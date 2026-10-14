// 页面上用的格式化：转义 HTML、日期时间、分数档位、打乱顺序
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
