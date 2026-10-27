"""Pure SQL70 structure and preservation gates. No connection or mutation."""
import copy
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MIGRATION = "20261027220000_historical_lead_contact_v1"
SQL_SHA256 = "7cfd6093caca8fbdf022aa66720c8bf6b38d1a04b1f599a80f66505c5e3edf4c"
PREFIX69_SHA256 = "a28c0ac0d05e842933d8aee63d863a92df027d48706b3dd0290a2f533ee60675"
MANIFEST70_SHA256 = "2addf6b3eb5db6cb87cacba269654de1849ab5e0e28192eaad201b0543f9f9e5"
METADATA_SHA256 = {
    69: "40f6c45a89eea10850284931753d3c637dc270f0a5f5b94c00534030a988627d",
    70: "2dd6192a9ad591e42ec02d1e0006e3a2de3d689baa7d91e15b69fdcbd53ecc9f",
}
KEYS = {"tables", "columns", "triggers", "functions", "constraints", "indexes"}
TABLES = ("CommercialLeadHistoricalContact", "CommercialLeadHistoricalConversion")
LEGACY = ("Lead", "Client", "CommercialLeadInboxItem", "CommercialLeadSlaCycle",
          "CommercialLeadSlaPolicyVersion", "CommercialLeadActivity", "AuditLog")
NEW = TABLES + ("historicalContactAudit", "historicalConversionAudit")
EMPTY = hashlib.sha256(b"").hexdigest()
HASH = re.compile(r"[a-f0-9]{64}")


class Stop(ValueError):
    pass


def need(value, code):
    if not value:
        raise Stop(code)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def checked_sql(raw):
    need(isinstance(raw, bytes) and hashlib.sha256(raw).hexdigest() == SQL_SHA256, "HISTORICAL_SQL70_DRIFT")
    return raw.decode("utf8")


def metadata(schema, raw):
    need(type(schema) is int and schema in METADATA_SHA256, "HISTORICAL_METADATA_SCHEMA")
    sql = checked_sql(raw)
    data = (ROOT / f"historical-structure{schema}.json").read_bytes()
    need(hashlib.sha256(data).hexdigest() == METADATA_SHA256[schema], "HISTORICAL_METADATA_FILE_DRIFT")
    value = json.loads(data)
    need(set(value) == KEYS, "HISTORICAL_METADATA_SHAPE")
    if schema == 69:
        need(all(not value[k] for k in KEYS - {"constraints"}) and len(value["constraints"]) == 1,
             "HISTORICAL_BASELINE_OBJECTS")
        row = value["constraints"][0]
        need(row["name"] == "CommercialLeadSlaCycle_contract_check" and row["validated"] is True
             and "HISTORICAL_CONTACT_BEFORE_CRM" not in row["definition"], "HISTORICAL_BASELINE_CONSTRAINT")
        return value
    need([r["name"] for r in value["tables"]] == list(TABLES)
         and all(r["kind"] == "r" and r["persistence"] == "p" and r["ownerMatches"] is True
                 and r["rowSecurity"] is False and r["forcedRowSecurity"] is False for r in value["tables"]),
         "HISTORICAL_TABLE_IDENTITY")
    need(len(value["columns"]) == 27 and len(value["functions"]) == 4
         and len(value["triggers"]) == 8 and len(value["indexes"]) == 10, "HISTORICAL_OBJECT_CARDINALITY")
    need(sum(r["type"] == "f" for r in value["constraints"]) == 13
         and all(r["validated"] is True for r in value["constraints"]), "HISTORICAL_CONSTRAINTS")
    need(all(r["enabled"] == "O" and r["functionSchema"] == "public" for r in value["triggers"])
         and sum(r["deferrable"] and r["initiallyDeferred"] for r in value["triggers"]) == 3,
         "HISTORICAL_TRIGGERS")
    for row in value["functions"]:
        bodies = re.findall(r"CREATE FUNCTION " + re.escape(row["name"])
                            + r"\(\) RETURNS TRIGGER LANGUAGE plpgsql AS \$\$(.*?)\$\$;", sql, re.S | re.I)
        need(len(bodies) == 1 and row == dict(name=row["name"], schema="public", arguments="", returns="trigger",
             language="plpgsql", volatility="v", securityDefiner=False, configuration=None, ownerMatches=True,
             bodySha256=hashlib.sha256(bodies[0].encode()).hexdigest()), "HISTORICAL_FUNCTION_SOURCE_DRIFT")
    return value


def validate_structure(observed, schema, raw):
    need(isinstance(observed, dict) and observed == metadata(schema, raw), "HISTORICAL_STRUCTURE_DRIFT")
    return {"schema": schema, "structureSha256": digest(observed),
            "migrationSha256": SQL_SHA256 if schema == 70 else None}


def ledger_binding(rows, manifest, schema):
    need(type(schema) is int and schema in (69, 70), "HISTORICAL_LEDGER_SCHEMA")
    need(isinstance(manifest, dict) and len(manifest) == 70 and list(manifest) == sorted(manifest)
         and list(manifest)[-1] == MIGRATION and manifest[MIGRATION] == SQL_SHA256
         and all(re.fullmatch(r"[0-9]{14}_[a-z0-9_]+", k) and HASH.fullmatch(str(v)) for k, v in manifest.items()),
         "HISTORICAL_SOURCE_MANIFEST")
    prefix = dict(list(manifest.items())[:69])
    need(digest(prefix) == PREFIX69_SHA256, "HISTORICAL_PREFIX69_DRIFT")
    need(digest(manifest) == MANIFEST70_SHA256, "HISTORICAL_MANIFEST70_DRIFT")
    need(isinstance(rows, list) and len(rows) == schema, "HISTORICAL_LEDGER_COUNT")
    checked = {}
    for row in rows:
        need(isinstance(row, dict) and row.get("finished") is True and row.get("rolled_back") is False
             and type(row.get("applied_steps_count")) is int and row["applied_steps_count"] == 1,
             "HISTORICAL_LEDGER_UNFINISHED")
        name = row.get("migration_name")
        need(isinstance(name, str) and name not in checked, "HISTORICAL_LEDGER_DUPLICATE")
        checked[name] = row.get("checksum")
    expected = dict(list(manifest.items())[:schema])
    need(checked == expected, "HISTORICAL_LEDGER_CHECKSUM")
    return {"prefix69ManifestSha256": PREFIX69_SHA256, "migrationManifestSha256": digest(expected),
            "historicalMigrationSha256": SQL_SHA256 if schema == 70 else None}


def admit(value, raw):
    need(isinstance(value, dict) and type(value.get("schema")) is int and value["schema"] in (69, 70),
         "HISTORICAL_STATE_SCHEMA")
    schema = value["schema"]
    need(value.get("historicalStructureProof") == validate_structure(metadata(schema, raw), schema, raw),
         "HISTORICAL_STATE_STRUCTURE")
    need(value.get("historicalMigrationSha256") == (SQL_SHA256 if schema == 70 else None), "HISTORICAL_STATE_MIGRATION")
    need(value.get("prefix69ManifestSha256") == PREFIX69_SHA256
         and value.get("migrationManifestSha256") == (PREFIX69_SHA256 if schema == 69 else MANIFEST70_SHA256),
         "HISTORICAL_STATE_MANIFEST")
    if schema == 69:
        need(value["migrationManifestSha256"] == PREFIX69_SHA256, "HISTORICAL_STATE_PREFIX")
    for name in LEGACY + NEW:
        count, hashed = value.get(name + "Count"), value.get(name + "Sha256")
        need(type(count) is int and count >= 0 and HASH.fullmatch(str(hashed)), "HISTORICAL_STATE_FINGERPRINT:" + name)
        need(count != 0 or hashed == EMPTY, "HISTORICAL_STATE_EMPTY_HASH:" + name)
    if schema == 69:
        need(all(value[n + "Count"] == 0 for n in NEW), "HISTORICAL_STATE_PREMATURE")
    return True


def bind_snapshot(observed, schema, ledger, manifest, raw):
    expected = {"historicalStructure"} | {n + suffix for n in LEGACY + NEW for suffix in ("Count", "Sha256")}
    need(isinstance(observed, dict) and set(observed) == expected, "HISTORICAL_OBSERVER_SHAPE")
    value = copy.deepcopy(observed)
    value["historicalStructureProof"] = validate_structure(value.pop("historicalStructure"), schema, raw)
    value.update(schema=schema, **ledger_binding(ledger, manifest, schema))
    admit(value, raw)
    return value


def transition(before, after, raw):
    admit(before, raw); admit(after, raw)
    need(before["schema"] == 69 and after["schema"] == 70, "HISTORICAL_MIGRATION_TRANSITION")
    for name in LEGACY:
        for suffix in ("Count", "Sha256"):
            need(before[name + suffix] == after[name + suffix], "HISTORICAL_PRIOR_STATE_CHANGED:" + name)
    need(all(after[n + "Count"] == 0 and after[n + "Sha256"] == EMPTY for n in NEW),
         "HISTORICAL_INITIALIZATION_NOT_EMPTY")
    return True


def same_schema(before, after, raw):
    admit(before, raw); admit(after, raw)
    need(before["schema"] == after["schema"] == 70, "HISTORICAL_RUNTIME_SCHEMA")
    for key in ("historicalStructureProof", "historicalMigrationSha256", "migrationManifestSha256", "prefix69ManifestSha256"):
        need(before[key] == after[key], "HISTORICAL_RUNTIME_CHANGED:" + key)
    for name in LEGACY + NEW:
        for suffix in ("Count", "Sha256"):
            need(before[name + suffix] == after[name + suffix], "HISTORICAL_RUNTIME_CHANGED:" + name)
    return True


def compare_complete(before, after, raw, *, previous_database_check, migration=False):
    """Compose with the complete schema69 guard without changing its source.

    The projection is only for its historical comparison; it never attests the
    actual runtime or ledger as schema69. Admission of actual SQL70 happens first.
    """
    need(callable(previous_database_check) and type(migration) is bool, "HISTORICAL_PREVIOUS_GUARD_REQUIRED")
    (transition if migration else same_schema)(before, after, raw)
    projected = []
    for value in (before, after):
        p = copy.deepcopy(value)
        p["schema"] = 69
        p["migrationManifestSha256"] = PREFIX69_SHA256
        projected.append(p)
    need(previous_database_check(*projected) is True, "HISTORICAL_PREVIOUS_GUARD_DID_NOT_PASS")
    return True
