param(
  [Parameter(Mandatory = $true)]
  [string]$Path
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

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User.Value
$allowedSids = @($sid, 'S-1-5-18', 'S-1-5-32-544')
$icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
if (-not (Test-Path -LiteralPath $icacls)) {
  throw "icacls.exe not found: $icacls"
}

function Assert-NoReparsePoints([string]$root) {
  $rootItem = Get-Item -LiteralPath $root -Force -ErrorAction Stop
  if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Refusing to harden a reparse point: $root"
  }
  $links = @(
    Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction Stop |
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
# principal cannot retain implicit WRITE_DAC. This fails closed if the current
# user cannot take ownership.
& $icacls $resolved /setowner "*$sid" /T /Q | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "icacls setowner failed on $resolved (exit $LASTEXITCODE)."
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

# Children now inherit only the restricted parent DACL. Reset them to remove
# any remaining explicit or stale inherited ACEs, then verify the final tree.
$children = @(Get-ChildItem -LiteralPath $resolved -Force -ErrorAction Stop)
if ($children.Count -gt 0) {
  & $icacls "$resolved\*" /reset /T /Q | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "icacls child reset failed on $resolved (exit $LASTEXITCODE)."
  }
}

Assert-NoReparsePoints $resolved
$items = @(Get-Item -LiteralPath $resolved -Force -ErrorAction Stop)
$items += @(Get-ChildItem -LiteralPath $resolved -Recurse -Force -ErrorAction Stop)
foreach ($item in $items) {
  $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
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
