#!/usr/bin/env bash
# Manual public IPv4 ingress check. Never starts a server, bot, or Funnel.
set -euo pipefail

usage() {
  echo 'Usage: bash scripts/check-funnel-public.sh --run HOST.ts.net [443|8443|10000]'
  echo 'Run only with the owner present. Queries public DNS and GET /health over HTTPS.'
}
if [[ ${1:-} == --help || $# == 0 ]]; then usage; exit 0; fi
if [[ ${1:-} != --run || $# -lt 2 || $# -gt 3 ]]; then usage >&2; exit 2; fi
host=$2
port=${3:-443}
if [[ ! $host =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.ts\.net$ || $host == *..* ]]; then
  echo 'Invalid hostname: supply a ts.net hostname without scheme, path, or port.' >&2
  exit 2
fi
case "$port" in 443|8443|10000) ;; *) echo 'Unsupported Funnel port.' >&2; exit 2 ;; esac
for tool in dig curl; do
  command -v "$tool" >/dev/null || { echo "Missing required command: $tool" >&2; exit 2; }
done

# Exclude local/tailnet, reserved and documentation IPv4 ranges. Ignore CNAME rows.
public_ipv4() {
  local ip=$1 a b c d part
  [[ $ip =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  IFS=. read -r a b c d <<< "$ip"
  for part in "$a" "$b" "$c" "$d"; do
    [[ ${#part} -le 3 && ( $part == 0 || $part != 0* ) ]] || return 1
    (( 10#$part <= 255 )) || return 1
  done
  (( a > 0 && a < 224 && a != 10 && a != 127 )) || return 1
  (( !(a == 100 && b >= 64 && b <= 127) && !(a == 169 && b == 254) && !(a == 172 && b >= 16 && b <= 31) )) || return 1
  (( !(a == 192 && (b == 168 || (b == 0 && (c == 0 || c == 2)))) )) || return 1
  (( !(a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100))) && !(a == 203 && b == 0 && c == 113) ))
}

if ! answer=$(dig @8.8.8.8 "$host" A +short +time=3 +tries=1); then
  echo 'INCONCLUSIVE: public DNS query failed; no HTTPS probe sent.' >&2
  exit 1
fi
count=0
failed=0
while IFS= read -r ip; do
  public_ipv4 "$ip" || continue
  count=$((count + 1))
  # -q must be first: ignore curlrc. Ignore proxy env, preserve TLS/SNI/Host,
  # verify the certificate, do not follow redirects or send any credentials.
  if status=$(curl -q --noproxy '*' --proto '=https' --connect-timeout 5 --max-time 15 \
    --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --resolve "$host:$port:$ip" "https://$host:$port/health"); then
    if [[ $status == 200 ]]; then
      echo "PASS: $ip public ingress returned HTTP 200 for /health."
    else
      echo "FAIL: $ip TLS/HTTP reachable, but /health returned HTTP $status (expected 200)."
      failed=1
    fi
  else
    echo "FAIL: $ip HTTPS request failed (DNS succeeded; inspect TLS/connect error above)." >&2
    failed=1
  fi
done <<< "$answer"
if (( count == 0 )); then
  echo 'INCONCLUSIVE: no usable public IPv4 A record; tailnet/private answers are not public-ingress proof.' >&2
  exit 1
fi
echo "Checked $count public IPv4 record(s) from this host; IPv6, WebSocket upgrades and external-client reachability remain unverified."
exit "$failed"
