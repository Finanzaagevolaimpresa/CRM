"""Single immutable read-only delegation for the existing e67bea STOP."""
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import stat
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


def state_file(path):
    protected(path.parent, directory=True)
    s = path.lstat()
    need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_uid == 0 and s.st_gid == 1000 and
         stat.S_IMODE(s.st_mode) == 0o660, 'DELEGATE_STATE_AUTHORITY')
    return path


def mark(handle, value):
    handle.seek(0)
    handle.write(value)
    handle.truncate()
    handle.flush()
    os.fsync(handle.fileno())


def one_observation(read, handle):
    need(handle.read(33) == b'', 'OBSERVATION_CONSUMED_RECONCILE_ONLY')
    # A hard kill or unverified settlement leaves a durable barrier, even after
    # the kernel releases flock. No further observation/removal is then allowed.
    mark(handle, b'RUNNING\n')
    try:
        result = project(supervised_read(read))
    except BaseException as exc:
        if getattr(exc, 'code', '') != 'COMMAND_GROUP_STOP_UNVERIFIED':
            mark(handle, b'STOPPED\n')
        raise
    mark(handle, b'COMPLETE\n')
    return result


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


def supervised_read(read):
    # Stay in the canonical Commands supervisor: its children use new sessions.
    # Killing an outer process group would orphan those commands and lose the lock.
    def interrupted(_number, _frame):
        raise ValueError('OBSERVATION_INTERRUPTED')
    previous = {n: signal.getsignal(n) for n in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGALRM)}
    try:
        for n in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            signal.signal(n, interrupted)
        return read()
    finally:
        signal.alarm(0)
        for n, handler in previous.items():
            signal.signal(n, handler)


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
    spec = importlib.util.spec_from_file_location('fixed_m1_observer', program)
    observer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(observer)
    lock = state_file(ROOT / 'observation.lock')
    with lock.open('r+b') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('OBSERVATION_ALREADY_RUNNING') from None
        return one_observation(observer.remote_read, handle)


if __name__ == '__main__':
    receipt = {'protocol': PROTOCOL, 'observedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'productionMutationPerformed': False, 'arbitraryArgumentsAccepted': False}
    try:
        receipt.update(status='READ_RETURNED', observation=run())
    except BaseException as exc:
        code = getattr(exc, 'code', str(exc) if isinstance(exc, ValueError) else 'LOCAL_DELEGATE_ERROR')
        receipt.update(status='STOP', code=code if code.replace('_', '').isalnum() and len(code) <= 100 else 'REDACTED')
    print(json.dumps(receipt, separators=(',', ':')), flush=True)
    raise SystemExit(0 if receipt['status'] == 'READ_RETURNED' and receipt['observation']['status'] == 'OBSERVATION_COMPLETE' else 2)
