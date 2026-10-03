"""Build the M5-only owner package after exact delta review; never execute it."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0,str(HERE))
sys.path.insert(1,str(REPO/'scripts/m1-assisted'))
from common import canonical, digest, exclusive, load, need, value_sha
from generate import render, inventory, CANDIDATE, CANDIDATE_TREE

OUTPUT = Path(r'C:\Users\Utente\Desktop\CRM\artifacts\M5-rilascio-R36')


def git(*args):
    return subprocess.check_output(['git',*args],cwd=REPO,timeout=90)


def source_hashes(folder=HERE):
    files = {}
    for p in folder.iterdir():
        if p.suffix not in ('.py','.json'):continue
        raw = p.read_bytes()
        need(b'\r' not in raw,'M5_SOURCE_LF_REQUIRED',file=p.name)
        files[p.name] = hashlib.sha256(raw).hexdigest()
    return files


def delta():
    return value_sha({'sources':source_hashes(),'generated':inventory()})


def build(review_path,owner_path,bundle_path):
    review = load(review_path)
    head = git('rev-parse','HEAD').decode().strip()
    need(review['status'] == 'PASS_FOR_MERGE' and review['candidate'] == CANDIDATE and
         review['deltaSha256'] == delta() and review['ciStatus'] == 'success' and
         review['ciHead'] == review['reviewedHead'] == head,'EXACT_DELTA_REVIEW_REQUIRED')
    need(review['softwareHead'] == CANDIDATE and review['softwareStatus'] == 'PASS_FOR_MERGE' and
         review['softwareCiStatus'] == 'success' and review['softwareMerged'] is True,'SOFTWARE_QUALIFICATION_REQUIRED')
    need(review['recoveryScope'] == 'NEW_PLAINTEXT_DATABASE_AND_DOCUMENT_SET','RECOVERY_SCOPE')
    need(not git('status','--porcelain=v1','--untracked-files=no').strip(),'BUILD_TRACKED_DIRTY')
    owner = load(owner_path)
    need(re.fullmatch(r'S-1-5-21-(?:[0-9]+-){3}[0-9]+',owner['ownerSid']) and set(owner['drives']) == {'C','F'} and
         owner['drives']['C']['disk'] != owner['drives']['F']['disk'],'OWNER_PHYSICAL_BINDING')
    need(git('bundle','list-heads',str(bundle_path)).decode().split() == [CANDIDATE,'refs/heads/codex/m5-runtime-candidate-r36'],'SOURCE_BUNDLE_REFERENCE')
    subprocess.run(['git','bundle','verify',str(bundle_path)],cwd=REPO,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
    run,post = uuid.uuid4().hex,uuid.uuid4().hex
    need(run != post,'RUN_COLLISION')
    OUTPUT.mkdir(exist_ok=True)
    output = OUTPUT/('M5-'+run)
    output.mkdir()
    files = {name:exclusive(output/name,data) for name,data in render(run).items()}
    # Import only generated local validators, not a production entry point.
    sys.path.insert(0,str(output))
    from release_evidence import details, validate
    binding = load(output/'binding.json')
    review = review | details(binding,output/'qualification.json')
    validate(review,binding)
    for name,path in [('owner-binding.json',owner_path),('candidate.bundle',bundle_path)]:
        with Path(path).open('rb') as incoming,(output/name).open('xb') as outgoing: shutil.copyfileobj(incoming,outgoing)
        files[name] = {'bytes':(output/name).stat().st_size,'sha256':digest(output/name)}
    files['review.json'] = exclusive(output/'review.json',review)
    programs = {'ssh':Path(r'C:\Windows\System32\OpenSSH\ssh.exe'),
        'powershell':Path(r'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'),
        'python':Path(r'C:\Users\Utente\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'),
        'gh':Path(r'C:\Program Files\GitHub CLI\gh.exe')}
    manifest = {'protocol':'FAI_M5_OWNER_PACKAGE_R36','runId':run,'postRunId':post,'candidate':CANDIDATE,
        'candidateTree':CANDIDATE_TREE,'deltaSha256':delta(),'reviewedHead':review['reviewedHead'],'files':files,
        'imageArchiveSha256':binding['imageArchiveSha256'],'programs':{name:digest(path) for name,path in programs.items()},
        'authorityReference':'https://chatgpt.com/codex/threads/01a0c20b-b096-78a3-b6f6-db9153b914fe',
        'migrations':[],'configurationChanged':False,'plannedSessionRevocation':True,'autonomyComponentRequired':False,
        'historicalAttemptsReplayed':False,'providerActivation':False}
    exclusive(output/'package.json',manifest)
    launcher = """$ErrorActionPreference = 'Stop'
$base = $PSScriptRoot
$manifestPath = Join-Path $base 'package.json'
if ((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash -ne '%s') { throw 'PACKAGE_MANIFEST_CHANGED' }
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ((Get-FileHash -LiteralPath '%s' -Algorithm SHA256).Hash -ne $manifest.programs.python) { throw 'LOCAL_PYTHON_CHANGED' }
foreach ($file in $manifest.files.PSObject.Properties) {
    if ([IO.Path]::GetFileName($file.Name) -ne $file.Name) { throw 'PACKAGE_PATH_INVALID' }
    if ((Get-FileHash -LiteralPath (Join-Path $base $file.Name) -Algorithm SHA256).Hash -ne $file.Value.sha256) { throw 'PACKAGE_FILE_CHANGED' }
}
& '%s' -I -B -S (Join-Path $base 'owner_release.py')
exit $LASTEXITCODE
""" % (digest(output/'package.json'),str(programs['python']),str(programs['python']))
    exclusive(output/'AVVIA-M5.ps1',launcher.encode('utf-8-sig'))
    print(canonical({'status':'OWNER_PACKAGE_READY','path':str(output),'manifestSha256':digest(output/'package.json'),
        'launcherSha256':digest(output/'AVVIA-M5.ps1'),'productionOperationsExecuted':False}).decode())


if __name__ == '__main__':
    if sys.argv[1:] == ['--delta']: print(delta())
    else:
        need(len(sys.argv) == 4,'REVIEW_OWNER_BINDING_AND_SOURCE_BUNDLE_REQUIRED')
        build(*map(Path,sys.argv[1:]))
