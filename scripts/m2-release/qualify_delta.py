"""CI-only schema48 session settlement and isolated recovery on saved M2 images."""
import io
import os
from pathlib import Path
import secrets
import shutil
import socket
import sys
import tarfile
import time
import uuid

sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
REPO=HERE.parents[1]
sys.path.insert(0,str(HERE))
sys.path.insert(1,str(REPO/'scripts/m1-assisted'))
from common import Commands, Stop, canonical, decode, digest, exclusive, module, need
from isolated_restore import Restore, LEDGER_SQL, ledger_valid
from image_binding import complete_binding
from qualified_images import verify_images
import package_builder as builder
from registry_settlement import SQL, PREFLIGHT_SQL, COUNT_SQL, parse_counts


class CiCommands(Commands):
    def docker(self,command_id,*args,**options):
        endpoint=os.environ['M2_CI_DOCKER_SOCKET']
        if endpoint.startswith('/'): endpoint='unix://'+endpoint
        need(endpoint.startswith('unix:///') and socket.gethostname()!='fai-crm-prod-02' and
             os.environ.get('CI')==os.environ.get('GITHUB_ACTIONS')=='true','CI_DAEMON_ONLY')
        return self.run(command_id,[shutil.which('docker'),'--host',endpoint,*args],**options)


def main():
    need(os.environ.get('CI')==os.environ.get('GITHUB_ACTIONS')=='true' and
         socket.gethostname()!='fai-crm-prod-02','CI_SYNTHETIC_ONLY')
    need(len(sys.argv)==2,'QUALIFIED_IMAGE_ARCHIVE_REQUIRED')
    image_archive=Path(sys.argv[1]).resolve()
    run=uuid.uuid4().hex
    binding=decode(builder.render(run)['binding.json'])
    binding=complete_binding(image_archive,binding)
    c=CiCommands(1500,REPO)
    c.env.update(PATH=os.environ['PATH'],HOME=os.environ['HOME'])
    c.docker('CI_LOAD_SAVED_M2_IMAGES','load','--input',image_archive,seconds=300)
    images=verify_images(c,image_archive,binding)
    c.docker('CI_POSTGRES_IMAGE','pull','postgres:16-alpine',seconds=120)
    pg_image=c.inspect('image','postgres:16-alpine')['Id']
    work=REPO/('m2-release-ci-'+run)
    work.mkdir(mode=0o700)
    label='fai.synthetic=m2-release-r26'
    network=c.docker('CI_NETWORK','network','create','--internal','--label',label,'m2-release-'+run).decode().strip()
    created=[]
    password=secrets.token_hex(24)
    print('::add-mask::'+password,flush=True)
    url='postgresql://postgres:'+password+'@postgres:5432/m2_release_test'
    try:
        pg=c.docker('CI_POSTGRES_CREATE','create','--name','m2-release-'+run+'-pg','--network',network,
            '--network-alias','postgres','--label',label,'--restart','no',
            '--tmpfs','/var/lib/postgresql/data:rw,size=1610612736','-e','POSTGRES_PASSWORD='+password,
            '-e','POSTGRES_DB=m2_release_test',pg_image).decode().strip()
        created.append(pg)
        c.docker('CI_POSTGRES_START','start',pg)
        for _ in range(50):
            try:
                c.docker('CI_POSTGRES_READY','exec',pg,'pg_isready','-U','postgres','-d','m2_release_test')
                break
            except Stop: time.sleep(1)
        def sql(text):
            return c.docker('CI_FIXED_SQL','exec','-i',pg,'psql','-U','postgres','-d','m2_release_test',
                '-XqAt','-F','\t','-v','ON_ERROR_STOP=1',data=text.encode()).decode().strip()
        def node(text):
            return c.docker('CI_SAVED_APPLICATION_HELPER','run','--rm','--network',network,'-e','DATABASE_URL='+url,
                '--entrypoint','node',binding['candidateImage'],'--import','tsx','-e',text,seconds=90).decode().strip()
        c.docker('CI_SYNTHETIC_SCHEMA48','run','--rm','--network',network,'-e','DATABASE_URL='+url,'--entrypoint','node',
            binding['candidateImage'],'node_modules/prisma/build/index.js','migrate','deploy',seconds=240)
        rows=lambda:[line.split('\t') for line in sql(LEDGER_SQL).splitlines()]
        before=rows()
        ledger_valid(before,binding['ledger48'])
        node("const{PrismaClient}=require('@prisma/client');const d=new PrismaClient();(async()=>{"
             "const u=await d.user.create({data:{email:'m2-r26@example.invalid',name:'Synthetic release admin',role:'admin',passwordHash:'NONLOGIN_SYNTHETIC'}});"
             "const m=await import('./src/lib/application-key-registry.ts');const rotate=m.rotatePrivilegedStepUpKeyVersion??m.default.rotatePrivilegedStepUpKeyVersion;"
             "await d.$transaction(tx=>rotate(tx,{version:1,keyDigest:Buffer.alloc(32,8),actorUserId:u.id}));"
             "for(let i=1;i<=3;i++)await d.internalSession.create({data:{userId:u.id,tokenDigest:Buffer.alloc(32,i),expiresAt:new Date(Date.now()+(i===3?-60000:3600000))}});"
             "console.log('SYNTHETIC_FIXTURE_READY')})().catch(()=>{process.exitCode=2}).finally(()=>d.$disconnect());")
        fingerprint_sql='''SELECT md5(string_agg(id::text||encode("tokenDigest",'hex'),'|' ORDER BY id)) FROM "InternalSession";'''
        identity_before=sql(fingerprint_sql)
        audit_count=lambda:sql('''SELECT COUNT(*) FROM "AuditLog" WHERE event='sessions_revoked_global';''')
        need(sql(COUNT_SQL)=='2' and audit_count()=='0','SESSION_FIXTURE')
        need(parse_counts(sql(PREFLIGHT_SQL))=={'revokedCount':0,'auditCount':0} and sql(COUNT_SQL)=='2','PREFLIGHT_MUTATED_SESSIONS')
        readiness="const{PrismaClient}=require('@prisma/client');const d=new PrismaClient();(async()=>{const m=await import('./src/lib/internal-session-registry.ts');await (m.assertRegistryActivationReady??m.default.assertRegistryActivationReady)(d);console.log('READY')})().catch(()=>{process.exitCode=2}).finally(()=>d.$disconnect());"
        try: node(readiness)
        except Stop: pass
        else: raise Stop('LIVE_SESSION_GUARD_NOT_EXERCISED')
        # A rejected audit must roll back both the revoke and its counts.
        sql('''CREATE FUNCTION m2_ci_deny_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
          IF NEW.event='sessions_revoked_global' THEN RAISE EXCEPTION 'M2_SYNTHETIC_AUDIT_DENIED'; END IF; RETURN NEW; END$$;
          CREATE TRIGGER m2_ci_deny BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION m2_ci_deny_audit();''')
        try: sql(SQL)
        except Stop: pass
        else: raise Stop('AUDIT_FAILURE_NOT_EXERCISED')
        need(sql(COUNT_SQL)=='2' and audit_count()=='0' and sql(fingerprint_sql)==identity_before,'FAILED_AUDIT_LEFT_PARTIAL_REVOCATION')
        sql('DROP TRIGGER m2_ci_deny ON "AuditLog"; DROP FUNCTION m2_ci_deny_audit();')
        counts=parse_counts(sql(SQL))
        need(counts=={'revokedCount':2,'auditCount':1} and sql(COUNT_SQL)=='0' and audit_count()=='1','AUDITED_SETTLEMENT')
        need(sql(fingerprint_sql)==identity_before and sql('SELECT COUNT(*) FROM "InternalSession";')=='3','SESSION_ROWS_OR_DIGESTS_CHANGED')
        need(node(readiness)=='READY','REGISTRY_STARTUP_STILL_DENIED')
        need(parse_counts(sql(SQL))=={'revokedCount':0,'auditCount':0} and audit_count()=='1','SYNTHETIC_DUPLICATE_AUDIT')
        need(sql('''SELECT COUNT(*) FROM "ApplicationKeyVersion" WHERE purpose='PRIVILEGED_STEP_UP' AND version=1 AND status='ACTIVE';''')=='1','KEY_REGISTRY_CHANGED')
        backup=work/'set48'
        backup.mkdir(mode=0o700)
        with (backup/'postgres.dump').open('xb') as outgoing:
            c.docker('CI_NEW_SCHEMA48_DUMP','exec',pg,'pg_dump','-U','postgres','-d','m2_release_test','-Fc',output=outgoing)
        with tarfile.open(backup/'documents.tar.gz','w:gz') as archive:
            root=tarfile.TarInfo('.')
            root.type=tarfile.DIRTYPE
            root.mode,root.uid,root.gid=0o750,1001,1001
            archive.addfile(root)
            payload=b'M2 schema48 new-set recovery fixture\n'
            item=tarfile.TarInfo('./m2-synthetic.txt')
            item.size,item.mode,item.uid,item.gid=len(payload),0o640,1001,1001
            archive.addfile(item,io.BytesIO(payload))
        recovery=work/'recovery'
        recovery.mkdir(mode=0o700)
        kit=module(REPO/'scripts/n05/recovery_kit.py','m2_ci_recovery_kit',binding['canonicalPrograms']['scripts/n05/recovery_kit.py'])
        restored=Restore(c,recovery,run,pg_image,binding['candidateImage'],kit).run(backup,binding['ledger48'])
        need(rows()==before and c.inspect('container',pg)['State']['Running'],'SOURCE_CHANGED_BY_RECOVERY')
        result={'protocol':'FAI_M2_RELEASE_DELTA_QUALIFICATION_R26','status':'PASS','synthetic':True,
            'candidate':binding['candidate'],'imageArchiveSha256':binding['imageArchiveSha256'],
            'imageArchiveBytes':image_archive.stat().st_size,'qualifiedImages':images,
            'liveSessionGuardObserved':True,'preflightNoMutation':True,'auditFailureAtomicRollback':True,
            'sessionRowsAndDigestsPreserved':True,'auditedRevocationCounts':counts,'registryReadyAfterSettlement':True,
            'keyRegistryPreserved':True,'restore':restored,'ledger48Preserved':True,'migrationsRequiredInProduction':[],
            'productionConnected':False,'autonomyQualified':False}
        exclusive(REPO/'m2-release-ci-receipt.json',result)
        print(canonical(result).decode(),flush=True)
    finally:
        for cid in created:
            raw=c.inspect('container',cid)
            need(raw['Id']==cid and raw['Config']['Labels'].get('fai.synthetic')=='m2-release-r26','CI_CLEANUP_IDENTITY')
            c.docker('CI_CLEANUP','rm','-f',cid)
        need(c.inspect('network',network)['Id']==network,'CI_NETWORK_IDENTITY')
        c.docker('CI_NETWORK_CLEANUP','network','rm',network)


if __name__=='__main__':
    try: main()
    except Stop as exc:
        print(canonical({'status':'STOP','code':exc.code,'details':exc.details}).decode(),flush=True)
        raise SystemExit(2)
