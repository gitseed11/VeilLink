param(
  [switch]$NoTunnel
)

$ErrorActionPreference = 'Stop'
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
$watchdogMarker = "-DataDir `"$dataDir`""
$expectedCloudflaredHash = 'D5C1D82031DA6253DCDCFF64C944CD0FE063016EDEB2E4FD088075FC9BD52D0A'

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
  if (-not $cim -or -not $cim.CommandLine -or $cim.CommandLine -notlike "*$commandMarker*") {
    return $null
  }
  if ($executablePath -and (-not $cim.ExecutablePath -or $cim.ExecutablePath -ne $executablePath)) {
    return $null
  }
  return $process
}

function Get-ListenerOwners([int]$port) {
  return @(
    Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
      ForEach-Object { [int]$_.OwningProcess }
  )
}

function Assert-ServerListeners([int]$serverPid) {
  foreach ($port in @($adminPort, $publicPort)) {
    $owners = Get-ListenerOwners $port
    if (-not $owners -or $owners.Count -eq 0) {
      throw "No listener is bound to 127.0.0.1:${port}."
    }
    if (@($owners | Where-Object { $_ -ne $serverPid }).Count -gt 0) {
      throw "127.0.0.1:$port is not owned by the managed VeilLink server PID $serverPid."
    }
  }
}

function Assert-TunnelConfig([string]$configPath, [string]$expectedService) {
  $configText = Get-Content -LiteralPath $configPath -Raw
  if ($configText -match '[\\{}\[\]&*!?]') {
    throw 'Tunnel config must use canonical block-style YAML with forward slashes; flow mappings, anchors, aliases, tags, explicit keys, and escape sequences are not allowed.'
  }
  if ($configText -match '(?m)^\s*(?:-\s*)?<<\s*:') {
    throw 'Tunnel config must not contain YAML merge keys.'
  }
  if ($configText -match '(?m)^\s*(?:---|\.\.\.)\s*$') {
    throw 'Tunnel config must contain exactly one YAML document.'
  }
  if ($configText -match '(?im)^\s*["'']?loglevel["'']?\s*:\s*["'']?(debug|trace)["'']?\s*(?:#.*)?$') {
    throw 'Tunnel config uses debug/trace logging; refusing to start.'
  }
  if ($configText -match '(?im)^\s*(?:-\s*)?["'']?(originRequest|httpHostHeader|metrics|warp-routing)["'']?\s*:') {
    throw 'Tunnel config contains originRequest/httpHostHeader/metrics/warp-routing; refusing to start.'
  }
  # The generated config uses unquoted mapping keys. Quoted keys and path
  # rules are rejected so a rule cannot hide an admin/other-service ingress.
  if ($configText -match '(?im)^\s*(?:-\s*)?["''][^"'']*["'']\s*:') {
    throw 'Tunnel config must not use quoted mapping keys.'
  }
  if ($configText -match '(?im)^\s*(?:-\s*)?["'']?path["'']?\s*:') {
    throw 'Tunnel config must not contain path-based ingress rules.'
  }
  if (([regex]::Matches($configText, '(?im)^\s*["'']?ingress["'']?\s*:')).Count -ne 1) {
    throw 'Tunnel config must contain exactly one ingress section.'
  }
  $hosts = @(
    [regex]::Matches($configText, '(?im)^\s*-\s*["'']?hostname["'']?\s*:\s*["'']?([^"''\s#]+)["'']?') |
      ForEach-Object { $_.Groups[1].Value.Trim('"', "'") }
  )
  if ($hosts.Count -ne 1) {
    throw 'Tunnel config must contain exactly one hostname ingress rule.'
  }
  $hostname = $hosts[0]
  if ($hostname -match '[*]' -or $hostname -notmatch '^[A-Za-z0-9.-]+$') {
    throw "Tunnel hostname is not a concrete DNS name: $hostname"
  }
  $services = @(
    [regex]::Matches($configText, '(?im)^\s*(?:-\s*)?["'']?service["'']?\s*:\s*["'']?([^"''\s#]+)["'']?') |
      ForEach-Object { $_.Groups[1].Value.Trim('"', "'") }
  )
  if ($services.Count -ne 2 -or $services -notcontains $expectedService -or $services -notcontains 'http_status:404') {
    throw "Tunnel config must route the hostname to $expectedService with a single http_status:404 catch-all."
  }

  # Final gate: accept only the canonical shape emitted by tunnel-setup.ps1.
  # This rejects YAML features that are valid to cloudflared but can hide
  # additional ingress rules from the checks above.
  $canonicalPattern = "(?s)^\s*tunnel\s*:\s*[^\r\n]+\r?\n\s*credentials-file\s*:\s*'[^'\r\n]+'\r?\n\s*ingress\s*:\s*\r?\n\s*-\s*hostname\s*:\s*'?([A-Za-z0-9.-]+)'?\r?\n\s*service\s*:\s*" +
    [regex]::Escape($expectedService) +
    "\r?\n\s*-\s*service\s*:\s*http_status:404\s*$"
  if (-not [regex]::IsMatch($configText, $canonicalPattern)) {
    throw 'Tunnel config does not match the canonical generated shape. Re-run scripts\tunnel-setup.ps1 and do not hand-edit the config.'
  }

  $validateOutput = & $cloudflared tunnel --config $configPath ingress validate 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    throw "cloudflared ingress validate failed: $($validateOutput.Trim())"
  }
  foreach ($probe in @('/', '/admin', '/admin/api/state', '/v1/messages', '/v1/responses', '/v1/chat/completions', '/__veillink_probe__')) {
    $ruleOutput = & $cloudflared tunnel --config $configPath ingress rule "https://$hostname$probe" 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or $ruleOutput -notmatch [regex]::Escape("service: $expectedService")) {
      throw "cloudflared routed $hostname$probe away from ${expectedService}: $($ruleOutput.Trim())"
    }
  }
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
      $candidate.CommandLine -like "*$tunnelConfig*"
    ) {
      Stop-Process -Id $candidate.ProcessId -Force -ErrorAction SilentlyContinue
      Wait-Process -Id $candidate.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
    }
  }
  Remove-Item -LiteralPath $tunnelPidFile -Force -ErrorAction SilentlyContinue
}

function Start-VeilLinkWatchdog([int]$serverPid, [long]$serverStartTicks) {
  $existingWatchdog = Get-ManagedProcess $watchdogPidFile $watchdogScript
  if ($existingWatchdog) {
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $($existingWatchdog.Id)" -ErrorAction SilentlyContinue
    if ($cim -and $cim.CommandLine -like "*-ServerPid $serverPid*" -and $cim.CommandLine -like "*$watchdogMarker*") {
      return
    }
    Stop-Process -Id $existingWatchdog.Id -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $watchdogPidFile -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path -LiteralPath $watchdogScript)) {
    throw "Watchdog script is missing: $watchdogScript"
  }
  $pwshPath = (Get-Process -Id $PID).Path
  $watchdogArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watchdogScript`" -ServerPid $serverPid -ServerStartTicks $serverStartTicks -DataDir `"$dataDir`""
  $watchdogOut = Join-Path $logsDir 'watchdog.out.log'
  $watchdogErr = Join-Path $logsDir 'watchdog.err.log'
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
      $cim.CommandLine -notlike "*-ServerPid $serverPid*" -or
      $cim.CommandLine -notlike "*$watchdogMarker*") {
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
if ($existingServer) {
  $serverPid = $existingServer.Id
  try {
    $serverStartTicks = $existingServer.StartTime.ToUniversalTime().Ticks
  } catch {
    $serverStartTicks = 0
  }
  Write-Host "VeilLink server is already running (PID $serverPid); reusing it."
} else {
  Remove-Item -LiteralPath $serverPidFile -Force -ErrorAction SilentlyContinue
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
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch {
      if ($serverProcess.HasExited) { break }
    }
  }
  if (-not $ready) {
    Write-Host 'VeilLink failed to start.'
    if (Test-Path -LiteralPath $serverErr) { Get-Content -LiteralPath $serverErr -Tail 30 }
    if (-not $serverProcess.HasExited) { Stop-Process -Id $serverProcess.Id -Force }
    Remove-Item -LiteralPath $serverPidFile -Force -ErrorAction SilentlyContinue
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
if (-not $NoTunnel -and (Test-Path -LiteralPath $cloudflared) -and (Test-Path -LiteralPath $tunnelConfig)) {
  $actualHash = (Get-FileHash -LiteralPath $cloudflared -Algorithm SHA256).Hash
  if ($actualHash -ne $expectedCloudflaredHash) {
    $tunnelBlocked = 'cloudflared SHA-256 does not match the pinned verified build; tunnel not started.'
  }
  $expectedService = "http://127.0.0.1:$publicPort"
  if (-not $tunnelBlocked) {
    try {
      Assert-TunnelConfig $tunnelConfig $expectedService
    } catch {
      $tunnelBlocked = $_.Exception.Message
    }
  }
  if (-not $tunnelBlocked) {
    $existingTunnel = Get-ManagedProcess $tunnelPidFile $tunnelConfig $cloudflared
    if (-not $existingTunnel) {
      Remove-Item -LiteralPath $tunnelPidFile -Force -ErrorAction SilentlyContinue
      $tunnelOut = Join-Path $logsDir 'cloudflared.out.log'
      $tunnelErr = Join-Path $logsDir 'cloudflared.err.log'
      $tunnelArgs = "tunnel --config `"$tunnelConfig`" --no-autoupdate --protocol http2 --loglevel info run"
      $tunnelProcess = Start-Process -FilePath $cloudflared `
        -ArgumentList $tunnelArgs `
        -WorkingDirectory $root `
        -WindowStyle Hidden `
        -RedirectStandardOutput $tunnelOut `
        -RedirectStandardError $tunnelErr `
        -PassThru
      Set-Content -LiteralPath $tunnelPidFile -Value $tunnelProcess.Id -Encoding ascii
      Start-Sleep -Milliseconds 1500
      if ($tunnelProcess.HasExited) {
        Remove-Item -LiteralPath $tunnelPidFile -Force -ErrorAction SilentlyContinue
        $tunnelBlocked = "cloudflared exited immediately; see $tunnelErr"
      } else {
        $tunnelStarted = $true
        $tunnelActive = $true
      }
    } else {
      $tunnelActive = $true
      Write-Host "Cloudflare tunnel is already running (PID $($existingTunnel.Id)); reusing it."
    }
  }
  if ($tunnelBlocked) {
    $existingTunnel = Get-ManagedProcess $tunnelPidFile $tunnelConfig $cloudflared
    if ($existingTunnel) {
      Stop-ManagedTunnel
      Write-Host 'Stopped the existing managed tunnel because its configuration or binary failed validation.'
    } elseif (Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -eq $cloudflared -and $_.CommandLine -like "*$tunnelConfig*" }) {
      Stop-ManagedTunnel
      Write-Host 'Stopped an unmanaged cloudflared process for this tunnel because validation failed.'
    }
  }
}

if ($tunnelActive) {
  try {
    Start-VeilLinkWatchdog $serverPid $serverStartTicks
    Write-Host "Tunnel watchdog started (server PID $serverPid)."
  } catch {
    Write-Host "WARNING: Unable to start the tunnel watchdog: $($_.Exception.Message)"
    Stop-TunnelProcess
    $tunnelActive = $false
    $tunnelStarted = $false
    $tunnelBlocked = 'Tunnel stopped because its lifecycle watchdog could not start.'
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
