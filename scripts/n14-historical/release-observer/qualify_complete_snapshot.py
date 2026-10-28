"""CI-only qualification of the complete observer's synthetic SQL twin.

Production identity literals are absent. The production admission guards are
not replaced by this qualification. Only aggregate hashes, counts and schema
metadata leave the isolated database; the query uses one read-only snapshot.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import historical_guards as g
import qualify_snapshot as isolated

HERE = Path(__file__).resolve().parent
REQUIRED = {
    "targetDatabase", "ledger", "historicalState", "ordinaryRows", "ordinaryRelations",
    "LeadSha256", "ClientSha256", "CommercialLeadInboxItemSha256", "CommercialLeadSlaCycleSha256",
    "sessionsStateSha256", "usersAdmissionSha256", "permissionOverridesSha256", "registryContinuityRows",
    "selectiveGrantsSha256", "keyRegistrySha256", "featureGatesSha256",
    "observerReadOnly", "observerActor", "observerSentinel",
}


def query(schema):
    g.need(type(schema) is int and schema in (69, 70), "COMPLETE_SCHEMA_INVALID")
    manifest = json.loads((HERE / "complete-query-manifest.json").read_bytes())
    entries = [p for p in manifest["queries"] if p["schema"] == schema]
    g.need(len(entries) == 1, "COMPLETE_QUERY_MANIFEST_INVALID")
    entry = entries[0]
    g.need(entry["file"] == f"complete-snapshot{schema}.sql", "COMPLETE_QUERY_PATH_INVALID")
    data = (HERE / entry["file"]).read_bytes()
    g.need(hashlib.sha256(data).hexdigest() == entry["sha256"], "COMPLETE_QUERY_DRIFT")
    text = data.decode("utf8")
    g.need(text.startswith("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;\n")
           and text.endswith(";\nROLLBACK;\n") and text.count("ROLLBACK;") == 1,
           "COMPLETE_QUERY_NOT_READ_ONLY")
    g.need(not re.search(r"(?im)^\s*(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|COPY|CALL|DO)\b", text),
           "COMPLETE_QUERY_WRITE_FORBIDDEN")
    g.need(not re.search(r"'cm[a-z0-9]{20,30}'", text), "COMPLETE_QUERY_REAL_IDENTITY_FORBIDDEN")
    return text


def admit(value, schema, source_manifest, raw):
    g.need(isinstance(value, dict) and len(value) >= 170 and REQUIRED <= set(value), "COMPLETE_FIELDS_MISSING")
    g.need(value["targetDatabase"] == "fai_crm_test" and value["observerActor"] == "postgres"
           and value["observerReadOnly"] is True and value["observerSentinel"] == isolated.SENTINEL,
           "COMPLETE_DATABASE_IDENTITY_INVALID")
    historical = g.bind_snapshot(value["historicalState"], schema, value["ledger"], source_manifest, raw)
    for name in ("Lead", "Client"):
        for suffix in ("Count", "Sha256"):
            g.need(value[name + suffix] == historical[name + suffix], "COMPLETE_SHARED_FINGERPRINT_MISMATCH")
    return {"complete": copy.deepcopy(value), "historical": historical}


def capture(schema, source_manifest, raw):
    # The connection guard rejects production and any non-isolated execution
    # before reading SQL or starting a process. It never prints a connection URL.
    dsn = isolated.connection(os.environ)
    sql = query(schema)
    try:
        result = subprocess.run(["psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-d", dsn],
                                input=sql, capture_output=True, text=True, timeout=25)
    except (OSError, subprocess.TimeoutExpired):
        raise g.Stop("COMPLETE_READ_FAILED") from None
    g.need(result.returncode == 0, "COMPLETE_READ_FAILED")
    try:
        value = json.loads(result.stdout)
    except (ValueError, TypeError):
        raise g.Stop("COMPLETE_RESULT_INVALID") from None
    return admit(value, schema, source_manifest, raw)


def same(before, after, raw):
    g.same_schema(before["historical"], after["historical"], raw)
    g.need(before["complete"] == after["complete"], "COMPLETE_EXISTING_STATE_DRIFT")


def transition(before, after, raw):
    g.transition(before["historical"], after["historical"], raw)
    exclusions = {"ledger", "historicalState"}
    g.need({k: v for k, v in before["complete"].items() if k not in exclusions}
           == {k: v for k, v in after["complete"].items() if k not in exclusions},
           "COMPLETE_MIGRATION_CHANGED_EXISTING_STATE")


def negative_cases(before, raw):
    keys = [k for k, v in before["complete"].items()
            if k.endswith("Sha256") and isinstance(v, str)]
    g.need(len(keys) >= 70, "COMPLETE_FINGERPRINTS_MISSING")
    for key in keys:
        changed = copy.deepcopy(before)
        changed["complete"][key] = hashlib.sha256((changed["complete"][key] + "drift").encode()).hexdigest()
        try:
            same(before, changed, raw)
        except g.Stop:
            continue
        raise g.Stop("COMPLETE_DRIFT_NOT_REJECTED")
    return keys


def save(folder, name, value):
    g.need(name in {"complete69.json", "complete70.json", "complete-initialization.json", "complete-populated.json"},
           "COMPLETE_EVIDENCE_NAME")
    with (folder / name).open("x", encoding="utf8", newline="\n") as stream:
        json.dump(value, stream, sort_keys=True, indent=2)
        stream.write("\n")


def main(mode):
    isolated.connection(os.environ)
    g.need(mode in {"capture69", "initialization", "populated"}, "COMPLETE_MODE_INVALID")
    folder = Path(os.environ["HISTORY_EVIDENCE"]).resolve(strict=True) / "migration70"
    g.need(folder.is_dir() and not folder.is_symlink(), "COMPLETE_EVIDENCE_DIRECTORY")
    raw = (isolated.ROOT / "prisma/migrations" / g.MIGRATION / "migration.sql").read_bytes()
    g.checked_sql(raw)
    source_manifest = isolated.manifest()
    if mode == "capture69":
        before = capture(69, source_manifest, raw)
        save(folder, "complete69.json", before)
        print("SQL70_COMPLETE_READ_ONLY_BASELINE_PASS")
        return
    if mode == "initialization":
        before = json.loads((folder / "complete69.json").read_text())
        after = capture(70, source_manifest, raw)
        transition(before, after, raw)
        save(folder, "complete70.json", after)
        proof = {"status": "SQL70_COMPLETE_INITIALIZATION_PASS", "oldFieldsPreserved": len(before["complete"]) - 2,
                 "newJournalsEmpty": True, "sourceManifestSha256": after["historical"]["migrationManifestSha256"]}
        name = "complete-initialization.json"
    else:
        before, after = capture(70, source_manifest, raw), capture(70, source_manifest, raw)
        same(before, after, raw)
        g.need(before["historical"]["CommercialLeadHistoricalContactCount"] >= 2
               and before["historical"]["CommercialLeadHistoricalConversionCount"] >= 1,
               "COMPLETE_POPULATED_FIXTURE_REQUIRED")
        proof = {"status": "SQL70_COMPLETE_POPULATED_PASS", "fieldsObserved": len(after["complete"]),
                 "negativeFingerprintCasesRejected": negative_cases(before, raw),
                 "sameSchemaPreserved": True, "historicalContactCount": before["historical"]["CommercialLeadHistoricalContactCount"],
                 "historicalConversionCount": before["historical"]["CommercialLeadHistoricalConversionCount"]}
        name = "complete-populated.json"
    proof.update(synthetic=True, readOnly=True, singleSnapshot=True, databaseWritesExecutedByObserver=False,
                 productionAdmissionQualified=False, productionContact=False,
                 qualificationScope="Complete SQL shape and preservation with synthetic identity literals; production identity and authority guards remain separate.")
    save(folder, name, proof)
    print(json.dumps(proof, sort_keys=True))


if __name__ == "__main__":
    try:
        g.need(len(sys.argv) == 2, "COMPLETE_ARGUMENTS_INVALID")
        main(sys.argv[1])
    except Exception as error:
        print(json.dumps({"status": "STOP", "code": str(error) if isinstance(error, g.Stop)
                          else "COMPLETE_FAILURE_REDACTED"}))
        raise SystemExit(2)
