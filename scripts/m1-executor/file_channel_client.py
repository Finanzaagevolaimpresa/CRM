"""Agent-side client: fixed files and operations; no credentials or shell calls."""
import datetime as dt
import contextlib
import ctypes
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


def parse(data, limit):
    need(len(data) <= limit, "RECEIPT_SIZE")
    result = json.loads(data.decode("utf-8"), object_pairs_hook=unique,
                        parse_constant=lambda _: (_ for _ in ()).throw(Stop("JSON_CONSTANT")))
    need(isinstance(result, dict), "JSON_OBJECT_REQUIRED")
    return result


class FileInfo(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in (
        "attributes", "creationLow", "creationHigh", "accessLow", "accessHigh",
        "writeLow", "writeHigh", "volume", "sizeHigh", "sizeLow", "links",
        "indexHigh", "indexLow")]


def kernel():
    need(os.name == "nt", "WINDOWS_REQUIRED")
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    api.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32,
                               ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
    api.CreateFileW.restype = ctypes.c_void_p
    api.GetFileInformationByHandle.argtypes = [ctypes.c_void_p, ctypes.POINTER(FileInfo)]
    api.GetFileInformationByHandle.restype = ctypes.c_int
    api.GetFinalPathNameByHandleW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32]
    api.GetFinalPathNameByHandleW.restype = ctypes.c_uint32
    api.ReadFile.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32), ctypes.c_void_p]
    api.ReadFile.restype = ctypes.c_int
    api.SetFileInformationByHandle.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    api.SetFileInformationByHandle.restype = ctypes.c_int
    api.CloseHandle.argtypes = [ctypes.c_void_p]
    api.CloseHandle.restype = ctypes.c_int
    return api


@contextlib.contextmanager
def opened(path, access, share, creation, busy_code="CHANNEL_FILE_BUSY"):
    api = kernel()
    handle = api.CreateFileW(str(path), access, share, None, creation, 0x00200000, None)
    if handle == ctypes.c_void_p(-1).value or handle is None:
        error = ctypes.get_last_error()
        if error in (2, 3):
            raise FileNotFoundError()
        raise Stop(busy_code if error in (32, 33) else "CHANNEL_FILE_OPEN_FAILED")
    try:
        info = FileInfo()
        need(api.GetFileInformationByHandle(handle, ctypes.byref(info)), "CHANNEL_FILE_METADATA_FAILED")
        need(not info.attributes & (0x400 | 0x10) and info.links == 1, "CHANNEL_LINK_OR_TYPE_DENIED")
        name = ctypes.create_unicode_buffer(1024)
        count = api.GetFinalPathNameByHandleW(handle, name, 1024, 0)
        expected = "\\\\?\\" + str(path.absolute())
        need(0 < count < 1024 and os.path.normcase(name.value) == os.path.normcase(expected), "CHANNEL_PATH_CHANGED")
        yield api, handle, info
    finally:
        api.CloseHandle(handle)


def contents(api, handle, info, limit):
    need(info.sizeHigh == 0 and info.sizeLow <= limit, "RECEIPT_SIZE")
    buffer = ctypes.create_string_buffer(limit + 1)
    count = ctypes.c_uint32()
    need(api.ReadFile(handle, buffer, limit + 1, ctypes.byref(count), None) and count.value == info.sizeLow,
         "CHANNEL_FILE_READ_FAILED")
    return parse(buffer.raw[:count.value], limit)


def read(path, limit=32768):
    with opened(path, 0x80000000, 1, 3) as (api, handle, info):
        return contents(api, handle, info, limit)


def consume_verified(path, expected):
    # Read+DELETE access without sharing write/delete freezes the identity and
    # contents until close. Disposition is applied to that same verified handle,
    # never to a path that another client could replace between check and unlink.
    with opened(path, 0x80010000, 1, 3) as (api, handle, info):
        need(contents(api, handle, info, 2048) == expected, "REQUEST_CHANGED_PRESERVED")
        disposition = ctypes.c_ubyte(1)  # FILE_DISPOSITION_INFO.DeleteFile
        need(api.SetFileInformationByHandle(handle, 4, ctypes.byref(disposition), ctypes.sizeof(disposition)),
             "REQUEST_CONSUMPTION_FAILED_PRESERVED")


def request(inbox, state, operation, timeout=185, sleep=time.sleep):
    need(operation in ("status", "observe", "reconcile", "collect"), "OPERATION_NOT_ALLOWED")
    need(inbox.is_dir() and state.is_dir(), "CHANNEL_NOT_INSTALLED")
    # Crash-safe OS handle lock, not an existence marker. It serializes publish,
    # collect and reconcile across processes, including the receipt wait window.
    with opened(inbox / "client.lock", 0xC0000000, 0, 4, "CHANNEL_CLIENT_BUSY"):
        return request_locked(inbox, state, operation, timeout, sleep)


def request_locked(inbox, state, operation, timeout, sleep):
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
            try:
                consume_verified(pending, item)
            except Stop as exc:
                if str(exc) != "CHANNEL_FILE_BUSY":
                    raise
                # A broker read can briefly deny DELETE sharing. Retry only the
                # local receipt consumption, never publication/provider execution.
                if time.monotonic() < deadline:
                    sleep(0.05)
                    continue
                return dict(protocol="FAI_M1_FILE_CLIENT_R18", status="UNCERTAIN",
                            code="RECEIPT_READY_REQUEST_BUSY_PRESERVED", requestId=rid,
                            requestPreserved=True, automaticRetry=False)
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
