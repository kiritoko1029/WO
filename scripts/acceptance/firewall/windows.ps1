param(
  [Parameter(Mandatory = $true)][ValidateSet('install', 'remove', 'status')][string]$Action,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')][string]$RunId,
  [Parameter(Mandatory = $true)][System.Net.IPAddress]$TurnAddress,
  [Parameter(Mandatory = $true)][ValidateRange(1, 65535)][int]$TurnUdpPort,
  [Parameter(Mandatory = $true)][ValidateRange(1, 65535)][int]$TurnTlsPort,
  [Parameter(Mandatory = $true)][ValidateRange(1, 65535)][int]$TurnRelayMinPort,
  [Parameter(Mandatory = $true)][ValidateRange(1, 65535)][int]$TurnRelayMaxPort,
  [Parameter(Mandatory = $true)][System.Net.IPAddress]$ControllerAddress,
  [Parameter(Mandatory = $true)][ValidateRange(1, 65535)][int]$ControllerPort,
  [Parameter(Mandatory = $true)][string]$DesktopExecutable,
  [Parameter(Mandatory = $true)][string]$StateFile,
  [ValidateRange(60, 3600)][int]$WatchdogSeconds = 900
)

$ErrorActionPreference = 'Stop'
$prefix = "WO-Acceptance-$RunId"
$ruleIds = @('dns-udp', 'dns-tcp', 'https', 'controller', 'turn-udp', 'turn-tcp', 'turn-tls', 'turn-relay')
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'FIREWALL_ELEVATION_REQUIRED'
}
if (-not [IO.Path]::IsPathFullyQualified($DesktopExecutable) -or -not [IO.Path]::IsPathFullyQualified($StateFile)) {
  throw 'FIREWALL_PATH_INVALID'
}
if (
  $TurnUdpPort -eq $TurnTlsPort -or
  $TurnRelayMinPort -gt $TurnRelayMaxPort -or
  ($TurnUdpPort -ge $TurnRelayMinPort -and $TurnUdpPort -le $TurnRelayMaxPort) -or
  ($TurnTlsPort -ge $TurnRelayMinPort -and $TurnTlsPort -le $TurnRelayMaxPort)
) {
  throw 'FIREWALL_RELAY_RANGE_INVALID'
}

function Get-PolicySnapshot {
  $profiles = Get-NetFirewallProfile | Sort-Object Name | Select-Object Name, Enabled, DefaultInboundAction, DefaultOutboundAction
  $json = $profiles | ConvertTo-Json -Compress
  $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($json))).ToLowerInvariant()
  return @{ profiles = $profiles; hash = $hash }
}

function Get-RuleStatus {
  $installedRules = @(Get-NetFirewallRule -DisplayName "$prefix-*" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty DisplayName)
  $installedRuleIds = @($installedRules | ForEach-Object { $_.Substring($prefix.Length + 1) })
  $profiles = @(Get-NetFirewallProfile -Profile Domain,Private,Public)
  $blockedProfiles = @($profiles | Where-Object { [string]$_.DefaultOutboundAction -eq 'Block' })
  return @{
    runId = $RunId
    elevated = $true
    installedRuleIds = $installedRuleIds
    ruleCount = $installedRules.Count
    defaultBlockInstalled = ($profiles.Count -eq 3 -and $blockedProfiles.Count -eq 3)
  }
}

if ($Action -eq 'status') {
  Get-RuleStatus | ConvertTo-Json -Depth 4 -Compress
  exit 0
}

if ($Action -eq 'install') {
  if (Test-Path -LiteralPath $StateFile) { throw 'FIREWALL_STATE_EXISTS' }
  $parent = Split-Path -Parent $StateFile
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  $snapshot = Get-PolicySnapshot
  @{ runId = $RunId; snapshot = $snapshot; rules = @(); ruleIds = $ruleIds; watchdogArmed = $false; watchdogPid = 0 } |
    ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $StateFile -Encoding UTF8 -NoNewline

  $quote = { param([string]$Value) $Value.Replace("'", "''") }
  $watchdogScriptPath = [IO.Path]::GetFullPath($PSCommandPath)
  $quotedWatchdogScriptPath = & $quote $watchdogScriptPath
  $watchdogCommand = "Start-Sleep -Seconds $WatchdogSeconds; if (Test-Path -LiteralPath '$(& $quote $StateFile)') { & '$quotedWatchdogScriptPath' -Action remove -RunId '$RunId' -TurnAddress '$($TurnAddress.IPAddressToString)' -TurnUdpPort $TurnUdpPort -TurnTlsPort $TurnTlsPort -TurnRelayMinPort $TurnRelayMinPort -TurnRelayMaxPort $TurnRelayMaxPort -ControllerAddress '$($ControllerAddress.IPAddressToString)' -ControllerPort $ControllerPort -DesktopExecutable '$(& $quote $DesktopExecutable)' -StateFile '$(& $quote $StateFile)' }"
  $encodedWatchdog = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($watchdogCommand))
  $watchdog = Start-Process -FilePath "$PSHOME\powershell.exe" -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $encodedWatchdog) -WindowStyle Hidden -PassThru
  $state = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
  $state.watchdogArmed = $true
  $state.watchdogPid = $watchdog.Id
  $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $StateFile -Encoding UTF8 -NoNewline

  $rules = @(
    @{ suffix = 'dns-udp'; protocol = 'UDP'; port = 53; address = 'Any' },
    @{ suffix = 'dns-tcp'; protocol = 'TCP'; port = 53; address = 'Any' },
    @{ suffix = 'https'; protocol = 'TCP'; port = 443; address = 'Any' },
    @{ suffix = 'controller'; protocol = 'TCP'; port = $ControllerPort; address = $ControllerAddress.IPAddressToString },
    @{ suffix = 'turn-udp'; protocol = 'UDP'; port = $TurnUdpPort; address = $TurnAddress.IPAddressToString },
    @{ suffix = 'turn-tcp'; protocol = 'TCP'; port = $TurnUdpPort; address = $TurnAddress.IPAddressToString },
    @{ suffix = 'turn-tls'; protocol = 'TCP'; port = $TurnTlsPort; address = $TurnAddress.IPAddressToString },
    @{ suffix = 'turn-relay'; protocol = 'UDP'; port = "$TurnRelayMinPort-$TurnRelayMaxPort"; address = $TurnAddress.IPAddressToString }
  )
  foreach ($rule in $rules) {
    $parameters = @{
      DisplayName = "$prefix-$($rule.suffix)"
      Direction = 'Outbound'
      Action = 'Allow'
      Protocol = $rule.protocol
      RemotePort = $rule.port
      RemoteAddress = $rule.address
    }
    if ($rule.suffix -ne 'controller') { $parameters.Program = $DesktopExecutable }
    New-NetFirewallRule @parameters | Out-Null
  }
  Set-NetFirewallProfile -Profile Domain,Private,Public -DefaultOutboundAction Block
  $state = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
  $state.rules = @($rules | ForEach-Object { "$prefix-$($_.suffix)" })
  $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $StateFile -Encoding UTF8 -NoNewline
  $state | ConvertTo-Json -Depth 8
  exit 0
}

if (-not (Test-Path -LiteralPath $StateFile)) { throw 'FIREWALL_STATE_MISSING' }
$state = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
if ($state.runId -ne $RunId) { throw 'FIREWALL_RUN_MISMATCH' }
if ($Action -eq 'remove') {
  if ($null -ne $state.watchdogPid -and [int]$state.watchdogPid -ne $PID) {
    Stop-Process -Id ([int]$state.watchdogPid) -Force -ErrorAction SilentlyContinue
  }
  Get-NetFirewallRule -DisplayName "$prefix-*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  foreach ($profile in $state.snapshot.profiles) {
    Set-NetFirewallProfile -Profile $profile.Name -Enabled $profile.Enabled `
      -DefaultInboundAction $profile.DefaultInboundAction -DefaultOutboundAction $profile.DefaultOutboundAction
  }
  $after = Get-PolicySnapshot
  if ($after.hash -ne $state.snapshot.hash) { throw 'FIREWALL_RESTORE_UNPROVEN' }
  Remove-Item -LiteralPath $StateFile -Force
  @{ runId = $RunId; removed = $true; policyHashBefore = $state.snapshot.hash; policyHashAfter = $after.hash } | ConvertTo-Json -Compress
  exit 0
}
