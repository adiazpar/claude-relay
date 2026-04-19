#!/usr/bin/env bash
# Enumerate URLs the relay is reachable on, grouped by reachability.
# Usage: print-url.sh <port>
# Transport-agnostic: any mesh VPN (Tailscale, ZeroTier, Nebula) that adds
# an IP to this machine appears automatically. We only special-case
# Tailscale for labeling and for the "reachable from anywhere" grouping.

set -euo pipefail

PORT="${1:-3001}"
OS="$(uname -s)"

# Two buckets:
#   remote_urls: reachable from anywhere (Tailscale / mesh VPNs)
#   local_urls:  reachable only on the same physical network (mDNS, LAN)
remote_urls=()
local_urls=()

# ---- Tailscale (MagicDNS + IPv4) ----
# Parse `tailscale status --json` without jq. The Self block is emitted
# before Peer, so the first "DNSName" field is always Self's FQDN.
# Format: "DNSName": "<host>.<tailnet>.ts.net."
if command -v tailscale >/dev/null 2>&1; then
  ts_name="$(tailscale status --json 2>/dev/null \
    | grep -o '"DNSName":[[:space:]]*"[^"]*"' \
    | head -n 1 \
    | cut -d'"' -f4 \
    | sed 's/\.$//' || true)"
  ts_ip4="$(tailscale ip --4 2>/dev/null | head -n 1 || true)"

  if [ -n "$ts_name" ]; then
    remote_urls+=("$ts_name	Tailscale MagicDNS")
  fi
  if [ -n "$ts_ip4" ]; then
    remote_urls+=("$ts_ip4	Tailscale IPv4")
  fi
fi

# ---- mDNS (<hostname>.local) ----
# Only advertise if mDNS is actually running. macOS has mDNSResponder
# built in. Linux needs avahi-daemon, which is NOT default on headless
# servers (Ubuntu Server, most cloud images, containers, OrbStack VMs).
mdns_available() {
  case "$OS" in
    Darwin) return 0 ;;
    Linux)
      pgrep -x avahi-daemon >/dev/null 2>&1 && return 0
      systemctl is-active avahi-daemon >/dev/null 2>&1 && return 0
      return 1
      ;;
    *) return 1 ;;
  esac
}

if mdns_available; then
  hostname_short="$(hostname -s 2>/dev/null || hostname)"
  if [ -n "$hostname_short" ]; then
    local_urls+=("$hostname_short.local	via mDNS")
  fi
fi

# ---- LAN IPv4s ----
# Skip loopback (127.*), link-local (169.254.*), and the Tailscale CGNAT
# range (100.64.0.0/10, covering 100.64.* through 100.127.*) since those
# are already surfaced as Tailscale above.
skip_ip() {
  local ip="$1"
  case "$ip" in
    127.*|169.254.*) return 0 ;;
    100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*) return 0 ;;
  esac
  return 1
}

collect_lan_darwin() {
  ifconfig 2>/dev/null | awk '/inet [0-9]/ {print $2}'
}

collect_lan_linux() {
  ip -4 addr 2>/dev/null | awk '/inet [0-9]/ {print $2}' | cut -d/ -f1
}

case "$OS" in
  Darwin) collector=collect_lan_darwin ;;
  Linux)  collector=collect_lan_linux ;;
  *)      collector= ;;
esac

if [ -n "$collector" ]; then
  while IFS= read -r ip; do
    [ -z "$ip" ] && continue
    if skip_ip "$ip"; then continue; fi
    local_urls+=("$ip	direct IP")
  done < <("$collector")
fi

# ---- Print ----
total=$((${#remote_urls[@]} + ${#local_urls[@]}))
if [ "$total" -eq 0 ]; then
  echo "Claude Relay running on port $PORT."
  echo "(Could not detect any network interfaces. Open http://<this-machine>:$PORT on your phone.)"
  exit 0
fi

echo "Claude Relay running."
echo ""

if [ "${#remote_urls[@]}" -gt 0 ]; then
  echo "Reachable from anywhere (via Tailscale):"
  for line in "${remote_urls[@]}"; do
    host="$(printf '%s' "$line" | cut -f1)"
    label="$(printf '%s' "$line" | cut -f2)"
    printf "    http://%s:%s   (%s)\n" "$host" "$PORT" "$label"
  done
  echo ""
fi

if [ "${#local_urls[@]}" -gt 0 ]; then
  if [ "${#remote_urls[@]}" -gt 0 ]; then
    echo "Reachable only on the same network (fallback):"
  else
    echo "Reachable only on the same network:"
  fi
  for line in "${local_urls[@]}"; do
    host="$(printf '%s' "$line" | cut -f1)"
    label="$(printf '%s' "$line" | cut -f2)"
    printf "    http://%s:%s   (%s)\n" "$host" "$PORT" "$label"
  done
  echo ""
fi

# Gentle nudge if no "from anywhere" option was found.
if [ "${#remote_urls[@]}" -eq 0 ]; then
  echo "For access outside your local network, set up Tailscale."
  echo "See the Tailscale section of the README for the full walkthrough."
  echo ""
fi
