#!/usr/bin/env bash
# Installs the wake-on-lan mod and puts its list under the Spaces list of a
# layout. Herdr's own layouts are read-only, so a shipped one is first
# duplicated as "<name>-wol" (main; terminals and win98 have no Spaces list
# and are refused).
#
# Usage: ./install.sh [--headless | --list] [--mac <machine>=<mac>]... [layout]
#   layout    default: the layout shown now
#   --mac     the network card's own MAC for a machine (as named in
#             `hc machine ls`), when the learned one is wrong or randomised
#   --headless  no list (a 0 px block that draws nothing): another mod
#               shows the Wake buttons, the engine keeps running
#   --list      the list again
# Needs: the Herdr app running, python3.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
backups="$app_home/.wake-on-lan-backup/$(date +%Y%m%d-%H%M%S)"
shipped=(main terminals win98)

layout=""
macs=()
visibility=""

while [ $# -gt 0 ]; do
  case "$1" in
    --mac) [ $# -ge 2 ] || { echo "--mac needs <machine>=<mac>" >&2; exit 1; }; macs+=("$2"); shift ;;
    --mac=*) macs+=("${1#--mac=}") ;;
    --headless) visibility="headless" ;;
    --list) visibility="list" ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    -*) echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
    *) [ -z "$layout" ] || { echo "One layout at most (got '$layout' and '$1')" >&2; exit 1; }; layout="$1" ;;
  esac
  shift
done

command -v herdr-app >/dev/null || { echo "herdr-app not found in PATH" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
herdr-app status >/dev/null 2>&1 || { echo "Start the Herdr app first" >&2; exit 1; }

# 0. Check the arguments before changing anything.
for p in ${macs[@]+"${macs[@]}"}; do
  m="$(printf '%s' "${p#*=}" | tr 'A-F-' 'a-f:')"
  case "$p" in *=*) ;; *) echo "--mac $p: expected <machine>=aa:bb:cc:dd:ee:ff" >&2; exit 1 ;; esac
  [ -n "${p%%=*}" ] && [[ "$m" =~ ^([0-9a-f]{2}:){5}[0-9a-f]{2}$ ]] || { echo "--mac $p: expected <machine>=aa:bb:cc:dd:ee:ff" >&2; exit 1; }
done
if [ -z "$layout" ]; then
  layout="$(herdr-app status | python3 -c 'import json,sys; print(json.load(sys.stdin)["layout"])')"
fi
is_shipped=false
for s in "${shipped[@]}"; do [ "$layout" = "$s" ] && is_shipped=true; done
if ! $is_shipped && [ ! -s "$app_home/layouts/$layout.json" ]; then
  echo "No layout file $app_home/layouts/$layout.json" >&2; exit 1
fi
# The layout the block goes in (a shipped one's clone if it exists, else the
# shipped one, which the clone will copy) must have a Spaces block, or already
# the Wake on LAN one: checked read-only, before anything changes.
source_layout="$app_home/layouts/$layout.json"
if $is_shipped && [ -s "$app_home/layouts/$layout-wol.json" ]; then source_layout="$app_home/layouts/$layout-wol.json"; fi
python3 - "$source_layout" <<'EOF'
import json, sys

def has(node):
    c = node.get("content", {})
    if node.get("id") in ("spaces", "wake-on-lan") or c.get("mod") in ("spaces", "wake-on-lan"):
        return True
    return any(has(k) for k in node.get("children", []))

path = sys.argv[1]
try:
    with open(path) as f:
        doc = json.load(f)
except (OSError, ValueError) as e:
    sys.exit(f"{path}: can't read it ({e})")
if not has(doc):
    sys.exit(f"{path}: no Spaces block to put the list under. Pick a layout with one (Herdr's main has it), or add the block by hand (see the README).")
EOF

# 1. Check the new mod where Herdr doesn't load it, then swap it in (plain
# renames on the same disk: Herdr never sees a half-copied mod).
staging="$(mktemp -d "$app_home/.wake-on-lan-staging.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
cp -r "$here/mods/wake-on-lan" "$staging/wake-on-lan"
rm -rf "$staging/wake-on-lan/__pycache__"
herdr-app check "$staging/wake-on-lan"

mkdir -p "$app_home/mods"
if [ -d "$app_home/mods/wake-on-lan" ]; then
  mkdir -p "$backups"
  mv "$app_home/mods/wake-on-lan" "$backups/wake-on-lan"
  echo "Previous mod kept in $backups/wake-on-lan"
fi
mv "$staging/wake-on-lan" "$app_home/mods/wake-on-lan"

# 2. The layout.
for s in "${shipped[@]}"; do
  if [ "$layout" = "$s" ]; then
    if [ ! -f "$app_home/layouts/$s-wol.json" ]; then
      herdr-app do layout.clone "{\"name\":\"$s\",\"as\":\"$s-wol\"}" >/dev/null
      for _ in $(seq 50); do
        [ -s "$app_home/layouts/$s-wol.json" ] && break
        sleep 0.2
      done
    fi
    layout="$s-wol"
  fi
done
file="$app_home/layouts/$layout.json"
[ -s "$file" ] || { echo "No layout file $file" >&2; exit 1; }

mkdir -p "$backups"
cp "$file" "$backups/$layout.json"

# ${macs[@]+…}: an empty array is "unbound" under set -u before bash 4.4 (macOS).
out="$(python3 - "$file" "$visibility" ${macs[@]+"${macs[@]}"} <<'EOF'
import json, os, re, shutil, sys, tempfile

path, visibility, pairs = sys.argv[1], sys.argv[2], sys.argv[3:]
macs = {}
for p in pairs:
    name, _, mac = p.partition("=")
    mac = mac.strip().lower().replace("-", ":")
    if not name or not re.fullmatch(r"([0-9a-f]{2}:){5}[0-9a-f]{2}", mac):
        sys.exit(f"--mac {p}: expected <machine>=aa:bb:cc:dd:ee:ff")
    macs[name] = mac

with open(path) as f:
    doc = json.load(f)

def find(node):
    if node.get("id") == "wake-on-lan" or node.get("content", {}).get("mod") == "wake-on-lan":
        return node
    for c in node.get("children", []):
        f = find(c)
        if f:
            return f
    return None

block = {"id": "wake-on-lan", "type": "block", "size": {"px": 68}, "content": {"mod": "wake-on-lan"}}

def insert(node):
    kids = node.get("children", [])
    for i, child in enumerate(kids):
        if child.get("id") == "spaces" or child.get("content", {}).get("mod") == "spaces":
            kids.insert(i + 1, block)
            return True
        if insert(child):
            return True
    return False

existing = find(doc)
if existing:
    target = existing
    print(f"{path}: already has the Wake on LAN list")
elif insert(doc):
    target = block
    print(f"{path}: Wake on LAN list added under Spaces")
else:
    sys.exit(f"{path}: no Spaces block found. Add this block where you want the list:\n{json.dumps(block)}")
if macs:
    props = target.setdefault("content", {}).setdefault("props", {})
    props.setdefault("macs", {}).update(macs)
    print(f"{path}: MAC set for {', '.join(macs)}")
changed = bool(macs)
# A hidden block never starts its mod: never hide it, draw nothing instead.
if target.pop("hidden", None) is not None:
    changed = True
props = target.setdefault("content", {}).setdefault("props", {})
if visibility == "headless" and not props.get("headless"):
    props["headless"] = True
    target["size"] = {"px": 0}
    changed = True
    print(f"{path}: Wake on LAN runs without its list")
elif visibility == "list" and props.get("headless"):
    del props["headless"]
    target["size"] = {"px": 68}
    changed = True
    print(f"{path}: Wake on LAN list shown")
if not props:
    del target["content"]["props"]
if not existing or changed:
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".wake-on-lan-", suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    shutil.copymode(path, tmp)
    os.replace(tmp, path)
print("state:" + ("headless" if target.get("content", {}).get("props", {}).get("headless") else "list"))
EOF
)"
printf '%s\n' "$out" | grep -v '^state:' || true
state="${out##*state:}"

herdr-app do layout.switch "$(python3 -c 'import json, sys; print(json.dumps({"name": sys.argv[1]}))' "$layout")" >/dev/null
echo "Layout backup: $backups/$layout.json"
if [ "$state" = "headless" ]; then
  echo "Done: layout '$layout' runs Wake on LAN without its list (another mod shows the Wake buttons)."
else
  echo "Done: layout '$layout' shows the Wake on LAN list."
fi
