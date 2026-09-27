"""Run the verified ZIP/cached-download tests against the exact M5 archive."""
import sys
from pathlib import Path
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parent))
from generate import source
raw=source('scripts/m4-release/test_download.py').decode().replace(
    'FAI_M4_REAL_ARTIFACT_EXTRACTION_R34','FAI_M5_REAL_ARTIFACT_EXTRACTION_R36')
exec(compile(raw,'pinned_download_tests.py','exec'),globals())
