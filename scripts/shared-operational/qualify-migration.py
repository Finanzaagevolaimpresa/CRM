"""Qualify schema75 -> 76 only against a fresh, labelled synthetic PostgreSQL.

No container lifecycle, downloads, production connection, reset or deletion.
The caller owns the ephemeral container. Every input, command and result is kept.
"""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile
import time
import urllib.parse


def sha(data):
    return hashlib.sha256(data).hexdigest()


def normalized(data):
    return data.decode('utf-8').replace('\r\n', '\n').encode('utf-8')


def ident(value):
    return '"' + value.replace('"', '""') + '"'


def literal(value):
    return "'" + value.replace("'", "''") + "'"


parser = argparse.ArgumentParser()
parser.add_argument('--container', required=True)
parser.add_argument('--out', required=True)
parser.add_argument('--node', default='node')
parser.add_argument('--context', default='default')
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[2]
out = pathlib.Path(args.out).resolve()
out.mkdir(parents=True, exist_ok=False)
docker = ['docker', '--context', args.context]
receipt = {'protocol': 'SHARED_OPERATIONAL_MIGRATION76_SYNTHETIC_V1',
           'productionContact': False, 'steps': [], 'status': 'RUNNING'}


def persist():
    (out / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')


def run(name, command, data=None, accepted=(0,), timeout=180):
    start, at = time.monotonic(), datetime.datetime.now(datetime.timezone.utc).isoformat()
    result = subprocess.run(command, input=data, cwd=root, capture_output=True, timeout=timeout)
    stdout, stderr = out / (name + '.out'), out / (name + '.err')
    stdout.write_bytes(result.stdout)
    stderr.write_bytes(result.stderr)
    receipt['steps'].append({'name': name, 'command': command, 'startedAt': at,
                            'durationSeconds': round(time.monotonic() - start, 3), 'exitCode': result.returncode,
                            'stdout': {'path': str(stdout), 'sha256': sha(result.stdout), 'bytes': len(result.stdout)},
                            'stderr': {'path': str(stderr), 'sha256': sha(result.stderr), 'bytes': len(result.stderr)}})
    persist()
    assert result.returncode in accepted, name + ' unexpected exit'
    assert len(result.stdout) <= 32 * 1024 * 1024, 'Bounded synthetic evidence required'
    return result.stdout


def sql(name, text, database='fai_crm_test', accepted=(0,)):
    return run(name, docker + ['exec', '-i', args.container, 'psql', '-X', '-q', '-U', 'postgres',
                              '-d', database, '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
               text.encode('utf-8'), accepted=accepted)


def value(name, text, database='fai_crm_test'):
    return json.loads(sql(name, text, database))


def columns(name, database='fai_crm_test'):
    return value(name, """SELECT COALESCE(jsonb_object_agg(table_name, cols),'{}'::jsonb) FROM (
      SELECT table_name, jsonb_agg(column_name ORDER BY ordinal_position) AS cols
      FROM information_schema.columns WHERE table_schema='public'
      GROUP BY table_name) s;""", database)


def snapshot(name, projection, database='fai_crm_test'):
    parts = []
    for table, fields in sorted(projection.items()):
        select = ','.join(ident(field) for field in fields)
        parts.append('SELECT ' + literal(table) + ' AS name, COALESCE(jsonb_agg(to_jsonb(s) '
                     "ORDER BY to_jsonb(s)::text),'[]'::jsonb) AS rows FROM (SELECT "
                     + select + ' FROM ' + ident(table) + ') s')
    return value(name, 'SELECT jsonb_object_agg(name,rows) FROM (' + ' UNION ALL '.join(parts) + ') all_rows;', database)


def catalog(name, database='fai_crm_test'):
    return value(name, """SELECT jsonb_build_object(
      'functions',(SELECT jsonb_agg(jsonb_build_array(p.proname,pg_get_function_identity_arguments(p.oid),
        pg_get_functiondef(p.oid)) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid))
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'),
      'constraints',(SELECT jsonb_agg(jsonb_build_array(c.relname,k.conname,pg_get_constraintdef(k.oid))
        ORDER BY c.relname,k.conname) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'),
      'triggers',(SELECT jsonb_agg(jsonb_build_array(c.relname,t.tgname,pg_get_triggerdef(t.oid))
        ORDER BY c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal),
      'indexes',(SELECT jsonb_agg(jsonb_build_array(tablename,indexname,indexdef) ORDER BY tablename,indexname)
        FROM pg_indexes WHERE schemaname='public'),
      'columns',(SELECT jsonb_agg(to_jsonb(c) ORDER BY table_name,ordinal_position)
        FROM (SELECT table_name,column_name,ordinal_position,column_default,is_nullable,data_type,
        character_maximum_length,udt_name FROM information_schema.columns WHERE table_schema='public') c));""", database)


try:
    assert os.environ.get('CI') == 'true'
    assert os.environ.get('AI_ORCHESTRATOR_DB_TESTS_CONFIRMED') == '1'
    assert os.environ.get('AI_ORCHESTRATOR_DB_TEST_SENTINEL') == 'FAI_CRM_EPHEMERAL_TEST_ONLY_V1'
    url = urllib.parse.urlsplit(os.environ['DATABASE_URL'])
    assert url.scheme in ('postgresql', 'postgres') and url.hostname == '127.0.0.1'
    assert url.path == '/fai_crm_test' and url.username == 'postgres'
    assert urllib.parse.parse_qs(url.query) in ({}, {'schema': ['public']})
    # Only selected non-secret inspection fields are collected.
    raw = run('container-target', docker + ['inspect', '--format',
        '{"id":{{json .Id}},"image":{{json .Image}},"labels":{{json .Config.Labels}},'
        '"binds":{{json .HostConfig.Binds}},"ports":{{json .NetworkSettings.Ports}},"running":{{json .State.Running}}}', args.container])
    inspection = json.loads(raw)
    assert inspection['labels'].get('fai.scope') == 'shared-operational-synthetic'
    assert not inspection['binds'] and inspection['running'] is True
    ports = inspection['ports']['5432/tcp']
    assert len(ports) == 1 and ports[0]['HostIp'] == '127.0.0.1' and int(ports[0]['HostPort']) == url.port
    receipt['target'] = inspection
    db_identity = value('database-identity', """SELECT jsonb_build_object('name',current_database(),'user',current_user,
      'version',current_setting('server_version_num'),'sentinel',shobj_description(oid,'pg_database'))
      FROM pg_database WHERE datname=current_database();""")
    assert db_identity['name'] == 'fai_crm_test' and db_identity['user'] == 'postgres'
    assert 160000 <= int(db_identity['version']) < 170000
    assert db_identity['sentinel'] == 'FAI_CRM_EPHEMERAL_TEST_ONLY_V1'
    assert columns('fresh-tables') == {}, 'Only a fresh empty schema is accepted'
    binding = json.loads((root / 'scripts/shared-operational/schema-binding.json').read_text(encoding='utf-8'))
    baseline = binding['baseline']
    assert run('base-tree', ['git', 'rev-parse', baseline + '^{tree}']).decode().strip() == binding['baselineTree']
    migration = root / 'prisma/migrations' / binding['migration'] / 'migration.sql'
    migration_bytes = normalized(migration.read_bytes())
    assert migration_bytes == migration.read_bytes(), 'Canonical LF SQL required by .gitattributes'
    assert sha(migration_bytes) == binding['migrationSha256']
    files = run('prefix-files', ['git', 'ls-tree', '-r', '--name-only', baseline, '--', 'prisma']).decode().splitlines()
    selected = [p for p in files if p == 'prisma/schema.prisma' or p == 'prisma/migrations/migration_lock.toml'
                or (p.startswith('prisma/migrations/') and p.endswith('/migration.sql'))]
    assert len([p for p in selected if p.endswith('/migration.sql')]) == 75
    # A short independent fixture path also works on Windows without changing
    # the machine's long-path policy. Retain it and its hashes as evidence.
    prefix = pathlib.Path(tempfile.mkdtemp(prefix='fai-schema75-'))
    receipt['preservedPrefixDirectory'] = str(prefix)
    inputs = []
    for index, relative in enumerate(selected):
        data = run('export-' + str(index), ['git', 'cat-file', 'blob', baseline + ':' + relative])
        path = prefix / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        inputs.append({'path': relative, 'sha256': sha(data)})
    receipt['prefixInputs'] = inputs
    prisma = str(root / 'node_modules/prisma/build/index.js')
    run('apply-prefix75', [args.node, prisma, 'migrate', 'deploy', '--schema', str(prefix / 'prisma/schema.prisma')], timeout=300)
    sql('seed-old-canonical-fields', """BEGIN;
      INSERT INTO "Client"(id,type,"displayName",notes,"updatedAt")
      VALUES('shared-migration-client','societa','Synthetic migration client','PRIVATE_SYNTHETIC_OLD_NOTE',CURRENT_TIMESTAMP);
      INSERT INTO "Company"(id,"clientId",name,"legalAddress","operatingAddress",pec,"vatNumber",notes,"updatedAt")
      VALUES('shared-migration-company','shared-migration-client','Synthetic canonical company','Via precedente 4, località sintetica',
      'Sede precedente sintetica','synthetic@invalid.test','00000000000','PRIVATE_SYNTHETIC_COMPANY_NOTE',CURRENT_TIMESTAMP);
      INSERT INTO "Person"(id,"firstName","lastName",email,phone,"taxCode",notes)
      VALUES('shared-migration-person','Synthetic','Existing','contact@invalid.test','0000000000','SYNTHETIC_CF','PRIVATE_PERSON_NOTE');
      INSERT INTO "CompanyPerson"(id,"companyId","personId",role)
      VALUES('shared-migration-membership','shared-migration-company','shared-migration-person','Ruolo storico non classificato');
      COMMIT;""")
    before_cols = columns('columns75')
    before = snapshot('rows75', before_cols)
    before_catalog = catalog('catalog75')
    assert len(before_cols) == 179 and len(before['_prisma_migrations']) == 75
    assert migration_bytes.rstrip().endswith(b'COMMIT;') and migration_bytes.count(b'COMMIT;') == 1
    injected = migration_bytes.rsplit(b'COMMIT;', 1)[0] + b'SELECT 1/0;\nCOMMIT;\n'
    sql('injected-failure', injected.decode('utf-8'), accepted=(3,))
    assert b'division by zero' in (out / 'injected-failure.err').read_bytes()
    assert columns('rollback-columns') == before_cols
    assert catalog('rollback-catalog') == before_catalog
    assert snapshot('rollback-rows', before_cols) == before
    receipt['injectedRollbackExact'] = True
    run('apply-schema76', [args.node, prisma, 'migrate', 'deploy'], timeout=300)
    after_cols = columns('columns76')
    assert set(after_cols) == set(before_cols) | {'SharedOperationalUpdate'}
    after_old = snapshot('old-column-rows76', before_cols)
    ledger = after_old.pop('_prisma_migrations')
    expected_old = {k: v for k, v in before.items() if k != '_prisma_migrations'}
    assert after_old == expected_old, 'Existing rows or old columns changed'
    prefix_ledger = [row for row in ledger if row['migration_name'] != binding['migration']]
    assert prefix_ledger == before['_prisma_migrations'] and len(ledger) == 76
    added = [row for row in ledger if row['migration_name'] == binding['migration']]
    assert len(added) == 1 and added[0]['checksum'] == binding['migrationSha256'] and added[0]['finished_at']
    new_defaults = value('new-field-defaults', """SELECT jsonb_build_object(
      'company',(SELECT to_jsonb(c) FROM "Company" c WHERE id='shared-migration-company'),
      'membership',(SELECT to_jsonb(m) FROM "CompanyPerson" m WHERE id='shared-migration-membership'),
      'client',(SELECT to_jsonb(c) FROM "Client" c WHERE id='shared-migration-client'),
      'sharedRows',(SELECT count(*) FROM "SharedOperationalUpdate"));""")
    for column in set(after_cols['Company']) - set(before_cols['Company']):
        assert new_defaults['company'][column] is None
    assert new_defaults['membership']['isAdministrator'] is False
    assert new_defaults['membership']['isOperationalContact'] is False
    assert new_defaults['client']['operationalState'] is None and new_defaults['sharedRows'] == 0
    after = snapshot('all-rows76', after_cols)
    after_catalog = catalog('catalog76')
    sql('repeat-denied', migration_bytes.decode('utf-8'), accepted=(3,))
    assert b'SHARED_OPERATIONAL_SCHEMA75_REQUIRED' in (out / 'repeat-denied.err').read_bytes()
    assert snapshot('repeat-rows', after_cols) == after and catalog('repeat-catalog') == after_catalog
    backup = run('backup76', docker + ['exec', args.container, 'pg_dump', '-U', 'postgres', '-d', 'fai_crm_test', '-Fc'])
    restored = 'shared_restore_' + inspection['id'][:12]
    sql('create-restore-target', 'CREATE DATABASE ' + ident(restored) + ';')
    run('restore76', docker + ['exec', '-i', args.container, 'pg_restore', '-U', 'postgres', '-d', restored,
                              '--exit-on-error', '--single-transaction'], data=backup)
    assert columns('restored-columns', restored) == after_cols
    assert snapshot('restored-rows', after_cols, restored) == after
    restored_catalog = catalog('restored-catalog', restored)
    # PostgreSQL's dump/reparse may rewrite equivalent CHECK/index expressions
    # (array casts, nested Boolean parentheses). Compare the full restore with
    # an independently exported schema-only round trip, not a regex that drops
    # constraints or a blind allowance for arbitrary catalog differences.
    schema_backup = run('schema-only-backup76', docker + ['exec', args.container, 'pg_dump', '-U', 'postgres',
                        '-d', 'fai_crm_test', '-Fc', '--schema-only'])
    schema_target = 'shared_schema_' + inspection['id'][:12]
    sql('create-schema-control', 'CREATE DATABASE ' + ident(schema_target) + ';')
    run('restore-schema-control', docker + ['exec', '-i', args.container, 'pg_restore', '-U', 'postgres',
        '-d', schema_target, '--exit-on-error', '--single-transaction'], data=schema_backup)
    assert columns('control-columns', schema_target) == after_cols
    assert catalog('control-catalog', schema_target) == restored_catalog
    text_differences = []
    for key, original in after_catalog.items():
        actual = restored_catalog[key]
        if key not in ('constraints', 'indexes'):
            assert actual == original, 'Unexplained catalog change: ' + key
            continue
        assert [row[:2] for row in original] == [row[:2] for row in actual]
        for source_row, restored_row in zip(original, actual):
            if source_row != restored_row:
                text_differences.append({'kind': key, 'before': source_row, 'after': restored_row})
    (out / 'catalog-roundtrip-differences.json').write_text(json.dumps(text_differences, indent=2) + '\n', encoding='utf-8')
    receipt.update(status='PASS', schema75RowsPreserved=True, priorLedgerPreserved=True, emptySharedHistory=True,
                   noRoleOrGrantBackfill=True, repeatDenied=True, backupRestoreExact=True,
                   tableCounts={'before': len(before_cols), 'after': len(after_cols)},
                   migrationSha256=binding['migrationSha256'], restoreDatabase=restored,
                   schemaOnlyControlDatabase=schema_target, restoredCatalogMatchesSchemaOnlyControl=True,
                   catalogTextIdenticalToBefore=not text_differences, catalogTextRoundTripDifferences=len(text_differences))
except Exception as error:
    receipt.update(status='FAIL', error=type(error).__name__ + ': ' + str(error))
    raise
finally:
    receipt['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    persist()
