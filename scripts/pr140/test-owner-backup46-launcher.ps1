$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot 'Invoke-OwnerBackup46.ps1'
$tokens = $null
$parseErrors = $null
$null = [Management.Automation.Language.Parser]::ParseFile($launcher, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'LAUNCHER_PARSE_FAILED' }
$python = (Get-Command python -ErrorAction Stop).Source
$launcherSha = (Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash.ToLowerInvariant()
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('fai-backup46-test-' + [Guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($testRoot)
$generator = @'
import copy, hashlib, json, pathlib, sys
sys.path.insert(0, sys.argv[1])
import test_owner_backup46 as fixture
m=fixture.s
root=pathlib.Path(sys.argv[2])
p=fixture.packet()
p['approval']['programSha256']=hashlib.sha256(pathlib.Path(m.__file__).read_bytes()).hexdigest()
p['approval']['launcherSha256']=sys.argv[3]
def write(name,value):
    (root/name).write_text(json.dumps(value),encoding='utf-8')
write('approved.json',p)
unapproved=copy.deepcopy(p);unapproved['approval']=None
write('unapproved.json',unapproved)
for kind in ['extra-plan','missing-ledger','bad-target']:
    q=copy.deepcopy(p)
    if kind=='extra-plan':q['plan']['unexpected']=True
    elif kind=='missing-ledger':q['plan']['expectedLedger'].pop(next(iter(q['plan']['expectedLedger'])))
    else:q['plan']['target']['appId']='invalid'
    q['approval']['planSha256']=m.sha(q['plan'])
    write(kind+'.json',q)
duplicate=json.dumps(p).replace('"runId":', '"runId": "'+'a'*32+'", "runId":', 1)
(root/'duplicate.json').write_text(duplicate,encoding='utf-8')
print(json.dumps({'expectedPlanSha256':m.sha(p['plan'])}))
'@
$expected = (& $python -I -B -c $generator $PSScriptRoot $testRoot $launcherSha) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'SYNTHETIC_FIXTURE_FAILED' }
# Even an SSH executable lookup is a failure in all cases below.
function Get-Command {
    [CmdletBinding()]param([string]$Name)
    throw 'SSH_LOOKUP_UNEXPECTED'
}
$packetPath = Join-Path $testRoot 'unapproved.json'
$result = (& $launcher -PacketPath $packetPath -PythonPath $python -ValidateOnly) | ConvertFrom-Json
if ($result.executionAdmitted -ne $false -or $result.remoteConnectionAttempted -ne $false) { throw 'VALIDATION_OPENED_GATE' }
if ($result.planSha256 -ne $expected.expectedPlanSha256) { throw 'CANONICAL_PLAN_DIGEST_MISMATCH' }
$denied = $false
try { & $launcher -PacketPath $packetPath -PythonPath $python } catch {
    if ($_.Exception.Message -notlike 'REVIEW_AND_EXPLICIT_OWNER_APPROVAL_REQUIRED*') { throw }
    $denied = $true
}
if (-not $denied) { throw 'UNAPPROVED_PACKET_ACCEPTED' }
$result = (& $launcher -PacketPath (Join-Path $testRoot 'approved.json') -PythonPath $python -ValidateOnly) | ConvertFrom-Json
if ($result.executionAdmitted -ne $true -or $result.remoteConnectionAttempted -ne $false) { throw 'COMPLETE_LOCAL_PACKET_FAILED' }
foreach ($name in @('extra-plan','missing-ledger','bad-target','duplicate')) {
    $denied = $false
    try { & $launcher -PacketPath (Join-Path $testRoot ($name + '.json')) -PythonPath $python } catch {
        if ($_.Exception.Message -notlike 'LOCAL_PACKET_VALIDATION_FAILED_*') { throw }
        $denied = $true
    }
    if (-not $denied) { throw 'MALFORMED_APPROVED_PACKET_ACCEPTED' }
}
if (@(Get-ChildItem -LiteralPath $testRoot -Filter '*_ATTEMPT.json').Count -ne 0) { throw 'INVALID_PACKET_CONSUMED_ATTEMPT' }
Write-Output '{"protocol":"PR140_BACKUP46_LAUNCHER_TEST_R05","status":"PASS","synthetic":true,"remoteConnectionAttempted":false,"approvalDeniedBeforeDispatch":true,"canonicalDigestMatched":true,"malformedApprovedPacketsDenied":4,"completeLocalPacketAccepted":true}'
