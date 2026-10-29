# Kraken Hub client (Windows)

The app that runs on each customer PC. It shows the counter's customer screens full-screen,
locks the PC between sessions, shrinks to a corner widget while a session runs, and carries
out restart / shut down / log off when the counter asks.

## Install on a customer PC

1. Download `KrakenHubClient.exe` from the
   [client-latest release](https://github.com/UncleKraken/kraken-hub/releases/tag/client-latest).
2. Put it somewhere permanent, e.g. `C:\KrakenHub\KrakenHubClient.exe`.
3. Run it once **as administrator** the first time (right-click → Run as administrator), so it
   can register itself to start for every Windows user and save its pairing for the whole PC.
4. It finds the counter automatically. If it can't (different network segment, firewall), staff
   type the counter's address and the admin code (default `1234`).
5. On the counter, the PC appears as "*PC name* wants to join". Approve it and pick its station.

The host PC must allow Node.js through Windows Firewall (TCP 7300, UDP 7301) on private networks.

### Setup mode (before the first connection)

Until a PC has reached the counter at least once, the client runs in **setup mode**: it does
**not** lock the desktop. It shows the connect screen in a normal, minimizable window with a
**"Minimize to set up this PC"** button, so whoever installs it can reach the Windows desktop to
finish configuring the machine instead of being trapped behind the connect screen. The moment it
connects successfully it marks the PC configured and, from then on, locks down normally on every
boot (and fails closed if the counter is unreachable). Only a fresh, never-connected install is
minimizable — a deployed PC is already configured, so customers can't reach setup mode.

## Staff menu

Press **Ctrl + Alt + Shift + F12** on the customer PC and enter the admin code to change the
counter address or close the client. Change the code in `C:\ProgramData\KrakenHub\client.json`.

## Health reporting

Every 30 seconds the client sends the counter a small health snapshot — disk space, memory,
CPU load, uptime and, where the hardware exposes it, temperature — plus one-off events it
notices: an unclean shutdown (power loss or hard crash, detected from a run marker) and a
WebView crash. The counter raises a floor alert when free disk or temperature crosses the
thresholds in Settings → Venue. Temperature comes from the ACPI thermal zone and isn't
available on every PC; the snapshot simply omits what it can't read. No extra privileges or
install are needed.

## Files on the PC

- `C:\ProgramData\KrakenHub\client.json`: counter address, pairing secret, admin code
- `C:\ProgramData\KrakenHub\running.flag`: marker used to detect an unclean shutdown
- `%LocalAppData%\KrakenHub\client.log`: log for troubleshooting

## What's not done yet

- Lockdown policies (Task Manager, settings, command prompt) and the per-session profile wipe:
  next step. Until then, use a standard (non-admin) Windows account for customers.
- A protection service that restarts the client if it's killed.
- Headset/mouse auto-fixes.
