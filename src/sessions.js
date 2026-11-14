import crypto from 'node:crypto';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export class SessionStore {
  constructor() {
    this.sessions = new Map();
    this.timer = setInterval(() => this.cleanup(), 10 * 60 * 1000);
    this.timer.unref?.();
  }

  create(ip = '', authRevision = '') {
    const token = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.sessions.set(token, {
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      ip,
      authRevision,
      csrfToken
    });
    return {
      token,
      csrfToken,
      maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000)
    };
  }

  get(token, authRevision = null) {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    if (authRevision !== null && session.authRevision !== authRevision) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  destroy(token) {
    if (token) this.sessions.delete(token);
  }

  clear() {
    this.sessions.clear();
  }

  cleanup() {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }

  close() {
    clearInterval(this.timer);
  }
}

export function sessionCookie(token, maxAgeSeconds) {
  return `vl_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie() {
  return 'vl_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';
}
