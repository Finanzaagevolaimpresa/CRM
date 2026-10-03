"""Reconcile only the fixed R28 pre-quiescence STOP; preserve its files and intent."""
import os
from pathlib import Path
import shutil

from common import digest, exclusive, load, need, private

RUN = '8e0e7fecd0434cc18ea8d04057aefac8'
MANIFEST_SHA = '11203610144a748db910d14ed6b9ea1b1b5fbdcefe413557479dff4266f63773'
STOP_SHA = 'c6c8d78b0850e406471ded49f646917395f828ffdead5e61ea4cc29f3b4b82fd'
PREPARE_SHA = '483efcf66b02ebed2dea840a7ea7034663b4b24166b93b917de956f55ffdb6c7'
IMAGE_SHA = '3e0dd8b4ff7cd0d82fde2f7445334e1f764bd11042154f70905a171747cd7dc2'
IMAGE_BYTES = 544767216
ERROR_SHA = '31a75e9ac33507086b8e92198b79fdb6391c8dea309a13bdc9e08fb3a466bd72'
LOCAL = Path(r'C:\Users\Utente\Desktop\CRM\artifacts\M2-rilascio-R26') / ('M2-' + RUN)
BASE = Path('/home/faiadmin/.local/share/fai-crm-releases')
REMOTE = BASE / ('m2-release-r26-' + RUN)
FOLLOWING = ('protect', 'copies-backup', 'recover', 'migrate', 'deploy', 'postcheck',
             'postbackup', 'postprotect', 'copies-postbackup', 'final')


def verified_json(path, expected):
    path = private(path)
    need(path.stat().st_size <= 65536 and digest(path) == expected, 'CONSUMED_RECEIPT_CHANGED')
    return load(path)


def validate_stop(value):
    need(value['status'] == 'STOP' and value['stage'] == 'backup' and value['code'] == 'BACKUP_STOP',
         'CONSUMED_STOP_NOT_BOUND')
    receipt = value['details']['backupReceipt']
    need(receipt['status'] == 'STOP' and receipt['code'] == 'COMMAND_FAILED' and
         receipt['quiescenceAttempted'] is False and receipt['interruptionRequested'] is False and
         receipt['localCommandGroupsQuiet'] is True, 'CONSUMED_QUIESCENCE_OR_UNCERTAINTY')
    need(receipt['commandFailure'] == {
        'commandId': 'BACKUP_RESOURCE_PREFLIGHT', 'phase': 'BEFORE_QUIESCENCE',
        'exitCode': 1, 'errorClass': 'OUTPUT_REDACTED', 'stderrBytes': 47, 'stderrSha256': ERROR_SHA
    }, 'CONSUMED_FAILURE_DIFFERENT')
    return receipt


def reconcile(remote=False):
    root = REMOTE if remote else LOCAL
    manifest = verified_json(root / 'package.json', MANIFEST_SHA)
    need(manifest['runId'] == RUN and manifest['imageArchiveSha256'] == IMAGE_SHA, 'CONSUMED_MANIFEST_BINDING')
    evidence = root / 'evidence' if remote else root
    prepared = verified_json(evidence / 'prepare.json', PREPARE_SHA)
    stop = verified_json(evidence / ('backup.stop.json' if remote else 'backup.json'), STOP_SHA)
    receipt = validate_stop(stop)
    need(prepared['status'] == 'PASS' and prepared['stage'] == 'prepare' and prepared['runId'] == RUN and
         prepared['runtimeApplicationChanged'] is False and prepared['observation']['ledgerCount'] == 48,
         'CONSUMED_PREPARATION_NOT_BOUND')
    need(all(not os.path.lexists(evidence / (stage + suffix)) for stage in FOLLOWING
             for suffix in ('.intent.json', '.json', '.stop.json')), 'CONSUMED_LATER_STAGE_STARTED')
    if remote:
        need(not os.path.lexists(evidence / 'backup.json'), 'CONSUMED_BACKUP_COMPLETED')
        work = BASE / ('evidence-backup48-' + RUN)
        need(load(private(work / 'STOP.json')) == receipt, 'CONSUMED_INNER_STOP_MISMATCH')
        need(all(not os.path.lexists(work / name) for name in
                 ('LEDGER_BEFORE.json', 'SESSION_SETTLEMENT.json', 'BACKUP_VERIFIED.json')),
             'CONSUMED_BACKUP_PROGRESS')
        need(not any(private(work / 'sets', directory=True).iterdir()), 'CONSUMED_BACKUP_SET_EXISTS')
    return {'consumedRunId': RUN, 'stopSha256': STOP_SHA, 'previousPrepareSha256': PREPARE_SHA,
            'quiescenceAttempted': False, 'laterStagesAbsent': True, 'historicalFilesChanged': False,
            'freshRuntimeObservationStillRequired': True}


def copy_archive(destination, remote=False):
    root = REMOTE if remote else LOCAL
    source = private(root / 'release-images.tar.gz')
    need(source.stat().st_size == IMAGE_BYTES and digest(source) == IMAGE_SHA, 'CONSUMED_IMAGE_CHANGED')
    target = private(destination, directory=True) / 'release-images.tar.gz'
    with source.open('rb') as incoming, target.open('xb') as outgoing:
        shutil.copyfileobj(incoming, outgoing, 1024 * 1024)
        outgoing.flush()
        os.fsync(outgoing.fileno())
    need(private(target).stat().st_size == IMAGE_BYTES and digest(target) == IMAGE_SHA, 'REUSED_IMAGE_COPY_CHANGED')
    return {'bytes': IMAGE_BYTES, 'sha256': IMAGE_SHA, 'reusedFromRunId': RUN, 'networkBytes': 0}


def receive_prepared(destination):
    proof = reconcile(remote=True)
    image = copy_archive(destination, remote=True)
    exclusive(destination / 'evidence' / 'consumed-preparation.json', proof | {'image': image})
