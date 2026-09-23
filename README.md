# Car Spec Bluffing

Multiplayer Fibbage-style game about obscure car specs.  
Stack: Node + Express + WebSocket (`ws`) + static browser client. Deck is local JSON — no external API.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000

## Deploy globally (Railway — recommended)

This repo already includes a `Dockerfile` + `railway.toml`.

1. Push is done: https://github.com/shivansh488/car-spec-bluffing
2. Go to [railway.app](https://railway.app) → **Login with GitHub**
3. **New Project** → **Deploy from GitHub repo** → select `car-spec-bluffing`
4. Railway builds the Docker image and assigns a public URL
5. In the service → **Settings** → **Networking** → **Generate Domain**
6. Open that `*.up.railway.app` URL on two phones — same game, worldwide

Optional CLI (after `npm i -g @railway/cli` and `railway login`):

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
