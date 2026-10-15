// 页面上用的格式化：转义 HTML、日期时间、分数档位、token 数、打乱顺序
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** 拼进 HTML 的文字都要先转义 */
export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c] ?? c);

const pad = (n: number) => String(n).padStart(2, '0');

export const localDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 2026-10-14 → 10月14日 */
export function fmtDay(s: string | null | undefined): string {
  if (!s) return '';
  const [, m, d] = s.slice(0, 10).split('-');
  return `${Number(m)}月${Number(d)}日`;
}

/** ISO 时间 → 10/14 08:05（本机时区） */
export function fmtTime(iso: string | null | undefined): string {
  const d = new Date(iso ?? '');
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** token 数：8,512 / 1.23 万 / 45.6 万 / 1.2 亿（保留三位有效数字） */
export function fmtTokens(n: number | null | undefined): string {
  const v = Math.max(0, Math.round(n ?? 0));
  if (v < 10_000) return v.toLocaleString('en-US');
  const wan = Number((v / 10_000).toPrecision(3));
  if (wan < 10_000) return `${wan} 万`; // 99,999,999 四舍五入成 10000 万时改用“亿”
  return `${Number((v / 100_000_000).toPrecision(3))} 亿`;
}

/** ISO 时间 → 11月15日（本机时区）；不是今年的加上年份：2027年11月15日 */
export function fmtDate(iso: string | null | undefined): string {
  const d = new Date(iso ?? '');
  if (Number.isNaN(d.getTime())) return '';
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}年${md}`;
}

/** 离这个时间还有几天（不足一天算 1 天；已经过了是 0 或负数） */
export const daysUntil = (iso: string): number => Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);

export type Tone = 'good' | 'mid' | 'low';
export const scoreTone = (n: number): Tone => (n >= 85 ? 'good' : n >= 60 ? 'mid' : 'low');

/** 0..n-1 打乱顺序 */
export function shuffle(n: number): number[] {
  const a = [...Array(n).keys()];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j] as number, a[i] as number];
  }
  return a;
}
