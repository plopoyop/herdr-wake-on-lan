# herdr-wake-on-lan

Public Herdr mod (target: GitHub, topic `herdr-mod`). Everything here is published: English only, no personal paths, names, IPs, MACs or work titles (screenshots included: take them from the `demo: true` props). Exception: `LICENSE` names the author as copyright holder, on purpose.

## Layout

- `mods/wake-on-lan/main.js`: view + engine. `wol.py`: lookup (MAC from the neighbour table) and send (magic packet), python3 standard library only.
- `install.sh` / `uninstall.sh`: bash + python3.
- `RECIPE.md` follows Herdr's recipe format (What you see / How it behaves / Built from / Watch out / Done when). Update it with every behaviour change, as well as `README.md`.

## Rules

- Check after every change: `herdr-app check mods/wake-on-lan`, and `bash -n` on the scripts.
- Herdr's API truth is `~/.config/herdr-app/herdr.d.ts` and `gpui-kit.d.ts`, plus `~/.config/herdr-app/AGENTS.md`.
- Never send a magic packet without a click (or the toast's action): a machine may be asleep on purpose.
- v1 is same-network only: never learn a machine behind a gateway. VPN and relay support are v2.
- Shared keys are all prefixed `wake-on-lan.`: `uninstall.sh` removes them by prefix.
- `wake-on-lan.status`, `.waking` and `.request` are a contract with other mods (they read and write them): keep them compatible, and document any change in README's "Wake buttons in another mod".
- Never make the block `hidden`: a hidden copy never starts. No list = props `headless: true` + 0 px.
- Don't test a real wake without the user's go: it wakes their machine.
