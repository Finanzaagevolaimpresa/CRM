"""Offline rejection and failure tests. Never connects to the production target."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
import signal
import subprocess
from pathlib import Path
import sys
import tempfile
import tarfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
tempfile.tempdir = str(Path(__file__).resolve().parent)
import common
import download_images as download
import isolated_restore as restore
import owner_release as owner
import remote_release as remote
import qualified_images as qualified
import receive_package as receiver


class QualifiedImageTests(unittest.TestCase):
    def fixture(self, folder):
        archive = Path(folder) / 'images.tar.gz'
        b = {'candidate':'a'*40, 'candidateTree':'b'*40, 'returnCommit':'c'*40,
             'returnTree':'d'*40, 'imageStoreVersion':'29.6.1'}
        observations = {}
        with tarfile.open(archive, 'w:gz') as stream:
            for role in ('candidate','return'):
                commit = b['candidate' if role == 'candidate' else 'returnCommit']
                labels = {'org.opencontainers.image.revision':commit,
                          'it.finanzaagevolaimpresa.source-tree':b[role+'Tree']}
                config = {'os':'linux','architecture':'amd64','config':{'Labels':labels},
                          'rootfs':{'diff_ids':['sha256:'+'e'*64]}}
                config_raw = common.canonical(config)
                b[role+'ConfigDigest'] = 'sha256:' + hashlib.sha256(config_raw).hexdigest()
                manifest_raw = common.canonical({'config':{'digest':b[role+'ConfigDigest']}})
                b[role+'Image'] = 'sha256:' + hashlib.sha256(manifest_raw).hexdigest()
                for raw in (config_raw,manifest_raw):
                    info = tarfile.TarInfo('blobs/sha256/'+hashlib.sha256(raw).hexdigest())
                    info.size = len(raw)
                    stream.addfile(info,io.BytesIO(raw))
                tag = 'fai-crm:r05-' + ('candidate' if role == 'candidate' else 'recovery') + '-' + commit
                observations[b[role+'Image']] = {'id':b[role+'Image'],'os':'linux','architecture':'amd64',
                    'layers':config['rootfs']['diff_ids'],'tags':[tag],'commit':commit,'tree':b[role+'Tree']}
        b['imageArchiveSha256'] = common.digest(archive)
        engine = {'version':'29.6.1','driver':'overlayfs','status':[['driver-type','io.containerd.snapshotter.v1']]}
        calls = []
        def docker(command_id,*args,**_):
            calls.append((command_id,args))
            return common.canonical(engine if args[0]=='info' else observations[args[2]])
        return archive,b,observations,engine,calls,SimpleNamespace(docker=docker)

    def test_manifest_identity_is_bound_to_original_config_and_layers(self):
        with tempfile.TemporaryDirectory() as folder:
            archive,b,observations,engine,calls,commands = self.fixture(folder)
            result = qualified.verify_images(commands,archive,b)
            self.assertEqual(result['candidate']['configDigest'],b['candidateConfigDigest'])
            self.assertNotEqual(result['candidate']['imageId'],b['candidateConfigDigest'])
            self.assertEqual([args[2] for _,args in calls if args[0]=='image'],[b['candidateImage'],b['returnImage']])
            self.assertTrue(all(args[0]=='info' or args[:2]==('image','inspect') for _,args in calls))

    def test_config_manifest_link_or_archive_tamper_rejected_before_docker(self):
        with tempfile.TemporaryDirectory() as folder:
            archive,b,_,_,calls,commands = self.fixture(folder)
            swapped = b | {'candidateConfigDigest':b['returnConfigDigest'],'returnConfigDigest':b['candidateConfigDigest']}
            with self.assertRaisesRegex(common.Stop,'QUALIFIED_MANIFEST_CONFIG_LINK'):
                qualified.verify_images(commands,archive,swapped)
            with archive.open('ab') as stream:
                stream.write(b'changed')
            with self.assertRaisesRegex(common.Stop,'QUALIFIED_ARCHIVE_CHANGED'):
                qualified.verify_images(commands,archive,b)
            self.assertEqual(calls,[])

    def test_runtime_identity_platform_layers_tag_and_labels_are_all_required(self):
        changes = {'id':'sha256:'+'f'*64,'os':'windows','architecture':'arm64',
                   'layers':['sha256:'+'f'*64],'tags':[],'commit':'e'*40,'tree':'f'*40}
        for key,value in changes.items():
            with self.subTest(key=key),tempfile.TemporaryDirectory() as folder:
                archive,b,observations,_,_,commands = self.fixture(folder)
                observations[b['candidateImage']][key] = value
                with self.assertRaisesRegex(common.Stop,'QUALIFIED_IMAGE_PROVENANCE'):
                    qualified.verify_images(commands,archive,b)

    def test_changed_engine_is_reconciled_before_image_inspect(self):
        with tempfile.TemporaryDirectory() as folder:
            archive,b,_,engine,calls,commands = self.fixture(folder)
            engine['status'] = []
            with self.assertRaisesRegex(common.Stop,'IMAGE_STORE_RECONCILIATION_REQUIRED'):
                qualified.verify_images(commands,archive,b)
            self.assertEqual(len(calls),1)


class PreparedArchiveReuseTests(unittest.TestCase):
    def test_owner_reaches_prepare_without_any_local_image_or_downloader(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            common.exclusive(root/'package.json',{'runId':'a'*32})
            with patch.object(owner,'ROOT',root),patch.object(owner,'admit'),patch.object(owner,'storage'), \
                 patch.object(owner,'upload') as upload,patch.object(owner,'stage_call',side_effect=common.Stop('SYNTHETIC_PREPARE_STOP')) as stage, \
                 patch.object(owner.subprocess,'run',side_effect=AssertionError('No local download permitted')), \
                 patch('builtins.print'):
                self.assertEqual(owner.main(),2)
            upload.assert_called_once_with({'runId':'a'*32})
            stage.assert_called_once_with({'runId':'a'*32},'prepare')
            self.assertEqual(common.load(root/'ESITO-ASSISTITO.json')['code'],'SYNTHETIC_PREPARE_STOP')

    def test_owner_transport_does_not_include_or_open_local_images(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            manifest = {'runId':'a'*32,'files':{receiver.IMAGE_NAME:{'bytes':543331793},'receive_package.py':{}}}
            common.exclusive(root/'package.json',manifest)
            common.exclusive(root/'receive_package.py',b'# synthetic bootstrap, never executed\n')
            with patch.object(owner,'ROOT',root),patch.object(owner,'call',return_value=(0,b'{"status":"PACKAGE_RECEIVED"}',b'')),patch('builtins.print'):
                owner.upload(manifest)
            with tarfile.open(root/'owner-transfer.tar') as archive:
                self.assertEqual(set(archive.getnames()),{'package.json','receive_package.py'})
            self.assertFalse((root/receiver.IMAGE_NAME).exists())

    def fixture(self,folder):
        prior,destination = Path(folder)/'prior',Path(folder)/'new'
        prior.mkdir(mode=0o700)
        destination.mkdir(mode=0o700)
        (prior/'evidence').mkdir(mode=0o700)
        payload = b'synthetic-already-transferred-image-archive'
        common.exclusive(prior/receiver.IMAGE_NAME,payload)
        entry = {'bytes':len(payload),'sha256':hashlib.sha256(payload).hexdigest()}
        common.exclusive(prior/'package.json',{'runId':'e67bea4040fc4aeb86a0c98ac6178e7e','files':{receiver.IMAGE_NAME:entry}})
        common.exclusive(prior/'evidence/prepare.stop.json',{'status':'STOP','stage':'prepare','code':'COMMAND_FAILED',
            'details':{'commandId':'INSPECT_IMAGE','exitCode':1,'stderrBytes':115,
                      'stderrSha256':'ff8de78af764da229499fee0e1131c12a6688c63664b8c8bbbe4cc2b5cbd06d0'}})
        return prior,destination,entry

    def test_reuse_copies_verified_bytes_without_changing_old_receipts(self):
        with tempfile.TemporaryDirectory() as folder:
            prior,destination,entry = self.fixture(folder)
            before = {p.relative_to(prior):p.read_bytes() for p in prior.rglob('*') if p.is_file()}
            with patch.object(receiver,'PREPARED',prior),patch.object(receiver,'PREPARED_MANIFEST_SHA',common.digest(prior/'package.json')):
                receiver.reuse_images(destination,entry)
                with self.assertRaises(FileExistsError):
                    receiver.reuse_images(destination,entry)
            self.assertEqual(common.digest(destination/receiver.IMAGE_NAME),entry['sha256'])
            self.assertEqual(before,{p.relative_to(prior):p.read_bytes() for p in prior.rglob('*') if p.is_file()})

    def test_any_later_intent_blocks_reuse(self):
        with tempfile.TemporaryDirectory() as folder:
            prior,destination,entry = self.fixture(folder)
            common.exclusive(prior/'evidence/backup.intent.json',{})
            with patch.object(receiver,'PREPARED',prior),patch.object(receiver,'PREPARED_MANIFEST_SHA',common.digest(prior/'package.json')):
                with self.assertRaisesRegex(RuntimeError,'REUSE_LATER_STAGE_STARTED'):
                    receiver.reuse_images(destination,entry)
            self.assertFalse((destination/receiver.IMAGE_NAME).exists())

    def test_wrong_old_package_or_image_is_not_adopted(self):
        for change in ('package','image'):
            with self.subTest(change=change),tempfile.TemporaryDirectory() as folder:
                prior,destination,entry = self.fixture(folder)
                expected = common.digest(prior/'package.json')
                name = 'package.json' if change=='package' else receiver.IMAGE_NAME
                with (prior/name).open('ab') as stream:
                    stream.write(b'changed')
                with patch.object(receiver,'PREPARED',prior),patch.object(receiver,'PREPARED_MANIFEST_SHA',expected):
                    with self.assertRaisesRegex(RuntimeError,'REUSE_PACKAGE_CHANGED|REUSE_IMAGE_SIZE'):
                        receiver.reuse_images(destination,entry)
                self.assertFalse((destination/receiver.IMAGE_NAME).exists())


class DownloadTests(unittest.TestCase):
    @staticmethod
    def response(data=b'abcdef', start=100, status=206, total=1000, length=None):
        end = start + len(data) - 1
        return (('HTTP/2.0 %d Test\nContent-Range: bytes %d-%d/%d\r\nContent-Length: %d\r\n\r\n' %
                 (status, start, end, total, len(data) if length is None else length)).encode() + data)

    def test_exact_range_mixed_header_endings(self):
        self.assertEqual(download.validate_range(0, self.response(), b'', False, 100, 105, 1000), b'abcdef')

    def test_full_response_cannot_append_to_partial(self):
        with self.assertRaisesRegex(download.Stop, 'SERVER_DID_NOT_HONOR_RANGE'):
            download.validate_range(0, self.response(status=200), b'', False, 100, 105, 1000)

    def test_wrong_range_total_or_length_denied(self):
        for raw in [self.response(start=0), self.response(total=1001), self.response(length=7)]:
            with self.assertRaises(download.Stop):
                download.validate_range(0, raw, b'', False, 100, 105, 1000)

    def test_duplicate_header_rejected(self):
        raw = self.response().replace(b'Content-Length:', b'Content-Range: bytes 100-105/1000\r\nContent-Length:')
        with self.assertRaisesRegex(download.Stop, 'DUPLICATE_RESPONSE_HEADER'):
            download.validate_range(0, raw, b'', False, 100, 105, 1000)

    def test_only_transient_failures_retry(self):
        calls, events = [], []
        def interrupted(args, cap, timeout):
            calls.append(args)
            if len(calls) < 3:
                return 1, b'', b'unexpected EOF: https://secret.invalid/token', False
            return 0, self.response(), b'', False
        with contextlib.redirect_stdout(io.StringIO()):
            data = download.obtain_range(10850108348, 100, 105, 1000, download.time.monotonic() + 60, events, interrupted)
        self.assertEqual(data, b'abcdef')
        self.assertEqual(len(calls), 3)
        self.assertNotIn('secret.invalid', json.dumps(events))
        self.assertEqual(events[0]['code'], 'GITHUB_CONNECTION_INTERRUPTED')

    def test_authentication_does_not_retry(self):
        calls = []
        def denied(*args):
            calls.append(args)
            return 1, b'', b'HTTP 401: Bad credentials', False
        with self.assertRaisesRegex(download.Stop, 'GITHUB_AUTHENTICATION_REQUIRED'):
            download.obtain_range(1, 0, 5, 10, download.time.monotonic() + 30, [], denied)
        self.assertEqual(len(calls), 1)

    def test_deadline_precedes_next_request(self):
        with self.assertRaisesRegex(download.Stop, 'TRANSFER_TIME_LIMIT_REACHED'):
            download.obtain_range(1, 0, 5, 10, 0, [], lambda *args: self.fail('network call'))

    def test_zip_member_set_and_artifact_digest(self):
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder) / 'bad.zip'
            with zipfile.ZipFile(p, 'w') as z:
                z.writestr('../untrusted', b'bad')
            with self.assertRaisesRegex(download.Stop, 'ARTIFACT_ENTRY_SET_MISMATCH'):
                download.verify_extract(p, Path(folder), 0, (1, p.stat().st_size, download.sha(p)))
            with self.assertRaisesRegex(download.Stop, 'ARTIFACT_SIZE_OR_HASH_MISMATCH'):
                download.verify_extract(p, Path(folder), 0, (1, p.stat().st_size, '0' * 64))
            self.assertFalse((Path(folder).parent / 'untrusted').exists())


class StageTests(unittest.TestCase):
    def test_intent_not_replayable_after_lost_success(self):
        with tempfile.TemporaryDirectory() as d:
            os.chmod(d, 0o700)
            s = common.Stages(Path(d), 'a' * 32)
            s.begin('backup', [])
            with self.assertRaisesRegex(common.Stop, 'STAGE_CONSUMED_RECONCILE_ONLY'):
                s.begin('backup', [])
            with self.assertRaisesRegex(common.Stop, 'PREDECESSOR_NOT_VERIFIED'):
                s.begin('migrate', ['backup'])

    def test_dependencies_and_immutable_receipts(self):
        with tempfile.TemporaryDirectory() as d:
            os.chmod(d, 0o700)
            s = common.Stages(Path(d), 'a' * 32)
            s.begin('backup', [])
            r = s.complete('backup', {'verified': True})
            before = (Path(d) / 'backup.json').read_bytes()
            s.begin('protect', ['backup'])
            with self.assertRaises(FileExistsError):
                s.complete('backup', {'verified': False})
            self.assertEqual((Path(d) / 'backup.json').read_bytes(), before)
            self.assertEqual(s.result('backup'), r)

    def test_other_run_receipt_does_not_authorize(self):
        with tempfile.TemporaryDirectory() as d:
            os.chmod(d, 0o700)
            common.exclusive(Path(d) / 'backup.json', {'status': 'PASS', 'runId': 'b' * 32})
            with self.assertRaisesRegex(common.Stop, 'PREDECESSOR_NOT_VERIFIED'):
                common.Stages(Path(d), 'a' * 32).begin('protect', ['backup'])

    def test_duplicate_or_nonfinite_json_denied(self):
        for raw in (b'{"status":"STOP","status":"PASS"}', b'{"value":NaN}'):
            with self.assertRaises(common.Stop):
                common.decode(raw)

    def test_historical_runs_not_referenced_for_execution(self):
        b = common.load(Path(__file__).parent / 'binding.json')
        self.assertEqual(len(b['ledger46']), 46)
        self.assertEqual(len(b['ledger48']), 48)
        self.assertEqual(len(set(b['ledger48']) - set(b['ledger46'])), 2)
        self.assertTrue(all(b['ledger48'][k] == v for k,v in b['ledger46'].items()))

    def test_canonical_hashes_match_qualified_repository_bytes(self):
        root = Path(__file__).resolve().parents[2]
        b = common.load(root / 'scripts/m1-assisted/binding.json')
        for name, expected in b['canonicalPrograms'].items():
            raw = subprocess.check_output(['git','show','HEAD:' + name], cwd=root)
            self.assertEqual(hashlib.sha256(raw).hexdigest(), expected, name)
        raw = subprocess.check_output(['git','show','HEAD:scripts/pr140/owner_backup46.py'], cwd=root)
        self.assertEqual(hashlib.sha256(raw).hexdigest(), b['backupProgramSha256'])
        inventory = {}
        names = subprocess.check_output(['git','ls-tree','-r','--name-only','HEAD','prisma/migrations'], cwd=root).decode().splitlines()
        for name in names:
            if name.endswith('/migration.sql'):
                raw = subprocess.check_output(['git','show','HEAD:' + name], cwd=root)
                inventory[Path(name).parent.name] = hashlib.sha256(raw).hexdigest()
        self.assertEqual(inventory, b['ledger48'])


class AdmissionTests(unittest.TestCase):
    def test_protected_configuration_drift_blocks_model_and_deploy(self):
        with tempfile.TemporaryDirectory() as folder:
            runtime = Path(folder)
            path = runtime / '.env.production'
            path.write_bytes(b'SYNTHETIC_CONFIGURATION=original\n')
            expected = common.digest(path)
            release = remote.Release.__new__(remote.Release)
            release.runtime = runtime
            release.stages = SimpleNamespace(result=lambda _: {'configurationSha256': expected})
            release.require_config_binding()
            path.write_bytes(b'SYNTHETIC_CONFIGURATION=changed\n')
            for action in (release.models, release.deploy, release.postcheck):
                with self.assertRaisesRegex(common.Stop, 'PROTECTED_CONFIGURATION_CHANGED'):
                    action()

    def test_provision_holds_canonical_lock_and_releases_on_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            descriptor = os.open(str(Path(folder) / 'lock'), os.O_RDWR | os.O_CREAT, 0o600)
            release = remote.Release.__new__(remote.Release)
            release.t = {'engineId': 'synthetic-engine'}
            def acquire(path, binding):
                self.assertEqual(binding, {'engine_id': 'synthetic-engine', 'project': 'fai-crm'})
                return descriptor
            release.n05 = lambda: SimpleNamespace(PRODUCTION_LOCK_PATH='synthetic-lock', acquire_lock=acquire)
            def operation():
                os.fstat(descriptor)
                raise common.Stop('SYNTHETIC_PROVISION_FAILURE')
            release.provision_locked = operation
            with self.assertRaisesRegex(common.Stop, 'SYNTHETIC_PROVISION_FAILURE'):
                release.provision({'keyConfirmation': remote.KEY_CONFIRMATION})
            with self.assertRaises(OSError):
                os.fstat(descriptor)

    def test_migrator_timeout_preserves_settlement_reserve_and_lock_release(self):
        for settles in (True, False):
            with self.subTest(settles=settles), tempfile.TemporaryDirectory() as folder:
                clock = {'now': 1000.0}
                calls = []
                raw = {'Id':'a'*64, 'Created':'synthetic-created', 'Image':'sha256:'+'b'*64,
                       'Mounts':[], 'HostConfig':{'PortBindings':{}}, 'ExecIDs':None,
                       'State':{'Running':True,'Pid':123}}
                class Commands(common.Commands):
                    def docker(self, command_id, *args, **options):
                        self.remaining(options.get('seconds',60))
                        calls.append(command_id)
                        if command_id == 'MIGRATOR_CREATE':
                            return ('a'*64).encode()
                        if command_id == 'MIGRATOR_WAIT':
                            clock['now'] = self.wall_end + 1
                            raise common.Stop('SYNTHETIC_MIGRATOR_TIMEOUT')
                        if command_id == 'MIGRATOR_SETTLE' and settles:
                            signal.getsignal(signal.SIGINT)(signal.SIGINT, None)
                            raw['State'].update(Running=False,Pid=0)
                        return b''
                    def inspect(self, *args):
                        self.remaining(60)
                        return copy.deepcopy(raw)
                descriptor = os.open(str(Path(folder) / 'lock'), os.O_RDWR | os.O_CREAT, 0o600)
                with patch.object(common.time, 'time', side_effect=lambda: clock['now']), \
                     patch.object(common.time, 'monotonic', side_effect=lambda: clock['now']):
                    release = remote.Release.__new__(remote.Release)
                    release.work = Path(folder)
                    release.run_id = 'c'*32
                    release.t = {'engineId':'synthetic-engine'}
                    release.b = {'candidateImage':raw['Image'],'ledger46':{},'ledger48':{}}
                    release.c = Commands(330)
                    release.n05 = lambda: SimpleNamespace(PRODUCTION_LOCK_PATH='synthetic-lock',acquire_lock=lambda *_:descriptor)
                    release.sql = lambda _: '{"keys":1,"sessions":0,"otherSessions":0}'
                    release.rows = lambda _: []
                    release.models = lambda: ({}, {})
                    common.exclusive(release.work / 'frozen-candidate.json',
                                     {'services':{'app':{'environment':{'DATABASE_URL':'postgresql://synthetic'}}}})
                    expected = 'SYNTHETIC_MIGRATOR_TIMEOUT' if settles else 'MIGRATOR_SETTLEMENT_UNVERIFIED'
                    with self.assertRaisesRegex(common.Stop, expected):
                        release.migrate()
                    self.assertIn('MIGRATOR_SETTLE',calls)
                    self.assertEqual(release.c.wall_end,1330)
                with self.assertRaises(OSError):
                    os.fstat(descriptor)

    def test_document_cleanup_failure_still_settles_attributed_postgres(self):
        calls = []
        run = 'a'*32
        pg = {'id':'b'*64,'created':'synthetic-pg','image':'sha256:'+'c'*64}
        doc = {'id':'d'*64,'created':'synthetic-doc','image':'sha256:'+'e'*64}
        raw = {'Id':pg['id'],'Created':pg['created'],'Image':pg['image'],
               'Config':{'Labels':{restore.LABEL:run}},'Mounts':[], 'ExecIDs':None,
               'State':{'Running':True,'Pid':42},
               'HostConfig':{'NetworkMode':'none','ReadonlyRootfs':True,'RestartPolicy':{'Name':'no'},
                 'LogConfig':{'Type':'none'},'SecurityOpt':['no-new-privileges'],'CapDrop':['ALL'],
                 'Tmpfs':{'/var/lib/postgresql/data':'','/tmp':''},'Memory':2048*1024**2,
                 'MemorySwap':2048*1024**2,'NanoCpus':1000000000,'PidsLimit':128}}
        class Commands(common.Commands):
            def inspect(self, kind, cid):
                self.remaining(60)
                if cid == doc['id']:
                    raise common.Stop('SYNTHETIC_DOCUMENT_INSPECT_FAILURE')
                return copy.deepcopy(raw)
            def docker(self, command_id, *args, **options):
                self.remaining(options.get('seconds',60))
                calls.append(command_id)
                if command_id == 'RECOVERY_STOP_POSTGRES':
                    raw['State'].update(Running=False,Pid=0)
                return b''
        operation = restore.Restore(Commands(90), Path(__file__).parent, run, pg['image'], doc['image'], None)
        operation.refs = {'postgres':pg,'documents':doc}
        with self.assertRaisesRegex(common.Stop,'RECOVERY_RESOURCES_UNSETTLED') as error:
            operation.cleanup()
        self.assertEqual(error.exception.details['resources'],
                         [{'role':'documents','code':'SYNTHETIC_DOCUMENT_INSPECT_FAILURE'}])
        self.assertIn('RECOVERY_STOP_POSTGRES',calls)
        self.assertIn('RECOVERY_REMOVE_POSTGRES',calls)
        self.assertFalse(raw['State']['Running'])


@unittest.skipUnless(os.name == 'posix', 'Real process-group qualification runs on Linux CI')
class ProcessSettlementTests(unittest.TestCase):
    def test_nonzero_leader_with_live_descendant_is_settled_before_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            child_pid = Path(folder) / 'child.pid'
            child = 'import time;time.sleep(20)'
            parent = ('import pathlib,subprocess,sys;'
                      'p=subprocess.Popen([sys.executable,"-c",' + repr(child) + '],'
                      'stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);'
                      'pathlib.Path(' + repr(str(child_pid)) + ').write_text(str(p.pid));'
                      'raise SystemExit(7)')
            commands = common.Commands(5,Path(folder))
            with self.assertRaisesRegex(common.Stop,'COMMAND_FAILED') as error:
                commands.run('SYNTHETIC_NONZERO_LEADER',[sys.executable,'-c',parent],seconds=3)
            self.assertEqual(error.exception.details['exitCode'],7)
            self.assertTrue(commands.groups_quiet)
            with self.assertRaises(ProcessLookupError):
                os.kill(int(child_pid.read_text()),0)

    def test_command_timeout_settles_group_inside_original_bound(self):
        commands = common.Commands(5,Path(__file__).parent)
        started = time.monotonic()
        with self.assertRaisesRegex(common.Stop,'COMMAND_INTERRUPTED_OR_EXPIRED'):
            commands.run('SYNTHETIC_TIMEOUT',[sys.executable,'-c','import time;time.sleep(20)'],seconds=.6)
        self.assertLess(time.monotonic()-started,.9)
        self.assertTrue(commands.groups_quiet)

    def test_canonical_interruption_keeps_own_session_child_supervised(self):
        root = Path(__file__).resolve().parents[2]
        path = root / 'scripts/n05/failed_app_return.py'
        n05 = common.module(path,'synthetic_n05_settlement',common.digest(path))
        with tempfile.TemporaryDirectory() as folder:
            pid_file = Path(folder) / 'canonical-child.pid'
            code = 'import os,pathlib,time;pathlib.Path(' + repr(str(pid_file)) + ').write_text(str(os.getpid()));time.sleep(20)'
            def operation(args):
                self.assertEqual(args[1],'forward')
                return n05.run_deadline([sys.executable,'-c',code],os.environ.copy(),time.time()+3,
                                        stop_deadline=time.time()+5)
            release = remote.Release.__new__(remote.Release)
            release.runtime = root
            release.c = common.Commands(10,root)
            original_env, original_cwd = os.environ.copy(),Path.cwd()
            original_handler = signal.getsignal(signal.SIGTERM)
            timer = threading.Timer(.4,lambda:os.kill(os.getpid(),signal.SIGTERM))
            try:
                with patch.object(n05,'production_main',side_effect=operation):
                    timer.start()
                    with self.assertRaisesRegex(common.Stop,'CANONICAL_OPERATION_INTERRUPTED'):
                        release.canonical_transition(n05,'forward',root/'synthetic-plan-not-read.json')
            finally:
                timer.cancel()
                timer.join()
            self.assertEqual(os.environ.copy(),original_env)
            self.assertEqual(Path.cwd(),original_cwd)
            self.assertEqual(signal.getsignal(signal.SIGTERM),original_handler)
            with self.assertRaises(ProcessLookupError):
                os.kill(int(pid_file.read_text()),0)


class AdmissionBaselineTests(unittest.TestCase):
    def test_environment_preserves_unrelated_secrets_and_comments(self):
        source = b'# keep\nAUTH_SECRET="a$b#c"\nDATABASE_URL="postgresql://x"\nINTERNAL_SESSION_MODE=legacy\n'
        changed = remote.env_with_changes(source, {'INTERNAL_SESSION_MODE': 'registry'})
        self.assertEqual(changed, source.replace(b'=legacy', b'=registry'))

    def test_duplicate_changed_key_and_metacharacters_rejected(self):
        with self.assertRaisesRegex(common.Stop, 'DUPLICATE_CHANGED_ENVIRONMENT_KEY'):
            remote.env_with_changes(b'KEY=1\nexport KEY=2\n', {'KEY': '3'})
        with self.assertRaisesRegex(common.Stop, 'ENV_CHANGE_INVALID'):
            remote.env_with_changes(b'', {'KEY': '$(command)'})

    def test_initial_registration_never_rotates_existing_key(self):
        good = {'keys': 0, 'admins': 1, 'sessions': 0, 'otherSessions': 0, 'databaseBytes': 100000}
        remote.current_key_allowed(good)
        for field, value in [('keys', 1), ('admins', 2), ('sessions', 1), ('otherSessions', 1), ('databaseBytes', 1024**3)]:
            with self.assertRaises(common.Stop):
                remote.current_key_allowed(good | {field: value})

    def test_no_arbitrary_remote_operation(self):
        with self.assertRaisesRegex(common.Stop, 'FIXED_OPERATION_REQUIRED'):
            owner.command({'runId': 'a' * 32}, 'rm -rf anything')
        with self.assertRaisesRegex(common.Stop, 'RUN_ID_INVALID'):
            owner.command({'runId': 'a; command'}, 'prepare')

    def test_ssh_errors_distinguish_domains_and_auth(self):
        self.assertEqual(owner.ssh_error(b'Could not resolve hostname'), 'SSH_DNS_FAILED')
        self.assertEqual(owner.ssh_error(b'Permission denied (publickey)'), 'SSH_AUTHENTICATION_FAILED')
        self.assertEqual(owner.ssh_error(b'Host key verification failed'), 'SSH_HOST_KEY_REJECTED')

    def test_isolation_and_identity_tamper_rejected(self):
        ref = {'id': 'a' * 64, 'created': 'now', 'image': 'sha256:' + 'b' * 64}
        raw = {'Id': ref['id'], 'Created': 'now', 'Image': ref['image'],
               'Config': {'Labels': {restore.LABEL: 'c' * 32}}, 'Mounts': [],
               'HostConfig': {'NetworkMode': 'none', 'ReadonlyRootfs': True, 'RestartPolicy': {'Name': 'no'},
                 'LogConfig': {'Type': 'none'}, 'SecurityOpt': ['no-new-privileges'], 'CapDrop': ['ALL'],
                 'Tmpfs': {'/var/lib/postgresql/data': '', '/tmp': ''}, 'Memory': 2048*1024**2,
                 'MemorySwap': 2048*1024**2, 'NanoCpus': 1000000000, 'PidsLimit': 128}}
        restore.isolation(raw, ref, 'c'*32)
        document = copy.deepcopy(raw)
        document['HostConfig'].update(CapAdd=['CAP_CHOWN','CAP_FOWNER','CAP_DAC_OVERRIDE'],
            Tmpfs={'/work':'','/tmp':''}, Memory=384*1024**2, MemorySwap=384*1024**2)
        restore.isolation(document, ref, 'c'*32, document=True)
        document['HostConfig']['CapAdd'].append('CAP_SYS_ADMIN')
        with self.assertRaisesRegex(common.Stop, 'ISOLATION_CAPABILITIES'):
            restore.isolation(document, ref, 'c'*32, document=True)
        for change in [lambda x: x['HostConfig'].update(NetworkMode='fai-crm_default'),
                       lambda x: x.update(Mounts=[{'Type':'volume','Destination':'/var/lib/postgresql/data'}]),
                       lambda x: x.update(Created='changed'),
                       lambda x: x['HostConfig'].update(MemorySwap=-1)]:
            mutated = copy.deepcopy(raw)
            change(mutated)
            with self.assertRaises(common.Stop):
                restore.isolation(mutated, ref, 'c'*32)

    def test_ledger_requires_exact_completed_names_and_checksums(self):
        rows = [['migration', 'hash', 'started', 'finished', '', '1']]
        restore.ledger_valid(rows, {'migration':'hash'})
        for bad in [[], rows + rows, [['migration', 'hash', 'started', '', '', '1']],
                    [['migration', 'different', 'started', 'finished', '', '1']]]:
            with self.assertRaises(common.Stop):
                restore.ledger_valid(bad, {'migration':'hash'})


if __name__ == '__main__':
    unittest.main(verbosity=2)
