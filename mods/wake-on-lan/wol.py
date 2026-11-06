#!/usr/bin/env python3
"""Wake-on-LAN helper for the wake-on-lan Herdr mod. Standard library only.

  wol.py lookup <ssh target>   where the machine is: JSON {ip, mac, lan, net, random, why}
                               (+ proxied: true when reached through a jump host)
                               (net: this computer's network, as its gateway's MAC)
  wol.py net                   this computer's network: JSON {net}
  wol.py send <mac> [ip] [net] send magic packets:   JSON {sent: [addresses], away}
                               (net given and this computer on another network: nothing sent)

`lookup` reads this computer's neighbour (ARP) table, so it only finds the MAC
of a machine on the same network that answered lately (while connected).
"""
import ipaddress
import json
import os
import re
import socket
import subprocess
import sys
import threading

MAC_RE = re.compile(r"^([0-9a-f]{2}:){5}[0-9a-f]{2}$")


def run(*cmd):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
        return r.stdout if r.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def norm_mac(s):
    parts = re.split(r"[:-]", (s or "").strip().lower())
    if len(parts) != 6 or not all(re.fullmatch(r"[0-9a-f]{1,2}", p) for p in parts):
        return None
    mac = ":".join(p.zfill(2) for p in parts)
    return mac if mac != "00:00:00:00:00:00" and mac != "ff:ff:ff:ff:ff:ff" else None


def bare_host(target):
    """`user@host:port`, `user@[v6]:port`, `[v6]` -> the host alone."""
    host = target.rsplit("@", 1)[-1]
    if host.startswith("["):
        end = host.find("]")
        return host[1:end] if end > 0 else host
    if host.count(":") == 1:  # one colon: a port (an IPv6 address has several)
        host = host.split(":", 1)[0]
    return host


def host_of(target):
    """(HostName, through a jump host?) as ssh sees the target."""
    host = bare_host(target)
    name, proxied = host, False
    # An ssh config alias: its HostName; a ProxyJump/ProxyCommand means the
    # machine is reached through another one, so not on this network.
    for line in run("ssh", "-G", host).splitlines():
        key, _, value = line.partition(" ")
        value = value.strip()
        if key == "hostname" and value:
            name = value
        elif key in ("proxyjump", "proxycommand") and value and value.lower() != "none":
            proxied = True
    return name, proxied


def resolve(host, timeout=3):
    """IPv4 address of host, or None (also when it takes over `timeout` s: a
    sleeping `.local` name can take seconds to fail). A daemon thread: the
    script can exit without waiting for a lookup it gave up on."""
    out = []

    def look():
        try:
            out.append(socket.getaddrinfo(host, None, socket.AF_INET)[0][4][0])
        except (OSError, IndexError):
            pass

    t = threading.Thread(target=look, daemon=True)
    t.start()
    t.join(timeout)
    return out[0] if out else None


def route_dev(ip):
    """The interface the route to ip goes out of (Linux), or None."""
    try:
        return json.loads(run("ip", "-j", "route", "get", ip) or "[]")[0].get("dev")
    except (ValueError, IndexError, AttributeError):
        return None


def on_lan(ip):
    """True: same network; False: behind a router or a tunnel; None: can't tell."""
    out = run("ip", "-j", "route", "get", ip)
    if out:
        try:
            route = json.loads(out)[0]
        except (ValueError, IndexError, KeyError):
            return None
        if "gateway" in route:
            return False
        # A routed VPN (WireGuard, Tailscale, a tun) has no gateway either:
        # only an Ethernet-like link (Wi-Fi included) is this network.
        try:
            link = json.loads(run("ip", "-j", "link", "show", "dev", route.get("dev", "")) or "[]")[0]
        except (ValueError, IndexError):
            return None
        flags = set(link.get("flags", []))
        return link.get("link_type") == "ether" and not flags & {"POINTOPOINT", "NOARP"}
    # macOS: `route -n get` says the gateway and the interface.
    out = run("route", "-n", "get", ip)
    if not out:
        return None
    fields = {}
    for line in out.splitlines():
        key, _, value = line.strip().partition(":")
        fields[key.strip()] = value.strip()
    iface = fields.get("interface", "")
    if fields.get("gateway") or re.match(r"(utun|ipsec|ppp|gif|stf|tun|tap)", iface):
        return False
    return bool(iface) or None


def mac_of(ip, dev=None):
    out = run("ip", "-j", "neigh", "show", ip, *(["dev", dev] if dev else []))
    try:
        for n in json.loads(out):
            mac = norm_mac(n.get("lladdr"))
            if mac:
                return mac
        # `ip` answered: no entry on that interface means none. `arp` doesn't
        # filter by interface and could bring back another network's entry.
        return None
    except ValueError:
        pass  # no `ip` (macOS) or no usable answer: `arp`
    m = re.search(r"(([0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2})", run("arp", "-n", ip), re.I)
    return norm_mac(m.group(1)) if m else None


# Interfaces that come and go without this computer moving (containers, VMs,
# VPNs): never part of "which network am I on".
VIRTUAL = re.compile(r"^(lo|docker|br-|virbr|veth|vnet|tailscale|wg|tun|tap|zt|utun|ppp|bridge|vmnet|awdl|llw|ipsec|gif|stf)")


def physical_links():
    """ifname -> True for up, Ethernet-like, non-virtual interfaces (Linux; {} elsewhere)."""
    out = {}
    try:
        for l in json.loads(run("ip", "-j", "link", "show") or "[]"):
            flags = set(l.get("flags", []))
            out[l.get("ifname", "")] = (l.get("link_type") == "ether" and "UP" in flags
                                        and not flags & {"POINTOPOINT", "NOARP"}
                                        and not VIRTUAL.match(l.get("ifname", "")))
    except (ValueError, TypeError):
        pass
    return out


def network_id():
    """This computer's network, as the MAC of its default gateway on a physical
    interface; on a network without one (a switch, a direct cable), "lan:" +
    the IPv4 subnets of its physical interfaces; None: no network at all, or
    the gateway not in the neighbour table yet. A VPN's default route or a
    container bridge doesn't count. Two networks with the same private subnet
    still have different gateways."""
    phys = physical_links()
    gw, dev = None, None
    try:
        # The route actually used (lowest metric first) among physical ones,
        # and its device: the same gateway address may sit on two interfaces.
        routes = [r for r in json.loads(run("ip", "-j", "route", "show", "default") or "[]")
                  if r.get("gateway") and phys.get(r.get("dev", ""), False)]
        routes.sort(key=lambda r: r.get("metric", 0))
        if routes:
            gw, dev = routes[0]["gateway"], routes[0].get("dev")
        elif phys and json.loads(run("ip", "-j", "route", "show", "default") or "[]"):
            # A VPN took over the default route (`default dev tun0`): this
            # computer is still on the network its VPN server is reached
            # through. That route's gateway names it.
            for r in json.loads(run("ip", "-j", "route", "show") or "[]"):
                if r.get("gateway") and phys.get(r.get("dev", ""), False):
                    gw, dev = r["gateway"], r.get("dev")
                    break
            if gw is None:
                return None  # a default route but none physical: can't tell
    except (ValueError, TypeError):
        pass
    if gw is None and not phys:  # macOS (no `ip`)
        out = run("route", "-n", "get", "default")
        m = re.search(r"gateway:\s*(\S+)", out)
        iface = re.search(r"interface:\s*(\S+)", out)
        if m and not (iface and VIRTUAL.match(iface.group(1))):
            gw = m.group(1)
    if gw:
        return mac_of(gw, dev)
    nets = set()
    if phys:
        try:
            for iface in json.loads(run("ip", "-j", "-4", "addr") or "[]"):
                if not phys.get(iface.get("ifname", ""), False):
                    continue
                for a in iface.get("addr_info", []):
                    n = ipaddress.ip_network(f"{a['local']}/{a['prefixlen']}", strict=False)
                    if not (n.network_address.is_loopback or n.network_address.is_link_local):
                        nets.add(str(n))
        except (ValueError, KeyError, TypeError):
            pass
    else:  # macOS: physical-looking interfaces only
        nets = {str(n) for name, n in ifconfig_networks()
                if not VIRTUAL.match(name)
                and not (n.network_address.is_loopback or n.network_address.is_link_local)}
    return "lan:" + ",".join(sorted(nets)) if nets else None


def local_networks():
    """This computer's IPv4 networks: `ip -j -4 addr` (Linux), else `ifconfig` (macOS)."""
    nets = []
    try:
        for iface in json.loads(run("ip", "-j", "-4", "addr") or "[]"):
            for a in iface.get("addr_info", []):
                nets.append(ipaddress.ip_network(f"{a['local']}/{a['prefixlen']}", strict=False))
    except (ValueError, KeyError, TypeError):
        pass
    if nets:
        return nets
    return [n for _, n in ifconfig_networks()]


def ifconfig_networks():
    """(interface, network) pairs from `ifconfig` (macOS): blocks start at
    column 0 with "<name>:", lines like "inet 192.168.1.5 netmask 0xffffff00"."""
    out, name = [], ""
    for line in run("ifconfig").splitlines():
        head = re.match(r"^(\S+?):", line)
        if head:
            name = head.group(1)
            continue
        m = re.search(r"inet (\d+\.\d+\.\d+\.\d+) netmask (0x[0-9a-f]{8}|\d+\.\d+\.\d+\.\d+)", line, re.I)
        if not m:
            continue
        mask = m.group(2)
        if mask.lower().startswith("0x"):
            mask = str(ipaddress.ip_address(int(mask, 16)))
        try:
            out.append((name, ipaddress.ip_network(f"{m.group(1)}/{mask}", strict=False)))
        except ValueError:
            pass
    return out


def broadcasts(ip):
    """255.255.255.255, plus the broadcast address of every local network holding ip."""
    out = {"255.255.255.255"}
    try:
        target = ipaddress.ip_address(ip) if ip else None
    except ValueError:
        target = None
    if target is not None:
        for net in local_networks():
            if target in net and net.prefixlen < 31:
                out.add(str(net.broadcast_address))
    return sorted(out)


def lookup(target):
    host, proxied = host_of(target)
    net = network_id()
    if proxied:
        return {"ip": None, "mac": None, "lan": False, "proxied": True, "net": net, "random": False, "why": "reached through a jump host: not on this network"}
    ip = resolve(host)
    if not ip:
        return {"ip": None, "mac": None, "lan": None, "net": net, "random": False, "why": "can't resolve the host"}
    lan = on_lan(ip)
    if lan is False:
        return {"ip": ip, "mac": None, "lan": False, "net": net, "random": False, "why": "not on this network (behind a router or a VPN)"}
    # On the interface the route uses: the same address may have a stale entry
    # on another interface, of another network.
    mac = mac_of(ip, route_dev(ip))
    if mac and mac == net:
        # Every host answers with the gateway's MAC here (proxy ARP, a MAC-NAT
        # range extender): not the machine's own card.
        return {"ip": ip, "mac": None, "lan": lan, "net": net, "random": False, "why": "answers with the gateway's MAC (proxy ARP or a range extender)"}
    return {
        "ip": ip,
        "mac": mac,
        "lan": lan,
        "net": net,
        # Locally administered: a randomised address (often Wi-Fi), not the card's own.
        "random": bool(mac) and int(mac[:2], 16) & 0x02 != 0,
        "why": None if mac else "no MAC in the neighbour table",
    }


def send(mac, ip=None, net=None):
    mac = norm_mac(mac)
    if not mac:
        return {"sent": [], "why": "bad MAC address"}
    # Checked at the moment of sending: a packet doesn't cross networks, and
    # the mod's own view of where this computer is may be minutes old.
    want = net.strip().lower() if net else None
    here = network_id() if want else None
    if want and here and here != want:
        return {"sent": [], "away": True, "why": "this computer is on another network"}
    packet = b"\xff" * 6 + bytes.fromhex(mac.replace(":", "")) * 16
    sent = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            for addr in broadcasts(ip):
                for port in (9, 7):
                    try:
                        s.sendto(packet, (addr, port))
                        sent.append(f"{addr}:{port}")
                    except OSError:
                        pass
    except OSError as e:  # no UDP socket allowed here (a sandbox)
        return {"sent": [], "why": f"no UDP broadcast socket: {e}"}
    return {"sent": sent, "why": None if sent else "no packet could be sent"}


def main(argv):
    if len(argv) == 1 and argv[0] == "net":
        result = {"net": network_id()}
    elif len(argv) >= 2 and argv[0] == "lookup":
        result = lookup(argv[1])
    elif len(argv) >= 2 and argv[0] == "send":
        result = send(argv[1], (argv[2] if len(argv) > 2 else "") or None, (argv[3] if len(argv) > 3 else "") or None)
    else:
        print(__doc__, file=sys.stderr)
        return 2
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    code = main(sys.argv[1:])
    sys.stdout.flush()
    # Not sys.exit: it would wait for a name lookup resolve() gave up on.
    os._exit(code)
