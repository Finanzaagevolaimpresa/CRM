#!/usr/bin/env python3
"""Bounded adversarial tests. Every byte, identity and destination is synthetic."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "kit", Path(__file__).resolve().parents[2] / "scripts/n05/recovery_kit.py")
kit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(kit)


class RecoveryGuards(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="fai-crm-n05-kit-unit-")
        self.root = Path(self.temporary.name)
        self.root.chmod(0o700)
        self.work = self.root / "operations"
        self.work.mkdir(mode=0o700)
        self.binding = {"commit": "a" * 40, "tree": "b" * 40,
                        "program_sha256": kit.digest(kit.PROGRAM)}
        self.plan = {"schema": kit.SCHEMA, "phase": "receive", "data_class": "synthetic",
                     "run_id": "a" * 32, "host": socket.gethostname(),
                     "work_root": str(self.work), "tools": self.binding,
                     "bundle_bytes": 3, "bundle_sha256": kit.sha(b"abc"),
                     "recipient_sha256": "c" * 64, "sender_host": "synthetic-sender",
                     "program_sha256": kit.digest(kit.PROGRAM)}

    def tearDown(self):
        self.temporary.cleanup()

    def file(self, name, data=b"synthetic", mode=0o600):
        result = self.root / name
        result.write_bytes(data)
        result.chmod(mode)
        return result

    def load(self, plan=None, expected=None):
        p = self.file("plan.json", kit.canonical(plan or self.plan))
        return kit.load_plan(p, expected or kit.digest(p))

    def tar(self, entries):
        result = self.root / "archive.tar"
        with tarfile.open(result, "w") as out:
            for name, kind, contents in entries:
                item = tarfile.TarInfo(name)
                item.type = kind
                item.mode = 0o600
                item.size = len(contents) if kind == tarfile.REGTYPE else 0
                if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                    item.linkname = "/outside"
                out.addfile(item, io.BytesIO(contents) if item.isfile() else None)
        return result

    def denied(self, code, function, *args, **kwargs):
        with self.assertRaisesRegex(kit.Denied, "^" + code + "$"):
            function(*args, **kwargs)

    def document_tar(self, changes=None, omit=()):
        path = self.root / ("documents-" + kit.uuid.uuid4().hex + ".tar.gz")
        with tarfile.open(path, "w:gz") as archive:
            for name in (".", "nested", "empty", "nested/document"):
                if name in omit:
                    continue
                item = tarfile.TarInfo(name)
                item.uid = item.gid = 1001
                item.type = tarfile.REGTYPE if name == "nested/document" else tarfile.DIRTYPE
                item.mode = 0o600 if item.isfile() else 0o700
                contents = b"synthetic unchanged document"
                item.size = len(contents) if item.isfile() else 0
                for key, value in (changes or {}).get(name, {}).items():
                    setattr(item, key, value)
                archive.addfile(item, io.BytesIO(contents) if item.isfile() else None)
        return path

    def test_document_inventory_detects_metadata_loss_with_identical_bytes(self):
        expected = kit.document_inventory(self.document_tar())
        self.assertEqual(set(expected), {".", "nested", "empty", "nested/document"})
        for name in expected:
            for field, value in (("uid", 0), ("gid", 0), ("mode", 0o755)):
                with self.subTest(name=name, field=field):
                    observed = kit.document_inventory(self.document_tar({name: {field: value}}))
                    self.assertEqual(observed["nested/document"]["sha256"],
                                     expected["nested/document"]["sha256"])
                    self.assertNotEqual(observed, expected)

    def test_document_metadata_unsafe_or_incomplete_is_denied(self):
        for name in (".", "nested/document"):
            for field, value in (("uid", -1), ("gid", 2**32 - 1), ("mode", 0o4700)):
                with self.subTest(name=name, field=field):
                    self.denied("DOCUMENT_ARCHIVE_METADATA_UNSUPPORTED", kit.document_inventory,
                                self.document_tar({name: {field: value}}))
        self.denied("DOCUMENT_ARCHIVE_ROOT_MISSING", kit.document_inventory,
                    self.document_tar(omit=(".",)))
        self.denied("DOCUMENT_ARCHIVE_DIRECTORY_MISSING", kit.document_inventory,
                    self.document_tar(omit=("nested",)))

    def test_duplicate_roots_and_roots_over_entry_limit_are_denied(self):
        path = self.tar([(".", tarfile.DIRTYPE, b""), ("./", tarfile.DIRTYPE, b"")])
        self.denied("ARCHIVE_DUPLICATE_PATH", kit.safe_members, path)
        with patch.object(kit, "MAX_MEMBERS", 1):
            self.denied("ARCHIVE_ENTRY_LIMIT", kit.safe_members, path)

    def test_valid_pinned_plan_and_no_preflight_side_effect(self):
        plan = self.load()
        kit.preflight(plan)
        self.assertEqual(list(self.work.iterdir()), [])

    def test_plan_changed_after_approval_denied(self):
        self.denied("PLAN_HASH_MISMATCH", self.load, expected="e" * 64)

    def test_unknown_plan_fields_not_ignored(self):
        self.plan["environment_override"] = {"DOCKER_HOST": "tcp://outside:2375"}
        self.denied("PLAN_KEYS_INVALID", self.load)

    def test_duplicate_json_keys_denied(self):
        self.denied("DUPLICATE_JSON_KEY", kit.decode, b'{"phase":"receive","phase":"recover"}')

    def test_wrong_host_denied(self):
        self.plan["host"] = "different-receiver"
        self.denied("HOST_IDENTITY_MISMATCH", self.load)

    def test_same_host_not_off_host(self):
        self.plan["sender_host"] = socket.gethostname()
        self.denied("SAME_HOST_TRANSFER_DENIED", self.load)

    def test_program_replacement_denied(self):
        self.plan["program_sha256"] = "e" * 64
        self.denied("RECEIVER_PROGRAM_MISMATCH", self.load)

    def test_receiver_production_host_denied(self):
        self.plan["host"] = "fai-crm-prod-02"
        with patch.object(kit.socket, "gethostname", return_value="fai-crm-prod-02"):
            self.denied("PRODUCTION_DESTINATION_DENIED", self.load)

    def test_private_plan_permissions_and_hardlink_denied(self):
        p = self.file("public.json", b"{}", 0o644)
        self.denied("PRIVATE_REGULAR_FILE_REQUIRED", kit.private_file, p)
        p.chmod(0o600)
        os.link(p, self.root / "alias")
        self.denied("PRIVATE_REGULAR_FILE_REQUIRED", kit.private_file, p)

    def test_symlink_at_file_or_ancestor_denied(self):
        p = self.file("file")
        link = self.root / "link"
        link.symlink_to(p)
        self.denied("SYMLINK_DENIED", kit.private_file, link)
        alias = self.root / "directory-alias"
        alias.symlink_to(self.work, target_is_directory=True)
        self.denied("SYMLINK_DENIED", kit.path_checked, str(alias / "missing"), exists=False)

    def test_atomic_publish_never_overwrites_file_or_symlink(self):
        source = self.file("source", b"new")
        target = self.file("target", b"keep")
        self.denied("ATOMIC_DESTINATION_OCCUPIED_OR_UNAVAILABLE", kit.publish, source, target)
        self.assertEqual(target.read_bytes(), b"keep")
        link = self.root / "link"
        link.symlink_to(target)
        self.denied("ATOMIC_DESTINATION_OCCUPIED_OR_UNAVAILABLE", kit.publish, source, link)
        kit.publish(source, self.root / "new")
        self.assertFalse(source.exists())

    def test_safe_nested_archive_extracts_exact_bytes(self):
        p = self.tar([("nested/file", tarfile.REGTYPE, b"new synthetic document")])
        target = self.root / "extract"
        kit.unpack(p, target)
        self.assertEqual((target / "nested/file").read_bytes(), b"new synthetic document")
        self.assertEqual((target / "nested/file").stat().st_mode & 0o777, 0o600)
        self.assertEqual((target / "nested").stat().st_mode & 0o777, 0o700)

    def test_traversal_and_special_files_denied_before_extract(self):
        for name, kind in [("../outside", tarfile.REGTYPE), ("/absolute", tarfile.REGTYPE),
                           ("link", tarfile.SYMTYPE), ("hardlink", tarfile.LNKTYPE),
                           ("fifo", tarfile.FIFOTYPE), ("a\\b", tarfile.REGTYPE)]:
            with self.subTest(name=name):
                p = self.tar([(name, kind, b"x")])
                with self.assertRaises(kit.Denied):
                    kit.unpack(p, self.root / "never-created")
                self.assertFalse((self.root / "never-created").exists())

    def test_duplicate_or_file_parent_collision_denied_before_extract(self):
        for entries in [[("same", tarfile.REGTYPE, b"1"), ("same", tarfile.REGTYPE, b"2")],
                        [("a/b", tarfile.REGTYPE, b"1"), ("a", tarfile.REGTYPE, b"2")]]:
            p = self.tar(entries)
            with self.assertRaises(kit.Denied):
                kit.unpack(p, self.root / "never-created")
            self.assertFalse((self.root / "never-created").exists())

    def test_archive_entry_size_and_exact_inventory_limits(self):
        p = self.tar([("a", tarfile.REGTYPE, b"1234"), ("b", tarfile.REGTYPE, b"5678")])
        with patch.object(kit, "MAX_FILE", 7):
            self.denied("ARCHIVE_SIZE_LIMIT", kit.safe_members, p)
        with patch.object(kit, "MAX_MEMBERS", 1):
            self.denied("ARCHIVE_ENTRY_LIMIT", kit.safe_members, p)
        self.denied("ARCHIVE_INVENTORY_MISMATCH", kit.safe_members, p, exact={"a"})

    def test_truncated_archive_rejected(self):
        p = self.tar([("a", tarfile.REGTYPE, b"x" * 1024)])
        p.write_bytes(p.read_bytes()[:700])
        with self.assertRaises(tarfile.TarError):
            kit.safe_members(p)

    def test_private_coverage_cannot_contain_symlinks_or_empty_placeholder(self):
        self.denied("COVERAGE_COMPONENT_EMPTY", kit.private_inventory, self.work)
        (self.work / "alias").symlink_to(self.file("secret"))
        self.denied("SYMLINK_DENIED", kit.private_inventory, self.work)

    def test_operation_resume_requires_identical_plan_and_lock(self):
        op = kit.Operation(self.plan, "a" * 64)
        op.event("STARTED")
        self.denied("OPERATION_BUSY", kit.Operation, self.plan, "a" * 64, resume=True)
        op.close()
        self.denied("RESUME_IDENTITY_MISMATCH", kit.Operation, self.plan, "b" * 64, resume=True)
        self.denied("OPERATION_ALREADY_EXISTS", kit.Operation, self.plan, "a" * 64)
        resumed = kit.Operation(self.plan, "a" * 64, resume=True)
        self.assertEqual(resumed.events()[0]["phase"], "STARTED")
        resumed.close()

    def receiver_cli(self, command="receive", resume=True):
        path = self.file("receiver-plan.json", kit.canonical(self.plan))
        args = ["kit", command, "--plan", str(path), "--plan-sha256", kit.digest(path),
                "--authorize", "FAI_CRM_N05_RECOVERY_" + command.upper() + "_V1"]
        if resume:
            args.append("--resume")
        output = io.StringIO()
        with patch.object(kit.sys, "argv", args), patch.object(kit.sys, "stdout", output), \
             patch.object(kit.sys, "stdin", io.TextIOWrapper(io.BytesIO(b"abc"))):
            try:
                kit.main()
            finally:
                kit.signal.alarm(0)
        return json.loads(output.getvalue())

    def test_receiver_cli_resume_initializes_only_missing_operation(self):
        receipt = self.receiver_cli()
        self.assertEqual(receipt["status"], "RECEIVE_VERIFIED")
        root = self.work / self.plan["run_id"]
        original = (root / "operation.json").read_bytes()
        repeat = self.receiver_cli()
        self.assertEqual(repeat["bundle_sha256"], receipt["bundle_sha256"])
        self.assertEqual((root / "operation.json").read_bytes(), original)
        self.assertEqual((root / "received.bundle.tar").read_bytes(), b"abc")

    def test_receiver_resume_refuses_inconsistent_or_occupied_journal(self):
        root = self.work / self.plan["run_id"]
        root.mkdir(mode=0o700)
        kept = root / "preserve"
        kept.write_bytes(b"preexisting")
        kept.chmod(0o600)
        for kind in ("missing-journal", "wrong-plan"):
            if kind == "wrong-plan":
                kit.exclusive(root / "operation.json", kit.canonical({
                    "schema": kit.SCHEMA, "phase": "receive", "run_id": self.plan["run_id"],
                    "host": self.plan["host"], "plan_sha256": "0" * 64}))
            with self.subTest(kind=kind), patch.object(kit.sys, "stderr", io.StringIO()), \
                 self.assertRaises(SystemExit) as error:
                self.receiver_cli()
            self.assertEqual(error.exception.code, 1)
            self.assertEqual(kept.read_bytes(), b"preexisting")
            self.assertFalse((root / "received.bundle.tar").exists())

    def test_resume_initialization_does_not_apply_to_cleanup_or_sender(self):
        with patch.object(kit.sys, "stderr", io.StringIO()), self.assertRaises(SystemExit):
            self.receiver_cli(command="cleanup", resume=False)
        self.assertFalse((self.work / self.plan["run_id"]).exists())
        sender = self.plan | {"phase": "transfer"}
        self.denied("PATH_MISSING", kit.Operation, sender, "a" * 64, resume=True)
        self.assertFalse((self.work / self.plan["run_id"]).exists())

    def cleanup_fixture(self, kinds=("container", "volume")):
        plan = self.plan | {"phase": "recover", "run_id": kit.uuid.uuid4().hex,
                            "engine_id": "synthetic-engine", "postgres_image_id": "sha256:" + "1" * 64,
                            "expected": {"app_image_id": "sha256:" + "2" * 64}}
        plan["target_project"] = "fai-crm-recovery-" + plan["run_id"]
        plan["bundle"] = str(self.file("preserved-bundle-" + plan["run_id"], b"synthetic ciphertext"))
        plan["bundle_sha256"] = kit.digest(plan["bundle"])
        op = kit.Operation(plan, "a" * 64)
        self.addCleanup(op.close)
        names = kit.target_names(plan)
        labels = {kit.LABEL: plan["run_id"], kit.TEST_LABEL: plan["run_id"],
                  "it.finanzaagevolaimpresa.sentinel": kit.SENTINEL}
        resources = {}
        for kind in kinds:
            name = names["postgres"] if kind == "container" else names["documents_volume"]
            op.event("RESOURCE_INTENT", kind=kind, name=name)
            if kind == "container":
                resources[name] = {"Id": "c" * 64, "Config": {"Labels": labels.copy()}}
                op.event("RESOURCE_CREATED", kind=kind, name=name, resource_id="c" * 64)
            else:
                resources[name] = {"Name": name, "Labels": labels.copy(), "CreatedAt": "synthetic-created",
                                   "Mountpoint": "/synthetic/" + name, "Driver": "local"}
                op.event("RESOURCE_CREATED", kind=kind, name=name, created_at="synthetic-created",
                         mountpoint="/synthetic/" + name, driver="local")
        for component in kit.COMPONENTS:
            directory = op.root / component
            directory.mkdir(mode=0o700)
            kit.exclusive(directory / "synthetic", b"synthetic private material")
        calls = []

        def absent_image_docker(*args, **kwargs):
            calls.append(args)
            if args[0] == "info":
                return kit.canonical({"ID": plan["engine_id"], "OSType": "linux", "Name": "synthetic-engine"})
            if args[0] == "image":
                raise kit.Denied("COMMAND_FAILED_DOCKER")
            if args[0] == "inspect":
                return kit.canonical([resources[args[1]]])
            if args[:2] == ("volume", "inspect"):
                return kit.canonical([resources[args[2]]])
            if args[0] == "ps":
                values = [n for n, v in resources.items() if "Id" in v]
                return ("\n".join(values) + ("\n" if values else "")).encode()
            if args[:2] == ("volume", "ls"):
                values = [n for n, v in resources.items() if "Id" not in v]
                return ("\n".join(values) + ("\n" if values else "")).encode()
            if args[:2] == ("rm", "-f"):
                match = next(n for n, v in resources.items() if v.get("Id") == args[2])
                del resources[match]
                return b""
            if args[:2] == ("volume", "rm"):
                del resources[args[2]]
                return b""
            raise AssertionError("Unexpected Docker operation")
        return plan, op, resources, calls, absent_image_docker

    def test_cleanup_without_images_removes_owned_resources_and_plaintext(self):
        plan, op, resources, calls, docker = self.cleanup_fixture()
        original = Path(plan["bundle"]).read_bytes()
        with patch.object(kit, "docker", side_effect=docker):
            result = kit.cleanup(plan, op)
        self.assertEqual(result["status"], "CLEANUP_VERIFIED")
        self.assertEqual(resources, {})
        self.assertFalse(any(call[0] == "image" for call in calls))
        self.assertTrue(all(not (op.root / c).exists() for c in kit.COMPONENTS))
        self.assertEqual(Path(plan["bundle"]).read_bytes(), original)
        self.assertTrue((op.root / "operation.json").exists())

    def test_cleanup_without_images_still_rejects_foreign_or_replaced_resources(self):
        for kind in ("container", "volume"):
            for fault, code in (("foreign", "RESOURCE_OWNERSHIP_MISMATCH"),
                                ("replaced", "CLEANUP_RESOURCE_REPLACED"),
                                ("missing-receipt", "CLEANUP_CREATION_RECEIPT_MISSING")):
                with self.subTest(kind=kind, fault=fault):
                    plan, op, resources, calls, docker = self.cleanup_fixture((kind,))
                    value = next(iter(resources.values()))
                    if fault == "foreign":
                        labels = value["Config"]["Labels"] if kind == "container" else value["Labels"]
                        labels[kit.LABEL] = "unrelated-run"
                    elif fault == "replaced":
                        value["Id" if kind == "container" else "CreatedAt"] = "replaced-identity"
                    events = op.events()
                    if fault == "missing-receipt":
                        events = [e for e in events if e["phase"] != "RESOURCE_CREATED"]
                    with patch.object(kit, "docker", side_effect=docker), \
                         patch.object(op, "events", return_value=events):
                        self.denied(code, kit.cleanup, plan, op)
                    self.assertFalse(any(c[0] == "rm" or c[:2] == ("volume", "rm") for c in calls))
                    self.assertTrue(all((op.root / c).exists() for c in kit.COMPONENTS))

    def test_cleanup_identity_checks_survive_missing_images(self):
        for changes, code in (({"ID": "wrong"}, "DOCKER_ENGINE_MISMATCH"),
                              ({"OSType": "windows"}, "DOCKER_ENGINE_MISMATCH"),
                              ({"Name": "fai-crm-prod-02"}, "PRODUCTION_DOCKER_ENGINE_DENIED")):
            with self.subTest(changes=changes):
                plan, op, resources, calls, docker = self.cleanup_fixture()
                def altered_engine(*args, **kwargs):
                    if args[0] == "info":
                        return kit.canonical({"ID": plan["engine_id"], "OSType": "linux",
                                              "Name": "synthetic"} | changes)
                    return docker(*args, **kwargs)
                with patch.object(kit, "docker", side_effect=altered_engine):
                    self.denied(code, kit.cleanup, plan, op)
                self.assertEqual(calls, [])
                self.assertEqual(len(resources), 2)

    def test_new_recovery_still_requires_images_when_cleanup_does_not(self):
        plan, op, resources, calls, docker = self.cleanup_fixture()
        with patch.object(kit, "docker", side_effect=docker):
            self.denied("COMMAND_FAILED_DOCKER", kit.destination_preflight, plan)
        self.assertTrue(any(c[0] == "image" for c in calls))
        self.assertEqual(len(resources), 2)

    def test_interrupted_receive_resume_and_changed_destination(self):
        op = kit.Operation(self.plan, "a" * 64)
        try:
            with patch.object(kit.sys, "stdin", io.TextIOWrapper(io.BytesIO(b"a"))):
                self.denied("TRANSFER_INTERRUPTED", kit.receive, self.plan, op, False)
            partial = list(op.root.glob("incoming-*.partial"))
            self.assertEqual(len(partial), 1)
            self.assertFalse((op.root / "received.bundle.tar").exists())
            with patch.object(kit.sys, "stdin", io.TextIOWrapper(io.BytesIO(b"abc"))):
                receipt = kit.receive(self.plan, op, True)
            self.assertEqual(receipt["status"], "RECEIVE_VERIFIED")
            self.assertTrue(partial[0].exists())
            final = op.root / "received.bundle.tar"
            final.write_bytes(b"changed")
            with patch.object(kit.sys, "stdin", io.TextIOWrapper(io.BytesIO(b"abc"))):
                self.denied("RESUME_DESTINATION_CHANGED", kit.receive, self.plan, op, True)
            self.assertEqual(final.read_bytes(), b"changed")
        finally:
            kit.signal.alarm(0)
            op.close()

    def test_receive_altered_or_extra_ciphertext_no_success(self):
        for data, code in [(b"abd", "TRANSFER_CIPHERTEXT_MISMATCH"), (b"abcd", "TRANSFER_EXTRA_BYTES")]:
            self.plan["run_id"] = kit.uuid.uuid4().hex
            op = kit.Operation(self.plan, "a" * 64)
            try:
                with patch.object(kit.sys, "stdin", io.TextIOWrapper(io.BytesIO(data))):
                    self.denied(code, kit.receive, self.plan, op, False)
                self.assertFalse((op.root / "received.bundle.tar").exists())
                self.assertFalse(any(e["phase"] == "RECEIVE_VERIFIED" for e in op.events()))
            finally:
                kit.signal.alarm(0)
                op.close()

    def test_subprocess_diagnostics_and_environment_are_not_exposed(self):
        marker = "SYNTHETIC_PRIVATE_MARKER"
        with self.assertRaises(kit.Denied) as error:
            kit.run(["sh", "-c", "printf " + marker + " >&2; exit 1"])
        self.assertNotIn(marker, str(error.exception))
        with patch.dict(os.environ, {"DOCKER_HOST": "tcp://outside", "COMPOSE_FILE": "evil"}):
            value = kit.run(["sh", "-c", 'printf "%s|%s" "${DOCKER_HOST-unset}" "${COMPOSE_FILE-unset}"'])
        self.assertEqual(value, b"unset|unset")

    def test_cleanup_rejects_non_owned_material(self):
        root = self.root / "owned"
        root.mkdir(mode=0o700)
        outside = self.file("preserved")
        (root / "link").symlink_to(outside)
        self.denied("SYMLINK_DENIED", kit.remove_owned_tree, root)
        self.assertEqual(outside.read_bytes(), b"synthetic")

    def test_only_explicit_isolated_target_names_allowed(self):
        p = {"run_id": "a" * 32, "target_project": "fai-crm"}
        self.denied("RECOVERY_PROJECT_INVALID", kit.target_names, p)
        p["target_project"] = "fai-crm-recovery-" + p["run_id"]
        self.assertTrue(all(n.startswith(p["target_project"]) for n in kit.target_names(p).values()))

    def test_cleanup_labels_do_not_authorize_other_resources(self):
        self.denied("RESOURCE_OWNERSHIP_MISMATCH", kit.check_owner,
                    {"Labels": {kit.LABEL: self.plan["run_id"]}}, self.plan)

    def test_restored_migrations_require_exact_set_and_completed_checksums(self):
        expected = {"migration-" + str(n): kit.sha(str(n).encode()) for n in range(43)}
        observed = [{"name": n, "checksum": c, "finished": True, "rolled_back": False}
                    for n, c in expected.items()]
        kit.verify_restored_migrations(observed, expected)
        for field, value in (("checksum", "0" * 64), ("finished", False), ("rolled_back", True)):
            changed = copy.deepcopy(observed)
            changed[0][field] = value
            self.denied("RESTORED_MIGRATIONS_MISMATCH", kit.verify_restored_migrations, changed, expected)
        duplicate = observed[:-1] + [observed[0]]
        self.denied("RESTORED_MIGRATIONS_MISMATCH", kit.verify_restored_migrations, duplicate, expected)

    def test_cleanup_requires_recorded_instance_even_with_matching_labels(self):
        plan = self.plan | {"phase": "recover", "target_project": "fai-crm-recovery-" + self.plan["run_id"]}
        name = kit.target_names(plan)["postgres"]
        intent = {"phase": "RESOURCE_INTENT", "kind": "container", "name": name}
        created = {"phase": "RESOURCE_CREATED", "kind": "container", "name": name, "resource_id": "a" * 64}
        value = {"Id": "b" * 64, "Config": {"Labels": {
            kit.LABEL: plan["run_id"], kit.TEST_LABEL: plan["run_id"],
            "it.finanzaagevolaimpresa.sentinel": kit.SENTINEL}}}
        for events, code in (([intent], "CLEANUP_CREATION_RECEIPT_MISSING"),
                             ([intent, created], "CLEANUP_RESOURCE_REPLACED")):
            operation = SimpleNamespace(events=lambda: events)
            with patch.object(kit, "destination_identity", return_value=kit.target_names(plan)), \
                 patch.object(kit, "docker_object", return_value=value), \
                 patch.object(kit, "docker", return_value=(name + "\n").encode()) as commands:
                self.denied(code, kit.cleanup, plan, operation)
                self.assertFalse(any("rm" in call.args for call in commands.call_args_list))

    def test_backup_socket_and_engine_are_bound_before_wrapper(self):
        plan = {"host": socket.gethostname(), "data_class": "synthetic", "engine_id": "expected-engine",
                "environment": {"FAI_ENVIRONMENT": "restore-source", "EXPECTED_MIGRATION_COUNT": "43"}}
        with patch.object(kit, "docker", return_value=b'{"ID":"other-engine","OSType":"linux"}'), \
             patch.object(kit, "run") as runner:
            self.denied("BACKUP_DOCKER_ENGINE_MISMATCH", kit.backup_preflight, plan)
            runner.assert_not_called()
        with patch.object(kit, "docker", return_value=b'{"ID":"expected-engine","OSType":"linux"}'), \
             patch.object(kit, "verify_backup_configuration"), patch.object(kit, "run") as runner, \
             patch.dict(os.environ, {"DOCKER_CONTEXT": "unapproved-context"}):
            kit.backup_preflight(plan)
            self.assertEqual(runner.call_args.kwargs["env"]["DOCKER_HOST"], "unix:///var/run/docker.sock")
            self.assertNotIn("DOCKER_CONTEXT", runner.call_args.kwargs["env"])


if __name__ == "__main__":
    os.umask(0o077)
    unittest.main()
