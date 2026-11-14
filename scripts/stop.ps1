param(
  [switch]$Force
)

if (-not $Force) {
  Add-Type -AssemblyName System.Windows.Forms | Out-Null
  $answer = [System.Windows.Forms.MessageBox]::Show(
    "确定停止 VeilLink 服务吗？`n`n停止后，本地管理页和公网 API 都会立即不可用。`nCloudflare 隧道也会一并停止。`n`n如需继续使用，请重新打开桌面快捷方式。",
    '停止 VeilLink',
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Warning,
    [System.Windows.Forms.MessageBoxDefaultButton]::Button2
  )
  if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) {
    Write-Host '已取消停止。'
    exit 0
  }
}

$ErrorActionPreference = 'SilentlyContinue'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$dataDir = if ($env:VEILLINK_DATA_DIR) {
  [IO.Path]::GetFullPath($env:VEILLINK_DATA_DIR).TrimEnd('\')
} else {
  Join-Path $root 'data'
}
$adminPort = if ($env:VEILLINK_ADMIN_PORT) { [int]$env:VEILLINK_ADMIN_PORT } else { 8787 }
$publicPort = if ($env:VEILLINK_PUBLIC_PORT) { [int]$env:VEILLINK_PUBLIC_PORT } else { 8788 }
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
$serverScript = Join-Path $root 'src\server.js'
$cloudflared = Join-Path $root 'bin\cloudflared.exe'
$tunnelConfig = Join-Path $dataDir 'tunnel\config.yml'
$watchdogScript = Join-Path $PSScriptRoot 'watchdog.ps1'
$serverPidFile = Join-Path $dataDir 'veillink.pid'
$tunnelPidFile = Join-Path $dataDir 'cloudflared.pid'
$watchdogPidFile = Join-Path $dataDir 'watchdog.pid'
$serverMarker = "--veillink-data-dir=`"$dataDir`""
$watchdogMarker = "-DataDir `"$dataDir`""

function Stop-MatchingProcess([int]$processId, [string]$executablePath, [string]$commandMarker) {
  if ($processId -le 0 -or $processId -eq $PID) { return $false }
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if (-not $process) { return $false }
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
  if (-not $cim -or -not $cim.CommandLine) { return $false }
  if ($executablePath -and $cim.ExecutablePath -ne $executablePath) { return $false }
  if ($commandMarker -and $cim.CommandLine -notlike "*$commandMarker*") { return $false }
  Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  Wait-Process -Id $processId -Timeout 5 -ErrorAction SilentlyContinue
  Write-Host "Stopped $($process.ProcessName) (PID $processId)."
  return $true
}

function Stop-FromPidFile([string]$pidFile, [string]$executablePath, [string]$commandMarker, [string]$label) {
  if (-not (Test-Path -LiteralPath $pidFile)) { return }
  $raw = (Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
  $processId = 0
  if ($raw -and [int]::TryParse($raw, [ref]$processId)) {
    if (-not (Stop-MatchingProcess $processId $executablePath $commandMarker)) {
      Write-Host "Skipped stale $label PID $processId (identity does not match)."
    }
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

function Stop-ByScan([string]$executablePath, [string]$commandMarker, [string]$label) {
  if (-not (Test-Path -LiteralPath $executablePath)) { return }
  $matches = @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $_.ProcessId -ne $PID -and
      $_.ExecutablePath -and
      $_.ExecutablePath -eq $executablePath -and
      $_.CommandLine -and
      $_.CommandLine -like "*$commandMarker*"
    }
  )
  foreach ($item in $matches) {
    if (Stop-MatchingProcess $item.ProcessId $executablePath $commandMarker) {
      Write-Host "Stopped remaining $label PID $($item.ProcessId)."
    }
  }
}

# Stop the tunnel before the server. Fall back to a process scan if the PID
# file is missing or stale, so a crashed server cannot leave the public tunnel
# pointing at a free 8788 port.
Stop-FromPidFile $tunnelPidFile $cloudflared $tunnelConfig 'cloudflared'
Stop-ByScan $cloudflared $tunnelConfig 'cloudflared'

Stop-FromPidFile $serverPidFile $node $serverMarker 'VeilLink server'
if ($node) {
  Stop-ByScan $node $serverMarker 'VeilLink server'
}

# Stop the lifecycle watchdog last; it is harmless once the server is gone.
Stop-FromPidFile $watchdogPidFile '' $watchdogMarker 'watchdog'
$watchdogs = @(
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -ne $PID -and
    $_.CommandLine -and
    $_.CommandLine -like "*$watchdogScript*" -and
    $_.CommandLine -like "*$watchdogMarker*"
  }
)
foreach ($item in $watchdogs) {
  Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue
  Write-Host "Stopped watchdog PID $($item.ProcessId)."
}

Start-Sleep -Milliseconds 500
$failed = $false
$tunnelRemaining = @(
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -ne $PID -and
    $_.ExecutablePath -and
    $_.ExecutablePath -eq $cloudflared -and
    $_.CommandLine -and
    $_.CommandLine -like "*$tunnelConfig*"
  }
)
if ($tunnelRemaining.Count -gt 0) {
  Write-Host "ERROR: cloudflared is still running for $tunnelConfig (PID $($tunnelRemaining.ProcessId -join ','))."
  $failed = $true
}
if ($node) {
  $serverRemaining = @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $_.ProcessId -ne $PID -and
      $_.ExecutablePath -and
      $_.ExecutablePath -eq $node -and
      $_.CommandLine -and
      $_.CommandLine -like "*$serverMarker*"
    }
  )
  if ($serverRemaining.Count -gt 0) {
    Write-Host "ERROR: VeilLink server is still running (PID $($serverRemaining.ProcessId -join ','))."
    $failed = $true
  }
}
$watchdogRemaining = @(
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -ne $PID -and
    $_.CommandLine -and
    $_.CommandLine -like "*$watchdogScript*" -and
    $_.CommandLine -like "*$watchdogMarker*"
  }
)
if ($watchdogRemaining.Count -gt 0) {
  Write-Host "ERROR: watchdog is still running (PID $($watchdogRemaining.ProcessId -join ','))."
  $failed = $true
}

$remaining = @(
  Get-NetTCPConnection -State Listen -LocalPort $adminPort, $publicPort -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq '127.0.0.1' }
)
if ($remaining.Count -gt 0) {
  foreach ($listener in $remaining) {
    Write-Host "WARNING: 127.0.0.1:$($listener.LocalPort) is still listening (PID $($listener.OwningProcess))."
  }
}
if ($failed) {
  Write-Host 'VeilLink stop incomplete.'
  exit 1
}
Write-Host 'VeilLink stopped.'
exit 0
