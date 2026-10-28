"""Qualify the release observer against the CI-only PostgreSQL service.

This entry point can only read the explicitly isolated database. It never
applies a migration or writes a row. Saved evidence contains counts, digests,
schema metadata and migration names; no row contents or connection strings.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit

import technical_private_guards as g
import technical_private_snapshot as s

ROOT = Path(__file__).resolve().parents[3]
SENTINEL = "FAI_CRM_EPHEMERAL_TEST_ONLY_V1"


def connection(env):
    expected = {"CI": "true", "GITHUB_ACTIONS": "true", "APP_ENV": "test",
                "RUN_DB_TESTS": "1", "TECHNICAL_PRIVATE_ITEM_DB_TESTS": "1",
                "AI_ORCHESTRATOR_DB_TESTS_CONFIRMED": "1",
                "AI_ORCHESTRATOR_DB_TEST_SENTINEL": SENTINEL}
    g.require(all(env.get(k) == v for k, v in expected.items()), "ISOLATED_CI_REQUIRED")
    raw = env.get("DATABASE_URL", "")
    try:
        value = urlsplit(raw)
        allowed = value.scheme == "postgresql" and value.hostname == "127.0.0.1" and value.port == 5432
        allowed = allowed and value.username == "postgres" and value.password == "synthetic-private-item-only"
        allowed = allowed and value.path == "/fai_crm_test" and value.query == "schema=public" and not value.fragment
    except ValueError:
        allowed = False
    g.require(allowed, "ISOLATED_CONNECTION_REQUIRED")
    return raw.partition("?")[0]


def query(schema):
    observed = "jsonb_build_object(" + ",".join(s.snapshot_fields(schema)) + ")"
    return """BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='15s';
SET LOCAL lock_timeout='5s';
SELECT jsonb_build_object(
 'targetDatabase',current_database(), 'actor',current_user,
 'readOnly',current_setting('transaction_read_only')='on',
 'sentinel',(SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()),
 'ledger',(SELECT jsonb_agg(r ORDER BY migration_name) FROM
   (SELECT migration_name,checksum,finished_at IS NOT NULL AS finished,
    rolled_back_at IS NOT NULL AS rolled_back,applied_steps_count FROM "_prisma_migrations") r),
 'observed',""" + observed + ");\nROLLBACK;\n"


def manifest():
    # This observer qualifies only the immutable 68 -> 69 transition and a
    # populated schema69 database. Later candidate SQL belongs to its own
    # observer; ledger_binding still rejects any extra database migration.
    return {p.parent.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted((ROOT / "prisma/migrations").glob("*/migration.sql"))
            if p.parent.name <= g.MIGRATION}


def bind(result, schema, source_manifest, raw):
    g.require(set(result) == {"targetDatabase", "actor", "readOnly", "sentinel", "ledger", "observed"},
              "ISOLATED_RESULT_SHAPE")
    g.require(result["targetDatabase"] == "fai_crm_test" and result["actor"] == "postgres"
              and result["readOnly"] is True and result["sentinel"] == SENTINEL, "ISOLATED_DATABASE_IDENTITY")
    return s.bind_snapshot(result["observed"], schema, result["ledger"], source_manifest, raw)


def capture(schema, raw):
    dsn = connection(os.environ)
    try:
        result = subprocess.run(["psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-d", dsn],
                                input=query(schema), capture_output=True, text=True, timeout=25)
    except (OSError, subprocess.TimeoutExpired):
        raise g.Stop("ISOLATED_OBSERVER_READ_FAILED") from None
    g.require(result.returncode == 0, "ISOLATED_OBSERVER_READ_FAILED")
    try:
        value = json.loads(result.stdout)
    except (ValueError, TypeError):
        raise g.Stop("ISOLATED_OBSERVER_RESULT_INVALID") from None
    return bind(value, schema, manifest(), raw)


def save(folder, name, value):
    g.require(name in {"observer68.json", "observer69.json", "observer-initialization.json",
                      "observer-populated.json"}, "EVIDENCE_NAME")
    with (folder / name).open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, sort_keys=True, indent=2)
        stream.write("\n")


def negative_cases(before, raw):
    cases = []
    # Exercise actual PostgreSQL output, including equal-count marker swaps.
    for field in ("TaskWithPrivateSha256", "DocumentChecklistItemWithPrivateSha256",
                  "TaskWithoutPrivateSha256", "TechnicalPrivateItemOriginSha256",
                  "technicalPrivateCreationAuditSha256", "migrationManifestSha256"):
        changed = copy.deepcopy(before)
        changed[field] = hashlib.sha256((before[field] + "changed").encode()).hexdigest()
        g.require(changed[field] != before[field], "NEGATIVE_FIXTURE_UNCHANGED")
        try:
            s.same_schema(before, changed, raw)
        except g.Stop:
            cases.append(field)
        else:
            raise g.Stop("OBSERVER_DRIFT_NOT_REJECTED")
    return cases


def main(mode):
    connection(os.environ)
    g.require(mode in {"capture68", "initialization", "populated"}, "ISOLATED_MODE")
    folder = Path(os.environ["TECHNICAL_PRIVATE_ITEM_EVIDENCE"]).resolve(strict=True) / "migration69"
    g.require(folder.is_dir() and not folder.is_symlink(), "ISOLATED_EVIDENCE_DIRECTORY")
    raw = (ROOT / "prisma/migrations" / g.MIGRATION / "migration.sql").read_bytes()
    g.checked_sql(raw)
    if mode == "capture68":
        save(folder, "observer68.json", capture(68, raw))
        print("SQL69_READ_ONLY_OBSERVER_BASELINE_PASS")
        return
    if mode == "initialization":
        before = json.loads((folder / "observer68.json").read_text())
        after = capture(69, raw)
        s.transition(before, after, raw)
        save(folder, "observer69.json", after)
        proof = {"status": "SQL69_OBSERVER_INITIALIZATION_PASS", "synthetic": True,
                 "schemaFrom": 68, "schemaTo": 69, "previousFieldsPreserved": True,
                 "markersFalse": True, "originAndCreationAuditEmpty": True,
                 "sourceManifestSha256": after["migrationManifestSha256"],
                 "migrationSha256": g.SQL_SHA256, "databaseWritesExecuted": False}
        save(folder, "observer-initialization.json", proof)
    else:
        before, after = capture(69, raw), capture(69, raw)
        s.same_schema(before, after, raw)
        g.require(before["TaskPrivateCount"] > 0 and before["DocumentChecklistItemPrivateCount"] > 0
                  and before["TechnicalPrivateItemOriginCount"] > 0
                  and before["technicalPrivateCreationAuditCount"] > 0, "POPULATED_PRIVATE_FIXTURE_REQUIRED")
        proof = {"status": "SQL69_OBSERVER_POPULATED_PASS", "synthetic": True,
                 "state": after, "negativeCasesRejected": negative_cases(before, raw),
                 "sameSchemaPreserved": True, "databaseWritesExecuted": False,
                 "restartExecutedByThisObserver": False}
        save(folder, "observer-populated.json", proof)
    print(json.dumps({k: v for k, v in proof.items() if k != "state"}, sort_keys=True))


if __name__ == "__main__":
    try:
        g.require(len(sys.argv) == 2, "ISOLATED_ARGUMENTS")
        main(sys.argv[1])
    except Exception as error:
        print(json.dumps({"status": "STOP", "code": str(error) if isinstance(error, g.Stop)
                          else "ISOLATED_QUALIFICATION_FAILURE_REDACTED"}))
        raise SystemExit(2)
