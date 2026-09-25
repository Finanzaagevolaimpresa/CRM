[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestSha256)
$ErrorActionPreference='Stop'
$channelIdentity=[Security.Principal.WindowsIdentity]::GetCurrent()
if ($channelIdentity.Name -notmatch '\\Utente$' -or $channelIdentity.Name -match 'codexsandbox' -or
    -not ([Security.Principal.WindowsPrincipal]::new($channelIdentity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'EXPLICIT_OWNER_ADMIN_UNINSTALL_REQUIRED' }
$channelRoot='C:\Program Files\FAI-CRM-M1-CHANNEL-R18'
$channelState='C:\ProgramData\FAI-CRM-M1-CHANNEL-R18'
$channelInstall=[IO.Path]::GetFullPath((Join-Path $channelRoot $ManifestSha256.Substring(0,16)))
if ([IO.Path]::GetFullPath($PSScriptRoot) -ne $channelInstall -or [IO.Path]::GetDirectoryName($channelInstall) -ne $channelRoot) { throw 'CHANNEL_UNINSTALL_SCOPE' }
foreach ($channelStart in @($channelInstall,$channelState)) {
    for ($channelWalk=$channelStart;$channelWalk;$channelWalk=[IO.Path]::GetDirectoryName($channelWalk)) {
        if ((Get-Item -LiteralPath $channelWalk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'CHANNEL_UNINSTALL_LINK_DENIED' }
    }
}
$channelManifestPath=Join-Path $channelInstall 'manifest.json'
if ((Get-FileHash -LiteralPath $channelManifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ManifestSha256) { throw 'CHANNEL_UNINSTALL_MANIFEST_HASH' }
$channelManifest=[IO.File]::ReadAllText($channelManifestPath)|ConvertFrom-Json
$channelNames=@('M1FileChannel.exe','Install-FileChannel.ps1','Uninstall-FileChannel.ps1','manifest.json','install.json')
$channelActual=@(Get-ChildItem -LiteralPath $channelInstall -Force)
if ($channelActual.Count -ne 5 -or @($channelActual|Where-Object {$_.Name -notin $channelNames -or $_.PSIsContainer -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)}).Count) { throw 'CHANNEL_UNINSTALL_INVENTORY' }
foreach ($channelName in @('M1FileChannel.exe','Install-FileChannel.ps1','Uninstall-FileChannel.ps1')) {
    if ((Get-FileHash -LiteralPath (Join-Path $channelInstall $channelName) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $channelManifest.files.$channelName) { throw 'CHANNEL_UNINSTALL_FILE_HASH' }
}
$channelAdmission=[IO.File]::ReadAllText((Join-Path $channelInstall 'install.json'))|ConvertFrom-Json
if ($channelAdmission.ownerSid -ne $channelIdentity.User.Value -or $channelAdmission.manifestSha256 -ne $ManifestSha256) { throw 'CHANNEL_UNINSTALL_OWNER' }
$channelRun=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run',$true)
try {
    $channelExpected='"'+(Join-Path $channelInstall 'M1FileChannel.exe')+'"'
    if ($null -eq $channelRun -or $channelRun.GetValue('FAI-CRM-M1-CHANNEL-R18',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -ne $channelExpected) { throw 'CHANNEL_UNINSTALL_REGISTRATION_CHANGED' }
    $channelStop=Join-Path $channelState 'owner-stop.json'
    if (Test-Path -LiteralPath $channelStop) { throw 'CHANNEL_STOP_EXISTS_RECONCILE_FIRST' }
    $channelStopBytes=[Text.Encoding]::UTF8.GetBytes('{"protocol":"FAI_M1_OWNER_STOP_R18"}')
    $channelStream=[IO.File]::Open($channelStop,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try {$channelStream.Write($channelStopBytes,0,$channelStopBytes.Length);$channelStream.Flush($true)} finally {$channelStream.Dispose()}
    # A bounded graceful stop; never terminate an in-flight provider or SSH process.
    $channelDeadline=[DateTime]::UtcNow.AddSeconds(185)
    do {
        $channelRunning=@(Get-Process -Name M1FileChannel -ErrorAction SilentlyContinue|Where-Object {$_.Path -eq (Join-Path $channelInstall 'M1FileChannel.exe')})
        if ($channelRunning.Count -eq 0) { break }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $channelDeadline)
    if ($channelRunning.Count) { throw 'CHANNEL_STOP_NOT_CONFIRMED' }
    $channelRun.DeleteValue('FAI-CRM-M1-CHANNEL-R18',$true)
    foreach ($channelName in $channelNames) { [IO.File]::Delete((Join-Path $channelInstall $channelName)) }
    [IO.Directory]::Delete($channelInstall,$false)
    if (@(Get-ChildItem -LiteralPath $channelRoot -Force).Count -eq 0) { [IO.Directory]::Delete($channelRoot,$false) }
    [pscustomobject]@{protocol='FAI_M1_FILE_CHANNEL_UNINSTALL_R18';status='UNINSTALLED';receiptsPreserved=$true;inboxPreserved=$true;existingMcpUnchanged=$true;credentialsChanged=$false}|ConvertTo-Json -Compress
} finally { if ($channelRun) {$channelRun.Dispose()} }
