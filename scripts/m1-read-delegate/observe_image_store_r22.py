"""One owner-invoked, fixed-target read after the e67bea prepare STOP. No release actions."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import socket
import sys
import tarfile

sys.dont_write_bytecode = True
RUN = 'e67bea4040fc4aeb86a0c98ac6178e7e'
PACKAGE_SHA = '961e6d7f6f1d1275a8d472eed8b2bc5dc14adecd25b304f4dad5b475985088c3'
COMMON_SHA = 'b53f7670f3e4e2aad58c1ad4eb9999cc429fb40d2ce61b5f188742089bda3b19'
OWNER_SHA = '20f22730dda3e1982d9dc7e2ddc589a94ff6d64bf136ac9103366f44f47d45e2'
ARCHIVE_SHA = 'fadbed9be809e18e6d6afc4b123532edf7d0115a86e52e2e1e7bce16e245b2e7'
PROTOCOL = 'FAI_M1_IMAGE_STORE_READONLY_R22'
LOCAL = Path(r'C:\Users\Utente\Desktop\CRM\artifacts\M1-assistito-R20')
REMOTE = Path('/home/faiadmin/.local/share/fai-crm-releases')
CONFIG_IDS = {
    'candidate': 'sha256:839602508e6c7648336e8baae3781813dd2aa2479f9fa88292878ea01c836d73',
    'return': 'sha256:11818e8f42c000700929452ffff8222d7f50c759c8fe59948838abf7c97c8458',
}
MANIFEST_IDS = {
    'candidate': 'sha256:06fe7f94dfd274eba7c24bd9e9cc102631ebc600f4a66e6066b708e846941bf9',
    'return': 'sha256:bd70ecab1f747fd2c394a5846f8b3a3b6a93896fea42fc76dbd2aec5f25d0212',
}
IMAGE_FORMAT = ('{"id":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}},'
                '"layers":{{json .RootFS.Layers}},'
                '"commit":{{json (index .Config.Labels "org.opencontainers.image.revision")}},'
                '"tree":{{json (index .Config.Labels "it.finanzaagevolaimpresa.source-tree")}}}')
STATE_FORMAT = ('{"id":{{json .Id}},"image":{{json .Image}},"running":{{json .State.Running}},'
                '"health":{{json .State.Health.Status}},"restartCount":{{json .RestartCount}}}')
FOLLOWING = ('backup', 'protect', 'copies-backup', 'recover', 'provision', 'copies-config', 'migrate', 'deploy', 'postcheck')


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def require(condition, code):
    if not condition:
        raise ValueError(code)


def verified_module(path, expected, name):
    require(sha(path) == expected and not path.is_symlink(), 'PROGRAM_HASH_MISMATCH')
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    sys.modules[name] = result
    spec.loader.exec_module(result)
    return result


def image_evidence(role, observed, configs, binding):
    config = configs[role]
    expected_commit = binding['candidate' if role == 'candidate' else 'returnCommit']
    expected_tree = binding[role + 'Tree']
    image_id = observed['id']
    require(re.fullmatch('sha256:[0-9a-f]{64}', image_id), 'IMAGE_ID_INVALID')
    return {'availableByQualifiedTag': True, 'observedId': image_id,
            'idKind': 'CONFIG_DIGEST' if image_id == CONFIG_IDS[role] else
                      'ARCHIVE_OCI_MANIFEST' if image_id == MANIFEST_IDS[role] else 'UNEXPECTED_ID',
            'platformMatches': observed['os'] == config['os'] == 'linux' and
                               observed['architecture'] == config['architecture'] == 'amd64',
            'layersMatchQualifiedConfig': observed['layers'] == config['rootfs']['diff_ids'],
            'qualifiedLabelsMatch': observed['commit'] == expected_commit and observed['tree'] == expected_tree,
            'qualifiedConfigDigest': CONFIG_IDS[role], 'archiveManifestDigest': MANIFEST_IDS[role]}


def remote_read():
    import pwd
    require(len(sys.argv) == 1 and socket.gethostname() == 'fai-crm-prod-02' and
            os.getuid() == os.getgid() == 1000 and pwd.getpwuid(1000).pw_name == 'faiadmin', 'REMOTE_IDENTITY_MISMATCH')
    def expired(_number, _frame):
        raise ValueError('READ_DEADLINE_EXPIRED')
    signal.signal(signal.SIGALRM, expired)
    signal.alarm(120)
    root = REMOTE / ('m1-assisted-r21-' + RUN)
    require(sha(root / 'package.json') == PACKAGE_SHA, 'REMOTE_PACKAGE_CHANGED')
    cmod = verified_module(root / 'common.py', COMMON_SHA, 'm1_image_read_common')
    manifest = cmod.load(cmod.private(root / 'package.json'))
    require(manifest['runId'] == RUN, 'RUN_CHANGED')
    for name, entry in manifest['files'].items():
        require(Path(name).name == name, 'PACKAGE_MEMBER_NAME')
        path = cmod.private(root / name)
        require(path.stat().st_size == entry['bytes'] and sha(path) == entry['sha256'], 'PACKAGE_MEMBER_CHANGED')
    binding = cmod.load(root / 'binding.json')
    target = binding['target']
    c = cmod.Commands(100, root)
    engine = cmod.decode(c.docker('ENGINE_METADATA', 'info', '--format',
        '{"id":{{json .ID}},"version":{{json .ServerVersion}},"driver":{{json .Driver}},"driverStatus":{{json .DriverStatus}}}', seconds=10))
    require(engine['id'] == target['engineId'], 'ENGINE_IDENTITY_MISMATCH')
    stop = cmod.load(cmod.private(root / 'evidence/prepare.stop.json'))
    require(stop['code'] == 'COMMAND_FAILED' and stop['details']['commandId'] == 'INSPECT_IMAGE' and
            stop['details']['exitCode'] == 1 and stop['details']['stderrBytes'] == 115 and
            stop['details']['stderrSha256'] == 'ff8de78af764da229499fee0e1131c12a6688c63664b8c8bbbe4cc2b5cbd06d0',
            'STOP_RECEIPT_CHANGED')
    require(all(not (root / 'evidence' / (s + suffix)).exists() for s in FOLLOWING
                for suffix in ('.intent.json', '.json', '.stop.json')), 'LATER_STAGE_ALREADY_STARTED')
    archive = root / 'release-images.tar.gz'
    require(manifest['files']['release-images.tar.gz']['sha256'] == ARCHIVE_SHA, 'ARCHIVE_BINDING_CHANGED')
    wanted = {v.removeprefix('sha256:'): k for k, v in CONFIG_IDS.items()}
    descriptors = {v.removeprefix('sha256:'): k for k, v in MANIFEST_IDS.items()}
    configs, found = {}, set()
    with tarfile.open(archive, 'r|gz') as stream:
        for member in stream:
            digest = member.name.removeprefix('blobs/sha256/')
            if member.name == 'blobs/sha256/' + digest and digest in wanted.keys() | descriptors.keys():
                require(member.isfile() and member.size <= 32768 and digest not in found, 'ARCHIVE_METADATA_INVALID')
                raw = stream.extractfile(member).read(32769)
                require(hashlib.sha256(raw).hexdigest() == digest, 'ARCHIVE_METADATA_HASH')
                found.add(digest)
                value = cmod.decode(raw)
                if digest in wanted:
                    configs[wanted[digest]] = value
                else:
                    require(value['config']['digest'] == CONFIG_IDS[descriptors[digest]], 'MANIFEST_CONFIG_LINK_CHANGED')
    require(len(found) == 4 and set(configs) == {'candidate', 'return'}, 'ARCHIVE_METADATA_MISSING')
    images = {}
    for role in ('candidate', 'return'):
        commit = binding['candidate' if role == 'candidate' else 'returnCommit']
        tag = 'fai-crm:r05-' + ('candidate' if role == 'candidate' else 'recovery') + '-' + commit
        try:
            observed = cmod.decode(c.docker('IMAGE_METADATA_' + role.upper(), 'image', 'inspect', tag, '--format', IMAGE_FORMAT, seconds=10))
            images[role] = image_evidence(role, observed, configs, binding)
        except cmod.Stop as exc:
            images[role] = {'availableByQualifiedTag': False, 'code': exc.code, 'details': exc.details}
    states = {}
    for role in ('app', 'postgres'):
        value = cmod.decode(c.docker('CONTAINER_METADATA_' + role.upper(), 'container', 'inspect', target[role + 'Id'], '--format', STATE_FORMAT, seconds=10))
        require(value['id'] == target[role + 'Id'] and value['image'] == target[role + 'Image'], 'LIVE_CONTAINER_IDENTITY_CHANGED')
        states[role] = {'identityMatches': True, 'running': value['running'], 'health': value['health'], 'restartCount': value['restartCount']}
    engine_public = {k: engine[k] for k in ('version', 'driver')}
    engine_public['containerdSnapshotter'] = any(row == ['driver-type', 'io.containerd.snapshotter.v1'] for row in engine['driverStatus'] or [])
    return {'protocol': PROTOCOL, 'runId': RUN, 'status': 'OBSERVATION_COMPLETE', 'observedUtc': cmod.utc(),
            'readOnly': True, 'productionMutationPerformed': False, 'agentRealKeyAccess': False,
            'engine': engine_public, 'images': images, 'containers': states, 'laterStagesNotStarted': True,
            'historicalReceiptsPreserved': True, 'releaseAdmitted': False}


def owner_read():
    require(len(sys.argv) == 1, 'NO_ARGUMENTS_ALLOWED')
    package = LOCAL / ('M1-R21-' + RUN)
    require(sha(package / 'package.json') == PACKAGE_SHA, 'LOCAL_PACKAGE_CHANGED')
    common = verified_module(package / 'common.py', COMMON_SHA, 'common')
    owner = verified_module(package / 'owner_release.py', OWNER_SHA, 'image_observer_owner_admission')
    out_path = LOCAL / 'DIAGNOSI-IMMAGINI-R22' / 'RICEVUTA.json'
    require(not out_path.exists(), 'READ_RECEIPT_EXISTS_DO_NOT_REPEAT')
    stage = 'LOCAL_ADMISSION'
    result = None
    try:
        owner.admit(common.load(package / 'package.json'))
        stage = 'REMOTE_OBSERVATION'
        print('Lettura mirata delle immagini sul server; massimo 3 minuti. Nessun rilascio viene avviato.', flush=True)
        rc, stdout, stderr = owner.call(owner.SSH_ARGS + ['python3 -I -B -S -'], 130, data=Path(__file__).read_bytes())
        if rc == 0:
            result = common.decode(stdout)
            require(result['protocol'] == PROTOCOL and result['runId'] == RUN and result['readOnly'] is True,
                    'UNEXPECTED_OBSERVATION')
        else:
            try:
                remote = common.decode(stdout)
                require(remote['protocol'] == PROTOCOL and remote['readOnly'] is True, 'UNEXPECTED_REMOTE_ERROR')
            except (ValueError, KeyError, common.Stop):
                remote = None
            result = {'protocol': PROTOCOL, 'status': 'STOP', 'stage': stage, 'sshExit': rc,
                      'code': remote['code'] if remote else owner.ssh_error(stderr), 'details': remote.get('details', {}) if remote else {},
                      'readOnly': True, 'productionMutationPerformed': False, 'agentRealKeyAccess': False}
    except BaseException as exc:
        code = getattr(exc, 'code', str(exc))
        result = {'protocol': PROTOCOL, 'status': 'STOP', 'stage': stage,
                  'code': code if re.fullmatch('[A-Z0-9_]{1,100}', code) else 'LOCAL_ERROR_REDACTED',
                  'readOnly': True, 'productionMutationPerformed': False, 'agentRealKeyAccess': False}
    common.exclusive(out_path, result)
    print(common.canonical(result).decode(), flush=True)
    print('Ricevuta salvata. Codex puo leggerla direttamente; non occorre copiarla.', flush=True)
    return 0 if result.get('status') == 'OBSERVATION_COMPLETE' else 2


if __name__ == '__main__':
    if os.name == 'nt':
        raise SystemExit(owner_read())
    try:
        print(json.dumps(remote_read(), separators=(',', ':')), flush=True)
    except BaseException as exc:
        code = getattr(exc, 'code', str(exc))
        print(json.dumps({'protocol': PROTOCOL, 'status': 'STOP', 'readOnly': True,
                          'code': code if re.fullmatch('[A-Z0-9_]{1,100}', code) else 'REMOTE_ERROR_REDACTED',
                          'details': getattr(exc, 'details', {})}, separators=(',', ':')), flush=True)
        raise SystemExit(2)
