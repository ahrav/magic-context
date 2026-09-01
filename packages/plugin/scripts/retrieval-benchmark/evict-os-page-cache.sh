#!/usr/bin/env sh
#
# Writing `/proc/sys/vm/drop_caches` requires effective UID 0.
# `sudo -n` fails instead of prompting when authentication is required.
set -eu

sync
if [ "$(id -u)" -eq 0 ]; then
    echo 3 > /proc/sys/vm/drop_caches
else
    echo 3 | sudo -n tee /proc/sys/vm/drop_caches > /dev/null
fi
echo "drop_caches=3"
