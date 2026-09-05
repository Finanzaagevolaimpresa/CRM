"""Isolated Docker qualification of the actual N05 freeze/recreate primitives."""
import base64
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("n05_keys", ROOT / "scripts/n05/key_mounts.py")
n05 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(n05)


def main():
    n05.require(os.environ.get("N05_SYNTHETIC_KEYS_CONFIRMED") == "1", "SYNTHETIC_CONFIRMATION_REQUIRED")
    image_tag = os.environ["N05_SYNTHETIC_APP_IMAGE"]
    n05.require(image_tag.startswith("fai-crm:n05-keys-"), "SYNTHETIC_IMAGE_REQUIRED")
    project = "fai-crm-vnx04-keys-" + uuid.uuid4().hex[:12]
    docker = n05.Docker(command=["docker"])
    image = docker.inspect(image_tag, "image")
    labels = image["Config"]["Labels"]
    approval = {
        "image": image_tag, "image_id": image["Id"],
        "image_source_commit": labels["org.opencontainers.image.revision"],
        "image_source_tree": labels["it.finanzaagevolaimpresa.source-tree"],
    }
    created = False
    private = tempfile.TemporaryDirectory(prefix=".vnx04-keys-drill-", dir=Path.home())
    root = Path(private.name)
    try:
        for args in (("ps", "-aq"), ("volume", "ls", "-q"), ("network", "ls", "-q")):
            n05.require(not docker.run(*args, "--filter", f"label=com.docker.compose.project={project}").strip(),
                        "SYNTHETIC_PROJECT_NOT_EMPTY")
        env = root / "synthetic.env"
        env.write_text("\n".join([
            "POSTGRES_DB=vnx04_keys", "POSTGRES_USER=vnx04_keys", "POSTGRES_PASSWORD=synthetic-only",
            "DATABASE_URL=postgresql://vnx04_keys:synthetic-only@postgres:5432/vnx04_keys?schema=public",
            "AUTH_SECRET=vnx04-synthetic-only-authentication-secret", "APP_ORIGIN=http://app:3000",
            "SECURE_LEAD_GATEWAY_MODE=disabled", "FEATURE_INTEGRATIONS_ENABLED=false",
            "VNX01_LEAD_INTAKE_CONSUMER_ENABLED=0", "FEATURE_AI_WORKER_ENABLED=false",
            "FEATURE_AI_DISPATCH_ENABLED=false", "FEATURE_AI_EGRESS_ENABLED=false",
            "AI_EXTERNAL_PROVIDERS_ENABLED=false", "AI_ORCHESTRATOR_WORKER_ENABLED=0",
            "SECURE_LEAD_GATEWAY_KEYRING_FILE=", "LEAD_IDENTITY_KEY_FILE=",
            "INTERNAL_SESSION_MODE=legacy", "PRIVILEGED_ACCESS_MODE=disabled",
            "WEBSITE_LEAD_MODE=disabled", "COMMERCIAL_LEAD_INBOX_MODE=disabled",
        ]) + "\n")
        env.chmod(0o600)
        # First qualify the REAL, fixed production overlay with real Compose.
        # config never starts anything. All environment values are synthetic.
        docker.env.update({
            "APP_ENV_FILE": str(env), "APP_IMAGE": image_tag, "COMPOSE_PROJECT_NAME": "fai-crm",
            "SOURCE_COMMIT": approval["image_source_commit"], "SOURCE_TREE": approval["image_source_tree"],
            "POSTGRES_IMAGE": "postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685",
        })
        fixed = [ROOT / "docker-compose.prod.example.yml", ROOT / "docker-compose.prod.legacy-resources.yml"]
        plain_prod = json.loads(docker.compose("fai-crm", ROOT, fixed, "config", "--format", "json", env_file=env))
        keys_prod = json.loads(docker.compose("fai-crm", ROOT, fixed + [ROOT / "docker-compose.prod.key-mounts.yml"],
                                             "config", "--format", "json", env_file=env))
        print("N05_SYNTHETIC_COMPOSE_VERSION|" + docker.run("compose", "version", "--short").strip(), flush=True)
        # Only fixed public mount metadata; never effective environment values.
        print("N05_SYNTHETIC_MOUNT_MODEL|" + json.dumps(keys_prod["services"]["app"]["volumes"], sort_keys=True), flush=True)
        n05.validate_pair(plain_prod, keys_prod, "fai-crm", n05.PRODUCTION_KEY_ROOT)
        print("N05_SYNTHETIC_PRODUCTION_MODEL_PASS", flush=True)
        n05.require(not n05.PRODUCTION_KEY_ROOT.exists(), "SYNTHETIC_RUNNER_CONTAINS_PRODUCTION_KEY_ROOT")
        # Distinct fixture identity. Never weaken or invoke the production guard
        # against this stack. Only identity/ports/host sources are substituted.
        plain = copy.deepcopy(plain_prod)
        plain["name"] = project
        for key, value in plain["volumes"].items():
            value["name"] = project + "_" + key
        plain["networks"]["default"]["name"] = project + "_default"
        for service in plain["services"].values():
            service["labels"] = {
                "it.finanzaagevolaimpresa.environment": "vnx04-synthetic",
                "it.finanzaagevolaimpresa.sentinel": "FAI_CRM_VNX04_SYNTHETIC_KEYS_V1",
            }
        app = plain["services"]["app"]
        app["environment"].update({
            "APP_ENV": "test", "FAI_ENVIRONMENT": "vnx04-synthetic",
            "FAI_ENVIRONMENT_SENTINEL": "FAI_CRM_VNX04_SYNTHETIC_KEYS_V1",
            "N05_SYNTHETIC_LITERAL_CANARY": "value-$${MUST_NOT_INTERPOLATE}-$$literal",
        })
        app.pop("ports", None)
        app["healthcheck"]["test"] = ["CMD", "node", "-e",
            "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
        app["healthcheck"].update(interval="2s", timeout="2s", retries=30, start_period="2s")
        plain["services"]["postgres"]["healthcheck"].update(interval="2s", timeout="2s", retries=30)
        initial = copy.deepcopy(plain)
        initial["volumes"] = {name: {"name": project + "_" + name} for name in plain["volumes"]}
        initial["networks"]["default"].pop("external")
        initial_file = root / "initial.json"
        n05.freeze_model(docker, project, ROOT, initial, initial_file)
        print("N05_SYNTHETIC_INITIAL_FREEZE_PASS", flush=True)
        created = True
        docker.compose(project, ROOT, [initial_file], "up", "-d", "--no-build", "--pull", "never")
        current_id = n05.app_id(docker, project)
        for _ in range(120):
            state = docker.inspect(current_id)["State"]
            if state.get("Health", {}).get("Status") == "healthy":
                break
            time.sleep(1)
        n05.require(state.get("Health", {}).get("Status") == "healthy", "SYNTHETIC_APP_NOT_HEALTHY")
        uid, gid = (int(docker.run("exec", current_id, "id", option).strip()) for option in ("-u", "-g"))
        n05.validate_provenance(image, docker.inspect(current_id), approval)
        n05.validate_runtime(docker.inspect(current_id), image, plain, project, root / "keys", False)
        # Ordinary stack is now healthy with no key directory.
        n05.require(not (root / "keys").exists(), "ORDINARY_MODE_REQUIRES_KEYS")
        postgres_id = docker.run("ps", "-q", "--no-trunc", "--filter", f"label=com.docker.compose.project={project}",
                                 "--filter", "label=com.docker.compose.service=postgres").strip()
        sql_args = ("exec", "-i", postgres_id, "psql", "-X", "-v", "ON_ERROR_STOP=1",
                    "-U", "vnx04_keys", "-d", "vnx04_keys", "-At")
        docker.run(*sql_args, input_text="CREATE TABLE n05_keys_sentinel(id text PRIMARY KEY); "
                                         "INSERT INTO n05_keys_sentinel VALUES ('synthetic-persisted-row');")
        docker.run("exec", current_id, "node", "-e",
                   "require('fs').writeFileSync('/var/lib/fai-crm/documents/vnx04-synthetic.txt','synthetic-persisted-document')")
        snapshot = n05.persistent_snapshot(docker, project, postgres_id)
        keys = root / "keys"
        keys.mkdir(mode=0o700)
        secret = base64.b64encode(bytes(range(32))).decode()
        materials = {
            "n12-keyring.json": {"version": 1, "keys": [{"keyId": "vnx04-synthetic-only", "secretBase64": secret}]},
            "n13-identity.json": {"version": 1, "secretBase64": secret},
        }
        for name, value in materials.items():
            file = keys / name
            file.write_text(json.dumps(value))
            file.chmod(0o400)
            if file.stat().st_uid != uid or file.stat().st_gid != gid:
                n05.command(["sudo", "-n", "chown", f"{uid}:{gid}", str(file)])
        n05.validate_key_sources(keys, uid, gid)
        enabled = copy.deepcopy(plain)
        for key, (name, target) in n05.KEYS.items():
            enabled["services"]["app"]["environment"][key] = target
            enabled["services"]["app"]["volumes"].append({
                "type": "bind", "source": str(keys / name), "target": target,
                "read_only": True, "bind": {"create_host_path": False},
            })
        n05.validate_pair(plain, enabled, project, keys)
        mounted_file = root / "mounted.json"
        ordinary_file = root / "ordinary.json"
        n05.freeze_model(docker, project, ROOT, enabled, mounted_file)
        n05.freeze_model(docker, project, ROOT, plain, ordinary_file)
        # Wrong image/source/configuration must fail before a new app is created.
        bad = approval | {"image_source_tree": "0" * 40}
        for candidate in (bad, approval | {"image_id": "sha256:" + "0" * 64}):
            try:
                n05.recreate_app(docker, project, ROOT, mounted_file, enabled, image, candidate, keys,
                                  uid, gid, postgres_id, True, current_id, plain)
                raise RuntimeError("INCOHERENT_PROVENANCE_ACCEPTED")
            except n05.Denied:
                n05.require(n05.app_id(docker, project) == current_id, "NEGATIVE_TEST_MUTATED_APP")
        tampered = copy.deepcopy(enabled)
        tampered["services"]["app"]["volumes"][-1]["read_only"] = False
        n05.freeze_model(docker, project, ROOT, tampered, mounted_file)
        try:
            n05.recreate_app(docker, project, ROOT, mounted_file, enabled, image, approval, keys,
                              uid, gid, postgres_id, True, current_id, plain)
            raise RuntimeError("TAMPERED_CONFIG_ACCEPTED")
        except n05.Denied:
            n05.require(n05.app_id(docker, project) == current_id, "NEGATIVE_TEST_MUTATED_APP")
        n05.freeze_model(docker, project, ROOT, enabled, mounted_file)
        enabled_id = n05.recreate_app(docker, project, ROOT, mounted_file, enabled, image, approval, keys,
                                      uid, gid, postgres_id, True, current_id, plain)
        # Restoration must also work after the mounted app stops, with a source
        # unavailable at its old path. Retain material; no ledger/data rollback.
        docker.run("stop", enabled_id)
        (keys / "n12-keyring.json").rename(keys / "n12-retained.json")
        restored_id = n05.recreate_app(docker, project, ROOT, ordinary_file, plain, image, approval, keys,
                                       uid, gid, postgres_id, False, enabled_id, enabled)
        n05.require(n05.persistent_snapshot(docker, project, postgres_id) == snapshot, "SYNTHETIC_RESOURCES_CHANGED")
        n05.require(docker.run(*sql_args, input_text="SELECT id FROM n05_keys_sentinel;").strip()
                    == "synthetic-persisted-row", "SYNTHETIC_DATABASE_CONTENT_CHANGED")
        n05.require(docker.run("exec", restored_id, "node", "-e",
                    "process.stdout.write(require('fs').readFileSync('/var/lib/fai-crm/documents/vnx04-synthetic.txt'))")
                    == "synthetic-persisted-document", "SYNTHETIC_DOCUMENT_CONTENT_CHANGED")
        (keys / "n12-retained.json").rename(keys / "n12-keyring.json")
        n05.validate_key_sources(keys, uid, gid)  # rollback retains cryptographic material
        print("N05_SYNTHETIC_KEYS_PASS|ordinary_without_keys=true|parsers=existing|write=denied|recreate=true|restore=true|same_image=true|data=preserved")
    finally:
        if created:
            # Only this collision-checked random project; never down -v or prune.
            for resource in docker.run("ps", "-aq", "--filter", f"label=com.docker.compose.project={project}").split():
                docker.run("rm", "-f", resource)
            for resource in docker.run("network", "ls", "-q", "--filter", f"label=com.docker.compose.project={project}").split():
                docker.run("network", "rm", resource)
            for resource in docker.run("volume", "ls", "-q", "--filter", f"label=com.docker.compose.project={project}").split():
                docker.run("volume", "rm", resource)
            for args in (("ps", "-aq"), ("volume", "ls", "-q"), ("network", "ls", "-q")):
                n05.require(not docker.run(*args, "--filter", f"label=com.docker.compose.project={project}").strip(),
                            "SYNTHETIC_CLEANUP_INCOMPLETE")
        private.cleanup()
        print("N05_SYNTHETIC_KEYS_CLEANUP_PASS")


if __name__ == "__main__":
    try:
        main()
    except (n05.Denied, OSError, KeyError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        # Never expose subprocess output, configuration values or key material.
        code = str(error) if isinstance(error, n05.Denied) else "SYNTHETIC_CHECK_FAILED"
        raise SystemExit("N05_FAILED|code=" + code)
