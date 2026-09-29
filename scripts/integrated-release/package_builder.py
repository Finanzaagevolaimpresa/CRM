"""Build only after review of this exact operational delta and successful CI."""
import hashlib
import json
from pathlib import Path
import sys
sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
from generate import pinned, change

raw = pinned('scripts/m5-release/package_builder.py').decode()
raw = raw.replace('M5-only', 'R40 app-only').replace('M5-rilascio-R36','R40-rilascio-R64')
raw = raw.replace('codex/m5-runtime-candidate-r36','codex/crm-integrated-release')
raw = raw.replace("'M5-'", "'R40-'").replace('FAI_M5_OWNER_PACKAGE_R36','FAI_R40_OWNER_PACKAGE_R64')
raw = raw.replace('01a0c20b-b096-78a3-b6f6-db9153b914fe','01a0e6a3-ef0c-7981-ab48-d124f0e3e590')
raw = raw.replace("'plannedSessionRevocation':True", "'plannedSessionRevocation':False,'databaseWritesAuthorized':False,'automaticReturnAuthorized':False")
raw = raw.replace('AVVIA-M5.ps1','AVVIA-R40.ps1')
raw = change(raw, "    exclusive(output/'package.json',manifest)", """    # Reuse the exact archive Antonio already downloaded and whose blobs were
    # verified in R63. The downloader can verify existing bytes without a ZIP.
    cache = Path(r'C:\\Users\\Utente\\Desktop\\CRM\\artifacts\\crm-integrated-release-R40\\release-artifact-36587091238-1')
    archive = cache/'release-images.tar.gz'
    need(digest(archive) == binding['imageArchiveSha256'], 'ACQUIRED_ARCHIVE_CHANGED')
    need(load(cache/'release-receipt.json') == load(HERE/'qualification.json')['receipt'], 'ACQUIRED_RECEIPT_CHANGED')
    for name in ('release-images.tar.gz','release-receipt.json'):
        with (cache/name).open('rb') as incoming,(output/name).open('xb') as outgoing:
            shutil.copyfileobj(incoming,outgoing)
    exclusive(output/'package.json',manifest)""")
raw = change(raw, "    launcher = \"\"\"", """    # An ordinary Python entry point avoids changing PowerShell execution policy.
    # It verifies the immutable manifest and every executable module before import.
    guard = (HERE/'owner_launcher.py').read_text(encoding='utf-8').replace(
        'EXPECTED_MANIFEST_SHA256', digest(output/'package.json'))
    exclusive(output/'AVVIA-R40.py',guard.encode())
    launcher = \"\"\"""")
exec(compile(raw,str(HERE/'pinned_package_builder.py'),'exec'),globals())
