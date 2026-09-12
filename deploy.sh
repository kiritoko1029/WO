#!/usr/bin/env bash
# Docker performs configuration/builds; only Bash, Docker Compose and Git are needed.
set -euo pipefail
WO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$WO_ROOT"
command -v docker >/dev/null || { echo 'Install Docker Engine and the Docker Compose plugin first.' >&2; exit 1; }
command -v git >/dev/null || { echo 'Install Git and run this script from its cloned repository.' >&2; exit 1; }
[[ "$(docker info --format '{{.OSType}}')" == linux ]] || { echo 'A Linux Docker engine is required.' >&2; exit 1; }
docker compose version >/dev/null
WO_LOCAL=false
WO_HELP=false
for WO_ARGUMENT in "$@"; do
  [[ "$WO_ARGUMENT" != --local ]] || WO_LOCAL=true
  [[ "$WO_ARGUMENT" != --help ]] || WO_HELP=true
done
if [[ "$(uname -s)" != Linux && "$WO_LOCAL" != true && "$WO_HELP" != true ]]; then
  echo 'Production requires a Linux host. Use --local for Docker Desktop testing.' >&2
  exit 1
fi
WO_LOCK="$WO_ROOT/deploy/.wo-release-apply.lock"
mkdir "$WO_LOCK" 2>/dev/null || { echo 'Another deployment operation is running. Check it before removing deploy/.wo-release-apply.lock.' >&2; exit 1; }
trap 'rmdir "$WO_LOCK" 2>/dev/null || true' EXIT
WO_HELPER=(run --rm --init --mount "type=bind,source=$WO_ROOT,target=/workspace" --workdir /workspace)
if [[ -t 0 && -t 1 ]]; then WO_HELPER+=(-it); else WO_HELPER+=(-i); fi
if [[ "$(uname -s)" == Linux ]]; then WO_HELPER+=(--user "$(id -u):$(id -g)"); fi
WO_HELPER+=(node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059 node deploy/scripts/setup.mjs)
docker "${WO_HELPER[@]}" "$@" --prepare-only
[[ "$WO_HELP" != true ]] || exit 0
WO_PLAN="$WO_ROOT/deploy/.managed/launch-plan"
# Prevent ambient application variables overriding the selected generated env file.
while IFS= read -r WO_KEY; do
  [[ "$WO_KEY" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo 'Invalid setup plan.' >&2; exit 1; }
  unset "$WO_KEY"
done < "$WO_PLAN/environment-keys"
WO_COUNT="$(< "$WO_PLAN/count")"
[[ "$WO_COUNT" =~ ^[0-9]+$ ]] || { echo 'Invalid setup plan.' >&2; exit 1; }
if ((WO_COUNT > 0)); then
  WO_PROJECT="$(< "$WO_PLAN/project")"
  WO_DEPLOYMENT_ID="$(< "$WO_PLAN/deployment-id")"
  WO_CONTAINERS="$(docker ps --all --no-trunc --quiet --filter "label=com.docker.compose.project=$WO_PROJECT")"
  WO_VOLUMES="$(docker volume ls --quiet --filter "name=^${WO_PROJECT}_")"
  for WO_KIND in container volume; do
    if [[ "$WO_KIND" == container ]]; then
      WO_RESOURCES="$WO_CONTAINERS"
      WO_LABEL='{{ index .Config.Labels "io.wo.managed.deployment-id" }}'
    else
      WO_RESOURCES="$WO_VOLUMES"
      WO_LABEL='{{ index .Labels "io.wo.managed.deployment-id" }}'
    fi
    while IFS= read -r WO_RESOURCE; do
      [[ -n "$WO_RESOURCE" ]] || continue
      WO_OWNER="$(docker "$WO_KIND" inspect --format "$WO_LABEL" "$WO_RESOURCE")"
      [[ "$WO_OWNER" == "$WO_DEPLOYMENT_ID" ]] || { echo 'This Compose project contains resources from another deployment. Choose another --project and state directory; existing resources were preserved.' >&2; exit 1; }
    done <<< "$WO_RESOURCES"
  done
fi
for ((WO_INDEX=0; WO_INDEX<WO_COUNT; WO_INDEX++)); do
  WO_ARGS=()
  while IFS= read -r WO_ARGUMENT; do WO_ARGS+=("$WO_ARGUMENT"); done < "$WO_PLAN/$WO_INDEX.args"
  docker "${WO_ARGS[@]}"
done
if [[ "$(< "$WO_PLAN/finish")" == yes ]]; then
  docker "${WO_HELPER[@]}" "$@" --finish
fi
