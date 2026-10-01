"""CI-only exact saved R40/R37 images: fail, recover, enforce access, resume.

No image build. The original artifact checksums and image labels are mandatory.
All writes belong to the sentinel-bound ephemeral CI database.
"""
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parent))
from generate import pinned, change, CANDIDATE, CANDIDATE_TREE

if os.environ.get('CI') != 'true' or os.environ.get('GITHUB_ACTIONS') != 'true' or socket.gethostname() == 'fai-crm-prod-02':
    raise SystemExit('CI_SYNTHETIC_ONLY')
raw=pinned('scripts/pr140/qualify-release.sh').decode()
raw=change(raw,'head="$(git rev-parse HEAD)"', 'head='+CANDIDATE)
raw=change(raw,'tree="$(git rev-parse HEAD^{tree})"', 'tree='+CANDIDATE_TREE)
raw=change(raw,'recovery_head=73432464d741164fd76690bbdef65b17d626e6e9',
           'recovery_head=8e3874a304b1cb2281d59146448bcdf121afe0d1')
raw=change(raw,'recovery_tree=5ee2c7819c31f772fc04bc4a28784ab7b005af25',
           'recovery_tree=2e9fb13313a2287918d4776918d9f7df530649a1')
raw=change(raw,'recovery_image="fai-crm:r05-recovery-$recovery_head"',
           'recovery_image="fai-crm:r05-candidate-$recovery_head"')
a=raw.index('docker build -f "$source_candidate/Dockerfile.prod.example"')
b=raw.index('candidate_id="$(docker image inspect',a)
raw=raw[:a]+'''printf '%s  %s\\n' d81cd3070d0bc3a7dbd4017a398353ea7ad61dcf6dcb43226f3083e96977c50e qualified-r40/release-images.tar.gz | sha256sum -c -
printf '%s  %s\\n' 83010bcbb15ce93af213a382ee25e94c7b20511e9ec8072cbefe34063ca515d6 qualified-r37/release-images.tar.gz | sha256sum -c -
docker load --input qualified-r40/release-images.tar.gz
docker load --input qualified-r37/release-images.tar.gz
''' + raw[b:]
raw=raw.replace('CI_SCHEMA49_M1_APPLICATION_RETURN_PASS','CI_SCHEMA49_R37_APPLICATION_RETURN_PASS')
raw=raw.replace('"m4AvailableDuringM1Return":false','"m4AvailableDuringReturn":true,"r37ReturnSource":true,"imagesRebuilt":false')
raw=change(raw, 'run_browser recovery-m1 tests/pr140-release/playwright.config.ts m1-recovery.spec.ts 2',
           'run_browser recovery-m1 tests/pr140-release/playwright.config.ts m1-recovery.spec.ts 2\nrun_browser recovery-m4 scripts/integrated-release/return-playwright.config.ts return-availability.spec.ts 1')
# Config digests remain stable across classic Docker and containerd image stores.
raw=change(raw,' "$head" "$tree" "$candidate_id" "$recovery_head" "$recovery_tree" "$recovery_id" "$bundle_sha" "$document_before"',
 ''' "$head" "$tree" sha256:c1db10f9ee503a487e2191775b27ffba498e3e633d8ae908a728aca51599bbd5 "$recovery_head" "$recovery_tree" sha256:4f19689454481bb8276767d46d1affa527bbd7e94e341330c608b312dd1acc96 "$bundle_sha" "$document_before"''')
with tempfile.TemporaryDirectory(prefix='r40-pair-',dir=os.environ['RUNNER_TEMP']) as folder:
    path=Path(folder)/'qualify.sh'
    path.write_text(raw,encoding='utf-8',newline='\n')
    subprocess.run(['bash','-n',str(path)],check=True)
    subprocess.run(['bash',str(path)],check=True)
