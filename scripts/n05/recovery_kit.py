#!/usr/bin/env python3
"""N05 recovery kit. Linux/POSIX only; no application, consumer or provider start.

Plans are exact, private inputs pinned by a separately supplied SHA-256.
Production-origin manifests remain production-origin manifests. Authorization
strings are technical interlocks, not substitutes for an operator's mandate.
"""
import argparse
import ctypes
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import signal
import socket
import stat
import subprocess
import sys
import tarfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
PROGRAM = Path(__file__).resolve()
SCHEMA = "FAI_CRM_N05_RECOVERY_KIT_V1"
LABEL = "it.finanzaagevolaimpresa.recovery-operation"
TEST_LABEL = "it.finanzaagevolaimpresa.recovery-test"
SENTINEL = "FAI_CRM_N05_ISOLATED_RECOVERY_V1"
N05_FILES = {"MANIFEST.txt", "SHA256SUMS", "postgres.dump", "documents.tar.gz"}
COMPONENTS = ("database-documents", "configuration", "cryptographic-material")
TOOL_FILES = ("scripts/n05/recovery_kit.py", "scripts/n05/lib.sh",
              "scripts/n05/verify-backup-manifest.sh",
              "scripts/n05/backup-compose.sh", "scripts/backup-docker-prod.sh",
              "docker-compose.prod.example.yml", "docker-compose.staging.example.yml",
              "docker-compose.restore-drill.yml")
BASE_KEYS = {"schema", "phase", "data_class", "run_id", "host", "work_root", "tools"}
PHASE_KEYS = {
    "backup": {"environment", "env_file_sha256", "app_env_file_sha256", "engine_id"},
    "protect": {"backup_set", "expected", "recipient", "configuration_dir",
                "cryptographic_dir", "configuration_sha256", "cryptographic_sha256", "output"},
    "transfer": {"bundle", "bundle_sha256", "bundle_bytes", "recipient_sha256", "ssh"},
    "receive": {"bundle_sha256", "bundle_bytes", "recipient_sha256", "sender_host",
                "program_sha256"},
    "recover": {"bundle", "bundle_sha256", "bundle_bytes", "recipient",
                "identity_file", "expected", "engine_id", "postgres_image_id",
                "target_project"},
}
ENV_KEYS = {
    "CONFIRM_PRODUCTION_BACKUP", "FAI_ENVIRONMENT", "FAI_ENVIRONMENT_SENTINEL",
    "COMPOSE_PROJECT_NAME", "COMPOSE_FILE", "ENV_FILE", "APP_ENV_FILE",
    "APP_ORIGIN", "APP_IMAGE", "POSTGRES_IMAGE", "BACKUP_ROOT", "BACKUP_SET_ID",
    "SOURCE_COMMIT", "SOURCE_TREE", "EXPECTED_APP_IMAGE_ID",
    "BACKUP_IMAGE_PROVENANCE", "BACKUP_RESOURCE_PROVENANCE",
    "CONFIRM_LEGACY_RESOURCE_IDENTITY", "EXPECTED_DATABASE_NAME",
    "EXPECTED_MIGRATION_COUNT", "EXPECTED_DATABASE_SENTINEL",
    "BACKUP_CONSISTENCY", "DATABASE_URL", "POSTGRES_DB", "POSTGRES_USER",
    "POSTGRES_PASSWORD",
}
EXPECTED_KEYS = {"environment", "project", "source_commit", "source_tree",
                 "app_image_id", "image_provenance", "resource_provenance",
                 "migration_count", "manifest_sha256", "checksums_sha256"}
MAX_FILE = 128 * 1024**3
MAX_MEMBERS = 20000
SAFE_ENV = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8", "HOME": str(Path.home())}


class Denied(Exception):
    pass


def require(value, code):
    if not value:
        raise Denied(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def pairs(items):
    result = {}
    for key, value in items:
        require(key not in result, "DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def decode(raw):
    try:
        return json.loads(raw, object_pairs_hook=pairs)
    except (ValueError, UnicodeError):
        raise Denied("INVALID_JSON") from None


def path_checked(value, exists=True):
    require(isinstance(value, str) and not any(ord(c) < 32 for c in value), "PATH_INVALID")
    p = Path(value)
    require(p.is_absolute() and ".." not in p.parts and p != Path("/"), "PATH_INVALID")
    for item in (p, *p.parents):
        require(not item.is_symlink(), "SYMLINK_DENIED")
    require(str(p) == str(p.resolve(strict=False)), "PATH_NOT_CANONICAL")
    if exists:
        require(p.exists(), "PATH_MISSING")
    return p


def private_dir(value):
    p = path_checked(str(value))
    s = p.stat()
    require(stat.S_ISDIR(s.st_mode) and stat.S_IMODE(s.st_mode) == 0o700
            and s.st_uid == os.geteuid(), "PRIVATE_DIRECTORY_REQUIRED")
    return p


def private_file(value, limit=MAX_FILE):
    p = path_checked(str(value))
    s = p.stat()
    require(stat.S_ISREG(s.st_mode) and s.st_nlink == 1
            and stat.S_IMODE(s.st_mode) == 0o600 and s.st_uid == os.geteuid(),
            "PRIVATE_REGULAR_FILE_REQUIRED")
    require(s.st_size <= limit, "FILE_SIZE_LIMIT")
    return p


def hash_value(value):
    require(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value), "SHA256_INVALID")
    return value


def image_id(value):
    require(isinstance(value, str) and re.fullmatch(r"sha256:[a-f0-9]{64}", value),
            "IMAGE_ID_REQUIRED")
    return value


def exclusive(path, data):
    with Path(path).open("xb") as stream:
        os.chmod(path, 0o600)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def publish(source, target):
    # Linux renameat2(RENAME_NOREPLACE): an occupied destination is never replaced,
    # including a concurrent empty directory or symlink created after preflight.
    library = ctypes.CDLL(None, use_errno=True)
    require(hasattr(library, "renameat2"), "ATOMIC_NOREPLACE_UNAVAILABLE")
    result = library.renameat2(-100, os.fsencode(source), -100, os.fsencode(target), 1)
    require(result == 0, "ATOMIC_DESTINATION_OCCUPIED_OR_UNAVAILABLE")
    descriptor = os.open(Path(target).parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def run(argv, *, data=None, input_file=None, output_file=None, env=None, timeout=300):
    require(not (data is not None and input_file is not None), "INPUT_AMBIGUOUS")
    child_env = dict(SAFE_ENV)
    if env:
        child_env.update(env)
    try:
        result = subprocess.run([str(a) for a in argv], input=data,
                                stdin=input_file, stdout=output_file or subprocess.PIPE,
                                stderr=subprocess.PIPE, env=child_env, cwd=ROOT,
                                timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        raise Denied("COMMAND_TIMEOUT") from None
    except OSError:
        raise Denied("DEPENDENCY_UNAVAILABLE") from None
    # Never surface subprocess diagnostics: pg_restore/age/SSH errors may contain
    # confidential material. The command category and phase remain identifiable.
    if result.returncode:
        category = "COMMAND_FAILED_" + Path(str(argv[0])).name.upper()
        if Path(str(argv[0])).name == "bash":
            codes = re.findall(rb"N05_FAILED\|code=([A-Z0-9_]{1,100})(?:\r?\n|$)", result.stderr)
            if codes:
                category += "__" + codes[-1].decode()
        raise Denied(category)
    return result.stdout or b""


def git(*args):
    return run(["git", "-C", ROOT, *args]).decode().strip()


def tools_binding():
    commit = git("rev-parse", "HEAD")
    return {"commit": commit, "tree": git("rev-parse", "HEAD^{tree}"),
            "program_sha256": digest(PROGRAM)}


def verify_tools(value):
    require(isinstance(value, dict) and set(value) == {"commit", "tree", "program_sha256"},
            "TOOLS_BINDING_INVALID")
    require(value == tools_binding(), "TOOLS_IDENTITY_MISMATCH")
    for name in TOOL_FILES:
        source = run(["git", "-C", ROOT, "show", value["commit"] + ":" + name])
        require(sha(source) == digest(ROOT / name), "TOOLS_WORKING_COPY_CHANGED")


def recipient(value):
    require(isinstance(value, str) and re.fullmatch(r"age1[023456789acdefghjklmnpqrstuvwxyz]{58}", value),
            "X25519_RECIPIENT_REQUIRED")
    return value


def age_ready():
    require(run(["age", "--version"]).decode().strip() == "v1.3.2", "AGE_VERSION_MISMATCH")


def load_plan(path, expected_hash):
    require(sys.platform.startswith("linux"), "LINUX_POSIX_REQUIRED")
    p = private_file(path, 128 * 1024)
    require(digest(p) == hash_value(expected_hash), "PLAN_HASH_MISMATCH")
    value = decode(p.read_bytes())
    require(isinstance(value, dict) and value.get("schema") == SCHEMA, "PLAN_SCHEMA_MISMATCH")
    phase = value.get("phase")
    require(phase in PHASE_KEYS and set(value) == BASE_KEYS | PHASE_KEYS[phase], "PLAN_KEYS_INVALID")
    require(value["data_class"] in ("synthetic", "production"), "DATA_CLASS_REQUIRED")
    require(re.fullmatch(r"[a-f0-9]{32}", value["run_id"] or ""), "RUN_ID_INVALID")
    require(value["host"] == socket.gethostname(), "HOST_IDENTITY_MISMATCH")
    root = private_dir(value["work_root"])
    require(root != ROOT and ROOT not in root.parents, "WORK_ROOT_INSIDE_TOOLS_REPOSITORY")
    operation_root = root / value["run_id"]
    for field in ("backup_set", "configuration_dir", "cryptographic_dir", "bundle",
                  "identity_file", "output"):
        if field in value:
            material = path_checked(value[field], exists=field != "output")
            require(material != operation_root and operation_root not in material.parents
                    and material not in operation_root.parents, "OPERATION_OVERLAPS_INPUT_OR_OUTPUT")
    require(p != operation_root and operation_root not in p.parents, "PLAN_INSIDE_OPERATION")
    if phase in ("receive", "recover"):
        require(value["host"] != "fai-crm-prod-02" and "/opt/fai-crm" not in str(root)
                and ".env.production" not in str(root), "PRODUCTION_DESTINATION_DENIED")
    if phase == "receive":
        require(isinstance(value["tools"], dict)
                and set(value["tools"]) == {"commit", "tree", "program_sha256"},
                "TOOLS_BINDING_INVALID")
        for field in ("commit", "tree"):
            require(re.fullmatch(r"[a-f0-9]{40}", value["tools"][field] or ""),
                    "TOOLS_BINDING_INVALID")
        require(value["program_sha256"] == digest(PROGRAM)
                == value["tools"].get("program_sha256"), "RECEIVER_PROGRAM_MISMATCH")
        require(value["sender_host"] != value["host"], "SAME_HOST_TRANSFER_DENIED")
    else:
        verify_tools(value["tools"])
    return value


class Operation:
    def __init__(self, plan, plan_hash, resume=False):
        self.plan = plan
        self.plan_hash = plan_hash
        self.root = private_dir(plan["work_root"]) / plan["run_id"]
        if not resume:
            require(not self.root.exists(), "OPERATION_ALREADY_EXISTS")
            self.root.mkdir(mode=0o700)
            exclusive(self.root / "operation.json", canonical({
                "schema": SCHEMA, "run_id": plan["run_id"], "plan_sha256": plan_hash,
                "phase": plan["phase"], "host": plan["host"], "created_utc": utc()}))
        else:
            private_dir(self.root)
            original = decode(private_file(self.root / "operation.json").read_bytes())
            require(original["plan_sha256"] == plan_hash and original["run_id"] == plan["run_id"]
                    and original["host"] == plan["host"], "RESUME_IDENTITY_MISMATCH")
        lock_path = self.root / "operation.lock"
        if lock_path.exists() or lock_path.is_symlink():
            private_file(lock_path, 0)
        descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        self.lock = os.fdopen(descriptor, "r+b")
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.lock.close()
            raise Denied("OPERATION_BUSY") from None

    def event(self, phase, **metadata):
        sequence = len(list(self.root.glob("event-*.json")))
        exclusive(self.root / f"event-{sequence:06d}.json",
                  canonical({"phase": phase, "utc": utc(), **metadata}))

    def events(self):
        return [decode(private_file(p, 128 * 1024).read_bytes())
                for p in sorted(self.root.glob("event-*.json"))]

    def close(self):
        self.lock.close()


def expected_source(value):
    require(isinstance(value, dict) and set(value) == EXPECTED_KEYS, "SOURCE_BINDING_INVALID")
    require(value["environment"] in ("production", "staging", "restore-source"),
            "SOURCE_ENVIRONMENT_INVALID")
    require(value["migration_count"] == 43, "EXACTLY_43_MIGRATIONS_REQUIRED")
    for key in ("source_commit", "source_tree"):
        require(re.fullmatch(r"[a-f0-9]{40}", value[key] or ""), "SOURCE_GIT_ID_INVALID")
    require(git("rev-parse", value["source_commit"] + "^{tree}") == value["source_tree"],
            "SOURCE_TREE_MISMATCH")
    image_id(value["app_image_id"])
    hash_value(value["manifest_sha256"])
    hash_value(value["checksums_sha256"])


def verify_n05(directory, expected):
    expected_source(expected)
    directory = private_dir(directory)
    require({p.name for p in directory.iterdir()} == N05_FILES, "N05_SET_INVENTORY_MISMATCH")
    for p in directory.iterdir():
        private_file(p)
    require(digest(directory / "MANIFEST.txt") == expected["manifest_sha256"],
            "MANIFEST_DIGEST_MISMATCH")
    require(digest(directory / "SHA256SUMS") == expected["checksums_sha256"],
            "CHECKSUMS_IDENTITY_MISMATCH")
    env = {"EXPECTED_" + k.upper(): str(v) for k, v in expected.items()
           if k not in ("manifest_sha256", "checksums_sha256")}
    run(["bash", ROOT / "scripts/n05/verify-backup-manifest.sh", directory], env=env)
    safe_members(directory / "documents.tar.gz", compressed=True)


def safe_members(archive, *, compressed=False, exact=None):
    # Additional bounded parser before any extraction; N05's original validator
    # is still called for the document archive.
    entries = []
    seen = set()
    total = 0
    with tarfile.open(archive, "r:gz" if compressed else "r:") as source:
        for item in source:
            require(len(entries) < MAX_MEMBERS, "ARCHIVE_ENTRY_LIMIT")
            name = item.name
            normalized = name[2:] if name.startswith("./") else name
            if normalized in ("", "."):
                require(item.isdir(), "ARCHIVE_ROOT_INVALID")
                continue
            p = PurePosixPath(normalized)
            require(not p.is_absolute() and ".." not in p.parts and "\\" not in normalized
                    and not any(ord(c) < 32 for c in normalized)
                    and "//" not in normalized and len(normalized) <= 512
                    and str(p) == normalized.rstrip("/"), "ARCHIVE_PATH_DENIED")
            require(item.isfile() or item.isdir(), "ARCHIVE_SPECIAL_ENTRY_DENIED")
            require(normalized.rstrip("/") not in seen, "ARCHIVE_DUPLICATE_PATH")
            seen.add(normalized.rstrip("/"))
            total += item.size
            require(0 <= item.size <= MAX_FILE and total <= MAX_FILE, "ARCHIVE_SIZE_LIMIT")
            entries.append((normalized.rstrip("/"), item.size, item.isdir()))
    files = {name for name, _, isdir in entries if not isdir}
    require(all(not files.intersection(str(p) for p in PurePosixPath(name).parents)
                for name, _, _ in entries), "ARCHIVE_FILE_PARENT_COLLISION")
    # A valid N05 documents volume may be empty. Mandatory bundle components
    # and configuration/crypto coverage still have exact/nonempty inventories.
    if exact is not None:
        require({name for name, _, isdir in entries if not isdir} == exact
                and all(not isdir for _, _, isdir in entries), "ARCHIVE_INVENTORY_MISMATCH")
    return entries


def unpack(archive, target, *, compressed=False, exact=None):
    members = safe_members(archive, compressed=compressed, exact=exact)
    target.mkdir(mode=0o700)
    with tarfile.open(archive, "r:gz" if compressed else "r:") as source:
        by_name = {m.name.removeprefix("./").rstrip("/"): m for m in source}
        for name, size, isdir in members:
            destination = target / name
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if isdir:
                destination.mkdir(exist_ok=True, mode=0o700)
                continue
            item = by_name[name]
            with source.extractfile(item) as incoming, destination.open("xb") as outgoing:
                os.chmod(destination, 0o600)
                copied = 0
                while block := incoming.read(1024 * 1024):
                    copied += len(block)
                    require(copied <= size, "ARCHIVE_MEMBER_SIZE_MISMATCH")
                    outgoing.write(block)
                require(copied == size, "ARCHIVE_MEMBER_TRUNCATED")


def private_inventory(root):
    root = private_dir(root)
    files = []
    total = 0
    for current, directories, names in os.walk(root, followlinks=False):
        private_dir(current)
        for name in directories:
            private_dir(Path(current) / name)
        for name in sorted(names):
            p = private_file(Path(current) / name)
            relative = str(p.relative_to(root))
            require("\\" not in relative and not any(ord(c) < 32 for c in relative),
                    "COMPONENT_PATH_DENIED")
            files.append((p, relative))
            total += p.stat().st_size
            require(total <= MAX_FILE, "COMPONENT_SIZE_LIMIT")
            require(len(files) <= MAX_MEMBERS, "COMPONENT_ENTRY_LIMIT")
    require(files, "COVERAGE_COMPONENT_EMPTY")
    return files


def tar_component(files, destination):
    with destination.open("xb") as stream:
        os.chmod(destination, 0o600)
        with tarfile.open(fileobj=stream, mode="w") as archive:
            for path, name in files:
                private_file(path)
                info = archive.gettarinfo(str(path), arcname=name)
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                info.mode = 0o600
                with path.open("rb") as source:
                    archive.addfile(info, source)


def component_identity(root):
    files = private_inventory(root)
    items = sorted((name, digest(path)) for path, name in files)
    return {"sha256": sha(canonical(items)), "files": len(items),
            "bytes": sum(p.stat().st_size for p, _ in files)}


def protect_preflight(plan):
    age_ready()
    recipient(plan["recipient"])
    verify_n05(plan["backup_set"], plan["expected"])
    for field in ("configuration", "cryptographic"):
        require(component_identity(plan[field + "_dir"])["sha256"]
                == hash_value(plan[field + "_sha256"]), "COVERAGE_IDENTITY_MISMATCH")
    output = path_checked(plan["output"], exists=False)
    private_dir(output.parent)
    require(not output.exists(), "OUTPUT_OCCUPIED")
    for source in ("backup_set", "configuration_dir", "cryptographic_dir"):
        p = path_checked(plan[source])
        require(output != p and p not in output.parents, "OUTPUT_OVERLAPS_SOURCE")


def protect(plan, op):
    sources = {
        "database-documents": [(Path(plan["backup_set"]) / n, n) for n in sorted(N05_FILES)],
        "configuration": private_inventory(plan["configuration_dir"]),
        "cryptographic-material": private_inventory(plan["cryptographic_dir"]),
    }
    initial = {component: [(str(p), digest(p)) for p, _ in files]
               for component, files in sources.items()}
    index = {"schema": "FAI_CRM_N05_RECOVERY_BUNDLE_V1",
             "data_class": plan["data_class"], "source": plan["expected"],
             "recipient_sha256": sha(plan["recipient"].encode()),
             "tools": plan["tools"], "components": {}}
    encrypted = op.root / "encrypted"
    encrypted.mkdir(mode=0o700)
    for component, files in sources.items():
        op.event("ENCRYPTING", component=component)
        plaintext = op.root / (component + ".tar")
        tar_component(files, plaintext)
        ciphertext = encrypted / (component + ".age")
        with plaintext.open("rb") as source, ciphertext.open("xb") as output:
            os.chmod(ciphertext, 0o600)
            run(["age", "--encrypt", "--recipient", plan["recipient"]],
                input_file=source, output_file=output)
        index["components"][component] = {"file": ciphertext.name, "bytes": ciphertext.stat().st_size,
                                          "sha256": digest(ciphertext)}
        # Only files created by this operation are removed. Ciphertext does not
        # imply a successful recovery test of the protected private components.
        plaintext.unlink()
    current_sources = {
        "database-documents": [(Path(plan["backup_set"]) / n, n) for n in sorted(N05_FILES)],
        "configuration": private_inventory(plan["configuration_dir"]),
        "cryptographic-material": private_inventory(plan["cryptographic_dir"]),
    }
    require(initial == {c: [(str(p), digest(p)) for p, _ in files] for c, files in current_sources.items()},
            "SOURCE_CHANGED_DURING_PROTECTION")
    verify_n05(plan["backup_set"], plan["expected"])
    exclusive(encrypted / "INDEX.json", canonical(index))
    packed = op.root / "protected.bundle.tar"
    tar_component([(p, p.name) for p in sorted(encrypted.iterdir())], packed)
    # Output may be on another filesystem: copy only ciphertext to a private
    # sibling temporary, fsync, then atomic no-replace publication.
    destination = Path(plan["output"])
    temporary = destination.parent / (".n05-recovery-" + plan["run_id"] + ".partial")
    copy_exact(packed, temporary)
    publish(temporary, destination)
    op.event("PROTECTION_VERIFIED", bundle_sha256=digest(destination),
             bundle_bytes=destination.stat().st_size, recipient_sha256=index["recipient_sha256"])
    return {"bundle_sha256": digest(destination), "bundle_bytes": destination.stat().st_size,
            "recipient_sha256": index["recipient_sha256"], "coverage": list(COMPONENTS)}


def copy_exact(source, destination):
    with Path(source).open("rb") as incoming, Path(destination).open("xb") as outgoing:
        os.chmod(destination, 0o600)
        while block := incoming.read(1024 * 1024):
            outgoing.write(block)
        outgoing.flush()
        os.fsync(outgoing.fileno())
    require(digest(source) == digest(destination), "COPY_DIGEST_MISMATCH")


def bundle_preflight(plan):
    bundle = private_file(plan["bundle"])
    require(bundle.stat().st_size == plan["bundle_bytes"]
            and digest(bundle) == hash_value(plan["bundle_sha256"]), "BUNDLE_IDENTITY_MISMATCH")
    safe_members(bundle, exact={"INDEX.json", *(c + ".age" for c in COMPONENTS)})
    with tarfile.open(bundle, "r:") as archive:
        item = archive.getmember("INDEX.json")
        require(item.size <= 128 * 1024, "BUNDLE_INDEX_SIZE_LIMIT")
        index = decode(archive.extractfile(item).read())
        require(set(index) == {"schema", "data_class", "source", "recipient_sha256", "tools", "components"}
                and index["schema"] == "FAI_CRM_N05_RECOVERY_BUNDLE_V1"
                and index["data_class"] == plan["data_class"]
                and set(index["components"]) == set(COMPONENTS), "BUNDLE_INDEX_INVALID")
        recipient_hash = sha(plan["recipient"].encode()) if "recipient" in plan else plan["recipient_sha256"]
        require(index["recipient_sha256"] == recipient_hash, "RECIPIENT_BINDING_MISMATCH")
        if "expected" in plan:
            require(index["source"] == plan["expected"], "BACKUP_SOURCE_BINDING_MISMATCH")
        for component in COMPONENTS:
            value = index["components"][component]
            require(set(value) == {"file", "bytes", "sha256"} and value["file"] == component + ".age",
                    "BUNDLE_COMPONENT_INVALID")
            member = archive.getmember(value["file"])
            require(member.size == value["bytes"], "CIPHERTEXT_SIZE_MISMATCH")
            h = hashlib.sha256()
            with archive.extractfile(member) as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    h.update(block)
            require(h.hexdigest() == value["sha256"], "CIPHERTEXT_DIGEST_MISMATCH")
    return index


def ssh_command(plan):
    value = plan["ssh"]
    require(set(value) == {"host", "port", "user", "known_hosts", "known_hosts_sha256",
                          "identity_file", "remote_program", "remote_plan", "remote_plan_sha256",
                          "receiver_host", "receiver_run_id", "receiver_work_root"},
            "SSH_BINDING_INVALID")
    require(re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}", value["host"] or "")
            and re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", value["user"] or "")
            and type(value["port"]) is int and 1 <= value["port"] <= 65535, "SSH_ENDPOINT_INVALID")
    require(value["receiver_host"] != plan["host"], "SAME_HOST_TRANSFER_DENIED")
    known = private_file(value["known_hosts"], 64 * 1024)
    require(digest(known) == hash_value(value["known_hosts_sha256"]), "SSH_HOST_KEY_BINDING_MISMATCH")
    identity = private_file(value["identity_file"], 64 * 1024)
    for key in ("remote_program", "remote_plan", "receiver_work_root"):
        require(re.fullmatch(r"/[A-Za-z0-9_./-]+", value[key] or "")
                and ".." not in PurePosixPath(value[key]).parts, "SSH_REMOTE_PATH_INVALID")
    hash_value(value["remote_plan_sha256"])
    # Authenticate the receiver's bytes before executing them. Do not depend on
    # a replaced receiver program to attest its own identity.
    bootstrap = ("import hashlib,pathlib,sys;"
                 "p=sys.argv[1];b=pathlib.Path(p).read_bytes();"
                 "ok=hashlib.sha256(b).hexdigest()==sys.argv[2];"
                 "sys.exit(71) if not ok else None;"
                 "sys.argv=[p]+sys.argv[3:];"
                 "exec(compile(b,p,'exec'),{'__name__':'__main__','__file__':p})")
    remote = ["python3", "-c", bootstrap, value["remote_program"], digest(PROGRAM),
              "receive", "--plan", value["remote_plan"],
              "--plan-sha256", value["remote_plan_sha256"], "--authorize",
              "FAI_CRM_N05_RECOVERY_RECEIVE_V1"]
    return ["ssh", "-F", "/dev/null", "-T", "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=yes", "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", "UserKnownHostsFile=" + str(known), "-o", "IdentitiesOnly=yes",
            "-o", "IdentityAgent=none", "-o", "ClearAllForwardings=yes",
            "-o", "PermitLocalCommand=no", "-o", "ConnectTimeout=10",
            "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2",
            "-i", identity, "-p", str(value["port"]),
            value["user"] + "@" + value["host"], shlex.join(remote)]


def transfer(plan, op, resume):
    argv = ssh_command(plan)
    if resume:
        argv[-1] += " --resume"
    op.event("TRANSFER_STARTED")
    with Path(plan["bundle"]).open("rb") as source:
        result = decode(run(argv, input_file=source, timeout=900))
    value = plan["ssh"]
    require(result.get("status") == "RECEIVE_VERIFIED"
            and result.get("bundle_sha256") == plan["bundle_sha256"]
            and result.get("bundle_bytes") == plan["bundle_bytes"]
            and result.get("recipient_sha256") == plan["recipient_sha256"]
            and result.get("host") == value["receiver_host"]
            and result.get("run_id") == value["receiver_run_id"]
            and result.get("work_root") == value["receiver_work_root"]
            and result.get("plan_sha256") == value["remote_plan_sha256"]
            and result.get("program_sha256") == digest(PROGRAM),
            "TRANSFER_RECEIPT_MISMATCH")
    op.event("TRANSFER_VERIFIED", receipt=result)
    return result


def receive(plan, op, resume):
    # A disconnected or stalled sender cannot hold an operation indefinitely.
    signal.alarm(900)
    require(type(plan["bundle_bytes"]) is int and 0 < plan["bundle_bytes"] <= MAX_FILE,
            "RECEIVE_SIZE_INVALID")
    hash_value(plan["bundle_sha256"])
    hash_value(plan["recipient_sha256"])
    final = op.root / "received.bundle.tar"
    require(resume or not final.exists(), "RECEIVE_DESTINATION_OCCUPIED")
    temporary = op.root / ("incoming-" + uuid.uuid4().hex + ".partial")
    op.event("RECEIVE_STARTED", temporary=temporary.name)
    h = hashlib.sha256()
    remaining = plan["bundle_bytes"]
    with temporary.open("xb") as stream:
        os.chmod(temporary, 0o600)
        while remaining:
            block = sys.stdin.buffer.read(min(remaining, 1024 * 1024))
            require(block, "TRANSFER_INTERRUPTED")
            stream.write(block)
            h.update(block)
            remaining -= len(block)
        require(not sys.stdin.buffer.read(1), "TRANSFER_EXTRA_BYTES")
        stream.flush()
        os.fsync(stream.fileno())
    require(h.hexdigest() == plan["bundle_sha256"], "TRANSFER_CIPHERTEXT_MISMATCH")
    if final.exists():
        private_file(final)
        require(digest(final) == plan["bundle_sha256"], "RESUME_DESTINATION_CHANGED")
        temporary.unlink()
    else:
        publish(temporary, final)
    receipt = {"status": "RECEIVE_VERIFIED", "bundle_sha256": digest(final),
               "bundle_bytes": final.stat().st_size, "recipient_sha256": plan["recipient_sha256"],
               "host": plan["host"], "run_id": plan["run_id"],
               "work_root": plan["work_root"],
               "plan_sha256": op.plan_hash, "program_sha256": digest(PROGRAM),
               "completed_utc": utc()}
    op.event("RECEIVE_VERIFIED", receipt=receipt)
    signal.alarm(0)
    return receipt


def docker(*args, **kwargs):
    # Never inherit DOCKER_HOST, contexts or Compose substitutions.
    return run(["docker", "--host", "unix:///var/run/docker.sock", *args], **kwargs)


def docker_object(kind, name):
    return decode(docker(kind, "inspect", name))[0] if kind in ("image", "volume") else decode(docker("inspect", name))[0]


def target_names(plan):
    project = plan["target_project"]
    require(re.fullmatch(r"fai-crm-recovery-[a-f0-9]{32}", project or "")
            and project == "fai-crm-recovery-" + plan["run_id"], "RECOVERY_PROJECT_INVALID")
    return {"postgres": project + "-postgres", "documents_helper": project + "-documents",
            "validator": project + "-validator", "postgres_volume": project + "-database",
            "documents_volume": project + "-documents-data"}


def destination_preflight(plan, occupied=False):
    require(plan["host"] != "fai-crm-prod-02", "PRODUCTION_RECOVERY_HOST_DENIED")
    actual = decode(docker("info", "--format", "{{json .}}"))
    require(actual["ID"] == plan["engine_id"] and actual["OSType"] == "linux", "DOCKER_ENGINE_MISMATCH")
    require(actual["Name"] != "fai-crm-prod-02", "PRODUCTION_DOCKER_ENGINE_DENIED")
    image_id(plan["postgres_image_id"])
    pg = docker_object("image", plan["postgres_image_id"])
    require(pg["Id"] == plan["postgres_image_id"], "POSTGRES_IMAGE_MISMATCH")
    image = docker_object("image", plan["expected"]["app_image_id"])
    labels = image["Config"].get("Labels") or {}
    require(image["Id"] == plan["expected"]["app_image_id"], "APPLICATION_IMAGE_MISMATCH")
    if plan["expected"]["image_provenance"] == "oci-labels":
        require(labels.get("org.opencontainers.image.revision") == plan["expected"]["source_commit"]
                and labels.get("it.finanzaagevolaimpresa.source-tree") == plan["expected"]["source_tree"],
                "APPLICATION_PROVENANCE_MISMATCH")
    else:
        require(plan["expected"]["image_provenance"] == "authorized-legacy-image-id"
                and not labels.get("org.opencontainers.image.revision")
                and not labels.get("it.finanzaagevolaimpresa.source-tree"), "LEGACY_PROVENANCE_MISMATCH")
    names = target_names(plan)
    if not occupied:
        containers = docker("ps", "-aq", "--filter", "label=" + LABEL + "=" + plan["run_id"]).strip()
        volumes = docker("volume", "ls", "-q", "--filter", "label=" + LABEL + "=" + plan["run_id"]).strip()
        require(not containers and not volumes, "RECOVERY_RESOURCES_ALREADY_EXIST")
        existing_names = set(docker("ps", "-a", "--format", "{{.Names}}").decode().splitlines())
        volume_names = set(docker("volume", "ls", "-q").decode().splitlines())
        require(not existing_names.intersection(names.values()) and not volume_names.intersection(names.values()),
                "DESTINATION_OCCUPIED")
    return names


def check_owner(value, plan):
    labels = value.get("Labels") or value.get("Config", {}).get("Labels") or {}
    require(labels.get(LABEL) == plan["run_id"]
            and labels.get("it.finanzaagevolaimpresa.sentinel") == SENTINEL,
            "RESOURCE_OWNERSHIP_MISMATCH")
    if plan["data_class"] == "synthetic":
        require(labels.get(TEST_LABEL) == plan["run_id"], "SYNTHETIC_RESOURCE_LABEL_MISMATCH")


def sql(plan, container, statement, *, data=None):
    return docker("exec", "-i", "-u", "postgres", container, "psql", "-X", "-q", "-A", "-t",
                  "-v", "ON_ERROR_STOP=1", "-U", "fai_recovery", "-d", "fai_crm_recovery",
                  data=data if data is not None else statement.encode(), timeout=180)


def recovery_preflight(plan):
    expected_source(plan["expected"])
    bundle_preflight(plan)
    age_ready()
    recipient(plan["recipient"])
    identity = private_file(plan["identity_file"], 64 * 1024)
    require(run(["age-keygen", "-y", identity]).decode().strip() == plan["recipient"],
            "DECRYPTION_IDENTITY_MISMATCH")
    destination_preflight(plan)


def owned_container_args(plan, name):
    result = ["--name", name, "--label", LABEL + "=" + plan["run_id"],
            "--label", "it.finanzaagevolaimpresa.sentinel=" + SENTINEL,
            "--network", "none", "--read-only", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges=true", "--pull", "never"]
    if plan["data_class"] == "synthetic":
        result += ["--label", TEST_LABEL + "=" + plan["run_id"]]
    return result


def temporary_container(plan, op, name, arguments, *, input_file=None, output_file=None):
    op.event("RESOURCE_INTENT", kind="container", name=name)
    identifier = docker("create", "-i", *owned_container_args(plan, name),
                        "--tmpfs", "/var/lib/postgresql/data:rw,nosuid,noexec,mode=0700",
                        *arguments).decode().strip()
    value = docker_object("container", identifier)
    check_owner(value, plan)
    require(value["Id"] == identifier, "CREATED_CONTAINER_ID_MISMATCH")
    op.event("RESOURCE_CREATED", kind="container", name=name, resource_id=identifier)
    # Explicit instance ID is recorded before execution and checked before removal.
    docker("start", "--attach", "--interactive", identifier,
           input_file=input_file, output_file=output_file)
    value = docker_object("container", identifier)
    check_owner(value, plan)
    require(value["Id"] == identifier and not value["State"]["Running"],
            "HELPER_INSTANCE_CHANGED_OR_RUNNING")
    exit_code = value["State"]["ExitCode"]
    docker("rm", identifier)
    op.event("RESOURCE_REMOVED", kind="container", name=name, resource_id=identifier)
    require(exit_code == 0, "RECOVERY_HELPER_FAILED")


def recover(plan, op):
    encrypted = op.root / "encrypted"
    unpack(Path(plan["bundle"]), encrypted, exact={"INDEX.json", *(c + ".age" for c in COMPONENTS)})
    for component in COMPONENTS:
        op.event("DECRYPTING", component=component)
        plaintext = op.root / (component + ".tar")
        with plaintext.open("xb") as target:
            os.chmod(plaintext, 0o600)
            run(["age", "--decrypt", "--identity", plan["identity_file"], encrypted / (component + ".age")],
                output_file=target)
        exact = N05_FILES if component == "database-documents" else None
        unpack(plaintext, op.root / component, exact=exact)
        plaintext.unlink()
    backup = op.root / "database-documents"
    verify_n05(backup, plan["expected"])
    names = destination_preflight(plan)
    pg_image = plan["postgres_image_id"]
    # Validate the authenticated custom dump in a disposable networkless process
    # before allocating any persistent target volume.
    with (backup / "postgres.dump").open("rb") as source:
        temporary_container(plan, op, names["validator"],
                            ["--entrypoint", "pg_restore", pg_image, "--list"], input_file=source)
    for key in ("postgres_volume", "documents_volume"):
        op.event("RESOURCE_INTENT", kind="volume", name=names[key])
        volume_labels = ["--label", LABEL + "=" + plan["run_id"],
                         "--label", "it.finanzaagevolaimpresa.sentinel=" + SENTINEL]
        if plan["data_class"] == "synthetic":
            volume_labels += ["--label", TEST_LABEL + "=" + plan["run_id"]]
        docker("volume", "create", *volume_labels, names[key])
        value = docker_object("volume", names[key])
        check_owner(value, plan)
        op.event("RESOURCE_CREATED", kind="volume", name=names[key], created_at=value["CreatedAt"],
                 mountpoint=value["Mountpoint"], driver=value["Driver"])
    op.event("RESOURCE_INTENT", kind="container", name=names["postgres"])
    # The official image supplies the empty directory's postgres ownership via
    # Docker volume initialization. PostgreSQL itself runs without capabilities.
    created_id = docker("create", *owned_container_args(plan, names["postgres"]), "--user", "postgres",
           "--tmpfs", "/tmp:rw,nosuid,noexec,mode=1777",
           "--tmpfs", "/var/run/postgresql:rw,nosuid,noexec,mode=1777",
           "--mount", "type=volume,src=" + names["postgres_volume"] + ",dst=/var/lib/postgresql/data",
           "-e", "POSTGRES_USER=fai_recovery", "-e", "POSTGRES_DB=fai_crm_recovery",
           "-e", "POSTGRES_HOST_AUTH_METHOD=trust", pg_image).decode().strip()
    value = docker_object("container", created_id)
    check_owner(value, plan)
    require(value["Id"] == created_id, "CREATED_CONTAINER_ID_MISMATCH")
    op.event("RESOURCE_CREATED", kind="container", name=names["postgres"], resource_id=value["Id"])
    docker("start", created_id)
    require(value["HostConfig"]["NetworkMode"] == "none"
            and not value["HostConfig"].get("PortBindings")
            and not value["HostConfig"]["Privileged"], "RECOVERY_ISOLATION_MISMATCH")
    deadline = time.monotonic() + 90
    while True:
        try:
            sql(plan, names["postgres"], "SELECT 1;")
            break
        except Denied:
            require(time.monotonic() < deadline, "RECOVERY_DATABASE_NOT_READY")
            time.sleep(0.5)
    require(sql(plan, names["postgres"], "SHOW server_version_num;").strip().startswith(b"16"),
            "POSTGRES_MAJOR_VERSION_MISMATCH")
    empty = sql(plan, names["postgres"],
                "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
                "WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S');").strip()
    require(empty == b"0", "RECOVERY_DATABASE_NOT_EMPTY")
    op.event("DATABASE_RESTORE_STARTED")
    with (backup / "postgres.dump").open("rb") as source:
        docker("exec", "-i", "-u", "postgres", names["postgres"],
               "pg_restore", "--exit-on-error", "--single-transaction", "--no-owner",
               "--no-privileges", "-U", "fai_recovery", "-d", "fai_crm_recovery",
               input_file=source, timeout=900)
    op.event("DATABASE_RESTORED")
    with (backup / "documents.tar.gz").open("rb") as source:
        temporary_container(plan, op, names["documents_helper"], ["--user", "0:0", "--mount",
               "type=volume,src=" + names["documents_volume"] + ",dst=/recovery",
               "--entrypoint", "sh", pg_image, "-ceu",
               'test -z "$(ls -A /recovery)"; exec tar --no-same-owner --no-same-permissions -xzf - -C /recovery'],
               input_file=source)
    op.event("DOCUMENTS_RESTORED")
    migrations_sql = ('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; '
        "SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='1s'; "
        'SELECT coalesce(json_agg(json_build_object(\'name\',"migration_name",\'checksum\',"checksum",'
        '\'finished\',"finished_at" IS NOT NULL,\'rolled_back\',"rolled_back_at" IS NOT NULL) '
        'ORDER BY "migration_name"),\'[]\'::json) FROM "_prisma_migrations"; ROLLBACK;')
    observed = decode(sql(plan, names["postgres"], migrations_sql))
    migration_paths = git("ls-tree", "-r", "--name-only", plan["expected"]["source_commit"],
                          "--", "prisma/migrations").splitlines()
    expected = {Path(p).parent.name: sha(run(["git", "-C", ROOT, "show",
                 plan["expected"]["source_commit"] + ":" + p])) for p in migration_paths
                if p.endswith("/migration.sql")}
    verify_restored_migrations(observed, expected)
    invalid = sql(plan, names["postgres"],
        "BEGIN READ ONLY; SET LOCAL statement_timeout='30s'; "
        "SELECT count(*) FROM pg_constraint WHERE contype IN ('f','c') AND NOT convalidated; ROLLBACK;").strip()
    require(invalid == b"0", "RESTORED_CONSTRAINTS_NOT_VALIDATED")
    # Re-export documents from the newly allocated volume, validate paths again
    # and compare each byte digest internally. Never output client filenames.
    exported = op.root / "verified-documents.tar.gz"
    with exported.open("xb") as target:
        os.chmod(exported, 0o600)
        temporary_container(plan, op, names["documents_helper"],
               ["--mount", "type=volume,src=" + names["documents_volume"] + ",dst=/recovery,readonly",
               "--entrypoint", "tar", pg_image, "-czf", "-", "-C", "/recovery", "."],
               output_file=target)
    original_docs = archive_digests(backup / "documents.tar.gz")
    require(archive_digests(exported) == original_docs, "RESTORED_DOCUMENTS_MISMATCH")
    verify_n05(backup, plan["expected"])
    require(digest(plan["bundle"]) == plan["bundle_sha256"], "SOURCE_BUNDLE_CHANGED")
    result = {"status": "RECOVERY_VERIFIED", "source": plan["expected"],
              "migrations": len(observed), "document_files": len(original_docs),
              "configuration_files": len(private_inventory(op.root / "configuration")),
              "cryptographic_files": len(private_inventory(op.root / "cryptographic-material")),
              "database_restore": "single transaction; rebuilt constraints/indexes",
              "network": "none", "published_ports": 0, "application_started": False,
              "engine_id": plan["engine_id"], "bundle_sha256": plan["bundle_sha256"],
              "data_class": plan["data_class"]}
    op.event("RECOVERY_VERIFIED", result=result)
    return result


def verify_restored_migrations(observed, expected):
    require(len(expected) == 43 and len(observed) == 43
            and {x["name"] for x in observed} == set(expected)
            and all(x["finished"] and not x["rolled_back"] and expected.get(x["name"]) == x["checksum"]
                    for x in observed), "RESTORED_MIGRATIONS_MISMATCH")


def archive_digests(path):
    safe_members(path, compressed=True)
    result = {}
    with tarfile.open(path, "r:gz") as archive:
        for item in archive:
            if item.isfile():
                name = item.name[2:] if item.name.startswith("./") else item.name
                h = hashlib.sha256()
                with archive.extractfile(item) as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b""):
                        h.update(block)
                result[name] = h.hexdigest()
    return result


def cleanup(plan, op):
    if plan["phase"] in ("protect", "receive", "transfer"):
        # Keep published ciphertext, keys and all receipts. Only incomplete
        # local plaintext/copy files created under this pinned operation go.
        names = {c + ".tar" for c in COMPONENTS} if plan["phase"] == "protect" else set()
        names |= {e["temporary"] for e in op.events() if e["phase"] == "RECEIVE_STARTED"}
        for name in names:
            require(Path(name).name == name, "CLEANUP_NAME_DENIED")
            p = op.root / name
            if p.exists() or p.is_symlink():
                private_file(p).unlink()
        op.event("CLEANUP_VERIFIED", published_ciphertext_preserved=True)
        return {"status": "CLEANUP_VERIFIED", "published_ciphertext_preserved": True}
    require(plan["phase"] == "recover", "CLEANUP_BACKUP_NOT_SUPPORTED")
    destination_preflight(plan, occupied=True)
    intents = {(e["kind"], e["name"]) for e in op.events() if e["phase"] == "RESOURCE_INTENT"}
    names = set(target_names(plan).values())
    for kind, name in sorted(intents, key=lambda x: x[0] == "volume"):
        require(name in names, "CLEANUP_NAME_DENIED")
        listing = docker("volume", "ls", "-q") if kind == "volume" else docker("ps", "-a", "--format", "{{.Names}}")
        if name not in listing.decode().splitlines():
            continue
        value = docker_object(kind, name)
        check_owner(value, plan)
        events = [e for e in op.events() if e["phase"] == "RESOURCE_CREATED"
                  and e["name"] == name and e["kind"] == kind]
        require(events, "CLEANUP_CREATION_RECEIPT_MISSING")
        identity = value["CreatedAt"] if kind == "volume" else value["Id"]
        recorded = events[-1]["created_at"] if kind == "volume" else events[-1]["resource_id"]
        require(identity == recorded, "CLEANUP_RESOURCE_REPLACED")
        if kind == "volume":
            require(value["Name"] == name and value["Mountpoint"] == events[-1]["mountpoint"]
                    and value["Driver"] == events[-1]["driver"], "CLEANUP_RESOURCE_REPLACED")
        if kind == "volume":
            docker("volume", "rm", name)
        else:
            docker("rm", "-f", value["Id"])
    # Private decrypted material is removed only below this operation's private
    # root. Source bundle, protected output, identities and journal stay intact.
    for name in ("database-documents", "configuration", "cryptographic-material"):
        p = op.root / name
        if p.exists():
            remove_owned_tree(p)
    for p in op.root.iterdir():
        if p.name.endswith(".tar") or p.name == "verified-documents.tar.gz":
            private_file(p).unlink()
    require(not docker("ps", "-aq", "--filter", "label=" + LABEL + "=" + plan["run_id"]).strip()
            and not docker("volume", "ls", "-q", "--filter", "label=" + LABEL + "=" + plan["run_id"]).strip(),
            "CLEANUP_RESOURCES_REMAIN")
    require(digest(plan["bundle"]) == plan["bundle_sha256"], "SOURCE_BUNDLE_CHANGED")
    op.event("CLEANUP_VERIFIED", source_bundle_preserved=True)
    return {"status": "CLEANUP_VERIFIED", "source_bundle_preserved": True}


def remove_owned_tree(root):
    private_dir(root)
    for current, directories, files in os.walk(root, topdown=False, followlinks=False):
        for name in files:
            private_file(Path(current) / name).unlink()
        for name in directories:
            private_dir(Path(current) / name).rmdir()
    root.rmdir()


def backup_preflight(plan):
    value = plan["environment"]
    require(isinstance(value, dict) and set(value) <= ENV_KEYS
            and all(isinstance(v, str) for v in value.values()), "BACKUP_ENVIRONMENT_INVALID")
    require(value.get("EXPECTED_MIGRATION_COUNT") == "43", "EXACTLY_43_MIGRATIONS_REQUIRED")
    actual = decode(docker("info", "--format", "{{json .}}"))
    require(actual["ID"] == plan["engine_id"] and actual["OSType"] == "linux",
            "BACKUP_DOCKER_ENGINE_MISMATCH")
    verify_backup_configuration(plan)
    production = value.get("FAI_ENVIRONMENT") == "production"
    if production:
        require(plan["data_class"] == "production" and plan["host"] == "fai-crm-prod-02",
                "PRODUCTION_BACKUP_IDENTITY_MISMATCH")
        wrapper = ROOT / "scripts/backup-docker-prod.sh"
    else:
        require(plan["data_class"] == "synthetic" and value.get("FAI_ENVIRONMENT") == "restore-source",
                "SYNTHETIC_BACKUP_IDENTITY_MISMATCH")
        wrapper = ROOT / "scripts/n05/backup-compose.sh"
    run(["bash", wrapper, "--preflight"], env=backup_environment(plan))
    return wrapper


def backup_environment(plan):
    # Force the same local socket inspected above. A saved Docker context in
    # the operator's HOME must not redirect the N05 wrapper to another engine.
    return plan["environment"] | {"DOCKER_HOST": "unix:///var/run/docker.sock"}


def verify_backup_configuration(plan):
    for field, expected in (("ENV_FILE", "env_file_sha256"), ("APP_ENV_FILE", "app_env_file_sha256")):
        p = private_file(plan["environment"][field])
        require(digest(p) == hash_value(plan[expected]), "BACKUP_CONFIGURATION_CHANGED")


def preflight(plan):
    phase = plan["phase"]
    if phase == "backup":
        backup_preflight(plan)
    elif phase == "protect":
        protect_preflight(plan)
    elif phase == "transfer":
        bundle_preflight(plan)
        ssh_command(plan)
    elif phase == "recover":
        recovery_preflight(plan)
    elif phase == "receive":
        hash_value(plan["bundle_sha256"])
        require(type(plan["bundle_bytes"]) is int and 0 < plan["bundle_bytes"] <= MAX_FILE,
                "RECEIVE_SIZE_INVALID")


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("identity", "inspect-component", "preflight", "backup", "protect",
                                           "transfer", "receive", "recover", "status", "cleanup"))
    parser.add_argument("--plan")
    parser.add_argument("--plan-sha256")
    parser.add_argument("--authorize")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--directory")
    args = parser.parse_args()
    op = None
    try:
        if args.command == "identity":
            print(json.dumps({"tools": tools_binding(), "host": socket.gethostname()}))
            return
        if args.command == "inspect-component":
            print(json.dumps(component_identity(args.directory), sort_keys=True))
            return
        plan = load_plan(args.plan, args.plan_sha256)
        require(args.command in ("preflight", "status", "cleanup", plan["phase"]), "PLAN_PHASE_MISMATCH")
        if args.command == "status":
            root = private_dir(plan["work_root"]) / plan["run_id"]
            original = decode(private_file(root / "operation.json").read_bytes())
            require(original["plan_sha256"] == args.plan_sha256, "STATUS_PLAN_MISMATCH")
            events = sorted(root.glob("event-*.json"))
            last = decode(private_file(events[-1]).read_bytes()) if events else {"phase": "INITIALIZED"}
            print(json.dumps({"status": "OBSERVED", "last_phase": last["phase"], "run_id": plan["run_id"]}))
            return
        if args.command == "preflight":
            preflight(plan)
            require(not (Path(plan["work_root"]) / plan["run_id"]).exists(), "OPERATION_ALREADY_EXISTS")
            print(json.dumps({"status": "PREFLIGHT_PASS", "phase": plan["phase"],
                              "authorization_granted": False, "plan_sha256": args.plan_sha256}))
            return
        require(args.authorize == "FAI_CRM_N05_RECOVERY_" + args.command.upper() + "_V1",
                "EXPLICIT_AUTHORIZATION_REQUIRED")
        require(not args.resume or args.command in ("transfer", "receive"), "RESUME_PHASE_DENIED")
        if args.command != "cleanup":
            # A partial database is NEVER reused as an empty recovery target.
            # Cleanup the owned failed attempt and use a new plan/run identity.
            preflight(plan)
        op = Operation(plan, args.plan_sha256, resume=args.resume or args.command == "cleanup")
        op.event("BEGIN", command=args.command)
        if args.command == "backup":
            wrapper = backup_preflight(plan)
            backup_output = run(["bash", wrapper, "--create"], env=backup_environment(plan), timeout=1800)
            helper_ids = re.findall(rb"N05_BACKUP_HELPER_REMOVED\|container_id=([a-f0-9]{64})", backup_output)
            require(len(helper_ids) == 1, "BACKUP_HELPER_RECEIPT_MISSING")
            op.event("BACKUP_HELPER_REMOVED", resource_id=helper_ids[0].decode(),
                     removal="Docker automatic removal bound to recorded instance")
            verify_backup_configuration(plan)
            result = {"status": "BACKUP_WRAPPER_COMPLETED", "verification": "N05 atomic verified publication"}
            op.event("BACKUP_VERIFIED")
        elif args.command == "protect":
            result = protect(plan, op)
            result["status"] = "PROTECTION_VERIFIED"
        elif args.command == "transfer":
            result = transfer(plan, op, args.resume)
        elif args.command == "receive":
            result = receive(plan, op, args.resume)
        elif args.command == "recover":
            result = recover(plan, op)
        else:
            result = cleanup(plan, op)
        print(json.dumps(result, sort_keys=True))
    except (Denied, OSError, ValueError, KeyError, TypeError, tarfile.TarError, InterruptedError) as error:
        code = str(error) if isinstance(error, Denied) else "INTERRUPTED" if isinstance(error, InterruptedError) else "OPERATION_FAILED"
        if op:
            op.event("FAILED", code=code)
        print(json.dumps({"status": "DENIED", "code": code}), file=sys.stderr)
        sys.exit(1)
    finally:
        if op:
            op.close()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(InterruptedError()))
    signal.signal(signal.SIGINT, lambda *_: (_ for _ in ()).throw(InterruptedError()))
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(InterruptedError()))
    main()
