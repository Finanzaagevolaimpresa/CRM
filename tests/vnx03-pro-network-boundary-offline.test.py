"""Exercise the real boundary and runner ordering with substituted transports only."""

import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("boundary", ROOT / "scripts/vnx03/pro-network-boundary.py")
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)
BASH = str(Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe") if os.name == "nt" else "bash"
BRIDGE = {k: {} for k in guard.STABLE}
BRIDGE.update(Name="bridge", Driver="bridge", Scope="local", Internal=False, Id="a" * 64,
              Created="2026-01-01T00:00:00Z", Containers={}, EnableIPv4=True, EnableIPv6=False,
              Attachable=False, Ingress=False, ConfigOnly=False)
SNAPSHOT = {"bridge": guard.normalize_bridge(BRIDGE, []), "containersSha256": "b" * 64,
            "volumesSha256": "c" * 64, "networksSha256": "d" * 64,
            "counts": {"containers": 3, "volumes": 5, "networks": 4}}


class Clock:
    def __init__(self):
        self.value = 0

    def __call__(self):
        return self.value

    def sleep(self, seconds):
        self.value += seconds


class Samples:
    def __init__(self, samples):
        self.samples = copy.deepcopy(samples)
        self.calls = 0

    def snapshot(self, _binding):
        item = self.samples[min(self.calls, len(self.samples) - 1)]
        self.calls += 1
        if isinstance(item, Exception):
            raise item
        return copy.deepcopy(item)


def attached(kind="UNATTRIBUTED_SANDBOX"):
    value = copy.deepcopy(SNAPSHOT)
    value["bridge"]["attachments"] = [{"attachmentId": "opaque-synthetic-sandbox", "kind": kind}]
    return value


class Boundary(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.args = argparse.Namespace(mode="prepare", directory=str(Path(self.temp.name) / "boundary"),
                                       contract=guard.CONTRACT, context="synthetic-local", engine="synthetic-engine",
                                       endpoint="unix:///var/run/docker.sock", head="1" * 40, tree="2" * 40,
                                       project="fai-vnx03-offline-1", baseline_sha=None)
        self.clock = Clock()
        self.addCleanup(patch.stopall)
        patch.object(subprocess, "run", side_effect=AssertionError("REAL_PROCESS_FORBIDDEN")).start()
        patch.object(socket, "socket", side_effect=AssertionError("REAL_NETWORK_FORBIDDEN")).start()

    def call(self, samples):
        return guard.execute(self.args, transport=Samples(samples), clock=self.clock, sleep=self.clock.sleep)

    def prepare(self):
        result = self.call([SNAPSHOT])
        self.assertEqual(result["status"], "BASELINE_RECORDED")
        self.args.mode = "admit"
        self.args.baseline_sha = result["baselineSha256"]

    def test_two_empty_samples_admit_only_the_boundary(self):
        self.prepare()
        result = self.call([SNAPSHOT])
        self.assertEqual(result["status"], "ADMITTED_BOUNDARY_ONLY")
        self.assertEqual(result["consecutiveEmptySamples"], 2)
        self.assertFalse(result["runtimeQualified"])
        self.assertFalse(result["endpointAttributionProven"])
        self.assertEqual(self.clock.value, 1)

    def test_baseline_occupied_is_saved_before_denial(self):
        result = self.call([attached()])
        self.assertEqual(result["code"], "BASELINE_BRIDGE_NOT_EMPTY")
        self.assertFalse((Path(self.args.directory) / "baseline.json").exists())
        self.assertIn("opaque-synthetic-sandbox", (Path(self.args.directory) / "before-build.jsonl").read_text())

    def test_unattributed_postbuild_endpoint_must_disappear_and_is_never_attributed(self):
        self.prepare()
        result = self.call([attached(), SNAPSHOT, SNAPSHOT])
        self.assertEqual(result["status"], "ADMITTED_BOUNDARY_ONLY")
        self.assertEqual(self.clock.value, 2)
        self.assertFalse(result["endpointAttributionProven"])
        self.assertIn("UNATTRIBUTED_SANDBOX", (Path(self.args.directory) / "after-build.jsonl").read_text())

    def test_one_empty_sample_then_attachment_never_admits(self):
        self.prepare()
        result = self.call([SNAPSHOT, attached()])
        self.assertEqual(result["status"], "STOP")
        self.assertEqual(result["code"], "POST_BUILD_BRIDGE_NOT_QUIESCENT")
        self.assertEqual(self.clock.value, 30)

    def test_container_and_orphan_never_get_polling_exception(self):
        for kind in ("ENGINE_CONTAINER", "ORPHAN_ENDPOINT"):
            with self.subTest(kind=kind), self.assertRaisesRegex(guard.Denied, "FORBIDDEN_ATTACHMENT"):
                guard.compare(SNAPSHOT, attached(kind))

    def test_network_instance_and_config_changes_deny(self):
        for key in ("id", "created", "stablePropertiesSha256"):
            value = copy.deepcopy(SNAPSHOT)
            value["bridge"][key] = "changed"
            with self.subTest(key=key), self.assertRaisesRegex(guard.Denied, "IDENTITY_OR_CONFIG_CHANGED"):
                guard.compare(SNAPSHOT, value)

    def test_historical_resources_and_state_changes_deny(self):
        for key in ("containersSha256", "volumesSha256", "networksSha256", "counts"):
            value = copy.deepcopy(SNAPSHOT)
            value[key] = "changed"
            with self.subTest(key=key), self.assertRaisesRegex(guard.Denied, "HISTORICAL_RESOURCES_CHANGED"):
                guard.compare(SNAPSHOT, value)

    def test_drift_evidence_is_written_before_assertion(self):
        self.prepare()
        value = copy.deepcopy(SNAPSHOT)
        value["bridge"]["created"] = "changed"
        result = self.call([value])
        self.assertEqual(result["code"], "BRIDGE_IDENTITY_OR_CONFIG_CHANGED")
        self.assertIn("changed", (Path(self.args.directory) / "after-build.jsonl").read_text())

    def test_missing_read_is_not_empty_and_does_not_retry(self):
        self.prepare()
        reader = Samples([guard.Denied("DOCKER_METADATA_READ_UNCERTAIN"), SNAPSHOT])
        result = guard.execute(self.args, transport=reader, clock=self.clock, sleep=self.clock.sleep)
        self.assertEqual(result["status"], "STOP")
        self.assertEqual(reader.calls, 1)

    def test_slow_sample_cannot_admit_outside_budget(self):
        self.prepare()
        class Slow:
            def snapshot(_self, _binding):
                self.clock.value += 31
                return SNAPSHOT
        result = guard.execute(self.args, transport=Slow(), clock=self.clock, sleep=self.clock.sleep)
        self.assertEqual(result["code"], "BOUNDARY_READ_BUDGET_EXHAUSTED")

    def test_tampered_baseline_is_rejected_before_transport(self):
        self.prepare()
        path = Path(self.args.directory) / "baseline.json"
        path.write_bytes(path.read_bytes() + b" ")
        reader = Samples([SNAPSHOT])
        result = guard.execute(self.args, transport=reader, clock=self.clock, sleep=self.clock.sleep)
        self.assertEqual(result["code"], "BASELINE_CHANGED")
        self.assertEqual(reader.calls, 0)

    def test_other_candidate_context_or_project_cannot_reuse_baseline(self):
        self.prepare()
        self.args.head = "3" * 40
        reader = Samples([SNAPSHOT])
        result = guard.execute(self.args, transport=reader, clock=self.clock, sleep=self.clock.sleep)
        self.assertEqual(result["code"], "BASELINE_BINDING_INVALID")
        self.assertEqual(reader.calls, 0)

    def test_duplicate_admission_preserves_original(self):
        self.prepare()
        self.call([SNAPSHOT])
        path = Path(self.args.directory) / "boundary-result.json"
        original = path.read_bytes()
        with self.assertRaisesRegex(guard.Denied, "ALREADY_ATTEMPTED"):
            self.call([SNAPSHOT])
        self.assertEqual(path.read_bytes(), original)

    def test_wrong_or_missing_contract_denies_before_transport_and_files(self):
        for contract in (None, "R08", "legacy", "build-boundary-v2"):
            self.args.contract = contract
            with self.subTest(contract=contract), patch.object(guard, "DockerReadOnly") as factory:
                with self.assertRaisesRegex(guard.Denied, "NEW_NETWORK_CONTRACT_REQUIRED"):
                    guard.execute(self.args)
                factory.assert_not_called()
                self.assertFalse(Path(self.args.directory).exists())

    def test_remote_endpoint_denies_before_transport(self):
        self.args.endpoint = "tcp://remote.invalid:2376"
        with self.assertRaisesRegex(guard.Denied, "NONLOCAL_ENDPOINT"):
            self.call([SNAPSHOT])


class MetadataTransport(unittest.TestCase):
    def fixture(self, args):
        self.assertEqual(args[:3], ["docker", "--context", "synthetic-local"])
        operation = args[3:]
        if operation == ["info", "--format", "{{.ID}}"]:
            return b"synthetic-engine"
        if operation[:2] == ["context", "inspect"]:
            return b"unix:///var/run/docker.sock"
        if operation == ["ps", "-aq", "--no-trunc"]:
            return ("e" * 64).encode()
        if operation[:3] == ["inspect", "--type", "container"]:
            self.assertNotIn("Config", operation[4])
            self.assertNotIn("Env", operation[4])
            return json.dumps({"id": "e" * 64, "created": "synthetic", "image": "sha256:" + "f" * 64,
                               "state": "exited", "started": "synthetic", "finished": "synthetic", "restarts": 0}).encode()
        if operation[:2] == ["volume", "ls"]:
            return b'{"Name":"private-name-not-to-persist","Driver":"local","Scope":"local"}'
        if operation[:2] == ["network", "ls"]:
            return json.dumps({"ID": "a" * 64, "Name": "bridge", "Driver": "bridge", "Scope": "local"}).encode()
        if operation[:3] == ["network", "inspect", "bridge"]:
            return json.dumps(BRIDGE).encode()
        self.fail("UNEXPECTED_DOCKER_COMMAND " + repr(operation))

    def test_actual_adapter_only_queries_bound_metadata_and_redacts_names(self):
        def fake_run(args, **kwargs):
            self.assertLessEqual(kwargs["timeout"], 5)
            self.assertIs(kwargs["stderr"], subprocess.DEVNULL)
            return subprocess.CompletedProcess(args, 0, self.fixture(args))
        binding = {"engine": "synthetic-engine", "endpoint": "unix:///var/run/docker.sock"}
        with patch.object(subprocess, "run", side_effect=fake_run) as process, patch.object(socket, "socket", side_effect=AssertionError):
            value = guard.DockerReadOnly("synthetic-local").snapshot(binding)
        self.assertGreater(process.call_count, 5)
        self.assertNotIn("private-name", json.dumps(value))
        self.assertEqual(value["counts"]["containers"], 1)

    def test_endpoint_identity_not_mistaken_for_engine_container_id(self):
        value = copy.deepcopy(BRIDGE)
        value["Containers"] = {"opaque-sandbox": {"Name": "private-endpoint-name", "EndpointID": "f" * 64,
                                                  "IPv4Address": "private-ip", "MacAddress": "private-mac"}}
        result = guard.normalize_bridge(value, ["e" * 64])
        self.assertEqual(result["attachments"][0]["kind"], "UNATTRIBUTED_SANDBOX")
        self.assertNotIn("private-", json.dumps(result))

    def test_incomplete_network_metadata_is_never_empty(self):
        for key in (*guard.STABLE, "Id", "Created", "Containers"):
            value = copy.deepcopy(BRIDGE)
            del value[key]
            with self.subTest(key=key), self.assertRaises(guard.Denied):
                guard.normalize_bridge(value, [])

    def test_failed_or_timed_out_query_does_not_expose_output(self):
        cases = (subprocess.CompletedProcess([], 1, b"sensitive-output"), subprocess.TimeoutExpired([], 1, output=b"sensitive-output"))
        for outcome in cases:
            def fake(*_args, **_kwargs):
                if isinstance(outcome, Exception):
                    raise outcome
                return outcome
            with self.subTest(outcome=type(outcome).__name__), patch.object(subprocess, "run", side_effect=fake):
                with self.assertRaises(guard.Denied) as caught:
                    guard.DockerReadOnly("synthetic-local").query("info", "--format", "{{.ID}}")
                self.assertNotIn("sensitive", str(caught.exception))


class RunnerOrdering(unittest.TestCase):
    def exercise(self, phase="ok", contract=guard.CONTRACT):
        runner = (ROOT / "scripts/vnx03/run-e2e.sh").read_text()
        end = runner.index('"${compose[@]}" up -d --wait --wait-timeout 180 postgres mysql')
        start = runner.rfind('if [[ "$WPFORMS_EDITION" == \'pro\' ]]; then', 0, end)
        # Execute the actual orchestration block, with every I/O dependency
        # replaced. The post-boundary DB start is a logging function only.
        block = runner[start:end] + runner[end:].splitlines()[0]
        shell = r'''
set -Eeuo pipefail
repo_root="$1"; evidence_dir="$2"; phase="$3"
source_commit=1111111111111111111111111111111111111111
source_tree=2222222222222222222222222222222222222222
COMPOSE_PROJECT_NAME=fai-vnx03-offline-1; docker_context=synthetic-local
docker_endpoint=unix:///var/run/docker.sock; VNX03_EXPECTED_DOCKER_ENGINE_ID=synthetic-engine
VNX03_PRO_PYTHON=fake_python; VNX03_PRO_NETWORK_CONTRACT="$4"; WPFORMS_EDITION=pro
compose_resources_created=false
trap 'printf "cleanup-eligible=%s\n" "$compose_resources_created" >> "$evidence_dir/calls"' EXIT
fail() { printf '%s\n' "$1" >&2; exit 2; }
docker() { fail REAL_DOCKER_FORBIDDEN; }
fake_python() {
  printf '%s\n' "$5" >> "$evidence_dir/calls"
  [[ "$phase" != "$5" ]] || return 42
  if [[ "$5" == prepare ]]; then printf '%064d\n' 0; fi
}
pro_build_images() {
  printf '%s\n' build >> "$evidence_dir/calls"
  [[ "$phase" != build ]]
}
fake_compose() { printf 'start-databases\n' >> "$evidence_dir/calls"; }
compose=(fake_compose)
source "$repo_root/scripts/vnx03/pro-network-boundary.sh"
'''
        with tempfile.TemporaryDirectory() as tmp:
            env = {k: v for k, v in os.environ.items() if k not in ("BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS")}
            result = subprocess.run([BASH, "--noprofile", "--norc", "-c", shell + block, "offline-boundary",
                                     ROOT.as_posix(), Path(tmp).as_posix(), phase, contract],
                                    capture_output=True, text=True, timeout=15, env=env)
            calls = (Path(tmp) / "calls").read_text().splitlines()
        return result, calls

    def test_actual_pro_runner_orders_baseline_build_boundary_then_databases(self):
        result, calls = self.exercise()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, ["prepare", "build", "admit", "start-databases", "cleanup-eligible=true"])

    def test_failure_in_each_phase_blocks_downstream_actions_without_retry(self):
        for phase, expected in (("prepare", ["prepare", "cleanup-eligible=false"]),
                                ("build", ["prepare", "build", "cleanup-eligible=true"]),
                                ("admit", ["prepare", "build", "admit", "cleanup-eligible=true"])):
            with self.subTest(phase=phase):
                result, calls = self.exercise(phase)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, expected)

    def test_prior_method_never_reaches_transport_build_or_cleanup(self):
        result, calls = self.exercise(contract="")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, ["cleanup-eligible=false"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
