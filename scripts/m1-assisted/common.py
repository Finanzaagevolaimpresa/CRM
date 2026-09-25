"""Bounded execution and immutable receipts for the explicit owner release."""
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time


class Stop(Exception):
    def __init__(self, code, **details):
        super().__init__(code)
        self.code, self.details = code, details


def need(value, code, **details):
    if not value:
        raise Stop(code, **details)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def value_sha(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def decode(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            need(key not in result, 'DUPLICATE_JSON_KEY')
            result[key] = value
        return result
    def bad(_):
        raise Stop('NONFINITE_JSON')
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=bad)


def load(path):
    need(Path(path).stat().st_size <= 2 * 1024 * 1024, 'JSON_SIZE_LIMIT')
    return decode(Path(path).read_bytes())


def private(path, directory=False):
    path = Path(path)
    need(path.is_absolute() and '..' not in path.parts, 'PRIVATE_PATH_INVALID')
    for p in [path, *path.parents]:
        s = p.lstat()
        need(not stat.S_ISLNK(s.st_mode), 'SYMLINK_DENIED')
        if os.name != 'nt':
            need(s.st_uid in (0, os.getuid()) and not s.st_mode & 0o022, 'PATH_AUTHORITY')
    s = path.lstat()
    if directory:
        need(stat.S_ISDIR(s.st_mode), 'DIRECTORY_REQUIRED')
    else:
        need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1, 'SINGLE_REGULAR_FILE_REQUIRED')
    return path


def exclusive(path, value):
    path = Path(path)
    private(path.parent, directory=True)
    data = value if isinstance(value, bytes) else canonical(value) + b'\n'
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    need(path.read_bytes() == data, 'RECEIPT_READBACK_FAILED')
    if os.name != 'nt':
        fd = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    return {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}


def module(path, name, expected):
    need(digest(private(path)) == expected, 'PROGRAM_HASH_MISMATCH')
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    sys.modules[name] = result
    spec.loader.exec_module(result)
    return result


def error_class(error):
    raw = error.lower()
    for needles, category in [
        ((b'permission denied', b'operation not permitted'), 'PERMISSION_DENIED'),
        ((b'no space left',), 'NO_SPACE'), ((b'no such file', b'not found'), 'NOT_FOUND'),
        ((b'cannot connect', b'connection refused'), 'CONNECTION_FAILED'),
        ((b'timeout', b'timed out', b'deadline'), 'TIMEOUT'),
    ]:
        if any(n in raw for n in needles):
            return category
    return 'COMMAND_ERROR_REDACTED'


class Commands:
    def __init__(self, seconds=900, cwd=None):
        self.wall_end = time.time() + seconds
        self.mono_end = time.monotonic() + seconds
        self.cwd = cwd
        self.env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/home/faiadmin',
                    'LANG': 'C', 'LC_ALL': 'C', 'GIT_TERMINAL_PROMPT': '0'}

    def remaining(self, cap):
        n = min(cap, self.wall_end - time.time(), self.mono_end - time.monotonic())
        need(n > 0, 'STAGE_DEADLINE_EXPIRED')
        return n

    def run(self, command_id, args, *, seconds=60, data=None, source=None, output=None, env=None):
        need(re.fullmatch('[A-Z0-9_]{1,80}', command_id), 'COMMAND_IDENTIFIER_INVALID')
        limit = self.remaining(seconds)
        try:
            p = subprocess.Popen([str(x) for x in args], cwd=self.cwd,
                env=self.env | (env or {}), stdin=source or (subprocess.PIPE if data is not None else subprocess.DEVNULL),
                stdout=output or subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        except OSError:
            raise Stop('COMMAND_START_FAILED', commandId=command_id) from None
        try:
            out, error = p.communicate(data, timeout=limit)
        except BaseException:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                p.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                raise Stop('COMMAND_GROUP_STOP_UNVERIFIED', commandId=command_id) from None
            raise Stop('COMMAND_INTERRUPTED_OR_EXPIRED', commandId=command_id, exitCode=p.returncode) from None
        need(p.returncode == 0, 'COMMAND_FAILED', commandId=command_id, exitCode=p.returncode,
             errorClass=error_class(error), stderrBytes=len(error), stderrSha256=hashlib.sha256(error).hexdigest())
        need(output is not None or len(out) <= 8 * 1024 * 1024, 'COMMAND_OUTPUT_LIMIT', commandId=command_id)
        return out or b''

    def docker(self, command_id, *args, **options):
        return self.run(command_id, ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', *args], **options)

    def inspect(self, kind, identity):
        return decode(self.docker('INSPECT_' + kind.upper(), kind, 'inspect', identity))[0]


class Stages:
    """An intent without a durable success is never replay authority."""
    def __init__(self, root, run_id):
        self.root, self.run_id = Path(root), run_id

    def result(self, stage):
        path = self.root / (stage + '.json')
        return load(private(path)) if path.exists() else None

    def begin(self, stage, dependencies):
        need(re.fullmatch('[a-z][a-z-]{2,40}', stage), 'STAGE_INVALID')
        for dependency in dependencies:
            value = self.result(dependency)
            need(value and value.get('status') == 'PASS' and value.get('runId') == self.run_id,
                 'PREDECESSOR_NOT_VERIFIED', predecessor=dependency)
        need(self.result(stage) is None and not (self.root / (stage + '.intent.json')).exists(),
             'STAGE_CONSUMED_RECONCILE_ONLY', stage=stage)
        exclusive(self.root / (stage + '.intent.json'), {'runId': self.run_id, 'stage': stage, 'utc': utc()})

    def complete(self, stage, evidence):
        result = {'protocol': 'FAI_M1_ASSISTED_STAGE_R21', 'runId': self.run_id, 'stage': stage,
                  'status': 'PASS', 'utc': utc(), 'agentRealKeyAccess': False, **evidence}
        exclusive(self.root / (stage + '.json'), result)
        return result
