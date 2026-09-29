"""Reuse the connected schema49 dispatcher/model/forward admission fixture."""
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from generate import pinned
raw=pinned('scripts/m5-release/admission_fixture.py').decode().replace(
    'FAI_M5_ASSISTED_STAGE_R36','FAI_R40_ASSISTED_STAGE_R64')
exec(compile(raw,'pinned_admission_fixture.py','exec'),globals())
