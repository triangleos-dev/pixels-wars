# Pixel Wars

A multiplayer "country battle" on a 100x100 pixel board. Runs entirely on Cloudflare's free plan
(Workers + D1) and gets a free `*.workers.dev` address.

## How it plays

- You must register / log in to see or use anything. **One account per IP address.**
- Create a faction (unique name, unique color, pick your spawn pixel) or join an existing one. You can leave at any time.
- Every player can claim **1 pixel every 4 minutes**.
- New pixels must touch your faction's land. You can capture enemy pixels, except capitals (the spawn pixel).
- A faction whose last member leaves dissolves and its land becomes neutral.
- Hover any pixel to see which faction owns it. The **Players** tab lists everyone with their faction.

## Deploy (free)

```bash
wrangler login
wrangler d1 create pixel-wars          # copy database_id into wrangler.toml
wrangler d1 execute pixel-wars --remote --file=schema.sql
wrangler secret put ADMIN_KEY          # long random string, see "Admin" below
wrangler deploy
```

### Upgrading an existing deployment

```bash
wrangler d1 execute pixel-wars --remote --file=migrations/002_ip_limit_and_bans.sql   # once
wrangler secret put ADMIN_KEY
wrangler deploy
```

## Admin

- Set the secret with `wrangler secret put ADMIN_KEY` (generate one with `openssl rand -base64 32`).
- Open `/admin.html` on your site and paste the key to list players, **ban** (with an optional reason shown to the player) and **unban**.
- Names `triangle`, `admin`, `moderator`... are reserved. To play as `triangle`, register that name in the normal form; it asks for the admin key. That account is exempt from the IP limit and can't be banned.
- Banning logs the player out everywhere, removes them from their faction (an emptied faction dissolves) and blocks login. Since their account keeps its IP, they also can't just make a new one from the same address.

## Notes

- IPs are stored only as a salted hash (IPv6 is reduced to its /64). Changing `ADMIN_KEY` changes the salt, which resets the IP limit for existing accounts.
- Accounts created before the IP limit existed get their IP recorded the next time they log in.
- Limitation: players on the same network (family, school, mobile carrier NAT) share an IP and can't both register. Raise or remove the check in `register()` if that's a problem.
- Passwords: PBKDF2-SHA256, 100k iterations, per-user salt. Sessions: random tokens in an HttpOnly cookie, stored hashed.
- All rules are enforced on the server. Tunable constants are at the top of `src/worker.js`.
