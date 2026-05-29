// ============================================================
// Actual Dashboard — Cloudflare Worker Proxy
// ============================================================
// Routes:
//   GET/POST  /meta/<path>           -> https://graph.facebook.com/v21.0/<path>
//   POST      /google-ads/<path>     -> https://googleads.googleapis.com/v16/<path>
//   POST      /anthropic             -> https://api.anthropic.com/v1/messages
//   GET       /health                -> { ok: true }
//
// Secrets required (set via Cloudflare > Workers > Settings > Variables):
//   META_TOKEN
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REFRESH_TOKEN
//   GOOGLE_DEVELOPER_TOKEN
//   ANTHROPIC_KEY
//   ALLOWED_ORIGIN   (e.g. "https://YOUR_USER.github.io")  -- can be "*" for testing
// ============================================================

// In-memory cache for Google OAuth access token (per Worker isolate, lives ~30s-15min)
let _googleTokenCache = { token: null, expiry: 0 };

export default {
  async fetch(request, env) {
    const corsHdrs = corsHeaders(env, request);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHdrs });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/health') {
        return json({ ok: true, ts: Date.now() }, 200, corsHdrs);
      }
      if (path.startsWith('/meta/')) {
        return await handleMeta(request, env, url, corsHdrs);
      }
      if (path.startsWith('/google-ads/')) {
        return await handleGoogleAds(request, env, url, corsHdrs);
      }
      if (path === '/anthropic' || path === '/anthropic/') {
        return await handleAnthropic(request, env, corsHdrs);
      }
      if (path === '/gmail/send' || path === '/gmail/send/') {
        return await handleGmailSend(request, env, corsHdrs);
      }
      if (path === '/gmail/oauth/start') {
        return await handleGmailOAuthStart(request, env, url);
      }
      if (path === '/gmail/oauth/callback') {
        return await handleGmailOAuthCallback(request, env, url);
      }
      if (path === '/gmail/oauth/poll') {
        return await handleGmailOAuthPoll(request, env, url, corsHdrs);
      }
      return json({ error: 'Unknown route', path }, 404, corsHdrs);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500, corsHdrs);
    }
  }
};

// ── CORS ───────────────────────────────────────────────────────
function corsHeaders(env, request) {
  const allowed = (env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim());
  const origin = request.headers.get('Origin') || '';
  let allowOrigin = '*';
  if (allowed.indexOf('*') === -1) {
    allowOrigin = allowed.indexOf(origin) !== -1 ? origin : allowed[0];
  }
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-login-customer-id, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
function json(obj, status, corsHdrs) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHdrs }
  });
}

// ── Meta Graph API ─────────────────────────────────────────────
async function handleMeta(request, env, url, corsHdrs) {
  if (!env.META_TOKEN) throw new Error('META_TOKEN secret not configured');

  const subPath = url.pathname.replace(/^\/meta\//, '');
  const upstream = new URL('https://graph.facebook.com/v21.0/' + subPath);
  // Copy query params, but ensure our access_token wins
  url.searchParams.forEach((v, k) => {
    if (k !== 'access_token') upstream.searchParams.set(k, v);
  });
  upstream.searchParams.set('access_token', env.META_TOKEN);

  const init = {
    method: request.method,
    headers: {},
  };
  const ctype = request.headers.get('Content-Type');
  if (ctype) init.headers['Content-Type'] = ctype;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.arrayBuffer();
  }

  const r = await fetch(upstream.toString(), init);
  const body = await r.arrayBuffer();
  return new Response(body, {
    status: r.status,
    headers: {
      'Content-Type': r.headers.get('Content-Type') || 'application/json',
      ...corsHdrs,
    }
  });
}

// ── Google Ads API ─────────────────────────────────────────────
async function getGoogleAccessToken(env) {
  if (_googleTokenCache.token && _googleTokenCache.expiry > Date.now()) {
    return _googleTokenCache.token;
  }
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    throw new Error('Google OAuth secrets not configured');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:
      'client_id=' + encodeURIComponent(env.GOOGLE_CLIENT_ID) +
      '&client_secret=' + encodeURIComponent(env.GOOGLE_CLIENT_SECRET) +
      '&refresh_token=' + encodeURIComponent(env.GOOGLE_REFRESH_TOKEN) +
      '&grant_type=refresh_token'
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Google OAuth error: ' + (data.error_description || data.error || 'unknown'));
  }
  _googleTokenCache.token = data.access_token;
  _googleTokenCache.expiry = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
  return _googleTokenCache.token;
}

async function handleGoogleAds(request, env, url, corsHdrs) {
  if (!env.GOOGLE_DEVELOPER_TOKEN) throw new Error('GOOGLE_DEVELOPER_TOKEN secret not configured');

  const subPath = url.pathname.replace(/^\/google-ads\//, '');
  const upstream = 'https://googleads.googleapis.com/v20/' + subPath;

  const loginCustId = request.headers.get('x-login-customer-id') || '';
  const token = await getGoogleAccessToken(env);

  const init = {
    method: request.method,
    headers: {
      'Authorization': 'Bearer ' + token,
      'developer-token': env.GOOGLE_DEVELOPER_TOKEN,
      'Content-Type': 'application/json',
    }
  };
  if (loginCustId) init.headers['login-customer-id'] = loginCustId;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.arrayBuffer();
  }

  const r = await fetch(upstream, init);
  const body = await r.arrayBuffer();
  return new Response(body, {
    status: r.status,
    headers: {
      'Content-Type': r.headers.get('Content-Type') || 'application/json',
      ...corsHdrs,
    }
  });
}

// ── Gmail Send (admin pre-configured) ──────────────────────────
// In-memory cache for Gmail access tokens per refresh_token
let _gmailTokenCache = {};
async function getGmailAccessToken(env, refreshToken, clientId, clientSecret) {
  const key = refreshToken;
  const cached = _gmailTokenCache[key];
  if (cached && cached.expiry > Date.now()) return cached.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:
      'client_id=' + encodeURIComponent(clientId) +
      '&client_secret=' + encodeURIComponent(clientSecret) +
      '&refresh_token=' + encodeURIComponent(refreshToken) +
      '&grant_type=refresh_token'
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Gmail OAuth refresh failed: ' + (data.error_description || data.error || 'unknown'));
  }
  _gmailTokenCache[key] = {
    token: data.access_token,
    expiry: Date.now() + ((data.expires_in || 3600) - 60) * 1000,
  };
  return data.access_token;
}

// Encode UTF-8 string to STANDARD base64 (con + / y padding)
function toBase64Std(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
// Encode UTF-8 string to base64url (per RFC 4648 §5) — para el campo "raw" de Gmail API
function toBase64Url(str) {
  return toBase64Std(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function handleGmailSend(request, env, corsHdrs) {
  if (request.method !== 'POST') {
    return json({ error: 'POST only' }, 405, corsHdrs);
  }

  let body;
  try { body = await request.json(); }
  catch(e) { return json({ error: 'Invalid JSON body' }, 400, corsHdrs); }

  const { to, subject, html, text, cc, bcc, fromName, mode } = body;
  if (!to || !subject || (!html && !text)) {
    return json({ error: 'Missing fields: to, subject, html|text' }, 400, corsHdrs);
  }

  // SOLO mode='user' está permitido. El path 'admin' (con GMAIL_REFRESH_TOKEN) se
  // deshabilitó por seguridad — cualquiera con la URL del Worker no debe poder
  // mandar mails desde el Gmail del dueño original al clonar la app.
  if (mode !== 'user') {
    return json({ error: 'Only mode="user" is supported. Connect your Gmail via OAuth first.' }, 400, corsHdrs);
  }
  if (!body.refresh_token) return json({ error: 'Missing refresh_token for user mode' }, 400, corsHdrs);
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET) {
    return json({ error: 'GMAIL_CLIENT_ID/SECRET not configured in Worker' }, 500, corsHdrs);
  }
  const clientId = env.GMAIL_CLIENT_ID;
  const clientSecret = env.GMAIL_CLIENT_SECRET;
  const refreshToken = body.refresh_token;
  const fromEmail = body.from_email || 'me';

  let accessToken;
  try { accessToken = await getGmailAccessToken(env, refreshToken, clientId, clientSecret); }
  catch(e) { return json({ error: e.message }, 502, corsHdrs); }

  // Build RFC 2822 MIME message (Gmail API espera base64url del RFC822 completo)
  const fromHeader = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  let raw = '';
  raw += `From: ${fromHeader}\r\n`;
  raw += `To: ${to}\r\n`;
  if (cc)  raw += `Cc: ${cc}\r\n`;
  if (bcc) raw += `Bcc: ${bcc}\r\n`;
  raw += `Subject: =?UTF-8?B?${toBase64Std(subject)}?=\r\n`;
  raw += `MIME-Version: 1.0\r\n`;
  if (html) {
    raw += `Content-Type: text/html; charset="UTF-8"\r\n\r\n`;
    raw += html;
  } else {
    raw += `Content-Type: text/plain; charset="UTF-8"\r\n\r\n`;
    raw += (text || '');
  }
  const encoded = toBase64Url(raw);

  // Call Gmail API
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: encoded }),
  });
  const respText = await r.text();
  if (!r.ok) {
    return json({ error: 'Gmail send failed', status: r.status, body: respText }, r.status, corsHdrs);
  }
  let respJson = {};
  try { respJson = JSON.parse(respText); } catch(e) {}
  return json({ ok: true, id: respJson.id, threadId: respJson.threadId }, 200, corsHdrs);
}

// ── Gmail OAuth flow (popup-based for in-app connection) ─────
// Helpers para guardar/leer el resultado OAuth server-side usando Cache API
// (no requiere setup de KV; cache es per-colo y el mismo usuario pega al mismo colo).
function _oauthCacheKey(session) {
  return new Request('https://oauth-store.internal/session/' + encodeURIComponent(session));
}
async function _oauthStore(session, data) {
  const cache = caches.default;
  await cache.put(_oauthCacheKey(session), new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=300' }
  }));
}
async function _oauthRetrieve(session) {
  const cache = caches.default;
  const hit = await cache.match(_oauthCacheKey(session));
  if (!hit) return null;
  const data = await hit.json();
  await cache.delete(_oauthCacheKey(session));
  return data;
}

async function handleGmailOAuthStart(request, env, url) {
  if (!env.GMAIL_CLIENT_ID) {
    return new Response('GMAIL_CLIENT_ID secret not configured', { status: 500 });
  }
  const session = url.searchParams.get('session') || '';
  const callbackUrl = `${url.origin}/gmail/oauth/callback`;
  const params = new URLSearchParams({
    client_id: env.GMAIL_CLIENT_ID,
    redirect_uri: callbackUrl,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: session  // thread session para recuperar el resultado por polling
  });
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
  return Response.redirect(authUrl, 302);
}

async function handleGmailOAuthPoll(request, env, url, corsHdrs) {
  const session = url.searchParams.get('session') || '';
  if (!session) return json({ error: 'Missing session' }, 400, corsHdrs);
  const data = await _oauthRetrieve(session);
  if (!data) return json({ pending: true }, 200, corsHdrs);
  return json({ pending: false, success: !!data.refresh_token, email: data.email || '', refresh_token: data.refresh_token || '', error: data.error || '' }, 200, corsHdrs);
}

async function handleGmailOAuthCallback(request, env, url) {
  const code  = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const session = url.searchParams.get('state') || '';  // = session que pasamos en /start

  // Bridge page — solo muestra "podés cerrar esta ventana". Los tokens NO van
  // en la URL: se guardan server-side y el dashboard los consulta por /poll.
  const BRIDGE_URL = 'https://matidesiderio.github.io/actual-dashboard/oauth-bridge.html';
  function redirectToBridge(statusFlag) {
    return Response.redirect(BRIDGE_URL + '#status=' + statusFlag, 302);
  }

  if (error) {
    await _oauthStore(session, { error: 'Google devolvió: ' + error });
    return redirectToBridge('error');
  }
  if (!code) {
    await _oauthStore(session, { error: 'Falta el código de autorización' });
    return redirectToBridge('error');
  }
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET) {
    await _oauthStore(session, { error: 'GMAIL_CLIENT_ID/SECRET no configurados en el Worker' });
    return redirectToBridge('error');
  }

  // Exchange authorization code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      code: code,
      redirect_uri: `${url.origin}/gmail/oauth/callback`,
      grant_type: 'authorization_code'
    }).toString()
  });
  const tokens = await tokenRes.json();
  if (!tokens.refresh_token) {
    await _oauthStore(session, { error: 'Google no devolvió refresh_token (revocá el acceso en https://myaccount.google.com/permissions y reintentá)' });
    return redirectToBridge('error');
  }

  // Get user's email via userinfo endpoint
  let userEmail = '';
  try {
    const uiRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: 'Bearer ' + tokens.access_token }
    });
    const ui = await uiRes.json();
    userEmail = ui.email || '';
  } catch(e) { /* ignore */ }

  // Guardar server-side para que el dashboard lo recupere por /poll
  await _oauthStore(session, { email: userEmail, refresh_token: tokens.refresh_token });
  return redirectToBridge('ok');
}

// ── Anthropic API ──────────────────────────────────────────────
async function handleAnthropic(request, env, corsHdrs) {
  if (!env.ANTHROPIC_KEY) throw new Error('ANTHROPIC_KEY secret not configured');

  const body = await request.arrayBuffer();
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body
  });
  const respBody = await r.arrayBuffer();
  return new Response(respBody, {
    status: r.status,
    headers: {
      'Content-Type': r.headers.get('Content-Type') || 'application/json',
      ...corsHdrs,
    }
  });
}
