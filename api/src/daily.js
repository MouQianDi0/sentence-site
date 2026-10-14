// 每天按各账户自己设的时间（北京时间，默认 7:50，可在“设置”→“每日任务”里改或关掉）自动生成今日任务；
// 句数和难度也按各账户的“每日任务”设置。.env 里 DAILY_GENERATE=0 时整个功能关掉。
// 照顾的账户：你自己，加上最近 7 天登录过、而且配好了自己模型的邀请账户（很久没来的回来后在页面上点一下就能生成）。
// 服务重启后如果当天已经过了设定时间还没出题，也会补上。
import * as repo from './repo.js';
import { shanghaiDate, shanghaiParts } from './time.js';
import { minutesOf } from './practice.js';

export const ACTIVE_DAYS = 7;

/** llmFor(account)：这个账户的 AI 客户端；没配置模型的账户跳过。now 方便测试时指定时间 */
export function createDailyRunner({ ai, llmFor, practice, log = console, now = () => new Date() }) {
  let running = false;
  const done = new Map(); // 账户 id -> 已经出好题（或确认不用出）的日期
  const retryAfter = new Map(); // 账户 id -> 失败后下次再试的时间

  async function tick() {
    if (running) return;
    running = true;
    const t = now();
    const p = shanghaiParts(t);
    const day = shanghaiDate(t);
    const minute = p.h * 60 + p.min;
    try {
      for (const acc of await repo.listActiveAccounts(ACTIVE_DAYS)) {
        if (done.get(acc.id) === day || t.getTime() < (retryAfter.get(acc.id) || 0)) continue;
        const set = practice.get(acc);
        // 关了自动生成、或者还没到这个账户设的时间：先不管，下一分钟再看（中途改了设置也能跟上）
        if (!set.autoDaily || minute < minutesOf(set.dailyAt)) continue;
        try {
          if (!(await llmFor(acc)).ready()) continue;
          if (await repo.hasDailyFor(acc.id, day)) {
            done.set(acc.id, day);
            continue;
          }
          const ids = await ai.generate(acc, { source: 'daily', n: set.dailyCount, levels: set.levels });
          done.set(acc.id, day);
          log.log(`[daily] ${day} ${acc.role === 'owner' ? '我' : acc.note || acc.id} 新增 ${ids.length} 句`);
        } catch (e) {
          retryAfter.set(acc.id, t.getTime() + 30 * 60_000); // 失败后 30 分钟再试
          log.error(`[daily] ${acc.note || acc.id} 出题失败：${e.message}`);
        }
      }
    } catch (e) {
      log.error(`[daily] 读取账户失败：${e.message}`);
    } finally {
      running = false;
    }
  }

  return { tick };
}

export function startDailyJob({ cfg, ai, llmFor, practice, log = console, intervalMs = 60_000 }) {
  if (!cfg.daily.enabled) return () => {};
  const { tick } = createDailyRunner({ ai, llmFor, practice, log });
  const first = setTimeout(tick, 10_000);
  const timer = setInterval(tick, intervalMs);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
