"""Synthetic admission, fault and recovery tests; no SSH, Docker or real files."""
import copy
import importlib.util
import io
import json
import pathlib
import subprocess
import time
import unittest
from contextlib import redirect_stdout
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("owner_backup46", pathlib.Path(__file__).with_name("owner_backup46.py"))
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)


def packet():
    plan = {
        "protocol": s.PROTOCOL, "runId": "a" * 32, "sourceCommit": s.SOURCE, "sourceTree": s.TREE,
        "schema": 46, "databaseName": "fai_crm", "ownerReceiptSha256": "b" * 64,
        "retention": "PRESERVE_EXISTING_LOCAL_AND_F_COPIES",
        "expectedLedger": {f"20260101{i:06d}_invented": "c" * 64 for i in range(46)},
        "target": {"hostname": "fai-crm-prod-02", "user": "faiadmin", "engineId": "11111111-1111-1111-1111-111111111111",
            "appId": "1" * 64, "postgresId": "2" * 64, "networkId": "3" * 64,
            "appImage": "sha256:" + "4" * 64, "postgresImage": "sha256:" + "5" * 64},
    }
    return {"plan": plan, "approval": {"status": "OWNER_EXPLICITLY_AUTHORIZED", "confirmation": s.CONFIRMATION,
        "planSha256": s.sha(plan), "programSha256": "f" * 64, "launcherSha256": "e" * 64,
        "reviewReference": "synthetic-review-test-only"}}


def model():
    return {"services": {"postgres": {}, "app": {"image": "sha256:" + "4" * 64, "environment": {
        "FEATURE_INTEGRATIONS_ENABLED": "false", "FEATURE_AI_WORKER_ENABLED": "false", "FEATURE_AI_DISPATCH_ENABLED": "false",
        "FEATURE_AI_EGRESS_ENABLED": "false", "AI_EXTERNAL_PROVIDERS_ENABLED": "false", "AI_ORCHESTRATOR_WORKER_ENABLED": "0",
        "AI_PROVIDER": "mock", "WEBSITE_LEAD_MODE": "disabled", "INTERNAL_SESSION_MODE": "legacy",
        "PRIVILEGED_ACCESS_MODE": "disabled", "AUTH_SECRET": "synthetic-never-a-real-key"}}},
        "volumes": {k: {"name": "fai-crm_" + k, "external": True} for k in ("crm_documents", "postgres_data")},
        "networks": {"default": {"name": "fai-crm_default", "external": True}}}


class AdmissionTests(unittest.TestCase):
    def test_complete_exact_approval(self):
        p = packet()
        self.assertEqual(s.validate_packet(p, "f" * 64), p["plan"])

    def test_no_approval_never_constructs_operation(self):
        p = packet(); p["approval"] = None
        out = io.StringIO()
        with patch.object(s, "Backup") as operation, redirect_stdout(out):
            self.assertEqual(s.entry_point(p, "f" * 64), 2)
            operation.assert_not_called()
        self.assertEqual(json.loads(out.getvalue())["code"], "EXPLICIT_APPROVAL_REQUIRED")

    def test_changed_plan_invalidates_approval(self):
        p = packet(); p["plan"]["target"]["appId"] = "6" * 64
        with self.assertRaisesRegex(s.Stop, "APPROVAL_DIGEST_MISMATCH"):
            s.validate_packet(p, "f" * 64)

    def test_changed_program_invalidates_approval(self):
        with self.assertRaisesRegex(s.Stop, "APPROVAL_DIGEST_MISMATCH"):
            s.validate_packet(packet(), "e" * 64)

    def test_old_schema_and_source_are_not_accepted(self):
        for key, value in (("schema", 43), ("sourceCommit", "e" * 40)):
            p = packet(); p["plan"][key] = value
            with self.subTest(key=key), self.assertRaisesRegex(s.Stop, "SOURCE_BINDING"):
                s.validate_packet(p, "f" * 64)

    def test_missing_review_is_not_accepted(self):
        p = packet(); p["approval"]["reviewReference"] = ""
        with self.assertRaisesRegex(s.Stop, "REVIEW_REFERENCE_REQUIRED"):
            s.validate_packet(p, "f" * 64)

    def test_path_injection_has_no_packet_field(self):
        p = packet(); p["plan"]["outputDirectory"] = "/elsewhere"
        with self.assertRaisesRegex(s.Stop, "PLAN_FIELDS"):
            s.validate_packet(p, "f" * 64)

    def test_duplicate_json_keys_and_nonfinite_numbers(self):
        for text in ('{"plan":1,"plan":2}', '{"a":NaN}'):
            with self.subTest(text=text), self.assertRaises(s.Stop):
                s.strict_json(text)

    def test_error_values_never_leak(self):
        self.assertEqual(s.denial(RuntimeError("sensitive-value=do-not-print")), "OPERATION_FAILED")


class LedgerModelTests(unittest.TestCase):
    def setUp(self):
        self.inventory = packet()["plan"]["expectedLedger"]
        self.rows = [[k, v, "started", "finished", "", "1"] for k, v in self.inventory.items()]

    def test_complete_canonical_ledger(self):
        s.validate_ledger(self.rows, self.inventory)

    def test_same_count_changed_checksum_rejected(self):
        self.rows[0][1] = "d" * 64
        with self.assertRaisesRegex(s.Stop, "LEDGER_CHECKSUM_OR_NAME_DRIFT"):
            s.validate_ledger(self.rows, self.inventory)

    def test_duplicate_migration_rejected(self):
        self.rows[0] = self.rows[1]
        with self.assertRaisesRegex(s.Stop, "LEDGER_CHECKSUM_OR_NAME_DRIFT"):
            s.validate_ledger(self.rows, self.inventory)

    def test_unfinished_or_rolled_back_or_count43_rejected(self):
        for rows in (self.rows[:43], [self.rows[0][:3] + ["", "", "1"]] + self.rows[1:],
                     [self.rows[0][:4] + ["rolled-back", "1"]] + self.rows[1:]):
            with self.subTest(rows=rows[0]), self.assertRaises(s.Stop):
                s.validate_ledger(rows, self.inventory)

    def test_closed_model(self):
        s.validate_model(model(), "sha256:" + "4" * 64)

    def test_real_activation_or_file_key_is_not_admitted(self):
        for key, value in (("AI_PROVIDER", "real"), ("INTERNAL_SESSION_MODE", "registry"),
                           ("PRACTICE_READINESS_MODE", "internal"), ("INTERNAL_ENGAGEMENT_MODE", "controlled"),
                           ("LEAD_IDENTITY_KEY_FILE", "/synthetic-key")):
            m = model(); m["services"]["app"]["environment"][key] = value
            with self.subTest(key=key), self.assertRaises(s.Stop):
                s.validate_model(m, "sha256:" + "4" * 64)

    def test_extra_services_or_managed_volume_rejected(self):
        m = model(); m["services"]["worker"] = {}
        with self.assertRaises(s.Stop): s.validate_model(m, "sha256:" + "4" * 64)
        m = model(); m["volumes"]["crm_documents"]["external"] = False
        with self.assertRaises(s.Stop): s.validate_model(m, "sha256:" + "4" * 64)


class OperationTests(unittest.TestCase):
    def setUp(self):
        self.o = s.Backup(packet()["plan"])
        self.o.before = {"app": {"id": "1" * 64, "created": "original", "image_id": self.o.target["appImage"]}}

    def test_expired_budget_never_starts_subprocess(self):
        self.o.monotonic -= 1300
        with patch.object(s.subprocess, "Popen") as popen, self.assertRaisesRegex(s.Stop, "ORIGINAL_EXECUTION_BUDGET_EXPIRED"):
            self.o.run(["invented"])
        popen.assert_not_called()

    def test_wall_clock_rollback_does_not_extend_monotonic_budget(self):
        self.o.started += 10000; self.o.monotonic -= 1300
        with self.assertRaises(s.Stop): self.o.remaining()

    def test_emergency_budget_is_bounded_by_original_start(self):
        self.o.emergency = True; self.o.monotonic -= 1600
        with self.assertRaises(s.Stop): self.o.remaining()

    def failure_after_stop(self, at):
        writes = []
        def run(*args, **kwargs):
            raise s.Stop("SYNTHETIC_BACKUP_FAILURE")
        with patch.object(self.o, "same_source"), patch.object(self.o, "rows", return_value=[]), \
             patch.object(self.o, "check_inputs"), patch.object(self.o, "write", side_effect=lambda p,v: writes.append(p.name)), \
             patch.object(self.o, "docker", side_effect=s.Stop("SYNTHETIC_LOST_STOP_REPLY") if at == "stop" else None), \
             patch.object(self.o, "inspect", return_value={"Id":"1"*64,"Created":"original","State":{"Running":False,"Pid":0}}), \
             patch.object(self.o, "run", side_effect=run), patch.object(self.o, "resume") as resume:
            with self.assertRaises(s.Stop): self.o.create()
            resume.assert_called_once()
        self.assertTrue(self.o.quiescence_attempted)
        self.assertNotIn("BACKUP_VERIFIED.json", writes)

    def test_lost_stop_reply_still_enters_resume(self): self.failure_after_stop("stop")
    def test_backup_preflight_failure_still_enters_resume(self): self.failure_after_stop("backup")

    def test_resume_does_not_start_substituted_container(self):
        raw={"Id":"1"*64,"Created":"substituted","Image":self.o.target["appImage"],"State":{"Running":False}}
        with patch.object(self.o,"inspect",return_value=raw), patch.object(self.o,"docker") as docker:
            with self.assertRaisesRegex(s.Stop,"RESUME_IDENTITY"): self.o.resume()
            docker.assert_not_called()

    def test_resume_revalidates_before_start_and_marks_success_after_health(self):
        raw={"Id":"1"*64,"Created":"original","Image":self.o.target["appImage"],"State":{"Running":False}}
        healthy=copy.deepcopy(raw); healthy["State"]={"Running":True,"Health":{"Status":"healthy"}}
        with patch.object(self.o,"inspect",side_effect=[raw,healthy]), patch.object(self.o,"same_source") as same, \
             patch.object(self.o,"docker") as docker:
            self.o.resume()
        self.assertTrue(self.o.app_resumed)
        self.assertEqual(same.call_args_list[0].kwargs,{"healthy":False})
        docker.assert_called_once_with("start","1"*64)

    def test_resume_with_persistence_drift_never_starts_app(self):
        raw={"Id":"1"*64,"Created":"original","Image":self.o.target["appImage"],"State":{"Running":False}}
        with patch.object(self.o,"inspect",return_value=raw), patch.object(self.o,"same_source",side_effect=s.Stop("PERSISTENCE_DRIFT")), \
             patch.object(self.o,"docker") as docker:
            with self.assertRaisesRegex(s.Stop,"PERSISTENCE_DRIFT"): self.o.resume()
            docker.assert_not_called()

    def test_helper_substitution_never_stops_or_removes_resource(self):
        ref={"id":"6"*64,"created":"original","image":self.o.target["appImage"],"absent":False}
        with patch.object(self.o,"helper",return_value=ref|{"created":"other"}), patch.object(self.o,"docker") as docker:
            with self.assertRaisesRegex(s.Stop,"HELPER_SUBSTITUTED"): self.o.stop_helper(ref)
            docker.assert_not_called()

    def test_fast_helper_requires_trusted_stdout_identity_and_absence(self):
        cid="6"*64; proc=Mock(); proc.returncode=0
        proc.communicate.return_value=(("N05_BACKUP_HELPER_REMOVED|container_id="+cid+"\n").encode(),b"")
        with patch.object(pathlib.Path,"exists",return_value=False), patch.object(s.subprocess,"Popen",return_value=proc), \
             patch.object(self.o,"helper",return_value={"id":cid,"absent":True}) as helper, patch.object(self.o,"write"):
            self.o.supervise_backup()
            self.assertEqual(helper.call_count,2)

    def test_unknown_helper_on_failure_never_adopts_or_deletes(self):
        proc=Mock(); proc.returncode=1; proc.poll.return_value=1; proc.communicate.return_value=(b"",b"private-error")
        with patch.object(pathlib.Path,"exists",return_value=False), patch.object(s.subprocess,"Popen",return_value=proc), \
             patch.object(self.o,"stop_helper") as stop, patch.object(self.o,"docker") as docker:
            with self.assertRaisesRegex(s.Stop,"BACKUP_HELPER_IDENTITY_UNCERTAIN"): self.o.supervise_backup()
            stop.assert_not_called(); docker.assert_not_called()

    def test_database_restart_is_detected(self):
        pg={"Id":"2"*64,"Image":self.o.target["postgresImage"],"Created":"original","RestartCount":0,
            "State":{"StartedAt":"before","Running":True,"Health":{"Status":"healthy"}}}
        with patch.object(self.o,"inspect",return_value=pg): self.o.pg_state=self.o.check_pg_state()
        pg["State"]["StartedAt"]="after"
        with patch.object(self.o,"inspect",return_value=pg), self.assertRaisesRegex(s.Stop,"POSTGRES_RESTART_OR_IDENTITY_DRIFT"):
            self.o.check_pg_state()

    def test_wrapper_always_has_explicit46_and_source_identity(self):
        env=self.o.backup_environment()
        self.assertEqual(env["EXPECTED_MIGRATION_COUNT"],"46")
        self.assertEqual(env["SOURCE_COMMIT"],s.SOURCE)
        self.assertEqual(env["EXPECTED_APP_IMAGE_ID"],self.o.target["appImage"])
        self.assertEqual(env["BACKUP_CONSISTENCY"],"application-quiesced")

    def create_result(self, resume_failure=False):
        writes=[]
        raw={"Id":"1"*64,"Created":"original","State":{"Running":False,"Pid":0}}
        def resumed():
            if resume_failure: raise s.Stop("RESUME_HEALTH_TIMEOUT")
            self.o.app_resumed=True
        def wrote(path,value):
            writes.append((path.name,self.o.app_resumed))
        with patch.object(self.o,"same_source",return_value={"app":{"state":"exited"}}), \
             patch.object(self.o,"rows",return_value=[]), patch.object(self.o,"check_inputs"), \
             patch.object(self.o,"write",side_effect=wrote), patch.object(self.o,"docker"), \
             patch.object(self.o,"inspect",return_value=raw), patch.object(self.o,"run",return_value=b"synthetic"), \
             patch.object(self.o,"supervise_backup",return_value=b"synthetic"), patch.object(self.o,"resume",side_effect=resumed), \
             patch.object(s,"read_stable",return_value=b"synthetic"), \
             patch.object(pathlib.Path,"open",return_value=io.BytesIO(b"synthetic")):
            if resume_failure:
                with self.assertRaisesRegex(s.Stop,"RESUME_HEALTH_TIMEOUT"): self.o.create()
            else:
                result=self.o.create()
                self.assertTrue(result["appResumedHealthy"])
                self.assertFalse(result["offHostEncryptedCopiesCreated"])
                self.assertFalse(result["migration47Applied"])
        return writes

    def test_success_receipt_is_written_only_after_source_health(self):
        writes=self.create_result()
        self.assertEqual(writes[-1],("BACKUP_VERIFIED.json",True))

    def test_no_success_receipt_if_source_resume_fails(self):
        self.assertNotIn("BACKUP_VERIFIED.json",[name for name,_ in self.create_result(True)])


if __name__ == "__main__":
    unittest.main(verbosity=2)
