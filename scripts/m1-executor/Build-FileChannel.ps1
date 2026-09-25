[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
$channelOut=[IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $channelOut) { throw 'BUILD_DESTINATION_EXISTS' }
[IO.Directory]::CreateDirectory($channelOut) | Out-Null
$channelExe=Join-Path $channelOut 'M1FileChannel.exe'
& 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /target:winexe /optimize+ /platform:x64 /r:System.Web.Extensions.dll /main:Fai.M1.FileChannel ('/out:'+$channelExe) (Join-Path $PSScriptRoot 'M1Executor.cs') (Join-Path $PSScriptRoot 'FileChannel.cs')
if ($LASTEXITCODE -ne 0) { throw 'CHANNEL_COMPILATION_FAILED' }
$channelFiles=[ordered]@{}
foreach ($channelName in @('M1FileChannel.exe','Install-FileChannel.ps1','Uninstall-FileChannel.ps1')) {
    if ($channelName -ne 'M1FileChannel.exe') { [IO.File]::WriteAllBytes((Join-Path $channelOut $channelName),[IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $channelName))) }
    $channelFiles[$channelName]=(Get-FileHash -LiteralPath (Join-Path $channelOut $channelName) -Algorithm SHA256).Hash.ToLowerInvariant()
}
$channelManifest=[ordered]@{
    schema='FAI_M1_FILE_CHANNEL_PACKAGE_R18'
    candidate='fb645e014653ee87dc64f2439970967192f91b62'
    capability='FIXED_READ_ONLY_FILE_TRANSPORT'
    coreManifestSha256='464a7cb3e2150491ef3c32f02406fecfccdf1f5e127988f0f31ba488b897e94e'
    coreExeSha256='d3a595e0abe96e0ceb78cdb62fc7981afc201e9520c61493c3c0a928dc82bb72'
    files=$channelFiles
}
$channelManifestPath=Join-Path $channelOut 'manifest.json'
[IO.File]::WriteAllText($channelManifestPath,($channelManifest|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
[pscustomobject]@{status='CHANNEL_BUILT_NOT_INSTALLED';manifestSha256=(Get-FileHash -LiteralPath $channelManifestPath -Algorithm SHA256).Hash.ToLowerInvariant();directory=$channelOut;productionMutationCapability=$false}|ConvertTo-Json -Compress
