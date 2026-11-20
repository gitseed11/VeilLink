param(
  [switch]$NoOpen,
  [switch]$NoTray,
  [switch]$Quiet
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
  (Join-Path $root 'data').TrimEnd('\')
}
$adminPort = if ($env:VEILLINK_ADMIN_PORT) { [int]$env:VEILLINK_ADMIN_PORT } else { 8787 }
$publicPort = if ($env:VEILLINK_PUBLIC_PORT) { [int]$env:VEILLINK_PUBLIC_PORT } else { 8788 }
$adminUrl = "http://127.0.0.1:$adminPort"
$iconPath = Join-Path $root 'assets\veillink.ico'
$serverScript = Join-Path $root 'src\server.js'
$serverMarker = "--veillink-data-dir=`"$dataDir`""
$startScript = Join-Path $PSScriptRoot 'start.ps1'
$stopScript = Join-Path $PSScriptRoot 'stop.ps1'
$logsDir = Join-Path $dataDir 'logs'
$logFile = Join-Path $logsDir 'launcher.log'

New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

function Write-LauncherLog([string]$message) {
  try {
    if (Test-Path -LiteralPath $logFile) {
      $item = Get-Item -LiteralPath $logFile
      if ($item.Length -gt 5MB) {
        Move-Item -LiteralPath $logFile -Destination "$logFile.$(Get-Date -Format 'yyyyMMdd-HHmmss')" -Force
        Get-ChildItem -LiteralPath $logsDir -Filter 'launcher.log.*' -File -ErrorAction SilentlyContinue |
          Sort-Object LastWriteTime -Descending |
          Select-Object -Skip 5 |
          Remove-Item -Force -ErrorAction SilentlyContinue
      }
    }
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message"
    Add-Content -LiteralPath $logFile -Value $line -Encoding utf8
  } catch {
    # Logging must never prevent the launcher from starting the service.
  }
}

function Show-ErrorBox([string]$message) {
  Add-Type -AssemblyName System.Windows.Forms | Out-Null
  [System.Windows.Forms.MessageBox]::Show(
    $message,
    'VeilLink',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
}

function Test-LoopbackPort([int]$port) {
  $client = $null
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $async = $client.BeginConnect('127.0.0.1', $port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(500)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    if ($client) { $client.Close() }
  }
}

function Find-ManagedServerPid {
  try {
    $candidates = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop
    foreach ($candidate in $candidates) {
      if (
        $candidate.ExecutablePath -and
        [IO.Path]::GetFileName($candidate.ExecutablePath) -ieq 'node.exe' -and
        $candidate.CommandLine -and
        (Test-CommandContains $candidate.CommandLine $serverMarker)
      ) {
        return [int]$candidate.ProcessId
      }
    }
  } catch {
    # Fall through to the normal "not managed" result.
  }
  return 0
}

function Test-ManagedServer {
  $pidFile = Join-Path $dataDir 'veillink.pid'
  $processId = 0
  if (Test-Path -LiteralPath $pidFile) {
    $raw = Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue
    if ($raw) { [void][int]::TryParse($raw.Trim(), [ref]$processId) }
  }
  if ($processId -gt 0) {
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($process) {
      $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
      if (
        $cim -and
        $cim.ExecutablePath -and
        [IO.Path]::GetFileName($cim.ExecutablePath) -ieq 'node.exe' -and
        $cim.CommandLine -and
        (Test-CommandContains $cim.CommandLine $serverMarker)
      ) {
        return $true
      }
    }
  }
  # PID file may be stale or point at a reused PID. Fall back to a command
  # line scan and repair the PID file before declaring the server down.
  $found = Find-ManagedServerPid
  if ($found -le 0) { return $false }
  try {
    Set-Content -LiteralPath $pidFile -Value $found -Encoding ascii
  } catch {
    # The PID file is only an optimization; the command-line scan still works.
  }
  return $true
}

function Get-EdgePath {
  $candidates = @()
  if ($env:ProgramFiles) {
    $candidates += (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
  }
  if (${env:ProgramFiles(x86)}) {
    $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
  }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  return $null
}

function Open-AdminWindow {
  if (-not (Test-LoopbackPort $adminPort)) {
    Show-ErrorBox "管理端口 $adminPort 未监听。`n`n请重新打开 VeilLink 快捷方式，或运行 scripts\start.ps1。"
    return
  }
  $edge = Get-EdgePath
  if ($edge) {
    try {
      Start-Process -FilePath $edge -ArgumentList @(
        "--app=$adminUrl",
        '--window-size=1180,860'
      ) | Out-Null
      return
    } catch {
      Write-LauncherLog "Edge app window failed: $($_.Exception.Message)"
    }
  }
  try {
    Start-Process $adminUrl | Out-Null
  } catch {
    Write-LauncherLog "Opening the default browser failed: $($_.Exception.Message)"
    Show-ErrorBox "无法打开管理页面。请手动访问 $adminUrl"
  }
}

function Get-TunnelState {
  $stateFile = Join-Path $dataDir 'tunnel-state.json'
  try {
    if (-not (Test-Path -LiteralPath $stateFile)) { return $null }
    return Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Redact-TunnelError([string]$text) {
  $safe = [regex]::Replace($text, 'sk-[A-Za-z0-9@#%&_-]{20,}', 'sk-[REDACTED]')
  $safe = [regex]::Replace($safe, '\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b', 'Bearer [REDACTED]')
  $safe = [regex]::Replace($safe, '(?i)(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+', '$1[REDACTED]')
  $safe = [regex]::Replace($safe, '(?i)(x-api-key\s*[:=]\s*)[^\s,;]+', '$1[REDACTED]')
  return $safe
}

function Test-TunnelStateFresh($state) {
  if (-not $state -or -not $state.updatedAt) { return $false }
  try {
    $updated = ([DateTime]$state.updatedAt).ToUniversalTime()
    $age = ((Get-Date).ToUniversalTime() - $updated).TotalSeconds
    return ($age -ge -5 -and $age -le 30)
  } catch {
    return $false
  }
}

function Ensure-Service {
  if (Test-LoopbackPort $adminPort) {
    $managed = $false
    for ($i = 0; $i -lt 5; $i++) {
      if (Test-ManagedServer) { $managed = $true; break }
      Start-Sleep -Milliseconds 200
    }
    if (-not $managed) {
      Show-ErrorBox "管理端口 $adminPort 已被其他程序占用。`n`n请关闭占用该端口的程序，或设置 VEILLINK_ADMIN_PORT 后重新启动。"
      return $false
    }
  }

  $startOut = Join-Path $logsDir 'launcher-start.out.log'
  $startErr = Join-Path $logsDir 'launcher-start.err.log'
  $pwshPath = (Get-Process -Id $PID).Path
  $startArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`""
  Write-LauncherLog 'Invoking start.ps1.'
  try {
    $process = Start-Process -FilePath $pwshPath `
      -ArgumentList $startArgs `
      -WorkingDirectory $root `
      -WindowStyle Hidden `
      -PassThru `
      -RedirectStandardOutput $startOut `
      -RedirectStandardError $startErr
  } catch {
    Write-LauncherLog "start.ps1 could not be launched: $($_.Exception.Message)"
    Show-ErrorBox "无法启动 VeilLink。`n`n$($_.Exception.Message)`n`n日志：$logFile"
    return $false
  }

  $adminReady = $false
  for ($i = 0; $i -lt 240; $i++) {
    if (Test-LoopbackPort $adminPort) {
      $adminReady = $true
      break
    }
    if ($process.HasExited) { break }
    Start-Sleep -Milliseconds 250
  }

  if (-not $adminReady) {
    Write-LauncherLog "Admin port $adminPort did not become ready."
    Show-ErrorBox "VeilLink 服务未能就绪。`n`n请查看：`n$startErr`n$startOut`n$logFile"
    return $false
  }
  Write-LauncherLog "Admin port $adminPort is ready."

  # Wait for start.ps1 to finish its tunnel readiness check. A tunnel
  # failure leaves the local server running, so show the error but keep the
  # tray alive instead of orphaning the server.
  if (-not $process.HasExited) {
    try { [void]$process.WaitForExit(45000) } catch {}
  }
  if ($process.HasExited -and $process.ExitCode -ne 0) {
    Write-LauncherLog "start.ps1 exited with code $($process.ExitCode) after the server became ready."
    $tunnelState = Get-TunnelState
    $detail = if ($tunnelState -and $tunnelState.error) { Redact-TunnelError ([string]$tunnelState.error) } else { '请查看启动日志。' }
    Show-ErrorBox "VeilLink 本地服务已启动，但公网隧道未就绪。`n`n$detail`n`n日志：`n$startErr`n$startOut"
    return $true
  }
  return $true
}

function Stop-FromTray {
  $answer = [System.Windows.Forms.MessageBox]::Show(
    "确定停止 VeilLink 服务吗？`n`n停止后，本地管理页和公网 API 都会立即不可用。`nCloudflare 隧道也会一并停止。`n`n如需继续使用，请重新打开桌面快捷方式。",
    '停止 VeilLink',
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Warning,
    [System.Windows.Forms.MessageBoxDefaultButton]::Button2
  )
  if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }

  Write-LauncherLog 'Stopping service from the tray menu.'
  $script:stopAttemptFailed = $false
  $notify.Text = 'VeilLink 正在停止…'
  $stopArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$stopScript`" -Force"
  try {
    $pwshPath = (Get-Process -Id $PID).Path
    $process = Start-Process -FilePath $pwshPath `
      -ArgumentList $stopArgs `
      -WorkingDirectory $root `
      -WindowStyle Hidden `
      -Wait `
      -PassThru
    if ($process.ExitCode -ne 0) {
      $script:stopAttemptFailed = $true
      Write-LauncherLog "stop.ps1 exited with code $($process.ExitCode)."
    }
  } catch {
    $script:stopAttemptFailed = $true
    Write-LauncherLog "stop.ps1 could not be launched: $($_.Exception.Message)"
  }

  for ($i = 0; $i -lt 12; $i++) {
    if (-not (Test-LoopbackPort $adminPort)) { break }
    Start-Sleep -Milliseconds 250
  }
  if ((Test-LoopbackPort $adminPort) -or $script:stopAttemptFailed) {
    Write-LauncherLog 'Stop requested, but service or tunnel cleanup did not complete.'
    $notify.Text = 'VeilLink 停止失败'
    Show-ErrorBox "停止未完全成功：管理端口 $adminPort 仍在监听，或隧道/进程未能清理。`n`n请查看 $logFile 或运行 scripts\stop.ps1。"
    return
  }

  Write-LauncherLog 'Service stopped; exiting tray.'
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::ExitThread()
}

$mutex = $null
$ownsMutex = $false
$notify = $null
$menu = $null
$timer = $null
$context = $null

try {
  # Acquire the single-instance mutex before invoking start.ps1, otherwise
  # several rapid launches can race through Ensure-Service and each spawn a
  # start script.
  $createdNew = $false
  $mutex = [System.Threading.Mutex]::new($true, 'Local\VeilLink.Tray', [ref]$createdNew)
  $ownsMutex = $createdNew
  if (-not $createdNew) {
    Write-LauncherLog 'Another tray instance is already running; opening the admin page instead.'
    if (-not $NoOpen) { Open-AdminWindow }
    $mutex.Dispose()
    $mutex = $null
    exit 0
  }

  if (-not (Ensure-Service)) { exit 1 }

  if (-not $NoOpen) { Open-AdminWindow }

  if ($NoTray) {
    Write-LauncherLog 'Launcher completed without creating a tray icon.'
    exit 0
  }

  Add-Type -AssemblyName System.Windows.Forms | Out-Null
  Add-Type -AssemblyName System.Drawing | Out-Null
  [System.Windows.Forms.Application]::EnableVisualStyles()
  try {
    [System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)
  } catch {
    # It may already have been set by another assembly load.
  }

  if (Test-Path -LiteralPath $iconPath) {
    $trayIcon = New-Object System.Drawing.Icon -ArgumentList $iconPath
  } else {
    $trayIcon = [System.Drawing.SystemIcons]::Application
  }

  $notify = New-Object System.Windows.Forms.NotifyIcon
  $notify.Icon = $trayIcon
  $notify.Text = 'VeilLink 正在运行'
  $notify.Visible = $true

  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $menu.ShowImageMargin = $false
  $openItem = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList '打开管理页面'
  $openItem.Add_Click({ Open-AdminWindow })
  $stopItem = New-Object System.Windows.Forms.ToolStripMenuItem -ArgumentList '停止 VeilLink…'
  $stopItem.Add_Click({ Stop-FromTray })
  $menu.Items.Add($openItem) | Out-Null
  $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
  $menu.Items.Add($stopItem) | Out-Null
  $notify.ContextMenuStrip = $menu
  $notify.Add_DoubleClick({ Open-AdminWindow })

  $script:downTicks = 0
  $script:stopAttemptFailed = $false
  $script:tunnelStateKnown = $false
  $script:tunnelWasReady = $null
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 3000
  $timer.Add_Tick({
    if ($script:stopAttemptFailed) { return }
    $portUp = Test-LoopbackPort $adminPort
    if ($portUp) {
      if (-not (Test-ManagedServer)) {
        # A transient WMI failure must not stop a server whose port is still
        # listening. Keep the tray alive and wait for identity checks to
        # recover; only a missing admin port triggers the stop flow below.
        $notify.Text = 'VeilLink 运行中 · 身份校验失败'
        $script:downTicks = 0
        return
      }
      $script:downTicks = 0
      $tunnel = Get-TunnelState
      if ($tunnel -and $tunnel.mode -eq 'disabled') {
        $notify.Text = 'VeilLink 运行中 · 隧道未启用'
        $script:tunnelWasReady = $null
        $script:tunnelStateKnown = $true
        return
      }
      if ($tunnel -and $tunnel.mode -eq 'error') {
        $notify.Text = 'VeilLink 运行中 · 公网入口异常'
        if ($script:tunnelWasReady -ne $false -or -not $script:tunnelStateKnown) {
          $reason = if ($tunnel.error) { Redact-TunnelError ([string]$tunnel.error) } else { '隧道状态为错误。' }
          $notify.ShowBalloonTip(
            6000,
            'VeilLink 公网入口不可用',
            "$reason 本地管理页仍可用；请检查隧道日志。",
            [System.Windows.Forms.ToolTipIcon]::Warning
          )
        }
        $script:tunnelWasReady = $false
        $script:tunnelStateKnown = $true
        return
      }
      if ($tunnel -and -not (Test-TunnelStateFresh $tunnel)) {
        $notify.Text = 'VeilLink 运行中 · 公网状态未知'
        $script:tunnelWasReady = $null
        $script:tunnelStateKnown = $true
        return
      }
      if ($tunnel) {
        if ($tunnel.enabled -eq $true -and $tunnel.ready -eq $true) {
          $notify.Text = 'VeilLink 正在运行'
          if ($script:tunnelWasReady -eq $false) {
            $notify.ShowBalloonTip(
              5000,
              'VeilLink',
              '公网入口已恢复。',
              [System.Windows.Forms.ToolTipIcon]::Info
            )
          }
          $script:tunnelWasReady = $true
        } elseif ($tunnel.enabled -eq $true) {
          $notify.Text = 'VeilLink 运行中 · 公网入口异常'
          if ($script:tunnelWasReady -eq $true -or -not $script:tunnelStateKnown) {
            $reason = if ($tunnel.error) { Redact-TunnelError ([string]$tunnel.error) } else { 'cloudflared 未就绪。' }
            $notify.ShowBalloonTip(
              6000,
              'VeilLink 公网入口不可用',
              "$reason 本地管理页仍可用；请检查隧道日志。",
              [System.Windows.Forms.ToolTipIcon]::Warning
            )
          }
          $script:tunnelWasReady = $false
        } else {
          $notify.Text = 'VeilLink 运行中 · 隧道未启用'
          $script:tunnelWasReady = $null
        }
        $script:tunnelStateKnown = $true
      }
      return
    }
    $script:downTicks++
    if ($script:downTicks -ge 2) {
      Write-LauncherLog 'Admin port disappeared unexpectedly; requesting stop.ps1 -Force.'
      $timer.Stop()
      $stopFailed = $false
      try {
        $pwshPath = (Get-Process -Id $PID).Path
        $stopArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$stopScript`" -Force"
        $process = Start-Process -FilePath $pwshPath `
          -ArgumentList $stopArgs `
          -WorkingDirectory $root `
          -WindowStyle Hidden `
          -Wait `
          -PassThru
        if ($process.ExitCode -ne 0) {
          $stopFailed = $true
          Write-LauncherLog "stop.ps1 exited with code $($process.ExitCode) after unexpected server loss."
        }
      } catch {
        $stopFailed = $true
        Write-LauncherLog "stop.ps1 could not be launched after unexpected server loss: $($_.Exception.Message)"
      }
      if ($stopFailed) {
        $script:stopAttemptFailed = $true
        $notify.Text = 'VeilLink 停止失败'
        $notify.ShowBalloonTip(
          5000,
          'VeilLink',
          '后台服务已停止，但隧道或进程清理失败。请右键托盘图标重试停止，或运行 scripts\stop.ps1。',
          [System.Windows.Forms.ToolTipIcon]::Warning
        )
        return
      }
      $notify.Visible = $false
      $notify.Dispose()
      [System.Windows.Forms.Application]::ExitThread()
    }
  })
  $timer.Start()

  $context = New-Object System.Windows.Forms.ApplicationContext
  if (-not $Quiet) {
    $notify.ShowBalloonTip(
      4500,
      'VeilLink',
      '后台服务正在运行。关闭管理窗口不会停止服务；右键托盘图标可停止。',
      [System.Windows.Forms.ToolTipIcon]::Info
    )
  }
  Write-LauncherLog 'Tray started.'
  [System.Windows.Forms.Application]::Run($context)
} catch {
  Write-LauncherLog "Launcher failed: $($_.Exception.Message)"
  Show-ErrorBox "VeilLink 启动器出错。`n`n$($_.Exception.Message)`n`n日志：$logFile"
  exit 1
} finally {
  if ($timer) { try { $timer.Stop() } catch {}; $timer.Dispose() }
  if ($notify) { try { $notify.Visible = $false } catch {}; $notify.Dispose() }
  if ($menu) { $menu.Dispose() }
  if ($ownsMutex -and $mutex) {
    try { $mutex.ReleaseMutex() } catch {}
  }
  if ($mutex) { try { $mutex.Dispose() } catch {} }
}
