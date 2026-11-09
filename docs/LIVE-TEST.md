# Going live: laptop + one PC

This is the short path to run Kraken Hub in the café for real: your **laptop as the
server** (the counter brain) and your **desktop PC as a customer station**. Both machines must
be on the **same network** (same Wi‑Fi/router or the same switch).

---

## Part 1 — The laptop (server)

1. **Get the app onto the laptop.** Easiest with Git:
   ```powershell
   git clone https://github.com/UncleKraken/kraken-hub.git
   ```
   No Git? Download the ZIP from the GitHub page (green **Code** button → **Download ZIP**) and
   unzip it, e.g. to `C:\KrakenHub`.

2. **Run the installer.** Open the `kraken-hub\scripts` folder and **double‑click `setup.bat`**.
   Click **Yes** on the Windows admin prompt. It will, on its own:
   - install Node.js if it's missing,
   - build the app,
   - open the firewall (ports 7300 and 7301),
   - set the server to **start automatically every time the laptop boots**,
   - start it now.

   To start with a demo café to click around first, double‑click `setup.bat` and choose demo, or
   run `setup.bat seed` from a terminal. Skip that for your real café.

3. **Read the address it prints** at the end, for example:
   ```
   On this laptop:     http://localhost:7300
   From a PC / tablet: http://192.168.1.10:7300
   ```
   Write down that `192.168.1.x` number — the PCs and your phone/tablet use it. (It's the laptop's
   local IP; if you ever forget it, run `ipconfig` and read "IPv4 Address".)

4. **Set up the venue.** On the laptop open `http://localhost:7300`. The first screen creates your
   venue and manager account. Then open **Settings** and add, in order: **prices → stations**
   (use "Add several" for rows of PCs) **→ products → staff**, plus euro if you take it. Lay out
   the room in **Settings → Floor map** if you like. Then start a shift.

> **Tip:** give the laptop a fixed IP in your router (or reserve its address) so the PCs don't
> lose it after a reboot. Keep the laptop plugged in; it's now the counter.

---

## Part 2 — The desktop PC (customer station)

1. On the PC, download **`KrakenHubClient.exe`** from the
   [client-latest release](https://github.com/UncleKraken/kraken-hub/releases/tag/client-latest).
2. Put it somewhere permanent, e.g. `C:\KrakenHub\KrakenHubClient.exe`, and **run it as
   administrator the first time** (right‑click → Run as administrator).
3. It tries to find the laptop by itself. If it can't, type the laptop's address
   (`192.168.1.10`) and the admin code (default `1234`) on its connect screen.
   - Before it ever connects it's in **setup mode** — a normal window you can **minimize** to reach
     the Windows desktop, so you're never locked out while configuring the PC.
4. On the **laptop counter**, the PC shows up as *"…wants to join"*. **Approve it** and pick which
   station it is (e.g. PC‑01). From now on that PC locks between sessions and unlocks when you start
   one from the counter.

No real PC handy to test the customer side? Open `http://<laptop-ip>:7300/client` in any browser —
it pairs and appears on the counter exactly like a station.

---

## Daily use

- **Turn the laptop on** → the server starts by itself. Open `http://localhost:7300`, sign in,
  start your shift.
- **Power cut?** When the laptop comes back the server restarts on its own and offers to resume the
  sessions that were running.
- **Back up safe.** Your data lives in `C:\ProgramData\KrakenHub\data` — *outside* the app folder —
  so updating never touches it. The app also keeps rolling backups (Settings → Data).

## Updating later

When I ship fixes, double‑click **`scripts\update.bat`** on the laptop. It pulls the new version,
rebuilds, and restarts — your data stays put. (If you installed from a ZIP instead of Git, download
the new ZIP, unzip over the folder, and run `setup.bat` again.)

## If something's off

- Logs are in `C:\ProgramData\KrakenHub\logs` — send me the newest `server-*.log` if the counter
  won't load.
- A PC can't reach the laptop: check both are on the same network, and that the laptop's IP still
  matches what the PC has. Re‑run `setup.bat` to re‑open the firewall if needed.
