# Read-only identity check of the two previously approved physical destinations.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Need([bool]$value, [string]$code) { if (-not $value) { throw $code } }
function One([string]$class, [string]$filter) {
    $items = @(Get-CimInstance -Namespace root/Microsoft/Windows/Storage -ClassName $class -Filter $filter -OperationTimeoutSec 8)
    Need ($items.Count -eq 1) 'STORAGE_CARDINALITY'
    return $items[0]
}
function Device($letter, $partition, $disk, $serial, $unique, $bus, $offset, $size) {
    $p = One MSFT_Partition ("DriveLetter='" + $letter + "'")
    $d = One MSFT_Disk ('Number=' + [string]$p.DiskNumber)
    $v = One MSFT_Volume ("DriveLetter='" + $letter + "'")
    Need (([string]$p.Guid).Trim('{}').ToLowerInvariant() -ceq $partition) ('PARTITION_CHANGED_' + $letter)
    Need (([string]$d.Guid).Trim('{}').ToLowerInvariant() -ceq $disk) ('DISK_CHANGED_' + $letter)
    Need ($d.SerialNumber -ceq $serial -and $d.UniqueId -ceq $unique -and $d.BusType -eq $bus) ('PHYSICAL_IDENTITY_CHANGED_' + $letter)
    Need ($p.Offset -eq $offset -and $p.Size -eq $size) ('GEOMETRY_CHANGED_' + $letter)
    Need ($v.FileSystem -ceq 'NTFS' -and $d.HealthStatus -eq 0 -and $v.HealthStatus -eq 0 -and -not $d.IsOffline) ('STORAGE_UNHEALTHY_' + $letter)
    Need ($v.SizeRemaining -ge 10737418240) ('SPACE_LOW_' + $letter)
    return @{ physicalIdentityVerified = $true; partition = $partition; disk = $disk; freeBytes = $v.SizeRemaining }
}
try {
    $binding = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'owner-binding.json') | ConvertFrom-Json
    $ec = $binding.drives.C
    $ef = $binding.drives.F
    $c = Device 'C' $ec.partition $ec.disk $ec.serial $ec.unique $ec.bus $ec.offset $ec.size
    $f = Device 'F' $ef.partition $ef.disk $ef.serial $ef.unique $ef.bus $ef.offset $ef.size
    Need ($c.disk -cne $f.disk) 'DESTINATIONS_NOT_PHYSICALLY_SEPARATE'
    @{status='PASS'; C=$c; F=$f; readOnly=$true; policyChanged=$false} | ConvertTo-Json -Depth 5 -Compress
} catch {
    $code = [string]$_.Exception.Message
    if ($code -notmatch '^[A-Z_]{1,80}$') { $code = 'STORAGE_METADATA_UNAVAILABLE' }
    @{status='STOP'; code=$code; readOnly=$true; policyChanged=$false} | ConvertTo-Json -Compress
    exit 2
}
