# Kraken Hub — Product Spec

Last updated: 2026-10-25 · Owner: @UncleKraken

> Diagrams (guest approval flow, architecture, roadmap) live in the [living spec doc](https://claude.ai/artifact/CvuNQqXjeAEjUNgV5tACiU). This file is the version-controlled copy.

## Vision and positioning

Kraken Hub is venue software built for the operator: one screen that runs the whole floor, whether it holds PCs, PlayStations, sim rigs, pool tables, ping pong or board games. Existing tools (ggLeap, iCafe, Gizmo, SENET) are built for the manager and make the operator's shift harder.

**What we win on**

- **Reliable over fancy:** offline-safe, no duplicate orders, every action confirms it worked.
- **Learnable in 10 minutes:** if a new employee needs training, the screen is wrong.
- **Everything the venue rents:** PCs, consoles, sims and physical tables in one system, one timer model, one tab model.
- **Real Windows desktop for customers:** not a locked gaming-only shell. Not everyone comes to game.
- **Remote fixes:** most problems are software and get fixed with one tap from the counter or by the IT technician from another branch.
- **Free while we build:** no paywall until mainstream release.

**Pain points this answers** (from running a café on ggLeap and iCafe): slow client boot, frozen web panel, duplicate orders, no per-PC tabs, no shift revenue or tips view, hard-to-learn UI, broken remote access, clumsy game updates, high ping from background downloads, and peripherals that stop working after being swapped between PCs.

## Roles and permissions

The operator gets the full daily toolbox; the manager holds the keys; every action by anyone is signed and kept.

| Area | Operator | Manager | IT technician |
| --- | --- | --- | --- |
| Sessions on any station (start, extend, pause, end, move) | Yes | Yes | No |
| Orders, tabs, move/merge tabs, checkout | Yes | Yes | No |
| Small fixes (remove a wrong item within the manager's time window) | Yes, logged | Yes | No |
| Refunds, voids, big discounts, editing closed tabs | Approval (PIN or remote tap) | Yes | No |
| Bookings: create, edit, move, cancel | View + check in | Yes | No |
| Stations, products, prices, employees, settings | No | Yes | No |
| Inventory: receive delivery, mark waste, spot counts | Yes | Yes | No |
| Restart, shutdown, wake, remote view, updates | Yes | Yes | Yes |
| Health history, logs, all branches remotely | Own branch | Yes | Yes |
| Own shift: revenue, tips, drawer | Yes | All shifts | No |
| Money and sales reports | No | Yes | No |

**Audit log rules**

- Every change records who, when, what, and the before/after values.
- A manager acting inside the operator panel is labelled as the manager, so the operator is never blamed.
- Nobody can edit or delete log entries, the manager included.
- Operators sign in with username and password and press Start shift / End shift to register a shift.

## Stations and sessions

Everything rentable is a **station**: something used for a time, with a tab attached. Only the control method differs, so a new station type is configuration, not new code.

| Station type | Control method | Started by | Priced by |
| --- | --- | --- | --- |
| PC | Client agent (lock, unlock, launch, remote, update) | Customer request + operator approval, or operator | Hourly |
| Sim rig | Client agent | Operator | Hourly |
| Console (PS5, Xbox) | Manual timer, optional smart plug / HDMI-CEC | Operator | Hourly by player count (1P, 2P, 4P) |
| Pool, ping pong, table games | Manual timer, optional smart plug for the light | Operator | Hourly, per game, or per session |

**Session rules**

- **Prepaid:** time or a bundle bought up front; the station locks (or the operator is alerted) when it runs out.
- **Postpaid:** open timer; time posts to the tab when the session ends.
- **Player count can change mid-session:** a new segment starts at the new rate and the bill adds the segments.
- **Group sessions:** several stations linked into one group tab at start.
- **Rounding:** per minute or per 15-minute block, plus an optional minimum charge, set by the manager.

**The floor map** is the operator's home screen: one card per station with a colour for free, busy, ending soon, reserved or problem, plus time and tab total. Every common action (start, add item, extend, move, checkout) is 1–3 taps. Alerts appear for prepaid time ending and for forgotten timers ("Pool 2 open for 3 hours").

## Money

The operator never calculates: the app prices time, totals tabs, works out change, and reconciles the drawer. Every money action goes into an append-only ledger, so nothing is edited or deleted, only reversed by a new signed entry.

**Tabs and checkout**

- Every station has its own tab: time, drinks, snacks.
- Tabs can be moved between stations, merged for a group, or split per station, per person, by item, or equally.
- Checkout shows one total with the breakdown, quick-cash buttons for real notes (200, 500, 1000, 2000, 5000 L), and the change to give back in large type.
- Totals can round to the nearest 10 L.
- Payment: cash, card (recorded manually with the existing terminal at first), member balance, or mixed.
- Every order carries a unique ID created on the device, so a double tap or a network retry can never create a duplicate.

**Currencies**

- Lek is the base currency; the manager adds accepted currencies (euro first) with a rate.
- Totals show in both (2,450 L / €24.50); mixed payment is allowed; change is always given in lek.
- The drawer tracks each currency separately and the shift count asks for each.

**Sales vs collections**

- Sales belong to the shift in which the service happened; collections belong to whoever takes the money.
- Unpaid tabs at shift end are handed over as "open tabs from previous shift." Each operator is reconciled only on cash they actually collected.

**Shifts and cash drawer**

1. Start shift: sign in, confirm the opening float (pre-filled with what the last shift left).
2. During the shift: cash refunds and payouts are recorded against this drawer.
3. End shift: optional blind count (count before seeing the expected figure), enter float left for the next shift and cash sent to the office, hand over open tabs. The report goes to the manager automatically.

Expected cash = opening float + cash collected − cash paid out. Counted − expected = the difference.

**Tips (kept separate from revenue)**

- **+Tip** button at checkout when the customer says "keep the change"; card tips recorded the same way and paid out from the drawer at shift end.
- At shift end the operator can mark part of a positive difference as tips; the rest shows as over/short and is flagged to the manager.
- Shared shifts: the manager picks one rule — whoever collected it, equal split, or split by hours worked.
- Shift report lists tips by source and currency.

**Refunds and corrections**

- The manager can refund, remove or add items on open or closed tabs; operators can make the small fixes the manager allows.
- A refund appears as a new negative line on the order panel with who, when and a required reason; the original line stays.
- Stock is returned or written off as waste, by choice.
- Reports show gross sales, refunds and net, per shift, branch and person.

**Customer transparency**

- PC customers see a live tab (time, rate, every order, running total) and a popup whenever the operator adds an item.
- Consoles, tables and the counter: a customer-facing screen (tablet or second monitor) mirrors checkout.
- Itemised receipt with timestamps, printed or as a QR code.

## Customers and PC client

Guest is the default, member accounts are optional and light, and there is no customer phone app: PC customers self-serve on the PC, everything else is run by the operator.

**Customer types**

- **Guest:** one tap to start, no name, files wiped after.
- **Member:** username and password, phone optional; ID collection off by default (manager can enable). Gets bundles, points, saved files. Works at every branch.
- **Group:** temporary link of stations for one shared tab.

**Bundles and points:** fully configurable bundles (1 h, 2 h, 5 h…, validity, station types), points earned per hour and per lek, redeemable for bundles or snacks. Member balance is optional and off by default.

**Lock screen:** café banner, member login in the middle, **Continue as guest** underneath. The operator can also pre-start a guest session from the counter.

**Guest approval flow** (diagram in the living doc)

1. Customer taps **Continue as guest**; the PC shows "Request sent."
2. Operator gets an alert with any booking warning ("PC-07 booked at 18:00, 40 min free").
3. Operator chooses: **Approve** (prepaid or postpaid), **Approve with limit** (ends before the booking), **Move** (use another PC), or **Deny** (see the counter).
4. No answer in 1–2 minutes: the PC tells the customer to go to the counter.

Members skip approval unless the PC is booked soon (the manager can require approval for everyone).

**During a session** the customer has the normal Windows desktop plus a small floating widget: time left and live tab, order drinks and snacks (sent to the station's tab, operator alerted), request assistance ("PC problem", "need headphones", "call operator"), request an extension, self-fix buttons ("No sound?", "Mouse not working?"), and end session.

## Client desktop

Customers get a real Windows desktop that is safely limited and resets after every session, instead of a locked gaming-only shell.

- **Standard (non-admin) Windows account** for customers: Windows itself blocks driver installs, system settings and other users' files.
- **The agent runs as a protected system service**, so it can't be closed from Task Manager or uninstalled.
- **Lockdown presets** applied automatically by the installer and editable by the manager, pushed to all PCs from the host:
  - **Work:** full desktop, browser, Office, printing, USB for files; settings, command prompt and installing blocked.
  - **Gaming:** Work plus game launchers.
  - **Strict:** only an approved list of apps runs.
- Under the hood: Group Policy and registry policies plus app-control policies, depending on the Windows edition.
- **Session wipe:** each session gets a fresh temporary Windows profile, deleted when the operator ends the session or the customer logs out. Downloads, browser history, logins and changed settings disappear; the next customer gets a clean desktop in seconds without a reboot.
- **Member files** (Desktop, Documents, game saves, configs) sync to the host every few seconds and before any wipe. Game save locations come from Ludusavi's open-source list.
- **Crash rule:** after an unexpected shutdown the profile is kept for a grace period (default 30 min) in case the customer returns, then wiped.
- Cafés that want a full system freeze can keep diskless reset-on-reboot or Deep Freeze alongside Kraken Hub.

## Setup, pairing and storage modes

One installer for every PC; setup is "install, approve, done."

**Setup flow**

1. Run the installer on the main PC and choose **Host**. It configures itself as a Windows service and opens the **Add PCs** tab.
2. Run the installer on each customer PC and choose **Client**. It finds the host on the local network automatically.
3. The host shows "PC-07 wants to join"; the operator taps **Approve**. Pairing creates a secure token, so random PCs can't join.
4. After a restart, the host controls the PC.

**Faster rollout:** the host can build a pre-paired installer for a USB stick or shared folder; run it on each PC and it joins with no prompts.

**What the client installer does silently:** registers the agent service, applies the lockdown preset, opens firewall ports, enables Wake-on-LAN where possible, and names the PC (PC-01, PC-02…, renamable).

**Storage modes** (chosen at setup, so cafés keep the setup they already have)

| Mode | How games are stored | What Kraken Hub does | When |
| --- | --- | --- | --- |
| Local | Windows and games on each PC's own drive | Full support; updates pushed per PC overnight | Phase 1–2 |
| CCBoot / diskless | PCs boot Windows and games from a server; reset on reboot | Agent installed in the master image; PC identity by network card MAC, not disk | After pilot |
| Network game disk | Windows on local SSD, games on one shared virtual disk on the host | Master game disk updated once; each client mounts it as a local drive with a personal write overlay wiped on restart; clients switch to a new version at restart or idle, never mid-game | Prototype first, then build |
| Local + sync | Games on local SSDs, synced from a master | Only changed files copied overnight, peer to peer between PCs | Later option |

The network game disk is the riskiest part: plain shared folders break launchers and anti-cheat, so it must be a virtual disk (VHDX differencing disks first, iSCSI as fallback). Prototype on 3–4 PCs with Valorant, CS2 and Fortnite before committing. Host hardware: fast NVMe; 10 Gb networking on the host helps past about 15 PCs.

## Reliability

Core rule: nothing important lives only on the client. Sessions, tabs and orders live on the host; clients report and cache.

| Failure | What happens |
| --- | --- |
| Client loses network, host fine | Session keeps running locally; time and events logged with unique IDs; prepaid time still ends on schedule offline; everything syncs on reconnect with no duplicates; "offline" badge meanwhile |
| One PC crashes or loses power | Host notices the missing heartbeat and auto-pauses the session (no charge for dead time); customer logs back in and resumes, or the operator moves the session to another PC in one tap; profile kept for the grace period |
| Whole café loses power | Crash-safe database (SQLite in WAL mode) loses no committed transaction; on restart the operator sees "Power restored: N sessions interrupted" with Resume all / Review; time paused at the last heartbeat |
| Host PC dies | Clients keep counting offline; host database backed up nightly (cloud or a second PC); "Restore host on a new PC" in a few clicks |
| Internet down | Branch keeps working fully on the local network; cloud features resume when it returns |

**Recommended hardware:** a UPS on the host PC and network switch; the host detects the battery and shuts down cleanly.

## Health, auto-fixes and network

The fix ladder is: auto-fix first, operator one tap second, IT technician remotely third. Only physical hardware faults need someone on site.

| Problem | Detection | Fix |
| --- | --- | --- |
| High ping from background downloads | Agents measure ping and per-PC bandwidth | Launcher downloads paused during active sessions and run when idle or closed; **Boost PC-07** throttles every other PC's background traffic for 10 min |
| Overheating, throttling, lag | CPU/GPU temperature and clock speed (LibreHardwareMonitor) | Alert ("PC-04 GPU 94°C, throttling") so the operator moves the customer; per-PC history shows IT which PCs need cleaning |
| PC shuts off mid-game | Windows event log read after reboot | Likely cause reported: power loss, overheating, or driver crash with error code; session auto-paused |
| Slow boot | Boot time tracked per PC | Flag when far above average ("3 min vs 40 s"); agent starts as a light service |
| No sound or mic after headset swap | Device plug-in events | On plug-in: set as default speaker and mic, unmute, allow mic access; customer "No sound?" button runs the same fix |
| Mouse or keyboard stuck or lagging | Device disconnect/reconnect events | Restart that USB device in software; customer "Mouse not working?" button |
| Frozen app or PC | Agent heartbeat | Kill app, restart game, restart/shutdown/wake PC, remote view, mark Out of order |
| Peripheral taken | Unplug event | Alert "PC-09 headset unplugged" |

**Router support works with any router.** Layer 1 needs no router access: agents throttle background downloads with Windows' built-in traffic controls and measure network health themselves, so every café gets Boost and monitoring. Layer 2 adds optional router plug-ins for real per-PC limits and stats: MikroTik (RouterOS API) first, then OpenWrt, pfSense/OPNsense, Ubiquiti UniFi and TP-Link Omada by demand. All plug-ins share one internal interface.

**Windows updates:** usually disabled by IT through Group Policy; Kraken Hub can enforce "night only" or "paused" if the manager wants.

## Bookings

The manager owns bookings; the operator sees them and acts on arrival.

- **Manager:** creates, edits, moves and cancels bookings from any device, including a phone during the call.
- **Operator:** sees bookings on the floor map and timeline, cannot change them, taps **Check in** when the customer arrives to start the booked stations.
- **A booking holds:** customer name and phone, stations, date, start, duration, notes, optional deposit, source (phone, message, Instagram).
- **Reserved hold:** the station shows "Reserved 18:00" a set time ahead (default 15 min).
- **Conflicts:** guest requests on a soon-booked PC trigger the warning and time-limit option.
- **No-show:** after the grace time (default 15 min) the operator is prompted and the manager is notified to decide on release.
- Instagram integration is a later phase.

## Inventory

Stock is per branch, managed by the manager, with the operator confirming deliveries.

1. Stock goes down automatically with every sale.
2. Low-stock alert to the manager ("Branch 2: Red Bull, 6 left, minimum 24").
3. The manager creates a restock order: items, quantities, branch.
4. On delivery the operator opens the order and enters what actually arrived per item: complete, short or damaged.
5. The manager reviews and confirms; stock updates; missing items stay visible until resolved with the supplier.

**Extras:** spot counts the manager can request at shift end (differences show as shrinkage), and waste marked with a reason, never silently deducted.

## Multi-branch and cloud

Each branch runs its own host and keeps working without internet; the cloud connects branches.

- **Local at each branch:** sessions, tabs, orders, shifts, the floor. A branch never stops because the internet did.
- **Cloud:** owner dashboard across branches, IT technician remote access, reports, member accounts, backups. Each host keeps an outbound connection to a small cloud relay, so no router setup or port forwarding is needed.
- **Catalog:** one company catalog of products and station prices; per branch the manager can override a price, hide a product or add branch-only items.
- **Members:** shared across branches, cached on each host. While a branch is offline, bundle spending is capped so a balance can't be double-spent at two branches; it syncs on reconnect.
- **Staff and IT:** the IT technician role sees health, logs and remote access for every branch, with no access to money.

## Languages

Translation support is built in from day one: every text in translation files, right-to-left layout for Arabic, local currency and date formats. Launch ships English and Albanian; the rest follow where gaming cafés are big.

1. English (launch)
2. Albanian (launch)
3. Spanish
4. Portuguese (Brazil)
5. Turkish
6. Arabic
7. Russian
8. Vietnamese
9. Indonesian
10. Italian or Greek

## Architecture and tech stack

One web codebase for every screen, a small native agent for deep Windows control, and a local host per branch so the café never depends on the internet.

```
Cloud ── Cloud relay (backups, members, reports) ⇄ Remote access (owner dashboard, IT technician)
  ▲ outbound link only
Branch (works offline)
  Host PC (Windows service) ⇄ Router plug-in (optional)
    ├── Customer PC / sim rig — Hub Client agent (C#/.NET), web lock screen + widget
    ├── Counter PC or tablet — Hub Desk in the browser
    └── Consoles and tables — manual timers, optional smart plugs / HDMI-CEC
```

| Part | Technology | Why |
| --- | --- | --- |
| Host server | Node.js + TypeScript, SQLite (WAL), installed as a Windows service | Type checking catches bugs before they reach the floor; SQLite needs no setup and survives power cuts |
| Hub Desk, Hub Manager | Web app served by the host | Opens on the counter PC, a tablet or a phone with nothing to install |
| Hub Client agent | C# / .NET Windows service | Services, user profiles, audio devices, USB and policies are far more reliable in .NET |
| Client screens | Web pages from the host, shown in WebView2 | UI lives in one place; updating the host updates every client screen |
| Live link | WebSocket over the LAN with heartbeats; every event and order carries a unique ID | Offline-safe sync, no duplicates |
| Cloud relay | Small cloud service, outbound connections only | Owner and IT access from anywhere, no router setup |

## Roadmap to the January pilot

The full design is 6–12 months of work; a solid first version for the pilot by end of January is realistic with a tight scope, and reliability beats feature count.

| Phase | When | Scope |
| --- | --- | --- |
| 1 · Host and Hub Desk | November 2026 | Floor map with all station types; sessions, timers, player rates; per-station tabs and POS; checkout, change, lek and euro; shifts, drawer, tips; append-only ledger and audit log; roles and permissions |
| 2 · Hub Client | December 2026 | Installer and host/client pairing; lock screen and guest approval; lockdown presets and session wipe; widget (time, tab, orders, help); restart, shutdown, wake; offline and crash handling; headset and mouse auto-fix |
| 3 · Pilot and release | January 2027 | Install at the café; bug fixing on the real floor; bookings (manager); inventory and deliveries; health alerts and Boost; Albanian and English UI; release end of January |
| After release | 2027 | Network game disk, CCBoot and diskless support, router plug-ins, multi-branch cloud, remote desktop, members and bundles, more languages, the Pro plan, AI camera tracking |

**Pilot site:** the owner's own café branch, under renovation; PCs and server go in next week. Keep 2–3 PCs free as a test lab, give the host a fast NVMe drive, wire every PC, and put a UPS on the host and switch.

## Business model and open questions

Everything is free while we build; the Pro switch comes only after mainstream release. Features stay cleanly separated in the code so the switch is configuration, not a rewrite.

**Draft for later** (final prices after the pilot):

- **Free:** 1 branch, up to a PC limit (around 10), unlimited consoles, sim rigs and tables, every core operator feature.
- **Pro:** flat monthly price per branch (around €25–40), unlimited PCs, remote desktop, storage modes, router plug-ins, auto-fixes, advanced bookings, full reports.
- **Multi-branch:** Pro per branch at a discount, plus owner dashboard, shared members and the IT technician role.
- Rule: reliability and core operator features are never paywalled.

**Open questions**

- [ ] Final free-tier PC limit and Pro price
- [ ] Trademark search for "Kraken Hub" (EUIPO, WIPO) and domain before international launch
- [ ] Card terminal integration: which terminals are common in Albania
- [ ] Network game disk prototype results (load times, anti-cheat)
- [ ] Receipt printer and customer-facing screen models for the pilot
- [ ] Session wipe timing: on session end (current plan) vs at shutdown
