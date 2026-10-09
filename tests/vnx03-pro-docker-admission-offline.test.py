"""Exercise actual admission shell with substituted Docker, no daemon or DB."""

import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BASH = (str(Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe")
        if os.name == "nt" else "bash")
CONTEXT = "synthetic-local"
PROJECT = "fai-vnx03-offline-1"
BUILDER = "Name: synthetic-local\nDriver: docker\n\nNodes:\nName: synthetic-local\nEndpoint: synthetic-local\nStatus: running\nDevices:\n Name: docker.com/gpu=synthetic\n"
MODEL = {
    "name": PROJECT,
    "services": {"postgres": {}, "wordpress": {}},
    "volumes": {"postgres-data": {"name": PROJECT + "_postgres-data"}},
    "networks": {"vnx03": {"name": PROJECT + "_vnx03"}},
}

SHELL = r'''
set -Eeuo pipefail
repo_root="$1"; runtime_dir="$2"; docker_context=synthetic-local
COMPOSE_PROJECT_NAME=fai-vnx03-offline-1
fail() { printf '%s\n' "$1"; exit 2; }
docker() {
  printf '%s\n' "$*" >> "$runtime_dir/calls"
  case "$*" in
    '--context synthetic-local buildx inspect synthetic-local') cat "$runtime_dir/builder" ;;
    "volume ls --format {{.Name}}")
      [[ "${INVENTORY_FAIL:-}" != volume ]] || return 71
      cat "$runtime_dir/volumes" ;;
    "network ls --format {{.Name}}")
      [[ "${INVENTORY_FAIL:-}" != network ]] || return 71
      cat "$runtime_dir/networks" ;;
    "ps -a --format {{.Names}}")
      [[ "${INVENTORY_FAIL:-}" != container ]] || return 71
      cat "$runtime_dir/containers" ;;
    *) echo UNEXPECTED_DOCKER_OPERATION >&2; return 73 ;;
  esac
}
fake_compose() {
  printf 'compose %s\n' "$*" >> "$runtime_dir/calls"
  [[ "$*" == '--profile n14 config --format json' ]] || return 74
  cat "$runtime_dir/model"
}
compose=(fake_compose)
source "$repo_root/scripts/vnx03/pro-docker-admission.sh"
pro_bind_builder
pro_require_resource_names_absent
printf 'ADMITTED_BUILD_ARGUMENTS=%s|%s\n' "${pro_build_arguments[0]}" "${pro_build_arguments[1]}"
'''


class OfflineDockerAdmission(unittest.TestCase):
    def exercise(self, *, builder=BUILDER, model=MODEL, volumes="", networks="", containers="", env=None):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            for name, data in {"builder": builder, "model": json.dumps(model), "volumes": volumes,
                               "networks": networks, "containers": containers}.items():
                (target / name).write_text(data, encoding="utf-8")
            clean = {k: v for k, v in os.environ.items() if not k.startswith(("VNX03_", "BUILDX_", "BUILDKIT_", "COMPOSE_"))
                     and k not in ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_BUILDKIT")}
            clean.update({"VNX03_PRO_PYTHON": Path(sys.executable).as_posix(), **(env or {})})
            result = subprocess.run([BASH, "--noprofile", "--norc", "-c", SHELL, "offline-docker-admission",
                                     ROOT.as_posix(), target.as_posix()], env=clean, text=True,
                                    capture_output=True, timeout=20)
            calls = (target / "calls").read_text() if (target / "calls").exists() else ""
            # Every permissible fake operation is read-only. An accidental
            # build/load/exec/down/rm cannot reach a real Docker binary.
            self.assertNotIn("UNEXPECTED_DOCKER_OPERATION", result.stderr)
            self.assertNotIn("build --", calls)
            self.assertNotIn("down", calls)
            self.assertNotIn(" rm", calls)
            return result, calls

    def test_local_builder_and_empty_names_admitted(self):
        result, calls = self.exercise()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("ADMITTED_BUILD_ARGUMENTS=--builder|synthetic-local", result.stdout)
        self.assertIn("--context synthetic-local buildx inspect synthetic-local", calls)

    def test_build_overrides_denied_before_any_docker_or_input_transfer(self):
        for key in ("BUILDX_BUILDER", "BUILDKIT_HOST", "DOCKER_BUILDKIT", "COMPOSE_DOCKER_CLI_BUILD", "COMPOSE_BAKE"):
            with self.subTest(key=key):
                result, calls = self.exercise(env={key: "synthetic-remote"})
                self.assertEqual(result.returncode, 2)
                self.assertIn("VNX03_PRO_BUILD_OVERRIDE_FORBIDDEN", result.stdout)
                self.assertEqual(calls, "")

    def test_foreign_default_never_used_and_explicit_local_builder_is_returned(self):
        # A persistent default is outside the process environment. The fake
        # Docker accepts ONLY inspect of the explicitly selected local context;
        # unqualified inspect/build would fail, never consult that default.
        result, calls = self.exercise(env={"SYNTHETIC_PERSISTENT_DEFAULT": "remote-builder"})
        self.assertEqual(result.returncode, 0)
        self.assertEqual(calls.splitlines()[0], "--context synthetic-local buildx inspect synthetic-local")
        self.assertIn("ADMITTED_BUILD_ARGUMENTS=--builder|synthetic-local", result.stdout)

    def test_foreign_or_multiple_nodes_rejected_before_resources(self):
        for data in (BUILDER.replace("Name: synthetic-local", "Name: remote", 1),
                     BUILDER + "Name: extra\nEndpoint: tcp://remote.invalid:2376\nStatus: running\n"):
            result, calls = self.exercise(builder=data)
            self.assertEqual(result.returncode, 2)
            self.assertNotIn("compose", calls)

    def test_remote_driver_and_endpoint_rejected(self):
        for data in (BUILDER.replace("Driver: docker", "Driver: remote"),
                     BUILDER.replace("Endpoint: synthetic-local", "Endpoint: tcp://remote.invalid:2376")):
            result, calls = self.exercise(builder=data)
            self.assertEqual(result.returncode, 2)
            self.assertNotIn("compose", calls)

    def test_uncertain_or_stopped_builder_rejected(self):
        for data in ("", BUILDER.replace("Status: running", "Status: stopped"), BUILDER + "Error: unknown\n"):
            result, _ = self.exercise(builder=data)
            self.assertEqual(result.returncode, 2)

    def test_unlabelled_same_name_volume_stops_without_cleanup(self):
        result, _ = self.exercise(volumes=PROJECT + "_postgres-data\n")
        self.assertEqual(result.returncode, 2)
        self.assertIn("PRO_EXISTING_VOLUMES_NAME", result.stdout)

    def test_foreign_label_same_name_volume_stops_without_cleanup(self):
        # Name inventory does not filter labels, so an unrelated label cannot
        # hide the resource. The same name must be refused in both situations.
        result, _ = self.exercise(volumes=PROJECT + "_postgres-data\n", env={"SYNTHETIC_VOLUME_LABEL": "other-project"})
        self.assertEqual(result.returncode, 2)
        self.assertIn("PRO_EXISTING_VOLUMES_NAME", result.stdout)

    def test_network_and_container_names_also_protected(self):
        for values in ({"networks": PROJECT + "_vnx03\n"}, {"containers": PROJECT + "-wordpress-1\n"}):
            result, _ = self.exercise(**values)
            self.assertEqual(result.returncode, 2)

    def test_inventory_failure_is_not_empty_inventory(self):
        for kind in ("volume", "network", "container"):
            result, _ = self.exercise(env={"INVENTORY_FAIL": kind})
            self.assertEqual(result.returncode, 2)
            self.assertIn("VNX03_PRO_RESOURCE_INVENTORY_FAILED", result.stdout)

    def test_external_or_renamed_resources_and_incomplete_models_denied(self):
        for model in ({}, {**MODEL, "name": "foreign"},
                      {**MODEL, "volumes": {"postgres-data": {"name": PROJECT + "_postgres-data", "external": True}}},
                      {**MODEL, "volumes": {"postgres-data": {"name": "historical-data"}}}):
            result, _ = self.exercise(model=model)
            self.assertEqual(result.returncode, 2)

    def test_unrelated_resource_names_are_preserved_and_do_not_block(self):
        result, _ = self.exercise(volumes="historical-data\n", networks="historical-network\n", containers="historical-container\n")
        self.assertEqual(result.returncode, 0)


BUILD_SHELL = r'''
set -Eeuo pipefail
repo_root="$1"; runtime_dir="$2"; docker_context=synthetic-local
COMPOSE_PROJECT_NAME=fai-vnx03-offline-1
source_commit=1111111111111111111111111111111111111111
source_tree=2222222222222222222222222222222222222222
WORDPRESS_IMAGE=synthetic-wordpress; WPFORMS_SHA256=synthetic-wpforms
VNX03_CONNECTOR_SHA256=synthetic-connector; WP_CLI_SHA256=synthetic-cli
pro_build_arguments=(--builder "$docker_context")
fail() { printf '%s\n' "$1"; exit 2; }
fake_compose() {
  [[ "$*" == 'build --print --pull harness crm wordpress' ]] || return 74
  [[ "${RENDER_FAIL:-0}" == 0 ]] || return 75
  cat "$runtime_dir/model"
}
docker() {
  printf '%s\0' "$@" >> "$runtime_dir/build-calls"
  # Simulate the context disagreement from the standalone child. Global
  # --context must reach Docker, not be placed after compose/buildx.
  [[ "$1" == --context && "$2" == synthetic-local && "$3" == buildx && "$4" == bake ]] || return 73
  return "${BUILD_RESULT:-0}"
}
compose=(fake_compose)
source "$repo_root/scripts/vnx03/pro-docker-admission.sh"
pro_build_images
'''


class OfflineProBuildTransport(unittest.TestCase):
    def exercise(self, mutate=lambda model: None, env=None):
        with tempfile.TemporaryDirectory(prefix="pro build ") as directory:
            target = Path(directory)
            package = target / "input with spaces.zip"
            model = {"group": {"default": {"targets": ["harness", "crm", "wordpress"]}}, "target": {}}
            for name in ("harness", "crm", "wordpress"):
                item = {"context": str(ROOT), "dockerfile": "tests/vnx03/Dockerfile.crm",
                        "args": {"SOURCE_COMMIT": "1" * 40, "SOURCE_TREE": "2" * 40},
                        "labels": {"com.docker.compose.project": PROJECT, "com.docker.compose.service": name,
                                   "com.docker.compose.version": "5.5.1"},
                        "tags": [PROJECT + "-" + name + ":" + "1" * 40],
                        "target": name, "pull": True, "output": ["type=docker"]}
                if name == "wordpress":
                    item.pop("target")
                    item["dockerfile"] = "tests/vnx03/Dockerfile.wordpress"
                    item["args"] = {"WORDPRESS_IMAGE": "synthetic-wordpress", "WPFORMS_EDITION": "pro",
                                    "WPFORMS_SHA256": "synthetic-wpforms", "CONNECTOR_SHA256": "synthetic-connector",
                                    "WP_CLI_SHA256": "synthetic-cli"}
                    item["secret"] = ["id=wpforms_pro,type=file,src=" + package.as_posix()]
                model["target"][name] = item
            mutate(model)
            encoded = json.dumps(model)
            (target / "model").write_text(encoded, encoding="utf-8")
            clean = os.environ.copy()
            clean.update({"VNX03_PRO_PYTHON": Path(sys.executable).as_posix(),
                          "VNX03_PRO_PACKAGE": package.as_posix(), **(env or {})})
            result = subprocess.run([BASH, "--noprofile", "--norc", "-c", BUILD_SHELL, "offline-pro-build",
                                     ROOT.as_posix(), target.as_posix()], env=clean, text=True,
                                    capture_output=True, timeout=20)
            calls_path = target / "build-calls"
            calls = calls_path.read_bytes().decode().split("\0")[:-1] if calls_path.exists() else []
            if result.returncode == 0:
                # Exact rendered configuration reaches Buildx; no lossy rewrite
                # of digest pins, build arguments, secret or local image tags.
                self.assertEqual((target / "pro-bake.json").read_text(encoding="utf-8"), encoded)
                self.assertEqual(calls, ["--context", CONTEXT, "buildx", "bake", "--builder", CONTEXT,
                                        "--file", (target / "pro-bake.json").as_posix(), "--progress", "plain",
                                        "--allow", "fs.read=" + ROOT.as_posix(), "--allow",
                                        "fs.read=" + package.as_posix(), "harness", "crm", "wordpress"])
            return result, calls

    def test_explicit_context_and_builder_preserve_complete_rendered_input(self):
        result, _ = self.exercise(env={"DOCKER_CONTEXT": "foreign-default"})
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)

    def test_render_failure_never_reaches_builder(self):
        result, calls = self.exercise(env={"RENDER_FAIL": "1"})
        self.assertEqual(result.returncode, 2)
        self.assertEqual(calls, [])

    def test_builder_failure_is_propagated_without_retry_or_fallback(self):
        result, calls = self.exercise(env={"BUILD_RESULT": "42"})
        self.assertEqual(result.returncode, 42)
        self.assertEqual(calls.count("bake"), 1)

    def test_remote_context_export_or_extra_targets_never_reach_builder(self):
        def extra_target(model):
            model["target"]["extra"] = copy.deepcopy(model["target"]["harness"])
        mutations = [extra_target,
                     lambda m: m["target"]["harness"].update(context="https://remote.invalid/source"),
                     lambda m: m["target"]["harness"].update(output=["type=registry"]),
                     lambda m: m["target"]["harness"].update(tags=["foreign:latest"]),
                     lambda m: m["target"]["harness"].update(ssh=["default"]),
                     lambda m: m["target"]["harness"].update(entitlements=["security.insecure"]),
                     lambda m: m["group"]["default"].update(targets=["harness", "crm", "wordpress", "harness"])]
        for mutation in mutations:
            with self.subTest(mutation=mutations.index(mutation)):
                result, calls = self.exercise(mutation)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(calls, [])

    def test_drifted_source_stage_secret_or_args_never_reach_builder(self):
        mutations = [lambda m: m["target"]["crm"]["args"].update(SOURCE_TREE="3" * 40),
                     lambda m: m["target"]["crm"].update(target="other"),
                     lambda m: m["target"]["crm"].update(dockerfile="../Dockerfile"),
                     lambda m: m["target"]["crm"].update(secret=["id=private,env=TOKEN"]),
                     lambda m: m["target"]["wordpress"].update(secret=["id=wpforms_pro,type=env,env=TOKEN"]),
                     lambda m: m["target"]["wordpress"]["args"].update(WORDPRESS_IMAGE="foreign:latest"),
                     lambda m: m["target"]["wordpress"]["args"].update(WPFORMS_SHA256="other"),
                     lambda m: m["target"]["wordpress"].update(pull=False)]
        for mutation in mutations:
            with self.subTest(mutation=mutations.index(mutation)):
                result, calls = self.exercise(mutation)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
