#!/usr/bin/env python3
"""Exercise the real backup preflight with bounded synthetic command streams."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]

DOCKER = r"""#!/usr/bin/env python3
import os
from pathlib import Path
import signal
import sys
import time

signal.signal(signal.SIGPIPE, signal.SIG_DFL)
args = sys.argv[1:]
if args[0] == "compose" and args[-2] == "config":
    option = args[-1]
    if option == "--quiet":
        sys.exit(0)
    if option == "--services":
        print("app\npostgres")
        sys.exit(0)
    if option == "--volumes":
        print("restore_documents\nrestore_postgres_data")
        sys.exit(0)
    if option == "--images":
        mode = os.environ["SYNTHETIC_IMAGE_MODE"]
        expected = os.environ["APP_IMAGE"]
        if mode == "missing":
            print(expected + "-different")
            sys.exit(0)
        os.write(1, (expected + "\n").encode())
        if mode == "producer-failure":
            sys.exit(23)
        time.sleep(0.05)
        # More than a pipe buffer, after the match: early grep -q cannot drain it.
        for _ in range(16):
            os.write(1, b"fai-crm:synthetic-other\n" * 4096)
        Path(os.environ["SYNTHETIC_PRODUCER_COMPLETE"]).write_text("complete")
        sys.exit(0)
if args[:2] == ["image", "inspect"]:
    Path(os.environ["SYNTHETIC_IMAGE_INSPECTED"]).write_text("inspected")
    print("sha256:" + "b" * 64 if args[3] == "{{.Id}}" else "")
    sys.exit(0)
raise SystemExit("unexpected synthetic docker invocation")
"""

GIT = """#!/usr/bin/env python3
import os
import sys
if sys.argv[-2:] != ["rev-parse", os.environ["SOURCE_COMMIT"] + "^{tree}"]:
    raise SystemExit("unexpected synthetic git invocation")
print(os.environ["SOURCE_TREE"])
"""


class BackupImageStream(unittest.TestCase):
    def run_case(self, mode):
        with tempfile.TemporaryDirectory(prefix="fai-crm-backup-image-unit-") as temporary:
            work = Path(temporary)
            commands = work / "bin"
            commands.mkdir()
            for name, content in (("docker", DOCKER), ("git", GIT)):
                command = commands / name
                command.write_text(content)
                command.chmod(0o700)
            backups = work / "backups"
            backups.mkdir(mode=0o700)
            environment_file = work / "synthetic.env"
            environment_file.write_text("# synthetic fixture only\n")
            complete, inspected = work / "complete", work / "inspected"
            environment = dict(os.environ, PATH=str(commands) + os.pathsep + os.environ["PATH"],
                FAI_ENVIRONMENT="restore-source", FAI_ENVIRONMENT_SENTINEL="FAI_CRM_N05_RESTORE_SOURCE_V1",
                COMPOSE_PROJECT_NAME="fai-crm-restore-image-unit-source",
                COMPOSE_FILE=str(ROOT / "docker-compose.restore-drill.yml"),
                ENV_FILE=str(environment_file), APP_ORIGIN="http://app:3000",
                APP_IMAGE="fai-crm:synthetic-expected", BACKUP_ROOT=str(backups),
                BACKUP_SET_ID="synthetic-set", SOURCE_COMMIT="a" * 40, SOURCE_TREE="b" * 40,
                EXPECTED_APP_IMAGE_ID="sha256:" + "a" * 64, BACKUP_IMAGE_PROVENANCE="oci-labels",
                BACKUP_RESOURCE_PROVENANCE="n05-labels", EXPECTED_DATABASE_NAME="synthetic",
                BACKUP_CONSISTENCY="application-quiesced", SYNTHETIC_IMAGE_MODE=mode,
                SYNTHETIC_PRODUCER_COMPLETE=str(complete), SYNTHETIC_IMAGE_INSPECTED=str(inspected))
            result = subprocess.run(["bash", str(ROOT / "scripts/n05/backup-compose.sh"), "--preflight"],
                env=environment, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(list(backups.iterdir()), [])
            return result.stderr, complete.exists(), inspected.exists()

    def test_match_drains_stream_and_reaches_next_identity_guard(self):
        error, complete, inspected = self.run_case("match-streamed")
        self.assertIn("N05_FAILED|code=BACKUP_APP_IMAGE_ID_MISMATCH", error)
        self.assertTrue(complete)
        self.assertTrue(inspected)

    def test_nonmatching_image_is_denied_before_inspection(self):
        error, complete, inspected = self.run_case("missing")
        self.assertIn("N05_FAILED|code=BACKUP_COMPOSE_IMAGE_MISMATCH", error)
        self.assertFalse(complete)
        self.assertFalse(inspected)

    def test_producer_failure_is_denied_even_when_image_matches(self):
        error, complete, inspected = self.run_case("producer-failure")
        self.assertIn("N05_FAILED|code=BACKUP_COMPOSE_IMAGE_MISMATCH", error)
        self.assertFalse(complete)
        self.assertFalse(inspected)


if __name__ == "__main__":
    unittest.main()
