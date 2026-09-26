"""Resolve OCI config digests only through the exact qualified archive hash."""
import hashlib
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
            found[role] = manifest['config']['digest']
    need(set(found) == {'candidate', 'return'}, 'QUALIFIED_MANIFEST_MISSING')
    result = dict(binding)
    for role, value in found.items():
        result[role + 'ConfigDigest'] = value
    # The existing verifier subsequently hashes/parses both configs and checks
    # platform, source labels and layers. No tag-only identity is accepted.
    return result
