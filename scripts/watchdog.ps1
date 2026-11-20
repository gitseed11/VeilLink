param(
  [Parameter(Mandatory = $true)]
  [int]$ServerPid,
  [long]$ServerStartTicks = 0,
  [string]$DataDir = '',
  [ValidateRange(1, 65535)]
  [int]$MetricsPort = 20241,
  [ValidateRange(1, 65535)]
  [int]$PublicPort = 8788
)

$ErrorActionPreference = 'SilentlyContinue'

function Test-CommandContains {
  param([string]$CommandLine, [string]$Marker)
  if (-not $CommandLine -or -not $Marker) { return $false }
  return $CommandLine.IndexOf($Marker, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

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
$tunnelPidFile = Join-Path $dataDir 'cloudflared.pid'
$tunnelStateFile = Join-Path $dataDir 'tunnel-state.json'
$tunnelConfig = Join-Path $dataDir 'tunnel\config.yml'
$cloudflared = Join-Path $root 'bin\cloudflared.exe'
$tunnelOut = Join-Path $logsDir 'cloudflared.out.log'
$tunnelErr = Join-Path $logsDir 'cloudflared.err.log'
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

function Write-WatchdogLog([string]$message) {
  try {
    if (Test-Path -LiteralPath $logFile) {
      $item = Get-Item -LiteralPath $logFile
      if ($item.Length -gt 5MB) {
        Move-Item -LiteralPath $logFile -Destination "$logFile.$(Get-Date -Format 'yyyyMMdd-HHmmss')" -Force
        Get-ChildItem -LiteralPath $logsDir -Filter 'watchdog.log.*' -File -ErrorAction SilentlyContinue |
          Sort-Object LastWriteTime -Descending |
          Select-Object -Skip 5 |
          Remove-Item -Force -ErrorAction SilentlyContinue
      }
    }
    Add-Content -LiteralPath $logFile -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message" -Encoding utf8
  } catch {
    # Logging must never keep the watchdog alive.
  }
}

function Write-TunnelState([bool]$ready, [string]$errorMessage = '', [int]$processId = 0, [string]$mode = 'running') {
  try {
    $stateJson = [ordered]@{
      updatedAt = (Get-Date).ToUniversalTime().ToString('o')
      mode = $mode
      enabled = ($mode -ne 'disabled')
      ready = $ready
      processPid = $processId
      error = $errorMessage
      metricsPort = $MetricsPort
    } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($tunnelStateFile, $stateJson, (New-Object System.Text.UTF8Encoding($false)))
  } catch {
    # The state file is advisory.
  }
}

function Rotate-LogFile([string]$path) {
  try {
    if (-not (Test-Path -LiteralPath $path)) { return }
    $item = Get-Item -LiteralPath $path
    if ($item.Length -le 0) { return }
    Move-Item -LiteralPath $path -Destination "$path.$(Get-Date -Format 'yyyyMMdd-HHmmss')" -Force
    $dir = Split-Path -Parent $path
    $leaf = Split-Path -Leaf $path
    Get-ChildItem -LiteralPath $dir -Filter "$leaf.*" -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -Skip 5 |
      Remove-Item -Force -ErrorAction SilentlyContinue
  } catch {
    # Rotation must not stop the watchdog.
  }
}

function Get-TunnelProcess {
  $processId = 0
  if (Test-Path -LiteralPath $tunnelPidFile) {
    $raw = (Get-Content -LiteralPath $tunnelPidFile -Raw -ErrorAction SilentlyContinue).Trim()
    if ($raw) { [void][int]::TryParse($raw, [ref]$processId) }
  }
  if ($processId -gt 0) {
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($process) {
      $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
      if ($cim -and $cim.ExecutablePath -eq $cloudflared -and (Test-CommandContains $cim.CommandLine $tunnelConfig)) {
        return $process
      }
    }
  }
  $candidate = Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ExecutablePath -eq $cloudflared -and
      $_.CommandLine -and
      (Test-CommandContains $_.CommandLine $tunnelConfig)
    } |
    Select-Object -First 1
  if ($candidate) {
    try { Set-Content -LiteralPath $tunnelPidFile -Value $candidate.ProcessId -Encoding ascii } catch {}
    return Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue
  }
  return $null
}

function Test-TunnelReady {
  try {
    $response = Invoke-RestMethod -Uri "http://127.0.0.1:$MetricsPort/ready" -TimeoutSec 2
    return ([int]$response.readyConnections -ge 1)
  } catch {
    return $false
  }
}

function Test-TunnelConfig {
  $validator = Join-Path $PSScriptRoot 'tunnel-validate.ps1'
  if (-not (Test-Path -LiteralPath $validator)) {
    return "Tunnel validator is missing: $validator"
  }
  $output = & $validator `
    -ConfigPath $tunnelConfig `
    -CloudflaredPath $cloudflared `
    -ExpectedService "http://127.0.0.1:$PublicPort" 2>&1
  $invoked = $?
  $exitCode = $LASTEXITCODE
  $text = ($output | Out-String)
  if (-not $invoked -or $exitCode -ne 0 -or $text -notmatch '(?m)^TUNNEL_VALIDATION_OK\s*$') {
    if (-not $text.Trim()) {
      return 'Tunnel validator could not be executed or returned no result.'
    }
    return $text.Trim()
  }
  return ''
}

function Start-Tunnel {
  $script:lastTunnelStartError = ''
  $validationError = Test-TunnelConfig
  if ($validationError) {
    $script:lastTunnelStartError = "Tunnel validation failed: $validationError"
    Write-WatchdogLog "Refusing to restart cloudflared: $validationError"
    return $null
  }

  if (-not (Test-Path -LiteralPath $cloudflared) -or -not (Test-Path -LiteralPath $tunnelConfig)) {
    $script:lastTunnelStartError = 'cloudflared executable or tunnel config is missing.'
    Write-WatchdogLog 'Cannot restart cloudflared: executable or tunnel config is missing.'
    return $null
  }
  Rotate-LogFile $tunnelOut
  Rotate-LogFile $tunnelErr
  $arguments = "tunnel --config `"$tunnelConfig`" --no-autoupdate --protocol http2 --metrics 127.0.0.1:$MetricsPort --loglevel info run"
  $process = Start-Process -FilePath $cloudflared `
    -ArgumentList $arguments `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $tunnelOut `
    -RedirectStandardError $tunnelErr `
    -PassThru
  if (-not $process) {
    $script:lastTunnelStartError = 'cloudflared could not be started.'
    return $null
  }
  Set-Content -LiteralPath $tunnelPidFile -Value $process.Id -Encoding ascii
  $deadline = (Get-Date).AddSeconds(30)
  do {
    if (-not (Get-Process -Id $ServerPid -ErrorAction SilentlyContinue)) {
      $script:lastTunnelStartError = 'Server exited while cloudflared was restarting.'
      Write-WatchdogLog 'Server exited while cloudflared was restarting; stopping the new process.'
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      Wait-Process -Id $process.Id -Timeout 5 -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $tunnelPidFile -Force -ErrorAction SilentlyContinue
      return $null
    }
    if ($process.HasExited) {
      $script:lastTunnelStartError = "cloudflared exited during restart with code $($process.ExitCode)."
      Write-WatchdogLog "cloudflared exited during restart with code $($process.ExitCode)."
      Remove-Item -LiteralPath $tunnelPidFile -Force -ErrorAction SilentlyContinue
      return $null
    }
    if (Test-TunnelReady) { return $process }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  $script:lastTunnelStartError = 'cloudflared did not become ready within 30 seconds after restart.'
  Write-WatchdogLog 'cloudflared did not become ready within 30 seconds after restart.'
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  Wait-Process -Id $process.Id -Timeout 5 -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $tunnelPidFile -Force -ErrorAction SilentlyContinue
  return $null
}

function Remove-OwnPidFile {
  $pidFile = Join-Path $dataDir 'watchdog.pid'
  $raw = Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue
  if ($raw -and $raw.Trim() -eq [string]$PID) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  }
}

function Stop-ManagedTunnelProcesses {
  $matches = @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $_.ProcessId -ne $PID -and
      $_.ExecutablePath -and
      $_.ExecutablePath.Equals($cloudflared, [StringComparison]::OrdinalIgnoreCase) -and
      $_.CommandLine -and
      (Test-CommandContains $_.CommandLine $tunnelConfig)
    }
  )
  foreach ($item in $matches) {
    Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $item.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
    Write-WatchdogLog "Stopped cloudflared PID $($item.ProcessId)."
  }
  Remove-Item -LiteralPath $tunnelPidFile -Force -ErrorAction SilentlyContinue
}

Write-WatchdogLog "Watchdog started for server PID $ServerPid (metrics port $MetricsPort)."
$server = Get-Process -Id $ServerPid -ErrorAction SilentlyContinue
if (-not $server) {
  Write-WatchdogLog 'Server process is not running; stopping the tunnel and exiting.'
  Write-TunnelState $false 'Server process is not running.' 0 'error'
  Stop-ManagedTunnelProcesses
  Remove-OwnPidFile
  exit 0
}
if ($ServerStartTicks -gt 0) {
  try {
    $actualTicks = $server.StartTime.ToUniversalTime().Ticks
    if ($actualTicks -ne $ServerStartTicks) {
      Write-WatchdogLog 'Server PID was reused; stopping the tunnel and exiting.'
      Write-TunnelState $false 'Server PID was reused.' 0 'error'
      Stop-ManagedTunnelProcesses
      Remove-OwnPidFile
      exit 0
    }
  } catch {
    # If start time is unavailable, fall back to the process liveness loop.
  }
}

$failureCount = 0
$restartCount = 0
$validatedTunnelPid = 0
$validatedTunnelStartTicks = 0
$persistentTunnelError = ''
if (Test-Path -LiteralPath $tunnelStateFile) {
  try {
    $existingState = Get-Content -LiteralPath $tunnelStateFile -Raw | ConvertFrom-Json
    if ($existingState.mode -eq 'error' -and $existingState.error) {
      $persistentTunnelError = [string]$existingState.error
    }
  } catch {
    # A malformed state file is treated as no saved error.
  }
}
while ($true) {
  $server = Get-Process -Id $ServerPid -ErrorAction SilentlyContinue
  if (-not $server) { break }
  if ($ServerStartTicks -gt 0) {
    try {
      if ($server.StartTime.ToUniversalTime().Ticks -ne $ServerStartTicks) {
        Write-WatchdogLog 'Server PID was reused; treating the server as exited.'
        break
      }
    } catch {
      # If the start time is unavailable, keep the liveness check only.
    }
  }

  $tunnel = Get-TunnelProcess
  if (-not $tunnel) {
    $validatedTunnelPid = 0
    $validatedTunnelStartTicks = 0
  } else {
    $tunnelStartTicks = 0
    try {
      $tunnelStartTicks = $tunnel.StartTime.ToUniversalTime().Ticks
    } catch {
      $tunnelStartTicks = 0
    }
    if (
      $tunnel.Id -ne $validatedTunnelPid -or
      ($tunnelStartTicks -ne 0 -and $tunnelStartTicks -ne $validatedTunnelStartTicks)
    ) {
      $validationError = Test-TunnelConfig
      if ($validationError) {
        Write-WatchdogLog "Tunnel process $($tunnel.Id) failed validation: $validationError"
        Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
        Wait-Process -Id $tunnel.Id -Timeout 5 -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $tunnelPidFile -Force -ErrorAction SilentlyContinue
        $persistentTunnelError = $validationError
        Write-TunnelState $false $persistentTunnelError 0 'error'
        $tunnel = $null
        $validatedTunnelPid = 0
        $validatedTunnelStartTicks = 0
      } else {
        $validatedTunnelPid = $tunnel.Id
        $validatedTunnelStartTicks = $tunnelStartTicks
      }
    }
  }
  $ready = $false
  if ($tunnel) { $ready = Test-TunnelReady }

  if ($tunnel -and $ready) {
    if ($failureCount -gt 0 -or $persistentTunnelError) {
      Write-WatchdogLog 'Tunnel recovered.'
    }
    $persistentTunnelError = ''
    Write-TunnelState $true '' $tunnel.Id
    $validatedTunnelPid = $tunnel.Id
    try { $validatedTunnelStartTicks = $tunnel.StartTime.ToUniversalTime().Ticks } catch {}
    $failureCount = 0
    $restartCount = 0
    Start-Sleep -Seconds 5
    continue
  }

  $failureCount += 1
  $reason = if (-not $tunnel) { 'cloudflared is not running' } else { 'cloudflared has no ready edge connections' }
  Write-WatchdogLog "Tunnel health check failed ($failureCount): $reason."
  if ($persistentTunnelError) {
    Write-TunnelState $false $persistentTunnelError $(if ($tunnel) { $tunnel.Id } else { 0 }) 'error'
  } else {
    Write-TunnelState $false $reason $(if ($tunnel) { $tunnel.Id } else { 0 })
  }

  if ($failureCount -ge 3) {
    if ($tunnel) {
      Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
      Wait-Process -Id $tunnel.Id -Timeout 5 -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $tunnelPidFile -Force -ErrorAction SilentlyContinue
      $validatedTunnelPid = 0
      $validatedTunnelStartTicks = 0
    }
    $restartCount += 1
    if ($restartCount -le 5) {
      Write-WatchdogLog "Restarting cloudflared (attempt $restartCount)."
      $restarted = Start-Tunnel
      if ($restarted) {
        Write-WatchdogLog "cloudflared restarted (PID $($restarted.Id))."
        $persistentTunnelError = ''
        Write-TunnelState $true '' $restarted.Id
        $validatedTunnelPid = $restarted.Id
        try { $validatedTunnelStartTicks = $restarted.StartTime.ToUniversalTime().Ticks } catch {}
        $failureCount = 0
        $restartCount = 0
      } else {
        $persistentTunnelError = if ($script:lastTunnelStartError) {
          $script:lastTunnelStartError
        } else {
          'cloudflared restart failed.'
        }
        Write-WatchdogLog "cloudflared restart failed: $persistentTunnelError"
        Write-TunnelState $false $persistentTunnelError 0 'error'
        $failureCount = 0
      }
    } else {
      Write-WatchdogLog 'cloudflared restart limit reached; continuing health checks only.'
    }
    Start-Sleep -Seconds ([Math]::Min(10, 5 * $restartCount))
  } else {
    Start-Sleep -Seconds 5
  }
}

Write-WatchdogLog "Server PID $ServerPid exited; stopping the cloudflared tunnel."
Stop-ManagedTunnelProcesses
$remaining = @(
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -ne $PID -and
    $_.ExecutablePath -and
    $_.ExecutablePath.Equals($cloudflared, [StringComparison]::OrdinalIgnoreCase) -and
    $_.CommandLine -and
    (Test-CommandContains $_.CommandLine $tunnelConfig)
  }
)
if ($remaining.Count -gt 0) {
  Write-WatchdogLog "WARNING: cloudflared is still running after stop: $($remaining.ProcessId -join ',')"
}
Write-TunnelState $false 'Server stopped.' 0 'error'
Remove-OwnPidFile
Write-WatchdogLog 'Watchdog exiting.'
exit 0
