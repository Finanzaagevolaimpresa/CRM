[CmdletBinding()]
param([switch]$FixtureBoundaryOnly)
$ErrorActionPreference='Stop'
$channelTest=Join-Path ([IO.Path]::GetTempPath()) ('fai-m1-channel-test-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($channelTest)|Out-Null
$channelCsc='C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$channelTestExe=Join-Path $channelTest 'TestFileChannel.exe'
& $channelCsc /nologo /target:exe /platform:x64 /r:System.Web.Extensions.dll /main:TestFileChannel ('/out:'+$channelTestExe) (Join-Path $PSScriptRoot 'M1Executor.cs') (Join-Path $PSScriptRoot 'FileChannel.cs') (Join-Path $PSScriptRoot 'TestFileChannel.cs')
if ($LASTEXITCODE -ne 0) { throw 'FILE_CHANNEL_TEST_COMPILATION' }
if ($FixtureBoundaryOnly) { & $channelTestExe --fixture-boundary }
else { & $channelTestExe }
if ($LASTEXITCODE -ne 0) { throw 'FILE_CHANNEL_SECURITY_TESTS_FAILED' }
foreach ($channelScript in @('Build-FileChannel.ps1','Install-FileChannel.ps1','Uninstall-FileChannel.ps1','New-FileChannelLauncher.ps1')) {
    $channelTokens=$null;$channelErrors=$null
    [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $channelScript),[ref]$channelTokens,[ref]$channelErrors)
    if ($channelErrors.Count) { throw ('CHANNEL_POWERSHELL_PARSE_'+$channelScript) }
}
$channelPackage=Join-Path $channelTest 'package'
& (Join-Path $PSScriptRoot 'Build-FileChannel.ps1') -OutputDirectory $channelPackage
$channelSha=(Get-FileHash -LiteralPath (Join-Path $channelPackage 'manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
& (Join-Path $PSScriptRoot 'Install-FileChannel.ps1') -PackagePath $channelPackage -ManifestSha256 $channelSha -ValidatePackageOnly
& (Join-Path $PSScriptRoot 'New-FileChannelLauncher.ps1') -PackagePath $channelPackage -ManifestSha256 $channelSha -ReviewReference 'synthetic-review-not-an-approval' -OutputDirectory (Join-Path $channelTest 'launcher')
& (Join-Path $PSScriptRoot 'New-FileChannelLauncher.ps1') -PackagePath $channelPackage -ManifestSha256 $channelSha -ReviewReference 'synthetic-review-not-an-approval' -OutputDirectory (Join-Path $channelTest 'upgrade-launcher') -UpgradeExisting
if (-not ([IO.File]::ReadAllText((Join-Path $channelTest 'upgrade-launcher\INSTALLA_CANALE_M1_R18.ps1')).Contains('-UpgradeExisting:$true'))) {throw 'UPGRADE_LAUNCHER_MODE_MISSING'}
# Run the real executable from a synthetic, non-installed path; admission must
# refuse before provider execution, SSH, owner profile or private-key access.
$channelProbe=Start-Process -FilePath (Join-Path $channelPackage 'M1FileChannel.exe') -WindowStyle Hidden -PassThru -Wait
if ($channelProbe.ExitCode -ne 2) { throw 'UNINSTALLED_CHANNEL_DID_NOT_REFUSE' }
[IO.File]::AppendAllText((Join-Path $channelPackage 'M1FileChannel.exe'),'synthetic-tamper')
$channelRejected=$false
try { & (Join-Path $PSScriptRoot 'Install-FileChannel.ps1') -PackagePath $channelPackage -ManifestSha256 $channelSha -ValidatePackageOnly }
catch {if ($_.Exception.Message -ne 'CHANNEL_PACKAGE_HASH_MISMATCH') {throw};$channelRejected=$true}
if (-not $channelRejected) { throw 'CHANNEL_TAMPER_ACCEPTED' }
[pscustomobject]@{status='FILE_CHANNEL_PACKAGE_TESTS_PASS';tamperRejected=$true;uninstalledRuntimeRefused=$true;remoteConnectionAttempted=$false;installationPerformed=$false;artifacts=$channelTest}|ConvertTo-Json -Compress
