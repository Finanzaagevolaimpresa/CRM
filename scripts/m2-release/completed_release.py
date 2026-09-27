"""Read-only reconciliation of R30; never retry its consumed deploy intent."""
import os
from pathlib import Path
from common import digest, exclusive, load, need, private
import completed_backup as backup

RUN = '2662a61c934f4a3888236cad99c446ee'
POST_RUN = '77ee00a129f24abbb36c62327cccb9ba'
MANIFEST_SHA = '039c64df7af1812b49e61eb62ffce8971bec36bc99e63e793802d0a215e550a0'
STOP_SHA = '5f2c2d02a2d226125d2543b9a283d2b1773f3c5b82c45ec8a09456858aa7f7c2'
HASHES = {
    'prepare':'826ebf5432dc11f0aa99d19829d43a28817f59b8e3811ddc0bf0fb4e7d0fb0b2',
    'protect':'c742f4195216ec2cf075497815e6ea6c230d767c7c9b575ef15103a68a8b9406',
    'copies-backup':'053704d268c4909fd835474ae85915e6ebdff217c6f4563fce3f8938d245ca48',
    'recover':'329b1801d62dfa14e2253a1f43dfa7aa61527df7ed0b3a39577e5592c41945c9',
    'migrate':'b6e2899cd6b27ee650f9fbbae32af4573ff95ad75aed26074b70aa46eadaf946'}
LOCAL = backup.LOCAL.parent / ('M2-' + RUN)
REMOTE = backup.BASE / ('m2-release-r26-' + RUN)
FOLLOWING = ('postcheck','postbackup','postprotect','copies-postbackup','final')
FORWARD_FILES = ('forward-plan.json','forward.json','forward.json.pending',
    'return-request.json','return.json','return.json.pending',
    'recovery-evidence.json','artifacts-evidence.json','reviewed_plan-evidence.json',
    'authorization-evidence.json','return-image-schema-compatibility-evidence.json')

def result(stage, remote=True):
    need(stage in HASHES, 'COMPLETED_STAGE_INVALID')
    root = REMOTE/'evidence' if remote else LOCAL
    value = backup.verified_json(root/(stage+'.json'), HASHES[stage])
    need(value['status'] == 'PASS' and value['stage'] == stage and value['runId'] == RUN,
         'COMPLETED_STAGE_IDENTITY')
    return value

def reconcile(remote=False):
    root = REMOTE if remote else LOCAL
    evidence = root/'evidence' if remote else root
    m = backup.verified_json(root/'package.json', MANIFEST_SHA)
    need(m['runId'] == RUN and m['postRunId'] == POST_RUN and
         m['completedBackupRunId'] == backup.RUN, 'COMPLETED_RELEASE_MANIFEST')
    stages = {name:result(name, remote) for name in HASHES}
    stop = backup.verified_json(evidence/('deploy.stop.json' if remote else 'deploy.json'), STOP_SHA)
    need(stop['status'] == 'STOP' and stop['stage'] == 'deploy' and
         stop['code'] == 'REMOTE_FAILURE_REDACTED' and stop['details'] == {}, 'COMPLETED_DEPLOY_STOP')
    need(all(not os.path.lexists(evidence/(stage+suffix)) for stage in FOLLOWING
             for suffix in ('.intent.json','.json','.stop.json')), 'COMPLETED_RELEASE_LATER_STAGE')
    if remote:
        # A new run is admitted only after proving the old failure preceded N05.
        need(load(private(evidence/'deploy.intent.json'))['runId'] == RUN and
             not os.path.lexists(evidence/'deploy.json'), 'HISTORICAL_DEPLOY_STATE_CHANGED')
        need(not any(os.path.lexists(evidence/name) for name in FORWARD_FILES) and
             not any(evidence.glob('registry-*.json')), 'HISTORICAL_FORWARD_MAY_HAVE_STARTED')
        need(not os.path.lexists(backup.BASE/('evidence-backup48-'+POST_RUN)), 'HISTORICAL_POSTBACKUP_STARTED')
        for name, entry in m['files'].items():
            need(Path(name).name == name, 'HISTORICAL_MEMBER_PATH')
            p = private(root/name)
            need(p.stat().st_size == entry['bytes'] and digest(p) == entry['sha256'], 'HISTORICAL_PROGRAM_CHANGED')
        # This is the precise path to the reproduced KeyError, before any evidence writes.
        review = load(private(root/'review.json'))
        need('returnCompatibilityEvidence' not in review and type(review['softwareEvidence']) is str,
             'HISTORICAL_REPRODUCTION_NOT_APPLICABLE')
        cipher = private(evidence/'backup48.bundle.tar')
        p = stages['protect']
        need(cipher.stat().st_size == p['bundle_bytes'] and digest(cipher) == p['bundle_sha256'],
             'COMPLETED_CIPHERTEXT_CHANGED')
    return {'completedReleaseRunId':RUN,'completedBackupRunId':backup.RUN,
        'manifestSha256':MANIFEST_SHA,'stageSha256':dict(HASHES),'deployStopSha256':STOP_SHA,
        'historicalFilesChanged':False,'forwardArtifactsAbsentVerified':remote,
        'completedPhasesReplayed':False,'recoveryScope':stages['recover']['scope']}

def validate_copies(copies, remote=True):
    expected = result('copies-backup',remote=remote)['copies']
    need(copies == expected and set(copies) == {'C','F'}, 'HISTORICAL_COPIES_BINDING')
    return expected

def verify_local_copies(devices):
    proof = reconcile()
    copies = result('copies-backup',remote=False)['copies']
    for drive, entry in copies.items():
        need(entry['physicalDisk'] == devices[drive]['disk'] and
             entry['physicalIdentityVerified'] and entry['readbackVerified'], 'COMPLETED_COPY_PHYSICAL_DRIFT')
        p = private(Path(entry['path']))
        need(p.stat().st_size == entry['bytes'] and digest(p) == entry['sha256'], 'COMPLETED_COPY_CHANGED')
    return proof, copies

def receive_prepared(destination):
    proof = reconcile(remote=True)
    exclusive(destination/'evidence'/'completed-release-reference.json',proof)
