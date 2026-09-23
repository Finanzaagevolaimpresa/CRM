"""Synthetic tests; Linux also stops two disposable process groups. No SSH/Docker."""
import copy
import importlib.util
import io
import json
import pathlib
import os
import subprocess
import sys
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

    def test_local_validator_accepts_complete_approved_packet_without_operation(self):
        with patch.object(s,"Backup") as operation:
            result=s.validate_local_packet(packet(),"f"*64,"e"*64)
        self.assertTrue(result["executionAdmitted"])
        self.assertFalse(result["remoteConnectionAttempted"])
        operation.assert_not_called()

    def test_local_validator_closes_gate_on_missing_approval(self):
        p=packet(); p["approval"]=None
        self.assertFalse(s.validate_local_packet(p,"f"*64,"e"*64)["executionAdmitted"])

    def test_locally_approved_malformed_packet_never_admitted(self):
        for kind in ("extra-plan", "missing-ledger", "bad-target", "duplicate-container"):
            p=packet()
            if kind=="extra-plan": p["plan"]["unexpected"]=True
            elif kind=="missing-ledger": p["plan"]["expectedLedger"].pop(next(iter(p["plan"]["expectedLedger"])))
            elif kind=="bad-target": p["plan"]["target"]["appId"]="invalid"
            else: p["plan"]["target"]["appId"]=p["plan"]["target"]["postgresId"]
            p["approval"]["planSha256"]=s.sha(p["plan"])
            with self.subTest(kind=kind), self.assertRaises(s.Stop):
                s.validate_local_packet(p,"f"*64,"e"*64)

    def test_local_validator_detects_launcher_drift(self):
        with self.assertRaisesRegex(s.Stop,"LAUNCHER_DIGEST_MISMATCH"):
            s.validate_local_packet(packet(),"f"*64,"d"*64)


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


class CommandDiagnosticTests(unittest.TestCase):
    def exercise_stop_receipt(self, failed_phase, resume_failure=False):
        operation = s.Backup(packet()["plan"])
        operation.before = {"app": {"id": "1" * 64, "created": "original"}}
        operation.module = Mock()
        writes = {}
        commands = []

        def spawn(args, **kwargs):
            commands.append(args)
            failed = operation.phase == failed_phase or operation.phase == "APP_RESUME"
            code = 11 if operation.phase == "APP_RESUME" else 7 if failed else 0
            raw = [{"Id": "1" * 64, "Created": "original", "State": {"Running": False, "Pid": 0}}]
            out = b"PRIVATE_STDOUT" if failed else json.dumps(raw).encode()
            return Mock(returncode=code, communicate=Mock(return_value=(out, b"Permission denied PRIVATE_STDERR" if failed else b"")))

        def resume():
            if resume_failure:
                operation.phase = "APP_RESUME"
                operation.emergency = True
                operation.docker("start", operation.target["appId"])
            operation.app_resumed = True

        out = io.StringIO()
        with patch.object(s, "Backup", return_value=operation), patch.object(s.signal, "signal"), \
             patch.object(s.os, "umask"), patch.object(operation, "prepare"), \
             patch.object(operation, "same_source"), patch.object(operation, "rows", return_value=[]), \
             patch.object(operation, "check_inputs"), patch.object(operation, "verify_process_exit"), \
             patch.object(operation, "resume", side_effect=resume), \
             patch.object(operation, "write", side_effect=lambda p,v: writes.update({p.name: copy.deepcopy(v)})), \
             patch.object(pathlib.Path, "is_dir", return_value=True), \
             patch.object(s.subprocess, "Popen", side_effect=spawn), redirect_stdout(out):
            self.assertEqual(s.entry_point(packet(), "f" * 64), 2)
        result = json.loads(out.getvalue())
        self.assertEqual(result, writes["STOP.json"])
        self.assertEqual(result["code"], "COMMAND_FAILED")
        self.assertEqual(result["diagnosticVersion"], 1)
        self.assertNotIn("BACKUP_VERIFIED.json", writes)
        self.assertFalse(result["secretValuesExported"])
        for private in ("PRIVATE_STDOUT", "PRIVATE_STDERR", "1" * 64, str(operation.root)):
            self.assertNotIn(private, out.getvalue())
        return result, commands

    def test_three_preflight_command_failures_are_distinguished_in_both_receipts(self):
        for phase, command in (("APP_QUIESCE", "DOCKER_STOP"),
                               ("APP_STOP_VERIFY", "DOCKER_APP_INSPECT"),
                               ("BACKUP_PREFLIGHT", "BACKUP_PREFLIGHT")):
            with self.subTest(phase=phase):
                result, _ = self.exercise_stop_receipt(phase)
                self.assertEqual(result["commandFailure"]["phase"], phase)
                self.assertEqual(result["commandFailure"]["commandId"], command)
                self.assertEqual(result["commandFailure"]["exitCode"], 7)
                self.assertEqual(result["commandFailure"]["errorClass"], "ACCESS_DENIED")
                self.assertTrue(result["appResumedHealthy"])
                self.assertNotIn("recoveryCommandFailure", result)

    def test_resume_failure_preserves_original_command_and_records_recovery_separately(self):
        result, _ = self.exercise_stop_receipt("BACKUP_PREFLIGHT", resume_failure=True)
        self.assertEqual(result["commandFailure"]["phase"], "BACKUP_PREFLIGHT")
        self.assertEqual(result["commandFailure"]["exitCode"], 7)
        self.assertEqual(result["recoveryCommandFailure"]["phase"], "APP_RESUME")
        self.assertEqual(result["recoveryCommandFailure"]["commandId"], "DOCKER_START")
        self.assertEqual(result["recoveryCommandFailure"]["exitCode"], 11)
        self.assertFalse(result["appResumedHealthy"])

    def test_unknown_diagnostics_cannot_export_dynamic_labels_or_error_text(self):
        operation = s.Backup(packet()["plan"])
        operation.phase = "PRIVATE_PHASE"
        operation.record_command_failure("PRIVATE_ARGUMENT", Mock(returncode=3), b"secret=value\x00\xff")
        record = operation.command_failure
        self.assertEqual(record["phase"], "UNSPECIFIED")
        self.assertEqual(record["commandId"], "UNSPECIFIED")
        self.assertEqual(record["errorClass"], "OUTPUT_REDACTED")
        self.assertNotIn("secret", s.canonical(record))
        self.assertNotIn("PRIVATE", s.canonical(record))

    def test_timeout_is_captured_before_cleanup_without_fabricated_exit_code(self):
        operation = s.Backup(packet()["plan"])
        operation.phase = "BACKUP_PREFLIGHT"
        proc = Mock(returncode=None)
        proc.communicate.side_effect = subprocess.TimeoutExpired(["PRIVATE_ARGUMENT"], 1, stderr=b"PRIVATE_STDERR")
        with patch.object(s.subprocess, "Popen", return_value=proc), \
             patch.object(operation, "terminate_process") as cleanup:
            with self.assertRaisesRegex(s.Stop, "COMMAND_INTERRUPTED_OR_EXPIRED"):
                operation.run(["PRIVATE_ARGUMENT"], command_id="BACKUP_PREFLIGHT")
        cleanup.assert_called_once_with(proc)
        self.assertIsNone(operation.command_failure["exitCode"])
        self.assertEqual(operation.command_failure["errorClass"], "COMMAND_INTERRUPTED_OR_EXPIRED")
        self.assertNotIn("PRIVATE", s.canonical(operation.command_failure))

    def test_failed_process_creation_retains_sticky_stop_guard(self):
        operation = s.Backup(packet()["plan"])
        with patch.object(s.subprocess, "Popen", side_effect=OSError("PRIVATE_ERROR")):
            with self.assertRaises(OSError):
                operation.run(["PRIVATE_ARGUMENT"], command_id="SOURCE_REVISION")
        self.assertFalse(operation.command_groups_quiet)
        self.assertIsNone(operation.command_failure["exitCode"])
        self.assertEqual(operation.command_failure["errorClass"], "PROCESS_START_FAILED")
        self.assertNotIn("PRIVATE", s.canonical(operation.command_failure))

    def test_successful_command_has_no_failure_record_and_same_output(self):
        operation = s.Backup(packet()["plan"])
        proc = Mock(returncode=0, communicate=Mock(return_value=(b"expected", b"")))
        with patch.object(s.subprocess, "Popen", return_value=proc), patch.object(operation, "verify_process_exit"):
            self.assertEqual(operation.run(["synthetic"], command_id="SOURCE_REVISION"), b"expected")
        self.assertIsNone(operation.command_failure)
        self.assertIsNone(operation.recovery_command_failure)


class OperationTests(unittest.TestCase):
    def setUp(self):
        # Native group operations are mocked on Windows; keep the Linux signal
        # number confined to this fixture instead of changing the runtime.
        native_kill=patch.object(s.signal,"SIGKILL",9,create=True)
        native_kill.start(); self.addCleanup(native_kill.stop)
        self.o = s.Backup(packet()["plan"])
        self.o.approval = packet()["approval"]
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
        cid="6"*64; proc=Mock(); proc.returncode=0; proc.poll.return_value=0
        proc.communicate.return_value=(("N05_BACKUP_HELPER_REMOVED|container_id="+cid+"\n").encode(),b"")
        with patch.object(pathlib.Path,"exists",return_value=False), patch.object(s.subprocess,"Popen",return_value=proc), \
             patch.object(self.o,"helper",return_value={"id":cid,"absent":True}) as helper, patch.object(self.o,"write"), \
             patch.object(self.o,"process_group_exists",return_value=False):
            self.o.supervise_backup()
            self.assertEqual(helper.call_count,2)

    def test_unknown_helper_on_failure_never_adopts_or_deletes(self):
        proc=Mock(); proc.returncode=1; proc.poll.return_value=1; proc.communicate.return_value=(b"",b"private-error")
        with patch.object(pathlib.Path,"exists",return_value=False), patch.object(s.subprocess,"Popen",return_value=proc), \
             patch.object(self.o,"stop_helper") as stop, patch.object(self.o,"docker") as docker, \
             patch.object(self.o,"process_group_exists",return_value=False), patch.object(self.o,"terminate_process"):
            with self.assertRaisesRegex(s.Stop,"BACKUP_HELPER_IDENTITY_UNCERTAIN"): self.o.supervise_backup()
            stop.assert_not_called(); docker.assert_not_called()
        self.assertEqual(self.o.command_failure["phase"], "BACKUP_CREATE")
        self.assertEqual(self.o.command_failure["commandId"], "BACKUP_CREATE")
        self.assertEqual(self.o.command_failure["exitCode"], 1)
        self.assertNotIn("private-error", s.canonical(self.o.command_failure))

    def test_database_restart_is_detected(self):
        pg={"Id":"2"*64,"Image":self.o.target["postgresImage"],"Created":"original","RestartCount":0,
            "State":{"StartedAt":"before","Running":True,"Health":{"Status":"healthy"}}}
        with patch.object(self.o,"inspect",return_value=pg): self.o.pg_state=self.o.check_pg_state()
        pg["State"]["StartedAt"]="after"
        with patch.object(self.o,"inspect",return_value=pg), self.assertRaisesRegex(s.Stop,"POSTGRES_RESTART_OR_IDENTITY_DRIFT"):
            self.o.check_pg_state()

    def test_restarted_initial_app_is_not_admitted(self):
        app={"Id":"1"*64,"Image":self.o.target["appImage"],"RestartCount":1,
             "State":{"Running":True,"Health":{"Status":"healthy"}}}
        with patch.object(self.o,"inspect",return_value=app), self.assertRaisesRegex(s.Stop,"BASELINE_APP_DRIFT"):
            self.o.check_initial_app()

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

    def test_reaped_leader_still_requires_attributed_group_kill(self):
        proc=Mock(pid=123456); proc.poll.return_value=0
        with patch.object(s.os,"killpg",create=True) as kill, \
             patch.object(self.o,"process_group_exists",return_value=False) as group:
            self.o.terminate_process(proc)
        kill.assert_called_once_with(proc.pid,s.signal.SIGKILL)
        group.assert_called_once_with(proc.pid)
        proc.communicate.assert_called_once()
        self.assertTrue(self.o.command_groups_quiet)

    def test_reaped_leader_does_not_skip_surviving_descendant_wait(self):
        proc=Mock(pid=123456); proc.poll.return_value=0
        with patch.object(s.os,"killpg",create=True), patch.object(s.time,"sleep"), \
             patch.object(self.o,"process_group_exists",side_effect=[True,True,False]) as group:
            self.o.terminate_process(proc)
        self.assertEqual(group.call_count,3)
        self.assertEqual(proc.communicate.call_count,3)

    def test_unverified_group_poison_survives_other_cleanup_and_blocks_resume(self):
        proc=Mock(pid=123456); proc.poll.return_value=0
        with patch.object(s.os,"killpg",create=True), patch.object(self.o,"remaining",return_value=.04), \
             patch.object(self.o,"process_group_exists",return_value=True):
            with self.assertRaisesRegex(s.Stop,"PROCESS_STOP_UNVERIFIED"):
                self.o.terminate_process(proc)
        self.assertFalse(self.o.command_groups_quiet)
        # Settling a different group cannot erase the first group's uncertainty.
        other=Mock(pid=123457); other.poll.return_value=0
        with patch.object(s.os,"killpg",create=True), patch.object(self.o,"process_group_exists",return_value=False):
            self.o.terminate_process(other)
        with patch.object(self.o,"inspect") as inspect, patch.object(self.o,"docker") as docker:
            with self.assertRaisesRegex(s.Stop,"PROCESS_STOP_UNVERIFIED"): self.o.resume()
        inspect.assert_not_called(); docker.assert_not_called()

    def test_canonical_unverified_group_also_blocks_resume(self):
        self.o.adapter=Mock()
        self.o.adapter.snapshot.side_effect=RuntimeError("LOCAL_COMMAND_STOP_UNVERIFIED")
        with self.assertRaisesRegex(RuntimeError,"LOCAL_COMMAND_STOP_UNVERIFIED"): self.o.same_source()
        with patch.object(self.o,"inspect") as inspect:
            with self.assertRaisesRegex(s.Stop,"PROCESS_STOP_UNVERIFIED"): self.o.resume()
        inspect.assert_not_called()

    def test_normal_command_cannot_hide_descendant_after_zero_exit(self):
        proc=Mock(pid=123456,returncode=0); proc.poll.return_value=0
        proc.communicate.return_value=(b"synthetic",b"")
        with patch.object(s.subprocess,"Popen",return_value=proc), patch.object(s.os,"killpg",create=True) as kill, \
             patch.object(self.o,"process_group_exists",side_effect=[True,False]):
            with self.assertRaisesRegex(s.Stop,"COMMAND_INTERRUPTED_OR_EXPIRED"): self.o.run(["synthetic"])
        kill.assert_called_once_with(proc.pid,s.signal.SIGKILL)
        self.assertTrue(self.o.command_groups_quiet)

    def test_pending_signal_stops_forward_work_before_spawn(self):
        self.o.request_interruption(s.signal.SIGINT,None)
        with patch.object(s.subprocess,"Popen") as popen:
            with self.assertRaisesRegex(s.Stop,"OWNER_EXECUTION_INTERRUPTED"): self.o.run(["synthetic"])
        popen.assert_not_called()

    def test_unverified_canonical_preparation_is_recorded(self):
        out=io.StringIO()
        with patch.object(s,"Backup",return_value=self.o), patch.object(s.signal,"signal"), \
             patch.object(self.o,"prepare",side_effect=RuntimeError("LOCAL_COMMAND_STOP_UNVERIFIED")), \
             redirect_stdout(out):
            self.assertEqual(s.entry_point(packet(),"f"*64),2)
        self.assertFalse(json.loads(out.getvalue())["localCommandGroupsQuiet"])

    def test_installed_signals_during_real_resume_do_not_skip_restart(self):
        # Exercise entry_point -> failed stop reply -> actual resume(), including
        # the installed callbacks at inspection, start and final health check.
        handlers={}; writes=[]; calls=[]
        stopped={"Id":"1"*64,"Created":"original","Image":self.o.target["appImage"],"State":{"Running":False}}
        healthy=copy.deepcopy(stopped); healthy["State"]={"Running":True,"Health":{"Status":"healthy"}}
        inspections=iter([stopped,healthy])
        def inspect(_cid):
            handlers[s.signal.SIGTERM](s.signal.SIGTERM,None)
            return next(inspections)
        def docker(*args,**kwargs):
            calls.append(args)
            if args[0]=="stop": raise s.Stop("SYNTHETIC_LOST_STOP_REPLY")
            handlers[s.signal.SIGINT](s.signal.SIGINT,None)
        out=io.StringIO()
        with patch.object(s,"Backup",return_value=self.o), patch.object(self.o,"prepare"), \
             patch.object(s.signal,"signal",side_effect=lambda sig,fn:handlers.__setitem__(sig,fn)), \
             patch.object(self.o,"same_source"), patch.object(self.o,"rows",return_value=[]), \
             patch.object(self.o,"check_inputs"), patch.object(self.o,"write",side_effect=lambda p,v:writes.append(p.name)), \
             patch.object(self.o,"inspect",side_effect=inspect), patch.object(self.o,"docker",side_effect=docker), \
             redirect_stdout(out):
            self.assertEqual(s.entry_point(packet(),"f"*64),2)
        result=json.loads(out.getvalue())
        self.assertEqual(result["status"],"STOP")
        self.assertTrue(result["appResumedHealthy"])
        self.assertTrue(result["interruptionRequested"])
        self.assertEqual(calls[-1],("start","1"*64))
        self.assertEqual(sum(x[0]=="start" for x in calls),1)
        self.assertNotIn("BACKUP_VERIFIED.json",writes)

    def test_signal_during_cleanup_does_not_prevent_group_stop(self):
        proc=Mock(pid=123456); proc.poll.return_value=0
        proc.communicate.side_effect=lambda **kw:self.o.request_interruption(s.signal.SIGTERM,None)
        with patch.object(s.os,"killpg",create=True), patch.object(self.o,"process_group_exists",return_value=False):
            self.o.terminate_process(proc)
        self.assertTrue(self.o.interruption_requested)
        self.assertTrue(self.o.command_groups_quiet)

    def test_repeated_signals_do_not_extend_expired_resume_budget(self):
        self.o.monotonic-=1600
        self.o.request_interruption(s.signal.SIGTERM,None)
        self.o.request_interruption(s.signal.SIGINT,None)
        with patch.object(self.o,"inspect") as inspect, patch.object(self.o,"docker") as docker:
            with self.assertRaisesRegex(s.Stop,"ORIGINAL_EXECUTION_BUDGET_EXPIRED"): self.o.resume()
        inspect.assert_not_called(); docker.assert_not_called()

    def test_signal_during_successful_backup_resume_prevents_success_receipt(self):
        stopped={"Id":"1"*64,"Created":"original","Image":self.o.target["appImage"],
                 "State":{"Running":False,"Pid":0}}
        healthy=copy.deepcopy(stopped); healthy["State"]={"Running":True,"Health":{"Status":"healthy"}}
        inspections=iter([stopped,stopped,healthy]); writes=[]
        def inspect(_cid):
            if self.o.emergency: self.o.request_interruption(s.signal.SIGTERM,None)
            return next(inspections)
        with patch.object(self.o,"same_source",return_value={"app":{"state":"exited"}}), \
             patch.object(self.o,"rows",return_value=[]), patch.object(self.o,"check_inputs"), \
             patch.object(self.o,"write",side_effect=lambda p,v:writes.append(p.name)), \
             patch.object(self.o,"docker") as docker, patch.object(self.o,"inspect",side_effect=inspect), \
             patch.object(self.o,"run",return_value=b"synthetic"), \
             patch.object(self.o,"supervise_backup",return_value=b"synthetic"), \
             patch.object(s,"read_stable",return_value=b"synthetic"), \
             patch.object(pathlib.Path,"open",return_value=io.BytesIO(b"synthetic")):
            with self.assertRaisesRegex(s.Stop,"OWNER_EXECUTION_INTERRUPTED"): self.o.create()
        self.assertTrue(self.o.app_resumed)
        self.assertEqual(docker.call_args_list[-1].args,("start","1"*64))
        self.assertNotIn("BACKUP_VERIFIED.json",writes)

    def test_process_stop_cannot_renew_original_execution_budget(self):
        self.o.monotonic-=1600
        with patch.object(s.os,"killpg",create=True) as kill:
            with self.assertRaisesRegex(s.Stop,"ORIGINAL_EXECUTION_BUDGET_EXPIRED"):
                self.o.terminate_process(Mock(pid=123456))
        kill.assert_not_called()
        self.assertFalse(self.o.command_groups_quiet)


@unittest.skipUnless(sys.platform=="linux","native process groups require Linux")
class NativeProcessGroupTests(unittest.TestCase):
    def exercise(self, leader_exits):
        # Both children are ours, in a new session. The descendant ignores TERM
        # and closes output pipes, reproducing a leader whose communicate()
        # completes while its descendant still runs. No Docker or SSH involved.
        script="""import os, signal, sys, time
r,w=os.pipe()
child=os.fork()
if child==0:
    os.close(r)
    signal.signal(signal.SIGTERM,signal.SIG_IGN)
    os.write(w,b'1'); os.close(w)
    for fd in (0,1,2): os.close(fd)
    time.sleep(30)
    os._exit(0)
os.close(w); os.read(r,1); os.close(r)
print(child,flush=True)
if sys.argv[1]=='exit': os._exit(0)
time.sleep(30)
"""
        proc=subprocess.Popen([sys.executable,"-c",script,"exit" if leader_exits else "wait"],
                              start_new_session=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        child=None
        try:
            child=int(proc.stdout.readline())
            if leader_exits: proc.wait(timeout=3)
            operation=s.Backup(packet()["plan"])
            began=time.monotonic()
            try:
                operation.terminate_process(proc)
            except s.Stop as exc:
                # A host that has not reaped an orphan zombie is still denied;
                # only a vanished group admits resume, never just a dead leader.
                self.assertEqual(str(exc),"PROCESS_STOP_UNVERIFIED")
                self.assertFalse(operation.command_groups_quiet)
                with patch.object(operation,"inspect") as inspect:
                    with self.assertRaisesRegex(s.Stop,"PROCESS_STOP_UNVERIFIED"): operation.resume()
                inspect.assert_not_called()
            else:
                self.assertFalse(operation.process_group_exists(proc.pid))
            self.assertLess(time.monotonic()-began,6)
            state=pathlib.Path(f"/proc/{child}/stat")
            if state.exists(): self.assertIn(state.read_text().rsplit(")",1)[1].split()[0],("Z","X"))
        finally:
            try: os.killpg(proc.pid,s.signal.SIGKILL)
            except ProcessLookupError: pass
            proc.wait(timeout=3)
            proc.stdout.close(); proc.stderr.close()

    def test_native_reaped_leader_descendant_is_stopped(self): self.exercise(True)
    def test_native_live_leader_with_term_ignoring_child_is_stopped(self): self.exercise(False)


if __name__ == "__main__":
    unittest.main(verbosity=2)
