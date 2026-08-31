<h1 align="center">Sliver GUI</h1>

<p align="center">
  A desktop operator console for the <a href="https://github.com/BishopFox/sliver">Sliver C2</a> framework -
  an enhanced GUI with pivot graphs, script manager, and operator toolkit.
</p>

<p align="center">
  <img alt="Go" src="https://img.shields.io/badge/Go-1.25%2B-00ADD8?logo=go&logoColor=white">
  <img alt="Wails" src="https://img.shields.io/badge/Wails-v2-00d4aa">
  <img alt="Sliver" src="https://img.shields.io/badge/Sliver-C2-00d4aa">
  <img alt="Platform" src="https://img.shields.io/badge/Linux%20·%20Windows%20·%20macOS-555">
</p>

Sliver GUI is a [Wails v2](https://wails.io) (Go + plain HTML/CSS/JS) frontend over Sliver's
existing `rpcpb.SliverRPC` gRPC service. It reimplements **no** C2 logic and connects with the same
mTLS operator `.cfg` files as the official `sliver-client` - every command-and-control capability
comes from Sliver itself. Because the backend is Go, it imports Sliver's real protobuf/gRPC stubs
directly: no grpc-web proxy, no protocol reimplementation, no drift when upstream changes its `.proto`.

> **Authorized use only.** This is an offensive-security tool. Use it solely on systems you own
> or have explicit written permission to test.

---

## Features

| Area | What you get |
|------|--------------|
| **Agents** | Unified sessions + beacons table, plus an interactive **pivot graph** - firewall/egress boundary on the left, agents laid out in their real pivot topology, arrows colour-coded by type: **green** session · **red** SYSTEM/privileged · **blue** beacon. |
| **Per-agent console** | Real-time (session) or queued (beacon) consoles with **70+ RPC-backed commands**, a full **interactive PTY shell** (`shell -i` / `pty`) over a gRPC tunnel, and **extensions / BOFs** (`ext …`). |
| **Server console** | A pinned `sliver >` prompt for ~45 teamserver commands. |
| **Implants** | **Generate** (mTLS · HTTP · DNS · WireGuard · `tcp-pivot`), profiles, builds, and **armory** install / remove. |
| **Data** | Loot · credentials · hosts · operators · full event log. |
| **Operator QoL** | JSONL **audit log**, per-teamserver persisted graph layout / notes / integrity, **`Ctrl+K`** command palette, live event stream with toasts, and auto-reconnect. |

### Script Manager
One-click post-exploitation **recipes** with **dry-run preview**, **MITRE ATT&CK ID**, and **OpSec noise** rating:

- **Spawn** - builds + runs a fresh agent with listener check and post-spawn verification.
- **Lateral Movement** - SSH deploy, PsExec, WMI, WinRM, SC, SMB.
- **Privilege Escalation** - Linux (sudo / SUID), Windows (token impersonation, GetSystem, UAC bypass).
- **Persistence** - cron · SSH-key · systemd · Registry Run · scheduled task · service · WMI · startup.
- **Credentials** - Linux & Windows harvest, Kerberoast, DCSync (routed to Loot).
- **Enumeration** - network scan, Active Directory enumeration, local Windows enum.

### Operator Panels
- **File Browser** - visual remote filesystem with breadcrumb navigation.
- **Process Browser** - visual process list with search, kill, and migrate.
- **Kill-Chain Tracker** - record and visualise engagement stages.
- **IOC Tracker** - log indicators as you drop them, generate cleanup scripts.
- **Chain Health** - probe all listeners with sparkline history.
- **Beacon Sleep Dashboard** - bulk sleep presets across all beacons.
- **MITRE ATT&CK Coverage** - heatmap by tactic with per-agent tagging.
- **Watchdog** - rules engine with Slack/Discord/Teams webhook alerts.
- **Multi-Teamserver** - switch between teamserver connections.

### Pivot Graph
Topology view with **firewall boundary**, agents in **real pivot order**, colour-coded edges,
**orange dashed lateral-move edges**, drag nodes, scroll-zoom, pan, and per-teamserver saved layout.

---

## Quick start

**Prerequisites**

- **Go 1.25.6+** with `GOTOOLCHAIN=auto`
- **[Wails v2 CLI](https://wails.io/docs/gettingstarted/installation)** `go install github.com/wailsapp/wails/v2/cmd/wails@latest`
- **Linux WebKit deps** `sudo apt install libgtk-3-dev libwebkit2gtk-4.1-dev build-essential pkg-config`
- **A Sliver operator `.cfg`** `sliver-server operator --name <you> --lhost <host> --save <you>.cfg`

**Build & run**

```bash
go mod tidy
make build            # → build/bin/sliver-gui   (or: wails build -tags webkit2_41)
./build/bin/sliver-gui
```

> Hot reload: `make dev` · tests & linters: `make test` · `make lint` · `make vet`
> On WebKit 4.0 systems, use `make build TAGS=` (drop the `webkit2_41` tag).

---

## Usage

1. **Connect** - select your operator `.cfg`.
2. **Listen** - start a listener (Listeners panel, or `mtls 8443` in the server console).
3. **Generate** - build an implant against that listener's C2, then **Save to disk**.
4. **Run** it on the target - the session/beacon appears in the table and graph.
5. **Interact** - double-click the agent, or `use <id>` in the server console.

<details>
<summary><b>Full command reference</b></summary>

<br>

**Per-agent:** `ps · ls · cd · pwd · cat · mkdir · rm · mv · cp · chmod · chown · download · upload ·
screenshot · netstat · ifconfig · env · getenv · setenv · unsetenv · reg · grep · mount · memfiles ·
ssh · whoami · getprivs · getpid · procdump · kill · chtimes · execute · execute-assembly ·
execute-shellcode · sideload · spawndll · getsystem · make-token · impersonate · rev2self · runas ·
migrate · backdoor · dllhijack · msf · msf-inject · extensions · ext · socks · portfwd · rportfwd ·
wg-portfwd · wg-socks · pivot · services · loot · shell · shell -i / pty`
&nbsp;&nbsp;·&nbsp;&nbsp;beacon-only: `tasks · reconfig · interactive`

**Server:** `sessions · beacons · jobs [kill] · restart-jobs · operators · loot · hosts · creds ·
builds · regenerate · profiles · c2profiles · certificates · compiler · builders · traffic-encoders ·
shellcode-encoders · armory [install/remove] · websites · canaries · stager · use · rename ·
kill-session · kill-beacon · version · mtls/http/https/dns/wg`

</details>

---

## Notes

- **Sessions vs. beacons** - sessions are real-time; beacon output is delayed by the check-in interval (± jitter).
- **`getsystem <profile>`** builds from a saved profile, so the profile must be complete and buildable.
- **Symbol obfuscation** is off by default so builds work on a stock teamserver (no garble required).

## Roadmap

`crack` (hashcat cluster) · `cursed` (Chrome/Electron injection) · WASM extension *execution* · external builder log streaming.

---

## Credits

Forked from [Mr-In4inci3le/sliver-gui](https://github.com/Mr-In4inci3le/sliver-gui) by Raj Kumar Mullapudi.
This fork adds a redesigned UI, improved beacon polling, script manager enhancements, website cloner,
and various bug fixes.

Powered by the **[Sliver C2 framework](https://github.com/BishopFox/sliver)** (BishopFox) and
**[Wails](https://wails.io)**. Sliver GUI is a client interface only - it does not modify or
redistribute the framework.

## License

GPL-3.0 - see [LICENSE](LICENSE) for details.

<sub>Sliver C2 - BishopFox</sub>
