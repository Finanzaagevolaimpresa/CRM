[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$PackagePath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestSha256,
    [ValidatePattern('^[A-Za-z0-9:/._#?=-]{10,240}$')][string]$ReviewReference,
    [switch]$ValidatePackageOnly
)
$ErrorActionPreference='Stop'
function R18-Sha([byte[]]$Bytes) {
    $r18Hasher=[Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($r18Hasher.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() }
    finally { $r18Hasher.Dispose() }
}
function R18-NoLinks([string]$Path) {
    $r18Walk=[IO.Path]::GetFullPath($Path)
    while ($r18Walk) {
        if ((Get-Item -LiteralPath $r18Walk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'INSTALL_LINK_DENIED' }
        $r18Walk=[IO.Path]::GetDirectoryName($r18Walk)
    }
}
$r18Package=(Resolve-Path -LiteralPath $PackagePath).ProviderPath
R18-NoLinks $r18Package
$r18ManifestPath=Join-Path $r18Package 'manifest.json'
R18-NoLinks $r18ManifestPath
$r18ManifestBytes=[IO.File]::ReadAllBytes($r18ManifestPath)
if ((R18-Sha $r18ManifestBytes) -ne $ManifestSha256) { throw 'MANIFEST_HASH_MISMATCH' }
$r18Manifest=[Text.Encoding]::UTF8.GetString($r18ManifestBytes) | ConvertFrom-Json
if ($r18Manifest.schema -ne 'FAI_M1_OBSERVE_PACKAGE_R18' -or $r18Manifest.capability -ne 'READ_ONLY_ADMISSION' -or
    $r18Manifest.candidate -ne 'fb645e014653ee87dc64f2439970967192f91b62') { throw 'PACKAGE_SCOPE_MISMATCH' }
$r18Names=@('M1Executor.exe','Install-M1Executor.ps1','Uninstall-M1Executor.ps1')
if (@($r18Manifest.files.psobject.Properties).Count -ne 3 -or
    @($r18Manifest.files.psobject.Properties.Name | Where-Object { $_ -notin $r18Names }).Count) { throw 'PACKAGE_FILE_SET_INVALID' }
# Hold verified bytes in memory before any privileged filesystem change.
$r18Bytes=@{}
foreach ($r18Name in $r18Names) {
    $r18Path=Join-Path $r18Package $r18Name
    R18-NoLinks $r18Path
    if ((Get-Item -LiteralPath $r18Path).Length -gt 4MB) { throw 'PACKAGE_SIZE_LIMIT' }
    $r18Bytes[$r18Name]=[IO.File]::ReadAllBytes($r18Path)
    if ((R18-Sha $r18Bytes[$r18Name]) -ne $r18Manifest.files.$r18Name) { throw 'PACKAGE_FILE_HASH_MISMATCH' }
}
if ($ValidatePackageOnly) {
    [pscustomobject]@{status='PACKAGE_VALIDATED_NOT_INSTALLED';manifestSha256=$ManifestSha256;remoteConnectionAttempted=$false;configurationChanged=$false} | ConvertTo-Json -Compress
    return
}
if (-not $ReviewReference) { throw 'INDEPENDENT_REVIEW_REFERENCE_REQUIRED' }
$r18Identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$r18OwnerSid=$r18Identity.User.Value
if ($r18Identity.Name -notmatch '\\Utente$' -or $r18Identity.Name -match 'codexsandbox' -or
    -not ([Security.Principal.WindowsPrincipal]::new($r18Identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'EXPLICIT_OWNER_ADMIN_INSTALL_REQUIRED'
}
$r18OwnerProfile='C:\Users\Utente'
$r18SshProfile=Join-Path $r18OwnerProfile '.ssh\config'
$r18SshExe='C:\Windows\System32\OpenSSH\ssh.exe'
R18-NoLinks $r18SshProfile
R18-NoLinks $r18SshExe
$r18ProfileText=[IO.File]::ReadAllText($r18SshProfile)
if ($r18ProfileText -match '(?im)^\s*(Include|Match|ProxyCommand|ProxyJump|LocalCommand|KnownHostsCommand|PKCS11Provider|SecurityKeyProvider|RemoteCommand|SetEnv)(?:\s|=)' -or
    $r18ProfileText -match 'FAI-Custodia') { throw 'OWNER_PROFILE_UNSUPPORTED_DIRECTIVE' }
$r18Offline=([Security.Principal.NTAccount]::new($env:COMPUTERNAME,'CodexSandboxOffline')).Translate([Security.Principal.SecurityIdentifier])
$r18Admins=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$r18System=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$r18Owner=[Security.Principal.SecurityIdentifier]::new($r18OwnerSid)
$r18CodeRoot=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'FAI-CRM-M1-R18'
$r18StateRoot=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'FAI-CRM-M1-R18'
if ((Test-Path -LiteralPath $r18CodeRoot) -or (Test-Path -LiteralPath $r18StateRoot)) { throw 'INSTALLATION_PATH_OCCUPIED_RECONCILE_FIRST' }
R18-NoLinks ([IO.Path]::GetDirectoryName($r18CodeRoot))
R18-NoLinks ([IO.Path]::GetDirectoryName($r18StateRoot))
$r18ConfigPath=Join-Path $r18OwnerProfile '.codex\config.toml'
R18-NoLinks $r18ConfigPath
$r18ConfigStream=[IO.File]::Open($r18ConfigPath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read)
try {
    if ($r18ConfigStream.Length -gt 2MB) { throw 'CONFIGURATION_SIZE_LIMIT' }
    $r18Before=[byte[]]::new([int]$r18ConfigStream.Length)
    $r18Read=0
    while ($r18Read -lt $r18Before.Length) { $r18N=$r18ConfigStream.Read($r18Before,$r18Read,$r18Before.Length-$r18Read); if ($r18N -eq 0) { throw 'CONFIG_READ_INCOMPLETE' }; $r18Read+=$r18N }
    $r18ConfigText=[Text.UTF8Encoding]::new($false,$true).GetString($r18Before)
    if ($r18ConfigText -match 'fai_crm_m1_owner' -or $r18ConfigText -match '(?m)^\s*mcp_servers\s*=') { throw 'MCP_NAMESPACE_OCCUPIED_OR_INLINE_CONFIG' }
    if ($r18ConfigText -notmatch '(?m)^\s*default_permissions\s*=\s*"fai-custody-guard"\s*$' -or
        $r18ConfigText -notmatch '(?ms)^\[windows\]\s*\r?\n(?:(?!^\[).)*?^\s*sandbox\s*=\s*"elevated"\s*$' -or
        $r18ConfigText -notmatch 'FAI-Custodia') { throw 'CUSTODY_CONFIGURATION_NOT_RECOGNIZED' }
    function R18-NewProtectedDirectory([string]$Path,[bool]$State) {
        $r18Acl=[Security.AccessControl.DirectorySecurity]::new()
        $r18Acl.SetAccessRuleProtection($true,$false)
        $r18Acl.SetOwner($r18Admins)
        $r18Inheritance=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
        foreach ($r18Sid in @($r18Admins,$r18System)) {
            $r18Acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($r18Sid,'FullControl',$r18Inheritance,'None','Allow'))
        }
        $r18Rights=if ($State) { 'Modify' } else { 'ReadAndExecute' }
        $r18Acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($r18Owner,$r18Rights,$r18Inheritance,'None','Allow'))
        $r18Acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($r18Offline,'ReadAndExecute',$r18Inheritance,'None','Allow'))
        $r18Acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($r18Offline,'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership',$r18Inheritance,'None','Deny'))
        # The DACL is supplied at creation, not broadened then tightened later.
        [IO.Directory]::CreateDirectory($Path,$r18Acl) | Out-Null
    }
    R18-NewProtectedDirectory $r18CodeRoot $false
    R18-NewProtectedDirectory $r18StateRoot $true
    $r18Install=Join-Path $r18CodeRoot $ManifestSha256.Substring(0,16)
    R18-NewProtectedDirectory $r18Install $false
    foreach ($r18Name in $r18Names) { [IO.File]::WriteAllBytes((Join-Path $r18Install $r18Name),$r18Bytes[$r18Name]) }
    [IO.File]::WriteAllBytes((Join-Path $r18Install 'manifest.json'),$r18ManifestBytes)
    $r18Admission=[ordered]@{schema='FAI_M1_OBSERVE_INSTALL_R18';ownerSid=$r18OwnerSid;exeSha256=$r18Manifest.files.'M1Executor.exe';
        profileSha256=(Get-FileHash -LiteralPath $r18SshProfile -Algorithm SHA256).Hash.ToLowerInvariant();
        sshSha256=(Get-FileHash -LiteralPath $r18SshExe -Algorithm SHA256).Hash.ToLowerInvariant();reviewReference=$ReviewReference;approvedManifestSha256=$ManifestSha256}
    [IO.File]::WriteAllText((Join-Path $r18Install 'install.json'),($r18Admission|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    $r18Command=Join-Path $r18Install 'M1Executor.exe'
    $r18Block="`r`n# FAI_M1_R18_BEGIN $ManifestSha256`r`n[mcp_servers.fai_crm_m1_owner]`r`ncommand = '$r18Command'`r`ncwd = '$r18Install'`r`nstartup_timeout_sec = 15`r`ntool_timeout_sec = 170`r`nenabled_tools = ['fai_crm_m1_status', 'fai_crm_m1_observe', 'fai_crm_m1_reconcile']`r`n# FAI_M1_R18_END`r`n"
    [IO.File]::WriteAllText((Join-Path $r18Install 'registration.toml'),$r18Block,[Text.UTF8Encoding]::new($false))
    foreach ($r18InstalledName in @($r18Names)+@('manifest.json','install.json','registration.toml')) {
        $r18InstalledPath=Join-Path $r18Install $r18InstalledName
        $r18InstalledAcl=Get-Acl -LiteralPath $r18InstalledPath
        $r18InstalledAcl.SetOwner($r18Admins)
        Set-Acl -LiteralPath $r18InstalledPath -AclObject $r18InstalledAcl
    }
    $r18BlockBytes=[Text.Encoding]::UTF8.GetBytes($r18Block)
    $r18ConfigStream.Position=$r18Before.Length
    $r18ConfigStream.Write($r18BlockBytes,0,$r18BlockBytes.Length)
    $r18ConfigStream.Flush($true)
    $r18Receipt=[ordered]@{schema='FAI_M1_INSTALL_RECEIPT_R18';status='INSTALLED_CHANNEL_NOT_YET_QUALIFIED';manifestSha256=$ManifestSha256;
        installedDirectory=$r18Install;stateDirectory=$r18StateRoot;reviewReference=$ReviewReference;productionMutationCapability=$false;
        remoteConnectionAttempted=$false;credentialsChanged=$false;custodyPolicyUnchanged=$true;configOriginalPrefixSha256=(R18-Sha $r18Before)}
    [IO.File]::WriteAllText((Join-Path $r18StateRoot 'installation-receipt.json'),($r18Receipt|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    $r18Receipt | ConvertTo-Json -Compress
} finally { $r18ConfigStream.Dispose() }
