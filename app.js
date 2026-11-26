/* Grok Bot Desk PWA. Everything is decrypted on this phone with WebCrypto (AES-256-GCM).
   File format: 12-byte IV || ciphertext+tag. The key arrives once in the URL fragment
   (#k=<base64url key>&p=<path>), which browsers never send to a server. */
'use strict';
const POLL_MS = 15000;
const LS = { k: 'desk.k', p: 'desk.p' };
let cryptoKey = null;
let dataPath = null;
let lastFrameStamp = null;

const $ = (id) => document.getElementById(id);

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pairFromFragment() {
  const h = location.hash.replace(/^#/, '');
  if (!h) return;
  const params = new URLSearchParams(h);
  const k = params.get('k');
  const p = params.get('p');
  if (k && p) {
    try { localStorage.setItem(LS.k, k); localStorage.setItem(LS.p, p); } catch (e) { /* ignore */ }
  }
  // Always drop the fragment from the address bar and history entry.
  history.replaceState(null, '', location.pathname + location.search);
}

async function loadKey() {
  const k = localStorage.getItem(LS.k);
  const p = localStorage.getItem(LS.p);
  if (!k || !p) return false;
  try {
    cryptoKey = await crypto.subtle.importKey('raw', b64urlToBytes(k), 'AES-GCM', false, ['decrypt']);
  } catch (e) { return false; }
  dataPath = p;
  return true;
}

async function fetchDecrypted(name) {
  const url = `d/${encodeURIComponent(dataPath)}/${name}.enc?t=${Date.now()}`;
  const res = await fetch(url, { cache: 'no-store', referrerPolicy: 'no-referrer' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length < 28) throw new Error('bad file');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: buf.slice(0, 12) }, cryptoKey, buf.slice(12));
  return new Uint8Array(plain);
}

function fmtMoney(v) {
  return '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

let updatedAt = null;
function tickAge() {
  $('age').textContent = updatedAt ? `(${fmtAge(Date.now() - updatedAt.getTime())})` : '';
}

function render(state) {
  const mode = String(state.mode || '—').toUpperCase();
  const badge = $('mode-badge');
  badge.textContent = mode;
  badge.classList.toggle('live', mode === 'LIVE');
  const bal = state.balance_usd !== undefined ? state.balance_usd : state.balance;
  $('balance').textContent = (bal === null || bal === undefined) ? '—' : fmtMoney(bal);
  $('note').textContent = state.note || (bal == null ? 'No balance yet' : '');
  const ts = state.updated_at || state.ts;
  updatedAt = ts ? new Date(ts) : null;
  $('updated').textContent = updatedAt && !isNaN(updatedAt)
    ? updatedAt.toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' }) : '—';
  tickAge();
  renderCounts(state);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderCounts(state) {
  const c = state.counts;
  if (!c) return;
  $('counts-card').hidden = false;
  const w = c.fomo_warning_predicted || {};
  const cells = [
    ['New tokens', c.seen && c.seen.new_tokens], ['Migrations', c.seen && c.seen.migrations],
    ['Dex fresh', c.seen && c.seen.dex_discovered], ['Scanned', c.scanned], ['Analyzed', c.analyzed],
    ['PAPER trades', c.trade], ['Skips', c.skip], ['Warn (pred.)', `${w.flagged ?? 0}/${w.checked ?? 0}`],
    ['Open', state.paper ? state.paper.open : '—'],
  ];
  $('counts').innerHTML = cells.map(([k, v]) => `<div><b>${esc(v ?? '—')}</b><span>${esc(k)}</span></div>`).join('');
  const top = (c.top_skip_reasons || []).slice(0, 5).map(([r, n]) => `${r} ×${n}`).join(' · ');
  $('skip-reasons').textContent = top ? `Top skip reasons: ${top}` : '';
  const by = Object.entries(w.by_reason || {}).map(([k, v]) => `${k} ${v}`).join(', ');
  $('warn-line').textContent = `FOMO warning box: ${w.flagged ?? 0} of ${w.checked ?? 0} coins PREDICTED (not observed)${by ? ' — ' + by : ''}`;
  const b = state.paper;
  $('book-line').textContent = b ? `PAPER book: cash $${b.cash.toFixed(2)} · equity $${b.equity.toFixed(2)} (${b.pnl >= 0 ? '+' : ''}${b.pnl.toFixed(2)}) · fees $${b.fees.toFixed(2)}` : '';
  if (state.paused) $('note').textContent = 'PAUSED · ' + (state.note || '');
}

let logFilter = 'all';
let lastActivity = null;
function renderLog(act) {
  if (act) lastActivity = act;
  if (!lastActivity) return;
  $('log-card').hidden = false;
  const rows = (lastActivity.decisions || []).filter((d) => logFilter === 'all' || d.decision === logFilter);
  $('log').innerHTML = rows.slice(0, 100).map((d) => {
    const t = new Date(d.ts);
    const when = isNaN(t) ? '' : t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const head = d.decision === 'trade'
      ? `<span class="trade">PAPER BUY $${Number(d.size_usd).toFixed(2)}</span>` : `<span class="skip">skip · ${esc(d.stage)}</span>`;
    const warn = d.fomo_warning_predicted ? `<span class="pill" title="${esc((d.fomo_warning_reasons || []).join('; '))}">warn (pred.)</span>` : '';
    const name = d.coin_url ? `<a href="${esc(d.coin_url)}" target="_blank" rel="noopener noreferrer">${esc(d.symbol || d.mint.slice(0, 6))}</a>` : esc(d.symbol || d.mint.slice(0, 6));
    return `<li><div class="top"><span>${name}${warn}</span><span>${head} <span class="skip">${when}</span></span></div>`
      + `<div class="why">${esc((d.reasons || []).join(' · '))}</div></li>`;
  }).join('') || '<li class="skip">No decisions yet</li>';
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('.filters button');
  if (!b) return;
  logFilter = b.dataset.f;
  document.querySelectorAll('.filters button').forEach((x) => x.classList.toggle('on', x === b));
  renderLog();
});

async function refreshFrame() {
  try {
    const jpg = await fetchDecrypted('screen.jpg');
    if (!jpg) return;
    const img = $('screen');
    const old = img.src;
    img.src = URL.createObjectURL(new Blob([jpg], { type: 'image/jpeg' }));
    img.hidden = false;
    $('no-frame').hidden = true;
    if (old && old.startsWith('blob:')) URL.revokeObjectURL(old);
  } catch (e) { /* frame is optional */ }
}

async function poll() {
  try {
    const raw = await fetchDecrypted('state.json');
    if (raw === null) {
      $('error').hidden = false;
      $('error').textContent = 'No data published yet';
    } else {
      render(JSON.parse(new TextDecoder().decode(raw)));
      $('error').hidden = true;
    }
    try {
      const a = await fetchDecrypted('activity.json');
      if (a) renderLog(JSON.parse(new TextDecoder().decode(a)));
    } catch (e) { /* log is optional */ }
    await refreshFrame();
  } catch (e) {
    $('error').hidden = false;
    $('error').textContent = (e && e.name === 'OperationError')
      ? 'Cannot decrypt: wrong key. Re-pair this phone.' : `Offline or error: ${e.message || e}`;
  }
}

async function main() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('sw', e));
  }
  pairFromFragment();
  const ok = await loadKey();
  $('unpaired').hidden = ok;
  $('paired').hidden = !ok;
  if (!ok) return;
  poll();
  setInterval(poll, POLL_MS);
  setInterval(tickAge, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
}
main();
