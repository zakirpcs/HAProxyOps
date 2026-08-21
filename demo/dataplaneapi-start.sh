#!/bin/sh
# Data Plane API launcher for the demo HAProxy node.
#
# --scheme=http is load-bearing. By default dataplaneapi enables both the http
# and https listeners; with no TLS certificate configured, the https listener
# binds an ephemeral port and the process then calls exit(1) with nothing
# logged at any log level. Pinning the scheme to http is what keeps it alive.
# A real node configures TLS instead - see deploy/haproxy-node/dataplaneapi.yml.
#
# The wrapper also exists because HAProxy's `program` section tokenizer mangles
# quoted arguments, so --reload-cmd never arrives intact when written inline.
#
# Config and storage go to /tmp: /etc/haproxy is a symlink into the read-only
# bind-mounted config directory.
exec /usr/local/bin/dataplaneapi \
    --scheme=http \
    --host 0.0.0.0 \
    --port 5555 \
    --haproxy-bin /usr/local/sbin/haproxy \
    --config-file /usr/local/etc/haproxy/haproxy.cfg \
    --reload-cmd "kill -SIGUSR2 1" \
    --restart-cmd "kill -SIGUSR2 1" \
    --reload-delay 5 \
    --userlist dataplane-users \
    -f /tmp/dataplaneapi.yaml \
    --dataplane-storage-dir /tmp/dataplane \
    --log-to stdout \
    --log-level info
