#!/bin/sh
# Starts Tiny as the unprivileged `node` user.
#
# A host volume (Railway mounts one at /data) arrives owned by root, so a container that starts as
# `node` cannot write the store into it. Started as root, this hands the store's directory to
# `node` and then drops to it. Started as any other user, it changes nothing and runs as that user.
set -eu

data_dir=$(dirname "${DEMO_DATA_FILE:-/data/demo-store.json}")

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$data_dir"
  chown node:node "$data_dir"
  exec su-exec node "$@"
fi

exec "$@"
