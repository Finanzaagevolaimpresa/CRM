"""Exercise the real operator SQL only in the isolated GitHub CI database."""
import concurrent.futures
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

assert os.environ.get('CI') == 'true' and os.environ.get('GITHUB_ACTIONS') == 'true'
assert os.environ.get('APP_ENV') == 'test' and os.environ.get('RUN_TECHNICAL_ENROLLMENT_TESTS') == '1'
url = os.environ['DATABASE_URL'].split('?')[0]
parsed = urlparse(url)
assert (parsed.hostname, parsed.port, parsed.path) == ('127.0.0.1', 5432, '/fai_crm_test')
ddl_path = Path('ops/technical-assignment-authority-enrollment.sql')
ddl = ddl_path.read_text(encoding='utf-8')
checks = []


def execute(sql, must_succeed=True):
    result = subprocess.run(['psql', url, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'],
                            input=sql, text=True, capture_output=True, timeout=25)
    if must_succeed:
        assert result.returncode == 0, result.stderr
        return result.stdout.strip()
    return result


def literal(value):
    return "'" + value.replace("'", "''") + "'"


assert execute("SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()") == 'FAI_CRM_EPHEMERAL_TEST_ONLY_V1'
assert execute('SELECT count(*) FROM "TechnicalAssignmentAuthority"') == '0'
uid, other = str(uuid4()), str(uuid4())
binding = dict(database='fai_crm_test', userId=uid, name='Synthetic edit owner',
               email=uid + '@invalid.test', approvalSha256='a' * 64, auditId=str(uuid4()))
execute(f'''INSERT INTO "User"(id,email,name,role,"passwordHash","updatedAt") VALUES
 ({literal(uid)},{literal(binding['email'])},'Synthetic edit owner','admin','synthetic-unusable',now()),
 ({literal(other)},{literal(other + '@invalid.test')},'Synthetic other Admin','admin','synthetic-unusable',now());
 INSERT INTO "ApplicationKeyVersion"(id,purpose,version,"keyDigest",status,"activatedAt")
 VALUES('{uuid4()}','PRIVILEGED_STEP_UP',1,decode(repeat('ab',32),'hex'),'ACTIVE',now());''')


def footprint():
    names = execute("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").splitlines()
    assert all(re.fullmatch(r'[A-Za-z0-9_]+', name) for name in names)
    return {name: execute(f'''SELECT count(*)||'|'||md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) FROM "{name}" t''') for name in names}


def attempt(value, prefix=''):
    setting = '' if value is None else "SELECT set_config('fai.technical_assignment_binding'," + literal(json.dumps(value)) + ',false);'
    return execute(prefix + setting + '\n' + ddl, False)


def denied(name, value, error, prefix=''):
    before = footprint()
    result = attempt(value, prefix)
    assert result.returncode != 0 and error in result.stderr, (name, result.stdout, result.stderr)
    assert footprint() == before, name + ': denial changed rows'
    checks.append(name)


denied('missing_binding', None, 'TECHNICAL_ENROLLMENT_BINDING_INVALID')
for label, patch in [('wrong_database', dict(database='other')), ('bad_approval', dict(approvalSha256='invalid')),
                     ('bad_audit', dict(auditId='invalid')), ('unknown_input', dict(extra='unexpected'))]:
    denied(label, {**binding, **patch}, 'TECHNICAL_ENROLLMENT_BINDING_INVALID')
denied('wrong_profile', {**binding, 'email': 'wrong@invalid.test'}, 'TECHNICAL_ENROLLMENT_PROFILE_DENIED')
execute(f'''UPDATE "User" SET active=false WHERE id={literal(uid)}''')
denied('inactive_profile', binding, 'TECHNICAL_ENROLLMENT_PROFILE_DENIED')
execute(f'''UPDATE "User" SET active=true WHERE id={literal(uid)};
 INSERT INTO "UserPermissionOverride"(id,"userId",permission,allowed,"updatedAt") VALUES('{uuid4()}',{literal(uid)},'technical.assign',false,now());''')
denied('explicit_write_denial', binding, 'TECHNICAL_ENROLLMENT_PROFILE_DENIED')
execute(f'''UPDATE "UserPermissionOverride" SET allowed=true WHERE "userId"={literal(uid)} AND permission='technical.assign';
 UPDATE "ApplicationKeyVersion" SET status='RETIRED',"retiredAt"=now() WHERE purpose='PRIVILEGED_STEP_UP';''')
denied('inactive_key', binding, 'TECHNICAL_ENROLLMENT_KEY_REQUIRED')
execute('''UPDATE "ApplicationKeyVersion" SET status='ACTIVE',"retiredAt"=NULL WHERE purpose='PRIVILEGED_STEP_UP';
 UPDATE "_prisma_migrations" SET checksum=repeat('0',64) WHERE migration_name='20261022200000_technical_assignments_v1';''')
denied('wrong_schema_checksum', binding, 'TECHNICAL_ENROLLMENT_SCHEMA64_REQUIRED')
execute('''UPDATE "_prisma_migrations" SET checksum='9b3a7b1cab3cd97df9c110bff4b7590f7bee8acaabe7e985e3bfbfba3f5b7583'
 WHERE migration_name='20261022200000_technical_assignments_v1';
 CREATE FUNCTION synthetic_edit_enrollment_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.event='technical_assignment_authority_enrolled' AND current_setting('fai.synthetic_enrollment_fault',true)='1'
 THEN RAISE EXCEPTION 'SYNTHETIC_ENROLLMENT_AUDIT_FAILURE'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER synthetic_edit_enrollment_audit_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW
 EXECUTE FUNCTION synthetic_edit_enrollment_audit_fault();''')
denied('audit_fault_rolls_back_authority', binding, 'SYNTHETIC_ENROLLMENT_AUDIT_FAILURE',
       "SELECT set_config('fai.synthetic_enrollment_fault','1',false);")
before = footprint()
bindings = [binding, {**binding, 'auditId': str(uuid4())}]
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    results = list(pool.map(attempt, bindings))
winners = [index for index, result in enumerate(results) if result.returncode == 0]
assert len(winners) == 1, [(r.returncode, r.stderr) for r in results]
assert 'TECHNICAL_ENROLLMENT_COMMITTED' in results[winners[0]].stdout
winner = bindings[winners[0]]
after = footprint()
assert set(before) == set(after)
assert [name for name in before if before[name] != after[name]] == ['AuditLog', 'TechnicalAssignmentAuthority']
authority = json.loads(execute('SELECT row_to_json(t) FROM "TechnicalAssignmentAuthority" t'))
assert authority == dict(id='technical-assignment', userId=uid, revision=1, enabled=True)
audit = json.loads(execute("SELECT row_to_json(t) FROM \"AuditLog\" t WHERE id=" + literal(winner['auditId'])))
assert audit['event'] == 'technical_assignment_authority_enrolled' and audit['actorId'] == uid
assert audit['entityType'] == 'TechnicalAssignmentAuthority' and audit['entityId'] == 'technical-assignment'
assert audit['before'] == dict(version=0)
assert audit['after'] == dict(version=1, enabled=True, approvalHash=winner['approvalSha256'])
assert int(after['AuditLog'].split('|')[0]) == int(before['AuditLog'].split('|')[0]) + 1
checks.append('concurrent_exactly_one_enrollment_and_minimized_atomic_audit')
denied('replay_denied', {**binding, 'auditId': str(uuid4())}, 'TECHNICAL_ENROLLMENT_ALREADY_STARTED')
proof = dict(synthetic=True, schema=64, tests=len(checks), checks=checks, allPassed=True,
             operatorSqlSha256=hashlib.sha256(ddl_path.read_bytes()).hexdigest(),
             existingRowsPreserved=True, recipientGrantsCreated=0, productionContact=False)
destination = Path(os.environ['TECHNICAL_EVIDENCE']) / 'enrollment-proof.json'
destination.write_text(json.dumps(proof, indent=2) + '\n', encoding='utf-8')
print(json.dumps(proof))
