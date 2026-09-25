"""Agent-side client: fixed files and operations; no credentials or shell calls."""
import datetime as dt
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid

CANDIDATE = "fb645e014653ee87dc64f2439970967192f91b62"
TASK = "01a0c20b-b096-78a3-b6f6-db9153b914fe"
INBOX = Path(r"C:\Users\Utente\.codex\visualizations\2026\09\21\01a0c20b-b096-78a3-b6f6-db9153b914fe\m1-owner-channel-r18")
STATE = Path(r"C:\ProgramData\FAI-CRM-M1-CHANNEL-R18")


class Stop(Exception):
    pass


def need(ok, code):
    if not ok:
        raise Stop(code)


def unique(pairs):
    result = {}
    for key, value in pairs:
        need(key not in result, "DUPLICATE_JSON_FIELD")
        result[key] = value
    return result


def read(path, limit=32768):
    with path.open("rb") as stream:
        data = stream.read(limit + 1)
    need(len(data) <= limit, "RECEIPT_SIZE")
    result = json.loads(data.decode("utf-8"), object_pairs_hook=unique,
                        parse_constant=lambda _: (_ for _ in ()).throw(Stop("JSON_CONSTANT")))
    need(isinstance(result, dict), "JSON_OBJECT_REQUIRED")
    return result


def request(inbox, state, operation, timeout=185, sleep=time.sleep):
    """The CLI never accepts paths, timeout overrides, or extra request fields."""
    need(operation in ("status", "observe", "reconcile", "collect"), "OPERATION_NOT_ALLOWED")
    pending = inbox / "request.json"
    if operation == "collect":
        need(pending.exists(), "NO_PENDING_REQUEST")
        item = read(pending, 2048)
    else:
        need(inbox.is_dir() and state.is_dir(), "CHANNEL_NOT_INSTALLED")
        if pending.exists():
            need(operation == "reconcile", "REQUEST_EXISTS_USE_COLLECT")
            old = read(pending, 2048)
            old_id = old.get("requestId")
            need(isinstance(old_id, str) and re.fullmatch("[0-9a-f]{32}", old_id), "REQUEST_ID_INVALID")
            # Explicit reconciliation preserves the previous nonce and bytes,
            # and creates a fresh read. Never resubmit the previous request.
            os.rename(pending, inbox / ("retained-" + old_id + "-" + uuid.uuid4().hex + ".json"))
        ready = read(state / "ready.json", 4096)
        need(ready.get("protocol") == "FAI_M1_FILE_CHANNEL_READY_R18" and
             ready.get("candidate") == CANDIDATE and ready.get("taskId") == TASK and
             ready.get("readOnly") is True and ready.get("productionMutationCapability") is False and
             ready.get("agentRealKeyAccess") is False, "CHANNEL_READY_INVALID")
        session = ready.get("sessionId")
        need(isinstance(session, str) and re.fullmatch("[0-9a-f]{32}", session), "CHANNEL_SESSION_INVALID")
        item = dict(protocol="FAI_M1_FILE_REQUEST_R18", candidate=CANDIDATE, taskId=TASK,
                    sessionId=session, requestId=uuid.uuid4().hex, operation=operation,
                    expiresUtc=(dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=3)).strftime("%Y-%m-%dT%H:%M:%SZ"))
        staging = inbox / ("publish-" + item["requestId"] + ".tmp")
        with staging.open("xb") as stream:
            stream.write(json.dumps(item, separators=(",", ":")).encode("utf-8"))
            stream.flush()
            os.fsync(stream.fileno())
        # Windows rename refuses an occupied destination; never replace a request.
        need(os.name == "nt", "WINDOWS_REQUIRED")
        os.rename(staging, pending)
    rid = item.get("requestId")
    need(isinstance(rid, str) and re.fullmatch("[0-9a-f]{32}", rid), "REQUEST_ID_INVALID")
    receipt = state / ("receipt-" + rid + ".json")
    deadline = time.monotonic() + timeout
    while True:
        if receipt.exists():
            result = read(receipt)
            need(result.get("protocol") == "FAI_M1_FILE_RECEIPT_R18" and result.get("candidate") == CANDIDATE and
                 result.get("taskId") == TASK and result.get("requestId") == rid and
                 result.get("sessionId") == item.get("sessionId") and result.get("operation") == item.get("operation") and
                 result.get("status") in ("OK", "STOP") and result.get("readOnly") is True and
                 result.get("agentRealKeyAccess") is False and result.get("productionMutationPerformed") is False,
                 "RECEIPT_BINDING_INVALID")
            # Consume only this local request after its immutable receipt exists.
            # If another writer changed the file, preserve it and require inspection.
            need(read(pending, 2048) == item, "REQUEST_CHANGED_PRESERVED")
            pending.unlink()
            return result
        if time.monotonic() >= deadline:
            # Preserve pending bytes/nonce; collect never republishes or invokes.
            return dict(protocol="FAI_M1_FILE_CLIENT_R18", status="UNCERTAIN",
                        code="RECEIPT_NOT_OBSERVED_DO_NOT_REPEAT", requestId=rid,
                        requestPreserved=True, automaticRetry=False)
        sleep(1)


def main():
    try:
        need(len(sys.argv) == 2, "ONE_OPERATION_REQUIRED")
        result = request(INBOX, STATE, sys.argv[1])
    except Stop as exc:
        result = dict(protocol="FAI_M1_FILE_CLIENT_R18", status="STOP", code=str(exc))
    except FileNotFoundError:
        result = dict(protocol="FAI_M1_FILE_CLIENT_R18", status="STOP", code="CHANNEL_FILE_NOT_AVAILABLE")
    except Exception:
        result = dict(protocol="FAI_M1_FILE_CLIENT_R18", status="STOP", code="LOCAL_CLIENT_ERROR_REDACTED")
    print(json.dumps(result, separators=(",", ":")))
    return 0 if result.get("status") == "OK" else 2


if __name__ == "__main__":
    sys.exit(main())
