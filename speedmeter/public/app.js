const $ = id => document.getElementById(id);
let user = null, running = true, ctrl = null;
let total = 0, lastBytes = 0, lastT = performance.now(), mbps = 0, lastSaved = 0;

// ---------- API helper ----------
async function api(url, method = 'GET', body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- speed test (real download measured against /api/download) ----------
async function stream(signal) {
  while (!signal.aborted) {
    const r = await fetch('/api/download?bytes=20000000&r=' + Math.random(), { signal, cache: 'no-store' });
    const reader = r.body.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.length; }
  }
}
function startTest() {
  ctrl = new AbortController();
  total = lastBytes = 0; lastT = performance.now(); mbps = 0;
  for (let i = 0; i < 4; i++) stream(ctrl.signal).catch(() => {});   // 4 parallel connections
}
function stopTest() { if (ctrl) ctrl.abort(); }
setInterval(() => {
  if (!running) return;
  const now = performance.now(), dt = (now - lastT) / 1000;
  const cur = (total - lastBytes) * 8 / dt / 1e6;
  lastBytes = total; lastT = now;
  mbps = mbps ? mbps * 0.6 + cur * 0.4 : cur;
  $('num').textContent = mbps.toFixed(1);
  if (user && mbps > 0 && Date.now() - lastSaved > 30000) saveResult();
}, 500);
$('pause').onclick = () => {
  running = !running;
  $('pause').textContent = running ? 'Pause' : 'Resume';
  if (running) startTest(); else { stopTest(); if (user && mbps > 0) saveResult(); }
};
async function saveResult() {
  lastSaved = Date.now();
  try { await api('/api/results', 'POST', { mbps }); loadHistory(); } catch {}
}
async function loadHistory() {
  if (!user) return;
  try {
    const { results } = await api('/api/results');
    $('history').innerHTML = results.length
      ? results.map(r => `<li>${esc(r.mbps)} Mbps · ${esc(r.ip || '')} · ${new Date(r.created_at).toLocaleString()}</li>`).join('')
      : '<li>No results yet</li>';
  } catch {}
}

// ---------- IP ----------
api('/api/ip').then(d => $('ip').textContent = d.ip || 'unknown').catch(() => $('ip').textContent = 'unavailable');

// ---------- UI: avatar + auth ----------
function paint() {
  const a = $('avatar');
  a.style.backgroundImage = user && user.photo ? `url(${user.photo})` : '';
  a.textContent = user && !user.photo ? user.name[0].toUpperCase() : (user ? '' : '?');
}
function modal(html, locked) { $('box').innerHTML = html; $('modal').classList.add('on'); $('modal').dataset.locked = locked ? '1' : ''; }
function closeModal() { $('modal').classList.remove('on'); }
$('modal').onclick = e => { if (e.target.id === 'modal' && !$('modal').dataset.locked) closeModal(); };

function shrink(file) {
  return new Promise(res => {
    const i = new Image();
    i.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = 96;
      const s = Math.min(i.width, i.height);
      c.getContext('2d').drawImage(i, (i.width - s) / 2, (i.height - s) / 2, s, s, 0, 0, 96, 96);
      res(c.toDataURL('image/jpeg', 0.8));
    };
    i.onerror = () => res(null); i.src = URL.createObjectURL(file);
  });
}
function signupForm() {
  modal(`<h2>Create your account</h2><small>Sign up to save your speed history.</small>
    <input id="s-name" placeholder="Full name" autocomplete="name">
    <input id="s-email" type="email" placeholder="Email" autocomplete="email">
    <input id="s-pass" type="password" placeholder="Password (min 8 characters)" autocomplete="new-password">
    <label><small>Profile photo (optional)</small><input id="s-photo" type="file" accept="image/*"></label>
    <button class="btn" id="s-go">Sign up</button><div class="err" id="s-err"></div>
    <small>Already registered? <a class="link" id="to-login">Log in</a></small>`, true);
  $('to-login').onclick = loginForm;
  $('s-go').onclick = async () => {
    try {
      const f = $('s-photo').files[0];
      const photo = f ? await shrink(f) : null;
      const d = await api('/api/signup', 'POST', { name: $('s-name').value, email: $('s-email').value, password: $('s-pass').value, photo });
      user = d.user; paint(); closeModal(); loadHistory();
    } catch (e) { $('s-err').textContent = e.message; }
  };
}
function loginForm() {
  modal(`<h2>Welcome back</h2>
    <input id="l-email" type="email" placeholder="Email" autocomplete="email">
    <input id="l-pass" type="password" placeholder="Password" autocomplete="current-password">
    <button class="btn" id="l-go">Log in</button><div class="err" id="l-err"></div>
    <small>New here? <a class="link" id="to-signup">Create an account</a></small>`, true);
  $('to-signup').onclick = signupForm;
  $('l-go').onclick = async () => {
    try {
      const d = await api('/api/login', 'POST', { email: $('l-email').value, password: $('l-pass').value });
      user = d.user; paint(); closeModal(); loadHistory();
    } catch (e) { $('l-err').textContent = e.message; }
  };
}
function profileMenu() {
  modal(`<h2>${esc(user.name)}</h2><small>${esc(user.email)}</small>
    <input id="p-name" value="${esc(user.name)}">
    <label><small>Change photo</small><input id="p-photo" type="file" accept="image/*"></label>
    <button class="btn" id="p-save">Save profile</button>
    <button class="btn alt" id="p-out">Log out</button><div class="err" id="p-err"></div>`);
  $('p-save').onclick = async () => {
    try {
      const f = $('p-photo').files[0];
      const d = await api('/api/me', 'PUT', { name: $('p-name').value, photo: f ? await shrink(f) : null });
      user = d.user; paint(); closeModal();
    } catch (e) { $('p-err').textContent = e.message; }
  };
  $('p-out').onclick = async () => { await api('/api/logout', 'POST'); user = null; paint(); $('history').innerHTML = '<li>Sign in to see history</li>'; signupForm(); };
}
$('avatar').onclick = () => user ? profileMenu() : signupForm();

// ---------- boot: first visit shows sign-up ----------
(async () => {
  startTest();
  try { user = (await api('/api/me')).user; paint(); loadHistory(); }
  catch { paint(); signupForm(); }
})();
