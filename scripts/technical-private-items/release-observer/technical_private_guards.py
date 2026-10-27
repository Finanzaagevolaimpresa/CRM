"""Preparatory SQL69 guards only. No network, subprocess, DB or production mutation."""
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MIGRATION = "20261027010000_technical_private_items_v1"
SQL_SHA256 = "f8b1cd77f86fbe5c170bd81c92b5a04cf3c5f1832041071c87ec750c5fd811ce"
METADATA_SHA256 = "b55c9c40362bbcde0533ff4c9339ca1c98b30cb996197967fe81ee24baf9cccc"
EMPTY = hashlib.sha256(b"").hexdigest()
KEYS = {"tables", "columns", "triggers", "functions", "constraints", "indexes"}
LEGACY = ("Task", "DocumentChecklistItem")
PRESERVED = ("prefix68ManifestSha256", "TaskCount", "TaskWithoutPrivateSha256",
             "DocumentChecklistItemCount", "DocumentChecklistItemWithoutPrivateSha256")
NEW = ("TechnicalPrivateItemOrigin", "technicalPrivateCreationAudit")

class Stop(ValueError):
    pass

def require(value, code):
    if not value:
        raise Stop(code)

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()

def checked_sql(raw):
    require(isinstance(raw, bytes) and hashlib.sha256(raw).hexdigest() == SQL_SHA256, "PRIVATE_SQL69_DRIFT")
    return raw.decode("utf-8")

def qualified_metadata(raw):
    sql = checked_sql(raw)
    data = (ROOT / "technical-private-structure69.json").read_bytes()
    require(hashlib.sha256(data).hexdigest() == METADATA_SHA256, "PRIVATE_METADATA_FILE_DRIFT")
    value = json.loads(data)
    require(set(value) == KEYS and value["tables"] == [dict(name="TechnicalPrivateItemOrigin",
        kind="r", persistence="p", rowSecurity=False, forcedRowSecurity=False, ownerMatches=True)], "PRIVATE_TABLE_IDENTITY")
    require(len(value["columns"]) == 15 and len(value["functions"]) == 3 and len(value["triggers"]) == 8
        and len(value["indexes"]) == 3, "PRIVATE_OBJECT_CARDINALITY")
    require(sum(c["type"] == "f" for c in value["constraints"]) == 1
        and all(c["validated"] is True for c in value["constraints"]), "PRIVATE_CONSTRAINTS")
    for table in LEGACY:
        rows = [r for r in value["columns"] if r["table"] == table]
        require(len(rows) == 1 and rows[0]["name"] == "technicalPrivate" and rows[0]["type"] == "boolean"
            and rows[0]["nullable"] == "NO" and rows[0]["default"] == "false", "PRIVATE_MARKER_SHAPE")
    require(all(t["enabled"] == "O" for t in value["triggers"])
        and sum(t["deferrable"] and t["initiallyDeferred"] for t in value["triggers"]) == 3, "PRIVATE_TRIGGERS")
    for row in value["functions"]:
        body = re.findall(r"CREATE FUNCTION " + re.escape(row["name"])
            + r"\(\) RETURNS trigger LANGUAGE plpgsql AS \$\$(.*?)\$\$;", sql, re.S)
        require(len(body) == 1 and row == dict(name=row["name"], schema="public", arguments="", returns="trigger",
            language="plpgsql", volatility="v", securityDefiner=False, configuration=None, ownerMatches=True,
            bodySha256=hashlib.sha256(body[0].encode()).hexdigest()), "PRIVATE_FUNCTION_SOURCE_DRIFT")
    return value

def validate(observed, schema, raw):
    require(schema in (68, 69) and isinstance(observed, dict) and set(observed) == KEYS, "PRIVATE_STRUCTURE_SCHEMA")
    checked_sql(raw)
    if schema == 68:
        require(all(observed[k] == [] for k in KEYS), "PRIVATE_STRUCTURE_PRESENT_BEFORE_SQL69")
        return {"schema": 68, "newStructureAbsent": True}
    require(observed == qualified_metadata(raw), "PRIVATE_STRUCTURE_DRIFT")
    return {"schema": 69, "sqlSha256": SQL_SHA256, "structureSha256": digest(observed),
            "tableCount": 1, "markerColumns": 2, "functionCount": 3, "triggerCount": 8, "foreignKeyCount": 1}

def initialized_only(before, after, raw):
    """Only the 68-to-69 writer-stopped transition; never assume later rows empty."""
    require(before.get("schema") == 68 and after.get("schema") == 69, "PRIVATE_MIGRATION_TRANSITION")
    require(before.get("privateStructureProof") == validate({k: [] for k in KEYS}, 68, raw), "PRIVATE_BASELINE_PROOF")
    require(after.get("privateStructureProof") == validate(qualified_metadata(raw), 69, raw), "PRIVATE_AFTER_PROOF")
    require(before.get("privateMigrationSha256") is None and after.get("privateMigrationSha256") == SQL_SHA256,
            "PRIVATE_MIGRATION_CHECKSUM")
    for field in PRESERVED:
        require(before.get(field) == after.get(field) and before.get(field) is not None, "PRIVATE_PREVIOUS_STATE_CHANGED:" + field)
    for table in LEGACY:
        require(type(before.get(table + "Count")) is int and before[table + "Count"] >= 0, "PRIVATE_COUNT_MISSING")
        require(re.fullmatch("[a-f0-9]{64}", str(before.get(table + "WithoutPrivateSha256"))), "PRIVATE_HASH_MISSING")
        require(before.get(table + "PrivateCount") == after.get(table + "PrivateCount") == 0, "PRIVATE_MARKER_NOT_FALSE")
    require(re.fullmatch("[a-f0-9]{64}", str(before.get("prefix68ManifestSha256"))), "PRIVATE_PREFIX_MISSING")
    for name in NEW:
        require(before.get(name + "Count") == after.get(name + "Count") == 0
            and before.get(name + "Sha256") == after.get(name + "Sha256") == EMPTY, "PRIVATE_INITIALIZATION_NOT_EMPTY")
    return True
