// “设置 → Token 用量”：这个账户调用模型用掉了多少 token。每个账户都能看，只看得到自己的。
// 上面四格是今天 / 近 7 天 / 近 30 天 / 累计；下面按选的范围（7、30、90 天）画用量柱状图，再按用途、按模型分开。
// 从设置主页的“Token 用量”点进来，地址是 /settings/usage，手机的返回手势能回到设置主页。
import type { TokenCount, TokenKind, TokenStats } from '@sentence-site/shared';
import { api } from '../lib/api.ts';
import { closest } from '../lib/dom.ts';
import { esc, fmtDay, fmtTokens } from '../lib/format.ts';
import * as A from '../lib/anim.ts';
import type { Toast } from '../lib/toast.ts';

const C = {
  card: 'rounded-2xl border border-line bg-sheet',
  label: 'font-mono text-[11px] tracking-[.1em] uppercase text-muted',
  btn: 'cursor-pointer rounded-full border-[1.5px] border-line bg-sheet px-3 py-1.5 text-[13.5px] transition-transform active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-45',
  spin: 'inline-block h-4 w-4 flex-none animate-spin rounded-full border-2 border-line border-t-accent',
};

const ICON = {
  back: '<svg class="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.5L5.5 8l4.5 4.5"/></svg>',
  next: '<svg class="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5"/></svg>',
  chart:
    '<svg class="h-[18px] w-[18px]" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3.5 16.5h13"/><path d="M6 13.5V9"/><path d="M10 13.5V5"/><path d="M14 13.5v-3"/></svg>',
};

export const KIND_NAMES: Record<TokenKind, string> = {
  grade: '批改',
  lookup: '查词',
  generate: '出题',
  review: '复核谓语',
  test: '测试连接',
};

const RANGES = [7, 30, 90];
const size = (c: TokenCount) => c.input + c.output;

/** 纵轴刻度：0 加上 1–3 个整齐的数，最上面那个不小于最大值 */
function ticks(max: number): number[] {
  if (max <= 0) return [0];
  const raw = max / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const out = [0];
  while ((out.at(-1) ?? 0) < max) out.push(out.length * step);
  return out;
}

/** 图上的一根柱子：一天，或者（90 天时）一周 */
interface Bar extends TokenCount {
  from: string;
  to: string;
}

/** 90 天的柱子太细，按周合并（从今天往前每 7 天一根） */
function barsOf(d: TokenStats): { bars: Bar[]; weekly: boolean } {
  const days = d.daily.map((x) => ({ ...x, from: x.day, to: x.day }));
  if (d.days <= 30) return { bars: days, weekly: false };
  const bars: Bar[] = [];
  for (let end = days.length; end > 0; end -= 7) {
    const chunk = days.slice(Math.max(0, end - 7), end);
    bars.unshift({
      from: chunk[0]?.day ?? '',
      to: chunk.at(-1)?.day ?? '',
      input: chunk.reduce((n, x) => n + x.input, 0),
      output: chunk.reduce((n, x) => n + x.output, 0),
      calls: chunk.reduce((n, x) => n + x.calls, 0),
    });
  }
  return { bars, weekly: true };
}

/** 大一点的数字：数字用等宽字体，“万 / 亿”用小一号的正文字体，不会隔得太开 */
function numHTML(n: number, cls: string): string {
  const [num = '', unit = ''] = fmtTokens(n).split(' ');
  return `<b class="font-mono font-medium ${cls}">${esc(num)}</b>${unit ? `<span class="ml-0.5 text-[0.62em] font-normal">${esc(unit)}</span>` : ''}`;
}

/** 占比：不到 1% 但不是 0 的写成 <1% */
const pctText = (part: number, all: number) => {
  const p = (part / all) * 100;
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`;
};

const span = (b: Bar) => (b.from === b.to ? fmtDay(b.from) : `${fmtDay(b.from)} – ${fmtDay(b.to)}`);

/**
 * root：用量页的容器。onBack：点“← 设置”。boost()：现在开没开“准确度提升”（开着时提示批改用量会多）。
 * 数据由设置页统一读取（load），读好之前不显示。
 */
export function createUsage({
  root,
  toast,
  onBack,
  boost = () => false,
}: {
  root: HTMLElement;
  toast?: Toast;
  onBack?: () => void;
  boost?: () => boolean;
}) {
  let data: TokenStats | null = null;
  let err = '';
  let days = 30;
  let busy = false; // 换范围后正在读
  let active = -1; // 鼠标指着（或手指点了）的那根柱子

  /** 读取用量；返回数据有没有变化 */
  async function load(): Promise<boolean> {
    try {
      const next = await api.tokenStats(days);
      const changed = !data || JSON.stringify(next) !== JSON.stringify(data);
      data = next;
      err = '';
      return changed;
    } catch (e) {
      if (data) return false; // 有上次读到的数据就继续显示它
      const msg = (e as Error).message;
      const changed = err !== msg;
      err = msg;
      return changed;
    }
  }

  /** 设置主页入口上显示的摘要 */
  function summary(): { today: number; last7: number } | null {
    return data ? { today: size(data.today), last7: size(data.last7) } : null;
  }

  function headerHTML(): string {
    return `<header class="flex items-center gap-2.5">
      <button type="button" data-act="back" class="inline-flex flex-none cursor-pointer items-center gap-1 rounded-full border-[1.5px] border-line bg-sheet py-1.5 pr-3.5 pl-2.5 text-[13.5px] transition-transform active:scale-[.97]">${ICON.back}设置</button>
      <h2 class="m-0 min-w-0 truncate font-head text-[20px] font-bold leading-tight">Token 用量</h2>
    </header>`;
  }

  function tileHTML(label: string, c: TokenCount): string {
    return `<div class="flex min-w-0 flex-col gap-1 ${C.card} px-3.5 py-3">
      <span class="text-[12.5px] text-muted">${label}</span>
      <span class="text-[22px] leading-tight">${numHTML(size(c), '')}</span>
      <span class="flex flex-wrap gap-x-2 text-[11.5px] text-muted"><span>输入 ${esc(fmtTokens(c.input))}</span><span>输出 ${esc(fmtTokens(c.output))}</span></span>
      <span class="text-[11.5px] text-muted">调用 ${c.calls} 次</span>
    </div>`;
  }

  function rangeHTML(): string {
    return `<div class="flex flex-wrap items-center gap-2.5">
      <div role="group" aria-label="统计范围" class="inline-flex rounded-full border-[1.5px] border-line bg-sheet p-0.5">${RANGES.map(
        (n) =>
          `<button type="button" data-days="${n}" aria-pressed="${n === days}" class="cursor-pointer rounded-full px-3.5 py-1 text-[13.5px] transition-colors aria-pressed:bg-accent aria-pressed:font-semibold aria-pressed:text-on-accent">${n} 天</button>`,
      ).join('')}</div>
      ${busy ? `<span class="${C.spin}" role="status" aria-label="正在读取"></span>` : ''}
    </div>`;
  }

  function chartHTML(d: TokenStats): string {
    const { bars, weekly } = barsOf(d);
    const max = Math.max(0, ...bars.map(size));
    const used = size(
      bars.reduce((a, b) => ({ input: a.input + b.input, output: a.output + b.output, calls: 0 }), {
        input: 0,
        output: 0,
        calls: 0,
      }),
    );
    const title = `${weekly ? '每周' : '每天'}用量 · 近 ${d.days} 天`;
    if (!max) {
      return `<section class="${C.card} flex flex-col gap-2 px-4 pt-3.5 pb-4" aria-label="${title}">
        <span class="${C.label}">${title}</span>
        <p class="m-0 py-6 text-center text-[14px] text-muted">这段时间没有调用过模型。</p></section>`;
    }
    const t = ticks(max);
    const top = t.at(-1) || 1;
    const grid = t
      .map(
        (v) =>
          `<div class="absolute right-0 left-0 border-t border-line" style="bottom:${((v / top) * 100).toFixed(2)}%"><span class="absolute right-full mr-2 -translate-y-1/2 font-mono text-[10.5px] leading-none whitespace-nowrap text-muted tabular-nums">${esc(fmtTokens(v))}</span></div>`,
      )
      .join('');
    const cols = bars
      .map((b, i) => {
        const v = size(b);
        const pct = (v / top) * 100;
        const bar = v
          ? `<span class="block w-full max-w-6 rounded-t-[4px] bg-accent" style="height:max(2px, ${pct.toFixed(2)}%)"></span>`
          : '';
        return `<div data-i="${i}" class="flex h-full min-w-0 flex-1 items-end justify-center ${i === active ? 'bg-raise' : ''}">${bar}</div>`;
      })
      .join('');
    return `<section class="${C.card} flex flex-col gap-3 px-4 pt-3.5 pb-3" aria-label="${title}">
      <div class="flex items-baseline gap-2"><span class="${C.label}">${title}</span><span class="ml-auto text-[12.5px] text-muted">合计 ${esc(fmtTokens(used))}</span></div>
      <div data-chart class="relative mt-1 ml-12 h-[160px] ${busy ? 'opacity-50' : ''}" role="img" aria-label="${title}，最多的一${weekly ? '周' : '天'} ${esc(fmtTokens(max))} token。下面可以展开按天的表格。">
        ${grid}
        <div data-cols class="absolute inset-0 flex items-end gap-[2px]">${cols}</div>
        <div data-tip class="pointer-events-none absolute top-0 z-10 hidden min-w-[9.5em] flex-col gap-0.5 rounded-xl border border-line bg-sheet px-3 py-2 text-[12px] shadow-lg"></div>
      </div>
      <div class="ml-12 flex justify-between font-mono text-[10.5px] text-muted"><span>${esc(fmtDay(bars[0]?.from))}</span><span>${weekly ? '本周' : '今天'}</span></div>
      <span class="text-[12px] text-muted">指着${weekly ? '某一周' : '某一天'}（手机上点一下）可以看具体数字。</span>
    </section>`;
  }

  /** 按天的表格（只列用过的日子，新的在前）：看图不方便时用 */
  function tableHTML(d: TokenStats): string {
    const rows = d.daily.filter((x) => x.calls > 0).reverse();
    if (!rows.length) return '';
    const td = 'px-2 py-1.5 text-right font-mono tabular-nums';
    return `<details class="group ${C.card} px-4 py-3">
      <summary class="flex cursor-pointer list-none items-center gap-2 text-[14px] font-semibold [&::-webkit-details-marker]:hidden">按天看数字
        <span class="ml-auto text-muted transition-transform group-open:rotate-90">${ICON.next}</span></summary>
      <div class="mt-2.5 overflow-x-auto"><table class="w-full border-collapse text-[13px]">
        <thead><tr class="border-b border-line text-[12px] text-muted"><th class="px-2 py-1.5 text-left font-normal">日期</th><th class="px-2 py-1.5 text-right font-normal">输入</th><th class="px-2 py-1.5 text-right font-normal">输出</th><th class="px-2 py-1.5 text-right font-normal">合计</th><th class="px-2 py-1.5 text-right font-normal">调用</th></tr></thead>
        <tbody>${rows
          .map(
            (x) =>
              `<tr class="border-b border-line last:border-0"><td class="px-2 py-1.5 whitespace-nowrap">${esc(fmtDay(x.day))}</td><td class="${td}">${x.input.toLocaleString('en-US')}</td><td class="${td}">${x.output.toLocaleString('en-US')}</td><td class="${td} font-semibold">${size(x).toLocaleString('en-US')}</td><td class="${td}">${x.calls}</td></tr>`,
          )
          .join('')}</tbody>
      </table></div>
    </details>`;
  }

  /** 按用途 / 按模型：每行一个名字、用量、占比，下面一条长度按最多的那个算的横条 */
  function breakdownHTML(title: string, items: { name: string; c: TokenCount }[], note = ''): string {
    if (!items.length) return '';
    const all = items.reduce((n, x) => n + size(x.c), 0) || 1;
    const top = Math.max(...items.map((x) => size(x.c))) || 1;
    return `<section class="${C.card} flex flex-col gap-3 px-4 pt-3.5 pb-4" aria-label="${title}">
      <span class="${C.label}">${title}</span>
      <ul class="m-0 flex list-none flex-col gap-3 p-0">${items
        .map(({ name, c }) => {
          const v = size(c);
          return `<li class="flex flex-col gap-1.5">
            <div class="flex min-w-0 items-baseline gap-2 text-[14px]">
              <span class="min-w-0 truncate">${esc(name)}</span><span class="flex-none text-[12px] text-muted">${c.calls} 次</span>
              <span class="ml-auto flex-none text-[14px]">${numHTML(v, 'tabular-nums')}</span>
              <span class="w-[3.4em] flex-none text-right font-mono text-[12px] text-muted tabular-nums">${esc(pctText(v, all))}</span>
            </div>
            <span class="h-1.5 overflow-hidden rounded-full bg-line"><i class="block h-full rounded-full bg-accent" style="width:${((v / top) * 100).toFixed(1)}%"></i></span>
          </li>`;
        })
        .join('')}</ul>
      ${note ? `<span class="text-[12.5px] text-muted">${note}</span>` : ''}
    </section>`;
  }

  function bodyHTML(d: TokenStats): string {
    const kinds = d.byKind.map((k) => ({ name: KIND_NAMES[k.kind] ?? k.kind, c: k }));
    const models = d.byModel.map((m) => ({ name: m.model, c: m }));
    const boostNote =
      boost() && d.byKind.some((k) => k.kind === 'grade')
        ? '“准确度提升”开着：每次批改要调用 6 次模型，批改的用量约是关着时的 6 倍。'
        : '';
    return `<div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
        ${tileHTML('今天', d.today)}${tileHTML('近 7 天', d.last7)}${tileHTML('近 30 天', d.last30)}${tileHTML('累计', d.total)}
      </div>
      ${rangeHTML()}
      ${chartHTML(d)}
      ${breakdownHTML(`按用途 · 近 ${d.days} 天`, kinds, boostNote)}
      ${breakdownHTML(`按模型 · 近 ${d.days} 天`, models)}
      ${tableHTML(d)}
      <p class="m-0 text-[12.5px] leading-[1.7] text-muted">统计的是这个账户调用模型用掉的 token（输入 + 输出），数字来自模型平台返回的用量，和平台账单可能略有出入。查词、出题、复核谓语和测试连接从这次网站更新后才开始记录，更早的只有批改的用量。${d.since ? `最早的记录在 ${esc(fmtDay(d.since))}。` : ''}</p>`;
  }

  function render(enter = false): void {
    if (err && !data) {
      root.innerHTML = `${headerHTML()}<div class="flex flex-col items-start gap-2 rounded-xl bg-bad-soft px-3.5 py-3 text-[14px]">读取用量失败：${esc(err)}
        <button type="button" data-act="retry" class="${C.btn}">重试</button></div>`;
    } else if (!data) {
      root.innerHTML = `${headerHTML()}<div class="flex items-center gap-2 text-[14px] text-muted"><span class="${C.spin}"></span>正在读取用量…</div>`;
    } else {
      root.innerHTML = `${headerHTML()}${bodyHTML(data)}`;
    }
    if (enter) A.enter(root.children);
  }

  /** 显示某根柱子的数字；i < 0 时收起 */
  function showTip(i: number): void {
    active = i;
    const chart = root.querySelector<HTMLElement>('[data-chart]');
    const tip = chart?.querySelector<HTMLElement>('[data-tip]');
    const cols = chart?.querySelectorAll<HTMLElement>('[data-i]');
    if (!chart || !tip || !cols || !data) return;
    cols.forEach((c, k) => c.classList.toggle('bg-raise', k === i));
    const b = barsOf(data).bars[i];
    const col = cols[i];
    if (!b || !col) {
      tip.classList.add('hidden');
      tip.classList.remove('flex');
      return;
    }
    tip.innerHTML = `<span class="text-muted">${esc(span(b))}</span>
      <span class="text-[15px]">${numHTML(size(b), '')} <span class="text-[12px] text-muted">token</span></span>
      <span>输入 <b class="font-mono font-medium">${b.input.toLocaleString('en-US')}</b></span>
      <span>输出 <b class="font-mono font-medium">${b.output.toLocaleString('en-US')}</b></span>
      <span class="text-muted">调用 ${b.calls} 次</span>`;
    tip.classList.remove('hidden');
    tip.classList.add('flex');
    // 放在柱子旁边（右半边的柱子放左边，左半边的放右边），不挡住这根柱子，也不跑出卡片
    const box = chart.getBoundingClientRect();
    const c = col.getBoundingClientRect();
    const right = c.left + c.width / 2 - box.left > box.width / 2;
    const x = right ? c.left - box.left - 6 - tip.offsetWidth : c.right - box.left + 6;
    tip.style.left = `${Math.max(-44, Math.min(x, box.width - tip.offsetWidth))}px`;
  }

  async function setDays(n: number): Promise<void> {
    if (n === days || busy) return;
    days = n;
    busy = true;
    active = -1;
    render();
    try {
      data = await api.tokenStats(days);
    } catch (e) {
      toast?.(`读取用量失败：${(e as Error).message}`);
    } finally {
      busy = false;
      render();
    }
  }

  root.addEventListener('click', async (e) => {
    const a = closest<HTMLButtonElement>(e, '[data-act]');
    if (a?.dataset.act === 'back') {
      onBack?.();
      return;
    }
    if (a?.dataset.act === 'retry') {
      err = '';
      render();
      await load();
      render(true);
      return;
    }
    const r = closest<HTMLButtonElement>(e, '[data-days]');
    if (r) void setDays(Number(r.dataset.days));
  });

  // 鼠标指着、或者手指点一下柱子时显示数字；鼠标移开就收起（手指点的留着，点别处再换）
  root.addEventListener('pointerover', (e) => {
    const col = closest(e, '[data-i]');
    if (col && e.pointerType === 'mouse') showTip(Number(col.dataset.i));
  });
  root.addEventListener('pointerdown', (e) => {
    const col = closest(e, '[data-i]');
    if (col) showTip(Number(col.dataset.i));
  });
  root.addEventListener('pointerout', (e) => {
    const cols = root.querySelector('[data-cols]');
    if (e.pointerType === 'mouse' && cols && !cols.contains(e.relatedTarget as Node | null)) showTip(-1);
  });

  /** 离开页面时调用 */
  function reset(): void {
    active = -1;
  }

  return { load, render, reset, summary, hasData: () => Boolean(data) };
}

/** “设置”主页上的入口：今天和近 7 天的用量，点进去看详细 */
export function usageEntryHTML(sum: { today: number; last7: number } | null): string {
  const sub = sum ? `今天 ${fmtTokens(sum.today)} · 近 7 天 ${fmtTokens(sum.last7)}` : '看看调用模型用掉了多少 token';
  return `<button type="button" data-act="openUsage" class="${C.card} flex w-full cursor-pointer items-center gap-3 px-4 py-3.5 text-left transition-colors hover:border-accent active:scale-[.99]">
    <span class="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-accent-soft text-accent">${ICON.chart}</span>
    <span class="flex min-w-0 flex-col gap-0.5"><b class="text-[15px]">Token 用量</b><span class="truncate text-[13px] text-muted">${esc(sub)}</span></span>
    <span class="ml-auto flex-none text-muted">${ICON.next}</span>
  </button>`;
}
