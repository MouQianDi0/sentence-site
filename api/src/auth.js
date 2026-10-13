// 访问密码：不做账号，只用一个密码换一个 30 天有效的签名 Cookie。
// 改了 ACCESS_PASSWORD 之后，旧 Cookie 全部失效（Cookie 里带着密码版本号）。
import crypto from 'node:crypto';

export const COOKIE_NAME = 'ss_session';
const DAY = 24 * 60 * 60 * 1000;
const MAX_AGE = 30 * DAY;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

export function createAuth({ accessPassword, cookieSecret, now = () => Date.now() }) {
  const pwHash = sha256(accessPassword);
  const pwVersion = pwHash.toString('hex').slice(0, 12);
  const fails = new Map(); // ip -> { count, until }

  const sign = (payload) =>
    crypto.createHmac('sha256', cookieSecret).update(payload).digest('base64url');

  function issue() {
    const payload = Buffer.from(JSON.stringify({ v: pwVersion, exp: now() + MAX_AGE })).toString('base64url');
    return `${payload}.${sign(payload)}`;
  }

  function verify(token) {
    if (typeof token !== 'string') return false;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return false;
    const a = Buffer.from(sig);
    const b = Buffer.from(sign(payload));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return data.v === pwVersion && typeof data.exp === 'number' && data.exp > now();
    } catch {
      return false;
    }
  }

  function cookie(token, secure) {
    const parts = [`${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${MAX_AGE / 1000}`];
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }

  /** 返回剩余锁定分钟数，没锁定返回 0 */
  function lockedMinutes(ip) {
    const f = fails.get(ip);
    if (!f || !f.until) return 0;
    if (f.until <= now()) {
      fails.delete(ip);
      return 0;
    }
    return Math.ceil((f.until - now()) / 60000);
  }

  function tryPassword(ip, password) {
    const locked = lockedMinutes(ip);
    if (locked) return { ok: false, locked };
    const ok = typeof password === 'string' && crypto.timingSafeEqual(sha256(password), pwHash);
    if (ok) {
      fails.delete(ip);
      return { ok: true };
    }
    const f = fails.get(ip) || { count: 0, until: 0 };
    f.count += 1;
    if (f.count >= MAX_FAILS) {
      f.count = 0;
      f.until = now() + LOCK_MS;
      fails.set(ip, f);
      return { ok: false, locked: LOCK_MS / 60000 };
    }
    fails.set(ip, f);
    return { ok: false, left: MAX_FAILS - f.count };
  }

  return { issue, verify, cookie, tryPassword };
}
