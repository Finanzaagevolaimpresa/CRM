"""Real N05 backup on a disposable CI daemon; no connection to production."""
import hashlib
import os
from pathlib import Path
import secrets
import socket
import time
import uuid

from common import Stop, digest, exclusive, module, need


def qualify_backup_reference(c, repo, binding):
    need(os.environ.get('CI') == os.environ.get('GITHUB_ACTIONS') == 'true' and
         socket.gethostname() != 'fai-crm-prod-02', 'CI_ONLY_BACKUP_REFERENCE_TEST')
    need(c.docker('CI_EMPTY_PRODUCTION_NAMESPACE', 'ps', '-aq', '--filter',
                  'label=com.docker.compose.project=fai-crm').strip() == b'', 'CI_NAMESPACE_OCCUPIED')
    backup_module = module(repo/'scripts/pr140/owner_backup46.py', 'ci_backup_ref_r25',
                           binding['backupProgramSha256'])
    work = repo/('m1-backup-ref-ci-'+uuid.uuid4().hex)
    work.mkdir(mode=0o700)
    source, staged, sets = work/'source', work/'staged', work/'sets'
    for path in (source, staged, sets):
        path.mkdir(mode=0o700)
    originals = {name:c.run('CI_ORIGINAL_BACKUP_TOOL', ['git','show',backup_module.SOURCE+':'+name])
                 for name in backup_module.BACKUP_TOOL_PATHS}
    adapted = backup_module.staged_backup_tools(originals, source)
    for name, data in originals.items():
        path = source/name
        path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
        exclusive(path,data)
        path.chmod(0o700)
    for name, data in adapted.items():
        path = staged/name
        path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
        exclusive(path,data)
        path.chmod(0o700)
    compose = 'docker-compose.prod.example.yml'
    exclusive(source/compose,c.run('CI_ORIGINAL_COMPOSE',['git','show',backup_module.SOURCE+':'+compose]))
    password = secrets.token_hex(24)
    print('::add-mask::'+password,flush=True)
    database = 'm1_backup_ci'
    env_text = ('POSTGRES_DB='+database+'\nPOSTGRES_USER=postgres\nPOSTGRES_PASSWORD='+password+
                '\nDATABASE_URL=postgresql://postgres:'+password+'@postgres:5432/'+database+'\n')
    exclusive(source/'.env.production',env_text.encode())
    tag = 'fai-crm:pr999-'+binding['candidate'][:12]
    c.docker('CI_BOUND_TAG','tag',binding['candidateImage'],tag)
    labels = ('--label','com.docker.compose.project=fai-crm','--label','fai.synthetic=m1-backup-reference-r25')
    network = None
    volumes, containers = [], []
    try:
        network = c.docker('CI_BACKUP_NETWORK','network','create','--internal',*labels,
            '--label','com.docker.compose.network=default','fai-crm_default').decode().strip()
        for logical in ('crm_documents','postgres_data'):
            name = 'fai-crm_'+logical
            c.docker('CI_BACKUP_VOLUME','volume','create',*labels,'--label','com.docker.compose.volume='+logical,name)
            volumes.append(name)
        pg = c.docker('CI_BACKUP_POSTGRES','create','--name','fai-crm-postgres-1',*labels,
            '--label','com.docker.compose.service=postgres','--network',network,'--network-alias','postgres',
            '--mount','type=volume,source=fai-crm_postgres_data,target=/var/lib/postgresql/data',
            '-e','POSTGRES_USER=postgres','-e','POSTGRES_PASSWORD='+password,'-e','POSTGRES_DB='+database,
            'postgres:16-alpine').decode().strip()
        containers.append(pg)
        c.docker('CI_BACKUP_POSTGRES_START','start',pg)
        for _ in range(50):
            try:
                c.docker('CI_BACKUP_POSTGRES_READY','exec',pg,'pg_isready','-h','127.0.0.1','-U','postgres','-d',database)
                break
            except Stop:
                time.sleep(1)
        c.docker('CI_BACKUP_SYNTHETIC_LEDGER','exec',pg,'psql','-Xq','-v','ON_ERROR_STOP=1','-U','postgres','-d',database,
            '-c','CREATE TABLE "_prisma_migrations" (finished_at timestamptz, rolled_back_at timestamptz); '
                 'INSERT INTO "_prisma_migrations" VALUES (CURRENT_TIMESTAMP,NULL)')
        app = c.docker('CI_BACKUP_APP_BY_DIGEST','create','--name','fai-crm-app-1',*labels,
            '--label','com.docker.compose.service=app','--network',network,
            '--mount','type=volume,source=fai-crm_crm_documents,target=/var/lib/fai-crm/documents',
            '--entrypoint','sh',binding['candidateImage'],'-c','exec sleep 600').decode().strip()
        containers.append(app)
        c.docker('CI_BACKUP_APP_START','start',app)
        raw = c.inspect('container',app)
        need(raw['Config']['Image'] == raw['Image'] == binding['candidateImage'], 'CI_DIGEST_REFERENCE_NOT_EXERCISED')
        endpoint = os.environ['M1_CI_DOCKER_SOCKET']
        if endpoint.startswith('/'):
            endpoint = 'unix://'+endpoint
        env = {'DOCKER_HOST':endpoint,'FAI_ENVIRONMENT':'production','FAI_ENVIRONMENT_SENTINEL':'FAI_CRM_PRODUCTION_V1',
            'COMPOSE_PROJECT_NAME':'fai-crm','COMPOSE_FILE':str(source/compose),'ENV_FILE':str(source/'.env.production'),
            'APP_ENV_FILE':str(source/'.env.production'),'APP_ORIGIN':'https://desk.finanzaagevolaimpresa.it',
            'APP_IMAGE':tag,'POSTGRES_IMAGE':'postgres:16-alpine','SOURCE_COMMIT':binding['candidate'],
            'SOURCE_TREE':binding['candidateTree'],'EXPECTED_APP_IMAGE_ID':binding['candidateImage'],
            'EXPECTED_DATABASE_NAME':database,'EXPECTED_MIGRATION_COUNT':'1','BACKUP_CONSISTENCY':'application-quiesced',
            'BACKUP_IMAGE_PROVENANCE':'oci-labels','BACKUP_RESOURCE_PROVENANCE':'authorized-legacy-compose-identity',
            'CONFIRM_LEGACY_RESOURCE_IDENTITY':'FAI_CRM_N05_LEGACY_RESOURCE_BRIDGE_V1',
            'CONFIRM_PRODUCTION_BACKUP':'FAI_CRM_PRODUCTION_BACKUP_V1','BACKUP_ROOT':str(sets),'BACKUP_SET_ID':'synthetic'}
        command = ['bash','-c','set -Eeuo pipefail; source "$1"; n05_assert_environment_identity production; '
                   'n05_assert_authorized_legacy_compose_resources "$2" running','ci',str(source/'scripts/n05/lib.sh'),pg]
        try:
            c.run('CI_REPRODUCE_ORIGINAL_GUARD',command,env=env)
        except Stop as exc:
            need(exc.details.get('exitCode') == 1 and exc.details.get('stderrBytes') == 56 and
                 exc.details.get('stderrSha256') == '1da95e00e9135672b23f7195b27d790c04361ec2ce200449a492ea037e068dff',
                 'CI_ORIGINAL_ERROR_NOT_REPRODUCED')
        else:
            raise Stop('CI_ORIGINAL_GUARD_UNEXPECTEDLY_PASSED')
        command[-2] = str(staged/'scripts/n05/lib.sh')
        c.run('CI_CORRECTED_LIVE_GUARD',command,env=env)
        c.docker('CI_BACKUP_APP_QUIESCE','stop','--time','5',app)
        wrapper = staged/'scripts/backup-docker-prod.sh'
        c.run('CI_CORRECTED_FULL_PREFLIGHT',[str(wrapper),'--preflight'],env=env,seconds=120)
        c.run('CI_CORRECTED_FULL_BACKUP',[str(wrapper),'--create'],env=env,seconds=180)
        c.docker('CI_BACKUP_APP_RESUME','start',app)
        need(c.inspect('container',app)['State']['Running'], 'CI_BACKUP_APP_NOT_RESUMED')
        result = sets/'synthetic'
        need(all((result/name).is_file() for name in ('MANIFEST.txt','SHA256SUMS','postgres.dump','documents.tar.gz')),
             'CI_BACKUP_SET_INCOMPLETE')
        for name,data in originals.items():
            need((source/name).read_bytes() == data, 'CI_ORIGINAL_TOOL_MODIFIED')
        return {'originalErrorReproduced':True,'boundDigestReference':True,'liveGuardPassed':True,
                'fullPreflightPassed':True,'fullBackupPassed':True,'appResumed':True,'originalToolsUnchanged':True,
                'databaseSha256':digest(result/'postgres.dump'),'manifestSha256':digest(result/'MANIFEST.txt'),
                'productionConnected':False}
    finally:
        for cid in reversed(containers):
            raw = c.inspect('container',cid)
            need(raw['Id'] == cid and raw['Config']['Labels'].get('fai.synthetic') == 'm1-backup-reference-r25',
                 'CI_BACKUP_CLEANUP_IDENTITY')
            c.docker('CI_BACKUP_CLEANUP','rm','-f',cid)
        for name in volumes:
            raw = c.inspect('volume',name)
            need(raw['Labels'].get('fai.synthetic') == 'm1-backup-reference-r25', 'CI_VOLUME_IDENTITY')
            c.docker('CI_BACKUP_VOLUME_CLEANUP','volume','rm',name)
        if network:
            need(c.inspect('network',network)['Id'] == network, 'CI_NETWORK_IDENTITY')
            c.docker('CI_BACKUP_NETWORK_CLEANUP','network','rm',network)
