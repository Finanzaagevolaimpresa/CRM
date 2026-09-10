"""Real Docker/Compose drill of the production daemon-facing adapter."""
import hashlib, importlib.util, json, os, pathlib, subprocess, sys, tempfile, time, uuid
ROOT=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('n05',ROOT/'scripts/n05/failed_app_return.py'); n05=importlib.util.module_from_spec(spec); spec.loader.exec_module(n05)

def run(*a,input=None,ok=True):
 r=subprocess.run(['docker',*a],input=input,text=True,capture_output=True,timeout=120)
 if ok:n05.require(r.returncode==0,'DRILL_DOCKER_FAILED')
 return r.stdout.strip()
def inspect(kind,x):return json.loads(run(kind,'inspect',x))[0]
def ref(path,kind):return {'path':str(path),'sha256':n05.sha(json.loads(path.read_text())),'kind':kind}
def image(tag,c,t):
 raw=inspect('image',tag); return {'tag':tag,'id':raw['Id'],'oci_commit':c,'oci_tree':t}
def build(tag,c,t):
 docker=f'''FROM alpine:3.20\nLABEL org.opencontainers.image.revision={c}\nLABEL it.finanzaagevolaimpresa.source-tree={t}\n'''
 run('build','-q','-t',tag,'-f','-', '.',input=docker)
def freeze(project,source,env,destination):
 out=run('compose','-p',project,'--env-file',str(env),'-f',str(source),'config','--format','json')
 destination.write_text(n05.canonical(json.loads(out))); destination.chmod(0o600)

def scenario(reason,tags,private,registered):
 project='fai-crm-n05-synthetic-'+uuid.uuid4().hex[:12]; env=private/(project+'.env'); env.write_text('\n'); env.chmod(0o600)
 compose=private/(project+'.yml')
 def model(tag,command,health):
  return {'name':project,'services':{'app':{'image':tag,'command':['sh','-c',command],
   'healthcheck':{'test':['CMD','sh','-c',health],'interval':'1s','timeout':'1s','retries':2},
   'volumes':[{'type':'volume','source':'crm_documents','target':'/var/lib/fai-crm/documents'}],
   'networks':{'default':None},'environment':{'FEATURE_INTEGRATIONS_ENABLED':'false'}},
   'postgres':{'image':'postgres:16-alpine','environment':{'POSTGRES_PASSWORD':'synthetic','POSTGRES_DB':'synthetic'},
   'healthcheck':{'test':['CMD-SHELL','pg_isready -U postgres -d synthetic'],'interval':'1s','timeout':'1s','retries':30},
   'volumes':[{'type':'volume','source':'postgres_data','target':'/var/lib/postgresql/data'}], 'networks':{'default':None}}},
   'volumes':{'crm_documents':{'name':project+'_crm_documents'},'postgres_data':{'name':project+'_postgres_data'}},
   'networks':{'default':{'name':project+'_default'}}}
 source=model(tags[0],'while :; do sleep 60; done','true')
 compose.write_text(n05.canonical(source)); compose.chmod(0o600)
 run('compose','-p',project,'--env-file',str(env),'-f',str(compose),'up','-d');
 ids=run('ps','-aq','--filter','label=com.docker.compose.project='+project).split(); registered.extend(('container',x) for x in ids)
 registered[0:0]=[('network',project+'_default'),('volume',project+'_crm_documents'),('volume',project+'_postgres_data')]
 for _ in range(40):
  pgids=run('ps','-aq','--filter','label=com.docker.compose.project='+project,'--filter','label=com.docker.compose.service=postgres').split()
  appids=run('ps','-aq','--filter','label=com.docker.compose.project='+project,'--filter','label=com.docker.compose.service=app').split()
  if pgids and appids and inspect('container',pgids[0])['State'].get('Health',{}).get('Status')=='healthy' and inspect('container',appids[0])['State'].get('Health',{}).get('Status')=='healthy':break
  time.sleep(1)
 pg=inspect('container',pgids[0]); run('exec','-i',pg['Id'],'psql','-U','postgres','-d','synthetic','-v','ON_ERROR_STOP=1',input='CREATE TABLE _prisma_migrations(id text,migration_name text,checksum text,started_at timestamptz,finished_at timestamptz,rolled_back_at timestamptz,applied_steps_count int); INSERT INTO _prisma_migrations VALUES(\'1\',\'synthetic_001\',\'checksum\',now(),now(),null,1);')
 migrator=run('create','--label','com.docker.compose.project='+project,'--label','com.docker.compose.service=migrate','alpine:3.20','true'); registered.append(('container',migrator)); run('start','-a',migrator)
 migrator_raw=inspect('container',migrator)
 appid=run('ps','-aq','--filter','label=com.docker.compose.project='+project,'--filter','label=com.docker.compose.service=app'); run('exec',appid,'sh','-c','echo preserved >/var/lib/fai-crm/documents/sentinel')
 configs={}
 states={'functional-failure':('while :; do sleep 60; done','true'),'unhealthy':('while :; do sleep 60; done','false'),'exited':('exit 17','true'),'absent':('while :; do sleep 60; done','true')}
 for name,value in [('previous',source),('candidate',model(tags[1],*states[reason])),('return',model(tags[2],'while :; do sleep 60; done','true'))]:
  raw=private/f'{project}-{name}-raw.json'; raw.write_text(n05.canonical(value)); raw.chmod(0o600); frozen=private/f'{project}-{name}.json'; freeze(project,raw,env,frozen); configs[name]=ref(frozen,'frozen-compose-'+name)
 info=json.loads(run('info','--format','{{json .}}')); engine_id={'kind':'docker','host':'unix:///var/run/docker.sock','id':info['ID'],'name':info['Name'],'os_type':info['OSType']}
 a=inspect('container',appid); volumes={}
 for logical in ('crm_documents','postgres_data'):
  v=inspect('volume',project+'_'+logical); volumes[logical]={k:v[k] for k in ('Name','Driver','Mountpoint','CreatedAt','Labels','Options','Scope')}
 nw=inspect('network',project+'_default'); network={k:nw[k] for k in ('Id','Name','Created','Driver','Scope','Labels','Options','IPAM','Internal','Attachable','Ingress')}
 base={'schema':'FAI_CRM_N05_FAILED_APP_RETURN_V2','run_id':'synthetic-'+uuid.uuid4().hex[:20],'engine':engine_id,'project':project,
 'tools':{'commit':'a'*40,'tree':'b'*40,'ci_sha':'a'*40,'ci_conclusion':'success'},'source_app':{'id':a['Id'],'created':a['Created'],'image_id':a['Image']},
 'candidate':image(tags[1],'c'*40,'d'*40),'return_image':image(tags[2],'e'*40,'f'*40),'postgres':{'id':pg['Id'],'image':pg['Image'],'created':pg['Created']},
 'resources':{'volumes':volumes,'network':network},'configs':configs,'ledger':{'schema':'synthetic-v1','count':1,'digest':'0'*64},
 'compatibility':{'path':'/x','sha256':'5'*64,'kind':'return-image-schema-compatibility'},'deadline_epoch':time.time()+180,
 'gates':{x:{'path':'/x','sha256':str(i)*64,'kind':x} for x,i in [('recovery',6),('artifacts',7),('reviewed_plan',8),('authorization',9)]},
 'return_policy':{'allowed_reasons':['functional-failure','unhealthy','exited','absent']},
 'migrator':{'id':migrator_raw['Id'],'created':migrator_raw['Created'],'image_id':migrator_raw['Image'],'role':'migrate','project':project},
 'receipt_path':str(private/(project+'-receipt.json')),'return_request_path':str(private/(project+'-request.json')),'journal_path':str(private/(project+'-journal.json'))}
 adapter=n05.DockerEngine(base,ROOT,files=[compose],env_file=env,command=['docker'],synthetic_candidate_absence=reason=='absent',
                          created_callback=lambda identity: registered.append(('container',identity)))
 base['ledger']=adapter.ledger(pg['Id'],base['deadline_epoch'])
 n05.finish_registered_migrator(adapter,base)
 receipt=n05.ForwardRecorder(adapter).run(base,pathlib.Path(base['receipt_path']))
 request={'schema':'FAI_CRM_N05_RETURN_REQUEST_V1','run_id':base['run_id'],'plan_sha256':n05.sha(base),'receipt_sha256':n05.sha(receipt),'reason':reason,'evidence':{'path':'/synthetic/functional.json','sha256':'a'*64,'kind':'functional-failure'} if reason=='functional-failure' else None}
 n05.validate_return_request(request,base,receipt)
 # Concrete stopped foreign container must block, then exact cleanup permits return.
 foreign=run('create','--label','com.docker.compose.project='+project,'alpine:3.20','true'); registered.append(('container',foreign))
 try:n05.ReturnController(adapter).return_app(base,receipt,request,pathlib.Path(base['journal_path'])); raise RuntimeError('FOREIGN_ACCEPTED')
 except n05.Denied:pass
 # Pre-mutation denial did not create the attempt journal.
 run('rm',foreign); registered.remove(('container',foreign))
 n05.ReturnController(adapter).return_app(base,receipt,request,pathlib.Path(base['journal_path']))
 returned=run('ps','-aq','--filter','label=com.docker.compose.project='+project,'--filter','label=com.docker.compose.service=app')
 n05.require(run('exec',pg['Id'],'psql','-U','postgres','-d','synthetic','-Atc','select count(*) from _prisma_migrations')=='1','LEDGER_SENTINEL_LOST')
 n05.require(run('exec',returned,'cat','/var/lib/fai-crm/documents/sentinel')=='preserved','DOCUMENT_SENTINEL_LOST')

def main():
 n05.require(os.environ.get('N05_FAILED_RETURN_SYNTHETIC_CONFIRMED')=='1','SYNTHETIC_CONFIRMATION_REQUIRED')
 registered=[]
 with tempfile.TemporaryDirectory(dir=pathlib.Path.home(),prefix='.n05-real-drill-') as d:
  private=pathlib.Path(d); private.chmod(0o700); suffix=uuid.uuid4().hex[:10]; tags=[f'n05-source:{suffix}',f'n05-candidate:{suffix}',f'n05-return:{suffix}']
  try:
   build(tags[0],'9'*40,'8'*40); build(tags[1],'c'*40,'d'*40); build(tags[2],'e'*40,'f'*40)
   for reason in ('functional-failure','unhealthy','exited','absent'):scenario(reason,tags,private,registered)
   print('N05_FAILED_APP_RETURN_SYNTHETIC_DOCKER_PASS')
  finally:
   primary_error=sys.exc_info()[0] is not None; cleanup_errors=[]
   for kind,x in reversed(registered):
    command=['docker','rm','-f',x] if kind=='container' else ['docker',kind,'rm',x]
    r=subprocess.run(command,capture_output=True)
    if r.returncode!=0 and b'No such' not in r.stderr:cleanup_errors.append((kind,x))
   for tag in tags:subprocess.run(['docker','image','rm','-f',tag],capture_output=True)
   for kind,x in registered:
    command=['docker','container','inspect',x] if kind=='container' else ['docker',kind,'inspect',x]
    if subprocess.run(command,capture_output=True).returncode==0:cleanup_errors.append((kind,x))
   if cleanup_errors and not primary_error:raise n05.Denied('DRILL_CLEANUP_FAILED')
if __name__=='__main__':main()
