"""Audited planned-restart session settlement; never changes credentials.

The caller must prove that the only application writer is stopped/created.
Output contains counts, never session digests, user identifiers or credentials.
"""
import json

SQL = r'''BEGIN;
SET LOCAL statement_timeout='8s'; SET LOCAL lock_timeout='2s';
DO $$BEGIN
  IF (SELECT COUNT(*) FROM "User" WHERE role='admin' AND active AND "deletedAt" IS NULL) <> 1
  THEN RAISE EXCEPTION 'REGISTRY_ADMIN_AMBIGUOUS'; END IF;
END$$;
WITH principal AS (
  SELECT id FROM "User" WHERE role='admin' AND active AND "deletedAt" IS NULL FOR UPDATE
), changed AS (
  UPDATE "InternalSession" SET "revokedAt"=CURRENT_TIMESTAMP,"revokedReason"='INTERNAL_GLOBAL',
    "revokedByUserId"=(SELECT id FROM principal)
  WHERE "revokedAt" IS NULL AND "expiresAt">CURRENT_TIMESTAMP RETURNING "userId"
), audited AS (
  INSERT INTO "AuditLog" (id,"actorId",event,"entityType","entityId","after")
  SELECT gen_random_uuid()::text,(SELECT id FROM principal),'sessions_revoked_global','User',"userId",
    jsonb_build_object('reason','INTERNAL_GLOBAL','revokedCount',COUNT(*))
  FROM changed GROUP BY "userId" RETURNING id
) SELECT json_build_object('revokedCount',(SELECT COUNT(*) FROM changed),'auditCount',(SELECT COUNT(*) FROM audited));
COMMIT;'''

# Compile/check permissions, cardinality and constraints while the app is healthy.
# No existing row is updated; no audit is inserted. This is not an execution proof.
PREFLIGHT_SQL = SQL.replace('"revokedAt" IS NULL AND "expiresAt">CURRENT_TIMESTAMP RETURNING',
                           'FALSE RETURNING').replace('COMMIT;', 'ROLLBACK;')
COUNT_SQL = '''BEGIN READ ONLY; SET LOCAL statement_timeout='8s';
SELECT COUNT(*) FROM "InternalSession" WHERE "revokedAt" IS NULL AND "expiresAt">CURRENT_TIMESTAMP;
ROLLBACK;'''


def parse_counts(raw):
    value = json.loads(raw)
    if (set(value) != {'revokedCount', 'auditCount'} or
        any(type(v) is not int or v < 0 for v in value.values()) or
        (value['revokedCount'] == 0) != (value['auditCount'] == 0) or
        value['auditCount'] > value['revokedCount']):
        raise ValueError('SESSION_SETTLEMENT_RECEIPT_INVALID')
    return value


def stopped_app(raw, expected_id, allowed_images):
    state = raw['State']
    labels = raw['Config'].get('Labels') or {}
    return (raw['Id'] == expected_id and raw['Image'] in allowed_images and
            labels.get('com.docker.compose.project') == 'fai-crm' and
            labels.get('com.docker.compose.service') == 'app' and
            state.get('Status') in ('created', 'exited') and not state.get('Running') and
            not state.get('Paused') and not state.get('Restarting') and state.get('Pid') == 0 and
            not raw.get('ExecIDs'))


def registry_engine(base, receipt, execute_sql):
    """Keep the canonical N05 lock/recorder/deadlines; interpose only start.

    Compose --no-start has removed the old writer before this boundary. An
    unreceipted SQL error is never retried here. The caller reconciles a STOP.
    """
    class RegistryEngine(base):
        def run(self, *args, deadline, input_text=None):
            if args and args[0] == 'start':
                if len(args) != 2:
                    raise RuntimeError('REGISTRY_START_ARGUMENTS')
                identity = args[1]
                current = self.snapshot(deadline)
                raw = self.inspect('container', identity, deadline)
                images = {self.plan[k]['id'] for k in ('candidate', 'return_image')}
                if (not current['app'] or current['app']['id'] != identity or
                    current['foreign_containers'] or current['migrators'] or
                    not stopped_app(raw, identity, images)):
                    raise RuntimeError('REGISTRY_WRITER_NOT_QUIESCENT')
                self.validate_boundary(self.plan, current, deadline)
                counts = parse_counts(execute_sql(SQL, deadline))
                if execute_sql(COUNT_SQL, deadline).strip() != '0':
                    raise RuntimeError('REGISTRY_SESSIONS_REAPPEARED')
                receipt(identity, counts)
            return super().run(*args, deadline=deadline, input_text=input_text)
    return RegistryEngine
