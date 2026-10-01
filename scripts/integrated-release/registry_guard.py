# Embedded in registry_settlement.py. Every command is a read-only transaction.
SQL = '''BEGIN READ ONLY; SET LOCAL statement_timeout='8s';
SELECT json_build_object('revokedCount',0,'auditCount',0,'liveCount',COUNT(*))
FROM "InternalSession" WHERE "revokedAt" IS NULL AND "expiresAt">CURRENT_TIMESTAMP;
ROLLBACK;'''
PREFLIGHT_SQL = SQL
COUNT_SQL = '''BEGIN READ ONLY; SET LOCAL statement_timeout='8s';
SELECT COUNT(*) FROM "InternalSession" WHERE "revokedAt" IS NULL AND "expiresAt">CURRENT_TIMESTAMP;
ROLLBACK;'''


def parse_counts(raw):
    value = json.loads(raw)
    if (set(value) != {'revokedCount', 'auditCount', 'liveCount'} or
        any(type(v) is not int or v != 0 for v in value.values())):
        raise ValueError('LIVE_SESSIONS_REQUIRE_NORMAL_LOGOUT')
    return {'revokedCount': 0, 'auditCount': 0}
