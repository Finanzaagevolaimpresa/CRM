"""Exact M1/M2 schema48 protection adapter; canonical sources remain untouched."""
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import canonical, digest, load, need, private
from sealed_programs import M1, M1_TREE, M2, M2_TREE

SOURCES = {M1: M1_TREE, M2: M2_TREE}


def qualify(kit, commit, tree):
    need(SOURCES.get(commit) == tree and kit.SUPPORTED_SOURCE_MIGRATION_COUNTS == (43, 46),
         'PROTECTION_SOURCE_NOT_QUALIFIED')
    original = kit.verify_source_schema
    def verify(source_commit, source_tree, count):
        need(source_commit == commit and source_tree == tree and type(count) is int and count == 48,
             'PROTECTION_SOURCE_NOT_QUALIFIED')
        return original(source_commit, source_tree, count)
    kit.SUPPORTED_SOURCE_MIGRATION_COUNTS = (48,)
    kit.verify_source_schema = verify
    return kit


def execute(kit, plan_path, plan_hash, commit, tree):
    qualify(kit, commit, tree)
    # Preserve canonical hashes, Git provenance, private paths and all
    # manifest/component checks. No backup/recovery/cleanup entrypoint.
    plan = kit.load_plan(str(plan_path), plan_hash)
    need(plan['phase'] == 'protect' and plan['expected']['source_commit'] == commit and
         plan['expected']['source_tree'] == tree, 'PROTECTION_PLAN_BINDING')
    kit.protect_preflight(plan)
    operation = kit.Operation(plan, plan_hash, resume=False)
    try:
        operation.event('BEGIN', command='protect')
        return kit.protect(plan, operation) | {'status': 'PROTECTION_VERIFIED'}
    except BaseException:
        operation.event('FAILED', code='PROTECTION_FAILED_RECONCILE_ONLY')
        raise
    finally:
        operation.close()


def main():
    need(sys.argv[1:] in (['before'], ['after']), 'FIXED_PROTECTION_ROLE_REQUIRED')
    from remote_release import Release
    release = Release(Path(__file__).resolve().parent)
    role = sys.argv[1]
    target, commit, tree, run = release.source(role)
    backup, receipt = release.backup_set(role)
    path = private(release.work / ('protect-' + role + '-plan.json'))
    binding = load(private(release.work / ('protect-' + role + '-binding.json')))
    need(digest(path) == binding['planSha256'], 'PROTECTION_PLAN_CHANGED')
    plan = load(path)
    need(plan['backup_set'] == str(backup) and plan['run_id'] == run and
         plan['host'] == target['hostname'] and plan['recipient'] == release.b['recipient'] and
         plan['expected']['manifest_sha256'] == receipt['manifestSha256'] and
         plan['expected']['checksums_sha256'] == receipt['checksumsSha256'], 'PROTECTION_RECEIPT_BINDING')
    result = execute(release.kit(), path, binding['planSha256'], commit, tree)
    result.update(adapterSha256=release.manifest['files']['protect48.py']['sha256'],
                  canonicalProgramSha256=release.b['canonicalPrograms']['scripts/n05/recovery_kit.py'],
                  sourceMigrationCount=48)
    print(canonical(result).decode(), flush=True)


if __name__ == '__main__':
    try:
        main()
    except BaseException as exc:
        code = getattr(exc, 'code', str(exc))
        if not re.fullmatch('[A-Z][A-Z0-9_]{1,90}', code):
            code = 'PROTECTION_ERROR_REDACTED'
        print(canonical({'status': 'STOP', 'code': code}).decode(), flush=True)
        # The release validates this minimized business STOP and exits nonzero.
        raise SystemExit(0)
