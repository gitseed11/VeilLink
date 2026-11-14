param(
  [switch]$NoOpen,
  [switch]$NoTray,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

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
        $candidate.CommandLine -like "*$serverMarker*"
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
  if ($processId -le 0) {
    $processId = Find-ManagedServerPid
    if ($processId -le 0) { return $false }
    try {
      Set-Content -LiteralPath $pidFile -Value $processId -Encoding ascii
    } catch {
      # The PID file is only an optimization; the command-line scan still works.
    }
  }
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if (-not $process) { return $false }
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
  return [bool](
    $cim -and
    $cim.ExecutablePath -and
    [IO.Path]::GetFileName($cim.ExecutablePath) -ieq 'node.exe' -and
    $cim.CommandLine -and
    $cim.CommandLine -like "*$serverMarker*"
  )
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

function Ensure-Service {
  if ((Test-LoopbackPort $adminPort) -and -not (Test-ManagedServer)) {
    Show-ErrorBox "管理端口 $adminPort 已被其他程序占用。`n`n请关闭占用该端口的程序，或设置 VEILLINK_ADMIN_PORT 后重新启动。"
    return $false
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

  for ($i = 0; $i -lt 80; $i++) {
    if (Test-LoopbackPort $adminPort) {
      Write-LauncherLog "Admin port $adminPort is ready."
      return $true
    }
    if ($process.HasExited -and $process.ExitCode -ne 0) {
      Write-LauncherLog "start.ps1 exited with code $($process.ExitCode)."
      Show-ErrorBox "VeilLink 启动失败（退出码 $($process.ExitCode)）。`n`n请查看：`n$startErr`n$startOut`n$logFile"
      return $false
    }
    Start-Sleep -Milliseconds 250
  }

  Write-LauncherLog "Admin port $adminPort did not become ready."
  Show-ErrorBox "VeilLink 服务未能就绪。`n`n请查看：`n$startErr`n$startOut`n$logFile"
  return $false
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
  if (Test-LoopbackPort $adminPort -or $script:stopAttemptFailed) {
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
  if (-not (Ensure-Service)) { exit 1 }

  if (-not $NoOpen) { Open-AdminWindow }

  if ($NoTray) {
    Write-LauncherLog 'Launcher completed without creating a tray icon.'
    exit 0
  }

  $createdNew = $false
  $mutex = [System.Threading.Mutex]::new($true, 'Local\VeilLink.Tray', [ref]$createdNew)
  $ownsMutex = $createdNew
  if (-not $createdNew) {
    Write-LauncherLog 'Another tray instance is already running.'
    $mutex.Dispose()
    $mutex = $null
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
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 3000
  $timer.Add_Tick({
    if ($script:stopAttemptFailed) { return }
    if (Test-LoopbackPort $adminPort) {
      $script:downTicks = 0
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
