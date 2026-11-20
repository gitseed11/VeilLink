param(
  [Parameter(Mandatory = $true)]
  [string]$ConfigPath,
  [Parameter(Mandatory = $true)]
  [string]$CloudflaredPath,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedService,
  [string]$ExpectedHash = 'D5C1D82031DA6253DCDCFF64C944CD0FE063016EDEB2E4FD088075FC9BD52D0A'
)

$ErrorActionPreference = 'Stop'

function Stop-Validation([string]$message) {
  Write-Output "Tunnel validation failed: $message"
  exit 1
}

try {
  if (-not (Test-Path -LiteralPath $CloudflaredPath)) {
    Stop-Validation "cloudflared is missing: $CloudflaredPath"
  }
  if (-not (Test-Path -LiteralPath $ConfigPath)) {
    Stop-Validation "tunnel config is missing: $ConfigPath"
  }
  $actualHash = (Get-FileHash -LiteralPath $CloudflaredPath -Algorithm SHA256).Hash
  if ($actualHash -ne $ExpectedHash) {
    Stop-Validation 'cloudflared SHA-256 does not match the pinned verified build.'
  }

  $configText = Get-Content -LiteralPath $ConfigPath -Raw
  if ($configText -match '[\\{}\[\]&*!?]') {
    Stop-Validation 'Tunnel config must use canonical block-style YAML with forward slashes; flow mappings, anchors, aliases, tags, explicit keys, and escape sequences are not allowed.'
  }
  if ($configText -match '(?m)^\s*(?:-\s*)?<<\s*:') {
    Stop-Validation 'Tunnel config must not contain YAML merge keys.'
  }
  if ($configText -match '(?m)^\s*(?:---|\.\.\.)\s*$') {
    Stop-Validation 'Tunnel config must contain exactly one YAML document.'
  }
  if ($configText -match '(?im)^\s*["'']?loglevel["'']?\s*:\s*["'']?(debug|trace)["'']?\s*(?:#.*)?$') {
    Stop-Validation 'Tunnel config uses debug/trace logging.'
  }
  if ($configText -match '(?im)^\s*(?:-\s*)?["'']?(originRequest|httpHostHeader|metrics|warp-routing)["'']?\s*:') {
    Stop-Validation 'Tunnel config contains originRequest/httpHostHeader/metrics/warp-routing.'
  }
  if ($configText -match '(?im)^\s*(?:-\s*)?["''][^"'']*["'']\s*:') {
    Stop-Validation 'Tunnel config must not use quoted mapping keys.'
  }
  if ($configText -match '(?im)^\s*(?:-\s*)?["'']?path["'']?\s*:') {
    Stop-Validation 'Tunnel config must not contain path-based ingress rules.'
  }
  if (([regex]::Matches($configText, '(?im)^\s*["'']?ingress["'']?\s*:')).Count -ne 1) {
    Stop-Validation 'Tunnel config must contain exactly one ingress section.'
  }

  $hosts = @(
    [regex]::Matches($configText, '(?im)^\s*-\s*["'']?hostname["'']?\s*:\s*["'']?([^"''\s#]+)["'']?') |
      ForEach-Object { $_.Groups[1].Value.Trim('"', "'") }
  )
  if ($hosts.Count -ne 1) {
    Stop-Validation 'Tunnel config must contain exactly one hostname ingress rule.'
  }
  $hostname = $hosts[0]
  if ($hostname -match '[*]' -or $hostname -notmatch '^[A-Za-z0-9.-]+$') {
    Stop-Validation "Tunnel hostname is not a concrete DNS name: $hostname"
  }

  $services = @(
    [regex]::Matches($configText, '(?im)^\s*(?:-\s*)?["'']?service["'']?\s*:\s*["'']?([^"''\s#]+)["'']?') |
      ForEach-Object { $_.Groups[1].Value.Trim('"', "'") }
  )
  if ($services.Count -ne 2 -or $services -notcontains $ExpectedService -or $services -notcontains 'http_status:404') {
    Stop-Validation "Tunnel config must route the hostname to $ExpectedService with a single http_status:404 catch-all."
  }

  $canonicalPattern = "(?s)^\s*tunnel\s*:\s*[^\r\n]+\r?\n\s*credentials-file\s*:\s*'[^'\r\n]+'\r?\n\s*ingress\s*:\s*\r?\n\s*-\s*hostname\s*:\s*'?([A-Za-z0-9.-]+)'?\r?\n\s*service\s*:\s*" +
    [regex]::Escape($ExpectedService) +
    "\r?\n\s*-\s*service\s*:\s*http_status:404\s*$"
  if (-not [regex]::IsMatch($configText, $canonicalPattern)) {
    Stop-Validation 'Tunnel config does not match the canonical generated shape.'
  }

  $validateOutput = & $CloudflaredPath tunnel --config $ConfigPath ingress validate 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    Stop-Validation "cloudflared ingress validate failed: $($validateOutput.Trim())"
  }
  foreach ($probe in @('/', '/admin', '/admin/api/state', '/v1/messages', '/v1/responses', '/v1/chat/completions', '/__veillink_probe__')) {
    $ruleOutput = & $CloudflaredPath tunnel --config $ConfigPath ingress rule "https://$hostname$probe" 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or $ruleOutput -notmatch [regex]::Escape("service: $ExpectedService")) {
      Stop-Validation "cloudflared routed $hostname$probe away from ${ExpectedService}: $($ruleOutput.Trim())"
    }
  }
  Write-Output 'TUNNEL_VALIDATION_OK'
  exit 0
} catch {
  Stop-Validation $_.Exception.Message
}
