$ErrorActionPreference = 'Stop'
$installRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$dataDir = if ($env:VEILLINK_DATA_DIR) {
  [IO.Path]::GetFullPath($env:VEILLINK_DATA_DIR).TrimEnd('\')
} else {
  Join-Path $installRoot 'data'
}
if ($dataDir.Equals($installRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'VEILLINK_DATA_DIR must not be the install directory itself.'
}
if (-not (Test-Path -LiteralPath $dataDir)) {
  New-Item -ItemType Directory -Path $dataDir | Out-Null
}

if ($env:VEILLINK_ALLOW_INSECURE_ACL -eq '1') {
  Write-Host 'WARNING: VEILLINK_ALLOW_INSECURE_ACL=1; filesystem ACL hardening was skipped.'
  exit 0
}

$harden = Join-Path $PSScriptRoot 'harden-acl.ps1'
& $harden -Path $installRoot
$insideRoot = $dataDir.StartsWith(
  $installRoot + [IO.Path]::DirectorySeparatorChar,
  [StringComparison]::OrdinalIgnoreCase
)
if (-not $insideRoot) {
  & $harden -Path $dataDir
}

Write-Host 'Filesystem ACLs restricted to the current user, SYSTEM, and Administrators:'
Write-Host "  Install: $installRoot"
Write-Host "  Data:    $dataDir"
exit 0
