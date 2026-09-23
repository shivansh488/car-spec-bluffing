# Car Spec Bluffing

Multiplayer Fibbage-style game about obscure car specs.  
Stack: Node + Express + WebSocket (`ws`) + static browser client. Deck is local JSON — no external API.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000

## Deploy globally (free — Render)

Railway often requires a paid plan for new accounts. Use **Render** instead (free Web Service).

1. Repo: https://github.com/shivansh488/car-spec-bluffing  
2. Open [render.com](https://render.com) → **Sign up with GitHub**  
3. **New +** → **Web Service** → connect `car-spec-bluffing`  
4. Settings:
   - **Language / Runtime:** Docker (uses the repo `Dockerfile`)
   - **Instance type:** Free
   - **Health check path:** `/api/health`
5. Click **Create Web Service** and wait for the deploy  
6. Open the `https://….onrender.com` URL on two devices and play

Notes:
- Free instances **sleep after ~15 minutes idle**. First open can take 30–60s; then it’s normal.
- WebSockets work on Render HTTPS (`wss://` automatic).
- No env vars required for v1.

### Alternatives (also free-ish)
- **[Fly.io](https://fly.io)** — free allowance; needs `fly launch` + card on file sometimes (may not charge).
- **Local + [Pinggy](https://pinggy.io) / [ngrok](https://ngrok.com)** — free tunnel for a play session (not always-on).

## Deploy on Railway (if you have credits)

This repo already includes a `Dockerfile` + `railway.toml`.

1. [railway.app](https://railway.app) → **Login with GitHub**
2. **New Project** → **Deploy from GitHub repo** → `car-spec-bluffing`
3. **Settings** → **Networking** → **Generate Domain**

Optional CLI (after `railway login`):

```bash
railway init
railway up
railway domain
```

Healthcheck: `GET /api/health` must return `{ ok: true }`.

## 2-device playtest script

1. **Device A (host laptop)**  
   - Open http://localhost:3000 (or your LAN IP, e.g. `http://192.168.x.x:3000`)  
   - Create room → pick name/avatar → note the 4-letter code  
   - Tap **Copy invite** (or share `/r/CODE`)

2. **Device B (phone on same Wi‑Fi)**  
   - Open the invite link or Join with code  
   - Enter a different display name

3. **Lobby**  
   - Host sets rounds (try **3**) and bluff timer (**30s** for a quick test)  
   - Both tap ready (optional)  
   - Host taps **Start game** (enabled only with 2+ players)

4. **One full round**  
   - **Briefing:** same question on both screens; host can skip after 3s  
   - **Bluff:** each writes a fake spec (12–280 chars). Watch the lock pills update. Rejected bluffs show a reason and stay editable.  
   - **Vote:** lineup order matches on both devices. Own card says **Your bluff** and is disabled. Select → **Confirm selection**.  
   - **Reveal:** FACTORY TRUTH badge, authors, vote faces, then score chips (`Spotted…`, `Tricked…`, etc.)  
   - Host taps **Next round** (or wait ~12s)

5. **Finish**  
   - After the last round: podium, Biggest liar, Truth serum  
   - Host **Play again** keeps the same room/players, resets scores, reshuffles the deck

6. **Reconnect check**  
   - Mid-bluff, refresh Device B — it should rejoin the same phase via `localStorage` without changing a locked bluff

## Deck

24 prompts live in [`content/deck.json`](content/deck.json).

## API

- `GET /api/health`
- `GET /api/deck-size`
- `POST /api/rooms` `{ name, avatar }`
- `POST /api/rooms/:code/join` `{ name, avatar }`
- WebSocket on the same origin; first message `identify` with `{ roomCode, playerId }`
