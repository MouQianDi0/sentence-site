// 登录：访问密码登录你自己的账户（owner），邀请码登录对应的邀请账户；换一个 30 天有效的签名 Cookie。
// Cookie 里带着账户 id 和版本号：改了 ACCESS_PASSWORD 后你自己的旧 Cookie 失效，删除邀请码后对应账户的 Cookie 失效。
import crypto from 'node:crypto';

export const COOKIE_NAME = 'ss_session';
export const DEVICE_COOKIE = 'ss_device';
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

  /** accountId 不传时是 owner；邀请账户还带上设备编号 device（移除设备后这个 Cookie 就失效） */
  function issue(accountId = 'owner', version = pwVersion, device = undefined) {
    const data = { a: accountId, v: version, exp: now() + MAX_AGE };
    if (device) data.d = device;
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    return `${payload}.${sign(payload)}`;
  }

  /** 签名和有效期对得上时返回 {a, v, d}（账户 id、版本号、设备编号），由调用方再去核对账户；否则返回 null */
  function verify(token) {
    if (typeof token !== 'string') return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const x = Buffer.from(sig);
    const y = Buffer.from(sign(payload));
    if (x.length !== y.length || !crypto.timingSafeEqual(x, y)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (typeof data.exp !== 'number' || data.exp <= now()) return null;
      // 旧版 Cookie 没有账户 id，都是 owner 的
      return { a: typeof data.a === 'string' ? data.a : 'owner', v: data.v, d: data.d };
    } catch {
      return null;
    }
  }

  function cookie(token, secure) {
    const parts = [`${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${MAX_AGE / 1000}`];
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }

  /** 设备编号 Cookie：退出登录也保留，下次在同一个浏览器登录不会多占一个设备名额 */
  function deviceCookie(id, secure) {
    const parts = [`${DEVICE_COOKIE}=${id}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${10 * 365 * 24 * 3600}`];
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

  /**
   * 先按访问密码比对，不对再用 findByCode 找邀请码对应的账户。
   * 成功返回 {ok:true, account:'owner'} 或 {ok:true, account:<邀请账户>}；连续错 5 次锁 15 分钟。
   */
  async function tryLogin(ip, input, findByCode = async () => null) {
    const locked = lockedMinutes(ip);
    if (locked) return { ok: false, locked };
    const text = typeof input === 'string' ? input : '';
    let account = text && crypto.timingSafeEqual(sha256(text), pwHash) ? 'owner' : null;
    if (!account && text) account = (await findByCode(text)) || null;
    if (account) {
      fails.delete(ip);
      return { ok: true, account };
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

  return { issue, verify, cookie, deviceCookie, tryLogin, ownerVersion: pwVersion };
}
