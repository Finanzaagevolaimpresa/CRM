[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$BindingPath,
    [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$r18Compiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$r18Out = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $r18Out) { throw 'BUILD_DESTINATION_EXISTS' }
$r18BindingBytes = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $BindingPath).ProviderPath)
$r18Binding = [Text.Encoding]::UTF8.GetString($r18BindingBytes) | ConvertFrom-Json
if ($r18Binding.candidate -ne 'fb645e014653ee87dc64f2439970967192f91b62' -or
    @($r18Binding.ledger.psobject.Properties).Count -ne 46) { throw 'BUILD_BINDING_INVALID' }
[IO.Directory]::CreateDirectory($r18Out) | Out-Null
$r18BindingCopy = Join-Path $r18Out 'binding.build-input.json'
[IO.File]::WriteAllBytes($r18BindingCopy,$r18BindingBytes)
$r18Exe = Join-Path $r18Out 'M1Executor.exe'
$r18CompileArgs = @('/nologo','/target:exe','/optimize+','/platform:x64','/r:System.Web.Extensions.dll',
    ('/out:' + $r18Exe),('/resource:' + (Join-Path $PSScriptRoot 'observe_m1.py') + ',observer.py'),
    ('/resource:' + $r18BindingCopy + ',binding.json'),(Join-Path $PSScriptRoot 'M1Executor.cs'))
& $r18Compiler @r18CompileArgs
if ($LASTEXITCODE -ne 0) { throw 'COMPILATION_FAILED' }
foreach ($r18Name in @('Install-M1Executor.ps1','Uninstall-M1Executor.ps1')) {
    [IO.File]::WriteAllBytes((Join-Path $r18Out $r18Name),[IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $r18Name)))
}
$r18Files = [ordered]@{}
foreach ($r18Name in @('M1Executor.exe','Install-M1Executor.ps1','Uninstall-M1Executor.ps1')) {
    $r18Files[$r18Name] = (Get-FileHash -LiteralPath (Join-Path $r18Out $r18Name) -Algorithm SHA256).Hash.ToLowerInvariant()
}
$r18Manifest = [ordered]@{
    schema='FAI_M1_OBSERVE_PACKAGE_R18'; candidate=$r18Binding.candidate; capability='READ_ONLY_ADMISSION';
    observerSha256=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'observe_m1.py') -Algorithm SHA256).Hash.ToLowerInvariant();
    bindingSha256=(Get-FileHash -LiteralPath $r18BindingCopy -Algorithm SHA256).Hash.ToLowerInvariant(); files=$r18Files
}
$r18ManifestPath=Join-Path $r18Out 'manifest.json'
[IO.File]::WriteAllText($r18ManifestPath,($r18Manifest | ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
[pscustomobject]@{status='BUILT_NOT_INSTALLED';directory=$r18Out;manifestSha256=(Get-FileHash -LiteralPath $r18ManifestPath -Algorithm SHA256).Hash.ToLowerInvariant();productionMutationCapability=$false} | ConvertTo-Json -Compress
