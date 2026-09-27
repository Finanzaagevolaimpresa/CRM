"""Exact M2 artifact, bounded ranges using the already qualified M1 transport."""
import os
from pathlib import Path
import time
import zipfile

from common import decode, digest, exclusive, need, private
import transport_base as transport

ARTIFACT = 10917328245
ZIP_BYTES = 543122869
ZIP_SHA = 'b20440ece95afd14b9421ecebeac6f58ee766e8b49083b91d2cf2a67eb496f23'
IMAGE_SHA = '3e0dd8b4ff7cd0d82fde2f7445334e1f764bd11042154f70905a171747cd7dc2'
CANDIDATE = '7ab126f8a2ef385c3e720f190eda80f26f61ae39'
RUN = 36276199090


def extract(path,root):
    need(path.stat().st_size == ZIP_BYTES and digest(path) == ZIP_SHA,'QUALIFIED_ZIP_MISMATCH')
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        need(len(entries) <= 100 and len({e.filename for e in entries}) == len(entries),'ZIP_ENTRY_LIMIT')
        name = 'release-images.tar.gz'
        item = archive.getinfo(name)
        need(0 < item.file_size <= 1024**3 and not item.is_dir(),'IMAGE_ARCHIVE_SIZE')
        receipt_entry = archive.getinfo('release-receipt.json')
        need(0 < receipt_entry.file_size <= 65536,'IMAGE_RECEIPT_SIZE')
        receipt = decode(archive.read(receipt_entry))
        need(receipt['candidateCommit'] == CANDIDATE and receipt['imageArchiveSha256'] == IMAGE_SHA and
             receipt['status'] == 'CI_SCHEMA48_M1_APPLICATION_RETURN_PASS' and receipt['synthetic'] is True,
             'QUALIFICATION_RECEIPT_MISMATCH')
        target = root/name
        with archive.open(item) as source,target.open('xb') as output:
            remaining = item.file_size
            while remaining:
                block = source.read(min(1024*1024,remaining))
                need(block,'IMAGE_ARCHIVE_TRUNCATED')
                output.write(block)
                remaining -= len(block)
            need(not source.read(1),'IMAGE_ARCHIVE_EXTRA_BYTES')
            output.flush(); os.fsync(output.fileno())
        need(digest(private(target)) == IMAGE_SHA,'QUALIFIED_IMAGE_HASH')
        return {'bytes':target.stat().st_size,'sha256':IMAGE_SHA,'artifactId':ARTIFACT,'zipSha256':ZIP_SHA}


def acquire(root,manifest):
    from completed_backup import reconcile, image_reference
    proof = reconcile()
    need(manifest['imageArchiveSha256'] == IMAGE_SHA, 'REUSED_IMAGE_BINDING')
    result = image_reference()
    exclusive(root/'images-acquired.json', result | {'reconciliation':proof, 'productionMutationPerformed':False})
    return result
