#!/usr/bin/env bash
# Install HAProxyOps on a RHEL-family host using Docker. Run as root.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ETC=/etc/haproxyops
SECRETS="${ETC}/secrets"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not installed. Install Docker Engine and the compose plugin first." >&2
  exit 1
fi
docker compose version >/dev/null 2>&1 || {
  echo "The 'docker compose' plugin is missing. Install docker-compose-plugin." >&2
  exit 1
}

echo "==> Installing packages"
dnf install -y nginx policycoreutils-python-utils

echo "==> Building images"
# -f is required: the build files are named Containerfile, which Docker does
# not auto-detect.
docker build -f "${REPO_DIR}/backend/Containerfile"  -t haproxyops-api:latest "${REPO_DIR}/backend"
docker build -f "${REPO_DIR}/frontend/Containerfile" -t haproxyops-web:latest "${REPO_DIR}/frontend"

echo "==> Creating secrets (skipped if they already exist)"
# 0700 so only root can even list the directory.
install -d -m 0700 "${SECRETS}"
umask 077

if [[ ! -f "${SECRETS}/secret_key" ]]; then
  openssl rand -hex 32 > "${SECRETS}/secret_key"
  echo "    Generated a new secret key. Store a copy: node credentials are"
  echo "    encrypted with it and cannot be recovered if it is lost."
fi
if [[ ! -f "${SECRETS}/db_password" ]]; then
  openssl rand -hex 24 > "${SECRETS}/db_password"
  # Compose passes POSTGRES_PASSWORD_FILE, but the API needs the password
  # inline in its connection URL, so the two are written together.
  printf 'postgresql+asyncpg://haproxyops:%s@haproxyops-db:5432/haproxyops' \
    "$(cat "${SECRETS}/db_password")" > "${SECRETS}/database_url"
fi
# Held so it can be printed once at the end; empty on a re-run, because an
# existing secret file is never overwritten.
ADMIN_PASS=""
if [[ ! -f "${SECRETS}/admin_password" ]]; then
  # Alphanumeric only: this gets copied by hand out of a terminal, and shell
  # metacharacters in a password are a support ticket waiting to happen.
  ADMIN_PASS="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-24)"
  printf '%s' "${ADMIN_PASS}" > "${SECRETS}/admin_password"
fi
# 0640, not 0600: the API image runs as uid 1001 with gid 0, so it can only
# read a secret through the root *group*. The 0700 directory above is what
# actually keeps non-root host users out - they cannot traverse into it.
chown -R root:root "${SECRETS}"
chmod 0640 "${SECRETS}"/*

echo "==> Installing the compose project"
install -d -m 0755 "${ETC}"
install -m 0640 "${REPO_DIR}/deploy/docker/docker-compose.yml" "${ETC}/docker-compose.yml"
install -d -m 0750 "${ETC}/certs"

echo "==> Installing the systemd unit"
install -m 0644 "${REPO_DIR}/deploy/docker/haproxyops.service" /etc/systemd/system/

echo "==> Installing the nginx site"
install -m 0644 "${REPO_DIR}/deploy/nginx/haproxyops.conf" /etc/nginx/conf.d/

if selinuxenabled 2>/dev/null; then
  echo "==> Allowing nginx to proxy to the local containers"
  setsebool -P httpd_can_network_connect on
fi

echo "==> Opening the firewall"
firewall-cmd --permanent --add-service=https
firewall-cmd --permanent --add-service=http
firewall-cmd --reload

echo "==> Starting services"
systemctl daemon-reload
systemctl enable --now haproxyops.service
systemctl enable --now nginx

echo
echo "HAProxyOps is up. Sign in at https://$(hostname -f)/ as 'admin'."
if [[ -n "${ADMIN_PASS}" ]]; then
  echo
  echo "    Bootstrap admin password: ${ADMIN_PASS}"
  echo
  echo "    Shown once. Store it now, then change it after first login."
else
  echo "The admin password secret already existed and was left untouched."
  echo "If the account was never created, read it back with:"
  echo "    sudo cat ${SECRETS}/admin_password"
  echo "If the admin already exists, this secret is inert - its password is"
  echo "whatever it was last changed to, and only a signed-in admin can reset it."
fi
