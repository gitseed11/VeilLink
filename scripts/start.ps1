param(
  [switch]$NoTunnel
)

$ErrorActionPreference = 'Stop'

function Test-CommandContains {
  param([string]$CommandLine, [string]$Marker)
  if (-not $CommandLine -or -not $Marker) { return $false }
  return $CommandLine.IndexOf($Marker, [StringComparison]::OrdinalIgnoreCase) -ge 0
}
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$dataDir = if ($env:VEILLINK_DATA_DIR) {
  [IO.Path]::GetFullPath($env:VEILLINK_DATA_DIR).TrimEnd('\')
} else {
  Join-Path $root 'data'
}
$driveRoot = [IO.Path]::GetPathRoot($dataDir).TrimEnd('\')
if ($dataDir.Equals($driveRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'VEILLINK_DATA_DIR must not be a drive root.'
}
if ($dataDir.Equals($root, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'VEILLINK_DATA_DIR must not be the install directory.'
}
if ($env:SystemRoot) {
  $windowsDir = [IO.Path]::GetFullPath($env:SystemRoot).TrimEnd('\')
  if ($dataDir.Equals($windowsDir, [StringComparison]::OrdinalIgnoreCase) -or
      $dataDir.StartsWith($windowsDir + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'VEILLINK_DATA_DIR must not be inside the Windows system directory.'
  }
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
  if ($dataDir.Equals($normalizedBroad, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'VEILLINK_DATA_DIR must be a dedicated directory, not a broad user/Program Files/AppData/ProgramData root.'
  }
}
$adminPort = if ($env:VEILLINK_ADMIN_PORT) { [int]$env:VEILLINK_ADMIN_PORT } else { 8787 }
$publicPort = if ($env:VEILLINK_PUBLIC_PORT) { [int]$env:VEILLINK_PUBLIC_PORT } else { 8788 }
$logsDir = Join-Path $dataDir 'logs'
$tunnelDir = Join-Path $dataDir 'tunnel'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$serverScript = Join-Path $root 'src\server.js'
$cloudflared = Join-Path $root 'bin\cloudflared.exe'
$watchdogScript = Join-Path $PSScriptRoot 'watchdog.ps1'
$serverPidFile = Join-Path $dataDir 'veillink.pid'
$tunnelPidFile = Join-Path $dataDir 'cloudflared.pid'
$watchdogPidFile = Join-Path $dataDir 'watchdog.pid'
$tunnelConfig = Join-Path $tunnelDir 'config.yml'
$serverMarker = "--veillink-data-dir=`"$dataDir`""
$tunnelMetricsPort = 20241
if ($env:VEILLINK_TUNNEL_METRICS_PORT) {
  $parsedMetricsPort = 0
  if (
    -not [int]::TryParse($env:VEILLINK_TUNNEL_METRICS_PORT, [ref]$parsedMetricsPort) -or
    $parsedMetricsPort -lt 1 -or
    $parsedMetricsPort -gt 65535
  ) {
    throw 'VEILLINK_TUNNEL_METRICS_PORT must be an integer between 1 and 65535.'
  }
  $tunnelMetricsPort = $parsedMetricsPort
}
$tunnelStateFile = Join-Path $dataDir 'tunnel-state.json'

$sha256 = [Security.Cryptography.SHA256]::Create()
try {
  $hashBytes = $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($dataDir.ToLowerInvariant()))
  $dataDirHash = ([BitConverter]::ToString($hashBytes)).Replace('-', '').Substring(0, 16)
} finally {
  $sha256.Dispose()
}
$startMutex = [Threading.Mutex]::new($false, "Local\VeilLink.Start.$dataDirHash")
$startMutexAcquired = $false
try {
  $startMutexAcquired = $startMutex.WaitOne(0)
} catch [Threading.AbandonedMutexException] {
  $startMutexAcquired = $true
}
if (-not $startMutexAcquired) {
  Write-Host 'Another VeilLink start is already in progress for this data directory.'
  exit 1
}

New-Item -ItemType Directory -Force -Path $dataDir, $logsDir, $tunnelDir | Out-Null

$env:VEILLINK_DATA_DIR = $dataDir
$aclScript = Join-Path $PSScriptRoot 'setup-acl.ps1'
& $aclScript
if ($LASTEXITCODE -ne 0) { throw 'Unable to restrict the VeilLink filesystem ACL.' }

function Get-ManagedProcess([string]$pidFile, [string]$commandMarker, [string]$executablePath = '') {
  if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
  $raw = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  if (-not $raw) { return $null }
  $pidValue = 0
  if (-not [int]::TryParse($raw, [ref]$pidValue)) { return $null }
  $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
  if (-not $process) { return $null }
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction SilentlyContinue
  if (-not $cim -or -not $cim.CommandLine -or (-not (Test-CommandContains $cim.CommandLine $commandMarker))) {
    return $null
  }
  if ($executablePath -and (-not $cim.ExecutablePath -or $cim.ExecutablePath -ne $executablePath)) {
    return $null
  }
  return $process
}

function Test-CommandArg([string]$commandLine, [string]$name, [string]$value) {
  if (-not $commandLine) { return $false }
  $pattern = '(?:^|\s)' + [regex]::Escape($name) + '\s+"?' + [regex]::Escape([string]$value) + '"?(\s|$)'
  return [bool]($commandLine -match $pattern)
}

function Get-ListenerOwners([int]$port) {
  return @(
    Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
      ForEach-Object { [int]$_.OwningProcess } |
      Sort-Object -Unique
  )
}

function Assert-ServerListeners([int]$serverPid) {
  foreach ($port in @($adminPort, $publicPort)) {
    $owners = Get-ListenerOwners $port
    if (-not $owners -or $owners.Count -eq 0) {
      throw "No listener is bound to port ${port}."
    }
    if (@($owners | Where-Object { $_ -ne $serverPid }).Count -gt 0) {
      throw "Port $port is not owned by the managed VeilLink server PID $serverPid."
    }
  }
}

function Assert-TunnelConfig([string]$configPath, [string]$expectedService) {
  $validator = Join-Path $PSScriptRoot 'tunnel-validate.ps1'
  $validationOutput = & $validator -ConfigPath $configPath -CloudflaredPath $cloudflared -ExpectedService $expectedService 2>&1
  $invoked = $?
  $exitCode = $LASTEXITCODE
  $text = ($validationOutput | Out-String)
  if (-not $invoked -or $exitCode -ne 0 -or $text -notmatch '(?m)^TUNNEL_VALIDATION_OK\s*$') {
    throw "Tunnel configuration or cloudflared binary failed validation. $($text.Trim())"
  }
}

function Rotate-LogFile([string]$path) {
  try {
    if (-not (Test-Path -LiteralPath $path)) { return }
    $item = Get-Item -LiteralPath $path
    if ($item.Length -le 0) { return }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Move-Item -LiteralPath $path -Destination "$path.$stamp" -Force
    $dir = Split-Path -Parent $path
    $leaf = Split-Path -Leaf $path
    Get-ChildItem -LiteralPath $dir -Filter "$leaf.*" -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -Skip 5 |
      Remove-Item -Force -ErrorAction SilentlyContinue
  } catch {
    # Log rotation must never prevent startup.
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
      metricsPort = $tunnelMetricsPort
    } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($tunnelStateFile, $stateJson, (New-Object System.Text.UTF8Encoding($false)))
  } catch {
    # The state file is advisory; the admin page also probes /ready directly.
  }
}

function Wait-TunnelReady([int]$timeoutSeconds = 30) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  do {
    try {
      $response = Invoke-RestMethod -Uri "http://127.0.0.1:$tunnelMetricsPort/ready" -TimeoutSec 2
      if ([int]$response.readyConnections -ge 1) { return $true }
    } catch {
      # cloudflared is still establishing edge connections.
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Stop-TunnelProcess {
  $process = Get-ManagedProcess $tunnelPidFile $tunnelConfig $cloudflared
  if ($process) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $process.Id -Timeout 5 -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $tunnelPidFile -Force -ErrorAction SilentlyContinue
}

function Stop-ManagedTunnel {
  Stop-TunnelProcess
  # The PID file can be missing or stale; scan for a cloudflared process that
  # uses this exact tunnel config so an unvalidated tunnel cannot keep running.
  $candidates = Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue
  foreach ($candidate in $candidates) {
    if (
      $candidate.ExecutablePath -eq $cloudflared -and
      $candidate.CommandLine -and
      (Test-CommandContains $candidate.CommandLine $tunnelConfig)
    ) {
      Stop-Process -Id $candidate.ProcessId -Force -ErrorAction SilentlyContinue
      Wait-Process -Id $candidate.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
    }
  }
  Remove-Item -LiteralPath $tunnelPidFile -Force -ErrorAction SilentlyContinue
}

function Stop-ManagedWatchdog {
  $existing = Get-ManagedProcess $watchdogPidFile $watchdogScript
  if ($existing) {
    Stop-Process -Id $existing.Id -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $existing.Id -Timeout 5 -ErrorAction SilentlyContinue
  }
  $candidates = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and
      (Test-CommandContains $_.CommandLine $watchdogScript) -and
      (Test-CommandArg $_.CommandLine '-DataDir' $dataDir)
    }
  foreach ($candidate in $candidates) {
    Stop-Process -Id $candidate.ProcessId -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $candidate.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $watchdogPidFile -Force -ErrorAction SilentlyContinue
}

function Start-VeilLinkWatchdog([int]$serverPid, [long]$serverStartTicks) {
  $existingWatchdog = Get-ManagedProcess $watchdogPidFile $watchdogScript
  if (-not $existingWatchdog) {
    $watchdogCandidate = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.CommandLine -and
        (Test-CommandContains $_.CommandLine $watchdogScript) -and
        (Test-CommandArg $_.CommandLine '-ServerPid' $serverPid) -and
        (Test-CommandArg $_.CommandLine '-ServerStartTicks' $serverStartTicks) -and
        (Test-CommandArg $_.CommandLine '-DataDir' $dataDir)
      } |
      Select-Object -First 1
    if ($watchdogCandidate) {
      $existingWatchdog = Get-Process -Id $watchdogCandidate.ProcessId -ErrorAction SilentlyContinue
      if ($existingWatchdog) {
        Set-Content -LiteralPath $watchdogPidFile -Value $existingWatchdog.Id -Encoding ascii
      }
    }
  }
  if ($existingWatchdog) {
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $($existingWatchdog.Id)" -ErrorAction SilentlyContinue
    if (
      $cim -and
      (Test-CommandArg $cim.CommandLine '-ServerPid' $serverPid) -and
      (Test-CommandArg $cim.CommandLine '-ServerStartTicks' $serverStartTicks) -and
      (Test-CommandArg $cim.CommandLine '-MetricsPort' $tunnelMetricsPort) -and
      (Test-CommandArg $cim.CommandLine '-PublicPort' $publicPort) -and
      (Test-CommandArg $cim.CommandLine '-DataDir' $dataDir)
    ) {
      return
    }
    Stop-Process -Id $existingWatchdog.Id -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $watchdogPidFile -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path -LiteralPath $watchdogScript)) {
    throw "Watchdog script is missing: $watchdogScript"
  }
  $pwshPath = (Get-Process -Id $PID).Path
  $watchdogArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watchdogScript`" -ServerPid $serverPid -ServerStartTicks $serverStartTicks -DataDir `"$dataDir`" -MetricsPort $tunnelMetricsPort -PublicPort $publicPort"
  $watchdogOut = Join-Path $logsDir 'watchdog.out.log'
  $watchdogErr = Join-Path $logsDir 'watchdog.err.log'
  Rotate-LogFile $watchdogOut
  Rotate-LogFile $watchdogErr
  $watchdogProcess = Start-Process -FilePath $pwshPath `
    -ArgumentList $watchdogArgs `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $watchdogOut `
    -RedirectStandardError $watchdogErr `
    -PassThru
  Start-Sleep -Milliseconds 500
  if ($watchdogProcess.HasExited) {
    Remove-Item -LiteralPath $watchdogPidFile -Force -ErrorAction SilentlyContinue
    throw 'Watchdog exited immediately after start.'
  }
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $($watchdogProcess.Id)" -ErrorAction SilentlyContinue
  if (-not $cim -or -not $cim.CommandLine -or
      -not (Test-CommandArg $cim.CommandLine '-ServerPid' $serverPid) -or
      -not (Test-CommandArg $cim.CommandLine '-ServerStartTicks' $serverStartTicks) -or
      -not (Test-CommandArg $cim.CommandLine '-MetricsPort' $tunnelMetricsPort) -or
      -not (Test-CommandArg $cim.CommandLine '-PublicPort' $publicPort) -or
      -not (Test-CommandArg $cim.CommandLine '-DataDir' $dataDir)) {
    Stop-Process -Id $watchdogProcess.Id -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $watchdogPidFile -Force -ErrorAction SilentlyContinue
    throw 'Watchdog process identity does not match the current server/data directory.'
  }
  Set-Content -LiteralPath $watchdogPidFile -Value $watchdogProcess.Id -Encoding ascii
}

$serverOut = Join-Path $logsDir 'server.out.log'
$serverErr = Join-Path $logsDir 'server.err.log'
$serverProcess = $null
$existingServer = Get-ManagedProcess $serverPidFile $serverMarker $node
if (-not $existingServer) {
  # The PID file may be missing or point at a reused PID. Find the managed
  # server by its data-directory marker before starting a duplicate.
  $serverCandidate = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ExecutablePath -eq $node -and
      $_.CommandLine -and
      (Test-CommandContains $_.CommandLine $serverMarker)
    } |
    Select-Object -First 1
  if ($serverCandidate) {
    $existingServer = Get-Process -Id $serverCandidate.ProcessId -ErrorAction SilentlyContinue
    if ($existingServer) {
      Set-Content -LiteralPath $serverPidFile -Value $existingServer.Id -Encoding ascii
    }
  }
}
if ($existingServer) {
  $serverPid = $existingServer.Id
  try {
    $serverStartTicks = $existingServer.StartTime.ToUniversalTime().Ticks
  } catch {
    $serverStartTicks = 0
  }
  $healthy = $false
  for ($i = 0; $i -lt 20; $i++) {
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$adminPort/" -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -eq 200) { $healthy = $true; break }
    } catch {
      # The managed server may still be finishing startup.
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $healthy) {
    Write-Host "VeilLink server PID $serverPid is listening but its admin endpoint is not healthy."
    exit 1
  }
  Write-Host "VeilLink server is already running (PID $serverPid); reusing it."
} else {
  foreach ($port in @($adminPort, $publicPort)) {
    $portOwners = @(Get-ListenerOwners $port)
    if ($portOwners.Count -gt 0) {
      Write-Host "ERROR: Port $port is already in use by PID $($portOwners -join ', '); refusing to start."
      exit 1
    }
  }
  Remove-Item -LiteralPath $serverPidFile -Force -ErrorAction SilentlyContinue
  Rotate-LogFile $serverOut
  Rotate-LogFile $serverErr
  $serverProcess = Start-Process -FilePath $node `
    -ArgumentList "`"$serverScript`" --veillink-data-dir=`"$dataDir`"" `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $serverOut `
    -RedirectStandardError $serverErr `
    -PassThru
  $serverPid = $serverProcess.Id
  try {
    $serverStartTicks = $serverProcess.StartTime.ToUniversalTime().Ticks
  } catch {
    $serverStartTicks = 0
  }
  Set-Content -LiteralPath $serverPidFile -Value $serverPid -Encoding ascii

  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$adminPort/" -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -eq 200) {
        try {
          Assert-ServerListeners $serverPid
          $ready = $true
          break
        } catch {
          # A foreign process may be answering on the admin port; keep waiting
          # for the child we launched to own both listeners or exit.
        }
      }
    } catch {
      if ($serverProcess.HasExited) { break }
    }
  }
  if ($serverProcess.HasExited) {
    # A listener that answered may belong to another process; never report a
    # successful start when the child we launched has already exited.
    $ready = $false
  }
  if (-not $ready) {
    Write-Host 'VeilLink failed to start.'
    if (Test-Path -LiteralPath $serverErr) { Get-Content -LiteralPath $serverErr -Tail 30 }
    try {
      if (-not $serverProcess.HasExited) {
        Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
      }
    } finally {
      Remove-Item -LiteralPath $serverPidFile -Force -ErrorAction SilentlyContinue
    }
    exit 1
  }
}

try {
  Assert-ServerListeners $serverPid
} catch {
  Write-Host $_.Exception.Message
  if ($serverProcess -and -not $serverProcess.HasExited) {
    Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
  }
  if ($serverProcess) {
    Remove-Item -LiteralPath $serverPidFile -Force -ErrorAction SilentlyContinue
  }
  exit 1
}

$tunnelStarted = $false
$tunnelActive = $false
$tunnelBlocked = ''
$tunnelValidationFailed = $false
$tunnelProcess = $null
$tunnelOut = Join-Path $logsDir 'cloudflared.out.log'
$tunnelErr = Join-Path $logsDir 'cloudflared.err.log'
if (-not $NoTunnel -and (Test-Path -LiteralPath $cloudflared) -and (Test-Path -LiteralPath $tunnelConfig)) {
  $expectedService = "http://127.0.0.1:$publicPort"
  try {
    Assert-TunnelConfig $tunnelConfig $expectedService
  } catch {
    $tunnelBlocked = $_.Exception.Message
    $tunnelValidationFailed = $true
  }
  if (-not $tunnelBlocked) {
    $existingTunnel = Get-ManagedProcess $tunnelPidFile $tunnelConfig $cloudflared
    if (-not $existingTunnel) {
      $tunnelCandidate = Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
          $_.ExecutablePath -eq $cloudflared -and
          $_.CommandLine -and
          (Test-CommandContains $_.CommandLine $tunnelConfig)
        } |
        Select-Object -First 1
      if ($tunnelCandidate) {
        $existingTunnel = Get-Process -Id $tunnelCandidate.ProcessId -ErrorAction SilentlyContinue
        if ($existingTunnel) {
          Set-Content -LiteralPath $tunnelPidFile -Value $existingTunnel.Id -Encoding ascii
        }
      }
    }
    if ($existingTunnel) {
      if (Wait-TunnelReady 5) {
        $tunnelActive = $true
        $tunnelProcess = $existingTunnel
        Write-TunnelState $true '' $existingTunnel.Id
        Write-Host "Cloudflare tunnel is already ready (PID $($existingTunnel.Id)); reusing it."
      } else {
        Stop-Process -Id $existingTunnel.Id -Force -ErrorAction SilentlyContinue
        Wait-Process -Id $existingTunnel.Id -Timeout 5 -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $tunnelPidFile -Force -ErrorAction SilentlyContinue
        Write-Host "Existing cloudflared PID $($existingTunnel.Id) was not ready; restarting it."
      }
    }
    if (-not $tunnelActive) {
      Remove-Item -LiteralPath $tunnelPidFile -Force -ErrorAction SilentlyContinue
      Rotate-LogFile $tunnelOut
      Rotate-LogFile $tunnelErr
      $tunnelArgs = "tunnel --config `"$tunnelConfig`" --no-autoupdate --protocol http2 --metrics 127.0.0.1:$tunnelMetricsPort --loglevel info run"
      $tunnelProcess = Start-Process -FilePath $cloudflared `
        -ArgumentList $tunnelArgs `
        -WorkingDirectory $root `
        -WindowStyle Hidden `
        -RedirectStandardOutput $tunnelOut `
        -RedirectStandardError $tunnelErr `
        -PassThru
      Set-Content -LiteralPath $tunnelPidFile -Value $tunnelProcess.Id -Encoding ascii
      $ready = Wait-TunnelReady 30
      if ($tunnelProcess.HasExited -or -not $ready) {
        $reason = if ($tunnelProcess.HasExited) {
          "cloudflared exited with code $($tunnelProcess.ExitCode)"
        } else {
          'cloudflared did not become ready within 30 seconds'
        }
        if (-not $tunnelProcess.HasExited) {
          Stop-Process -Id $tunnelProcess.Id -Force -ErrorAction SilentlyContinue
          Wait-Process -Id $tunnelProcess.Id -Timeout 5 -ErrorAction SilentlyContinue
        }
        Remove-Item -LiteralPath $tunnelPidFile -Force -ErrorAction SilentlyContinue
        $tunnelBlocked = "$reason; see $tunnelErr"
        Write-TunnelState $false $tunnelBlocked $tunnelProcess.Id 'error'
      } else {
        $tunnelStarted = $true
        $tunnelActive = $true
        Write-TunnelState $true '' $tunnelProcess.Id
      }
    }
  }
  if ($tunnelBlocked -and $tunnelValidationFailed) {
    Stop-ManagedWatchdog
    Stop-ManagedTunnel
    Write-TunnelState $false $tunnelBlocked 0 'error'
    Write-Host 'Stopped the managed tunnel because its configuration or binary failed validation.'
  }
} else {
  # -NoTunnel or a missing tunnel config/executable must not leave a
  # previously managed tunnel or watchdog running behind a "disabled" state.
  Stop-ManagedWatchdog
  Stop-ManagedTunnel
  Start-Sleep -Milliseconds 300
  $remainingTunnel = @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $_.ProcessId -ne $PID -and
      $_.ExecutablePath -and
      $_.ExecutablePath.Equals($cloudflared, [StringComparison]::OrdinalIgnoreCase) -and
      $_.CommandLine -and
      (Test-CommandContains $_.CommandLine $tunnelConfig)
    }
  )
  $remainingWatchdog = @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $_.ProcessId -ne $PID -and
      $_.CommandLine -and
      (Test-CommandContains $_.CommandLine $watchdogScript) -and
      (Test-CommandArg $_.CommandLine '-DataDir' $dataDir)
    }
  )
  if ($remainingWatchdog.Count -gt 0 -or $remainingTunnel.Count -gt 0) {
    $parts = @()
    if ($remainingWatchdog.Count -gt 0) {
      $parts += "watchdog PID $($remainingWatchdog.ProcessId -join ',')"
    }
    if ($remainingTunnel.Count -gt 0) {
      $parts += "cloudflared PID $($remainingTunnel.ProcessId -join ',')"
    }
    $tunnelBlocked = "Tunnel cleanup is incomplete ($($parts -join '; '))."
    Write-TunnelState $false $tunnelBlocked 0 'error'
  } elseif ($NoTunnel) {
    Write-TunnelState $false '' 0 'disabled'
  } else {
    Remove-Item -LiteralPath $tunnelStateFile -Force -ErrorAction SilentlyContinue
  }
}

if ($tunnelActive) {
  try {
    Start-VeilLinkWatchdog $serverPid $serverStartTicks
    Write-Host "Tunnel watchdog is running (server PID $serverPid)."
  } catch {
    Write-Host "WARNING: Unable to start the tunnel watchdog: $($_.Exception.Message)"
    Stop-TunnelProcess
    $tunnelActive = $false
    $tunnelStarted = $false
    $tunnelBlocked = 'Tunnel stopped because its lifecycle watchdog could not start.'
    Write-TunnelState $false $tunnelBlocked 0 'error'
  }
}

Write-Host 'VeilLink is running.'
Write-Host "  Admin (local only): http://127.0.0.1:$adminPort"
Write-Host "  Admin token file:   $(Join-Path $dataDir 'ADMIN_TOKEN.txt')"
Write-Host "  Server log:         $serverOut"
Write-Host "  Public origin:      127.0.0.1:$publicPort (Cloudflare tunnel only)"
if ($tunnelStarted) {
  Write-Host '  Named Cloudflare tunnel started.'
  Write-Host "  Tunnel log:         $(Join-Path $logsDir 'cloudflared.out.log')"
} elseif ($tunnelActive) {
  Write-Host '  Named Cloudflare tunnel reused.'
} elseif ($tunnelBlocked) {
  Write-Host "  WARNING: $tunnelBlocked"
} elseif (-not $NoTunnel) {
  Write-Host '  Named tunnel not started (config.yml missing or cloudflared absent).'
}
Write-Host '  Stop from the VeilLink tray menu, or run scripts\stop.ps1.'
if ($tunnelBlocked) {
  Write-Host "ERROR: $tunnelBlocked"
  exit 1
}
