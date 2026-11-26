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
}

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
