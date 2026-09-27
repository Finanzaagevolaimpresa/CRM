"""Run the generated migration against a disposable schema48 PostgreSQL."""
import os
from pathlib import Path
import socket
import time
import types

from common import canonical, digest, exclusive, load, module, need
from image_binding import complete_binding
from qualified_images import verify_images
from generate import source, SOURCE, SOURCE_TREE, MIGRATION


def qualify_migration(c,repo,work,binding,pg,network,url,source_archive,helpers):
    need(os.environ.get('CI') == os.environ.get('GITHUB_ACTIONS') == 'true' and socket.gethostname() != 'fai-crm-prod-02', 'M4_MIGRATION_CI_ONLY')
    proof=__import__('json').loads(source('scripts/m3-release/qualification.json'))['receipt']
    source_binding=binding|{'candidate':SOURCE,'candidateTree':SOURCE_TREE,
        'candidateCiImage':proof['candidateImageId'],'returnCiImage':proof['recoveryImageId'],
        'imageArchiveSha256':proof['imageArchiveSha256']}
    for role in ('candidate','return'):
        source_binding.pop(role+'Image',None);source_binding.pop(role+'ConfigDigest',None)
    source_binding=complete_binding(source_archive,source_binding)
    c.docker('CI_SOURCE_LOAD','load','--input',source_archive,seconds=300)
    verify_images(c,source_archive,source_binding)
    c.docker('CI_SOURCE_SCHEMA48','run','--rm','--network',network,'-e','DATABASE_URL='+url,'--entrypoint','node',
        source_binding['candidateImage'],'node_modules/prisma/build/index.js','migrate','deploy',seconds=240)
    remote=module(helpers/'remote_release.py','m4_generated_migration_ci',digest(helpers/'remote_release.py'))
    release=remote.Release.__new__(remote.Release)
    release.root=helpers
    release.work=work/'migration-proof';release.work.mkdir(mode=0o700)
    release.b=binding
    release.t={'postgresId':pg,'engineId':c.docker('CI_ENGINE_ID','info','--format','{{.ID}}').decode().strip()}
    release.manifest={'migrations':[MIGRATION]}
    release.run_id='d'*32
    # Production admission is exercised separately offline. Only network, lock and
    # synthetic gate fixtures change here; the generated migrator itself executes.
    release.stages=types.SimpleNamespace(result=lambda stage:{'status':'PASS','synthetic':True})
    release.observer=lambda:None
    release.models=lambda:({}, {})
    exclusive(release.work/'frozen-candidate.json',{'services':{'app':{'environment':{'DATABASE_URL':url}}}})
    tool=module(repo/'scripts/n05/failed_app_return.py','m4_ci_n05',binding['canonicalPrograms']['scripts/n05/failed_app_return.py'])
    tool.PRODUCTION_LOCK_PATH=work/'ci-migration-lock'
    release.n05=lambda:tool
    created=[]
    class BoundCommands:
        wall_end=time.time()+540
        mono_end=time.monotonic()+540
        def docker(self,operation,*args,**options):
            args=list(args)
            if operation=='MIGRATOR_CREATE':
                pos=args.index('--network')+1
                need(args[pos]=='fai-crm_default','CI_MIGRATION_NETWORK_BINDING')
                args[pos]=network
            out=c.docker(operation,*args,**options)
            if operation=='MIGRATOR_CREATE':created.append(out.decode().strip())
            return out
        def inspect(self,*args):return c.inspect(*args)
    release.c=BoundCommands()
    try:
        # Establish M1 through its real registry helper before changing schema.
        fixture="const{PrismaClient}=require('@prisma/client');const d=new PrismaClient();(async()=>{"
        fixture+="const u=await d.user.create({data:{email:'m2-r26@example.invalid',name:'Synthetic release admin',role:'admin',passwordHash:'NONLOGIN_SYNTHETIC'}});"
        fixture+="const m=await import('./src/lib/application-key-registry.ts');const rotate=m.rotatePrivilegedStepUpKeyVersion??m.default.rotatePrivilegedStepUpKeyVersion;"
        fixture+="await d.$transaction(tx=>rotate(tx,{version:1,keyDigest:Buffer.alloc(32,8),actorUserId:u.id}));console.log('SOURCE_M1_READY')"
        fixture+="})().catch(()=>{process.exitCode=2}).finally(()=>d.$disconnect());"
        need(c.docker('CI_SOURCE_M1_FIXTURE','run','--rm','--network',network,'-e','DATABASE_URL='+url,'--entrypoint','node',
            source_binding['candidateImage'],'--import','tsx','-e',fixture,seconds=90).decode().strip()=='SOURCE_M1_READY','CI_SOURCE_M1_FIXTURE')
        key_sql='''SELECT version::text||'|'||status||'|'||encode("keyDigest",'hex') FROM "ApplicationKeyVersion" ORDER BY version;'''
        key_before=release.sql(key_sql)
        result=release.migrate()
        need(result['before']==48 and result['after']==49 and result['prior48Unchanged'] and result['newMigrations']==[MIGRATION], 'CI_MIGRATION_RECEIPT')
        boxes=release.sql('''SELECT COUNT(*)::text||'|'||COUNT(*) FILTER (WHERE enabled OR "canSend" OR "canReceive")::text
          FROM "CommunicationMailbox";''').decode().strip()
        need(boxes=='7|0','CI_MIGRATION_MAILBOXES')
        need(release.sql(key_sql)==key_before,'CI_KEY_CHANGED_BY_MIGRATION')
        return result|{'synthetic':True,'productionConnected':False,'mailboxes':{'count':7,'enabled':0},
            'sourceImage':source_binding['candidateImage'],'keyRegistryPreserved':True}
    finally:
        for cid in created:
            state=c.inspect('container',cid)
            need(state['Id']==cid and state['Image']==binding['candidateImage'] and
                 state['Config']['Labels'].get('it.finanzaagevolaimpresa.release-run')=='d'*32,'CI_MIGRATOR_CLEANUP_IDENTITY')
            c.docker('CI_MIGRATOR_CLEANUP','rm','-f',cid)
