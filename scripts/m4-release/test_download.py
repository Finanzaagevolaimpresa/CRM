"""Exercise the generated downloader, including a real saved ZIP when supplied."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0,str(HERE))
sys.path.insert(1,str(REPO/'scripts/m1-assisted'))
import generate
from common import Stop, digest


def load_generated(root):
    for name,raw in generate.render('f'*32).items(): (root/name).write_bytes(raw)
    sys.path.insert(0,str(root))
    try:
        spec=importlib.util.spec_from_file_location('m4_download_under_test',root/'download_images.py')
        module=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally: sys.path.pop(0)


class DownloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory(dir=REPO)
        cls.generated=Path(cls.temp.name)
        cls.module=load_generated(cls.generated)

    @classmethod
    def tearDownClass(cls): cls.temp.cleanup()

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir=REPO)
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.zip=self.root/'qualified-images.zip'
        self.payload=b'synthetic archive bytes; not executable'
        self.expected=copy.deepcopy(json.loads((HERE/'qualification.json').read_bytes())['receipt'])
        self.expected['imageArchiveSha256']=hashlib.sha256(self.payload).hexdigest()
        self.patches=[]
        self.addCleanup(lambda:[p.stop() for p in reversed(self.patches)])

    def setting(self,name,value):
        p=patch.object(self.module,name,value);p.start();self.patches.append(p)

    def fixture(self,change=None):
        receipt=copy.deepcopy(self.expected)
        if change:change(receipt)
        with zipfile.ZipFile(self.zip,'x') as z:
            z.writestr('release-images.tar.gz',self.payload)
            z.writestr('release-receipt.json',json.dumps(receipt))
        self.setting('ZIP_BYTES',self.zip.stat().st_size)
        self.setting('ZIP_SHA',digest(self.zip))
        self.setting('IMAGE_SHA',self.expected['imageArchiveSha256'])
        self.setting('EXPECTED_RECEIPT',self.expected)

    def test_schema49_qualified_receipt_is_accepted(self):
        self.fixture()
        actual=self.module.extract(self.zip,self.root)
        self.assertEqual(actual['sha256'],self.expected['imageArchiveSha256'])
        self.assertEqual((self.root/'release-images.tar.gz').read_bytes(),self.payload)

    def test_schema48_or_any_changed_qualification_field_is_rejected_before_extract(self):
        for field,value in [('status','CI_SCHEMA48_M1_APPLICATION_RETURN_PASS'),('schema',48),
                            ('candidateCommit','0'*40),('recoveryCommit','0'*40),('synthetic',False),
                            ('databaseRestoreQualified',True)]:
            with self.subTest(field=field),tempfile.TemporaryDirectory(dir=REPO) as path:
                root=Path(path);target=root/'changed.zip'
                receipt=copy.deepcopy(self.expected);receipt[field]=value
                with zipfile.ZipFile(target,'x') as z:
                    z.writestr('release-images.tar.gz',self.payload)
                    z.writestr('release-receipt.json',json.dumps(receipt))
                with patch.multiple(self.module,ZIP_BYTES=target.stat().st_size,ZIP_SHA=digest(target),
                                    IMAGE_SHA=self.expected['imageArchiveSha256'],EXPECTED_RECEIPT=self.expected):
                    with self.assertRaisesRegex(Stop,'QUALIFICATION_RECEIPT_MISMATCH'):
                        self.module.extract(target,root)
                self.assertFalse((root/'release-images.tar.gz').exists())

    def test_verified_cached_zip_never_calls_network(self):
        self.fixture()
        before=digest(self.zip)
        gh=self.root/'synthetic-gh';gh.write_bytes(b'not executable')
        with patch.object(self.module.transport,'GH',gh), \
             patch.object(self.module.transport,'bounded_command',side_effect=AssertionError('NETWORK_CALLED')), \
             patch.object(self.module.transport,'obtain_range',side_effect=AssertionError('NETWORK_CALLED')):
            self.module.acquire(self.root,{'programs':{'gh':digest(gh)}})
        receipt=json.loads((self.root/'images-acquired.json').read_bytes())
        self.assertTrue(receipt['reusedVerifiedZip'])
        self.assertFalse(receipt['remoteConnectionAttempted'])
        self.assertEqual(digest(self.zip),before)

    def test_bad_cached_zip_stops_without_network_or_overwrite(self):
        self.fixture();self.setting('ZIP_SHA','0'*64)
        before=self.zip.read_bytes()
        gh=self.root/'synthetic-gh';gh.write_bytes(b'not executable')
        with patch.object(self.module.transport,'GH',gh), \
             patch.object(self.module.transport,'bounded_command',side_effect=AssertionError('NETWORK_CALLED')):
            with self.assertRaisesRegex(Stop,'QUALIFIED_ZIP_MISMATCH'):
                self.module.acquire(self.root,{'programs':{'gh':digest(gh)}})
        self.assertEqual(self.zip.read_bytes(),before)
        self.assertFalse((self.root/'images-acquired.json').exists())
        self.assertFalse((self.root/'release-images.tar.gz').exists())


def actual_zip(zip_path,output):
    zip_path=Path(zip_path).resolve(strict=True)
    output=Path(output).resolve()
    output.mkdir(parents=True,exist_ok=False)
    with tempfile.TemporaryDirectory(dir=REPO) as path:
        module=load_generated(Path(path))
        before=digest(zip_path)
        result=module.extract(zip_path,output)
        assert digest(zip_path)==before
        result.update(protocol='FAI_M4_REAL_ARTIFACT_EXTRACTION_R34',status='PASS',
                      schema=49,candidate=generate.CANDIDATE,generatedDownloaderUsed=True,
                      sourceZipUnchanged=True,productionConnected=False,imagesExecuted=False)
        print(json.dumps(result,sort_keys=True))


if __name__=='__main__':
    if len(sys.argv)==4 and sys.argv[1]=='--qualified-zip': actual_zip(sys.argv[2],sys.argv[3])
    else:
        assert len(sys.argv)==1
        unittest.main()
