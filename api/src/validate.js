// 句子数据的校验与整理。导入旧数据用宽松模式，AI 新出的句子用严格模式。
export const ROLES = ['main', 'attr', 'noun', 'adv', 'nonfin'];
export const KB_KEYS = [
  'main', 'it_formal', 'notbut', 'comparison',
  'attr_r', 'attr_n', 'attr_where', 'attr_omit',
  'noun_obj', 'noun_subj', 'noun_pred', 'noun_appos',
  'adv_concession', 'adv_time', 'adv_cond', 'adv_reason', 'adv_phrase',
  'nf_pp', 'nf_ing', 'nf_inf',
];
const DEFAULT_K = { main: 'main', attr: 'attr_r', noun: 'noun_obj', adv: 'adv_phrase', nonfin: 'nf_inf' };

const S = (v, max = 2000) => String(v ?? '').trim().slice(0, max);
const count = (s, ch) => s.split(ch).length - 1;

/** 去掉 * 和 ^ 标记后的整句 */
export function plainText(segs) {
  return segs.map((g) => g.t.replace(/[*^]/g, '')).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * @returns {{ok: true, value: object} | {ok: false, reason: string}}
 */
export function checkSentence(o, { strict = false } = {}) {
  if (!o || typeof o !== 'object') return { ok: false, reason: '不是对象' };
  if (!Array.isArray(o.segs)) return { ok: false, reason: '缺少 segs' };

  const segs = o.segs
    .map((g) => ({ r: S(g?.r, 10), t: S(g?.t, 400), n: S(g?.n, 120), k: S(g?.k, 30) }))
    .filter((g) => g.t);
  if (segs.length < (strict ? 2 : 1)) return { ok: false, reason: 'segs 太少' };
  for (const g of segs) {
    if (!ROLES.includes(g.r)) {
      if (strict) return { ok: false, reason: `未知成分 ${g.r}` };
      g.r = 'main';
    }
    if (!KB_KEYS.includes(g.k)) g.k = DEFAULT_K[g.r];
    if (count(g.t, '*') % 2 || count(g.t, '^') % 2) return { ok: false, reason: `标记不成对：${g.t}` };
  }
  const mainMarks = segs.reduce((n, g) => n + (g.t.match(/\*[^*]+\*/g) || []).length, 0);
  if (mainMarks < 1) return { ok: false, reason: '没有标出主句谓语' };
  if (strict && mainMarks !== 1) return { ok: false, reason: '主句谓语标了不止一处' };

  const opts = (Array.isArray(o.opts) ? o.opts : [])
    .map((x) => ({ t: S(x?.t, 400), ok: Boolean(x?.ok), why: S(x?.why, 120) }))
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

  const value = {
    level: S(o.level, 10),
    focus: S(o.focus, 30),
    segs,
    trunk: S(o.trunk, 400),
    trunkZh: S(o.trunkZh, 400),
    trap: S(o.trap, 200),
    tip: S(o.tip, 300),
    ref: S(o.ref, 600) || opts.find((x) => x.ok).t,
    opts,
    words: (Array.isArray(o.words) ? o.words : [])
      .filter((w) => w && w.w)
      .slice(0, 10)
      .map((w) => ({ w: S(w.w, 40), lemma: S(w.lemma, 40), pos: S(w.pos, 10), zh: S(w.zh, 60) })),
    phrases: (Array.isArray(o.phrases) ? o.phrases : [])
      .filter((p) => p && (p.m || p.p))
      .slice(0, 5)
      .map((p) => ({ m: S(p.m || p.p, 80), p: S(p.p || p.m, 80), zh: S(p.zh, 60) })),
  };
  return { ok: true, value };
}

// ---- 练习记录的请求体 ----------------------------------------------------
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/** 把 PUT /api/records/:id 的请求体整理成要写入的字段；不合法时返回错误说明 */
export function checkRecordPatch(body) {
  const out = {};
  if ('done' in body) {
    if (typeof body.done !== 'boolean') return { error: 'done 必须是 true 或 false' };
    out.done = body.done;
  }
  if ('verbs' in body) {
    const v = body.verbs;
    if (v !== null && !(v && isInt(v.ok, 0, 999) && isInt(v.total, 0, 999) && isInt(v.wrong, 0, 999))) {
      return { error: 'verbs 格式不对，应为 {ok,total,wrong}' };
    }
    out.verbs = v;
  }
  if ('choice' in body) {
    const c = body.choice;
    if (c !== null && !(c && isInt(c.pick, 0, 9) && typeof c.ok === 'boolean')) {
      return { error: 'choice 格式不对，应为 {pick,ok}' };
    }
    out.choice = c;
  }
  if ('draft' in body) {
    if (body.draft !== null && typeof body.draft !== 'string') return { error: 'draft 必须是文字' };
    if (typeof body.draft === 'string' && body.draft.length > 2000) return { error: '草稿太长（最多 2000 字）' };
    out.draft = body.draft;
  }
  if (!Object.keys(out).length) return { error: '没有要保存的内容' };
  return { fields: out };
}
