"""Synthetic process boundaries only. Never contact Docker, DB or providers."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("ordinary_trigger", Path(__file__).resolve().parents[2] / "scripts/ordinary-email/trigger.py")
trigger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trigger)


def manifest():
    return {"protocol": "FAI_ORDINARY_EMAIL_TRIGGER_V1", "sourceCommit": "a" * 40, "sourceTree": "b" * 40,
            "runtimeImageId": "sha256:" + "c" * 64, "appId": "d" * 64,
            "streamId": "12345678-abcd-4abc-8abc-123456789abc",
            "activationPlanSha256": "e" * 64, "activationReceiptSha256": "f" * 64}


def runner(result, calls, change=None):
    def run(args, timeout=20):
        calls.append(args)
        if args[:3] == ["docker", "container", "inspect"]:
            m = manifest()
            app = {"Id": m["appId"], "Image": m["runtimeImageId"],
                   "State": {"Running": True, "Paused": False, "Health": {"Status": "healthy"}},
                   "Config": {"Labels": {"org.opencontainers.image.revision": m["sourceCommit"],
                                        "it.finanzaagevolaimpresa.source-tree": m["sourceTree"]}}}
            if change:
                change(app)
            return json.dumps([app])
        if isinstance(result, Exception):
            raise result
        return json.dumps(result)
    return run


class TriggerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.journal = Path(self.temp.name) / "journal.jsonl"
        self.calls = []
        # Windows permissions are not POSIX; the real Linux gate is tested in CI.
        self.patches = []
        if os.name != "posix":
            self.patches = [patch.object(trigger, "private_file", lambda path: path.stat()),
                            patch.object(trigger.os, "O_NOFOLLOW", 0, create=True)]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def test_idle_performs_exactly_one_native_invocation(self):
        r = trigger.execute(manifest(), self.journal, runner({"status": "IDLE"}, self.calls))
        self.assertEqual(r, {"status": "IDLE"})
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.calls[1], ["docker", "exec", "--workdir", "/app", "d" * 64,
                         "node", "--import", "tsx", "scripts/ordinary-email/receive-once.ts",
                         "--stream", manifest()["streamId"]])
        self.assertEqual(trigger.current_state(self.journal), "READY")

    def test_committed_counts_are_minimized(self):
        result = {"status": "COMMITTED", "cursorVersion": 2, "insertedCount": 1, "duplicateCount": 0, "conflictCount": 0}
        self.assertEqual(trigger.execute(manifest(), self.journal, runner(result, self.calls)), result)
        self.assertNotIn("password", self.journal.read_text())

    def test_failure_latches_and_next_tick_does_not_invoke_any_process(self):
        first = trigger.execute(manifest(), self.journal, runner({"status": "DENIED"}, self.calls))
        self.assertEqual(first, {"status": "LATCHED"})
        count = len(self.calls)
        self.assertEqual(trigger.execute(manifest(), self.journal, runner({"status": "IDLE"}, self.calls)), first)
        self.assertEqual(len(self.calls), count)

    def test_timeout_or_lost_result_latches_without_retry(self):
        trigger.execute(manifest(), self.journal, runner(TimeoutError(), self.calls))
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(trigger.current_state(self.journal), "LATCHED")

    def test_unfinished_prior_invocation_never_opens_another_connection(self):
        trigger.append(self.journal, {"kind": "STARTED", "runId": "prior"})
        self.assertEqual(trigger.execute(manifest(), self.journal, runner({"status": "IDLE"}, self.calls)), {"status": "LATCHED"})
        self.assertEqual(self.calls, [])

    def test_changed_runtime_identity_denies_before_exec(self):
        r = trigger.execute(manifest(), self.journal, runner({"status": "IDLE"}, self.calls,
                    lambda app: app.update(Image="sha256:" + "0" * 64)))
        self.assertEqual(r["status"], "LATCHED")
        self.assertEqual(len(self.calls), 1)

    def test_unexpected_payload_and_excess_counts_are_not_logged(self):
        for result in ({"status": "IDLE", "secret": "SYNTHETIC_UNEXPECTED"},
                       {"status": "COMMITTED", "cursorVersion": 1, "insertedCount": 26, "duplicateCount": 0, "conflictCount": 0}):
            with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as folder:
                path = Path(folder) / "journal.jsonl"
                self.assertEqual(trigger.execute(manifest(), path, runner(result, self.calls)), {"status": "LATCHED"})
                self.assertNotIn("SYNTHETIC_UNEXPECTED", path.read_text())

    def test_manifest_cannot_choose_command_or_destination(self):
        for changes in ({"streamId": "id; command"}, {"command": "anything"}, {"appId": "fai-crm-app-1"}):
            with self.subTest(changes=changes), self.assertRaises((trigger.Denied, ValueError)):
                trigger.execute({**manifest(), **changes}, self.journal, runner({"status": "IDLE"}, self.calls))
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
