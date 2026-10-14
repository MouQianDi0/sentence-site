// 句子数据的校验与整理。导入旧数据用宽松模式，AI 新出的句子用严格模式。
import type { RecordPatch, RoleId, Seg, SentenceBody } from '@sentence-site/shared';
import { predicateProblem } from './predicates.ts';

export const ROLES: RoleId[] = ['main', 'attr', 'noun', 'adv', 'nonfin'];
export const KB_KEYS = [
  'main', 'it_formal', 'notbut', 'comparison',
  'attr_r', 'attr_n', 'attr_where', 'attr_omit',
  'noun_obj', 'noun_subj', 'noun_pred', 'noun_appos',
  'adv_concession', 'adv_time', 'adv_cond', 'adv_reason', 'adv_phrase',
  'nf_pp', 'nf_ing', 'nf_inf',
]; // prettier-ignore
const DEFAULT_K: Record<RoleId, string> = {
  main: 'main',
  attr: 'attr_r',
  noun: 'noun_obj',
  adv: 'adv_phrase',
  nonfin: 'nf_inf',
};

/** 模型或旧数据给的任意值 */
type Loose = Record<string, unknown> | null | undefined;
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
const S = (v: unknown, max = 2000) =>
  String(v ?? '')
    .trim()
    .slice(0, max);
const count = (s: string, ch: string) => s.split(ch).length - 1;
const isRole = (r: string): r is RoleId => (ROLES as string[]).includes(r);

/** 去掉 * 和 ^ 标记后的整句 */
export function plainText(segs: { t: string }[]): string {
  return segs
    .map((g) => g.t.replace(/[*^]/g, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type CheckResult = { ok: true; value: SentenceBody } | { ok: false; reason: string };

export function checkSentence(input: unknown, { strict = false } = {}): CheckResult {
  const o = obj(input);
  if (!o) return { ok: false, reason: '不是对象' };
  if (!Array.isArray(o.segs)) return { ok: false, reason: '缺少 segs' };

  const raw = (o.segs as unknown[])
    .map((x) => {
      const g = obj(x);
      return { r: S(g?.r, 10), t: S(g?.t, 400), n: S(g?.n, 120), k: S(g?.k, 30) };
    })
    .filter((g) => g.t);
  if (raw.length < (strict ? 2 : 1)) return { ok: false, reason: 'segs 太少' };
  const segs: Seg[] = [];
  for (const g of raw) {
    let r: RoleId;
    if (isRole(g.r)) r = g.r;
    else {
      if (strict) return { ok: false, reason: `未知成分 ${g.r}` };
      r = 'main';
    }
    const k = KB_KEYS.includes(g.k) ? g.k : DEFAULT_K[r];
    if (count(g.t, '*') % 2 || count(g.t, '^') % 2) return { ok: false, reason: `标记不成对：${g.t}` };
    segs.push({ r, t: g.t, n: g.n, k });
  }
  const mainMarks = segs.reduce((n, g) => n + (g.t.match(/\*[^*]+\*/g) || []).length, 0);
  if (mainMarks < 1) return { ok: false, reason: '没有标出主句谓语' };
  if (strict && mainMarks !== 1) return { ok: false, reason: '主句谓语标了不止一处' };
  if (strict) {
    const bad = predicateProblem(segs, String(o.trap || ''));
    if (bad) return { ok: false, reason: bad };
  }

  const opts = (Array.isArray(o.opts) ? (o.opts as unknown[]) : [])
    .map((v) => {
      const x = obj(v);
      return { t: S(x?.t, 400), ok: Boolean(x?.ok), why: S(x?.why, 120) };
    })
    .filter((x) => x.t)
    .slice(0, 4);
  const okCount = opts.filter((x) => x.ok).length;
  if (opts.length < 2 || okCount !== 1) return { ok: false, reason: '选项必须至少 2 个且恰好 1 个正确' };
  if (strict && opts.length !== 3) return { ok: false, reason: '选项必须是 3 个' };

  const plain = plainText(segs);
  if (strict) {
    const words = plain.split(' ').length;
    if (words < 15 || words > 60) return { ok: false, reason: `句子长度 ${words} 词，不在 15–60 之间` };
    if (!/[.!?]["']?$/.test(plain)) return { ok: false, reason: '句子没有以句号结尾' };
  }

  const list = (v: unknown): Loose[] => (Array.isArray(v) ? (v as unknown[]).map(obj) : []);
  const value: SentenceBody = {
    level: S(o.level, 10),
    focus: S(o.focus, 30),
    segs,
    trunk: S(o.trunk, 400),
    trunkZh: S(o.trunkZh, 400),
    trap: S(o.trap, 200),
    tip: S(o.tip, 300),
    ref: S(o.ref, 600) || opts.find((x) => x.ok)?.t || '',
    opts,
    words: list(o.words)
      .filter((w): w is Record<string, unknown> => Boolean(w && w.w))
      .slice(0, 10)
      .map((w) => ({ w: S(w.w, 40), lemma: S(w.lemma, 40), pos: S(w.pos, 10), zh: S(w.zh, 60) })),
    phrases: list(o.phrases)
      .filter((p): p is Record<string, unknown> => Boolean(p && (p.m || p.p)))
      .slice(0, 5)
      .map((p) => ({ m: S(p.m || p.p, 80), p: S(p.p || p.m, 80), zh: S(p.zh, 60) })),
  };
  return { ok: true, value };
}

// ---- 练习记录的请求体 ----------------------------------------------------
const isInt = (v: unknown, lo: number, hi: number): v is number =>
  Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

/** 把 PUT /api/records/:id 的请求体整理成要写入的字段；不合法时返回错误说明 */
export function checkRecordPatch(body: Record<string, unknown>): { error: string } | { fields: RecordPatch } {
  const out: RecordPatch = {};
  if ('done' in body) {
    if (typeof body.done !== 'boolean') return { error: 'done 必须是 true 或 false' };
    out.done = body.done;
  }
  if ('verbs' in body) {
    const v = obj(body.verbs);
    if (body.verbs !== null && !(v && isInt(v.ok, 0, 999) && isInt(v.total, 0, 999) && isInt(v.wrong, 0, 999))) {
      return { error: 'verbs 格式不对，应为 {ok,total,wrong}' };
    }
    out.verbs = v ? { ok: v.ok as number, total: v.total as number, wrong: v.wrong as number } : null;
  }
  if ('choice' in body) {
    const c = obj(body.choice);
    if (body.choice !== null && !(c && isInt(c.pick, 0, 9) && typeof c.ok === 'boolean')) {
      return { error: 'choice 格式不对，应为 {pick,ok}' };
    }
    out.choice = c ? { pick: c.pick as number, ok: c.ok as boolean } : null;
  }
  if ('draft' in body) {
    if (body.draft !== null && typeof body.draft !== 'string') return { error: 'draft 必须是文字' };
    if (typeof body.draft === 'string' && body.draft.length > 2000) return { error: '草稿太长（最多 2000 字）' };
    out.draft = body.draft;
  }
  if (!Object.keys(out).length) return { error: '没有要保存的内容' };
  return { fields: out };
}
