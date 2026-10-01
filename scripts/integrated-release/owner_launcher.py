"""Owner profile entry point. No execution-policy or credential changes."""
import hashlib
import json
from pathlib import Path
import runpy
import sys

ROOT = Path(__file__).resolve().parent


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream,'sha256').hexdigest()


def main():
    path = ROOT/'package.json'
    if digest(path) != 'EXPECTED_MANIFEST_SHA256':
        raise SystemExit('PACKAGE_MANIFEST_CHANGED')
    manifest = json.loads(path.read_bytes())
    if digest(Path(sys.executable)) != manifest['programs']['python']:
        raise SystemExit('LOCAL_PYTHON_CHANGED')
    for name,entry in manifest['files'].items():
        if Path(name).name != name or (ROOT/name).is_symlink():
            raise SystemExit('PACKAGE_PATH_INVALID')
        if digest(ROOT/name) != entry['sha256'] or (ROOT/name).stat().st_size != entry['bytes']:
            raise SystemExit('PACKAGE_FILE_CHANGED')
    sys.path.insert(0,str(ROOT))
    sys.argv = [str(ROOT/'owner_release.py')]
    runpy.run_path(str(ROOT/'owner_release.py'),run_name='__main__')


if __name__ == '__main__':
    main()
