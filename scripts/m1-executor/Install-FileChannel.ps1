[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$PackagePath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestSha256,
    [ValidatePattern('^[A-Za-z0-9:/._#?=-]{10,240}$')][string]$ReviewReference,
    [switch]$ValidatePackageOnly
)
$ErrorActionPreference='Stop'
function Channel-Sha([byte[]]$Bytes) {
    $channelHasher=[Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($channelHasher.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() }
    finally { $channelHasher.Dispose() }
}
function Channel-NoLinks([string]$Path) {
    for ($channelWalk=[IO.Path]::GetFullPath($Path);$channelWalk;$channelWalk=[IO.Path]::GetDirectoryName($channelWalk)) {
        if ((Get-Item -LiteralPath $channelWalk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'CHANNEL_INSTALL_LINK_DENIED' }
    }
}
$channelPackage=(Resolve-Path -LiteralPath $PackagePath).ProviderPath
Channel-NoLinks $channelPackage
$channelManifestPath=Join-Path $channelPackage 'manifest.json'
Channel-NoLinks $channelManifestPath
if ((Get-Item -LiteralPath $channelManifestPath).Length -gt 8192) { throw 'CHANNEL_MANIFEST_SIZE' }
$channelManifestBytes=[IO.File]::ReadAllBytes($channelManifestPath)
if ((Channel-Sha $channelManifestBytes) -ne $ManifestSha256) { throw 'CHANNEL_MANIFEST_HASH_MISMATCH' }
$channelManifest=[Text.UTF8Encoding]::new($false,$true).GetString($channelManifestBytes)|ConvertFrom-Json
if ($channelManifest.schema -ne 'FAI_M1_FILE_CHANNEL_PACKAGE_R18' -or
    $channelManifest.capability -ne 'FIXED_READ_ONLY_FILE_TRANSPORT' -or
    $channelManifest.candidate -ne 'fb645e014653ee87dc64f2439970967192f91b62' -or
    $channelManifest.coreManifestSha256 -ne '464a7cb3e2150491ef3c32f02406fecfccdf1f5e127988f0f31ba488b897e94e' -or
    $channelManifest.coreExeSha256 -ne 'd3a595e0abe96e0ceb78cdb62fc7981afc201e9520c61493c3c0a928dc82bb72') { throw 'CHANNEL_PACKAGE_SCOPE_MISMATCH' }
$channelNames=@('M1FileChannel.exe','Install-FileChannel.ps1','Uninstall-FileChannel.ps1')
if (@($channelManifest.files.psobject.Properties).Count -ne 3 -or
    @($channelManifest.files.psobject.Properties.Name|Where-Object {$_ -notin $channelNames}).Count) { throw 'CHANNEL_PACKAGE_FILE_SET' }
$channelBytes=@{}
foreach ($channelName in $channelNames) {
    $channelPath=Join-Path $channelPackage $channelName
    Channel-NoLinks $channelPath
    if ((Get-Item -LiteralPath $channelPath).Length -gt 4MB) { throw 'CHANNEL_PACKAGE_SIZE' }
    $channelBytes[$channelName]=[IO.File]::ReadAllBytes($channelPath)
    if ((Channel-Sha $channelBytes[$channelName]) -ne $channelManifest.files.$channelName) { throw 'CHANNEL_PACKAGE_HASH_MISMATCH' }
}
if ($ValidatePackageOnly) {
    [pscustomobject]@{status='CHANNEL_PACKAGE_VALIDATED_NOT_INSTALLED';manifestSha256=$ManifestSha256;remoteConnectionAttempted=$false;configurationChanged=$false}|ConvertTo-Json -Compress
    return
}
if (-not $ReviewReference) { throw 'CHANNEL_REVIEW_REFERENCE_REQUIRED' }
$channelIdentity=[Security.Principal.WindowsIdentity]::GetCurrent()
if ($channelIdentity.Name -notmatch '\\Utente$' -or $channelIdentity.Name -match 'codexsandbox' -or
    -not ([Security.Principal.WindowsPrincipal]::new($channelIdentity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'EXPLICIT_OWNER_ADMIN_INSTALL_REQUIRED' }
$channelOwner=$channelIdentity.User
$channelCore='C:\Program Files\FAI-CRM-M1-R18\464a7cb3e2150491'
Channel-NoLinks $channelCore
foreach ($channelItem in @(@('M1Executor.exe',$channelManifest.coreExeSha256),@('manifest.json',$channelManifest.coreManifestSha256))) {
    Channel-NoLinks (Join-Path $channelCore $channelItem[0])
    if ((Get-FileHash -LiteralPath (Join-Path $channelCore $channelItem[0]) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $channelItem[1]) { throw 'EXISTING_CORE_HASH_MISMATCH' }
}
Channel-NoLinks (Join-Path $channelCore 'install.json')
$channelCoreAdmission=[IO.File]::ReadAllText((Join-Path $channelCore 'install.json'))|ConvertFrom-Json
if ($channelCoreAdmission.ownerSid -ne $channelOwner.Value -or $channelCoreAdmission.approvedManifestSha256 -ne $channelManifest.coreManifestSha256) { throw 'EXISTING_CORE_OWNER_MISMATCH' }
$channelCode='C:\Program Files\FAI-CRM-M1-CHANNEL-R18'
$channelState='C:\ProgramData\FAI-CRM-M1-CHANNEL-R18'
$channelInbox='C:\Users\Utente\.codex\visualizations\2026\09\21\01a0c20b-b096-78a3-b6f6-db9153b914fe\m1-owner-channel-r18'
foreach ($channelRoot in @($channelCode,$channelState,$channelInbox)) {
    if (Test-Path -LiteralPath $channelRoot) { throw 'CHANNEL_PATH_OCCUPIED_RECONCILE_FIRST' }
    Channel-NoLinks ([IO.Path]::GetDirectoryName($channelRoot))
}
$channelRun=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run',$true)
if ($null -eq $channelRun) { throw 'OWNER_RUN_KEY_UNAVAILABLE' }
$channelAssembly=[Reflection.Assembly]::Load($channelBytes['M1FileChannel.exe'])
$channelParentLocks=$channelAssembly.GetType('Fai.M1.FileChannelInstallSupport').GetMethod('HoldInstallationParents').Invoke($null,@())
try {
    if ($null -ne $channelRun.GetValue('FAI-CRM-M1-CHANNEL-R18',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)) { throw 'CHANNEL_RUN_VALUE_OCCUPIED' }
    $channelAdmins=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    $channelSystem=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $channelOffline=([Security.Principal.NTAccount]::new($env:COMPUTERNAME,'CodexSandboxOffline')).Translate([Security.Principal.SecurityIdentifier])
    function Channel-NewDirectory([string]$Path,[ValidateSet('Code','State','Inbox')][string]$Kind) {
        $channelAcl=[Security.AccessControl.DirectorySecurity]::new()
        $channelAcl.SetAccessRuleProtection($true,$false);$channelAcl.SetOwner($channelAdmins)
        $channelInheritance=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
        foreach ($channelSid in @($channelAdmins,$channelSystem)) {
            $channelAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($channelSid,'FullControl',$channelInheritance,'None','Allow'))
        }
        $channelOwnerRights=if ($Kind -eq 'Code') {'ReadAndExecute'} else {'Modify'}
        $channelAgentRights=if ($Kind -eq 'Inbox') {'Modify'} else {'ReadAndExecute'}
        $channelAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($channelOwner,$channelOwnerRights,$channelInheritance,'None','Allow'))
        $channelAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($channelOffline,$channelAgentRights,$channelInheritance,'None','Allow'))
        if ($Kind -ne 'Inbox') {
            $channelAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($channelOffline,'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership',$channelInheritance,'None','Deny'))
        }
        $channelDescriptor=$channelAcl.GetSecurityDescriptorBinaryForm()
        [void]$channelAssembly.GetType('Fai.M1.FileChannelInstallSupport').GetMethod('CreateProtectedDirectory').Invoke($null,@($Path,$channelDescriptor))
    }
    Channel-NewDirectory $channelCode Code
    Channel-NewDirectory $channelState State
    Channel-NewDirectory $channelInbox Inbox
    $channelInstall=Join-Path $channelCode $ManifestSha256.Substring(0,16)
    Channel-NewDirectory $channelInstall Code
    foreach ($channelName in $channelNames) { [IO.File]::WriteAllBytes((Join-Path $channelInstall $channelName),$channelBytes[$channelName]) }
    [IO.File]::WriteAllBytes((Join-Path $channelInstall 'manifest.json'),$channelManifestBytes)
    # Load only the bytes already hashed above, not a mutable workspace path.
    $channelInboxIdentity=$channelAssembly.GetType('Fai.M1.FileChannelInstallSupport').GetMethod('InboxIdentity').Invoke($null,@())
    $channelAdmission=[ordered]@{schema='FAI_M1_FILE_CHANNEL_INSTALL_R18';ownerSid=$channelOwner.Value;
        manifestSha256=$ManifestSha256;exeSha256=$channelManifest.files.'M1FileChannel.exe';
        inboxIdentity=$channelInboxIdentity;reviewReference=$ReviewReference}
    [IO.File]::WriteAllText((Join-Path $channelInstall 'install.json'),($channelAdmission|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    foreach ($channelName in @($channelNames)+@('manifest.json','install.json')) {
        $channelPath=Join-Path $channelInstall $channelName
        $channelAcl=Get-Acl -LiteralPath $channelPath
        $channelAcl.SetOwner($channelAdmins);Set-Acl -LiteralPath $channelPath -AclObject $channelAcl
    }
    $channelCommand='"'+(Join-Path $channelInstall 'M1FileChannel.exe')+'"'
    if ($channelCommand.Length -gt 260) { throw 'CHANNEL_RUN_COMMAND_LIMIT' }
    $channelRun.SetValue('FAI-CRM-M1-CHANNEL-R18',$channelCommand,[Microsoft.Win32.RegistryValueKind]::String)
    $channelReceipt=[ordered]@{protocol='FAI_M1_FILE_CHANNEL_INSTALL_RECEIPT_R18';status='INSTALLED_NOT_STARTED_OR_QUALIFIED';
        manifestSha256=$ManifestSha256;installedDirectory=$channelInstall;reviewReference=$ReviewReference;
        ownerLogonStartup=$true;remoteConnectionAttempted=$false;productionMutationCapability=$false;credentialsChanged=$false;
        existingMcpUnchanged=$true;existingAclUnchanged=$true;custodyPolicyUnchanged=$true}
    [IO.File]::WriteAllText((Join-Path $channelState 'installation-receipt.json'),($channelReceipt|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    $channelReceipt|ConvertTo-Json -Compress
} finally { $channelParentLocks.Dispose();$channelRun.Dispose() }
