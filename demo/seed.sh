#!/usr/bin/env bash
# Register the demo HAProxy node with a freshly started dashboard.
# Idempotent: re-running is a no-op if the node already exists.
set -euo pipefail

API="${API:-http://127.0.0.1:8000}"
USER="${ADMIN_USER:-admin}"
PASS="${ADMIN_PASS:-haproxyops}"

TOKEN=$(curl -sf -X POST "${API}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${USER}\",\"password\":\"${PASS}\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')

register() {
  local name="$1" group="$2" host="$3"
  if curl -sf "${API}/api/nodes" -H "Authorization: Bearer ${TOKEN}" \
       | grep -q "\"name\": *\"${name}\""; then
    echo "  ${name}: already registered"
    return
  fi
  curl -sf -X POST "${API}/api/nodes" \
    -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' \
    -d "{
          \"name\": \"${name}\",
          \"group\": \"${group}\",
          \"driver\": \"dataplane\",
          \"base_url\": \"http://${host}:5555\",
          \"api_prefix\": \"/v3\",
          \"username\": \"haproxyops\",
          \"password\": \"demo-password\",
          \"verify_tls\": false
        }" > /dev/null
  echo "  ${name}: registered"
}

register lb-edge-1     edge     haproxy-demo
register lb-edge-2     edge     haproxy-demo-2
register lb-internal-1 internal haproxy-demo-3
register lb-internal-2 internal haproxy-demo-4

echo "Nodes appear in the fleet after the next poll."
