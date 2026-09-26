"""Offline M2 owner package build; no SSH, private keys or runtime execution."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid

sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
REPO=HERE.parents[1]
sys.path.insert(0,str(HERE))
sys.path.insert(1,str(REPO/'scripts/m1-assisted'))
from common import canonical,digest,exclusive,load,need,value_sha
import sealed_programs as sealed

SEALED='b8f28c32e050176ddb2d13264ee6911bf51b808f'
OWN=('remote_release.py','owner_release.py','download_images.py','registry_settlement.py','image_binding.py','sealed_programs.py')
REUSE=('common.py','isolated_restore.py','qualified_images.py','storage_probe.ps1','download_images.py',
       'binding.json','remote_release.py','owner_release.py','receive_package.py')
OUTPUT=Path(r'C:\Users\Utente\Desktop\CRM\artifacts\M2-rilascio-R26')
ARCHIVE_SHA='3e0dd8b4ff7cd0d82fde2f7445334e1f764bd11042154f70905a171747cd7dc2'


def git(*args):
    return subprocess.check_output(['git',*args],cwd=REPO,timeout=90)


def source(path,ref='HEAD'):
    return git('show',ref+':'+path)


def inventory():
    values={'scripts/m2-release/'+n:source('scripts/m2-release/'+n) for n in (*OWN,'package_builder.py')}
    values.update({'sealed/scripts/m1-assisted/'+n:source('scripts/m1-assisted/'+n,SEALED) for n in REUSE})
    values.update({'sealed/'+n:source(n,SEALED) for n in ('scripts/pr140/owner_backup46.py','scripts/m1-executor/observe_m1.py')})
    return values


def delta():
    return value_sha({p:hashlib.sha256(v).hexdigest() for p,v in inventory().items()})


def render(run_id,reader=source):
    old=lambda name:reader('scripts/m1-assisted/'+name,SEALED)
    result={name:reader('scripts/m2-release/'+name) for name in OWN}
    result.update({name:old(name) for name in ('common.py','isolated_restore.py','qualified_images.py','storage_probe.ps1')})
    result['common.py']=result['common.py'].replace(b'FAI_M1_ASSISTED_STAGE_R21',b'FAI_M2_ASSISTED_STAGE_R26')
    result['transition_base.py']=sealed.transition(old('remote_release.py'))
    result['owner_base.py']=sealed.owner_base(old('owner_release.py'))
    result['transport_base.py']=old('download_images.py')
    result['receive_package.py']=sealed.receiver(old('receive_package.py'))
    for role in ('before','after'):
        result['backup48_'+role+'.py']=sealed.backup(reader('scripts/pr140/owner_backup46.py',SEALED),role,run_id)
        result['observe48_'+role+'.py']=sealed.observer(reader('scripts/m1-executor/observe_m1.py',SEALED),role,run_id)
    b=json.loads(old('binding.json'))
    b.update(protocol='FAI_M2_SCHEMA48_BINDING_R26',candidate=sealed.M2,candidateTree=sealed.M2_TREE,
        sourceCommit=sealed.M1,sourceTree=sealed.M1_TREE,
        candidateImage='sha256:01c7a81a6c294651066765413243f465ce4b76f05b60f266b706559f917e7d19',
        returnImage='sha256:42ec4e5431b77482ffffd00a2896356c94fd700aa1c5dc9bc60c500abd1b61d1',
        candidateCiImage='sha256:97c04ee3a04be24d66a773256a3585ebb81b7c1d189143a2dc71900532675c22',
        returnCiImage='sha256:8a31a9968090e5b2bc1a29259ea033627625a93b2f0edb9eda2396ec9cabba38',imageArchiveSha256=ARCHIVE_SHA)
    b['target'].update(appId='6ae0d2ac95dddc8d80859d32a68ef656bb578e1ff332a56dde6bacb70c05692c',
        appImage='sha256:06fe7f94dfd274eba7c24bd9e9cc102631ebc600f4a66e6066b708e846941bf9')
    for name in ('backupProgramSha256','candidateConfigDigest','returnConfigDigest','ledger46','consumedBackupStop'):
        b.pop(name,None)
    result['binding.json']=canonical(b)+b'\n'
    for name,data in result.items():
        if name.endswith('.py'): compile(data,name,'exec')
    return result


def build(review_path,owner_path,bundle_path):
    review=load(review_path)
    need(review['status']=='PASS_FOR_MERGE' and review['candidate']==sealed.M2 and
         review['deltaSha256']==delta() and review['ciStatus']=='success' and
         review['ciHead']==review['reviewedHead']==git('rev-parse','HEAD').decode().strip(),'EXACT_DELTA_REVIEW_REQUIRED')
    need(review['softwareHead']==sealed.M2 and review['softwareStatus']=='PASS_FOR_MERGE' and
         review['softwareCiStatus']=='success' and review['softwareMerged'] is True,'SOFTWARE_QUALIFICATION_REQUIRED')
    need(not git('status','--porcelain=v1','--untracked-files=no').strip(),'BUILD_TRACKED_DIRTY')
    owner=load(owner_path)
    need(re.fullmatch(r'S-1-5-21-(?:[0-9]+-){3}[0-9]+',owner['ownerSid']) and set(owner['drives'])=={'C','F'} and
         owner['drives']['C']['disk']!=owner['drives']['F']['disk'],'OWNER_PHYSICAL_BINDING')
    need(git('bundle','list-heads',str(bundle_path)).decode().split()==[sealed.M2,'refs/heads/codex/m2-runtime-candidate-r26'],'SOURCE_BUNDLE_REFERENCE')
    subprocess.run(['git','bundle','verify',str(bundle_path)],cwd=REPO,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
    run,post=uuid.uuid4().hex,uuid.uuid4().hex
    OUTPUT.mkdir(exist_ok=True)
    output=OUTPUT/('M2-'+run)
    output.mkdir()
    files={name:exclusive(output/name,data) for name,data in render(run).items()}
    for name,path in [('owner-binding.json',owner_path),('review.json',review_path),('candidate.bundle',bundle_path)]:
        with Path(path).open('rb') as incoming,(output/name).open('xb') as outgoing: shutil.copyfileobj(incoming,outgoing)
        files[name]={'bytes':(output/name).stat().st_size,'sha256':digest(output/name)}
    programs={'ssh':Path(r'C:\Windows\System32\OpenSSH\ssh.exe'),
        'powershell':Path(r'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'),
        'python':Path(r'C:\Users\Utente\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'),
        'gh':Path(r'C:\Program Files\GitHub CLI\gh.exe')}
    manifest={'protocol':'FAI_M2_OWNER_PACKAGE_R26','runId':run,'postRunId':post,'candidate':sealed.M2,
        'deltaSha256':delta(),'reviewedHead':review['reviewedHead'],'files':files,
        'imageArchiveSha256':ARCHIVE_SHA,'programs':{n:digest(p) for n,p in programs.items()},
        'authorityReference':'https://chatgpt.com/codex/threads/01a0c20b-b096-78a3-b6f6-db9153b914fe',
        'migrations':[],'configurationChanged':False,'plannedSessionRevocation':True,'autonomyComponentRequired':False}
    exclusive(output/'package.json',manifest)
    launcher="""$ErrorActionPreference = 'Stop'
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
    exclusive(output/'AVVIA-M2.ps1',launcher.encode('utf-8-sig'))
    print(canonical({'status':'OWNER_PACKAGE_READY','path':str(output),'manifestSha256':digest(output/'package.json'),
                     'launcherSha256':digest(output/'AVVIA-M2.ps1'),'productionOperationsExecuted':False}).decode())


if __name__=='__main__':
    if sys.argv[1:]==['--delta']: print(delta())
    else:
        need(len(sys.argv)==4,'REVIEW_OWNER_BINDING_AND_SOURCE_BUNDLE_REQUIRED')
        build(*map(Path,sys.argv[1:]))
