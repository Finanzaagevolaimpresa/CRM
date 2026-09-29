"""Return only counts and SHA256 of all mailbox rows; never addresses or IDs."""
from common import decode, need

SQL = '''BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='8s';
SELECT json_build_object('total',COUNT(*),'enabled',COUNT(*) FILTER (WHERE enabled),
 'sendReceive',COUNT(*) FILTER (WHERE "canSend" AND "canReceive"),
 'configured',COUNT(*) FILTER (WHERE "configuredRevision"="revision"),
 'tested',COUNT(*) FILTER (WHERE "testedRevision"="revision"),
 'responsible',COUNT(*) FILTER (WHERE "responsibleUserId" IS NOT NULL),
 'fingerprint',encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(m) ORDER BY id),'[]'::jsonb)::text,'UTF8')),'hex'))
FROM "CommunicationMailbox" m; ROLLBACK;'''


def observe(sql):
    import re
    value = decode(sql(SQL))
    counts = {'total', 'enabled', 'sendReceive', 'configured', 'tested', 'responsible'}
    need(set(value) == counts | {'fingerprint'} and
         all(type(value[k]) is int and value[k] == 7 for k in counts) and
         isinstance(value['fingerprint'], str) and re.fullmatch('[0-9a-f]{64}', value['fingerprint']),
         'SEVEN_QUALIFIED_MAILBOXES_REQUIRED')
    return value
