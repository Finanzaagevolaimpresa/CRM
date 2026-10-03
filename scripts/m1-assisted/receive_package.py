"""Fixed owner upload bootstrap. Only package bytes; no runtime mutation or credentials."""
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import sys
import tarfile

PREPARED = Path('/home/faiadmin/.local/share/fai-crm-releases/m1-assisted-r21-e67bea4040fc4aeb86a0c98ac6178e7e')
PREPARED_MANIFEST_SHA = '961e6d7f6f1d1275a8d472eed8b2bc5dc14adecd25b304f4dad5b475985088c3'
IMAGE_NAME = 'release-images.tar.gz'
FOLLOWING = ('backup', 'protect', 'copies-backup', 'recover', 'provision', 'copies-config', 'migrate', 'deploy', 'postcheck')


def need(ok, code):
    if not ok:
        raise RuntimeError(code)


def safe_file(path):
    for item in (path, *path.parents):
        metadata = item.lstat()
        need(not stat.S_ISLNK(metadata.st_mode), 'REUSE_SYMLINK_DENIED')
        if os.name != 'nt':
            need(metadata.st_uid in (0, os.getuid()) and not metadata.st_mode & 0o022, 'REUSE_PATH_AUTHORITY')
    need(stat.S_ISREG(path.stat().st_mode) and path.stat().st_nlink == 1, 'REUSE_REGULAR_FILE_REQUIRED')
    return path


def reuse_images(destination, expected):
    """Copy only the fixed consumed run's verified image archive, never its intent."""
    manifest_path = safe_file(PREPARED / 'package.json')
    need(manifest_path.stat().st_size <= 65536, 'REUSE_MANIFEST_SIZE')
    raw = manifest_path.read_bytes()
    need(hashlib.sha256(raw).hexdigest() == PREPARED_MANIFEST_SHA, 'REUSE_PACKAGE_CHANGED')
    manifest = json.loads(raw)
    need(manifest['runId'] == 'e67bea4040fc4aeb86a0c98ac6178e7e' and
         manifest['files'][IMAGE_NAME] == expected, 'REUSE_ARCHIVE_BINDING')
    stop_path = safe_file(PREPARED / 'evidence/prepare.stop.json')
    need(stop_path.stat().st_size <= 16384, 'REUSE_STOP_SIZE')
    stop = json.loads(stop_path.read_bytes())
    need(stop['status'] == 'STOP' and stop['stage'] == 'prepare' and stop['code'] == 'COMMAND_FAILED' and
         stop['details']['commandId'] == 'INSPECT_IMAGE' and stop['details']['exitCode'] == 1 and
         stop['details']['stderrBytes'] == 115 and stop['details']['stderrSha256'] ==
         'ff8de78af764da229499fee0e1131c12a6688c63664b8c8bbbe4cc2b5cbd06d0', 'REUSE_STOP_CHANGED')
    need(all(not (PREPARED / 'evidence' / (stage + suffix)).exists() for stage in FOLLOWING
             for suffix in ('.intent.json', '.json', '.stop.json')), 'REUSE_LATER_STAGE_STARTED')
    source = safe_file(PREPARED / IMAGE_NAME)
    need(source.stat().st_size == expected['bytes'], 'REUSE_IMAGE_SIZE')
    target = destination / IMAGE_NAME
    h = hashlib.sha256()
    with source.open('rb') as incoming, target.open('xb') as outgoing:
        while block := incoming.read(1024 * 1024):
            outgoing.write(block)
            h.update(block)
        outgoing.flush()
        os.fsync(outgoing.fileno())
    need(h.hexdigest() == expected['sha256'], 'REUSE_IMAGE_HASH')
    h = hashlib.sha256()
    with safe_file(target).open('rb') as incoming:
        while block := incoming.read(1024 * 1024):
            h.update(block)
    need(target.stat().st_size == expected['bytes'] and h.hexdigest() == expected['sha256'], 'REUSE_COPY_READBACK')


def receive(binding):
    os.umask(0o077)
    need(socket.gethostname() == 'fai-crm-prod-02' and os.getuid() == os.getgid() == 1000, 'WRONG_OWNER_TARGET')
    need(re.fullmatch('[0-9a-f]{32}', binding['runId']), 'RUN_ID_INVALID')
    root = Path('/home/faiadmin/.local/share/fai-crm-releases') / ('m1-assisted-r21-' + binding['runId'])
    for parent in [root.parent, *root.parent.parents]:
        st = parent.lstat()
        need(parent.is_dir() and not parent.is_symlink() and st.st_uid in (0, 1000) and not st.st_mode & 0o022, 'PARENT_AUTHORITY')
    need(not root.exists(), 'PACKAGE_PATH_OCCUPIED_RECONCILE_ONLY')
    root.mkdir(mode=0o700)
    (root / 'evidence').mkdir(mode=0o700)
    archive = root / 'received.tar'
    need(0 < binding['archiveBytes'] <= 1024**3, 'PACKAGE_SIZE_LIMIT')
    h = hashlib.sha256()
    remaining = binding['archiveBytes']
    with archive.open('xb') as out:
        while remaining:
            block = sys.stdin.buffer.read(min(1024 * 1024, remaining))
            need(block, 'PACKAGE_TRUNCATED')
            out.write(block)
            h.update(block)
            remaining -= len(block)
        need(not sys.stdin.buffer.read(1), 'PACKAGE_TRAILING_BYTES')
        out.flush()
        os.fsync(out.fileno())
    need(h.hexdigest() == binding['archiveSha256'], 'PACKAGE_TRANSPORT_HASH')
    with tarfile.open(archive, 'r:') as source:
        members = source.getmembers()
        need(0 < len(members) < 30 and len({m.name for m in members}) == len(members), 'PACKAGE_MEMBER_COUNT')
        need(all(m.isfile() and Path(m.name).name == m.name and re.fullmatch('[A-Za-z0-9_.-]+', m.name)
                 and m.name not in ('received.tar', 'evidence') and 0 < m.size <= 1024**3 for m in members), 'PACKAGE_MEMBER_DENIED')
        entry = source.getmember('package.json')
        need(entry.size <= 65536, 'PACKAGE_MANIFEST_SIZE')
        raw = source.extractfile(entry).read()
        need(hashlib.sha256(raw).hexdigest() == binding['manifestSha256'], 'PACKAGE_MANIFEST_HASH')
        manifest = json.loads(raw)
        need(manifest['runId'] == binding['runId'] and
             {m.name for m in members} == (set(manifest['files']) - {IMAGE_NAME}) | {'package.json'}, 'PACKAGE_MANIFEST_MEMBERS')
        for member in members:
            expected = manifest['files'].get(member.name, {'bytes': len(raw), 'sha256': binding['manifestSha256']})
            need(member.size == expected['bytes'], 'PACKAGE_FILE_SIZE')
            check = hashlib.sha256()
            with source.extractfile(member) as incoming, (root / member.name).open('xb') as out:
                while block := incoming.read(1024 * 1024):
                    out.write(block)
                    check.update(block)
                out.flush()
                os.fsync(out.fileno())
            need(check.hexdigest() == expected['sha256'], 'PACKAGE_FILE_HASH')
    reuse_images(root, manifest['files'][IMAGE_NAME])
    print(json.dumps({'status': 'PACKAGE_RECEIVED', 'runId': binding['runId'], 'sha256': binding['manifestSha256'],
                      'imagesReusedFromConsumedPreparation': True, 'imageBytesTransferred': 0,
                      'productionRuntimeMutationPerformed': False, 'credentialsRead': False}), flush=True)
