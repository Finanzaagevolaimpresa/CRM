"""Offline generation from exact PR158 bytes; historical programs stay untouched.

Only two allowed sources exist: deployed M1 before release and qualified M2
after release. No received shell, arbitrary target, source, path or program.
"""
import ast
import hashlib
import re

M1 = 'fb645e014653ee87dc64f2439970967192f91b62'
M1_TREE = 'a55efe3062437dab4cbced9bc895f565ad91db9f'
M1_RUNTIME = 'release-fb645e014653-r21-4fdd39f722e848e6994e51994b4790ed'
M2 = '7ab126f8a2ef385c3e720f190eda80f26f61ae39'
M2_TREE = 'c4566387ec58e7eb7c82e3da52ef1424eb08e756'
BASE = '/home/faiadmin/.local/share/fai-crm-releases/'
BACKUP_TEMPLATE = '81fc3ca26974cb0d44256b7efad66139fbe016cb63f12abcf6fa30eca0c36202'
OBSERVER_TEMPLATE = '79520da8edddb5f6e24b24c707d23828dd93492ee96300b30050cacdf78ceea3'
TRANSITION_TEMPLATE = 'f6cf98455012be4cad2c820380db74cf7f2be7a4d9e72887c5cc050894abc148'
OWNER_TEMPLATE = 'cb742683c6c5c7e87162e5911b1f72c7aa159fee785da4e1bf6f422f3e2982c0'
RECEIVER_TEMPLATE = 'fa6f9bacae657c234a4008551302055f3d1916f8534cf95c0aa6472413e65815'
MODES = {'INTERNAL_SESSION_MODE': 'registry', 'PRIVILEGED_ACCESS_MODE': 'enforced',
         'CONTROLLED_INTAKE_MODE': 'internal', 'PRACTICE_READINESS_MODE': 'internal',
         'INTERNAL_ENGAGEMENT_MODE': 'controlled'}


def identity(role, run_id):
    if role not in ('before', 'after') or not re.fullmatch('[a-f0-9]{32}', run_id):
        raise ValueError('SEALED_IDENTITY_DENIED')
    return ((M1, M1_TREE, M1_RUNTIME) if role == 'before' else
            (M2, M2_TREE, 'release-' + M2[:12] + '-m2-' + run_id))


def verified(raw, expected):
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('SEALED_TEMPLATE_CHANGED')
    return raw.decode('utf-8')


def replace(text, before, after, count=1):
    if text.count(before) != count:
        raise ValueError('SEALED_TRANSFORMATION_MISMATCH')
    return text.replace(before, after)


def assignment(text, name, expression):
    nodes = [n for n in ast.parse(text).body if isinstance(n, ast.Assign) and
             any(isinstance(t, ast.Name) and t.id == name for t in n.targets)]
    if len(nodes) != 1:
        raise ValueError('SEALED_ASSIGNMENT_MISMATCH')
    lines = text.splitlines(keepends=True)
    n = nodes[0]
    return ''.join(lines[:n.lineno-1]) + name + ' = ' + expression + '\n' + ''.join(lines[n.end_lineno:])


def schema48(text):
    return re.sub(r'(?<![A-Za-z0-9_])46(?![A-Za-z0-9_])', '48', text)


REGISTRY_METHODS = r'''
    def session_sql(self, sql, command_id):
        return self.docker('exec', self.target['postgresId'], 'sh', '-ceu',
            'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"',
            'planned-release-sessions', sql, command_id=command_id)

    def registry_preflight(self):
        from registry_settlement import PREFLIGHT_SQL, parse_counts
        need(parse_counts(self.session_sql(PREFLIGHT_SQL, 'REGISTRY_PREFLIGHT')) ==
             {'revokedCount': 0, 'auditCount': 0}, 'REGISTRY_PREFLIGHT_DENIED')

    def settle_registry_sessions(self):
        from registry_settlement import SQL, COUNT_SQL, parse_counts, stopped_app
        need(stopped_app(self.inspect(self.target['appId']), self.target['appId'],
                         {self.target['appImage']}), 'REGISTRY_WRITER_NOT_QUIESCENT')
        self.phase = 'SESSION_REVOCATION'
        counts = parse_counts(self.session_sql(SQL, 'SESSION_REVOCATION'))
        need(self.session_sql(COUNT_SQL, 'REGISTRY_COUNT') == '0', 'REGISTRY_SESSIONS_REAPPEARED')
        self.session_settlement = counts
        self.write(self.work / 'SESSION_SETTLEMENT.json', {
            'operation': 'PLANNED_RELEASE_SESSION_REVOCATION', 'runId': self.plan['runId'],
            'rowsPreserved': True, 'credentialsChanged': False, **counts})
'''



BACKUP_TAG_ADAPTER = r'''
    production_guard = b'[[ "$APP_IMAGE" =~ ^fai-crm:pr[0-9]+-[0-9a-f]{12}$ ]]'
    legacy_guard = b'[[ "${APP_IMAGE:-}" =~ ^fai-crm:pr[0-9]+-[0-9a-f]{12}$ ]]'
    need(data.count(production_guard) == data.count(legacy_guard) == 1, "BACKUP_TAG_GUARD_SOURCE_CHANGED")
    exact_guard = ('[[ "${APP_IMAGE:-}" == "' + TAG + '" ]]').encode()
    data = data.replace(production_guard, exact_guard).replace(legacy_guard, exact_guard)
'''

def backup(raw, role, run_id):
    text = verified(raw, BACKUP_TEMPLATE)
    commit, tree, runtime = identity(role, run_id)
    for name, expression in {'PROTOCOL': repr('FAI_CRM_OWNER_BACKUP48_R26'),
            'CONFIRMATION': repr('FAI_CRM_SCHEMA48_BACKUP_SESSION_SETTLEMENT_R26'),
            'SOURCE': repr(commit), 'TREE': repr(tree), 'RUNTIME': 'BASE / ' + repr(runtime),
            'TAG': repr('fai-crm:r05-candidate-' + commit)}.items():
        text = assignment(text, name, expression)
    text = schema48(text.replace('backup46', 'backup48').replace('schema46', 'schema48'))
    text = replace(text, '    return sources | {"scripts/n05/lib.sh": data}',
                   BACKUP_TAG_ADAPTER + '\n    return sources | {"scripts/n05/lib.sh": data}')
    text = replace(text, '    value = stderr[-65536:].lower()',
                   '    if stderr == b"N05_FAILED|code=PRODUCTION_IMAGE_NOT_IMMUTABLE\\n":\n'
                   '        return "PRODUCTION_IMAGE_NOT_IMMUTABLE"\n'
                   '    value = stderr[-65536:].lower()')
    text = replace(text, '"INTERNAL_SESSION_MODE": "legacy", "PRIVILEGED_ACCESS_MODE": "disabled"',
                   ', '.join(repr(k) + ': ' + repr(v) for k, v in MODES.items()))
    text = replace(text, '("SECURE_LEAD_GATEWAY_MODE", "COMMERCIAL_LEAD_INBOX_MODE", "CONTROLLED_INTAKE_MODE", "PRACTICE_READINESS_MODE", "INTERNAL_ENGAGEMENT_MODE")',
                   '("SECURE_LEAD_GATEWAY_MODE", "COMMERCIAL_LEAD_INBOX_MODE")')
    text = replace(text, '    def create(self):', REGISTRY_METHODS + '\n    def create(self):')
    text = replace(text, '        self.resource_preflight()\n', '        self.resource_preflight()\n        self.registry_preflight()\n')
    text = replace(text, '            env = self.backup_environment()\n',
                   '            self.settle_registry_sessions()\n            env = self.backup_environment()\n')
    text = replace(text, '        if not app["State"]["Running"]:\n',
                   '        if not app["State"]["Running"]:\n'
                   '            from registry_settlement import COUNT_SQL\n'
                   '            need(self.session_sql(COUNT_SQL, "REGISTRY_COUNT") == "0", "REGISTRY_RESUME_BLOCKED_LIVE_SESSIONS")\n')
    text = replace(text, '    "BACKUP_PREFLIGHT", "BACKUP_CREATE", "BACKUP_VERIFY", "ARCHIVE_VERIFY",',
                   '    "BACKUP_PREFLIGHT", "BACKUP_CREATE", "BACKUP_VERIFY", "ARCHIVE_VERIFY", "SESSION_REVOCATION",')
    text = replace(text, '    "BACKUP_PREFLIGHT", "BACKUP_RESOURCE_PREFLIGHT", "BACKUP_CREATE", "BACKUP_MANIFEST_VERIFY", "PG_ARCHIVE_READ",',
                   '    "BACKUP_PREFLIGHT", "BACKUP_RESOURCE_PREFLIGHT", "BACKUP_CREATE", "BACKUP_MANIFEST_VERIFY", "PG_ARCHIVE_READ", "REGISTRY_PREFLIGHT", "SESSION_REVOCATION", "REGISTRY_COUNT",')
    text = replace(text, '                "deployPerformed": False, "productionActivation": False}',
                   '                "deployPerformed": False, "productionActivation": False, "sessionSettlement": self.session_settlement}')
    compile(text, 'backup48_' + role + '.py', 'exec')
    return text.encode('utf-8')


def observer(raw, role, run_id):
    text = verified(raw, OBSERVER_TEMPLATE)
    commit, tree, runtime = identity(role, run_id)
    for name, value in {'PROTOCOL': 'FAI_M2_SCHEMA48_OBSERVATION_R26', 'SOURCE': commit,
                        'TREE': tree, 'CANDIDATE': M2, 'RUNTIME': BASE + runtime}.items():
        text = assignment(text, name, repr(value))
    text = schema48(text.replace('LEDGER46_', 'LEDGER48_'))
    text = assignment(text, 'INACTIVE_MODES', repr(('SECURE_LEAD_GATEWAY_MODE', 'COMMERCIAL_LEAD_INBOX_MODE')))
    tree_ast = ast.parse(text)
    flags = next(ast.literal_eval(n.value) for n in tree_ast.body if isinstance(n, ast.Assign) and
                 any(isinstance(t, ast.Name) and t.id == 'FLAGS' for t in n.targets))
    text = assignment(text, 'FLAGS', repr(flags | MODES))
    compile(text, 'observe48_' + role + '.py', 'exec')
    return text.encode('utf-8')


def transition(raw):
    """Retain only seven qualified methods; provisioning/migration are absent."""
    text = verified(raw, TRANSITION_TEMPLATE)
    source_class = next(n for n in ast.parse(text).body if isinstance(n,ast.ClassDef) and n.name == 'Release')
    names = {'sql','rows','kit','n05','canonical_transition','deploy','postcheck'}
    lines = text.splitlines(keepends=True)
    selected = [n for n in source_class.body if isinstance(n,ast.FunctionDef) and n.name in names]
    if {n.name for n in selected} != names:
        raise ValueError('SEALED_TRANSITION_METHODS')
    prefix = '''import contextlib, io, os, re, signal, sys, time
from pathlib import Path
from common import Stop, canonical, decode, digest, exclusive, load, module, need, private, value_sha
from isolated_restore import ledger_valid
from sealed_programs import BASE as BASE_STRING, MODES
BASE = Path(BASE_STRING)
LEDGER_SQL = "SELECT migration_name,checksum,started_at::text,coalesce(finished_at::text,''),coalesce(rolled_back_at::text,''),applied_steps_count::text FROM _prisma_migrations ORDER BY migration_name"
class Release:
'''
    result = prefix + '\n'.join(''.join(lines[n.lineno-1:n.end_lineno]) for n in selected)
    result = result.replace('evidence-backup46-', 'evidence-backup48-').replace("'m1-r21-'", "'m2-r26-'")
    result = replace(result, "'authorization': {'standingMandate': self.manifest['authorityReference'], 'key': load(self.work / 'key-provisioning-authority.json')},",
                     "'authorization': {'standingMandate': self.manifest['authorityReference'], 'configurationUnchanged': True, 'plannedSessionRevocation': True},")
    result = result.replace('PENDING_FRESH_LOGIN_AND_M1_USAGE','PENDING_FRESH_LOGIN_AND_M2_USAGE')
    compile(result,'transition_base.py','exec')
    return result.encode('utf-8')


def owner_base(raw):
    text = verified(raw,OWNER_TEMPLATE)
    names = {'ssh_error','call','admit','storage','command','stage_call'}
    constants = {'ROOT','SSH','PS','PY','NO_WINDOW','SSH_ARGS','TIMES'}
    lines = text.splitlines(keepends=True)
    nodes = [n for n in ast.parse(text).body if isinstance(n,(ast.Import,ast.ImportFrom)) or
             isinstance(n,ast.FunctionDef) and n.name in names or isinstance(n,ast.Assign) and
             any(isinstance(t,ast.Name) and t.id in constants for t in n.targets)]
    result = '\n'.join(''.join(lines[n.lineno-1:n.end_lineno]) for n in nodes)
    result = replace(result,M1,M2)
    compile(result,'owner_base.py','exec')
    return result.encode('utf-8')


def receiver(raw):
    text = verified(raw,RECEIVER_TEMPLATE)
    lines = text.splitlines(keepends=True)
    nodes = [n for n in ast.parse(text).body if isinstance(n,(ast.Import,ast.ImportFrom)) or
             isinstance(n,ast.FunctionDef) and n.name in ('need','receive')]
    result = '\n'.join(''.join(lines[n.lineno-1:n.end_lineno]) for n in nodes)
    result = result.replace('m1-assisted-r21-','m2-release-r26-')
    result = replace(result, "(set(manifest['files']) - {IMAGE_NAME}) | {'package.json'}", "set(manifest['files']) | {'package.json'}")
    result = replace(result, "        for member in members:\n", "        need(binding['image']['sha256'] == manifest['imageArchiveSha256'] and 0 < binding['image']['bytes'] <= 1024**3, 'QUALIFIED_IMAGE_BINDING')\n        for member in members:\n")
    result = replace(result, "            need(member.size == expected['bytes'], 'PACKAGE_FILE_SIZE')", "            if member.name == 'release-images.tar.gz': expected = binding['image']\n            need(member.size == expected['bytes'], 'PACKAGE_FILE_SIZE')")
    result = replace(result, "    reuse_images(root, manifest['files'][IMAGE_NAME])\n",
                     "    sys.path.insert(0, str(root))\n"
                     "    from consumed_preparation import receive_prepared\n"
                     "    receive_prepared(root)\n")
    result = replace(result,"'imagesReusedFromConsumedPreparation': True, 'imageBytesTransferred': 0,", "'imagesReusedFromConsumedPreparation': True, 'imageBytesTransferred': 0,")
    compile(result,'receive_package.py','exec')
    return result.encode('utf-8')
