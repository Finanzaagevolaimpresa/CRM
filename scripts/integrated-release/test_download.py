"""Keep exact qualified-image extraction and cached bytes regression checks."""
import sys
from pathlib import Path
sys.dont_write_bytecode = True
sys.path.insert(0,str(Path(__file__).resolve().parent))
from generate import source
raw = source('scripts/m4-release/test_download.py').decode().replace(
    'FAI_M4_REAL_ARTIFACT_EXTRACTION_R34','FAI_R40_REAL_ARTIFACT_EXTRACTION_R64')
raw = raw.replace("if __name__=='__main__':", "if __name__=='__disabled__':")
exec(compile(raw,'pinned_download_tests.py','exec'),globals())


class CachedArchiveTests(DownloadTests):
    def test_owner_acquired_archive_avoids_network_and_zip_claim(self):
        (self.root/'release-images.tar.gz').write_bytes(self.payload)
        (self.root/'release-receipt.json').write_text(json.dumps(self.expected))
        self.setting('IMAGE_SHA',self.expected['imageArchiveSha256'])
        self.setting('EXPECTED_RECEIPT',self.expected)
        with patch.object(self.module.transport,'bounded_command',side_effect=AssertionError('NETWORK_FORBIDDEN')):
            result=self.module.acquire(self.root,{})
        self.assertTrue(result['reusedVerifiedArchive'])
        self.assertFalse(result['zipDigestLocallyVerified'])

    def test_cached_archive_drift_denies_before_network(self):
        (self.root/'release-images.tar.gz').write_bytes(b'changed')
        (self.root/'release-receipt.json').write_text(json.dumps(self.expected))
        self.setting('IMAGE_SHA',self.expected['imageArchiveSha256'])
        with patch.object(self.module.transport,'bounded_command',side_effect=AssertionError('NETWORK_FORBIDDEN')):
            with self.assertRaisesRegex(Stop,'QUALIFIED_IMAGE_HASH'):
                self.module.acquire(self.root,{})


if __name__=='__main__':
    if len(sys.argv)>1:
        exec(compile(source('scripts/m4-release/test_download.py').decode(), 'real_zip_check.py','exec'),globals())
    else:
        suite=unittest.defaultTestLoader.loadTestsFromTestCase(DownloadTests)
        for name in ('test_owner_acquired_archive_avoids_network_and_zip_claim','test_cached_archive_drift_denies_before_network'):
            suite.addTest(CachedArchiveTests(name))
        raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
