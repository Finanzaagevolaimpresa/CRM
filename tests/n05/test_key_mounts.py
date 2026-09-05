"""Behavior tests for the shared N05 validators. No Docker daemon is called."""
import copy
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("n05_keys", ROOT / "scripts/n05/key_mounts.py")
n05 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(n05)


def models():
    project = "fai-crm-vnx04-unit"
    model = {
        "name": project,
        "services": {
            "app": {
                "image": "fai-crm:synthetic",
                "environment": {k: "" for k in n05.KEYS} | {"FEATURE_INTEGRATIONS_ENABLED": "false"},
                "volumes": [{"type": "volume", "source": "crm_documents", "target": "/var/lib/fai-crm/documents"}],
            },
            "postgres": {"volumes": [{"type": "volume", "source": "postgres_data", "target": "/var/lib/postgresql/data"}]},
        },
        "volumes": {k: {"external": True, "name": project + "_" + k} for k in ("crm_documents", "postgres_data")},
        "networks": {"default": {"external": True, "name": project + "_default"}},
    }
    mounted = copy.deepcopy(model)
    for key, (name, target) in n05.KEYS.items():
        mounted["services"]["app"]["environment"][key] = target
        mounted["services"]["app"]["volumes"].append({
            "type": "bind", "source": "/private/" + name, "target": target,
            "read_only": True, "bind": {"create_host_path": False},
        })
    return model, mounted, project


class ModelTests(unittest.TestCase):
    def test_only_two_read_only_app_mounts_and_references_are_accepted(self):
        plain, mounted, project = models()
        n05.validate_pair(plain, mounted, project, Path("/private"))

    def test_rejects_unexpected_effective_configuration(self):
        mutations = [
            lambda m: m["services"]["app"]["volumes"][-1].update(read_only=False),
            lambda m: m["services"]["app"]["volumes"][-1]["bind"].update(create_host_path=True),
            lambda m: m["services"]["app"]["volumes"][-1].update(target="/app/key.json"),
            lambda m: m["services"]["app"]["volumes"][-1].update(source="/var/lib/fai-crm/documents/key"),
            lambda m: m["services"]["app"]["volumes"].append({"type": "bind", "source": "/var/run/docker.sock", "target": "/socket"}),
            lambda m: m["services"]["postgres"]["volumes"].append(m["services"]["app"]["volumes"][-1]),
            lambda m: m["services"]["app"].update(privileged=True),
            lambda m: m["services"]["app"].update(user="root"),
            lambda m: m["services"]["app"].update(cap_add=["SYS_ADMIN"]),
            lambda m: m["services"]["app"].update(post_start=[{"command": "consumer"}]),
            lambda m: m["services"].update(consumer={"image": "unexpected"}),
            lambda m: m["volumes"]["postgres_data"].update(external=False),
            lambda m: m["networks"]["default"].update(name="another_network"),
            lambda m: m["services"]["app"]["environment"].update(SECURE_LEAD_GATEWAY_MODE="enforced"),
            lambda m: m["services"]["app"]["environment"].update(PRIVILEGED_STEP_UP_SECRET_FILE="/run/secrets/forbidden"),
            lambda m: m["services"]["app"].update(image="different"),
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                plain, mounted, project = models()
                mutate(mounted)
                with self.assertRaises(n05.Denied):
                    n05.validate_pair(plain, mounted, project, Path("/private"))

    def test_ordinary_references_must_be_empty(self):
        plain, mounted, project = models()
        plain["services"]["app"]["environment"]["LEAD_IDENTITY_KEY_FILE"] = "/unexpected"
        with self.assertRaises(n05.Denied):
            n05.validate_pair(plain, mounted, project, Path("/private"))

    def test_compose_empty_ipam_is_accepted_but_configuration_is_not(self):
        plain, mounted, project = models()
        for model in (plain, mounted):
            model["networks"]["default"]["ipam"] = {}
        n05.validate_pair(plain, mounted, project, Path("/private"))
        for model in (plain, mounted):
            model["networks"]["default"]["ipam"] = {"config": [{"subnet": "10.2.0.0/16"}]}
        with self.assertRaises(n05.Denied):
            n05.validate_pair(plain, mounted, project, Path("/private"))

    def test_frozen_model_rejects_a_changed_compose_round_trip(self):
        original = {"services": {"app": {"environment": {"SYNTHETIC": "canary-$${NOT_AN_OVERRIDE}"}}}}
        class ComposeResult:
            def __init__(self, result):
                self.result = result
            def model(self, *_args):
                return self.result
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / "frozen.json"
            n05.freeze_model(ComposeResult(original), "synthetic", ROOT, original, file)
            self.assertEqual(n05.load_json(file), original)
            with self.assertRaisesRegex(n05.Denied, "FROZEN_COMPOSE_MODEL_MISMATCH"):
                n05.freeze_model(ComposeResult({}), "synthetic", ROOT, original, file)

    def test_duplicate_approval_keys_are_denied(self):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / "approval.json"
            file.write_text('{"image": "one", "image": "two"}')
            with self.assertRaises(n05.Denied):
                n05.load_json(file)

    def test_omitted_false_is_written_explicitly_but_true_is_never_normalized_away(self):
        plain, mounted, project = models()
        mounted["services"]["app"]["volumes"][-1]["bind"] = {}
        normalized = n05.normalize_compose_model(mounted)
        self.assertIs(normalized["services"]["app"]["volumes"][-1]["bind"]["create_host_path"], False)
        n05.validate_pair(plain, normalized, project, Path("/private"))
        mounted["services"]["app"]["volumes"][-1]["bind"] = {"create_host_path": True}
        with self.assertRaises(n05.Denied):
            n05.validate_pair(plain, n05.normalize_compose_model(mounted), project, Path("/private"))

    def test_production_entrypoint_has_no_synthetic_profile_or_environment_bypass(self):
        result = subprocess.run(["python3", str(ROOT / "scripts/n05/key_mounts.py"), "enable", "/missing"],
                                env=os.environ | {"N05_KEY_MOUNTS_OPERATION": "FAI_CRM_N05_SAME_IMAGE_KEYS_V1",
                                                  "FAI_ENVIRONMENT": "production", "N05_TEST_MODE": "true"},
                                text=True, capture_output=True, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr.strip(), "N05_FAILED|code=PRODUCTION_HOST_IDENTITY_MISMATCH")
        self.assertEqual(result.stdout, "")


class SourceTests(unittest.TestCase):
    def setUp(self):
        # Trusted parent chain is deliberately not /tmp (world-writable).
        self.temp = tempfile.TemporaryDirectory(prefix=".vnx04-keys-unit-", dir=Path.home())
        self.root = Path(self.temp.name)
        self.uid, self.gid = os.getuid(), os.getgid()
        if self.uid == 0:
            self.uid = self.gid = 1001
        for name, _ in n05.KEYS.values():
            file = self.root / name
            file.write_text('{"synthetic":true}')
            if os.getuid() == 0:
                os.chown(file, self.uid, self.gid)
            file.chmod(0o400)

    def tearDown(self):
        self.temp.cleanup()

    def test_valid_private_files(self):
        self.assertEqual(len(n05.validate_key_sources(self.root, self.uid, self.gid)), 2)

    def test_missing_is_not_created(self):
        file = self.root / "n12-keyring.json"
        file.unlink()
        with self.assertRaises(OSError):
            n05.validate_key_sources(self.root, self.uid, self.gid)
        self.assertFalse(file.exists())

    def test_symlink_file_and_parent_are_denied(self):
        file = self.root / "n12-keyring.json"
        file.unlink()
        file.symlink_to(self.root / "n13-identity.json")
        with self.assertRaises(n05.Denied):
            n05.validate_key_sources(self.root, self.uid, self.gid)
        alias = self.root / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(n05.Denied):
            n05.validate_key_sources(alias, self.uid, self.gid)

    def test_directory_fifo_hardlink_and_permissions_are_denied(self):
        file = self.root / "n12-keyring.json"
        for mode in (0o600, 0o440, 0o644, 0o777, 0o000, 0o4000):
            file.chmod(mode)
            with self.subTest(mode=mode), self.assertRaises(n05.Denied):
                n05.validate_key_sources(self.root, self.uid, self.gid)
        file.unlink()
        file.mkdir()
        with self.assertRaises(n05.Denied):
            n05.validate_key_sources(self.root, self.uid, self.gid)
        file.rmdir()
        os.mkfifo(file)
        with self.assertRaises(n05.Denied):
            n05.validate_key_sources(self.root, self.uid, self.gid)
        file.unlink()
        os.link(self.root / "n13-identity.json", file)
        with self.assertRaises(n05.Denied):
            n05.validate_key_sources(self.root, self.uid, self.gid)

    def test_uid_gid_root_and_parent_write_are_denied(self):
        for uid, gid in ((self.uid + 1, self.gid), (self.uid, self.gid + 1), (0, self.gid)):
            with self.assertRaises(n05.Denied):
                n05.validate_key_sources(self.root, uid, gid)
        self.root.chmod(0o777)
        with self.assertRaises(n05.Denied):
            n05.validate_key_sources(self.root, self.uid, self.gid)


class ProvenanceTests(unittest.TestCase):
    def test_exact_source_and_same_image_required(self):
        approval = {
            "image": "fai-crm:synthetic", "image_id": "sha256:" + "a" * 64,
            "image_source_commit": "b" * 40, "image_source_tree": "c" * 40,
        }
        image = {"Id": approval["image_id"], "Config": {"User": "nextjs", "Labels": {
            "org.opencontainers.image.revision": approval["image_source_commit"],
            "it.finanzaagevolaimpresa.source-tree": approval["image_source_tree"],
        }}}
        app = {"Image": image["Id"], "Config": {"Image": approval["image"], "User": "nextjs"}}
        n05.validate_provenance(image, app, approval)
        for key in ("image_id", "image_source_commit", "image_source_tree", "image"):
            wrong = approval | {key: "incoherent"}
            with self.subTest(key=key), self.assertRaises(n05.Denied):
                n05.validate_provenance(image, app, wrong)



class ToolGateTests(unittest.TestCase):
    def test_ci_identity_cannot_be_replaced_by_another_head(self):
        approval = {key: "" for key in n05.APPROVAL_KEYS}
        approval.update({
            "schema": "FAI_CRM_N05_KEY_MOUNTS_V1", "tools_commit": "a" * 40,
            "tools_tree": "b" * 40, "tools_first_parent": "c" * 40,
            "tools_ci_sha": "d" * 40, "tools_ci_conclusion": "success",
            "image_source_commit": "e" * 40, "image_source_tree": "f" * 40,
        })
        with self.assertRaisesRegex(n05.Denied, "TOOLS_CI_IDENTITY_MISMATCH"):
            n05.validate_tools(approval)

    def test_recovery_requires_both_artifacts_integrity_and_restore_attestation(self):
        with tempfile.TemporaryDirectory(prefix=".vnx04-recovery-", dir=Path.home()) as temp:
            root = Path(temp)
            for name in ("configuration.encrypted", "cryptographic-material.encrypted"):
                file = root / name
                file.write_bytes(b"synthetic-opaque-recovery-fixture")
                file.chmod(0o600)
            manifest = root / "SHA256SUMS"
            manifest.write_text("".join(n05.file_digest(root / name) + "  " + name + "\n"
                                       for name in ("configuration.encrypted", "cryptographic-material.encrypted")))
            manifest.chmod(0o600)
            approval = {"recovery_directory": str(root), "recovery_manifest_sha256": n05.file_digest(manifest)}
            previous = os.environ.pop("N05_RECOVERY_RESTORE_VERIFIED", None)
            try:
                with self.assertRaisesRegex(n05.Denied, "RECOVERY_RESTORE_ATTESTATION_MISSING"):
                    n05.recovery_gate(approval)
                os.environ["N05_RECOVERY_RESTORE_VERIFIED"] = "CONFIGURATION_AND_KEYS_RESTORE_VERIFIED"
                n05.recovery_gate(approval)
                (root / "cryptographic-material.encrypted").write_bytes(b"corrupted")
                with self.assertRaisesRegex(n05.Denied, "RECOVERY_ARTIFACT_INVALID"):
                    n05.recovery_gate(approval)
            finally:
                os.environ.pop("N05_RECOVERY_RESTORE_VERIFIED", None)
                if previous is not None:
                    os.environ["N05_RECOVERY_RESTORE_VERIFIED"] = previous


if __name__ == "__main__":
    unittest.main()
