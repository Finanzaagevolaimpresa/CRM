"""Resume guards for the completed R29 backup; no production calls."""
import ast
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(1, str(REPO/'scripts/m1-assisted'))
from common import Stop, canonical
import completed_backup as completed
import protect48
import package_builder as builder


def reader(path, ref='HEAD'):
    return (REPO/path).read_bytes() if path.startswith('scripts/m2-release/') else builder.source(path, ref)


class ResumeTests(unittest.TestCase):
    def fixture(self, folder, remote=False):
        packet = folder/'packet'; packet.mkdir(mode=0o700)
        evidence = packet/'evidence' if remote else packet
        if remote: evidence.mkdir(mode=0o700)
        backup = folder/'backup'; backup.mkdir(mode=0o700)
        receipt = {'status':'BACKUP_VERIFIED_AND_APP_RESUMED','runId':completed.RUN,
                   'sourceCommit':completed.M1,'sourceTree':completed.M1_TREE,'schema':48,
                   'appResumedHealthy':True,'databaseNotRestarted':True,'fullPgArchiveReadable':True,
                   'appId':'a'*64,'postgresId':'b'*64,'configuration':[],
                   'set':(backup/'sets'/('backup48-'+completed.RUN)).as_posix()}
        values = {
            'package.json':('MANIFEST_SHA',{'runId':completed.RUN,'postRunId':completed.POST_RUN,
                                          'imageArchiveSha256':completed.IMAGE_SHA}),
            'prepare.json':('PREPARE_SHA',{'status':'PASS','stage':'prepare','runId':completed.RUN,
                                         'configurationSha256':'c'*64}),
            'backup.json':('BACKUP_SHA',{'status':'PASS','stage':'backup','runId':completed.RUN,'receipt':receipt}),
            ('protect.stop.json' if remote else 'protect.json'):('STOP_SHA',{
                'status':'STOP','stage':'protect','code':'COMMAND_FAILED','details':{
                    'commandId':'CANONICAL_N05_PROTECT','errorClass':'COMMAND_ERROR_REDACTED',
                    'exitCode':1,'stderrBytes':67,'stderrSha256':completed.ERROR_SHA}})}
        bindings = {'REMOTE' if remote else 'LOCAL':packet,'BASE':folder,'BACKUP':backup}
        for name,(constant,value) in values.items():
            p=(packet if name=='package.json' else evidence)/name
            p.write_bytes(canonical(value)+b'\n');p.chmod(0o600)
            bindings[constant]=hashlib.sha256(p.read_bytes()).hexdigest()
        if remote:
            (evidence/'protect-before').mkdir(mode=0o700)
            (backup/'configuration').mkdir(mode=0o700)
            for name,value in [('BACKUP_VERIFIED.json',receipt),
                               ('BASELINE.json',{'app':{'id':'a'*64},'postgres':{'id':'b'*64}})]:
                p=backup/name;p.write_bytes(canonical(value));p.chmod(0o600)
        return packet,evidence,bindings

    def test_exact_error_fingerprint(self):
        raw=(json.dumps({'status':'DENIED','code':'SOURCE_MIGRATION_COUNT_UNQUALIFIED'})+'\n').encode()
        self.assertEqual((len(raw),hashlib.sha256(raw).hexdigest()),(67,completed.ERROR_SHA))

    def test_valid_receipts_reuse_backup_without_changing_a_byte(self):
        with tempfile.TemporaryDirectory(dir=REPO) as folder:
            root,evidence,bindings=self.fixture(Path(folder))
            original={p.name:p.read_bytes() for p in root.iterdir()}
            with patch.multiple(completed,**bindings):
                self.assertTrue(completed.reconcile()['backupReused'])
                self.assertEqual({p.name:p.read_bytes() for p in root.iterdir()},original)
                (evidence/'deploy.intent.json').write_text('{}')
                with self.assertRaisesRegex(Stop,'COMPLETED_LATER_STAGE_STARTED'):completed.reconcile()

    def test_altered_backup_or_stop_is_not_retry_authority(self):
        for name in ('backup.json','protect.json'):
            with self.subTest(name=name),tempfile.TemporaryDirectory(dir=REPO) as folder:
                root,_,bindings=self.fixture(Path(folder))
                with patch.multiple(completed,**bindings):
                    with (root/name).open('ab') as stream:stream.write(b'\n')
                    with self.assertRaisesRegex(Stop,'COMPLETED_RECEIPT_CHANGED'):completed.reconcile()

    def test_remote_partial_encryption_or_later_stage_denies_resume(self):
        for residual in ('protect-before/operation.json','backup48.bundle.tar','protect.json','postbackup.intent.json'):
            with self.subTest(residual=residual),tempfile.TemporaryDirectory(dir=REPO) as folder:
                _,evidence,bindings=self.fixture(Path(folder),remote=True)
                with patch.multiple(completed,**bindings):
                    self.assertTrue(completed.reconcile(remote=True)['backupReused'])
                    (evidence/residual).write_text('{}')
                    with self.assertRaises(Stop):completed.reconcile(remote=True)

    def test_bound_adapter_calls_original_guard_and_rejects_other_sources_counts(self):
        for commit,tree in protect48.SOURCES.items():
            calls=[]
            kit=types.SimpleNamespace(SUPPORTED_SOURCE_MIGRATION_COUNTS=(43,46),
                                      verify_source_schema=lambda *args:calls.append(args))
            protect48.qualify(kit,commit,tree).verify_source_schema(commit,tree,48)
            self.assertEqual(calls,[(commit,tree,48)])
            for args in [(commit,tree,46),(commit,tree,True),('a'*40,tree,48),(commit,'a'*40,48)]:
                with self.assertRaises(Stop):kit.verify_source_schema(*args)
            self.assertEqual(len(calls),1)

    def test_receiver_and_transition_keep_old_backup_new_operation_separate(self):
        files=builder.render('a'*32,reader)
        transition=files['transition_base.py'].decode()
        self.assertIn("'evidence-backup48-' + self.backup_run_id",transition)
        self.assertIn("'m2-r26-' + self.run_id",transition)
        receiver=files['receive_package.py'].decode()
        self.assertIn('from completed_backup import receive_prepared',receiver)
        self.assertNotIn('from consumed_preparation',receiver)
        for name in ('observe48_after.py','backup48_after.py'):
            self.assertIn(completed.RUNTIME.name,files[name].decode())

    def test_cli_backup_is_rejected_before_target_or_mutation(self):
        files=builder.render('a'*32,reader)
        with tempfile.TemporaryDirectory(dir=REPO) as folder:
            root=Path(folder)
            for name,raw in files.items():(root/name).write_bytes(raw)
            code = "import sys,json;sys.path.insert(0,sys.argv[1]);import remote_release as r;sys.argv=['remote_release.py','backup'];\ntry:r.main()\nexcept r.Stop as e:print(json.dumps({'code':e.code}));sys.exit(2)"
            process=subprocess.run([sys.executable,'-I','-B','-S','-c',code,str(root)],
                                   stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
            self.assertEqual(process.returncode,2,process.stderr.decode())
            self.assertEqual(json.loads(process.stdout)['code'],'FIXED_OPERATION_REQUIRED')
            self.assertFalse((root/'evidence').exists())
        tree=ast.parse(files['owner_release.py'])
        calls=[n.args[1].value for n in ast.walk(tree) if isinstance(n,ast.Call) and
               isinstance(n.func,ast.Name) and n.func.id=='stage_call' and len(n.args)>1 and
               isinstance(n.args[1],ast.Constant)]
        self.assertNotIn('backup',calls)
        self.assertIn('protect',calls)


if __name__=='__main__':unittest.main(verbosity=2)
