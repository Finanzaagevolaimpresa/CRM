"""Offline protocol and immutable-receipt tests. No SSH or production execution."""
import ast
import copy
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
REPO=HERE.parents[1]
sys.path.insert(0,str(HERE))
sys.path.insert(1,str(REPO/'scripts/m1-assisted'))
import generate
from common import Stop, canonical, digest, exclusive, load, private, value_sha
from image_binding import complete_binding


def imported(path,name):
    spec=importlib.util.spec_from_file_location(name,path)
    value=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


class MutationBoundary(Exception): pass


class GeneratedTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir=REPO)
        self.root=Path(self.temp.name);self.root.chmod(0o700)
        self.files=generate.render('e'*32)
        for name,raw in self.files.items(): exclusive(self.root/name,raw)
        self.path=list(sys.path);sys.path.insert(0,str(self.root))
        self.previous={name:sys.modules.pop(name,None) for name in ('sealed_programs','release_evidence','owner_base','transport_base','download_images','transition_base')}
        self.addCleanup(self.cleanup)

    def cleanup(self):
        sys.path[:]=self.path
        for name,value in self.previous.items():
            sys.modules.pop(name,None)
            if value is not None:sys.modules[name]=value
        self.temp.cleanup()

    def test_exact_source_roles_and_no_historical_attempt_reuse(self):
        for role,commit in (('before',generate.SOURCE),('after',generate.CANDIDATE)):
            for prefix in ('backup48_','observe48_'):
                raw=self.files[prefix+role+'.py'];compile(raw,prefix+role,'exec')
                tree=ast.parse(raw)
                actual=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and
                    any(isinstance(t,ast.Name) and t.id=='SOURCE' for t in n.targets))
                self.assertEqual(actual,commit)
        remote=self.files['remote_release.py']
        self.assertNotIn(b'completed_backup',remote)
        self.assertNotIn(b'completed_release',remote)
        self.assertIn(b'M2_CONFIGURATION_DRIFT',remote)
        with self.assertRaisesRegex(ValueError,'SEALED_IDENTITY_DENIED'):generate.render('../arbitrary')

    def fixture(self):
        self.transition=imported(self.root/'transition_base.py','m3_test_transition')
        evidence=imported(self.root/'release_evidence.py','m3_test_evidence')
        self.b=json.loads(self.files['binding.json'])|{'candidateImage':'sha256:'+'1'*64,'returnImage':'sha256:'+'2'*64}
        self.review={'reference':'https://example.invalid/review',**evidence.details(self.b,self.root/'qualification.json')}
        if os.name=='nt':
            p=patch.dict(sys.modules,{'fcntl':types.ModuleType('fcntl')});p.start();self.addCleanup(p.stop)
        n05=imported(REPO/'scripts/n05/failed_app_return.py','m3_test_n05')
        self.work=self.root/'work';self.work.mkdir(mode=0o700)
        runtime=self.root/'runtime';runtime.mkdir(mode=0o700)
        baseline={'engine':{'kind':'docker','host':'unix:///var/run/docker.sock','id':'synthetic','name':'synthetic','os_type':'linux'},
            'app':{'id':'a'*64,'created':'synthetic-app','image_id':'sha256:'+'b'*64},
            'resources':{'volumes':{x:{'Name':x,'Driver':'local','Mountpoint':'/var/'+x,'CreatedAt':'now',
                'Labels':None,'Options':None,'Scope':'local'} for x in ('crm_documents','postgres_data')},
                'network':{'Id':'f'*64,'Name':'fai-crm_default','Created':'now','Driver':'bridge','Scope':'local',
                    'Labels':{},'Options':{},'IPAM':{},'Internal':False,'Attachable':False,'Ingress':False}}}
        backup=self.root/('evidence-backup48-'+'e'*32);backup.mkdir(mode=0o700)
        exclusive(backup/'BASELINE.json',baseline)
        plan={'project':'fai-crm','source_app':{'id':'a'*64,'image_id':'sha256:'+'b'*64},
            'postgres':{'id':'c'*64,'image':'sha256:'+'d'*64,'created':'synthetic-pg'},'configs':{},'ledger':{'schema':'prisma-m1-48'}}
        for name in ('previous','candidate','return'):
            f=self.work/('frozen-'+name+'.json');exclusive(f,{'synthetic':name})
            plan['configs'][name]={'path':str(f),'sha256':digest(f),'kind':'frozen-compose-'+name}
        exclusive(self.work/'models.json',plan)
        r=self.transition.Release()
        r.b,r.review,r.work,r.runtime=self.b,self.review,self.work,runtime
        r.run_id=r.backup_run_id='e'*32
        r.manifest={'authorityReference':'https://example.invalid/authority','deltaSha256':'d'*64}
        r.c=types.SimpleNamespace(cwd=None)
        r.require_config_binding=lambda:None
        r.rows=lambda _:[]
        r.stages=types.SimpleNamespace(result=lambda stage:({'ledgerDigest':value_sha([]),'migrator':None} if stage=='migrate'
            else {'runId':'e'*32,'stage':stage,'status':'PASS','scope':'UNIT_FIXTURE'}))
        r.n05=lambda:n05
        self.transition.BASE=self.root
        self.calls=[]
        def enter(tool,operation,path):
            self.calls.append(operation)
            p=load(path);tool.validate_plan(p)
            for reference in [*p['gates'].values(),p['compatibility']]:tool.validate_evidence(reference,p,tool.evidence_binding(p))
            raise MutationBoundary()
        r.canonical_transition=enter
        if os.name=='nt':
            p=patch.object(n05,'private_file',side_effect=private);p.start();self.addCleanup(p.stop)
        return r,evidence

    def test_generated_plan_passes_canonical_validation_before_mutation(self):
        r,_=self.fixture()
        with self.assertRaises(MutationBoundary):r.deploy()
        plan=load(self.work/'forward-plan.json')
        self.assertEqual(self.calls,['forward'])
        self.assertEqual(plan['ledger']['count'],48);self.assertIsNone(plan['migrator'])
        self.assertEqual(load(self.work/'recovery-evidence.json')['details']['restore']['runId'],'e'*32)
        self.assertFalse((self.work/'forward.json').exists())

    def test_missing_or_changed_qualification_denies_before_forward(self):
        r,evidence=self.fixture()
        for key in ('softwareEvidence','returnCompatibilityEvidence'):
            r.review=copy.deepcopy(self.review);r.review[key]='not-structured'
            with self.assertRaisesRegex(Stop,'QUALIFICATION_EVIDENCE_REQUIRED'):r.deploy()
            self.assertEqual(self.calls,[])
        for key in ('candidate','candidateTree','candidateCiImage','returnCommit','returnTree','returnCiImage','imageArchiveSha256'):
            with self.subTest(key=key),self.assertRaisesRegex(Stop,'RETURN_QUALIFICATION_IDENTITY'):
                evidence.details(self.b|{key:'changed'},self.root/'qualification.json')

    def test_uncertain_or_denied_forward_preserves_code_and_does_not_return(self):
        r,_=self.fixture()
        r.canonical_transition=lambda *args:(_ for _ in ()).throw(Stop('TOOLS_IDENTITY_DRIFT'))
        with self.assertRaisesRegex(Stop,'TOOLS_IDENTITY_DRIFT'):r.deploy()
        self.assertFalse((self.work/'forward.json').exists())
        self.assertFalse((self.work/'return-request.json').exists())

    def test_owner_order_and_repeat_only_status(self):
        owner=imported(self.root/'owner_release.py','m3_test_owner')
        exclusive(self.root/'package.json',{'runId':'e'*32})
        seen=[]
        owner.base.admit=lambda _:None
        owner.base.storage=lambda:seen.append('storage')
        owner.acquire=lambda *_:seen.append('acquire') or {}
        def upload(*_):seen.append('upload');exclusive(self.root/'upload.json',{})
        owner.upload=upload
        owner.stage_call=lambda _,stage,request=None,output=None:seen.append(stage) or {'status':'PASS'}
        owner.copies=lambda _,value,label:seen.append('local-'+label) or {}
        with contextlib.redirect_stdout(io.StringIO()):self.assertEqual(owner.main(),0)
        self.assertEqual(seen,['storage','acquire','upload','prepare','backup','protect','local-backup','copies-backup',
            'recover','migrate','deploy','postcheck','postbackup','postprotect','local-postbackup','copies-postbackup','final'])
        seen.clear()
        with contextlib.redirect_stdout(io.StringIO()):self.assertEqual(owner.main(),0)
        self.assertEqual(seen,['status'])
        with self.assertRaisesRegex(Stop,'FIXED_OPERATION_REQUIRED'):owner.command({'runId':'e'*32},'arbitrary')


class ImageTests(unittest.TestCase):
    def test_exact_archive_config_manifest_and_source_chain(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'archive.tar.gz'
            binding={'candidate':'a'*40,'candidateTree':'b'*40,'returnCommit':'c'*40,'returnTree':'d'*40}
            with tarfile.open(path,'w:gz') as archive:
                def blob(value):
                    raw=canonical(value);sha='sha256:'+hashlib.sha256(raw).hexdigest()
                    member=tarfile.TarInfo('blobs/sha256/'+sha[7:]);member.size=len(raw)
                    archive.addfile(member,io.BytesIO(raw));return sha
                for role in ('candidate','return'):
                    config=blob({'os':'linux','architecture':'amd64','config':{'Labels':{
                        'org.opencontainers.image.revision':binding['candidate' if role=='candidate' else 'returnCommit'],
                        'it.finanzaagevolaimpresa.source-tree':binding[role+'Tree']}},'rootfs':{'diff_ids':[]}})
                    binding[role+'CiImage']=config
                    blob({'schemaVersion':2,'config':{'digest':config}})
            binding['imageArchiveSha256']=digest(path)
            result=complete_binding(path,binding)
            self.assertNotEqual(result['candidateImage'],result['candidateCiImage'])
            for key,value in (('imageArchiveSha256','0'*64),('candidateCiImage','sha256:'+'0'*64),('candidate','f'*40),('candidateImage','sha256:'+'0'*64)):
                with self.subTest(key=key),self.assertRaises(Stop):complete_binding(path,binding|{key:value})


if __name__=='__main__':unittest.main()
