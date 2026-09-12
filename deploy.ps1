# Docker performs configuration/builds; no local Node.js installation is needed.
$ErrorActionPreference = 'Stop'
$woArguments = @($args)
$woRoot = $PSScriptRoot
$woOriginalLocation = Get-Location
$woLock = Join-Path $woRoot 'deploy/.wo-release-apply.lock'
$woAcquiredLock = $false
$woSavedEnvironment = @{}
try {
    Set-Location -LiteralPath $woRoot
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Install Docker Desktop with Linux containers first.' }
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Install Git and run this script from its cloned repository.' }
    $woEngine = & docker info --format '{{.OSType}}'
    if ($LASTEXITCODE -ne 0 -or $woEngine -ne 'linux') { throw 'A running Linux Docker engine is required.' }
    & docker compose version
    if ($LASTEXITCODE -ne 0) { throw 'Install Docker Compose 2.24.4 or newer.' }
    if ($env:OS -eq 'Windows_NT' -and $woArguments -notcontains '--local' -and $woArguments -notcontains '--help') {
        throw 'Production requires a Linux host. Add --local for Docker Desktop testing.'
    }
    if (Test-Path -LiteralPath $woLock) { throw 'Another deployment operation is running. Check it before removing deploy/.wo-release-apply.lock.' }
    New-Item -ItemType Directory -Path $woLock -ErrorAction Stop | Out-Null
    $woAcquiredLock = $true
    $woHelper = @('run', '--rm', '--init', '--mount', "type=bind,source=$woRoot,target=/workspace", '--workdir', '/workspace')
    if (-not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected) { $woHelper += '-it' } else { $woHelper += '-i' }
    $woHelper += @('node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059', 'node', 'deploy/scripts/setup.mjs')
    & docker @woHelper @woArguments --prepare-only
    if ($LASTEXITCODE -ne 0) { throw 'Setup configuration failed. Existing deployment state was preserved.' }
    if ($woArguments -contains '--help') { return }
    $woPlan = Get-Content -LiteralPath (Join-Path $woRoot 'deploy/.managed/launch-plan/plan.json') -Raw | ConvertFrom-Json
    foreach ($woKey in $woPlan.environmentKeys) {
        if ($woKey -notmatch '^[A-Z][A-Z0-9_]*$') { throw 'Invalid setup plan.' }
        $woSavedEnvironment[$woKey] = [Environment]::GetEnvironmentVariable($woKey)
        Remove-Item -LiteralPath "Env:$woKey" -ErrorAction SilentlyContinue
    }
    if ($woPlan.commands.Count -gt 0) {
        $woFilter = "label=com.docker.compose.project=$($woPlan.project)"
        $woContainers = @(& docker ps --all --no-trunc --quiet --filter $woFilter)
        if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect existing Docker containers.' }
        $woVolumes = @(& docker volume ls --quiet --filter "name=^$($woPlan.project)_")
        if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect existing Docker volumes.' }
        foreach ($woKind in @('container', 'volume')) {
            if ($woKind -eq 'container') {
                $woResources = $woContainers
                $woLabel = '{{json .Config.Labels}}'
            } else {
                $woResources = $woVolumes
                $woLabel = '{{json .Labels}}'
            }
            foreach ($woResource in $woResources) {
                $woLabelsJson = & docker $woKind inspect --format $woLabel $woResource
                if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect existing Docker resource ownership.' }
                $woLabels = $woLabelsJson | ConvertFrom-Json
                $woOwner = $woLabels.'io.wo.managed.deployment-id'
                if ($woOwner -ne $woPlan.deploymentId) { throw 'This Compose project contains resources from another deployment. Choose another --project and state directory; existing resources were preserved.' }
            }
        }
    }
    foreach ($woCommand in $woPlan.commands) {
        $woCommandArguments = @($woCommand)
        & docker @woCommandArguments
        if ($LASTEXITCODE -ne 0) { throw 'Deployment command failed. Run status or logs to investigate, then rerun up to resume.' }
    }
    if ($woPlan.finish) {
        & docker @woHelper @woArguments --finish
        if ($LASTEXITCODE -ne 0) { throw 'Services started but the local completion receipt could not be written.' }
    }
} finally {
    foreach ($woKey in $woSavedEnvironment.Keys) {
        if ($null -eq $woSavedEnvironment[$woKey]) { Remove-Item -LiteralPath "Env:$woKey" -ErrorAction SilentlyContinue }
        else { [Environment]::SetEnvironmentVariable($woKey, $woSavedEnvironment[$woKey]) }
    }
    if ($woAcquiredLock) { Remove-Item -LiteralPath $woLock -ErrorAction SilentlyContinue }
    Set-Location -LiteralPath $woOriginalLocation
}
