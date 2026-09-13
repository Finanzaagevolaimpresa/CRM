"""V3 real protocol/adapter code with invented clocks, storage and Docker I/O.

No native Docker, database, credentials, process, lock or production filesystem
access. The Windows fcntl sentinel is unusable; native lock coverage stays in
the existing POSIX suite. These tests do not manufacture production evidence.
"""
import copy
import importlib.util
from pathlib import Path, PurePosixPath
import subprocess
import sys
import types
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('n05_deadline_test', ROOT/'scripts/n05/failed_app_return.py')
n05 = importlib.util.module_from_spec(spec)
if sys.platform == 'win32':
    with mock.patch.dict(sys.modules, {'fcntl': types.ModuleType('unused_fcntl')}):
        spec.loader.exec_module(n05)
else:
    spec.loader.exec_module(n05)


def plan_fixture():
    def image(token):
        return dict(tag='invented:'+token, id='sha256:'+token*64, oci_commit=token*40, oci_tree=token*40)
    def ref(kind): return dict(path='/invented/'+kind+'.json', sha256='8'*64, kind=kind)
    def volume(name):
        return dict(Name=name, Driver='local', Mountpoint='/invented/volumes/'+name,
                    CreatedAt='invented-created', Labels={}, Options=None, Scope='local')
    return dict(schema=n05.PLAN_V3, run_id='invented-deadline-protocol',
        engine=dict(kind='docker', host='unix:///var/run/docker.sock', id='invented-engine',
                    name='invented-owner', os_type='linux'), project='fai-crm-n05-synthetic-111111111111',
        tools=dict(commit='1'*40, tree='2'*40, ci_sha='1'*40, ci_conclusion='success'),
        source_app=dict(id='a'*64, created='invented-source-created', image_id='sha256:'+'a'*64),
        candidate=image('b'), return_image=image('a'),
        postgres=dict(id='d'*64, image='sha256:'+'e'*64, created='invented-pg-created'),
        resources=dict(volumes=dict(crm_documents=volume('invented-documents'), postgres_data=volume('invented-database')),
            network=dict(Id='f'*64, Name='invented-network', Created='invented-created', Driver='bridge',
                Scope='local', Labels={}, Options={}, IPAM={}, Internal=False, Attachable=False, Ingress=False)),
        configs={k:ref('frozen-compose-'+k) for k in ('previous','candidate','return')},
        ledger=dict(schema='invented-ledger', count=44, digest='7'*64),
        compatibility=ref('return-image-schema-compatibility'), deadline_epoch=2260.0,
        phase_deadlines=dict(forward_epoch=1360.0, settlement_epoch=1480.0, return_epoch=2080.0,
            settlement_reserve_seconds=120, return_reserve_seconds=600, cleanup_reserve_seconds=180),
        gates={k:ref(k) for k in ('recovery','artifacts','reviewed_plan','authorization')},
        return_policy=dict(allowed_reasons=['functional-failure','unhealthy','exited','absent']), migrator=None,
        receipt_path='/invented/forward.json', return_request_path='/invented/request.json',
        journal_path='/invented/journal.json')


class Fixture:
    """Concrete ForwardRecorder/start/settle/create/recreate/ReturnController.

    Only native endpoints are replaced; protocol guards, event/hash validation,
    deadline selection, stop checks and all lifecycle orchestration execute.
    """
    def __init__(self, behavior='starting'):
        self.plan = plan_fixture()
        self.now = 1000.0
        self.files = {}
        self.writes = []
        self.calls = []
        self.behavior = behavior
        self.write_fault = None
        self.write_error = OSError('invented EIO')
        self.after_write_fault = None
        self.late_write = None
        self.inspect_fault = None
        self.settlement_hook = None
        self.stop_fault = None
        self.create_fault = None
        self.snapshot_hook = None
        self.config_hook = None
        self.return_slow = False
        self.engine = self.engine_type()(self.plan, PurePosixPath('/invented/repo'))
        self.app = self.raw(self.plan['source_app'], 'healthy')
        fixture = self
        class MemoryPath(PurePosixPath):
            def exists(self): return str(self) in fixture.files
        self.Path = MemoryPath

    def raw(self, identity, health):
        running = health != 'exited'
        return dict(Id=identity['id'], Created=identity['created'], Image=identity['image_id'], ExecIDs=None,
            State=dict(Running=running, Paused=False, Restarting=False, Status='running' if running else 'exited',
                       Pid=101 if running else 0, Health=dict(Status=health)))

    def engine_type(self):
        f = self
        class Endpoints(n05.DockerEngine):
            def config_digest(self, which, deadline):
                f.check(deadline)
                if f.config_hook: f.config_hook(which, deadline)
                return self.plan['configs'][which]['sha256']
            def image(self, spec, deadline):
                f.check(deadline)
                return spec in (self.plan['candidate'], self.plan['return_image'])
            def ids(self, service, deadline):
                f.check(deadline)
                assert service == 'app'
                return [] if f.app is None else [f.app['Id']]
            def inspect(self, kind, identity, deadline):
                f.check(deadline)
                assert kind == 'container'
                if f.inspect_fault:
                    f.inspect_fault(identity, deadline)
                n05.require(f.app is not None, 'INVENTED_CONTAINER_MISSING')
                return copy.deepcopy(f.app)
            def snapshot(self, deadline):
                f.check(deadline)
                if f.snapshot_hook: f.snapshot_hook(deadline)
                if deadline == f.plan['phase_deadlines']['settlement_epoch'] and f.settlement_hook:
                    action = f.settlement_hook
                    f.settlement_hook = None
                    action()
                app = None
                if f.app:
                    which = 'previous' if f.app['Id'] == f.plan['source_app']['id'] else (
                        'candidate' if f.app['Image'] == f.plan['candidate']['id'] else 'return')
                    app = dict(id=f.app['Id'], created=f.app['Created'], image_id=f.app['Image'],
                        state=n05.app_state(f.app), config_sha256=f.plan['configs'][which]['sha256'])
                return copy.deepcopy(dict(engine=f.plan['engine'], project=f.plan['project'], app=app,
                    postgres=f.plan['postgres'], postgres_healthy=True, resources=f.plan['resources'],
                    ledger=f.plan['ledger'], migrators=[], foreign_containers=[]))
            def run(self, *args, deadline, input_text=None):
                f.check(deadline)
                f.calls.append((args, deadline, f.now))
                if args == ('compose','version','--short'): return '2.39.1'
                if args[0] == 'rm':
                    assert args == ('rm','-f', f.plan['source_app']['id'])
                    f.app = None
                    return ''
                if args[0] == 'compose' and 'up' in args:
                    returning = '--force-recreate' in args
                    n05.require(all(x in args for x in ('--no-start','--no-deps','--no-build','never','app')),
                                'INVENTED_COMPOSE_GRAMMAR')
                    if f.create_fault and not returning:
                        f.create_fault()
                    image = f.plan['return_image' if returning else 'candidate']['id']
                    f.app = f.raw(dict(id=('e' if returning else 'c')*64, created='invented-created-'+str(returning),
                                       image_id=image), 'starting')
                    return ''
                if args[0] == 'start':
                    assert args[1] == f.app['Id']
                    returning = f.app['Image'] == f.plan['return_image']['id']
                    if not returning and f.behavior in {'interrupt','endpoint-timeout'}:
                        if f.behavior == 'interrupt': raise KeyboardInterrupt()
                        raise n05.Denied('SUBPROCESS_DEADLINE_EXPIRED')
                    f.app['State']['Health']['Status'] = 'starting' if returning and f.return_slow else (
                        'healthy' if returning else f.behavior)
                    if f.behavior == 'exited' and not returning:
                        f.app['State'].update(Running=False, Status='exited', Pid=0)
                    return ''
                if args[0] == 'stop':
                    assert args[1] == '--time' and args[3] == f.app['Id']
                    if f.stop_fault: return f.stop_fault()
                    f.now += 2
                    f.app['State'].update(Running=False, Status='exited', Pid=0)
                    return ''
                raise AssertionError('unmodeled command '+repr(args))
        return Endpoints

    def check(self, deadline):
        n05.require(self.now < deadline, 'DEADLINE_EXPIRED')

    def sleep(self, value):
        assert value >= 0
        self.now += value

    def atomic(self, path, value):
        phase = value['events'][-1]['phase'] if 'events' in value else value['result']
        self.writes.append(phase)
        if self.write_fault == phase: raise self.write_error
        self.files[str(path)] = copy.deepcopy(value)
        if self.after_write_fault == phase: raise self.write_error
        if self.late_write == phase: self.now = self.plan['phase_deadlines']['return_epoch']+1

    def require_published(self, path):
        n05.require(str(path)+'.pending' not in self.files, 'PUBLICATION_INCOMPLETE')

    def begin_publication(self, path, plan):
        marker=str(path)+'.pending'
        n05.require(marker not in self.files, 'PUBLICATION_INCOMPLETE')
        token=dict(identity=(1,1),body=dict(plan_sha256=n05.sha(plan),output=str(path)))
        self.files[marker]=copy.deepcopy(token)
        return token

    def finish_publication(self,path,value,token,deadline,clock):
        n05.require(clock()<deadline,'DEADLINE_EXPIRED')
        n05.require(self.files[str(path)]==value,'PUBLICATION_READBACK_MISMATCH')
        n05.require(self.files[str(path)+'.pending']==token,'PUBLICATION_INTERLOCK_REPLACED')
        del self.files[str(path)+'.pending']

    def __enter__(self):
        self.patch = mock.patch.multiple(n05, Path=self.Path, private_file=lambda *a,**k: None,
            atomic_json=self.atomic, require_published=self.require_published,
            begin_publication=self.begin_publication, finish_publication=self.finish_publication,
            time=types.SimpleNamespace(time=lambda:self.now, sleep=self.sleep))
        self.patch.start()
        return self

    def __exit__(self, *unused): self.patch.stop()

    def forward(self):
        return n05.ForwardRecorder(self.engine, lambda:self.now).run(self.plan, self.Path(self.plan['receipt_path']))

    def request(self, receipt, reason='exited'):
        return dict(schema='FAI_CRM_N05_RETURN_REQUEST_V1', run_id=self.plan['run_id'], plan_sha256=n05.sha(self.plan),
            receipt_sha256=n05.sha(receipt), reason=reason, evidence=(dict(path='/invented/functional.json',
                sha256='f'*64, kind='functional-failure') if reason == 'functional-failure' else None))

    def returning(self, receipt, reason='exited'):
        return n05.ReturnController(self.engine, lambda:self.now).return_app(
            self.plan, receipt, self.request(receipt, reason), self.Path(self.plan['journal_path']))

    def assert_incomplete(self, test):
        receipt = self.files.get(self.plan['receipt_path'])
        if receipt:
            with test.assertRaises(n05.Denied): n05.validate_receipt(receipt, self.plan)
        test.assertNotIn(self.plan['journal_path'], self.files)


class DeadlineProtocol(unittest.TestCase):
    def test_starting_candidate_exhausts_only_forward_then_actual_stop_and_return(self):
        with Fixture() as f:
            original = n05.sha(f.plan)
            receipt = f.forward()
            self.assertEqual(f.now, 1362)
            self.assertEqual(receipt['events'][-1]['result'], 'candidate-stopped-after-failure')
            self.assertEqual(receipt['events'][5]['observation']['code'], 'CANDIDATE_OBSERVATION_DEADLINE_EXPIRED')
            self.assertEqual(receipt['events'][7]['observation']['state'], 'exited')
            n05.validate_receipt(receipt, f.plan)
            self.assertEqual(f.returning(receipt)['result'], 'PASS')
            self.assertEqual(original, n05.sha(f.plan))
            self.assertEqual([d for a,d,t in f.calls if a[0]=='start'], [1360,2080])
            self.assertEqual([d for a,d,t in f.calls if a[0]=='stop'], [1480])
            self.assertEqual(f.plan['deadline_epoch']-2080,180)
            self.assertFalse(any(d==2260 for a,d,t in f.calls))

    def test_early_endpoint_timeout_is_settled_with_original_bounds(self):
        with Fixture('endpoint-timeout') as f:
            receipt=f.forward()
            self.assertEqual(f.now,1002)
            self.assertEqual(receipt['events'][5]['observation']['code'],'SUBPROCESS_DEADLINE_EXPIRED')
            self.assertEqual(f.returning(receipt)['result'],'PASS')

    def test_interrupt_has_stop_before_return_without_fake_started_event(self):
        with Fixture('interrupt') as f:
            receipt=f.forward()
            self.assertNotIn('candidate-start',[e['phase'] for e in receipt['events']])
            self.assertEqual(receipt['events'][5]['observation']['code'],'FORWARD_INTERRUPTED')
            self.assertEqual(f.returning(receipt)['result'],'PASS')

    def test_normal_healthy_unhealthy_and_exited_paths_preserved(self):
        for behavior,reason in [('healthy','functional-failure'),('unhealthy','unhealthy'),('exited','exited')]:
            with self.subTest(behavior=behavior), Fixture(behavior) as f:
                receipt=f.forward()
                self.assertEqual(len(receipt['events']),7)
                self.assertEqual(receipt['events'][-1]['result'],'candidate-observed')
                self.assertEqual(f.returning(receipt,reason)['result'],'PASS')
                self.assertFalse(any(a[0]=='stop' for a,d,t in f.calls))

    def test_failed_create_observed_absence_remains_returnable(self):
        with Fixture() as f:
            f.create_fault=lambda: (_ for _ in ()).throw(n05.Denied('DOCKER_COMMAND_FAILED'))
            receipt=f.forward()
            self.assertEqual(receipt['events'][-1]['result'],'candidate-absent-attributed')
            self.assertEqual(f.returning(receipt,'absent')['result'],'PASS')

    def test_lost_create_reply_never_adopts_inventory_or_stops(self):
        with Fixture() as f:
            def lost():
                f.app=f.raw(dict(id='c'*64,created='unknown-create',image_id=f.plan['candidate']['id']),'starting')
                raise n05.Denied('SUBPROCESS_DEADLINE_EXPIRED')
            f.create_fault=lost
            with self.assertRaisesRegex(n05.Denied,'SUBPROCESS_DEADLINE_EXPIRED'): f.forward()
            self.assertEqual(f.app['Created'],'unknown-create')
            self.assertFalse(any(a[0] in {'start','stop'} for a,d,t in f.calls))
            f.assert_incomplete(self)

    def test_create_receipt_write_failure_never_starts_or_settles(self):
        with Fixture() as f:
            f.write_fault='candidate-create'
            with self.assertRaises(OSError): f.forward()
            self.assertFalse(any(a[0] in {'start','stop'} for a,d,t in f.calls))
            self.assertEqual(f.writes.count('candidate-create'),1)
            f.assert_incomplete(self)

    def test_receipt_failures_never_publish_positive_settlement_or_retry(self):
        for phase in ('forward-interrupted','settlement-intent','forward-result'):
            for error in (OSError('invented ENOSPC'),n05.Denied('INVENTED_WRITE_INTERRUPTED'),KeyboardInterrupt()):
                with self.subTest(phase=phase,error=type(error).__name__), Fixture() as f:
                    f.write_fault=phase; f.write_error=error
                    with self.assertRaises(type(error)): f.forward()
                    self.assertEqual(f.writes.count(phase),1)
                    self.assertEqual(any(a[0]=='stop' for a,d,t in f.calls),phase=='forward-result')
                    f.assert_incomplete(self)

    def test_normal_completion_write_failure_does_not_enter_settlement(self):
        with Fixture('healthy') as f:
            f.write_fault='forward-result';f.write_error=n05.Denied('INVENTED_WRITE_INTERRUPTED')
            with self.assertRaisesRegex(n05.Denied,'INVENTED_WRITE_INTERRUPTED'): f.forward()
            self.assertFalse(any(a[0]=='stop' for a,d,t in f.calls))
            f.assert_incomplete(self)

    def test_json_complete_before_failed_fsync_is_not_return_authority(self):
        for behavior in ('healthy','starting'):
            with self.subTest(behavior=behavior),Fixture(behavior) as f:
                f.after_write_fault='forward-result'
                with self.assertRaises(OSError):f.forward()
                receipt=f.files[f.plan['receipt_path']]
                n05.validate_receipt(receipt,f.plan) # syntax/chain alone is explicitly insufficient
                with self.assertRaisesRegex(n05.Denied,'PUBLICATION_INCOMPLETE'):
                    f.returning(receipt,'functional-failure' if behavior=='healthy' else 'exited')
                self.assertIn(f.plan['receipt_path']+'.pending',f.files)
                self.assertEqual(f.writes.count('forward-result'),1)

    def test_late_return_pass_write_retains_interlock_and_no_completion(self):
        with Fixture() as f:
            receipt=f.forward();f.late_write='PASS'
            with self.assertRaisesRegex(n05.Denied,'DEADLINE_EXPIRED'):f.returning(receipt)
            self.assertEqual(f.files[f.plan['journal_path']]['result'],'PASS')
            with self.assertRaisesRegex(n05.Denied,'PUBLICATION_INCOMPLETE'):
                n05.require_published(f.Path(f.plan['journal_path']))
            self.assertIn(f.plan['journal_path']+'.pending',f.files)

    def test_local_client_stop_unverified_does_not_enter_settlement(self):
        with Fixture() as f:
            def unknown(identity,deadline):
                if identity=='c'*64: raise n05.Denied('LOCAL_COMMAND_STOP_UNVERIFIED')
            f.inspect_fault=unknown
            with self.assertRaisesRegex(n05.Denied,'LOCAL_COMMAND_STOP_UNVERIFIED'):f.forward()
            self.assertFalse(any(a[0]=='stop' for a,d,t in f.calls))
            f.assert_incomplete(self)

    def test_settlement_engine_unavailable_leaves_incomplete_receipt(self):
        with Fixture() as f:
            def offline(deadline):
                if deadline==1480: raise n05.Denied('INVENTED_ENGINE_UNAVAILABLE')
            f.snapshot_hook=offline
            with self.assertRaisesRegex(n05.Denied,'INVENTED_ENGINE_UNAVAILABLE'): f.forward()
            self.assertFalse(any(a[0]=='stop' for a,d,t in f.calls))
            f.assert_incomplete(self)

    def test_settlement_rejects_replaced_id_creation_or_image_without_stop(self):
        for key,value in [('Id','1'*64),('Created','replacement'),('Image','sha256:'+'e'*64)]:
            with self.subTest(key=key),Fixture() as f:
                f.settlement_hook=lambda:f.app.update({key:value})
                with self.assertRaisesRegex(n05.Denied,'SETTLEMENT_CANDIDATE_DRIFT'): f.forward()
                self.assertFalse(any(a[0]=='stop' for a,d,t in f.calls))
                f.assert_incomplete(self)

    def test_settlement_last_inspect_identity_check_precedes_stop(self):
        with Fixture() as f:
            def replace(identity, deadline):
                if deadline==1480: f.app['Created']='replaced-between-snapshot-and-stop'
            f.inspect_fault=replace
            with self.assertRaisesRegex(n05.Denied,'SETTLEMENT_INSTANCE_DRIFT'): f.forward()
            self.assertFalse(any(a[0]=='stop' for a,d,t in f.calls))
            f.assert_incomplete(self)

    def test_failed_stop_never_produces_returnable_receipt(self):
        for outcome in ('running','pid','exec','command-error','timeout'):
            with self.subTest(outcome=outcome),Fixture() as f:
                def bad():
                    if outcome=='command-error': raise n05.Denied('DOCKER_COMMAND_FAILED')
                    if outcome=='timeout':
                        f.now=1480
                        raise n05.Denied('SUBPROCESS_DEADLINE_EXPIRED')
                    if outcome!='running':f.app['State'].update(Running=False,Status='exited',Pid=0)
                    if outcome=='pid':f.app['State']['Pid']=123
                    if outcome=='exec':f.app['ExecIDs']=['invented-exec']
                    return ''
                f.stop_fault=bad
                with self.assertRaises(n05.Denied):f.forward()
                f.assert_incomplete(self)

    def test_paused_or_restarting_or_exec_is_not_hidden_unpause_stop(self):
        for key in ('Paused','Restarting','ExecIDs'):
            with self.subTest(key=key),Fixture() as f:
                def change():
                    if key=='ExecIDs':f.app[key]=['unattributed']
                    else:f.app['State'][key]=True
                f.settlement_hook=change
                with self.assertRaisesRegex(n05.Denied,'SETTLEMENT_RUNTIME_UNCERTAIN'):f.forward()
                self.assertFalse(any(a[0]=='stop' for a,d,t in f.calls))
                f.assert_incomplete(self)

    def test_post_stop_identity_drift_and_boundary_failure_are_not_positive(self):
        for mode in ('identity','boundary'):
            with self.subTest(mode=mode),Fixture() as f:
                def stop():
                    f.app['State'].update(Running=False,Status='exited',Pid=0)
                    if mode=='identity':f.app['Created']='replaced-after-stop'
                    else:f.snapshot_hook=lambda d: (_ for _ in ()).throw(n05.Denied('MUTATION_BOUNDARY_DRIFT'))
                    return ''
                f.stop_fault=stop
                with self.assertRaises(n05.Denied):f.forward()
                f.assert_incomplete(self)

    def test_expired_forward_denies_before_files_or_engine(self):
        with Fixture() as f:
            f.now=1360
            with self.assertRaisesRegex(n05.Denied,'DEADLINE_EXPIRED'):f.forward()
            self.assertEqual(f.writes,[]);self.assertEqual(f.calls,[])

    def test_slow_preflight_cannot_start_mutations_or_borrow_reserve(self):
        with Fixture() as f:
            f.config_hook=lambda which,deadline:setattr(f,'now',1361)
            with self.assertRaisesRegex(n05.Denied,'DEADLINE_EXPIRED'):f.forward()
            self.assertEqual(f.writes,[]);self.assertEqual(f.calls,[])
            self.assertEqual(f.app['Id'],f.plan['source_app']['id'])

    def test_original_settlement_and_return_epochs_never_renew(self):
        with Fixture() as f:
            def unavailable(identity,deadline):
                if deadline==1360:
                    f.now=1480
                    raise n05.Denied('SUBPROCESS_DEADLINE_EXPIRED')
            f.inspect_fault=unavailable
            with self.assertRaisesRegex(n05.Denied,'DEADLINE_EXPIRED'):f.forward()
            self.assertFalse(any(a[0]=='stop' for a,d,t in f.calls))
            f.assert_incomplete(self)
        with Fixture() as f:
            receipt=f.forward();f.now=2080;before=len(f.calls)
            with self.assertRaisesRegex(n05.Denied,'DEADLINE_EXPIRED'):f.returning(receipt)
            self.assertEqual(len(f.calls),before)

    def test_return_starting_exhausts_return_bound_preserving_cleanup_reserve(self):
        with Fixture() as f:
            receipt=f.forward();f.return_slow=True
            with self.assertRaisesRegex(n05.Denied,'DEADLINE_EXPIRED'):f.returning(receipt)
            self.assertEqual(f.now,2080)
            self.assertEqual(f.plan['deadline_epoch']-f.now,180)
            self.assertEqual(f.files[f.plan['journal_path']]['result'],'FAILED')
            with self.assertRaisesRegex(n05.Denied,'RETURN_ALREADY_ATTEMPTED'):f.returning(receipt)

    def test_deadline_reserves_and_types_validated_before_any_mutation(self):
        changes=[('forward_epoch',1480),('settlement_epoch',2070),('return_epoch',2259),
                 ('cleanup_reserve_seconds',181),('settlement_reserve_seconds',0),
                 ('return_reserve_seconds',601),('forward_epoch',True),('return_epoch',float('nan'))]
        for key,value in changes:
            with self.subTest(key=key,value=value),Fixture() as f:
                f.plan['phase_deadlines'][key]=value
                with self.assertRaises(n05.Denied):f.forward()
                self.assertEqual(f.calls,[]);self.assertEqual(f.writes,[])
        with Fixture() as f:
            f.plan['phase_deadlines']['unknown_epoch']=2100
            with self.assertRaisesRegex(n05.Denied,'PHASE_DEADLINES_INVALID'):f.forward()

    def test_phase_or_total_changes_invalidate_receipt_and_evidence_binding(self):
        with Fixture() as f:
            receipt=f.forward();binding=n05.evidence_binding(f.plan)
            for key in (*n05.PHASE_KEYS,'deadline_epoch'):
                changed=copy.deepcopy(f.plan)
                if key=='deadline_epoch':changed[key]+=1
                else:changed['phase_deadlines'][key]+=1
                self.assertNotEqual(n05.evidence_binding(changed),binding)
                with self.assertRaisesRegex(n05.Denied,'RECEIPT_BINDING_INVALID'):n05.validate_receipt(receipt,changed)

    def test_v2_new_forward_denied_and_historical_receipt_return_retained(self):
        with Fixture('unhealthy') as f:
            receipt=f.forward()
            f.plan['schema']=n05.PLAN_V2;del f.plan['phase_deadlines']
            receipt['schema']='FAI_CRM_N05_FORWARD_RECEIPT_V1';receipt['plan_sha256']=n05.sha(f.plan)
            f.now=2100 # after the V3 return bound, before this historical V2 total
            # Historical plan has no V3 field. Keep native observations modeled
            # without adding a phase extension to that unchanged old schema.
            def snapshot(d):
                app=dict(id=f.app['Id'],created=f.app['Created'],image_id=f.app['Image'],
                         state=n05.app_state(f.app),config_sha256=f.plan['configs']['candidate']['sha256'])
                if f.app['Id']=='e'*64:app['config_sha256']=f.plan['configs']['return']['sha256']
                return copy.deepcopy(dict(engine=f.plan['engine'],project=f.plan['project'],app=app,
                    postgres=f.plan['postgres'],postgres_healthy=True,resources=f.plan['resources'],
                    ledger=f.plan['ledger'],migrators=[],foreign_containers=[]))
            f.engine.snapshot=snapshot
            before=len(f.calls)
            with self.assertRaisesRegex(n05.Denied,'NEW_FORWARD_REQUIRES_V3'):f.forward()
            self.assertEqual(len(f.calls),before)
            self.assertEqual(f.returning(receipt,'unhealthy')['result'],'PASS')
            self.assertEqual([d for a,d,t in f.calls if a[0]=='start'][-1],2260)

    def test_settlement_receipt_missing_forged_or_renamed_proof_is_rejected(self):
        with Fixture() as f:
            receipt=f.forward()
            changes=[lambda r:r['events'].pop(7),
                     lambda r:r['events'][7]['observation'].update(stop_verified=False),
                     lambda r:r['events'][7]['observation'].update(candidate=dict(
                         r['events'][7]['observation']['candidate'],created='other')),
                     lambda r:r['events'][6]['observation'].update(settlement_epoch=9999),
                     lambda r:r['events'][5]['observation'].update(forward_epoch=9999)]
            for change in changes:
                with self.subTest(change=change):
                    altered=copy.deepcopy(receipt);change(altered)
                    rebuilt=[]
                    for e in altered['events']:
                        rebuilt.append(n05.event(rebuilt[-1] if rebuilt else None,f.plan['run_id'],
                            e['phase'],e['result'],e['observation']))
                    altered['events']=rebuilt
                    with self.assertRaises(n05.Denied):n05.validate_receipt(altered,f.plan)


class CommandTermination(unittest.TestCase):
    def exercise(self, mode):
        clock=[1000.0]; calls=[]
        class Process:
            pid=12345
            def __init__(self):self.count=0
            def communicate(self, input_text=None, timeout=None):
                calls.append(('communicate',timeout));self.count+=1
                if self.count==1:
                    clock[0]=1010.0
                    if mode=='interrupt':raise KeyboardInterrupt()
                    raise subprocess.TimeoutExpired('invented Docker client',timeout)
                if mode=='reap-timeout':
                    clock[0]+=timeout
                    raise subprocess.TimeoutExpired('invented reap',timeout)
                if mode=='reap-interrupted':raise KeyboardInterrupt()
                if mode=='late-reap':clock[0]=1031
                return ('','')
            def poll(self):return None if mode=='leader-active' else -9
        process=Process()
        def killpg(pid,signum):
            self.assertEqual(pid,process.pid);calls.append(('killpg',signum))
            if mode=='kill-failed' and signum==9:raise PermissionError('invented denial')
            if signum==0 and mode!='group-active':raise ProcessLookupError()
        with mock.patch.object(n05.subprocess,'Popen',return_value=process) as popen, \
             mock.patch.object(n05.os,'killpg',side_effect=killpg,create=True), \
             mock.patch.object(n05,'time',types.SimpleNamespace(time=lambda:clock[0],sleep=lambda n:clock.__setitem__(0,clock[0]+n))):
            error=None
            try:n05.run_deadline(['invented-no-process'],{},1010,stop_deadline=1030)
            except BaseException as caught:error=caught
            self.assertEqual(popen.call_count,1)
        return error,calls,clock[0]

    def test_timeout_reaps_verified_group_with_original_absolute_reserve(self):
        error,calls,clock=self.exercise('timeout')
        self.assertIsInstance(error,n05.Denied);self.assertEqual(str(error),'SUBPROCESS_DEADLINE_EXPIRED')
        self.assertEqual([c[1] for c in calls if c[0]=='communicate'],[10,20])
        self.assertIn(('killpg',0),calls);self.assertEqual(clock,1010)

    def test_interrupt_reaps_before_propagating(self):
        error,calls,clock=self.exercise('interrupt')
        self.assertIsInstance(error,KeyboardInterrupt)
        self.assertIn(('killpg',9),calls);self.assertIn(('killpg',0),calls)
        self.assertEqual([c[1] for c in calls if c[0]=='communicate'],[10,20])

    def test_unverified_kill_leader_group_and_blocked_reap_are_terminal(self):
        for mode in ('kill-failed','leader-active','group-active','reap-timeout','reap-interrupted','late-reap'):
            with self.subTest(mode=mode):
                error,calls,clock=self.exercise(mode)
                self.assertIsInstance(error,n05.Denied)
                self.assertEqual(str(error),'LOCAL_COMMAND_STOP_UNVERIFIED')
                self.assertTrue(all(c[1] is not None and c[1]<=20 for c in calls if c[0]=='communicate'))
                if mode in ('group-active','reap-timeout'):self.assertEqual(clock,1030)

    def test_no_bound_extension_and_no_command_without_local_stop_reserve(self):
        with mock.patch.object(n05.subprocess,'Popen') as popen, \
             mock.patch.object(n05,'time',types.SimpleNamespace(time=lambda:1000)):
            with self.assertRaisesRegex(n05.Denied,'COMMAND_STOP_BOUND_INVALID'):
                n05.run_deadline(['invented'],{},1020,stop_deadline=1019)
            with self.assertRaisesRegex(n05.Denied,'DEADLINE_EXPIRED'):
                n05.run_deadline(['invented'],{},1001)
            popen.assert_not_called()


class PublicationCommit(unittest.TestCase):
    def exercise(self, failure=None):
        calls=[];present=[True]
        token=dict(identity=(1,2),body=dict(schema='invented',run_id='invented-publication'))
        metadata=types.SimpleNamespace(st_dev=1,st_ino=2,st_nlink=1,st_mode=n05.stat.S_IFREG|0o600)
        marker=mock.Mock()
        marker.lstat.side_effect=lambda:(calls.append('lstat') or metadata)
        output=PurePosixPath('/invented/output')
        value={'invented':'complete-data-already-fsynced'}
        def close(fd):
            calls.append('close')
            if failure=='close':raise OSError('invented close failure')
        def unlink(path):
            self.assertIs(path,marker);calls.append('unlink')
            present[0]=False
        def read(fd,count):
            calls.append('read')
            if failure=='read':raise OSError('invented read failure')
            return (n05.canonical(token['body'])+'\n').encode()
        with mock.patch.object(n05,'publication_path',return_value=marker), \
             mock.patch.object(n05,'private_file'),mock.patch.object(n05,'strict_json',return_value=value), \
             mock.patch.object(n05.os,'open',return_value=9),mock.patch.object(n05.os,'fstat',return_value=metadata), \
             mock.patch.object(n05.os,'read',side_effect=read),mock.patch.object(n05.os,'close',side_effect=close), \
             mock.patch.object(n05.os,'unlink',side_effect=unlink), \
             mock.patch.object(n05.os,'O_NOFOLLOW',0,create=True), \
             mock.patch.object(n05.os,'fsync',side_effect=OSError('must never fsync after commit')) as fsync, \
             mock.patch.object(n05.os.path,'lexists',side_effect=lambda path:present[0]):
            error=None
            try:n05.finish_publication(output,value,token,1010,lambda:1000)
            except BaseException as caught:error=caught
            fsync.assert_not_called()
            if error:
                with self.assertRaisesRegex(n05.Denied,'PUBLICATION_INCOMPLETE'):n05.require_published(output)
            else:n05.require_published(output)
        return error,calls,present[0]

    def test_unlink_is_last_commit_after_all_fallible_checks_and_close(self):
        error,calls,present=self.exercise()
        self.assertIsNone(error);self.assertFalse(present)
        self.assertEqual(calls[-1],'unlink');self.assertLess(calls.index('close'),calls.index('unlink'))

    def test_read_or_close_failure_preserves_interlock_for_consumer(self):
        for failure in ('read','close'):
            with self.subTest(failure=failure):
                error,calls,present=self.exercise(failure)
                self.assertIsInstance(error,OSError);self.assertTrue(present);self.assertNotIn('unlink',calls)


if __name__ == '__main__': unittest.main(verbosity=2)
