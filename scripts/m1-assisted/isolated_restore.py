"""Restore a new plaintext backup into disposable, disconnected tmpfs containers.

This is deliberately a narrower proof than decrypting an off-host recovery bundle.
It never calls N05 recover, relaxes its non-production-host guard, or reads a key.
"""
import os
from pathlib import Path
import re
import time

from common import Stop, canonical, decode, defer_interruptions, digest, exclusive, need, value_sha

LABEL = 'it.finanzaagevolaimpresa.m1-isolated-restore'
PG_START = r'''set -eu
test "$(id -u)" = 70
initdb -D /var/lib/postgresql/data/isolated --auth-local=trust --auth-host=reject >/dev/null
exec postgres -D /var/lib/postgresql/data/isolated -c listen_addresses='' -c unix_socket_directories=/tmp -c max_connections=8 -c shared_buffers=32MB -c fsync=on
'''
DOC_START = 'exec sleep 600'
LEDGER_SQL = '''SELECT migration_name,checksum,started_at::text,coalesce(finished_at::text,''),coalesce(rolled_back_at::text,''),applied_steps_count::text FROM _prisma_migrations ORDER BY migration_name'''


def ledger_valid(rows, expected):
    need(len(rows) == len(expected) and len({r[0] for r in rows}) == len(expected), 'RESTORED_LEDGER_COUNT')
    need(all(len(r) == 6 and r[2] and r[3] and not r[4] and r[5] == '1' for r in rows), 'RESTORED_LEDGER_INCOMPLETE')
    need({r[0]: r[1] for r in rows} == expected, 'RESTORED_LEDGER_CHECKSUM')


def isolation(raw, ref, run_id, *, document=False):
    need(raw['Id'] == ref['id'] and raw['Created'] == ref['created'] and raw['Image'] == ref['image'],
         'ISOLATED_CONTAINER_REPLACED')
    need(raw['Config']['Labels'].get(LABEL) == run_id, 'ISOLATED_CONTAINER_LABEL')
    h = raw['HostConfig']
    need(h['NetworkMode'] == 'none' and not h.get('PortBindings') and h['ReadonlyRootfs'] is True
         and not h.get('Privileged') and not h.get('Devices') and not h.get('Binds'), 'ISOLATION_AUTHORITY')
    need(h['RestartPolicy']['Name'] == 'no' and h['LogConfig']['Type'] == 'none', 'ISOLATION_RESTART_LOGGING')
    need('no-new-privileges' in h.get('SecurityOpt', []) and 'ALL' in h.get('CapDrop', []), 'ISOLATION_SECURITY')
    capabilities = {name.removeprefix('CAP_') for name in h.get('CapAdd') or []}
    need(capabilities == ({'CHOWN', 'FOWNER', 'DAC_OVERRIDE'} if document else set()), 'ISOLATION_CAPABILITIES')
    allowed = {'/work', '/tmp'} if document else {'/var/lib/postgresql/data', '/tmp'}
    need(all(m['Type'] == 'tmpfs' and m['Destination'] in allowed for m in raw.get('Mounts', [])),
         'ISOLATION_PERSISTENT_MOUNT')
    need(set(h['Tmpfs']) == allowed, 'ISOLATION_TMPFS_DRIFT')
    need(0 < h['Memory'] <= (384 if document else 2048) * 1024**2 and h['MemorySwap'] == h['Memory'],
         'ISOLATION_MEMORY_SWAP')
    need(h['NanoCpus'] == 1000000000 and h['PidsLimit'] == 128, 'ISOLATION_RESOURCE_LIMITS')


class Restore:
    def __init__(self, commands, work, run_id, pg_image, document_image, kit):
        need(re.fullmatch('[a-f0-9]{32}', run_id), 'RECOVERY_RUN_ID')
        self.c, self.work, self.run_id, self.kit = commands, Path(work), run_id, kit
        self.images = {'postgres': pg_image, 'documents': document_image}
        self.refs = {}

    def create(self, role):
        document = role == 'documents'
        name = 'm1-recovery-' + self.run_id + '-' + role
        need(not self.c.docker('RECOVERY_NAME_CHECK', 'ps', '-aq', '--filter', 'name=^/' + name + '$').strip(),
             'RECOVERY_NAME_OCCUPIED')
        exclusive(self.work / (role + '-intent.json'), {'name': name, 'image': self.images[role]})
        tmpfs = ['/work:rw,nosuid,nodev,noexec,size=268435456,mode=0700', '/tmp:rw,nosuid,nodev,noexec,size=16777216'] if document else [
            '/var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=1610612736,uid=70,gid=70,mode=0700',
            '/tmp:rw,nosuid,nodev,noexec,size=16777216,mode=1777']
        args = ['create', '--name', name, '--label', LABEL + '=' + self.run_id, '--network', 'none',
                '--read-only', '--restart', 'no', '--log-driver', 'none', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges', '--cpus', '1', '--pids-limit', '128',
                '--memory', '384m' if document else '2048m', '--memory-swap', '384m' if document else '2048m',
                '--user', '0:0' if document else '70:70', '--entrypoint', '/bin/sh']
        for value in tmpfs:
            args += ['--tmpfs', value]
        if document:
            for cap in ('CHOWN', 'FOWNER', 'DAC_OVERRIDE'):
                args += ['--cap-add', cap]
        args += [self.images[role], '-ceu', DOC_START if document else PG_START]
        cid = self.c.docker('RECOVERY_CREATE_' + role.upper(), *args).decode().strip()
        need(re.fullmatch('[a-f0-9]{64}', cid), 'RECOVERY_CREATE_REPLY_UNCERTAIN')
        raw = self.c.inspect('container', cid)
        ref = {'id': cid, 'created': raw['Created'], 'image': self.images[role]}
        isolation(raw, ref, self.run_id, document=document)
        exclusive(self.work / (role + '-identity.json'), ref)
        self.refs[role] = ref
        self.c.docker('RECOVERY_START_' + role.upper(), 'start', cid)
        return cid

    def psql(self, cid, sql, database='m1_recovery'):
        return self.c.docker('RECOVERY_SQL', 'exec', '-i', cid, 'psql', '-h', '/tmp', '-U', 'postgres',
            '-d', database, '-X', '-qAt', '-F', '\t', '-v', 'ON_ERROR_STOP=1', data=sql.encode(), seconds=40).decode().strip()

    def cleanup(self):
        original_deadline = (self.c.wall_end, self.c.mono_end)
        items = list(reversed(list(self.refs.items())))
        errors = []
        with defer_interruptions() as deferred:
            for index, (role, ref) in enumerate(items):
                try:
                    # One failed resource cannot consume the other one's share.
                    budget = self.c.remaining(90) / (len(items) - index)
                    self.c.wall_end = min(original_deadline[0], time.time() + budget)
                    self.c.mono_end = min(original_deadline[1], time.monotonic() + budget)
                    raw = self.c.inspect('container', ref['id'])
                    isolation(raw, ref, self.run_id, document=role == 'documents')
                    if raw['State']['Running']:
                        self.c.docker('RECOVERY_STOP_' + role.upper(), 'stop', '--time', '10', ref['id'], seconds=25)
                    raw = self.c.inspect('container', ref['id'])
                    isolation(raw, ref, self.run_id, document=role == 'documents')
                    need(not raw['State']['Running'] and raw['State']['Pid'] == 0 and not raw.get('ExecIDs'),
                         'RECOVERY_STOP_UNVERIFIED')
                    self.c.docker('RECOVERY_REMOVE_' + role.upper(), 'rm', ref['id'])
                    need(not self.c.docker('RECOVERY_ABSENCE', 'ps', '-aq', '--no-trunc', '--filter', 'id=' + ref['id']).strip(),
                         'RECOVERY_REMOVAL_UNVERIFIED')
                except BaseException as exc:
                    errors.append({'role':role, 'code':getattr(exc, 'code', type(exc).__name__)})
                finally:
                    self.c.wall_end, self.c.mono_end = original_deadline
        need(not errors, 'RECOVERY_RESOURCES_UNSETTLED', resources=errors)
        return bool(deferred)
        # Never adopt a container after a lost creation reply. Its intent/name is
        # left for read-only reconciliation, without starting or deleting it.

    def run(self, backup, expected_ledger):
        cleanup_deadline = (self.c.wall_end, self.c.mono_end)
        self.c.wall_end -= 90
        self.c.mono_end -= 90
        backup = Path(backup)
        original = self.kit.document_inventory(backup / 'documents.tar.gz')
        sizes = [item[1] for item in self.kit.safe_members(backup / 'documents.tar.gz', compressed=True)]
        need(sum(sizes) <= 192 * 1024**2, 'ISOLATED_DOCUMENT_CAPACITY')
        need((backup / 'postgres.dump').stat().st_size <= 384 * 1024**2, 'ISOLATED_DATABASE_CAPACITY')
        source_hashes = {n: digest(backup / n) for n in ('postgres.dump', 'documents.tar.gz')}
        main_error = None
        result = None
        try:
            pg = self.create('postgres')
            deadline = time.monotonic() + 50
            while True:
                need(time.monotonic() < deadline, 'ISOLATED_POSTGRES_READY_TIMEOUT')
                need(self.c.inspect('container', pg)['State']['Running'], 'ISOLATED_POSTGRES_EXITED')
                try:
                    self.psql(pg, 'SELECT 1;', database='postgres')
                    break
                except Stop as exc:
                    if exc.code != 'COMMAND_FAILED':
                        raise
                    time.sleep(1)
            self.psql(pg, 'CREATE DATABASE m1_recovery;', database='postgres')
            with (backup / 'postgres.dump').open('rb') as source:
                self.c.docker('RECOVERY_PG_RESTORE', 'exec', '-i', pg, 'pg_restore', '-h', '/tmp',
                    '-U', 'postgres', '--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction',
                    '-d', 'm1_recovery', source=source, seconds=240)
            rows = [line.split('\t') for line in self.psql(pg, LEDGER_SQL).splitlines()]
            ledger_valid(rows, expected_ledger)
            need(self.psql(pg, 'SELECT count(*) FROM pg_constraint WHERE NOT convalidated;') == '0',
                 'RESTORED_CONSTRAINT_NOT_VALIDATED')
            # Read every restored table through pg_dump; no row contents are exported.
            with open(os.devnull, 'wb') as discard:
                self.c.docker('RECOVERY_DATABASE_FULL_READ', 'exec', pg, 'pg_dump', '-h', '/tmp', '-U', 'postgres',
                              '-d', 'm1_recovery', '--format=custom', output=discard, seconds=180)
            doc = self.create('documents')
            with (backup / 'documents.tar.gz').open('rb') as source:
                self.c.docker('RECOVERY_DOCUMENT_RESTORE', 'exec', '-i', '--user', '0:0', doc, 'tar',
                    '--extract', '--gzip', '--file=-', '--directory=/work', '--numeric-owner',
                    '--same-owner', '--same-permissions', source=source, seconds=120)
            roundtrip = self.work / 'documents-restored.tar.gz'
            with roundtrip.open('xb') as output:
                os.chmod(roundtrip, 0o600)
                self.c.docker('RECOVERY_DOCUMENT_READBACK', 'exec', '--user', '0:0', doc, 'tar',
                    '--create', '--gzip', '--file=-', '--directory=/work', '.', output=output, seconds=120)
                output.flush()
                os.fsync(output.fileno())
            need(self.kit.document_inventory(roundtrip) == original, 'RESTORED_DOCUMENT_INVENTORY_MISMATCH')
            need(source_hashes == {n: digest(backup / n) for n in source_hashes}, 'RECOVERY_SOURCE_CHANGED')
            result = {'scope': 'NEW_PLAINTEXT_DATABASE_AND_DOCUMENT_SET', 'databaseRestored': True,
                      'documentsRestored': True, 'ledgerCount': len(rows), 'ledgerDigest': value_sha(rows),
                      'sourceHashes': source_hashes, 'documentInventoryDigest': value_sha(original),
                      'encryptedCopiesDecrypted': False, 'privateConfigurationRestoreTested': False,
                      'sameHost': True, 'network': 'none', 'productionVolumesMounted': False,
                      'realKeyAccess': False, 'restoredApplicationStarted': False}
        except BaseException as exc:
            main_error = exc
        try:
            self.c.wall_end, self.c.mono_end = cleanup_deadline
            interrupted_cleanup = self.cleanup()
        except BaseException as exc:
            raise Stop('RECOVERY_CLEANUP_UNVERIFIED', originalCode=getattr(main_error, 'code', None),
                       cleanupCode=getattr(exc, 'code', type(exc).__name__),
                       cleanupDetails=getattr(exc, 'details', {})) from None
        if main_error:
            raise main_error
        need(not interrupted_cleanup, 'OWNER_INTERRUPTED_AFTER_RECOVERY_SETTLED')
        result['isolatedContainersRemoved'] = True
        return result
