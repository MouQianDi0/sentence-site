// 练习设置：每天的任务出几句（1–10）、出四级还是六级（可以都选，混合随机）。每个账户各存一份（accounts.practice）。
import * as repo from './repo.js';
import { HttpError } from './http.js';

export const LEVELS = ['CET-4', 'CET-6'];
export const MAX_DAILY = 10;

const clampCount = (n, d) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(MAX_DAILY, Math.max(1, v)) : d;
};

export function createPractice(cfg) {
  const defaults = { levels: [...LEVELS], dailyCount: clampCount(cfg.daily?.count, 5) };

  function normalize(raw = {}, base = defaults) {
    const levels = Array.isArray(raw.levels) ? LEVELS.filter((l) => raw.levels.includes(l)) : base.levels;
    return {
      levels: levels.length ? levels : base.levels,
      dailyCount: 'dailyCount' in raw ? clampCount(raw.dailyCount, base.dailyCount) : base.dailyCount,
    };
  }

  // dailyAt：每天自动生成的时间（北京时间）；autoDaily：有没有开自动生成
  const dailyAt = `${cfg.daily?.hour ?? 7}:${String(cfg.daily?.minute ?? 50).padStart(2, '0')}`;

  /** account：accounts 表里的一行（带 practice 字段） */
  function get(account) {
    const cur = normalize(account?.practice || {});
    return { ...cur, levels: [...cur.levels], maxDaily: MAX_DAILY, dailyAt, autoDaily: cfg.daily?.enabled !== false };
  }

  async function save(account, body = {}) {
    if ('levels' in body && (!Array.isArray(body.levels) || !LEVELS.some((l) => body.levels.includes(l)))) {
      throw new HttpError(400, '至少选一个：四级或六级');
    }
    if ('dailyCount' in body) {
      const n = Number(body.dailyCount);
      if (!Number.isInteger(n) || n < 1 || n > MAX_DAILY) throw new HttpError(400, `每天的句数要在 1–${MAX_DAILY} 之间`);
    }
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
