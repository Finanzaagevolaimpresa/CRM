import contextlib, copy, importlib.util, io, json, os, pathlib, subprocess, sys, tempfile, unittest
from unittest import mock
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
 def recreate_return(self,p,d,expected_app):
  self.snap['app']={'id':'b'*64,'created':'new','image_id':p['return_image']['id'],'config_sha256':p['configs']['return']['sha256'],'state':'healthy'}; return 'b'*64

def real_receipt(p,e,d,reason='unhealthy'):
 path=pathlib.Path(d)/'receipt.json'; p['receipt_path']=str(path); p['return_request_path']=str(pathlib.Path(d)/'request.json'); p['journal_path']=str(pathlib.Path(d)/'journal.json')
 receipt=n05.ForwardRecorder(e,lambda:1000).run(p,path)
 request={'schema':'FAI_CRM_N05_RETURN_REQUEST_V1','run_id':p['run_id'],'plan_sha256':n05.sha(p),'receipt_sha256':n05.sha(receipt),'reason':reason,'evidence':ref('functional-failure') if reason=='functional-failure' else None}
 return receipt,request

class Protocol(unittest.TestCase):
 def test_forward_preserves_source_when_return_artifacts_are_unavailable(self):
  for failure in ('image','config','replay'):
   p=plan();e=Engine(p)
   if failure=='image':e.image=lambda value,deadline:value!=p['return_image']
   if failure=='config':e.config_digest=lambda which,deadline:'0'*64 if which=='return' else p['configs'][which]['sha256']
   if failure=='replay':e.config_digest=lambda which,deadline:(_ for _ in ()).throw(n05.Denied('FROZEN_COMPOSE_REPLAY_MISMATCH')) if which=='return' else p['configs'][which]['sha256']
   with tempfile.TemporaryDirectory(dir=pathlib.Path.home(),prefix='.n05-return-preflight-') as d:
    pathlib.Path(d).chmod(0o700)
    with self.assertRaises(n05.Denied):real_receipt(p,e,d)
    self.assertEqual(e.snap['app']['id'],p['source_app']['id'])
    self.assertFalse(pathlib.Path(p['receipt_path']).exists())
 def test_output_aliases_and_existing_request_stop_forward_before_mutation(self):
  keys=('receipt_path','return_request_path','journal_path')
  for first,second in ((0,1),(0,2),(1,2)):
   p=plan();p[keys[second]]=p[keys[first]];e=Engine(p);e.remove_source=mock.Mock()
   with self.assertRaisesRegex(n05.Denied,'PROTOCOL_OUTPUT_PATH_ALIAS'):
    n05.ForwardRecorder(e,lambda:1000).run(p,pathlib.Path(p['receipt_path']))
   e.remove_source.assert_not_called()
  p=plan();p['receipt_path']=p['configs']['return']['path']
  with self.assertRaisesRegex(n05.Denied,'PROTOCOL_OUTPUT_INPUT_ALIAS'):n05.validate_plan(p,1000)
  for path in ('/private/./receipt.json','/private/a/../receipt.json','//private/receipt.json'):
   p=plan();p['receipt_path']=path
   with self.assertRaisesRegex(n05.Denied,'PRIVATE_OUTPUT_PATH_INVALID'):n05.validate_plan(p,1000)
  with tempfile.TemporaryDirectory(dir=pathlib.Path.home(),prefix='.n05-existing-output-') as d:
   private=pathlib.Path(d);private.chmod(0o700);p=plan();e=Engine(p)
   for key in keys:p[key]=str(private/(key+'.json'))
   request=pathlib.Path(p['return_request_path']);request.write_text('{}');request.chmod(0o600)
   with self.assertRaisesRegex(n05.Denied,'PROTOCOL_OUTPUT_ALREADY_EXISTS'):
    n05.ForwardRecorder(e,lambda:1000).run(p,pathlib.Path(p['receipt_path']))
   self.assertEqual(e.snap['app']['id'],p['source_app']['id'])
 def test_resource_consumer_inventory_includes_unlabeled_containers_and_fails_closed(self):
  p=plan();e=n05.DockerEngine(p,ROOT,command=['docker']);queries=[]
  values={'network=fai-crm_default':'a'*64,'volume=fai-crm_crm_documents':'b'*64,'volume=fai-crm_postgres_data':'c'*64}
  e.run=lambda *args,**kwargs:(queries.append(args) or values[args[-1]])
  self.assertEqual(e.protected_consumers(1500),set(values.values()))
  self.assertTrue(all(args[:4]==('ps','-aq','--no-trunc','--filter') for args in queries))
  e.run=lambda *args,**kwargs:(_ for _ in ()).throw(n05.Denied('DAEMON_UNCERTAIN'))
  with self.assertRaisesRegex(n05.Denied,'DAEMON_UNCERTAIN'):e.protected_consumers(1500)
 def test_qualification_binding_covers_operational_plan_without_hash_cycle(self):
  p=plan();binding=n05.evidence_binding(p)
  with tempfile.TemporaryDirectory(dir=pathlib.Path.home(),prefix='.n05-plan-binding-') as d:
   private=pathlib.Path(d);private.chmod(0o700);f=private/'synthetic-parser-evidence.json'
   document={'schema':'FAI_CRM_N05_EVIDENCE_V1','kind':'reviewed_plan','synthetic':False,'binding':binding,'result':'qualified','details':{'purpose':'parser unit fixture only'}}
   f.write_text(n05.canonical(document));f.chmod(0o600)
   reference={'path':str(f),'sha256':n05.hashlib.sha256(f.read_bytes()).hexdigest(),'kind':'reviewed_plan'}
   n05.validate_evidence(reference,p,binding)
   for section,key,value in [('candidate','id','sha256:'+'1'*64),('configs','candidate',ref('frozen-compose-candidate','f')),('source_app','id','1'*64),('postgres','id','2'*64),(None,'deadline_epoch',2100),(None,'return_request_path','/private/changed.json')]:
    changed=copy.deepcopy(p)
    if section:changed[section][key]=value
    else:changed[key]=value
    with self.assertRaisesRegex(n05.Denied,'EVIDENCE_BINDING_INVALID'):
     n05.validate_evidence(reference,changed,n05.evidence_binding(changed))
   changed=copy.deepcopy(p);changed['gates']['reviewed_plan']['sha256']='1'*64;changed['compatibility']['sha256']='2'*64
   self.assertEqual(n05.evidence_binding(changed),binding)
 def test_nonfinite_deadline_is_not_an_unbounded_operation(self):
  for value in (float('inf'),float('-inf'),float('nan')):
   p=plan();p['deadline_epoch']=value
   with self.assertRaises(n05.Denied):n05.validate_plan(p,1000)
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
 def test_frozen_models_pin_the_corresponding_image_before_replay(self):
  p=plan(); engine=n05.DockerEngine(p,ROOT,command=['docker'])
  with tempfile.TemporaryDirectory(dir=pathlib.Path.home(),prefix='.n05-image-binding-') as d:
   pathlib.Path(d).chmod(0o700)
   for which,expected in [('previous',p['source_app']['image_id']),('candidate',p['candidate']['id']),('return',p['return_image']['id'])]:
    path=pathlib.Path(d)/(which+'.json'); model={'services':{'app':{'image':expected}}}
    path.write_text(n05.canonical(model)); path.chmod(0o600)
    p['configs'][which]={'path':str(path),'sha256':n05.sha(model),'kind':'frozen-compose-'+which}
    with mock.patch.object(n05,'run_deadline',return_value=(0,n05.canonical(model),'')):
     self.assertEqual(engine.config_digest(which,n05.time.time()+30),n05.sha(model))
    for wrong in ('sha256:'+'0'*64,p['candidate']['tag']):
     model['services']['app']['image']=wrong; path.write_text(n05.canonical(model)); p['configs'][which]['sha256']=n05.sha(model)
     with mock.patch.object(n05,'run_deadline') as command:
      with self.assertRaisesRegex(n05.Denied,'FROZEN_APP_IMAGE_MISMATCH'):engine.config_digest(which,n05.time.time()+30)
      command.assert_not_called()
 def test_return_rechecks_app_at_last_mutation_boundary(self):
  p=plan(); expected={'id':'a'*64,'created':'candidate-created','image_id':p['candidate']['id'],'config_sha256':p['configs']['candidate']['sha256'],'state':'running-unhealthy'}
  changes=[None,*[expected|{key:value} for key,value in [('id','b'*64),('created','new'),('image_id',p['return_image']['id']),('config_sha256','0'*64),('state','healthy')]]]
  for changed in changes:
   engine=n05.DockerEngine(p,ROOT,command=['docker']); engine.config_digest=lambda which,deadline:p['configs'][which]['sha256']
   engine.snapshot=lambda deadline:{'app':changed}; engine.run=mock.Mock()
   with self.assertRaisesRegex(n05.Denied,'RETURN_APP_BOUNDARY_DRIFT'):engine.recreate_return(p,n05.time.time()+30,expected)
   engine.run.assert_not_called()
  engine.snapshot=lambda deadline:{'app':expected}
  with self.assertRaisesRegex(n05.Denied,'RETURN_APP_BOUNDARY_DRIFT'):engine.recreate_return(p,n05.time.time()+30,None)
  engine.run.assert_not_called()
 def test_created_wrong_image_is_never_started_in_either_path(self):
  p=plan()
  for returning in (False,True):
   engine=n05.DockerEngine(p,ROOT,command=['docker']); calls=[]; snapshot=Engine(p).snapshot(1500)
   engine.config_digest=lambda which,deadline:p['configs'][which]['sha256']
   engine.snapshot=lambda deadline:snapshot; engine.image=lambda value,deadline:True
   engine.run=lambda *args,**kwargs:(calls.append(args) or ('2.38.2' if args==('compose','version','--short') else ''))
   engine.ids=lambda service,deadline:['a'*64]
   engine.inspect=lambda *args,**kwargs:{'Id':'a'*64,'Created':'created','Image':'sha256:'+'0'*64}
   with self.assertRaisesRegex(n05.Denied,'RETURN_CREATED_IMAGE_MISMATCH' if returning else 'CANDIDATE_CREATED_IMAGE_MISMATCH'):
    if returning:engine.recreate_return(p,n05.time.time()+30,snapshot['app'])
    else:engine.create_candidate(p,n05.time.time()+30)
   self.assertTrue(any('--no-start' in command for command in calls))
   self.assertFalse(any(command[0]=='start' for command in calls))
 def test_app_change_between_controller_and_adapter_reads_stops_mutation(self):
  p=plan(); recorder=Engine(p)
  with tempfile.TemporaryDirectory(dir=pathlib.Path.home(),prefix='.n05-last-boundary-') as d:
   pathlib.Path(d).chmod(0o700); receipt,request=real_receipt(p,recorder,d)
   before=recorder.snapshot(1500); changed=copy.deepcopy(before); changed['app']['id']='b'*64
   observations=iter([before,changed]); engine=n05.DockerEngine(p,ROOT,command=['docker'])
   engine.snapshot=lambda deadline:next(observations); engine.image=lambda image,deadline:True
   engine.config_digest=lambda which,deadline:p['configs'][which]['sha256'];engine.run=mock.Mock()
   with self.assertRaisesRegex(n05.Denied,'RETURN_APP_BOUNDARY_DRIFT'):
    n05.ReturnController(engine,lambda:1000).return_app(p,receipt,request,pathlib.Path(p['journal_path']))
   engine.run.assert_not_called();self.assertEqual(json.loads(pathlib.Path(p['journal_path']).read_text())['result'],'FAILED')
 def test_starting_unknown_paused_and_dead_are_not_unhealthy(self):
  p=plan(); e=Engine(p)
  with tempfile.TemporaryDirectory(dir=pathlib.Path.home(),prefix='.n05-state-') as d:
   pathlib.Path(d).chmod(0o700); receipt,request=real_receipt(p,e,d)
   states=[{'Running':True,'Status':'running','Health':{'Status':'starting'}},
           {'Running':True,'Status':'running'},
           {'Running':True,'Status':'paused','Paused':True,'Health':{'Status':'unhealthy'}},
           {'Running':True,'Status':'restarting','Restarting':True,'Health':{'Status':'unhealthy'}},
           {'Running':False,'Status':'dead'}]
   for state in states:
    e.snap['app']['state']=n05.app_state({'State':state})
    with self.assertRaisesRegex(n05.Denied,'CANDIDATE_STATE_NOT_RETURNABLE'):
     n05.ReturnController(e,lambda:1000)._check(p,receipt,request)
   self.assertEqual(n05.app_state({'State':{'Running':True,'Health':{'Status':'unhealthy'}}}),'running-unhealthy')
   self.assertEqual(n05.app_state({'State':{'Running':False,'Status':'exited'}}),'exited')
 def test_forward_finishes_the_registered_migrator_before_transition(self):
  for invalid in (None,'running','ledger','resources'):
   p=plan(); p['migrator']={'id':'3'*64,'created':'migrator-created','image_id':'sha256:'+'2'*64,'role':'migrate','project':p['project']}
   e=Engine(p); e.snap['migrators']=[p['migrator']['id']]; removed=[]
   e.migrator=lambda identity,deadline:p['migrator']|{'state':'running' if invalid=='running' else 'exited','exit_code':0} if e.snap['migrators'] else None
   def remove(identity,deadline):removed.append(identity);e.snap['migrators']=[]
   e.remove_migrator=remove
   if invalid=='ledger':e.snap['ledger']['digest']='0'*64
   if invalid=='resources':e.snap['resources']['network']['Id']='0'*64
   with tempfile.TemporaryDirectory(dir=pathlib.Path.home(),prefix='.n05-migrator-') as d:
    pathlib.Path(d).chmod(0o700)
    if invalid:
     with self.assertRaises(n05.Denied):real_receipt(p,e,d)
     self.assertEqual(removed,[]);self.assertEqual(e.snap['app']['id'],p['source_app']['id'])
    else:
     receipt,request=real_receipt(p,e,d)
     self.assertEqual(removed,[p['migrator']['id']]);self.assertEqual(e.snap['migrators'],[])
     n05.validate_return_request(request,p,receipt)
 def test_production_entrypoint_forward_and_return_hold_real_lock_with_synthetic_io(self):
  # Host, daemon, Git and qualification I/O are synthetic. The actual private
  # file checks and flock run through both dispatch paths. CI provisions the
  # fixed production lock path on its isolated runner; local tests use home.
  p=plan();p['deadline_epoch']=n05.time.time()+30
  p['migrator']={'id':'3'*64,'created':'migrator-created','image_id':'sha256:'+'2'*64,'role':'migrate','project':p['project']}
  engine=Engine(p);engine.snap['migrators']=[p['migrator']['id']];events=[]
  engine.migrator=lambda identity,deadline:p['migrator']|{'state':'exited','exit_code':0} if engine.snap['migrators'] else None
  binding={'engine_id':p['engine']['id'],'project':p['project']}
  def assert_locked():
   with self.assertRaisesRegex(n05.Denied,'RETURN_LOCK_CONTENDED'):n05.acquire_lock(lock_path,binding)
  def remove(identity,deadline):
   assert_locked();events.append('migrator-removed-under-lock');engine.snap['migrators']=[]
  engine.remove_migrator=remove
  recreate=engine.recreate_return
  def recreate_locked(*args):
   assert_locked();events.append('return-under-lock');return recreate(*args)
  engine.recreate_return=recreate_locked
  def git(command,env,deadline,input_text=None):
   if command[3]=='branch':output='main'
   elif command[3]=='rev-parse':output=p['tools']['tree'] if command[-1]=='HEAD^{tree}' else p['tools']['commit']
   else:output=''
   return 0,output,''
  with tempfile.TemporaryDirectory(dir=pathlib.Path.home(),prefix='.n05-entrypoint-') as d:
   private=pathlib.Path(d);private.chmod(0o700)
   for key,name in [('receipt_path','receipt.json'),('return_request_path','request.json'),('journal_path','journal.json')]:p[key]=str(private/name)
   for reference in [*p['configs'].values(),*p['gates'].values(),p['compatibility']]:reference['path']=str(private/(reference['kind']+'.json'))
   plan_path=private/'plan.json';plan_path.write_text(n05.canonical(p));plan_path.chmod(0o600)
   canonical_lock=os.environ.get('N05_TEST_CANONICAL_LOCK')=='1'
   self.assertEqual(n05.PRODUCTION_LOCK_PATH,pathlib.Path('/run/fai-crm-n05/n05-failed-app-return.lock'))
   lock_path=n05.PRODUCTION_LOCK_PATH if canonical_lock else private/'synthetic-lock'
   env={'FAI_ENVIRONMENT':'production','FAI_ENVIRONMENT_SENTINEL':'FAI_CRM_PRODUCTION_V1','COMPOSE_PROJECT_NAME':'fai-crm'}
   with mock.patch.dict(os.environ,env,clear=True),mock.patch.object(n05.socket,'gethostname',return_value='fai-crm-prod-02'),mock.patch.object(n05,'validate_evidence'),mock.patch.object(n05,'run_deadline',side_effect=git),mock.patch.object(n05,'DockerEngine',return_value=engine) as adapter,mock.patch.object(n05,'PRODUCTION_LOCK_PATH',lock_path),contextlib.redirect_stdout(io.StringIO()):
    # Missing or writable lock parents must still fail before daemon access.
    bad_parent=private/'bad-lock-parent'
    with mock.patch.object(n05,'PRODUCTION_LOCK_PATH',bad_parent/'lock'):
     with self.assertRaises(OSError):n05.production_main(['failed_app_return.py','forward',str(plan_path)])
     bad_parent.mkdir(mode=0o775);bad_parent.chmod(0o775)
     with self.assertRaisesRegex(n05.Denied,'PRIVATE_PARENT_OWNER_MODE'):n05.production_main(['failed_app_return.py','forward',str(plan_path)])
    adapter.assert_not_called()
    n05.production_main(['failed_app_return.py','forward',str(plan_path)])
    receipt=json.loads(pathlib.Path(p['receipt_path']).read_text());n05.validate_receipt(receipt,p)
    os.close(n05.acquire_lock(lock_path,binding))
    request={'schema':'FAI_CRM_N05_RETURN_REQUEST_V1','run_id':p['run_id'],'plan_sha256':n05.sha(p),'receipt_sha256':n05.sha(receipt),'reason':'unhealthy','evidence':None}
    n05.atomic_json(pathlib.Path(p['return_request_path']),request)
    n05.production_main(['failed_app_return.py','return',str(plan_path)])
    os.close(n05.acquire_lock(lock_path,binding))
   self.assertEqual(events,['migrator-removed-under-lock','return-under-lock']);self.assertEqual(engine.snap['migrators'],[])
   self.assertEqual(engine.snap['app']['image_id'],p['return_image']['id'])
   if canonical_lock:print('N05_CANONICAL_LOCK_ENTRYPOINT_FORWARD_RETURN_PASS')
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
