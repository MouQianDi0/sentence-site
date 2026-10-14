// 文本工具：拆标记、拆单词、匹配固定搭配、中文差异对比、格式化
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** 把一段带 *主句谓语* ^从句谓语^ 标记的文字拆成词块 */
export function toks(text) {
  const out = [];
  const re = /(\*([^*]+)\*|\^([^^]+)\^)([,.;:!?]?)|(\S+)/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[2]) out.push({ t: m[2].trim(), p: m[4], k: 'main' });
    else if (m[3]) out.push({ t: m[3].trim(), p: m[4], k: 'sub' });
    else out.push({ t: m[5], p: '', k: null });
  }
  return out;
}

export const plain = (s) => s.segs.map((g) => g.t.replace(/[*^]/g, '')).join(' ').replace(/\s+/g, ' ').trim();

function splitCore(w) {
  const m = /^([^A-Za-z0-9']*)(.*?)([^A-Za-z0-9']*)$/.exec(w) || ['', '', w, ''];
  return { lead: m[1], core: m[2] || w, trail: m[3] };
}

/** 整句拆成单词，每个单词记住它属于哪一段、是不是谓语 */
export function flat(s) {
  const out = [];
  s.segs.forEach((g, si) =>
    toks(g.t).forEach((t) => {
      const parts = t.t.split(/\s+/);
      parts.forEach((w, j) => {
        const c = splitCore(w);
        out.push({
          lead: c.lead,
          core: c.core,
          trail: c.trail + (j === parts.length - 1 ? t.p : ''),
          norm: c.core.toLowerCase().replace(/’/g, "'"),
          si,
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
export function trunkWords(s, fw = flat(s)) {
  const norm = (w) => w.toLowerCase().replace(/’/g, "'").replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '');
  const T = String(s.trunk || '').split(/\s+/).map(norm).filter(Boolean);
  const W = fw.map((x) => x.norm);
  const n = W.length;
  const m = T.length;
  if (!m || m > n) return null;
  const INF = 1e9;
  // cost[j][i]：trunk 第 j 个词对到原句第 i 个词时，最少连成几段；from 记住上一个词对到哪里
  const cost = T.map(() => new Array(n).fill(INF));
  const from = T.map(() => new Array(n).fill(-1));
  for (let i = 0; i < n; i++) if (W[i] === T[0]) cost[0][i] = 1;
  for (let j = 1; j < m; j++) {
    for (let i = j; i < n; i++) {
      if (W[i] !== T[j]) continue;
      for (let k = j - 1; k < i; k++) {
        if (cost[j - 1][k] >= INF) continue;
        const c = cost[j - 1][k] + (k === i - 1 ? 0 : 1);
        if (c < cost[j][i]) {
          cost[j][i] = c;
          from[j][i] = k;
        }
      }
    }
  }
  let end = -1;
  for (let i = 0; i < n; i++) if (cost[m - 1][i] < INF && (end < 0 || cost[m - 1][i] < cost[m - 1][end])) end = i;
  if (end < 0) return null;
  const out = new Set();
  for (let j = m - 1, i = end; j >= 0; i = from[j][i], j--) out.add(i);
  return out;
}

/** 每个单词属于第几个固定搭配（没有就是 null） */
export function phraseMap(s, fw) {
  const map = new Array(fw.length).fill(null);
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

/** 按字符的最长公共子序列做差异对比 */
export function diff(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n) return [{ t: '+', s: b }];
  if (n * m > 60000) return [{ t: '=', s: b }];
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  const push = (t, c) => {
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

const pad = (n) => String(n).padStart(2, '0');
export const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function fmtDay(s) {
  if (!s) return '';
  const [, m, d] = s.slice(0, 10).split('-');
  return `${Number(m)}月${Number(d)}日`;
}
export function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const scoreTone = (n) => (n >= 85 ? 'good' : n >= 60 ? 'mid' : 'low');
export function shuffle(n) {
  const a = [...Array(n).keys()];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
