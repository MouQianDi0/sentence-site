// 标注题库：用你自己配的国内模型，把等着标注（raw）的真题句子逐句拆解成和 AI 出题一样格式的题（body）。
// - 永远不走 ChatGPT（标注结果所有账户都会用到，套餐凭据只能用于你自己的请求），见 settings.ts 的 llmFor。
// - token 记在你自己（owner）名下，用途是 annotate。
// - 拆解必须过和 AI 出题一样的严格校验，而且片段拼回去要等于原句（改过原文的用改过的）。过了 → ready；
//   没过 → rejected 并记下原因；模型出错（没配好、超时、限流、回复不是 JSON……）留在 raw，下次再试。
// 网页（/api/admin/bank/annotate）和命令行（scripts/annotate-bank.ts）都用这里；同一个进程里同时只跑一批。
import type { BankJob, Level, SentenceBody } from '@sentence-site/shared';
import type { AppConfig } from './config.ts';
import * as repo from './repo.ts';
import type { BankItemRow } from './repo.ts';
import { LlmError, type Llm } from './llm.ts';
import type { LlmUse } from './llm-route.ts';
import { annotatePrompt } from './prompts.ts';
import { checkSentence, plainText } from './validate.ts';
import { reviewPredicates } from './ai.ts';
import { sameText } from './bank.ts';
import { metered } from './tokens.ts';
import { HttpError } from './http.ts';

type Logger = Pick<Console, 'log' | 'error'> & { warn?: (...a: unknown[]) => void };
type Loose = Record<string, unknown>;
const obj = (v: unknown): Loose | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Loose) : null);

const OWNER = { id: 'owner', role: 'owner' } as const;
export const ANNOTATE_USE: LlmUse = { kind: 'annotate' };
/** 校验没过时同一句最多再问一次模型 */
const TRIES = 2;
/** 这几种错误说明模型现在用不了，整批停下来 */
const FATAL = ['auth', 'not_configured', 'rate_limited'];

/** 一句的标注结果：ready / rejected 写回数据库；raw 是模型出错，留着下次再试 */
export type Outcome =
  | { status: 'ready'; body: SentenceBody; by: string }
  | { status: 'rejected'; reason: string; by?: string }
  | { status: 'raw'; error: LlmError | Error };

/** 不用问模型就知道不合格的：词数（按 validate.ts 的数法）、结尾标点 */
export function precheck(text: string): string | null {
  const plain = text.replace(/\s+/g, ' ').trim();
  const words = plain.split(' ').length;
  if (words < 15 || words > 60) return `句子长度 ${words} 词，不在 15–60 之间`;
  if (!/[.!?]["'”’]?$/.test(plain)) return '句子没有以句号结尾';
  return null;
}

/** 拆解一句：L 是已经包好记账的国内模型 */
export async function annotateItem(
  L: Llm,
  item: Pick<BankItemRow, 'text' | 'textFix' | 'level'>,
  timeoutMs: number,
): Promise<Outcome> {
  const text = item.textFix ?? item.text;
  const level: Level = item.level === 'CET-6' ? 'CET-6' : 'CET-4';
  const early = precheck(text);
  if (early) return { status: 'rejected', reason: early };
  let reason = '';
  let by = '';
  for (let i = 0; i < TRIES; i++) {
    let data: unknown;
    try {
      const r = await L.chatJson({
        prompt: annotatePrompt(text, level),
        model: L.models().main,
        maxTokens: 4000,
        temperature: 0.3,
        timeoutMs: Math.max(timeoutMs, 180_000),
      });
      data = r.data;
      by = r.model;
    } catch (e) {
      return { status: 'raw', error: e instanceof Error ? e : new Error(String(e)) };
    }
    const d = obj(data);
    const skip = typeof d?.skip === 'string' ? d.skip.trim() : '';
    if (skip) return { status: 'rejected', reason: `模型说不能拆：${skip.slice(0, 60)}`, by };
    const raw = obj(d?.sentence) ?? (Array.isArray(d?.sentences) ? obj((d.sentences as unknown[])[0]) : d);
    const checked = checkSentence({ ...raw, level }, { strict: true });
    if (!checked.ok) {
      reason = checked.reason;
      continue;
    }
    if (!sameText(plainText(checked.value.segs), text)) {
      reason = '拆出来的片段拼起来和原句不一样';
      continue;
    }
    // 和出题一样再让模型复核一遍谓语：标错的按复核结果改，改完再校验；复核本身出错时保留规则校验通过的
    let body: SentenceBody = { ...checked.value, level };
    try {
      const [rv] = await reviewPredicates(L, [body], timeoutMs);
      if (rv?.status === 'mismatch') {
        reason = '复核给出的谓语在原句里找不到';
        continue;
      }
      if (rv?.status === 'ok' && rv.changed) {
        const again = checkSentence({ ...body, segs: rv.segs }, { strict: true });
        if (!again.ok) {
          reason = `复核改正后仍不合格：${again.reason}`;
          continue;
        }
        body = { ...again.value, level };
      }
    } catch {
      // 复核没做成：规则校验已经过了，照样用
    }
    return { status: 'ready', body, by };
  }
  return { status: 'rejected', reason, by };
}

/**
 * llmFor：settings.ts 的 llmFor（传 annotate 用途，拿到的一定是国内模型）。
 * 返回 start（后台跑一批，网页用）、run（跑完一批再返回，命令行用）、job（当前 / 上一批的进度）。
 */
export function createAnnotator({
  cfg,
  llmFor,
  log = console,
}: {
  cfg: Pick<AppConfig, 'llm'>;
  llmFor: (account: typeof OWNER, use: LlmUse) => Promise<Llm>;
  log?: Logger;
}) {
  let job: BankJob | null = null;

  async function model(): Promise<Llm> {
    const L = await llmFor(OWNER, ANNOTATE_USE);
    if (!L.ready())
      throw new HttpError(503, '还没配置国内模型：标注题库只用国内模型（不用 ChatGPT），先到“设置”里配好');
    return metered(L, OWNER.id, 'annotate', log);
  }

  /** 跑一批：limit 句，concurrency 句同时进行。onItem：每句做完后调用（命令行打印进度） */
  async function run(
    { limit, concurrency = 3 }: { limit: number; concurrency?: number },
    onItem: (item: BankItemRow, o: Outcome) => void = () => {},
  ): Promise<BankJob> {
    if (job?.running) throw new HttpError(409, '已经有一批在标注了，等它跑完');
    const startedAt = new Date().toISOString();
    job = {
      running: true,
      total: 0,
      done: 0,
      ready: 0,
      rejected: 0,
      failed: 0,
      startedAt,
      finishedAt: null,
      error: '',
    };
    const cur = job;
    try {
      const L = await model();
      const items = await repo.rawBankItems(Math.max(1, Math.min(2000, Math.round(limit))));
      cur.total = items.length;
      let next = 0;
      const worker = async () => {
        while (next < items.length && !cur.error) {
          const item = items[next++];
          if (!item) break;
          const o = await annotateItem(L, item, cfg.llm.timeoutMs);
          if (o.status === 'raw') {
            cur.failed++;
            if (o.error instanceof LlmError && FATAL.includes(o.error.code)) cur.error = o.error.message;
          } else if (await repo.saveAnnotation(item, o)) {
            if (o.status === 'ready') cur.ready++;
            else cur.rejected++;
          }
          cur.done++;
          onItem(item, o);
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(8, concurrency)) }, worker));
    } catch (e) {
      cur.error = (e as Error).message;
      if (!(e instanceof HttpError)) log.error(`[annotate] ${cur.error}`);
    } finally {
      cur.running = false;
      cur.finishedAt = new Date().toISOString();
    }
    return { ...cur };
  }

  /** 网页用：先确认模型配好了、没有正在跑的，然后在后台跑，马上返回进度 */
  async function start(opts: { limit: number; concurrency?: number }): Promise<BankJob> {
    if (job?.running) throw new HttpError(409, '已经有一批在标注了，等它跑完');
    await model();
    if (job?.running) throw new HttpError(409, '已经有一批在标注了，等它跑完');
    // run 在第一次 await 之前就把 job 设好了
    run(opts)
      .then((j) =>
        log.log(
          `[annotate] 标注完 ${j.done} 句：可以抽 ${j.ready}，不要 ${j.rejected}，出错 ${j.failed}${j.error ? `（${j.error}）` : ''}`,
        ),
      )
      .catch((e: Error) => log.error(`[annotate] ${e.message}`));
    return { ...(job as unknown as BankJob) };
  }

  return { run, start, job: (): BankJob | null => (job ? { ...job } : null) };
}

export type Annotator = ReturnType<typeof createAnnotator>;
