"""Qualify fixed M4 images, actual generated migration and schema49 backup."""
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
from generate import source, render, MIGRATION

if not (os.environ.get('CI')==os.environ.get('GITHUB_ACTIONS')=='true' and socket.gethostname()!='fai-crm-prod-02'):
    raise SystemExit('CI_SYNTHETIC_ONLY')
if len(sys.argv)!=3:raise SystemExit('M4_AND_M3_ARCHIVES_REQUIRED')
SOURCE_ARCHIVE=Path(sys.argv.pop()).resolve()

with tempfile.TemporaryDirectory(prefix='m4-qualified-',dir=REPO) as folder:
    HELPERS=Path(folder);HELPERS.chmod(0o700)
    for name,data in render('c'*32).items():(HELPERS/name).write_bytes(data)
    backup=source('scripts/m2-release/qualify_generated_backup.py').decode()
    backup=backup.replace('schema48','schema49').replace('Schema48','Schema49').replace('SCHEMA48','SCHEMA49')
    backup=re.sub(r'(?<![A-Za-z0-9_])48(?![A-Za-z0-9_])','49',backup)
    # The compatibility filename contains the schema49 program for the after role.
    backup=backup.replace("files['backup49_after.py']","files['backup48_after.py']")
    (HELPERS/'qualify_generated_backup.py').write_text(backup)
    protection=source('scripts/m2-release/qualify_protection.py').decode()
    protection=protection.replace('schema48','schema49').replace('Schema48','Schema49')
    protection=re.sub(r'(?<![A-Za-z0-9_])48(?![A-Za-z0-9_])','49',protection)
    protection=protection.replace('check.verify_source_schema(commit, tree, 49)','check.verify_source_schema(commit, tree, 48 if commit == M1 else 49)')
    (HELPERS/'qualify_protection.py').write_text(protection)
    sys.path.insert(1,str(HELPERS))
    # Existing real Docker/age/restore harness, bound to the new schema49 ledger.
    raw=source('scripts/m2-release/qualify_delta.py').decode()
    raw=raw.replace('m2-release-ci-receipt.json','m4-release-ci-receipt.json').replace('FAI_M2_RELEASE_DELTA_QUALIFICATION_R26','FAI_M4_RELEASE_DELTA_QUALIFICATION_R33')
    raw=raw.replace("binding['ledger48']","binding['ledger49']")
    # The generated SQL helper uses the normal container variables, unlike
    # the older CI harness's explicit psql -U argument.
    pg_env="'-e','POSTGRES_DB=m2_release_test',pg_image"
    if raw.count(pg_env)!=1:raise SystemExit('CI_POSTGRES_BINDING_CHANGED')
    raw=raw.replace(pg_env,"'-e','POSTGRES_USER=postgres','-e','POSTGRES_DB=m2_release_test',pg_image")
    old="""        c.docker('CI_SYNTHETIC_SCHEMA48','run','--rm','--network',network,'-e','DATABASE_URL='+url,'--entrypoint','node',
            binding['candidateImage'],'node_modules/prisma/build/index.js','migrate','deploy',seconds=240)"""
    if raw.count(old)!=1:raise SystemExit('CI_MIGRATION_INSERTION_CHANGED')
    raw=raw.replace(old,"        from qualify_migration import qualify_migration\n        migration_proof=qualify_migration(c,REPO,work,binding,pg,network,url,SOURCE_ARCHIVE,HELPERS)")
    raw=raw.replace("const u=await d.user.create({data:{email:'m2-r26@example.invalid',name:'Synthetic release admin',role:'admin',passwordHash:'NONLOGIN_SYNTHETIC'}});",
                    "const u=await d.user.findUniqueOrThrow({where:{email:'m2-r26@example.invalid'}});")
    raw=raw.replace("await d.$transaction(tx=>rotate(tx,{version:1,keyDigest:Buffer.alloc(32,8),actorUserId:u.id}));",'')
    raw=raw.replace("'migrationsRequiredInProduction':[]", "'migrationsRequiredInProduction':[MIGRATION], 'generatedMigration':migration_proof")
    raw=raw.replace("'ledger48Preserved':True", "'ledger49Preserved':True")
    exec(compile(raw,'qualified_m4_schema49_harness.py','exec'),globals())
