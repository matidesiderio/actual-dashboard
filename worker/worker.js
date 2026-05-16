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
