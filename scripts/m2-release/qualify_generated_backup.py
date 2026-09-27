"""CI-only reproduction and real schema48 backup through the generated N05 adapter."""
import hashlib
import os
from pathlib import Path
import secrets
import socket
import uuid
import time

from common import Stop, digest, exclusive, module, need
import package_builder as builder


def qualify_generated_backup(c, repo, binding):
    need(os.environ.get('CI') == os.environ.get('GITHUB_ACTIONS') == 'true' and
         socket.gethostname() != 'fai-crm-prod-02', 'GENERATED_BACKUP_CI_ONLY')
    need(not c.docker('CI_EMPTY_BACKUP_NAMESPACE', 'ps', '-aq', '--filter',
                      'label=com.docker.compose.project=fai-crm').strip(), 'CI_BACKUP_NAMESPACE_OCCUPIED')
    work = repo / ('m2-generated-backup-ci-' + uuid.uuid4().hex)
    work.mkdir(mode=0o700)
    source, staged, sets = work/'source', work/'staged', work/'sets'
    for p in (staged, sets): p.mkdir(mode=0o700)
    c.run('CI_BACKUP_SOURCE_CLONE', ['git', '-c', 'init.templateDir=', 'clone', '--no-checkout', str(repo), source])
    c.run('CI_BACKUP_SOURCE_CHECKOUT', ['git', '-C', source, '-c', 'core.hooksPath=/dev/null',
                                     'checkout', '--detach', binding['candidate']])
    files = builder.render('c'*32)
    backup_file = work/'generated_backup.py'
    exclusive(backup_file, files['backup48_after.py'])
    backup = module(backup_file, 'ci_generated_m2_backup', digest(backup_file))
    originals = {name:(source/name).read_bytes() for name in backup.BACKUP_TOOL_PATHS}
    adapted = backup.staged_backup_tools(originals, source)
    for name, raw in adapted.items():
        path = staged/name
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        exclusive(path, raw)
        path.chmod(0o700)
    password = secrets.token_hex(24)
    print('::add-mask::'+password, flush=True)
    database = 'm2_generated_backup_ci'
    exclusive(source/'.env.production', ('POSTGRES_DB='+database+'\nPOSTGRES_USER=postgres\nPOSTGRES_PASSWORD='+password+
        '\nDATABASE_URL=postgresql://postgres:'+password+'@postgres:5432/'+database+'\n').encode())
    labels = ('--label','com.docker.compose.project=fai-crm','--label','fai.synthetic=m2-generated-backup-r29')
    container_labels = labels+('--label','com.docker.compose.oneoff=False','--label','com.docker.compose.config-hash=synthetic-r29',
        '--label','com.docker.compose.container-number=1')
    containers, volumes, network = [], [], None
    try:
        network = c.docker('CI_GENERATED_NETWORK','network','create','--internal',*labels,
                           '--label','com.docker.compose.network=default','fai-crm_default').decode().strip()
        for logical in ('crm_documents','postgres_data'):
            name = 'fai-crm_'+logical
            c.docker('CI_GENERATED_VOLUME','volume','create',*labels,'--label','com.docker.compose.volume='+logical,name)
            volumes.append(name)
        pg = c.docker('CI_GENERATED_POSTGRES','create','--name','fai-crm-postgres-1',*container_labels,
            '--label','com.docker.compose.service=postgres','--network',network,'--network-alias','postgres',
            '--mount','type=volume,source=fai-crm_postgres_data,target=/var/lib/postgresql/data',
            '-e','POSTGRES_USER=postgres','-e','POSTGRES_PASSWORD='+password,'-e','POSTGRES_DB='+database,
            'postgres:16-alpine').decode().strip()
        containers.append(pg)
        c.docker('CI_GENERATED_PG_START','start',pg)
        for _ in range(50):
            try:
                c.docker('CI_GENERATED_PG_READY','exec',pg,'pg_isready','-h','127.0.0.1','-U','postgres','-d',database)
                break
            except Stop: time.sleep(1)
        url = 'postgresql://postgres:'+password+'@postgres:5432/'+database
        c.docker('CI_GENERATED_SCHEMA48','run','--rm','--network',network,'-e','DATABASE_URL='+url,'--entrypoint','node',
            binding['candidateImage'],'node_modules/prisma/build/index.js','migrate','deploy',seconds=240)
        app = c.docker('CI_GENERATED_APP','create','--name','fai-crm-app-1',*container_labels,
            '--label','com.docker.compose.service=app','--network',network,
            '--mount','type=volume,source=fai-crm_crm_documents,target=/var/lib/fai-crm/documents',
            '--entrypoint','sh',binding['candidateImage'],'-c','exec sleep 600').decode().strip()
        containers.append(app)
        c.docker('CI_GENERATED_APP_START','start',app)
        need(c.inspect('container',app)['Config']['Image'] == binding['candidateImage'], 'CI_GENERATED_DIGEST_REFERENCE')
        plan = {'runId':'d'*32,'target':{'appId':app,'appImage':binding['candidateImage'],'postgresId':pg},'databaseName':database}
        operation = backup.Backup(plan)
        operation.root, operation.work, operation.tool_root = source, work, staged
        operation.set_id = 'generated-schema48'
        # Keep production logic intact; only bind the disposable CI engine and cwd.
        endpoint = os.environ['M2_CI_DOCKER_SOCKET']
        if endpoint.startswith('/'): endpoint = 'unix://'+endpoint
        env = operation.environment() | operation.backup_environment() | {'DOCKER_HOST':endpoint}
        operation.run = lambda args, env=None, cap=90, command_id=None: c.run(
            command_id or 'CI_GENERATED_COMMAND', args,
            env=operation.environment() | (env or {}) | {'DOCKER_HOST':endpoint}, seconds=cap)
        command = ['bash','-c','set -Eeuo pipefail; source "$1"; n05_assert_environment_identity production; '
                   'n05_assert_authorized_legacy_compose_resources "$2" running',
                   'ci',str(source/'scripts/n05/lib.sh'),pg]
        try: c.run('CI_REPRODUCE_R28_IMAGE_GUARD',command,env=env)
        except Stop as exc:
            need(exc.details.get('exitCode') == 1 and exc.details.get('stderrBytes') == 47 and
                 exc.details.get('stderrSha256') == '31a75e9ac33507086b8e92198b79fdb6391c8dea309a13bdc9e08fb3a466bd72',
                 'CI_R28_ERROR_NOT_REPRODUCED')
        else: raise Stop('CI_R28_ERROR_NOT_EXERCISED')
        operation.resource_preflight()
        c.docker('CI_GENERATED_QUIESCE','stop','--time','5',app)
        wrapper = staged/'scripts/backup-docker-prod.sh'
        c.run('CI_GENERATED_PREFLIGHT',[str(wrapper),'--preflight'],env=env,seconds=120)
        c.run('CI_GENERATED_CREATE',[str(wrapper),'--create'],env=env,seconds=180)
        c.docker('CI_GENERATED_RESUME','start',app)
        need(c.inspect('container',app)['State']['Running'], 'CI_GENERATED_APP_NOT_RESUMED')
        result = sets/'generated-schema48'
        manifest = dict(line.split('=',1) for line in (result/'MANIFEST.txt').read_text().splitlines())
        need(manifest['migration_count'] == '48' and manifest['source_commit'] == binding['candidate'] and
             manifest['app_image_id'] == binding['candidateImage'], 'CI_GENERATED_MANIFEST')
        c.run('CI_GENERATED_VERIFY',['bash',str(staged/'scripts/n05/verify-backup-manifest.sh'),str(result)],
              env={'EXPECTED_ENVIRONMENT':'production','EXPECTED_PROJECT':'fai-crm','EXPECTED_SOURCE_COMMIT':binding['candidate'],
                   'EXPECTED_SOURCE_TREE':binding['candidateTree'],'EXPECTED_APP_IMAGE_ID':binding['candidateImage'],
                   'EXPECTED_MIGRATION_COUNT':'48','EXPECTED_IMAGE_PROVENANCE':'oci-labels',
                   'EXPECTED_RESOURCE_PROVENANCE':'authorized-legacy-compose-identity'})
        need(all((source/name).read_bytes() == raw for name,raw in originals.items()), 'CI_GENERATED_CANONICAL_CHANGED')
        return {'r28ErrorReproduced':True,'errorBytes':47,'errorSha256':hashlib.sha256(
            b'N05_FAILED|code=PRODUCTION_IMAGE_NOT_IMMUTABLE\n').hexdigest(),'generatedResourcePreflightPassed':True,
            'generatedEnvironmentUsed':True,'fullSchema48BackupPassed':True,'manifestVerified':True,'appResumed':True,
            'sourceToolsUnchanged':True,'databaseSha256':digest(result/'postgres.dump'),
            'manifestSha256':digest(result/'MANIFEST.txt'),'productionConnected':False}
    finally:
        for cid in reversed(containers):
            raw = c.inspect('container',cid)
            need(raw['Id']==cid and raw['Config']['Labels'].get('fai.synthetic')=='m2-generated-backup-r29', 'CI_GENERATED_CLEANUP_IDENTITY')
            c.docker('CI_GENERATED_CLEANUP','rm','-f',cid)
        for name in volumes:
            need(c.inspect('volume',name)['Labels'].get('fai.synthetic')=='m2-generated-backup-r29', 'CI_GENERATED_VOLUME_IDENTITY')
            c.docker('CI_GENERATED_VOLUME_CLEANUP','volume','rm',name)
        if network:
            need(c.inspect('network',network)['Id']==network, 'CI_GENERATED_NETWORK_IDENTITY')
            c.docker('CI_GENERATED_NETWORK_CLEANUP','network','rm',network)
