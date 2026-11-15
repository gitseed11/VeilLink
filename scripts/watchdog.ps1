param(
  [Parameter(Mandatory = $true)]
  [int]$ServerPid,
  [long]$ServerStartTicks = 0,
  [string]$DataDir = ''
)

$ErrorActionPreference = 'SilentlyContinue'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$dataDir = if ($DataDir) {
  [IO.Path]::GetFullPath($DataDir).TrimEnd('\')
} elseif ($env:VEILLINK_DATA_DIR) {
  [IO.Path]::GetFullPath($env:VEILLINK_DATA_DIR).TrimEnd('\')
} else {
  Join-Path $root 'data'
}
$logsDir = Join-Path $dataDir 'logs'
$logFile = Join-Path $logsDir 'watchdog.log'
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

function Write-WatchdogLog([string]$message) {
  try {
    Add-Content -LiteralPath $logFile -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message" -Encoding utf8
  } catch {
    # Logging must never keep the watchdog alive.
  }
}

function Remove-OwnPidFile {
  $pidFile = Join-Path $dataDir 'watchdog.pid'
  $raw = Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue
  if ($raw -and $raw.Trim() -eq [string]$PID) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  }
}

Write-WatchdogLog "Watchdog started for server PID $ServerPid."
$server = Get-Process -Id $ServerPid -ErrorAction SilentlyContinue
if ($server) {
  if ($ServerStartTicks -gt 0) {
    try {
      $actualTicks = $server.StartTime.ToUniversalTime().Ticks
      if ($actualTicks -ne $ServerStartTicks) {
        Write-WatchdogLog 'Server PID was reused; watchdog exits without stopping the tunnel.'
        Remove-OwnPidFile
        exit 0
      }
    } catch {
      # If start time is unavailable, fall back to the PID wait below.
    }
  }
  $server.WaitForExit()
}

Write-WatchdogLog "Server PID $ServerPid exited; stopping the cloudflared tunnel."
$cloudflared = Join-Path $root 'bin\cloudflared.exe'
$tunnelConfig = Join-Path $dataDir 'tunnel\config.yml'
$matches = @(
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -ne $PID -and
    $_.ExecutablePath -and
    $_.ExecutablePath.Equals($cloudflared, [StringComparison]::OrdinalIgnoreCase) -and
    $_.CommandLine -and
    $_.CommandLine -like "*$tunnelConfig*"
  }
)
foreach ($item in $matches) {
  Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue
  Write-WatchdogLog "Stopped cloudflared PID $($item.ProcessId)."
}
Start-Sleep -Milliseconds 300
$remaining = @(
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -ne $PID -and
    $_.ExecutablePath -and
    $_.ExecutablePath.Equals($cloudflared, [StringComparison]::OrdinalIgnoreCase) -and
    $_.CommandLine -and
    $_.CommandLine -like "*$tunnelConfig*"
  }
)
if ($remaining.Count -gt 0) {
  Write-WatchdogLog "WARNING: cloudflared is still running after stop: $($remaining.ProcessId -join ',')"
}
Remove-Item -LiteralPath (Join-Path $dataDir 'cloudflared.pid') -Force -ErrorAction SilentlyContinue
Remove-OwnPidFile
Write-WatchdogLog 'Watchdog exiting.'
exit 0
