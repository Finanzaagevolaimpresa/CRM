"""Owner/root-only installation and removal of one exact read delegation."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import socket
import stat
import subprocess

ROOT = Path('/usr/local/lib/fai-crm-m1-r23-read')
RULE = Path('/etc/sudoers.d/fai-crm-m1-r23-read')
PYTHON = Path('/usr/bin/python3.14')
PYTHON_SHA = '52e0a13e60a981d8c4b6478be2ba5176f69da07948a056bf49cf6f077e30cb41'
FILES = {'delegate.py': 'fbc707ede37dc5c8366be791f56116ae2ab507e235e8528c0cfec053c0bd7c38',
         'observe_image_store_r22.py': '94743eaafd7815d9509f670e032dbc0166ee55fe18a930e5215b912ad8aa031a'}
# One line, exact executable and complete arguments; no wildcards or continuation.
SUDOERS = ('fai-codex fai-crm-prod-02=(faiadmin) NOPASSWD: NOSETENV: '
           '/usr/bin/python3.14 -I -B -S /usr/local/lib/fai-crm-m1-r23-read/delegate.py\n').encode()


def need(value, code):
    if not value:
        raise ValueError(code)


def protected(path, directory=False):
    for p in [path, *path.parents]:
        s = p.lstat()
        need(s.st_uid == 0 and not s.st_mode & 0o022 and not stat.S_ISLNK(s.st_mode), 'PATH_NOT_ROOT_PROTECTED')
    s = path.lstat()
    need(stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode) and s.st_nlink == 1, 'PATH_TYPE')
    return path


def state_file(path):
    protected(path.parent, directory=True)
    s = path.lstat()
    need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_uid == 0 and s.st_gid == 1000 and
         stat.S_IMODE(s.st_mode) == 0o660, 'DELEGATE_STATE_AUTHORITY')
    return path


def create(path, data, mode=0o640, gid=1000, created=None):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    fd = os.open(path, flags, mode)
    if created is not None:
        created.append(path)
    with os.fdopen(fd, 'wb') as stream:
        os.fchown(stream.fileno(), 0, gid)
        os.fchmod(stream.fileno(), mode)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    checked = state_file(path) if path == ROOT / 'observation.lock' else protected(path)
    need(checked.read_bytes() == data, 'FILE_READBACK')


def check_sudo(path):
    # System-installed visudo may be an alternatives symlink; validate its target.
    program = protected(Path('/usr/sbin/visudo').resolve(strict=True))
    p = subprocess.run([str(program), '-c', '-f', str(path)], stdin=subprocess.DEVNULL,
        capture_output=True, env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}, timeout=15)
    need(p.returncode == 0, 'SUDOERS_VALIDATION_FAILED')


def payload_files(payload):
    import base64
    need(set(payload) == set(FILES), 'PAYLOAD_FILE_SET')
    result = {k: base64.b64decode(v, validate=True) for k, v in payload.items()}
    for name, value in result.items():
        need(len(value) <= 40000 and hashlib.sha256(value).hexdigest() == FILES[name], 'PAYLOAD_HASH')
    return result


def main(mode, payload):
    receipt = {'protocol': 'FAI_M1_READ_DELEGATION_INSTALL_R23', 'mode': mode,
               'productionMutationPerformed': False, 'sshConfigurationChanged': False,
               'keysChanged': False, 'dockerGroupGranted': False,
               'arbitraryCommandsGranted': False, 'remoteObservationExecuted': False}
    created, made_root = [], False
    try:
        need(mode in ('install', 'uninstall'), 'MODE')
        need(os.getuid() == 0 and socket.gethostname() == 'fai-crm-prod-02' and
             os.environ.get('SUDO_USER') == 'faiadmin' and os.environ.get('SUDO_UID') == '1000', 'EXPLICIT_OWNER_ROOT_REQUIRED')
        need((pwd.getpwnam('faiadmin').pw_uid, pwd.getpwnam('faiadmin').pw_gid) == (1000, 1000) and
             (pwd.getpwnam('fai-codex').pw_uid, pwd.getpwnam('fai-codex').pw_gid) == (1001, 1001), 'USER_IDENTITY_CHANGED')
        need(hashlib.sha256(protected(PYTHON).read_bytes()).hexdigest() == PYTHON_SHA, 'PYTHON_CHANGED')
        protected(ROOT.parent, directory=True)
        protected(RULE.parent, directory=True)
        data = payload_files(payload)
        if mode == 'install':
            need(not ROOT.exists() and not ROOT.is_symlink() and not RULE.exists() and not RULE.is_symlink(), 'INSTALLATION_PATH_OCCUPIED_RECONCILE_FIRST')
            ROOT.mkdir(mode=0o750)
            made_root = True
            os.chown(ROOT, 0, 1000)
            os.chmod(ROOT, 0o750)
            for name, value in data.items():
                create(ROOT / name, value, created=created)
            create(ROOT / 'observation.lock', b'', 0o660, 1000, created)
            create(ROOT / 'sudoers.candidate', SUDOERS, 0o440, 0, created)
            check_sudo(ROOT / 'sudoers.candidate')
            check_sudo(Path('/etc/sudoers'))
            create(RULE, SUDOERS, 0o440, 0, created)
            check_sudo(Path('/etc/sudoers'))
            receipt.update(status='FIXED_READ_DELEGATION_INSTALLED', files=FILES,
                           ruleSha256=hashlib.sha256(SUDOERS).hexdigest())
            create(ROOT / 'installation.json', (json.dumps(receipt, sort_keys=True)+'\n').encode(), created=created)
        else:
            protected(ROOT, directory=True)
            expected_names = set(FILES) | {'observation.lock', 'sudoers.candidate', 'installation.json'}
            need({p.name for p in ROOT.iterdir()} == expected_names, 'INSTALLATION_CONTENT_CHANGED')
            for name, value in data.items():
                need(protected(ROOT / name).read_bytes() == value, 'INSTALLED_PROGRAM_CHANGED')
            need(protected(RULE).read_bytes() == protected(ROOT / 'sudoers.candidate').read_bytes() == SUDOERS, 'RULE_CHANGED')
            lock = state_file(ROOT / 'observation.lock')
            old = json.loads(protected(ROOT / 'installation.json').read_bytes())
            need(old['status'] == 'FIXED_READ_DELEGATION_INSTALLED' and old['files'] == FILES, 'INSTALLATION_RECEIPT_CHANGED')
            import fcntl
            with lock.open('rb') as handle:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                need(handle.read(33) in (b'', b'COMPLETE\n', b'STOPPED\n'), 'OBSERVATION_UNRECONCILED')
                RULE.unlink()
                for name in sorted(expected_names):
                    (ROOT / name).unlink()
                ROOT.rmdir()
            check_sudo(Path('/etc/sudoers'))
            receipt.update(status='FIXED_READ_DELEGATION_REMOVED', historicalReleaseFilesChanged=False)
    except BaseException as exc:
        # Only objects exclusively created by this invocation can be rolled back.
        rollback = True
        if mode == 'install':
            for path in reversed(created):
                try:
                    if path.exists():
                        checked = state_file(path) if path == ROOT / 'observation.lock' else protected(path)
                        checked.unlink()
                except BaseException:
                    rollback = False
            if made_root:
                try:
                    ROOT.rmdir()
                except BaseException:
                    rollback = False
        code = str(exc) if isinstance(exc, ValueError) else 'INSTALLATION_ERROR_REDACTED'
        receipt.update(status='STOP', code=code if code.replace('_', '').isalnum() and len(code) <= 100 else 'REDACTED',
                       exceptionType=type(exc).__name__, installationRollbackComplete=rollback)
    print(json.dumps(receipt, separators=(',', ':')), flush=True)
    return 0 if receipt['status'] != 'STOP' else 2
