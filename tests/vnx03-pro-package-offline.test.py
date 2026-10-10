"""Offline admission tests: byte fixtures only, no Docker, DB, network or PHP."""

import hashlib
from contextlib import redirect_stdout
import importlib.util
import io
from pathlib import Path
import stat
import tempfile
import unittest
import warnings
import zipfile

spec = importlib.util.spec_from_file_location(
    "pro_package", Path(__file__).resolve().parents[1] /
    "scripts/vnx03/inspect-wpforms-pro-package.py")
admission = importlib.util.module_from_spec(spec)
spec.loader.exec_module(admission)

HEADER = b"""<?php
/**
 * Plugin Name: WPForms
 * Plugin URI: https://wpforms.com
 * Author: WPForms
 * Version: 2.0.2.2
 * License: GPL v2 or later
 */
"""


def fixture(extra=(), header=HEADER, missing=None, method=zipfile.ZIP_DEFLATED):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=method) as archive:
        for name in admission.REQUIRED:
            if name != missing:
                archive.writestr(name, header if name.endswith("/wpforms.php") else b"<?php // synthetic")
        for name, value in extra:
            archive.writestr(name, value)
    return output.getvalue()


class OfflineAdmission(unittest.TestCase):
    def inspect(self, data, **kwargs):
        return admission.inspect_archive(data, kwargs.get("version", "2.0.2.2"),
                                         kwargs.get("sha", hashlib.sha256(data).hexdigest()))

    def reject(self, data, code, **kwargs):
        with self.assertRaisesRegex(admission.Rejected, "^" + code + "$"):
            self.inspect(data, **kwargs)

    def test_valid_bytes_are_not_runtime_or_authenticity_proof(self):
        result = self.inspect(fixture())
        self.assertEqual(result["declaredVersion"], "2.0.2.2")
        self.assertEqual(len(result["sourceHashes"]), 3)
        for key in ("sourceAuthenticityAttested", "runtimeQualified", "filesExtracted", "codeExecuted"):
            self.assertIs(result[key], False)

    def test_exact_version_and_digest_are_required(self):
        self.reject(fixture(), "PRO_ARCHIVE_DIGEST_MISMATCH", sha="0" * 64)
        self.reject(fixture(header=HEADER.replace(b"2.0.2.2", b"2.0.1.1")), "PRO_VERSION_MISMATCH")
        self.reject(fixture(), "PRO_EXPECTED_VERSION_INVALID", version="latest")
        self.reject(fixture(), "PRO_EXPECTED_DIGEST_INVALID", sha="")

    def test_lite_or_missing_processor_cannot_be_admitted(self):
        for name in admission.REQUIRED:
            with self.subTest(name=name):
                self.reject(fixture(missing=name), "PRO_REQUIRED_SOURCE_MISSING")

    def test_path_traversal_absolute_ads_and_wrong_root_rejected(self):
        for name in ("wpforms/../escape.php", "/wpforms/absolute.php", "wpforms/a:b", "wpforms//x", "wpforms/./x"):
            with self.subTest(name=name):
                self.reject(fixture([(name, b"synthetic")]), "PRO_PATH_REJECTED")
        self.reject(fixture([("other/x.php", b"synthetic")]), "PRO_ROOT_REJECTED")
        # ZipInfo normalizes host separators when writing on Windows. Mutate
        # both stored names to test actual archive bytes, not a normalized fixture.
        backslash = fixture([("wpforms/x", b"synthetic")]).replace(b"wpforms/x", b"wpforms\\x")
        self.reject(backslash, "PRO_PATH_REJECTED")

    def test_duplicates_and_case_collisions_rejected(self):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            self.reject(fixture([("wpforms/wpforms.php", HEADER)]), "PRO_DUPLICATE_PATH_REJECTED")
        self.reject(fixture([("wpforms/WPFORMS.php", HEADER)]), "PRO_DUPLICATE_PATH_REJECTED")

    def test_symlink_and_nonregular_member_rejected(self):
        for kind, code in ((stat.S_IFLNK, "PRO_SYMLINK_REJECTED"), (stat.S_IFIFO, "PRO_SPECIAL_FILE_REJECTED")):
            info = zipfile.ZipInfo("wpforms/extra")
            info.create_system = 3
            info.external_attr = (kind | 0o600) << 16
            self.reject(fixture([(info, b"synthetic")]), code)

    def test_private_configuration_rejected_without_content_output(self):
        for name in ("wp-config.php", ".env", "id_rsa", "id_ed25519"):
            with self.subTest(name=name):
                self.reject(fixture([("wpforms/" + name, b"SYNTHETIC_VALUE_NOT_A_SECRET")]), "PRO_PRIVATE_CONFIGURATION_REJECTED")

    def test_header_spoofing_and_ambiguity_rejected(self):
        self.reject(fixture(header=HEADER.replace(b"Plugin Name: WPForms", b"Plugin Name: Other")), "PRO_IDENTITY_REJECTED")
        self.reject(fixture(header=HEADER.replace(b"https://wpforms.com", b"https://wpforms.com.evil.invalid")), "PRO_IDENTITY_REJECTED")
        self.reject(fixture(header=HEADER + b"\n * Version: 2.0.2.2\n"), "PRO_HEADER_AMBIGUOUS")

    def test_crc_error_truncation_and_wrong_format_rejected(self):
        raw = bytearray(fixture(method=zipfile.ZIP_STORED))
        offset = raw.index(b"synthetic")
        raw[offset] ^= 1
        self.reject(bytes(raw), "PRO_ZIP_CONTENT_INVALID")
        self.reject(fixture()[:-30], "PRO_ZIP_INVALID")
        self.reject(b"not a zip", "PRO_ZIP_INVALID")

    def test_compression_bomb_is_rejected_before_inflation(self):
        self.reject(fixture([("wpforms/bomb.txt", b"0" * (8 * 1024 * 1024))]), "PRO_COMPRESSION_RATIO_REJECTED")

    def test_cli_rejects_archive_inside_declared_checkout_before_reading_content(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "package.zip"
            path.write_bytes(b"not opened by the content validator")
            output = io.StringIO()
            with redirect_stdout(output):
                code = admission.main([str(path), "--expected-version", "2.0.2.2",
                                       "--expected-sha256", "0" * 64,
                                       "--outside-directory", directory])
            self.assertEqual(code, 2)
            self.assertIn('"code": "PRO_INPUT_INSIDE_CHECKOUT_REJECTED"', output.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)
