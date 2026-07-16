#!/usr/bin/env bash
# Install the ibus-longpress engine system-wide (component XML only; the
# engine itself runs from this directory, so edits here take effect after
# an `ibus restart`).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Installing dependencies (python3-gi, gir1.2-ibus-1.0)"
sudo apt-get install -y python3-gi gir1.2-ibus-1.0

chmod +x "$DIR/engine.py"

echo "==> Registering the IBus component"
sed "s|@ENGINE_EXEC@|$DIR/engine.py|" "$DIR/longpress.xml.in" \
    | sudo tee /usr/share/ibus/component/longpress.xml >/dev/null

echo "==> Restarting the ibus daemon"
ibus restart
sleep 2

if ! ibus list-engine 2>/dev/null | grep -q longpress-us; then
    echo "ERROR: engine did not register with ibus" >&2
    exit 1
fi
echo "==> Engine registered: longpress-us"

echo "==> Adding it to your input sources (replacing plain 'English (US)')"
python3 - <<'EOF'
import ast, subprocess
cur = subprocess.check_output(
    ['gsettings', 'get', 'org.gnome.desktop.input-sources', 'sources'])
sources = ast.literal_eval(cur.decode())
new = [('ibus', 'longpress-us') if s == ('xkb', 'us') else s for s in sources]
if ('ibus', 'longpress-us') not in new:
    new.insert(0, ('ibus', 'longpress-us'))
subprocess.check_call(
    ['gsettings', 'set', 'org.gnome.desktop.input-sources', 'sources',
     str(new)])
print('input sources are now:', new)
EOF

echo
echo "Done. Switch to 'English (US, long-press accents)' with Super+Space,"
echo "then hold a, o, u or s in any app."
