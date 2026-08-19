#!/usr/bin/env sh
# OS page-cache eviction hook for `benchmark-retrieval.ts --evict-os-page-cache`.
# Invoked as `evict-os-page-cache.sh <snapshot-path>`; stdout becomes the
# recorded eviction proof, so it prints the mechanism it used.
#
# Dropping the kernel page cache needs root; a reference-host runner account
# must either be root or hold passwordless sudo for tee to
# /proc/sys/vm/drop_caches. `sudo -n` fails fast instead of prompting.
set -eu

sync
if [ "$(id -u)" -eq 0 ]; then
    echo 3 > /proc/sys/vm/drop_caches
else
    echo 3 | sudo -n tee /proc/sys/vm/drop_caches > /dev/null
fi
echo "drop_caches=3"
