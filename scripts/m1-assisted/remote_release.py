"""Finite, hash-bound M1 owner operations. Not an agent SSH bridge or service."""
import contextlib
import hashlib
import io
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import sys
import time

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import Commands, Stop, Stages, canonical, decode, defer_interruptions, digest, exclusive, load, module, need, private, utc, value_sha
from isolated_restore import Restore, ledger_valid

BASE = Path('/home/faiadmin/.local/share/fai-crm-releases')
OLD = BASE / 'release-3230764a4406-20260920'
KEY_CONFIRMATION = 'AUTORIZZO_CHIAVE_STEP_UP_M1_VERSIONE_1'
MODES = {'INTERNAL_SESSION_MODE': 'registry', 'PRIVILEGED_ACCESS_MODE': 'enforced',
         'INTERNAL_ENGAGEMENT_MODE': 'controlled', 'PRACTICE_READINESS_MODE': 'internal',
         'CONTROLLED_INTAKE_MODE': 'internal'}
KEY_SQL = '''BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='8s'; SET LOCAL lock_timeout='2s';
SELECT json_build_object('keys',(SELECT count(*) FROM "ApplicationKeyVersion" WHERE purpose='PRIVILEGED_STEP_UP'),
'admins',(SELECT count(*) FROM "User" WHERE role='admin' AND active=true AND "deletedAt" IS NULL),
'sessions',(SELECT count(*) FROM "InternalSession" WHERE "revokedAt" IS NULL AND "expiresAt">CURRENT_TIMESTAMP),
'otherSessions',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active'),
'databaseBytes',pg_database_size(current_database())); ROLLBACK;'''
LEDGER_SQL = '''SELECT migration_name,checksum,started_at::text,coalesce(finished_at::text,''),coalesce(rolled_back_at::text,''),applied_steps_count::text FROM _prisma_migrations ORDER BY migration_name'''
PROVISION_NODE = r'''
const fs=require('node:fs'),crypto=require('node:crypto');
const {PrismaClient}=require('@prisma/client');
const db=new PrismaClient();
(async()=>{
 const input=JSON.parse(fs.readFileSync(0,'utf8'));
 if(input.version!==1 || !/^[0-9a-f]{96}$/.test(input.secret)) throw Error('INPUT_DENIED');
 for(const [file,hash] of Object.entries(input.hashes)) {
   if(!['src/lib/application-key-registry.ts','src/lib/privileged-step-up-token.ts'].includes(file)) throw Error('FILE_DENIED');
   if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==hash) throw Error('CODE_DRIFT');
 }
 const imported=await import('./src/lib/application-key-registry.ts');
 const rotate=imported.rotatePrivilegedStepUpKeyVersion??imported.default?.rotatePrivilegedStepUpKeyVersion;
 if(typeof rotate!=='function') throw Error('ROTATION_HELPER_UNAVAILABLE');
 const result=await db.$transaction(async tx=>{
   await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('FAI_PRIVILEGED_STEP_UP_KEY_ROTATION_V1'))");
   if(await tx.applicationKeyVersion.count({where:{purpose:'PRIVILEGED_STEP_UP'}})!==0) throw Error('KEY_ALREADY_EXISTS');
   if(await tx.internalSession.count({where:{revokedAt:null,expiresAt:{gt:new Date()}}})!==0) throw Error('SESSION_REAPPEARED');
   const admins=await tx.user.findMany({where:{role:'admin',active:true,deletedAt:null},select:{id:true},take:2});
   if(admins.length!==1) throw Error('ADMIN_AMBIGUOUS');
   const row=await rotate(tx,{version:1,keyDigest:crypto.createHash('sha256').update(input.secret).digest(),actorUserId:admins[0].id});
   return {version:row.version,status:row.status,auditEvent:'application_key_version_rotated'};
 },{timeout:15000});
 console.log(JSON.stringify(result));
})().catch(()=>{console.error('PROVISION_FAILED_REDACTED');process.exitCode=2}).finally(()=>db.$disconnect());
'''


def env_with_changes(raw, values):
    """Preserve every other byte/line; no interpolation or shell evaluation."""
    need(b'\x00' not in raw and b'\r' not in raw.replace(b'\r\n', b''), 'ENV_ENCODING')
    text = raw.decode('utf-8')
    seen = set()
    output = []
    for line in text.splitlines(keepends=True):
        match = re.match(r'^(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=', line)
        if match and match[1] in values:
            need(match[1] not in seen, 'DUPLICATE_CHANGED_ENVIRONMENT_KEY')
            seen.add(match[1])
        else:
            output.append(line)
    joined = ''.join(output)
    if joined and not joined.endswith('\n'):
        joined += '\n'
    for name, value in values.items():
        need(re.fullmatch('[A-Z_0-9]+', name) and re.fullmatch('[A-Za-z0-9_-]+', value), 'ENV_CHANGE_INVALID')
        joined += name + '=' + value + '\n'
    return joined.encode()


def current_key_allowed(metadata):
    need(metadata['keys'] == 0, 'STEP_UP_KEY_PROVISIONING_NOT_INITIAL')
    need(metadata['admins'] == 1, 'STEP_UP_OWNER_ADMIN_NOT_UNIQUE')
    need(metadata['sessions'] == 0 and metadata['otherSessions'] == 0, 'ACTIVE_SESSIONS_PRESENT')
    need(0 < metadata['databaseBytes'] < 256 * 1024**2, 'ISOLATED_DATABASE_CAPACITY')


class Release:
    def __init__(self, root):
        self.root = private(root, directory=True)
        self.manifest = load(private(self.root / 'package.json'))
        self.b = load(private(self.root / 'binding.json'))
        self.run_id = self.manifest['runId']
        need(re.fullmatch('[a-f0-9]{32}', self.run_id) and self.run_id not in self.b['historicalRunIds'], 'RUN_ID_INVALID')
        need(self.root == BASE / ('m1-assisted-r21-' + self.run_id), 'PACKAGE_PATH_BINDING')
        need(self.manifest['candidate'] == self.b['candidate'], 'PACKAGE_CANDIDATE')
        for name, entry in self.manifest['files'].items():
            need(Path(name).name == name, 'PACKAGE_MEMBER_NAME')
            path = private(self.root / name)
            need(path.stat().st_size == entry['bytes'] and digest(path) == entry['sha256'], 'PACKAGE_MEMBER_CHANGED')
        self.review = load(self.root / 'review.json')
        need(self.review['status'] == 'PASS_FOR_MERGE' and self.review['candidate'] == self.b['candidate']
             and self.review['deltaSha256'] == self.manifest['deltaSha256']
             and self.review['recoveryScope'] == 'NEW_PLAINTEXT_DATABASE_AND_DOCUMENT_SET', 'REVIEW_NOT_QUALIFIED')
        need(re.fullmatch(r'https://(?:chatgpt.com|github.com)/[A-Za-z0-9_./?#=-]+', self.review['reference']), 'REVIEW_REFERENCE')
        self.work = self.root / 'evidence'
        self.runtime = BASE / ('release-fb645e014653-r21-' + self.run_id)
        self.c = Commands(1500, OLD)
        self.stages = Stages(self.work, self.run_id)
        self.t = self.b['target']
        need(socket.gethostname() == self.t['hostname'] and os.getuid() == os.getgid() == 1000, 'TARGET_IDENTITY')
        import pwd
        need(pwd.getpwuid(1000).pw_name == self.t['user'], 'OWNER_IDENTITY')
        need(not any(os.environ.get(k) for k in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'COMPOSE_FILE', 'COMPOSE_PROFILES')), 'AMBIENT_SELECTOR_DENIED')
        need(self.c.docker('ENGINE_IDENTITY', 'info', '--format', '{{.ID}}').decode().strip() == self.t['engineId'], 'ENGINE_IDENTITY')

    def sql(self, text):
        return self.c.docker('DATABASE_READ', 'exec', '-i', self.t['postgresId'], 'sh', '-ceu',
            'exec psql -X -qAt -F "\t" -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"', data=text.encode()).decode().strip()

    def rows(self, expected):
        rows = [line.split('\t') for line in self.sql(LEDGER_SQL).splitlines()]
        ledger_valid(rows, expected)
        return rows

    def observer(self):
        m = module(self.root / 'observe_m1.py', 'm1_readonly', self.manifest['files']['observe_m1.py']['sha256'])
        binding = {k: self.t[k] for k in ('engineId', 'appId', 'appImage', 'postgresId', 'postgresImage', 'networkId')}
        binding.update(candidate=self.b['candidate'], ledger=self.b['ledger46'])
        return m.Observer(binding).observe()

    def historical(self):
        folder = BASE / ('evidence-backup46-' + self.b['historicalRunIds'][1])
        result = {'historicalRun': self.b['historicalRunIds'][1], 'readsOnly': True, 'files': {}}
        for name in ('STOP.json', 'BACKUP_PREFLIGHT.log', 'BACKUP_CREATE.log', 'BACKUP_VERIFIED.json'):
            p = folder / name
            result['files'][name] = {'exists': p.exists()}
            if p.exists():
                private(p)
                result['files'][name].update(bytes=p.stat().st_size)
                if name == 'STOP.json':
                    need(p.stat().st_size <= 16384, 'HISTORICAL_RECEIPT_SIZE')
                    stop = load(p)
                    result['files'][name]['sha256'] = digest(p)
                    result['stop'] = {k: stop.get(k) for k in ('status', 'code', 'quiescenceAttempted', 'appResumedHealthy')}
        result['causeEstablished'] = False
        result['limit'] = 'HISTORICAL_COMMAND_FAILED_DID_NOT_RECORD_SUBCOMMAND'
        result['compatiblePhases'] = ['APP_QUIESCE', 'APP_STOP_VERIFY', 'BACKUP_PREFLIGHT']
        return result

    def prepare(self):
        before = self.observer()
        need(before['liveSessions'] == 0 and before['otherActiveDbSessions'] == 0, 'ACTIVE_SESSIONS_PRESENT')
        need(before['internalSessionMode'] == 'legacy' and before['privilegedAccessMode'] == 'disabled', 'SOURCE_MODE_DRIFT')
        empty_step_up = self.c.docker('INITIAL_STEP_UP_CONFIGURATION', 'exec', self.t['appId'], 'node', '-e',
            "console.log(!process.env.PRIVILEGED_STEP_UP_SECRET&&!process.env.PRIVILEGED_STEP_UP_KEY_VERSION?'ABSENT':'PRESENT')").strip()
        need(empty_step_up == b'ABSENT', 'EXISTING_STEP_UP_CONFIGURATION_REQUIRES_RECONCILIATION')
        current_key_allowed(decode(self.sql(KEY_SQL)))
        documents = decode(self.c.docker('DOCUMENT_CAPACITY_METADATA', 'exec', self.t['appId'], 'node', '-e',
            "const fs=require('fs'),p=require('path');let bytes=0,files=0;function visit(d){for(const n of fs.readdirSync(d)){const f=p.join(d,n),s=fs.lstatSync(f);if(s.isSymbolicLink()||(!s.isFile()&&!s.isDirectory()))throw Error('ENTRY_DENIED');if(s.isDirectory())visit(f);else{bytes+=s.size;files++}if(files>20000||bytes>201326592)throw Error('CAPACITY')}}visit('/var/lib/fai-crm/documents');console.log(JSON.stringify({bytes,files}));"))
        need(documents['bytes'] <= 192 * 1024**2 and documents['files'] <= 20000, 'ISOLATED_DOCUMENT_CAPACITY')
        memory = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
        need(int(memory['MemAvailable'].split()[0]) >= 3 * 1024**2, 'ISOLATED_RECOVERY_MEMORY_LOW')
        need(before['availableBytes'] >= 12 * 1024**3, 'SERVER_SPACE_LOW')
        need(self.c.run('AGE_VERSION', ['age', '--version']).decode().strip() == 'v1.3.2', 'AGE_VERSION')
        backup = module(self.root / 'owner_backup46.py', 'backup145_precheck', self.b['backupProgramSha256'])
        for name, expected in backup.TOOLS.items():
            need(digest(private(OLD / name)) == expected, 'CANONICAL_BACKUP_TOOL_DRIFT')
        self.c.run('BACKUP_SCRIPT_SYNTAX', ['bash', '-n', OLD / 'scripts/backup-docker-prod.sh'])
        need(os.access(OLD / 'scripts/backup-docker-prod.sh', os.X_OK), 'BACKUP_SCRIPT_NOT_EXECUTABLE')
        historic = self.historical()
        need(digest(private(self.root / 'release-images.tar.gz')) == self.b['imageArchiveSha256'], 'IMAGE_ARCHIVE_HASH')
        need(not self.runtime.exists(), 'CANDIDATE_RUNTIME_OCCUPIED')
        # Local bundle only: no checkout from the network, no hooks or image build.
        self.c.run('RUNTIME_CLONE', ['git', '-c', 'init.templateDir=', 'clone', '--no-checkout',
            '--branch', 'codex/m1-runtime-candidate-r21', self.root / 'candidate.bundle', self.runtime], seconds=120)
        self.c.run('RUNTIME_CHECKOUT', ['git', '-C', self.runtime, '-c', 'core.hooksPath=/dev/null',
                    'checkout', '-b', 'main', self.b['candidate']], seconds=60)
        need(self.c.run('RUNTIME_IDENTITY', ['git', '-C', self.runtime, 'rev-parse', 'HEAD', 'HEAD^{tree}']).decode().split()
             == [self.b['candidate'], self.b['candidateTree']], 'RUNTIME_IDENTITY')
        for name, expected in self.b['canonicalPrograms'].items():
            need(digest(private(self.runtime / name)) == expected, 'QUALIFIED_PROGRAM_DRIFT')
        self.c.docker('IMAGE_LOAD', 'image', 'load', '--input', self.root / 'release-images.tar.gz', seconds=240)
        for key, image, commit, tree in [('candidate', self.b['candidateImage'], self.b['candidate'], self.b['candidateTree']),
                                      ('return', self.b['returnImage'], self.b['returnCommit'], self.b['returnTree'])]:
            raw = self.c.inspect('image', image)
            labels = raw['Config']['Labels']
            need(raw['Id'] == image and labels['org.opencontainers.image.revision'] == commit
                 and labels['it.finanzaagevolaimpresa.source-tree'] == tree, 'QUALIFIED_IMAGE_PROVENANCE')
        after = self.observer()
        need({k:v for k,v in after.items() if k != 'availableBytes'} ==
             {k:v for k,v in before.items() if k != 'availableBytes'}, 'BASELINE_CHANGED_DURING_PREPARATION')
        return {'candidate': self.b['candidate'], 'observation': after, 'history': historic,
                'documentCapacity': documents,
                'imagesLoaded': True, 'imagesRebuilt': False, 'productionRuntimeMutationPerformed': False,
                'recipientSha256': self.b['recipientSha256'], 'stepUpProvisioningRequired': True,
                'backupCurrentPredicatesVerified': True, 'historicalCauseInferred': False}

    def backup(self):
        before = self.observer()
        need(before['liveSessions'] == 0 and before['otherActiveDbSessions'] == 0, 'ACTIVE_SESSIONS_PRESENT')
        current_key_allowed(decode(self.sql(KEY_SQL)))
        p = {'protocol': 'PR140_OWNER_BACKUP46_R05', 'runId': self.run_id,
             'sourceCommit': self.b['sourceCommit'], 'sourceTree': self.b['sourceTree'], 'schema': 46,
             'target': self.t, 'databaseName': 'fai_crm', 'ownerReceiptSha256': value_sha(before),
             'expectedLedger': self.b['ledger46'], 'retention': 'PRESERVE_EXISTING_LOCAL_AND_F_COPIES'}
        approval = {'status': 'OWNER_EXPLICITLY_AUTHORIZED', 'confirmation': 'FAI_CRM_SCHEMA46_STOP_BACKUP_RESUME_R05',
                    'planSha256': value_sha(p), 'programSha256': self.b['backupProgramSha256'],
                    'launcherSha256': self.manifest['files']['owner_release.py']['sha256'],
                    'reviewReference': self.review['reference']}
        m = module(self.root / 'owner_backup46.py', 'backup145_execute', self.b['backupProgramSha256'])
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream):
            status = m.entry_point({'plan': p, 'approval': approval}, self.b['backupProgramSha256'])
        result = decode(stream.getvalue())
        exclusive(self.work / 'backup-pr145-receipt.json', result)
        need(status == 0 and result['status'] == 'BACKUP_VERIFIED_AND_APP_RESUMED', 'BACKUP_STOP', backupReceipt=result)
        return {'receipt': result, 'freshObservation': self.observer()}

    def kit(self):
        return module(self.runtime / 'scripts/n05/recovery_kit.py', 'm1_recovery_kit',
                      self.b['canonicalPrograms']['scripts/n05/recovery_kit.py'])

    def backup_set(self):
        result = self.stages.result('backup')['receipt']
        path = BASE / ('evidence-backup46-' + self.run_id) / 'sets' / ('backup46-' + self.run_id)
        need(result['set'] == str(path), 'BACKUP_SET_PATH')
        return path, result

    def protect(self):
        kit = self.kit()
        backup, receipt = self.backup_set()
        config = backup.parent.parent / 'configuration'
        crypto = self.work / 'crypto-environment'
        crypto.mkdir(mode=0o700)
        exclusive(crypto / 'application-environment', private(config / '.env.production').read_bytes())
        protect_root = self.work / 'protect-operations'
        protect_root.mkdir(mode=0o700)
        expected = {'environment': 'production', 'project': 'fai-crm', 'source_commit': self.b['sourceCommit'],
                    'source_tree': self.b['sourceTree'], 'app_image_id': self.t['appImage'], 'image_provenance': 'oci-labels',
                    'resource_provenance': 'authorized-legacy-compose-identity', 'migration_count': 46,
                    'manifest_sha256': receipt['manifestSha256'], 'checksums_sha256': receipt['checksumsSha256']}
        plan = {'schema': kit.SCHEMA, 'phase': 'protect', 'data_class': 'production', 'run_id': self.run_id,
                'host': self.t['hostname'], 'work_root': str(protect_root), 'tools': kit.tools_binding(),
                'backup_set': str(backup), 'expected': expected, 'recipient': self.b['recipient'],
                'configuration_dir': str(config), 'cryptographic_dir': str(crypto),
                'configuration_sha256': kit.component_identity(config)['sha256'],
                'cryptographic_sha256': kit.component_identity(crypto)['sha256'],
                'output': str(self.work / 'backup46.bundle.tar')}
        exclusive(self.work / 'protect-plan.json', plan)
        result = decode(self.c.run('CANONICAL_N05_PROTECT', ['python3', '-I', '-B', '-S',
            self.runtime / 'scripts/n05/recovery_kit.py', 'protect', '--plan', self.work / 'protect-plan.json',
            '--plan-sha256', digest(self.work / 'protect-plan.json'),
            '--authorize', 'FAI_CRM_N05_RECOVERY_PROTECT_V1'], seconds=780))
        need(result.pop('status', None) == 'PROTECTION_VERIFIED', 'N05_PROTECTION_NOT_VERIFIED')
        return {'ciphertext': 'backup46.bundle.tar', **result, 'recipientSha256': self.b['recipientSha256']}

    def recover(self):
        before = self.observer()
        folder = self.work / 'isolated-recovery'
        folder.mkdir(mode=0o700)
        backup, _ = self.backup_set()
        result = Restore(self.c, folder, self.run_id, self.t['postgresImage'], self.b['candidateImage'], self.kit()).run(backup, self.b['ledger46'])
        after = self.observer()
        need(all(after[k] == before[k] for k in ('appHealthy', 'postgresHealthy', 'postgresStartedAt', 'postgresRestartCount',
                  'ledgerChecksumsMatch', 'ledgerCount', 'closedGates')), 'PRODUCTION_CHANGED_DURING_ISOLATED_RECOVERY')
        return result | {'productionUnchanged': True}

    def provision(self, request):
        need(request.get('keyConfirmation') == KEY_CONFIRMATION, 'SPECIFIC_STEP_UP_APPROVAL_REQUIRED')
        n05 = self.n05()
        lock = n05.acquire_lock(n05.PRODUCTION_LOCK_PATH, {'engine_id': self.t['engineId'], 'project': 'fai-crm'})
        try:
            return self.provision_locked()
        finally:
            os.close(lock)

    def provision_locked(self):
        self.observer()
        metadata = decode(self.sql(KEY_SQL))
        current_key_allowed(metadata)
        secret = secrets.token_hex(48)
        values = MODES | {'PRIVILEGED_STEP_UP_KEY_VERSION': '1', 'PRIVILEGED_STEP_UP_SECRET': secret}
        env = env_with_changes(private(OLD / '.env.production').read_bytes(), values)
        exclusive(self.runtime / '.env.production', env)
        configuration_hash = hashlib.sha256(env).hexdigest()
        exclusive(self.work / 'key-provisioning-authority.json', {'confirmation': KEY_CONFIRMATION, 'version': 1,
                  'scope': 'INITIAL_STEP_UP_KEY_AND_ACTIVE_REGISTRY_WITH_AUDIT', 'ownerAccountVerified': True})
        hashes = {p: h for p, h in self.b['canonicalPrograms'].items() if p.startswith('src/')}
        result = decode(self.c.docker('STEP_UP_INITIAL_REGISTRATION', 'exec', '-i', self.t['appId'],
            'node', '--import', 'tsx', '-e', PROVISION_NODE, data=canonical({'secret': secret, 'version': 1, 'hashes': hashes}), seconds=30))
        need(result == {'version': 1, 'status': 'ACTIVE', 'auditEvent': 'application_key_version_rotated'}, 'STEP_UP_REGISTRATION_RESULT')
        # The new key/configuration needs its own protected off-host copies before deploy.
        with (self.work / 'm1-configuration.age').open('xb') as out:
            os.chmod(self.work / 'm1-configuration.age', 0o600)
            self.c.run('ENCRYPT_M1_CONFIGURATION', ['age', '--encrypt', '--recipient', self.b['recipient']], data=env, output=out)
            out.flush()
            os.fsync(out.fileno())
        need(digest(private(self.runtime / '.env.production')) == configuration_hash, 'CONFIGURATION_CHANGED_DURING_PROTECTION')
        return {'version': 1, 'registeredActive': True, 'auditWritten': True, 'secretValuesExported': False,
                'configurationSha256': configuration_hash,
                'ciphertext': 'm1-configuration.age', 'bundle_sha256': digest(self.work / 'm1-configuration.age'),
                'bundle_bytes': (self.work / 'm1-configuration.age').stat().st_size}

    def require_config_binding(self):
        proof = self.stages.result('provision')
        need(proof and digest(private(self.runtime / '.env.production')) == proof['configurationSha256'],
             'PROTECTED_CONFIGURATION_CHANGED')

    def n05(self):
        return module(self.runtime / 'scripts/n05/failed_app_return.py', 'm1_n05',
                      self.b['canonicalPrograms']['scripts/n05/failed_app_return.py'])

    def canonical_transition(self, n05, operation, path):
        """Keep N05 and its command supervisor in this process until settlement.

        An outer subprocess group cannot contain N05's new-session Docker CLIs.
        The unchanged canonical supervisor owns those groups and original bounds.
        """
        need(operation in ('forward', 'return'), 'CANONICAL_OPERATION_INVALID')
        before_cwd, before_env = Path.cwd(), os.environ.copy()
        previous, interrupted = {}, []
        def interrupt_once(number, _frame):
            interrupted.append(number)
            if len(interrupted) == 1:
                raise KeyboardInterrupt()
        try:
            for name in ('SIGINT', 'SIGTERM', 'SIGHUP'):
                if hasattr(signal, name):
                    number = getattr(signal, name)
                    previous[number] = signal.getsignal(number)
                    signal.signal(number, interrupt_once)
            os.chdir(self.runtime)
            os.environ.clear()
            os.environ.update(self.c.env | {'FAI_ENVIRONMENT':'production',
                'FAI_ENVIRONMENT_SENTINEL':'FAI_CRM_PRODUCTION_V1','COMPOSE_PROJECT_NAME':'fai-crm'})
            with contextlib.redirect_stdout(io.StringIO()):
                n05.production_main(['failed_app_return.py', operation, str(path)])
        except BaseException as exc:
            code = str(exc) if isinstance(exc, n05.Denied) else 'CANONICAL_OPERATION_INTERRUPTED' if isinstance(exc, KeyboardInterrupt) else 'CANONICAL_FAILURE_REDACTED'
            if code == 'LOCAL_COMMAND_STOP_UNVERIFIED':
                raise Stop('CANONICAL_COMMANDS_NOT_QUIET', operation=operation) from None
            raise Stop(code, operation=operation) from None
        finally:
            os.environ.clear()
            os.environ.update(before_env)
            os.chdir(before_cwd)
            for number, handler in previous.items():
                signal.signal(number, handler)

    def models(self):
        self.require_config_binding()
        n05 = self.n05()
        baseline = load(BASE / ('evidence-backup46-' + self.run_id) / 'BASELINE.json')
        plan = {'project': 'fai-crm', 'source_app': {'id': self.t['appId'], 'image_id': self.t['appImage']},
                'candidate': {'id': self.b['candidateImage']}, 'return_image': {'id': self.b['returnImage']},
                'postgres': baseline['postgres'], 'ledger': {'schema': 'prisma-m1-48'}, 'configs': {}}
        prior = load(BASE / ('evidence-backup46-' + self.run_id) / 'configuration/frozen-source.json')
        adapter = n05.DockerEngine(plan, self.runtime)
        candidates = {'previous': prior,
                      'candidate': adapter.model(self.b['candidateImage'], time.time() + self.c.remaining(60)),
                      'return': adapter.model(self.b['returnImage'], time.time() + self.c.remaining(60))}
        for name, model in candidates.items():
            if name != 'previous':
                need(model['services']['postgres'] == prior['services']['postgres'] and
                     model['volumes'] == prior['volumes'] and model['networks'] == prior['networks'], 'PERSISTENT_MODEL_DRIFT')
                a, p = dict(model['services']['app']), dict(prior['services']['app'])
                a.pop('image', None); p.pop('image', None)
                a.pop('build', None); p.pop('build', None)
                ae, pe = a.pop('environment'), p.pop('environment')
                changed = set(MODES) | {'PRIVILEGED_STEP_UP_KEY_VERSION', 'PRIVILEGED_STEP_UP_SECRET'}
                need(a == p and {k:v for k,v in ae.items() if k not in changed} ==
                     {k:v for k,v in pe.items() if k not in changed}, 'UNAUTHORIZED_MODEL_CHANGE')
                need(all(ae.get(k) == v for k,v in MODES.items()), 'M1_MODE_CONFIGURATION')
                verifier = r'''const fs=require('fs'),c=require('crypto'),{PrismaClient}=require('@prisma/client');const d=new PrismaClient();
                (async()=>{const s=JSON.parse(fs.readFileSync(0,'utf8'));const k=await d.applicationKeyVersion.findUnique({where:{purpose_version:{purpose:'PRIVILEGED_STEP_UP',version:1}}});
                const ok=!!k&&k.status==='ACTIVE'&&!!k.activatedAt&&!k.retiredAt&&s.version==='1'&&typeof s.secret==='string'&&s.secret.length>=32&&c.timingSafeEqual(Buffer.from(k.keyDigest),c.createHash('sha256').update(s.secret).digest());
                if(!ok)throw Error();console.log('KEY_MATCHED');})().catch(()=>{process.exitCode=2}).finally(()=>d.$disconnect());'''
                proof = self.c.docker('STEP_UP_PRE_DEPLOY_MATCH', 'exec', '-i', self.t['appId'], 'node', '-e', verifier,
                   data=canonical({'version':ae.get('PRIVILEGED_STEP_UP_KEY_VERSION'), 'secret':ae.get('PRIVILEGED_STEP_UP_SECRET')}))
                need(proof.strip() == b'KEY_MATCHED', 'STEP_UP_PRE_DEPLOY_MISMATCH')
            path = self.work / ('frozen-' + name + '.json')
            exclusive(path, model)
            plan['configs'][name] = {'path': str(path), 'sha256': n05.sha(model), 'kind': 'frozen-compose-' + name}
        self.require_config_binding()
        snapshot = adapter.snapshot(time.time() + self.c.remaining(90))
        need(snapshot['resources'] == baseline['resources'] and snapshot['postgres'] == baseline['postgres']
             and snapshot['postgres_healthy'] and not snapshot['foreign_containers'] and not snapshot['migrators']
             and snapshot['app']['id'] == self.t['appId'] and snapshot['app']['state'] == 'healthy', 'SOURCE_MODEL_RECONCILIATION')
        exclusive(self.work / 'models.json', plan)
        return plan, baseline

    def migrate(self):
        n05 = self.n05()
        lock = n05.acquire_lock(n05.PRODUCTION_LOCK_PATH, {'engine_id': self.t['engineId'], 'project': 'fai-crm'})
        cid = ref = None
        settlement_deadline = (self.c.wall_end, self.c.mono_end)
        self.c.wall_end -= 90
        self.c.mono_end -= 90
        try:
            metadata = decode(self.sql(KEY_SQL))
            need(metadata['keys'] == 1 and metadata['sessions'] == metadata['otherSessions'] == 0, 'MIGRATION_ADMISSION_DRIFT')
            before = self.rows(self.b['ledger46'])
            plan, _ = self.models()
            model = load(self.work / 'frozen-candidate.json')
            url = model['services']['app']['environment']['DATABASE_URL'].replace('$$', '$')
            need('\n' not in url and '\r' not in url, 'DATABASE_ENV_ENCODING')
            exclusive(self.work / 'migrator.env', ('DATABASE_URL=' + url + '\n').encode())
            cid = self.c.docker('MIGRATOR_CREATE', 'create', '--name', 'm1-' + self.run_id + '-migrate',
                '--label', 'com.docker.compose.project=fai-crm', '--label', 'com.docker.compose.service=migrate',
                '--label', 'it.finanzaagevolaimpresa.release-run=' + self.run_id, '--network', 'fai-crm_default',
                '--restart', 'no', '--memory', '512m', '--cpus', '1', '--pids-limit', '128', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges', '--env-file', self.work / 'migrator.env', '--entrypoint', 'node',
                self.b['candidateImage'], 'node_modules/prisma/build/index.js', 'migrate', 'deploy').decode().strip()
            need(re.fullmatch('[a-f0-9]{64}', cid), 'MIGRATOR_CREATE_UNCERTAIN')
            raw = self.c.inspect('container', cid)
            need(raw['Id'] == cid and raw['Image'] == self.b['candidateImage'] and not raw['Mounts']
                 and not raw['HostConfig']['PortBindings'], 'MIGRATOR_IDENTITY')
            ref = {'id': cid, 'created': raw['Created'], 'image_id': self.b['candidateImage'], 'role': 'migrate', 'project': 'fai-crm'}
            exclusive(self.work / 'migrator-identity.json', ref)
            self.c.docker('MIGRATOR_START', 'start', cid)
            need(self.c.docker('MIGRATOR_WAIT', 'wait', cid, seconds=240).decode().strip() == '0', 'MIGRATOR_EXIT_NONZERO')
            after = self.rows(self.b['ledger48'])
            need(after[:46] == before, 'PRIOR_MIGRATION_HISTORY_CHANGED')
            exclusive(self.work / 'ledger48.json', after)
            return {'before': 46, 'after': 48, 'prior46Unchanged': True, 'ledgerDigest': value_sha(after),
                    'newMigrations': sorted(set(self.b['ledger48']) - set(self.b['ledger46'])), 'migrator': ref}
        finally:
            original_error = sys.exc_info()[1]
            self.c.wall_end, self.c.mono_end = settlement_deadline
            try:
                with defer_interruptions() as deferred:
                    if ref:
                        raw = self.c.inspect('container', ref['id'])
                        need(raw['Id'] == ref['id'] and raw['Image'] == ref['image_id']
                             and raw['Created'] == ref['created'], 'MIGRATOR_SETTLEMENT_IDENTITY')
                        if raw['State']['Running']:
                            self.c.docker('MIGRATOR_SETTLE', 'stop', '--time', '10', ref['id'], seconds=30)
                        raw = self.c.inspect('container', ref['id'])
                        need(raw['Id'] == ref['id'] and raw['Image'] == ref['image_id'] and raw['Created'] == ref['created']
                             and not raw['State']['Running'] and raw['State']['Pid'] == 0 and not raw.get('ExecIDs'),
                             'MIGRATOR_STOP_UNVERIFIED')
            except BaseException as exc:
                raise Stop('MIGRATOR_SETTLEMENT_UNVERIFIED', originalCode=getattr(original_error, 'code', None),
                           settlementCode=getattr(exc, 'code', type(exc).__name__)) from None
            finally:
                os.close(lock)
            if deferred and original_error is None:
                raise Stop('OWNER_INTERRUPTED_AFTER_MIGRATOR_SETTLED')

    def deploy(self):
        self.require_config_binding()
        n05 = self.n05()
        baseline = load(BASE / ('evidence-backup46-' + self.run_id) / 'BASELINE.json')
        plan = load(self.work / 'models.json')
        rows = self.rows(self.b['ledger48'])
        need(value_sha(rows) == self.stages.result('migrate')['ledgerDigest'], 'PRE_DEPLOY_LEDGER_DRIFT')
        deadline = time.time()
        image = lambda prefix: {'tag': 'fai-crm:r05-' + ('candidate' if prefix == 'candidate' else 'recovery') + '-' + self.b[prefix if prefix == 'candidate' else 'returnCommit'],
             'id': self.b[prefix + 'Image'], 'oci_commit': self.b[prefix if prefix == 'candidate' else 'returnCommit'],
             'oci_tree': self.b[prefix + 'Tree']}
        plan.update(schema=n05.PLAN_V3, run_id='m1-r21-' + self.run_id, engine=baseline['engine'],
            tools={'commit': self.b['candidate'], 'tree': self.b['candidateTree'], 'ci_sha': self.b['candidate'], 'ci_conclusion': 'success'},
            source_app={k:baseline['app'][k] for k in ('id', 'created', 'image_id')}, candidate=image('candidate'), return_image=image('return'),
            resources=baseline['resources'], ledger={'schema': 'prisma-m1-48', 'count': 48, 'digest': value_sha(rows)},
            gates={}, compatibility={}, migrator=self.stages.result('migrate')['migrator'],
            return_policy={'allowed_reasons': ['functional-failure', 'unhealthy', 'exited', 'absent']},
            receipt_path=str(self.work / 'forward.json'), return_request_path=str(self.work / 'return-request.json'),
            journal_path=str(self.work / 'return.json'), deadline_epoch=deadline + 900,
            phase_deadlines={'forward_epoch': deadline + 360, 'settlement_epoch': deadline + 480, 'return_epoch': deadline + 840,
                             'settlement_reserve_seconds': 120, 'return_reserve_seconds': 360, 'cleanup_reserve_seconds': 60})
        binding = n05.evidence_binding(plan)
        evidence = {
            'recovery': {'restore': self.stages.result('recover'), 'copies': self.stages.result('copies-backup')},
            'artifacts': self.review['softwareEvidence'],
            'reviewed_plan': {'reference': self.review['reference'], 'deltaSha256': self.manifest['deltaSha256']},
            'authorization': {'standingMandate': self.manifest['authorityReference'], 'key': load(self.work / 'key-provisioning-authority.json')},
            'return-image-schema-compatibility': self.review['returnCompatibilityEvidence']}
        for kind, details in evidence.items():
            path = self.work / (kind + '-evidence.json')
            exclusive(path, {'schema': 'FAI_CRM_N05_EVIDENCE_V1', 'kind': kind, 'synthetic': False,
                             'binding': binding, 'result': 'qualified', 'details': details})
            ref = {'path': str(path), 'sha256': digest(path), 'kind': kind}
            if kind == 'return-image-schema-compatibility':
                plan['compatibility'] = ref
            else:
                plan['gates'][kind] = ref
        n05.validate_plan(plan)
        path = self.work / 'forward-plan.json'
        exclusive(path, plan)
        self.c.cwd = self.runtime
        forward_error = None
        try:
            self.canonical_transition(n05, 'forward', path)
        except Stop as exc:
            if exc.code == 'CANONICAL_COMMANDS_NOT_QUIET':
                raise
            forward_error = exc
        # The durable canonical receipt, not the CLI exit, authorizes the next action.
        n05.require_published(Path(plan['receipt_path']))
        receipt = load(plan['receipt_path'])
        n05.validate_receipt(receipt, plan)
        adapter = n05.DockerEngine(plan, self.runtime)
        current = adapter.snapshot(time.time() + 60)
        if current['app'] and current['app']['image_id'] == self.b['candidateImage'] and current['app']['state'] == 'healthy':
            need(forward_error is None, 'FORWARD_EXIT_WITH_HEALTHY_APP_RECONCILE_ONLY')
            return {'candidate': self.b['candidate'], 'image': self.b['candidateImage'], 'appId': current['app']['id'],
                    'healthy': True, 'schema': 48, 'canonicalForwardReceiptSha256': digest(plan['receipt_path']), 'returnUsed': False}
        state = current['app']['state'] if current['app'] else 'absent'
        reason = {'running-unhealthy': 'unhealthy', 'exited': 'exited', 'absent': 'absent'}.get(state)
        need(reason is not None, 'FORWARD_STATE_NOT_RETURNABLE')
        request = {'schema': 'FAI_CRM_N05_RETURN_REQUEST_V1', 'run_id': plan['run_id'], 'plan_sha256': n05.sha(plan),
                   'receipt_sha256': n05.sha(receipt), 'reason': reason, 'evidence': None}
        exclusive(Path(plan['return_request_path']), request)
        self.canonical_transition(n05, 'return', path)
        raise Stop('QUALIFIED_APP_RETURN_PERFORMED_RELEASE_NOT_COMPLETE', returnCommit=self.b['returnCommit'], schema=48)

    def copies(self, stage, request):
        previous = 'protect' if stage == 'copies-backup' else 'provision'
        original = self.stages.result(previous)
        receipt = request.get('copies')
        need(isinstance(receipt, dict) and set(receipt) == {'C', 'F'}, 'TWO_APPROVED_COPIES_REQUIRED')
        for drive, value in receipt.items():
            need(value['sha256'] == original['bundle_sha256'] and value['bytes'] == original['bundle_bytes']
                 and value['physicalIdentityVerified'] is True and value['readbackVerified'] is True, 'COPY_EVIDENCE_MISMATCH')
        return {'copies': receipt, 'ciphertextSha256': original['bundle_sha256'], 'ciphertextBytes': original['bundle_bytes']}

    def postcheck(self):
        self.require_config_binding()
        m = self.n05()
        plan = load(self.work / 'forward-plan.json')
        current = m.DockerEngine(plan, self.runtime).snapshot(time.time() + 90)
        need(current['app'] and current['app']['image_id'] == self.b['candidateImage'] and current['app']['state'] == 'healthy'
             and current['postgres_healthy'] and current['resources'] == plan['resources']
             and current['postgres'] == plan['postgres'] and not current['foreign_containers'] and not current['migrators'], 'POST_DEPLOY_RUNTIME_DRIFT')
        self.rows(self.b['ledger48'])
        pg = self.c.inspect('container', self.t['postgresId'])
        initial = self.stages.result('prepare')['observation']
        need(pg['State']['StartedAt'] == initial['postgresStartedAt'] and
             pg['RestartCount'] == initial['postgresRestartCount'], 'POSTGRES_RESTARTED_DURING_RELEASE')
        js = r'''const c=require('node:crypto');const{PrismaClient}=require('@prisma/client');const d=new PrismaClient();
        (async()=>{const e=process.env,k=await d.applicationKeyVersion.findUnique({where:{purpose_version:{purpose:'PRIVILEGED_STEP_UP',version:1}}});
        const ok=!!k&&k.status==='ACTIVE'&&!!k.activatedAt&&!k.retiredAt&&e.PRIVILEGED_STEP_UP_KEY_VERSION==='1'&&typeof e.PRIVILEGED_STEP_UP_SECRET==='string'&&e.PRIVILEGED_STEP_UP_SECRET.length>=32&&c.timingSafeEqual(Buffer.from(k.keyDigest),c.createHash('sha256').update(e.PRIVILEGED_STEP_UP_SECRET).digest());
        const expected=JSON.parse(process.argv[1]);const modes=Object.entries(expected).every(([k,v])=>e[k]===v);
        const health=(await fetch('http://127.0.0.1:3000/api/health')).ok;
        console.log(JSON.stringify({stepUpMatched:ok,modesMatched:modes,health}));if(!ok||!modes||!health)process.exitCode=2;
        })().catch(()=>{console.error('POSTCHECK_FAILED');process.exitCode=2}).finally(()=>d.$disconnect());'''
        result = decode(self.c.docker('M1_RUNTIME_POSTCHECK', 'exec', current['app']['id'], 'node', '-e', js, canonical(MODES).decode()))
        need(all(result.get(k) is True for k in ('stepUpMatched', 'modesMatched', 'health')), 'M1_POSTCHECK_FAILED')
        # Public health endpoint only, with the ordinary certificate/hostname checks.
        import urllib.request
        with urllib.request.urlopen('https://desk.finanzaagevolaimpresa.it/api/health', timeout=15) as response:
            need(response.status == 200, 'HTTPS_HEALTH_FAILED')
        return {'candidate': self.b['candidate'], 'schema': 48, 'appHealthy': True, 'postgresHealthy': True,
                'postgresNotRestarted': True, 'httpsHealthVerified': True,
                'keyVersion': 1, **result, 'ownerUsageProof': 'PENDING_FRESH_LOGIN_AND_M1_USAGE',
                'autonomyQualified': False, 'assistedOwnerExecution': True}

    def status(self):
        states = {}
        for stage in DEPENDENCIES:
            result = self.stages.result(stage)
            states[stage] = result or {'status': 'UNCERTAIN_RECONCILE_ONLY' if (self.work / (stage + '.intent.json')).exists() else 'NOT_STARTED'}
        app = self.c.docker('APP_MINIMUM_STATUS', 'ps', '-a', '--no-trunc', '--filter', 'label=com.docker.compose.project=fai-crm',
                          '--filter', 'label=com.docker.compose.service=app', '--format', '{{.ID}}|{{.Image}}|{{.Status}}').decode().strip()
        return {'protocol': 'FAI_M1_ASSISTED_RECONCILIATION_R21', 'runId': self.run_id, 'utc': utc(), 'readOnly': True,
                'stages': states, 'appMinimumStatus': app, 'agentRealKeyAccess': False}

    def fetch(self, stage):
        result = self.stages.result('protect' if stage == 'fetch-backup' else 'provision')
        need(result and result['status'] == 'PASS', 'CIPHERTEXT_NOT_VERIFIED')
        name = 'backup46.bundle.tar' if stage == 'fetch-backup' else 'm1-configuration.age'
        path = private(self.work / name)
        need(digest(path) == result['bundle_sha256'] and path.stat().st_size == result['bundle_bytes'], 'CIPHERTEXT_CHANGED')
        with path.open('rb') as source:
            for block in iter(lambda: source.read(1024 * 1024), b''):
                sys.stdout.buffer.write(block)
        sys.stdout.buffer.flush()


DEPENDENCIES = {'prepare': [], 'backup': ['prepare'], 'protect': ['backup'],
                'copies-backup': ['protect'], 'recover': ['copies-backup'],
                'provision': ['recover'], 'copies-config': ['provision'],
                'migrate': ['copies-config'], 'deploy': ['migrate'], 'postcheck': ['deploy']}


def main():
    os.umask(0o077)
    need(len(sys.argv) == 2 and sys.argv[1] in set(DEPENDENCIES) | {'status', 'fetch-backup', 'fetch-config'}, 'FIXED_OPERATION_REQUIRED')
    stage = sys.argv[1]
    root = Path(__file__).resolve().parent
    release = Release(root)
    if stage.startswith('fetch-'):
        release.fetch(stage)
        return
    if stage == 'status':
        result = release.status()
    else:
        # Keep command settlement/receipt time inside the owner's SSH bound.
        limits = {'prepare':480, 'protect':840, 'recover':840, 'provision':90,
                  'migrate':330, 'deploy':900, 'postcheck':120, 'copies-backup':60, 'copies-config':60}
        if stage in limits:
            release.c.wall_end = time.time() + limits[stage]
            release.c.mono_end = time.monotonic() + limits[stage]
        release.stages.begin(stage, DEPENDENCIES[stage])
        request = decode(sys.stdin.buffer.read(65537))
        need(set(request) <= {'keyConfirmation', 'copies'}, 'REQUEST_FIELDS_DENIED')
        if stage.startswith('copies-'):
            evidence = release.copies(stage, request)
        elif stage == 'provision':
            evidence = release.provision(request)
        else:
            evidence = getattr(release, stage)()
        result = release.stages.complete(stage, evidence)
    print(canonical(result).decode(), flush=True)


if __name__ == '__main__':
    try:
        def interrupted(_number, _frame):
            raise Stop('OWNER_OPERATION_INTERRUPTED')
        for name in ('SIGTERM', 'SIGINT', 'SIGHUP'):
            signal.signal(getattr(signal, name), interrupted)
        main()
    except BaseException as exc:
        code = exc.code if isinstance(exc, Stop) else str(exc) if re.fullmatch('[A-Z0-9_]{1,100}', str(exc)) else 'REMOTE_FAILURE_REDACTED'
        result = {'protocol': 'FAI_M1_ASSISTED_STAGE_R21', 'status': 'STOP', 'stage': sys.argv[1] if len(sys.argv) == 2 else 'ADMISSION',
                  'code': code, 'details': exc.details if isinstance(exc, Stop) else {}, 'utc': utc(), 'agentRealKeyAccess': False}
        try:
            exclusive(Path(__file__).parent / 'evidence' / (result['stage'] + '.stop.json'), result)
        except BaseException:
            result['stopReceiptWritten'] = False
        print(canonical(result).decode(), flush=True)
        raise SystemExit(2)
