// 北京时间（UTC+8，没有夏令时）。容器里没装时区数据，所以这里手动换算。
const OFFSET = 8 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, '0');

export function shanghaiParts(d = new Date()) {
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
export function shanghaiDate(d = new Date()) {
  const p = shanghaiParts(d);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** HHMMSS */
export function shanghaiClock(d = new Date()) {
  const p = shanghaiParts(d);
  return `${pad(p.h)}${pad(p.min)}${pad(p.s)}`;
}
