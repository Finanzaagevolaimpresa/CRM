"""Sealed, read-only M1 admission observation. No CLI or request parameters.

The reviewed Windows executable embeds this source and the exact target binding.
Nothing here starts a backup, changes a container, provisions a key or writes DB.
Application secret comparison stays inside the VPS; only booleans leave it.
"""
import datetime
import hashlib
import hmac
import json
import os
import pathlib
import re
import signal
import socket
import subprocess
import time

PROTOCOL = "FAI_M1_ADMISSION_OBSERVATION_R18"
SOURCE = "3230764a4406182e50d22236bb7e701d0f1b5656"
TREE = "e25e66e081d92ecf61f8b1422aed456f12128d39"
CANDIDATE = "fb645e014653ee87dc64f2439970967192f91b62"
RUNTIME = "/home/faiadmin/.local/share/fai-crm-releases/release-3230764a4406-20260920"
DOCKER = ["/usr/bin/docker", "--host", "unix:///var/run/docker.sock"]
SAFE_ENV = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C", "HOME": "/home/faiadmin"}
FLAGS = {
    "FEATURE_INTEGRATIONS_ENABLED": "false", "FEATURE_AI_WORKER_ENABLED": "false",
    "FEATURE_AI_DISPATCH_ENABLED": "false", "FEATURE_AI_EGRESS_ENABLED": "false",
    "AI_EXTERNAL_PROVIDERS_ENABLED": "false", "AI_ORCHESTRATOR_WORKER_ENABLED": "0",
    "AI_PROVIDER": "mock", "WEBSITE_LEAD_MODE": "disabled",
}
NODE_METADATA = r"""
const c=require('node:crypto');
const e=process.env,v=e.PRIVILEGED_STEP_UP_KEY_VERSION,s=e.PRIVILEGED_STEP_UP_SECRET;
const flags=Object.fromEntries(%s.map(k=>[k,e[k]??null]));
console.log(JSON.stringify({version:/^[1-9][0-9]{0,8}$/.test(v||'')?Number(v):null,
configured:typeof s==='string'&&s.length>=32,
digest:typeof s==='string'&&s.length>=32?c.createHash('sha256').update(s).digest('hex'):null,
flags}));
""" % json.dumps(list(FLAGS) + [
    "VNX01_LEAD_INTAKE_CONSUMER_ENABLED", "VNX05_LEAD_INTAKE_PILOT_ENABLED",
    "N15_SYNTHETIC_SELF_CLAIM_OPT_IN", "N15_SYNTHETIC_ASSIGNMENT_OPT_IN",
    "INTERNAL_SESSION_MODE", "PRIVILEGED_ACCESS_MODE", "INTERNAL_ENGAGEMENT_MODE",
    "CONTROLLED_INTAKE_MODE", "PRACTICE_READINESS_MODE",
])
SQL = '''BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='8s';
SET LOCAL lock_timeout='2s';
SELECT json_build_object(
 'database',CURRENT_DATABASE(),
 'ledger',(SELECT json_agg(r ORDER BY r.migration_name) FROM
   (SELECT migration_name,checksum,finished_at IS NOT NULL AS finished,
     rolled_back_at IS NOT NULL AS rolled_back,applied_steps_count AS steps
    FROM "_prisma_migrations") r),
 'keys',(SELECT coalesce(json_agg(r), '[]'::json) FROM
   (SELECT version,status,"activatedAt" IS NOT NULL AS activated,
     "retiredAt" IS NOT NULL AS retired,encode("keyDigest",'hex') AS digest
    FROM "ApplicationKeyVersion" WHERE purpose='PRIVILEGED_STEP_UP') r),
 'liveSessions',(SELECT count(*) FROM "InternalSession"
   WHERE "revokedAt" IS NULL AND "expiresAt">CURRENT_TIMESTAMP),
 'otherActiveSessions',(SELECT count(*) FROM pg_stat_activity
   WHERE datname=CURRENT_DATABASE() AND pid<>pg_backend_pid() AND state='active'));
ROLLBACK;
'''
CONTAINER_FORMAT = ('{"id":{{json .Id}},"image":{{json .Image}},'
    '"running":{{json .State.Running}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},'
    '"startedAt":{{json .State.StartedAt}},"restarts":{{json .RestartCount}},'
    '"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
    '"service":{{json (index .Config.Labels "com.docker.compose.service")}},'
    '"mounts":[{{range $i,$m := .Mounts}}{{if $i}},{{end}}'
    '{"type":{{json $m.Type}},"name":{{json $m.Name}},"destination":{{json $m.Destination}}}{{end}}],'
    '"networks":{{json .NetworkSettings.Networks}}}')


class Stop(Exception):
    pass


def need(value, code):
    if not value:
        raise Stop(code)


def strict_json(raw):
    def unique(pairs):
        out = {}
        for key, value in pairs:
            need(key not in out, "DUPLICATE_JSON_KEY")
            out[key] = value
        return out
    return json.loads(raw, object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(Stop("INVALID_JSON_NUMBER")))


def validate_binding(b):
    need(isinstance(b, dict) and set(b) == {
        "candidate", "engineId", "appId", "appImage", "postgresId", "postgresImage", "networkId", "ledger"
    }, "BINDING_FIELDS")
    need(b["candidate"] == CANDIDATE, "CANDIDATE_BINDING")
    need(re.fullmatch(r"[0-9a-f-]{36}", b["engineId"] or ""), "ENGINE_BINDING")
    for key in ("appId", "postgresId", "networkId"):
        need(re.fullmatch(r"[0-9a-f]{64}", b[key] or ""), "RESOURCE_BINDING")
    need(b["appId"] != b["postgresId"], "RESOURCE_COLLISION")
    for key in ("appImage", "postgresImage"):
        need(re.fullmatch(r"sha256:[0-9a-f]{64}", b[key] or ""), "IMAGE_BINDING")
    need(isinstance(b["ledger"], dict) and len(b["ledger"]) == 46, "LEDGER_BINDING")
    need(all(re.fullmatch(r"[0-9]{14}_[a-z0-9_]+", k) and re.fullmatch(r"[0-9a-f]{64}", v)
             for k, v in b["ledger"].items()), "LEDGER_BINDING")


def ledger_matches(rows, inventory):
    return (isinstance(rows, list) and len(rows) == 46
            and all(set(r) == {"migration_name", "checksum", "finished", "rolled_back", "steps"}
                    and r["finished"] is True and r["rolled_back"] is False
                    and type(r["steps"]) is int and r["steps"] == 1 for r in rows)
            and len({r["migration_name"] for r in rows}) == 46
            and {r["migration_name"]: r["checksum"] for r in rows} == inventory)


def step_up_metadata(local, keys):
    version = local["version"]
    need(version is None or type(version) is int and 0 < version < 1000000000, "KEY_METADATA_INVALID")
    need(type(local["configured"]) is bool and isinstance(keys, list), "KEY_METADATA_INVALID")
    active = [k for k in keys if k["status"] == "ACTIVE" and k["activated"] and not k["retired"]]
    matching = [k for k in active if k["version"] == version]
    digest = local["digest"]
    match = bool(local["configured"] and len(matching) == 1 and isinstance(digest, str)
                 and re.fullmatch(r"[a-f0-9]{64}", digest)
                 and hmac.compare_digest(digest, matching[0]["digest"]))
    return {"stepUpVersion": version, "stepUpSecretConfigured": local["configured"],
            "stepUpActiveCount": len(active), "stepUpRegisteredActive": len(matching) == 1,
            "stepUpDigestMatches": match}


class Observer:
    def __init__(self, binding):
        validate_binding(binding)
        self.b = binding
        self.started = time.monotonic()

    def run(self, argv, code, data=None):
        timeout = min(15, 110 - (time.monotonic() - self.started))
        need(timeout > 0, "OBSERVATION_DEADLINE")
        try:
            result = subprocess.run(argv, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    env=SAFE_ENV, timeout=timeout, check=False)
        except subprocess.TimeoutExpired:
            raise Stop("COMMAND_TIMEOUT_" + code) from None
        except OSError:
            raise Stop("COMMAND_UNAVAILABLE_" + code) from None
        need(result.returncode == 0, "COMMAND_FAILED_" + code)
        need(len(result.stdout) <= 131072, "OUTPUT_LIMIT_" + code)
        return result.stdout.decode("utf-8").strip()

    def docker(self, *args, code="DOCKER", data=None):
        return self.run(DOCKER + list(args), code, data)

    def container(self, role):
        cid = self.b[role + "Id"]
        x = strict_json(self.docker("container", "inspect", "--format", CONTAINER_FORMAT, cid))
        need(x["id"] == cid and x["image"] == self.b[role + "Image"], "CONTAINER_IDENTITY_DRIFT")
        need(x["project"] == "fai-crm" and x["service"] == ("postgres" if role == "postgres" else "app"),
             "CONTAINER_ROLE_DRIFT")
        need(x["running"] is True and x["health"] == "healthy", "CONTAINER_NOT_HEALTHY")
        need(set(x["networks"]) == {"fai-crm_default"}
             and x["networks"]["fai-crm_default"]["NetworkID"] == self.b["networkId"], "NETWORK_DRIFT")
        expected = ("fai-crm_postgres_data", "/var/lib/postgresql/data") if role == "postgres" else (
            "fai-crm_crm_documents", "/var/lib/fai-crm/documents")
        need(len(x["mounts"]) == 1 and x["mounts"][0]["type"] == "volume"
             and (x["mounts"][0]["name"], x["mounts"][0]["destination"]) == expected, "VOLUME_DRIFT")
        return x

    def observe(self):
        import pwd
        need(socket.gethostname() == "fai-crm-prod-02" and os.geteuid() == 1000
             and pwd.getpwuid(os.geteuid()).pw_name == "faiadmin", "TARGET_IDENTITY_MISMATCH")
        need(self.docker("info", "--format", "{{.ID}}") == self.b["engineId"], "ENGINE_IDENTITY_DRIFT")
        app, pg = self.container("app"), self.container("postgres")
        git = ["/usr/bin/git", "-C", RUNTIME]
        need(self.run(git + ["rev-parse", "HEAD", "HEAD^{tree}"], "SOURCE_IDENTITY").split() == [SOURCE, TREE],
             "SOURCE_REVISION_DRIFT")
        need(not self.run(git + ["status", "--porcelain=v1", "--untracked-files=no"], "SOURCE_STATUS"),
             "SOURCE_TRACKED_DIRTY")
        labels = self.docker("image", "inspect", "--format",
                            '{{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "it.finanzaagevolaimpresa.source-tree"}}',
                            self.b["appImage"])
        need(labels.split() == [SOURCE, TREE], "SOURCE_IMAGE_PROVENANCE")
        running = self.docker("ps", "-q", "--no-trunc", "--filter", "label=com.docker.compose.project=fai-crm").split()
        need(set(running) == {self.b["appId"], self.b["postgresId"]}, "COMPETING_CONTAINER_PRESENT")
        data = strict_json(self.docker("exec", "-i", self.b["postgresId"], "sh", "-c",
            'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"', code="DATABASE_READ",
            data=SQL.encode()))
        need(data["database"] == "fai_crm", "DATABASE_IDENTITY_DRIFT")
        need(ledger_matches(data["ledger"], self.b["ledger"]), "LEDGER46_DRIFT_OR_INCOMPLETE")
        local = strict_json(self.docker("exec", self.b["appId"], "node", "-e", NODE_METADATA, code="KEY_METADATA"))
        closed = all(str(local["flags"].get(k)).lower() == v for k, v in FLAGS.items())
        closed = closed and all(local["flags"].get(k) in (None, "", "0", "false") for k in (
            "VNX01_LEAD_INTAKE_CONSUMER_ENABLED", "VNX05_LEAD_INTAKE_PILOT_ENABLED",
            "N15_SYNTHETIC_SELF_CLAIM_OPT_IN", "N15_SYNTHETIC_ASSIGNMENT_OPT_IN"))
        need(closed, "EXTERNAL_GATES_NOT_CLOSED")
        session_mode = local["flags"].get("INTERNAL_SESSION_MODE")
        privileged_mode = local["flags"].get("PRIVILEGED_ACCESS_MODE")
        need(session_mode in ("legacy", "registry") and privileged_mode in ("disabled", "enforced"),
             "APPLICATION_ACCESS_MODE_UNEXPECTED")
        after_app, after_pg = self.container("app"), self.container("postgres")
        need(after_app == app and after_pg == pg, "CONTAINER_CHANGED_DURING_OBSERVATION")
        capacity = os.statvfs(RUNTIME)
        result = {"baselineMatches": True, "appHealthy": True, "postgresHealthy": True,
                  "postgresStartedAt": pg["startedAt"], "postgresRestartCount": pg["restarts"],
                  "ledgerCount": 46, "ledgerChecksumsMatch": True, "zeroIncomplete": True,
                  "closedGates": True, "liveSessions": data["liveSessions"],
                  "otherActiveDbSessions": data["otherActiveSessions"],
                  "availableBytes": capacity.f_bavail * capacity.f_frsize,
                  "recipientEvidence": "UNATTESTED", "releaseAdmitted": False}
        result.update(internalSessionMode=session_mode, privilegedAccessMode=privileged_mode)
        result.update(step_up_metadata(local, data["keys"]))
        return result


def main(binding):
    receipt = {"protocol": PROTOCOL, "status": "STOP", "readOnly": True,
               "runtimeMutationPerformed": False, "secretValuesExported": False,
               "agentRealKeyAccess": False, "privateKeyFilesRead": False,
               "candidate": CANDIDATE, "observedUtc": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    def expired(_signum, _frame):
        raise Stop("OBSERVATION_DEADLINE")
    signal.signal(signal.SIGALRM, expired)
    signal.alarm(120)
    try:
        receipt.update(Observer(binding).observe())
        receipt["status"] = "OBSERVATION_COMPLETE"
    except Stop as error:
        code = str(error)
        receipt["code"] = code if re.fullmatch(r"[A-Z0-9_]{1,100}", code) else "OBSERVATION_FAILED"
    except Exception:
        receipt["code"] = "OBSERVATION_FAILED_REDACTED"
    finally:
        signal.alarm(0)
    print(json.dumps(receipt, sort_keys=True, separators=(",", ":")), flush=True)
    return 0 if receipt["status"] == "OBSERVATION_COMPLETE" else 2
