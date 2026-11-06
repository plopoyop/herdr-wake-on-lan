// wake-on-lan: wake a sleeping machine of `hc machine ls` with a magic packet.
//
// While a machine is connected, its MAC address is read from this computer's
// neighbour (ARP) table and remembered: the machine must be on the same
// network (v1). When it stops answering, a toast offers to wake it, and its
// row in this list (or, headless, another mod's Wake button) wakes it. Waking sends magic packets (wol.py,
// python3) to the network's broadcast addresses, again every 20 s, until the
// machine is connected again or 2 min have passed.
//
// Block props: `macs: { "<machine name>": "aa:bb:cc:dd:ee:ff" }` replaces a
// learned MAC (a randomised Wi-Fi address can't wake a machine: give the
// network card's own). `demo: true` shows sample rows and does nothing.
//
// Other mods can offer a Wake button of their own: then block props
// `headless: true` (and a 0 px block) draw nothing. Don't hide the block
// instead: a hidden copy never starts. Shared keys: `status` written by the leader
// copy, `waking` (and an `away` found at send time) by the copy doing the wake:
//   wake-on-lan.status  = { at, machines: { <machine id>: { name, mac, random, away } } }
//                         (away: on another network than where the MAC was learned: no Wake)
//                         rewritten every check (10 s): older than 35 s, no copy runs
//   wake-on-lan.waking  = { <machine id>: { since, by, beat } }  (a wake under way,
//                         2 min at most; `beat` rewritten every 3 s, stale after 45 s)
// and one they write:
//   wake-on-lan.request = { <machine id>: <ms> }  (a click; taken within a second
//                         once `hc machine ls` has answered, ignored after 30 s)
// A `<mod>.<command>` only reaches a shown copy, hence the shared request.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { hc, exec, appHome, shared, setShared, notify, nextCommand, theme, props, layout, run } from "herdr";

const MOD = "wake-on-lan";
const LEARNED_KEY = `${MOD}.machines`; // machine id -> { name, ip, mac, random, net, away, seen, at }
const WAKING_KEY = `${MOD}.waking`; // machine id -> { since, by, beat }
const LEADER_KEY = `${MOD}.leader`;
const STATUS_KEY = `${MOD}.status`;
const REQUEST_KEY = `${MOD}.request`;
const REQUEST_POLL_MS = 1000;
const REQUEST_STALE_MS = 30_000;
// A machine whose MAC couldn't be learned isn't looked up again for this long.
const RETRY_LOOKUP_MS = 5 * 60_000;
// While this computer's network is unknown (no gateway yet, or none at all).
const NO_NET_RETRY_MS = 30_000;
// A wake under way rewrites its `waking` entry every few seconds; one not
// rewritten for this long was cut off (app reload, closed copy).
const WAKING_BEAT_STALE_MS = 45_000;
// No "doesn't answer" toast for this long after this copy takes the lead or
// this computer wakes up (every ssh link is coming back then).
const QUIET_MS = 60_000;
// The 1 s timer running this late means this computer slept.
const SLEPT_MS = 15_000;
const CHECK_MS = 10_000;
const LEADER_STALE_MS = 3 * CHECK_MS;
const RESEND_MS = 20_000;
const WAKE_TIMEOUT_MS = 120_000;
const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const ROW = 28;

const helper = () => `${appHome()}/mods/${MOD}/wol.py`;
const isDemo = () => props()?.demo === true;
const isHeadless = () => props()?.headless === true;
const overrides = () => {
  const out = {};
  for (const [name, mac] of Object.entries(props()?.macs ?? {})) {
    const m = String(mac).toLowerCase().replace(/-/g, ":");
    if (MAC_RE.test(m)) out[name] = m;
  }
  return out;
};

async function wol(args) {
  const r = await exec("python3", [helper(), ...args]).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

const DEMO = [
  { id: "d1", name: "laptop", state: "unreachable", mac: "00:00:5e:00:53:01" },
  { id: "d2", name: "build-box", state: "connected", mac: "00:00:5e:00:53:02" },
  { id: "d3", name: "nas", state: "unreachable", mac: "00:00:5e:00:53:03", waking: true },
];

export default class WakeOnLan extends View {
  init(_props, cx) {
    this.id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.machines = []; // from `hc machine ls`, without temporary ones
    this.prev = {}; // machine id -> last state seen (leader's toasts)
    this.busy = new Set(); // machine ids being woken by this copy
    this.noMac = new Map(); // machine id -> no lookup while connected before this time (failed lately)
    this.recheckAt = new Map(); // machine id -> no lookup while down before this time (every 5 min)
    this.down = new Set(); // machine ids seen not answering once, toasted if still so next check
    this.quietUntil = 0; // no toast before this time
    if (isDemo()) return;
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c.startsWith("wake-")) this.wake(c.slice(5), cx);
      }
    });
    cx.timer.every(CHECK_MS, (cx) => this.check(cx));
    cx.timer.every(REQUEST_POLL_MS, (cx) => this.takeRequests(cx));
    this.check(cx);
  }

  // Wake requests from other mods' buttons: the leader takes them all at once.
  takeRequests(cx) {
    // This 1 s timer running late: this computer slept. Its ssh links are
    // coming back, so don't toast about them for a while.
    const now0 = Date.now();
    if (this.lastTick && now0 - this.lastTick > SLEPT_MS) {
      this.quietUntil = now0 + QUIET_MS;
      this.recheckAt.clear(); // this computer may be on another network now
      this.noMac.clear();
    }
    this.lastTick = now0;
    // A check's MAC lookups can take a while: keep the lead and the status
    // fresh meanwhile (other mods count a status older than 35 s as no engine).
    if (shared(LEADER_KEY)?.id === this.id && now0 - (shared(STATUS_KEY)?.at ?? 0) >= CHECK_MS && this.machines.length) {
      setShared(LEADER_KEY, { id: this.id, at: now0 });
      this.publish();
    }
    const req = shared(REQUEST_KEY);
    // Before the first `hc machine ls` answer, keep it for the next second.
    if (!req || Object.keys(req).length === 0 || this.machines.length === 0 || !this.lead()) return;
    setShared(REQUEST_KEY, null);
    const now = Date.now();
    for (const [id, at] of Object.entries(req)) {
      if (now - Number(at) < REQUEST_STALE_MS) this.wake(id, cx);
    }
  }

  // The leader posts toasts, so the action follows whether the leader is
  // shown (another shown copy would get it too; not worth a heartbeat).
  // A toast's action only reaches a shown copy: not when the block (or a
  // parent) was hidden after it started. A sidebar hidden with its key is
  // drawn from the layout's saved state and may not show here.
  shown() {
    const hidden = (function find(n, above) {
      if (!n) return null;
      const h = above || n.hidden === true;
      if (n.content?.mod === MOD) return h;
      for (const c of n.children ?? []) {
        const f = find(c, h);
        if (f !== null) return f;
      }
      return null;
    })(layout(), false);
    return hidden === false;
  }

  async close() {
    if (shared(LEADER_KEY)?.id === this.id) setShared(LEADER_KEY, null);
  }

  lead() {
    const l = shared(LEADER_KEY);
    const now = Date.now();
    if (l && l.id !== this.id && now - l.at < LEADER_STALE_MS) return false;
    setShared(LEADER_KEY, { id: this.id, at: now });
    return true;
  }

  check(cx) {
    if (this.checking) return;
    this.checking = true;
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["machine", "ls", "--json"]).catch(() => null);
        if (r?.code === 0) {
          try {
            this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary);
          } catch {}
        }
        // A long gap since this copy's last check: this computer slept (the
        // 1 s timer may not have run yet). Its ssh links are coming back.
        const t = Date.now();
        // From the end of the previous check: a slow check (long lookups) is
        // not a wake-up.
        if (this.lastCheck && t - this.lastCheck > CHECK_MS + SLEPT_MS) {
          this.quietUntil = Math.max(this.quietUntil, t + QUIET_MS);
          this.down.clear();
          this.recheckAt.clear();
          this.noMac.clear();
        }
        const leads = this.lead();
        // Taking the lead (again): states seen while another copy led are
        // stale, so start over, quiet for a while.
        if (leads && !this.led) {
          this.prev = Object.fromEntries(this.machines.map((m) => [m.id, m.state]));
          this.down.clear();
          this.quietUntil = Math.max(this.quietUntil, Date.now() + QUIET_MS);
        }
        this.led = leads;
        if (leads) {
          // Before the lookups, which can take seconds per machine: other
          // mods' buttons count a status older than 35 s as no engine.
          this.publish();
          // This computer changed network (Wi-Fi switch, cable, without
          // sleeping): look every machine up again now, so "other network"
          // follows within a check, not 5 min later.
          const here = (await wol(["net"]))?.net ?? null;
          // No network at all (cable pulled, Wi-Fi gone): every link drops
          // because of this computer, not the machines. No toast until a
          // network is back, then a quiet period while the links come back.
          if (!here) {
            if (!this.noNet) this.down.clear();
            this.noNet = true;
          } else if (this.noNet) {
            this.noNet = false;
            this.down.clear();
            this.quietUntil = Math.max(this.quietUntil, Date.now() + QUIET_MS);
          }
          if (here && here !== this.here) {
            if (this.here) {
              this.recheckAt.clear();
              this.noMac.clear();
              // Every ssh link is dropping or coming back: no toast for a
              // while (the lookups below mark what is now away).
              this.down.clear();
              this.quietUntil = Math.max(this.quietUntil, Date.now() + QUIET_MS);
            }
            this.here = here;
          }
          await this.learnAndWarn();
        }
      } finally {
        this.checking = false;
        this.lastCheck = Date.now();
      }
      cx.notify();
    });
  }

  mac(m) {
    return overrides()[m.name] ?? shared(LEARNED_KEY)?.[m.id]?.mac ?? null;
  }

  // Leader only: remember where connected machines are, and say when one
  // that can be woken stops answering.
  async learnAndWarn() {
    // Toasts first: the lookups below can take seconds per machine.
    const quiet = Date.now() < this.quietUntil || this.noNet;
    for (const m of this.machines) {
      const was = this.prev[m.id];
      this.prev[m.id] = m.state;
      // Gone from connected: wait one more check (a short blip comes back);
      // still not connected then → toast. Nothing while quiet.
      if (m.state === "connected" || quiet) {
        this.down.delete(m.id);
        continue;
      }
      if (was === "connected") {
        this.down.add(m.id);
        continue;
      }
      if (!this.down.has(m.id)) continue;
      this.down.delete(m.id);
      if (this.mac(m) && !this.away(m.id) && !this.waking(m.id)) {
        notify({
          title: `${m.name} doesn't answer`,
          body: this.shown() ? "Asleep? Send it a magic packet." : "Asleep? Its Wake button sends it a magic packet.",
          level: "warning",
          ...(this.shown() ? { action: { name: `${MOD}.wake-${m.id}` } } : {}),
        });
      }
    }
    for (const m of this.machines) {
      // Reached through another machine (`via`): not on this network, never
      // learned, and an address learned earlier (on this network) is dropped.
      if (m.via) {
        this.forget(m.id);
        continue;
      }
      // Connected: the neighbour table holds its current address. Not
      // connected and never seen: the table may still remember it, better
      // than nothing (a connected look replaces it). Not connected but
      // learned: looked up too, every RETRY_LOOKUP_MS, so a move to another
      // network (this computer's or its own) marks it away (the address is
      // kept). A failed lookup waits RETRY_LOOKUP_MS too.
      const entry = shared(LEARNED_KEY)?.[m.id];
      const connected = m.state === "connected";
      const waitMap = connected ? this.noMac : this.recheckAt;
      if (Date.now() < (waitMap.get(m.id) ?? 0)) continue;
      if (!connected) this.recheckAt.set(m.id, Date.now() + RETRY_LOOKUP_MS);
      const found = await wol(["lookup", m.target]);
      // This computer's network isn't up yet (just woke up, no gateway): any
      // answer is partial, try again in 30 s rather than 5 min.
      if (found && !found.net) waitMap.set(m.id, Date.now() + NO_NET_RETRY_MS);
      // Away: this computer (or the machine) is on another network now. The
      // learned MAC stays (back home it is right again), but no Wake then.
      // Changed on clear evidence only; a lookup that can't tell (no network
      // yet after a wake-up, a name that doesn't resolve) changes nothing and
      // is tried again at the next check.
      if (entry) {
        const away = this.awayFrom(entry, found, connected);
        // A lookup that can't tell (null) changes nothing; it was retried in
        // 30 s above if this computer's network is unknown, else in 5 min.
        // A new `net` only when the learned MAC itself answers there on a
        // connected machine (a new router), never on `lan` alone.
        if (away === false && connected && found.net && found.net !== entry.net && found.mac === entry.mac) this.patch(m.id, { away: false, net: found.net });
        else if (away !== null && away !== Boolean(entry.away)) this.patch(m.id, { away });
        // Away while "connected": a link not yet seen dead after this
        // computer moved, its address now answered by another device. Never
        // learn from it.
        if (away === true) continue;
      }
      // Not connected but learned: never take its MAC, its address may be
      // another device's by now (a reused lease, the same subnet elsewhere).
      if (!connected && entry) continue;
      // Learned, but this computer's network unknown (just woke up somewhere):
      // a "connected" link may be a dead one whose address another device
      // answers. Only a known network may replace a learned MAC.
      if (entry && !found?.net) continue;
      // A card's own MAC is never replaced by a randomised one (a Wi-Fi
      // address can't wake the machine; its Ethernet one can).
      // (An entry learned while the machine was down, `seen: false`, may be
      // another device's address: a connected look replaces it whatever it is.)
      if (entry && entry.seen !== false && !entry.random && found?.random) continue;
      if (found?.mac && MAC_RE.test(found.mac) && found.lan !== false) {
        this.noMac.delete(m.id);
        const before = entry;
        // A lookup that couldn't name this computer's network keeps the one known.
        const net = found.net ?? before?.net ?? null;
        if (before?.mac !== found.mac || before?.ip !== found.ip || before?.name !== m.name || before?.net !== net || before?.away || (connected && before?.seen === false)) {
          this.patch(m.id, { name: m.name, ip: found.ip, mac: found.mac, random: found.random, net, away: false, seen: connected, at: Date.now() }, true);
        }
      } else if (connected && found?.net !== null) this.noMac.set(m.id, Date.now() + RETRY_LOOKUP_MS);
    }
    this.publish();
  }

  patch(id, fields, replace = false) {
    const all = { ...(shared(LEARNED_KEY) ?? {}) };
    if (!replace && !all[id]) return;
    all[id] = replace ? fields : { ...all[id], ...fields };
    setShared(LEARNED_KEY, all);
  }

  // true: away; false: on the network it was learned on; null: can't tell.
  awayFrom(entry, found, connected) {
    if (!found) return null;
    // Two known networks that differ: away, whatever else the lookup says.
    if (entry.net && found.net) {
      // Another gateway, but the learned MAC answering at its address on this
      // link: the same network with a new router, if the machine is connected.
      // Asleep, that neighbour entry may be a stale one carried over from the
      // previous network: can't tell.
      if (found.net !== entry.net) {
        if (!(found.lan === true && found.mac && found.mac === entry.mac)) return true;
        return connected ? false : null;
      }
      // Same network as when learned: not away, even when its name doesn't
      // resolve while it sleeps (`.local`, DHCP DNS) or a `Match exec` rule
      // picks a jump host for it. Only a connected machine reached through a
      // jump host, or a route that clearly leaves this network, is away.
      return found.proxied ? connected : found.lan === false;
    } else if (!found.net) {
      // This computer's network unknown (no default route yet): only a route
      // that clearly leaves this network counts.
      return found.lan === false && !found.proxied ? true : null;
    }
    // Same network (or the entry has none to compare). A jump host chosen by
    // a `Match exec` rule says nothing about a sleeping machine: only a
    // connected one reached that way is away.
    if (found.proxied) return connected ? true : null;
    if (found.lan === false) return true;
    return found.lan === true ? false : null;
  }

  // On another network than where its MAC was learned (see learnAndWarn).
  // A block `macs` override wins: the person said where to send it (a new
  // router, a range extender), so no away guess stops it.
  away(id) {
    const name = this.machines.find((x) => x.id === id)?.name;
    if (name && overrides()[name]) return false;
    return Boolean(shared(LEARNED_KEY)?.[id]?.away);
  }

  forget(id) {
    const all = shared(LEARNED_KEY) ?? {};
    if (!all[id]) return;
    const next = { ...all };
    delete next[id];
    setShared(LEARNED_KEY, next);
  }

  // What other mods need for a Wake button of their own.
  publish() {
    const machines = {};
    for (const m of this.machines) {
      const override = overrides()[m.name];
      machines[m.id] = { name: m.name, mac: this.mac(m), random: !override && Boolean(shared(LEARNED_KEY)?.[m.id]?.random), away: this.away(m.id) };
    }
    setShared(STATUS_KEY, { at: Date.now(), machines });
  }

  waking(id) {
    const w = shared(WAKING_KEY)?.[id];
    const now = Date.now();
    return w && now - w.since < WAKE_TIMEOUT_MS + CHECK_MS && now - (w.beat ?? w.since) < WAKING_BEAT_STALE_MS ? w : null;
  }

  setWaking(id, value) {
    const all = { ...(shared(WAKING_KEY) ?? {}) };
    if (value) all[id] = value;
    else delete all[id];
    setShared(WAKING_KEY, all);
  }

  wake(id, cx) {
    if (isDemo() || this.busy.has(id) || this.waking(id)) return;
    const m = this.machines.find((x) => x.id === id);
    // Back already (a late toast click or request): nothing to wake.
    if (!m || m.state === "connected") return;
    const mac = this.mac(m);
    if (this.away(id)) {
      notify({ title: `Can't wake ${m.name} from here`, body: "This computer is on another network than the one it was learned on: a magic packet doesn't cross networks.", level: "warning" });
      return;
    }
    if (!mac) {
      notify({ title: `Can't wake ${m.name}`, body: "Its MAC address isn't known yet: it's learned while the machine is connected.", level: "warning" });
      return;
    }
    const ip = shared(LEARNED_KEY)?.[id]?.ip;
    // Block `macs` overrides have no network to check against.
    const net = overrides()[m.name] ? null : shared(LEARNED_KEY)?.[id]?.net;
    this.busy.add(id);
    this.setWaking(id, { since: Date.now(), by: this.id });
    cx.notify();
    cx.spawn(async (cx) => {
      let woke = false;
      let wrongNet = false;
      let sentOnce = false;
      let why = null; // the helper's last reason for sending nothing
      try {
        const start = Date.now();
        let last = 0;
        while (Date.now() - start < WAKE_TIMEOUT_MS) {
          if (Date.now() - last >= RESEND_MS) {
            last = Date.now();
            const r = await wol(["send", mac, ip ?? "", net ?? ""]);
            if (r?.away) {
              wrongNet = true;
              this.patch(id, { away: true });
              break;
            }
            if (r?.sent?.length) sentOnce = true;
            else if (r?.why) why = r.why;
          }
          await cx.sleep(3000);
          this.setWaking(id, { since: start, by: this.id, beat: Date.now() });
          const r = await hc(["machine", "ls", "--json"]).catch(() => null);
          try {
            const now = (JSON.parse(r?.stdout ?? "{}").machines ?? []).find((x) => x.id === id);
            if (now?.state === "connected") {
              woke = true;
              break;
            }
          } catch {}
        }
      } finally {
        this.busy.delete(id);
        this.setWaking(id, null);
        cx.notify();
      }
      if (wrongNet) notify({ title: `Can't wake ${m.name} from here`, body: "This computer is on another network than the one it was learned on: a magic packet doesn't cross networks.", level: "warning" });
      else if (woke) notify({ title: `${m.name} is back`, level: "info" });
      else if (!sentOnce) notify({ title: `Couldn't wake ${m.name}`, body: `No magic packet could be sent (${why ?? "is python3 installed?"}).`, level: "warning" });
      else notify({ title: `${m.name} didn't wake up`, body: `Magic packets sent to ${mac} for 2 min. Check that Wake-on-LAN is on for its network card.`, level: "warning" });
    });
  }

  rows() {
    if (isDemo()) return DEMO.map((d) => ({ ...d, random: false }));
    return this.machines.map((m) => {
      const learned = shared(LEARNED_KEY)?.[m.id];
      const override = overrides()[m.name];
      return {
        id: m.id,
        name: m.name,
        state: m.state,
        mac: override ?? learned?.mac ?? null,
        random: !override && Boolean(learned?.random),
        waking: Boolean(this.waking(m.id)),
        away: this.away(m.id),
      };
    });
  }

  // The block takes the height of its rows.
  fit(count) {
    const node = (function find(n) {
      if (!n) return null;
      if (n.content?.mod === MOD) return n;
      for (const c of n.children ?? []) {
        const f = find(c);
        if (f) return f;
      }
      return null;
    })(layout());
    const px = 30 + Math.max(count, 1) * ROW + 10;
    if (!node?.id || node.size?.px === px || this.fitted === px) return;
    this.fitted = px;
    run("layout.resize", { id: node.id, px });
  }

  row(t, r) {
    const connected = r.state === "connected";
    const canWake = !connected && r.mac && !r.waking && !r.away;
    const status = r.waking ? "waking…" : connected ? "" : r.away ? "other network" : (r.state ?? "asleep").replace(/_/g, " ");
    const tip = r.away
      ? `${r.mac}: learned on another network than this computer's now (a magic packet doesn't cross networks)`
      : !r.mac
      ? "MAC address not known yet: it's learned while the machine is connected, on this network."
      : `${r.mac}${r.random ? " (randomised address: Wake-on-LAN needs the network card's own, see the README)" : ""}`;
    return h_flex()
      .id(`wol-${r.id}`)
      .h(ROW)
      .flex_none()
      .px(8)
      .gap(8)
      .items_center()
      .rounded(7)
      .tooltip(tip)
      .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : r.waking ? t.working : t.dim))
      .child(div().flex_1().min_w(0).truncate().text_color(connected ? t.muted : t.foreground).child(r.name))
      .when(r.random && !connected, (el) => el.child(div().flex_none().text_size(11).text_color(t.blocked).child("random MAC")))
      .when(Boolean(status), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(status)))
      .when(Boolean(canWake), (el) =>
        el.child(
          div()
            .id(`wol-wake-${r.id}`)
            .flex_none()
            .px(6)
            .rounded(4)
            .text_size(11)
            .cursor_pointer()
            .text_color(t.foreground)
            .bg(t.hover)
            .hover((s) => s.bg(t.selected))
            .on_click((_e, cx) => this.wake(r.id, cx))
            .child("Wake"),
        ),
      );
  }

  render(cx) {
    if (isHeadless()) return div().size_full();
    const t = theme();
    const rows = this.rows();
    if (!isDemo()) this.fit(rows.length);
    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .text_size(13)
      .child(h_flex().px(16).h(30).pt(8).flex_none().items_center().text_size(11).font_medium().text_color(t.dim).child("Wake on LAN"))
      .child(
        v_flex()
          .id("wol-list")
          .flex_1()
          .min_h(0)
          .px(8)
          .overflow_y_scrollbar()
          .children(rows.map((r) => this.row(t, r)))
          .when(rows.length === 0, (el) => el.child(div().px(8).text_size(12).text_color(t.dim).child("No remote machine (hc machine add)."))),
      );
  }
}
