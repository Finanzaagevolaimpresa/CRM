"""Resolve OCI config digests only through the exact qualified archive hash."""
import hashlib
import re
import tarfile

from common import decode, digest, need


def complete_binding(archive, binding):
    need(digest(archive) == binding['imageArchiveSha256'], 'QUALIFIED_ARCHIVE_CHANGED')
    selected = {}
    for role in ('candidate', 'return'):
        image = binding[role + 'Image']
        need(image.startswith('sha256:') and len(image) == 71, 'IMAGE_DIGEST_INVALID')
        selected['blobs/sha256/' + image[7:]] = role
    found = {}
    with tarfile.open(archive, 'r|gz') as stream:
        for member in stream:
            if member.name not in selected:
                continue
            role = selected[member.name]
            need(member.isfile() and 0 < member.size <= 32768 and role not in found,
                 'QUALIFIED_MANIFEST_INVALID')
            raw = stream.extractfile(member).read(32769)
            need(hashlib.sha256(raw).hexdigest() == binding[role + 'Image'][7:], 'MANIFEST_DIGEST')
            manifest = decode(raw)
            need(manifest.get('schemaVersion') == 2, 'OCI_MANIFEST_VERSION')
            config = manifest.get('config') if isinstance(manifest, dict) else None
            need(isinstance(config, dict) and
                 re.fullmatch('sha256:[0-9a-f]{64}', str(config.get('digest', ''))),
                 'OCI_MANIFEST_CONFIG_LINK_INVALID')
            found[role] = config['digest']
    need(set(found) == {'candidate', 'return'}, 'QUALIFIED_MANIFEST_MISSING')
    result = dict(binding)
    for role, value in found.items():
        # The source CI used classic Docker config IDs. The deployment daemon
        # uses OCI manifest IDs. Both immutable identities must link through
        # this very archive; they are not interchangeable inspect arguments.
        need(value == binding[role + 'CiImage'], 'QUALIFIED_CI_CONFIG_LINK')
        result[role + 'ConfigDigest'] = value
    # The existing verifier subsequently hashes/parses both configs and checks
    # platform, source labels and layers. No tag-only identity is accepted.
    return result
