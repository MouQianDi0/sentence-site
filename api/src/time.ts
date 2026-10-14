// 北京时间（UTC+8，没有夏令时）。容器里没装时区数据，所以这里手动换算。
const OFFSET = 8 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, '0');

export interface ClockParts {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
  s: number;
}

export function shanghaiParts(d: Date = new Date()): ClockParts {
  const t = new Date(d.getTime() + OFFSET);
  return {
    y: t.getUTCFullYear(),
    m: t.getUTCMonth() + 1,
    d: t.getUTCDate(),
    h: t.getUTCHours(),
    min: t.getUTCMinutes(),
    s: t.getUTCSeconds(),
  };
}

/** YYYY-MM-DD */
export function shanghaiDate(d: Date = new Date()): string {
  const p = shanghaiParts(d);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** HHMMSS */
export function shanghaiClock(d: Date = new Date()): string {
  const p = shanghaiParts(d);
  return `${pad(p.h)}${pad(p.min)}${pad(p.s)}`;
}
