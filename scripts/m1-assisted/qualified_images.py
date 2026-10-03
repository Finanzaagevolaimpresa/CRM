"""Verify existing OCI images against the saved, qualified archive; never load/build."""
import hashlib
import re
import tarfile

from common import decode, digest, need


IMAGE_FORMAT = ('{"id":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}},'
                '"layers":{{json .RootFS.Layers}},"tags":{{json .RepoTags}},'
                '"commit":{{json (index .Config.Labels "org.opencontainers.image.revision")}},'
                '"tree":{{json (index .Config.Labels "it.finanzaagevolaimpresa.source-tree")}}}')


def archive_metadata(archive, binding):
    need(digest(archive) == binding['imageArchiveSha256'], 'QUALIFIED_ARCHIVE_CHANGED')
    wanted = {}
    for role in ('candidate', 'return'):
        for kind in ('Image', 'ConfigDigest'):
            value = binding[role + kind]
            need(re.fullmatch('sha256:[0-9a-f]{64}', value), 'QUALIFIED_DIGEST_INVALID')
            need(value not in wanted, 'QUALIFIED_DIGEST_DUPLICATE')
            wanted[value] = (role, kind)
    found = {}
    with tarfile.open(archive, 'r|gz') as stream:
        for member in stream:
            value = 'sha256:' + member.name.removeprefix('blobs/sha256/')
            if member.name == 'blobs/sha256/' + value[7:] and value in wanted:
                need(member.isfile() and 0 < member.size <= 32768 and value not in found,
                     'QUALIFIED_ARCHIVE_METADATA_INVALID')
                raw = stream.extractfile(member).read(32769)
                need(hashlib.sha256(raw).hexdigest() == value[7:], 'QUALIFIED_METADATA_DIGEST')
                found[value] = decode(raw)
    need(set(found) == set(wanted), 'QUALIFIED_ARCHIVE_METADATA_MISSING')
    configs = {}
    for role in ('candidate', 'return'):
        manifest, config = found[binding[role + 'Image']], found[binding[role + 'ConfigDigest']]
        need(manifest['config']['digest'] == binding[role + 'ConfigDigest'], 'QUALIFIED_MANIFEST_CONFIG_LINK')
        need(config['os'] == 'linux' and config['architecture'] == 'amd64', 'QUALIFIED_PLATFORM')
        labels = config['config']['Labels']
        commit = binding['candidate' if role == 'candidate' else 'returnCommit']
        need(labels['org.opencontainers.image.revision'] == commit and
             labels['it.finanzaagevolaimpresa.source-tree'] == binding[role + 'Tree'], 'QUALIFIED_ARCHIVE_PROVENANCE')
        configs[role] = config
    return configs


def verify_images(commands, archive, binding):
    configs = archive_metadata(archive, binding)
    engine = decode(commands.docker('QUALIFIED_IMAGE_STORE', 'info', '--format',
        '{"version":{{json .ServerVersion}},"driver":{{json .Driver}},"status":{{json .DriverStatus}}}'))
    need(engine['version'] == binding['imageStoreVersion'] and engine['driver'] == 'overlayfs' and
         ['driver-type', 'io.containerd.snapshotter.v1'] in (engine['status'] or []), 'IMAGE_STORE_RECONCILIATION_REQUIRED')
    proof = {}
    for role in ('candidate', 'return'):
        raw = decode(commands.docker('QUALIFIED_IMAGE_' + role.upper(), 'image', 'inspect',
                                     binding[role + 'Image'], '--format', IMAGE_FORMAT))
        commit = binding['candidate' if role == 'candidate' else 'returnCommit']
        tag = 'fai-crm:r05-' + ('candidate' if role == 'candidate' else 'recovery') + '-' + commit
        need(raw['id'] == binding[role + 'Image'] and raw['os'] == configs[role]['os'] and
             raw['architecture'] == configs[role]['architecture'] and
             raw['layers'] == configs[role]['rootfs']['diff_ids'] and tag in (raw['tags'] or []) and
             raw['commit'] == commit and raw['tree'] == binding[role + 'Tree'], 'QUALIFIED_IMAGE_PROVENANCE')
        proof[role] = {'imageId': raw['id'], 'configDigest': binding[role + 'ConfigDigest'],
                       'archiveLinkVerified': True, 'layersAndLabelsVerified': True}
    return proof
