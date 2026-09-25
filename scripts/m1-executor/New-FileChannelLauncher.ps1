[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$PackagePath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestSha256,
    [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9:/._#?=-]{10,240}$')][string]$ReviewReference,
    [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference='Stop'
$channelPackage=(Resolve-Path -LiteralPath $PackagePath).ProviderPath
$channelManifestPath=Join-Path $channelPackage 'manifest.json'
$channelManifestBytes=[IO.File]::ReadAllBytes($channelManifestPath)
$channelHasher=[Security.Cryptography.SHA256]::Create()
try {$channelActual=([BitConverter]::ToString($channelHasher.ComputeHash($channelManifestBytes))).Replace('-','').ToLowerInvariant()}finally{$channelHasher.Dispose()}
if ($channelActual -ne $ManifestSha256) {throw 'LAUNCHER_MANIFEST_HASH_MISMATCH'}
$channelManifest=[Text.Encoding]::UTF8.GetString($channelManifestBytes)|ConvertFrom-Json
if ($channelManifest.schema -ne 'FAI_M1_FILE_CHANNEL_PACKAGE_R18') {throw 'LAUNCHER_PACKAGE_SCOPE'}
$channelOut=[IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $channelOut) {throw 'LAUNCHER_DESTINATION_EXISTS'}
[IO.Directory]::CreateDirectory($channelOut)|Out-Null
$channelTemplate=@'
$ErrorActionPreference='Stop'
$launchIdentity=[Security.Principal.WindowsIdentity]::GetCurrent()
if ($launchIdentity.Name -notmatch '\\Utente$' -or $launchIdentity.Name -match 'codexsandbox' -or
    ([Security.Principal.WindowsPrincipal]::new($launchIdentity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'NORMAL_OWNER_WINDOWS_SESSION_REQUIRED'
}
$launchPackage='@@PACKAGE@@'
$launchManifest='@@MANIFEST@@'
$launchInstallerSha='@@INSTALLER@@'
$launchExeSha='@@EXE@@'
$launchReview='@@REVIEW@@'
$launchAdmin=@'
$ErrorActionPreference='Stop'
$bytes=[IO.File]::ReadAllBytes('@@PACKAGE@@\Install-FileChannel.ps1')
$hasher=[Security.Cryptography.SHA256]::Create()
try {$actual=([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$hasher.Dispose()}
if ($actual -ne '@@INSTALLER@@') {throw 'INSTALLER_HASH_MISMATCH'}
& ([scriptblock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($bytes))) -PackagePath '@@PACKAGE@@' -ManifestSha256 '@@MANIFEST@@' -ReviewReference '@@REVIEW@@'
@@END_INNER@@
$launchEncoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($launchAdmin))
Write-Host 'Installazione del solo canale di lettura. Confermare UAC. Non ripetere in caso di errore.'
$launchInstall=Start-Process -FilePath 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','RemoteSigned','-EncodedCommand',$launchEncoded) -Verb RunAs -WindowStyle Hidden -Wait -PassThru
if ($launchInstall.ExitCode -ne 0) {throw 'CHANNEL_INSTALLATION_NOT_CONFIRMED_DO_NOT_REPEAT'}
$launchState='C:\ProgramData\FAI-CRM-M1-CHANNEL-R18'
$launchReceipt=[IO.File]::ReadAllText((Join-Path $launchState 'installation-receipt.json'))|ConvertFrom-Json
if ($launchReceipt.manifestSha256 -ne $launchManifest -or $launchReceipt.status -ne 'INSTALLED_NOT_STARTED_OR_QUALIFIED') {throw 'INSTALLATION_RECEIPT_MISMATCH'}
$launchExe=Join-Path ('C:\Program Files\FAI-CRM-M1-CHANNEL-R18\'+$launchManifest.Substring(0,16)) 'M1FileChannel.exe'
if ((Get-FileHash -LiteralPath $launchExe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $launchExeSha) {throw 'INSTALLED_CHANNEL_HASH_MISMATCH'}
$launchWorker=Start-Process -FilePath $launchExe -WindowStyle Hidden -PassThru
$launchDeadline=[DateTime]::UtcNow.AddSeconds(15)
do {
    if (Test-Path -LiteralPath (Join-Path $launchState 'ready.json')) {break}
    if ($launchWorker.HasExited) {throw 'OWNER_CHANNEL_START_FAILED'}
    Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $launchDeadline)
if (-not (Test-Path -LiteralPath (Join-Path $launchState 'ready.json'))) {throw 'OWNER_CHANNEL_READY_NOT_OBSERVED_DO_NOT_REPEAT'}
$launchReady=[IO.File]::ReadAllText((Join-Path $launchState 'ready.json'))|ConvertFrom-Json
if ($launchReady.manifestSha256 -ne $launchManifest) {throw 'OWNER_CHANNEL_READY_BINDING'}
Write-Host 'Canale avviato. Codex puo ora qualificarlo dalla stessa task. Nessuna connessione remota eseguita dall installer.'
'@
# The inner here-string delimiter is materialized only in the generated script.
$channelLauncher=$channelTemplate.Replace('@@END_INNER@@',"'@").
    Replace('@@PACKAGE@@',$channelPackage.Replace("'","''")).
    Replace('@@MANIFEST@@',$ManifestSha256).
    Replace('@@INSTALLER@@',$channelManifest.files.'Install-FileChannel.ps1').
    Replace('@@EXE@@',$channelManifest.files.'M1FileChannel.exe').
    Replace('@@REVIEW@@',$ReviewReference)
$channelPs1=Join-Path $channelOut 'INSTALLA_CANALE_M1_R18.ps1'
[IO.File]::WriteAllText($channelPs1,$channelLauncher,[Text.UTF8Encoding]::new($false))
$channelTokens=$null;$channelErrors=$null
[void][Management.Automation.Language.Parser]::ParseFile($channelPs1,[ref]$channelTokens,[ref]$channelErrors)
if ($channelErrors.Count) {throw 'GENERATED_LAUNCHER_PARSE_FAILED'}
$channelCmd="@echo off"+[Environment]::NewLine+
    '"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0INSTALLA_CANALE_M1_R18.ps1"'+[Environment]::NewLine+
    'echo Esito avvio: %ERRORLEVEL%. In caso di errore non ripetere.'+[Environment]::NewLine+'pause'+[Environment]::NewLine
[IO.File]::WriteAllText((Join-Path $channelOut 'INSTALLA_CANALE_M1_R18.cmd'),$channelCmd,[Text.Encoding]::ASCII)
[pscustomobject]@{status='OWNER_LAUNCHER_PREPARED_NOT_RUN';directory=$channelOut;manifestSha256=$ManifestSha256;reviewReference=$ReviewReference}|ConvertTo-Json -Compress
