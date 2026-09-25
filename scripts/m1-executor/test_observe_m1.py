"""Pure synthetic tests: never invokes SSH, Docker or a database."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("m1observe", Path(__file__).with_name("observe_m1.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def binding():
    return {"candidate": m.CANDIDATE, "engineId": "0"*8+"-"+"0"*4+"-"+"0"*4+"-"+"0"*4+"-"+"0"*12,
            "appId": "a"*64, "postgresId": "b"*64, "appImage": "sha256:"+"c"*64,
            "postgresImage": "sha256:"+"d"*64, "networkId": "e"*64,
            "ledger": {"202601%08d_synthetic" % i: hashlib.sha256(str(i).encode()).hexdigest() for i in range(46)}}


def ledger():
    return [{"migration_name": k, "checksum": v, "finished": True, "rolled_back": False, "steps": 1}
            for k, v in binding()["ledger"].items()]


class FakeObserver(m.Observer):
    def __init__(self):
        super().__init__(binding())
        self.calls = []
        self.rows = ledger()
        self.extra_container = False
        self.key_digest = hashlib.sha256(b"synthetic-not-a-production-secret-000").hexdigest()
        self.key_version = 7
        self.key_status = "ACTIVE"
        self.pg_healthy = True
        self.source = m.SOURCE
        self.mutate_after = False
        self.container_reads = 0
        self.flag_override = {}

    def run(self, args, code, data=None):
        self.calls.append((args, data))
        if args[0] == "/usr/bin/git":
            return self.source+"\n"+m.TREE if "rev-parse" in args else ""
        self.assert_docker(args)
        a = args[3:]
        if a[0] == "info":
            return self.b["engineId"]
        if a[:2] == ["container", "inspect"]:
            self.container_reads += 1
            pg = a[-1] == self.b["postgresId"]
            role = "postgres" if pg else "app"
            return json.dumps({"id": self.b[role+"Id"], "image": self.b[role+"Image"],
                "project": "fai-crm", "service": role, "running": True,
                "health": "healthy" if not pg or self.pg_healthy else "unhealthy",
                "startedAt": "2026-09-20T18:00:00.000Z",
                "restarts": 1 if self.mutate_after and self.container_reads > 2 else 0,
                "networks": {"fai-crm_default": {"NetworkID": self.b["networkId"]}},
                "mounts": [{"type": "volume", "name": "fai-crm_postgres_data" if pg else "fai-crm_crm_documents",
                            "destination": "/var/lib/postgresql/data" if pg else "/var/lib/fai-crm/documents"}]})
        if a[:2] == ["image", "inspect"]:
            return m.SOURCE+" "+m.TREE
        if a[0] == "ps":
            return "\n".join([self.b["appId"], self.b["postgresId"]] + (["f"*64] if self.extra_container else []))
        if a[:2] == ["exec", "-i"]:
            assert data == m.SQL.encode()
            return json.dumps({"database": "fai_crm", "ledger": self.rows, "keys": [
                {"version": self.key_version, "status": self.key_status, "activated": True, "retired": False, "digest": self.key_digest}],
                "liveSessions": 0, "otherActiveSessions": 0})
        if a[:3] == ["exec", self.b["appId"], "node"]:
            return json.dumps({"version": 7, "configured": True,
                               "digest": hashlib.sha256(b"synthetic-not-a-production-secret-000").hexdigest(),
                               "flags": m.FLAGS | {"INTERNAL_SESSION_MODE": "legacy", "PRIVILEGED_ACCESS_MODE": "disabled"} | self.flag_override})
        raise AssertionError("Unexpected command")

    @staticmethod
    def assert_docker(args):
        assert args[:3] == m.DOCKER


def run_fake(observer):
    fake_pwd = types.SimpleNamespace(getpwuid=lambda _: types.SimpleNamespace(pw_name="faiadmin"))
    with patch.dict(sys.modules, {"pwd": fake_pwd}), patch.object(m.socket, "gethostname", return_value="fai-crm-prod-02"), \
         patch.object(m.os, "geteuid", return_value=1000, create=True), \
         patch.object(m.os, "statvfs", return_value=types.SimpleNamespace(f_bavail=100000, f_frsize=4096), create=True):
        return observer.observe()


class Tests(unittest.TestCase):
    def test_complete_bounded_observation_never_admits_release(self):
        f = FakeObserver()
        result = run_fake(f)
        self.assertTrue(result["baselineMatches"])
        self.assertTrue(result["stepUpDigestMatches"])
        self.assertFalse(result["releaseAdmitted"])
        self.assertEqual(result["recipientEvidence"], "UNATTESTED")
        self.assertNotIn("digest", json.dumps(result))
        self.assertTrue(all(args[3] in ("info", "container", "image", "ps", "exec")
                            for args, _ in f.calls if args[0] == "/usr/bin/docker"))

    def test_failed_or_partial_migrations_stop(self):
        for field, value in (("finished", False), ("rolled_back", True), ("steps", 0), ("checksum", "0"*64)):
            with self.subTest(field=field):
                f = FakeObserver(); f.rows[0][field] = value
                with self.assertRaisesRegex(m.Stop, "LEDGER46_DRIFT_OR_INCOMPLETE"):
                    run_fake(f)

    def test_duplicate_ledger_rejected(self):
        f = FakeObserver(); f.rows[0] = copy.deepcopy(f.rows[1])
        with self.assertRaises(m.Stop): run_fake(f)

    def test_drift_stops_before_key_inspection(self):
        for field, value, code in (("source", "0"*40, "SOURCE_REVISION_DRIFT"),
                                   ("pg_healthy", False, "CONTAINER_NOT_HEALTHY"),
                                   ("extra_container", True, "COMPETING_CONTAINER_PRESENT"),
                                   ("mutate_after", True, "CONTAINER_CHANGED_DURING_OBSERVATION")):
            with self.subTest(field=field):
                f = FakeObserver(); setattr(f, field, value)
                with self.assertRaisesRegex(m.Stop, code): run_fake(f)

    def test_external_gate_cannot_be_silently_enabled(self):
        f = FakeObserver(); f.flag_override = {"FEATURE_AI_DISPATCH_ENABLED": "true"}
        with self.assertRaisesRegex(m.Stop, "EXTERNAL_GATES_NOT_CLOSED"): run_fake(f)

    def test_key_mismatch_is_evidence_not_permission_to_provision(self):
        for field, value in (("key_digest", "0"*64), ("key_version", 9), ("key_status", "RETIRED")):
            with self.subTest(field=field):
                f = FakeObserver(); setattr(f, field, value)
                result = run_fake(f)
                self.assertFalse(result["stepUpDigestMatches"])
                self.assertFalse(result["releaseAdmitted"])

    def test_binding_has_no_path_or_command_escape(self):
        for field, value in (("path", "/etc/shadow"), ("command", "id"), ("appId", "a;id"), ("candidate", "0"*40)):
            b = binding(); b[field] = value
            with self.assertRaises(m.Stop): m.validate_binding(b)

    def test_json_duplicates_and_nan_rejected(self):
        for raw in ('{"x":1,"x":2}', '{"x":NaN}', '{"x":Infinity}'):
            with self.assertRaises(m.Stop): m.strict_json(raw)

    def test_subprocess_failure_never_exports_raw_stderr(self):
        with patch.object(m.subprocess, "run", return_value=types.SimpleNamespace(returncode=1, stdout=b"", stderr=b"SENSITIVE_VALUE")):
            with self.assertRaisesRegex(m.Stop, "^COMMAND_FAILED_DATABASE_READ$"):
                m.Observer(binding()).run(["unused"], "DATABASE_READ")

    def test_sql_is_read_only_and_has_time_limits(self):
        self.assertIn("READ ONLY", m.SQL)
        self.assertIn("statement_timeout='8s'", m.SQL)
        for word in ("INSERT ", "UPDATE ", "DELETE ", "ALTER ", "CREATE "):
            self.assertNotIn(word, m.SQL)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--write-synthetic-binding":
        Path(sys.argv[2]).write_text(json.dumps(binding(), sort_keys=True), encoding="utf-8")
    else:
        unittest.main()
