#!/usr/bin/env python3
"""Export only the recovery test inputs; never clone local Git/config/history.

Original commit and tree objects are retained byte for byte, with only the
whitelisted blobs. This intentionally incomplete object store is a test fixture,
not a replacement for the repository or a release source archive.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]
FILES = (
    "scripts/n05/recovery_kit.py", "scripts/n05/lib.sh",
    "scripts/n05/verify-backup-manifest.sh", "scripts/n05/backup-compose.sh",
    "scripts/backup-docker-prod.sh", "docker-compose.restore-drill.yml",
    "docker-compose.prod.example.yml", "docker-compose.staging.example.yml",
    "tests/n05/recovery_drill.py", "tests/n05/test_recovery_kit.py",
)


def git(*args, data=None, root=ROOT):
    p = subprocess.run(["git", "-C", str(root), *args], input=data,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if p.returncode:
        raise RuntimeError("CONTEXT_GIT_OPERATION_FAILED")
    return p.stdout


def export(destination, source_commit):
    destination = Path(destination)
    if not destination.is_absolute() or destination.exists() or destination.is_symlink():
        raise RuntimeError("CONTEXT_REQUIRES_NEW_ABSOLUTE_DESTINATION")
    for p in destination.parents:
        if p.is_symlink():
            raise RuntimeError("CONTEXT_SYMLINK_DENIED")
    head = git("rev-parse", "HEAD").decode().strip()
    if not re.fullmatch("[a-f0-9]{40}", source_commit):
        raise RuntimeError("CONTEXT_SOURCE_COMMIT_INVALID")
    object_ids = {head, source_commit}
    files = {}
    for commit in (head, source_commit):
        if git("ls-tree", commit, "--", "CRM TXT.txt").strip():
            raise RuntimeError("PROTECTED_TRACKED_PATH_DENIED")
        object_ids.add(git("rev-parse", commit + "^{tree}").decode().strip())
        for raw in git("ls-tree", "-r", "-t", "-z", commit).split(b"\0"):
            if not raw:
                continue
            prefix, name = raw.split(b"\t", 1)
            mode, kind, oid = prefix.decode().split()
            name = name.decode()
            if kind == "tree":
                object_ids.add(oid)
            elif (commit == head and name in FILES) or re.fullmatch(
                    r"prisma/migrations/[A-Za-z0-9_-]+/migration\.sql", name):
                if mode != "100644" and mode != "100755":
                    raise RuntimeError("CONTEXT_REGULAR_BLOB_REQUIRED")
                object_ids.add(oid)
                if commit == head:
                    files[name] = (oid, mode)
    if not set(FILES) <= set(files):
        raise RuntimeError("CONTEXT_INPUT_MISSING")
    # pack-objects receives only explicit object IDs, without --revs or history walk.
    packed = git("pack-objects", "--stdout", data=("\n".join(sorted(object_ids)) + "\n").encode())
    destination.mkdir(mode=0o700)
    metadata = destination / ".git"
    (metadata / "objects").mkdir(parents=True, mode=0o700)
    (metadata / "refs/heads").mkdir(parents=True, mode=0o700)
    (metadata / "HEAD").write_text(head + "\n", encoding="ascii")
    (metadata / "config").write_text("[core]\nrepositoryformatversion = 0\nbare = false\n", encoding="ascii")
    (metadata / "shallow").write_text("\n".join(sorted({head, source_commit})) + "\n", encoding="ascii")
    git("index-pack", "--stdin", data=packed, root=destination)
    manifest = {}
    for name, (oid, mode) in sorted(files.items()):
        contents = git("cat-file", "blob", oid)
        path = destination / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(contents)
        path.chmod(0o755 if mode == "100755" else 0o644)
        manifest[name] = hashlib.sha256(contents).hexdigest()
    report = {"schema": "FAI_CRM_N05_MINIMIZED_TEST_CONTEXT_V1",
              "tools_commit": head, "image_source_commit": source_commit,
              "files": manifest, "git_objects": len(object_ids),
              "git_configuration_copied": False, "history_copied": False,
              "protected_path_copied": False}
    (destination / "TEST_CONTEXT.json").write_text(json.dumps(report, sort_keys=True), encoding="utf-8")
    return report


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--destination", required=True)
    p.add_argument("--image-source", required=True)
    args = p.parse_args()
    result = export(args.destination, args.image_source)
    print(json.dumps({k: v for k, v in result.items() if k != "files"} | {"files": len(result["files"])}))
