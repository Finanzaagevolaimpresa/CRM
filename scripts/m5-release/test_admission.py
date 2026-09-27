"""Connected no-migration dispatcher -> models -> canonical forward admission."""
import sys
from pathlib import Path
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parent))
from test_release import GeneratedTests, json, unittest, tempfile
from admission_fixture import exercise
import package_builder

class AdmissionTests(GeneratedTests):
    def fixture(self,drift=False):
        binding=json.loads(self.files['binding.json'])|{'candidateImage':'sha256:'+'1'*64,'returnImage':'sha256:'+'2'*64}
        rows=[[name,sha,'synthetic-start','synthetic-finish','','1'] for name,sha in sorted(binding['ledger49'].items())]
        return exercise(self.root,self.root/'admission',binding,lambda:rows,model_drift=drift)

    def test_real_dispatcher_persists_models_and_reaches_canonical_forward(self):
        result=self.fixture()
        self.assertTrue(result['dispatcherUsed'] and result['durableReceiptReadBack'] and result['repeatDenied'])
        self.assertTrue(result['modelsGeneratedAndValidated'] and result['canonicalForwardPlanValidated'])
        self.assertFalse(result['forwardExecuted'])

    def test_model_drift_prevents_stage_completion(self):
        with self.assertRaisesRegex(Exception,'UNAUTHORIZED_MODEL_CHANGE'):self.fixture(True)

class EolTests(unittest.TestCase):
    def test_crlf_sources_cannot_claim_a_reviewed_delta(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);file=root/'test.py'
            file.write_bytes(b'pass\r\n')
            with self.assertRaisesRegex(Exception,'M5_SOURCE_LF_REQUIRED'):package_builder.source_hashes(root)
            file.write_bytes(b'pass\n')
            self.assertEqual(set(package_builder.source_hashes(root)),{'test.py'})

if __name__=='__main__':
    suite=unittest.TestSuite(AdmissionTests(name) for name in (
        'test_real_dispatcher_persists_models_and_reaches_canonical_forward',
        'test_model_drift_prevents_stage_completion'))
    suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(EolTests))
    raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())

