"""Run the qualified M2 Docker/age/schema48 harness on the exact M3 images."""
import os
from pathlib import Path
import socket
import sys
import tempfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0,str(HERE))
from generate import source, render, M2_TOOLS

if not (os.environ.get('CI') == os.environ.get('GITHUB_ACTIONS') == 'true'
        and socket.gethostname() != 'fai-crm-prod-02'):
    raise SystemExit('CI_SYNTHETIC_ONLY')

with tempfile.TemporaryDirectory(prefix='m3-qualified-helpers-',dir=REPO) as folder:
    root = Path(folder)
    root.chmod(0o700)
    for name,data in render('c'*32).items():
        (root/name).write_bytes(data)
    for name in ('qualify_generated_backup.py','qualify_protection.py'):
        (root/name).write_bytes(source('scripts/m2-release/'+name,M2_TOOLS))
    sys.path.insert(1,str(root))
    raw = source('scripts/m2-release/qualify_delta.py',M2_TOOLS).decode()
    raw = raw.replace('m2-release-ci-receipt.json','m3-release-ci-receipt.json').replace('FAI_M2_RELEASE_DELTA_QUALIFICATION_R26','FAI_M3_RELEASE_DELTA_QUALIFICATION_R32')
    # __file__ remains this wrapper: the reused harness resolves the same repository.
    exec(compile(raw,'pinned_m2_qualification_for_m3.py','exec'),globals())
