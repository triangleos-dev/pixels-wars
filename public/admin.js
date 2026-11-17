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
  for (const u of USERS) {
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
      el('td', {}, el('b', {}, u.username)),
      el('td', {}, u.faction
        ? el('span', {}, el('span', { class: 'dot', style: `background:${u.color}` }), u.faction)
        : el('span', { class: 'muted' }, '—')),
      el('td', {}, status),
      el('td', { style: 'text-align:right' }, action)));
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
$('#refresh').onclick = () => load().catch((e) => toast(e.message));
$('#lock').onclick = () => {
  KEY = '';
  try { sessionStorage.removeItem('adminKey'); } catch { /* ignore */ }
  $('#panel').hidden = true;
  $('#keyForm').hidden = false;
};
if (KEY) load().catch(() => { KEY = ''; });
