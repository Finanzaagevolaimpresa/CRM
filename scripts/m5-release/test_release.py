"""Reuse qualified protocol regressions; add the schema49 no-migration boundary."""
import sys
from pathlib import Path
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
from generate import source
raw=source('scripts/m4-release/test_release.py').decode()
raw=raw.replace("if __name__=='__main__':unittest.main()",'')
raw=raw.replace("'-m4-'","'-m5-'").replace('m4-release-r33-','m5-release-r36-')
raw=raw.replace('evidence-backup48-','evidence-backup49-').replace('prisma-m1-48','prisma-m4-49')
exec(compile(raw,'pinned_m4_protocol_tests.py','exec'),globals())


class NoMigrationTests(GeneratedTests):
    def test_protection_accepts_schema49_only_for_each_exact_source_role(self):
        protection=imported(self.root/'protect48.py','m5_protection_boundary')
        roles=((generate.SOURCE,generate.SOURCE_TREE),(generate.CANDIDATE,generate.CANDIDATE_TREE))
        for commit,tree in roles:
            seen=[]
            kit=types.SimpleNamespace(SUPPORTED_SOURCE_MIGRATION_COUNTS=(43,46),
                verify_source_schema=lambda *args:seen.append(args))
            protection.qualify(kit,commit,tree).verify_source_schema(commit,tree,49)
            self.assertEqual(seen,[(commit,tree,49)])
            self.assertEqual(kit.SUPPORTED_SOURCE_MIGRATION_COUNTS,(49,))
            for bad_commit,bad_tree,count in ((commit,tree,48),(commit,tree,50),('0'*40,tree,49),(commit,'0'*40,49)):
                with self.assertRaisesRegex(Stop,'PROTECTION_SOURCE_NOT_QUALIFIED'):
                    kit.verify_source_schema(bad_commit,bad_tree,count)
            self.assertEqual(seen,[(commit,tree,49)])
        for commit,tree in roles:
            kit=types.SimpleNamespace(SUPPORTED_SOURCE_MIGRATION_COUNTS=(43,46),verify_source_schema=lambda *_:None)
            with self.assertRaisesRegex(Stop,'PROTECTION_SOURCE_NOT_QUALIFIED'):
                protection.qualify(kit,commit,'0'*40)

    def test_generated_recover_receives_the_complete_schema49_ledger(self):
        remote=imported(self.root/'remote_release.py','m5_schema49_recover')
        r=remote.Release.__new__(remote.Release)
        r.b=json.loads(self.files['binding.json'])|{'candidateImage':'sha256:'+'1'*64}
        r.c=object();r.work=self.root;r.run_id='e'*32
        r.t={'postgresImage':'sha256:'+'2'*64};r.kit=lambda:object()
        r.backup_set=lambda:(self.root/'synthetic-backup',None)
        before={k:True for k in ('appHealthy','postgresHealthy','ledgerChecksumsMatch','closedGates')}
        before.update(postgresStartedAt='synthetic',postgresRestartCount=0,ledgerCount=49)
        r.observer=lambda:before
        observed=[]
        class BoundRestore:
            def __init__(self,*args):pass
            def run(self,backup,ledger):
                observed.append((backup,ledger))
                if len(ledger)!=49:raise AssertionError('WRONG_RECOVERY_SCHEMA')
                return {'status':'SYNTHETIC_RESTORED'}
        with patch.object(remote,'Restore',BoundRestore):
            result=r.recover()
        self.assertEqual(observed,[(self.root/'synthetic-backup',r.b['ledger49'])])
        self.assertTrue(result['productionUnchanged'])

    def no_migration_fixture(self):
        remote=imported(self.root/'remote_release.py','m5_zero_migration')
        r=remote.Release.__new__(remote.Release)
        r.b=json.loads(self.files['binding.json'])
        r.manifest={'migrations':[]}
        r.stages=types.SimpleNamespace(result=lambda _:{'status':'PASS'})
        calls=[]
        r.observer=lambda:calls.append('observe') or {'ledgerCount':49,'zeroIncomplete':True,'liveSessions':0,'otherActiveDbSessions':0}
        r.rows=lambda expected:calls.append('ledger') or [[name,sha] for name,sha in sorted(expected.items())]
        r.c=types.SimpleNamespace(run=lambda *a,**k:(_ for _ in ()).throw(AssertionError('COMMAND_FORBIDDEN')),
                                 docker=lambda *a,**k:(_ for _ in ()).throw(AssertionError('DOCKER_FORBIDDEN')))
        return r,calls

    def test_migration_authority_and_recovery_failure_deny_before_observation(self):
        r,calls=self.no_migration_fixture()
        r.manifest['migrations']=['not-authorized']
        with self.assertRaisesRegex(Stop,'NO_MIGRATIONS_AUTHORIZED'):r.migrate()
        self.assertEqual(calls,[])
        r.manifest['migrations']=[]
        r.stages.result=lambda _:None
        with self.assertRaisesRegex(Stop,'DEPLOY_RECOVERY_GATES_REQUIRED'):r.migrate()
        self.assertEqual(calls,[])
        r.stages.result=lambda _:{'status':'PASS'}
        r.observer=lambda:{'ledgerCount':48,'zeroIncomplete':True}
        with self.assertRaisesRegex(Stop,'SCHEMA49_OBSERVATION_REQUIRED'):r.migrate()
        self.assertEqual(calls,[])
        r.observer=lambda:{'ledgerCount':49,'zeroIncomplete':True,'liveSessions':1,'otherActiveDbSessions':0}
        with self.assertRaisesRegex(Stop,'PRE_DEPLOY_SESSIONS_CHANGED'):r.migrate()
        self.assertEqual(calls,[])


if __name__=='__main__':
    suite=unittest.TestSuite()
    suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(GeneratedTests))
    suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(ImageTests))
    for name in ('test_protection_accepts_schema49_only_for_each_exact_source_role',
                 'test_generated_recover_receives_the_complete_schema49_ledger',
                 'test_migration_authority_and_recovery_failure_deny_before_observation'):
        suite.addTest(NoMigrationTests(name))
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(not result.wasSuccessful())
