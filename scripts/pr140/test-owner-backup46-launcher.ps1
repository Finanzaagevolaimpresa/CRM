$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot 'Invoke-OwnerBackup46.ps1'
$tokens = $null
$parseErrors = $null
$null = [Management.Automation.Language.Parser]::ParseFile($launcher, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'LAUNCHER_PARSE_FAILED' }
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('fai-backup46-test-' + [Guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($testRoot)
$packetPath = Join-Path $testRoot 'synthetic-packet.json'
# No real resource, connection or authorization is supplied by this test.
@'
{"plan":{"protocol":"PR140_OWNER_BACKUP46_R05","runId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","schema":46,"z":"last","a":"first"},"approval":null}
'@ | Set-Content -LiteralPath $packetPath -Encoding UTF8
$result = (& $launcher -PacketPath $packetPath -ValidateOnly) | ConvertFrom-Json
if ($result.executionAdmitted -ne $false -or $result.remoteConnectionAttempted -ne $false) { throw 'VALIDATION_OPENED_GATE' }
$canonical = '{"a":"first","protocol":"PR140_OWNER_BACKUP46_R05","runId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","schema":46,"z":"last"}'
$hash = [Security.Cryptography.SHA256]::Create()
try { $expected = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical)))).Replace('-', '').ToLowerInvariant() }
finally { $hash.Dispose() }
if ($result.planSha256 -ne $expected) { throw 'CANONICAL_PLAN_DIGEST_MISMATCH' }
$denied = $false
try { & $launcher -PacketPath $packetPath } catch {
    if ($_.Exception.Message -notlike 'REVIEW_AND_EXPLICIT_OWNER_APPROVAL_REQUIRED*') { throw }
    $denied = $true
}
if (-not $denied) { throw 'UNAPPROVED_PACKET_ACCEPTED' }
if (@(Get-ChildItem -LiteralPath $testRoot).Count -ne 1) { throw 'UNAPPROVED_LAUNCHER_WROTE_STATE' }
Write-Output '{"protocol":"PR140_BACKUP46_LAUNCHER_TEST_R05","status":"PASS","synthetic":true,"remoteConnectionAttempted":false,"approvalDeniedBeforeDispatch":true,"canonicalDigestMatched":true}'
