#!/usr/bin/env bash
# Remove the ibus-longpress engine and restore the plain US layout.
set -euo pipefail

python3 - <<'EOF'
import ast, subprocess
cur = subprocess.check_output(
    ['gsettings', 'get', 'org.gnome.desktop.input-sources', 'sources'])
sources = ast.literal_eval(cur.decode())
new = [('xkb', 'us') if s == ('ibus', 'longpress-us') else s for s in sources]
if ('xkb', 'us') not in new:
    new.insert(0, ('xkb', 'us'))
subprocess.check_call(
    ['gsettings', 'set', 'org.gnome.desktop.input-sources', 'sources',
     str(new)])
print('input sources are now:', new)
EOF

sudo rm -f /usr/share/ibus/component/longpress.xml
ibus restart
echo "Done. ibus-longpress removed."
