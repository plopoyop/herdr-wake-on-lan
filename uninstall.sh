#!/usr/bin/env bash
# Removes the wake-on-lan mod and its block from every personal layout.
# With the Herdr app closed, it also removes the mod's shared state (learned
# MAC addresses) from shared.json; with the app running, that state stays
# (harmless) until you run this again with the app closed.
set -euo pipefail

# Usage: ./uninstall.sh   (no arguments; --help shows this)
case "${1:-}" in
  "") ;;
  -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
  *) echo "Unknown argument: $1 (./uninstall.sh takes none; see --help)" >&2; exit 1 ;;
esac

app_home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
backups="$app_home/.wake-on-lan-backup/$(date +%Y%m%d-%H%M%S)-uninstall"
status=0

python3 - "$app_home/layouts" "$backups" <<'EOF' || status=1
import json, os, pathlib, shutil, sys, tempfile

def strip(node):
    kids = node.get("children")
    if kids is None:
        return False
    keep = [c for c in kids if c.get("id") != "wake-on-lan" and c.get("content", {}).get("mod") != "wake-on-lan"]
    changed = len(keep) != len(kids)
    node["children"] = keep
    return any([strip(c) for c in keep]) or changed

failed = False
for path in sorted(pathlib.Path(sys.argv[1]).glob("*.json")):
    try:
        doc = json.loads(path.read_text())
        if not strip(doc):
            continue
        os.makedirs(sys.argv[2], exist_ok=True)
        shutil.copy2(path, os.path.join(sys.argv[2], path.name))
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".wake-on-lan-", suffix=".tmp")
        with os.fdopen(fd, "w") as f:
            json.dump(doc, f, indent=2, ensure_ascii=False)
            f.write("\n")
        shutil.copymode(path, tmp)
        os.replace(tmp, path)
        print(f"{path}: Wake on LAN list removed (backup in {sys.argv[2]})")
    except Exception as e:  # one bad layout must not stop the others
        failed = True
        print(f"{path}: skipped ({e})", file=sys.stderr)
sys.exit(1 if failed else 0)
EOF

if [ "$status" -eq 0 ]; then
  rm -rf "$app_home/mods/wake-on-lan"
else
  echo "A layout above couldn't be changed: the mod stays in $app_home/mods/wake-on-lan (a layout may still use it). Fix it, then run this again." >&2
fi

app_running=false
if command -v herdr-app >/dev/null && herdr-app status >/dev/null 2>&1; then app_running=true; fi
shared_file="$app_home/shared.json"
if ! $app_running && [ -f "$shared_file" ]; then
  python3 - "$shared_file" <<'EOF' || status=1
import json, os, shutil, sys, tempfile

path = sys.argv[1]
try:
    with open(path) as f:
        doc = json.load(f)
    keys = [k for k in doc if k.startswith("wake-on-lan.")]
    if keys:
        for k in keys:
            del doc[k]
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".wake-on-lan-", suffix=".tmp")
        with os.fdopen(fd, "w") as f:
            json.dump(doc, f, indent=2, ensure_ascii=False)
        shutil.copymode(path, tmp)
        os.replace(tmp, path)
except (OSError, ValueError) as e:
    sys.exit(f"{path}: wake-on-lan state not removed ({e})")
EOF
elif $app_running; then
  echo "The app is running: the learned MAC addresses stay in $shared_file until you run this again with it closed."
fi

if [ "$status" -ne 0 ]; then
  echo "wake-on-lan removed, but some steps above failed: see the messages." >&2
  exit 1
fi
echo "wake-on-lan removed."
