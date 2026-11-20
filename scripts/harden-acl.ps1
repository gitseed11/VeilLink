param(
  [Parameter(Mandatory = $true)]
  [string]$Path,
  [string[]]$ExcludePaths = @()
)

$ErrorActionPreference = 'Stop'

$resolved = [IO.Path]::GetFullPath($Path).TrimEnd('\')
if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
  throw "ACL target is not a directory: $resolved"
}
$rootOfPath = [IO.Path]::GetPathRoot($resolved).TrimEnd('\')
if ($resolved -eq $rootOfPath) {
  throw "Refusing to harden a drive root: $resolved"
}
$windowsDir = [IO.Path]::GetFullPath($env:SystemRoot).TrimEnd('\')
if ($resolved.Equals($windowsDir, [StringComparison]::OrdinalIgnoreCase) -or
    $resolved.StartsWith($windowsDir + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to harden a Windows system directory: $resolved"
}
$broadRoots = @(
  $env:USERPROFILE,
  $env:ProgramFiles,
  ${env:ProgramFiles(x86)},
  $env:ProgramData,
  $env:LOCALAPPDATA,
  $env:APPDATA
) | Where-Object { $_ }
foreach ($broadRoot in $broadRoots) {
  $normalizedBroad = [IO.Path]::GetFullPath($broadRoot).TrimEnd('\')
  if ($resolved.Equals($normalizedBroad, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to harden a broad user/Program Files/AppData/ProgramData root: $resolved"
  }
}

# Temp is a transient working tree (and may contain huge scratch dirs). Skip it
# from recursive ACL work/verification; it still inherits the hardened root
# DACL. Do not store secrets there.
$excludedPaths = New-Object System.Collections.Generic.List[string]
foreach ($item in @($ExcludePaths) + @((Join-Path $resolved 'Temp'))) {
  if (-not $item) { continue }
  $full = [IO.Path]::GetFullPath([string]$item).TrimEnd('\')
  $already = $false
  foreach ($existing in $excludedPaths) {
    if ($existing.Equals($full, [StringComparison]::OrdinalIgnoreCase)) {
      $already = $true
      break
    }
  }
  if (-not $already) { $excludedPaths.Add($full) }
}
function Test-Excluded([string]$PathToCheck) {
  foreach ($ex in $excludedPaths) {
    if ($PathToCheck.Equals($ex, [StringComparison]::OrdinalIgnoreCase) -or
        $PathToCheck.StartsWith($ex + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User.Value
$allowedSids = @($sid, 'S-1-5-18', 'S-1-5-32-544')
$icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
if (-not (Test-Path -LiteralPath $icacls)) {
  throw "icacls.exe not found: $icacls"
}

function Test-PathSafe([string]$Path) {
  try {
    if ([IO.Directory]::Exists($Path)) { return $true }
    return [IO.File]::Exists($Path)
  } catch {
    return $false
  }
}

function Get-ChildItemsBestEffort {
  param([string]$Root, [switch]$Recurse)
  $items = New-Object System.Collections.Generic.List[object]
  $pending = New-Object System.Collections.Generic.Stack[string]
  $pending.Push($Root)
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    $entries = @()
    $enumerated = $false
    for ($attempt = 0; $attempt -lt 20 -and -not $enumerated; $attempt += 1) {
      try {
        $entries = @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)
        $enumerated = $true
      } catch {
        if (-not (Test-PathSafe $directory)) {
          break
        }
        if ($attempt -eq 19) {
          if (-not (Test-PathSafe $directory)) {
            break
          }
          throw
        }
        Start-Sleep -Milliseconds 100
      }
    }
    if (-not $enumerated) { continue }
    foreach ($entry in $entries) {
      if (Test-Excluded $entry.FullName) { continue }
      $items.Add($entry)
      if ($Recurse -and $entry.PSIsContainer -and
          -not ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        $pending.Push($entry.FullName)
      }
    }
  }
  return $items.ToArray()
}

function Assert-NoReparsePoints([string]$root) {
  $rootItem = Get-Item -LiteralPath $root -Force -ErrorAction Stop
  if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Refusing to harden a reparse point: $root"
  }
  $links = @(
    Get-ChildItemsBestEffort -Root $root -Recurse |
      Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }
  )
  if ($links.Count -gt 0) {
    throw "Refusing to harden a tree containing reparse points: $($links[0].FullName)"
  }
}

function Remove-UnrestrictedExplicitRules([string]$root) {
  $acl = Get-Acl -LiteralPath $root -ErrorAction Stop
  $grantSids = @{}
  $denySids = @{}
  foreach ($rule in $acl.Access) {
    if ($rule.IsInherited) { continue }
    try {
      $ruleSid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    } catch {
      throw "Cannot resolve ACL identity on $root`: $($rule.IdentityReference)"
    }
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny) {
      $denySids[$ruleSid] = $true
    } elseif ($allowedSids -notcontains $ruleSid) {
      $grantSids[$ruleSid] = $true
    }
  }
  foreach ($ruleSid in $grantSids.Keys) {
    & $icacls $root /remove:g "*$ruleSid" /Q | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "icacls could not remove inherited-to-be grant ACE $ruleSid on $root."
    }
  }
  foreach ($ruleSid in $denySids.Keys) {
    & $icacls $root /remove:d "*$ruleSid" /Q | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "icacls could not remove deny ACE $ruleSid on $root."
    }
  }
}

Assert-NoReparsePoints $resolved

# Take ownership first so a pre-created file/directory owned by another
# principal cannot retain implicit WRITE_DAC. Temp is excluded from recursive
# work; every other top-level child is processed best-effort (/C), because
# concurrent deletions can make icacls return non-zero. The final per-item
# verification below is the authoritative security check.
try {
  & $icacls $resolved /setowner "*$sid" /Q 2>$null | Out-Null
} catch {
}
$topLevelChildren = @(Get-ChildItemsBestEffort -Root $resolved)
foreach ($child in $topLevelChildren) {
  try {
    if ($child.PSIsContainer) {
      & $icacls $child.FullName /setowner "*$sid" /T /C /Q 2>$null | Out-Null
    } else {
      & $icacls $child.FullName /setowner "*$sid" /Q 2>$null | Out-Null
    }
  } catch {
  }
}

# Remove inheritance, then remove every explicit ACE outside the allowlist.
# This order never resets a clean tree to a broad parent ACL.
& $icacls $resolved /inheritance:r /Q | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "icacls inheritance removal failed on $resolved (exit $LASTEXITCODE)."
}
Remove-UnrestrictedExplicitRules $resolved

& $icacls $resolved /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /Q | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "icacls grant failed on $resolved (exit $LASTEXITCODE)."
}

# Children now inherit only the restricted parent DACL. Reset them best-effort
# (/C) because files may disappear during a concurrent cleanup; Temp is skipped
# and keeps its inherited root DACL. The final per-item verification below
# checks every non-excluded item that still exists.
if ($topLevelChildren.Count -gt 0) {
  foreach ($child in $topLevelChildren) {
    try {
      if ($child.PSIsContainer) {
        & $icacls $child.FullName /reset /T /C /Q 2>$null | Out-Null
      } else {
        & $icacls $child.FullName /reset /Q 2>$null | Out-Null
      }
    } catch {
    }
  }
}

Assert-NoReparsePoints $resolved
$items = @(Get-Item -LiteralPath $resolved -Force -ErrorAction Stop)
$items += @(Get-ChildItemsBestEffort -Root $resolved -Recurse)
foreach ($item in $items) {
  $acl = $null
  for ($attempt = 0; $attempt -lt 20 -and $null -eq $acl; $attempt += 1) {
    try {
      $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
    } catch {
      if (-not (Test-PathSafe $item.FullName)) {
        break
      }
      if ($attempt -eq 19) {
        if (-not (Test-PathSafe $item.FullName)) {
          break
        }
        throw
      }
      Start-Sleep -Milliseconds 100
    }
  }
  if ($null -eq $acl) {
    # The item vanished during verification; nothing remains to protect.
    continue
  }
  try {
    $ownerSid = (New-Object Security.Principal.NTAccount -ArgumentList $acl.Owner).Translate(
      [Security.Principal.SecurityIdentifier]
    ).Value
  } catch {
    throw "Cannot resolve owner on $($item.FullName): $($acl.Owner)"
  }
  if ($allowedSids -notcontains $ownerSid) {
    throw "Owner outside the allowlist on $($item.FullName): $ownerSid"
  }
  foreach ($rule in $acl.Access) {
    try {
      $ruleSid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    } catch {
      throw "Cannot resolve ACL identity on $($item.FullName): $($rule.IdentityReference)"
    }
    if ($allowedSids -notcontains $ruleSid) {
      throw "ACE outside the allowlist on $($item.FullName): $ruleSid"
    }
  }
}

Write-Output "ACL OK: $resolved"
exit 0
