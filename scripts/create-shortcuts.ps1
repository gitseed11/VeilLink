$ErrorActionPreference = 'Stop'

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$launcher = Join-Path $root 'scripts\launcher.vbs'
$icon = Join-Path $root 'assets\veillink.ico'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'

if (-not (Test-Path -LiteralPath $launcher)) { throw "Launcher not found: $launcher" }
if (-not (Test-Path -LiteralPath $icon)) { throw "Icon not found: $icon" }
if (-not (Test-Path -LiteralPath $wscript)) { throw "wscript.exe not found: $wscript" }

$shell = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'VeilLink.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'VeilLink.lnk')
)

foreach ($target in $targets) {
  $shortcut = $shell.CreateShortcut($target)
  $shortcut.TargetPath = $wscript
  $shortcut.Arguments = '"' + $launcher + '"'
  $shortcut.WorkingDirectory = $root
  $shortcut.IconLocation = "$icon,0"
  $shortcut.Description = 'VeilLink 本地网关启动器'
  $shortcut.WindowStyle = 1
  $shortcut.Save()
  Write-Host "Created: $target"
}

Write-Host 'VeilLink shortcuts are ready.'
