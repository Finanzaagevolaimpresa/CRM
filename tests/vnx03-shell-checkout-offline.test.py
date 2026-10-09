"""Exercise real Git checkout filters and Bash headers; no bank/runtime is started."""

import os
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]
BASH = (str(Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe")
        if os.name == "nt" else "bash")
ENV = {key: value for key, value in os.environ.items()
       if key not in {"BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS"}}
PATTERNS = ("scripts/vnx03/*.sh", "tests/vnx03/*.sh", "tests/vnx03-pro-build-context-ci.sh")
ENTRYPOINTS = ("tests/vnx03/init-materials.sh", "tests/vnx03/wordpress-entrypoint.sh")


def git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, env=ENV, check=True,
                          capture_output=True, timeout=20).stdout


def checkout(path, attribute_path=None):
    # Per-command configuration: neither global nor repository config is changed.
    return git("-c", "core.autocrlf=true", "cat-file", "--filters",
               f"--path={attribute_path or path}", f"HEAD:{path}")


class ShellCheckout(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scripts = git("ls-files", "-z", "--", *PATTERNS).decode().strip("\0").split("\0")
        if not cls.scripts or any(not path for path in cls.scripts):
            raise AssertionError("VNX03_SHELL_SCRIPTS_MISSING")

    def test_windows_checkout_preserves_canonical_lf_bytes(self):
        for path in self.scripts:
            with self.subTest(path=path):
                blob = git("show", f"HEAD:{path}")
                self.assertNotIn(b"\r", blob)
                self.assertEqual(checkout(path), blob)

    def test_current_build_input_is_the_same_lf_script(self):
        for path in self.scripts:
            with self.subTest(path=path):
                self.assertEqual((ROOT / path).read_bytes(), checkout(path))

    def test_every_filtered_script_parses_without_execution(self):
        for path in self.scripts:
            with self.subTest(path=path):
                result = subprocess.run([BASH, "--noprofile", "--norc", "-n"],
                                        input=checkout(path), cwd=ROOT, env=ENV,
                                        capture_output=True, timeout=20)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_unrelated_path_retains_windows_conversion(self):
        path = ENTRYPOINTS[0]
        blob = git("show", f"HEAD:{path}")
        self.assertEqual(checkout(path, "outside-vnx03-checkout-control.sh"),
                         blob.replace(b"\n", b"\r\n"))

    def entrypoint_header(self, path):
        header = b"".join(checkout(path).splitlines(keepends=True)[:2])
        # Whitelist before executing only the inert header, never the script body.
        self.assertEqual(header, b"#!/usr/bin/env bash\nset -Eeuo pipefail\n")
        return header

    def run_header(self, header):
        return subprocess.run(
            [BASH, "--noprofile", "--norc", "-e", "-s"],
            input=header + b"printf '%s\\n' VNX03_HEADER_ONLY\n",
            cwd=ROOT, env=ENV, capture_output=True, timeout=20)

    def test_real_entrypoint_lf_headers_succeed(self):
        for path in ENTRYPOINTS:
            with self.subTest(path=path):
                result = self.run_header(self.entrypoint_header(path))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, b"VNX03_HEADER_ONLY\n")

    @unittest.skipIf(os.name == "nt", "Git Bash accepts CRLF; Linux CI must prove this denial")
    def test_linux_rejects_crlf_before_any_script_body(self):
        for path in ENTRYPOINTS:
            with self.subTest(path=path):
                result = self.run_header(self.entrypoint_header(path).replace(b"\n", b"\r\n"))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b"invalid option name", result.stderr)
                self.assertNotIn(b"VNX03_HEADER_ONLY", result.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
