'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const { Server } = require('socket.io');
const { Rooms } = require('./game');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'yn-local-dev-secret';
const X_CLIENT_ID = process.env.X_CLIENT_ID || '';
const X_CLIENT_SECRET = process.env.X_CLIENT_SECRET || '';
const X_CALLBACK_URL = process.env.X_CALLBACK_URL || '';
const XAI_API_KEY = process.env.XAI_API_KEY || '';
const XAI_MODEL = process.env.XAI_MODEL || 'grok-3-mini';

const xEnabled = Boolean(X_CLIENT_ID && X_CALLBACK_URL);

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));

const sessionMiddleware = session({
  name: 'yn.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
});
app.use(sessionMiddleware);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// ---------- Public config / session ----------

app.get('/api/config', (_req, res) => {
  res.json({
    xEnabled,
    aiEnabled: Boolean(XAI_API_KEY),
    devLoginEnabled: !xEnabled || process.env.ALLOW_DEV_LOGIN === 'true',
  });
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not signed in' });
  res.json({ user: req.session.user });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('yn.sid');
    res.json({ ok: true });
  });
});

// ---------- X OAuth 2.0 (PKCE) ----------

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

app.get('/auth/x', (req, res) => {
  if (!xEnabled) return res.status(503).send('X login is not configured on this server.');
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));
  req.session.xOAuth = { verifier, state };
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: X_CLIENT_ID,
    redirect_uri: X_CALLBACK_URL,
    scope: 'tweet.read users.read offline.access',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  res.redirect('https://twitter.com/i/oauth2/authorize?' + params.toString());
});

app.get('/auth/x/callback', async (req, res) => {
  if (!xEnabled) return res.status(503).send('X login is not configured on this server.');
  const saved = req.session.xOAuth;
  delete req.session.xOAuth;
  const { code, state, error } = req.query;
  if (error) return res.redirect('/?error=' + encodeURIComponent('X login was cancelled.'));
  if (!code || !saved || state !== saved.state) {
    return res.status(400).send('Invalid login state. Go back and try again.');
  }
  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: X_CALLBACK_URL,
      code_verifier: saved.verifier,
    });
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (X_CLIENT_SECRET) {
      headers.Authorization =
        'Basic ' + Buffer.from(X_CLIENT_ID + ':' + X_CLIENT_SECRET).toString('base64');
    } else {
      body.set('client_id', X_CLIENT_ID);
    }

    const tokenRes = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers,
      body,
    });
    if (!tokenRes.ok) throw new Error('token exchange: HTTP ' + tokenRes.status);
    const token = await tokenRes.json();

    const meRes = await fetch('https://api.twitter.com/2/users/me?user.fields=profile_image_url', {
      headers: { Authorization: 'Bearer ' + token.access_token },
    });
    if (!meRes.ok) throw new Error('profile fetch: HTTP ' + meRes.status);
    const u = (await meRes.json()).data;

    req.session.user = {
      id: 'x-' + u.id,
      name: String(u.name || '@' + u.username).slice(0, 24),
      handle: u.username,
      avatar: u.profile_image_url || null,
      dev: false,
    };
    res.redirect('/');
  } catch (err) {
    console.error('X callback error:', err.message);
    res.redirect('/?error=' + encodeURIComponent('X login failed. Please try again.'));
  }
});

// ---------- Dev login (only when X is not configured) ----------

const NAME_RE = /^[A-Za-z0-9 _-]{2,20}$/;

app.post('/auth/dev', (req, res) => {
  if (xEnabled && process.env.ALLOW_DEV_LOGIN !== 'true') {
    return res.status(403).json({ error: 'Dev login is disabled while X login is active.' });
  }
  const name = String((req.body && req.body.name) || '').trim();
  if (!NAME_RE.test(name)) {
    return res.status(400).json({ error: 'Name must be 2-20 chars: letters, numbers, spaces, - or _' });
  }
  req.session.user = {
    id: 'dev-' + name.toLowerCase(),
    name,
    handle: name,
    avatar: null,
    dev: true,
  };
  res.json({ ok: true, user: req.session.user });
});

// ---------- Optional xAI "Inspire me" ----------

app.post('/api/inspire', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Sign in first.' });
  if (!XAI_API_KEY) {
    return res.status(503).json({ error: 'AI is not configured on this server. The game works fine without it!' });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const r = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + XAI_API_KEY,
      },
      body: JSON.stringify({
        model: XAI_MODEL,
        temperature: 1,
        max_tokens: 60,
        messages: [
          {
            role: 'system',
            content:
              'You write one short, absurd, family-friendly "Why" question for a comedy party game. Reply with ONLY the question. No quotes, no preamble, max 15 words.',
          },
          { role: 'user', content: 'Give me one funny Why question.' },
        ],
      }),
    });
    if (!r.ok) throw new Error('xAI HTTP ' + r.status);
    const data = await r.json();
    const idea = String(
      data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : ''
    )
      .trim()
      .replace(/^["']|["']$/g, '')
      .slice(0, 140);
    if (!idea) throw new Error('empty idea');
    res.json({ idea });
  } catch (err) {
    console.error('Inspire error:', err.message);
    res.status(502).json({ error: 'No idea right now — your own brain works great too!' });
  } finally {
    clearTimeout(timeout);
  }
});

// ---------- Real-time server ----------

const server = http.createServer(app);
const io = new Server(server);

const fakeRes = {
  getHeader: () => undefined,
  setHeader: () => {},
  writeHead: () => {},
  end: () => {},
  on: () => {},
  get headersSent() { return true; },
};

io.use((socket, next) => sessionMiddleware(socket.request, fakeRes, next));
io.use((socket, next) => {
  const user = socket.request.session && socket.request.session.user;
  if (!user) return next(new Error('unauthorized'));
  socket.data.user = user;
  next();
});

const rooms = new Rooms(io);

io.on('connection', (socket) => rooms.attach(socket));

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `YN listening on http://0.0.0.0:${PORT}` +
      ` (xLogin=${xEnabled ? 'on' : 'off'}, xAI=${XAI_API_KEY ? 'on' : 'off'})`
  );
});