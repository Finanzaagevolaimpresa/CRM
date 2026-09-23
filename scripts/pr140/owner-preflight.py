#!/usr/bin/env python3
"""PR140 owner preflight: read-only remote commands, minimized stdout only."""
import datetime, hashlib, json, os, pathlib, re, shutil, socket, subprocess, sys

EXPECTED_HOST = "fai-crm-prod-02"
EXPECTED_USER = "faiadmin"
PROJECT = "fai-crm"
RELEASE = "/home/faiadmin/.local/share/fai-crm-releases/release-3230764a4406-20260920"
FLAGS = {
    "INTERNAL_SESSION_MODE": ["legacy", "registry"],
    "PRACTICE_READINESS_MODE": ["disabled", "synthetic", "internal"],
    "CONTROLLED_INTAKE_MODE": ["disabled", "synthetic", "internal"],
    "INTERNAL_ENGAGEMENT_MODE": ["disabled", "controlled"],
    "FEATURE_INTEGRATIONS_ENABLED": ["false", "true"],
    "FEATURE_AI_WORKER_ENABLED": ["false", "true"],
    "FEATURE_AI_DISPATCH_ENABLED": ["false", "true"],
    "FEATURE_AI_EGRESS_ENABLED": ["false", "true"],
    "AI_EXTERNAL_PROVIDERS_ENABLED": ["false", "true"],
    "AI_ORCHESTRATOR_WORKER_ENABLED": ["0", "1"],
    "AI_PROVIDER": ["mock"],
    "WEBSITE_LEAD_MODE": ["disabled"],
    "PRIVILEGED_ACCESS_MODE": ["disabled"],
    "VNX01_LEAD_INTAKE_CONSUMER_ENABLED": ["0", "1"],
    "VNX05_LEAD_INTAKE_PILOT_ENABLED": ["0", "1"],
    "N15_SYNTHETIC_SELF_CLAIM_OPT_IN": ["0", "1"],
    "N15_SYNTHETIC_ASSIGNMENT_OPT_IN": ["0", "1"],
}
receipt = {"protocol": "PR140_OWNER_PREFLIGHT_R05", "observedUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
           "readOnly": True, "realKeyAccess": False, "status": "STARTED"}

class CheckFailure(Exception):
    pass

def run(args, code, data=None):
    try:
        result = subprocess.run(args, input=data, text=True, capture_output=True, timeout=35, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise CheckFailure(code) from None
    if result.returncode:
        raise CheckFailure(code)
    return result.stdout.strip()

def inspect(target, expression, image=False):
    command = ["docker", "image" if image else "container", "inspect", "--format", expression, target]
    return run(command, "DOCKER_METADATA_READ_FAILED")

def container(service):
    ids = run(["docker", "ps", "-q", "--filter", "label=com.docker.compose.project=" + PROJECT,
               "--filter", "label=com.docker.compose.service=" + service], "DOCKER_READ_DENIED").splitlines()
    if len(ids) != 1 or not re.fullmatch(r"[0-9a-f]{12,64}", ids[0]):
        raise CheckFailure("EXPECTED_RUNNING_" + service.upper() + "_NOT_UNIQUE")
    target = ids[0]
    meta = json.loads(inspect(target, '{"Running":{{json .State.Running}},"Status":{{json .State.Status}},"Health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}'))
    # Never acquire the health log: application output may contain private data.
    result = {"id": inspect(target, "{{.Id}}"), "image": inspect(target, "{{.Image}}"),
              "running": bool(meta.get("Running")), "status": meta.get("Status"),
              "health": meta.get("Health"),
              "restartCount": int(inspect(target, "{{.RestartCount}}"))}
    image_id = result["image"]
    result["revision"] = inspect(image_id, '{{index .Config.Labels "org.opencontainers.image.revision"}}', True)
    result["tree"] = inspect(image_id, '{{index .Config.Labels "it.finanzaagevolaimpresa.source-tree"}}', True)
    result["repoDigests"] = json.loads(inspect(image_id, "{{json .RepoDigests}}", True)) or []
    mounts = inspect(target, '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}|{{.Destination}}\n{{end}}{{end}}')
    result["volumes"] = [dict(zip(("name", "destination"), row.split("|", 1))) for row in mounts.splitlines()]
    networks = json.loads(inspect(target, "{{json .NetworkSettings.Networks}}"))
    result["networks"] = [{"name": name, "id": network.get("NetworkID")} for name, network in networks.items()]
    return target, result

def main():
    if os.name != "posix":
        raise CheckFailure("TARGET_PLATFORM_MISMATCH")
    import pwd
    receipt["identity"] = {"host": socket.gethostname(), "user": pwd.getpwuid(os.geteuid()).pw_name}
    if receipt["identity"] != {"host": EXPECTED_HOST, "user": EXPECTED_USER}:
        raise CheckFailure("TARGET_IDENTITY_MISMATCH")
    receipt["capabilities"] = {name: bool(shutil.which(name)) for name in ("docker", "git", "sha256sum", "tar", "age", "pg_restore")}
    receipt["dockerServer"] = json.loads(run(["docker", "version", "--format", "{{json .Server}}"], "DOCKER_READ_DENIED"))["Version"]
    receipt["dockerEngineId"] = run(["docker", "info", "--format", "{{.ID}}"], "DOCKER_READ_DENIED")
    app, receipt["app"] = container("app")
    pg, receipt["postgres"] = container("postgres")
    condition = "or " + " ".join('(eq (index (split . "=") 0) "' + key + '")' for key in FLAGS)
    template = "{{range .Config.Env}}{{if " + condition + "}}{{println .}}{{end}}{{end}}"
    selected = inspect(app, template)
    values = dict(line.split("=", 1) for line in selected.splitlines() if "=" in line)
    receipt["flags"] = {key: values[key] if values.get(key) in allowed else
                        None if key not in values else "UNEXPECTED_VALUE_REDACTED" for key, allowed in FLAGS.items()}
    receipt["checkouts"] = []
    for source in (RELEASE, "/opt/fai-crm"):
        item = {"path": source, "exists": pathlib.Path(source).is_dir()}
        if item["exists"]:
            item["head"] = run(["git", "-C", source, "rev-parse", "HEAD"], "GIT_READ_FAILED")
            item["tree"] = run(["git", "-C", source, "rev-parse", "HEAD^{tree}"], "GIT_READ_FAILED")
            item["trackedClean"] = not run(["git", "-C", source, "status", "--porcelain=v1", "--untracked-files=no"], "GIT_READ_FAILED")
            folder = pathlib.Path(source) / "prisma" / "migrations"
            item["migrationFiles"] = [{"name": file.parent.name, "sha256": hashlib.sha256(file.read_bytes()).hexdigest()}
                                      for file in sorted(folder.glob("*/migration.sql"))]
        receipt["checkouts"].append(item)
    sql = """BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout='10s';
SELECT json_build_object(
 'ledger', (SELECT json_agg(r ORDER BY r.migration_name) FROM
  (SELECT migration_name, checksum, finished_at IS NOT NULL AS finished,
   rolled_back_at IS NOT NULL AS rolled_back FROM "_prisma_migrations") r),
 'liveRegistrySessions', (SELECT count(*) FROM "InternalSession" WHERE "revokedAt" IS NULL AND "expiresAt">CURRENT_TIMESTAMP),
 'registrySessionsTotal', (SELECT count(*) FROM "InternalSession"),
 'catalogRevisionCounts', (SELECT json_agg(r) FROM (SELECT version,status,count(*) FROM "ServiceCatalogRevision" GROUP BY version,status ORDER BY version,status) r),
 'migration47Present', to_regclass('public."EngagementDossierVersion"') IS NOT NULL,
 'otherActiveSessions', (SELECT count(*) FROM pg_stat_activity WHERE datname=CURRENT_DATABASE() AND pid<>pg_backend_pid() AND state='active'));
ROLLBACK;
"""
    # DB identity variables are expanded only inside PostgreSQL's container.
    # No password/environment dump, user rows, cookies, customer data or documents.
    query = run(["docker", "exec", "-i", pg, "sh", "-c",
                 'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],
                "READ_ONLY_DATABASE_PREFLIGHT_FAILED", sql)
    receipt["database"] = json.loads(query)
    capacity = os.statvfs(RELEASE)
    receipt["releaseFilesystemAvailableBytes"] = capacity.f_bavail * capacity.f_frsize
    receipt["backup46"] = {"verified": False, "reason": "No backup content is read or created by this preflight."}
    receipt["status"] = "READ_ONLY_PREFLIGHT_COMPLETE"

if __name__ == "__main__":
    try:
        main()
    except CheckFailure as error:
        receipt["status"] = "STOP"
        receipt["code"] = str(error)
    except Exception:
        receipt["status"] = "STOP"
        receipt["code"] = "UNEXPECTED_PREFLIGHT_FAILURE_REDACTED"
    print(json.dumps(receipt, sort_keys=True))
    sys.exit(0 if receipt["status"] == "READ_ONLY_PREFLIGHT_COMPLETE" else 2)
