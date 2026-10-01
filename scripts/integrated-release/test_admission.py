"""Connected admission and source EOL invariants for the R40 program."""
from pathlib import Path
import sys
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parent))
from generate import pinned
exec(compile(pinned('scripts/m5-release/test_admission.py'),'pinned_admission_tests.py','exec'),globals())
