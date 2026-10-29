"""Compare complete schemas after PostgreSQL parses each independent source.

No regex equivalence, removed constraints, or sorted DDL is admitted. The only
normalization removes pg_dump's random restrict nonce and dump timestamps.
The source is an independently captured schema-only stream, not schema extracted
from the data archive under test. All operations are on an attributed helper.
"""
import hashlib

REFERENCE_DB = 'm1_schema_reference'
RESTORED_DB = 'm1_recovery'
MAX_SCHEMA_BYTES = 8 * 1024 * 1024

class SchemaMismatch(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)

def require(value, code):
    if not value:
        raise SchemaMismatch(code)

def normalize(data):
    require(isinstance(data, bytes) and 0 < len(data) <= MAX_SCHEMA_BYTES, 'SCHEMA_BYTES_INVALID')
    text = data.decode('utf-8', errors='strict')
    lines = [line for line in text.splitlines() if not line.startswith(
        ('\\restrict ', '\\unrestrict ', '-- Dumped ', '-- Started on ', '-- Completed on '))]
    return ('\n'.join(lines) + '\n').encode()

def fingerprint(data):
    return hashlib.sha256(normalize(data)).hexdigest()

def compare(source, expected_source_sha, prepare, reference, restored):
    require(fingerprint(source) == expected_source_sha, 'SCHEMA_SOURCE_CHANGED')
    # prepare must create a fresh empty reference DB, never reuse a previous one.
    prepare(source)
    wanted, actual = normalize(reference()), normalize(restored())
    require(wanted == actual, 'RESTORED_SCHEMA_REFERENCE_MISMATCH')
    return dict(protocol='POSTGRES_INDEPENDENT_SCHEMA_REFERENCE_V1',
        sourceSchemaSha256=expected_source_sha,
        sourceFileSha256=hashlib.sha256(source).hexdigest(),
        referenceSchemaSha256=hashlib.sha256(wanted).hexdigest(),
        restoredSchemaSha256=hashlib.sha256(actual).hexdigest(),
        allSchemaBytesCompared=True,ddlExceptionsApplied=False,
        referenceDatabase=REFERENCE_DB,restoredDatabase=RESTORED_DB)

def helper_qualify(commands, helper_id, source, expected_source_sha):
    """Caller verifies helper ID/Created/image/label with the restore guard."""
    def sql(statement, db='postgres'):
        return commands.docker('SCHEMA_REFERENCE_SQL', 'exec', '-i', helper_id,
            'psql', '-h', '/tmp', '-U', 'postgres', '-d', db, '-XqAt',
            '-v', 'ON_ERROR_STOP=1', data=statement.encode(), seconds=45).decode().strip()
    def prepare(data):
        require(sql("SELECT count(*) FROM pg_database WHERE datname='m1_schema_reference';") == '0',
            'SCHEMA_REFERENCE_ALREADY_EXISTS')
        sql('CREATE DATABASE m1_schema_reference;')
        commands.docker('SCHEMA_REFERENCE_LOAD', 'exec', '-i', helper_id,
            'psql', '-h', '/tmp', '-U', 'postgres', '-d', REFERENCE_DB,
            '-Xq', '-v', 'ON_ERROR_STOP=1', '--single-transaction', data=data, seconds=120)
    def dump(db):
        return commands.docker('SCHEMA_REFERENCE_DUMP', 'exec', helper_id,
            'pg_dump', '-h', '/tmp', '-U', 'postgres', '-d', db,
            '--schema-only', '--no-owner', '--no-privileges', seconds=60)
    return compare(source, expected_source_sha, prepare,
        lambda: dump(REFERENCE_DB), lambda: dump(RESTORED_DB))
