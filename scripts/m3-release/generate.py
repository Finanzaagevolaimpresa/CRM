"""Offline, exact-source adaptation of the qualified M2 owner sequence for M3.

No SSH, daemon, credentials, application execution or historical receipt writes.
The compatibility names M1/M2 inside reused helpers mean SOURCE/CANDIDATE here.
"""
import ast
import hashlib
import json
from pathlib import Path
import subprocess
import types

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
M1_TOOLS = 'b8f28c32e050176ddb2d13264ee6911bf51b808f'
M2_TOOLS = 'db4fff35f00255eae1741c8b8bf279d0007ec425'
M2_INITIAL = '31eeb42f9ac8d6da75534a4e08c0f4ba09bb892f'
SOURCE = '7ab126f8a2ef385c3e720f190eda80f26f61ae39'
SOURCE_TREE = 'c4566387ec58e7eb7c82e3da52ef1424eb08e756'
SOURCE_RUNTIME = 'release-7ab126f8a2ef-m2-de4842fa7df64d6da023c53f808c48c0'
CANDIDATE = '9508d0da1b9642b02609d7431a984ced7b501e2e'
CANDIDATE_TREE = 'a1c92d728b3446159b7be53043dbaa168bf0bb22'
SOURCE_APP = 'ba710299e85034b9ec6633ff44d1c48d38ecddb78494d0e87316b31a5dad0b04'
SOURCE_IMAGE = 'sha256:01c7a81a6c294651066765413243f465ce4b76f05b60f266b706559f917e7d19'
SOURCE_CONFIG_SHA = '4151be9922fd13515cd6190b53f2a77ff59731012e8269574bf2b9c8008ce751'


def source(path, ref):
    return subprocess.check_output(['git', 'show', ref + ':' + path], cwd=REPO, timeout=60)


def change(text, before, after, count=1):
    if text.count(before) != count:
        raise ValueError('M3_EXACT_TRANSFORMATION_CHANGED: ' + before[:60])
    return text.replace(before, after)


def member(text, name):
    cls = next(n for n in ast.parse(text).body if isinstance(n, ast.ClassDef) and n.name == 'Release')
    node = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == name)
    return ''.join(text.splitlines(keepends=True)[node.lineno-1:node.end_lineno])


def rename(text):
    return text.replace('FAI_M2_', 'FAI_M3_').replace('_R26', '_R32').replace('m2-release-r26-', 'm3-release-r32-').replace('-m2-', '-m3-').replace('m2-r26-', 'm3-r32-').replace('M2_USAGE', 'M3_USAGE')


def render(run_id, own=None):
    own = own or (lambda name: (HERE/name).read_bytes())
    raw_sealed = source('scripts/m2-release/sealed_programs.py', M2_TOOLS).decode()
    original = types.ModuleType('m3_original_sealed')
    exec(compile(raw_sealed, 'pinned_m2_sealed.py', 'exec'), original.__dict__)
    raw_m1 = lambda name: source('scripts/m1-assisted/'+name, M1_TOOLS)
    raw_m2 = lambda name: source('scripts/m2-release/'+name, M2_TOOLS)
    initial = lambda name: source('scripts/m2-release/'+name, M2_INITIAL).decode()
    owner_base = original.owner_base(raw_m1('owner_release.py')).decode().replace(SOURCE, CANDIDATE)
    sealed_text = raw_sealed
    for name, value in {'M1':SOURCE, 'M1_TREE':SOURCE_TREE, 'M1_RUNTIME':SOURCE_RUNTIME,
                        'M2':CANDIDATE, 'M2_TREE':CANDIDATE_TREE}.items():
        sealed_text = original.assignment(sealed_text, name, repr(value))
    sealed_text = rename(sealed_text)
    sealed = types.ModuleType('m3_bound_sealed')
    exec(compile(sealed_text, 'm3_sealed.py', 'exec'), sealed.__dict__)
    result = {name:raw_m1(name) for name in ('common.py','isolated_restore.py','qualified_images.py','storage_probe.ps1')}
    result['common.py'] = result['common.py'].replace(b'FAI_M1_ASSISTED_STAGE_R21', b'FAI_M3_ASSISTED_STAGE_R32')
    result.update({name:own(name) for name in ('image_binding.py','release_evidence.py','qualification.json')})
    result['registry_settlement.py'] = raw_m2('registry_settlement.py')
    result['sealed_programs.py'] = sealed_text.encode()
    result['owner_base.py'] = rename(owner_base).encode()
    result['transport_base.py'] = raw_m1('download_images.py')
    transition = sealed.transition(raw_m1('remote_release.py')).decode()
    transition = change(transition, 'self.completed_result(', 'self.stages.result(', 4)
    result['transition_base.py'] = rename(transition).encode()
    for role in ('before','after'):
        result['backup48_'+role+'.py'] = sealed.backup(source('scripts/pr140/owner_backup46.py',M1_TOOLS),role,run_id)
        result['observe48_'+role+'.py'] = sealed.observer(source('scripts/m1-executor/observe_m1.py',M1_TOOLS),role,run_id)

    remote = initial('remote_release.py')
    latest = raw_m2('remote_release.py').decode()
    protected = member(latest,'protect_set').replace("        need(role == 'after', 'COMPLETED_PROTECTION_REPLAY_DENIED')\n",'')
    remote = change(remote, member(remote,'protect_set'), member(latest,'protection_expected')+'\n\n'+protected)
    remote = change(remote, 'from transition_base import Release as Transition',
        'from transition_base import Release as Transition\nfrom release_evidence import validate as validate_evidence_inputs')
    remote = change(remote, "self.b = load(private(root / 'binding.json'))", "self.b = complete_binding(private(root / 'release-images.tar.gz'), load(private(root / 'binding.json')))")
    remote = change(remote, "        self.work = private(root / 'evidence', directory=True)",
        "        validate_evidence_inputs(self.review, self.b)\n        self.backup_run_id = self.run_id\n        self.work = private(root / 'evidence', directory=True)")
    remote = change(remote, "        config = private(OLD/'.env.production')", "        config = private(OLD/'.env.production')\n        need(digest(config) == self.b['sourceConfigurationSha256'], 'M2_CONFIGURATION_DRIFT')")
    remote = change(remote, "need(set(request) <= ({'copies'} if stage.startswith('copies-') else set())", "need(set(request) == ({'copies'} if stage.startswith('copies-') else set())")
    remote = change(remote, "'utc':utc(),'agentRealKeyAccess':False}", "'utc':utc(),'agentRealKeyAccess':False,\n                  'errorType':type(exc).__name__ if type(exc).__name__ in {'KeyError','TypeError','ValueError','OSError','Denied'} else 'CONTROLLED_STOP'}")
    remote = remote.replace('codex/m2-runtime-candidate-r26','codex/m3-runtime-candidate-r32')
    result['remote_release.py'] = rename(remote).encode()
    result['protect48.py'] = raw_m2('protect48.py')

    receiver = original.receiver(raw_m1('receive_package.py')).decode()
    # R31 receiver deliberately reuses consumed attempts; M3 uses a new set and archive.
    receiver = change(receiver, "set(manifest['files']) | {'package.json'}", "set(manifest['files']) | {'package.json', 'release-images.tar.gz'}")
    start = receiver.index('    sys.path.insert(0, str(root))')
    end = receiver.index('    print(json.dumps(',start)
    receiver = receiver[:start]+receiver[end:]
    receiver = receiver.replace("'imagesReusedFromConsumedPreparation': True, 'imageBytesTransferred': 0,", "'imagesReusedFromConsumedPreparation': False, 'imageBytesTransferred': binding['image']['bytes'],")
    result['receive_package.py'] = rename(receiver).encode()

    owner = initial('owner_release.py').replace('CRM-BACKUP-M2-SCHEMA48-R26-','CRM-BACKUP-M3-SCHEMA48-R32-')
    owner = owner.replace('Immagini M2','Immagini M3').replace('Deploy M2','Deploy M3').replace('finale M2','finale M3').replace('TECNICO M2','TECNICO M3').replace('ESITO-M2','ESITO-M3')
    result['owner_release.py'] = rename(owner).encode()
    proof = json.loads(own('qualification.json'))
    receipt = proof['receipt']
    download = initial('download_images.py')
    replacements = {'ARTIFACT':proof['artifactId'],'ZIP_BYTES':proof['artifactZipBytes'],'ZIP_SHA':proof['artifactZipSha256'],
                    'IMAGE_SHA':receipt['imageArchiveSha256'],'CANDIDATE':CANDIDATE,'RUN':proof['run']}
    for name,value in replacements.items():
        download = original.assignment(download,name,repr(value))
    result['download_images.py'] = download.replace('Immagini M2','Immagini M3').encode()

    b = json.loads(raw_m1('binding.json'))
    b.update(protocol='FAI_M3_SCHEMA48_BINDING_R32',candidate=CANDIDATE,candidateTree=CANDIDATE_TREE,
        sourceCommit=SOURCE,sourceTree=SOURCE_TREE,sourceConfigurationSha256=SOURCE_CONFIG_SHA,
        candidateCiImage=receipt['candidateImageId'],returnCiImage=receipt['recoveryImageId'],imageArchiveSha256=receipt['imageArchiveSha256'])
    b['target'].update(appId=SOURCE_APP,appImage=SOURCE_IMAGE)
    for name in ('backupProgramSha256','candidateImage','returnImage','candidateConfigDigest','returnConfigDigest','ledger46','consumedBackupStop'):
        b.pop(name,None)
    result['binding.json'] = json.dumps(b,sort_keys=True,separators=(',',':')).encode()+b'\n'
    for name,data in result.items():
        if name.endswith('.py'): compile(data,name,'exec')
    return result


def inventory():
    # Generated values use a fixed synthetic run only for deterministic hashing.
    return {name:hashlib.sha256(data).hexdigest() for name,data in render('a'*32).items()}
