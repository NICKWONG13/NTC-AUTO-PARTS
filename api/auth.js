const express = require('express');
const crypto = require('crypto');

const router = express.Router();

const SESSION_DAYS = 7;
const SECRET = () => process.env.SESSION_SECRET || process.env.SUPABASE_KEY || 'dev-secret-change-me';

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = crypto.createHmac('sha256', SECRET()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verify(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET()).update(body).digest('base64url');
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function getSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verify(cookies.ntc_session);
}

// Middleware: require login for protected routes
function requireAuth(req, res, next) {
  // Whitelist: auth endpoints, webhook, login page, static assets needed by login page
  const p = req.path;
  const isPublic =
    p === '/login' ||
    p === '/login.html' ||
    p === '/style.css' ||
    p === '/favicon.ico' ||
    p.startsWith('/api/auth/') ||
    p.startsWith('/tg/webhook');

  if (isPublic) return next();

  const session = getSession(req);
  if (!session) {
    if (p.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    return res.redirect('/login');
  }
  req.user = session.user;
  next();
}

// ─── Routes ────────────────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const validUser = process.env.DASHBOARD_USER || 'admin';
  const validPass = process.env.DASHBOARD_PASS || 'admin';

  if (username !== validUser || password !== validPass) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = sign({
    user: username,
    exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000
  });

  res.setHeader('Set-Cookie',
    `ntc_session=${token}; HttpOnly; Path=/; Max-Age=${SESSION_DAYS * 86400}; SameSite=Lax; Secure`);
  res.json({ ok: true, user: username });
});

router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'ntc_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure');
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user: session.user });
});

module.exports = { router, requireAuth };
