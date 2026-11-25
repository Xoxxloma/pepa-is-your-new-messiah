#!/usr/bin/env bash
# Linux-only integration test. Uses isolated network namespaces, not host firewall.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run as root on Linux with network namespace support.' >&2; exit 1; }
for tool in ip nft python3 node; do command -v "$tool" >/dev/null; done
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
client="pepa-c-$$"
entry="pepa-r-$$"
exit_node="pepa-x-$$"
echo_pid=
cleanup() {
  if [[ -n $echo_pid ]]; then kill "$echo_pid" 2>/dev/null || true; wait "$echo_pid" 2>/dev/null || true; fi
  for ns in "$client" "$entry" "$exit_node"; do ip netns delete "$ns" 2>/dev/null || true; done
  rm -f "$tmp/rules.nft" "$tmp/reload.nft" "$tmp/ready"
  rmdir "$tmp"
}
trap cleanup EXIT
for ns in "$client" "$entry" "$exit_node"; do ip netns add "$ns"; ip -n "$ns" link set lo up; done
ip -n "$client" link add c0 type veth peer name r0 netns "$entry"
ip -n "$entry" link add r1 type veth peer name x0 netns "$exit_node"
ip -n "$client" addr add 203.0.113.20/24 dev c0
ip -n "$entry" addr add 203.0.113.10/24 dev r0
ip -n "$entry" addr add 198.51.100.1/24 dev r1
ip -n "$exit_node" addr add 198.51.100.20/24 dev x0
ip -n "$client" link set c0 up
ip -n "$entry" link set r0 up
ip -n "$entry" link set r1 up
ip -n "$exit_node" link set x0 up
ip -n "$client" route add default via 203.0.113.10
node --input-type=module - > "$tmp/rules.nft" <<'JS'
import { readFileSync } from 'node:fs';
import { renderRules } from './deploy/lib.js';
console.log(renderRules(JSON.parse(readFileSync('deploy/two-vps.example.json', 'utf8')), 42000));
JS
ip netns exec "$entry" nft --check --file "$tmp/rules.nft"
ip netns exec "$entry" nft --file "$tmp/rules.nft"
ip netns exec "$entry" sysctl -q -w net.ipv4.ip_forward=1
ip netns exec "$exit_node" python3 - "$tmp/ready" <<'PY' &
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(('198.51.100.20', 42000))
open(sys.argv[1], 'w').close()
while True:
    data, peer = s.recvfrom(4096)
    s.sendto(peer[0].encode(), peer)
PY
echo_pid=$!
for attempt in {1..30}; do [[ -f $tmp/ready ]] && break; sleep 0.1; done
[[ -f $tmp/ready ]] || { echo 'Echo server failed to start' >&2; exit 1; }
probe() {
  ip netns exec "$client" python3 - "$@" <<'PY'
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(1)
s.sendto(b'test', (sys.argv[1], int(sys.argv[2])))
try:
    data, peer = s.recvfrom(4096)
except socket.timeout:
    assert sys.argv[3] == 'timeout', 'Relay did not deliver a reply'
else:
    assert sys.argv[3] != 'timeout', 'Unexpected forwarding was permitted'
    assert data.decode() == '198.51.100.1', 'Exit did not see entry SNAT address'
    assert peer == ('203.0.113.10', 51820), 'Client did not see entry address on reply'
PY
}
probe 203.0.113.10 51820 success
probe 198.51.100.20 42000 timeout
{ echo 'delete table ip pepa_relay'; cat "$tmp/rules.nft"; } > "$tmp/reload.nft"
ip netns exec "$entry" nft --file "$tmp/reload.nft"
probe 203.0.113.10 51820 success
ip -n "$exit_node" link set x0 down
probe 203.0.113.10 51820 timeout
ip -n "$exit_node" link set x0 up
ip netns exec "$entry" sysctl -q -w net.ipv4.ip_forward=0
ip netns exec "$entry" nft delete table ip pepa_relay
probe 198.51.100.20 42000 timeout
echo 'OK: DNAT/SNAT, return path, atomic reload, fixed-target isolation and exit failure.'
