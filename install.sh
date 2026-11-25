#!/usr/bin/env bash
# Install the Claude Code Quota GNOME Shell extension.
#   ./install.sh          symlink (development: edits apply after reloading the shell)
#   ./install.sh --copy   copy files instead of symlinking
set -euo pipefail

UUID="claude-code-quota@gnome-extension"
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

glib-compile-schemas --strict "$SRC/schemas"

mkdir -p "$(dirname "$DEST")"
if [ "${1:-}" = "--copy" ]; then
  rm -rf "$DEST"
  cp -r "$SRC" "$DEST"
  echo "Copied to $DEST"
else
  if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
    echo "A real directory already exists at $DEST — remove it or use --copy." >&2
    exit 1
  fi
  ln -sfn "$SRC" "$DEST"
  echo "Linked $DEST -> $SRC"
fi

# Enable now if the shell already knows the extension, otherwise add it to the
# enabled list so it starts after the next shell reload.
if ! gnome-extensions enable "$UUID" 2>/dev/null; then
  python3 - "$UUID" <<'EOF'
import ast, subprocess, sys
uuid = sys.argv[1]
raw = subprocess.check_output(["gsettings", "get", "org.gnome.shell", "enabled-extensions"]).decode()
cur = ast.literal_eval(raw.replace("@as ", ""))
if uuid not in cur:
    cur.append(uuid)
    subprocess.check_call(["gsettings", "set", "org.gnome.shell", "enabled-extensions", str(cur)])
EOF
  echo "Added $UUID to enabled extensions."
fi

cat <<EOF

Reload GNOME Shell for changes to take effect:
  X11:     Alt+F2, type r, Enter
  Wayland: log out and back in
Settings: gnome-extensions prefs $UUID
EOF
