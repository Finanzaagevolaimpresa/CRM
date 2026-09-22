[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$receiptPath = Join-Path $PSScriptRoot 'PR140_OWNER_PREFLIGHT_RECEIPT.json'
if (Test-Path -LiteralPath $receiptPath) { throw 'La ricevuta esiste: conservarla e comunicarla alla task. Non viene sovrascritta.' }
$collectorPath = Join-Path $PSScriptRoot 'owner-preflight.py'
$sshCommand = Get-Command ssh -ErrorAction Stop
# The existing user profile, alias and keys are used by OpenSSH itself.
# StrictHostKeyChecking and UpdateHostKeys forbid changes to known_hosts.
$profileOutput = & $sshCommand.Source -G fai-crm-prod 2>$null
if ($LASTEXITCODE -ne 0) {
    throw 'PREFLIGHT_CONFIG_UNREADABLE: nessuna connessione tentata. Non cambiare policy o permessi.'
}
$hostLine = @($profileOutput | Where-Object { $_ -match '^hostname ' })[0]
$userLine = @($profileOutput | Where-Object { $_ -match '^user ' })[0]
if ($hostLine -eq 'hostname fai-crm-prod' -or $userLine -ne 'user faiadmin') {
    throw 'PREFLIGHT_ALIAS_UNRESOLVED_OR_WRONG_PROFILE: usare il profilo Windows già configurato, senza modificare SSH.'
}
$payload = Get-Content -LiteralPath $collectorPath -Raw
$previousErrorPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$nativeOutput = $payload | & $sshCommand.Source -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes -o UpdateHostKeys=no fai-crm-prod 'python3 -' 2>&1
$sshExit = $LASTEXITCODE
$ErrorActionPreference = $previousErrorPreference
$serialized = ($nativeOutput | ForEach-Object { "$_" }) -join "`n"
if ($sshExit -eq 255) {
    $code = if ($serialized -match '(?i)permission denied') { 'REMOTE_AUTHENTICATION_REJECTED' }
      elseif ($serialized -match '(?i)could not resolve') { 'TRANSPORT_HOST_UNRESOLVED' }
      elseif ($serialized -match '(?i)host key verification failed') { 'HOST_KEY_NOT_VERIFIED' }
      else { 'SSH_TRANSPORT_UNAVAILABLE' }
    throw "$code. Nessuna configurazione, chiave o policy modificata; non inoltrare il log grezzo."
}
try { $receipt = $serialized | ConvertFrom-Json } catch { throw 'Ricevuta non valida: conservare localmente il risultato senza inoltrare log grezzi.' }
if ($receipt.protocol -ne 'PR140_OWNER_PREFLIGHT_R05' -or -not $receipt.readOnly) { throw 'Protocollo ricevuta inatteso.' }
[System.IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 15), [System.Text.UTF8Encoding]::new($false))
Write-Output "Ricevuta minimizzata salvata: $receiptPath"
Write-Output ($receipt | ConvertTo-Json -Depth 15)
