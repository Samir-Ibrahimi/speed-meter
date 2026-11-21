const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROD = process.env.NODE_ENV === 'production';
const SECRET = process.env.JWT_SECRET || (PROD ? null : 'dev-secret-change-me');
if (!SECRET) { console.error('JWT_SECRET is required in production'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : (PROD ? { rejectUnauthorized: false } : false),
});

const app = express();
app.set('trust proxy', true);              // so req.ip is the real client IP behind a proxy
app.use(express.json({ limit: '400kb' }));
app.use(cookieParser());

const clientIp = req => (req.ip || '').replace(/^::ffff:/, '');
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

function setSession(res, user) {
  const token = jwt.sign({ uid: user.id }, SECRET, { expiresIn: '7d' });
  res.cookie('sm_token', token, { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 7 * 864e5 });
}
function auth(req, res, next) {
  try { req.uid = jwt.verify(req.cookies.sm_token, SECRET).uid; next(); }
  catch { res.status(401).json({ error: 'Not signed in' }); }
}
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, photo: u.photo, createdAt: u.created_at });
const validPhoto = p => p == null || p === '' || (typeof p === 'string' && p.startsWith('data:image/') && p.length < 300000);

// ---------- auth ----------
app.post('/api/signup', authLimiter, async (req, res) => {
  const { name, email, password, photo } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
  if (!/^\S+@\S+\.\S+$/.test(email || '')) return res.status(400).json({ error: 'Valid email is required' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!validPhoto(photo)) return res.status(400).json({ error: 'Invalid or too large photo' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      'INSERT INTO users (name,email,password_hash,photo) VALUES ($1,$2,$3,$4) RETURNING *',
      [String(name).trim(), email.toLowerCase().trim(), hash, photo || null]);
    setSession(res, rows[0]);
    res.status(201).json({ user: publicUser(rows[0]) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    console.error(e); res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [(email || '').toLowerCase().trim()]);
    if (!rows[0] || !(await bcrypt.compare(password || '', rows[0].password_hash)))
      return res.status(401).json({ error: 'Wrong email or password' });
    setSession(res, rows[0]);
    res.json({ user: publicUser(rows[0]) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/logout', (req, res) => { res.clearCookie('sm_token'); res.json({ ok: true }); });

app.get('/api/me', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.uid]);
  if (!rows[0]) return res.status(401).json({ error: 'Not signed in' });
  res.json({ user: publicUser(rows[0]) });
});

app.put('/api/me', auth, async (req, res) => {
  const { name, photo } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
  if (!validPhoto(photo)) return res.status(400).json({ error: 'Invalid or too large photo' });
  const { rows } = await pool.query(
    'UPDATE users SET name=$1, photo=COALESCE($2, photo) WHERE id=$3 RETURNING *',
    [String(name).trim(), photo || null, req.uid]);
  res.json({ user: publicUser(rows[0]) });
});

// ---------- speed test API ----------
app.get('/api/ip', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ ip: clientIp(req) }); });

// Streams incompressible random bytes so the client can measure download speed.
const CHUNK = crypto.randomBytes(64 * 1024);
app.get('/api/download', (req, res) => {
  let remaining = Math.min(parseInt(req.query.bytes, 10) || 10e6, 50e6);
  res.set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Encoding': 'identity', 'Content-Length': remaining });
  let closed = false; req.on('close', () => { closed = true; });
  (function write() {
    while (remaining > 0 && !closed) {
      const part = remaining >= CHUNK.length ? CHUNK : CHUNK.subarray(0, remaining);
      remaining -= part.length;
      if (!res.write(part)) return res.once('drain', write);
    }
    res.end();
  })();
});

app.post('/api/results', auth, async (req, res) => {
  const mbps = Number(req.body && req.body.mbps);
  if (!isFinite(mbps) || mbps < 0 || mbps > 100000) return res.status(400).json({ error: 'Invalid speed' });
  await pool.query('INSERT INTO speed_results (user_id,mbps,ip) VALUES ($1,$2,$3)', [req.uid, mbps.toFixed(2), clientIp(req)]);
  res.status(201).json({ ok: true });
});

app.get('/api/results', auth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT mbps, ip, created_at FROM speed_results WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20', [req.uid]);
  res.json({ results: rows });
});

app.get('/health', (req, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, 'public')));

(async () => {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));   // auto-create tables
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('SpeedMeter on port ' + port));
})().catch(e => { console.error('Startup failed:', e); process.exit(1); });
