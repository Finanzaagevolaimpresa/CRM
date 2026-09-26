"""Create a new owner package only from a qualified delta and private metadata.

This local build does not connect to production or run the package.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid

sys.dont_write_bytecode = True
SOURCE = Path(__file__).resolve().parent
sys.path.insert(0, str(SOURCE))
from common import Stop, canonical, digest, exclusive, load, need, value_sha

REPO = SOURCE.parents[1]
OUTPUT_ROOT = Path(r'C:\Users\Utente\Desktop\CRM\artifacts\M1-assistito-R20')
CANDIDATE = 'fb645e014653ee87dc64f2439970967192f91b62'
INPUTS = ('binding.json', 'common.py', 'isolated_restore.py',
          'remote_release.py', 'owner_release.py', 'receive_package.py', 'storage_probe.ps1', 'qualified_images.py')
CANONICAL = {'owner_backup46.py': REPO / 'scripts/pr140/owner_backup46.py',
             'observe_m1.py': REPO / 'scripts/m1-executor/observe_m1.py'}


def identity(path):
    return {'sha256': digest(path), 'bytes': path.stat().st_size}


def repository_bytes(path):
    relative = path.relative_to(REPO).as_posix()
    return subprocess.check_output(['git', 'show', 'HEAD:' + relative], cwd=REPO)


def delta():
    paths = {name: SOURCE / name for name in INPUTS} | CANONICAL
    return value_sha({name: {'sha256': hashlib.sha256(repository_bytes(path)).hexdigest(),
                            'bytes': len(repository_bytes(path))} for name, path in paths.items()})


def build(review_file, owner_binding_file, bundle_file):
    review, owner = load(review_file), load(owner_binding_file)
    need(review['status'] == 'PASS_FOR_MERGE' and review['deltaSha256'] == delta() and review['candidate'] == CANDIDATE,
         'EXACT_DELTA_REVIEW_REQUIRED')
    need(review['ciStatus'] == 'success' and review['ciHead'] == review['reviewedHead'], 'EXACT_HEAD_CI_REQUIRED')
    need(subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO).decode().strip() == review['reviewedHead'], 'BUILD_HEAD_NOT_REVIEWED')
    need(not subprocess.check_output(['git','status','--porcelain=v1','--untracked-files=no'],cwd=REPO).strip(), 'BUILD_TRACKED_DIRTY')
    need(re.fullmatch(r'S-1-5-21-(?:[0-9]+-){3}[0-9]+', owner['ownerSid']), 'OWNER_SID_BINDING')
    need(set(owner['drives']) == {'C', 'F'} and owner['drives']['C']['disk'] != owner['drives']['F']['disk'], 'APPROVED_DISKS_BINDING')
    branch = 'codex/m1-runtime-candidate-r21'
    checked = subprocess.run(['git', 'bundle', 'list-heads', str(bundle_file)], cwd=REPO,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=60)
    need(checked.stdout.decode().split() == [CANDIDATE, 'refs/heads/' + branch], 'SOURCE_BUNDLE_REFERENCE')
    subprocess.run(['git', 'bundle', 'verify', str(bundle_file)], cwd=REPO,
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=60)
    run_id = uuid.uuid4().hex
    output = OUTPUT_ROOT / ('M1-R21-' + run_id)
    output.mkdir()
    sources = {name: SOURCE / name for name in INPUTS} | CANONICAL | {
        'owner-binding.json': owner_binding_file, 'review.json': review_file, 'candidate.bundle': bundle_file}
    files = {}
    for name, source in sources.items():
        if name in INPUTS or name in CANONICAL:
            with (output / name).open('xb') as outgoing:
                outgoing.write(repository_bytes(source))
        else:
            with Path(source).open('rb') as incoming, (output / name).open('xb') as outgoing:
                shutil.copyfileobj(incoming, outgoing)
        files[name] = identity(output / name)
    files['release-images.tar.gz'] = {'bytes': 543331793,
        'sha256': 'fadbed9be809e18e6d6afc4b123532edf7d0115a86e52e2e1e7bce16e245b2e7'}
    programs = {'ssh': Path(r'C:\Windows\System32\OpenSSH\ssh.exe'),
                'powershell': Path(r'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'),
                'python': Path(r'C:\Users\Utente\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe')}
    manifest = {'protocol':'FAI_M1_OWNER_PACKAGE_R21', 'runId':run_id, 'candidate':CANDIDATE,
                'deltaSha256':delta(), 'reviewedHead':review['reviewedHead'],
                'files':files, 'programs':{name:digest(path) for name,path in programs.items()},
                'authorityReference':'https://chatgpt.com/codex/threads/01a0c20b-b096-78a3-b6f6-db9153b914fe',
                'keyProvisioningPreauthorized':False, 'autonomyComponentRequired':False}
    exclusive(output / 'package.json', manifest)
    # The launcher validates every package byte before the Python program starts.
    manifest_hash = digest(output / 'package.json')
    script_hash = files['owner_release.py']['sha256']
    launcher = """$ErrorActionPreference = 'Stop'
$base = $PSScriptRoot
$manifestPath = Join-Path $base 'package.json'
if ((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash -ne '%s') { throw 'PACKAGE_MANIFEST_CHANGED' }
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ((Get-FileHash -LiteralPath '%s' -Algorithm SHA256).Hash -ne $manifest.programs.python) { throw 'LOCAL_PYTHON_CHANGED' }
foreach ($file in $manifest.files.PSObject.Properties) {
    if ($file.Name -eq 'release-images.tar.gz') { continue }
    if ([IO.Path]::GetFileName($file.Name) -ne $file.Name) { throw 'PACKAGE_PATH_INVALID' }
    if ((Get-FileHash -LiteralPath (Join-Path $base $file.Name) -Algorithm SHA256).Hash -ne $file.Value.sha256) { throw 'PACKAGE_FILE_CHANGED' }
}
& '%s' -I -B -S (Join-Path $base 'owner_release.py')
exit $LASTEXITCODE
""" % (manifest_hash, str(programs['python']), str(programs['python']))
    exclusive(output / 'AVVIA-M1.ps1', launcher.encode('utf-8-sig'))
    batch = '@echo off\r\n"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0AVVIA-M1.ps1"\r\necho Esito: %errorlevel%. Conservare le ricevute.\r\npause\r\n'
    exclusive(output / 'AVVIA-M1.cmd', batch.encode('ascii'))
    result = {'status':'OWNER_PACKAGE_READY', 'path':str(output), 'manifestSha256':manifest_hash,
              'entryScriptSha256':script_hash, 'launcherSha256':digest(output / 'AVVIA-M1.ps1'),
              'runId':run_id, 'productionOperationsExecuted':False}
    print(canonical(result).decode())
    return result


if __name__ == '__main__':
    if sys.argv[1:] == ['--delta']:
        print(delta())
    else:
        need(len(sys.argv) == 4, 'REVIEW_OWNER_BINDING_AND_SOURCE_BUNDLE_REQUIRED')
        build(*map(Path, sys.argv[1:]))
