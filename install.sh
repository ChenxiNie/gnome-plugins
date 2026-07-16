#!/usr/bin/env bash
# Install (copy) the GNOME Shell extensions into this user's extension dir
# and try to enable them. On Wayland, newly installed extensions are only
# picked up at login — log out and back in, then rerun the enable commands
# printed below if needed.
#
# The long-press accent engine is an IBus engine, not a Shell extension:
# install it separately with long-press-for-German-letters/install.sh.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions"
UUIDS=("headset-indicator@chenxi" "three-finger-drag@chenxi")

for uuid in "${UUIDS[@]}"; do
    mkdir -p "$EXT_DIR/$uuid"
    cp -r "$DIR/$uuid/." "$EXT_DIR/$uuid/"
    echo "installed $uuid"
done

echo
for uuid in "${UUIDS[@]}"; do
    if gnome-extensions enable "$uuid" 2>/dev/null; then
        echo "enabled $uuid"
    else
        echo "could not enable $uuid yet — log out/in, then run:"
        echo "  gnome-extensions enable $uuid"
    fi
done
