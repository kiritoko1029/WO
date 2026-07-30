#!/bin/bash
set -euo pipefail

action="${1:?action}"
run_id="${2:?run id}"
turn_address="${3:?turn address}"
turn_udp_port="${4:?turn udp port}"
turn_tls_port="${5:?turn tls port}"
turn_relay_min_port="${6:?turn relay minimum port}"
turn_relay_max_port="${7:?turn relay maximum port}"
controller_address="${8:?controller address}"
controller_port="${9:?controller port}"
desktop_executable="${10:?desktop executable}"
state_file="${11:?state file}"

[[ "$run_id" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]] || exit 64
[[ "$state_file" = /* && "$desktop_executable" = /* ]] || exit 64
for port in "$turn_udp_port" "$turn_tls_port" "$turn_relay_min_port" "$turn_relay_max_port" "$controller_port"; do
  [[ "$port" =~ ^[1-9][0-9]{0,4}$ ]] && (( port <= 65535 )) || exit 64
done
(( turn_relay_min_port <= turn_relay_max_port )) || exit 64
(( turn_udp_port != turn_tls_port )) || exit 64
for listener_port in "$turn_udp_port" "$turn_tls_port"; do
  (( listener_port < turn_relay_min_port || listener_port > turn_relay_max_port )) || exit 64
done
[[ "$EUID" -eq 0 ]] || { echo 'FIREWALL_ELEVATION_REQUIRED' >&2; exit 77; }

anchor="wo.acceptance/$run_id"
label_prefix="wo-acceptance-"
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
pass out quick proto udp from any to any port 53 label "${label_prefix}dns-udp"
pass out quick proto tcp from any to any port 53 label "${label_prefix}dns-tcp"
pass out quick proto tcp from any to any port 443 label "${label_prefix}https"
pass out quick proto tcp from any to $controller_address port $controller_port label "${label_prefix}controller"
pass out quick proto udp from any to $turn_address port $turn_udp_port label "${label_prefix}turn-udp"
pass out quick proto tcp from any to $turn_address port $turn_udp_port label "${label_prefix}turn-tcp"
pass out quick proto tcp from any to $turn_address port $turn_tls_port label "${label_prefix}turn-tls"
pass out quick proto udp from any to $turn_address port $turn_relay_min_port:$turn_relay_max_port label "${label_prefix}turn-relay"
block drop out quick proto { tcp udp } from any to any label "${label_prefix}default-block"
EOF
    /bin/cat /etc/pf.conf >"$config_file"
    /usr/bin/printf '\nanchor "wo.acceptance/*"\nload anchor "wo.acceptance/*" from "%s"\n' "$rules_file" >>"$config_file"
    ( /bin/sleep 900; [[ ! -f "$state_file" ]] || "$0" remove "$run_id" "$turn_address" "$turn_udp_port" "$turn_tls_port" "$turn_relay_min_port" "$turn_relay_max_port" "$controller_address" "$controller_port" "$desktop_executable" "$state_file" ) >/dev/null 2>&1 &
    watchdog_pid="$!"
    /usr/bin/printf '{"runId":"%s","policyHashBefore":"%s","pfWasEnabled":%s,"rulesFile":"%s","configFile":"%s","ruleIds":["dns-udp","dns-tcp","https","controller","turn-udp","turn-tcp","turn-tls","turn-relay"],"watchdogArmed":true,"watchdogPid":%s}\n' \
      "$run_id" "$before" "$pf_was_enabled" "$rules_file" "$config_file" "$watchdog_pid" >"$state_file"
    /bin/chmod 600 "$state_file" "$rules_file" "$config_file"
    if [[ "$pf_was_enabled" = false ]]; then /sbin/pfctl -E >/dev/null; fi
    /sbin/pfctl -f "$config_file"
    ;;
  remove)
    [[ -f "$state_file" ]] || { echo 'FIREWALL_STATE_MISSING' >&2; exit 66; }
    before="$(/usr/bin/sed -n 's/.*"policyHashBefore":"\([a-f0-9]*\)".*/\1/p' "$state_file")"
    watchdog_pid="$(/usr/bin/sed -n 's/.*"watchdogPid":\([0-9]*\).*/\1/p' "$state_file")"
    pf_was_enabled="$(/usr/bin/sed -n 's/.*"pfWasEnabled":\(true\|false\).*/\1/p' "$state_file")"
    [[ "$before" =~ ^[a-f0-9]{64}$ && "$watchdog_pid" =~ ^[0-9]+$ && "$pf_was_enabled" =~ ^(true|false)$ ]] || exit 66
    if [[ -n "$watchdog_pid" && "$watchdog_pid" != "$$" ]]; then /bin/kill "$watchdog_pid" 2>/dev/null || true; fi
    /sbin/pfctl -a "$anchor" -F all
    /sbin/pfctl -f /etc/pf.conf
    if [[ "$pf_was_enabled" = false ]] && /sbin/pfctl -s info 2>/dev/null | /usr/bin/grep -q '^Status: Enabled'; then /sbin/pfctl -d; fi
    after="$(policy_hash)"
    [[ "$before" = "$after" ]] || { echo 'FIREWALL_RESTORE_UNPROVEN' >&2; exit 70; }
    /bin/rm -f "${state_file}.rules" "${state_file}.pf.conf" "$state_file"
    /usr/bin/printf '{"runId":"%s","removed":true,"policyHashBefore":"%s","policyHashAfter":"%s"}\n' "$run_id" "$before" "$after"
    ;;
  status)
    loaded_rules="$(/sbin/pfctl -a "$anchor" -sr)"
    rule_count="$(/usr/bin/printf '%s\n' "$loaded_rules" | /usr/bin/awk 'NF { count += 1 } END { print count + 0 }')"
    installed_rule_ids=''
    separator=''
    for rule_id in dns-udp dns-tcp https controller turn-udp turn-tcp turn-tls turn-relay; do
      if /usr/bin/printf '%s\n' "$loaded_rules" | /usr/bin/grep -Fq "label \"${label_prefix}${rule_id}\""; then
        installed_rule_ids="${installed_rule_ids}${separator}\"${rule_id}\""
        separator=','
      fi
    done
    if /usr/bin/printf '%s\n' "$loaded_rules" | /usr/bin/grep -Fq "label \"${label_prefix}default-block\""; then default_block_installed=true; else default_block_installed=false; fi
    /usr/bin/printf '{"runId":"%s","elevated":true,"installedRuleIds":[%s],"ruleCount":%s,"defaultBlockInstalled":%s}\n' \
      "$run_id" "$installed_rule_ids" "$rule_count" "$default_block_installed"
    ;;
  *) exit 64 ;;
esac
