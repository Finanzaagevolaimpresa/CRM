"""CI-only observer of SQL70. The only transport is a read-only psql query.

No production entry point, migrations, writes, retries or leaked connection data.
Evidence contains aggregate hashes, counts and schema metadata, never row contents.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit
import historical_guards as g
import historical_snapshot as s

ROOT = Path(__file__).resolve().parents[3]
SENTINEL = "FAI_CRM_EPHEMERAL_TEST_ONLY_V1"


def connection(env):
    required = {"CI": "true", "GITHUB_ACTIONS": "true", "APP_ENV": "test", "RUN_DB_TESTS": "1",
                "AI_ORCHESTRATOR_DB_TESTS_CONFIRMED": "1", "AI_ORCHESTRATOR_DB_TEST_SENTINEL": SENTINEL}
    g.need(all(env.get(k) == v for k, v in required.items()), "HISTORICAL_ISOLATED_CI_REQUIRED")
    raw = env.get("DATABASE_URL", "")
    try:
        value = urlsplit(raw)
        allowed = value.scheme == "postgresql" and value.hostname == "127.0.0.1" and value.port == 5432
        allowed = allowed and value.username == "postgres" and value.password == "synthetic-n14-history-only"
        allowed = allowed and value.path == "/fai_crm_test" and value.query == "schema=public" and not value.fragment
    except ValueError:
        allowed = False
    g.need(allowed, "HISTORICAL_ISOLATED_CONNECTION_REQUIRED")
    return raw.partition("?")[0]


def query(schema):
    observed = "jsonb_build_object(" + ",".join(s.snapshot_fields(schema)) + ")"
    return """BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='15s';
SET LOCAL lock_timeout='5s';
SELECT jsonb_build_object(
 'targetDatabase',current_database(),'actor',current_user,
 'readOnly',current_setting('transaction_read_only')='on',
 'sentinel',(SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()),
 'ledger',(SELECT jsonb_agg(r ORDER BY migration_name) FROM
  (SELECT migration_name,checksum,finished_at IS NOT NULL AS finished,
   rolled_back_at IS NOT NULL AS rolled_back,applied_steps_count FROM "_prisma_migrations") r),
 'observed',""" + observed + ");\nROLLBACK;\n"


def manifest():
    # This observer qualifies only the frozen 69 -> 70 transition. Newer source
    # migrations are qualified separately; ledger_binding still rejects a live
    # database whose ledger is not exactly the requested historical version.
    return {p.parent.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted((ROOT / "prisma/migrations").glob("*/migration.sql"))
            if p.parent.name <= g.MIGRATION}


def bind(result, schema, source_manifest, raw):
    g.need(isinstance(result, dict) and set(result) == {"targetDatabase", "actor", "readOnly", "sentinel", "ledger", "observed"},
           "HISTORICAL_ISOLATED_RESULT_SHAPE")
    g.need(result["targetDatabase"] == "fai_crm_test" and result["actor"] == "postgres" and result["readOnly"] is True
           and result["sentinel"] == SENTINEL, "HISTORICAL_ISOLATED_DATABASE_IDENTITY")
    return g.bind_snapshot(result["observed"], schema, result["ledger"], source_manifest, raw)


def capture(schema, raw):
    dsn = connection(os.environ)
    try:
        result = subprocess.run(["psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-d", dsn],
                                input=query(schema), capture_output=True, text=True, timeout=25)
    except (OSError, subprocess.TimeoutExpired):
        raise g.Stop("HISTORICAL_ISOLATED_READ_FAILED") from None
    g.need(result.returncode == 0, "HISTORICAL_ISOLATED_READ_FAILED")
    try:
        value = json.loads(result.stdout)
    except (ValueError, TypeError):
        raise g.Stop("HISTORICAL_ISOLATED_RESULT_INVALID") from None
    return bind(value, schema, manifest(), raw)


def save(folder, name, value):
    g.need(name in {"observer69.json", "observer70.json", "observer-initialization.json", "observer-populated.json"},
           "HISTORICAL_EVIDENCE_NAME")
    with (folder / name).open("x", encoding="utf8", newline="\n") as stream:
        json.dump(value, stream, sort_keys=True, indent=2)
        stream.write("\n")


def negative_cases(before, raw):
    rejected = []
    for name in g.LEGACY + g.NEW:
        changed = copy.deepcopy(before)
        changed[name + "Sha256"] = hashlib.sha256((before[name + "Sha256"] + "changed").encode()).hexdigest()
        try:
            g.same_schema(before, changed, raw)
        except g.Stop:
            rejected.append(name)
        else:
            raise g.Stop("HISTORICAL_DRIFT_NOT_REJECTED")
    return rejected


def main(mode):
    connection(os.environ)
    g.need(mode in {"capture69", "initialization", "populated"}, "HISTORICAL_ISOLATED_MODE")
    folder = Path(os.environ["HISTORY_EVIDENCE"]).resolve(strict=True) / "migration70"
    g.need(folder.is_dir() and not folder.is_symlink(), "HISTORICAL_ISOLATED_EVIDENCE_DIRECTORY")
    raw = (ROOT / "prisma/migrations" / g.MIGRATION / "migration.sql").read_bytes()
    g.checked_sql(raw)
    if mode == "capture69":
        save(folder, "observer69.json", capture(69, raw))
        print("SQL70_READ_ONLY_OBSERVER_BASELINE_PASS")
        return
    if mode == "initialization":
        before = json.loads((folder / "observer69.json").read_text())
        after = capture(70, raw)
        g.transition(before, after, raw)
        save(folder, "observer70.json", after)
        proof = {"status": "SQL70_OBSERVER_INITIALIZATION_PASS", "synthetic": True, "schemaFrom": 69, "schemaTo": 70,
                 "allN14RowsAndAuditPreserved": True, "newJournalsAndAuditEmpty": True,
                 "sourceManifestSha256": after["migrationManifestSha256"], "migrationSha256": g.SQL_SHA256,
                 "databaseWritesExecutedByObserver": False}
        save(folder, "observer-initialization.json", proof)
    else:
        before, after = capture(70, raw), capture(70, raw)
        g.same_schema(before, after, raw)
        g.need(before["CommercialLeadHistoricalContactCount"] >= 2 and before["CommercialLeadHistoricalConversionCount"] >= 1
               and before["historicalContactAuditCount"] >= 2 and before["historicalConversionAuditCount"] >= 1,
               "HISTORICAL_POPULATED_FIXTURE_REQUIRED")
        proof = {"status": "SQL70_OBSERVER_POPULATED_PASS", "synthetic": True, "state": after,
                 "negativeCasesRejected": negative_cases(before, raw), "sameSchemaPreserved": True,
                 "databaseWritesExecutedByObserver": False, "restartExecutedByObserver": False}
        save(folder, "observer-populated.json", proof)
    print(json.dumps({k: v for k, v in proof.items() if k != "state"}, sort_keys=True))


if __name__ == "__main__":
    try:
        g.need(len(sys.argv) == 2, "HISTORICAL_ISOLATED_ARGUMENTS")
        main(sys.argv[1])
    except Exception as error:
        print(json.dumps({"status": "STOP", "code": str(error) if isinstance(error, g.Stop)
                          else "HISTORICAL_ISOLATED_FAILURE_REDACTED"}))
        raise SystemExit(2)
