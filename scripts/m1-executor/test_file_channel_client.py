import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

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


if __name__ == "__main__":
    unittest.main()
