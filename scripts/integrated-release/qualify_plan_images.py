"""CI-only real N05 image checks for the exact generated forward plan."""
import hashlib
import os
from pathlib import Path
import shutil
import socket
import time
import types
from common import load, need
from generate import pinned


def qualify(repo, plan_path, binding):
    need(os.environ.get('CI') == os.environ.get('GITHUB_ACTIONS') == 'true'
         and socket.gethostname() != 'fai-crm-prod-02', 'CI_SYNTHETIC_ONLY')
    endpoint = os.environ['M2_CI_DOCKER_SOCKET']
    if endpoint.startswith('/'):
        endpoint = 'unix://' + endpoint
    need(endpoint.startswith('unix:///'), 'CI_DAEMON_ONLY')
    relative = 'scripts/n05/failed_app_return.py'
    raw = pinned(relative)
    need(hashlib.sha256(raw).hexdigest() == binding['canonicalPrograms'][relative],
         'CANONICAL_IMAGE_CHECK_CHANGED')
    module = types.ModuleType('r40_canonical_plan_images')
    module.__file__ = str(Path(repo)/relative)
    exec(compile(raw, module.__file__, 'exec'), module.__dict__)
    plan = load(plan_path)
    engine = module.DockerEngine(plan, Path(repo),
                                command=[shutil.which('docker'), '--host', endpoint])
    for field in ('candidate', 'return_image'):
        need(engine.image(plan[field], time.time()+60), 'GENERATED_PLAN_IMAGE_UNAVAILABLE', role=field)
    wrong = plan['return_image'] | {'tag': 'fai-crm:r05-recovery-' + binding['returnCommit']}
    need(not engine.image(wrong, time.time()+60), 'WRONG_R37_TAG_ACCEPTED')
    need(not engine.image(plan['return_image'] | {'oci_commit': 'f'*40}, time.time()+60),
         'WRONG_R37_COMMIT_ACCEPTED')
    return {'generatedForwardPlanUsed': True, 'canonicalDockerEngineImageUsed': True,
            'exactSavedCandidateAndReturnAccepted': True, 'wrongR37TagDenied': True,
            'wrongR37CommitDenied': True, 'imagesRetagged': False,
            'productionConnected': False}
