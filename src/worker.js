// Pixel Wars backend: Cloudflare Worker + D1 (free plan compatible)

const SIZE = 100;
const COOLDOWN = 10 * 60 * 1000; // 1 pixel per player per 10 minutes
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

async function getUser(req, env) {
  const token = getCookie(req, 'sid');
  if (!token) return null;
  const th = await sha(token);
  return env.DB.prepare(
    'SELECT u.id, u.username, u.faction_id, u.last_move FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?1 AND s.expires > ?2'
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

async function register(req, env) {
  const b = await readBody(req);
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return err('Username: 3-20 letters, digits or underscore');
  if (password.length < 6 || password.length > 72) return err('Password must be 6-72 characters');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPw(password, salt);
  let res;
  try {
    res = await env.DB.prepare('INSERT INTO users(username, salt, pass_hash, created_at) VALUES(?1, ?2, ?3, ?4)')
      .bind(username, b64(salt), hash, Date.now())
      .run();
  } catch {
    return err('Username already taken', 409);
  }
  return startSession(env, res.meta.last_row_id);
}

async function login(req, env) {
  const b = await readBody(req);
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  const u = await env.DB.prepare('SELECT id, salt, pass_hash FROM users WHERE username = ?1').bind(username).first();
  if (!u) return err('Wrong username or password', 401);
  const hash = await hashPw(password, unb64(u.salt));
  if (!safeEqual(hash, u.pass_hash)) return err('Wrong username or password', 401);
  return startSession(env, u.id);
}

async function logout(req, env) {
  const token = getCookie(req, 'sid');
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha(token)).run();
  return json({ ok: true }, 200, { 'set-cookie': 'sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
}

async function state(url, user, env) {
  const since = Math.max(0, parseInt(url.searchParams.get('since') || '0', 10) || 0);
  const [px, fs, me] = await env.DB.batch([
    env.DB.prepare('SELECT x, y, faction_id f, capital c, updated_at u FROM pixels WHERE updated_at >= ?1').bind(since),
    env.DB.prepare(
      'SELECT f.id, f.name, f.color, f.capital_x cx, f.capital_y cy, f.pixels, (SELECT COUNT(*) FROM users WHERE faction_id = f.id) members FROM factions f ORDER BY f.pixels DESC, f.id ASC'
    ),
    env.DB.prepare('SELECT id, username, faction_id, last_move FROM users WHERE id = ?1').bind(user.id),
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
    factions: fs.results,
    me: { id: m.id, username: m.username, faction_id: m.faction_id, next_at: m.last_move + COOLDOWN },
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
  const b = await readBody(req);
  const fid = Number(b.faction_id);
  const f = await env.DB.prepare('SELECT id FROM factions WHERE id = ?1').bind(fid).first();
  if (!f) return err('Faction not found', 404);
  await env.DB.prepare('UPDATE users SET faction_id = ?1 WHERE id = ?2').bind(fid, user.id).run();
  return json({ ok: true });
}

async function leaveFaction(user, env) {
  const fid = user.faction_id;
  if (!fid) return err('You are not in a faction');
  await env.DB.prepare('UPDATE users SET faction_id = NULL WHERE id = ?1').bind(user.id).run();
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
  return json({ ok: true });
}

async function claimPixel(req, user, env) {
  if (!user.faction_id) return err('Join or create a faction first');
  const b = await readBody(req);
  const x = Number(b.x);
  const y = Number(b.y);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= SIZE || y >= SIZE)
    return err('Invalid pixel');
  const now = Date.now();
  if (now - user.last_move < COOLDOWN)
    return json({ error: 'Cooldown active', next_at: user.last_move + COOLDOWN }, 429);

  const mine = user.faction_id;
  const old = await env.DB.prepare('SELECT faction_id, capital FROM pixels WHERE x = ?1 AND y = ?2').bind(x, y).first();
  if (old && old.faction_id === mine) return err('This pixel already belongs to your faction');
  if (old && old.capital) return err('Capitals are protected and cannot be captured');

  // Must border your faction's territory.
  const adj = await env.DB.prepare(
    'SELECT 1 FROM pixels WHERE faction_id = ?1 AND ((x = ?2 AND y = ?3) OR (x = ?4 AND y = ?5) OR (x = ?6 AND y = ?7) OR (x = ?8 AND y = ?9)) LIMIT 1'
  )
    .bind(mine, x - 1, y, x + 1, y, x, y - 1, x, y + 1)
    .first();
  if (!adj) return err('You can only expand to pixels touching your faction');

  // Atomically reserve the cooldown so parallel requests cannot double-claim.
  const reserve = await env.DB.prepare('UPDATE users SET last_move = ?1 WHERE id = ?2 AND last_move <= ?3')
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
      'UPDATE pixels SET faction_id = ?1, updated_at = ?2 WHERE x = ?3 AND y = ?4 AND faction_id = ?5 AND capital = 0'
    )
      .bind(mine, now, x, y, old.faction_id)
      .run();
  }
  if (!res.meta.changes) {
    await env.DB.prepare('UPDATE users SET last_move = ?1 WHERE id = ?2 AND last_move = ?3')
      .bind(user.last_move, user.id, now)
      .run();
    return err('Someone changed that pixel just now, try again', 409);
  }
  const stmts = [env.DB.prepare('UPDATE factions SET pixels = pixels + 1 WHERE id = ?1').bind(mine)];
  if (old && old.faction_id)
    stmts.push(env.DB.prepare('UPDATE factions SET pixels = pixels - 1 WHERE id = ?1').bind(old.faction_id));
  await env.DB.batch(stmts);
  return json({ ok: true, next_at: now + COOLDOWN });
}

async function route(req, env) {
  const url = new URL(req.url);
  const p = url.pathname;
  const m = req.method;

  if (m === 'POST') {
    const origin = req.headers.get('origin');
    if (origin && origin !== url.origin) return err('Bad origin', 403);
  }

  if (m === 'POST' && p === '/api/register') return register(req, env);
  if (m === 'POST' && p === '/api/login') return login(req, env);
  if (m === 'POST' && p === '/api/logout') return logout(req, env);

  const user = await getUser(req, env);
  if (!user) return err('Not logged in', 401);

  if (m === 'GET' && p === '/api/state') return state(url, user, env);
  if (m === 'POST' && p === '/api/faction/create') return createFaction(req, user, env);
  if (m === 'POST' && p === '/api/faction/join') return joinFaction(req, user, env);
  if (m === 'POST' && p === '/api/faction/leave') return leaveFaction(user, env);
  if (m === 'POST' && p === '/api/claim') return claimPixel(req, user, env);
  return err('Not found', 404);
}

export default {
  async fetch(req, env) {
    try {
      return await route(req, env);
    } catch (e) {
      console.error(e);
      return err('Server error', 500);
    }
  },
};
