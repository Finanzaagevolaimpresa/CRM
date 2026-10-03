"""Create reviewable owner launchers; never install or connect while building."""
import base64
import hashlib
import json
from pathlib import Path
import sys

SOURCE = Path(__file__).resolve().parent
PYTHON = r'C:\Users\Utente\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
PYTHON_SHA = '372c2eae555b344520bf147be0096e009069aeca4e7f78d6aecea6d53158056a'

OWNER = r'''import hashlib, importlib.util, json, re, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent
PACKAGE=Path(r'C:\Users\Utente\Desktop\CRM\artifacts\M1-assistito-R20\M1-R21-e67bea4040fc4aeb86a0c98ac6178e7e')
def need(v,c):
 if not v: raise ValueError(c)
def mod(name,sha):
 p=PACKAGE/(name+'.py')
 need(hashlib.sha256(p.read_bytes()).hexdigest()==sha,'PROGRAM_HASH_CHANGED')
 spec=importlib.util.spec_from_file_location(name,p)
 m=importlib.util.module_from_spec(spec);sys.modules[name]=m;spec.loader.exec_module(m);return m
out=ROOT/('ESITO-'+MODE.upper()+'.json')
need(not out.exists(),'RECEIPT_EXISTS_DO_NOT_REPEAT')
result={'protocol':'FAI_M1_OWNER_DELEGATION_R23','mode':MODE,'credentialValuesExported':False,'productionMutationPerformed':False}
stage='LOCAL_ADMISSION'
try:
 need(len(sys.argv)==1,'NO_ARGUMENTS_ALLOWED')
 need(hashlib.sha256((PACKAGE/'package.json').read_bytes()).hexdigest()=='961e6d7f6f1d1275a8d472eed8b2bc5dc14adecd25b304f4dad5b475985088c3','OWNER_BINDING_CHANGED')
 c=mod('common','b53f7670f3e4e2aad58c1ad4eb9999cc429fb40d2ce61b5f188742089bda3b19')
 owner=mod('owner_release','20f22730dda3e1982d9dc7e2ddc589a94ff6d64bf136ac9103366f44f47d45e2')
 owner.admit(c.load(PACKAGE/'package.json'))
 data=(ROOT/(MODE+'.bundle.py')).read_bytes()
 need(hashlib.sha256(data).hexdigest()==BUNDLE_SHA,'INSTALLER_HASH_CHANGED')
 stage='OWNER_SUDO_INSTALL' if MODE=='install' else 'OWNER_SUDO_UNINSTALL'
 print('Collegamento proprietario e delega della sola lettura; massimo 75 secondi.',flush=True)
 rc,stdout,stderr=owner.call(owner.SSH_ARGS+['/usr/bin/sudo -n /usr/bin/python3.14 -I -B -S -'],65,data=data)
 result.update(sshExit=rc,stderrBytes=len(stderr),stderrSha256=hashlib.sha256(stderr).hexdigest())
 if stdout:
  remote=c.decode(stdout)
  need(remote.get('protocol')=='FAI_M1_READ_DELEGATION_INSTALL_R23','REMOTE_RECEIPT_INVALID')
  result['receipt']=remote
 need(rc==0,'OWNER_SUDO_NONINTERACTIVE_UNAVAILABLE' if b'password' in stderr.lower() else 'OWNER_INSTALLER_STOP')
 expected='FIXED_READ_DELEGATION_INSTALLED' if MODE=='install' else 'FIXED_READ_DELEGATION_REMOVED'
 need(result['receipt']['status']==expected,'REMOTE_INSTALLATION_NOT_CONFIRMED')
 result.update(status=expected,stage='COMPLETE')
except BaseException as exc:
 code=getattr(exc,'code',str(exc))
 result.update(status='STOP',stage=stage,code=code if re.fullmatch('[A-Z0-9_]{1,100}',code) else 'OWNER_CHANNEL_ERROR_REDACTED')
with out.open('x',encoding='utf8') as f:json.dump(result,f,indent=2)
print(json.dumps(result),flush=True)
print('DELEGA DI LETTURA INSTALLATA. Codex prosegue direttamente.' if result['status']=='FIXED_READ_DELEGATION_INSTALLED' else 'STOP: non ripetere. Codex legge la ricevuta.' if result['status']=='STOP' else 'DELEGA RIMOSSA.',flush=True)
raise SystemExit(2 if result['status']=='STOP' else 0)
'''


def build(output):
    output = Path(output)
    output.mkdir()
    payload = {name: base64.b64encode((SOURCE / name).read_bytes()).decode()
               for name in ('delegate.py', 'observe_image_store_r22.py')}
    installer = (SOURCE / 'install.py').read_text(encoding='utf8')
    files = {}
    def write(name, text):
        raw = text.encode('utf8')
        with (output / name).open('xb') as f:
            f.write(raw)
        files[name] = {'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}
        return files[name]['sha256']
    for mode, title in (('install', 'AVVIA-DELEGA'), ('uninstall', 'RIMUOVI-DELEGA')):
        bundle = installer + '\nraise SystemExit(main(' + repr(mode) + ',' + repr(payload) + '))\n'
        bundle_sha = write(mode+'.bundle.py', bundle)
        owner_sha = write(mode+'.owner.py', 'MODE='+repr(mode)+'\nBUNDLE_SHA='+repr(bundle_sha)+'\n'+OWNER)
        ps = ("$ErrorActionPreference='Stop'\n"
              "$r23Python='"+PYTHON+"'\n"
              "if ((Get-FileHash -LiteralPath $r23Python -Algorithm SHA256).Hash -ne '"+PYTHON_SHA+"') { throw 'PYTHON_CHANGED' }\n"
              "$r23Owner=Join-Path $PSScriptRoot '"+mode+".owner.py'\n"
              "if ((Get-FileHash -LiteralPath $r23Owner -Algorithm SHA256).Hash -ne '"+owner_sha+"') { throw 'OWNER_PROGRAM_CHANGED' }\n"
              "& $r23Python -I -B -S $r23Owner\n"
              "exit $LASTEXITCODE\n")
        write(title+'.ps1', ps)
        write(title+'.cmd', '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0'+title+'.ps1"\r\necho Esito: %ERRORLEVEL%. Non ripetere in caso di errore.\r\npause\r\n')
    write('LEGGIMI.md', '# Delega della sola lettura R23\n\n'
          'Avviare una sola volta AVVIA-DELEGA.cmd dal normale account Windows di Antonio. '
          'Non serve PowerShell amministratore o UAC locale. Il profilo SSH proprietario '
          'deve consentire sudo non interattivo; non vengono richieste password.\n\n'
          'Crea sul VPS solo la directory root /usr/local/lib/fai-crm-m1-r23-read e la '
          'regola /etc/sudoers.d/fai-crm-m1-r23-read. Consente a fai-codex di invocare '
          'come faiadmin unicamente l’osservazione R22, senza argomenti liberi. '
          'Nessun backup, migrazione, deploy o modifica alle chiavi.\n\n'
          'Esito atteso: DELEGA DI LETTURA INSTALLATA. La task legge ESITO-INSTALL.json. '
          'In caso di STOP non ripetere. Codex riconcilia la ricevuta.\n\n'
          'RIMUOVI-DELEGA.cmd è la disinstallazione preparata; non avviarla durante il '
          'rilascio. Rifiuta contenuti modificati o una lettura in corso.\n')
    (output/'PACCHETTO.json').write_text(json.dumps({'status':'PREPARED_NOT_INSTALLED','files':files},indent=2),encoding='utf8')
    return files


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('One fresh local output directory is required')
    print(json.dumps(build(sys.argv[1])))
