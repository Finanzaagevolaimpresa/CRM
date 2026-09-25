"""Resume only the two fixed, qualified M1 image downloads. No production access."""
import csv
import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import zipfile

ROOT = Path(r'C:\Users\Utente\Desktop\CRM\artifacts\M1-assistito-R20')
GH = Path(r'C:\Program Files\GitHub CLI\gh.exe')
GH_SHA = 'cd79f16203f1fbe56937c4c96e2b6eadd10549418dcb241d91576ac77af0ac8b'
CANDIDATE = 'fb645e014653ee87dc64f2439970967192f91b62'
IMAGE_SHA = 'fadbed9be809e18e6d6afc4b123532edf7d0115a86e52e2e1e7bce16e245b2e7'
ARTIFACTS = (
    (10850108348, 314573847, '98639947a6ac25cc9f860c89416c9775aa460bc9fe2eddd6c1e86b210468d141'),
    (10850283024, 228760040, '009b20cc6e30ba4a769e1b9e2d38fb35d539d7bca02bfc5ba35eafc56cea3e3b'),
)
SEED_BYTES = 99336192
SEED_SHA = '67bd769e16ae64b3fbf5a83cf41aa78e934e6388aab4654398f2b316c11c421d'
BLOCK = 8 * 1024 * 1024
TOTAL_SECONDS = 600
READ_SECONDS = 45
RETRIES = 3
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
TRANSIENT = {'DOWNLOAD_TIMEOUT', 'GITHUB_CONNECTION_INTERRUPTED',
             'GITHUB_DNS_FAILED', 'GITHUB_SERVER_ERROR', 'TRUNCATED_RANGE'}


class Stop(Exception):
    def __init__(self, code, **detail):
        super().__init__(code)
        self.code, self.detail = code, detail


def need(ok, code, **detail):
    if not ok:
        raise Stop(code, **detail)


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for b in iter(lambda: f.read(1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()


def new_json(path, value):
    with path.open('x', encoding='utf-8') as f:
        json.dump(value, f, indent=2)
        f.flush()
        os.fsync(f.fileno())


def classify(stderr, status=None):
    s = stderr.decode('utf-8', errors='replace').lower()
    if status == 401 or any(v in s for v in ('gh auth login', 'http 401', 'bad credentials')):
        return 'GITHUB_AUTHENTICATION_REQUIRED'
    if status == 403 or 'http 403' in s:
        return 'GITHUB_ACCESS_DENIED'
    if status in (404, 410):
        return 'GITHUB_ARTIFACT_UNAVAILABLE'
    if status is not None and status >= 500:
        return 'GITHUB_SERVER_ERROR'
    if any(v in s for v in ('unexpected eof', 'connection reset', 'connection was forcibly closed',
                             'stream error', 'connection closed', 'http2:')):
        return 'GITHUB_CONNECTION_INTERRUPTED'
    if any(v in s for v in ('no such host', 'lookup', 'resolve')):
        return 'GITHUB_DNS_FAILED'
    if any(v in s for v in ('timeout', 'timed out', 'deadline exceeded')):
        return 'DOWNLOAD_TIMEOUT'
    if any(v in s for v in ('certificate', 'tls', 'x509')):
        return 'GITHUB_TLS_ERROR'
    return 'GITHUB_COMMAND_FAILED'


def bounded_command(args, limit, seconds):
    """Bound both streams; never print raw headers, signed URLs or credentials."""
    env = dict(os.environ, GH_PROMPT_DISABLED='1', GIT_TERMINAL_PROMPT='0', GH_PAGER='cat', NO_COLOR='1')
    p = subprocess.Popen([str(GH)] + args, stdin=subprocess.DEVNULL,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                         creationflags=NO_WINDOW)
    output, error = bytearray(), bytearray()
    overflow = threading.Event()

    def pump(stream, dest, cap):
        try:
            while True:
                block = stream.read(16384)
                if not block:
                    break
                if len(dest) + len(block) > cap:
                    dest.extend(block[:max(0, cap - len(dest))])
                    overflow.set()
                    p.kill()
                    break
                dest.extend(block)
        finally:
            stream.close()

    threads = [threading.Thread(target=pump, args=(p.stdout, output, limit), daemon=True),
               threading.Thread(target=pump, args=(p.stderr, error, 16384), daemon=True)]
    for t in threads:
        t.start()
    try:
        p.wait(timeout=seconds)
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait(timeout=5)
        raise Stop('DOWNLOAD_TIMEOUT') from None
    except BaseException:
        p.kill()
        p.wait(timeout=5)
        raise
    finally:
        for t in threads:
            t.join(timeout=5)
    return p.returncode, bytes(output), bytes(error), overflow.is_set()


def parse_response(raw):
    # gh prints the status line with LF and the remaining headers with CRLF.
    end = raw.find(b'\r\n\r\n')
    width = 4
    if end < 0:
        end, width = raw.find(b'\n\n'), 2
    need(0 < end <= 16384, 'RESPONSE_HEADERS_INVALID')
    lines = raw[:end].splitlines()
    match = re.fullmatch(rb'HTTP/\d(?:\.\d)? (\d{3})(?: .*)?', lines[0])
    need(match is not None, 'RESPONSE_STATUS_INVALID')
    headers = {}
    for line in lines[1:]:
        key, sep, value = line.partition(b':')
        need(bool(sep), 'RESPONSE_HEADERS_INVALID')
        key = key.strip().lower()
        need(key not in headers, 'DUPLICATE_RESPONSE_HEADER')
        headers[key] = value.strip()
    return int(match[1]), headers, raw[end + width:]


def validate_range(exit_code, raw, error, overflow, start, end, total):
    status, headers, data = parse_response(raw)
    detail = {'httpStatus': status, 'exitCode': exit_code,
              'stderrBytes': len(error), 'stderrSha256': hashlib.sha256(error).hexdigest()}
    need(status == 206, 'SERVER_DID_NOT_HONOR_RANGE' if status == 200 else classify(error, status), **detail)
    expected = ('bytes %d-%d/%d' % (start, end, total)).encode('ascii')
    need(headers.get(b'content-range') == expected, 'CONTENT_RANGE_MISMATCH', **detail)
    need(headers.get(b'content-encoding', b'identity') == b'identity', 'UNEXPECTED_CONTENT_ENCODING')
    need(not overflow, 'RESPONSE_SIZE_LIMIT_EXCEEDED', **detail)
    if exit_code != 0:
        raise Stop(classify(error, status), **detail)
    need(len(data) == end - start + 1, 'TRUNCATED_RANGE', receivedBytes=len(data), **detail)
    if b'content-length' in headers:
        need(headers[b'content-length'] == str(len(data)).encode('ascii'), 'CONTENT_LENGTH_MISMATCH')
    return data


def obtain_range(artifact, start, end, total, deadline, events, runner=bounded_command):
    args = ['api', '--hostname', 'github.com', '--method', 'GET',
            'repos/Finanzaagevolaimpresa/CRM/actions/artifacts/%d/zip' % artifact,
            '--include', '-H', 'Range: bytes=%d-%d' % (start, end),
            '-H', 'Accept-Encoding: identity']
    for attempt in range(1, RETRIES + 1):
        remaining = deadline - time.monotonic()
        need(remaining > 0, 'TRANSFER_TIME_LIMIT_REACHED')
        try:
            response = runner(args, end - start + 1 + 16384, min(READ_SECONDS, remaining))
            if not response[1] and response[0] != 0:
                raise Stop(classify(response[2]), exitCode=response[0], stderrBytes=len(response[2]),
                           stderrSha256=hashlib.sha256(response[2]).hexdigest())
            return validate_range(*response, start, end, total)
        except Stop as exc:
            events.append({'artifactId': artifact, 'offset': start, 'attempt': attempt,
                           'code': exc.code, **exc.detail})
            if exc.code not in TRANSIENT or attempt == RETRIES:
                raise
            print('Interruzione temporanea: ripresa automatica del solo blocco (%d/%d).' %
                  (attempt + 1, RETRIES), flush=True)
    raise Stop('RANGE_ATTEMPTS_EXHAUSTED')


def verify_extract(path, folder, index, record):
    artifact, size, expected = record
    need(path.stat().st_size == size and sha(path) == expected, 'ARTIFACT_SIZE_OR_HASH_MISMATCH')
    filename = 'release-images.tar.gz.part%02d' % index
    with zipfile.ZipFile(path) as archive:
        need(len(archive.namelist()) == 2 and set(archive.namelist()) == {filename, 'transport.json'},
             'ARTIFACT_ENTRY_SET_MISMATCH')
        need(archive.getinfo('transport.json').file_size <= 32768, 'TRANSPORT_METADATA_LIMIT')
        metadata = json.loads(archive.read('transport.json'))
        need(metadata['protocol'] == 'FAI_M1_QUALIFIED_IMAGE_TRANSPORT_R18'
             and metadata['candidate'] == CANDIDATE and metadata['imageArchiveSha256'] == IMAGE_SHA
             and metadata['sourceRunId'] == 36021069464 and metadata['sourceArtifactId'] == 10817321285
             and len(metadata['parts']) == 2, 'TRANSPORT_BINDING_MISMATCH')
        part = metadata['parts'][index]
        need(part['file'] == 'part-%02d/%s' % (index, filename)
             and 0 < part['bytes'] <= 300 * 1024 * 1024
             and re.fullmatch('[a-f0-9]{64}', part['sha256']), 'PART_METADATA_INVALID')
        need(archive.getinfo(filename).file_size == part['bytes'], 'PART_SIZE_MISMATCH')
        dest = folder / filename
        with archive.open(filename) as source, dest.open('xb') as output:
            for block in iter(lambda: source.read(1024 * 1024), b''):
                output.write(block)
        need(sha(dest) == part['sha256'], 'PART_HASH_MISMATCH')
    return {'artifactId': artifact, 'zipBytes': size, 'zipSha256': expected,
            'part': filename, 'partBytes': part['bytes'], 'partSha256': part['sha256']}


def main():
    need(os.name == 'nt' and len(sys.argv) == 1, 'NORMAL_OWNER_WINDOWS_REQUIRED')
    identity = subprocess.run([r'C:\Windows\System32\whoami.exe', '/user', '/fo', 'csv', '/nh'],
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=10, check=True, creationflags=NO_WINDOW)
    row = next(csv.reader(io.StringIO(identity.stdout.decode('utf-8', errors='replace').strip())))
    owner = json.loads((Path(__file__).resolve().parent / 'owner-binding.json').read_text(encoding='utf-8'))['ownerSid']
    need(re.fullmatch(r'S-1-5-21-(?:[0-9]+-){3}[0-9]+', owner), 'OWNER_BINDING_INVALID')
    need(row[-1] == owner and 'codexsandbox' not in row[0].lower(), 'OWNER_ACCOUNT_REQUIRED')
    need(sha(GH) == GH_SHA, 'GITHUB_PROGRAM_HASH_MISMATCH')
    prior = json.loads((ROOT / '02-RICEVUTA.json').read_text(encoding='utf-8-sig'))
    diagnostic = json.loads((ROOT / '02-DIAGNOSI-RICEVUTA.json').read_text(encoding='utf-8-sig'))
    need(prior['status'] == 'STOP' and prior['candidate'] == CANDIDATE, 'HISTORICAL_RECEIPT_MISMATCH')
    need(diagnostic['authentication']['category'] == 'SUCCESS'
         and diagnostic['artifactMetadata']['artifact']['digest'] == 'sha256:' + ARTIFACTS[0][2],
         'OWNER_GITHUB_DIAGNOSTIC_MISMATCH')
    seed = ROOT / '02-IMMAGINI' / 'part-00.zip'
    need(seed.is_file() and not seed.is_symlink() and seed.stat().st_size == SEED_BYTES
         and sha(seed) == SEED_SHA, 'HISTORICAL_PARTIAL_CHANGED')
    folder = ROOT / '02-IMMAGINI-R21'
    need(not folder.exists() and not (ROOT / '02-RICEVUTA-R21.json').exists(),
         'R21_ALREADY_STARTED_RECONCILE_FIRST')
    folder.mkdir()
    result = {'protocol': 'FAI_M1_RESUMABLE_IMAGE_ACQUISITION_R21',
              'observedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'candidate': CANDIDATE, 'status': 'STOP', 'stage': 'DOWNLOAD',
              'reusedBytes': SEED_BYTES, 'historicalPartialPreserved': True,
              'events': [], 'artifacts': [], 'imagesRebuilt': False, 'imagesExecuted': False,
              'productionMutationPerformed': False, 'remoteSshConnectionAttempted': False,
              'credentialValuesExported': False, 'downloadTimeLimitSeconds': TOTAL_SECONDS}
    started = time.monotonic()
    deadline = started + TOTAL_SECONDS
    try:
        for index, record in enumerate(ARTIFACTS):
            artifact, total, expected = record
            target = folder / ('part-%02d.zip' % index)
            with target.open('xb') as output:
                if index == 0:
                    with seed.open('rb') as original:
                        for block in iter(lambda: original.read(1024 * 1024), b''):
                            output.write(block)
                offset = output.tell()
                while offset < total:
                    end = min(total, offset + BLOCK) - 1
                    block = obtain_range(artifact, offset, end, total, deadline, result['events'])
                    output.write(block)
                    output.flush()
                    os.fsync(output.fileno())
                    offset += len(block)
                    print('Parte %d/2: %d%% (%d/%d MB).' %
                          (index + 1, offset * 100 // total, offset // 1000000, total // 1000000), flush=True)
            result['stage'] = 'VERIFY_ARCHIVE'
            result['artifacts'].append(verify_extract(target, folder, index, record))
            result['stage'] = 'DOWNLOAD'
        result['stage'] = 'REASSEMBLY'
        combined = folder / 'release-images.tar.gz'
        with combined.open('xb') as output:
            for entry in result['artifacts']:
                with (folder / entry['part']).open('rb') as source:
                    for block in iter(lambda: source.read(1024 * 1024), b''):
                        output.write(block)
            output.flush()
            os.fsync(output.fileno())
        need(sha(combined) == IMAGE_SHA, 'QUALIFIED_IMAGE_REASSEMBLY_MISMATCH')
        result.update(status='IMAGES_DOWNLOADED_AND_VERIFIED', stage='COMPLETE',
                      imageArchive=str(combined), imageArchiveSha256=IMAGE_SHA,
                      imageArchiveBytes=combined.stat().st_size)
    except Stop as exc:
        result.update(code=exc.code, error=exc.detail)
    except KeyboardInterrupt:
        result.update(code='OWNER_INTERRUPTED_PARTIAL_PRESERVED')
    except Exception as exc:
        result.update(code='LOCAL_PROCESSING_ERROR', exceptionType=type(exc).__name__)
    result['elapsedSeconds'] = round(time.monotonic() - started, 1)
    new_json(ROOT / '02-RICEVUTA-R21.json', result)
    print(json.dumps(result, separators=(',', ':')), flush=True)
    print('IMMAGINI COMPLETE E VERIFICATE.' if result['status'] != 'STOP'
          else 'STOP: ricevuta salvata; non ripetere il comando.', flush=True)
    return 0 if result['status'] != 'STOP' else 2


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Stop as exc:
        print(json.dumps({'status': 'LOCAL_ADMISSION_STOP', 'code': exc.code, **exc.detail}))
        raise SystemExit(2)
