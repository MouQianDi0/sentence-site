// 每天北京时间 7:50（可在 .env 里改）自动生成今日任务：句数和难度按各账户“设置”里的“每日任务”。
// 照顾的账户：你自己，加上最近 7 天登录过、而且配好了自己模型的邀请账户（很久没来的回来后在页面上点一下就能生成）。
// 服务重启后如果当天还没出题，也会补上。
import * as repo from './repo.js';
import { shanghaiDate, shanghaiParts } from './time.js';

export const ACTIVE_DAYS = 7;

/** llmFor(account)：这个账户的 AI 客户端；没配置模型的账户跳过 */
export function startDailyJob({ cfg, ai, llmFor, practice, log = console, intervalMs = 60_000 }) {
  if (!cfg.daily.enabled) return () => {};
  let running = false;
  const done = new Map(); // 账户 id -> 已经出好题的日期
  const retryAfter = new Map(); // 账户 id -> 失败后下次再试的时间

  async function tick() {
    if (running) return;
    const p = shanghaiParts();
    const day = shanghaiDate();
    if (p.h * 60 + p.min < cfg.daily.hour * 60 + cfg.daily.minute) return;
    running = true;
    try {
      for (const acc of await repo.listActiveAccounts(ACTIVE_DAYS)) {
        if (done.get(acc.id) === day || Date.now() < (retryAfter.get(acc.id) || 0)) continue;
        try {
          if (!(await llmFor(acc)).ready()) continue;
          if (await repo.hasDailyFor(acc.id, day)) {
            done.set(acc.id, day);
            continue;
          }
          const set = practice.get(acc);
          const ids = await ai.generate(acc, { source: 'daily', n: set.dailyCount, levels: set.levels });
          done.set(acc.id, day);
          log.log(`[daily] ${day} ${acc.role === 'owner' ? '我' : acc.note || acc.id} 新增 ${ids.length} 句`);
        } catch (e) {
          retryAfter.set(acc.id, Date.now() + 30 * 60_000); // 失败后 30 分钟再试
          log.error(`[daily] ${acc.note || acc.id} 出题失败：${e.message}`);
        }
      }
    } catch (e) {
      log.error(`[daily] 读取账户失败：${e.message}`);
    } finally {
      running = false;
    }
  }

  const first = setTimeout(tick, 10_000);
  const timer = setInterval(tick, intervalMs);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
