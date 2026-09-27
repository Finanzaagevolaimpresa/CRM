"""M4/schema49 -> M5/schema49. Offline adaptation of the qualified PR170 tools."""
import hashlib
from functools import lru_cache
import json
from pathlib import Path
import re
import subprocess
import types

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
TOOLS = '2ec365553e8cfe3bc0354756ed921de376f6e383'
M1_TOOLS = 'b8f28c32e050176ddb2d13264ee6911bf51b808f'
SOURCE = 'e00acfe008c9d2c0504a551198688296797c2491'
SOURCE_TREE = '9da5856e9272bb72af9f173440300daf07d41cfc'
SOURCE_RUNTIME = 'release-e00acfe008c9-m4-288ac9d2bd274736b58da1be22186acd'
SOURCE_APP = '0f8338eb03e8e4f11142551fd79470979322f4cf623ec100395e033093e37193'
SOURCE_IMAGE = 'sha256:9e3a3fce439566f51c175a650272f9ecb62ab01a6d95a3b52210708040793d9f'
SOURCE_CONFIG_SHA = '4151be9922fd13515cd6190b53f2a77ff59731012e8269574bf2b9c8008ce751'
CANDIDATE = 'd43b850b3cb4e086f4a986d2dc6a40782d641afe'
CANDIDATE_TREE = 'fe42bd58d509de1ae02d750bc611a83d6bc2f82a'


@lru_cache(maxsize=None)
def source(path, ref=TOOLS):
    return subprocess.check_output(['git','show',ref+':'+path],cwd=REPO,timeout=60)


def imported(raw, name, path):
    value = types.ModuleType(name)
    value.__file__ = str(path)
    exec(compile(raw,str(path),'exec'),value.__dict__)
    return value


def change(text, before, after, count=1):
    if text.count(before) != count:
        raise ValueError('M5_EXACT_TRANSFORMATION_CHANGED: '+before[:80])
    return text.replace(before,after)


def rename(text):
    return text.replace('FAI_M4_', 'FAI_M5_').replace('_R33','_R36').replace(
        'm4-release-r33-', 'm5-release-r36-').replace("'-m4'", "'-m5'").replace(
        "'-m4-'", "'-m5-'").replace('m4-r33-', 'm5-r36-').replace('M4_USAGE','M5_USAGE')


def schema49(text):
    text = text.replace('backup48','backup49').replace('BACKUP48','BACKUP49').replace(
        'SCHEMA48','SCHEMA49').replace('schema48','schema49').replace('LEDGER48_','LEDGER49_')
    return re.sub(r'(?<![A-Za-z0-9_])48(?![A-Za-z0-9_])','49',text)


def render(run_id):
    if not re.fullmatch('[a-f0-9]{32}',run_id):
        raise ValueError('SEALED_IDENTITY_DENIED')
    # The parent generator reads three adjacent files; bind every such read to PR170.
    for name in ('qualification.json','release_evidence.py','protect48.py'):
        if (REPO/'scripts/m4-release'/name).read_bytes() != source('scripts/m4-release/'+name):
            raise ValueError('PINNED_PARENT_CHANGED')
    m4 = imported(source('scripts/m4-release/generate.py'),'pinned_m4',REPO/'scripts/m4-release/generate.py')
    raw = m4.render(run_id)
    result = {name:rename(data.decode()).encode() if name.endswith('.py') else data for name,data in raw.items()}
    original = imported(result['sealed_programs.py'],'original_sealed',HERE/'sealed_programs.py')
    sealed_text = result['sealed_programs.py'].decode()
    for name,value in {'M1':SOURCE,'M1_TREE':SOURCE_TREE,'M1_RUNTIME':SOURCE_RUNTIME,
                       'M2':CANDIDATE,'M2_TREE':CANDIDATE_TREE}.items():
        sealed_text = original.assignment(sealed_text,name,repr(value))
    result['sealed_programs.py'] = sealed_text.encode()
    sealed = imported(result['sealed_programs.py'],'m5_sealed',HERE/'sealed_programs.py')
    for role in ('before','after'):
        for prefix,method,path in [('backup48_',sealed.backup,'scripts/pr140/owner_backup46.py'),
                                  ('observe48_',sealed.observer,'scripts/m1-executor/observe_m1.py')]:
            result[prefix+role+'.py'] = schema49(method(source(path,M1_TOOLS),role,run_id).decode()).encode()
    result['owner_base.py'] = change(result['owner_base.py'].decode(),m4.CANDIDATE,CANDIDATE).encode()
    transition = result['transition_base.py'].decode().replace('evidence-backup48-', 'evidence-backup49-')
    result['transition_base.py'] = transition.encode()

    remote = result['remote_release.py'].decode()
    remote = change(remote,"'codex/m4-read-candidate-r32'","'codex/m5-runtime-candidate-r36'")
    remote = change(remote,"self.b['ledger48' if role == 'before' else 'ledger49']","self.b['ledger49']")
    remote = change(remote,"48 if role == 'before' else 49","49",3)
    remote = remote.replace('M1/schema48 -> M2/schema48','M4/schema49 -> M5/schema49').replace('SCHEMA48','SCHEMA49')
    remote = remote.replace('evidence-backup48-','evidence-backup49-').replace('backup48.bundle.tar','backup49.bundle.tar')
    remote = change(remote,"'migrationsRequired':['"+m4.MIGRATION+"']","'migrationsRequired':[]")
    remote = change(remote,"migrationsApplied=['"+m4.MIGRATION+"']","migrationsApplied=[]")
    member = imported(source('scripts/m3-release/generate.py'),'pinned_members',HERE/'generate.py').member
    no_migration = """    def migrate(self):
        need(self.manifest['migrations'] == [], 'NO_MIGRATIONS_AUTHORIZED')
        need(len(self.b['ledger49']) == 49, 'FIXED_SCHEMA49_REQUIRED')
        need(all(self.stages.result(s) and self.stages.result(s)['status'] == 'PASS'
                 for s in ('backup','copies-backup','recover')), 'DEPLOY_RECOVERY_GATES_REQUIRED')
        observation = self.observer()
        need(observation['ledgerCount'] == 49 and observation['zeroIncomplete'] is True,
             'SCHEMA49_OBSERVATION_REQUIRED')
        rows = self.rows(self.b['ledger49'])
        return self.receipt('migrate', before=49, after=49, newMigrations=[],
                            ledger49Unchanged=True, ledgerDigest=value_sha(rows), migrator=None)

"""
    remote = change(remote,member(remote,'migrate'),no_migration.rstrip())
    remote = change(remote,"self.b['ledger48']","self.b['ledger49']")
    result['remote_release.py'] = remote.encode()
    owner = result['owner_release.py'].decode().replace('M4','M5').replace(
        'SCHEMA48-49-R33','SCHEMA49-R36').replace('backup48.bundle.tar','backup49.bundle.tar')
    owner = owner.replace('schema48','schema49').replace('corrente48','corrente49')
    owner = change(owner,'Sola migrazione 49, prefisso 48 conservato. Deploy M5 e controllo salute.',
                   'Schema49 invariato: zero migrazioni. Deploy M5 e controllo salute.')
    result['owner_release.py'] = owner.encode()
    proof = json.loads((HERE/'qualification.json').read_bytes())
    receipt = proof['receipt']
    download = result['download_images.py'].decode()
    for name,value in {'ARTIFACT':proof['artifactId'],'ZIP_BYTES':proof['artifactZipBytes'],
                       'ZIP_SHA':proof['artifactZipSha256'],'IMAGE_SHA':receipt['imageArchiveSha256'],
                       'CANDIDATE':CANDIDATE,'RUN':proof['run'],'EXPECTED_RECEIPT':receipt}.items():
        download = sealed.assignment(download,name,repr(value))
    result['download_images.py'] = download.replace('Immagini M4','Immagini M5').encode()
    for name in ('qualification.json','release_evidence.py'):
        result[name] = (HERE/name).read_bytes()
    b = json.loads(result['binding.json'])
    b.update(protocol='FAI_M5_SCHEMA49_BINDING_R36',candidate=CANDIDATE,candidateTree=CANDIDATE_TREE,
        sourceCommit=SOURCE,sourceTree=SOURCE_TREE,sourceConfigurationSha256=SOURCE_CONFIG_SHA,
        candidateCiImage=receipt['candidateImageId'],returnCiImage=receipt['recoveryImageId'],
        imageArchiveSha256=receipt['imageArchiveSha256'])
    b['target'].update(appId=SOURCE_APP,appImage=SOURCE_IMAGE)
    b.pop('ledger48')
    for ref in (SOURCE,CANDIDATE):
        # Full ledger is compared below, not inferred from a migration count.
        names = subprocess.check_output(['git','ls-tree','-r','--name-only',ref,'prisma/migrations'],cwd=REPO).decode().splitlines()
        ledger = {Path(name).parent.name:hashlib.sha256(source(name,ref)).hexdigest()
                  for name in names if name.endswith('/migration.sql')}
        if ledger != b['ledger49']:
            raise ValueError('M5_LEDGER49_CHANGED')
        for name,expected in b['canonicalPrograms'].items():
            if hashlib.sha256(source(name,ref)).hexdigest() != expected:
                raise ValueError('CANONICAL_SOURCE_CHANGED')
    result['binding.json'] = json.dumps(b,sort_keys=True,separators=(',',':')).encode()+b'\n'
    for name,data in result.items():
        if name.endswith('.py'): compile(data,name,'exec')
    return result


def inventory():
    return {name:hashlib.sha256(data).hexdigest() for name,data in render('a'*32).items()}
