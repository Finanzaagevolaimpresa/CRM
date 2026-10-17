"""One bounded, explicitly enrolled IMAP invocation. No retry or outbound SMTP.
A failed/lost run latches this local append-only journal until reconciliation.
The timer must be installed separately from a reviewed activation receipt.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys
import uuid


class Denied(Exception):
    pass


def need(value):
    if not value:
        raise Denied("ORDINARY_EMAIL_TRIGGER_DENIED")


def validate_manifest(value):
    need(type(value) is dict and set(value) == {
        "protocol", "sourceCommit", "sourceTree", "runtimeImageId", "appId",
        "streamId", "activationPlanSha256", "activationReceiptSha256"})
    need(value["protocol"] == "FAI_ORDINARY_EMAIL_TRIGGER_V1")
    for key in ("sourceCommit", "sourceTree"):
        need(isinstance(value[key], str) and re.fullmatch("[a-f0-9]{40}", value[key]))
    for key in ("appId", "activationPlanSha256", "activationReceiptSha256"):
        need(isinstance(value[key], str) and re.fullmatch("[a-f0-9]{64}", value[key]))
    need(isinstance(value["runtimeImageId"], str) and re.fullmatch("sha256:[a-f0-9]{64}", value["runtimeImageId"]))
    need(isinstance(value["streamId"], str) and str(uuid.UUID(value["streamId"])) == value["streamId"])
    return value


def private_file(path):
    info = path.lstat()
    need(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
         and info.st_nlink == 1 and info.st_mode & 0o077 == 0)
    return info


def append(path, row):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def current_state(path):
    if not path.exists():
        need(not path.is_symlink())
        return "READY"
    need(private_file(path).st_size <= 16 * 1024 * 1024)
    rows = path.read_text(encoding="utf-8").splitlines()
    need(bool(rows))
    last = json.loads(rows[-1])
    return "READY" if last.get("kind") == "COMPLETED" and last.get("status") in ("IDLE", "COMMITTED") else "LATCHED"


def command(args, timeout=20):
    result = subprocess.run(args, input="", text=True, capture_output=True, timeout=timeout)
    need(result.returncode == 0 and len(result.stdout.encode()) <= 128 * 1024)
    return result.stdout


def execute(manifest, journal, run=command):
    """Caller owns the exclusive lock. A denied invocation is never retried."""
    validate_manifest(manifest)
    if current_state(journal) != "READY":
        return {"status": "LATCHED"}
    run_id = str(uuid.uuid4())
    append(journal, {"kind": "STARTED", "runId": run_id,
                    "utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    "planSha256": manifest["activationPlanSha256"]})
    try:
        rows = json.loads(run(["docker", "container", "inspect", "fai-crm-app-1"]))
        need(isinstance(rows, list) and len(rows) == 1)
        app = rows[0]
        labels = app.get("Config", {}).get("Labels") or {}
        need(app.get("Id") == manifest["appId"] and app.get("Image") == manifest["runtimeImageId"]
             and app.get("State", {}).get("Running") is True and app["State"].get("Paused") is False
             and app["State"].get("Health", {}).get("Status") == "healthy"
             and labels.get("org.opencontainers.image.revision") == manifest["sourceCommit"]
             and labels.get("it.finanzaagevolaimpresa.source-tree") == manifest["sourceTree"])
        raw = run(["docker", "exec", "--workdir", "/app", manifest["appId"],
                   "node", "--import", "tsx", "scripts/ordinary-email/receive-once.ts",
                   "--stream", manifest["streamId"]], timeout=85)
        need(len(raw.encode()) <= 4096)
        result = json.loads(raw)
        need(type(result) is dict)
        if result.get("status") == "IDLE":
            need(set(result) == {"status"})
        else:
            need(set(result) == {"status", "cursorVersion", "insertedCount", "duplicateCount", "conflictCount"}
                 and result["status"] == "COMMITTED"
                 and type(result["cursorVersion"]) is int and result["cursorVersion"] > 0)
            counts = [result[k] for k in ("insertedCount", "duplicateCount", "conflictCount")]
            need(all(type(v) is int and 0 <= v <= 25 for v in counts) and sum(counts) <= 25)
        append(journal, {"kind": "COMPLETED", "runId": run_id, **result})
        return result
    except Exception:
        append(journal, {"kind": "FAILED", "runId": run_id, "status": "LATCHED"})
        return {"status": "LATCHED"}


def main():
    need(os.name == "posix" and socket.gethostname() == "fai-crm-prod-02")
    need(command(["id", "-un"]).strip() == "faiadmin")
    need(len(sys.argv) == 3 and re.fullmatch("[a-f0-9]{64}", sys.argv[2]))
    path = Path(sys.argv[1])
    need(path.is_absolute() and path.name == "inbound-manifest.json" and not path.parent.is_symlink())
    parent = path.parent.lstat()
    need(stat.S_ISDIR(parent.st_mode) and parent.st_uid == os.geteuid() and parent.st_mode & 0o077 == 0)
    need(private_file(path).st_size <= 4096)
    raw = path.read_bytes()
    need(hashlib.sha256(raw).hexdigest() == sys.argv[2])
    manifest = validate_manifest(json.loads(raw))
    import fcntl
    fd = os.open(path.parent / "inbound.lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"status": "BUSY"}
        return execute(manifest, path.parent / "inbound-journal.jsonl")


if __name__ == "__main__":
    os.umask(0o077)
    try:
        result = main()
    except Exception:
        result = {"status": "DENIED"}
    print(json.dumps(result, sort_keys=True))
    sys.exit(0 if result["status"] in ("IDLE", "COMMITTED", "BUSY") else 2)
