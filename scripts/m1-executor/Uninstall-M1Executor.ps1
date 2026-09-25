[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestSha256)
$ErrorActionPreference='Stop'
$r18Identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if ($r18Identity.Name -notmatch '\\Utente$' -or $r18Identity.Name -match 'codexsandbox' -or
    -not ([Security.Principal.WindowsPrincipal]::new($r18Identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'OWNER_ADMIN_UNINSTALL_REQUIRED' }
$r18Root=[IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'FAI-CRM-M1-R18'))
$r18Install=[IO.Path]::GetFullPath((Join-Path $r18Root $ManifestSha256.Substring(0,16)))
if ([IO.Path]::GetDirectoryName($r18Install) -ne $r18Root) { throw 'UNINSTALL_SCOPE_INVALID' }
foreach ($r18Process in @(Get-Process -Name M1Executor -ErrorAction SilentlyContinue)) {
    if ($r18Process.Path -eq (Join-Path $r18Install 'M1Executor.exe')) { throw 'STOP_THIS_MCP_SERVER_BEFORE_UNINSTALL' }
}
foreach ($r18Path in @($r18Root,$r18Install)) {
    if ((Get-Item -LiteralPath $r18Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'UNINSTALL_LINK_DENIED' }
}
$r18ManifestPath=Join-Path $r18Install 'manifest.json'
if ((Get-FileHash -LiteralPath $r18ManifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ManifestSha256) { throw 'INSTALLED_MANIFEST_CHANGED' }
$r18Manifest=Get-Content -Raw -LiteralPath $r18ManifestPath | ConvertFrom-Json
$r18Files=@('M1Executor.exe','Install-M1Executor.ps1','Uninstall-M1Executor.ps1','manifest.json','install.json','registration.toml')
if (@(Get-ChildItem -LiteralPath $r18Install -Force | Where-Object { $_.Name -notin $r18Files -or $_.PSIsContainer -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) }).Count) { throw 'UNEXPECTED_INSTALL_CONTENT_PRESERVED' }
foreach ($r18Name in @('M1Executor.exe','Install-M1Executor.ps1','Uninstall-M1Executor.ps1')) {
    if ((Get-FileHash -LiteralPath (Join-Path $r18Install $r18Name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $r18Manifest.files.$r18Name) { throw 'INSTALLED_FILE_CHANGED_PRESERVED' }
}
$r18Config='C:\Users\Utente\.codex\config.toml'
$r18Block=[IO.File]::ReadAllBytes((Join-Path $r18Install 'registration.toml'))
$r18Stream=[IO.File]::Open($r18Config,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read)
try {
    if ($r18Stream.Length -lt $r18Block.Length) { throw 'CONFIG_CHANGED_PRESERVED' }
    $r18Stream.Position=$r18Stream.Length-$r18Block.Length
    $r18Tail=[byte[]]::new($r18Block.Length)
    if ($r18Stream.Read($r18Tail,0,$r18Tail.Length) -ne $r18Tail.Length -or
        [Convert]::ToBase64String($r18Tail) -ne [Convert]::ToBase64String($r18Block)) { throw 'CONFIG_CHANGED_PRESERVED' }
    # Remove precisely the block appended by this installation. Preserve all prior bytes.
    $r18Stream.SetLength($r18Stream.Length-$r18Block.Length); $r18Stream.Flush($true)
} finally { $r18Stream.Dispose() }
# No recursive delete: exact files and already checked namespace only.
foreach ($r18Name in $r18Files) { Remove-Item -LiteralPath (Join-Path $r18Install $r18Name) -ErrorAction Stop }
[IO.Directory]::Delete($r18Install,$false)
if (@(Get-ChildItem -LiteralPath $r18Root -Force).Count -eq 0) { [IO.Directory]::Delete($r18Root,$false) }
[pscustomobject]@{status='UNREGISTERED_AND_CODE_REMOVED';receiptsPreserved=$true;credentialsChanged=$false;productionMutationPerformed=$false} | ConvertTo-Json -Compress
