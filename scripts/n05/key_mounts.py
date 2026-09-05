"""N05 configuration-only gate and shared, daemon-facing test primitives.

No key content or subprocess output is printed. The production entry point has
fixed identities/paths; the synthetic drill imports the same lower-level
primitives and supplies a distinct, isolated stack. It cannot select a synthetic
mode on the production entry point.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys
import tempfile
import time

REPO = Path(__file__).resolve().parents[2]
KEYS = {
    "SECURE_LEAD_GATEWAY_KEYRING_FILE": ("n12-keyring.json", "/run/secrets/n12-keyring.json"),
    "LEAD_IDENTITY_KEY_FILE": ("n13-identity.json", "/run/secrets/n13-identity.json"),
}
PRODUCTION_KEY_ROOT = Path("/etc/fai-crm/keys")
CLOSED = {
    "SECURE_LEAD_GATEWAY_MODE": {"", "disabled"},
    "WEBSITE_LEAD_MODE": {"", "disabled"},
    "COMMERCIAL_LEAD_INBOX_MODE": {"", "disabled"},
    "FEATURE_INTEGRATIONS_ENABLED": {"", "false"},
    "VNX01_LEAD_INTAKE_CONSUMER_ENABLED": {"", "0"},
    "FEATURE_AI_WORKER_ENABLED": {"", "false"},
    "FEATURE_AI_DISPATCH_ENABLED": {"", "false"},
    "FEATURE_AI_EGRESS_ENABLED": {"", "false"},
    "AI_ORCHESTRATOR_WORKER_ENABLED": {"", "0"},
    "AI_EXTERNAL_PROVIDERS_ENABLED": {"", "false"},
}
PARSER_PROBE = """
const fs = await import('node:fs');
const n12 = await import('./src/lib/secure-lead-gateway.ts');
const n13 = await import('./src/lib/lead-identity.ts');
await (n12.readSecureLeadGatewayKeyring ?? n12.default.readSecureLeadGatewayKeyring)();
await (n13.readLeadIdentityKeyFile ?? n13.default.readLeadIdentityKeyFile)();
for (const file of [process.env.SECURE_LEAD_GATEWAY_KEYRING_FILE, process.env.LEAD_IDENTITY_KEY_FILE]) {
  const s = fs.statSync(file);
  if (s.uid !== process.getuid() || s.gid !== process.getgid() || (s.mode & 0o7777) !== 0o400) process.exit(3);
  // O_WRONLY without O_TRUNC: even a failed RO assertion never truncates a key.
  try { const fd = fs.openSync(file, fs.constants.O_WRONLY); fs.closeSync(fd); process.exit(4); }
  catch (e) { if (!['EROFS', 'EACCES', 'EPERM'].includes(e.code)) throw e; }
  try { fs.chmodSync(file, 0o600); process.exit(5); }
  catch (e) { if (!['EROFS', 'EPERM'].includes(e.code)) throw e; }
}
console.log('N05_KEY_PARSERS_READ_ONLY_PASS');
"""


class Denied(Exception):
    pass


def require(condition, code):
    if not condition:
        raise Denied(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def file_digest(file):
    with open(file, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def load_json(file):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "DUPLICATE_JSON_KEY")
            result[key] = value
        return result
    with open(file, encoding="utf-8") as stream:
        return json.load(stream, object_pairs_hook=unique)


def trusted_path(path, directory=False, owners=None):
    """lstat every component; never resolve a symlink into an accepted path."""
    path = Path(path)
    require(path.is_absolute() and ".." not in path.parts and str(path) != "/", "PATH_INVALID")
    owners = {0, os.getuid()} if owners is None else owners
    for parent in reversed(path.parents):
        s = parent.lstat()
        require(stat.S_ISDIR(s.st_mode) and s.st_uid in owners and not s.st_mode & 0o022,
                "PATH_PARENT_UNTRUSTED")
    s = path.lstat()
    require(stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode), "PATH_TYPE_INVALID")
    require(s.st_uid in owners and not s.st_mode & 0o022, "PATH_OWNER_OR_MODE_INVALID")
    return s


def validate_key_sources(root, uid, gid):
    require(uid > 0 and gid > 0, "APP_ROOT_IDENTITY_DENIED")
    trusted_path(root, directory=True)
    inventory = {}
    for name, _ in KEYS.values():
        source = Path(root) / name
        # The directory has already been checked; the file belongs to the app.
        s = source.lstat()
        require(stat.S_ISREG(s.st_mode) and s.st_nlink == 1, "KEY_NOT_SINGLE_REGULAR_FILE")
        require(s.st_uid == uid and s.st_gid == gid and stat.S_IMODE(s.st_mode) == 0o400,
                "KEY_OWNER_OR_PERMISSIONS_INVALID")
        require(0 < s.st_size <= 65536, "KEY_SIZE_INVALID")
        inventory[name] = (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_uid, s.st_gid)
    return inventory


def validate_pair(ordinary, mounted, project, key_root):
    """Validate the effective Compose models, not just the overlay's source."""
    for model in (ordinary, mounted):
        require(model.get("name") == project, "COMPOSE_PROJECT_INVALID")
        require(set(model.get("services", {})) == {"app", "postgres"}, "COMPOSE_SERVICES_INVALID")
        require(set(model.get("volumes", {})) == {"crm_documents", "postgres_data"}, "COMPOSE_VOLUMES_INVALID")
        require(set(model.get("networks", {})) == {"default"}, "COMPOSE_NETWORKS_INVALID")
        require(not model.get("secrets") and not model.get("configs"), "COMPOSE_EXTRA_RESOURCES")
        for logical in ("crm_documents", "postgres_data"):
            require(model["volumes"][logical] == {"external": True, "name": f"{project}_{logical}"},
                    "COMPOSE_VOLUME_NOT_EXACT_EXTERNAL")
        network = copy.deepcopy(model["networks"]["default"])
        # Compose 2.x emits an empty IPAM object for an external network.
        # Accept only that empty normalization; never an IPAM configuration.
        if network.get("ipam") == {}:
            network.pop("ipam")
        require(network == {"external": True, "name": f"{project}_default"},
                "COMPOSE_NETWORK_NOT_EXACT_EXTERNAL")
        for service in model["services"].values():
            for forbidden in ("privileged", "cap_add", "devices", "device_cgroup_rules", "pid", "ipc",
                              "user", "userns_mode", "group_add", "network_mode", "volumes_from",
                              "secrets", "configs", "post_start", "pre_stop", "develop"):
                require(not service.get(forbidden), "COMPOSE_EXTRA_AUTHORITY")
        app_env = model["services"]["app"].get("environment", {})
        for key, allowed in CLOSED.items():
            require(str(app_env.get(key) or "") in allowed, "APPLICATION_GATE_NOT_CLOSED")
    plain = ordinary["services"]["app"]
    enabled = mounted["services"]["app"]
    for key in KEYS:
        require(not plain.get("environment", {}).get(key), "ORDINARY_KEY_REFERENCE_NOT_EMPTY")
    mounts = plain.get("volumes", [])
    require(len(mounts) == 1 and mounts[0].get("type") == "volume"
            and mounts[0].get("source") == "crm_documents"
            and mounts[0].get("target") == "/var/lib/fai-crm/documents", "ORDINARY_APP_MOUNTS_INVALID")
    db_mounts = ordinary["services"]["postgres"].get("volumes", [])
    require(len(db_mounts) == 1 and db_mounts[0].get("type") == "volume"
            and db_mounts[0].get("source") == "postgres_data"
            and db_mounts[0].get("target") == "/var/lib/postgresql/data", "POSTGRES_MOUNTS_INVALID")
    expected = copy.deepcopy(ordinary)
    expected_app = expected["services"]["app"]
    for key, (name, target) in KEYS.items():
        expected_app["environment"][key] = target
        expected_app["volumes"].append({
            "type": "bind", "source": (Path(key_root) / name).as_posix(), "target": target,
            "read_only": True, "bind": {"create_host_path": False},
        })
    # Compose sorts the volume sequence by target.
    for model in (expected, mounted):
        model["services"]["app"]["volumes"].sort(key=lambda item: item["target"])
    require(expected == mounted, "COMPOSE_UNEXPECTED_DELTA")
    require(enabled.get("image") == plain.get("image"), "COMPOSE_IMAGE_CHANGED")


def validate_provenance(image, app, approval):
    image_id = approval["image_id"]
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", image_id), "IMAGE_ID_INVALID")
    require(image["Id"] == app["Image"] == image_id, "SAME_IMAGE_ID_MISMATCH")
    require(app["Config"]["Image"] == approval["image"], "CURRENT_IMAGE_TAG_MISMATCH")
    require(image["Config"].get("User") and image["Config"]["User"] == app["Config"].get("User"),
            "APP_IMAGE_USER_MISMATCH")
    labels = image["Config"].get("Labels", {})
    require(labels.get("org.opencontainers.image.revision") == approval["image_source_commit"]
            and labels.get("it.finanzaagevolaimpresa.source-tree") == approval["image_source_tree"],
            "IMAGE_PROVENANCE_MISMATCH")


def env_map(values):
    return dict(item.split("=", 1) for item in values or [])


def validate_runtime(app, image, model, project, key_root, enabled):
    service = model["services"]["app"]
    expected_env = env_map(image["Config"].get("Env"))
    # Compose's config JSON is a replayable representation; literal dollars
    # are doubled by its serializer. Docker receives one unescaped level.
    expected_env.update({k: str(v).replace("$$", "$") for k, v in service["environment"].items()})
    require(env_map(app["Config"].get("Env")) == expected_env, "CURRENT_APP_ENVIRONMENT_MISMATCH")
    for key in ("Cmd", "Entrypoint", "User"):
        require(app["Config"].get(key) == image["Config"].get(key), "CURRENT_APP_EXECUTION_MISMATCH")
    host = app["HostConfig"]
    require(not host.get("Privileged") and not host.get("CapAdd") and not host.get("Devices")
            and not host.get("GroupAdd") and not host.get("Binds"), "CURRENT_APP_AUTHORITY_MISMATCH")
    expected_mounts = {"/var/lib/fai-crm/documents": ("volume", f"{project}_crm_documents", True)}
    if enabled:
        expected_mounts.update({target: ("bind", str(Path(key_root) / name), False)
                                for name, target in KEYS.values()})
    observed = {m["Destination"]: (m["Type"], m.get("Name") if m["Type"] == "volume" else m["Source"], m["RW"])
                for m in app["Mounts"]}
    require(observed == expected_mounts and len(app["Mounts"]) == len(expected_mounts),
            "CURRENT_APP_MOUNTS_MISMATCH")
    require(set(app["NetworkSettings"]["Networks"]) == {f"{project}_default"}, "CURRENT_APP_NETWORK_MISMATCH")
    expected_ports = {}
    for port in service.get("ports", []):
        expected_ports.setdefault(f'{port["target"]}/{port.get("protocol", "tcp")}', []).append({
            "HostIp": port.get("host_ip", ""), "HostPort": str(port["published"]),
        })
    require((host.get("PortBindings") or {}) == expected_ports, "CURRENT_APP_PORTS_MISMATCH")


def normalize_compose_model(model):
    model = copy.deepcopy(model)
    for service in model.get("services", {}).values():
        for mount in service.get("volumes", []):
            if mount.get("type") == "bind" and mount.get("bind") == {}:
                # Compose 2.38 omits this false boolean when serializing. Write
                # it explicitly into the frozen input; never rely on a default.
                mount["bind"]["create_host_path"] = False
    return model


class Docker:
    def __init__(self, command=None, environment=None):
        self.command = command or ["docker", "--host", "unix:///var/run/docker.sock"]
        self.env = environment or {k: os.environ[k] for k in ("PATH", "HOME") if k in os.environ}
        self.env["LC_ALL"] = "C"

    def run(self, *args, input_text=None, timeout=120):
        result = subprocess.run(self.command + list(args), env=self.env, input=input_text,
                                text=True, capture_output=True, timeout=timeout, check=False)
        require(result.returncode == 0, "DOCKER_COMMAND_FAILED")
        return result.stdout

    def inspect(self, resource, kind="container"):
        return json.loads(self.run(kind, "inspect", resource))[0]

    def compose(self, project, root, files, *args, env_file="/dev/null"):
        return self.run("compose", "-p", project, "--project-directory", str(root),
                        "--env-file", str(env_file),
                        *[item for file in files for item in ("-f", str(file))], *args)

    def model(self, project, root, files, env_file="/dev/null"):
        return normalize_compose_model(json.loads(self.compose(project, root, files,
                                       "config", "--format", "json", env_file=env_file)))


def freeze_model(docker, project, root, model, destination):
    # config --format json already escapes dollars for replay. A second escape
    # would corrupt runtime values. Prove a fixed point before actual use.
    destination.write_text(canonical(model), encoding="utf-8")
    destination.chmod(0o600)
    reread = docker.model(project, root, [destination])
    require(reread == model, "FROZEN_COMPOSE_MODEL_MISMATCH")


def persistent_snapshot(docker, project, postgres_id):
    db = docker.inspect(postgres_id)
    require(db["State"]["Running"] and db["State"].get("Health", {}).get("Status") == "healthy",
            "POSTGRES_NOT_HEALTHY")
    network = docker.inspect(f"{project}_default", "network")
    return {
        "postgres": {key: db[key] for key in ("Id", "Image", "Created", "Mounts")},
        "volumes": [docker.inspect(f"{project}_{name}", "volume") for name in ("crm_documents", "postgres_data")],
        # Endpoints change on app recreation; the network identity must not.
        "network": {key: network[key]
                    for key in ("Id", "Name", "Created", "Driver", "Scope", "Labels", "Options", "IPAM")},
    }


def app_id(docker, project):
    ids = docker.run("ps", "-aq", "--no-trunc", "--filter", f"label=com.docker.compose.project={project}",
                     "--filter", "label=com.docker.compose.service=app").split()
    require(len(ids) == 1, "APP_COUNT_INVALID")
    return ids[0]


def recreate_app(docker, project, root, frozen, expected_model, image, approval, key_root,
                 uid, gid, postgres_id, enabled, expected_current_id, current_model):
    before_id = app_id(docker, project)
    require(before_id == expected_current_id, "CURRENT_CONTAINER_CHANGED")
    validate_provenance(docker.inspect(approval["image"], "image"), docker.inspect(before_id), approval)
    validate_runtime(docker.inspect(before_id), image, current_model, project, key_root, not enabled)
    before = persistent_snapshot(docker, project, postgres_id)
    require(docker.model(project, root, [frozen]) == expected_model,
            "FROZEN_COMPOSE_CHANGED")
    docker.compose(project, root, [frozen], "up", "-d", "--no-deps", "--no-build",
                   "--pull", "never", "--force-recreate", "app")
    after_id = app_id(docker, project)
    require(after_id != before_id, "APP_WAS_NOT_RECREATED")
    for _ in range(120):
        after = docker.inspect(after_id)
        if after["State"].get("Health", {}).get("Status") == "healthy":
            break
        require(after["State"]["Running"], "RECREATED_APP_STOPPED")
        time.sleep(1)
    require(after["State"].get("Health", {}).get("Status") == "healthy", "RECREATED_APP_NOT_HEALTHY")
    validate_provenance(image, after, approval)
    validate_runtime(after, image, expected_model, project, key_root, enabled)
    require(persistent_snapshot(docker, project, postgres_id) == before, "PERSISTENT_RESOURCES_CHANGED")
    require(docker.run("exec", after_id, "id", "-u").strip() == str(uid)
            and docker.run("exec", after_id, "id", "-g").strip() == str(gid), "RECREATED_APP_UID_GID_MISMATCH")
    if enabled:
        probe = docker.run("exec", "-i", after_id, "node", "--import", "tsx", "--input-type=module",
                           input_text=PARSER_PROBE)
        require(probe.strip() == "N05_KEY_PARSERS_READ_ONLY_PASS", "KEY_PARSER_PROBE_FAILED")
    return after_id


def command(args, environment=None):
    result = subprocess.run(args, env=environment, capture_output=True, text=True, timeout=120, check=False)
    require(result.returncode == 0, "EXTERNAL_CHECK_FAILED")
    return result.stdout.strip()


def git(*args):
    return command(["git", "-C", str(REPO), *args])


APPROVAL_KEYS = {
    "schema", "tools_commit", "tools_tree", "tools_first_parent", "tools_ci_sha", "tools_ci_conclusion",
    "image", "image_id", "image_source_commit", "image_source_tree", "postgres_image",
    "ordinary_config_sha256", "mounted_config_sha256", "app_uid", "app_gid",
    "backup_set", "recovery_directory", "recovery_manifest_sha256",
}


def validate_tools(approval):
    require(set(approval) == APPROVAL_KEYS and approval["schema"] == "FAI_CRM_N05_KEY_MOUNTS_V1",
            "APPROVAL_SCHEMA_INVALID")
    for key in ("tools_commit", "tools_tree", "tools_first_parent", "tools_ci_sha",
                "image_source_commit", "image_source_tree"):
        require(re.fullmatch(r"[0-9a-f]{40}", approval[key]), "APPROVAL_GIT_ID_INVALID")
    require(approval["tools_ci_conclusion"] == "success"
            and approval["tools_ci_sha"] == approval["tools_commit"], "TOOLS_CI_IDENTITY_MISMATCH")
    require(git("branch", "--show-current") == "main", "TOOLS_BRANCH_MISMATCH")
    require(git("rev-parse", "HEAD") == approval["tools_commit"]
            and git("rev-parse", "HEAD^{tree}") == approval["tools_tree"]
            and git("rev-parse", "HEAD^1") == approval["tools_first_parent"], "TOOLS_IDENTITY_MISMATCH")
    require(not git("status", "--porcelain=v1", "--untracked-files=no"), "TOOLS_TRACKED_WORKTREE_DIRTY")
    require(git("remote", "get-url", "origin") in {
        "https://github.com/Finanzaagevolaimpresa/CRM.git", "git@github.com:Finanzaagevolaimpresa/CRM.git",
    }, "TOOLS_ORIGIN_MISMATCH")
    require(git("ls-remote", "origin", "refs/heads/main").split()[0] == approval["tools_commit"],
            "REMOTE_TOOLS_MAIN_MISMATCH")
    require(git("rev-parse", approval["image_source_commit"] + "^{tree}") == approval["image_source_tree"],
            "IMAGE_SOURCE_TREE_MISMATCH")
    git("merge-base", "--is-ancestor", approval["image_source_commit"], approval["tools_commit"])
    require(re.fullmatch(r"fai-crm:pr[0-9]+-" + approval["image_source_commit"][:12], approval["image"]),
            "IMAGE_TAG_SOURCE_MISMATCH")
    # An old image is allowed ONLY when all its functional inputs are unchanged.
    # Deployment code has its own reviewed commit; no generic release exception.
    protected = ["src", "prisma", "public", "package.json", "package-lock.json", "Dockerfile.prod.example",
                 "next.config.ts", "next-env.d.ts", "postcss.config.js", "tailwind.config.ts", "tsconfig.json"]
    require(not git("diff", "--name-only", approval["image_source_commit"], approval["tools_commit"], "--", *protected),
            "FUNCTIONAL_SOURCE_DELTA_DENIED")
    script_delta = git("diff", "--name-only", approval["image_source_commit"], approval["tools_commit"], "--", "scripts")
    require(all(path.startswith(("scripts/n05/", "scripts/vnx03/"))
                or path in {"scripts/backup-docker-prod.sh", "scripts/smoke-docker-prod.sh"}
                for path in script_delta.splitlines()), "APPLICATION_SCRIPT_DELTA_DENIED")
    require(len(git("ls-tree", "-d", "--name-only", "HEAD:prisma/migrations").splitlines()) == 43,
            "MIGRATION_COUNT_MISMATCH")


def recovery_gate(approval):
    root = Path(approval["recovery_directory"])
    s = trusted_path(root, directory=True)
    require(stat.S_IMODE(s.st_mode) == 0o700, "RECOVERY_DIRECTORY_PERMISSIONS")
    manifest = root / "SHA256SUMS"
    s = trusted_path(manifest)
    require(stat.S_IMODE(s.st_mode) == 0o600
            and file_digest(manifest) == approval["recovery_manifest_sha256"], "RECOVERY_MANIFEST_MISMATCH")
    rows = manifest.read_text().splitlines()
    require(len(rows) == 2, "RECOVERY_COVERAGE_INCOMPLETE")
    entries = {}
    for row in rows:
        match = re.fullmatch(r"([0-9a-f]{64})  (configuration\.encrypted|cryptographic-material\.encrypted)", row)
        require(match and match[2] not in entries, "RECOVERY_INVENTORY_INVALID")
        entries[match[2]] = match[1]
    require(set(entries) == {"configuration.encrypted", "cryptographic-material.encrypted"}, "RECOVERY_COVERAGE_INCOMPLETE")
    for name, expected in entries.items():
        artifact = root / name
        s = trusted_path(artifact)
        require(stat.S_IMODE(s.st_mode) == 0o600 and s.st_size > 0
                and file_digest(artifact) == expected, "RECOVERY_ARTIFACT_INVALID")
    require(os.environ.get("N05_RECOVERY_RESTORE_VERIFIED") == "CONFIGURATION_AND_KEYS_RESTORE_VERIFIED",
            "RECOVERY_RESTORE_ATTESTATION_MISSING")


def production(action, approval_path):
    require(action in {"preflight", "enable", "restore"}, "ACTION_INVALID")
    require(os.environ.get("N05_KEY_MOUNTS_OPERATION") == "FAI_CRM_N05_SAME_IMAGE_KEYS_V1", "EXPLICIT_MODE_REQUIRED")
    require(sys.platform == "linux" and REPO == Path("/opt/fai-crm")
            and socket.gethostname() == "fai-crm-prod-02", "PRODUCTION_HOST_IDENTITY_MISMATCH")
    import pwd
    require(pwd.getpwuid(os.getuid()).pw_name == "faiadmin", "PRODUCTION_HOST_IDENTITY_MISMATCH")
    require(not any(os.environ.get(k) for k in ("DOCKER_HOST", "DOCKER_CONTEXT", "COMPOSE_PROFILES",
                                               "COMPOSE_ENV_FILES", "COMPOSE_FILE")), "AMBIENT_DOCKER_COMPOSE_OVERRIDE")
    require(os.environ.get("CONFIRM_LEGACY_RESOURCE_IDENTITY") == "FAI_CRM_N05_LEGACY_RESOURCE_BRIDGE_V1",
            "LEGACY_RESOURCE_BRIDGE_CONFIRMATION_MISMATCH")
    require(os.environ.get("INCOMPATIBLE_PR_COUNT") == "0", "INCOMPATIBLE_PR_PRESENT")
    s = trusted_path(Path(approval_path))
    require(stat.S_IMODE(s.st_mode) == 0o600, "APPROVAL_FILE_PERMISSIONS")
    approval = load_json(approval_path)
    validate_tools(approval)
    env_file = REPO / ".env.production"
    s = trusted_path(env_file)
    require(stat.S_IMODE(s.st_mode) == 0o600, "PRODUCTION_ENV_PERMISSIONS")
    fixed = [REPO / "docker-compose.prod.example.yml", REPO / "docker-compose.prod.legacy-resources.yml"]
    overlay = REPO / "docker-compose.prod.key-mounts.yml"
    for file in fixed + [overlay, REPO / "scripts/n05/lib.sh", REPO / "scripts/n05/verify-backup-manifest.sh"]:
        trusted_path(file)
        require(git("ls-files", "--error-unmatch", str(file)), "TOOLS_FILE_NOT_TRACKED")
    docker_env = {k: os.environ[k] for k in ("PATH", "HOME") if k in os.environ}
    docker_env.update({
        "APP_ENV_FILE": str(env_file), "APP_IMAGE": approval["image"],
        "SOURCE_COMMIT": approval["image_source_commit"], "SOURCE_TREE": approval["image_source_tree"],
        "POSTGRES_IMAGE": approval["postgres_image"], "COMPOSE_PROJECT_NAME": "fai-crm",
    })
    docker = Docker(environment=docker_env)
    version = docker.run("compose", "version", "--short").strip().lstrip("v")
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)", version)
    require(match and tuple(map(int, match.groups())) >= (2, 24, 4), "COMPOSE_OVERRIDE_UNSUPPORTED")
    info = json.loads(docker.run("info", "--format", "{{json .}}"))
    require(info["Name"] == "fai-crm-prod-02" and info["OSType"] == "linux"
            and not any("rootless" in x or "userns" in x for x in info["SecurityOptions"]),
            "DOCKER_DAEMON_IDENTITY_MISMATCH")
    ordinary = docker.model("fai-crm", REPO, fixed, env_file=env_file)
    mounted = docker.model("fai-crm", REPO, fixed + [overlay], env_file=env_file)
    validate_pair(ordinary, mounted, "fai-crm", PRODUCTION_KEY_ROOT)
    current_id = app_id(docker, "fai-crm")
    app = docker.inspect(current_id)
    image = docker.inspect(approval["image"], "image")
    validate_provenance(image, app, approval)
    require(action == "restore" or (app["State"]["Running"]
            and app["State"].get("Health", {}).get("Status") == "healthy"), "CURRENT_APP_NOT_HEALTHY")
    require(app["State"]["Status"] in {"running", "exited"}, "CURRENT_APP_STATE_INVALID")
    # A failed/stopped app can be restored with its already approved UID/GID,
    # exact immutable image and unchanged Config.User. Never invent a new user.
    uid, gid = approval["app_uid"], approval["app_gid"]
    if app["State"]["Running"]:
        uid = int(docker.run("exec", current_id, "id", "-u").strip())
        gid = int(docker.run("exec", current_id, "id", "-g").strip())
    require(uid == approval["app_uid"] and gid == approval["app_gid"] and uid > 0 and gid > 0,
            "APP_UID_GID_MISMATCH")
    current_enabled = any(m["Destination"] == "/run/secrets/n12-keyring.json" for m in app["Mounts"])
    validate_runtime(app, image, mounted if current_enabled else ordinary, "fai-crm", PRODUCTION_KEY_ROOT, current_enabled)
    require(action == "preflight" or current_enabled == (action == "restore"), "CURRENT_CONFIGURATION_STATE_MISMATCH")
    postgres_ids = docker.run("ps", "-aq", "--no-trunc", "--filter", "label=com.docker.compose.project=fai-crm",
                              "--filter", "label=com.docker.compose.service=postgres").split()
    require(len(postgres_ids) == 1, "POSTGRES_COUNT_INVALID")
    postgres_id = postgres_ids[0]
    guard_env = docker.env | {
        "FAI_ENVIRONMENT": "production", "FAI_ENVIRONMENT_SENTINEL": "FAI_CRM_PRODUCTION_V1",
        "COMPOSE_PROJECT_NAME": "fai-crm", "COMPOSE_FILE": str(fixed[0]),
        "ENV_FILE": str(env_file), "APP_ORIGIN": "https://desk.finanzaagevolaimpresa.it",
        "APP_IMAGE": approval["image"], "EXPECTED_APP_IMAGE_ID": approval["image_id"],
        "POSTGRES_IMAGE": approval["postgres_image"], "BACKUP_RESOURCE_PROVENANCE": "authorized-legacy-compose-identity",
        "CONFIRM_LEGACY_RESOURCE_IDENTITY": os.environ["CONFIRM_LEGACY_RESOURCE_IDENTITY"], "N05_POSTGRES_ID": postgres_id,
        "DOCKER_HOST": "unix:///var/run/docker.sock",
        "N05_CURRENT_APP_STATE": "running" if app["State"]["Running"] else "quiesced",
    }
    command(["bash", "-c", 'set -Eeuo pipefail; '
             'docker() { command docker --host unix:///var/run/docker.sock "$@"; }; '
             'source /opt/fai-crm/scripts/n05/lib.sh; '
             'n05_assert_environment_identity production; '
             'n05_assert_authorized_legacy_compose_resources "$N05_POSTGRES_ID" "$N05_CURRENT_APP_STATE"'], guard_env)
    source_inventory = validate_key_sources(PRODUCTION_KEY_ROOT, uid, gid) if action != "restore" else None
    ordinary_digest, mounted_digest = digest(ordinary), digest(mounted)
    if action == "preflight":
        print("N05_KEYS_PREFLIGHT_PASS|mutation=none|ordinary=" + ordinary_digest + "|mounted=" + mounted_digest)
        return
    require(approval["ordinary_config_sha256"] == ordinary_digest
            and approval["mounted_config_sha256"] == mounted_digest, "APPROVED_COMPOSE_DIGEST_MISMATCH")
    require(os.environ.get("CONFIRM_N05_SAME_IMAGE_RECREATE") == "FAI_CRM_N05_RECREATE_APP_ONLY_V1",
            "APP_RECREATE_CONFIRMATION_MISSING")
    recovery_gate(approval)
    backup = Path(approval["backup_set"])
    trusted_path(backup, directory=True)
    verify_env = guard_env | {
        "EXPECTED_ENVIRONMENT": "production", "EXPECTED_PROJECT": "fai-crm",
        "EXPECTED_SOURCE_COMMIT": approval["image_source_commit"], "EXPECTED_SOURCE_TREE": approval["image_source_tree"],
        "EXPECTED_APP_IMAGE_ID": approval["image_id"], "EXPECTED_IMAGE_PROVENANCE": "oci-labels",
        "EXPECTED_RESOURCE_PROVENANCE": "authorized-legacy-compose-identity", "EXPECTED_MIGRATION_COUNT": "43",
    }
    command(["bash", str(REPO / "scripts/n05/verify-backup-manifest.sh"), str(backup)], verify_env)
    created_line = next(line for line in (backup / "MANIFEST.txt").read_text().splitlines() if line.startswith("created_at="))
    import datetime
    created = datetime.datetime.strptime(created_line.split("=")[1], "%Y%m%dT%H%M%SZ").replace(tzinfo=datetime.timezone.utc)
    require(0 <= time.time() - created.timestamp() <= 3600, "QUIESCED_BACKUP_OUTSIDE_ONE_HOUR_WINDOW")
    target = mounted if action == "enable" else ordinary
    with tempfile.TemporaryDirectory(prefix="fai-crm-n05-keys-") as private:
        Path(private).chmod(0o700)
        frozen = Path(private) / "compose.json"
        freeze_model(docker, "fai-crm", REPO, target, frozen)
        # Recheck source inode/ownership and all approved input identities at the mutation boundary.
        if action == "enable":
            require(validate_key_sources(PRODUCTION_KEY_ROOT, uid, gid) == source_inventory, "KEY_SOURCE_CHANGED")
        validate_tools(approval)
        validate_provenance(docker.inspect(approval["image"], "image"), docker.inspect(current_id), approval)
        validate_runtime(docker.inspect(current_id), image, mounted if current_enabled else ordinary,
                         "fai-crm", PRODUCTION_KEY_ROOT, current_enabled)
        recreate_app(docker, "fai-crm", REPO, frozen, target, image, approval, PRODUCTION_KEY_ROOT,
                     uid, gid, postgres_id, action == "enable", current_id,
                     mounted if current_enabled else ordinary)
    print("N05_KEYS_RECONFIGURATION_PASS|same_image=true|postgres=unchanged|volumes=unchanged|network=unchanged|gates=closed")


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 3, "USAGE_ACTION_AND_PRIVATE_APPROVAL_REQUIRED")
        production(sys.argv[1], sys.argv[2])
    except (Denied, OSError, ValueError, KeyError, TypeError, StopIteration, subprocess.SubprocessError) as error:
        code = str(error) if isinstance(error, Denied) else "SAFE_CHECK_FAILED"
        print("N05_FAILED|code=" + code, file=sys.stderr)
        sys.exit(1)
