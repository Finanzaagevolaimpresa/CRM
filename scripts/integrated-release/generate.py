"""R40 app-only release on schema49, using the immutable PR176 images.

Adapt the qualified M5 transport/backup/recovery program. Registry guards are
read-only and an unsuccessful forward transition never starts an older image.
"""
import hashlib
from functools import lru_cache
import json
from pathlib import Path
import re
import subprocess
import types

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
PIN = 'd0d7e9bdc0b4e38ceb31955e32cfca3e1f4ad63f'
SOURCE = 'd43b850b3cb4e086f4a986d2dc6a40782d641afe'
SOURCE_TREE = 'fe42bd58d509de1ae02d750bc611a83d6bc2f82a'
SOURCE_RUNTIME = 'release-d43b850b3cb4-m5-611f3ed6e00a416d872db7c97fa63369'
CANDIDATE = PIN
CANDIDATE_TREE = 'b8b2c2ee55747d0366d6bf5956c52a0a8c322276'


@lru_cache(maxsize=None)
def source(path, ref='2ec365553e8cfe3bc0354756ed921de376f6e383'):
    return subprocess.check_output(['git', 'show', ref+':'+path], cwd=REPO, timeout=60)


def pinned(path):
    return source(path, PIN)


def schema49(text):
    text = text.replace('backup48','backup49').replace('BACKUP48','BACKUP49').replace(
        'SCHEMA48','SCHEMA49').replace('schema48','schema49').replace('LEDGER48_','LEDGER49_')
    return re.sub(r'(?<![A-Za-z0-9_])48(?![A-Za-z0-9_])','49',text)


def imported(raw, name, path):
    value = types.ModuleType(name)
    value.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), value.__dict__)
    return value


def change(text, before, after, count=1):
    if text.count(before) != count:
        raise ValueError('R40_EXACT_TRANSFORMATION_CHANGED: '+before[:100])
    return text.replace(before, after)


def member(text, name):
    found = re.search(r'^    def '+name+r'\(.*?(?=^    def |\Z)', text, re.M | re.S)
    if not found:
        raise ValueError('R40_METHOD_NOT_FOUND: '+name)
    return found.group().rstrip()


@lru_cache(maxsize=8)
def _render(run_id):
    base = imported(pinned('scripts/m5-release/generate.py'), 'r40_parent', HERE/'generate.py')
    base.HERE = HERE
    base.SOURCE, base.SOURCE_TREE = SOURCE, SOURCE_TREE
    base.SOURCE_RUNTIME = SOURCE_RUNTIME
    base.SOURCE_APP = 'a9df05e1383fb6fcc480d55bff34674e7bcfc07bd284403df09baa4333fcfafb'
    base.SOURCE_IMAGE = 'sha256:f29e5468d0b944a664e1ae86f7082aba2f7c3ca7e6995d3040ba9bf6955656af'
    base.CANDIDATE, base.CANDIDATE_TREE = CANDIDATE, CANDIDATE_TREE
    base.source = source
    files = base.render(run_id)
    proof = json.loads((HERE/'qualification.json').read_bytes())
    paired = proof['receipt']
    # Rename only the new package/runtime, never the established source path.
    for name, data in list(files.items()):
        if not name.endswith('.py'):
            continue
        text = data.decode().replace('m5-release-r36-', 'integrated-release-r64-')
        text = text.replace("'-m5-'", "'-r40-'").replace("'-m5'", "'-r40'")
        text = text.replace('release-'+CANDIDATE[:12]+'-m5-', 'release-'+CANDIDATE[:12]+'-r40-')
        text = text.replace('FAI_M5_', 'FAI_R40_').replace('_R36', '_R64')
        text = text.replace('codex/m5-runtime-candidate-r36', 'codex/crm-integrated-release')
        text = text.replace("'plannedSessionRevocation':True", "'plannedSessionRevocation':False")
        text = text.replace("'plannedSessionRevocation': True", "'plannedSessionRevocation': False")
        if name.startswith('backup48_'):
            text = text.replace('PLANNED_RELEASE_SESSION_REVOCATION', 'PLANNED_RELEASE_READONLY_SESSION_GUARD')
            text = text.replace('SESSION_REVOCATION', 'SESSION_READONLY_GUARD')
        files[name] = text.encode()

    # The single shared SQL provider covers preflight, backup/resume and start.
    registry = files['registry_settlement.py'].decode()
    start = registry.index('SQL = ')
    end = registry.index('\n\ndef stopped_app', start)
    guard = (HERE/'registry_guard.py').read_text(encoding='utf-8')
    registry = registry[:start]+guard+registry[end:]
    registry = registry.replace('Audited planned-restart session settlement; never changes credentials.',
                                'Read-only planned-restart session guard; no revocation or audit writes.')
    files['registry_settlement.py'] = registry.encode()
    files['mailbox_guard.py'] = (HERE/'mailbox_guard.py').read_bytes()
    # The saved PR175 image retains its original candidate tag. Verify that
    # exact provenance without retagging or rebuilding either archive member.
    images = files['qualified_images.py'].decode()
    images = change(images,
        "('candidate' if role == 'candidate' else 'recovery')",
        "('candidate' if role == 'candidate' or commit == '8e3874a304b1cb2281d59146448bcdf121afe0d1' else 'recovery')")
    files['qualified_images.py'] = images.encode()

    remote = files['remote_release.py'].decode()
    remote = change(remote, 'from release_evidence import validate as validate_evidence_inputs',
                    'from release_evidence import validate as validate_evidence_inputs\nfrom mailbox_guard import observe as observe_mailboxes')
    remote = change(remote, '    def prepare(self):\n        before = self.observer()',
                    "    def prepare(self):\n        before = self.observer()\n        mailboxes = observe_mailboxes(self.sql)")
    remote = change(remote, "return {'candidate':M2,'observation':after,'documentCapacity':documents,'images':images,",
                    "return {'candidate':M2,'observation':after,'documentCapacity':documents,'images':images,\n                'mailboxes':mailboxes,'databaseWritesAuthorized':False,'automaticReturnAuthorized':False,")
    postcheck = '''    def postcheck(self):
        result = super().postcheck()
        boxes = observe_mailboxes(self.sql)
        need(boxes == self.stages.result('prepare')['mailboxes'], 'MAILBOX_CONFIGURATION_DRIFT')
        return result | {'mailboxes':boxes,'mailboxesPreserved':True,'providerActivation':False}
'''.rstrip()
    remote = change(remote, member(remote, 'postcheck'), postcheck)
    remote = change(remote, '    def make_backup(self, role):\n        self.require_config_binding()',
                    "    def make_backup(self, role):\n        need(observe_mailboxes(self.sql) == self.stages.result('prepare')['mailboxes'], 'MAILBOX_CONFIGURATION_DRIFT')\n        self.require_config_binding()")
    remote = change(remote, '    def canonical_transition(self,n05,operation,path):\n        original = n05.DockerEngine',
                    "    def canonical_transition(self,n05,operation,path):\n        need(operation == 'forward', 'OLDER_IMAGE_RETURN_NOT_AUTHORIZED')\n        original = n05.DockerEngine")
    files['remote_release.py'] = remote.encode()
    transition = files['transition_base.py'].decode()
    a = transition.index("        state = current['app']['state'] if current['app'] else 'absent'")
    b = transition.index('\n    def postcheck(self):', a)
    transition = transition[:a]+'''        # N05 publishes the failure and stops the failed candidate. Keep that
        # durable state; the archive's historical M1 image cannot retain R37.
        raise Stop('FORWARD_FAILED_NO_OLDER_IMAGE_RETURN',
                   candidate=self.b['candidate'], schema=49,
                   automaticReturnAuthorized=False, databaseRestoreAuthorized=False)
''' + transition[b:]
    files['transition_base.py'] = transition.encode()
    owner = files['owner_release.py'].decode().replace('Immagini M5', 'Immagini R40')
    owner = owner.replace('CRM-BACKUP-M5-SCHEMA49-R36-', 'CRM-BACKUP-R40-SCHEMA49-R64-')
    owner = owner.replace('revoca con audit delle sessioni e riavvio controllato',
                          'controllo sessioni in sola lettura e riavvio controllato')
    owner = owner.replace('M5', 'R40')
    files['owner_release.py'] = owner.encode()
    owner_base = files['owner_base.py'].decode()
    owner_base = change(owner_base,
        "    code, out, _ = call([PS, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', ROOT / 'storage_probe.ps1'], 75)",
        "    script = private(ROOT/'storage_probe.ps1').read_text(encoding='utf-8-sig')\n"
        "    script = script.replace('$PSScriptRoot', \"'\"+str(ROOT).replace(\"'\", \"''\")+\"'\")\n"
        "    code, out, _ = call([PS, '-NoProfile', '-NonInteractive', '-Command', script], 75)")
    files['owner_base.py'] = owner_base.encode()
    download = files['download_images.py'].decode()
    download = change(download, "artifact['workflow_run']['head_sha'] == CANDIDATE",
                      "artifact['workflow_run']['head_sha'] == "+repr(proof['artifactHead']))
    download = change(download, 'def acquire(root,manifest):', '''def acquire(root,manifest):
    target, receipt_path = root/'release-images.tar.gz', root/'release-receipt.json'
    if target.exists() or receipt_path.exists():
        need(target.exists() and receipt_path.exists(), 'ACQUIRED_IMAGE_PAIR_INCOMPLETE')
        need(0 < target.stat().st_size <= 1024**3 and digest(private(target)) == IMAGE_SHA,
             'QUALIFIED_IMAGE_HASH')
        need(receipt_path.stat().st_size <= 65536 and decode(private(receipt_path).read_bytes()) == EXPECTED_RECEIPT,
             'QUALIFICATION_RECEIPT_MISMATCH')
        result = {'bytes':target.stat().st_size,'sha256':IMAGE_SHA,'artifactId':ARTIFACT,
                  'zipDigestLocallyVerified':False,'reusedVerifiedArchive':True}
        exclusive(root/'images-acquired.json',result | {'events':[],
                  'remoteConnectionAttempted':False,'productionMutationPerformed':False})
        print('Archivio R40 gia acquisito: hash e ricevuta verificati.',flush=True)
        return result
'''.rstrip())
    files['download_images.py'] = download.encode()
    binding = json.loads(files['binding.json'])
    binding.update(returnCommit=paired['recoveryCommit'],returnTree=paired['recoveryTree'])
    binding.update(protocol='FAI_R40_SCHEMA49_BINDING_R64', automaticReturnAuthorized=False,
                   databaseWritesAuthorized=False, sessionRevocationAuthorized=False,
                   mailboxState='PRESERVE_SEVEN_QUALIFIED')
    files['binding.json'] = json.dumps(binding, sort_keys=True, separators=(',', ':')).encode()+b'\n'
    for name, raw in files.items():
        if name.endswith('.py'):
            compile(raw, name, 'exec')
    return files


def render(run_id):
    return dict(_render(run_id))


def inventory():
    return {name: hashlib.sha256(raw).hexdigest() for name, raw in render('a'*32).items()}
