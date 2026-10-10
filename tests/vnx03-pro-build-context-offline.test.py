"""Exercise the real bounded-parts staging boundary with synthetic bytes only."""
import argparse
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("pro_admission", ROOT / "scripts/vnx03/pro-docker-admission.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PackageContext(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pro context ")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.runtime = self.base / "fai-vnx03.Abc123"
        self.runtime.mkdir()
        self.package = self.base / "input.zip"
        self.package.write_bytes(b"synthetic archive transport fixture\n" * 20000)
        self.args = argparse.Namespace(repository=str(ROOT), package=str(self.package),
            runtime_directory=str(self.runtime), wpforms_sha=hashlib.sha256(self.package.read_bytes()).hexdigest())

    def test_payload_larger_than_secret_limit_copies_only_exact_admitted_file(self):
        (self.base / "unrelated-private.txt").write_bytes(b"must not enter context")
        result = module.stage_package(self.args)
        self.assertGreater(result["bytes"], 500 * 1024)
        target = module.verify_package_directory(self.args)
        self.assertEqual(sorted(p.name for p in target.iterdir()), [f"{i:02d}" for i in range(32)])
        self.assertEqual(b"".join((target / f"{i:02d}").read_bytes() for i in range(32)), self.package.read_bytes())
        self.assertTrue((self.base / "unrelated-private.txt").exists())

    def test_wrong_digest_and_repository_input_do_not_create_context(self):
        self.args.wpforms_sha = "f" * 64
        with self.assertRaisesRegex(module.Rejected, "DIGEST_MISMATCH"):
            module.stage_package(self.args)
        self.assertFalse((self.runtime / "pro-package").exists())
        self.args.package = str(ROOT / "package.json")
        with self.assertRaisesRegex(module.Rejected, "PATH_INVALID"):
            module.stage_package(self.args)

    def test_existing_destination_is_not_reused_or_overwritten(self):
        module.stage_package(self.args)
        before = (self.runtime / "pro-package/00").read_bytes()
        with self.assertRaises(FileExistsError):
            module.stage_package(self.args)
        self.assertEqual((self.runtime / "pro-package/00").read_bytes(), before)

    def test_extra_file_or_changed_bytes_stop_before_build(self):
        module.stage_package(self.args)
        target = Path(self.args.package_directory)
        (target / "extra").write_bytes(b"synthetic")
        with self.assertRaisesRegex(module.Rejected, "EXTRA_FILES"):
            module.verify_package_directory(self.args)
        (target / "extra").unlink()
        (target / "00").write_bytes(b"changed")
        with self.assertRaisesRegex(module.Rejected, "BYTES_CHANGED"):
            module.verify_package_directory(self.args)

    def test_parent_directory_or_foreign_context_is_rejected(self):
        module.stage_package(self.args)
        self.args.package_directory = str(self.base)
        with self.assertRaisesRegex(module.Rejected, "CONTEXT_INVALID"):
            module.verify_package_directory(self.args)
        self.args.runtime_directory = str(self.base)
        with self.assertRaisesRegex(module.Rejected, "DIRECTORY_INVALID"):
            module.stage_package(self.args)

    def test_links_cannot_substitute_context_or_package(self):
        link = self.base / "link.zip"
        try:
            link.symlink_to(self.package)
        except OSError:
            self.skipTest("Host cannot create a test symlink; CI Linux covers this case")
        self.args.package = str(link)
        with self.assertRaisesRegex(module.Rejected, "PATH_INVALID"):
            module.stage_package(self.args)


if __name__ == "__main__":
    unittest.main(verbosity=2)
