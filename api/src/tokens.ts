// token 用量：每次调用模型后记到账户名下（token_usage 表），以及“设置 → Token 用量”页的统计。
// 用量来自模型接口返回的 usage 字段；接口没返回时只记调用次数。
import type { TokenCount, TokenKind, TokenStats } from '@sentence-site/shared';
import * as repo from './repo.ts';
import { LlmError, type ChatJsonResult, type Llm } from './llm.ts';
import { shanghaiDate } from './time.ts';

export const TOKEN_KINDS: TokenKind[] = ['grade', 'lookup', 'generate', 'review', 'test'];
/** 统计页能选的范围（天） */
export const TOKEN_RANGES = [7, 30, 90];

type Logger = Pick<Console, 'error'>;

const DAY = 24 * 60 * 60 * 1000;
/** 北京时间 n 天前的日期，YYYY-MM-DD */
export const daysAgo = (n: number, now = new Date()): string => shanghaiDate(new Date(now.getTime() - n * DAY));

async function record(
  accountId: string,
  kind: TokenKind,
  model: string,
  usage: ChatJsonResult['usage'],
  log: Logger,
): Promise<void> {
  try {
    await repo.addTokens({
      accountId,
      day: shanghaiDate(),
      kind,
      model: model.slice(0, 100),
      input: Math.max(0, usage.input ?? 0),
      output: Math.max(0, usage.output ?? 0),
    });
  } catch (e) {
    // 记账失败不影响正常使用
    log.error('[tokens]', (e as Error).message);
  }
}

/**
 * 包一层 AI 客户端：每次调用模型后，把用掉的 token 记到这个账户名下。
 * 模型回复了但格式不对时（invalid_json），token 照样花掉了，也要记。
 */
export function metered(L: Llm, accountId: string, kind: TokenKind, log: Logger = console): Llm {
  return {
    ...L,
    async chatJson(opts) {
      try {
        const r = await L.chatJson(opts);
        await record(accountId, kind, r.model, r.usage, log);
        return r;
      } catch (e) {
        if (e instanceof LlmError && e.usage) await record(accountId, kind, e.model || opts.model, e.usage, log);
        throw e;
      }
    },
  };
}

const zero = (): TokenCount => ({ input: 0, output: 0, calls: 0 });
const add = (a: TokenCount, b: TokenCount): TokenCount => ({
  input: a.input + b.input,
  output: a.output + b.output,
  calls: a.calls + b.calls,
});
const size = (c: TokenCount) => c.input + c.output;

/** 当前账户的用量统计。days：图表和分类统计的范围（7、30、90，其他值按 30） */
export async function tokenStats(accountId: string, daysIn: unknown, now = new Date()): Promise<TokenStats> {
  const days = TOKEN_RANGES.includes(Number(daysIn)) ? Number(daysIn) : 30;
  const span = Math.max(days, 30);
  const rows = await repo.listTokens(accountId, daysAgo(span - 1, now));
  const total = await repo.tokenTotal(accountId);
  const from = daysAgo(days - 1, now);

  const sumSince = (day: string) => rows.filter((r) => r.day >= day).reduce((acc, r) => add(acc, r), zero());

  const perDay = new Map<string, TokenCount>();
  const perKind = new Map<TokenKind, TokenCount>();
  const perModel = new Map<string, TokenCount>();
  for (const r of rows) {
    if (r.day < from) continue;
    perDay.set(r.day, add(perDay.get(r.day) ?? zero(), r));
    const kind = (TOKEN_KINDS as string[]).includes(r.kind) ? (r.kind as TokenKind) : 'grade';
    perKind.set(kind, add(perKind.get(kind) ?? zero(), r));
    const model = r.model || '未知模型';
    perModel.set(model, add(perModel.get(model) ?? zero(), r));
  }
  const daily = Array.from({ length: days }, (_, i) => {
    const day = daysAgo(days - 1 - i, now);
    return { day, ...(perDay.get(day) ?? zero()) };
  });
  const sorted = <K>(m: Map<K, TokenCount>) => [...m.entries()].sort((a, b) => size(b[1]) - size(a[1]));

  return {
    days,
    today: sumSince(daysAgo(0, now)),
    last7: sumSince(daysAgo(6, now)),
    last30: sumSince(daysAgo(29, now)),
    total: { input: total.input, output: total.output, calls: total.calls },
    daily,
    byKind: sorted(perKind).map(([kind, c]) => ({ kind, ...c })),
    byModel: sorted(perModel).map(([model, c]) => ({ model, ...c })),
    since: total.since,
  };
}
