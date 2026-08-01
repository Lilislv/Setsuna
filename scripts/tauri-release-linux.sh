#!/usr/bin/env bash
set -euo pipefail

# Local Linux release build. Works around two linuxdeploy problems that only
# show up outside CI; on a clean machine this is just `tauri build`.
#
# 1. The bundled `strip` is too old to read the .relr.dyn sections that current
#    toolchains (Arch, CachyOS) emit, so it fails on every deployed library.
# 2. The gtk plugin locates libgdk_pixbuf with a *recursive* `find` over the
#    gdk-pixbuf libdir, so any unrelated GTK copy under /usr/lib wins over the
#    system one. VMware Workstation ships such a copy in /usr/lib/vmware/lib,
#    and it still links the long-removed libcroco, which aborts bundling.

export NO_STRIP="${NO_STRIP:-true}"

cmd=(npx tauri build --config src-tauri/tauri.release.conf.json "$@")

if [ -d /usr/lib/vmware ]; then
    if command -v bwrap >/dev/null 2>&1; then
        echo "Hiding /usr/lib/vmware for this build (it breaks linuxdeploy's gtk plugin)."
        exec bwrap --dev-bind / / --tmpfs /usr/lib/vmware -- "${cmd[@]}"
    fi
    echo "warning: /usr/lib/vmware exists and bubblewrap is not installed." >&2
    echo "warning: AppImage bundling will likely fail. Install bubblewrap to work around it." >&2
fi

exec "${cmd[@]}"
