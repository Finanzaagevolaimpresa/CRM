"""Single immutable read-only delegation for the existing e67bea STOP."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import stat
import subprocess
import sys

ROOT = Path('/usr/local/lib/fai-crm-m1-r23-read')
PYTHON = Path('/usr/bin/python3.14')
PYTHON_SHA = '52e0a13e60a981d8c4b6478be2ba5176f69da07948a056bf49cf6f077e30cb41'
OBSERVER_SHA = '94743eaafd7815d9509f670e032dbc0166ee55fe18a930e5215b912ad8aa031a'
PROTOCOL = 'FAI_M1_FIXED_READ_DELEGATE_R23'


def need(value, code):
    if not value:
        raise ValueError(code)


def protected(path, *, directory=False):
    for parent in [path, *path.parents]:
        s = parent.lstat()
        need(s.st_uid == 0 and not s.st_mode & 0o022 and not stat.S_ISLNK(s.st_mode), 'UNPROTECTED_PROGRAM_PATH')
    s = path.lstat()
    need(stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode) and s.st_nlink == 1, 'PROGRAM_PATH_TYPE')
    return path


def verified(path, expected):
    data = protected(path).read_bytes()
    need(hashlib.sha256(data).hexdigest() == expected, 'PROGRAM_HASH_CHANGED')
    return data


def project(value):
    """Deny extra output instead of forwarding potentially sensitive diagnostics."""
    need(isinstance(value, dict) and value.get('protocol') == 'FAI_M1_IMAGE_STORE_READONLY_R22', 'OBSERVER_PROTOCOL')
    need(value.get('readOnly') is True, 'OBSERVER_NOT_READONLY')
    if value.get('status') == 'STOP':
        return {'protocol': value['protocol'], 'status': 'STOP', 'readOnly': True,
                'code': 'FIXED_OBSERVATION_STOP', 'observationCode': value.get('code')
                if isinstance(value.get('code'), str) and value['code'].replace('_', '').isalnum() and len(value['code']) <= 100 else 'REDACTED'}
    expected = {'protocol', 'runId', 'status', 'observedUtc', 'readOnly', 'productionMutationPerformed',
                'agentRealKeyAccess', 'engine', 'images', 'containers', 'laterStagesNotStarted',
                'historicalReceiptsPreserved', 'releaseAdmitted'}
    need(set(value) == expected and value['status'] == 'OBSERVATION_COMPLETE' and
         value['runId'] == 'e67bea4040fc4aeb86a0c98ac6178e7e' and
         value['productionMutationPerformed'] is False and value['releaseAdmitted'] is False,
         'OBSERVER_RECEIPT_UNEXPECTED')
    # The observer is hash pinned, and its projection is independently tested.
    return value


def spawn_observer(program, lock_handle):
    # Keep serialization even if the SSH/controller process is interrupted.
    # The observer owns the same open lock until its bounded work has ended.
    return subprocess.Popen([str(PYTHON), '-I', '-B', '-S', str(program)], cwd=ROOT,
        env={'PATH': '/usr/bin:/bin', 'HOME': '/home/faiadmin', 'LANG': 'C', 'LC_ALL': 'C'},
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        start_new_session=True, pass_fds=(lock_handle.fileno(),))


def run():
    import fcntl
    need(len(sys.argv) == 1 and socket.gethostname() == 'fai-crm-prod-02' and
         os.getuid() == os.getgid() == 1000 and os.environ.get('SUDO_USER') == 'fai-codex' and
         os.environ.get('SUDO_UID') == '1001', 'DELEGATION_IDENTITY_OR_ARGUMENTS')
    need(sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode, 'PYTHON_FLAGS')
    protected(ROOT, directory=True)
    verified(PYTHON, PYTHON_SHA)
    program = ROOT / 'observe_image_store_r22.py'
    verified(program, OBSERVER_SHA)
    lock = protected(ROOT / 'observation.lock')
    with lock.open('rb') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('OBSERVATION_ALREADY_RUNNING') from None
        p = spawn_observer(program, handle)
        try:
            out, err = p.communicate(timeout=125)
        except BaseException:
            os.killpg(p.pid, signal.SIGKILL)
            p.communicate(timeout=5)
            raise ValueError('OBSERVATION_TIMEOUT_OR_INTERRUPTED') from None
        need(len(out) <= 32768 and len(err) == 0, 'OBSERVER_OUTPUT_REDACTED')
        result = project(json.loads(out))
        need(p.returncode in (0, 2), 'OBSERVER_EXIT_UNEXPECTED')
        need((p.returncode == 0) == (result['status'] == 'OBSERVATION_COMPLETE'), 'OBSERVER_EXIT_CONTRADICTION')
        return result


if __name__ == '__main__':
    receipt = {'protocol': PROTOCOL, 'observedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'productionMutationPerformed': False, 'arbitraryArgumentsAccepted': False}
    try:
        receipt.update(status='READ_RETURNED', observation=run())
    except BaseException as exc:
        code = str(exc) if isinstance(exc, ValueError) else 'LOCAL_DELEGATE_ERROR'
        receipt.update(status='STOP', code=code if code.replace('_', '').isalnum() and len(code) <= 100 else 'REDACTED')
    print(json.dumps(receipt, separators=(',', ':')), flush=True)
    raise SystemExit(0 if receipt['status'] == 'READ_RETURNED' and receipt['observation']['status'] == 'OBSERVATION_COMPLETE' else 2)
