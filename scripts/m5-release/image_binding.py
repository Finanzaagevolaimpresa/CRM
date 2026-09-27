"""Derive runtime OCI manifests only from the exact qualified archive/config IDs."""
import hashlib
import tarfile
from common import decode, digest, need
from qualified_images import archive_metadata


def complete_binding(archive, binding):
    need(digest(archive) == binding['imageArchiveSha256'],'QUALIFIED_ARCHIVE_CHANGED')
    found = {}
    wanted = {binding[role+'CiImage']:role for role in ('candidate','return')}
    need(len(wanted) == 2,'QUALIFIED_CONFIG_COLLISION')
    with tarfile.open(archive,'r|gz') as stream:
        for member in stream:
            if not member.name.startswith('blobs/sha256/') or not member.isfile() or not 0 < member.size <= 32768:
                continue
            raw = stream.extractfile(member).read(32769)
            if not raw.lstrip().startswith(b'{'): continue
            value = decode(raw)
            if not isinstance(value,dict) or value.get('schemaVersion') != 2: continue
            config = value.get('config',{})
            if not isinstance(config,dict) or config.get('digest') not in wanted: continue
            role = wanted[config['digest']]
            sha = 'sha256:'+hashlib.sha256(raw).hexdigest()
            need(member.name == 'blobs/sha256/'+sha[7:] and role not in found,'QUALIFIED_MANIFEST_AMBIGUOUS')
            found[role] = sha
    need(set(found) == {'candidate','return'},'QUALIFIED_MANIFEST_MISSING')
    resolved = dict(binding)
    for role,sha in found.items():
        need(binding.get(role+'Image',sha) == sha,'QUALIFIED_RUNTIME_IMAGE_CHANGED')
        resolved[role+'Image'] = sha
        resolved[role+'ConfigDigest'] = binding[role+'CiImage']
    archive_metadata(archive,resolved)
    return resolved
