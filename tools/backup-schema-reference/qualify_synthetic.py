"""CI-only PostgreSQL roundtrip; fixed synthetic DBs, no production endpoints."""
import hashlib,json,os,re,subprocess
from pathlib import Path
import schema_reference as s

assert os.environ.get('CI')=='true' and os.environ.get('R04_SYNTHETIC_BACKUP_CONFIRMED')=='1'
CID=os.environ['R04_SYNTHETIC_POSTGRES_CONTAINER'];assert re.fullmatch('[a-f0-9]{64}',CID)
def command(*args,data=None):
    r=subprocess.run(['docker',*args],input=data,capture_output=True,timeout=120)
    assert r.returncode==0,(args[0],r.stderr.decode()[:2000])
    return r.stdout
raw=json.loads(command('inspect',CID))[0]
assert raw['Config']['Env'] and 'POSTGRES_DB=r04_synthetic_source' in raw['Config']['Env']
class Commands:
    def docker(self,_id,*args,data=None,**_):return command(*args,data=data)
c=Commands()
def sql(query,db):
    return command('exec','-i',CID,'psql','-U','postgres','-d',db,'-XqAt','-v','ON_ERROR_STOP=1',data=query.encode()).decode().strip()
def dump(db):
    return command('exec',CID,'pg_dump','-U','postgres','-d',db,'--schema-only','--no-owner','--no-privileges')

sql('''CREATE TABLE synthetic_record (
 id int PRIMARY KEY, state varchar(20) NOT NULL,
 value numeric(18,2), note text,
 CONSTRAINT synthetic_state_check CHECK (state IN ('DRAFT','READY','ARCHIVED')),
 CONSTRAINT synthetic_nested_check CHECK ((id>0 AND id<10) AND (value IS NULL OR value>=0)));
CREATE UNIQUE INDEX synthetic_ready ON synthetic_record (state) WHERE state IN ('READY','ARCHIVED');
CREATE FUNCTION synthetic_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END;$$;
CREATE TRIGGER synthetic_before BEFORE UPDATE ON synthetic_record FOR EACH ROW EXECUTE FUNCTION synthetic_guard();
INSERT INTO synthetic_record VALUES (1,'DRAFT',123.45,'synthetic only'),(2,'READY',NULL,'sintetico è');''','r04_synthetic_source')
source=dump('r04_synthetic_source')
archive=command('exec',CID,'pg_dump','-U','postgres','-d','r04_synthetic_source','-Fc')
sql('CREATE DATABASE m1_recovery;','postgres')
command('exec','-i',CID,'pg_restore','-U','postgres','-d','m1_recovery','--no-owner','--no-privileges','--exit-on-error','--single-transaction',data=archive)

# The production helper uses /tmp; CI's service socket is /var/run/postgresql.
# Only the socket argument differs. The shared comparison implementation is exact.
class CICommands(Commands):
    def docker(self,_id,*args,data=None,**_):
        args=list(args)
        if '-h' in args:
            i=args.index('-h');assert args[i+1]=='/tmp';del args[i:i+2]
        return command(*args,data=data)
proof=s.helper_qualify(CICommands(),CID,source,s.fingerprint(source))
row_query="SELECT md5(string_agg(to_jsonb(r)::text,E'\\n' ORDER BY id)) FROM synthetic_record r;"
assert sql(row_query,'r04_synthetic_source')==sql(row_query,'m1_recovery')
tests=[]
canonical_repairs={
 'missing_check':'ALTER TABLE synthetic_record ADD CONSTRAINT synthetic_state_check '+sql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='synthetic_state_check';",s.REFERENCE_DB)+';',
 'weakened_check':'ALTER TABLE synthetic_record DROP CONSTRAINT synthetic_nested_check; ALTER TABLE synthetic_record ADD CONSTRAINT synthetic_nested_check '+sql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='synthetic_nested_check';",s.REFERENCE_DB)+';',
 'missing_index':sql("SELECT pg_get_indexdef('synthetic_ready'::regclass);",s.REFERENCE_DB)+';',
 'missing_trigger':sql("SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname='synthetic_before';",s.REFERENCE_DB)+';',
 'function_body':sql("SELECT pg_get_functiondef('synthetic_guard()'::regprocedure);",s.REFERENCE_DB)
}
for name,mutation,repair in [
 ('missing_check','ALTER TABLE synthetic_record DROP CONSTRAINT synthetic_state_check;',"ALTER TABLE synthetic_record ADD CONSTRAINT synthetic_state_check CHECK (state IN ('DRAFT','READY','ARCHIVED'));"),
 ('weakened_check','ALTER TABLE synthetic_record DROP CONSTRAINT synthetic_nested_check; ALTER TABLE synthetic_record ADD CONSTRAINT synthetic_nested_check CHECK (id>0);','ALTER TABLE synthetic_record DROP CONSTRAINT synthetic_nested_check; ALTER TABLE synthetic_record ADD CONSTRAINT synthetic_nested_check CHECK ((id>0 AND id<10) AND (value IS NULL OR value>=0));'),
 ('missing_index','DROP INDEX synthetic_ready;',"CREATE UNIQUE INDEX synthetic_ready ON synthetic_record (state) WHERE state IN ('READY','ARCHIVED');"),
 ('missing_trigger','DROP TRIGGER synthetic_before ON synthetic_record;','CREATE TRIGGER synthetic_before BEFORE UPDATE ON synthetic_record FOR EACH ROW EXECUTE FUNCTION synthetic_guard();'),
 ('function_body','CREATE OR REPLACE FUNCTION synthetic_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION \'synthetic denial\'; END;$$;','CREATE OR REPLACE FUNCTION synthetic_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END;$$;'),
 ('extra_column','ALTER TABLE synthetic_record ADD COLUMN unauthorized text;','ALTER TABLE synthetic_record DROP COLUMN unauthorized;')]:
    sql(mutation,'m1_recovery')
    try:s.compare(source,s.fingerprint(source),lambda _:None,lambda:dump(s.REFERENCE_DB),lambda:dump(s.RESTORED_DB))
    except s.SchemaMismatch as e:assert e.code=='RESTORED_SCHEMA_REFERENCE_MISMATCH'
    else:raise AssertionError('Changed schema accepted: '+name)
    sql(canonical_repairs.get(name,repair),'m1_recovery')
    # Some DDL changes leave dropped attnums: comparison must still be exact.
    assert s.fingerprint(dump(s.REFERENCE_DB))==s.fingerprint(dump(s.RESTORED_DB)),name
    tests.append(name)
out=Path(os.environ['RUNNER_TEMP'])/'schema-reference-evidence';out.mkdir()
result=dict(status='PASS_SYNTHETIC_POSTGRES_SCHEMA_REFERENCE',sourceHead=os.environ['GITHUB_SHA'],
 moduleSha256=hashlib.sha256(Path(s.__file__).read_bytes()).hexdigest(),
 rawSchemaEqual=s.fingerprint(source)==s.fingerprint(dump('m1_recovery')),
 exactCanonicalProof=proof,rowsPreserved=True,negativeCases=tests,productionAccess=False)
(out/'result.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
