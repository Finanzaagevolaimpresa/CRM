"""Exercise canonical admission and new no-write/no-downgrade boundaries."""
import sys
from pathlib import Path
sys.dont_write_bytecode = True
sys.path.insert(0,str(Path(__file__).resolve().parent))
from generate import source
raw = source('scripts/m4-release/test_release.py').decode()
raw = raw.replace("if __name__=='__main__':unittest.main()", '')
raw = raw.replace("'-m4-'", "'-r40-'").replace('m4-release-r33-', 'integrated-release-r64-')
raw = raw.replace('evidence-backup48-', 'evidence-backup49-').replace('prisma-m1-48','prisma-m4-49')
raw = raw.replace("'transition_base')", "'transition_base','registry_settlement','mailbox_guard')")
exec(compile(raw, 'pinned_protocol_tests.py', 'exec'), globals())


class ReleaseBoundaryTests(GeneratedTests):
    def test_registry_read_only_denies_live_or_ambiguous_counts(self):
        registry = imported(self.root/'registry_settlement.py','r40_registry_test')
        for sql in (registry.SQL,registry.PREFLIGHT_SQL,registry.COUNT_SQL):
            self.assertTrue(sql.startswith('BEGIN READ ONLY;'))
            self.assertTrue(sql.endswith('ROLLBACK;'))
            import re
            self.assertFalse(re.search(r'\b(UPDATE|INSERT|DELETE|CREATE|ALTER|DROP|TRUNCATE|CALL|DO)\b',sql,re.I))
        self.assertEqual(registry.parse_counts('{"revokedCount":0,"auditCount":0,"liveCount":0}'),
                         {'revokedCount':0,'auditCount':0})
        for item in ({'revokedCount':0,'auditCount':0,'liveCount':1},
                     {'revokedCount':0,'auditCount':0},
                     {'revokedCount':False,'auditCount':0,'liveCount':0},
                     {'revokedCount':1,'auditCount':1,'liveCount':0}):
            with self.assertRaisesRegex(ValueError,'LIVE_SESSIONS_REQUIRE_NORMAL_LOGOUT'):
                registry.parse_counts(json.dumps(item))

    def test_failed_forward_never_invokes_historical_return(self):
        r,_ = self.fixture()
        n05 = r.n05()
        def forward(tool,operation,path):
            self.assertEqual(operation,'forward')
            self.calls.append(operation)
            exclusive(load(path)['receipt_path'],{})
        r.canonical_transition = forward
        engine = types.SimpleNamespace(snapshot=lambda deadline:{'app':{'state':'exited','image_id':self.b['candidateImage']}})
        with patch.object(n05,'require_published'),patch.object(n05,'validate_receipt'),\
             patch.object(n05,'DockerEngine',return_value=engine):
            with self.assertRaisesRegex(Stop,'FORWARD_FAILED_NO_OLDER_IMAGE_RETURN'):
                r.deploy()
        self.assertEqual(self.calls,['forward'])
        self.assertFalse((self.work/'return-request.json').exists())

    def test_remote_return_operation_is_denied_before_any_command(self):
        remote = imported(self.root/'remote_release.py','r40_return_boundary')
        r = remote.Release.__new__(remote.Release)
        with self.assertRaisesRegex(Stop,'OLDER_IMAGE_RETURN_NOT_AUTHORIZED'):
            r.canonical_transition(None,'return',None)

    def test_mailbox_full_row_fingerprint_must_match(self):
        remote = imported(self.root/'remote_release.py','r40_mailbox_boundary')
        r = remote.Release.__new__(remote.Release)
        before = {k:7 for k in ('total','enabled','sendReceive','configured','tested','responsible')}
        before['fingerprint'] = 'a'*64
        r.stages = types.SimpleNamespace(result=lambda stage:{'mailboxes':before})
        r.sql = lambda _:json.dumps(before)
        with patch.object(remote.Transition,'postcheck',return_value={'healthy':True}):
            self.assertTrue(r.postcheck()['mailboxesPreserved'])
            r.sql = lambda _:json.dumps(before|{'fingerprint':'b'*64})
            with self.assertRaisesRegex(Stop,'MAILBOX_CONFIGURATION_DRIFT'):r.postcheck()
            r.sql = lambda _:json.dumps(before|{'enabled':6})
            with self.assertRaisesRegex(Stop,'SEVEN_QUALIFIED_MAILBOXES_REQUIRED'):r.postcheck()


if __name__ == '__main__':
    suite = unittest.TestSuite()
    for cls in (GeneratedTests,ImageTests):
        suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(cls))
    for name in ('test_registry_read_only_denies_live_or_ambiguous_counts',
                 'test_failed_forward_never_invokes_historical_return',
                 'test_remote_return_operation_is_denied_before_any_command',
                 'test_mailbox_full_row_fingerprint_must_match'):
        suite.addTest(ReleaseBoundaryTests(name))
    raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
