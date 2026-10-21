// AI 学习分析（记录页）：汇总这个账户的批改和练习记录，交给模型写一份学习报告（学习曲线、要改的翻译习惯、
// 薄弱结构、接下来怎么练），存进 analyses 表。只读写当前账户自己的数据。
import type {
  Analysis,
  Attempt,
  CurvePoint,
  Habit,
  LearningReport,
  LearningStats,
  PracticeRecord,
  ScoreAvg,
  Sentence,
} from '@sentence-site/shared';
import type { AppConfig } from './config.ts';
import * as repo from './repo.ts';
import { HttpError } from './http.ts';
import { LlmError, type Llm } from './llm.ts';
import type { LlmUse } from './llm-route.ts';
import { toHttpError, withQuota, type Account, type Logger } from './ai.ts';
import { analysisPrompt, type AnalysisInput } from './prompts.ts';
import { metered } from './tokens.ts';
import { plainText } from './validate.ts';
import { specKbNames } from './spec.ts';
import { shanghaiDate } from './time.ts';

/** 至少批改过几句才能分析 */
export const MIN_SENTENCES = 3;
/** 交给模型的批注问题、完整例子最多几条 */
const MAX_ISSUES = 40;
const RECENT_SAMPLES = 4;
const LOW_SAMPLES = 2;

type Loose = Record<string, unknown> | null;
const obj = (v: unknown): Loose => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, max: number) =>
  String(v ?? '')
    .trim()
    .slice(0, max);
const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : 0);

/** 有分数的一次批改（导入的旧批改可能没有分数） */
type Scored = Attempt & { acc: number; flu: number; comp: number; total: number };
const isScored = (a: Attempt): a is Scored => a.total !== null && a.acc !== null && a.flu !== null && a.comp !== null;

const avgOf = (xs: Scored[]): ScoreAvg => ({
  total: mean(xs.map((x) => x.total)),
  acc: mean(xs.map((x) => x.acc)),
  flu: mean(xs.map((x) => x.flu)),
  comp: mean(xs.map((x) => x.comp)),
});

const DAY = 86_400_000;
/** 北京时间的日期 ↔ 从 1970-01-01 起第几天 */
const dayNum = (iso: string) => Date.parse(`${shanghaiDate(new Date(iso))}T00:00:00Z`) / DAY;
const dayStr = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);

/** 有分数的批改，从早到晚 */
const chronological = (attempts: Attempt[], has: (id: string) => boolean): Scored[] =>
  attempts
    .filter((a): a is Scored => isScored(a) && has(a.sentenceId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);

/** 每句第一次提交，从早到晚 */
function firstAttempts(list: Scored[]): Scored[] {
  const seen = new Set<string>();
  return list.filter((a) => {
    if (seen.has(a.sentenceId)) return false;
    seen.add(a.sentenceId);
    return true;
  });
}

/** 汇总这个账户的批改和练习记录。没有有分数的批改时 sentences 是 0，其余字段是空的 */
export function learningStats(sentences: Sentence[], records: PracticeRecord[], attempts: Attempt[]): LearningStats {
  const byId = new Map(sentences.map((s) => [s.id, s]));
  const all = chronological(attempts, (id) => byId.has(id));
  const firsts = firstAttempts(all);
  const half = Math.floor(firsts.length / 2);

  // 学习曲线：练的时间跨度在两周内按天，16 周内按周，再长就分成 16 段左右
  let curveUnit: LearningStats['curveUnit'] = 'day';
  const curve: CurvePoint[] = [];
  const head = firsts[0];
  const tail = firsts.at(-1);
  if (head && tail) {
    const d0 = dayNum(head.createdAt);
    const d1 = dayNum(tail.createdAt);
    const span = d1 - d0 + 1;
    const width = span <= 14 ? 1 : span <= 7 * 16 ? 7 : Math.ceil(span / 16);
    curveUnit = width === 1 ? 'day' : width === 7 ? 'week' : 'span';
    const buckets = new Map<number, Scored[]>();
    for (const a of firsts) {
      const i = Math.floor((dayNum(a.createdAt) - d0) / width);
      buckets.set(i, [...(buckets.get(i) ?? []), a]);
    }
    for (const [i, xs] of [...buckets].sort((a, b) => a[0] - b[0])) {
      const from = d0 + i * width;
      curve.push({ from: dayStr(from), to: dayStr(Math.min(from + width - 1, d1)), n: xs.length, ...avgOf(xs) });
    }
  }

  const issues = new Map<string, { n: number; earlier: number; recent: number }>();
  firsts.forEach((a, i) => {
    for (const it of a.feedback?.issues ?? []) {
      const type = it.type || '其他';
      const c = issues.get(type) ?? { n: 0, earlier: 0, recent: 0 };
      c.n++;
      if (i < half) c.earlier++;
      else c.recent++;
      issues.set(type, c);
    }
  });

  const points = new Map<string, number[]>();
  const levels = new Map<string, number[]>();
  for (const a of firsts) {
    const s = byId.get(a.sentenceId);
    for (const k of new Set((s?.segs ?? []).map((g) => g.k).filter((k) => k && k !== 'main'))) {
      points.set(k, [...(points.get(k) ?? []), a.total]);
    }
    const level = s?.level || '未标注难度';
    levels.set(level, [...(levels.get(level) ?? []), a.total]);
  }

  const gains: number[] = [];
  const bySentence = new Map<string, Scored[]>();
  for (const a of all) bySentence.set(a.sentenceId, [...(bySentence.get(a.sentenceId) ?? []), a]);
  for (const xs of bySentence.values()) {
    if (xs.length > 1) gains.push(Math.max(...xs.map((x) => x.total)) - (xs[0]?.total ?? 0));
  }

  const own = records.filter((r) => byId.has(r.sentenceId));
  const verbs = own.flatMap((r) => (r.verbs ? [r.verbs] : []));
  const choice = own.flatMap((r) => (r.choice ? [r.choice] : []));

  return {
    sentences: firsts.length,
    attempts: all.length,
    firstAt: head?.createdAt ?? '',
    lastAt: all.at(-1)?.createdAt ?? '',
    avg: avgOf(firsts),
    earlier: avgOf(firsts.slice(0, half)),
    recent: avgOf(firsts.slice(half)),
    curveUnit,
    curve,
    issues: [...issues].map(([type, c]) => ({ type, ...c })).sort((a, b) => b.n - a.n),
    points: [...points]
      .map(([k, xs]) => ({ k, n: xs.length, avg: mean(xs) }))
      .sort((a, b) => a.avg - b.avg || b.n - a.n),
    levels: [...levels].map(([level, xs]) => ({ level, n: xs.length, avg: mean(xs) })),
    retry: { sentences: gains.length, gain: mean(gains) },
    verbs: {
      sentences: verbs.length,
      ok: verbs.reduce((n, v) => n + v.ok, 0),
      total: verbs.reduce((n, v) => n + v.total, 0),
      wrong: verbs.reduce((n, v) => n + v.wrong, 0),
    },
    choice: { sentences: choice.length, ok: choice.filter((c) => c.ok).length },
  };
}

/** 交给模型的材料：汇总数据 + 最近的批注问题 + 几句完整的例子（最近的几句和分最低的几句）+ 上次分析的要点 */
export function analysisInput(
  sentences: Sentence[],
  attempts: Attempt[],
  stats: LearningStats,
  previous: Analysis | null,
): AnalysisInput {
  const byId = new Map(sentences.map((s) => [s.id, s]));
  const all = chronological(attempts, (id) => byId.has(id));
  const newest = [...all].reverse();
  const focus = (a: Attempt) => byId.get(a.sentenceId)?.focus || '';
  const issues = newest
    .flatMap((a) => (a.feedback?.issues ?? []).map((it) => ({ ...it, focus: focus(a) })))
    .slice(0, MAX_ISSUES);
  const firsts = firstAttempts(all);
  const recent = firsts.slice(-RECENT_SAMPLES).reverse();
  const low = firsts
    .filter((a) => !recent.includes(a))
    .sort((a, b) => a.total - b.total)
    .slice(0, LOW_SAMPLES);
  const samples = [...recent, ...low].map((a) => {
    const s = byId.get(a.sentenceId);
    return { en: plainText(s?.segs ?? []), text: a.text, ref: s?.ref || '', total: a.total, focus: focus(a) };
  });
  const good = [...new Set(newest.flatMap((a) => a.feedback?.good ?? []))].slice(0, 10);
  return {
    stats,
    names: specKbNames(),
    issues,
    samples,
    good,
    previous: previous
      ? {
          day: shanghaiDate(new Date(previous.createdAt)),
          sentences: previous.stats.sentences,
          summary: previous.report.summary,
          habits: previous.report.habits.map((h) => h.name),
        }
      : null,
  };
}

/** 比较时不管空格：模型摘的片段有时多一个或少一个空格 */
const squash = (s: string) => s.replace(/\s+/g, '');

/**
 * 整理模型写的报告：字段截到合适的长度；习惯的例子必须能在这个账户的某次译文里找到，
 * 找到的记下是哪一句（页面上能点回去），找不到的丢掉。
 */
export function cleanReport(input: unknown, attempts: Attempt[]): LearningReport {
  const d = obj(input);
  const newest = [...attempts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const whose = (src: string) => newest.find((a) => squash(a.text).includes(squash(src)))?.sentenceId;
  const habits: Habit[] = arr(d?.habits)
    .map(obj)
    .map((h) => ({
      name: str(h?.name, 20),
      detail: str(h?.detail, 160),
      advice: str(h?.advice, 160),
      examples: arr(h?.examples)
        .map(obj)
        .flatMap((x) => {
          const src = str(x?.src, 120);
          const fix = str(x?.fix, 200);
          const sentenceId = src ? whose(src) : undefined;
          return sentenceId && fix ? [{ src, fix, sentenceId }] : [];
        })
        .slice(0, 2),
    }))
    .filter((h) => h.name && (h.detail || h.advice))
    .slice(0, 4);
  return {
    summary: str(d?.summary, 200),
    curve: str(d?.curve, 240),
    strengths: arr(d?.strengths)
      .map((x) => str(x, 100))
      .filter(Boolean)
      .slice(0, 3),
    habits,
    weak: arr(d?.weak)
      .map(obj)
      .map((w) => ({ name: str(w?.name, 30), detail: str(w?.detail, 160) }))
      .filter((w) => w.name)
      .slice(0, 3),
    plan: arr(d?.plan)
      .map((x) => str(x, 140))
      .filter(Boolean)
      .slice(0, 5),
  };
}

export interface AnalysisService {
  /** 这个账户最近的一次分析；还没分析过是 null */
  latest(account: Account): Promise<Analysis | null>;
  /** 现在分析一次：占一次今天的分析次数，调用一次主力模型，存下来返回 */
  run(account: Account): Promise<Analysis>;
}

export function createAnalysis({
  cfg,
  llmFor,
  log = console,
}: {
  cfg: Pick<AppConfig, 'llm' | 'limits'>;
  llmFor: (account: Account, use?: LlmUse) => Promise<Llm>;
  log?: Logger;
}): AnalysisService {
  const busy = new Set<string>(); // 正在分析的账户

  /** 回复不是 JSON 或缺内容时再试一次 */
  async function ask(L: Llm, prompt: string, attempts: Attempt[]) {
    let lastError: unknown;
    for (let i = 0; i < 2; i++) {
      try {
        const result = await L.chatJson({
          prompt,
          model: L.models().main,
          maxTokens: 3000,
          temperature: 0.4,
          timeoutMs: Math.max(cfg.llm.timeoutMs, 120_000),
        });
        const report = cleanReport(result.data, attempts);
        if (!report.summary || (!report.habits.length && !report.plan.length)) {
          throw new LlmError('invalid_json', 'AI 写的分析报告缺少内容');
        }
        return { report, result };
      } catch (e) {
        lastError = e;
        if (!(e instanceof LlmError) || e.code !== 'invalid_json') break;
      }
    }
    throw lastError;
  }

  async function run(account: Account): Promise<Analysis> {
    if (busy.has(account.id)) throw new HttpError(409, '正在分析，稍等一下');
    busy.add(account.id);
    try {
      const [sentences, records, attempts, previous] = await Promise.all([
        repo.listSentences(account.id),
        repo.listRecords(account.id),
        repo.listAttempts(account.id),
        repo.latestAnalysis(account.id),
      ]);
      const stats = learningStats(sentences, records, attempts);
      if (stats.sentences < MIN_SENTENCES) {
        throw new HttpError(400, `至少批改 ${MIN_SENTENCES} 句之后才能分析（现在批改过 ${stats.sentences} 句）`);
      }
      const prompt = analysisPrompt(analysisInput(sentences, attempts, stats, previous));
      const message = '今天的学习分析次数用完了（{n} 次），明天再来';
      return await withQuota({ account, field: 'analyses', limit: cfg.limits.analyze, message, log }, async () => {
        const L = metered(await llmFor(account, { kind: 'analyze' }), account.id, 'analyze', log);
        const { report, result } = await ask(L, prompt, attempts);
        return repo.insertAnalysis({ accountId: account.id, stats, report, model: result.model || null });
      });
    } catch (e) {
      throw toHttpError(e);
    } finally {
      busy.delete(account.id);
    }
  }

  return { latest: (account) => repo.latestAnalysis(account.id), run };
}
