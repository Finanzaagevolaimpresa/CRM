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
raw = raw.replace("'transition_base')", "'transition_base','registry_settlement','mailbox_guard','ssh_guard')")
exec(compile(raw, 'pinned_protocol_tests.py', 'exec'), globals())


class ReleaseBoundaryTests(GeneratedTests):
    def test_generated_specs_pass_real_n05_image_predicate_and_deny_wrong_tag(self):
        r,_ = self.fixture()
        with self.assertRaises(MutationBoundary): r.deploy()
        plan = load(self.work/'forward-plan.json')
        engine = r.n05().DockerEngine.__new__(r.n05().DockerEngine)
        observed = {}
        for field,role in (('candidate','candidate'),('return_image','return')):
            commit = self.b['candidate' if role == 'candidate' else 'returnCommit']
            observed[self.b[role+'Image']] = {'Id':self.b[role+'Image'],
                'RepoTags':['fai-crm:r05-candidate-'+commit],
                'Config':{'Labels':{'org.opencontainers.image.revision':commit,
                    'it.finanzaagevolaimpresa.source-tree':self.b[role+'Tree']}}}
        engine.inspect = lambda kind,identity,deadline:observed[identity]
        self.assertTrue(engine.image(plan['candidate'],0))
        self.assertTrue(engine.image(plan['return_image'],0))
        wrong = plan['return_image'] | {'tag':'fai-crm:r05-recovery-'+self.b['returnCommit']}
        self.assertFalse(engine.image(wrong,0))
        self.assertFalse(engine.image(plan['return_image'] | {'oci_commit':'f'*40},0))

    def test_generated_owner_ssh_profile_counterproof_and_shared_connections(self):
        import shutil
        import subprocess
        owner = imported(self.root/'owner_base.py','r40_ssh_owner')
        guard = imported(self.root/'ssh_guard.py','r40_ssh_guard')
        ssh = shutil.which('ssh')
        self.assertIsNotNone(ssh, 'Real OpenSSH required for the offline counterproof')
        fixture = self.root/'hostile-ssh.conf'
        fixture.write_text('''Host fai-crm-prod
    HostName desk.finanzaagevolaimpresa.it
    User faiadmin
    Port 22
    BatchMode no
    StrictHostKeyChecking no
    UpdateHostKeys yes
    CheckHostIP yes
    ClearAllForwardings no
    ForwardAgent yes
    ForwardX11 yes
    ForwardX11Trusted yes
    PermitLocalCommand yes
    VerifyHostKeyDNS yes
    AddKeysToAgent yes
    LocalForward 127.0.0.1:41801 127.0.0.1:9
    RemoteForward 41802 127.0.0.1:9
    DynamicForward 127.0.0.1:41803
''', encoding='utf-8', newline='\n')
        before = digest(fixture)
        baseline = subprocess.run([ssh,'-F',str(fixture),'-G','fai-crm-prod'],
            capture_output=True,check=True,timeout=10).stdout
        with self.assertRaisesRegex(Stop,'SSH_PROTECTED_OPTIONS_NOT_ENFORCED'):
            guard.validate_profile(baseline)
        seen = []
        sid = 'S-1-5-21-111-222-333-444'
        def profile_call(args,seconds,**options):
            seen.append(args)
            if str(args[0]).endswith('whoami.exe'):
                return 0,('"synthetic-owner","'+sid+'"').encode(),b''
            self.assertEqual(args,owner.SSH_ARGS[:-1]+['-G',owner.SSH_ARGS[-1]])
            p = subprocess.run([ssh,'-F',str(fixture),*args[1:]],
                capture_output=True,check=True,timeout=seconds)
            return p.returncode,p.stdout,p.stderr
        with patch.object(owner,'call',side_effect=profile_call),\
             patch.object(owner,'os',types.SimpleNamespace(name='nt')),\
             patch.object(owner,'sys',types.SimpleNamespace(argv=['owner_release.py'])),\
             patch.object(owner,'load',return_value={'ownerSid':sid}),\
             patch.object(owner,'digest',return_value='synthetic'):
            owner.admit({'candidate':generate.CANDIDATE,'files':{},
                'programs':{name:'synthetic' for name in ('ssh','python','powershell')}})
        self.assertEqual(len(seen),2)
        self.assertEqual(digest(fixture),before)
        with patch.dict(sys.modules,{'owner_base':owner}):
            launcher = imported(self.root/'owner_release.py','r40_shared_ssh')
        manifest = {'runId':'e'*32,'files':{}}
        self.assertEqual(launcher.command(manifest,'status')[:-1],owner.SSH_ARGS)
        exclusive(self.root/'package.json',manifest)
        exclusive(self.root/'release-images.tar.gz',b'SYNTHETIC_NO_IMAGE_EXECUTION')
        connection_calls = []
        def capture(args,seconds,**options):
            connection_calls.append(args)
            value = {'status':'PACKAGE_RECEIVED' if 'source' in options else 'PASS'}
            return 0,canonical(value),b''
        with patch.object(owner,'call',side_effect=capture):
            launcher.upload(manifest,{})
            launcher.stage_call(manifest,'status')
        self.assertEqual(len(connection_calls),2)
        self.assertTrue(all(args[:-1] == owner.SSH_ARGS for args in connection_calls))

    def test_missing_unsafe_or_duplicate_effective_ssh_option_is_denied(self):
        guard = imported(self.root/'ssh_guard.py','r40_ssh_denial')
        good = dict(guard.TARGET) | {name:sorted(values)[0] for name,values in guard.REQUIRED.items()}
        serialize = lambda values:'\n'.join(key+' '+value for key,value in values.items()).encode()
        guard.validate_profile(serialize(good))
        for key in guard.REQUIRED:
            with self.subTest(option=key):
                with self.assertRaisesRegex(Stop,'SSH_PROTECTED_OPTIONS_NOT_ENFORCED'):
                    guard.validate_profile(serialize({k:v for k,v in good.items() if k != key}))
                with self.assertRaisesRegex(Stop,'SSH_PROTECTED_OPTIONS_NOT_ENFORCED'):
                    guard.validate_profile(serialize(good | {key:'unsafe'}))
                with self.assertRaisesRegex(Stop,'SSH_PROFILE_AMBIGUOUS'):
                    guard.validate_profile(serialize(good)+('\n'+key+' '+good[key]).encode())

    def test_saved_r37_keeps_original_candidate_tag_and_checks_labels(self):
        self.fixture()
        images=imported(self.root/'qualified_images.py','r40_pair_provenance')
        binding=self.b | {'imageStoreVersion':'29.6.1'}
        configs={role:{'os':'linux','architecture':'amd64','rootfs':{'diff_ids':['layer-'+role]}}
                 for role in ('candidate','return')}
        observed={}
        for role in configs:
            binding[role+'ConfigDigest']='sha256:'+('3' if role=='candidate' else '4')*64
            commit=binding['candidate' if role=='candidate' else 'returnCommit']
            observed[role]={'id':binding[role+'Image'],'os':'linux','architecture':'amd64',
                'layers':configs[role]['rootfs']['diff_ids'],'tags':['fai-crm:r05-candidate-'+commit],
                'commit':commit,'tree':binding[role+'Tree']}
        def docker(command,*args):
            if command=='QUALIFIED_IMAGE_STORE':
                return canonical({'version':'29.6.1','driver':'overlayfs',
                    'status':[['driver-type','io.containerd.snapshotter.v1']]})
            return canonical(observed[command.removeprefix('QUALIFIED_IMAGE_').lower()])
        with patch.object(images,'archive_metadata',return_value=configs):
            result=images.verify_images(types.SimpleNamespace(docker=docker),None,binding)
            self.assertTrue(result['return']['layersAndLabelsVerified'])
            observed['return']['commit']='f'*40
            with self.assertRaisesRegex(Stop,'QUALIFIED_IMAGE_PROVENANCE'):
                images.verify_images(types.SimpleNamespace(docker=docker),None,binding)

    def test_storage_probe_does_not_change_execution_policy(self):
        owner=imported(self.root/'owner_base.py','r40_storage_owner')
        seen=[]
        def capture(args,timeout,**kw):
            seen.append(args)
            return 0,b'{"status":"PASS","readOnly":true,"policyChanged":false}',b''
        owner.call=capture
        self.assertTrue(owner.storage()['readOnly'])
        self.assertEqual(len(seen),1)
        self.assertNotIn('-ExecutionPolicy',seen[0])
        self.assertIn('-Command',seen[0])
        self.assertIn('Get-CimInstance',seen[0][-1])
        self.assertNotIn('$PSScriptRoot',seen[0][-1])

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
    for name in ('test_generated_specs_pass_real_n05_image_predicate_and_deny_wrong_tag',
                 'test_generated_owner_ssh_profile_counterproof_and_shared_connections',
                 'test_missing_unsafe_or_duplicate_effective_ssh_option_is_denied',
                 'test_saved_r37_keeps_original_candidate_tag_and_checks_labels',
                 'test_storage_probe_does_not_change_execution_policy',
                 'test_registry_read_only_denies_live_or_ambiguous_counts',
                 'test_failed_forward_never_invokes_historical_return',
                 'test_remote_return_operation_is_denied_before_any_command',
                 'test_mailbox_full_row_fingerprint_must_match'):
        suite.addTest(ReleaseBoundaryTests(name))
    raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
