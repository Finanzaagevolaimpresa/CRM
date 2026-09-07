#!/usr/bin/env python3
"""Real N05 -> age -> pinned SSH -> networkless PostgreSQL drill; synthetic only."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("kit", ROOT / "scripts/n05/recovery_kit.py")
kit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kit)
TEST_LABEL = "it.finanzaagevolaimpresa.recovery-test"
MARKER = b"SYNTHETIC_RECOVERY_PRIVATE_20260907"
passed = []


def check(value, name):
    if not value:
        raise RuntimeError("DRILL_ASSERTION_" + name)
    passed.append(name)
    print("N05_RECOVERY_CHECK_PASS|" + name, flush=True)


def command(args, *, data=None, timeout=300):
    result = subprocess.run([str(a) for a in args], input=data, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout, cwd=ROOT)
    if result.returncode:
        # Do not echo command arguments, database errors or private material.
        diagnostic = result.stderr + result.stdout
        # Only recognized tool failure categories are reported; contents stay private.
        categories = [code for code in (b"EACCES", b"EROFS", b"ECONNREFUSED", b"P1000",
                      b"P1001", b"P1002", b"P1012", b"P3018", b"P3006", b"not found",
                      b"permission denied", b"network", b"read-only") if code in diagnostic]
        print("DRILL_DIAGNOSTIC|" + ",".join(c.decode() for c in categories), file=sys.stderr)
        # Only technical error lines from this wholly synthetic fixture. Never
        # dump arbitrary stdout, command arguments, SQL rows or custody material.
        lines = []
        for line in diagnostic.decode(errors="replace").splitlines():
            if not re.search(r"error|fatal|failed|cannot|could not|unable|invalid|unsupported|Applying migration", line, re.I):
                continue
            line = line.replace(MARKER.decode(), "[synthetic-marker]").replace("synthetic-only", "[synthetic-password]")
            line = re.sub(r"postgres(?:ql)?://\S+", "[synthetic-database-url]", line)
            line = re.sub(r"AGE-SECRET-KEY-\S+", "[synthetic-age-identity]", line)
            if "PRIVATE KEY" not in line:
                lines.append(line[:300])
        print("DRILL_TECHNICAL_ERROR|" + " | ".join(lines[-8:]), file=sys.stderr)
        raise RuntimeError("DRILL_COMMAND_FAILED_" + Path(str(args[0])).name)
    return result.stdout


def docker(*args, data=None, timeout=300):
    return command(["docker", "--host", "unix:///var/run/docker.sock", *args], data=data, timeout=timeout)


def write(path, value):
    path.write_bytes(value)
    path.chmod(0o600)
    return path


def mkdir(path):
    path.mkdir(mode=0o700)
    return path


def basic(phase, work, binding):
    return {"schema": kit.SCHEMA, "phase": phase, "data_class": "synthetic",
            "run_id": uuid.uuid4().hex, "host": socket.gethostname(),
            "work_root": str(work), "tools": binding}


def save(root, plan):
    contents = kit.canonical(plan)
    path = root / (plan["run_id"] + "-" + kit.sha(contents)[:16] + ".json")
    if path.exists():
        if path.read_bytes() != contents:
            raise RuntimeError("FIXTURE_PLAN_REPLACED")
    else:
        write(path, contents)
    return path, kit.digest(path)


def invoke(root, plan, action=None, expect=None, data=None, extra=()):
    path, digest = save(root, plan)
    action = action or plan["phase"]
    args = ["python3", "-B", kit.PROGRAM, action, "--plan", path, "--plan-sha256", digest,
            "--authorize", "FAI_CRM_N05_RECOVERY_" + action.upper() + "_V1", *extra]
    result = subprocess.run([str(a) for a in args], input=data, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, cwd=ROOT, timeout=1200)
    check(MARKER not in result.stdout + result.stderr, "no-private-log-" + action)
    if expect:
        check(result.returncode != 0 and expect.encode() in result.stderr, expect)
        return None
    if result.returncode:
        # CLI diagnostic codes are deliberately minimized by the real kit.
        print(result.stderr.decode(), file=sys.stderr)
        raise RuntimeError("DRILL_KIT_COMMAND_FAILED_" + action)
    return json.loads(result.stdout)


def wait_sql(container):
    for _ in range(120):
        p = subprocess.run(["docker", "--host", "unix:///var/run/docker.sock", "exec", container,
                            "pg_isready", "-U", "fai_source", "-d", "fai_recovery_source"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if p.returncode == 0:
            return
        time.sleep(0.5)
    raise RuntimeError("SYNTHETIC_DATABASE_NOT_READY")


def tampered_bundle(source, destination):
    # Deliberately inconsistent authenticated ciphertext with a recomputed outer
    # checksum: this exercises age authentication, beyond the transport digest.
    with tarfile.open(source, "r:") as archive:
        members = {m.name: archive.extractfile(m).read() for m in archive if m.isfile()}
    payload = bytearray(members["database-documents.age"])
    payload[-1] ^= 1
    members["database-documents.age"] = bytes(payload)
    index = json.loads(members["INDEX.json"])
    index["components"]["database-documents"]["sha256"] = kit.sha(payload)
    members["INDEX.json"] = kit.canonical(index)
    with tarfile.open(destination, "w") as archive:
        for name, data in members.items():
            item = tarfile.TarInfo(name)
            item.size = len(data)
            item.mode = 0o600
            archive.addfile(item, io.BytesIO(data))
    destination.chmod(0o600)


def main():
    os.umask(0o077)
    check(os.environ.get("N05_RECOVERY_SYNTHETIC_CONFIRMED") == "1", "synthetic-confirmation")
    test_id = os.environ["N05_RECOVERY_TEST_ID"]
    check(len(test_id) == 32 and all(c in "0123456789abcdef" for c in test_id), "synthetic-run-id")
    network = os.environ["N05_RECOVERY_TEST_NETWORK"]
    runner_image = os.environ["N05_RECOVERY_RUNNER_IMAGE"]
    app_image = os.environ["N05_RECOVERY_APP_IMAGE"]
    pg_image = os.environ["N05_RECOVERY_POSTGRES_IMAGE"]
    network_info = json.loads(docker("network", "inspect", network))[0]
    check(network_info["Internal"] and network_info["Labels"].get(TEST_LABEL) == test_id,
          "internal-fixture-network")
    for image in (runner_image, app_image, pg_image):
        docker("image", "inspect", image)
    binding = kit.tools_binding()
    kit.verify_tools(binding)
    app = json.loads(docker("image", "inspect", app_image))[0]
    pg_id = json.loads(docker("image", "inspect", pg_image))[0]["Id"]
    source_commit = app["Config"]["Labels"]["org.opencontainers.image.revision"]
    source_tree = app["Config"]["Labels"]["it.finanzaagevolaimpresa.source-tree"]
    check(source_commit != binding["commit"], "distinct-image-and-tools-source")
    check(kit.git("rev-parse", source_commit + "^{tree}") == source_tree, "image-source-tree")
    engine = json.loads(docker("info", "--format", "{{json .}}"))["ID"]
    check(engine == os.environ["N05_RECOVERY_ENGINE_ID"], "orchestrator-engine-identity")
    before_containers = set(docker("ps", "-aq", "--no-trunc").decode().split())
    before_volumes = set(docker("volume", "ls", "-q").decode().split())
    source_project = "fai-crm-restore-" + test_id + "-source"
    source_pg = source_project + "-postgres"
    source_db = source_project + "_restore_postgres_data"
    source_docs = source_project + "_restore_documents"
    receiver = "fai-crm-recovery-receiver-" + test_id
    own_containers = {}
    own_volumes = {}
    recovery_plans = []
    with tempfile.TemporaryDirectory(prefix="fai-crm-n05-kit-drill-") as directory:
        root = Path(directory)
        root.chmod(0o700)
        work = mkdir(root / "operations")
        configs = mkdir(root / "configuration")
        keys = mkdir(root / "cryptographic")
        backups = mkdir(root / "backups")
        out = mkdir(root / "protected")
        keys_file = write(keys / "synthetic.key", MARKER + b"-key")
        config_file = write(configs / "synthetic.env", MARKER + b"-config")
        sentinel = "FAI_CRM_N05_RESTORE_SOURCE_V1"
        labels = ["--label", TEST_LABEL + "=" + test_id,
                  "--label", "com.docker.compose.project=" + source_project,
                  "--label", "it.finanzaagevolaimpresa.environment=restore-source",
                  "--label", "it.finanzaagevolaimpresa.sentinel=" + sentinel]
        def create_container(name, args):
            identifier = docker("create", "--name", name, *args).decode().strip()
            info = json.loads(docker("inspect", identifier))[0]
            check(info["Id"] == identifier and info["Config"]["Labels"].get(TEST_LABEL) == test_id,
                  "fixture-created-container-identity")
            own_containers[name] = identifier
            return identifier

        def fixture_helper(args, data=None):
            name = "fai-crm-recovery-fixture-" + uuid.uuid4().hex
            identifier = create_container(name, ["-i", "--pull", "never", *labels, *args])
            result = docker("start", "--attach", "--interactive", identifier, data=data)
            info = json.loads(docker("inspect", identifier))[0]
            check(info["Id"] == own_containers[name] and not info["State"]["Running"],
                  "fixture-helper-recorded-instance")
            docker("rm", identifier)
            del own_containers[name]
            check(info["State"]["ExitCode"] == 0, "fixture-helper-success")
            return result
        try:
            migration_files = [p for p in kit.git("ls-tree", "-r", "--name-only", source_commit,
                               "--", "prisma/migrations").splitlines() if p.endswith("/migration.sql")]
            canonical_migrations = {Path(p).parent.name: kit.sha(kit.run(
                ["git", "-C", ROOT, "show", source_commit + ":" + p])) for p in migration_files}
            image_migrations = json.loads(fixture_helper([
                "--network", "none", "--read-only", "--cap-drop", "ALL",
                "--security-opt", "no-new-privileges=true", "--entrypoint", "node", app_image,
                "-e", "const fs=require('fs'),c=require('crypto'),r={};"
                "for(const d of fs.readdirSync('/app/prisma/migrations',{withFileTypes:true})){"
                "if(d.isDirectory()){const p='/app/prisma/migrations/'+d.name+'/migration.sql';"
                "r[d.name]=c.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}}"
                "process.stdout.write(JSON.stringify(r));"]))
            check(len(canonical_migrations) == 43 and image_migrations == canonical_migrations,
                  "image-migration-bytes-match-canonical-git-before-database-creation")
            # These are new synthetic resources with the real N05 source identity.
            # Only this explicit internal network is used; no application server runs.
            for name, logical in [(source_db, "restore_postgres_data"), (source_docs, "restore_documents")]:
                check(name not in before_volumes, "new-source-volume-" + logical)
                docker("volume", "create", *labels, "--label", "com.docker.compose.volume=" + logical, name)
                info = json.loads(docker("volume", "inspect", name))[0]
                own_volumes[name] = {k: info[k] for k in ("Name", "CreatedAt", "Mountpoint", "Driver")}
            # Have Compose generate its own service metadata. This separate,
            # explicitly synthetic source fixture has one database and reuses
            # only the new volumes/network whose identities were recorded above.
            fixture_compose = write(root / "source-compose.json", kit.canonical({
                "name": source_project,
                "services": {"postgres": {
                    "image": pg_id, "container_name": source_pg,
                    "labels": {TEST_LABEL: test_id,
                               "it.finanzaagevolaimpresa.environment": "restore-source",
                               "it.finanzaagevolaimpresa.sentinel": sentinel},
                    "environment": {"POSTGRES_USER": "fai_source",
                                    "POSTGRES_DB": "fai_recovery_source",
                                    "POSTGRES_PASSWORD": "synthetic-only"},
                    "volumes": ["database:/var/lib/postgresql/data"],
                    "networks": {"default": {"aliases": ["postgres"]}}}},
                "volumes": {"database": {"external": True, "name": source_db}},
                "networks": {"default": {"external": True, "name": network}}}))
            check(not docker("ps", "-aq", "--filter", "name=^/" + source_pg + "$").strip(),
                  "source-container-name-empty-before-compose")
            docker("compose", "-p", source_project, "-f", fixture_compose,
                   "create", "--no-build", "--pull", "never", "postgres")
            source_id = docker("compose", "-p", source_project, "-f", fixture_compose,
                               "ps", "--all", "-q", "postgres").decode().strip()
            source_info = json.loads(docker("inspect", source_id))[0]
            check(source_info["Id"] == source_id
                  and source_info["Config"]["Labels"].get(TEST_LABEL) == test_id
                  and source_info["Name"] == "/" + source_pg,
                  "compose-created-source-recorded-id-and-owner")
            own_containers[source_pg] = source_id
            docker("start", source_id)
            wait_sql(source_pg)
            database_url = "postgresql://fai_source:synthetic-only@postgres:5432/fai_recovery_source?schema=public"
            fixture_helper(["--network", network,
                   "--tmpfs", "/tmp", "-e", "DATABASE_URL=" + database_url,
                   "--entrypoint", "npm", app_image, "run", "prisma:migrate:deploy"])
            sql = ('COMMENT ON DATABASE fai_recovery_source IS \'FAI_CRM_N05_RESTORE_SOURCE_V1\'; '
                   'CREATE TABLE recovery_synthetic_parent(id integer PRIMARY KEY, value text NOT NULL); '
                   'CREATE TABLE recovery_synthetic_child(id integer PRIMARY KEY, parent_id integer REFERENCES recovery_synthetic_parent(id)); '
                   "INSERT INTO recovery_synthetic_parent VALUES (7,'SYNTHETIC_RECOVERY_PRIVATE_20260907'); "
                   "INSERT INTO recovery_synthetic_child VALUES (9,7);")
            docker("exec", "-i", source_pg, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1",
                   "-U", "fai_source", "-d", "fai_recovery_source", data=sql.encode())
            docs = io.BytesIO()
            with tarfile.open(fileobj=docs, mode="w") as archive:
                item = tarfile.TarInfo("synthetic-document.txt")
                item.uid = item.gid = 1001
                item.mode = 0o600
                item.size = len(MARKER)
                archive.addfile(item, io.BytesIO(MARKER))
            fixture_helper(["--network", "none", "--tmpfs", "/var/lib/postgresql/data",
                   "--mount", "type=volume,src=" + source_docs + ",dst=/docs",
                   "--entrypoint", "tar", pg_id, "-xf", "-", "-C", "/docs"], data=docs.getvalue())
            check(True, "43-actual-prisma-migrations-and-relational-doc-fixture")
            env_file = write(root / "source.env", b"# synthetic only\n")
            env = {"FAI_ENVIRONMENT": "restore-source", "FAI_ENVIRONMENT_SENTINEL": sentinel,
                   "COMPOSE_PROJECT_NAME": source_project, "COMPOSE_FILE": str(ROOT / "docker-compose.restore-drill.yml"),
                   "ENV_FILE": str(env_file), "APP_ENV_FILE": str(env_file), "APP_ORIGIN": "http://app:3000",
                   "APP_IMAGE": app_image, "POSTGRES_IMAGE": pg_image, "DATABASE_URL": database_url,
                   "POSTGRES_USER": "fai_source", "POSTGRES_DB": "fai_recovery_source",
                   "POSTGRES_PASSWORD": "synthetic-only", "BACKUP_ROOT": str(backups),
                   "BACKUP_SET_ID": "synthetic-set", "SOURCE_COMMIT": source_commit, "SOURCE_TREE": source_tree,
                   "EXPECTED_APP_IMAGE_ID": app["Id"], "BACKUP_IMAGE_PROVENANCE": "oci-labels",
                   "BACKUP_RESOURCE_PROVENANCE": "n05-labels", "EXPECTED_DATABASE_NAME": "fai_recovery_source",
                   "EXPECTED_MIGRATION_COUNT": "43", "EXPECTED_DATABASE_SENTINEL": sentinel,
                   "BACKUP_CONSISTENCY": "application-quiesced"}
            backup_plan = basic("backup", work, binding) | {"environment": env,
                "env_file_sha256": kit.digest(env_file), "app_env_file_sha256": kit.digest(env_file)}
            invoke(root, backup_plan, "preflight")
            check(list(backups.iterdir()) == [], "backup-preflight-creates-no-set")
            invoke(root, backup_plan)
            backup = backups / "synthetic-set"
            original_backup = {p.name: kit.digest(p) for p in backup.iterdir()}
            check(set(original_backup) == kit.N05_FILES, "actual-n05-atomic-set")
            expected = {"environment": "restore-source", "project": source_project,
                        "source_commit": source_commit, "source_tree": source_tree,
                        "app_image_id": app["Id"], "image_provenance": "oci-labels",
                        "resource_provenance": "n05-labels", "migration_count": 43,
                        "manifest_sha256": kit.digest(backup / "MANIFEST.txt"),
                        "checksums_sha256": kit.digest(backup / "SHA256SUMS")}
            identity = root / "age.identity"
            command(["age-keygen", "-o", identity])
            identity.chmod(0o600)
            public = command(["age-keygen", "-y", identity]).decode().strip()
            protection = basic("protect", work, binding) | {
                "backup_set": str(backup), "expected": expected, "recipient": public,
                "configuration_dir": str(configs), "cryptographic_dir": str(keys),
                "configuration_sha256": kit.component_identity(configs)["sha256"],
                "cryptographic_sha256": kit.component_identity(keys)["sha256"],
                "output": str(out / "protected.bundle.tar")}
            protected = invoke(root, protection)
            check(protected["status"] == "PROTECTION_VERIFIED", "three-distinct-encrypted-components")
            bad = copy.deepcopy(protection)
            bad["run_id"] = uuid.uuid4().hex
            invoke(root, bad, expect="OUTPUT_OCCUPIED")
            check(keys_file.read_bytes() == MARKER + b"-key" and config_file.read_bytes() == MARKER + b"-config",
                  "source-config-and-key-preserved")
            for component, code in [("MANIFEST.txt", "MANIFEST_DIGEST_MISMATCH"),
                                    ("SHA256SUMS", "CHECKSUMS_IDENTITY_MISMATCH"),
                                    ("documents.tar.gz", "COMMAND_FAILED_BASH")]:
                damaged = mkdir(root / ("damaged-" + component.replace(".", "-")))
                for name in kit.N05_FILES:
                    write(damaged / name, (backup / name).read_bytes())
                content = bytearray((damaged / component).read_bytes())
                content[-1] ^= 1
                write(damaged / component, content)
                bad = copy.deepcopy(protection)
                bad["run_id"] = uuid.uuid4().hex
                bad["backup_set"] = str(damaged)
                bad["output"] = str(out / (bad["run_id"] + ".tar"))
                invoke(root, bad, expect=code)
                check(not Path(bad["output"]).exists(), "damaged-set-never-published-" + component)
            # Real SSH with a distinct receiver, a pinned host key and a pinned
            # private receiver plan. No browser, agent or production credential.
            ssh_identity = root / "ssh.identity"
            command(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", ssh_identity])
            ssh_identity.chmod(0o600)
            receiver_plan = basic("receive", Path("/work"), binding) | {
                "host": receiver, "sender_host": socket.gethostname(), "program_sha256": kit.digest(kit.PROGRAM),
                "bundle_sha256": protected["bundle_sha256"], "bundle_bytes": protected["bundle_bytes"],
                "recipient_sha256": protected["recipient_sha256"]}
            remote_plan_bytes = kit.canonical(receiver_plan)
            receiver_start = ("mkdir -p /run/sshd /root/.ssh /work /opt/kit/scripts/n05; "
                "chmod 700 /root/.ssh /work; ssh-keygen -A >/dev/null 2>&1; "
                "/usr/sbin/sshd -t; touch /run/q04-sshd.ready; "
                "exec /usr/sbin/sshd -D -e -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no "
                "-o PermitRootLogin=prohibit-password -o AllowTcpForwarding=no -o X11Forwarding=no")
            receiver_id = create_container(receiver, ["--pull", "never", "--hostname", receiver,
                   "--label", TEST_LABEL + "=" + test_id, "--network", network,
                   "--entrypoint", "sh", runner_image, "-ceu", receiver_start])
            docker("start", receiver_id)
            deadline = time.monotonic() + 30
            while True:
                ready = subprocess.run(["docker", "--host", "unix:///var/run/docker.sock",
                    "exec", receiver_id, "sh", "-c",
                    "test -f /run/q04-sshd.ready && test -s /etc/ssh/ssh_host_ed25519_key.pub"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if ready.returncode == 0:
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError("SYNTHETIC_SSH_INITIALIZATION_TIMEOUT")
                time.sleep(0.2)
            check(True, "synthetic-ssh-initialized-within-timeout")
            for path, payload in [
                ("/root/.ssh/authorized_keys", (ssh_identity.with_suffix(".identity.pub")).read_bytes()),
                ("/opt/kit/scripts/n05/recovery_kit.py", kit.PROGRAM.read_bytes()),
                ("/work/receive.json", remote_plan_bytes)]:
                docker("exec", "-i", receiver, "python3", "-c",
                       "import pathlib,sys,os; p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(sys.stdin.buffer.read()); p.chmod(0o600)",
                       path, data=payload)
            public_host = docker("exec", receiver, "cat", "/etc/ssh/ssh_host_ed25519_key.pub").decode().strip()
            known = write(root / "known_hosts", (receiver + " " + public_host + "\n").encode())
            ssh = {"host": receiver, "port": 22, "user": "root", "known_hosts": str(known),
                   "known_hosts_sha256": kit.digest(known), "identity_file": str(ssh_identity),
                   "remote_program": "/opt/kit/scripts/n05/recovery_kit.py", "remote_plan": "/work/receive.json",
                   "remote_plan_sha256": kit.sha(remote_plan_bytes), "receiver_host": receiver,
                   "receiver_run_id": receiver_plan["run_id"], "receiver_work_root": "/work"}
            transfer = basic("transfer", work, binding) | {
                "bundle": protection["output"], "bundle_sha256": protected["bundle_sha256"],
                "bundle_bytes": protected["bundle_bytes"], "recipient_sha256": protected["recipient_sha256"], "ssh": ssh}
            bad = copy.deepcopy(transfer)
            bad["run_id"] = uuid.uuid4().hex
            bad["ssh"]["known_hosts_sha256"] = "0" * 64
            invoke(root, bad, expect="SSH_HOST_KEY_BINDING_MISMATCH")
            interrupted = subprocess.run([str(a) for a in kit.ssh_command(transfer)],
                                         input=Path(transfer["bundle"]).read_bytes()[:100],
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
            check(interrupted.returncode != 0 and b"RECEIVE_VERIFIED" not in interrupted.stdout,
                  "interrupted-ssh-no-success-receipt")
            # First local attempt encounters the receiver's existing partial
            # operation; an explicit resume is required at both ends.
            invoke(root, transfer, expect="COMMAND_FAILED_SSH")
            receipt = invoke(root, transfer, extra=("--resume",))
            check(receipt["status"] == "RECEIVE_VERIFIED" and receipt["host"] == receiver, "pinned-off-host-ssh-receipt")
            repeat = invoke(root, transfer, extra=("--resume",))
            check(repeat["bundle_sha256"] == receipt["bundle_sha256"], "ssh-resume-idempotent-no-overwrite")
            restored = basic("recover", work, binding) | {
                "bundle": protection["output"], "bundle_sha256": protected["bundle_sha256"],
                "bundle_bytes": protected["bundle_bytes"], "recipient": public, "identity_file": str(identity),
                "expected": expected, "engine_id": engine, "postgres_image_id": pg_id}
            restored["target_project"] = "fai-crm-recovery-" + restored["run_id"]
            wrong_identity = root / "wrong-age.identity"
            command(["age-keygen", "-o", wrong_identity])
            wrong_identity.chmod(0o600)
            bad = copy.deepcopy(restored)
            bad["identity_file"] = str(wrong_identity)
            invoke(root, bad, expect="DECRYPTION_IDENTITY_MISMATCH")
            bad = copy.deepcopy(restored)
            bad["expected"]["source_tree"] = "0" * 40
            invoke(root, bad, expect="SOURCE_TREE_MISMATCH")
            for field, bad_value, code in [
                ("engine_id", "other-engine", "DOCKER_ENGINE_MISMATCH"),
                ("target_project", "fai-crm", "RECOVERY_PROJECT_INVALID"),
                ("bundle_sha256", "0" * 64, "BUNDLE_IDENTITY_MISMATCH")]:
                bad = copy.deepcopy(restored)
                bad[field] = bad_value
                invoke(root, bad, expect=code)
                check(not (work / bad["run_id"]).exists(), "rejected-before-operation-" + field)
            # Occupancy is checked before any extraction or Docker mutation.
            occupied_name = kit.target_names(restored)["documents_volume"]
            docker("volume", "create", "--label", TEST_LABEL + "=" + test_id, occupied_name)
            info = json.loads(docker("volume", "inspect", occupied_name))[0]
            own_volumes[occupied_name] = {k: info[k] for k in ("Name", "CreatedAt", "Mountpoint", "Driver")}
            invoke(root, restored, expect="DESTINATION_OCCUPIED")
            info = json.loads(docker("volume", "inspect", occupied_name))[0]
            check(own_volumes[occupied_name] == {k: info[k] for k in own_volumes[occupied_name]},
                  "occupied-fixture-volume-recorded-identity")
            docker("volume", "rm", occupied_name)
            del own_volumes[occupied_name]
            corrupt = out / "tampered.bundle.tar"
            tampered_bundle(Path(protection["output"]), corrupt)
            bad = copy.deepcopy(restored)
            bad["run_id"] = uuid.uuid4().hex
            bad["target_project"] = "fai-crm-recovery-" + bad["run_id"]
            bad["bundle"] = str(corrupt)
            bad["bundle_sha256"] = kit.digest(corrupt)
            bad["bundle_bytes"] = corrupt.stat().st_size
            recovery_plans.append(bad)
            invoke(root, bad, expect="COMMAND_FAILED_AGE")
            check(not docker("volume", "ls", "-q", "--filter", "label=" + kit.LABEL + "=" + bad["run_id"]).strip(),
                  "ciphertext-authentication-before-target-allocation")
            invoke(root, bad, "cleanup")
            recovery_plans.append(restored)
            result = invoke(root, restored)
            check(result["status"] == "RECOVERY_VERIFIED" and result["migrations"] == 43, "complete-database-and-documents-recovery")
            recovered_pg = kit.target_names(restored)["postgres"]
            content = docker("exec", recovered_pg, "psql", "-X", "-q", "-At", "-U", "fai_recovery", "-d", "fai_crm_recovery",
                             "-c", "SELECT p.value FROM recovery_synthetic_parent p JOIN recovery_synthetic_child c ON c.parent_id=p.id WHERE c.id=9;").strip()
            check(content == MARKER, "relational-data-byte-identity")
            inspect = json.loads(docker("inspect", recovered_pg))[0]
            check(inspect["HostConfig"]["NetworkMode"] == "none" and not inspect["HostConfig"]["PortBindings"]
                  and not inspect["HostConfig"]["Privileged"] and inspect["Config"]["Image"] == pg_id,
                  "no-network-no-ports-exact-postgres-image")
            recovery_root = work / restored["run_id"]
            check((recovery_root / "configuration/synthetic.env").read_bytes() == MARKER + b"-config"
                  and (recovery_root / "cryptographic-material/synthetic.key").read_bytes() == MARKER + b"-key",
                  "separate-config-and-key-byte-identity")
            invoke(root, restored, expect="RECOVERY_RESOURCES_ALREADY_EXIST")
            invoke(root, restored, "cleanup")
            check(not (recovery_root / "database-documents").exists(), "owned-plaintext-removed")
            check(kit.digest(protection["output"]) == protected["bundle_sha256"] and identity.exists(),
                  "encrypted-source-and-custody-key-preserved")
            check({p.name: kit.digest(p) for p in backup.iterdir()} == original_backup, "original-n05-manifest-unchanged")
            # New, explicitly synthetic production-format fixture. Neither the
            # authentic source set nor any historical/real manifest is rewritten.
            production_fixture = mkdir(root / "synthetic-production-format")
            for name in kit.N05_FILES - {"MANIFEST.txt"}:
                write(production_fixture / name, (backup / name).read_bytes())
            metadata = dict(line.split("=", 1) for line in (backup / "MANIFEST.txt").read_text().splitlines())
            metadata.update(environment="production", environment_sentinel="FAI_CRM_PRODUCTION_V1",
                            compose_project="fai-crm")
            write(production_fixture / "MANIFEST.txt",
                  "".join(k + "=" + v + "\n" for k, v in metadata.items()).encode())
            production_expected = expected | {"environment": "production", "project": "fai-crm",
                "manifest_sha256": kit.digest(production_fixture / "MANIFEST.txt")}
            protection2 = copy.deepcopy(protection)
            protection2.update(run_id=uuid.uuid4().hex, backup_set=str(production_fixture),
                               expected=production_expected, output=str(out / "synthetic-production.bundle.tar"))
            protected2 = invoke(root, protection2)
            restored2 = copy.deepcopy(restored)
            restored2.update(run_id=uuid.uuid4().hex, bundle=protection2["output"],
                             bundle_sha256=protected2["bundle_sha256"], bundle_bytes=protected2["bundle_bytes"],
                             expected=production_expected)
            restored2["target_project"] = "fai-crm-recovery-" + restored2["run_id"]
            recovery_plans.append(restored2)
            result2 = invoke(root, restored2)
            check(result2["status"] == "RECOVERY_VERIFIED" and result2["source"]["environment"] == "production",
                  "production-format-source-retained-with-isolated-target")
            invoke(root, restored2, "cleanup")
            check(before_containers <= set(docker("ps", "-aq", "--no-trunc").decode().split())
                  and before_volumes <= set(docker("volume", "ls", "-q").decode().split()), "preexisting-resources-preserved")
        except Exception:
            if source_pg in own_containers:
                # Only PostgreSQL error categories from the synthetic database;
                # SQL statement lines and row contents are never returned.
                logs = subprocess.run(["docker", "--host", "unix:///var/run/docker.sock",
                    "logs", "--tail", "2000", own_containers[source_pg]],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30, check=True).stdout
                for line in logs.decode(errors="replace").splitlines():
                    if "ERROR:" in line and MARKER.decode() not in line:
                        print("SYNTHETIC_POSTGRES_ERROR|" + line.split("ERROR:", 1)[1][:300],
                              file=sys.stderr)
            raise
        finally:
            # Real kit cleanup first. A failed step cannot target any unlabelled
            # resource; outer fixture cleanup is restricted to this random test.
            for plan in recovery_plans:
                if (work / plan["run_id"] / "operation.json").exists():
                    invoke(root, plan, "cleanup")
            for name, identifier in reversed(list(own_containers.items())):
                info = json.loads(docker("inspect", identifier))[0]
                check(info["Config"]["Labels"].get(TEST_LABEL) == test_id and info["Id"] == identifier
                      and info["Name"] == "/" + name, "fixture-container-cleanup-recorded-id-and-owner")
                docker("rm", "-f", identifier)
            for name, recorded in own_volumes.items():
                info = json.loads(docker("volume", "inspect", name))[0]
                check(info["Labels"].get(TEST_LABEL) == test_id
                      and recorded == {k: info[k] for k in recorded}, "fixture-volume-cleanup-recorded-identity")
                docker("volume", "rm", name)
        print(json.dumps({"status": "N05_RECOVERY_DRILL_PASS", "assertions": len(passed),
                      "distinct_checks": sorted(set(passed)),
                      "app_started": False, "fixture": "synthetic", "cleanup": "verified",
                      "engine_id": engine, "runner_image_id": json.loads(docker("image", "inspect", runner_image))[0]["Id"],
                      "tools": binding, "source_image_id": app["Id"]}), flush=True)


if __name__ == "__main__":
    main()
