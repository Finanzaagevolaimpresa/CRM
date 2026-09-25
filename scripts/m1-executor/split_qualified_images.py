"""Transport an already qualified archive without rebuilding or running images."""
import hashlib
import json
from pathlib import Path
import sys

IMAGE_ARCHIVE_SHA256 = "fadbed9be809e18e6d6afc4b123532edf7d0115a86e52e2e1e7bce16e245b2e7"
CHUNK_BYTES = 300 * 1024 * 1024


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024*1024), b""):
            h.update(block)
    return h.hexdigest()


def split(source, destination, expected, chunk_bytes=CHUNK_BYTES):
    if source.is_symlink() or not source.is_file() or source.stat().st_size > 2*chunk_bytes:
        raise ValueError("SOURCE_TYPE_OR_SIZE_INVALID")
    if digest(source) != expected:
        raise ValueError("QUALIFIED_IMAGE_ARCHIVE_HASH_MISMATCH")
    destination.mkdir()  # Never replace or reuse existing output.
    parts = []
    with source.open("rb") as stream:
        for index in range(2):
            data = stream.read(chunk_bytes)
            if not data:
                break
            folder = destination / ("part-%02d" % index)
            folder.mkdir()
            path = folder / ("release-images.tar.gz.part%02d" % index)
            with path.open("xb") as output:
                output.write(data)
            parts.append({"file": str(path.relative_to(destination)).replace("\\", "/"),
                          "bytes": path.stat().st_size, "sha256": digest(path)})
        if stream.read(1):
            raise ValueError("SOURCE_GREW_DURING_COPY")
    reconstructed = hashlib.sha256()
    for part in parts:
        with (destination / part["file"]).open("rb") as stream:
            for block in iter(lambda: stream.read(1024*1024), b""):
                reconstructed.update(block)
    if not parts or reconstructed.hexdigest() != expected:
        raise ValueError("REASSEMBLY_HASH_MISMATCH")
    manifest = {"protocol": "FAI_M1_QUALIFIED_IMAGE_TRANSPORT_R18",
                "sourceRunId": 36021069464, "sourceArtifactId": 10817321285,
                "candidate": "fb645e014653ee87dc64f2439970967192f91b62",
                "imageArchiveSha256": expected, "parts": parts,
                "imagesRebuilt": False, "imagesExecuted": False,
                "verification": "INNER_IMAGE_ARCHIVE_SHA256_AND_REASSEMBLY"}
    for part in parts:
        (destination / part["file"]).parent.joinpath("transport.json").write_text(
            json.dumps(manifest, sort_keys=True, indent=2), encoding="utf-8")
    return manifest


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("FIXED_SOURCE_ARCHIVE_AND_NEW_DESTINATION_REQUIRED")
    print(json.dumps(split(Path(sys.argv[1]), Path(sys.argv[2]), IMAGE_ARCHIVE_SHA256), sort_keys=True))
