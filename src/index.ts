/**
 * GAS Masking Proxy - Main Entry Point
 * Cloudflare Workers + Hono Framework
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { basicAuth } from 'hono/basic-auth';
import type { Env, ApiResponse, App, AppWithRules, MaskingRule } from './types';
import {
  getAllApps,
  getApp,
  getAppWithRules,
  createApp,
  updateApp,
  deleteApp,
  getRules,
  addRule,
  updateRule,
  deleteRule,
  getUseDefaultRules,
  setUseDefaultRules,
} from './storage';
import { processGasApp, proxyResource, forwardPost, fetchGasContent, fetchGasContentWithAuth } from './proxy';
import {
  getAuthUrl,
  getRedirectUri,
  exchangeCodeForTokens,
  getUserInfo,
  createSession,
  getSession,
  deleteSession,
  getSessionIdFromCookie,
  createSessionCookie,
  createLogoutCookie,
  refreshAccessToken,
} from './auth';

// Create Hono app with environment bindings
const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', cors());
app.use('*', logger());

/**
 * Debug endpoint to see raw GAS HTML
 */
app.get('/debug/:appId', async (c) => {
  const { appId } = c.req.param();
  const appData = await getAppWithRules(c.env, appId);
  if (!appData) {
    return c.text('App not found', 404);
  }

  try {
    const { html, finalUrl } = await fetchGasContent(appData.url);
    return c.html(`
      <h1>Debug: ${appData.name}</h1>
      <p><strong>Original URL:</strong> ${appData.url}</p>
      <p><strong>Final URL:</strong> ${finalUrl}</p>
      <p><strong>HTML Length:</strong> ${html.length}</p>
      <h2>Raw HTML:</h2>
      <pre style="background:#f0f0f0;padding:10px;overflow:auto;max-height:500px;">${html.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
    `);
  } catch (error) {
    return c.text(`Error: ${error instanceof Error ? error.message : 'Unknown'}`, 500);
  }
});

// Helper to get proxy base URL
function getProxyBase(c: { req: { url: string } }): string {
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}`;
}

// ============================================
// Proxy Endpoints
// ============================================

/**
 * GET /view/:appId - Display masked GAS app
 */
app.get('/view/:appId', async (c) => {
  const { appId } = c.req.param();

  try {
    const appData = await getAppWithRules(c.env, appId);
    if (!appData) {
      return c.html(
        `<!DOCTYPE html>
<html>
<head><title>Error - GAS Masking Proxy</title></head>
<body>
  <h1>App Not Found</h1>
  <p>The requested app (ID: ${appId}) was not found.</p>
  <p><a href="/">Back to Dashboard</a></p>
</body>
</html>`,
        404
      );
    }

    // Check if user is authenticated (for org-restricted GAS apps)
    let accessToken: string | undefined;
    const sessionId = getSessionIdFromCookie(c.req.header('cookie'));
    if (sessionId) {
      const session = await getSession(c.env, sessionId);
      if (session) {
        const refreshedSession = await refreshAccessToken(c.env, session);
        if (refreshedSession) {
          accessToken = refreshedSession.accessToken;
        }
      }
    }

    const proxyBase = getProxyBase(c);
    const maskedHtml = await processGasApp(
      appData.url,
      appData.rules,
      appData.useDefaultRules,
      proxyBase,
      accessToken
    );

    console.log(`[PROXY] GET /view/${appId} - ${appData.name}${accessToken ? ' (authenticated)' : ''}`);
    return c.html(maskedHtml);
  } catch (error) {
    console.error(`[ERROR] Failed to proxy app ${appId}:`, error);

    // Check if it's an authentication error
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const isAuthError = errorMessage.includes('401') || errorMessage.includes('403');

    if (isAuthError) {
      return c.html(
        `<!DOCTYPE html>
<html>
<head><title>認証が必要 - GAS Masking Proxy</title></head>
<body>
  <h1>認証が必要です</h1>
  <p>このGASアプリにアクセスするにはGoogleログインが必要です。</p>
  <p><a href="/auth/login">Googleでログイン</a></p>
  <p><a href="/">Back to Dashboard</a></p>
</body>
</html>`,
        401
      );
    }

    return c.html(
      `<!DOCTYPE html>
<html>
<head><title>Error - GAS Masking Proxy</title></head>
<body>
  <h1>Proxy Error</h1>
  <p>Failed to load the GAS application.</p>
  <p>Error: ${errorMessage}</p>
  <p><a href="/">Back to Dashboard</a></p>
</body>
</html>`,
      500
    );
  }
});

/**
 * POST /view/:appId - Forward form submission to GAS
 */
app.post('/view/:appId', async (c) => {
  const { appId } = c.req.param();

  try {
    const appData = await getAppWithRules(c.env, appId);
    if (!appData) {
      return c.json({ error: 'App not found' }, 404);
    }

    const contentType = c.req.header('content-type') || 'application/x-www-form-urlencoded';
    const body = await c.req.text();

    const proxyBase = getProxyBase(c);
    const response = await forwardPost(
      appData.url,
      body,
      contentType,
      appData.rules,
      appData.useDefaultRules,
      proxyBase
    );

    console.log(`[PROXY] POST /view/${appId} - ${appData.name}`);
    return c.html(response);
  } catch (error) {
    console.error(`[ERROR] Failed to forward POST to app ${appId}:`, error);
    return c.html(
      `<!DOCTYPE html>
<html>
<head><title>Error - GAS Masking Proxy</title></head>
<body>
  <h1>Proxy Error</h1>
  <p>Failed to submit form to the GAS application.</p>
  <p>Error: ${error instanceof Error ? error.message : 'Unknown error'}</p>
</body>
</html>`,
      500
    );
  }
});

/**
 * GET /proxy-resource - Proxy static resources (CSS, JS, images)
 */
app.get('/proxy-resource', async (c) => {
  const resourceUrl = c.req.query('url');

  if (!resourceUrl) {
    return c.text('Missing url parameter', 400);
  }

  try {
    const { content, contentType } = await proxyResource(resourceUrl);
    console.log(`[PROXY] Resource: ${resourceUrl.substring(0, 100)}...`);

    return new Response(content, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (error) {
    console.error(`[ERROR] Failed to proxy resource:`, error);
    return c.text('Failed to fetch resource', 500);
  }
});

// ============================================
// OAuth Authentication Endpoints
// ============================================

/**
 * GET /auth/login - Redirect to Google OAuth
 */
app.get('/auth/login', async (c) => {
  const redirectUri = getRedirectUri(c.req.url);
  const state = Math.random().toString(36).substring(2, 15);

  // Store state in cookie for CSRF protection
  const authUrl = getAuthUrl(c.env, redirectUri, state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl,
      'Set-Cookie': `oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
    },
  });
});

/**
 * GET /auth/callback - OAuth callback handler
 */
app.get('/auth/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');

  if (error) {
    return c.html(`
      <!DOCTYPE html>
      <html>
      <head><title>Login Failed</title></head>
      <body>
        <h1>Login Failed</h1>
        <p>Error: ${error}</p>
        <p><a href="/">Back to Home</a></p>
      </body>
      </html>
    `, 400);
  }

  if (!code) {
    return c.html(`
      <!DOCTYPE html>
      <html>
      <head><title>Login Failed</title></head>
      <body>
        <h1>Login Failed</h1>
        <p>No authorization code received.</p>
        <p><a href="/">Back to Home</a></p>
      </body>
      </html>
    `, 400);
  }

  try {
    const redirectUri = getRedirectUri(c.req.url);
    const tokens = await exchangeCodeForTokens(c.env, code, redirectUri);
    const userInfo = await getUserInfo(tokens.accessToken);

    const session = await createSession(
      c.env,
      tokens.accessToken,
      tokens.refreshToken,
      tokens.expiresIn,
      userInfo.email
    );

    console.log(`[AUTH] User logged in: ${userInfo.email}`);

    return new Response(null, {
      status: 302,
      headers: {
        Location: '/',
        'Set-Cookie': createSessionCookie(session.id),
      },
    });
  } catch (err) {
    console.error('[AUTH] OAuth callback error:', err);
    return c.html(`
      <!DOCTYPE html>
      <html>
      <head><title>Login Failed</title></head>
      <body>
        <h1>Login Failed</h1>
        <p>Authentication failed. Please try again.</p>
        <p><a href="/auth/login">Try Again</a></p>
      </body>
      </html>
    `, 500);
  }
});

/**
 * GET /auth/logout - Logout and clear session
 */
app.get('/auth/logout', async (c) => {
  const sessionId = getSessionIdFromCookie(c.req.header('cookie'));

  if (sessionId) {
    await deleteSession(c.env, sessionId);
    console.log(`[AUTH] Session deleted: ${sessionId}`);
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: '/',
      'Set-Cookie': createLogoutCookie(),
    },
  });
});

/**
 * GET /auth/status - Check authentication status
 */
app.get('/auth/status', async (c) => {
  const sessionId = getSessionIdFromCookie(c.req.header('cookie'));

  if (!sessionId) {
    return c.json({ authenticated: false });
  }

  const session = await getSession(c.env, sessionId);
  if (!session) {
    return c.json({ authenticated: false });
  }

  // Try to refresh token if expired
  const refreshedSession = await refreshAccessToken(c.env, session);
  if (!refreshedSession) {
    return c.json({ authenticated: false });
  }

  return c.json({
    authenticated: true,
    email: refreshedSession.email,
  });
});

// ============================================
// Management API Endpoints
// ============================================

// Basic auth middleware for API routes
const authMiddleware = basicAuth({
  verifyUser: (username, password, c) => {
    return username === 'admin' && password === c.env.ADMIN_PASSWORD;
  },
});

/**
 * GET /api/apps - List all registered apps
 */
app.get('/api/apps', authMiddleware, async (c) => {
  try {
    const apps = await getAllApps(c.env);
    const response: ApiResponse<App[]> = { success: true, data: apps };
    return c.json(response);
  } catch (error) {
    console.error('[ERROR] Failed to list apps:', error);
    return c.json({ success: false, error: 'Failed to list apps' }, 500);
  }
});

/**
 * POST /api/apps - Register a new app
 */
app.post('/api/apps', authMiddleware, async (c) => {
  try {
    const { name, url } = await c.req.json<{ name: string; url: string }>();

    if (!name || !url) {
      return c.json({ success: false, error: 'name and url are required' }, 400);
    }

    // Validate URL format
    if (!url.includes('script.google.com')) {
      return c.json({ success: false, error: 'URL must be a Google Apps Script URL' }, 400);
    }

    const app = await createApp(c.env, name, url);
    const proxyBase = getProxyBase(c);

    console.log(`[API] Created app: ${app.id} - ${name}`);

    return c.json({
      success: true,
      data: {
        ...app,
        proxyUrl: `${proxyBase}/view/${app.id}`,
      },
    });
  } catch (error) {
    console.error('[ERROR] Failed to create app:', error);
    return c.json({ success: false, error: 'Failed to create app' }, 500);
  }
});

/**
 * GET /api/apps/:appId - Get app details
 */
app.get('/api/apps/:appId', authMiddleware, async (c) => {
  const { appId } = c.req.param();

  try {
    const appData = await getAppWithRules(c.env, appId);
    if (!appData) {
      return c.json({ success: false, error: 'App not found' }, 404);
    }

    const proxyBase = getProxyBase(c);
    const response: ApiResponse<AppWithRules & { proxyUrl: string }> = {
      success: true,
      data: {
        ...appData,
        proxyUrl: `${proxyBase}/view/${appId}`,
      },
    };
    return c.json(response);
  } catch (error) {
    console.error('[ERROR] Failed to get app:', error);
    return c.json({ success: false, error: 'Failed to get app' }, 500);
  }
});

/**
 * PUT /api/apps/:appId - Update app
 */
app.put('/api/apps/:appId', authMiddleware, async (c) => {
  const { appId } = c.req.param();

  try {
    const updates = await c.req.json<{ name?: string; url?: string; useDefaultRules?: boolean }>();

    // Handle useDefaultRules separately
    if (updates.useDefaultRules !== undefined) {
      await setUseDefaultRules(c.env, appId, updates.useDefaultRules);
    }

    const appUpdates: { name?: string; url?: string } = {};
    if (updates.name) appUpdates.name = updates.name;
    if (updates.url) appUpdates.url = updates.url;

    let app;
    if (Object.keys(appUpdates).length > 0) {
      app = await updateApp(c.env, appId, appUpdates);
      if (!app) {
        return c.json({ success: false, error: 'App not found' }, 404);
      }
    } else {
      app = await getApp(c.env, appId);
    }

    console.log(`[API] Updated app: ${appId}`);
    return c.json({ success: true, data: app });
  } catch (error) {
    console.error('[ERROR] Failed to update app:', error);
    return c.json({ success: false, error: 'Failed to update app' }, 500);
  }
});

/**
 * DELETE /api/apps/:appId - Delete app
 */
app.delete('/api/apps/:appId', authMiddleware, async (c) => {
  const { appId } = c.req.param();

  try {
    const deleted = await deleteApp(c.env, appId);
    if (!deleted) {
      return c.json({ success: false, error: 'App not found' }, 404);
    }

    console.log(`[API] Deleted app: ${appId}`);
    return c.json({ success: true });
  } catch (error) {
    console.error('[ERROR] Failed to delete app:', error);
    return c.json({ success: false, error: 'Failed to delete app' }, 500);
  }
});

/**
 * GET /api/apps/:appId/rules - Get rules for an app
 */
app.get('/api/apps/:appId/rules', authMiddleware, async (c) => {
  const { appId } = c.req.param();

  try {
    const app = await getApp(c.env, appId);
    if (!app) {
      return c.json({ success: false, error: 'App not found' }, 404);
    }

    const rules = await getRules(c.env, appId);
    return c.json({ success: true, data: rules });
  } catch (error) {
    console.error('[ERROR] Failed to get rules:', error);
    return c.json({ success: false, error: 'Failed to get rules' }, 500);
  }
});

/**
 * POST /api/apps/:appId/rules - Add a rule
 */
app.post('/api/apps/:appId/rules', authMiddleware, async (c) => {
  const { appId } = c.req.param();

  try {
    const app = await getApp(c.env, appId);
    if (!app) {
      return c.json({ success: false, error: 'App not found' }, 404);
    }

    const ruleData = await c.req.json<Omit<MaskingRule, 'id'>>();

    if (!ruleData.type) {
      return c.json({ success: false, error: 'type is required' }, 400);
    }

    if (!ruleData.selector && !ruleData.pattern) {
      return c.json({ success: false, error: 'Either selector or pattern is required' }, 400);
    }

    const rule = await addRule(c.env, appId, {
      ...ruleData,
      enabled: ruleData.enabled ?? true,
    });

    console.log(`[API] Added rule to app ${appId}: ${rule.id}`);
    return c.json({ success: true, data: rule });
  } catch (error) {
    console.error('[ERROR] Failed to add rule:', error);
    return c.json({ success: false, error: 'Failed to add rule' }, 500);
  }
});

/**
 * PUT /api/apps/:appId/rules/:ruleId - Update a rule
 */
app.put('/api/apps/:appId/rules/:ruleId', authMiddleware, async (c) => {
  const { appId, ruleId } = c.req.param();

  try {
    const updates = await c.req.json<Partial<Omit<MaskingRule, 'id'>>>();
    const rule = await updateRule(c.env, appId, ruleId, updates);

    if (!rule) {
      return c.json({ success: false, error: 'Rule not found' }, 404);
    }

    console.log(`[API] Updated rule ${ruleId} in app ${appId}`);
    return c.json({ success: true, data: rule });
  } catch (error) {
    console.error('[ERROR] Failed to update rule:', error);
    return c.json({ success: false, error: 'Failed to update rule' }, 500);
  }
});

/**
 * DELETE /api/apps/:appId/rules/:ruleId - Delete a rule
 */
app.delete('/api/apps/:appId/rules/:ruleId', authMiddleware, async (c) => {
  const { appId, ruleId } = c.req.param();

  try {
    const deleted = await deleteRule(c.env, appId, ruleId);
    if (!deleted) {
      return c.json({ success: false, error: 'Rule not found' }, 404);
    }

    console.log(`[API] Deleted rule ${ruleId} from app ${appId}`);
    return c.json({ success: true });
  } catch (error) {
    console.error('[ERROR] Failed to delete rule:', error);
    return c.json({ success: false, error: 'Failed to delete rule' }, 500);
  }
});

// ============================================
// Dashboard / Static Pages
// ============================================

/**
 * GET / - Dashboard (simple HTML)
 */
app.get('/', async (c) => {
  const dashboardHtml = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GAS Masking Proxy</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f5f5;
      padding: 20px;
      line-height: 1.6;
    }
    .container { max-width: 1000px; margin: 0 auto; }
    header {
      background: #1a73e8;
      color: white;
      padding: 20px;
      border-radius: 8px 8px 0 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    header h1 { font-size: 1.5rem; }
    .logout-btn {
      background: rgba(255,255,255,0.2);
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
    }
    main {
      background: white;
      padding: 20px;
      border-radius: 0 0 8px 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }
    .section { margin-bottom: 30px; }
    .section h2 {
      font-size: 1.1rem;
      margin-bottom: 15px;
      padding-bottom: 10px;
      border-bottom: 2px solid #1a73e8;
    }
    .form-group { margin-bottom: 15px; }
    label { display: block; margin-bottom: 5px; font-weight: 500; }
    input[type="text"], input[type="url"] {
      width: 100%;
      padding: 10px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
    }
    button {
      background: #1a73e8;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    }
    button:hover { background: #1557b0; }
    button.danger { background: #dc3545; }
    button.danger:hover { background: #c82333; }
    table { width: 100%; border-collapse: collapse; }
    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #ddd;
    }
    th { background: #f8f9fa; font-weight: 600; }
    .actions { display: flex; gap: 8px; }
    .actions button { padding: 6px 12px; font-size: 12px; }
    .copy-btn {
      background: #28a745;
      padding: 4px 8px;
      font-size: 12px;
      margin-left: 8px;
    }
    .login-form {
      max-width: 400px;
      margin: 100px auto;
      background: white;
      padding: 30px;
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }
    .login-form h1 { margin-bottom: 20px; text-align: center; }
    .message { padding: 10px; margin-bottom: 15px; border-radius: 4px; }
    .message.error { background: #f8d7da; color: #721c24; }
    .message.success { background: #d4edda; color: #155724; }
    #app-list { min-height: 100px; }
    .loading { text-align: center; color: #666; padding: 20px; }
    .empty { text-align: center; color: #666; padding: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <div id="login-view" style="display: none;">
      <div class="login-form">
        <h1>GAS Masking Proxy</h1>
        <div id="login-message" class="message" style="display: none;"></div>
        <form id="login-form">
          <div class="form-group">
            <label>パスワード</label>
            <input type="password" id="password" required>
          </div>
          <button type="submit" style="width: 100%;">ログイン</button>
        </form>
      </div>
    </div>

    <div id="dashboard-view" style="display: none;">
      <header>
        <h1>GAS Masking Proxy</h1>
        <button class="logout-btn" onclick="logout()">ログアウト</button>
      </header>
      <main>
        <div class="section">
          <h2>新規アプリ登録</h2>
          <form id="register-form">
            <div class="form-group">
              <label>GAS URL</label>
              <input type="url" id="gas-url" placeholder="https://script.google.com/macros/s/..." required>
            </div>
            <div class="form-group">
              <label>アプリ名</label>
              <input type="text" id="app-name" placeholder="営業管理アプリ" required>
            </div>
            <button type="submit">登録する</button>
          </form>
          <div id="register-message" class="message" style="display: none; margin-top: 15px;"></div>
        </div>

        <div class="section">
          <h2>登録済みアプリ</h2>
          <div id="app-list">
            <div class="loading">読み込み中...</div>
          </div>
        </div>
      </main>
    </div>
  </div>

  <script>
    let authToken = localStorage.getItem('authToken');

    function showLogin() {
      document.getElementById('login-view').style.display = 'block';
      document.getElementById('dashboard-view').style.display = 'none';
    }

    function showDashboard() {
      document.getElementById('login-view').style.display = 'none';
      document.getElementById('dashboard-view').style.display = 'block';
      loadApps();
    }

    function logout() {
      localStorage.removeItem('authToken');
      authToken = null;
      showLogin();
    }

    async function apiRequest(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        headers: {
          'Authorization': 'Basic ' + authToken,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });
      if (response.status === 401) {
        logout();
        throw new Error('Unauthorized');
      }
      return response.json();
    }

    async function loadApps() {
      const listEl = document.getElementById('app-list');
      try {
        const result = await apiRequest('/api/apps');
        if (result.success && result.data.length > 0) {
          listEl.innerHTML = \`
            <table>
              <thead>
                <tr>
                  <th>アプリ名</th>
                  <th>プロキシURL</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                \${result.data.map(app => \`
                  <tr>
                    <td>\${escapeHtml(app.name)}</td>
                    <td>
                      <a href="/view/\${app.id}" target="_blank">/view/\${app.id}</a>
                      <button class="copy-btn" onclick="copyUrl('/view/\${app.id}')">コピー</button>
                    </td>
                    <td class="actions">
                      <button onclick="openSettings('\${app.id}')">設定</button>
                      <button class="danger" onclick="deleteApp('\${app.id}')">削除</button>
                    </td>
                  </tr>
                \`).join('')}
              </tbody>
            </table>
          \`;
        } else {
          listEl.innerHTML = '<div class="empty">登録されたアプリはありません</div>';
        }
      } catch (error) {
        listEl.innerHTML = '<div class="message error">アプリの読み込みに失敗しました</div>';
      }
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function copyUrl(path) {
      const url = window.location.origin + path;
      navigator.clipboard.writeText(url).then(() => {
        alert('URLをコピーしました: ' + url);
      });
    }

    function openSettings(appId) {
      alert('設定画面は Phase 3 で実装予定です。\\n\\nAPI経由でルール設定が可能です:\\nGET /api/apps/' + appId + '/rules');
    }

    async function deleteApp(appId) {
      if (!confirm('このアプリを削除しますか？')) return;
      try {
        const result = await apiRequest('/api/apps/' + appId, { method: 'DELETE' });
        if (result.success) {
          loadApps();
        } else {
          alert('削除に失敗しました: ' + result.error);
        }
      } catch (error) {
        alert('削除に失敗しました');
      }
    }

    // Login form
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = document.getElementById('password').value;
      const token = btoa('admin:' + password);

      try {
        const response = await fetch('/api/apps', {
          headers: { 'Authorization': 'Basic ' + token }
        });

        if (response.ok) {
          authToken = token;
          localStorage.setItem('authToken', token);
          showDashboard();
        } else {
          const msg = document.getElementById('login-message');
          msg.textContent = 'パスワードが正しくありません';
          msg.className = 'message error';
          msg.style.display = 'block';
        }
      } catch (error) {
        alert('ログインに失敗しました');
      }
    });

    // Register form
    document.getElementById('register-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = document.getElementById('gas-url').value;
      const name = document.getElementById('app-name').value;
      const msgEl = document.getElementById('register-message');

      try {
        const result = await apiRequest('/api/apps', {
          method: 'POST',
          body: JSON.stringify({ url, name }),
        });

        if (result.success) {
          msgEl.textContent = '登録しました！プロキシURL: ' + result.data.proxyUrl;
          msgEl.className = 'message success';
          msgEl.style.display = 'block';
          document.getElementById('gas-url').value = '';
          document.getElementById('app-name').value = '';
          loadApps();
        } else {
          msgEl.textContent = '登録に失敗: ' + result.error;
          msgEl.className = 'message error';
          msgEl.style.display = 'block';
        }
      } catch (error) {
        msgEl.textContent = '登録に失敗しました';
        msgEl.className = 'message error';
        msgEl.style.display = 'block';
      }
    });

    // Initialize
    if (authToken) {
      // Verify token is still valid
      fetch('/api/apps', { headers: { 'Authorization': 'Basic ' + authToken } })
        .then(r => r.ok ? showDashboard() : showLogin())
        .catch(() => showLogin());
    } else {
      showLogin();
    }
  </script>
</body>
</html>`;

  return c.html(dashboardHtml);
});

/**
 * Health check endpoint
 */
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Export the app for Cloudflare Workers
export default app;
