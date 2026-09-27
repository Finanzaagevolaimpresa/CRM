"""Fixed M4 backup adoption after the pre-encryption Git STOP. No replay."""
import os
from pathlib import Path
import subprocess

from common import digest, exclusive, load, module, need, private
from sealed_programs import BASE as BASE_STRING, M1, M1_TREE, M1_RUNTIME, M2, M2_TREE

RUN = '288ac9d2bd274736b58da1be22186acd'
POST_RUN = 'fb3533f578a74a43b3b6b76495ce3e25'
MANIFEST_SHA = '6355187e119bf42bd16cd54dc41cbfc01b262facd5c94fc823d61070f328b798'
PREPARE_SHA = '9a2a9c543c18afcbfbb47c9018a6639795ede5bfee6a4caabc8050e7c56c4bab'
BACKUP_SHA = '7a1e39d2c57958f9f22d2bcb36a3f28b3002259e675c94bc6168d2832890d98a'
STOP_SHA = '9e1eca4b45ac5e24bfafa6588930f4cb758a0636b4080666ffe549289aa1e33f'
IMAGE_SHA = 'e84490709532b97c63333fd7d4e3ed1c3b8d71425ed3d9562a5b4bb4214721a4'
IMAGE_BYTES = 547569706
BASE = Path(BASE_STRING)
LOCAL = Path(r'C:\Users\Utente\Desktop\CRM\artifacts\M4-rilascio-R33') / ('M4-' + RUN)
REMOTE = BASE / ('m4-release-r33-' + RUN)
RUNTIME_NAME = 'release-' + M2[:12] + '-m4-' + RUN
RUNTIME = BASE / RUNTIME_NAME
BACKUP = BASE / ('evidence-backup48-' + RUN)
FOLLOWING = ('copies-backup', 'recover', 'migrate', 'deploy', 'postcheck',
             'postbackup', 'postprotect', 'copies-postbackup', 'final')


def verified_json(path, sha):
    path = private(path)
    need(path.stat().st_size <= 65536 and digest(path) == sha, 'COMPLETED_RECEIPT_CHANGED')
    return load(path)


def validate_backup(value):
    need(value['status'] == 'PASS' and value['stage'] == 'backup' and value['runId'] == RUN,
         'COMPLETED_BACKUP_STAGE')
    result = value['receipt']
    need(result['status'] == 'BACKUP_VERIFIED_AND_APP_RESUMED' and result['runId'] == RUN and
         result['sourceCommit'] == M1 and result['sourceTree'] == M1_TREE and result['schema'] == 48 and
         result['appResumedHealthy'] is True and result['databaseNotRestarted'] is True and
         result['fullPgArchiveReadable'] is True and
         result['set'] == (BACKUP / 'sets' / ('backup48-' + RUN)).as_posix(), 'COMPLETED_BACKUP_NOT_BOUND')
    return result


def git_observation(root, *args):
    p = subprocess.run(['git', '-C', str(private(root, directory=True)), *args],
                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       timeout=30, env={'PATH': '/usr/bin:/bin', 'HOME': str(Path.home()),
                                        'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8'})
    need(len(p.stdout) <= 16384 and len(p.stderr) <= 16384, 'GIT_OBSERVATION_LIMIT')
    return p.returncode, p.stdout.decode().strip()


def diagnose(program_sha):
    # All inputs are fixed public Git identities. No config, environment or raw log output.
    kit = module(private(RUNTIME/'scripts/n05/recovery_kit.py'), 'historical_git_diagnosis', program_sha)
    kit.verify_tools(kit.tools_binding())
    for root, commit, tree in ((BASE/M1_RUNTIME, M1, M1_TREE), (RUNTIME, M2, M2_TREE)):
        code, output = git_observation(root, 'rev-parse', 'HEAD', 'HEAD^{tree}')
        need(code == 0 and output.split() == [commit, tree], 'COMPLETED_RUNTIME_DRIFT')
    code, _ = git_observation(RUNTIME, 'rev-parse', '--verify', M1+'^{tree}')
    need(code == 128, 'HISTORICAL_GIT_CAUSE_DIFFERENT')
    code_source, source_tree = git_observation(BASE/M1_RUNTIME, 'rev-parse', '--verify', M1+'^{tree}')
    need(code_source == 0 and source_tree == M1_TREE, 'SOURCE_PROVENANCE_UNAVAILABLE')
    return {'commandId': 'SOURCE_TREE_RESOLVE', 'exitCode': code,
            'errorClass': 'SOURCE_COMMIT_ABSENT_FROM_CANDIDATE_REPOSITORY',
            'sourceRepositoryVerified': True, 'candidateToolsVerified': True, 'readOnly': True}


def reconcile(remote=False):
    root = REMOTE if remote else LOCAL
    manifest = verified_json(root/'package.json', MANIFEST_SHA)
    need(manifest['runId'] == RUN and manifest['postRunId'] == POST_RUN and
         manifest['candidate'] == M2 and manifest['imageArchiveSha256'] == IMAGE_SHA,
         'COMPLETED_MANIFEST_BINDING')
    for name, value in manifest['files'].items():
        need(Path(name).name == name, 'COMPLETED_MEMBER_PATH')
        path = private(root/name)
        need(path.stat().st_size == value['bytes'] and digest(path) == value['sha256'],
             'COMPLETED_PROGRAM_CHANGED')
    evidence = root/'evidence' if remote else root
    prepared = verified_json(evidence/'prepare.json', PREPARE_SHA)
    result = validate_backup(verified_json(evidence/'backup.json', BACKUP_SHA))
    stop = verified_json(evidence/('protect.stop.json' if remote else 'protect.json'), STOP_SHA)
    need(stop['status'] == 'STOP' and stop['stage'] == 'protect' and
         stop['code'] == 'SCHEMA48_PROTECTION_STOP' and
         stop['details'] == {'publicCode': 'COMMAND_FAILED_GIT'}, 'COMPLETED_STOP_DIFFERENT')
    need(prepared['status'] == 'PASS' and prepared['runId'] == RUN and
         prepared['candidate'] == M2, 'COMPLETED_PREPARATION_NOT_BOUND')
    need(all(not os.path.lexists(evidence/(stage+suffix)) for stage in FOLLOWING
             for suffix in ('.intent.json', '.json', '.stop.json')), 'COMPLETED_LATER_STAGE_STARTED')
    proof = {'completedBackupRunId': RUN, 'backupReceiptSha256': BACKUP_SHA, 'protectStopSha256': STOP_SHA,
             'backupReused': True, 'historicalFilesChanged': False, 'laterStagesAbsent': True,
             'backupReceipt': result, 'configurationSha256': prepared['configurationSha256']}
    if remote:
        need(not os.path.lexists(evidence/'protect.json') and
             not os.path.lexists(BASE/('evidence-backup49-'+POST_RUN)), 'HISTORICAL_OPERATION_ADVANCED')
        need(load(private(BACKUP/'BACKUP_VERIFIED.json')) == result, 'COMPLETED_INNER_RECEIPT_MISMATCH')
        operations = private(evidence/'protect-before', directory=True)
        need(not any(operations.iterdir()) and not os.path.lexists(evidence/'backup48.bundle.tar'),
             'HISTORICAL_PROTECTION_PROGRESS_UNCERTAIN')
        config = private(BACKUP/'configuration', directory=True)
        need(set(p.name for p in config.iterdir()) == {v['file'] for v in result['configuration']},
             'COMPLETED_CONFIGURATION_INVENTORY')
        for item in result['configuration']:
            need(Path(item['file']).name == item['file'], 'COMPLETED_CONFIGURATION_PATH')
            path = private(config/item['file'])
            need(path.stat().st_size == item['bytes'] and digest(path) == item['sha256'],
                 'COMPLETED_CONFIGURATION_CHANGED')
        baseline = load(private(BACKUP/'BASELINE.json'))
        need(baseline['app']['id'] == result['appId'] and baseline['postgres']['id'] == result['postgresId'],
             'COMPLETED_BASELINE_IDENTITY')
        binding = load(private(root/'binding.json'))
        proof['diagnosis'] = diagnose(binding['canonicalPrograms']['scripts/n05/recovery_kit.py'])
        proof['encryptionNotStarted'] = True
    return proof


def image_reference(remote=False):
    path = private((REMOTE if remote else LOCAL)/'release-images.tar.gz')
    need(path.stat().st_size == IMAGE_BYTES and digest(path) == IMAGE_SHA, 'COMPLETED_IMAGE_CHANGED')
    return {'bytes': IMAGE_BYTES, 'sha256': IMAGE_SHA, 'reusedFromRunId': RUN, 'networkBytes': 0}


def receive_prepared(destination):
    proof = reconcile(remote=True)
    image = image_reference(remote=True)
    source = private(REMOTE/'release-images.tar.gz')
    # A separate ordinary file: never a hardlink into historical evidence.
    with source.open('rb') as incoming, (destination/'release-images.tar.gz').open('xb') as outgoing:
        while block := incoming.read(1024*1024): outgoing.write(block)
        outgoing.flush(); os.fsync(outgoing.fileno())
    need(digest(destination/'release-images.tar.gz') == IMAGE_SHA, 'REUSED_REMOTE_IMAGE_CHANGED')
    exclusive(destination/'evidence/completed-backup.json', proof | {'image': image})
