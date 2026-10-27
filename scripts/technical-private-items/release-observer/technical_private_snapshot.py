"""SQL69 preparation: read-only projection builder and pure preservation gates.
No connection, mutation or execution entry point. Real SQL qualification and
integration into the complete release executor remain required.
"""
import copy
import hashlib
import re
from pathlib import Path
import technical_private_guards as g

METADATA_QUERY_SHA256 = "1b2a6ef54a4a91d11567c614b6eeaf8cc0cf3a563313d5af0075ca8c4b3fe021"
EVENT = "technical_item_created_private"
HASH = re.compile("[a-f0-9]{64}")
STATE = g.PRESERVED + ("privateStructureProof", "privateMigrationSha256", "migrationManifestSha256") + tuple(
    n + suffix for n in g.NEW for suffix in ("Count", "Sha256")
) + tuple(n + suffix for n in g.LEGACY for suffix in ("PrivateCount", "WithPrivateSha256"))


def ledger_binding(rows, manifest, schema):
    g.require(type(schema) is int and schema in (68, 69), "PRIVATE_LEDGER_SCHEMA")
    g.require(isinstance(manifest, dict) and len(manifest) == 69
              and list(manifest) == sorted(manifest) and list(manifest)[-1] == g.MIGRATION
              and manifest[g.MIGRATION] == g.SQL_SHA256
              and all(re.fullmatch(r"[0-9]{14}_[a-z0-9_]+", k) and HASH.fullmatch(str(v))
                      for k, v in manifest.items()), "PRIVATE_SOURCE_MANIFEST")
    g.require(isinstance(rows, list) and len(rows) == schema, "PRIVATE_LEDGER_COUNT")
    checked = {}
    for row in rows:
        g.require(isinstance(row, dict) and row.get("finished") is True
                  and row.get("rolled_back") is False and type(row.get("applied_steps_count")) is int
                  and row["applied_steps_count"] == 1, "PRIVATE_LEDGER_UNFINISHED")
        name = row.get("migration_name")
        g.require(isinstance(name, str) and name not in checked, "PRIVATE_LEDGER_DUPLICATE")
        checked[name] = row.get("checksum")
    expected = dict(list(manifest.items())[:schema])
    g.require(checked == expected, "PRIVATE_LEDGER_CHECKSUM")
    return {"prefix68ManifestSha256": g.digest(dict(list(manifest.items())[:68])),
            "migrationManifestSha256": g.digest(expected),
            "privateMigrationSha256": g.SQL_SHA256 if schema == 69 else None}


def structure_expression():
    raw = (Path(__file__).parent / "technical-private-structure.sql").read_bytes()
    g.require(hashlib.sha256(raw).hexdigest() == METADATA_QUERY_SHA256, "PRIVATE_METADATA_QUERY_DRIFT")
    sql = "\n".join(x for x in raw.decode("utf-8").splitlines() if not x.startswith("--")).strip()
    g.require(sql.startswith("SELECT json_build_object(") and sql.endswith(");"), "PRIVATE_METADATA_QUERY_SHAPE")
    return sql[len("SELECT "):-1]


def fingerprint(table, projection="to_jsonb(r)", where=""):
    g.require(table in g.LEGACY + ("TechnicalPrivateItemOrigin", "AuditLog")
              and projection in ("to_jsonb(r)", "(to_jsonb(r)-'technicalPrivate')")
              and where in ("", " WHERE event='" + EVENT + "'"), "PRIVATE_QUERY_PARAMETERS")
    return "(SELECT encode(sha256(convert_to(COALESCE(string_agg(" + projection + \
        "::text,E'\\n' ORDER BY " + projection + "::text),''),'UTF8')),'hex') FROM \"" + table + "\" r" + where + ")"


def snapshot_fields(schema):
    g.require(type(schema) is int and schema in (68, 69), "PRIVATE_SNAPSHOT_SCHEMA")
    fields = ["'privateStructure'," + structure_expression()]
    for table in g.LEGACY:
        fields += ["'" + table + "Count',(SELECT count(*) FROM \"" + table + "\")",
                   "'" + table + "WithoutPrivateSha256'," + fingerprint(table, "(to_jsonb(r)-'technicalPrivate')"),
                   "'" + table + "WithPrivateSha256'," + fingerprint(table),
                   "'" + table + "PrivateCount'," + (
                       "(SELECT count(*) FROM \"" + table + "\" WHERE \"technicalPrivate\" IS TRUE)" if schema == 69 else "0")]
    where = " WHERE event='" + EVENT + "'"
    fields += ["'technicalPrivateCreationAuditCount',(SELECT count(*) FROM \"AuditLog\"" + where + ")",
               "'technicalPrivateCreationAuditSha256'," + fingerprint("AuditLog", where=where)]
    if schema == 69:
        fields += ["'TechnicalPrivateItemOriginCount',(SELECT count(*) FROM \"TechnicalPrivateItemOrigin\")",
                   "'TechnicalPrivateItemOriginSha256'," + fingerprint("TechnicalPrivateItemOrigin")]
    else:
        fields += ["'TechnicalPrivateItemOriginCount',0", "'TechnicalPrivateItemOriginSha256','" + g.EMPTY + "'"]
    return fields


def admit(snapshot, raw):
    g.require(isinstance(snapshot, dict) and type(snapshot.get("schema")) is int
              and snapshot["schema"] in (68, 69), "PRIVATE_STATE_SCHEMA")
    schema = snapshot["schema"]
    expected = g.validate({k: [] for k in g.KEYS} if schema == 68 else g.qualified_metadata(raw), schema, raw)
    g.require(snapshot.get("privateStructureProof") == expected, "PRIVATE_STATE_STRUCTURE")
    g.require(snapshot.get("privateMigrationSha256") == (g.SQL_SHA256 if schema == 69 else None), "PRIVATE_STATE_MIGRATION")
    g.require(HASH.fullmatch(str(snapshot.get("prefix68ManifestSha256"))), "PRIVATE_STATE_PREFIX")
    g.require(HASH.fullmatch(str(snapshot.get("migrationManifestSha256"))), "PRIVATE_STATE_MANIFEST")
    if schema == 68:
        g.require(snapshot["migrationManifestSha256"] == snapshot["prefix68ManifestSha256"], "PRIVATE_STATE_PREFIX_MISMATCH")
    for table in g.LEGACY:
        count, private = snapshot.get(table + "Count"), snapshot.get(table + "PrivateCount")
        g.require(type(count) is int and type(private) is int and 0 <= private <= count, "PRIVATE_STATE_COUNTS")
        g.require(HASH.fullmatch(str(snapshot.get(table + "WithoutPrivateSha256"))), "PRIVATE_STATE_LEGACY_HASH")
        g.require(HASH.fullmatch(str(snapshot.get(table + "WithPrivateSha256"))), "PRIVATE_STATE_FULL_HASH")
        if schema == 68:
            g.require(snapshot[table + "WithPrivateSha256"] == snapshot[table + "WithoutPrivateSha256"], "PRIVATE_PREVIOUS_PROJECTION_MISMATCH")
    for name in g.NEW:
        count = snapshot.get(name + "Count"); hashed = snapshot.get(name + "Sha256")
        g.require(type(count) is int and count >= 0 and HASH.fullmatch(str(hashed)), "PRIVATE_STATE_NEW_HASH")
        g.require(count != 0 or hashed == g.EMPTY, "PRIVATE_EMPTY_HASH")
    if schema == 68:
        g.require(all(snapshot[n + "PrivateCount"] == 0 for n in g.LEGACY)
                  and all(snapshot[n + "Count"] == 0 for n in g.NEW), "PRIVATE_STATE_PREMATURE")
    return True


def bind_snapshot(observed, schema, ledger, manifest, raw):
    expected = {"privateStructure"} | {n + suffix for n in g.LEGACY for suffix in ("Count", "WithoutPrivateSha256", "WithPrivateSha256", "PrivateCount")} | {n + suffix for n in g.NEW for suffix in ("Count", "Sha256")}
    g.require(isinstance(observed, dict) and set(observed) == expected, "PRIVATE_OBSERVER_FORMAT")
    result = copy.deepcopy(observed)
    g.require("privateStructure" in result, "PRIVATE_OBSERVER_STRUCTURE_MISSING")
    result["privateStructureProof"] = g.validate(result.pop("privateStructure"), schema, raw)
    result.update(schema=schema, **ledger_binding(ledger, manifest, schema))
    admit(result, raw)
    return result


def transition(before, after, raw):
    admit(before, raw); admit(after, raw)
    g.initialized_only(before, after, raw)
    # Callers must additionally preserve every prior snapshot field with the
    # existing release guards, using the two explicit legacy projections.
    return True


def same_schema(before, after, raw):
    admit(before, raw); admit(after, raw)
    g.require(before["schema"] == after["schema"] == 69, "PRIVATE_RUNTIME_SCHEMA")
    for key in STATE:
        g.require(before[key] == after[key], "PRIVATE_RUNTIME_CHANGED:" + key)
    return True
