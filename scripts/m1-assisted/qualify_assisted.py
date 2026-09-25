"""CI-only qualification of the new restore/provision/migration delta, using saved images."""
import hashlib
import io
import json
import os
from pathlib import Path
import secrets
import socket
import sys
import tarfile
import time
import uuid

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import Commands, Stop, canonical, decode, digest, exclusive, load, module, need
from isolated_restore import Restore, ledger_valid, LEDGER_SQL
from remote_release import PROVISION_NODE


def main():
    need(os.environ.get('CI') == os.environ.get('GITHUB_ACTIONS') == 'true' and socket.gethostname() != 'fai-crm-prod-02', 'CI_SYNTHETIC_ONLY')
    need(len(sys.argv) == 2, 'QUALIFIED_IMAGE_ARCHIVE_REQUIRED')
    root = Path(__file__).resolve().parents[2]
    b = load(root / 'scripts/m1-assisted/binding.json')
    image_archive = Path(sys.argv[1]).resolve()
    need(digest(image_archive) == b['imageArchiveSha256'], 'QUALIFIED_IMAGE_ARCHIVE_CHANGED')
    c = Commands(1500, root)
    c.env.update(PATH=os.environ['PATH'], HOME=os.environ['HOME'])
    c.docker('LOAD_EXISTING_QUALIFIED_IMAGES', 'load', '--input', image_archive, seconds=300)
    for image in ('candidateImage', 'returnImage'):
        need(c.inspect('image', b[image])['Id'] == b[image], 'QUALIFIED_IMAGE_ID')
    c.docker('PULL_ISOLATED_TEST_DATABASE_IMAGE', 'pull', 'postgres:16-alpine', seconds=120)
    pg_image = c.inspect('image', 'postgres:16-alpine')['Id']
    run = uuid.uuid4().hex
    prefix = 'm1-assisted-ci-' + run
    work = root / prefix
    work.mkdir(mode=0o700)
    source = work / 'source46'
    source.mkdir(mode=0o700)
    source_prisma = c.run('SOURCE46_ARCHIVE', ['git', 'archive', b['sourceCommit'], 'prisma'])
    with tarfile.open(fileobj=io.BytesIO(source_prisma)) as archive:
        for item in archive:
            need(not item.issym() and not item.islnk() and '..' not in Path(item.name).parts, 'SOURCE_PATH')
        archive.extractall(source, filter='data')
    schema = source / 'prisma'
    need({p.parent.name:digest(p) for p in (schema/'migrations').glob('*/migration.sql')} == b['ledger46'], 'SOURCE46_INVENTORY')
    network = c.docker('CI_NETWORK', 'network', 'create', '--internal', '--label', 'fai.synthetic=m1-assisted-r21', prefix).decode().strip()
    pg = None
    created = []
    password = secrets.token_hex(24)
    database = 'fai_crm_test'
    url = 'postgresql://postgres:' + password + '@postgres:5432/' + database
    print('::add-mask::' + password, flush=True)
    try:
        pg = c.docker('CI_POSTGRES_CREATE', 'create', '--name', prefix + '-source', '--network', network,
            '--network-alias', 'postgres', '--label', 'fai.synthetic=m1-assisted-r21', '--restart', 'no',
            '--tmpfs', '/var/lib/postgresql/data:rw,size=1610612736', '-e', 'POSTGRES_PASSWORD=' + password,
            '-e', 'POSTGRES_DB=' + database, pg_image).decode().strip()
        created.append(pg)
        c.docker('CI_POSTGRES_START', 'start', pg)
        for _ in range(50):
            try:
                c.docker('CI_POSTGRES_READY', 'exec', pg, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', database)
                break
            except Stop:
                time.sleep(1)
        def node(code, data=None):
            return c.docker('CI_NODE', 'run', '--rm', '-i', '--network', network,
                '--env', 'DATABASE_URL=' + url, '--entrypoint', 'node', b['candidateImage'],
                '--import', 'tsx', '-e', code, data=data, seconds=90)
        c.docker('CI_SCHEMA46', 'run', '--rm', '--network', network, '--mount', 'type=bind,source=' + str(schema) + ',target=/schema,readonly',
            '--env', 'DATABASE_URL=' + url, '--entrypoint', 'node', b['candidateImage'],
            'node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', '/schema/schema.prisma', seconds=240)
        def rows():
            raw = c.docker('CI_LEDGER', 'exec', pg, 'psql', '-U', 'postgres', '-d', database, '-XqAt', '-F', '\t', '-c', LEDGER_SQL).decode()
            return [line.split('\t') for line in raw.splitlines()]
        before = rows()
        ledger_valid(before, b['ledger46'])
        backup = work / 'set46'
        backup.mkdir(mode=0o700)
        with (backup / 'postgres.dump').open('xb') as output:
            c.docker('CI_DUMP', 'exec', pg, 'pg_dump', '-U', 'postgres', '-d', database, '-Fc', output=output)
        with tarfile.open(backup / 'documents.tar.gz', 'w:gz') as archive:
            root_info = tarfile.TarInfo('.')
            root_info.type = tarfile.DIRTYPE
            root_info.mode, root_info.uid, root_info.gid = 0o750, 1001, 1001
            archive.addfile(root_info)
            payload = b'M1 synthetic restore fixture\n'
            info = tarfile.TarInfo('./synthetic.txt')
            info.size, info.mode, info.uid, info.gid = len(payload), 0o640, 1001, 1001
            archive.addfile(info, io.BytesIO(payload))
        kit = module(root / 'scripts/n05/recovery_kit.py', 'ci_recovery_kit', b['canonicalPrograms']['scripts/n05/recovery_kit.py'])
        restore_dir = work / 'recovery'
        restore_dir.mkdir(mode=0o700)
        restored = Restore(c, restore_dir, run, pg_image, b['candidateImage'], kit).run(backup, b['ledger46'])
        need(rows() == before, 'RESTORE_CHANGED_SOURCE_LEDGER')
        need(c.inspect('container', pg)['State']['Running'], 'RESTORE_STOPPED_SOURCE')
        # Exercise the actual helper included in the exact saved candidate image.
        node("const{PrismaClient}=require('@prisma/client');const d=new PrismaClient();d.user.create({data:{email:'m1-ci@example.invalid',name:'Synthetic M1 admin',passwordHash:'NONLOGIN_SYNTHETIC',role:'admin'}}).finally(()=>d.$disconnect());")
        secret = secrets.token_hex(48)
        print('::add-mask::' + secret, flush=True)
        inputs = {'version':1, 'secret':secret, 'hashes':{p:h for p,h in b['canonicalPrograms'].items() if p.startswith('src/')}}
        provisioned = decode(node(PROVISION_NODE, canonical(inputs)))
        need(provisioned['version'] == 1 and provisioned['status'] == 'ACTIVE', 'CI_KEY_PROVISION')
        try:
            node(PROVISION_NODE, canonical(inputs))
        except Stop:
            pass
        else:
            raise Stop('SECOND_KEY_PROVISION_NOT_DENIED')
        audit = decode(node("const{PrismaClient}=require('@prisma/client');const d=new PrismaClient();(async()=>console.log(JSON.stringify({keys:await d.applicationKeyVersion.count(),audit:await d.auditLog.count({where:{event:'application_key_version_rotated'}})})))().finally(()=>d.$disconnect());"))
        need(audit == {'keys':1,'audit':1}, 'AUDITED_INITIAL_REGISTRATION_COUNT')
        c.docker('CI_EXACT_MIGRATIONS47_48', 'run', '--rm', '--network', network, '--env', 'DATABASE_URL=' + url,
            '--entrypoint', 'node', b['candidateImage'], 'node_modules/prisma/build/index.js', 'migrate', 'deploy', seconds=240)
        after = rows()
        ledger_valid(after, b['ledger48'])
        need(after[:46] == before, 'PREFIX46_NOT_PRESERVED')
        result = {'protocol':'FAI_M1_ASSISTED_QUALIFICATION_R21','status':'PASS','synthetic':True,
                  'candidate':b['candidate'],'candidateImage':b['candidateImage'],'imagesRebuilt':False,
                  'imageArchiveBytes':image_archive.stat().st_size,'imageArchiveSha256':b['imageArchiveSha256'],
                  'restore':restored,'initialStepUpRegistrationAudited':True,'duplicateProvisionDenied':True,
                  'migrations47And48Verified':True,'prior46Unchanged':True,'productionConnected':False}
        exclusive(root / 'm1-assisted-ci-receipt.json', result)
        print(canonical(result).decode(), flush=True)
    finally:
        for cid in created:
            raw = c.inspect('container', cid)
            need(raw['Config']['Labels'].get('fai.synthetic') == 'm1-assisted-r21' and raw['Id'] == cid, 'CI_CLEANUP_IDENTITY')
            c.docker('CI_CLEANUP_CONTAINER', 'rm', '-f', cid)
        need(c.inspect('network', network)['Id'] == network, 'CI_NETWORK_IDENTITY')
        c.docker('CI_CLEANUP_NETWORK', 'network', 'rm', network)


if __name__ == '__main__':
    try:
        main()
    except Stop as exc:
        print(canonical({'status':'STOP','code':exc.code,'details':exc.details}).decode(), flush=True)
        raise SystemExit(2)
