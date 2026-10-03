"""One normal owner launch, fixed M2 sequence; repeat means read-only status."""
import base64
import os
from pathlib import Path
import re
import shutil
import sys
import tarfile
import time

sys.dont_write_bytecode = True
sys.path.insert(0,str(Path(__file__).resolve().parent))
import owner_base as base
from common import Stop, canonical, decode, digest, exclusive, load, need, private, utc
from download_images import acquire
from completed_release import verify_local_copies

ROOT = Path(__file__).resolve().parent
base.ROOT = ROOT
TIMES = {'prepare':600,'protect':900,'copies-backup':90,'recover':900,'migrate':180,
    'deploy':960,'postcheck':180,'postbackup':1800,'postprotect':900,'copies-postbackup':90,'final':210,
    'status':180,'fetch-backup':600,'fetch-postbackup':600}
base.TIMES = TIMES


def command(manifest,stage):
    need(stage in TIMES and re.fullmatch('[a-f0-9]{32}',manifest['runId']),'FIXED_OPERATION_REQUIRED')
    remote = '/home/faiadmin/.local/share/fai-crm-releases/m2-release-r26-'+manifest['runId']
    return base.SSH_ARGS+['python3 -I -B -S '+remote+'/remote_release.py '+stage]


base.command = command
stage_call = base.stage_call


def upload(manifest,image):
    archive = ROOT/'owner-transfer.tar'
    need(not archive.exists(),'TRANSFER_ALREADY_STARTED_RECONCILE_ONLY')
    with tarfile.open(archive,'x') as target:
        for name in [*manifest['files'],'package.json']:
            source = private(ROOT/name)
            info = target.gettarinfo(str(source),arcname=name)
            info.uid=info.gid=1000
            info.uname=info.gname=''
            info.mode=0o600
            with source.open('rb') as stream: target.addfile(info,stream)
    packet = {'runId':manifest['runId'],'manifestSha256':digest(ROOT/'package.json'),
              'archiveSha256':digest(archive),'archiveBytes':archive.stat().st_size,'image':image}
    source = (ROOT/'receive_package.py').read_text(encoding='utf-8')+'\nreceive('+repr(packet)+')\n'
    encoded = base64.b64encode(source.encode()).decode('ascii')
    remote = 'python3 -I -B -S -c "import base64;exec(base64.b64decode(\''+encoded+'\'))"'
    with archive.open('rb') as incoming:
        code,out,error = base.call(base.SSH_ARGS+[remote],600,source=incoming)
    result = None
    try: result=decode(out)
    except (ValueError,Stop): pass
    exclusive(ROOT/'upload.json',result or {'status':'STOP','code':base.ssh_error(error),'sshExit':code})
    need(code == 0 and result and result['status'] == 'PACKAGE_RECEIVED','PACKAGE_UPLOAD_NOT_CONFIRMED')


def copies(manifest,source,label):
    need(label in ('backup','postbackup'),'COPY_KIND')
    devices = base.storage()
    folder='CRM-BACKUP-M2-SCHEMA48-R26-'+manifest['runId']
    roots={'C':Path(r'C:\Users\Utente\Desktop\CRM\storage\private')/folder,'F':Path('F:/')/('FAI-'+folder)}
    name='backup48.bundle.tar' if label=='backup' else 'post-backup48.bundle.tar'
    result={}
    for drive,root in roots.items():
        private(root.parent,directory=True)
        root.mkdir()
        private(root,directory=True)
        with (root/name).open('xb') as output:
            if drive=='C': stage_call(manifest,'fetch-'+label,output=output)
            else:
                with private(roots['C']/name).open('rb') as incoming: shutil.copyfileobj(incoming,output,1024*1024)
            output.flush(); os.fsync(output.fileno())
        path=private(root/name)
        need(path.stat().st_size==source['bundle_bytes'] and digest(path)==source['bundle_sha256'],'CIPHERTEXT_COPY_HASH')
        after=base.storage()
        need(after[drive]['disk']==devices[drive]['disk'] and after[drive]['partition']==devices[drive]['partition'],'COPY_DESTINATION_CHANGED')
        result[drive]={'path':str(path),'bytes':path.stat().st_size,'sha256':digest(path),'physicalIdentityVerified':True,
                       'physicalDisk':devices[drive]['disk'],'readbackVerified':True}
    exclusive(ROOT/('local-copies-'+label+'.json'),result)
    return result


def main():
    manifest=load(ROOT/'package.json')
    base.admit(manifest)
    if (ROOT/'owner-started.json').exists():
        if (ROOT/'upload.json').exists(): stage_call(manifest,'status')
        print('AVVIO GIA REGISTRATO: sola riconciliazione; nessuna fase ripetuta.',flush=True)
        return 0
    exclusive(ROOT/'owner-started.json',{'runId':manifest['runId'],'utc':utc(),'ownerSidVerified':True})
    try:
        print('1/6 — Verifica dei backup gia completati e delle copie fisiche C:/F:.',flush=True)
        devices = base.storage()
        proof, prior_copies = verify_local_copies(devices)
        after = base.storage()
        need(all(after[d][k] == devices[d][k] for d in ('C','F') for k in ('disk','partition')),
             'COMPLETED_COPY_DESTINATIONS_CHANGED')
        exclusive(ROOT/'completed-local-verification.json',proof | {'copies':prior_copies})
        print('2/6 — Riuso immagini e trasferimento del solo pacchetto di ripresa.',flush=True)
        image=acquire(ROOT,manifest)
        upload(manifest,image)
        print('3/6 — Riconciliazione in lettura: STOP precedente, schema48, recupero e piano completo.',flush=True)
        stage_call(manifest,'prepare',{'copies':prior_copies})
        print('4/6 — Deploy M2 e controllo salute; nessuna migrazione.',flush=True)
        stage_call(manifest,'deploy')
        stage_call(manifest,'postcheck')
        print('5/6 — Backup post-deploy distinto, cifratura e due copie C:/F:.',flush=True)
        stage_call(manifest,'postbackup')
        protected=stage_call(manifest,'postprotect')
        stage_call(manifest,'copies-postbackup',{'copies':copies(manifest,protected,'postbackup')})
        print('6/6 — Verifica finale M2 e ricevute.',flush=True)
        result=stage_call(manifest,'final')
        exclusive(ROOT/'ESITO-M2.json',result)
        print('RILASCIO TECNICO M2 VERIFICATO. Codex acquisisce le ricevute e completa la prova d uso.',flush=True)
        return 0
    except BaseException as exc:
        result={'protocol':'FAI_M2_OWNER_STOP_R26','status':'STOP','utc':utc(),
                'code':getattr(exc,'code','LOCAL_FAILURE_REDACTED'),
                'details':getattr(exc,'details',getattr(exc,'detail',{})),
                'historicalAttemptsRepeated':False,'autonomyQualified':False}
        exclusive(ROOT/'ESITO-M2.json',result)
        print(canonical(result).decode(),flush=True)
        if (ROOT/'upload.json').exists():
            try: stage_call(manifest,'status')
            except BaseException: print('Sola riconciliazione non disponibile.',flush=True)
        print('STOP: ricevute conservate. Non ripetere il rilascio; Codex riconcilia.',flush=True)
        return 2


if __name__=='__main__':
    try: raise SystemExit(main())
    except Stop as exc:
        print(canonical({'status':'LOCAL_ADMISSION_STOP','code':exc.code,'details':exc.details}).decode())
        raise SystemExit(2)
