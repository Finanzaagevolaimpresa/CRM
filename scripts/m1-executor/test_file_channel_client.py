import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("client", Path(__file__).with_name("file_channel_client.py"))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="fai-file-client-"))
        self.inbox = self.root / "inbox"
        self.state = self.root / "state"
        self.inbox.mkdir()
        self.state.mkdir()
        (self.state / "ready.json").write_text(json.dumps(dict(
            protocol="FAI_M1_FILE_CHANNEL_READY_R18", candidate=c.CANDIDATE, taskId=c.TASK,
            sessionId="a" * 32, readOnly=True, productionMutationCapability=False, agentRealKeyAccess=False)))

    def receipt(self, corrupt=False):
        item = c.read(self.inbox / "request.json")
        value = dict(protocol="FAI_M1_FILE_RECEIPT_R18", candidate=c.CANDIDATE, taskId=c.TASK,
                     requestId=item["requestId"], sessionId=item["sessionId"], operation=item["operation"],
                     status="OK", readOnly=True, agentRealKeyAccess=corrupt, productionMutationPerformed=False)
        (self.state / ("receipt-" + item["requestId"] + ".json")).write_text(json.dumps(value))
        return value

    def test_completed_request_consumed_once_receipt_preserved(self):
        result = c.request(self.inbox, self.state, "status", sleep=lambda _: self.receipt())
        self.assertEqual(result["status"], "OK")
        self.assertFalse((self.inbox / "request.json").exists())
        self.assertEqual(len(list(self.state.glob("receipt-*"))), 1)

    def test_timeout_never_republishes_and_collect_only_reads(self):
        result = c.request(self.inbox, self.state, "observe", timeout=0)
        self.assertEqual(result["status"], "UNCERTAIN")
        original = (self.inbox / "request.json").read_bytes()
        with self.assertRaisesRegex(c.Stop, "REQUEST_EXISTS_USE_COLLECT"):
            c.request(self.inbox, self.state, "observe", timeout=0)
        self.assertEqual((self.inbox / "request.json").read_bytes(), original)
        self.receipt()
        collected = c.request(self.inbox, self.state, "collect", timeout=0)
        self.assertEqual(collected["requestId"], result["requestId"])

    def test_invalid_receipt_preserves_request(self):
        with self.assertRaisesRegex(c.Stop, "RECEIPT_BINDING_INVALID"):
            c.request(self.inbox, self.state, "observe", sleep=lambda _: self.receipt(True))
        self.assertTrue((self.inbox / "request.json").exists())

    def test_reconcile_retains_previous_nonce_without_retry(self):
        first = c.request(self.inbox, self.state, "observe", timeout=0)
        before = (self.inbox / "request.json").read_bytes()
        second = c.request(self.inbox, self.state, "reconcile", timeout=0)
        self.assertNotEqual(first["requestId"], second["requestId"])
        history = list(self.inbox.glob("retained-*"))
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0].read_bytes(), before)
        self.assertEqual(c.read(self.inbox / "request.json")["operation"], "reconcile")

    def test_wrong_channel_refused_before_publish(self):
        ready = c.read(self.state / "ready.json")
        ready["candidate"] = "other"
        (self.state / "ready.json").write_text(json.dumps(ready))
        with self.assertRaisesRegex(c.Stop, "CHANNEL_READY_INVALID"):
            c.request(self.inbox, self.state, "observe", timeout=0)
        self.assertFalse((self.inbox / "request.json").exists())

    def test_arbitrary_operation_and_duplicate_keys(self):
        with self.assertRaisesRegex(c.Stop, "OPERATION_NOT_ALLOWED"):
            c.request(self.inbox, self.state, "deploy", timeout=0)
        (self.state / "ready.json").write_text('{"sessionId":"a","sessionId":"b"}')
        with self.assertRaisesRegex(c.Stop, "DUPLICATE_JSON_FIELD"):
            c.request(self.inbox, self.state, "status", timeout=0)

    def test_native_collect_reconcile_interleaving_cannot_delete_replacement(self):
        original = c.request(self.inbox, self.state, "observe", timeout=0)
        self.receipt()
        pending = self.inbox / "request.json"
        old_bytes = pending.read_bytes()
        parse = c.parse
        parsed_requests = 0
        concurrent = []

        def interleave(data, limit):
            nonlocal parsed_requests
            result = parse(data, limit)
            if result.get("protocol") == "FAI_M1_FILE_REQUEST_R18":
                parsed_requests += 1
                if parsed_requests == 2:  # Verification inside the consume handle.
                    def reconcile():
                        try:
                            c.request(self.inbox, self.state, "reconcile", timeout=0)
                        except c.Stop as exc:
                            concurrent.append(str(exc))
                    other = threading.Thread(target=reconcile)
                    other.start()
                    other.join(2)
                    self.assertFalse(other.is_alive())
                    self.assertEqual(concurrent, ["CHANNEL_CLIENT_BUSY"])
                    # Even a non-cooperating writer cannot replace the file
                    # whose open handle is being verified and consumed.
                    with self.assertRaises(PermissionError):
                        pending.rename(self.inbox / "replacement-attempt.json")
                    with self.assertRaises(PermissionError):
                        pending.write_bytes(b'{"replacement":true}')
                    self.assertEqual(data, old_bytes)
            return result

        with mock.patch.object(c, "parse", side_effect=interleave):
            collected = c.request(self.inbox, self.state, "collect", timeout=0)
        self.assertEqual(parsed_requests, 2)
        self.assertEqual(concurrent, ["CHANNEL_CLIENT_BUSY"])
        self.assertEqual(collected["requestId"], original["requestId"])
        self.assertFalse(pending.exists())
        self.assertEqual(len(list(self.state.glob("receipt-*"))), 1)
        replacement = c.request(self.inbox, self.state, "reconcile", timeout=0)
        self.assertNotEqual(replacement["requestId"], original["requestId"])
        self.assertEqual(c.read(pending)["requestId"], replacement["requestId"])

    def test_client_lock_released_after_exception(self):
        (self.state / "ready.json").write_text('{"bad":true}')
        for _ in range(2):
            with self.assertRaisesRegex(c.Stop, "CHANNEL_READY_INVALID"):
                c.request(self.inbox, self.state, "status", timeout=0)

    def test_changed_request_preserved_by_handle(self):
        c.request(self.inbox, self.state, "observe", timeout=0)
        pending = self.inbox / "request.json"
        before = pending.read_bytes()
        with self.assertRaisesRegex(c.Stop, "REQUEST_CHANGED_PRESERVED"):
            c.consume_verified(pending, {"wrong": "request"})
        self.assertEqual(pending.read_bytes(), before)

    def test_broker_read_contention_retries_only_local_consumption(self):
        original = c.request(self.inbox, self.state, "observe", timeout=0)
        self.receipt()
        pending = self.inbox / "request.json"
        before = pending.read_bytes()
        with mock.patch.object(c, "consume_verified", side_effect=c.Stop("CHANNEL_FILE_BUSY")):
            stopped = c.request(self.inbox, self.state, "collect", timeout=0)
        self.assertEqual(stopped["code"], "RECEIPT_READY_REQUEST_BUSY_PRESERVED")
        self.assertEqual(pending.read_bytes(), before)
        consume = c.consume_verified
        calls = 0

        def once(path, expected):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise c.Stop("CHANNEL_FILE_BUSY")
            return consume(path, expected)

        with mock.patch.object(c, "consume_verified", side_effect=once):
            result = c.request(self.inbox, self.state, "collect", timeout=1, sleep=lambda _: None)
        self.assertEqual(calls, 2)
        self.assertEqual(result["requestId"], original["requestId"])
        self.assertFalse(pending.exists())
        self.assertEqual(len(list(self.state.glob("receipt-*"))), 1)


if __name__ == "__main__":
    unittest.main()
