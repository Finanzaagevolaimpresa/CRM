"""Exact M3/schema48 -> M4/schema49 owner package. Offline generation only."""
import ast
import hashlib
import json
from pathlib import Path
import re
import subprocess
import types

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
TOOLS = '14fe1509ee61040063070ea61b07a3afc5b0e62a'
SOURCE = '9508d0da1b9642b02609d7431a984ced7b501e2e'
SOURCE_TREE = 'a1c92d728b3446159b7be53043dbaa168bf0bb22'
SOURCE_RUNTIME = 'release-9508d0da1b96-m3-a5c84e80bdd3473d83f542974fc8da06'
SOURCE_APP = 'd7f80f8382d531a603b8e7bb98a46ef9816e75039dbd7c73ef2e5a61a506688e'
SOURCE_IMAGE = 'sha256:99627b714628a2a950e954e4e5ea090831d761c85bcadbf1dbfae39270aaf8c9'
SOURCE_CONFIG_SHA = '4151be9922fd13515cd6190b53f2a77ff59731012e8269574bf2b9c8008ce751'
CANDIDATE = 'e00acfe008c9d2c0504a551198688296797c2491'
CANDIDATE_TREE = '9da5856e9272bb72af9f173440300daf07d41cfc'
MIGRATION = '20260927010000_approved_manual_communications_v1'
MIGRATION_SHA = 'eaba8119ad0409ff4fa9a5de0f63109ffe7d6a721c69633b40c5193c3b0a2dc8'


def source(path, ref=TOOLS):
    return subprocess.check_output(['git','show',ref+':'+path],cwd=REPO,timeout=60)


def imported(raw, name, path):
    value = types.ModuleType(name)
    value.__file__ = str(path)
    exec(compile(raw,str(path),'exec'),value.__dict__)
    return value


def change(text, before, after, count=1):
    if text.count(before) != count:
        raise ValueError('M4_EXACT_TRANSFORMATION_CHANGED: '+before[:65])
    return text.replace(before,after)


def rename(text):
    return text.replace('FAI_M3_', 'FAI_M4_').replace('_R32','_R33').replace('m3-release-r32-', 'm4-release-r33-').replace("'-m3-'", "'-m4-'").replace('m3-r32-', 'm4-r33-').replace('M3_USAGE','M4_USAGE')


def render(run_id):
    if not re.fullmatch('[a-f0-9]{32}',run_id): raise ValueError('SEALED_IDENTITY_DENIED')
    m3 = imported(source('scripts/m3-release/generate.py'),'pinned_m3',HERE/'generate.py')
    raw = m3.render(run_id,own=lambda name:source('scripts/m3-release/'+name))
    result = {name:rename(data.decode()).encode() if name.endswith('.py') else data for name,data in raw.items()}
    original = imported(result['sealed_programs.py'],'pinned_sealed',HERE/'sealed_programs.py')
    sealed_text = result['sealed_programs.py'].decode()
    for name,value in {'M1':SOURCE,'M1_TREE':SOURCE_TREE,'M1_RUNTIME':SOURCE_RUNTIME,'M2':CANDIDATE,'M2_TREE':CANDIDATE_TREE}.items():
        sealed_text = original.assignment(sealed_text,name,repr(value))
    result['sealed_programs.py'] = sealed_text.encode()
    sealed = imported(result['sealed_programs.py'],'m4_sealed',HERE/'sealed_programs.py')
    for role in ('before','after'):
        for prefix,method,path in [('backup48_',sealed.backup,'scripts/pr140/owner_backup46.py'),
                                   ('observe48_',sealed.observer,'scripts/m1-executor/observe_m1.py')]:
            text = method(source(path,m3.M1_TOOLS),role,run_id).decode()
            if role == 'after':
                text = text.replace('backup48','backup49').replace('BACKUP48','BACKUP49').replace('SCHEMA48','SCHEMA49').replace('schema48','schema49').replace('LEDGER48_','LEDGER49_')
                text = re.sub(r'(?<![A-Za-z0-9_])48(?![A-Za-z0-9_])','49',text)
            # Compatibility filenames stay fixed; the source, schema and protocol inside are role-bound.
            result[prefix+role+'.py'] = text.encode()
    owner_base = result['owner_base.py'].decode()
    result['owner_base.py'] = change(owner_base,m3.CANDIDATE,CANDIDATE).encode()

    transition = result['transition_base.py'].decode()
    transition = transition.replace("self.b['ledger48']", "self.b['ledger49']").replace('prisma-m1-48','prisma-m4-49')
    transition = transition.replace("'count': 48", "'count': 49").replace("'schema': 48", "'schema': 49").replace('schema=48','schema=49')
    result['transition_base.py'] = transition.encode()

    remote = result['remote_release.py'].decode()
    remote = change(remote,'decode, digest,','decode, defer_interruptions, digest,')
    remote = change(remote,"'migrate': 120", "'migrate': 540")
    m1_source = source('scripts/m1-assisted/remote_release.py',m3.M1_TOOLS).decode()
    key_sql = next(ast.literal_eval(n.value) for n in ast.parse(m1_source).body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='KEY_SQL' for t in n.targets))
    remote = sealed.assignment(remote,'KEY_SQL',repr(key_sql))
    remote = change(remote,"ledger=self.b['ledger48']", "ledger=self.b['ledger48' if role == 'before' else 'ledger49']")
    remote = change(remote,"'codex/m3-runtime-candidate-r32'", "'codex/m4-read-candidate-r32'")
    remote = change(remote,"'migrationsRequired':[]", "'migrationsRequired':['"+MIGRATION+"']")
    remote = change(remote,"        plan = {'protocol':'FAI_CRM_OWNER_BACKUP48_R33'", "        m = module(self.root/name,'m4_backup_'+role,script_hash)\n        schema = 48 if role == 'before' else 49\n        plan = {'protocol':m.PROTOCOL")
    remote = change(remote,"'schema':48,'target':target", "'schema':schema,'target':target")
    remote = change(remote,"'expectedLedger':self.b['ledger48']", "'expectedLedger':self.b['ledger'+str(schema)]")
    remote = change(remote,"'confirmation':'FAI_CRM_SCHEMA48_BACKUP_SESSION_SETTLEMENT_R33'", "'confirmation':m.CONFIRMATION")
    remote = change(remote,"        m = module(self.root/name,'m2_backup_'+role,script_hash)\n",'')
    remote = change(remote,"        path = BASE/('evidence-backup48-'+run)/'sets'/('backup48-'+run)", "        schema = 48 if role == 'before' else 49\n        path = BASE/('evidence-backup'+str(schema)+'-'+run)/'sets'/('backup'+str(schema)+'-'+run)")
    remote = change(remote,"'migration_count':48", "'migration_count':48 if role == 'before' else 49")
    remote = remote.replace('post-backup48.bundle.tar','post-backup49.bundle.tar').replace('prisma-m1-48','prisma-m4-49')
    migration = m3.member(m1_source,'migrate')
    migration = migration.replace("self.b['ledger46']", "self.b['sourceLedger']").replace("self.b['ledger48']", "self.b['ledger49']").replace("self.b['sourceLedger']", "self.b['ledger48']")
    migration = migration.replace('after[:46]', 'after[:48]').replace('ledger48.json','ledger49.json').replace("'before': 46, 'after': 48, 'prior46Unchanged'", "'before': 48, 'after': 49, 'prior48Unchanged'").replace("'m1-'", "'m4-'")
    admission = """        need(self.manifest['migrations'] == ['%s'], 'MIGRATION_AUTHORITY_BINDING')
        need(set(self.b['ledger49']) - set(self.b['ledger48']) == {'%s'} and
             self.b['ledger49']['%s'] == '%s' and
             {k:v for k,v in self.b['ledger49'].items() if k in self.b['ledger48']} == self.b['ledger48'],
             'ONLY_MIGRATION49_ALLOWED')
        need(all(self.stages.result(s) and self.stages.result(s)['status'] == 'PASS'
                 for s in ('backup','copies-backup','recover')), 'MIGRATION_RECOVERY_GATES_REQUIRED')
        self.observer()
""" % (MIGRATION,MIGRATION,MIGRATION,MIGRATION_SHA)
    migration = change(migration,'        n05 = self.n05()\n',admission+'        n05 = self.n05()\n')
    remote = change(remote,m3.member(remote,'migrate'),migration)
    remote = change(remote,'migrationsApplied=[]',"migrationsApplied=['"+MIGRATION+"']")
    # The return image deliberately retains schema49; no rollback of data is callable.
    postcheck = '''    def postcheck(self):
        result = super().postcheck()
        boxes = decode(self.sql("""BEGIN READ ONLY; SELECT json_build_object('count',COUNT(*),
          'enabled',COUNT(*) FILTER (WHERE enabled OR "canSend" OR "canReceive"),
          'configured',COUNT(*) FILTER (WHERE kind <> 'UNATTESTED' OR "providerReference" IS NOT NULL
            OR "responsibleUserId" IS NOT NULL OR "configuredRevision" IS NOT NULL OR "testedRevision" IS NOT NULL))
          FROM "CommunicationMailbox"; ROLLBACK;"""))
        need(boxes == {'count':7,'enabled':0,'configured':0}, 'MAILBOX_ACTIVATION_OR_DRIFT')
        return result | {'mailboxes':boxes,'providerActivation':False}

'''
    remote = change(remote,'    def final(self):',postcheck+'    def final(self):')
    result['remote_release.py'] = remote.encode()

    owner = result['owner_release.py'].decode().replace('M3','M4').replace('SCHEMA48-R32','SCHEMA48-49-R33').replace('post-backup48.bundle.tar','post-backup49.bundle.tar')
    owner = change(owner,"'migrate':180", "'migrate':600")
    owner = change(owner,'Conferma: zero migrazioni da applicare. Deploy M4 e controllo salute.', 'Sola migrazione 49, prefisso 48 conservato. Deploy M4 e controllo salute.')
    owner = change(owner,'Backup post-deploy48 distinto','Backup post-deploy49 distinto')
    result['owner_release.py'] = owner.encode()
    proof = json.loads((HERE/'qualification.json').read_bytes())
    receipt = proof['receipt']
    download = result['download_images.py'].decode()
    for name,value in {'ARTIFACT':proof['artifactId'],'ZIP_BYTES':proof['artifactZipBytes'],'ZIP_SHA':proof['artifactZipSha256'],
                       'IMAGE_SHA':receipt['imageArchiveSha256'],'CANDIDATE':CANDIDATE,'RUN':proof['run']}.items():
        download = sealed.assignment(download,name,repr(value))
    result['download_images.py'] = download.replace('Immagini M3','Immagini M4').encode()
    for name in ('qualification.json','release_evidence.py','protect48.py'):
        result[name] = (HERE/name).read_bytes()
    b = json.loads(result['binding.json'])
    b.update(protocol='FAI_M4_SCHEMA48_TO49_BINDING_R33',candidate=CANDIDATE,candidateTree=CANDIDATE_TREE,
        sourceCommit=SOURCE,sourceTree=SOURCE_TREE,sourceConfigurationSha256=SOURCE_CONFIG_SHA,
        candidateCiImage=receipt['candidateImageId'],returnCiImage=receipt['recoveryImageId'],imageArchiveSha256=receipt['imageArchiveSha256'])
    b['target'].update(appId=SOURCE_APP,appImage=SOURCE_IMAGE)
    migration_bytes = source('prisma/migrations/'+MIGRATION+'/migration.sql',CANDIDATE)
    if hashlib.sha256(migration_bytes).hexdigest() != MIGRATION_SHA: raise ValueError('MIGRATION49_CHANGED')
    b['ledger49'] = b['ledger48'] | {MIGRATION:MIGRATION_SHA}
    for name,expected in b['canonicalPrograms'].items():
        if hashlib.sha256(source(name,CANDIDATE)).hexdigest() != expected: raise ValueError('CANONICAL_SOURCE_CHANGED')
    result['binding.json'] = json.dumps(b,sort_keys=True,separators=(',',':')).encode()+b'\n'
    for name,data in result.items():
        if name.endswith('.py'): compile(data,name,'exec')
    return result


def inventory():
    return {name:hashlib.sha256(raw).hexdigest() for name,raw in render('a'*32).items()}
