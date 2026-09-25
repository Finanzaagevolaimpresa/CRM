"""Fixed owner upload bootstrap. Only package bytes; no runtime mutation or credentials."""
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import sys
import tarfile


def receive(binding):
    def need(ok, code):
        if not ok:
            raise RuntimeError(code)
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
        need(manifest['runId'] == binding['runId'] and {m.name for m in members} == set(manifest['files']) | {'package.json'}, 'PACKAGE_MANIFEST_MEMBERS')
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
    print(json.dumps({'status': 'PACKAGE_RECEIVED', 'runId': binding['runId'], 'sha256': binding['manifestSha256'],
                      'productionRuntimeMutationPerformed': False, 'credentialsRead': False}), flush=True)
