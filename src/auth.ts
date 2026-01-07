/**
 * GAS Masking Proxy - Google OAuth Authentication
 */

import type { Env, Session } from './types';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

// Required scopes for accessing GAS web apps
const SCOPES = [
  'openid',
  'email',
  'profile',
].join(' ');

/**
 * Generate a random session ID
 */
function generateSessionId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Get the OAuth redirect URI based on the request
 */
export function getRedirectUri(requestUrl: string): string {
  const url = new URL(requestUrl);
  return `${url.protocol}//${url.host}/auth/callback`;
}

/**
 * Generate Google OAuth authorization URL
 */
export function getAuthUrl(env: Env, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state: state,
  });

  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(
  env: Env,
  code: string,
  redirectUri: string
): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code: code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

/**
 * Get user info from Google
 */
export async function getUserInfo(accessToken: string): Promise<{ email: string; name: string }> {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error('Failed to get user info');
  }

  const data = await response.json() as { email: string; name: string };
  return data;
}

/**
 * Create a new session
 */
export async function createSession(
  env: Env,
  accessToken: string,
  refreshToken: string | undefined,
  expiresIn: number,
  email: string
): Promise<Session> {
  const sessionId = generateSessionId();
  const now = Date.now();

  const session: Session = {
    id: sessionId,
    accessToken,
    refreshToken,
    expiresAt: now + expiresIn * 1000,
    email,
    createdAt: new Date(now).toISOString(),
  };

  // Store session in KV (expire after 7 days)
  await env.SESSIONS.put(`session:${sessionId}`, JSON.stringify(session), {
    expirationTtl: 7 * 24 * 60 * 60,
  });

  return session;
}

/**
 * Get session by ID
 */
export async function getSession(env: Env, sessionId: string): Promise<Session | null> {
  const data = await env.SESSIONS.get(`session:${sessionId}`, 'json');
  return data as Session | null;
}

/**
 * Delete session
 */
export async function deleteSession(env: Env, sessionId: string): Promise<void> {
  await env.SESSIONS.delete(`session:${sessionId}`);
}

/**
 * Get session ID from cookie
 */
export function getSessionIdFromCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(';').map(c => c.trim());
  for (const cookie of cookies) {
    const [name, value] = cookie.split('=');
    if (name === 'session_id') {
      return value;
    }
  }
  return null;
}

/**
 * Create session cookie
 */
export function createSessionCookie(sessionId: string): string {
  return `session_id=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`;
}

/**
 * Create logout cookie (expires immediately)
 */
export function createLogoutCookie(): string {
  return 'session_id=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

/**
 * Refresh access token if expired
 */
export async function refreshAccessToken(
  env: Env,
  session: Session
): Promise<Session | null> {
  if (!session.refreshToken) {
    return null;
  }

  // Check if token is expired (with 5 minute buffer)
  if (session.expiresAt > Date.now() + 5 * 60 * 1000) {
    return session; // Token still valid
  }

  try {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: session.refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as {
      access_token: string;
      expires_in: number;
    };

    // Update session
    const updatedSession: Session = {
      ...session,
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    await env.SESSIONS.put(`session:${session.id}`, JSON.stringify(updatedSession), {
      expirationTtl: 7 * 24 * 60 * 60,
    });

    return updatedSession;
  } catch {
    return null;
  }
}
