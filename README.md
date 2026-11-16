# Pixel Wars

A multiplayer "country battle" on a 100x100 pixel board. Runs entirely on Cloudflare's free plan
(Workers + D1), and gets a free `*.workers.dev` address.

## How it plays

- You must register / log in to see or use anything.
- Create a faction (unique name, unique color, pick your spawn pixel) or join an existing one. You can leave at any time.
- Every player can claim **1 pixel every 10 minutes** (the timer belongs to the player, so switching factions doesn't reset it).
- New pixels must touch your faction's land. You can capture enemy pixels.
- Each faction's capital (the spawn pixel, shown as a diamond) can't be captured.
- A faction whose last member leaves dissolves and its land becomes neutral.
- Hover any pixel to see which faction owns it. Drag to pan, scroll or pinch to zoom.

## Deploy (free)

You need Node.js and a free Cloudflare account.

```bash
cd pixel-wars
npm install -g wrangler        # or use: npx wrangler ...
wrangler login

# 1. create the database, copy the printed database_id into wrangler.toml
wrangler d1 create pixel-wars

# 2. create tables in the remote database
wrangler d1 execute pixel-wars --remote --file=schema.sql

# 3. publish
wrangler deploy
```

Wrangler prints your URL, like `https://pixel-wars.<your-subdomain>.workers.dev`.

### Local testing

```bash
wrangler d1 execute pixel-wars --local --file=schema.sql
wrangler dev
```

## Notes

- Passwords are hashed with PBKDF2-SHA256 (100,000 iterations) with a per-user salt. Sessions are random tokens in an HttpOnly cookie, stored hashed.
- All rules (cooldown, adjacency, unique color/name) are enforced on the server, so the client can't cheat.
- The client polls every 4 seconds and only downloads pixels that changed, which keeps D1 reads well inside the free limits.
- If you ever see Worker "exceeded CPU" errors when registering or logging in on the free plan, PBKDF2 is the likely cause; the Workers Paid plan removes that limit.
- Tunable constants are at the top of `src/worker.js` (cooldown, color-similarity threshold, map size).
