"""Exercise real disjoint Git histories and the exact remaining owner sequence."""
import contextlib
import io
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
from common import Stop, digest, exclusive, load
from generate import render, SOURCE, SOURCE_TREE, CANDIDATE, CANDIDATE_TREE
from resume import render_resume, RUN, RUNTIME_NAME
from test_release import imported


def git(*args):
    return subprocess.check_output(['git', *map(str,args)], stderr=subprocess.PIPE, timeout=90)


class ResumeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=REPO)
        self.root = Path(self.temp.name); self.root.chmod(0o700)
        self.files = render_resume('e'*32)
        for name, raw in self.files.items(): exclusive(self.root/name, raw)
        self.saved_path = sys.path[:]
        sys.path.insert(0, str(self.root))
        self.previous = {name:sys.modules.pop(name,None) for name in
            ('sealed_programs','release_evidence','owner_base','transport_base','download_images',
             'transition_base','completed_backup','protect48')}
        self.addCleanup(self.cleanup)

    def cleanup(self):
        sys.path[:] = self.saved_path
        for name, old in self.previous.items():
            sys.modules.pop(name,None)
            if old is not None: sys.modules[name] = old
        self.temp.cleanup()

    def test_real_split_repositories_reproduce_old_git_failure_and_bind_both_roles(self):
        if os.name == 'nt':
            p=patch.dict(sys.modules, {'fcntl':types.ModuleType('fcntl')});p.start();self.addCleanup(p.stop)
        remote=imported(self.root/'remote_release.py','split_remote')
        protected=imported(self.root/'protect48.py','split_protect')
        roots={}
        for role,commit in (('before',SOURCE),('after',CANDIDATE)):
            folder=self.root/role
            git('init','-q',folder)
            git('-C',folder,'config','core.autocrlf','false')
            git('-C',folder,'-c','protocol.file.allow=always','fetch','--depth=1',REPO,commit)
            git('-C',folder,'-c','core.hooksPath=/dev/null','checkout','--detach','FETCH_HEAD')
            folder.chmod(0o700); roots[role]=folder
        release=remote.Release.__new__(remote.Release)
        release.runtime=roots['after']
        release.b=json.loads(self.files['binding.json'])
        release.source=lambda role:({},SOURCE,SOURCE_TREE,RUN) if role=='before' else ({},CANDIDATE,CANDIDATE_TREE,'f'*32)
        class Commands:
            def run(this,command,args): return git(*args[1:])
        release.c=Commands()
        with patch.object(remote,'OLD',roots['before']):
            wrong=release.kit()
            wrong.SAFE_ENV['PATH']=os.environ['PATH']
            wrong=protected.qualify(wrong,SOURCE,SOURCE_TREE)
            with self.assertRaisesRegex(wrong.Denied,'COMMAND_FAILED_GIT'):
                wrong.verify_source_schema(SOURCE,SOURCE_TREE,48)
            for role,commit,tree,count in (('before',SOURCE,SOURCE_TREE,48),('after',CANDIDATE,CANDIDATE_TREE,49)):
                kit=release.protection_kit(role);kit.SAFE_ENV['PATH']=os.environ['PATH']
                kit.verify_tools(kit.tools_binding())
                protected.qualify(kit,commit,tree).verify_source_schema(commit,tree,count)
                self.assertEqual(kit.ROOT,roots[role])
            release.source=lambda _:({},CANDIDATE,CANDIDATE_TREE,'f'*32)
            with self.assertRaisesRegex(Stop,'PROTECTION_TOOLS_IDENTITY'):release.protection_kit('before')
            with self.assertRaisesRegex(Stop,'FIXED_PROTECTION_ROLE_REQUIRED'):release.protection_kit('other')

    def test_resume_uses_prepared_runtime_and_only_adopts_initial_backup(self):
        remote=imported(self.root/'remote_release.py','resume_remote')
        release=remote.Release.__new__(remote.Release)
        release.backup_run_id=RUN
        release.t={}
        release.require_config_binding=lambda:None
        release.observer=lambda:{'liveSessions':0,'otherActiveDbSessions':0}
        proof={'backupReceipt':{'runId':RUN},'backupReceiptSha256':'a'*64}
        with patch.object(remote,'reconcile',return_value=proof):
            result=release.backup()
            self.assertFalse(result['newBackupExecuted'])
            self.assertEqual(result['adoptedFromRunId'],RUN)
            self.assertEqual(release.source('before')[3],RUN)
            release.observer=lambda:{'liveSessions':1,'otherActiveDbSessions':0}
            with self.assertRaisesRegex(Stop,'BACKUP_REUSE_WRITERS'):release.backup()
        with self.assertRaisesRegex(Stop,'CONSUMED_BACKUP_REPLAY_DENIED'):release.make_backup('before')
        for name in ('backup48_after.py','observe48_after.py'):
            self.assertIn(RUNTIME_NAME.encode(),self.files[name])
            self.assertNotIn(('release-'+CANDIDATE[:12]+'-m4-'+'e'*32).encode(),self.files[name])
        self.assertNotIn(b"'LOAD_QUALIFIED_M2_IMAGES'",self.files['remote_release.py'])
        self.assertNotIn(b"'RUNTIME_CLONE'",self.files['remote_release.py'])
        self.assertNotIn(b"evidence-backup48-'+self.run_id",self.files['remote_release.py'])
        with self.assertRaisesRegex(ValueError,'CONSUMED_RUN_DENIED'):render_resume(RUN)

    def test_only_remaining_owner_sequence_and_repeat_is_read_only(self):
        owner=imported(self.root/'owner_release.py','resume_owner')
        exclusive(self.root/'package.json',{'runId':'e'*32})
        seen=[]
        owner.base.admit=lambda _:None
        owner.base.storage=lambda:seen.append('storage')
        owner.reconcile=lambda:seen.append('reconcile')
        owner.image_reference=lambda:seen.append('cached-image') or {}
        owner.upload=lambda *_:(seen.append('upload-small'),exclusive(self.root/'upload.json',{}))
        owner.stage_call=lambda _,stage,request=None,output=None:seen.append(stage) or {}
        owner.copies=lambda _,source,label:seen.append('local-'+label) or {}
        with contextlib.redirect_stdout(io.StringIO()):self.assertEqual(owner.main(),0)
        self.assertEqual(seen,['storage','reconcile','cached-image','upload-small','prepare','backup','protect',
            'local-backup','copies-backup','recover','migrate','deploy','postcheck','postbackup','postprotect',
            'local-postbackup','copies-postbackup','final'])
        seen.clear()
        with contextlib.redirect_stdout(io.StringIO()):self.assertEqual(owner.main(),0)
        self.assertEqual(seen,['status'])

    def fixture(self):
        m=imported(self.root/'completed_backup.py','completed_fixture')
        old=self.root/'old';old.mkdir(mode=0o700)
        m.LOCAL=m.REMOTE=old
        m.BACKUP=self.root/'backup';m.BACKUP.mkdir(mode=0o700)
        result={'status':'BACKUP_VERIFIED_AND_APP_RESUMED','runId':RUN,'sourceCommit':SOURCE,'sourceTree':SOURCE_TREE,
                'schema':48,'appResumedHealthy':True,'databaseNotRestarted':True,'fullPgArchiveReadable':True,
                'set':(m.BACKUP/'sets'/('backup48-'+RUN)).as_posix(),'configuration':[],
                'appId':'a'*64,'postgresId':'p'*64}
        manifest={'runId':RUN,'postRunId':m.POST_RUN,'candidate':CANDIDATE,'imageArchiveSha256':m.IMAGE_SHA,'files':{}}
        prepared={'status':'PASS','stage':'prepare','runId':RUN,'candidate':CANDIDATE,'configurationSha256':'c'*64}
        backup={'status':'PASS','stage':'backup','runId':RUN,'receipt':result}
        stop={'status':'STOP','stage':'protect','code':'SCHEMA48_PROTECTION_STOP','details':{'publicCode':'COMMAND_FAILED_GIT'}}
        for name,raw,attr in [('package.json',manifest,'MANIFEST_SHA'),('prepare.json',prepared,'PREPARE_SHA'),
                              ('backup.json',backup,'BACKUP_SHA'),('protect.json',stop,'STOP_SHA')]:
            exclusive(old/name,raw);setattr(m,attr,digest(old/name))
        return m,old,result

    def test_changed_receipts_or_later_work_deny_adoption(self):
        m,old,_=self.fixture()
        before={p.name:p.read_bytes() for p in old.iterdir()}
        self.assertTrue(m.reconcile()['backupReused'])
        self.assertEqual(before,{p.name:p.read_bytes() for p in old.iterdir()})
        exclusive(old/'migrate.intent.json',{})
        with self.assertRaisesRegex(Stop,'COMPLETED_LATER_STAGE_STARTED'):m.reconcile()
        # A changed receipt is rejected even if no success was recorded.
        (old/'backup.json').write_bytes(b'{}')
        with self.assertRaisesRegex(Stop,'COMPLETED_RECEIPT_CHANGED'):m.reconcile()

    def test_remote_partial_encryption_denies_before_diagnosis_or_resume(self):
        m,old,result=self.fixture()
        evidence=old/'evidence';evidence.mkdir(mode=0o700)
        for name in ('prepare.json','backup.json'):exclusive(evidence/name,(old/name).read_bytes())
        exclusive(evidence/'protect.stop.json',(old/'protect.json').read_bytes())
        exclusive(m.BACKUP/'BACKUP_VERIFIED.json',result)
        operations=evidence/'protect-before';operations.mkdir(mode=0o700)
        (operations/RUN).mkdir(mode=0o700)
        with self.assertRaisesRegex(Stop,'HISTORICAL_PROTECTION_PROGRESS_UNCERTAIN'):m.reconcile(remote=True)


if __name__=='__main__':unittest.main()
