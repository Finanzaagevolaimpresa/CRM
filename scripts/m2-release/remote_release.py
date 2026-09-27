"""Finite M1/schema48 -> M2/schema48 owner release; no credential provisioning.

The unchanged M1 helpers provide bounded command supervision, N05 transition,
encryption and isolated recovery. Only the listed stages below are callable.
"""
import contextlib
import io
import os
from pathlib import Path
import re
import signal
import socket
import sys
import time

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import Commands, Stop, Stages, canonical, decode, digest, exclusive, load, module, need, private, utc, value_sha
from isolated_restore import Restore, ledger_valid
from image_binding import complete_binding
from qualified_images import archive_metadata, verify_images
from registry_settlement import COUNT_SQL, PREFLIGHT_SQL, parse_counts, registry_engine
from sealed_programs import BASE as BASE_STRING, M1, M1_TREE, M1_RUNTIME, M2, M2_TREE, MODES
from transition_base import Release as Transition

BASE = Path(BASE_STRING)
OLD = BASE / M1_RUNTIME
DEPENDENCIES = {'prepare': [], 'backup': ['prepare'], 'protect': ['backup'],
    'copies-backup': ['protect'], 'recover': ['copies-backup'], 'migrate': ['recover'],
    'deploy': ['migrate'], 'postcheck': ['deploy'], 'postbackup': ['postcheck'],
    'postprotect': ['postbackup'], 'copies-postbackup': ['postprotect'], 'final': ['copies-postbackup']}
LIMITS = {'prepare': 540, 'backup': 1650, 'protect': 840, 'copies-backup': 60, 'recover': 840,
          'migrate': 120, 'deploy': 900, 'postcheck': 120, 'postbackup': 1650,
          'postprotect': 840, 'copies-postbackup': 60, 'final': 150, 'status': 120}
KEY_SQL = '''BEGIN READ ONLY; SET LOCAL statement_timeout='8s';
SELECT json_build_object('admins',(SELECT COUNT(*) FROM "User" WHERE role='admin' AND active AND "deletedAt" IS NULL),
'databaseBytes',pg_database_size(current_database())); ROLLBACK;'''


class Release(Transition):
    def __init__(self, root):
        self.root = private(root, directory=True)
        self.manifest = load(private(root / 'package.json'))
        self.b = load(private(root / 'binding.json'))
        self.run_id = self.manifest['runId']
        self.post_id = self.manifest['postRunId']
        need(all(re.fullmatch('[0-9a-f]{32}', r) for r in (self.run_id, self.post_id)) and
             self.run_id != self.post_id, 'RUN_BINDING')
        need(root == BASE / ('m2-release-r26-' + self.run_id), 'PACKAGE_PATH_BINDING')
        need(self.manifest['candidate'] == self.b['candidate'] == M2 and
             self.b['candidateTree'] == M2_TREE and self.b['sourceCommit'] == M1 and
             self.b['sourceTree'] == M1_TREE, 'RELEASE_IDENTITY')
        for name, entry in self.manifest['files'].items():
            need(Path(name).name == name, 'PACKAGE_MEMBER_NAME')
            p = private(root / name)
            need(p.stat().st_size == entry['bytes'] and digest(p) == entry['sha256'], 'PACKAGE_MEMBER_CHANGED')
        self.review = load(root / 'review.json')
        need(self.review['status'] == 'PASS_FOR_MERGE' and self.review['candidate'] == M2 and
             self.review['deltaSha256'] == self.manifest['deltaSha256'] and
             self.review['recoveryScope'] == 'NEW_PLAINTEXT_DATABASE_AND_DOCUMENT_SET', 'REVIEW_NOT_QUALIFIED')
        self.work = private(root / 'evidence', directory=True)
        self.runtime = BASE / ('release-' + M2[:12] + '-m2-' + self.run_id)
        self.c = Commands(1800, OLD)
        self.stages = Stages(self.work, self.run_id)
        self.t = self.b['target']
        import pwd
        need(socket.gethostname() == self.t['hostname'] == 'fai-crm-prod-02' and
             os.getuid() == os.getgid() == 1000 and pwd.getpwuid(1000).pw_name == 'faiadmin', 'TARGET_IDENTITY')
        need(not any(os.environ.get(k) for k in ('DOCKER_HOST','DOCKER_CONTEXT','COMPOSE_FILE','COMPOSE_PROFILES')), 'AMBIENT_SELECTOR_DENIED')
        need(self.c.docker('ENGINE_IDENTITY', 'info', '--format', '{{.ID}}').decode().strip() == self.t['engineId'], 'ENGINE_IDENTITY')

    def source(self, role):
        need(role in ('before', 'after'), 'SOURCE_ROLE')
        if role == 'before':
            return self.t, M1, M1_TREE, self.run_id
        deployed = self.stages.result('deploy')
        need(deployed and deployed['candidate'] == M2 and deployed['healthy'], 'DEPLOY_NOT_CONFIRMED')
        return self.t | {'appId': deployed['appId'], 'appImage': self.b['candidateImage']}, M2, M2_TREE, self.post_id

    def observer(self, role='before'):
        target, _, _, _ = self.source(role)
        name = 'observe48_' + role + '.py'
        m = module(self.root / name, 'm2_observer_' + role, self.manifest['files'][name]['sha256'])
        binding = {k:target[k] for k in ('engineId','appId','appImage','postgresId','postgresImage','networkId')}
        binding.update(candidate=M2, ledger=self.b['ledger48'])
        observed = m.Observer(binding).observe()
        need(observed['stepUpVersion'] == 1 and observed['stepUpActiveCount'] == 1 and
             observed['stepUpRegisteredActive'] and observed['stepUpDigestMatches'], 'EXISTING_STEP_UP_DRIFT')
        return observed

    def prepare(self):
        from consumed_preparation import reconcile
        consumed = reconcile(remote=True)
        before = self.observer()
        need(before['otherActiveDbSessions'] == 0 and before['availableBytes'] >= 12 * 1024**3, 'SOURCE_CAPACITY_OR_WRITERS')
        metadata = decode(self.sql(KEY_SQL))
        need(metadata['admins'] == 1 and 0 < metadata['databaseBytes'] < 256 * 1024**2, 'RECOVERY_CAPACITY_OR_ADMIN')
        need(parse_counts(self.sql(PREFLIGHT_SQL)) == {'revokedCount':0,'auditCount':0}, 'SESSION_PREFLIGHT')
        memory = dict(line.split(':',1) for line in Path('/proc/meminfo').read_text().splitlines())
        need(int(memory['MemAvailable'].split()[0]) >= 3 * 1024**2, 'ISOLATED_RECOVERY_MEMORY_LOW')
        documents = decode(self.c.docker('DOCUMENT_CAPACITY_METADATA', 'exec', self.t['appId'], 'node', '-e',
            "const fs=require('fs'),p=require('path');let bytes=0,files=0;function v(d){for(const n of fs.readdirSync(d)){const f=p.join(d,n),s=fs.lstatSync(f);if(s.isSymbolicLink()||(!s.isFile()&&!s.isDirectory()))throw Error();if(s.isDirectory())v(f);else{bytes+=s.size;files++}if(files>20000||bytes>201326592)throw Error()}}v('/var/lib/fai-crm/documents');console.log(JSON.stringify({bytes,files}));"))
        need(self.c.run('AGE_VERSION', ['age','--version']).decode().strip() == 'v1.3.2', 'AGE_VERSION')
        archive = private(self.root / 'release-images.tar.gz')
        binding = complete_binding(archive, self.b)
        archive_metadata(archive, binding)
        store = decode(self.c.docker('IMAGE_STORE', 'info','--format',
            '{"version":{{json .ServerVersion}},"driver":{{json .Driver}},"status":{{json .DriverStatus}}}'))
        need(store['version'] == self.b['imageStoreVersion'] and store['driver'] == 'overlayfs' and
             ['driver-type','io.containerd.snapshotter.v1'] in (store['status'] or []), 'IMAGE_STORE_DRIFT')
        images = verify_images(self.c, archive, binding)
        need(not self.runtime.exists(), 'CANDIDATE_RUNTIME_OCCUPIED')
        self.c.run('RUNTIME_CLONE', ['git','-c','init.templateDir=','clone','--no-checkout','--branch',
                   'codex/m2-runtime-candidate-r26',self.root/'candidate.bundle',self.runtime],seconds=120)
        self.c.run('RUNTIME_CHECKOUT', ['git','-C',self.runtime,'-c','core.hooksPath=/dev/null','checkout','-b','main',M2])
        need(self.c.run('RUNTIME_IDENTITY',['git','-C',self.runtime,'rev-parse','HEAD','HEAD^{tree}']).decode().split() == [M2,M2_TREE], 'RUNTIME_IDENTITY')
        for name, expected in self.b['canonicalPrograms'].items():
            need(digest(private(self.runtime/name)) == expected, 'QUALIFIED_PROGRAM_DRIFT')
        config = private(OLD/'.env.production')
        exclusive(self.runtime/'.env.production', config.read_bytes())
        need(digest(private(self.runtime/'.env.production')) == digest(config), 'CONFIGURATION_COPY_CHANGED')
        after = self.observer()
        stable = ('appHealthy','postgresHealthy','postgresStartedAt','postgresRestartCount','ledgerChecksumsMatch','closedGates')
        need(all(after[k] == before[k] for k in stable), 'SOURCE_CHANGED_DURING_PREPARATION')
        return {'candidate':M2,'observation':after,'documentCapacity':documents,'images':images,
                'configurationSha256':digest(config),'configurationChanged':False,'newCredentialsCreated':False,
                'imageLoadPerformed':False,'runtimeApplicationChanged':False,'consumedPreparation':consumed,'migrationsRequired':[],
                'plannedSessionRevocation':True,'historicalAttemptsRepeated':False}

    def require_config_binding(self):
        prepared = self.stages.result('prepare')
        need(prepared and all(digest(private(p/'.env.production')) == prepared['configurationSha256']
                             for p in (OLD,self.runtime)), 'PROTECTED_CONFIGURATION_CHANGED')

    def backup(self):
        return self.make_backup('before')

    def postbackup(self):
        return self.make_backup('after')

    def make_backup(self, role):
        self.require_config_binding()
        before = self.observer(role)
        need(before['otherActiveDbSessions'] == 0, 'OTHER_DATABASE_WRITERS')
        target, commit, tree, run = self.source(role)
        name = 'backup48_' + role + '.py'
        script_hash = self.manifest['files'][name]['sha256']
        plan = {'protocol':'FAI_CRM_OWNER_BACKUP48_R26','runId':run,'sourceCommit':commit,'sourceTree':tree,
                'schema':48,'target':target,'databaseName':'fai_crm','ownerReceiptSha256':value_sha(before),
                'expectedLedger':self.b['ledger48'],'retention':'PRESERVE_EXISTING_LOCAL_AND_F_COPIES'}
        approval = {'status':'OWNER_EXPLICITLY_AUTHORIZED','confirmation':'FAI_CRM_SCHEMA48_BACKUP_SESSION_SETTLEMENT_R26',
                    'planSha256':value_sha(plan),'programSha256':script_hash,
                    'launcherSha256':self.manifest['files']['owner_release.py']['sha256'],'reviewReference':self.review['reference']}
        m = module(self.root/name,'m2_backup_'+role,script_hash)
        previous = {s:signal.getsignal(s) for s in (signal.SIGINT,signal.SIGTERM,signal.SIGHUP)}
        stream = io.StringIO()
        try:
            with contextlib.redirect_stdout(stream):
                status = m.entry_point({'plan':plan,'approval':approval},script_hash)
        finally:
            for s,handler in previous.items(): signal.signal(s,handler)
        result = decode(stream.getvalue())
        exclusive(self.work/('backup48-'+role+'-receipt.json'),result)
        need(status == 0 and result['status'] == 'BACKUP_VERIFIED_AND_APP_RESUMED','BACKUP_STOP',backupReceipt=result)
        return {'receipt':result,'freshObservation':self.observer(role)}

    def backup_set(self, role='before'):
        result = self.stages.result('backup' if role == 'before' else 'postbackup')['receipt']
        _,_,_,run = self.source(role)
        path = BASE/('evidence-backup48-'+run)/'sets'/('backup48-'+run)
        need(result['set'] == str(path),'BACKUP_SET_PATH')
        return path,result

    def protect(self):
        return self.protect_set('before')

    def postprotect(self):
        return self.protect_set('after')

    def protect_set(self, role):
        kit = self.kit()
        backup,receipt = self.backup_set(role)
        target,commit,tree,run = self.source(role)
        config = backup.parent.parent/'configuration'
        crypto = self.work/('crypto-'+role)
        crypto.mkdir(mode=0o700)
        exclusive(crypto/'application-environment',private(config/'.env.production').read_bytes())
        operations = self.work/('protect-'+role)
        operations.mkdir(mode=0o700)
        expected = {'environment':'production','project':'fai-crm','source_commit':commit,'source_tree':tree,
            'app_image_id':target['appImage'],'image_provenance':'oci-labels',
            'resource_provenance':'authorized-legacy-compose-identity','migration_count':48,
            'manifest_sha256':receipt['manifestSha256'],'checksums_sha256':receipt['checksumsSha256']}
        name = 'backup48.bundle.tar' if role == 'before' else 'post-backup48.bundle.tar'
        plan = {'schema':kit.SCHEMA,'phase':'protect','data_class':'production','run_id':run,
            'host':target['hostname'],'work_root':str(operations),'tools':kit.tools_binding(),
            'backup_set':str(backup),'expected':expected,'recipient':self.b['recipient'],
            'configuration_dir':str(config),'cryptographic_dir':str(crypto),
            'configuration_sha256':kit.component_identity(config)['sha256'],
            'cryptographic_sha256':kit.component_identity(crypto)['sha256'],'output':str(self.work/name)}
        path = self.work/('protect-'+role+'-plan.json')
        exclusive(path,plan)
        result = decode(self.c.run('CANONICAL_N05_PROTECT',['python3','-I','-B','-S',
            self.runtime/'scripts/n05/recovery_kit.py','protect','--plan',path,'--plan-sha256',digest(path),
            '--authorize','FAI_CRM_N05_RECOVERY_PROTECT_V1'],seconds=780))
        need(result.pop('status',None) == 'PROTECTION_VERIFIED','N05_PROTECTION_NOT_VERIFIED')
        return {'ciphertext':name,**result,'recipientSha256':self.b['recipientSha256']}

    def recover(self):
        before = self.observer()
        folder = self.work/'isolated-recovery'
        folder.mkdir(mode=0o700)
        backup,_ = self.backup_set()
        result = Restore(self.c,folder,self.run_id,self.t['postgresImage'],self.b['candidateImage'],self.kit()).run(backup,self.b['ledger48'])
        after = self.observer()
        need(all(after[k] == before[k] for k in ('appHealthy','postgresHealthy','postgresStartedAt',
             'postgresRestartCount','ledgerChecksumsMatch','ledgerCount','closedGates')),'PRODUCTION_CHANGED_DURING_RECOVERY')
        return result | {'productionUnchanged':True}

    def models(self):
        self.require_config_binding()
        n05 = self.n05()
        baseline = load(BASE/('evidence-backup48-'+self.run_id)/'BASELINE.json')
        plan = {'project':'fai-crm','source_app':{'id':self.t['appId'],'image_id':self.t['appImage']},
            'candidate':{'id':self.b['candidateImage']},'return_image':{'id':self.b['returnImage']},
            'postgres':baseline['postgres'],'ledger':{'schema':'prisma-m1-48'},'configs':{}}
        prior = load(BASE/('evidence-backup48-'+self.run_id)/'configuration/frozen-source.json')
        adapter = n05.DockerEngine(plan,self.runtime)
        models = {'previous':prior,'candidate':adapter.model(self.b['candidateImage'],time.time()+60),
                  'return':adapter.model(self.b['returnImage'],time.time()+60)}
        for name,model in models.items():
            left,right = decode(canonical(model)),decode(canonical(prior))
            for value in (left,right):
                value['services']['app'].pop('image',None)
                value['services']['app'].pop('build',None)
            need(left == right,'UNAUTHORIZED_MODEL_CHANGE')
            path = self.work/('frozen-'+name+'.json')
            exclusive(path,model)
            plan['configs'][name] = {'path':str(path),'sha256':n05.sha(model),'kind':'frozen-compose-'+name}
        snapshot = adapter.snapshot(time.time()+90)
        need(snapshot['resources'] == baseline['resources'] and snapshot['postgres'] == baseline['postgres'] and
             snapshot['postgres_healthy'] and not snapshot['foreign_containers'] and not snapshot['migrators'] and
             snapshot['app']['id'] == self.t['appId'] and snapshot['app']['state'] == 'healthy','SOURCE_MODEL_DRIFT')
        exclusive(self.work/'models.json',plan)
        return plan,baseline

    def migrate(self):
        """Explicit NO-OP: the immutable 48-entry ledger must match exactly."""
        self.observer()
        rows = self.rows(self.b['ledger48'])
        self.models()
        return {'before':48,'after':48,'newMigrations':[],'databaseMigrationInvoked':False,
                'ledgerDigest':value_sha(rows),'migrator':None}

    def canonical_transition(self,n05,operation,path):
        original = n05.DockerEngine
        def sql(text,deadline):
            try:
                return self.c.docker('PLANNED_SESSION_SETTLEMENT','exec','-i',self.t['postgresId'],'sh','-ceu',
                    'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
                    data=text.encode(),seconds=min(15,max(.1,deadline-time.time()))).decode().strip()
            except Stop as exc:
                exclusive(self.work/('registry-'+operation+'-command-error.json'),
                    {'phase':'REGISTRY_PRE_START','code':exc.code,'details':exc.details,
                     'repetitionAllowed':False,'commandGroupsQuiet':self.c.groups_quiet})
                raise
        def receipt(identity,counts):
            need(re.fullmatch('[a-f0-9]{64}',identity),'SESSION_APP_ID')
            exclusive(self.work/('registry-start-'+identity+'.json'),
                {'rowsPreserved':True,'credentialsChanged':False,'appId':identity,**counts})
        n05.DockerEngine = registry_engine(original,receipt,sql)
        try:
            return super().canonical_transition(n05,operation,path)
        finally:
            n05.DockerEngine = original

    def copies(self,stage,request):
        original = self.stages.result('protect' if stage == 'copies-backup' else 'postprotect')
        copies = request.get('copies')
        need(isinstance(copies,dict) and set(copies) == {'C','F'},'TWO_APPROVED_COPIES_REQUIRED')
        need(copies['C']['physicalDisk'] != copies['F']['physicalDisk'],'PHYSICALLY_DISTINCT_COPIES_REQUIRED')
        for value in copies.values():
            need(value['sha256'] == original['bundle_sha256'] and value['bytes'] == original['bundle_bytes'] and
                 value['physicalIdentityVerified'] is True and value['readbackVerified'] is True,'COPY_EVIDENCE_MISMATCH')
        return {'copies':copies,'ciphertextSha256':original['bundle_sha256'],'ciphertextBytes':original['bundle_bytes']}

    def fetch(self,stage):
        result = self.stages.result('protect' if stage == 'fetch-backup' else 'postprotect')
        need(result and result['status'] == 'PASS','CIPHERTEXT_NOT_VERIFIED')
        name = 'backup48.bundle.tar' if stage == 'fetch-backup' else 'post-backup48.bundle.tar'
        path = private(self.work/name)
        need(digest(path) == result['bundle_sha256'] and path.stat().st_size == result['bundle_bytes'],'CIPHERTEXT_CHANGED')
        with path.open('rb') as source:
            for block in iter(lambda:source.read(1024*1024),b''): sys.stdout.buffer.write(block)
        sys.stdout.buffer.flush()

    def final(self):
        result = self.postcheck()
        result['ownerUsageProof'] = 'PENDING_FRESH_LOGIN_AND_M2_USAGE'
        result.update(preBackupVerified=True,postBackupVerified=True,
                      copiesBefore=self.stages.result('copies-backup'),copiesAfter=self.stages.result('copies-postbackup'),
                      recovery=self.stages.result('recover'),migrationsApplied=[],autonomyQualified=False)
        return result

    def status(self):
        states = {name:self.stages.result(name) or {'status':'UNCERTAIN_RECONCILE_ONLY' if
                  (self.work/(name+'.intent.json')).exists() else 'NOT_STARTED'} for name in DEPENDENCIES}
        app = self.c.docker('APP_MINIMUM_STATUS','ps','-a','--no-trunc','--filter',
            'label=com.docker.compose.project=fai-crm','--filter','label=com.docker.compose.service=app',
            '--format','{{.ID}}|{{.Image}}|{{.Status}}').decode().strip()
        return {'protocol':'FAI_M2_RECONCILIATION_R26','readOnly':True,'runId':self.run_id,
                'stages':states,'appMinimumStatus':app,'agentRealKeyAccess':False}


def main():
    os.umask(0o077)
    need(len(sys.argv) == 2 and sys.argv[1] in set(DEPENDENCIES)|{'status','fetch-backup','fetch-postbackup'},'FIXED_OPERATION_REQUIRED')
    stage = sys.argv[1]
    release = Release(Path(__file__).resolve().parent)
    if stage.startswith('fetch-'):
        release.fetch(stage)
        return
    release.c.wall_end = time.time()+LIMITS[stage]
    release.c.mono_end = time.monotonic()+LIMITS[stage]
    if stage == 'status':
        result = release.status()
    else:
        release.stages.begin(stage,DEPENDENCIES[stage])
        request = decode(sys.stdin.buffer.read(65537))
        need(set(request) <= ({'copies'} if stage.startswith('copies-') else set()),'REQUEST_FIELDS_DENIED')
        evidence = release.copies(stage,request) if stage.startswith('copies-') else getattr(release,stage)()
        result = release.stages.complete(stage,evidence)
    print(canonical(result).decode(),flush=True)


if __name__ == '__main__':
    try:
        def interrupted(_number,_frame): raise Stop('OWNER_OPERATION_INTERRUPTED')
        for s in (signal.SIGINT,signal.SIGTERM,signal.SIGHUP): signal.signal(s,interrupted)
        main()
    except BaseException as exc:
        code = exc.code if isinstance(exc,Stop) else str(exc) if re.fullmatch('[A-Z0-9_]{1,100}',str(exc)) else 'REMOTE_FAILURE_REDACTED'
        result = {'protocol':'FAI_M2_STAGE_R26','status':'STOP','stage':sys.argv[1] if len(sys.argv)==2 else 'ADMISSION',
                  'code':code,'details':exc.details if isinstance(exc,Stop) else {},'utc':utc(),'agentRealKeyAccess':False}
        try: exclusive(Path(__file__).parent/'evidence'/(result['stage']+'.stop.json'),result)
        except BaseException: result['stopReceiptWritten']=False
        print(canonical(result).decode(),flush=True)
        raise SystemExit(2)
