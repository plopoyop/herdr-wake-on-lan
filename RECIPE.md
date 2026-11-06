# Wake on LAN

A small list under the Spaces list: each remote machine of `hc machine ls`
with its state, and a Wake button that sends a Wake-on-LAN magic packet when
it doesn't answer. A toast offers the same when a connected machine goes away.

## What you see

- A block right after the `spaces` block of the sidebar, background `chrome`,
  text 13 px. It sizes itself (`layout.resize`) to 30 px + 28 px per row + 10.
- Header, 30 px high (8 px top padding), 16 px side padding, 11 px medium
  `dim`: "Wake on LAN".
- One row per machine (temporary ones left out), 28 px, radius 7, 8 px
  padding: a 6 px dot (`ansi2` connected, `working` waking, else `dim`), the
  name (`muted` when connected, else `foreground`), then in 11 px: "random
  MAC" in `blocked` when the learned address is locally administered and the
  machine is down, the state (`unreachable`, underscores as spaces) or
  "waking…" or "other network" (away) in `dim`, and a "Wake" chip (`hover`
  background, `selected` on hover, radius 4) when it is down, its MAC is
  known and it isn't away.
- Tooltip: the MAC (and the randomised warning), or why it isn't known.
- No machine: "No remote machine (hc machine add)."
- Block props `headless: true`: nothing drawn (`div().size_full()`), no
  resize; the block is meant to be 0 px. The engine runs as usual.

## How it behaves

- Every 10 s, each copy reads `hc machine ls --json`. One copy leads (shared
  `wake-on-lan.leader`, taken over after 30 s of silence, released on
  `close()`); only the leader learns and posts toasts.
- Learning, after the toasts (lookups can take seconds each): for a
  connected machine, one never learned, or (every 5 min) a learned one not
  connected (only to tell whether it is away; its MAC is never taken then:
  its IP may be another device's by now), unless it has a `via` (reached
  through another machine) or its last lookup failed less than 5 min ago, run
  `python3 <appHome>/mods/wake-on-lan/wol.py lookup <target>`: host after
  `@` without a `:port` (or `[v6]`), `ssh -G` HostName for aliases (a
  `proxyjump` / `proxycommand` other than `none` means another network: not
  learned), IPv4 resolve, `ip -j route get` (a `gateway`, or a route over a
  link that isn't Ethernet-like — `link_type` not `ether`, or `POINTOPOINT` /
  `NOARP`: a VPN or tunnel — means another network: not learned; macOS:
  `route -n get`, a gateway or a `utun`/`ipsec`/`ppp`… interface), MAC from `ip -j neigh show` else `arp -n`. Store
  `{ name, ip, mac, random, net, away, seen, at }` per machine id in shared
  `wake-on-lan.machines`, only when something changed. `net` is this
  computer's network when it was learned (`wol.py`: the default gateway's
  MAC; a lookup without one keeps the known `net`). `away` changes on clear
  evidence only: both `net`s known and different → away (unless the lookup
  finds the learned MAC at its address on this link: for a connected machine
  a new router, the `net` is updated; for a sleeping one can't tell, as that
  neighbour entry may be left from the previous network); both known and
  equal → not away, unless the route clearly leaves this network (`lan:
  false`) or a connected machine is reached through a jump host (a name that
  doesn't resolve while it sleeps, or a `Match exec` jump host, doesn't make
  it away); no current `net` → away only on a clear `lan: false`, else can't
  tell; an entry without `net` → a jump host: away if connected, else can't
  tell; `lan: false` away, `lan: true` not. A
  lookup that can't tell changes nothing; it is retried after 30 s while this
  computer's network is unknown, for any machine (else the 5 min wait
  stands). Kept, not forgotten: back on that network
  it is right again. Away: the row says "other network", no Wake
  chip, no toast, a Wake request answers with a warning toast, and
  `wake-on-lan.status` carries `away: true`. A machine with a `via` loses its
  learned address (block `macs` still apply). A block `macs` override is never away (the person
  said where to send it). `wol.py lookup` never learns a MAC equal to the
  gateway's (proxy ARP, a MAC-NAT range extender); the network is the
  default route with the lowest metric, its gateway looked up on that route's
  device, among physical interfaces only (up, `ether`, not POINTOPOINT/NOARP,
  not docker/br-/virbr/veth/tailscale/wg/tun… : a VPN's default route or a
  container bridge doesn't move this computer); on a network without such a
  default route (a switch, a direct cable) it is `lan:` + the IPv4 subnets of
  those physical interfaces (a VPN that replaced the default route: the
  gateway of a physical route, the one to its server), and none without any
  usable IPv4 address, or while the gateway isn't in the neighbour table
  yet (no toasts then, briefly). A `seen: false` entry becomes `seen: true` at the
  first connected look, even with the same values. The machine's own MAC is read from the neighbour table on the
  interface its route uses. A learned MAC that isn't randomised is never
  replaced by a randomised one (a Wi-Fi address can't wake it). Lookups of connected machines
  that failed wait 5 min; machines not connected are looked up every 5 min
  (learned or not); the two are timed apart (a machine back up is looked up
  at once).
- A copy that takes the lead (again) first records every machine's state:
  states seen while another copy led are stale.
- Block props `macs: { name: mac }` win over learned addresses (and are never
  "random").
- Toast: the leader remembers each machine's last state; going from
  `connected` to anything else and still not connected at the next check
  (a short blip comes back), with a MAC, not away and not waking → `notify` warning
  "<name> doesn't answer", action `{ name: "wake-on-lan.wake-<id>" }`. No
  toast for 60 s after this copy takes the lead or this computer wakes up (the
  1 s timer running over 15 s late).
  `nextCommand()` gets `wake-<id>` and wakes it.
- Wake (click or command): ignored if the machine is connected, this copy is on it, or shared
  `wake-on-lan.waking[id]` is fresh (under 2 min + 10 s since `since`, and
  under 45 s since `beat`). Set it, then loop for 2 min: `wol.py send <mac>
  <ip> <net>` at once and every 20 s, and every 3 s rewrite `beat` and check `hc
  machine ls` (a loop cut off by a reload stops beating: its entry goes stale
  in 45 s). Connected → "<name> is back"; nothing ever sent → "Couldn't
  wake" with the helper's reason (no UDP socket…), else "python3?"; else "didn't wake up" with the MAC and a hint about the
  card's Wake-on-LAN. Clear `waking` at the end.
- `wol.py send <mac> <ip> <net>`: with a learned `net` (not for block `macs`)
  and this computer's network known and different, nothing is sent and it
  answers `away: true`; the wake stops, marks the machine away and toasts
  "Can't wake … from here". After this computer wakes up, every machine is
  looked up again at the next check (both 5 min timers cleared). Every
  check, the leader also asks `wol.py net` for this computer's network: a
  change clears both timers too (a Wi-Fi switch without sleeping), drops
  pending downs and starts a 60 s quiet period. A lookup that finds the
  machine away never learns from it, even while hc still says connected (a
  dead link after a move, its address answered by another device); a new
  `net` is written only when the learned MAC itself answers there. While this computer has no network at all, no toast (every link drops
  because of it); when one is back, pending downs are dropped and a 60 s
  quiet period starts. An entry learned while the machine was down is marked
  `seen: false`: a connected look replaces it, even with a randomised MAC. A learned
  MAC is never replaced while this computer's network is unknown (a link
  still seen as connected right after waking up elsewhere). A lookup that can't tell is retried after 30 s while this computer's network is unknown; else the
  5 min wait stands.
- `wol.py send`: packet = 6 × `0xff` + 16 × MAC, UDP with `SO_BROADCAST`, ports
  9 and 7, to `255.255.255.255` and to the broadcast address of every local
  IPv4 network containing the last known ip (`ip -j -4 addr`, else
  `ifconfig` inet/netmask on macOS).
- Nothing is ever sent without a click.
- Every check, the leader writes shared `wake-on-lan.status` right after `hc
  machine ls` answers (before the MAC lookups, which can take seconds per
  machine) and again after them: `{ at, machines: { id: { name, mac, random, away } } }`
  (block `macs` included), for other mods' Wake buttons.
- Every second, the leader takes shared `wake-on-lan.request` = `{ id: ms }`
  (written by other mods' Wake buttons): cleared at once, each fresh entry
  (under 30 s) woken as a click would. Not before the first `hc machine ls`
  answer (kept for the next second).
- The toast's action only reaches a shown copy: when the block (or a parent)
  was made `hidden` after it started, the toast has no action and says to use
  the Wake button. A sidebar hidden with its key (saved in the layout's state)
  may not show in `layout()`: the toast keeps its action, which then does
  nothing (documented limit). With several copies, the toast's action follows whether the
  leader copy (which posts it) is shown. A copy starts the first time its block shows:
  started with the sidebar hidden, the engine doesn't run until it is shown.
- A gap of more than 25 s between this copy's checks also counts as this
  computer waking up (quiet 60 s, pending "down" machines dropped).
- Every second, the leader also rewrites its `wake-on-lan.leader` and the
  status when the status is 10 s old and `hc machine ls` has answered (a check whose lookups run long).

## Built from

- Layout: `{ "id": "wake-on-lan", "type": "block", "size": { "px": 68 }, "content": { "mod": "wake-on-lan" } }`
  after the `spaces` block. `install.sh` clones a shipped layout to
  `<name>-wol`, checks the mod in a staging folder, backs up, writes
  atomically, and puts `--mac name=mac` into props `macs`.
- `mods/wake-on-lan/main.js`: `herdr` functions `hc(["machine","ls","--json"])`,
  `exec("python3", …)`, `appHome()`, `shared` / `setShared`, `notify`,
  `nextCommand`, `theme`, `props`, `layout`, `run("layout.resize")`;
  `cx.timer.every`, `cx.sleep`, `cx.spawn`.
- `mods/wake-on-lan/wol.py`: python3 standard library; runs `ssh -G`, `ip`,
  `arp`, `ifconfig`.
- `install.sh` checks, before any change, the arguments, the layout file
  and that the layout (a shipped one's existing clone, else the shipped one)
  has a Spaces or Wake on LAN block; it copies the mod without `__pycache__`; `uninstall.sh` backs up
  each layout it changes to `.wake-on-lan-backup/<date>-uninstall/`.
- Block props `demo: true`: rows `laptop` (unreachable), `build-box`
  (connected), `nas` (waking); no timer, no actions.

## Watch out

- A magic packet is a local broadcast: it never crosses a router or a VPN.
  Don't learn a machine behind a gateway.
- A locally administered MAC (bit `0x02` of the first byte) is randomised:
  flag it, the card's own address is needed.
- Never send on its own: someone may have put the machine to sleep on purpose.
- Several copies (one per layout) would toast twice: only the leader toasts.
- `<mod>.<command>` reaches shown copies only: other mods ask through the
  shared `wake-on-lan.request` instead.
- A hidden block's copy never starts (it starts the first time it shows):
  for no list, use `headless` and a 0 px block, never `hidden`.

## Done when

- `herdr-app check mods/wake-on-lan` passes.
- A connected machine on this network gets its MAC learned (tooltip).
- Putting it to sleep shows a toast within about 20 s (two checks) and a Wake button.
- Wake brings it back (on hardware that supports it) and a "is back" toast
  shows; otherwise "didn't wake up" after 2 min.
- A machine behind a router is never learned and shows no Wake button.
