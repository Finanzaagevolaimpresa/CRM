"""Fixed R29 completed backup and pre-encryption STOP; never replay its stages."""
import os
from pathlib import Path

from common import digest, exclusive, load, need, private
from sealed_programs import BASE as BASE_STRING, M1, M1_TREE, M2

RUN = 'de4842fa7df64d6da023c53f808c48c0'
POST_RUN = 'dee63a819c7e434ea6a58cf0cb56738c'
MANIFEST_SHA = '3d45160663a67c3097c1d20f416cc2c56cb76b6d1a04620e2df6d99aae1a87b0'
PREPARE_SHA = '7c5ec72c768fcf025a47e665b339d964f5e02186188620b84f694cba5cb01514'
BACKUP_SHA = '290b0996b0eb83e02028690811496f8dab4677a45a4d6c5efca425f2d8bde0dc'
STOP_SHA = '2c3f021646e5324f4ea767061cf6b08ec82f8932eb0d9553ab592f9ac174fd4f'
ERROR_SHA = '92541c64497e23f3f85104574c6e8d354441ec436da63c18600ff65e94c75e24'
IMAGE_SHA = '3e0dd8b4ff7cd0d82fde2f7445334e1f764bd11042154f70905a171747cd7dc2'
IMAGE_BYTES = 544767216
BASE = Path(BASE_STRING)
LOCAL = Path(r'C:\Users\Utente\Desktop\CRM\artifacts\M2-rilascio-R26') / ('M2-' + RUN)
REMOTE = BASE / ('m2-release-r26-' + RUN)
RUNTIME = BASE / ('release-' + M2[:12] + '-m2-' + RUN)
BACKUP = BASE / ('evidence-backup48-' + RUN)
FOLLOWING = ('copies-backup', 'recover', 'migrate', 'deploy', 'postcheck',
             'postbackup', 'postprotect', 'copies-postbackup', 'final')


def verified_json(path, expected):
    path = private(path)
    need(path.stat().st_size <= 65536 and digest(path) == expected, 'COMPLETED_RECEIPT_CHANGED')
    return load(path)


def validate_stop(value):
    need(value['status'] == 'STOP' and value['stage'] == 'protect' and value['code'] == 'COMMAND_FAILED' and
         value['details'] == {'commandId': 'CANONICAL_N05_PROTECT', 'errorClass': 'COMMAND_ERROR_REDACTED',
                             'exitCode': 1, 'stderrBytes': 67, 'stderrSha256': ERROR_SHA},
         'COMPLETED_PROTECT_FAILURE_DIFFERENT')


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


def reconcile(remote=False):
    root = REMOTE if remote else LOCAL
    manifest = verified_json(root / 'package.json', MANIFEST_SHA)
    need(manifest['runId'] == RUN and manifest['postRunId'] == POST_RUN and
         manifest['imageArchiveSha256'] == IMAGE_SHA, 'COMPLETED_MANIFEST_BINDING')
    evidence = root / 'evidence' if remote else root
    prepared = verified_json(evidence / 'prepare.json', PREPARE_SHA)
    backup = verified_json(evidence / 'backup.json', BACKUP_SHA)
    validate_stop(verified_json(evidence / ('protect.stop.json' if remote else 'protect.json'), STOP_SHA))
    result = validate_backup(backup)
    need(prepared['status'] == 'PASS' and prepared['runId'] == RUN and prepared['stage'] == 'prepare',
         'COMPLETED_PREPARATION_NOT_BOUND')
    need(all(not os.path.lexists(evidence / (stage + suffix)) for stage in FOLLOWING
             for suffix in ('.intent.json', '.json', '.stop.json')), 'COMPLETED_LATER_STAGE_STARTED')
    if remote:
        need(not os.path.lexists(evidence / 'protect.json'), 'HISTORICAL_PROTECT_COMPLETED')
        need(load(private(BACKUP / 'BACKUP_VERIFIED.json')) == result, 'COMPLETED_INNER_RECEIPT_MISMATCH')
        need(not os.path.lexists(BASE / ('evidence-backup48-' + POST_RUN)), 'HISTORICAL_POSTBACKUP_STARTED')
        # The canonical rejection precedes Operation initialization.
        operations = private(evidence / 'protect-before', directory=True)
        need(not any(operations.iterdir()) and not os.path.lexists(evidence / 'backup48.bundle.tar'),
             'HISTORICAL_PROTECTION_PROGRESS_UNCERTAIN')
        config = private(BACKUP / 'configuration', directory=True)
        need(set(p.name for p in config.iterdir()) == {e['file'] for e in result['configuration']},
             'COMPLETED_CONFIGURATION_INVENTORY')
        for item in result['configuration']:
            need(Path(item['file']).name == item['file'], 'COMPLETED_CONFIGURATION_PATH')
            path = private(config / item['file'])
            need(path.stat().st_size == item['bytes'] and digest(path) == item['sha256'],
                 'COMPLETED_CONFIGURATION_CHANGED')
        baseline = load(private(BACKUP / 'BASELINE.json'))
        need(baseline['app']['id'] == result['appId'] and baseline['postgres']['id'] == result['postgresId'],
             'COMPLETED_BASELINE_IDENTITY')
    return {'completedBackupRunId': RUN, 'backupReceiptSha256': BACKUP_SHA, 'protectStopSha256': STOP_SHA,
            'failedPublicCode': 'SOURCE_MIGRATION_COUNT_UNQUALIFIED', 'backupReused': True,
            'historicalFilesChanged': False, 'laterStagesAbsent': True, 'backupReceipt': result,
            'configurationSha256': prepared['configurationSha256']}


def image_reference(remote=False):
    source = private((REMOTE if remote else LOCAL) / 'release-images.tar.gz')
    need(source.stat().st_size == IMAGE_BYTES and digest(source) == IMAGE_SHA, 'COMPLETED_IMAGE_CHANGED')
    return {'bytes': IMAGE_BYTES, 'sha256': IMAGE_SHA, 'reusedFromRunId': RUN, 'networkBytes': 0}


def receive_prepared(destination):
    proof = reconcile(remote=True)
    image = image_reference(remote=True)
    exclusive(destination / 'evidence' / 'completed-backup.json', proof | {'image': image})
