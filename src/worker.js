// Pixel Wars backend: Cloudflare Worker + D1 (free plan compatible)

const SIZE = 100;
const COOLDOWN = 1 * 60 * 1000; // 1 pixel per player per 1 minute
const CAPITAL_SHIELD = 60 * 60 * 1000; // a new faction's capital can't be captured for 1 hour
const NEW_ACCOUNT_JOIN_DELAY = 60 * 60 * 1000; // new accounts can't join a faction for 1 hour (they may create their own)
// Names nobody can register normally; creating one needs the admin key.
const RESERVED = ['triangle', 'admin', 'administrator', 'moderator', 'mod', 'system', 'staff'];
const SESSION_MS = 30 * 24 * 3600 * 1000;
const PBKDF2_ITER = 100000; // Workers maximum
const MIN_COLOR_DISTANCE = 30; // RGB distance; blocks near-identical colors

const enc = new TextEncoder();

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
const err = (message, status = 400) => json({ error: message }, status);

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function hashPw(password, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER },
    key,
    256
  );
  return b64(bits);
}
async function sha(s) {
  return b64(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

async function readBody(req) {
  try {
    const b = await req.json();
    return b && typeof b === 'object' ? b : {};
  } catch {
    return {};
  }
}

function getCookie(req, name) {
  const c = req.headers.get('cookie') || '';
  for (const part of c.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

// One account per IP: we store only a peppered hash of the address (IPv6 → /64 prefix).
function clientIp(req) {
  const ip = req.headers.get('cf-connecting-ip');
  if (!ip) return null;
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':'); // good enough /64
  return ip;
}
async function ipHash(req, env) {
  const ip = clientIp(req);
  return ip ? sha('ip:' + (env.ADMIN_KEY || '') + ':' + ip) : null;
}
// Device cookie: a random id per browser. We store only its hash, and use it to spot twin accounts.
const DID_RE = /^[A-Za-z0-9_-]{43}$/;
const newDeviceId = () => b64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function recordDevice(env, user, dh) {
  if (!dh || RESERVED.includes(String(user.username).toLowerCase())) return; // admin accounts are never flagged
  await env.DB.prepare('INSERT OR IGNORE INTO user_devices(user_id, device_hash, first_seen) VALUES(?1, ?2, ?3)')
    .bind(user.id, dh, Date.now())
    .run();
}
async function isAdminKey(key, env) {
  if (!env.ADMIN_KEY || typeof key !== 'string' || !key) return false;
  return safeEqual(await sha(key), await sha(env.ADMIN_KEY));
}

async function getUser(req, env) {
  const token = getCookie(req, 'sid');
  if (!token) return null;
  const th = await sha(token);
  return env.DB.prepare(
    'SELECT u.id, u.username, u.faction_id, u.last_move, u.bonus_moves, u.created_at, u.banned, u.ban_reason FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?1 AND s.expires > ?2'
  )
    .bind(th, Date.now())
    .first();
}

async function startSession(env, userId) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const token = b64(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires < ?1').bind(now),
    env.DB.prepare('INSERT INTO sessions(token_hash, user_id, expires) VALUES(?1, ?2, ?3)').bind(
      await sha(token),
      userId,
      now + SESSION_MS
    ),
  ]);
  return json(
    { ok: true },
    200,
    { 'set-cookie': `sid=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MS / 1000}` }
  );
}

async function register(req, env, dh) {
  const b = await readBody(req);
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return err('Username: 3-20 letters, digits or underscore');
  if (password.length < 6 || password.length > 72) return err('Password must be 6-72 characters');
  // Reserved names (e.g. "triangle") need the admin key; that account is exempt from the IP limit.
  let isAdminAccount = false;
  if (RESERVED.includes(username.toLowerCase())) {
    if (!(await isAdminKey(b.admin_key, env)))
      return json({ error: 'This username is reserved', code: 'reserved' }, 403);
    isAdminAccount = true;
  }
  const ih = isAdminAccount ? null : await ipHash(req, env);
  if (ih) {
    const used = await env.DB.prepare('SELECT 1 FROM users WHERE ip_hash = ?1').bind(ih).first();
    if (used) return err('Only one account per IP address is allowed', 409);
  }
  if (!isAdminAccount) {
    // Same browser already used by another account (including banned ones) → refuse.
    const dev = await env.DB.prepare('SELECT 1 FROM user_devices WHERE device_hash = ?1 LIMIT 1').bind(dh).first();
    if (dev) return err('This device already has an account. Only one account per player is allowed', 409);
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPw(password, salt);
  let res;
  try {
    res = await env.DB.prepare(
      'INSERT INTO users(username, salt, pass_hash, ip_hash, created_at) VALUES(?1, ?2, ?3, ?4, ?5)'
    )
      .bind(username, b64(salt), hash, ih, Date.now())
      .run();
  } catch (e) {
    if (String(e && e.message).includes('ip_hash')) return err('Only one account per IP address is allowed', 409);
    return err('Username already taken', 409);
  }
  await recordDevice(env, { id: res.meta.last_row_id, username }, dh);
  return startSession(env, res.meta.last_row_id);
}

async function login(req, env, dh) {
  const b = await readBody(req);
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  const u = await env.DB.prepare('SELECT id, salt, pass_hash, ip_hash, banned, ban_reason FROM users WHERE username = ?1')
    .bind(username)
    .first();
  if (!u) return err('Wrong username or password', 401);
  const hash = await hashPw(password, unb64(u.salt));
  if (!safeEqual(hash, u.pass_hash)) return err('Wrong username or password', 401);
  if (u.banned) return json({ error: banMessage(u.ban_reason), code: 'banned' }, 403);
  // Accounts created before the IP limit existed get their IP recorded on first login (if still free).
  if (!u.ip_hash && !RESERVED.includes(username.toLowerCase())) {
    const ih = await ipHash(req, env);
    if (ih) {
      try {
        await env.DB.prepare('UPDATE users SET ip_hash = ?1 WHERE id = ?2 AND ip_hash IS NULL').bind(ih, u.id).run();
      } catch { /* another account already uses this IP: leave it unset */ }
    }
  }
  await recordDevice(env, { id: u.id, username }, dh);
  return startSession(env, u.id);
}

const banMessage = (reason) => 'This account is banned' + (reason ? ': ' + reason : '');

async function logout(req, env) {
  const token = getCookie(req, 'sid');
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha(token)).run();
  return json({ ok: true }, 200, { 'set-cookie': 'sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
}

async function state(url, user, env, dh) {
  const since = Math.max(0, parseInt(url.searchParams.get('since') || '0', 10) || 0);
  // Once per page load (the full-map request): note which browser this account is used from.
  if (since === 0) await recordDevice(env, user, dh);
  const [px, fs, me, ann] = await env.DB.batch([
    env.DB.prepare('SELECT x, y, faction_id f, capital c, updated_at u FROM pixels WHERE updated_at >= ?1').bind(since),
    env.DB.prepare(
      'SELECT f.id, f.name, f.color, f.capital_x cx, f.capital_y cy, f.pixels, f.created_at, (SELECT COUNT(*) FROM users WHERE faction_id = f.id) members FROM factions f ORDER BY f.pixels DESC, f.id ASC'
    ),
    env.DB.prepare('SELECT id, username, faction_id, last_move, bonus_moves, created_at FROM users WHERE id = ?1').bind(user.id),
    env.DB.prepare("SELECT v FROM settings WHERE k = 'announcement'"),
  ]);
  let cursor = since;
  const cells = px.results.map((r) => {
    if (r.u > cursor) cursor = r.u;
    return [r.x, r.y, r.f, r.c];
  });
  const m = me.results[0];
  return json({
    now: Date.now(),
    size: SIZE,
    cooldown: COOLDOWN,
    cursor,
    cells,
    factions: fs.results.map((f) => ({ ...f, shield_until: f.created_at + CAPITAL_SHIELD })),
    announcement: (ann.results[0] && ann.results[0].v) || '',
    me: {
      id: m.id,
      username: m.username,
      faction_id: m.faction_id,
      next_at: m.last_move + COOLDOWN,
      bonus_moves: m.bonus_moves,
      join_at: m.created_at + NEW_ACCOUNT_JOIN_DELAY, // before this time the account can only create a faction
    },
  });
}

async function createFaction(req, user, env) {
  if (user.faction_id) return err('Leave your current faction first');
  const b = await readBody(req);
  const name = String(b.name || '').trim().replace(/\s+/g, ' ');
  const color = String(b.color || '').toLowerCase();
  const x = Number(b.x);
  const y = Number(b.y);
  if (!/^[\p{L}\p{N} _-]{3,20}$/u.test(name)) return err('Faction name: 3-20 letters, digits, spaces, _ or -');
  if (!/^#[0-9a-f]{6}$/.test(color)) return err('Invalid color');
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= SIZE || y >= SIZE)
    return err('Pick a spawn point on the map');

  const existing = (await env.DB.prepare('SELECT name, color FROM factions').all()).results;
  const [r, g, bl] = hexRgb(color);
  for (const f of existing) {
    if (f.name.toLowerCase() === name.toLowerCase()) return err('Faction name already taken', 409);
    const [r2, g2, b2] = hexRgb(f.color);
    if (Math.hypot(r - r2, g - g2, bl - b2) < MIN_COLOR_DISTANCE)
      return err('That color is taken or too similar to another faction', 409);
  }

  const now = Date.now();
  let fid;
  try {
    const res = await env.DB.prepare(
      'INSERT INTO factions(name, color, capital_x, capital_y, pixels, created_at) VALUES(?1, ?2, ?3, ?4, 1, ?5)'
    )
      .bind(name, color, x, y, now)
      .run();
    fid = res.meta.last_row_id;
  } catch {
    return err('Name or color already taken', 409);
  }
  const claim = await env.DB.prepare(
    'INSERT INTO pixels(x, y, faction_id, capital, updated_at) VALUES(?1, ?2, ?3, 1, ?4) ON CONFLICT(x, y) DO UPDATE SET faction_id = excluded.faction_id, capital = 1, updated_at = excluded.updated_at WHERE pixels.faction_id = 0'
  )
    .bind(x, y, fid, now)
    .run();
  if (!claim.meta.changes) {
    await env.DB.prepare('DELETE FROM factions WHERE id = ?1').bind(fid).run();
    return err('That pixel is already taken, choose another spawn', 409);
  }
  await env.DB.prepare('UPDATE users SET faction_id = ?1 WHERE id = ?2').bind(fid, user.id).run();
  return json({ ok: true, faction_id: fid });
}

async function joinFaction(req, user, env) {
  if (user.faction_id) return err('Leave your current faction first');
  const wait = user.created_at + NEW_ACCOUNT_JOIN_DELAY - Date.now();
  if (wait > 0)
    return err(`New accounts can join a faction in ${Math.ceil(wait / 60000)} min. You can create your own faction now.`, 403);
  const b = await readBody(req);
  const fid = Number(b.faction_id);
  const f = await env.DB.prepare('SELECT id FROM factions WHERE id = ?1').bind(fid).first();
  if (!f) return err('Faction not found', 404);
  await env.DB.prepare('UPDATE users SET faction_id = ?1 WHERE id = ?2').bind(fid, user.id).run();
  return json({ ok: true });
}

async function removeFromFaction(env, userId, fid) {
  await env.DB.prepare('UPDATE users SET faction_id = NULL WHERE id = ?1').bind(userId).run();
  const left = await env.DB.prepare('SELECT COUNT(*) n FROM users WHERE faction_id = ?1').bind(fid).first();
  if (left.n === 0) {
    // Empty faction dissolves; its land becomes neutral again.
    await env.DB.batch([
      env.DB.prepare('UPDATE pixels SET faction_id = 0, capital = 0, updated_at = ?1 WHERE faction_id = ?2').bind(
        Date.now(),
        fid
      ),
      env.DB.prepare('DELETE FROM factions WHERE id = ?1').bind(fid),
    ]);
  }
}

async function leaveFaction(user, env) {
  const fid = user.faction_id;
  if (!fid) return err('You are not in a faction');
  await removeFromFaction(env, user.id, fid);
  return json({ ok: true });
}

// Player list with each player's faction (banned players are hidden).
async function players(env) {
  const rows = await env.DB.prepare(
    'SELECT u.username n, u.faction_id f, u.claims c FROM users u WHERE u.banned = 0 ORDER BY u.username COLLATE NOCASE LIMIT 1000'
  ).all();
  return json({ players: rows.results.map((r) => [r.n, r.f || 0, r.c || 0]) });
}

// Recent captures. since=0 returns the latest 30; otherwise only events newer than that id.
async function feed(url, env) {
  const since = Math.max(0, parseInt(url.searchParams.get('since') || '0', 10) || 0);
  const rows = since
    ? (await env.DB.prepare('SELECT * FROM events WHERE id > ?1 ORDER BY id ASC LIMIT 50').bind(since).all()).results
    : (await env.DB.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 30').all()).results.reverse();
  return json({ now: Date.now(), events: rows });
}

/* ---------- Admin (protected by the ADMIN_KEY secret, sent in the x-admin-key header) ---------- */
async function admin(req, url, env) {
  if (!(await isAdminKey(req.headers.get('x-admin-key'), env))) return err('Wrong admin key', 403);
  const p = url.pathname;

  if (req.method === 'GET' && p === '/api/admin/users') {
    const rows = await env.DB.prepare(
      'SELECT u.id, u.username, u.faction_id, f.name faction, f.color, u.banned, u.ban_reason, u.created_at, u.last_move, u.bonus_moves, u.claims, (SELECT GROUP_CONCAT(DISTINCT u2.username) FROM user_devices d1 JOIN user_devices d2 ON d2.device_hash = d1.device_hash AND d2.user_id != d1.user_id JOIN users u2 ON u2.id = d2.user_id WHERE d1.user_id = u.id) same_device FROM users u LEFT JOIN factions f ON f.id = u.faction_id ORDER BY u.banned DESC, u.created_at DESC LIMIT 2000'
    ).all();
    const fl = await env.DB.prepare('SELECT id, name, color, pixels FROM factions ORDER BY name COLLATE NOCASE').all();
    return json({ users: rows.results, factions: fl.results, reserved: RESERVED });
  }

  if (req.method === 'POST' && (p === '/api/admin/ban' || p === '/api/admin/unban')) {
    const b = await readBody(req);
    const id = Number(b.user_id);
    const u = await env.DB.prepare('SELECT id, username, faction_id FROM users WHERE id = ?1').bind(id).first();
    if (!u) return err('User not found', 404);
    if (RESERVED.includes(u.username.toLowerCase())) return err('Cannot ban a reserved/admin account');
    if (p === '/api/admin/unban') {
      await env.DB.prepare('UPDATE users SET banned = 0, ban_reason = NULL WHERE id = ?1').bind(id).run();
      return json({ ok: true });
    }
    const reason = String(b.reason || '').trim().slice(0, 120) || null;
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET banned = 1, ban_reason = ?1 WHERE id = ?2').bind(reason, id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(id), // log them out everywhere
    ]);
    if (u.faction_id) await removeFromFaction(env, id, u.faction_id);
    return json({ ok: true });
  }

  // Give or clear a rectangle of map pixels. Capitals are never overwritten or cleared here.
  if (req.method === 'POST' && p === '/api/admin/pixels') {
    const b = await readBody(req);
    const cl = (v) => Math.min(SIZE - 1, Math.max(0, Math.trunc(Number(v))));
    if (![b.x1, b.y1, b.x2, b.y2].every((v) => Number.isFinite(Number(v)))) return err('Enter x1, y1, x2, y2');
    const x1 = Math.min(cl(b.x1), cl(b.x2)), x2 = Math.max(cl(b.x1), cl(b.x2));
    const y1 = Math.min(cl(b.y1), cl(b.y2)), y2 = Math.max(cl(b.y1), cl(b.y2));
    const now = Date.now();
    if (b.action === 'give') {
      const f = await env.DB.prepare('SELECT id FROM factions WHERE id = ?1').bind(Number(b.faction_id)).first();
      if (!f) return err('Pick a faction', 404);
      await env.DB.prepare(
        'WITH RECURSIVE xs(x) AS (SELECT ?1 UNION ALL SELECT x + 1 FROM xs WHERE x < ?2), ys(y) AS (SELECT ?3 UNION ALL SELECT y + 1 FROM ys WHERE y < ?4) INSERT INTO pixels(x, y, faction_id, capital, updated_at) SELECT xs.x, ys.y, ?5, 0, ?6 FROM xs, ys WHERE true ON CONFLICT(x, y) DO UPDATE SET faction_id = excluded.faction_id, updated_at = excluded.updated_at WHERE pixels.capital = 0'
      )
        .bind(x1, x2, y1, y2, f.id, now)
        .run();
    } else if (b.action === 'clear') {
      await env.DB.prepare(
        'UPDATE pixels SET faction_id = 0, updated_at = ?1 WHERE x BETWEEN ?2 AND ?3 AND y BETWEEN ?4 AND ?5 AND capital = 0 AND faction_id != 0'
      )
        .bind(now, x1, x2, y1, y2)
        .run();
    } else return err('Unknown action');
    await recount(env);
    return json({ ok: true, rect: [x1, y1, x2, y2] });
  }

  // Destroy a faction: its land becomes neutral and its members become factionless.
  if (req.method === 'POST' && p === '/api/admin/faction/delete') {
    const b = await readBody(req);
    const id = Number(b.faction_id);
    const f = await env.DB.prepare('SELECT id FROM factions WHERE id = ?1').bind(id).first();
    if (!f) return err('Faction not found', 404);
    await env.DB.batch([
      env.DB.prepare('UPDATE pixels SET faction_id = 0, capital = 0, updated_at = ?1 WHERE faction_id = ?2').bind(Date.now(), id),
      env.DB.prepare('UPDATE users SET faction_id = NULL WHERE faction_id = ?1').bind(id),
      env.DB.prepare('DELETE FROM factions WHERE id = ?1').bind(id),
    ]);
    return json({ ok: true });
  }

  // Wipe the whole map (all land, all factions, the feed). Accounts, bans and passwords stay.
  if (req.method === 'POST' && p === '/api/admin/reset') {
    const b = await readBody(req);
    if (b.confirm !== 'RESET') return err('Type RESET to confirm');
    await env.DB.batch([
      env.DB.prepare('UPDATE pixels SET faction_id = 0, capital = 0, updated_at = ?1 WHERE faction_id != 0 OR capital != 0').bind(Date.now()),
      env.DB.prepare('UPDATE users SET faction_id = NULL'),
      env.DB.prepare('DELETE FROM factions'),
      env.DB.prepare('DELETE FROM events'),
    ]);
    return json({ ok: true });
  }

  // Give (or take away, with a negative number) bonus pixels: each one lets a player claim during cooldown.
  if (req.method === 'POST' && p === '/api/admin/bonus') {
    const b = await readBody(req);
    const amount = Math.trunc(Number(b.amount));
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1000) return err('Amount must be between -1000 and 1000');
    const r = await env.DB.prepare('UPDATE users SET bonus_moves = MAX(0, bonus_moves + ?1) WHERE id = ?2')
      .bind(amount, Number(b.user_id))
      .run();
    return r.meta.changes ? json({ ok: true }) : err('User not found', 404);
  }

  if (req.method === 'POST' && p === '/api/admin/cooldown') {
    const b = await readBody(req);
    const r = await env.DB.prepare('UPDATE users SET last_move = 0 WHERE id = ?1').bind(Number(b.user_id)).run();
    return r.meta.changes ? json({ ok: true }) : err('User not found', 404);
  }

  // Message shown at the top of the game for everyone. Empty text removes it.
  if (req.method === 'POST' && p === '/api/admin/announce') {
    const b = await readBody(req);
    const text = String(b.text || '').trim().slice(0, 200);
    if (text) await env.DB.prepare("INSERT INTO settings(k, v) VALUES('announcement', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(text).run();
    else await env.DB.prepare("DELETE FROM settings WHERE k = 'announcement'").run();
    return json({ ok: true });
  }
  return err('Not found', 404);
}

async function recount(env) {
  await env.DB.prepare('UPDATE factions SET pixels = (SELECT COUNT(*) FROM pixels p WHERE p.faction_id = factions.id)').run();
}

async function claimPixel(req, user, env) {
  if (!user.faction_id) return err('Join or create a faction first');
  const b = await readBody(req);
  const x = Number(b.x);
  const y = Number(b.y);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= SIZE || y >= SIZE)
    return err('Invalid pixel');
  const now = Date.now();
  // On cooldown, a bonus pixel (given by the admin) can be spent instead.
  const useBonus = now - user.last_move < COOLDOWN;
  if (useBonus && !(user.bonus_moves > 0))
    return json({ error: 'Cooldown active', next_at: user.last_move + COOLDOWN }, 429);

  const mine = user.faction_id;
  const old = await env.DB.prepare('SELECT faction_id, capital FROM pixels WHERE x = ?1 AND y = ?2').bind(x, y).first();
  if (old && old.faction_id === mine) return err('This pixel already belongs to your faction');
  const victim =
    old && old.faction_id
      ? await env.DB.prepare('SELECT id, name, color, created_at FROM factions WHERE id = ?1').bind(old.faction_id).first()
      : null;
  const fell = !!(old && old.capital && victim); // capturing a capital destroys the whole faction
  if (fell) {
    const left = victim.created_at + CAPITAL_SHIELD - now;
    if (left > 0) return err(`This capital is shielded for ${Math.ceil(left / 60000)} more min`, 403);
  }

  // Must border your faction's territory.
  const adj = await env.DB.prepare(
    'SELECT 1 FROM pixels WHERE faction_id = ?1 AND ((x = ?2 AND y = ?3) OR (x = ?4 AND y = ?5) OR (x = ?6 AND y = ?7) OR (x = ?8 AND y = ?9)) LIMIT 1'
  )
    .bind(mine, x - 1, y, x + 1, y, x, y - 1, x, y + 1)
    .first();
  if (!adj) return err('You can only expand to pixels touching your faction');

  // Atomically reserve the cooldown (or one bonus pixel) so parallel requests cannot double-claim.
  const reserve = useBonus
    ? await env.DB.prepare('UPDATE users SET bonus_moves = bonus_moves - 1 WHERE id = ?1 AND bonus_moves > 0').bind(user.id).run()
    : await env.DB.prepare('UPDATE users SET last_move = ?1 WHERE id = ?2 AND last_move <= ?3')
        .bind(now, user.id, now - COOLDOWN)
        .run();
  if (!reserve.meta.changes) return err('Cooldown active', 429);

  let res;
  if (!old) {
    res = await env.DB.prepare(
      'INSERT OR IGNORE INTO pixels(x, y, faction_id, capital, updated_at) VALUES(?1, ?2, ?3, 0, ?4)'
    )
      .bind(x, y, mine, now)
      .run();
  } else {
    res = await env.DB.prepare(
      'UPDATE pixels SET faction_id = ?1, capital = 0, updated_at = ?2 WHERE x = ?3 AND y = ?4 AND faction_id = ?5'
    )
      .bind(mine, now, x, y, old.faction_id)
      .run();
  }
  if (!res.meta.changes) {
    // Lost a race: give the cooldown / bonus back.
    await (useBonus
      ? env.DB.prepare('UPDATE users SET bonus_moves = bonus_moves + 1 WHERE id = ?1').bind(user.id)
      : env.DB.prepare('UPDATE users SET last_move = ?1 WHERE id = ?2 AND last_move = ?3').bind(user.last_move, user.id, now)
    ).run();
    return err('Someone changed that pixel just now, try again', 409);
  }
  const stmts = [
    env.DB.prepare('UPDATE factions SET pixels = pixels + 1 WHERE id = ?1').bind(mine),
    env.DB.prepare('UPDATE users SET claims = claims + 1 WHERE id = ?1').bind(user.id),
  ];
  if (fell) {
    // The capital is gone: every other pixel of that faction turns neutral and its members are left without a faction.
    stmts.push(
      env.DB.prepare('UPDATE pixels SET faction_id = 0, capital = 0, updated_at = ?1 WHERE faction_id = ?2').bind(now, victim.id),
      env.DB.prepare('UPDATE users SET faction_id = NULL WHERE faction_id = ?1').bind(victim.id),
      env.DB.prepare('DELETE FROM factions WHERE id = ?1').bind(victim.id)
    );
  } else if (old && old.faction_id) {
    stmts.push(env.DB.prepare('UPDATE factions SET pixels = pixels - 1 WHERE id = ?1').bind(old.faction_id));
  }
  if (victim) {
    const mf = await env.DB.prepare('SELECT name, color FROM factions WHERE id = ?1').bind(mine).first();
    stmts.push(
      env.DB.prepare('INSERT INTO events(t, kind, actor, fa, ca, fv, cv, x, y) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)').bind(
        now, fell ? 'fall' : 'capture', user.username, mf ? mf.name : '?', mf ? mf.color : '#888888', victim.name, victim.color, x, y
      ),
      env.DB.prepare('DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - 200')
    );
  }
  await env.DB.batch(stmts);
  return json({ ok: true, fell, next_at: useBonus ? user.last_move + COOLDOWN : now + COOLDOWN });
}

async function route(req, env, dh) {
  const url = new URL(req.url);
  const p = url.pathname;
  const m = req.method;

  if (m === 'POST') {
    const origin = req.headers.get('origin');
    if (origin && origin !== url.origin) return err('Bad origin', 403);
  }

  if (m === 'POST' && p === '/api/register') return register(req, env, dh);
  if (m === 'POST' && p === '/api/login') return login(req, env, dh);
  if (m === 'POST' && p === '/api/logout') return logout(req, env);

  if (p.startsWith('/api/admin/')) return admin(req, url, env);

  const user = await getUser(req, env);
  if (!user) return err('Not logged in', 401);
  if (user.banned) return json({ error: banMessage(user.ban_reason), code: 'banned' }, 403);

  if (m === 'GET' && p === '/api/state') return state(url, user, env, dh);
  if (m === 'GET' && p === '/api/players') return players(env);
  if (m === 'GET' && p === '/api/feed') return feed(url, env);
  if (m === 'POST' && p === '/api/faction/create') return createFaction(req, user, env);
  if (m === 'POST' && p === '/api/faction/join') return joinFaction(req, user, env);
  if (m === 'POST' && p === '/api/faction/leave') return leaveFaction(user, env);
  if (m === 'POST' && p === '/api/claim') return claimPixel(req, user, env);
  return err('Not found', 404);
}

export default {
  async fetch(req, env) {
    try {
      // Every visitor gets a long-lived random device cookie (even before logging in).
      let did = getCookie(req, 'did');
      const fresh = !did || !DID_RE.test(did);
      if (fresh) did = newDeviceId();
      const res = await route(req, env, await sha('dev:' + did));
      if (fresh) res.headers.append('set-cookie', `did=${did}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=34560000`);
      return res;
    } catch (e) {
      console.error(e);
      return err('Server error', 500);
    }
  },
};
