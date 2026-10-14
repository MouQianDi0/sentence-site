// 练习设置：每天的任务出几句（1–10）、出四级还是六级（可以都选，混合随机）、
// 每天几点自动生成（北京时间，也可以关掉自动生成）。每个账户各存一份（accounts.practice）。
import * as repo from './repo.js';
import { HttpError } from './http.js';

export const LEVELS = ['CET-4', 'CET-6'];
export const MAX_DAILY = 10;

const clampCount = (n, d) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(MAX_DAILY, Math.max(1, v)) : d;
};

const pad = (n) => String(n).padStart(2, '0');
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** '7:50' / '07:50' → '07:50'；不合法返回 null */
export function normalizeTime(s) {
  const m = typeof s === 'string' ? TIME_RE.exec(s.trim()) : null;
  return m ? `${pad(Number(m[1]))}:${m[2]}` : null;
}

/** '07:50' → 470（当天第几分钟） */
export const minutesOf = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export function createPractice(cfg) {
  const serverDaily = cfg.daily?.enabled !== false;
  const defaults = {
    levels: [...LEVELS],
    dailyCount: clampCount(cfg.daily?.count, 5),
    autoDaily: true,
    // .env 里的时间只是默认值，每个账户可以在“设置”里改成自己的
    dailyAt: normalizeTime(`${cfg.daily?.hour ?? 7}:${pad(cfg.daily?.minute ?? 50)}`) || '07:50',
  };

  function normalize(raw = {}, base = defaults) {
    const levels = Array.isArray(raw.levels) ? LEVELS.filter((l) => raw.levels.includes(l)) : base.levels;
    return {
      levels: levels.length ? levels : base.levels,
      dailyCount: 'dailyCount' in raw ? clampCount(raw.dailyCount, base.dailyCount) : base.dailyCount,
      autoDaily: typeof raw.autoDaily === 'boolean' ? raw.autoDaily : base.autoDaily,
      dailyAt: normalizeTime(raw.dailyAt) || base.dailyAt,
    };
  }

  /**
   * account：accounts 表里的一行（带 practice 字段）。
   * autoDaily / dailyAt 是这个账户自己的选择；serverDaily 是服务器 .env 有没有开每日出题（关了的话谁都不会自动生成）。
   */
  function get(account) {
    const cur = normalize(account?.practice || {});
    return { ...cur, levels: [...cur.levels], maxDaily: MAX_DAILY, serverDaily };
  }

  async function save(account, body = {}) {
    if ('levels' in body && (!Array.isArray(body.levels) || !LEVELS.some((l) => body.levels.includes(l)))) {
      throw new HttpError(400, '至少选一个：四级或六级');
    }
    if ('dailyCount' in body) {
      const n = Number(body.dailyCount);
      if (!Number.isInteger(n) || n < 1 || n > MAX_DAILY) throw new HttpError(400, `每天的句数要在 1–${MAX_DAILY} 之间`);
    }
    if ('autoDaily' in body && typeof body.autoDaily !== 'boolean') throw new HttpError(400, 'autoDaily 要是 true 或 false');
    if ('dailyAt' in body && !normalizeTime(body.dailyAt)) throw new HttpError(400, '生成时间的格式是 时:分，比如 07:50');
    const next = normalize(body, normalize(account.practice || {}));
    await repo.setPractice(account.id, next);
    account.practice = next;
    return get(account);
  }

  return { get, save };
}

/**
 * 给 n 句分配难度：只选一种就全是它；两种都选就各占一半（单数时多出来的那句随机），顺序打乱。
 * rand 方便测试时固定随机数。
 */
export function planLevels(n, levels, rand = Math.random) {
  const pool = LEVELS.filter((l) => levels.includes(l));
  if (pool.length <= 1) return Array(n).fill(pool[0] || LEVELS[0]);
  const plan = [];
  const half = Math.floor(n / 2);
  for (let i = 0; i < half; i++) plan.push(pool[0], pool[1]);
  if (n % 2) plan.push(pool[rand() < 0.5 ? 0 : 1]);
  for (let i = plan.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [plan[i], plan[j]] = [plan[j], plan[i]];
  }
  return plan;
}
