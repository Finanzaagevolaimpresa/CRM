import copy, importlib.util, json, os, pathlib, subprocess, sys, tempfile, unittest
ROOT=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('n05',ROOT/'scripts/n05/failed_app_return.py'); n05=importlib.util.module_from_spec(spec); spec.loader.exec_module(n05)

def ref(kind,n='a'): return {'path':'/private/'+kind+'.json','sha256':n*64,'kind':kind}
def plan(reason='unhealthy'):
 image=lambda c:{'tag':'fai-crm:pr1-'+c*12,'id':'sha256:'+c*64,'oci_commit':c*40,'oci_tree':chr(ord(c)+1)*40}
 return {'schema':'FAI_CRM_N05_FAILED_APP_RETURN_V2','run_id':'synthetic-run-0001',
  'engine':{'kind':'docker','host':'unix:///var/run/docker.sock','id':'synthetic-engine','name':'synthetic-daemon','os_type':'linux'},'project':'fai-crm',
  'tools':{'commit':'a'*40,'tree':'b'*40,'ci_sha':'a'*40,'ci_conclusion':'success'},
  'source_app':{'id':'9'*64,'created':'source-created','image_id':'sha256:'+'8'*64},
  'candidate':image('c'),'return_image':image('e'),'postgres':{'id':'f'*64,'image':'sha256:'+'7'*64,'created':'created-pg'},
  'resources':{'volumes':{x:{'Name':x,'Driver':'local','Mountpoint':'/var/'+x,'CreatedAt':'now','Labels':{},'Options':{},'Scope':'local'} for x in ('crm_documents','postgres_data')},
               'network':{'Id':'6'*64,'Name':'net','Created':'now','Driver':'bridge','Scope':'local','Labels':{},'Options':{},'IPAM':{},'Internal':False,'Attachable':False,'Ingress':False}},
  'configs':{x:ref('frozen-compose-'+x,str(i)) for x,i in [('previous',1),('candidate',2),('return',3)]},
  'ledger':{'schema':'v44','count':44,'digest':'4'*64},'compatibility':ref('return-image-schema-compatibility','5'),
  'deadline_epoch':2000,'gates':{x:ref(x,str(i)) for x,i in [('recovery',6),('artifacts',7),('reviewed_plan',8),('authorization',9)]},
  'return_policy':{'allowed_reasons':['functional-failure','unhealthy','exited','absent']},
  'migrator':None,
  'receipt_path':'/private/receipt.json','return_request_path':'/private/request.json','journal_path':'/private/journal.json'}

class Engine:
 def __init__(self,p,reason='unhealthy',absent_forward=False):
  self.p=p; self.done=set(); self.absent_forward=absent_forward; self.reason=reason
  self.snap={'engine':p['engine'],'project':p['project'],'postgres':copy.deepcopy(p['postgres']),'resources':copy.deepcopy(p['resources']),
   'postgres_healthy':True,'migrators':[],'foreign_containers':[],'ledger':copy.deepcopy(p['ledger']),
   'app':{'id':'9'*64,'created':'source-created','image_id':p['source_app']['image_id'],'config_sha256':p['configs']['previous']['sha256'],'state':'healthy'}}
 def snapshot(self,d): return copy.deepcopy(self.snap)
 def config_digest(self,w,d): return self.p['configs'][w]['sha256']
 def image(self,s,d): return True
 def validate_boundary(self,p,s,d,returning=False):
  if s['postgres']!=p['postgres'] or s['resources']!=p['resources'] or s['ledger']!=p['ledger'] or s['foreign_containers'] or s['migrators']: raise n05.Denied('MUTATION_BOUNDARY_DRIFT')
 def remove_source(self,i,d):
  if self.snap['app']['id']!=i: raise n05.Denied('SOURCE_IDENTITY_DRIFT')
  self.snap['app']=None
 def observe_app_absence(self,d): return self.snap['app'] is None
 def create_candidate(self,p,d):
  if self.absent_forward:return None
  state={'functional-failure':'healthy','unhealthy':'running-unhealthy','exited':'exited','absent':'exited'}[self.reason]
  self.snap['app']={'id':'a'*64,'created':'candidate-created','image_id':p['candidate']['id'],'config_sha256':p['configs']['candidate']['sha256'],'state':state}
  return {k:self.snap['app'][k] for k in ('id','created','image_id')}
 def start_candidate(self,i,d): pass
 def attempted(self,r): return r in self.done
 def mark_attempt(self,r): self.done.add(r)
 def recreate_return(self,p,d):
  self.snap['app']={'id':'b'*64,'created':'new','image_id':p['return_image']['id'],'config_sha256':p['configs']['return']['sha256'],'state':'healthy'}; return 'b'*64

def real_receipt(p,e,d,reason='unhealthy'):
 path=pathlib.Path(d)/'receipt.json'; p['receipt_path']=str(path); p['return_request_path']=str(pathlib.Path(d)/'request.json'); p['journal_path']=str(pathlib.Path(d)/'journal.json')
 receipt=n05.ForwardRecorder(e,lambda:1000).run(p,path)
 request={'schema':'FAI_CRM_N05_RETURN_REQUEST_V1','run_id':p['run_id'],'plan_sha256':n05.sha(p),'receipt_sha256':n05.sha(receipt),'reason':reason,'evidence':ref('functional-failure') if reason=='functional-failure' else None}
 return receipt,request

class Protocol(unittest.TestCase):
 def test_unverified_strings_are_not_gates(self):
  p=plan(); p['gates']={k:'unverified' for k in p['gates']}
  with self.assertRaisesRegex(n05.Denied,'PRODUCTION_GATES_INCOMPLETE'): n05.validate_plan(p,1000)
 def test_nonfinite_duplicate_and_nested_extra_rejected(self):
  p=plan(); p['return_image']['extra']=True
  with self.assertRaises(n05.Denied): n05.validate_plan(p,1000)
  with tempfile.TemporaryDirectory(dir=pathlib.Path.home(),prefix='.n05-json-') as d:
   pathlib.Path(d).chmod(0o700); f=pathlib.Path(d)/'x'; f.write_text('{"a":1,"a":2}'); f.chmod(0o600)
   with self.assertRaises(n05.Denied): n05.strict_json(f)
   f.write_text('{"a":NaN}')
   with self.assertRaises(n05.Denied): n05.strict_json(f)
 def test_evidence_requires_digest_binding_and_non_synthetic_qualification(self):
  p=plan(); binding={'run_id':p['run_id']}
  with tempfile.TemporaryDirectory(dir=pathlib.Path.home(),prefix='.n05-evidence-') as d:
   pathlib.Path(d).chmod(0o700); f=pathlib.Path(d)/'gate.json'
   doc={'schema':'FAI_CRM_N05_EVIDENCE_V1','kind':'recovery','synthetic':True,'binding':binding,'result':'qualified','details':{'restore':'measured'}}
   f.write_text(n05.canonical(doc)); f.chmod(0o600); r={'path':str(f),'sha256':n05.hashlib.sha256(f.read_bytes()).hexdigest(),'kind':'recovery'}
   with self.assertRaisesRegex(n05.Denied,'PRODUCTION_EVIDENCE_NOT_QUALIFIED'): n05.validate_evidence(r,p,binding)
   doc['synthetic']=False; f.write_text(n05.canonical(doc)); r['sha256']=n05.hashlib.sha256(f.read_bytes()).hexdigest()
   self.assertEqual(n05.validate_evidence(r,p,binding)['result'],'qualified')
 def test_canonical_lock_contends_and_binds_engine_project(self):
  with tempfile.TemporaryDirectory(dir=pathlib.Path.home(),prefix='.n05-lock-') as d:
   pathlib.Path(d).chmod(0o700); path=pathlib.Path(d)/'lock'; binding={'engine_id':'one','project':'fai-crm'}
   fd=n05.acquire_lock(path,binding)
   try:
    with self.assertRaisesRegex(n05.Denied,'RETURN_LOCK_CONTENDED'): n05.acquire_lock(path,binding)
   finally: os.close(fd)
   with self.assertRaisesRegex(n05.Denied,'LOCK_BINDING_MISMATCH'): n05.acquire_lock(path,{'engine_id':'two','project':'fai-crm'})
 def test_global_deadline_terminates_subprocess_group(self):
  with self.assertRaisesRegex(n05.Denied,'SUBPROCESS_DEADLINE_EXPIRED'):
   n05.run_deadline(['bash','-c','sleep 30 & wait'],os.environ.copy(),n05.time.time()+0.05)
 def test_ledger_defaults_postgres_user_without_weakening_rows(self):
  p=plan(); engine=n05.DockerEngine(p,ROOT,command=['docker']); captured=[]
  engine.run=lambda *args,**kwargs:(captured.extend(args) or 'migration_001\tchecksum\tstarted\tfinished\t\t1\n')
  self.assertEqual(engine.ledger('f'*64,1500)['count'],1)
  self.assertIn('POSTGRES_USER:-postgres',captured[4])
  engine.run=lambda *args,**kwargs:'migration_001\tchecksum\tstarted\t\t\t0\n'
  with self.assertRaisesRegex(n05.Denied,'LEDGER_INCOMPLETE_FAILED_OR_ROLLED_BACK'): engine.ledger('f'*64,1500)
 def test_handwritten_two_event_absence_denied(self):
  p=plan('absent'); a=n05.event(None,p['run_id'],'healthy-source','verified',{}); b=n05.event(a,p['run_id'],'forward-result','candidate-absent-attributed',{'absence_attributed':True})
  r={'schema':'FAI_CRM_N05_FORWARD_RECEIPT_V1','run_id':p['run_id'],'engine':p['engine'],'project':p['project'],'plan_sha256':n05.sha(p),'lock_id':p['engine']['id']+':fai-crm','events':[a,b]}
  with self.assertRaisesRegex(n05.Denied,'FORWARD_SEQUENCE_INCOMPLETE'): n05.validate_receipt(r,p)
 def test_native_null_volume_metadata_is_preserved_and_drift_denied(self):
  p=plan(); p['resources']['volumes']['crm_documents'].update(Labels=None,Options=None)
  n05.validate_plan(p,1000)
  e=Engine(p); e.snap['resources']['volumes']['crm_documents']['Options']={}
  with self.assertRaisesRegex(n05.Denied,'PERSISTENT_RESOURCE_DRIFT'):
   n05.ReturnController(e,lambda:1000)._check(p)
  p['resources']['volumes']['crm_documents']['Options']=[]
  with self.assertRaisesRegex(n05.Denied,'VOLUME_SPEC_INVALID'): n05.validate_plan(p,1000)
 def test_real_adapter_failed_create_requires_fresh_absence_and_boundary(self):
  p=plan(); engine=n05.DockerEngine(p,ROOT,command=['docker']); checked=[]
  engine.config_digest=lambda which,deadline:p['configs'][which]['sha256']
  engine.run=lambda *args,**kwargs:(_ for _ in ()).throw(n05.Denied('DOCKER_COMMAND_FAILED'))
  engine.snapshot=lambda deadline:{'app':None}
  engine.validate_boundary=lambda *args,**kwargs:checked.append(args[1])
  self.assertIsNone(engine.create_candidate(p,1500)); self.assertEqual(checked,[{'app':None}])
  engine.snapshot=lambda deadline:{'app':{'id':'partial'}}
  with self.assertRaisesRegex(n05.Denied,'FAILED_CREATE_LEFT_CANDIDATE'): engine.create_candidate(p,1500)
  engine.snapshot=lambda deadline:(_ for _ in ()).throw(n05.Denied('DAEMON_UNCERTAIN'))
  with self.assertRaisesRegex(n05.Denied,'DAEMON_UNCERTAIN'): engine.create_candidate(p,1500)
  engine.snapshot=lambda deadline:{'app':None}
  engine.validate_boundary=lambda *args,**kwargs:(_ for _ in ()).throw(n05.Denied('MUTATION_BOUNDARY_DRIFT'))
  with self.assertRaisesRegex(n05.Denied,'MUTATION_BOUNDARY_DRIFT'): engine.create_candidate(p,1500)
 def test_create_timeout_never_produces_an_absence_receipt(self):
  p=plan(); engine=n05.DockerEngine(p,ROOT,command=['docker'])
  engine.config_digest=lambda which,deadline:p['configs'][which]['sha256']
  engine.run=lambda *args,**kwargs:(_ for _ in ()).throw(n05.Denied('SUBPROCESS_DEADLINE_EXPIRED'))
  engine.snapshot=lambda deadline:self.fail('a deadline is not an absence observation')
  with self.assertRaisesRegex(n05.Denied,'SUBPROCESS_DEADLINE_EXPIRED'):engine.create_candidate(p,1500)
 def test_true_forward_receipts_and_four_return_states(self):
  for reason in ('functional-failure','unhealthy','exited','absent'):
   p=plan(reason); e=Engine(p,reason,reason=='absent')
   with tempfile.TemporaryDirectory(dir=pathlib.Path.home(),prefix='.n05-protocol-') as d:
    pathlib.Path(d).chmod(0o700); r,q=real_receipt(p,e,d,reason)
    out=pathlib.Path(p['journal_path']); got=n05.ReturnController(e,lambda:1000).return_app(p,r,q,out)
    self.assertEqual(got['result'],'PASS'); self.assertEqual(json.loads(out.read_text())['result'],'PASS')
 def test_post_forward_request_is_bound_and_cannot_relabel_outcome(self):
  p=plan(); e=Engine(p,'unhealthy')
  with tempfile.TemporaryDirectory(dir=pathlib.Path.home(),prefix='.n05-request-') as d:
   pathlib.Path(d).chmod(0o700); receipt,request=real_receipt(p,e,d,'unhealthy')
   for changed in (request|{'reason':'exited'},request|{'receipt_sha256':'0'*64},request|{'plan_sha256':'0'*64}):
    with self.assertRaises(n05.Denied): n05.validate_return_request(changed,p,receipt)
 def test_identity_runtime_resource_ledger_and_inventory_drift(self):
  mutations=[('app','created','changed'),('app','image_id','sha256:'+'0'*64),('app','config_sha256','0'*64),('postgres',None,{'id':'other'}),('resources',None,{}),('ledger',None,{}),('foreign_containers',None,['stopped-stranger']),('migrators',None,['migrate-id'])]
  for root,key,value in mutations:
   p=plan(); e=Engine(p)
   with tempfile.TemporaryDirectory(dir=pathlib.Path.home(),prefix='.n05-drift-') as d:
    pathlib.Path(d).chmod(0o700); r,q=real_receipt(p,e,d)
    if key:e.snap[root][key]=value
    else:e.snap[root]=value
    with self.subTest(root=root,key=key),self.assertRaises(n05.Denied): n05.ReturnController(e,lambda:1000).return_app(p,r,q,pathlib.Path(p['journal_path']))
 def test_failed_attempt_is_durable_across_engine_restart(self):
  p=plan(); e=Engine(p)
  with tempfile.TemporaryDirectory(dir=pathlib.Path.home(),prefix='.n05-attempt-') as d:
   pathlib.Path(d).chmod(0o700); r,q=real_receipt(p,e,d); e.recreate_return=lambda *x:(_ for _ in ()).throw(n05.Denied('SYNTHETIC_MUTATION_FAILED'))
   journal=pathlib.Path(p['journal_path'])
   with self.assertRaises(n05.Denied): n05.ReturnController(e,lambda:1000).return_app(p,r,q,journal)
   self.assertEqual(json.loads(journal.read_text())['result'],'FAILED')
   with self.assertRaisesRegex(n05.Denied,'RETURN_ALREADY_ATTEMPTED'): n05.ReturnController(Engine(p),lambda:1000).return_app(p,r,q,journal)
 def test_incomplete_forward_on_observation_error_denied(self):
  p=plan('absent'); e=Engine(p,absent_forward=True); e.observe_app_absence=lambda d: (_ for _ in ()).throw(n05.Denied('DAEMON_UNCERTAIN'))
  with tempfile.TemporaryDirectory(dir=pathlib.Path.home(),prefix='.n05-incomplete-') as d:
   pathlib.Path(d).chmod(0o700); path=pathlib.Path(d)/'receipt'; p['receipt_path']=str(path); p['return_request_path']=str(pathlib.Path(d)/'request'); p['journal_path']=str(pathlib.Path(d)/'journal')
   with self.assertRaises(n05.Denied): n05.ForwardRecorder(e,lambda:1000).run(p,path)
   with self.assertRaises(n05.Denied): n05.validate_receipt(json.loads(path.read_text()),p)
 def test_entry_rejects_before_private_read_or_daemon(self):
  env={'PATH':os.environ['PATH'],'FAI_ENVIRONMENT':'synthetic','FAI_ENVIRONMENT_SENTINEL':'x','COMPOSE_PROJECT_NAME':'x'}
  r=subprocess.run([sys.executable,str(ROOT/'scripts/n05/failed_app_return.py'),'return','/does/not/exist'],env=env,text=True,capture_output=True)
  self.assertNotEqual(r.returncode,0); self.assertEqual(r.stderr.strip(),'N05_FAILED|code=PRODUCTION_IDENTITY_DENIED')

if __name__=='__main__':unittest.main()
