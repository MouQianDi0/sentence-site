// 谓语标注：检查 *主句谓语* ^从句谓语^ 标得对不对，以及按新的标注重写 segs。
// 出题时先用这里的规则挡掉明显的错，再让 AI 复核一遍；做题时发现错了，也用这里按单词位置改。

// 这些词引导从句或本身就不是动词，被标成谓语的开头一定是标错了
const NOT_VERB_START = new Set([
  'that', 'which', 'who', 'whom', 'whose', 'what', 'whatever', 'whoever', 'whichever',
  'when', 'where', 'why', 'how', 'whether', 'if', 'because', 'although', 'though', 'while',
  'whereas', 'unless', 'until', 'since', 'as', 'once', 'before', 'after', 'so', 'than',
  'the', 'a', 'an', 'and', 'or', 'but',
]);
// 陷阱说明里出现这些说法，说明它讲的那个词不是谓语
// 本身以 -ing 结尾的动词原形
const ING_VERBS = new Set(['bring', 'cling', 'fling', 'sling', 'spring', 'sting', 'string', 'swing', 'wring', 'sing', 'ring', 'ping']);
const NOT_PRED_SAYS = /不是谓语|非谓语|作定语|作状语|作宾补|作宾语补足语|作主语|作表语|后置定语|动名词|不定式|引导词|连接词|关系代词|关系副词/;

const splitCore = (w) => {
  const m = /^([^A-Za-z0-9']*)(.*?)([^A-Za-z0-9']*)$/.exec(w) || ['', '', w, ''];
  return { lead: m[1], core: m[2] || w, trail: m[3] };
};
const norm = (w) => splitCore(w).core.toLowerCase().replace(/’/g, "'");

/** 整句拆成单词（去掉标记），每个词记住所在段、原样文字、属于哪种谓语（main / sub / null） */
export function wordsOf(segs) {
  const out = [];
  segs.forEach((g, si) => {
    // 和前端 text.js 的 toks() 拆法一致，保证两边的单词下标对得上
    const re = /(\*([^*]+)\*|\^([^^]+)\^)([,.;:!?]?)|(\S+)/g;
    let m;
    while ((m = re.exec(g.t))) {
      const kind = m[2] ? 'main' : m[3] ? 'sub' : null;
      const parts = (m[2] || m[3] || m[5]).trim().split(/\s+/).filter(Boolean);
      parts.forEach((raw, j) => {
        const last = j === parts.length - 1;
        // 紧贴在前一块后面、中间没有空格（如 ^was^." 里的 "），重写时也不加空格
        const glue = j === 0 && m.index > 0 && !/\s/.test(g.t[m.index - 1]);
        out.push({ si, raw: raw + (kind && last ? m[4] : ''), kind, start: kind && j === 0, end: kind && last, glue });
      });
    }
  });
  return out;
}

/** 当前标注的谓语：[{kind, a, b, text, si}]，a、b 是整句单词下标 */
export function extractMarks(segs) {
  const w = wordsOf(segs);
  const out = [];
  w.forEach((x, i) => {
    if (x.start) out.push({ kind: x.kind, a: i, b: i, si: x.si });
    else if (x.kind && out.length) out.at(-1).b = i;
  });
  return out.map((s) => ({ ...s, text: w.slice(s.a, s.b + 1).map((x) => splitCore(x.raw).core).join(' ') }));
}

/**
 * 按单词下标重新标注谓语，返回新的 segs（文字、成分、说明都不变）。
 * spans：[{kind:'main'|'sub', a, b}]，每段必须在同一个片段里、互不重叠。
 */
export function markByIndex(segs, spans) {
  const w = wordsOf(segs);
  const tag = new Array(w.length).fill(null);
  for (const s of spans) {
    const a = Number(s.a);
    const b = Number(s.b);
    if (!['main', 'sub'].includes(s.kind) || !Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < a || b >= w.length) {
      throw new Error('标注位置不对');
    }
    if (w[a].si !== w[b].si) throw new Error('一个谓语不能跨两个片段');
    for (let i = a; i <= b; i++) {
      if (tag[i]) throw new Error('标注重叠了');
      tag[i] = { kind: s.kind, start: i === a, end: i === b };
    }
  }
  return segs.map((g, si) => {
    let text = '';
    w.forEach((x, i) => {
      if (x.si !== si) return;
      const t = tag[i];
      let piece = x.raw;
      if (t) {
        const mk = t.kind === 'main' ? '*' : '^';
        const c = splitCore(x.raw);
        // 引号、括号这类前导符号放进标记里，后面的标点放在标记外
        piece = `${t.start ? mk : ''}${c.lead}${c.core}${t.end ? mk : ''}${c.trail}`;
      }
      text += (text && !x.glue ? ' ' : '') + piece;
    });
    return { ...g, t: text };
  });
}

/**
 * 把 AI 复核给出的谓语原文（main 一个，sub 若干）对到句子里的单词位置。
 * 同一个词出现多次时按顺序依次占用；对不上返回 null。
 */
export function locate(segs, main, subs) {
  const w = wordsOf(segs);
  const used = new Array(w.length).fill(false);
  const find = (phrase) => {
    const p = String(phrase || '').trim().split(/\s+/).map(norm).filter(Boolean);
    if (!p.length) return null;
    for (let i = 0; i + p.length <= w.length; i++) {
      let ok = true;
      for (let j = 0; j < p.length && ok; j++) {
        const x = w[i + j];
        ok = !used[i + j] && x.si === w[i].si && norm(x.raw) === p[j];
      }
      if (ok) {
        for (let j = 0; j < p.length; j++) used[i + j] = true;
        return { a: i, b: i + p.length - 1 };
      }
    }
    return null;
  };
  const m = find(main);
  if (!m) return null;
  const spans = [{ kind: 'main', ...m }];
  for (const s of subs || []) {
    const f = find(s);
    if (!f) return null;
    spans.push({ kind: 'sub', ...f });
  }
  return spans;
}

/** 规则检查：返回第一个问题的说明，没问题返回空字符串 */
export function predicateProblem(segs, trap = '') {
  const marks = extractMarks(segs);
  const clauses = String(trap || '').split(/[，。；;,.!?！？\n]/);
  for (const m of marks) {
    const words = m.text.toLowerCase().split(/\s+/);
    if (NOT_VERB_START.has(words[0])) return `“${m.text}”是引导词或不是动词，却标成了谓语`;
    if (words[0] === 'to') return `“${m.text}”是不定式，却标成了谓语`;
    if (words.length === 1 && /ing$/.test(words[0]) && words[0].length > 4 && !ING_VERBS.has(words[0])) return `“${m.text}”是 -ing 形式，单独不能作谓语`;
    if (segs[m.si]?.r === 'nonfin') return `“${m.text}”在非谓语短语里，却标成了谓语`;
    const re = new RegExp(`(^|[^A-Za-z])${m.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z]|$)`, 'i');
    if (clauses.some((c) => re.test(c) && NOT_PRED_SAYS.test(c))) return `陷阱说明里说“${m.text}”不是谓语，却又标成了谓语`;
  }
  return '';
}
