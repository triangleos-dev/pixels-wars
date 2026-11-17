'use strict';
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
function toast(msg, kind = 'bad') {
  const t = el('div', { class: 'toast ' + kind }, msg);
  $('#toast').append(t);
  setTimeout(() => t.remove(), 3500);
}

// The key lives only in this tab's sessionStorage and is sent as a header on each request.
let KEY = '';
try { KEY = sessionStorage.getItem('adminKey') || ''; } catch { /* ignore */ }
let USERS = [];
let RESERVED = [];
let FACTIONS = [];

async function api(path, body) {
  const r = await fetch('/api/admin' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-admin-key': KEY, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let d = {};
  try { d = await r.json(); } catch { /* ignore */ }
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}

async function load() {
  const d = await api('/users');
  USERS = d.users;
  RESERVED = d.reserved.map((s) => s.toLowerCase());
  FACTIONS = d.factions || [];
  fillFactions();
  $('#keyForm').hidden = true;
  $('#panel').hidden = false;
  render();
}

function render() {
  const q = $('#q').value.trim().toLowerCase();
  const rows = $('#rows');
  rows.replaceChildren();
  const banned = USERS.filter((u) => u.banned).length;
  $('#stats').textContent = `${USERS.length} players · ${banned} banned`;
  const onlySus = $('#sus').checked;
  for (const u of USERS) {
    if (onlySus && !u.same_device) continue;
    if (q && !u.username.toLowerCase().includes(q) && !(u.faction || '').toLowerCase().includes(q)) continue;
    const isAdmin = RESERVED.includes(u.username.toLowerCase());
    const status = u.banned
      ? el('span', { class: 'tag bad', title: u.ban_reason || '' }, 'Banned' + (u.ban_reason ? ': ' + u.ban_reason : ''))
      : el('span', { class: 'tag' }, isAdmin ? 'Admin' : 'Active');
    const action = isAdmin ? '' : u.banned
      ? el('button', { onclick: () => act('/unban', { user_id: u.id }, `Unbanned ${u.username}`) }, 'Unban')
      : el('button', {
          class: 'danger',
          onclick: () => {
            const reason = prompt(`Ban ${u.username}? Optional reason (shown to the player):`, '');
            if (reason === null) return;
            act('/ban', { user_id: u.id, reason }, `Banned ${u.username}`);
          },
        }, 'Ban');
    rows.append(el('tr', { class: u.banned ? 'banned' : '' },
      el('td', {}, el('b', {}, u.username), el('span', { class: 'muted small' }, ` ${u.claims || 0} claims` + (u.bonus_moves ? ` · +${u.bonus_moves} bonus` : '')),
        u.same_device ? el('div', { class: 'small', style: 'color:#ffb454' }, '⚠ same device as: ' + u.same_device.split(',').join(', ')) : null),
      el('td', {}, u.faction
        ? el('span', {}, el('span', { class: 'dot', style: `background:${u.color}` }), u.faction)
        : el('span', { class: 'muted' }, '—')),
      el('td', {}, status),
      el('td', { style: 'text-align:right' }, el('span', { class: 'act' },
        isAdmin ? null : el('button', { class: 'ghost', title: 'Let this player claim extra pixels during cooldown', onclick: () => {
          const n = prompt(`Give ${u.username} how many bonus pixels? (negative removes)`, '5');
          if (n === null) return;
          act('/bonus', { user_id: u.id, amount: Number(n) }, `Bonus pixels updated for ${u.username}`);
        } }, '+Pixels'),
        el('button', { class: 'ghost', onclick: () => act('/cooldown', { user_id: u.id }, `Cooldown reset for ${u.username}`) }, 'Reset timer'),
        action))));
  }
  if (!rows.children.length) rows.append(el('tr', {}, el('td', { colspan: '4', class: 'muted' }, 'No players found.')));
}

async function act(path, body, okMsg) {
  try { await api(path, body); toast(okMsg, 'good'); await load(); } catch (e) { toast(e.message); }
}

$('#keyForm').onsubmit = async (e) => {
  e.preventDefault();
  KEY = $('#key').value.trim();
  $('#keyErr').textContent = '';
  try {
    await load();
    try { sessionStorage.setItem('adminKey', KEY); } catch { /* ignore */ }
    $('#key').value = '';
  } catch (err) {
    KEY = '';
    $('#keyErr').textContent = err.message;
  }
};
$('#q').oninput = render;
$('#sus').onchange = render;
$('#refresh').onclick = () => load().catch((e) => toast(e.message));
$('#lock').onclick = () => {
  KEY = '';
  try { sessionStorage.removeItem('adminKey'); } catch { /* ignore */ }
  $('#panel').hidden = true;
  $('#keyForm').hidden = false;
};
if (KEY) load().catch(() => { KEY = ''; });

/* ---------- Map tools ---------- */
function fillFactions() {
  const sel = $('#fSel');
  const cur = sel.value;
  sel.replaceChildren(...(FACTIONS.length ? FACTIONS : [{ id: '', name: '(no factions)', pixels: 0 }]).map((f) =>
    el('option', { value: String(f.id) }, f.id ? `${f.name} (${f.pixels}px)` : f.name)));
  if (cur) sel.value = cur;
}
const rect = () => ({ x1: $('#x1').value, y1: $('#y1').value, x2: $('#x2').value || $('#x1').value, y2: $('#y2').value || $('#y1').value });
$('#giveBtn').onclick = () => {
  if (!$('#fSel').value) return toast('Pick a faction');
  act('/pixels', { action: 'give', faction_id: Number($('#fSel').value), ...rect() }, 'Pixels given');
};
$('#clearBtn').onclick = () => {
  const r = rect();
  if (!confirm(`Make pixels (${r.x1},${r.y1}) to (${r.x2},${r.y2}) neutral?`)) return;
  act('/pixels', { action: 'clear', ...r }, 'Pixels cleared');
};
$('#delFBtn').onclick = () => {
  const f = FACTIONS.find((x) => String(x.id) === $('#fSel').value);
  if (!f) return toast('Pick a faction');
  if (!confirm(`Destroy faction "${f.name}"? Its land becomes neutral and members are removed from it.`)) return;
  act('/faction/delete', { faction_id: f.id }, `Destroyed ${f.name}`);
};
$('#resetBtn').onclick = () => {
  if (prompt('This wipes ALL land and ALL factions (accounts stay). Type RESET to confirm:') !== 'RESET') return;
  act('/reset', { confirm: 'RESET' }, 'Map reset');
};
$('#annSave').onclick = () => act('/announce', { text: $('#annText').value }, 'Announcement published');
$('#annClear').onclick = () => { $('#annText').value = ''; act('/announce', { text: '' }, 'Announcement removed'); };
