"""Owner-only, finite schema46 backup using unchanged canonical N05 tools.

The launcher supplies a separately approved packet. There is no deployment,
migration, restore, SSH configuration, key-file access or automatic admission.
Secret-bearing configuration stays in new private files on the target.
"""
import datetime
import getpass
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import shutil
import socket
import stat
import subprocess
import sys
import time

sys.dont_write_bytecode = True
PROTOCOL = "PR140_OWNER_BACKUP46_R05"
CONFIRMATION = "FAI_CRM_SCHEMA46_STOP_BACKUP_RESUME_R05"
BASE = Path("/home/faiadmin/.local/share/fai-crm-releases")
SOURCE = "3230764a4406182e50d22236bb7e701d0f1b5656"
TREE = "e25e66e081d92ecf61f8b1422aed456f12128d39"
RUNTIME = BASE / "release-3230764a4406-20260920"
TAG = "fai-crm:pr139-3230764a4406"
TOOLS = {
    "scripts/backup-docker-prod.sh": "6b69a9e1197e91e8a7ec059a6f21ea23cb3de37702a5d93ed3de5f9192f0c790",
    "scripts/n05/backup-compose.sh": "f7088b910b0f2eef1be421fdce5ff61ca3edcce8b618e4505e5b0270fe193425",
    "scripts/n05/lib.sh": "eccdefa89cba47957d791d0419ab781469a9cbde3d969dbf67f7d8aa125d9691",
    "scripts/n05/failed_app_return.py": "b3793cea5ba599d6a4f6624406aef94b8a4bce081d50e5fa1732f24e26e2083d",
    "scripts/n05/key_mounts.py": "ffec4317f3f57a30b989efb237a902de020d18962877525f4df10744ce135c00",
    "scripts/n05/verify-backup-manifest.sh": "72863b84dfcfb5229d7618c42608bde64835f33e1e66783dcf33173e227a4ba4",
    "docker-compose.prod.example.yml": "10a56d1058c64de7b265352f9ad4f29f3c9d5db88f42e8ce1f901a9836508c75",
    "docker-compose.prod.legacy-resources.yml": "b6c4ea08bc30726677a2ede1076a72dddc0986ac58e7e58609b6bd98b02a5e73",
}


class Stop(Exception):
    pass


def need(value, code):
    if not value:
        raise Stop(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha_bytes(value):
    return hashlib.sha256(value).hexdigest()


def sha(value):
    return sha_bytes(canonical(value).encode("utf-8"))


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def denial(exc):
    code = str(exc)
    return code if re.fullmatch(r"[A-Z0-9_]{1,100}", code) else "OPERATION_FAILED"


def strict_json(text):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            need(key not in result, "DUPLICATE_JSON_KEY")
            result[key] = value
        return result
    def invalid(_):
        raise Stop("NON_FINITE_JSON")
    return json.loads(text, object_pairs_hook=unique, parse_constant=invalid)


def validate_packet(packet, program_sha256):
    need(isinstance(packet, dict) and set(packet) == {"plan", "approval"}, "PACKET_FIELDS")
    plan, approval = packet["plan"], packet["approval"]
    need(isinstance(plan, dict) and set(plan) == {
        "protocol", "runId", "sourceCommit", "sourceTree", "schema", "target",
        "databaseName", "ownerReceiptSha256", "expectedLedger", "retention",
    }, "PLAN_FIELDS")
    need(plan["protocol"] == PROTOCOL and plan["sourceCommit"] == SOURCE and
         plan["sourceTree"] == TREE and type(plan["schema"]) is int and plan["schema"] == 46,
         "SOURCE_BINDING")
    need(re.fullmatch(r"[0-9a-f]{32}", plan["runId"] or ""), "RUN_ID")
    need(plan["databaseName"] == "fai_crm", "DATABASE_BINDING")
    need(re.fullmatch(r"[0-9a-f]{64}", plan["ownerReceiptSha256"] or ""), "OWNER_RECEIPT_BINDING")
    need(plan["retention"] == "PRESERVE_EXISTING_LOCAL_AND_F_COPIES", "RETENTION_BINDING")
    target = plan["target"]
    need(isinstance(target, dict) and set(target) == {
        "hostname", "user", "engineId", "appId", "appImage", "postgresId", "postgresImage", "networkId",
    }, "TARGET_FIELDS")
    need(target["hostname"] == "fai-crm-prod-02" and target["user"] == "faiadmin", "TARGET_BINDING")
    need(re.fullmatch(r"[0-9a-f-]{36}", target["engineId"] or ""), "ENGINE_BINDING")
    for key in ("appId", "postgresId", "networkId"):
        need(re.fullmatch(r"[0-9a-f]{64}", target[key] or ""), "RESOURCE_BINDING")
    need(target["appId"] != target["postgresId"], "CONTAINER_BINDING_COLLISION")
    for key in ("appImage", "postgresImage"):
        need(re.fullmatch(r"sha256:[0-9a-f]{64}", target[key] or ""), "IMAGE_BINDING")
    inventory = plan["expectedLedger"]
    need(isinstance(inventory, dict) and len(inventory) == 46, "LEDGER_INVENTORY_COUNT")
    need(all(re.fullmatch(r"[0-9]{14}_[a-z0-9_]+", k) and re.fullmatch(r"[0-9a-f]{64}", v)
             for k, v in inventory.items()), "LEDGER_INVENTORY_FORMAT")
    need(isinstance(approval, dict) and set(approval) == {
        "status", "confirmation", "planSha256", "programSha256", "launcherSha256", "reviewReference",
    }, "EXPLICIT_APPROVAL_REQUIRED")
    need(approval["status"] == "OWNER_EXPLICITLY_AUTHORIZED" and
         approval["confirmation"] == CONFIRMATION, "EXPLICIT_APPROVAL_REQUIRED")
    need(approval["planSha256"] == sha(plan) and
         approval["programSha256"] == program_sha256, "APPROVAL_DIGEST_MISMATCH")
    need(re.fullmatch(r"[0-9a-f]{64}", approval["launcherSha256"] or ""), "LAUNCHER_DIGEST_REQUIRED")
    need(isinstance(approval["reviewReference"], str) and
         re.fullmatch(r"[A-Za-z0-9:/._#?=-]{10,240}", approval["reviewReference"]), "REVIEW_REFERENCE_REQUIRED")
    return plan


def file_identity(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
            value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def trusted_directory(path):
    for item in reversed([path, *path.parents]):
        s = item.lstat()
        need(stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode) and
             s.st_uid in (0, os.getuid()) and not s.st_mode & 0o022, "DIRECTORY_AUTHORITY")


def read_stable(path, *, secret=False):
    trusted_directory(path.parent)
    before = path.lstat()
    need(stat.S_ISREG(before.st_mode) and before.st_uid in (0, os.getuid()) and
         before.st_nlink == 1 and not before.st_mode & 0o022, "INPUT_FILE_AUTHORITY")
    if secret:
        need(before.st_uid == os.getuid() and stat.S_IMODE(before.st_mode) == 0o600,
             "PRIVATE_INPUT_MODE")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        need(file_identity(os.fstat(stream.fileno())) == file_identity(before), "INPUT_REPLACED")
        data = stream.read()
        need(file_identity(before) == file_identity(os.fstat(stream.fileno())) ==
             file_identity(path.lstat()), "INPUT_CHANGED")
    return data


class Backup:
    def __init__(self, plan):
        self.plan, self.target = plan, plan["target"]
        self.started, self.monotonic = time.time(), time.monotonic()
        self.emergency = False
        self.root = RUNTIME
        self.work = BASE / ("evidence-backup46-" + plan["runId"])
        self.set_id = "backup46-" + plan["runId"]
        self.module = self.adapter = self.before = None
        self.pg_state = None
        self.inputs = {}
        self.configuration_copies = []
        self.quiescence_attempted = self.app_resumed = False
        self.helper_ref = None

    def remaining(self):
        limit = 1500 if self.emergency else 1200
        remaining = min(self.started + limit - time.time(), self.monotonic + limit - time.monotonic())
        need(remaining > 0, "ORIGINAL_EXECUTION_BUDGET_EXPIRED")
        return remaining

    def deadline(self, cap=90):
        return time.time() + min(cap, self.remaining())

    def environment(self):
        return {k: os.environ[k] for k in ("PATH", "HOME") if k in os.environ} | {
            "LC_ALL": "C", "GIT_TERMINAL_PROMPT": "0", "FAI_ENVIRONMENT": "production",
            "FAI_ENVIRONMENT_SENTINEL": "FAI_CRM_PRODUCTION_V1", "COMPOSE_PROJECT_NAME": "fai-crm",
            "DOCKER_HOST": "unix:///var/run/docker.sock",
        }

    def run(self, args, *, cap=60, env=None, stdin=None):
        seconds = min(cap, self.remaining())
        proc = subprocess.Popen(args, cwd=self.root, env=self.environment() | (env or {}),
                                stdin=stdin or subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, start_new_session=True)
        try:
            out, _ = proc.communicate(timeout=seconds)
        except BaseException:
            self.terminate_process(proc)
            raise Stop("COMMAND_INTERRUPTED_OR_EXPIRED") from None
        need(proc.returncode == 0, "COMMAND_FAILED")
        self.remaining()
        return out

    @staticmethod
    def terminate_process(proc):
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                proc.communicate(timeout=5)
        need(proc.poll() is not None, "PROCESS_STOP_UNVERIFIED")

    def docker(self, *args, **kwargs):
        return self.run(["docker", "--host", "unix:///var/run/docker.sock", *args], **kwargs).decode().strip()

    def inspect(self, cid):
        return strict_json(self.docker("inspect", cid))[0]

    def write(self, path, value):
        self.module.private_file(path, may_create=True)
        data = value if isinstance(value, bytes) else (canonical(value) + "\n").encode()
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        need(read_stable(path, secret=True) == data, "OUTPUT_READBACK")
        fd = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        return {"file": path.name, "sha256": sha_bytes(data), "bytes": len(data)}

    def rows(self):
        sql = ("BEGIN READ ONLY; SELECT migration_name,checksum,started_at::text,"
               "coalesce(finished_at::text,''),coalesce(rolled_back_at::text,''),"
               "applied_steps_count::text FROM _prisma_migrations ORDER BY migration_name; COMMIT;")
        output = self.docker("exec", self.target["postgresId"], "sh", "-ceu",
            'exec psql -X -qAt -F "\t" -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"',
            "backup-ledger", sql)
        rows = [line.split("\t") for line in output.splitlines()]
        validate_ledger(rows, self.plan["expectedLedger"])
        return rows

    def check_pg_state(self):
        pg = self.inspect(self.target["postgresId"])
        state = {"id": pg["Id"], "image": pg["Image"], "created": pg["Created"],
                 "started": pg["State"]["StartedAt"], "restarts": pg["RestartCount"]}
        need(state["id"] == self.target["postgresId"] and state["image"] == self.target["postgresImage"] and
             pg["State"]["Running"] and pg["State"].get("Health", {}).get("Status") == "healthy",
             "POSTGRES_NOT_BOUND_HEALTHY")
        if self.pg_state is not None:
            need(state == self.pg_state, "POSTGRES_RESTART_OR_IDENTITY_DRIFT")
        return state

    def same_source(self, *, healthy=True):
        current = self.adapter.snapshot(self.deadline())
        need(current["engine"] == self.before["engine"] and
             current["postgres"] == self.before["postgres"] and
             current["resources"] == self.before["resources"] and current["postgres_healthy"], "PERSISTENCE_DRIFT")
        need(not current["foreign_containers"] and not current["migrators"], "FOREIGN_CONSUMER")
        need(current["app"] and all(current["app"][k] == self.before["app"][k]
             for k in ("id", "created", "image_id", "config_sha256")), "SOURCE_DRIFT")
        if healthy:
            need(current["app"]["state"] == "healthy", "SOURCE_NOT_HEALTHY")
        self.check_pg_state()
        return current

    def prepare(self):
        need(socket.gethostname() == self.target["hostname"] and getpass.getuser() == self.target["user"] and
             os.getuid() == 1000 and os.getgid() == 1000, "HOST_IDENTITY")
        trusted_directory(self.root)
        need(not os.path.lexists(self.work), "OUTPUT_ALREADY_EXISTS")
        need(shutil.disk_usage(BASE).free >= 2 * 1024 ** 3, "BACKUP_SPACE_LOW")
        need(self.run(["git", "rev-parse", "HEAD", "HEAD^{tree}"]).decode().split() == [SOURCE, TREE], "SOURCE_CHECKOUT_DRIFT")
        need(not self.run(["git", "status", "--porcelain", "--untracked-files=no"]).strip(), "TRACKED_SOURCE_DIRTY")
        for name, expected in TOOLS.items():
            need(sha_bytes(read_stable(self.root / name)) == expected, "CANONICAL_TOOL_DRIFT")
        for name, expected in self.plan["expectedLedger"].items():
            path = "prisma/migrations/" + name + "/migration.sql"
            need(sha_bytes(self.run(["git", "show", SOURCE + ":" + path])) == expected and
                 sha_bytes(read_stable(self.root / path)) == expected, "CANONICAL_LEDGER_DRIFT")
        pg_state = self.check_pg_state()
        need(pg_state["restarts"] == 0, "BASELINE_POSTGRES_RESTARTED")
        self.pg_state = pg_state
        need(self.docker("info", "--format", "{{.ID}}") == self.target["engineId"], "ENGINE_IDENTITY")
        actual_image = strict_json(self.docker("image", "inspect", TAG))[0]
        labels = actual_image["Config"].get("Labels") or {}
        need(actual_image["Id"] == self.target["appImage"] and labels.get("org.opencontainers.image.revision") == SOURCE and
             labels.get("it.finanzaagevolaimpresa.source-tree") == TREE, "SOURCE_IMAGE_PROVENANCE")
        need(self.docker("exec", self.target["postgresId"], "sh", "-ceu", 'printf %s "$POSTGRES_DB"') ==
             self.plan["databaseName"], "DATABASE_NAME_DRIFT")
        module_path = self.root / "scripts/n05/failed_app_return.py"
        spec = importlib.util.spec_from_file_location("backup46_canonical", module_path)
        self.module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = self.module
        spec.loader.exec_module(self.module)
        # Reuse the canonical production interlock, never repair its ACL/binding.
        self.lock_fd = self.module.acquire_lock(self.module.PRODUCTION_LOCK_PATH,
            {"engine_id": self.target["engineId"], "project": "fai-crm"})
        os.mkdir(self.work, 0o700)
        os.mkdir(self.work / "sets", 0o700)
        os.mkdir(self.work / "configuration", 0o700)
        binding = {"project": "fai-crm", "source_app": {"id": self.target["appId"], "image_id": self.target["appImage"]},
                   "candidate": {"id": self.target["appImage"]}, "return_image": {"id": self.target["appImage"]},
                   "postgres": {"id": pg_state["id"], "image": pg_state["image"], "created": pg_state["created"]},
                   "ledger": {"schema": "prisma-46-observed"}, "configs": {}}
        self.adapter = self.module.DockerEngine(binding, self.root)
        for name in (".env.production", "docker-compose.prod.example.yml", "docker-compose.prod.legacy-resources.yml"):
            data = read_stable(self.root / name, secret=name.startswith(".env"))
            self.inputs[name] = self.write(self.work / "configuration" / name, data)
            self.configuration_copies.append(self.inputs[name])
        model = self.adapter.model(self.target["appImage"], self.deadline())
        validate_model(model, self.target["appImage"])
        frozen = self.work / "configuration/frozen-source.json"
        self.configuration_copies.append(self.write(frozen, self.module.canonical(model).encode()))
        for which in ("previous", "candidate", "return"):
            binding["configs"][which] = {"path": str(frozen), "sha256": self.module.sha(model), "kind": "frozen-compose-" + which}
        self.before = self.adapter.snapshot(self.deadline())
        need(self.before["engine"]["id"] == self.target["engineId"] and
             self.before["resources"]["network"]["Id"] == self.target["networkId"] and
             self.before["app"]["id"] == self.target["appId"] and
             self.before["app"]["image_id"] == self.target["appImage"], "BASELINE_IDENTITY_DRIFT")
        self.same_source()
        self.rows()
        self.check_inputs()
        self.write(self.work / "BOUND_PLAN.json", self.plan)
        self.write(self.work / "BASELINE.json", self.before)

    def check_inputs(self):
        for name, expected in TOOLS.items():
            need(sha_bytes(read_stable(self.root / name)) == expected, "CANONICAL_TOOL_DRIFT")
        for name, info in self.inputs.items():
            need(sha_bytes(read_stable(self.root / name, secret=name.startswith(".env"))) == info["sha256"], "CONFIGURATION_CHANGED")

    def backup_environment(self):
        return {"ENV_FILE": str(self.root / ".env.production"), "APP_ENV_FILE": str(self.root / ".env.production"),
            "APP_IMAGE": TAG, "POSTGRES_IMAGE": "postgres:16-alpine", "COMPOSE_FILE": str(self.root / "docker-compose.prod.example.yml"),
            "APP_ORIGIN": "https://desk.finanzaagevolaimpresa.it", "SOURCE_COMMIT": SOURCE, "SOURCE_TREE": TREE,
            "EXPECTED_APP_IMAGE_ID": self.target["appImage"], "EXPECTED_DATABASE_NAME": self.plan["databaseName"],
            "EXPECTED_MIGRATION_COUNT": "46", "BACKUP_CONSISTENCY": "application-quiesced", "BACKUP_IMAGE_PROVENANCE": "oci-labels",
            "BACKUP_RESOURCE_PROVENANCE": "authorized-legacy-compose-identity", "CONFIRM_LEGACY_RESOURCE_IDENTITY": "FAI_CRM_N05_LEGACY_RESOURCE_BRIDGE_V1",
            "CONFIRM_PRODUCTION_BACKUP": "FAI_CRM_PRODUCTION_BACKUP_V1", "BACKUP_ROOT": str(self.work / "sets"), "BACKUP_SET_ID": self.set_id}

    def helper(self, cid):
        need(re.fullmatch(r"[0-9a-f]{64}", cid), "HELPER_ID_INVALID")
        ids = self.docker("ps", "-aq", "--no-trunc", "--filter", "id=" + cid).split()
        if not ids:
            return {"id": cid, "absent": True}
        need(ids == [cid], "HELPER_INVENTORY_UNCERTAIN")
        raw = self.inspect(cid)
        mounts = raw.get("Mounts") or []
        need(raw["Id"] == cid and raw["Image"] == self.target["appImage"] and len(mounts) == 1 and
             mounts[0]["Name"] == "fai-crm_crm_documents" and mounts[0]["RW"] is False and
             raw["HostConfig"]["NetworkMode"] == "none", "HELPER_IDENTITY_MISMATCH")
        return {"id": cid, "created": raw["Created"], "image": raw["Image"], "absent": False}

    def stop_helper(self, ref):
        current = self.helper(ref["id"])
        if current["absent"]:
            return
        need(not ref["absent"] and current == ref, "HELPER_SUBSTITUTED")
        raw = self.inspect(ref["id"])
        if raw["State"]["Running"]:
            self.docker("stop", "--time", "10", ref["id"], cap=25)
        if not self.helper(ref["id"])["absent"]:
            need(self.helper(ref["id"]) == ref, "HELPER_STOP_IDENTITY")
            raw = self.inspect(ref["id"])
            need(not raw["State"]["Running"] and raw["State"]["Pid"] == 0 and not raw.get("ExecIDs"), "HELPER_STOP_UNVERIFIED")
            self.docker("rm", ref["id"])
        need(self.helper(ref["id"])["absent"], "HELPER_REMOVAL_UNVERIFIED")

    def supervise_backup(self):
        self.remaining()
        proc = subprocess.Popen([str(self.root / "scripts/backup-docker-prod.sh"), "--create"], cwd=self.root,
            env=self.environment() | self.backup_environment(), stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        cidpath = self.work / "sets" / (".partial-" + self.set_id) / ".documents-helper.cid"
        def capture():
            if self.helper_ref is not None or not cidpath.exists():
                return
            cid = read_stable(cidpath).decode().strip()
            if not re.fullmatch(r"[0-9a-f]{64}", cid):
                return
            self.helper_ref = self.helper(cid)
            self.write(self.work / "HELPER_IDENTITY.json", self.helper_ref)
        try:
            while True:
                capture()
                self.remaining()
                try:
                    out, _ = proc.communicate(timeout=0.1)
                    break
                except subprocess.TimeoutExpired:
                    pass
            need(proc.returncode == 0, "BACKUP_COMMAND_FAILED")
            ids = [line.split(b"container_id=", 1)[1].decode() for line in out.splitlines()
                   if line.startswith(b"N05_BACKUP_HELPER_REMOVED|container_id=")]
            need(len(ids) == 1, "BACKUP_HELPER_RECEIPT_MISSING")
            if self.helper_ref is None:
                self.helper_ref = self.helper(ids[0])
                self.write(self.work / "HELPER_IDENTITY.json", self.helper_ref)
            need(ids == [self.helper_ref["id"]] and self.helper(ids[0])["absent"], "BACKUP_HELPER_STILL_PRESENT")
            return out
        except BaseException:
            self.emergency = True
            capture_failed = False
            try:
                capture()
            except BaseException:
                capture_failed = True
            self.terminate_process(proc)
            if self.helper_ref is not None:
                self.stop_helper(self.helper_ref)
            need(not capture_failed and self.helper_ref is not None, "BACKUP_HELPER_IDENTITY_UNCERTAIN")
            raise

    def resume(self):
        self.emergency = True
        app = self.inspect(self.target["appId"])
        need(app["Id"] == self.before["app"]["id"] and app["Created"] == self.before["app"]["created"] and
             app["Image"] == self.target["appImage"], "RESUME_IDENTITY")
        self.same_source(healthy=False)
        if not app["State"]["Running"]:
            self.docker("start", app["Id"])
        until = self.deadline(120)
        while time.time() < until:
            app = self.inspect(self.target["appId"])
            need(app["Id"] == self.before["app"]["id"] and app["Created"] == self.before["app"]["created"] and
                 app["Image"] == self.target["appImage"], "RESUME_IDENTITY")
            need(app["State"]["Running"], "RESUMED_APP_EXITED")
            if app["State"].get("Health", {}).get("Status") == "healthy":
                self.same_source()
                self.app_resumed = True
                return
            time.sleep(min(1, self.remaining()))
        raise Stop("RESUME_HEALTH_TIMEOUT")

    def create(self):
        self.same_source()
        before_rows = self.rows()
        self.check_inputs()
        self.write(self.work / "LEDGER_BEFORE.json", before_rows)
        need(self.remaining() >= 300, "INSUFFICIENT_QUIESCENCE_BUDGET")
        receipt = None
        try:
            self.quiescence_attempted = True
            self.docker("stop", "--time", "30", self.target["appId"], cap=45)
            app = self.inspect(self.target["appId"])
            need(app["Id"] == self.before["app"]["id"] and app["Created"] == self.before["app"]["created"] and
                 not app["State"]["Running"] and app["State"]["Pid"] == 0 and not app.get("ExecIDs"), "QUIESCENCE_UNVERIFIED")
            env = self.backup_environment()
            out = self.run([str(self.root / "scripts/backup-docker-prod.sh"), "--preflight"], env=env, cap=120)
            self.write(self.work / "BACKUP_PREFLIGHT.log", out)
            self.write(self.work / "BACKUP_CREATE.log", self.supervise_backup())
            backup = self.work / "sets" / self.set_id
            verify_env = {"EXPECTED_ENVIRONMENT": "production", "EXPECTED_PROJECT": "fai-crm",
                "EXPECTED_SOURCE_COMMIT": SOURCE, "EXPECTED_SOURCE_TREE": TREE, "EXPECTED_APP_IMAGE_ID": self.target["appImage"],
                "EXPECTED_IMAGE_PROVENANCE": "oci-labels", "EXPECTED_RESOURCE_PROVENANCE": "authorized-legacy-compose-identity",
                "EXPECTED_MIGRATION_COUNT": "46"}
            self.run(["bash", str(self.root / "scripts/n05/verify-backup-manifest.sh"), str(backup)], env=verify_env, cap=120)
            with (backup / "postgres.dump").open("rb") as stream:
                self.run(["docker", "--host", "unix:///var/run/docker.sock", "exec", "-i", self.target["postgresId"],
                          "pg_restore", "--file=/dev/null"], stdin=stream, cap=120)
            self.check_inputs()
            need(self.same_source(healthy=False)["app"]["state"] == "exited", "WRITER_REAPPEARED")
            need(self.rows() == before_rows, "BACKUP_LEDGER_DRIFT")
            receipt = {"protocol": PROTOCOL, "status": "BACKUP_VERIFIED_AND_APP_RESUMED", "utc": utc(),
                "runId": self.plan["runId"], "sourceCommit": SOURCE, "sourceTree": TREE, "schema": 46,
                "appId": self.target["appId"], "appImage": self.target["appImage"], "postgresId": self.target["postgresId"],
                "set": str(backup), "manifestSha256": sha_bytes(read_stable(backup / "MANIFEST.txt", secret=True)),
                "checksumsSha256": sha_bytes(read_stable(backup / "SHA256SUMS", secret=True)),
                "ledgerSha256": sha(before_rows), "fullPgArchiveReadable": True, "databaseNotRestarted": True,
                "configuration": self.configuration_copies, "activeEnvironmentPrivatelyPreserved": True,
                "externalKeyFileReferencesAbsent": True, "realKeyAccess": False, "secretValuesExported": False,
                "offHostEncryptedCopiesCreated": False, "historicalR11Repeated": False, "migration47Applied": False,
                "deployPerformed": False, "productionActivation": False}
        finally:
            # Lost stop/backup replies never skip an identity-bound source resume.
            self.resume()
        need(receipt is not None and self.app_resumed, "SUCCESS_NOT_ESTABLISHED")
        receipt["appResumedHealthy"] = True
        receipt["completedUtc"] = utc()
        self.write(self.work / "BACKUP_VERIFIED.json", receipt)
        return receipt


def validate_ledger(rows, inventory):
    need(len(rows) == 46 and all(len(r) == 6 and r[2] and r[3] and not r[4] and r[5] == "1" for r in rows), "LEDGER_INCOMPLETE")
    need(len({r[0] for r in rows}) == 46 and {r[0]: r[1] for r in rows} == inventory, "LEDGER_CHECKSUM_OR_NAME_DRIFT")


def validate_model(model, image):
    need(set(model.get("services", {})) == {"app", "postgres"} and not model.get("configs") and not model.get("secrets"), "MODEL_SERVICES")
    need(set(model.get("volumes", {})) == {"crm_documents", "postgres_data"}, "MODEL_VOLUMES")
    for key, value in model["volumes"].items():
        need(value == {"name": "fai-crm_" + key, "external": True}, "MODEL_VOLUME_AUTHORITY")
    network = model.get("networks", {}).get("default", {})
    need(set(model.get("networks", {})) == {"default"} and network.get("external") is True and
         network.get("name") == "fai-crm_default" and not network.get("ipam") and
         set(network) <= {"name", "external", "ipam"}, "MODEL_NETWORK_AUTHORITY")
    app = model["services"]["app"]
    need(app.get("image") == image and not app.get("privileged") and not app.get("devices") and not app.get("cap_add"), "MODEL_APP_AUTHORITY")
    env = app.get("environment", {})
    closed = {"FEATURE_INTEGRATIONS_ENABLED": "false", "FEATURE_AI_WORKER_ENABLED": "false",
        "FEATURE_AI_DISPATCH_ENABLED": "false", "FEATURE_AI_EGRESS_ENABLED": "false",
        "AI_EXTERNAL_PROVIDERS_ENABLED": "false", "AI_ORCHESTRATOR_WORKER_ENABLED": "0",
        "AI_PROVIDER": "mock", "WEBSITE_LEAD_MODE": "disabled", "INTERNAL_SESSION_MODE": "legacy", "PRIVILEGED_ACCESS_MODE": "disabled"}
    need(all(str(env.get(k)).lower() == v for k, v in closed.items()), "MODEL_INACTIVITY_DRIFT")
    need(all(env.get(k) in (None, "", "false", "0") for k in
        ("VNX01_LEAD_INTAKE_CONSUMER_ENABLED", "VNX05_LEAD_INTAKE_PILOT_ENABLED", "N15_SYNTHETIC_SELF_CLAIM_OPT_IN", "N15_SYNTHETIC_ASSIGNMENT_OPT_IN")), "MODEL_DORMANT_FEATURE")
    need(all(env.get(k) in (None, "", "disabled") for k in
        ("SECURE_LEAD_GATEWAY_MODE", "COMMERCIAL_LEAD_INBOX_MODE", "CONTROLLED_INTAKE_MODE", "PRACTICE_READINESS_MODE", "INTERNAL_ENGAGEMENT_MODE")), "MODEL_CLOSED_MODE_DRIFT")
    need(env.get("AUTH_SECRET") and all(not env.get(k) for k in
        ("SECURE_LEAD_GATEWAY_KEYRING_FILE", "LEAD_IDENTITY_KEY_FILE")), "CRYPTO_COVERAGE_UNPROVEN")


def entry_point(packet, program_sha256):
    operation = None
    try:
        plan = validate_packet(packet, program_sha256)
        def interrupted(_signum, _frame):
            raise Stop("OWNER_EXECUTION_INTERRUPTED")
        for signal_name in ("SIGTERM", "SIGINT", "SIGHUP"):
            if hasattr(signal, signal_name):
                signal.signal(getattr(signal, signal_name), interrupted)
        os.umask(0o077)
        operation = Backup(plan)
        operation.prepare()
        result = operation.create()
        print(canonical(result), flush=True)
        return 0
    except BaseException as exc:
        result = {"protocol": PROTOCOL, "status": "STOP", "code": denial(exc), "realKeyAccess": False,
                  "secretValuesExported": False, "quiescenceAttempted": bool(operation and operation.quiescence_attempted),
                  "appResumedHealthy": bool(operation and operation.app_resumed)}
        if operation is not None and operation.module is not None and operation.work.is_dir():
            try:
                operation.write(operation.work / "STOP.json", result)
            except BaseException:
                result["privateReceiptWriteFailed"] = True
        print(canonical(result), flush=True)
        return 2
    finally:
        if operation is not None and hasattr(operation, "lock_fd"):
            os.close(operation.lock_fd)


if __name__ == "__main__":
    # Production execution is only through the owner launcher after packet approval.
    print(canonical({"protocol": PROTOCOL, "status": "OWNER_LAUNCHER_REQUIRED"}))
    raise SystemExit(2)
