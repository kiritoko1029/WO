#!/bin/bash
set -euo pipefail

action="${1:?action}"
run_id="${2:?run id}"
turn_address="${3:?turn address}"
turn_udp_port="${4:?turn udp port}"
turn_tls_port="${5:?turn tls port}"
controller_address="${6:?controller address}"
controller_port="${7:?controller port}"
desktop_executable="${8:?desktop executable}"
state_file="${9:?state file}"

[[ "$run_id" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]] || exit 64
[[ "$state_file" = /* && "$desktop_executable" = /* ]] || exit 64
[[ "$EUID" -eq 0 ]] || { echo 'FIREWALL_ELEVATION_REQUIRED' >&2; exit 77; }

anchor="wo.acceptance/$run_id"
policy_hash() {
  /sbin/pfctl -sr 2>/dev/null | /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}'
}

case "$action" in
  install)
    [[ ! -e "$state_file" ]] || { echo 'FIREWALL_STATE_EXISTS' >&2; exit 73; }
    /bin/mkdir -p "$(/usr/bin/dirname "$state_file")"
    before="$(policy_hash)"
    if /sbin/pfctl -s info 2>/dev/null | /usr/bin/grep -q '^Status: Enabled'; then pf_was_enabled=true; else pf_was_enabled=false; fi
    rules_file="${state_file}.rules"
    config_file="${state_file}.pf.conf"
    /bin/cat >"$rules_file" <<EOF
block drop out quick proto { tcp udp } from any to any
pass out quick proto { tcp udp } from any to any port 53
pass out quick proto tcp from any to any port 443
pass out quick proto tcp from any to $controller_address port $controller_port
pass out quick proto udp from any to $turn_address port $turn_udp_port
pass out quick proto tcp from any to $turn_address port $turn_tls_port
EOF
    /bin/cat /etc/pf.conf >"$config_file"
    /usr/bin/printf '\nanchor "wo.acceptance/*"\nload anchor "wo.acceptance/*" from "%s"\n' "$rules_file" >>"$config_file"
    /sbin/pfctl -E >/dev/null 2>&1 || true
    /sbin/pfctl -f "$config_file"
    ( /bin/sleep 900; [[ ! -f "$state_file" ]] || "$0" remove "$run_id" "$turn_address" "$turn_udp_port" "$turn_tls_port" "$controller_address" "$controller_port" "$desktop_executable" "$state_file" ) >/dev/null 2>&1 &
    watchdog_pid="$!"
    /usr/bin/printf '{"runId":"%s","policyHashBefore":"%s","pfWasEnabled":%s,"rulesFile":"%s","configFile":"%s","watchdogArmed":true,"watchdogPid":%s}\n' \
      "$run_id" "$before" "$pf_was_enabled" "$rules_file" "$config_file" "$watchdog_pid" >"$state_file"
    /bin/chmod 600 "$state_file" "$rules_file" "$config_file"
    ;;
  remove)
    [[ -f "$state_file" ]] || { echo 'FIREWALL_STATE_MISSING' >&2; exit 66; }
    before="$(/usr/bin/sed -n 's/.*"policyHashBefore":"\([a-f0-9]*\)".*/\1/p' "$state_file")"
    watchdog_pid="$(/usr/bin/sed -n 's/.*"watchdogPid":\([0-9]*\).*/\1/p' "$state_file")"
    pf_was_enabled="$(/usr/bin/sed -n 's/.*"pfWasEnabled":\(true\|false\).*/\1/p' "$state_file")"
    if [[ -n "$watchdog_pid" && "$watchdog_pid" != "$$" ]]; then /bin/kill "$watchdog_pid" 2>/dev/null || true; fi
    /sbin/pfctl -a "$anchor" -F all
    /sbin/pfctl -f /etc/pf.conf
    if [[ "$pf_was_enabled" = false ]]; then /sbin/pfctl -d; fi
    /bin/rm -f "${state_file}.rules" "${state_file}.pf.conf" "$state_file"
    after="$(policy_hash)"
    [[ "$before" = "$after" ]] || { echo 'FIREWALL_RESTORE_UNPROVEN' >&2; exit 70; }
    /usr/bin/printf '{"runId":"%s","removed":true,"policyHashBefore":"%s","policyHashAfter":"%s"}\n' "$run_id" "$before" "$after"
    ;;
  status)
    /sbin/pfctl -a "$anchor" -sr
    ;;
  *) exit 64 ;;
esac
