"""Closed, read-only SQL fragments. Transport and runtime gates are separate."""
import hashlib
from pathlib import Path
import historical_guards as g

QUERY_SHA256 = "00dc480ba461d0938fbb0957894c5a2ce6f2104942a6e15106cc96264dfb5fca"
EVENTS = {"historicalContactAudit": "commercial_lead_historical_contact_recorded",
          "historicalConversionAudit": "commercial_lead_historical_conversion_recorded"}


def structure_expression():
    raw = (Path(__file__).parent / "historical-structure.sql").read_bytes()
    g.need(hashlib.sha256(raw).hexdigest() == QUERY_SHA256, "HISTORICAL_METADATA_QUERY_DRIFT")
    sql = "\n".join(x for x in raw.decode().splitlines() if not x.startswith("--")).strip()
    g.need(sql.startswith("SELECT json_build_object(") and sql.endswith(");"), "HISTORICAL_METADATA_QUERY_SHAPE")
    return sql[len("SELECT "):-1]


def fingerprint(table, event=None):
    g.need(table in g.TABLES + g.LEGACY and (event is None or table == "AuditLog" and event in EVENTS.values()),
           "HISTORICAL_QUERY_PARAMETERS")
    where = " WHERE event='" + event + "'" if event else ""
    return "(SELECT encode(sha256(convert_to(COALESCE(string_agg(to_jsonb(r)::text,E'\\n' ORDER BY to_jsonb(r)::text),''),'UTF8')),'hex') FROM \"" + table + "\" r" + where + ")"


def snapshot_fields(schema):
    g.need(type(schema) is int and schema in (69, 70), "HISTORICAL_SNAPSHOT_SCHEMA")
    fields = ["'historicalStructure'," + structure_expression()]
    for name in g.LEGACY + g.NEW:
        if schema == 69 and name in g.TABLES:
            fields += ["'" + name + "Count',0", "'" + name + "Sha256','" + g.EMPTY + "'"]
            continue
        table = "AuditLog" if name in EVENTS else name
        event = EVENTS.get(name)
        where = " WHERE event='" + event + "'" if event else ""
        fields += ["'" + name + "Count',(SELECT count(*) FROM \"" + table + "\"" + where + ")",
                   "'" + name + "Sha256'," + fingerprint(table, event)]
    return fields
