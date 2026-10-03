"""Exercise actual generated migrator admission and failure settlement offline."""
import json
import os
from pathlib import Path
import sys
import time
import types
import unittest

sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
sys.path.insert(1,str(HERE.parents[1]/'scripts/m1-assisted'))
from test_release import GeneratedTests, imported
from common import Stop, exclusive, load
import generate


class MigrationTests(GeneratedTests):
    def migration_fixture(self,exit_code='0'):
        remote=imported(self.root/'remote_release.py','m4_migration_under_test')
        release=remote.Release.__new__(remote.Release)
        release.root=self.root
        release.work=self.root/'migration';release.work.mkdir(mode=0o700)
        release.b=json.loads(self.files['binding.json'])|{'candidateImage':'sha256:'+'1'*64}
        release.t={'engineId':'synthetic','postgresId':'p'*64}
        release.manifest={'migrations':[generate.MIGRATION]}
        release.run_id='e'*32
        release.stages=types.SimpleNamespace(result=lambda stage:{'status':'PASS'})
        release.observer=lambda:None
        release.sql=lambda _:json.dumps({'keys':1,'sessions':0,'otherSessions':0}).encode()
        before=[[str(i)] for i in range(48)]
        after=before+[['migration49']]
        release.rows=lambda expected:before if expected is release.b['ledger48'] else after
        def models():
            exclusive(release.work/'frozen-candidate.json',{'services':{'app':{'environment':{'DATABASE_URL':'postgresql://synthetic:nonsecret@localhost/isolated'}}}})
            return {},{}
        release.models=models
        release.n05=lambda:types.SimpleNamespace(PRODUCTION_LOCK_PATH=self.root/'unit-lock',
            acquire_lock=lambda *_:os.open(self.root/'unit-lock',os.O_CREAT|os.O_RDWR,0o600))
        commands=[]
        class Commands:
            wall_end=time.time()+540
            mono_end=time.monotonic()+540
            running=True
            def docker(this,operation,*args,**kwargs):
                commands.append(operation)
                if operation=='MIGRATOR_CREATE':return ('a'*64).encode()
                if operation=='MIGRATOR_WAIT':
                    this.running=False
                    return exit_code.encode()
                if operation=='MIGRATOR_SETTLE':this.running=False
                return b''
            def inspect(this,*_):return {'Id':'a'*64,'Image':release.b['candidateImage'],'Created':'synthetic',
                'Mounts':[],'HostConfig':{'PortBindings':{}},'State':{'Running':this.running,'Pid':1 if this.running else 0},'ExecIDs':[]}
        release.c=Commands()
        return release,commands,before,after

    def test_only_migration49_and_verified_recovery_are_admitted(self):
        release,calls,_,_=self.migration_fixture()
        release.manifest['migrations']=[]
        with self.assertRaisesRegex(Stop,'MIGRATION_AUTHORITY_BINDING'):release.migrate()
        release.manifest['migrations']=[generate.MIGRATION]
        release.b['ledger49'][generate.MIGRATION]='0'*64
        with self.assertRaisesRegex(Stop,'ONLY_MIGRATION49_ALLOWED'):release.migrate()
        release.b['ledger49'][generate.MIGRATION]=generate.MIGRATION_SHA
        release.stages.result=lambda stage:None
        with self.assertRaisesRegex(Stop,'MIGRATION_RECOVERY_GATES_REQUIRED'):release.migrate()
        self.assertEqual(calls,[])

    def test_success_keeps_all_48_prior_rows_and_settles_exact_migrator(self):
        release,calls,_,_=self.migration_fixture()
        result=release.migrate()
        self.assertEqual((result['before'],result['after'],result['newMigrations']),(48,49,[generate.MIGRATION]))
        self.assertTrue(result['prior48Unchanged'])
        self.assertEqual(calls,['MIGRATOR_CREATE','MIGRATOR_START','MIGRATOR_WAIT'])
        self.assertEqual(result['migrator']['role'],'migrate')
        self.assertEqual(len(load(release.work/'ledger49.json')),49)

    def test_nonzero_exit_does_not_claim_migration_success(self):
        release,calls,_,_=self.migration_fixture('2')
        with self.assertRaisesRegex(Stop,'MIGRATOR_EXIT_NONZERO'):release.migrate()
        self.assertFalse((release.work/'ledger49.json').exists())
        self.assertEqual(calls.count('MIGRATOR_START'),1)

    def test_history_drift_is_rejected_after_migrator_settlement(self):
        release,calls,_,after=self.migration_fixture()
        after[0]=['changed']
        with self.assertRaisesRegex(Stop,'PRIOR_MIGRATION_HISTORY_CHANGED'):release.migrate()
        self.assertFalse((release.work/'ledger49.json').exists())
        self.assertEqual(calls.count('MIGRATOR_START'),1)

    def test_wait_timeout_stops_only_the_bound_migrator(self):
        release,calls,_,_=self.migration_fixture()
        original=release.c.docker
        def timeout(operation,*args,**kwargs):
            if operation=='MIGRATOR_WAIT':raise Stop('COMMAND_TIMEOUT')
            return original(operation,*args,**kwargs)
        release.c.docker=timeout
        with self.assertRaisesRegex(Stop,'COMMAND_TIMEOUT'):release.migrate()
        self.assertIn('MIGRATOR_SETTLE',calls)
        self.assertFalse(release.c.running)
        self.assertFalse((release.work/'ledger49.json').exists())

    def test_backup_and_protection_schemas_are_bound_to_each_role(self):
        sealed=imported(self.root/'sealed_programs.py','schema_roles')
        protect=imported(self.root/'protect48.py','protection_roles')
        self.assertEqual(protect.SOURCES,{generate.SOURCE:(generate.SOURCE_TREE,48),generate.CANDIDATE:(generate.CANDIDATE_TREE,49)})
        for role,schema in [('before',48),('after',49)]:
            backup=imported(self.root/('backup48_'+role+'.py'),'backup_role_'+role)
            self.assertIn('BACKUP'+str(schema),backup.PROTOCOL)
            self.assertIn('SCHEMA'+str(schema),backup.CONFIRMATION)
            self.assertEqual(backup.SOURCE,sealed.identity(role,'e'*32)[0])
        self.assertIn(b"'migrate':600",self.files['owner_release.py'])
        self.assertIn(b"'migrate': 540",self.files['remote_release.py'])


if __name__=='__main__':
    suite=unittest.TestSuite(MigrationTests(name) for name in (
        'test_only_migration49_and_verified_recovery_are_admitted',
        'test_success_keeps_all_48_prior_rows_and_settles_exact_migrator',
        'test_nonzero_exit_does_not_claim_migration_success',
        'test_history_drift_is_rejected_after_migrator_settlement',
        'test_wait_timeout_stops_only_the_bound_migrator',
        'test_backup_and_protection_schemas_are_bound_to_each_role'))
    raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
