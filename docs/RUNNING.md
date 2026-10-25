# Running Kraken Hub

This is the developer setup for the pilot. A one-click Windows installer comes in Phase 2.

## Install on the host PC (Windows)

1. Install **Node.js 22 LTS or newer** from nodejs.org. No build tools are needed: the database is built into Node.
2. Install **Git**, or download the repository as a ZIP from GitHub and unzip it.
3. Open **PowerShell** in the project folder and run:

   ```powershell
   git clone https://github.com/UncleKraken/kraken-hub.git
   cd kraken-hub
   npm install
   npm run build
   ```

## Start it

```powershell
npm start
```

The host listens on port **7300**. On the host PC open `http://localhost:7300`. On the counter PC or a tablet open `http://<host-ip>:7300` (find the IP with `ipconfig`). Allow Node.js through Windows Firewall on private networks when Windows asks.

The first time, the app asks you to set up the venue and create the manager account. Then open **Settings** (top right, or on the start-shift screen) and add, in this order: prices, stations (use "Add several" for rows of PCs), products, staff, and any extra currency like euro. After that, start a shift and the floor is ready.

## Try it with demo data

On a fresh install, before starting:

```powershell
npm run seed
npm start
```

This creates a demo café (10 PCs, 2 PS5s, a sim rig, pool and ping pong, a drinks menu, lek and euro). Logins: `admin` / `admin123` (manager) and `operator` / `1234` (operator).

## Where data lives

Everything is in one SQLite file: `host/data/kraken-hub.db` (plus `-wal` and `-shm` files next to it while running). To start over, stop the host and delete the `host/data` folder. Back this folder up; automatic backups come later.

Change the location with the `KRAKEN_DATA_DIR` environment variable, and the port with `PORT`.

## Update to the latest version

```powershell
git pull
npm install
npm run build
npm start
```

Database changes are applied automatically on start.

## Development

```bash
npm run dev:host   # host with auto-reload on :7300
npm run dev:web    # web app with hot reload on :5173 (proxies to the host)
npm test           # host tests
npm run typecheck  # both workspaces
```
