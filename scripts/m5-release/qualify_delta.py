"""CI-only schema49 before/after backup, role-selected encryption and isolated restore."""
import os
from pathlib import Path
import re
import socket
import sys
import tempfile
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
REPO=HERE.parents[1]
sys.path.insert(0,str(HERE))
from generate import source, render, SOURCE, SOURCE_TREE, schema49


def shallow_source(raw):
    old="    c.run('CI_BACKUP_SOURCE_CLONE', ['git', '-c', 'init.templateDir=', 'clone', '--no-checkout', str(repo), source])"
    new="""    c.run('CI_BACKUP_SOURCE_INIT', ['git', '-c', 'init.templateDir=', 'init', str(source)])
    c.run('CI_BACKUP_SOURCE_FETCH', ['git', '-C', source, '-c', 'protocol.file.allow=always',
                                   'fetch', '--depth=1', str(repo), binding['candidate']])"""
    if raw.count(old)!=1:raise SystemExit('CI_SOURCE_CLONE_CHANGED')
    return raw.replace(old,new)


def qualify_source_backup(c, repo, binding):
    import json
    from common import digest, module
    from image_binding import complete_binding
    from qualified_images import verify_images
    proof=json.loads(source('scripts/m4-release/qualification.json'))['receipt']
    source_binding=binding|{'candidate':SOURCE,'candidateTree':SOURCE_TREE,
        'candidateCiImage':proof['candidateImageId'],'returnCiImage':proof['recoveryImageId'],
        'imageArchiveSha256':proof['imageArchiveSha256']}
    for role in ('candidate','return'):
        source_binding.pop(role+'Image',None)
        source_binding.pop(role+'ConfigDigest',None)
    source_binding=complete_binding(SOURCE_ARCHIVE,source_binding)
    c.docker('CI_SOURCE_BACKUP_IMAGES','load','--input',SOURCE_ARCHIVE,seconds=300)
    verify_images(c,SOURCE_ARCHIVE,source_binding)
    path=HELPERS/'qualify_source_backup.py'
    return module(path,'m5_source_backup_proof',digest(path)).qualify_generated_backup(c,repo,source_binding)


if not (os.environ.get('CI')==os.environ.get('GITHUB_ACTIONS')=='true' and socket.gethostname()!='fai-crm-prod-02'):
    raise SystemExit('CI_SYNTHETIC_ONLY')
if len(sys.argv)!=3:raise SystemExit('M5_AND_M4_ARCHIVES_REQUIRED')
SOURCE_ARCHIVE=Path(sys.argv.pop()).resolve()

with tempfile.TemporaryDirectory(prefix='m5-qualified-',dir=REPO) as folder:
    HELPERS=Path(folder);HELPERS.chmod(0o700)
    for name,data in render('c'*32).items():(HELPERS/name).write_bytes(data)
    backup=schema49(source('scripts/m2-release/qualify_generated_backup.py').decode())
    backup=backup.replace("files['backup49_after.py']","files['backup48_after.py']")
    (HELPERS/'qualify_generated_backup.py').write_text(shallow_source(backup))
    before=backup.replace("files['backup48_after.py']","files['backup48_before.py']")
    (HELPERS/'qualify_source_backup.py').write_text(shallow_source(before))
    (HELPERS/'qualify_protection.py').write_bytes((HERE/'qualify_protection.py').read_bytes())
    sys.path.insert(1,str(HELPERS))
    raw=source('scripts/m2-release/qualify_delta.py').decode()
    raw=raw.replace('m2-release-ci-receipt.json','m5-release-ci-receipt.json').replace(
        'FAI_M2_RELEASE_DELTA_QUALIFICATION_R26','FAI_M5_RELEASE_DELTA_QUALIFICATION_R36')
    raw=raw.replace("binding['ledger48']","binding['ledger49']")
    raw=raw.replace("    generated_backup=qualify_generated_backup(c,REPO,binding)",
                    "    source_backup=qualify_source_backup(c,REPO,binding)\n    generated_backup=qualify_generated_backup(c,REPO,binding)")
    raw=raw.replace("'generatedBackup':generated_backup","'generatedBackup':generated_backup,'sourceBackup49':source_backup")
    pg_env="'-e','POSTGRES_DB=m2_release_test',pg_image"
    if raw.count(pg_env)!=1:raise SystemExit('CI_POSTGRES_BINDING_CHANGED')
    raw=raw.replace(pg_env,"'-e','POSTGRES_USER=postgres','-e','POSTGRES_DB=m2_release_test',pg_image")
    raw=raw.replace("'ledger48Preserved':True","'ledger49Preserved':True")
    raw=raw.replace('SCHEMA48','SCHEMA49').replace('schema48','schema49').replace("work/'set48'","work/'set49'")
    restore="        restored=Restore(c,recovery,run,pg_image,binding['candidateImage'],kit).run(backup,binding['ledger49'])"
    generated_restore="""        from remote_release import Release
        release=Release.__new__(Release)
        release.c,release.work,release.run_id=c,work,run
        release.t,release.b={'postgresImage':pg_image},binding
        release.kit=lambda:kit
        release.backup_set=lambda:(backup,None)
        def recovery_observation():
            pg_state=c.inspect('container',pg)
            ledger_valid(rows(),binding['ledger49'])
            return {'appHealthy':True,'postgresHealthy':pg_state['State']['Running'],
                'postgresStartedAt':pg_state['State']['StartedAt'],'postgresRestartCount':pg_state['RestartCount'],
                'ledgerChecksumsMatch':True,'ledgerCount':len(rows()),'closedGates':True}
        release.observer=recovery_observation
        restored=release.recover()
""".rstrip()
    if raw.count(restore)!=1:raise SystemExit('CI_RECOVERY_INSERTION_CHANGED')
    raw=raw.replace(restore,generated_restore)
    raw=raw.replace("'restore':restored","'restore':restored,'generatedRecoverUsed':True")
    check="""        from admission_fixture import exercise
        no_migration=exercise(HELPERS,work/'admission-proof',binding,rows)
        need(no_migration['newMigrations']==[] and no_migration['migrator'] is None and
             no_migration['before']==no_migration['after']==49 and rows()==before,
             'GENERATED_NO_MIGRATION_CHANGED_LEDGER')
"""
    needle="        result={'protocol':'FAI_M5_RELEASE_DELTA_QUALIFICATION_R36'"
    if raw.count(needle)!=1:raise SystemExit('CI_RESULT_INSERTION_CHANGED')
    raw=raw.replace(needle,check+needle)
    raw=raw.replace("'migrationsRequiredInProduction':[]","'migrationsRequiredInProduction':[],'generatedNoMigration':no_migration")
    exec(compile(raw,'qualified_m5_schema49_harness.py','exec'),globals())
