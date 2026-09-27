"""Generated-deploy admission and consumed-run boundaries; no production calls."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0,str(HERE))
sys.path.insert(1,str(REPO/'scripts/m1-assisted'))
from common import Stop, canonical, digest, exclusive, load, private, value_sha
import package_builder as builder
import completed_release as history
import release_evidence as evidence

def reader(path, ref='HEAD'):
    return (REPO/path).read_bytes() if path.startswith('scripts/m2-release/') else builder.source(path,ref)

def import_file(path, name):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module

def fixture_plan():
    return {'project':'fai-crm','source_app':{'id':'a'*64,'image_id':'sha256:'+'b'*64},
        'postgres':{'id':'c'*64,'image':'sha256:'+'d'*64,'created':'synthetic-pg'},
        'configs':{},'ledger':{'schema':'prisma-m1-48'}}

class MutationBoundary(Exception):pass

class DeployTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir=Path.home() if os.name!='nt' else REPO)
        self.root=Path(self.temp.name);self.root.chmod(0o700)
        self.files=builder.render('e'*32,reader)
        for name,raw in self.files.items():exclusive(self.root/name,raw)
        self.transition=import_file(self.root/'transition_base.py','r31_transition')
        self.b=json.loads(self.files['binding.json'])
        self.review={'reference':'https://example.invalid/review',**evidence.details(self.b)}
        if os.name=='nt':self.fcntl=patch.dict(sys.modules,{'fcntl':types.ModuleType('fcntl')});self.fcntl.start()
        self.n05=import_file(REPO/'scripts/n05/failed_app_return.py','r31_n05')
        self.work=self.root/'work';self.work.mkdir(mode=0o700)
        self.runtime=self.root/'runtime';self.runtime.mkdir(mode=0o700)
        self.baseline={'engine':{'kind':'docker','host':'unix:///var/run/docker.sock','id':'synthetic',
            'name':'synthetic','os_type':'linux'},
            'app':{'id':'a'*64,'created':'synthetic-app','image_id':'sha256:'+'b'*64},
            'resources':{'volumes':{x:{'Name':x,'Driver':'local','Mountpoint':'/var/'+x,'CreatedAt':'now',
                'Labels':None,'Options':None,'Scope':'local'} for x in ('crm_documents','postgres_data')},
                'network':{'Id':'f'*64,'Name':'fai-crm_default','Created':'now','Driver':'bridge',
                    'Scope':'local','Labels':{},'Options':{},'IPAM':{},'Internal':False,'Attachable':False,'Ingress':False}}}
        backup=self.root/'evidence-backup48-synthetic';backup.mkdir(mode=0o700)
        exclusive(backup/'BASELINE.json',self.baseline)
        p=fixture_plan()
        for name in ('previous','candidate','return'):
            f=self.work/('frozen-'+name+'.json');exclusive(f,{'fixture':'synthetic '+name})
            p['configs'][name]={'path':str(f),'sha256':digest(f),'kind':'frozen-compose-'+name}
        exclusive(self.work/'models.json',p)
        self.r=self.transition.Release()
        self.r.b=self.b;self.r.review=self.review;self.r.work=self.work;self.r.runtime=self.runtime
        self.r.run_id='e'*32;self.r.backup_run_id='synthetic'
        self.r.manifest={'authorityReference':'https://example.invalid/authority','deltaSha256':'d'*64}
        self.r.c=types.SimpleNamespace(cwd=None)
        self.r.require_config_binding=lambda:None
        self.r.rows=lambda _: []
        self.r.completed_result=lambda stage: ({'ledgerDigest':value_sha([]),'migrator':None} if stage=='migrate'
            else {'runId':history.RUN,'stage':stage,'status':'PASS','scope':'UNIT_FIXTURE'})
        self.r.n05=lambda:self.n05
        self.transition.BASE=self.root
        self.calls=[]
        def enter(n05,operation,path):
            self.calls.append(operation)
            p=load(path)
            n05.validate_plan(p)
            for ref in [*p['gates'].values(),p['compatibility']]:
                n05.validate_evidence(ref,p,n05.evidence_binding(p))
            raise MutationBoundary()
        self.r.canonical_transition=enter
        # Windows has no POSIX owner/mode API. Linux exercises the original guard.
        self.mode=patch.object(self.n05,'private_file',side_effect=lambda p:private(p)) if os.name=='nt' else None
        if self.mode:self.mode.start()

    def tearDown(self):
        if self.mode:self.mode.stop()
        if os.name=='nt':self.fcntl.stop()
        self.temp.cleanup()

    def test_generated_plan_and_every_evidence_reach_canonical_boundary(self):
        with self.assertRaises(MutationBoundary):self.r.deploy()
        p=load(self.work/'forward-plan.json')
        self.assertEqual(self.calls,['forward'])
        self.assertEqual(p['ledger']['count'],48)
        self.assertIsNone(p['migrator'])
        self.assertEqual(p['source_app'],self.baseline['app'])
        self.assertEqual(load(self.work/'recovery-evidence.json')['details']['restore']['runId'],history.RUN)
        self.assertFalse((self.work/'forward.json').exists())

    def test_exact_r30_generated_code_reproduces_keyerror_before_forward(self):
        raw=builder.source('scripts/m2-release/sealed_programs.py','23da4c5a186e14368041a908d9a6b1972dbda311')
        generator=types.ModuleType('r30_generator')
        exec(compile(raw,'historical_generator','exec'),generator.__dict__)
        old=types.ModuleType('r30_transition')
        exec(compile(generator.transition(builder.source('scripts/m1-assisted/remote_release.py',builder.SEALED)),
                     'historical_transition','exec'),old.__dict__)
        old.BASE=self.root
        r=old.Release();r.__dict__.update(self.r.__dict__)
        r.review={'reference':'old','softwareEvidence':'old.json'}
        r.stages=types.SimpleNamespace(result=r.completed_result)
        before=set(self.work.iterdir())
        with self.assertRaisesRegex(KeyError,'returnCompatibilityEvidence'):r.deploy()
        self.assertEqual(set(self.work.iterdir()),before)
        self.assertEqual(self.calls,[])

    def test_old_missing_compatibility_and_string_artifacts_fail_before_any_write(self):
        initial=set(self.work.iterdir())
        for key, value, code in (
            ('returnCompatibilityEvidence',None,'RETURN_COMPATIBILITY_EVIDENCE_REQUIRED'),
            ('softwareEvidence','old-report.json','SOFTWARE_ARTIFACT_EVIDENCE_REQUIRED')):
            with self.subTest(key=key):
                self.r.review=copy.deepcopy(self.review)
                if value is None:del self.r.review[key]
                else:self.r.review[key]=value
                with self.assertRaisesRegex(Stop,code):self.r.deploy()
                self.assertEqual(set(self.work.iterdir()),initial)
                self.assertEqual(self.calls,[])

    def test_changed_ci_image_schema_or_archive_denies_admission(self):
        for key in ('candidate','candidateTree','candidateCiImage','returnCommit','returnTree','returnCiImage','imageArchiveSha256'):
            with self.subTest(key=key):
                b=dict(self.b);b[key]='changed'
                with self.assertRaisesRegex(Stop,'RETURN_QUALIFICATION_IDENTITY'):evidence.details(b)

    def test_canonical_error_before_receipt_preserves_original_code(self):
        self.r.canonical_transition=lambda *a:(_ for _ in ()).throw(Stop('TOOLS_IDENTITY_DRIFT',operation='forward'))
        with self.assertRaisesRegex(Stop,'TOOLS_IDENTITY_DRIFT'):self.r.deploy()
        self.assertFalse((self.work/'forward.json').exists())

    @unittest.skipIf(os.name=='nt','production entry point requires POSIX owner/mode APIs')
    def test_generated_packet_passes_actual_production_entrypoint_up_to_lock(self):
        n05=self.n05
        def enter(_,operation,path):
            self.calls.append(operation)
            def git(args,*unused,**kwargs):
                key=args[3:]
                out='main' if key==['branch','--show-current'] else (
                    self.b['candidate'] if key==['rev-parse','HEAD'] else
                    self.b['candidateTree'] if key==['rev-parse','HEAD^{tree}'] else '')
                return 0,out,''
            before=Path.cwd()
            try:
                os.chdir(self.runtime)
                with patch.dict(os.environ,{'FAI_ENVIRONMENT':'production',
                    'FAI_ENVIRONMENT_SENTINEL':'FAI_CRM_PRODUCTION_V1','COMPOSE_PROJECT_NAME':'fai-crm'},clear=True), \
                    patch.object(n05.socket,'gethostname',return_value='fai-crm-prod-02'), \
                    patch.object(n05,'__file__',str(self.runtime/'scripts/n05/failed_app_return.py')), \
                    patch.object(n05,'run_deadline',side_effect=git), \
                    patch.object(n05,'acquire_lock',side_effect=MutationBoundary):
                    n05.production_main(['failed_app_return.py',operation,str(path)])
            finally:os.chdir(before)
        self.r.canonical_transition=enter
        with self.assertRaises(MutationBoundary):self.r.deploy()
        self.assertEqual(self.calls,['forward'])
        self.assertFalse((self.work/'forward.json').exists())

class ResumeTests(unittest.TestCase):
    def fixture(self, root):
        packet=root/'packet';packet.mkdir(mode=0o700)
        work=packet/'evidence';work.mkdir(mode=0o700)
        definitions={'package.json':{'runId':history.RUN,'postRunId':history.POST_RUN,
                                     'completedBackupRunId':history.backup.RUN,'files':{}},
                     'review.json':{'softwareEvidence':'old.json'}}
        bindings={'REMOTE':packet,'HASHES':{}}
        for name,value in definitions.items():exclusive(packet/name,value)
        review=packet/'review.json'
        manifest=definitions['package.json']|{'files':{'review.json':{'bytes':review.stat().st_size,'sha256':digest(review)}}}
        (packet/'package.json').write_bytes(canonical(manifest)+b'\n')
        bindings['MANIFEST_SHA']=digest(packet/'package.json')
        for stage in history.HASHES:
            value={'status':'PASS','stage':stage,'runId':history.RUN}
            if stage=='protect':
                exclusive(work/'backup48.bundle.tar',b'ciphertext fixture')
                value.update(bundle_bytes=(work/'backup48.bundle.tar').stat().st_size,bundle_sha256=digest(work/'backup48.bundle.tar'))
            if stage=='recover':value['scope']='NEW_PLAINTEXT_DATABASE_AND_DOCUMENT_SET'
            exclusive(work/(stage+'.json'),value)
            bindings['HASHES'][stage]=digest(work/(stage+'.json'))
        exclusive(work/'deploy.stop.json',{'status':'STOP','stage':'deploy','code':'REMOTE_FAILURE_REDACTED','details':{}})
        bindings['STOP_SHA']=digest(work/'deploy.stop.json')
        exclusive(work/'deploy.intent.json',{'runId':history.RUN})
        return packet,work,bindings

    def test_reconciles_without_changing_historical_bytes(self):
        with tempfile.TemporaryDirectory(dir=REPO) as d:
            root=Path(d);_,work,bindings=self.fixture(root)
            before={p.name:p.read_bytes() for p in work.iterdir()}
            with patch.multiple(history,**bindings),patch.object(history.backup,'BASE',root):
                result=history.reconcile(remote=True)
            self.assertTrue(result['forwardArtifactsAbsentVerified'])
            self.assertEqual(before,{p.name:p.read_bytes() for p in work.iterdir()})

    def test_any_forward_or_later_progress_prevents_new_deploy(self):
        for name in (*history.FORWARD_FILES,'registry-start-'+('a'*64)+'.json','postcheck.intent.json','deploy.json'):
            with self.subTest(name=name),tempfile.TemporaryDirectory(dir=REPO) as d:
                root=Path(d);_,work,bindings=self.fixture(root)
                exclusive(work/name,{})
                with patch.multiple(history,**bindings),patch.object(history.backup,'BASE',root):
                    with self.assertRaises(Stop):history.reconcile(remote=True)

    def test_altered_success_or_stop_cannot_be_adopted(self):
        for name in ('recover.json','copies-backup.json','deploy.stop.json'):
            with self.subTest(name=name),tempfile.TemporaryDirectory(dir=REPO) as d:
                root=Path(d);_,work,bindings=self.fixture(root)
                with (work/name).open('ab') as out:out.write(b'\n')
                with patch.multiple(history,**bindings),patch.object(history.backup,'BASE',root):
                    with self.assertRaisesRegex(Stop,'COMPLETED_RECEIPT_CHANGED'):history.reconcile(remote=True)


class OwnerSequenceTests(unittest.TestCase):
    def test_resume_executes_only_remaining_phases_and_creates_post_copy_directories(self):
        import subprocess
        with tempfile.TemporaryDirectory(dir=REPO) as d:
            root=Path(d)
            for name,raw in builder.render('f'*32,reader).items():exclusive(root/name,raw)
            code=r"""
import sys,types,hashlib
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import owner_release as o
from common import exclusive,load,digest
root=Path(sys.argv[1])
exclusive(root/'package.json',{'runId':'f'*32})
devices={'C':{'disk':'disk-c','partition':'part-c'},'F':{'disk':'disk-f','partition':'part-f'}}
o.base.admit=lambda _:None
o.base.storage=lambda:devices
o.verify_local_copies=lambda _ : ({'completedPhasesReplayed':False},{'C':{'prior':True},'F':{'prior':True}})
o.acquire=lambda *a:{'bytes':10}
o.upload=lambda *a:None
payload=b'new synthetic post-deploy ciphertext'
sha=hashlib.sha256(payload).hexdigest()
calls=[]
def stage(manifest,name,request=None,output=None):
    calls.append(name)
    if output is not None:output.write(payload);return
    if name=='postprotect':return {'bundle_bytes':len(payload),'bundle_sha256':sha}
    if name=='copies-postbackup':
        assert set(request['copies'])=={'C','F'}
        assert all(x['sha256']==sha and x['bytes']==len(payload) for x in request['copies'].values())
    return {'status':'PASS'}
o.stage_call=stage
(root/'c').mkdir();(root/'f').mkdir()
def path(value):
    if value==r'C:\Users\Utente\Desktop\CRM\storage\private':return root/'c'
    if value=='F:/':return root/'f'
    return Path(value)
o.Path=path
assert o.main()==0
assert calls==['prepare','deploy','postcheck','postbackup','postprotect','fetch-postbackup','copies-postbackup','final'],calls
assert not {'backup','protect','recover','migrate','copies-backup'} & set(calls)
assert len(list((root/'c').glob('*/post-backup48.bundle.tar')))==1
assert len(list((root/'f').glob('*/post-backup48.bundle.tar')))==1
assert o.main()==0
assert calls==['prepare','deploy','postcheck','postbackup','postprotect','fetch-postbackup','copies-postbackup','final']
print('OWNER_REMAINING_SEQUENCE_AND_COPIES_PASS')
"""
            result=subprocess.run([sys.executable,'-I','-B','-S','-c',code,str(root)],capture_output=True,timeout=30)
            self.assertEqual(result.returncode,0,result.stderr.decode())
            self.assertIn(b'OWNER_REMAINING_SEQUENCE_AND_COPIES_PASS',result.stdout)
if __name__=='__main__':unittest.main(verbosity=2)
