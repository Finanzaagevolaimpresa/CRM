[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PacketPath,
    [string]$PythonPath = (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'),
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'

$resolvedPacket = (Resolve-Path -LiteralPath $PacketPath).ProviderPath
$packetItem = Get-Item -LiteralPath $resolvedPacket
if ($packetItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'PACKET_LINK_DENIED' }
$packetText = [IO.File]::ReadAllText($resolvedPacket, [Text.Encoding]::UTF8)
$packet = $packetText | ConvertFrom-Json
if ($packet.plan.protocol -ne 'PR140_OWNER_BACKUP46_R05' -or $packet.plan.schema -ne 46 -or
    $packet.plan.runId -notmatch '^[0-9a-f]{32}$') { throw 'PACKET_IDENTITY_INVALID' }
$programPath = Join-Path $PSScriptRoot 'owner_backup46.py'
$programItem = Get-Item -LiteralPath $programPath
if ($programItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'PROGRAM_LINK_DENIED' }
$programBytes = [IO.File]::ReadAllBytes($programPath)
$programSha = (Get-FileHash -LiteralPath $programPath -Algorithm SHA256).Hash.ToLowerInvariant()
$launcherSha = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
$resolvedPython = (Resolve-Path -LiteralPath $PythonPath).ProviderPath
$validationOutput = & $resolvedPython -I -B $programPath --validate-packet $resolvedPacket --launcher-sha256 $launcherSha 2>$null
$validationExit = $LASTEXITCODE
try { $validation = ($validationOutput -join "`n") | ConvertFrom-Json } catch { throw 'LOCAL_VALIDATOR_RESULT_INVALID' }
if ($validationExit -ne 0 -or $validation.protocol -ne 'PR140_OWNER_BACKUP46_LOCAL_VALIDATION_R05') {
    $failureCode = if ($validation.code -match '^[A-Z0-9_]{1,100}$') { $validation.code } else { 'INVALID_PACKET' }
    throw "LOCAL_PACKET_VALIDATION_FAILED_$failureCode"
}
if ($validation.programSha256 -ne $programSha -or $validation.launcherSha256 -ne $launcherSha -or
    $validation.runId -ne $packet.plan.runId -or $validation.remoteConnectionAttempted -ne $false) { throw 'LOCAL_VALIDATION_BINDING_CHANGED' }
$planSha = $validation.planSha256
$ready = $validation.executionAdmitted -eq $true
if ($ValidateOnly) {
    $validation | ConvertTo-Json -Compress
    return
}
if (-not $ready) { throw 'REVIEW_AND_EXPLICIT_OWNER_APPROVAL_REQUIRED: nessuna connessione tentata.' }

$sshCommand = Get-Command ssh -ErrorAction Stop
$profileOutput = & $sshCommand.Source -G fai-crm-prod 2>$null
if ($LASTEXITCODE -ne 0) { throw 'SSH_PROFILE_UNREADABLE: nessuna modifica al profilo o ai permessi.' }
$hostLine = @($profileOutput | Where-Object { $_ -match '^hostname ' })[0]
$userLine = @($profileOutput | Where-Object { $_ -match '^user ' })[0]
if (-not $hostLine -or $hostLine -eq 'hostname fai-crm-prod' -or $userLine -ne 'user faiadmin') {
    throw 'SSH_ALIAS_UNRESOLVED_OR_WRONG_PROFILE'
}
$receiptDirectory = [IO.Path]::GetDirectoryName($resolvedPacket)
$stem = 'PR140_OWNER_BACKUP46_' + $packet.plan.runId
$receiptPath = Join-Path $receiptDirectory ($stem + '_RECEIPT.json')
$attemptPath = Join-Path $receiptDirectory ($stem + '_ATTEMPT.json')
if (Test-Path -LiteralPath $receiptPath) { throw 'RECEIPT_EXISTS_DO_NOT_REPEAT' }
# One-shot local marker, preserved even on uncertain SSH delivery. Never overwrite.
$attempt = [ordered]@{ runId = $packet.plan.runId; planSha256 = $planSha; programSha256 = $programSha;
    startedUtc = [DateTime]::UtcNow.ToString('o'); status = 'OWNER_DISPATCH_ATTEMPT' } | ConvertTo-Json -Compress
$stream = [IO.File]::Open($attemptPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($attempt)
    $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true)
} finally { $stream.Dispose() }

$source64 = [Convert]::ToBase64String($programBytes)
$packet64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($packetText))
# Both substituted values use the base64 alphabet, never shell interpolation.
$bootstrap = @"
import base64, hashlib, json, sys
code = base64.b64decode('$source64', validate=True)
packet_text = base64.b64decode('$packet64', validate=True).decode('utf-8')
namespace = {'__name__': 'owner_backup46_payload'}
try:
    exec(compile(code, '<reviewed-owner-backup46>', 'exec'), namespace)
    packet = namespace['strict_json'](packet_text)
    status = namespace['entry_point'](packet, hashlib.sha256(code).hexdigest())
except Exception:
    print(json.dumps({'protocol':'PR140_OWNER_BACKUP46_R05','status':'STOP','code':'BOOTSTRAP_FAILED','secretValuesExported':False}))
    status = 2
sys.exit(status)
"@
Write-Host 'Avvio del backup autorizzato. Conservare questa finestra aperta fino alla ricevuta; non ripetere il comando.'
$previousErrorPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$nativeOutput = $bootstrap | & $sshCommand.Source -T -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes -o UpdateHostKeys=no -o ServerAliveInterval=10 -o ServerAliveCountMax=3 fai-crm-prod 'python3 -u -' 2>&1
$sshExit = $LASTEXITCODE
$ErrorActionPreference = $previousErrorPreference
$serialized = ($nativeOutput | ForEach-Object { "$_" }) -join "`n"
try { $receipt = $serialized | ConvertFrom-Json } catch {
    throw 'EXECUTION_RESULT_UNCERTAIN_DO_NOT_REPEAT: conservare il marker e comunicare solo questo codice alla task.'
}
if ($receipt.protocol -ne 'PR140_OWNER_BACKUP46_R05' -or $receipt.secretValuesExported -ne $false) {
    throw 'RECEIPT_PROTOCOL_INVALID_DO_NOT_REPEAT'
}
if ($receipt.status -eq 'BACKUP_VERIFIED_AND_APP_RESUMED') {
    if ($sshExit -ne 0 -or $receipt.schema -ne 46 -or $receipt.appResumedHealthy -ne $true -or
        $receipt.databaseNotRestarted -ne $true -or $receipt.fullPgArchiveReadable -ne $true -or
        $receipt.runId -ne $packet.plan.runId -or $receipt.appId -ne $packet.plan.target.appId -or
        $receipt.postgresId -ne $packet.plan.target.postgresId -or
        $receipt.planSha256 -ne $planSha -or $receipt.programSha256 -ne $programSha -or
        $receipt.reviewReference -ne $packet.approval.reviewReference -or
        $receipt.sourceCommit -ne $packet.plan.sourceCommit -or $receipt.sourceTree -ne $packet.plan.sourceTree -or
        $receipt.migration47Applied -ne $false -or $receipt.deployPerformed -ne $false) {
        throw 'SUCCESS_RECEIPT_BINDING_INVALID_DO_NOT_REPEAT'
    }
} elseif ($receipt.status -ne 'STOP') { throw 'RECEIPT_STATUS_INVALID_DO_NOT_REPEAT' }
$data = [Text.Encoding]::UTF8.GetBytes(($receipt | ConvertTo-Json -Depth 20))
$stream = [IO.File]::Open($receiptPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $stream.Write($data, 0, $data.Length); $stream.Flush($true) } finally { $stream.Dispose() }
Write-Output ($receipt | ConvertTo-Json -Depth 20)
Write-Host "Ricevuta minimizzata: $receiptPath"
if ($receipt.status -eq 'STOP' -or $sshExit -ne 0) { throw 'BACKUP_STOP: non ripetere il comando; la task deve verificare la ricevuta.' }
