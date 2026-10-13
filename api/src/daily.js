// 每天北京时间 7:50（可在 .env 里改）自动出 5 句。服务重启后如果当天还没出题，也会补上。
import * as repo from './repo.js';
import { shanghaiDate, shanghaiParts } from './time.js';

export function startDailyJob({ cfg, ai, llm, log = console, intervalMs = 60_000 }) {
  if (!cfg.daily.enabled) return () => {};
  let running = false;
  let doneDay = null;
  let retryAfter = 0;

  async function tick() {
    if (running || !llm.ready()) return;
    const p = shanghaiParts();
    const day = shanghaiDate();
    if (doneDay === day || Date.now() < retryAfter) return;
    if (p.h * 60 + p.min < cfg.daily.hour * 60 + cfg.daily.minute) return;
    running = true;
    try {
      if (await repo.hasDailyFor(day)) {
        doneDay = day;
        return;
      }
      const ids = await ai.generate({ source: 'daily', n: cfg.daily.count });
      doneDay = day;
      log.log(`[daily] ${day} 新增 ${ids.length} 句：${ids.join(', ')}`);
    } catch (e) {
      retryAfter = Date.now() + 30 * 60_000; // 失败后 30 分钟再试
      log.error(`[daily] 出题失败：${e.message}`);
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
