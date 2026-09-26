"""One explicit owner session; fixed target/actions; never usable by the sandbox identity."""
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import time

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from common import Stop, canonical, decode, digest, exclusive, load, need, private, utc

SSH = Path(r'C:\Windows\System32\OpenSSH\ssh.exe')
PS = Path(r'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe')
PY = Path(r'C:\Users\Utente\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe')
R20 = Path(r'C:\Users\Utente\Desktop\CRM\artifacts\M1-assistito-R20')
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
SSH_ARGS = [str(SSH), '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ConnectionAttempts=1',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', '-o', 'ServerAliveInterval=15',
            '-o', 'ServerAliveCountMax=2', 'fai-crm-prod']
KEY_CONFIRMATION = 'AUTORIZZO_CHIAVE_STEP_UP_M1_VERSIONE_1'
TIMES = {'prepare': 540, 'backup': 1800, 'protect': 900, 'copies-backup': 90, 'recover': 900,
         'provision': 120, 'copies-config': 90, 'migrate': 390, 'deploy': 960, 'postcheck': 180, 'status': 150,
         'fetch-backup': 600, 'fetch-config': 120}


def ssh_error(error):
    text = error.decode('utf-8', 'replace').lower()
    for values, category in [
        (('could not resolve hostname', 'no such host'), 'SSH_DNS_FAILED'),
        (('host key verification failed', 'remote host identification has changed'), 'SSH_HOST_KEY_REJECTED'),
        (('permission denied', 'authentication failed'), 'SSH_AUTHENTICATION_FAILED'),
        (('connection timed out', 'connection refused', 'connection reset', 'broken pipe'), 'SSH_CONNECTION_FAILED'),
    ]:
        if any(v in text for v in values):
            return category
    return 'SSH_OR_REMOTE_COMMAND_FAILED'


def call(args, seconds, *, data=None, source=None, output=None):
    p = subprocess.Popen([str(a) for a in args], stdin=source or (subprocess.PIPE if data is not None else subprocess.DEVNULL),
                         stdout=output or subprocess.PIPE, stderr=subprocess.PIPE, creationflags=NO_WINDOW)
    try:
        out, error = p.communicate(input=data, timeout=seconds)
    except BaseException:
        p.kill()
        try:
            p.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            raise Stop('LOCAL_PROCESS_STOP_UNVERIFIED') from None
        raise Stop('OWNER_CHANNEL_TIMEOUT_OR_INTERRUPTED_RECONCILE_ONLY') from None
    return p.returncode, out or b'', error


def admit(manifest):
    need(os.name == 'nt' and len(sys.argv) == 1, 'NORMAL_OWNER_WINDOWS_REQUIRED')
    code, out, _ = call([r'C:\Windows\System32\whoami.exe', '/user', '/fo', 'csv', '/nh'], 10)
    row = next(csv.reader(io.StringIO(out.decode('utf-8', 'replace').strip())))
    owner = load(ROOT / 'owner-binding.json')['ownerSid']
    need(re.fullmatch(r'S-1-5-21-(?:[0-9]+-){3}[0-9]+', owner), 'OWNER_BINDING_INVALID')
    need(code == 0 and row[-1] == owner and 'codexsandbox' not in row[0].lower(), 'OWNER_ACCOUNT_REQUIRED')
    for program, path in [('ssh', SSH), ('python', PY), ('powershell', PS)]:
        need(digest(path) == manifest['programs'][program], 'LOCAL_PROGRAM_CHANGED', program=program)
    need(manifest['candidate'] == 'fb645e014653ee87dc64f2439970967192f91b62', 'CANDIDATE_CHANGED')
    for name, entry in manifest['files'].items():
        if name == 'release-images.tar.gz':
            continue
        need(Path(name).name == name, 'PACKAGE_FILENAME')
        path = ROOT / name
        need(not path.is_symlink() and path.stat().st_size == entry['bytes'] and digest(path) == entry['sha256'], 'PACKAGE_FILE_CHANGED', file=name)
    # Read only the effective, nonsecret target. Use the owner's normal profile.
    code, out, err = call([str(SSH), '-G', 'fai-crm-prod'], 10)
    need(code == 0, 'LOCAL_SSH_PROFILE_QUERY_FAILED')
    fields = {}
    for line in out.decode('utf-8', 'replace').splitlines():
        key, sep, value = line.partition(' ')
        if key in ('hostname', 'user', 'port'):
            need(key not in fields, 'SSH_TARGET_AMBIGUOUS')
            fields[key] = value.strip()
    need(fields == {'hostname': 'desk.finanzaagevolaimpresa.it', 'user': 'faiadmin', 'port': '22'}, 'SSH_ALIAS_TARGET_MISMATCH')


def storage():
    code, out, _ = call([PS, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', ROOT / 'storage_probe.ps1'], 75)
    result = decode(out.decode('utf-8-sig').strip())
    need(code == 0 and result['status'] == 'PASS', result.get('code', 'STORAGE_CHECK_FAILED'))
    return result


def command(manifest, stage):
    need(stage in TIMES, 'FIXED_OPERATION_REQUIRED')
    need(re.fullmatch('[a-f0-9]{32}', manifest.get('runId', '')), 'RUN_ID_INVALID')
    remote = '/home/faiadmin/.local/share/fai-crm-releases/m1-assisted-r21-' + manifest['runId']
    # Paths consist of fixed literals and a validated hex run. No supplied shell.
    return SSH_ARGS + ['python3 -I -B -S ' + remote + '/remote_release.py ' + stage]


def stage_call(manifest, stage, request=None, output=None):
    code, out, error = call(command(manifest, stage), TIMES[stage], data=canonical(request or {}), output=output)
    if output is not None:
        need(code == 0, ssh_error(error), exitCode=code, stderrBytes=len(error), stderrSha256=hashlib.sha256(error).hexdigest())
        return None
    result = None
    try:
        result = decode(out)
    except (ValueError, TypeError, Stop):
        pass
    if result is not None:
        name = stage + ('-reconcile-' + str(time.time_ns()) if stage == 'status' else '') + '.json'
        exclusive(ROOT / name, result)
    need(code == 0 and isinstance(result, dict) and result.get('status', 'PASS') == 'PASS',
         result.get('code', 'REMOTE_STAGE_STOP') if isinstance(result, dict) else ssh_error(error),
         stage=stage, exitCode=code, receiptReceived=result is not None,
         stderrBytes=len(error), stderrSha256=hashlib.sha256(error).hexdigest())
    return result


def upload(manifest):
    archive = ROOT / 'owner-transfer.tar'
    need(not archive.exists(), 'TRANSFER_ALREADY_STARTED_RECONCILE_ONLY')
    with tarfile.open(archive, 'x') as target:
        for name in [*manifest['files'], 'package.json']:
            if name == 'release-images.tar.gz':
                continue  # The fixed receiver verifies and copies the already transferred archive.
            source = ROOT / name
            info = target.gettarinfo(str(source), arcname=name)
            info.uid = info.gid = 1000
            info.uname = info.gname = ''
            info.mode = 0o600
            with source.open('rb') as stream:
                target.addfile(info, stream)
    # The bootstrap is reviewed source plus fixed hashes, not an arbitrary command channel.
    bootstrap = (ROOT / 'receive_package.py').read_text(encoding='utf-8')
    import base64
    packet = {'runId': manifest['runId'], 'manifestSha256': digest(ROOT / 'package.json'),
              'archiveSha256': digest(archive), 'archiveBytes': archive.stat().st_size}
    code = bootstrap + '\nreceive(' + repr(packet) + ')\n'
    encoded = base64.b64encode(code.encode()).decode('ascii')
    remote = 'python3 -I -B -S -c "import base64;exec(base64.b64decode(\'' + encoded + '\'))"'
    print('2/9 — Trasferimento del solo pacchetto e verifica delle immagini già sul server; massimo 10 minuti.', flush=True)
    with archive.open('rb') as source:
        status, out, error = call(SSH_ARGS + [remote], 600, source=source)
    result = None
    try:
        result = decode(out)
    except (ValueError, Stop):
        pass
    exclusive(ROOT / 'upload.json', result or {'status': 'STOP', 'code': ssh_error(error), 'sshExit': status})
    need(status == 0 and result and result['status'] == 'PACKAGE_RECEIVED', 'PACKAGE_UPLOAD_NOT_CONFIRMED')


def copies(manifest, source, label):
    devices = storage()
    target_names = {'backup': 'backup46.bundle.tar', 'config': 'm1-configuration.age'}
    need(label in target_names, 'COPY_KIND')
    folder_name = 'CRM-BACKUP-M1-SCHEMA46-R21-' + manifest['runId']
    roots = {'C': Path(r'C:\Users\Utente\Desktop\CRM\storage\private') / folder_name,
             'F': Path('F:/') / ('FAI-' + folder_name)}
    results = {}
    for drive, root in roots.items():
        private(root.parent, directory=True)
        if label == 'backup':
            root.mkdir()
        private(root, directory=True)
        path = root / target_names[label]
        with path.open('xb') as output:
            if drive == 'C':
                stage_call(manifest, 'fetch-' + label, output=output)
            else:
                with (roots['C'] / target_names[label]).open('rb') as incoming:
                    shutil.copyfileobj(incoming, output, 1024 * 1024)
            output.flush()
            os.fsync(output.fileno())
        need(path.stat().st_size == source['bundle_bytes'] and digest(path) == source['bundle_sha256'], 'CIPHERTEXT_COPY_HASH')
        after = storage()
        private(path)
        need(after[drive]['disk'] == devices[drive]['disk'] and after[drive]['partition'] == devices[drive]['partition'], 'COPY_DESTINATION_CHANGED')
        results[drive] = {'path': str(path), 'sha256': digest(path), 'bytes': path.stat().st_size,
                          'physicalIdentityVerified': True, 'physicalDisk': devices[drive]['disk'], 'readbackVerified': True}
    exclusive(ROOT / ('local-copies-' + label + '.json'), results)
    return results


def key_consent():
    print('\nServe soltanto questa decisione specifica, già descritta nel pacchetto:', flush=True)
    print('creare sul VPS la prima chiave step-up M1, versione 1, registrarla ACTIVE con audit', flush=True)
    print('a nome dell’unico amministratore attivo e conservarne due copie cifrate C:/F:.', flush=True)
    print('Il valore rimane sul VPS. Nessuna chiave esistente viene sostituita.', flush=True)
    print('Per autorizzare digita esattamente ' + KEY_CONFIRMATION + ' e premi Invio (120 secondi).', flush=True)
    import msvcrt
    deadline = time.monotonic() + 120
    answer = ''
    while time.monotonic() < deadline:
        if not msvcrt.kbhit():
            time.sleep(.05)
            continue
        char = msvcrt.getwch()
        if char in ('\r', '\n'):
            print('', flush=True)
            need(answer == KEY_CONFIRMATION, 'SPECIFIC_KEY_APPROVAL_NOT_GIVEN')
            return answer
        if char == '\x03':
            raise Stop('OWNER_CANCELLED_BEFORE_BACKUP')
        if char == '\b':
            answer = answer[:-1]
        elif char.isprintable() and len(answer) < 100:
            answer += char
            print(char, end='', flush=True)
    raise Stop('SPECIFIC_KEY_APPROVAL_TIMEOUT_NO_BACKUP_STARTED')


def main():
    manifest = load(ROOT / 'package.json')
    admit(manifest)
    need(re.fullmatch('[0-9a-f]{32}', manifest['runId']), 'RUN_ID')
    if (ROOT / 'owner-started.json').exists():
        print('Avvio già registrato: eseguo soltanto la riconciliazione in lettura.', flush=True)
        result = stage_call(manifest, 'status')
        print('RICONCILIAZIONE SALVATA. Nessuna operazione ripetuta.', flush=True)
        return 0
    exclusive(ROOT / 'owner-started.json', {'runId': manifest['runId'], 'utc': utc(), 'ownerSidVerified': True})
    try:
        print('1/9 — Verifica delle destinazioni fisiche C:/F: già approvate.', flush=True)
        storage()
        upload(manifest)
        print('3/9 — Riconciliazione corrente, immagini, prerequisiti e diagnosi mirata.', flush=True)
        stage_call(manifest, 'prepare')
        confirmation = key_consent()
        print('4/9 — Nuovo backup PR145 e rientro dell’applicazione; massimo 30 minuti inclusi i controlli.', flush=True)
        stage_call(manifest, 'backup')
        print('5/9 — Cifratura e due copie verificate sulle destinazioni fisiche C:/F:.', flush=True)
        protected = stage_call(manifest, 'protect')
        stage_call(manifest, 'copies-backup', {'copies': copies(manifest, protected, 'backup')})
        print('6/9 — Recupero del nuovo database e documenti in container isolati; massimo 15 minuti.', flush=True)
        stage_call(manifest, 'recover')
        print('7/9 — Configurazione M1 autorizzata e relative copie cifrate.', flush=True)
        configured = stage_call(manifest, 'provision', {'keyConfirmation': confirmation})
        stage_call(manifest, 'copies-config', {'copies': copies(manifest, configured, 'config')})
        print('8/9 — Sole migrazioni 47/48 e deploy del candidato qualificato.', flush=True)
        stage_call(manifest, 'migrate')
        stage_call(manifest, 'deploy')
        print('9/9 — Verifiche dello stato produttivo M1.', flush=True)
        result = stage_call(manifest, 'postcheck')
        exclusive(ROOT / 'ESITO-ASSISTITO.json', result)
        print('RILASCIO TECNICO VERIFICATO. Resta la prova d’uso M1 con accesso personale; Codex legge le ricevute.', flush=True)
        return 0
    except BaseException as exc:
        result = {'protocol': 'FAI_M1_ASSISTED_OWNER_STOP_R21', 'status': 'STOP', 'utc': utc(),
                  'code': exc.code if isinstance(exc, Stop) else 'LOCAL_FAILURE_REDACTED',
                  'details': exc.details if isinstance(exc, Stop) else {'exceptionType': type(exc).__name__},
                  'historicalAttemptsRepeated': False, 'autonomyQualified': False}
        exclusive(ROOT / 'ESITO-ASSISTITO.json', result)
        print(canonical(result).decode(), flush=True)
        # Exactly one bounded read after failure; never retry a mutating stage.
        if (ROOT / 'upload.json').exists():
            try:
                stage_call(manifest, 'status')
                print('Riconciliazione in lettura salvata automaticamente.', flush=True)
            except BaseException:
                print('Canale di riconciliazione indisponibile: nessuna operazione ripetuta.', flush=True)
        print('STOP: conserva la finestra. Codex legge le ricevute; non ripetere il rilascio.', flush=True)
        return 2


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Stop as exc:
        print(canonical({'status': 'LOCAL_ADMISSION_STOP', 'code': exc.code, 'details': exc.details}).decode())
        raise SystemExit(2)
