# Pixel Wars

A multiplayer "country battle" on a 100x100 pixel board. Runs entirely on Cloudflare's free plan
(Workers + D1) and gets a free `*.workers.dev` address.

## How it plays

- You must register / log in to see or use anything. **One account per IP address.**
- Create a faction (unique name, unique color, pick your spawn pixel) or join an existing one. You can leave at any time.
- Every player can claim **1 pixel every minute**.
- New pixels must touch your faction's land. You can capture enemy pixels.
- **Capture a faction's capital and the whole faction falls**: its land turns neutral and its members are left without a faction. A new faction's capital is shielded for its first hour (`CAPITAL_SHIELD` in `src/worker.js`).
- A faction whose last member leaves dissolves and its land becomes neutral.
- Side panel tabs: Factions (with % of the map), Players (A-Z or most claims) and a live Feed of captures.
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
npx wrangler d1 execute pixel-wars --remote --file=migrations/002_ip_limit_and_bans.sql   # only if not done yet
npx wrangler d1 execute pixel-wars --remote --file=migrations/003_devices.sql             # only if not done yet
npx wrangler d1 execute pixel-wars --remote --file=migrations/004_features.sql            # once
npx wrangler deploy
```

## Against twink accounts

- One account per IP address, and one per browser (a random device cookie; only its hash is stored).
- Accounts created in the last hour can create their own faction but can't join an existing one yet.
- Every login from a browser is remembered. In `/admin.html`, accounts that were used from the same browser show "same device as: ..." and can be filtered with "Same-device only".
- A banned account keeps its IP and browser, so it can't just register again from them.
- Limits: someone who uses a VPN *and* a clean/private browser window for each account can still get through, and people sharing a computer or network can be blocked by mistake. Use the admin panel to review such cases.

## Admin

- Set the secret with `wrangler secret put ADMIN_KEY` (generate one with `openssl rand -base64 32`).
- Open `/admin.html` on your site and paste the key to list players, **ban** (with an optional reason shown to the player) and **unban**.
- Names `triangle`, `admin`, `moderator`... are reserved. To play as `triangle`, register that name in the normal form; it asks for the admin key. That account is exempt from the IP limit and can't be banned.
- Banning logs the player out everywhere, removes them from their faction (an emptied faction dissolves) and blocks login. Since their account keeps its IP, they also can't just make a new one from the same address.

## Admin tools (`/admin.html`)

- **Give / clear pixels:** pick a rectangle (x1,y1 to x2,y2) and give it to a faction or make it neutral. Capitals are never overwritten or cleared by this.
- **Destroy a faction**, or **reset the whole map** (type RESET; accounts and bans stay).
- **+Pixels** on a player: bonus pixels let them claim during cooldown (negative numbers remove them). **Reset timer** clears a player's cooldown.
- **Announcement:** a banner shown at the top of the game for everyone.

## Notes

- IPs are stored only as a salted hash (IPv6 is reduced to its /64). Changing `ADMIN_KEY` changes the salt, which resets the IP limit for existing accounts.
- Accounts created before the IP limit existed get their IP recorded the next time they log in.
- Limitation: players on the same network (family, school, mobile carrier NAT) share an IP and can't both register. Raise or remove the check in `register()` if that's a problem.
- Passwords: PBKDF2-SHA256, 100k iterations, per-user salt. Sessions: random tokens in an HttpOnly cookie, stored hashed.
- All rules are enforced on the server. Tunable constants are at the top of `src/worker.js`.
