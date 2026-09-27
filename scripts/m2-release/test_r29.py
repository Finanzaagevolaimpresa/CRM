"""R28 regression: actual Bash guards and refusal of changed/advanced historical attempts."""
import copy
import hashlib
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
REPO=HERE.parents[1]
sys.path.insert(0,str(HERE))
sys.path.insert(1,str(REPO/'scripts/m1-assisted'))
import package_builder as builder
import consumed_preparation as consumed
from common import Stop, canonical


def reader(path,ref='HEAD'):
    return (REPO/path).read_bytes() if path.startswith('scripts/m2-release/') else builder.source(path,ref)


class TagRegression(unittest.TestCase):
    def test_actual_shell_guard_accepts_only_exact_bound_tag_for_each_role(self):
        bash = str(Path(r'C:\Program Files\Git\bin\bash.exe')) if os.name=='nt' else shutil.which('bash')
        self.assertTrue(bash and Path(bash).is_file(), 'BASH_REQUIRED_FOR_REGRESSION')
        files=builder.render('c'*32,reader)
        for role in ('before','after'):
            with self.subTest(role=role),tempfile.TemporaryDirectory(dir=REPO) as folder:
                root=Path(folder)
                m=types.ModuleType('bound_'+role)
                exec(compile(files['backup48_'+role+'.py'],m.__name__,'exec'),m.__dict__)
                source={name:builder.source(name,builder.SEALED) for name in m.BACKUP_TOOL_PATHS}
                staged=m.staged_backup_tools(source,PurePosixPath('/ci/bound-source'))
                self.assertEqual(source['scripts/n05/lib.sh'],builder.source('scripts/n05/lib.sh',builder.SEALED))
                original=root/'original.sh'; original.write_bytes(source['scripts/n05/lib.sh'])
                adapted=root/'adapted.sh'; adapted.write_bytes(staged['scripts/n05/lib.sh'])
                (root/'.env.production').write_text('SYNTHETIC=1\n')
                (root/'docker-compose.prod.example.yml').write_text('services: {}\n')
                command='''set -Eeuo pipefail
export PATH=/usr/bin:/bin:$PATH
source "$1"
N05_REPO_ROOT="$(cd "$(dirname "$1")" && pwd)"
export FAI_ENVIRONMENT=production FAI_ENVIRONMENT_SENTINEL=FAI_CRM_PRODUCTION_V1 COMPOSE_PROJECT_NAME=fai-crm
export COMPOSE_FILE="$N05_REPO_ROOT/docker-compose.prod.example.yml" ENV_FILE="$N05_REPO_ROOT/.env.production"
export APP_ORIGIN=https://desk.finanzaagevolaimpresa.it APP_IMAGE="$2"
n05_assert_environment_identity production
'''
                def run(path,tag):
                    return subprocess.run([bash,'--noprofile','--norc','-c',command,'regression',path.as_posix(),tag],
                                          stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
                old=run(original,m.TAG)
                self.assertEqual(old.returncode,1)
                self.assertEqual(len(old.stderr),47,old.stderr.decode('utf-8','replace'))
                self.assertEqual(hashlib.sha256(old.stderr).hexdigest(),consumed.ERROR_SHA)
                self.assertEqual(run(adapted,m.TAG).returncode,0)
                for wrong in ('fai-crm:latest','fai-crm:pr999-123456789abc','fai-crm:r05-candidate-'+'0'*40):
                    self.assertNotEqual(run(adapted,wrong).returncode,0)
                self.assertEqual(m.sanitized_command_error(old.stderr),'PRODUCTION_IMAGE_NOT_IMMUTABLE')
                self.assertEqual(m.sanitized_command_error(b'private value'),'OUTPUT_REDACTED')
                self.assertIn(b'LEGACY_APP_CONTAINER_IMAGE_ID_MISMATCH',staged['scripts/n05/lib.sh'])
                self.assertIn(b'LEGACY_APP_CONTAINER_IMAGE_TAG_MISMATCH',staged['scripts/n05/lib.sh'])


class ReconciliationRegression(unittest.TestCase):
    def fixture(self,root):
        root.mkdir()
        manifest={'runId':consumed.RUN,'imageArchiveSha256':consumed.IMAGE_SHA}
        prepared={'status':'PASS','stage':'prepare','runId':consumed.RUN,
                  'runtimeApplicationChanged':False,'observation':{'ledgerCount':48}}
        receipt={'status':'STOP','code':'COMMAND_FAILED','quiescenceAttempted':False,
                 'interruptionRequested':False,'localCommandGroupsQuiet':True,'commandFailure':{
                     'commandId':'BACKUP_RESOURCE_PREFLIGHT','phase':'BEFORE_QUIESCENCE','exitCode':1,
                     'errorClass':'OUTPUT_REDACTED','stderrBytes':47,'stderrSha256':consumed.ERROR_SHA}}
        stopped={'status':'STOP','stage':'backup','code':'BACKUP_STOP','details':{'backupReceipt':receipt}}
        hashes={}
        for name,value in [('package.json',manifest),('prepare.json',prepared),('backup.json',stopped)]:
            raw=canonical(value)+b'\n'
            (root/name).write_bytes(raw)
            hashes[name]=hashlib.sha256(raw).hexdigest()
        return stopped,{'LOCAL':root,'MANIFEST_SHA':hashes['package.json'],'PREPARE_SHA':hashes['prepare.json'],
                        'STOP_SHA':hashes['backup.json']}

    def test_stop_after_quiescence_or_uncertain_command_is_never_reusable(self):
        with tempfile.TemporaryDirectory(dir=REPO) as folder:
            stop,_=self.fixture(Path(folder)/'previous')
            consumed.validate_stop(stop)
            for field,value in [('quiescenceAttempted',True),('interruptionRequested',True),('localCommandGroupsQuiet',False)]:
                changed=copy.deepcopy(stop)
                changed['details']['backupReceipt'][field]=value
                with self.assertRaises(Stop):consumed.validate_stop(changed)
            changed=copy.deepcopy(stop)
            changed['details']['backupReceipt']['commandFailure']['stderrSha256']='0'*64
            with self.assertRaises(Stop):consumed.validate_stop(changed)

    def test_changed_receipt_or_started_later_stage_prevents_reuse(self):
        with tempfile.TemporaryDirectory(dir=REPO) as folder:
            root=Path(folder)/'previous'
            _,bindings=self.fixture(root)
            with patch.multiple(consumed,**bindings):
                self.assertEqual(consumed.reconcile()['consumedRunId'],consumed.RUN)
                marker=root/'deploy.intent.json';marker.write_text('{}')
                with self.assertRaisesRegex(Stop,'CONSUMED_LATER_STAGE_STARTED'):consumed.reconcile()
                marker.unlink()
                with (root/'backup.json').open('ab') as out:out.write(b'\n')
                with self.assertRaisesRegex(Stop,'CONSUMED_RECEIPT_CHANGED'):consumed.reconcile()

    def test_archive_copy_preserves_source_and_refuses_wrong_hash_or_occupied_target(self):
        with tempfile.TemporaryDirectory(dir=REPO) as folder:
            root=Path(folder)/'previous';root.mkdir()
            dest=Path(folder)/'new';dest.mkdir()
            raw=b'opaque synthetic image archive'
            original=root/'release-images.tar.gz';original.write_bytes(raw)
            with patch.multiple(consumed,LOCAL=root,IMAGE_BYTES=len(raw),IMAGE_SHA=hashlib.sha256(raw).hexdigest()):
                result=consumed.copy_archive(dest)
                self.assertEqual(result['networkBytes'],0)
                self.assertEqual(original.read_bytes(),raw)
                self.assertEqual((dest/original.name).read_bytes(),raw)
                with self.assertRaises(FileExistsError):consumed.copy_archive(dest)
                original.write_bytes(b'X'*len(raw))
                with self.assertRaisesRegex(Stop,'CONSUMED_IMAGE_CHANGED'):consumed.copy_archive(dest)


if __name__=='__main__':unittest.main(verbosity=2)
