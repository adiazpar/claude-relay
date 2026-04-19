#!/usr/bin/env bash
# Enumerate URLs the relay is reachable on, and print a "best" recommendation.
# Usage: print-url.sh <port>
# Transport-agnostic: any mesh VPN (Tailscale, ZeroTier, Nebula) that adds an
# IP to this machine appears automatically. We don't special-case anything
# beyond Tailscale for cosmetic labeling and the "best URL" ranking.

set -euo pipefail

PORT="${1:-3001}"
OS="$(uname -s)"

# Collect results as "host<TAB>label" lines. The "best" URL is the first
# entry in the array after priority-ordered collection.
urls=()

# ---- Tailscale ----
if command -v tailscale >/dev/null 2>&1; then
  ts_name=""
  if command -v jq >/dev/null 2>&1; then
    ts_name="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' | sed 's/\.$//')"
  fi
  ts_ip4="$(tailscale ip --4 2>/dev/null | head -n 1 || true)"

  if [ -n "$ts_name" ]; then
    urls+=("$ts_name	Tailscale (MagicDNS)")
  fi
  if [ -n "$ts_ip4" ]; then
    urls+=("$ts_ip4	Tailscale IPv4")
  fi
fi

# ---- mDNS (.local) ----
hostname_short="$(hostname -s 2>/dev/null || hostname)"
if [ -n "$hostname_short" ]; then
  urls+=("$hostname_short.local	mDNS / same Wi-Fi")
fi

# ---- LAN IPv4s ----
# Skip loopback (127.*), link-local (169.254.*), and the Tailscale CGNAT
# range (100.64.0.0/10 which covers 100.64.* through 100.127.*). The
# CGNAT range is Tailscale's allocation; those IPs are already handled
# above with the correct "Tailscale IPv4" label.
skip_cgnat() {
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
  if command -v jq >/dev/null 2>&1; then
    ip -j addr 2>/dev/null | jq -r '.[].addr_info[]? | select(.family == "inet") | .local'
  else
    ip -4 addr 2>/dev/null | awk '/inet [0-9]/ {print $2}' | cut -d/ -f1
  fi
}

case "$OS" in
  Darwin) collector=collect_lan_darwin ;;
  Linux)  collector=collect_lan_linux ;;
  *)      collector= ;;
esac

if [ -n "$collector" ]; then
  while IFS= read -r ip; do
    [ -z "$ip" ] && continue
    if skip_cgnat "$ip"; then continue; fi
    urls+=("$ip	LAN")
  done < <("$collector")
fi

# ---- Print ----
if [ "${#urls[@]}" -eq 0 ]; then
  echo "Claude Relay running on port $PORT."
  echo "(Could not detect any network interfaces. Open http://<this-machine>:$PORT on your phone.)"
  exit 0
fi

best_host="$(printf '%s\n' "${urls[0]}" | cut -f1)"
echo "Claude Relay running."
echo ""
echo "Open this on your phone:"
echo ""
echo "    http://$best_host:$PORT"
echo ""

if [ "${#urls[@]}" -gt 1 ]; then
  echo "If that doesn't load, try one of these instead:"
  echo ""
  for i in $(seq 1 $((${#urls[@]} - 1))); do
    line="${urls[$i]}"
    host="$(printf '%s' "$line" | cut -f1)"
    label="$(printf '%s' "$line" | cut -f2)"
    printf "    http://%s:%s   (%s)\n" "$host" "$PORT" "$label"
  done
  echo ""
fi

echo "Your phone needs to reach this machine via one of these routes —"
echo "Tailscale, same Wi-Fi, or another network you've set up."
