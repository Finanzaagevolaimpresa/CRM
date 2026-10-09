"""Profile admission only: no Docker, database, PHP or network is executed."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BASH = (str(Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe")
        if os.name == "nt" else "bash")


class OfflineProfile(unittest.TestCase):
    def run_profile(self, **values):
        env = {k: v for k, v in os.environ.items()
               if not k.startswith("VNX03_") and k != "DOCKER_HOST"}
        env.update(values)
        return subprocess.run([
            BASH, "--noprofile", "--norc", "-c",
            'set -Eeuo pipefail; fail() { echo "$1"; exit 2; }; '
            'repo_root="$1"; source "$repo_root/scripts/vnx03/wpforms-profile.sh"; '
            'printf "%s|%s|%s|%s\\n" "$WPFORMS_EDITION" "$WPFORMS_SLUG" '
            '"$WPFORMS_VERSION" "$WORDPRESS_VERSION"',
            "offline-profile", ROOT.as_posix()
        ], env=env, text=True, capture_output=True, timeout=20)

    def rejected(self, code, **values):
        result = self.run_profile(**values)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(result.stdout.strip(), code)

    def test_default_lite_profile_preserved(self):
        result = self.run_profile()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "lite|wpforms-lite|2.0.1.1|7.1")

    def test_unknown_edition_cannot_fall_back(self):
        self.rejected("VNX03_WPFORMS_EDITION_INVALID", VNX03_WPFORMS_EDITION="latest")

    def test_pro_requires_existing_local_input_not_a_url(self):
        for value in ("", "https://wpforms.com/account/"):
            self.rejected("VNX03_PRO_PACKAGE_REQUIRED", VNX03_WPFORMS_EDITION="pro",
                          VNX03_PRO_PACKAGE=value)

    def inputs(self, archive):
        return {"VNX03_WPFORMS_EDITION": "pro", "VNX03_PRO_PACKAGE": archive.as_posix(),
                "VNX03_PRO_PYTHON": Path(sys.executable).as_posix(),
                "VNX03_EXPECTED_DOCKER_ENGINE_ID": "synthetic-engine-not-contacted",
                "VNX03_EXPECTED_DOCKER_CONTEXT": "synthetic-context-not-contacted",
                "VNX03_QUALIFICATION_PROFILE": "candidate-schema49"}

    def test_python_is_required_before_any_transport(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "synthetic.zip"
            archive.write_bytes(b"synthetic invalid archive")
            values = self.inputs(archive)
            values.pop("VNX03_PRO_PYTHON")
            self.rejected("VNX03_PRO_PYTHON_REQUIRED", **values)

    def test_both_local_engine_bindings_required(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "synthetic.zip"
            archive.write_bytes(b"synthetic invalid archive")
            for key in ("VNX03_EXPECTED_DOCKER_ENGINE_ID", "VNX03_EXPECTED_DOCKER_CONTEXT"):
                values = self.inputs(archive)
                values.pop(key)
                self.rejected("VNX03_PRO_LOCAL_ENGINE_BINDING_REQUIRED", **values)

    def test_historical_schema_not_accepted_for_pro(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "synthetic.zip"
            archive.write_bytes(b"synthetic invalid archive")
            values = self.inputs(archive)
            values["VNX03_QUALIFICATION_PROFILE"] = "historical-schema44"
            self.rejected("VNX03_PRO_SCHEMA49_REQUIRED", **values)

    def test_docker_host_override_is_rejected_without_contact(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "synthetic.zip"
            archive.write_bytes(b"synthetic invalid archive")
            values = self.inputs(archive)
            values["DOCKER_HOST"] = "tcp://synthetic.invalid:2376"
            self.rejected("VNX03_PRO_DOCKER_HOST_OVERRIDE_FORBIDDEN", **values)

    def test_actual_validator_denies_wrong_input_before_docker(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "synthetic.zip"
            archive.write_bytes(b"synthetic invalid archive")
            self.rejected("VNX03_PRO_PACKAGE_ADMISSION_FAILED", **self.inputs(archive))


if __name__ == "__main__":
    unittest.main(verbosity=2)
