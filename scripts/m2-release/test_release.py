"""Offline release-boundary tests; no SSH, daemon, credential or production use."""
import ast
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import tarfile
import types
import unittest

sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
REPO=HERE.parents[1]
sys.path.insert(0,str(HERE))
sys.path.insert(1,str(REPO/'scripts/m1-assisted'))
import package_builder as builder
import registry_settlement as registry
import sealed_programs as sealed
from image_binding import complete_binding
from common import Stop


class ImageBindingTests(unittest.TestCase):
    def test_saved_metadata_links_exact_ci_config_to_runtime_manifest(self):
        for version in (None, 2):
            with self.subTest(version=version), tempfile.TemporaryDirectory() as folder:
                path=Path(folder)/'images.tar.gz'
                binding={}
                with tarfile.open(path,'w:gz') as archive:
                    for index,role in enumerate(('candidate','return')):
                        value={'config':{'digest':'sha256:'+str(index)*64}}
                        if version is not None: value['schemaVersion']=version
                        raw=json.dumps(value).encode()
                        sha=hashlib.sha256(raw).hexdigest()
                        member=tarfile.TarInfo('blobs/sha256/'+sha)
                        member.size=len(raw)
                        archive.addfile(member,io.BytesIO(raw))
                        binding[role+'Image']='sha256:'+sha
                        binding[role+'CiImage']='sha256:'+str(index)*64
                binding['imageArchiveSha256']=hashlib.sha256(path.read_bytes()).hexdigest()
                if version is None:
                    with self.assertRaises(Stop): complete_binding(path,binding)
                    continue
                result=complete_binding(path,binding)
                self.assertEqual(result['candidateConfigDigest'],'sha256:'+'0'*64)
                self.assertEqual(result['returnConfigDigest'],'sha256:'+'1'*64)
                with self.assertRaises(Stop):
                    complete_binding(path,binding|{'imageArchiveSha256':'0'*64})
                with self.assertRaises(Stop):
                    complete_binding(path,binding|{'candidateCiImage':'sha256:'+'f'*64})


def reader(path,ref='HEAD'):
    return (REPO/path).read_bytes() if path.startswith('scripts/m2-release/') else builder.source(path,ref)


class SealedTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files=builder.render('a'*32,reader)

    def test_every_program_compiles_and_binds_exact_source(self):
        for name,raw in self.files.items():
            if name.endswith('.py'): compile(raw,name,'exec')
        for role,commit in [('before',sealed.M1),('after',sealed.M2)]:
            for prefix in ('backup48_','observe48_'):
                tree=ast.parse(self.files[prefix+role+'.py'])
                source=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and
                            any(isinstance(t,ast.Name) and t.id=='SOURCE' for t in n.targets))
                self.assertEqual(source,commit)
        self.assertNotIn(b'backup46-',self.files['transition_base.py'])

    def test_historical_template_changes_deny_generation(self):
        for function,path in [(sealed.backup,'scripts/pr140/owner_backup46.py'),
                              (sealed.observer,'scripts/m1-executor/observe_m1.py')]:
            raw=builder.source(path,builder.SEALED)
            with self.assertRaisesRegex(ValueError,'SEALED_TEMPLATE_CHANGED'):
                function(raw+b'\n','before','a'*32)
            with self.assertRaisesRegex(ValueError,'SEALED_IDENTITY_DENIED'):
                function(raw,'different','a'*32)
            with self.assertRaisesRegex(ValueError,'SEALED_IDENTITY_DENIED'):
                function(raw,'after','../arbitrary')

    def test_provision_and_real_migrate_absent_from_transition(self):
        tree=ast.parse(self.files['transition_base.py'])
        cls=next(n for n in tree.body if isinstance(n,ast.ClassDef))
        self.assertEqual({n.name for n in cls.body if isinstance(n,ast.FunctionDef)},
                         {'sql','rows','kit','n05','canonical_transition','deploy','postcheck'})
        self.assertNotIn(b'key-provisioning-authority',self.files['transition_base.py'])
        self.assertIn(b'plannedSessionRevocation',self.files['transition_base.py'])

    def test_backup_settles_only_after_quiescence_and_before_dump(self):
        code=self.files['backup48_before.py'].decode()
        method=code[code.index('    def create(self):'):code.index('\ndef validate_ledger')]
        self.assertLess(method.index('self.registry_preflight()'),method.index('self.quiescence_attempted = True'))
        self.assertLess(method.index('QUIESCENCE_UNVERIFIED'),method.index('self.settle_registry_sessions()'))
        self.assertLess(method.index('self.settle_registry_sessions()'),method.index('BACKUP_PREFLIGHT'))
        self.assertIn('REGISTRY_RESUME_BLOCKED_LIVE_SESSIONS',code)
        self.assertIn('"EXPECTED_MIGRATION_COUNT": "48"',code)

    def test_receiver_never_reuses_historical_attempt(self):
        code=self.files['receive_package.py'].decode()
        self.assertNotIn('reuse_images',code)
        self.assertNotIn('e67bea',code)
        self.assertIn("binding['image']['sha256'] == manifest['imageArchiveSha256']",code)
        self.assertIn('PACKAGE_PATH_OCCUPIED_RECONCILE_ONLY',code)
        self.assertIn("set(manifest['files']) | {'package.json'}",code)
        self.assertIn("receive_prepared(root)",code)

    def test_generated_modules_import_and_owner_is_bound(self):
        with tempfile.TemporaryDirectory(dir=REPO/'artifacts' if (REPO/'artifacts').exists() else None) as folder:
            root=Path(folder)
            for name,data in self.files.items(): (root/name).write_bytes(data)
            # New interpreter ensures no imported M1 module masks a generated dependency.
            code="import sys;sys.path.insert(0,sys.argv[1]);import remote_release as r,owner_release as o;assert r.M2=='7ab126f8a2ef385c3e720f190eda80f26f61ae39';assert set(r.DEPENDENCIES)<=set(o.TIMES);assert not hasattr(o.base,'key_consent');assert o.base.command is o.command;print('IMPORT_PASS')"
            result=subprocess.run([sys.executable,'-I','-B','-S','-c',code,str(root)],
                                  stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
            self.assertEqual(result.returncode,0,result.stderr.decode())
            self.assertIn(b'IMPORT_PASS',result.stdout)
        self.assertIn(sealed.M2.encode(),self.files['owner_base.py'])
        self.assertNotIn(b'key_consent',self.files['owner_base.py'])


class StartBoundaryTests(unittest.TestCase):
    def fixture(self):
        calls=[]
        raw={'Id':'a'*64,'Image':'sha256:candidate','Config':{'Labels':{
            'com.docker.compose.project':'fai-crm','com.docker.compose.service':'app'}},
            'State':{'Status':'created','Running':False,'Paused':False,'Restarting':False,'Pid':0},'ExecIDs':[]}
        state={'app':{'id':'a'*64},'foreign_containers':[],'migrators':[]}
        class Base:
            plan={'candidate':{'id':'sha256:candidate'},'return_image':{'id':'sha256:return'}}
            def snapshot(self,deadline): return state
            def inspect(self,*args): return raw
            def validate_boundary(self,*args): calls.append('boundary')
            def run(self,*args,deadline,input_text=None): calls.append(('docker',args));return 'started'
        def sql(text,deadline):
            calls.append('sql' if text==registry.SQL else 'count')
            return '{"revokedCount":2,"auditCount":1}' if text==registry.SQL else '0'
        engine=registry.registry_engine(Base,lambda identity,value:calls.append(('receipt',value)),sql)()
        return engine,calls,raw,state,Base

    def test_canonical_start_after_quiet_writer_and_audited_commit(self):
        engine,calls,_,_,_=self.fixture()
        self.assertEqual(engine.run('start','a'*64,deadline=1),'started')
        self.assertEqual(calls,['boundary','sql','count',('receipt',{'revokedCount':2,'auditCount':1}),('docker',('start','a'*64))])

    def test_active_or_foreign_writer_never_reaches_sql_or_start(self):
        for change in ('running','foreign','pid','exec','wrongid','image'):
            with self.subTest(change=change):
                engine,calls,raw,state,_=self.fixture()
                if change=='running':raw['State']['Running']=True
                if change=='foreign':state['foreign_containers']=['foreign']
                if change=='pid':raw['State']['Pid']=99
                if change=='exec':raw['ExecIDs']=['exec']
                if change=='wrongid':raw['Id']='b'*64
                if change=='image':raw['Image']='sha256:other'
                with self.assertRaisesRegex(RuntimeError,'REGISTRY_WRITER_NOT_QUIESCENT'):
                    engine.run('start','a'*64,deadline=1)
                self.assertEqual(calls,[])

    def test_sql_uncertainty_stops_without_repeat_or_start(self):
        _,calls,_,_,base=self.fixture()
        def failure(sql,deadline): calls.append('failed-once');raise RuntimeError('SQL_UNCERTAIN')
        engine=registry.registry_engine(base,lambda *a:calls.append('receipt'),failure)()
        with self.assertRaisesRegex(RuntimeError,'SQL_UNCERTAIN'): engine.run('start','a'*64,deadline=1)
        self.assertEqual(calls,['boundary','failed-once'])

    def test_count_receipt_and_preflight(self):
        for raw in ('{"revokedCount":true,"auditCount":1}','{"revokedCount":1,"auditCount":0}',
                    '{"revokedCount":1,"auditCount":2}','{"revokedCount":1,"auditCount":1,"secret":"x"}'):
            with self.assertRaises(ValueError):registry.parse_counts(raw)
        self.assertIn('WHERE FALSE RETURNING',registry.PREFLIGHT_SQL)
        self.assertNotIn('COMMIT;',registry.PREFLIGHT_SQL)
        self.assertNotIn('DELETE',registry.SQL)


if __name__=='__main__': unittest.main(verbosity=2)
