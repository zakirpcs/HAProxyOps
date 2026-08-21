#!/usr/bin/env bash
# Prepare one HAProxy node for management by HAProxyOps. Run as root.
#
# Idempotent: safe to re-run. Does NOT edit haproxy.cfg for you - review
# deploy/haproxy-node/haproxy-snippet.cfg and merge it yourself, because
# every fleet's config layout differs.
set -euo pipefail

DASHBOARD_IP="${DASHBOARD_IP:?set DASHBOARD_IP to the dashboard server's address}"
DPAPI_PORT="${DPAPI_PORT:-5555}"
STATS_PORT="${STATS_PORT:-8404}"

echo "==> Installing HAProxy and the Data Plane API"
dnf install -y haproxy haproxy-dataplaneapi || {
  echo "haproxy-dataplaneapi not in the configured repos."
  echo "Enable the HAProxy Enterprise/HAProxyTech repo, or install the upstream"
  echo "dataplaneapi binary into /usr/local/bin and re-run."
  exit 1
}

echo "==> Creating transaction directory"
install -d -o haproxy -g haproxy -m 0750 /var/lib/haproxy/dataplane-transactions

echo "==> Opening the firewall to the dashboard only"
firewall-cmd --permanent --add-rich-rule \
  "rule family=ipv4 source address=${DASHBOARD_IP}/32 port port=${DPAPI_PORT} protocol=tcp accept"
firewall-cmd --permanent --add-rich-rule \
  "rule family=ipv4 source address=${DASHBOARD_IP}/32 port port=${STATS_PORT} protocol=tcp accept"
firewall-cmd --reload

if selinuxenabled 2>/dev/null; then
  echo "==> SELinux is enforcing; allowing HAProxy to bind the management ports"
  semanage port -a -t http_port_t -p tcp "${DPAPI_PORT}" 2>/dev/null || \
    semanage port -m -t http_port_t -p tcp "${DPAPI_PORT}"
  semanage port -a -t http_port_t -p tcp "${STATS_PORT}" 2>/dev/null || \
    semanage port -m -t http_port_t -p tcp "${STATS_PORT}"
  # dataplaneapi shells out to systemctl to reload haproxy.
  setsebool -P daemons_enable_cluster_mode on 2>/dev/null || true
fi

echo "==> Validating the HAProxy config"
haproxy -c -f /etc/haproxy/haproxy.cfg

echo "==> Enabling services"
systemctl enable --now haproxy
systemctl enable --now dataplaneapi

echo
echo "Done. Register this node in HAProxyOps with:"
echo "  base_url = https://$(hostname -f):${DPAPI_PORT}"
echo "  driver   = dataplane"
