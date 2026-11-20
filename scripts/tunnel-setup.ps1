param(
  [Parameter(Mandatory = $true)]
  [string]$Hostname,
  [string]$TunnelName = 'veillink',
  [switch]$ForceDns
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$exe = Join-Path $root 'bin\cloudflared.exe'
$dataDir = if ($env:VEILLINK_DATA_DIR) {
  [IO.Path]::GetFullPath($env:VEILLINK_DATA_DIR)
} else {
  Join-Path $root 'data'
}
$publicPort = if ($env:VEILLINK_PUBLIC_PORT) { [int]$env:VEILLINK_PUBLIC_PORT } else { 8788 }
$tunnelDir = Join-Path $dataDir 'tunnel'
$cert = Join-Path $tunnelDir 'cert.pem'
$credFile = Join-Path $tunnelDir "$TunnelName.json"
$configFile = Join-Path $tunnelDir 'config.yml'
# Keep this value in sync with the ExpectedHash default in tunnel-validate.ps1.
$expectedCloudflaredHash = 'D5C1D82031DA6253DCDCFF64C944CD0FE063016EDEB2E4FD088075FC9BD52D0A'

if ($Hostname -match '^[a-zA-Z]+://' -or $Hostname -match '/') {
  throw 'Hostname must be a DNS name only, for example api.example.com (no scheme, path, or trailing slash).'
}
if ($Hostname -notmatch '^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$') {
  throw 'Hostname is not a valid DNS name.'
}
if ($TunnelName -notmatch '^[A-Za-z0-9_-]{1,40}$') {
  throw 'TunnelName may only contain letters, digits, underscore, and hyphen.'
}
if (-not (Test-Path -LiteralPath $exe)) {
  throw "cloudflared.exe is missing at $exe"
}
$actualHash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
if ($actualHash -ne $expectedCloudflaredHash) {
  throw 'cloudflared.exe SHA-256 does not match the pinned verified build. Refusing to use it.'
}
New-Item -ItemType Directory -Force -Path $tunnelDir | Out-Null

# Tunnel credentials and cert.pem are sensitive. Harden data\ before login.
$aclScript = Join-Path $PSScriptRoot 'setup-acl.ps1'
if (Test-Path -LiteralPath $aclScript) {
  & $aclScript
  if ($LASTEXITCODE -ne 0) { throw 'Unable to apply the data directory ACL.' }
}

if (-not (Test-Path -LiteralPath $cert)) {
  Write-Host ''
  Write-Host 'Cloudflare login is required. A browser window will open.'
  Write-Host 'Sign in, then select the zone that contains your VeilLink domain.'
  Write-Host 'If no zone is available, add the domain to Cloudflare first and wait until it is Active.'
  Write-Host ''
  $env:TUNNEL_ORIGIN_CERT = $cert
  & $exe tunnel login
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $cert)) {
    throw 'Cloudflare login did not complete successfully.'
  }
}
$env:TUNNEL_ORIGIN_CERT = $cert

$rawList = & $exe tunnel list --output json 2>$null
if ($LASTEXITCODE -ne 0) { throw 'Unable to list Cloudflare tunnels.' }
$parsed = if ($rawList) { $rawList | ConvertFrom-Json } else { @() }
$tunnels = if ($parsed -is [array]) { $parsed } elseif ($parsed.tunnels) { $parsed.tunnels } elseif ($parsed) { @($parsed) } else { @() }
$existing = $tunnels | Where-Object { $_.name -eq $TunnelName } | Select-Object -First 1

if ($existing) {
  if (-not (Test-Path -LiteralPath $credFile)) {
    $fallback = Join-Path $env:USERPROFILE ".cloudflared\$($existing.id).json"
    if (Test-Path -LiteralPath $fallback) {
      Copy-Item -LiteralPath $fallback -Destination $credFile -Force
      Write-Host "Copied existing tunnel credentials into $credFile"
    } else {
      throw "Tunnel '$TunnelName' exists but its credentials were not found. Remove it in Cloudflare or choose another tunnel name."
    }
  }
  $tunnelId = $existing.id
  Write-Host "Using existing tunnel '$TunnelName' ($tunnelId)."
} else {
  & $exe tunnel create --credentials-file $credFile $TunnelName
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $credFile)) {
    throw 'Tunnel creation failed.'
  }
  $credential = Get-Content -LiteralPath $credFile -Raw | ConvertFrom-Json
  $tunnelId = $credential.TunnelID
  Write-Host "Created tunnel '$TunnelName' ($tunnelId)."
}

$routeArgs = @('tunnel', 'route', 'dns')
if ($ForceDns) { $routeArgs += '--overwrite-dns' }
$routeArgs += @($TunnelName, $Hostname)
& $exe @routeArgs
if ($LASTEXITCODE -ne 0) {
  throw "DNS route creation failed for $Hostname. Confirm the domain is active in the same Cloudflare account."
}

$credYaml = ($credFile -replace '\\', '/')
$configText = @"
tunnel: $tunnelId
credentials-file: '$credYaml'
ingress:
  - hostname: '$Hostname'
    service: http://127.0.0.1:$publicPort
  - service: http_status:404
"@
$utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
[IO.File]::WriteAllText($configFile, $configText, $utf8NoBom)

Write-Host ''
Write-Host 'Named tunnel configured.'
Write-Host "  Public HTTPS URL: https://$Hostname"
Write-Host "  Cloudflared config: $configFile"
Write-Host ''
Write-Host 'Next steps:'
Write-Host "  1. In the local admin UI, set '公网 API 地址' to https://$Hostname and save."
Write-Host '  2. Start the local service and tunnel with scripts\start.ps1'
Write-Host "  3. In Cloudflare, enable SSL/TLS mode Full (strict) and Always Use HTTPS."
