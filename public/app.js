'use strict';
const N = 100;
const PALETTE = [
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6',
  '#bcf60c', '#fabebe', '#008080', '#e6beff', '#9a6324', '#fffac8', '#800000', '#aaffc3',
  '#808000', '#ffd8b1', '#a0a0a0', '#ff6f91', '#00c2a8', '#ff9f1c', '#7b2cbf', '#2ec4b6',
];
const MIN_DIST = 30;

const $ = (s) => document.querySelector(s);
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of kids) if (c != null) e.append(c);
  return e;
}
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const S = {
  me: null,
  cooldown: 600000,
  factions: new Map(),
  rgb: new Map(),
  fid: new Uint32Array(N * N),
  cap: new Uint8Array(N * N),
  cursor: 0,
  skew: 0,
  sel: null,
  spawn: null,
  pick: false,
  hoverF: 0,
  color: '#e6194b',
  view: { s: 5, x: 0, y: 0 },
  touched: false,
  dirty: true,
  polling: false,
};

/* ---------- API ---------- */
async function api(path, body) {
  const r = await fetch('/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let d = {};
  try { d = await r.json(); } catch { /* ignore */ }
  if (r.status === 401 && path !== '/login' && path !== '/register') {
    showAuth();
    throw new Error('auth');
  }
  if (!r.ok) {
    const e = new Error(d.error || 'Something went wrong');
    e.data = d;
    throw e;
  }
  return d;
}

function toast(msg, kind = 'bad') {
  const t = el('div', { class: 'toast ' + kind }, msg);
  $('#toast').append(t);
  setTimeout(() => t.remove(), 3500);
}

/* ---------- Auth ---------- */
let regMode = false;
function setMode(reg) {
  regMode = reg;
  $('#tabLogin').classList.toggle('on', !reg);
  $('#tabReg').classList.toggle('on', reg);
  $('#aPass2').hidden = !reg;
  $('#aPass2').required = reg;
  $('#aPass').autocomplete = reg ? 'new-password' : 'current-password';
  $('#authBtn').textContent = reg ? 'Create account' : 'Log in';
  $('#authErr').textContent = '';
}
$('#tabLogin').onclick = () => setMode(false);
$('#tabReg').onclick = () => setMode(true);
$('#authForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#authErr').textContent = '';
  const username = $('#aUser').value.trim();
  const password = $('#aPass').value;
  if (regMode && password !== $('#aPass2').value) {
    $('#authErr').textContent = 'Passwords do not match';
    return;
  }
  $('#authBtn').disabled = true;
  try {
    await api(regMode ? '/register' : '/login', { username, password });
    $('#aPass').value = $('#aPass2').value = '';
    await poll(true);
  } catch (err) {
    $('#authErr').textContent = err.message;
  } finally {
    $('#authBtn').disabled = false;
  }
};
function showAuth() {
  $('#auth').hidden = false;
  $('#app').hidden = true;
}
function showApp() {
  $('#auth').hidden = true;
  $('#app').hidden = false;
  resize();
}
$('#logoutBtn').onclick = async () => {
  try { await api('/logout', {}); } catch { /* ignore */ }
  S.cursor = 0;
  S.fid.fill(0);
  S.cap.fill(0);
  S.me = null;
  showAuth();
};

/* ---------- State ---------- */
function applyState(d) {
  S.skew = d.now - Date.now();
  S.cooldown = d.cooldown;
  S.me = d.me;
  S.factions = new Map(d.factions.map((f) => [f.id, f]));
  S.rgb = new Map(d.factions.map((f) => [f.id, hexRgb(f.color)]));
  for (const [x, y, f, c] of d.cells) {
    S.fid[y * N + x] = f;
    S.cap[y * N + x] = c;
  }
  S.cursor = d.cursor;
  rebuild();
  renderAll();
}

async function poll(first = false) {
  if (S.polling) return;
  S.polling = true;
  try {
    const d = await api('/state?since=' + S.cursor);
    const wasHidden = $('#app').hidden;
    applyState(d);
    if (wasHidden || first) {
      showApp();
      if (!S.touched) fit();
    }
  } catch (e) {
    if (e.message !== 'auth') { /* transient network error: ignore */ }
  } finally {
    S.polling = false;
  }
}
setInterval(() => { if (!document.hidden && !$('#app').hidden) poll(); }, 4000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

/* ---------- Cooldown ---------- */
const nowMs = () => Date.now() + S.skew;
const remaining = () => (S.me ? Math.max(0, S.me.next_at - nowMs()) : 0);
function tickCooldown() {
  if (!S.me) return;
  const r = remaining();
  const box = $('#cd');
  if (r <= 0) {
    box.classList.add('ready');
    $('#cdText').textContent = 'Ready to claim';
  } else {
    box.classList.remove('ready');
    const s = Math.ceil(r / 1000);
    $('#cdText').textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    $('#cdBar').style.width = (100 * (1 - r / S.cooldown)).toFixed(1) + '%';
  }
  const btn = $('#claimBtn');
  if (btn) updateClaimBtn(btn);
}
setInterval(tickCooldown, 250);

/* ---------- Rendering: map ---------- */
const cv = $('#map');
const ctx = cv.getContext('2d');
const off = document.createElement('canvas');
off.width = off.height = N;
const octx = off.getContext('2d');
const img = octx.createImageData(N, N);

function rebuild() {
  const d = img.data;
  for (let i = 0; i < N * N; i++) {
    const x = i % N, y = (i / N) | 0;
    let c;
    const f = S.fid[i];
    if (!f) {
      c = (x + y) % 2 ? [22, 27, 41] : [25, 31, 46];
    } else {
      c = S.rgb.get(f) || [128, 128, 128];
      if (S.hoverF && S.hoverF !== f) c = [c[0] * 0.35 + 14, c[1] * 0.35 + 17, c[2] * 0.35 + 26];
    }
    d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255;
  }
  octx.putImageData(img, 0, 0);
  S.dirty = true;
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  if (!S.touched) fit();
  S.dirty = true;
}
window.addEventListener('resize', resize);

function fit() {
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  const s = Math.max(2, Math.floor((Math.min(w, h) * 0.96) / N * 10) / 10);
  S.view = { s, x: (w - N * s) / 2, y: (h - N * s) / 2 };
  S.dirty = true;
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#070a12';
  ctx.fillRect(0, 0, w, h);
  const { s, x: ox, y: oy } = S.view;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, ox, oy, N * s, N * s);

  if (s >= 7) {
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const x0 = Math.max(0, Math.floor(-ox / s)), x1 = Math.min(N, Math.ceil((w - ox) / s));
    const y0 = Math.max(0, Math.floor(-oy / s)), y1 = Math.min(N, Math.ceil((h - oy) / s));
    for (let i = x0; i <= x1; i++) { const px = Math.round(ox + i * s) + 0.5; ctx.moveTo(px, oy + y0 * s); ctx.lineTo(px, oy + y1 * s); }
    for (let j = y0; j <= y1; j++) { const py = Math.round(oy + j * s) + 0.5; ctx.moveTo(ox + x0 * s, py); ctx.lineTo(ox + x1 * s, py); }
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(ox - 0.5, oy - 0.5, N * s + 1, N * s + 1);

  // capitals
  if (s >= 5) {
    for (const f of S.factions.values()) {
      const cx = ox + (f.cx + 0.5) * s, cy = oy + (f.cy + 0.5) * s, r = Math.max(2, s * 0.32);
      ctx.beginPath();
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath();
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.stroke();
    }
  }

  // own territory outline
  const mine = S.me && S.me.faction_id;
  if (mine && s >= 4) {
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = Math.max(1, s * 0.08);
    ctx.beginPath();
    for (let i = 0; i < N * N; i++) {
      if (S.fid[i] !== mine) continue;
      const x = i % N, y = (i / N) | 0;
      const px = ox + x * s, py = oy + y * s;
      if (x === 0 || S.fid[i - 1] !== mine) { ctx.moveTo(px, py); ctx.lineTo(px, py + s); }
      if (x === N - 1 || S.fid[i + 1] !== mine) { ctx.moveTo(px + s, py); ctx.lineTo(px + s, py + s); }
      if (y === 0 || S.fid[i - N] !== mine) { ctx.moveTo(px, py); ctx.lineTo(px + s, py); }
      if (y === N - 1 || S.fid[i + N] !== mine) { ctx.moveTo(px, py + s); ctx.lineTo(px + s, py + s); }
    }
    ctx.stroke();
  }

  const mark = (c, color, lw) => {
    if (!c) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.strokeRect(ox + c.x * s + lw / 2, oy + c.y * s + lw / 2, s - lw, s - lw);
  };
  mark(S.hover, 'rgba(255,255,255,0.7)', 2);
  mark(S.sel, '#ffd34d', 2);
  mark(S.spawn, '#3ddc97', 3);
}

function loop() {
  if (S.dirty) { S.dirty = false; draw(); }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/* ---------- Map interaction ---------- */
function cellAt(cx, cy) {
  const r = cv.getBoundingClientRect();
  const x = Math.floor((cx - r.left - S.view.x) / S.view.s);
  const y = Math.floor((cy - r.top - S.view.y) / S.view.s);
  return x >= 0 && y >= 0 && x < N && y < N ? { x, y } : null;
}

function zoomAt(px, py, factor) {
  const v = S.view;
  const ns = Math.min(60, Math.max(2, v.s * factor));
  const k = ns / v.s;
  v.x = px - (px - v.x) * k;
  v.y = py - (py - v.y) * k;
  v.s = ns;
  S.touched = true;
  S.dirty = true;
}

cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = cv.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.18 : 1 / 1.18);
}, { passive: false });

const ptrs = new Map();
let moved = 0, pinch0 = 0;
cv.addEventListener('pointerdown', (e) => {
  cv.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  moved = 0;
  if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    pinch0 = Math.hypot(a.x - b.x, a.y - b.y);
  }
});
cv.addEventListener('pointermove', (e) => {
  const p = ptrs.get(e.pointerId);
  if (p) {
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (ptrs.size === 1) {
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > 5) {
        S.view.x += dx; S.view.y += dy;
        S.touched = true; S.dirty = true;
        hideTip();
      }
    } else if (ptrs.size === 2) {
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const r = cv.getBoundingClientRect();
      if (pinch0 > 0) zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, d / pinch0);
      pinch0 = d;
      moved = 99;
    }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  } else if (e.pointerType === 'mouse') {
    hoverAt(e);
  }
});
function endPtr(e) {
  const wasClick = ptrs.size === 1 && moved <= 5 && e.type === 'pointerup';
  ptrs.delete(e.pointerId);
  if (wasClick) clickCell(cellAt(e.clientX, e.clientY));
}
cv.addEventListener('pointerup', endPtr);
cv.addEventListener('pointercancel', endPtr);
cv.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { S.hover = null; setHoverF(0); hideTip(); S.dirty = true; } });

function hoverAt(e) {
  const c = cellAt(e.clientX, e.clientY);
  S.hover = c;
  S.dirty = true;
  if (!c) { setHoverF(0); hideTip(); return; }
  const f = S.fid[c.y * N + c.x];
  setHoverF(f);
  showTip(e, c, f);
}
function setHoverF(f) {
  if (S.hoverF !== f) { S.hoverF = f; rebuild(); }
}
function showTip(e, c, f) {
  const tip = $('#tip');
  tip.replaceChildren();
  const coords = el('span', { class: 'muted' }, `(${c.x}, ${c.y}) `);
  if (f && S.factions.has(f)) {
    const fa = S.factions.get(f);
    tip.append(coords, el('span', { class: 'dot', style: `background:${fa.color}` }), el('b', {}, fa.name));
    if (S.cap[c.y * N + c.x]) tip.append(' ◆ capital');
    tip.append(el('div', { class: 'muted small' }, `${fa.pixels} px · ${fa.members} member${fa.members === 1 ? '' : 's'}`));
  } else {
    tip.append(coords, 'Unclaimed');
  }
  tip.hidden = false;
  const r = $('#stage').getBoundingClientRect();
  let x = e.clientX - r.left + 14, y = e.clientY - r.top + 14;
  if (x + tip.offsetWidth > r.width - 4) x = e.clientX - r.left - tip.offsetWidth - 12;
  if (y + tip.offsetHeight > r.height - 4) y = e.clientY - r.top - tip.offsetHeight - 12;
  tip.style.left = Math.max(4, x) + 'px';
  tip.style.top = Math.max(4, y) + 'px';
}
function hideTip() { $('#tip').hidden = true; }

function clickCell(c) {
  if (!c) return;
  if (S.pick) {
    if (S.fid[c.y * N + c.x]) { toast('That pixel is already taken. Pick an empty one.'); return; }
    S.spawn = c;
    S.pick = false;
    $('#pickHint').hidden = true;
    $('#spawnLbl').textContent = `(${c.x}, ${c.y})`;
    $('#pickBtn').textContent = 'Pick on map';
  }
  S.sel = c;
  S.dirty = true;
  renderSel();
}

$('#zIn').onclick = () => { const r = cv.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.4); };
$('#zOut').onclick = () => { const r = cv.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1 / 1.4); };
$('#zFit').onclick = () => { S.touched = false; fit(); };

function focusOn(x, y) {
  const w = cv.clientWidth, h = cv.clientHeight;
  const s = Math.max(S.view.s, 12);
  S.view = { s, x: w / 2 - (x + 0.5) * s, y: h / 2 - (y + 0.5) * s };
  S.touched = true;
  S.dirty = true;
}

/* ---------- Side panel ---------- */
function updateClaimBtn(btn) {
  const c = S.sel;
  if (!c || !S.me) return;
  const f = S.fid[c.y * N + c.x];
  const mine = S.me.faction_id;
  let label = 'Claim this pixel', ok = true;
  if (!mine) { label = 'Join a faction first'; ok = false; }
  else if (f === mine) { label = 'Already yours'; ok = false; }
  else if (S.cap[c.y * N + c.x]) { label = 'Capital is protected'; ok = false; }
  else if (remaining() > 0) { label = 'Cooldown active'; ok = false; }
  btn.textContent = label;
  btn.disabled = !ok;
}

function renderSel() {
  const box = $('#selBox');
  box.replaceChildren();
  const c = S.sel;
  if (!c) {
    box.append(el('h3', {}, 'Selected pixel'), el('div', { class: 'muted' }, 'Click a pixel on the map. Drag to pan, scroll or pinch to zoom.'));
    return;
  }
  const f = S.fid[c.y * N + c.x];
  const fa = f && S.factions.get(f);
  box.append(el('h3', {}, `Pixel (${c.x}, ${c.y})`));
  const owner = el('div', { style: 'margin-bottom:10px' });
  if (fa) {
    owner.append(el('span', { class: 'dot', style: `background:${fa.color}` }), el('b', {}, fa.name));
    if (S.cap[c.y * N + c.x]) owner.append(' ◆ capital');
  } else owner.append('Unclaimed');
  box.append(owner);
  const btn = el('button', { id: 'claimBtn', class: 'primary' }, 'Claim this pixel');
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const r = await api('/claim', { x: c.x, y: c.y });
      S.me.next_at = r.next_at;
      toast('Pixel claimed!', 'good');
    } catch (e) {
      if (e.data && e.data.next_at) S.me.next_at = e.data.next_at;
      toast(e.message);
    }
    await poll();
    tickCooldown();
  };
  box.append(btn);
  updateClaimBtn(btn);
}

function renderTop() {
  $('#userName').textContent = S.me.username;
  tickCooldown();
}

function renderMyFaction() {
  const box = $('#myFaction'), create = $('#createBox');
  const fid = S.me.faction_id;
  const fa = fid && S.factions.get(fid);
  box.hidden = !fa;
  create.hidden = !!fa;
  if (!fa) { renderPalette(); return; }
  box.replaceChildren(
    el('h3', {}, 'Your faction'),
    el('div', { style: 'margin-bottom:10px' },
      el('span', { class: 'dot', style: `background:${fa.color}` }), el('b', {}, fa.name)),
    el('div', { class: 'muted', style: 'margin-bottom:10px' }, `${fa.pixels} pixels · ${fa.members} member${fa.members === 1 ? '' : 's'}`),
    el('div', { class: 'row' },
      el('button', { class: 'ghost', onclick: () => focusOn(fa.cx, fa.cy) }, 'Go to capital'),
      el('button', {
        class: 'danger',
        onclick: async () => {
          if (!confirm('Leave this faction? Your pixels stay with it. If you are the last member, the faction dissolves.')) return;
          try { await api('/faction/leave', {}); } catch (e) { toast(e.message); }
          await poll();
        },
      }, 'Leave faction'))
  );
}

function isTaken(hex) {
  const rgb = hexRgb(hex);
  for (const c of S.rgb.values()) if (dist(rgb, c) < MIN_DIST) return true;
  return false;
}
function renderPalette() {
  const p = $('#palette');
  p.replaceChildren();
  for (const hex of PALETTE) {
    const taken = isTaken(hex);
    const b = el('button', {
      type: 'button',
      class: 'sw' + (taken ? ' taken' : '') + (S.color === hex ? ' sel' : ''),
      style: `background:${hex}`,
      title: taken ? 'Taken' : hex,
    });
    b.onclick = () => { if (!taken) { S.color = hex; $('#fColor').value = hex; renderPalette(); } };
    p.append(b);
  }
}
$('#fColor').oninput = (e) => { S.color = e.target.value.toLowerCase(); renderPalette(); };

$('#pickBtn').onclick = () => {
  S.pick = !S.pick;
  $('#pickHint').hidden = !S.pick;
  $('#pickBtn').textContent = S.pick ? 'Cancel' : 'Pick on map';
};
$('#createBtn').onclick = async () => {
  const name = $('#fName').value.trim();
  if (!name) return toast('Enter a faction name');
  if (!S.spawn) return toast('Pick a spawn point on the map');
  if (isTaken(S.color)) return toast('That color is taken, choose another');
  $('#createBtn').disabled = true;
  try {
    await api('/faction/create', { name, color: S.color, x: S.spawn.x, y: S.spawn.y });
    toast('Faction created!', 'good');
    focusOn(S.spawn.x, S.spawn.y);
    S.spawn = null;
    $('#spawnLbl').textContent = 'not chosen';
    $('#fName').value = '';
  } catch (e) { toast(e.message); }
  $('#createBtn').disabled = false;
  await poll();
};

function renderBoard() {
  const b = $('#board');
  b.replaceChildren();
  const list = [...S.factions.values()];
  if (!list.length) { b.append(el('div', { class: 'muted' }, 'No factions yet. Create the first one!')); return; }
  const mine = S.me.faction_id;
  list.forEach((f, i) => {
    const row = el('div', { class: 'fRow' + (f.id === mine ? ' mine' : '') },
      el('span', { class: 'rank' }, String(i + 1)),
      el('span', { class: 'dot', style: `background:${f.color};margin:0` }),
      el('span', { class: 'nm', title: f.name }, f.name),
      el('span', { class: 'st' }, `${f.pixels}px · ${f.members}👤`));
    if (!mine) {
      row.append(el('button', {
        onclick: async (ev) => {
          ev.stopPropagation();
          try { await api('/faction/join', { faction_id: f.id }); toast('Joined ' + f.name, 'good'); } catch (e) { toast(e.message); }
          await poll();
        },
      }, 'Join'));
    }
    row.onclick = () => focusOn(f.cx, f.cy);
    row.onmouseenter = () => setHoverF(f.id);
    row.onmouseleave = () => setHoverF(0);
    b.append(row);
  });
}

function renderAll() {
  renderTop();
  renderMyFaction();
  renderBoard();
  renderSel();
}

/* ---------- Boot ---------- */
renderSel();
poll(true).then(() => { if ($('#app').hidden) showAuth(); });
