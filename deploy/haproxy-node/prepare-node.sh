#!/usr/bin/env bash
# Prepare one HAProxy node for management by HAProxyOps. Run as root.
#
# Idempotent: safe to re-run. Does NOT edit haproxy.cfg for you - review
# deploy/haproxy-node/haproxy-snippet.cfg and merge it yourself, because
# every fleet's config layout differs.
set -euo pipefail

DASHBOARD_IP="${DASHBOARD_IP:?set DASHBOARD_IP to the dashboard servers address}"
DPAPI_PORT="${DPAPI_PORT:-5555}"
STATS_PORT="${STATS_PORT:-8404}"
#: Upstream release to fall back to when haproxy-dataplaneapi is not in any
#: configured repo. Bump by overriding the env var, not by editing this file.
DPAPI_VERSION="${DPAPI_VERSION:-3.4.2}"

# Fetch the upstream .rpm release directly from GitHub and install it with
# dnf, rather than the raw binary tarball: the .rpm ships its own systemd
# unit (EnvironmentFile=/etc/default/dataplaneapi, ExecStart=/usr/sbin/
# dataplaneapi $SYSD_OPTIONS) and default config at
# /etc/dataplaneapi/dataplaneapi.yml - not /etc/haproxy/dataplaneapi.yml.
# Verified against the real package layout on HAProxy Data Plane API v3.4.2.
install_dataplaneapi_from_github() {
  local arch dpapi_arch tmp
  arch="$(uname -m)"
  case "$arch" in
    x86_64) dpapi_arch=linux_x86_64 ;;
    aarch64) dpapi_arch=linux_arm64 ;;
    *)
      echo "No upstream dataplaneapi release for architecture '${arch}'."
      echo "See https://github.com/haproxytech/dataplaneapi/releases/tag/v${DPAPI_VERSION}"
      echo "for the full asset list and install manually."
      exit 1
      ;;
  esac

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  local url="https://github.com/haproxytech/dataplaneapi/releases/download/v${DPAPI_VERSION}/dataplaneapi_${DPAPI_VERSION}_${dpapi_arch}.rpm"
  echo "    downloading ${url}"
  curl -fsSL -o "${tmp}/dataplaneapi.rpm" "${url}"
  dnf install -y "${tmp}/dataplaneapi.rpm"

  echo "    installed. Config lives at /etc/dataplaneapi/dataplaneapi.yml -"
  echo "    confirm with: cat /etc/default/dataplaneapi"
}

echo "==> Installing HAProxy"
dnf install -y haproxy

echo "==> Installing the Data Plane API"
if dnf install -y haproxy-dataplaneapi 2>/dev/null; then
  echo "Installed haproxy-dataplaneapi from the configured repos."
else
  echo "haproxy-dataplaneapi not in the configured repos."
  echo "Falling back to the upstream .rpm release from GitHub (v${DPAPI_VERSION})."
  install_dataplaneapi_from_github
fi

echo "==> Creating transaction and backup directories"
# Paths match the dataplaneapi.yml default (transaction:/resources:). The
# package's own postinstall/first-run creates "transactions" but not
# "backups" - create both explicitly rather than relying on that.
# dataplaneapi's unit has no User= (runs as root), so root ownership is fine.
install -d -m 0750 /var/lib/dataplaneapi/transactions /var/lib/dataplaneapi/backups

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
echo "Done. Merge haproxy-snippet.cfg (with a real userlist password) and"
echo "dataplaneapi.yml (see README for the config path) before starting"
echo "dataplaneapi, then register this node in HAProxyOps with:"
echo "  base_url = http://$(hostname -f):${DPAPI_PORT}   (or https:// if you added TLS)"
echo "  driver   = dataplane"
