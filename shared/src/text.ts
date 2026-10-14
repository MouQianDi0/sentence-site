// 句子文本工具（前端页面和后端测试共用）：拆标记、拆单词、对主干、匹配固定搭配、中文差异对比。
// 拆单词的规则要和后端 api/src/predicates.ts 的 wordsOf() 一致，两边的单词下标才对得上。
import type { Phrase, Seg } from './types.ts';

/** 一个词块：谓语短语（如 was published）整体算一块 */
export interface Tok {
  /** 文字（不含标记） */
  t: string;
  /** 紧跟在谓语标记后面的标点 */
  p: string;
  /** main = 主句谓语，sub = 从句谓语，null = 不是谓语 */
  k: 'main' | 'sub' | null;
}

/** 整句里的一个单词 */
export interface FlatWord {
  /** 单词前面的符号（引号、括号） */
  lead: string;
  /** 单词本身 */
  core: string;
  /** 单词后面的标点 */
  trail: string;
  /** 小写、统一撇号后的单词，用来比较 */
  norm: string;
  /** 第几段 */
  si: number;
  /** 第几个词块（圈谓语时点选的单位） */
  ti: number;
  k: Tok['k'];
}

/** 只需要句子的这几个字段 */
type HasSegs = { segs: Pick<Seg, 't'>[] };

/** 把一段带 *主句谓语* ^从句谓语^ 标记的文字拆成词块 */
export function toks(text: string): Tok[] {
  const out: Tok[] = [];
  const re = /(\*([^*]+)\*|\^([^^]+)\^)([,.;:!?]?)|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[2]) out.push({ t: m[2].trim(), p: m[4] ?? '', k: 'main' });
    else if (m[3]) out.push({ t: m[3].trim(), p: m[4] ?? '', k: 'sub' });
    else out.push({ t: m[5] ?? '', p: '', k: null });
  }
  return out;
}

/** 去掉标记后的整句 */
export const plain = (s: HasSegs): string =>
  s.segs
    .map((g) => g.t.replace(/[*^]/g, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

function splitCore(w: string): { lead: string; core: string; trail: string } {
  const m = /^([^A-Za-z0-9']*)(.*?)([^A-Za-z0-9']*)$/.exec(w);
  if (!m) return { lead: '', core: w, trail: '' };
  return { lead: m[1] ?? '', core: m[2] || w, trail: m[3] ?? '' };
}

/** 整句拆成单词，每个单词记住它属于哪一段、是不是谓语 */
export function flat(s: HasSegs): FlatWord[] {
  const out: FlatWord[] = [];
  let ti = -1; // 第几个词块（圈谓语时整体点选的单位，如 was published），和第 1 步的点选编号一致
  s.segs.forEach((g, si) =>
    toks(g.t).forEach((t) => {
      ti++;
      const parts = t.t.split(/\s+/);
      parts.forEach((w, j) => {
        const c = splitCore(w);
        out.push({
          lead: c.lead,
          core: c.core,
          trail: c.trail + (j === parts.length - 1 ? t.p : ''),
          norm: c.core.toLowerCase().replace(/’/g, "'"),
          si,
          ti,
          k: t.k,
        });
      });
    }),
  );
  return out;
}

/**
 * 主干在原句里的位置：把 trunk 的单词按顺序对到整句单词上（只能删词，不能改词），
 * 有多种对法时选连成段数最少的。返回整句单词下标的 Set；对不上返回 null。
 */
export function trunkWords(s: HasSegs & { trunk?: string | null }, fw: FlatWord[] = flat(s)): Set<number> | null {
  const norm = (w: string) =>
    w
      .toLowerCase()
      .replace(/’/g, "'")
      .replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '');
  const T = String(s.trunk || '')
    .split(/\s+/)
    .map(norm)
    .filter(Boolean);
  const W = fw.map((x) => x.norm);
  const n = W.length;
  const m = T.length;
  if (!m || m > n) return null;
  const INF = 1e9;
  // cost[j][i]：trunk 第 j 个词对到原句第 i 个词时，最少连成几段；from 记住上一个词对到哪里
  const cost: number[][] = T.map(() => new Array<number>(n).fill(INF));
  const from: number[][] = T.map(() => new Array<number>(n).fill(-1));
  for (let i = 0; i < n; i++) if (W[i] === T[0]) cost[0][i] = 1;
  for (let j = 1; j < m; j++) {
    const prev = cost[j - 1];
    const row = cost[j];
    for (let i = j; i < n; i++) {
      if (W[i] !== T[j]) continue;
      for (let k = j - 1; k < i; k++) {
        if (prev[k] >= INF) continue;
        const c = prev[k] + (k === i - 1 ? 0 : 1);
        if (c < row[i]) {
          row[i] = c;
          from[j][i] = k;
        }
      }
    }
  }
  const last = cost[m - 1];
  let end = -1;
  for (let i = 0; i < n; i++) if (last[i] < INF && (end < 0 || last[i] < last[end])) end = i;
  if (end < 0) return null;
  const out = new Set<number>();
  for (let j = m - 1, i = end; j >= 0; i = from[j][i], j--) out.add(i);
  return out;
}

/** 每个单词属于第几个固定搭配（没有就是 null） */
export function phraseMap(s: { phrases?: Phrase[] | null }, fw: FlatWord[]): (number | null)[] {
  const map = new Array<number | null>(fw.length).fill(null);
  (s.phrases || []).forEach((ph, pi) => {
    const m = String(ph.m || ph.p || '')
      .toLowerCase()
      .split(/\s+/)
      .map((x) => x.replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, ''))
      .filter(Boolean);
    if (!m.length) return;
    for (let i = 0; i + m.length <= fw.length; i++) {
      if (m.every((x, j) => fw[i + j].norm === x)) {
        for (let j = 0; j < m.length; j++) if (map[i + j] == null) map[i + j] = pi;
        break;
      }
    }
  });
  return map;
}

/** 差异对比的一块：= 相同，- 删掉，+ 新增 */
export interface DiffPart {
  t: '=' | '-' | '+';
  s: string;
}

/** 按字符的最长公共子序列做差异对比 */
export function diff(a: string, b: string): DiffPart[] {
  const n = a.length;
  const m = b.length;
  if (!n) return [{ t: '+', s: b }];
  if (n * m > 60000) return [{ t: '=', s: b }];
  const dp: Uint16Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffPart[] = [];
  const push = (t: DiffPart['t'], c: string) => {
    const l = out[out.length - 1];
    if (l && l.t === t) l.s += c;
    else out.push({ t, s: c });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('=', a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) push('-', a[i++]);
    else push('+', b[j++]);
  }
  while (i < n) push('-', a[i++]);
  while (j < m) push('+', b[j++]);
  return out;
}
