[CmdletBinding()]
param([string]$PythonPath='python')
$ErrorActionPreference='Stop'
$r18TestRoot=Join-Path ([IO.Path]::GetTempPath()) ('fai-m1-executor-test-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($r18TestRoot) | Out-Null
$r18Binding=Join-Path $r18TestRoot 'synthetic-binding.json'
& $PythonPath -I -B -S (Join-Path $PSScriptRoot 'test_observe_m1.py')
if ($LASTEXITCODE -ne 0) { throw 'REMOTE_OBSERVER_TESTS_FAILED' }
& $PythonPath -I -B -S (Join-Path $PSScriptRoot 'test_observe_m1.py') --write-synthetic-binding $r18Binding
if ($LASTEXITCODE -ne 0) { throw 'SYNTHETIC_BINDING_FAILED' }
$r18Package=Join-Path $r18TestRoot 'package'
& (Join-Path $PSScriptRoot 'Build-M1Executor.ps1') -BindingPath $r18Binding -OutputDirectory $r18Package
$r18TestExe=Join-Path $r18TestRoot 'TestExecutor.exe'
$r18Csc='C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $r18Csc /nologo /target:exe /platform:x64 ('/out:'+(Join-Path $r18TestRoot 'TestChild.exe')) (Join-Path $PSScriptRoot 'TestChild.cs')
if ($LASTEXITCODE -ne 0) { throw 'CHILD_FIXTURE_COMPILATION_FAILED' }
& $r18Csc /nologo /target:exe /platform:x64 /r:System.Web.Extensions.dll /main:TestExecutor ('/out:'+$r18TestExe) (Join-Path $PSScriptRoot 'M1Executor.cs') (Join-Path $PSScriptRoot 'TestExecutor.cs')
if ($LASTEXITCODE -ne 0) { throw 'TEST_COMPILATION_FAILED' }
& $r18TestExe
if ($LASTEXITCODE -ne 0) { throw 'EXECUTOR_SECURITY_TESTS_FAILED' }
& $PythonPath -I -B -S (Join-Path $PSScriptRoot 'test_protocol.py') (Join-Path $r18Package 'M1Executor.exe')
if ($LASTEXITCODE -ne 0) { throw 'STDIO_PROTOCOL_TESTS_FAILED' }
$r18ManifestSha=(Get-FileHash -LiteralPath (Join-Path $r18Package 'manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
& (Join-Path $PSScriptRoot 'Install-M1Executor.ps1') -PackagePath $r18Package -ManifestSha256 $r18ManifestSha -ValidatePackageOnly
$r18Tampered=Join-Path $r18Package 'M1Executor.exe'
[IO.File]::AppendAllText($r18Tampered,'synthetic-tamper')
$r18Rejected=$false
try { & (Join-Path $PSScriptRoot 'Install-M1Executor.ps1') -PackagePath $r18Package -ManifestSha256 $r18ManifestSha -ValidatePackageOnly }
catch { if ($_.Exception.Message -ne 'PACKAGE_FILE_HASH_MISMATCH') { throw }; $r18Rejected=$true }
if (-not $r18Rejected) { throw 'TAMPERED_PACKAGE_ACCEPTED' }
[pscustomobject]@{status='WINDOWS_PACKAGE_TESTS_PASS';tamperRejected=$true;remoteConnectionAttempted=$false;installationPerformed=$false;testArtifacts=$r18TestRoot} | ConvertTo-Json -Compress
