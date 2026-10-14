// 句库：按日期分组的一排圆点，点一下打开那一句
import type { Sentence } from '@sentence-site/shared';
import { $, closest } from '../lib/dom.ts';
import { esc, fmtDay } from '../lib/format.ts';
import { state, rec, atts, today } from '../state.ts';
import { open } from './nav.ts';

export function renderBank(): void {
  const el = $('bank');
  const { sentences } = state;
  const total = sentences.length;
  const done = sentences.filter((s) => rec(s.id)?.done).length;
  $('bankCount').textContent = total ? `共 ${total} 句 · 已完成 ${done}` : '';
  if (!total) {
    el.innerHTML = `<p class="m-0 text-[14px] text-muted">${state.loaded ? '句库还是空的，生成今天的任务就有句子了。' : '正在加载句库…'}</p>`;
    return;
  }
  const td = today();
  const groups: { b: string; items: { s: Sentence; i: number }[] }[] = [];
  let g: (typeof groups)[number] | null = null;
  sentences.forEach((s, i) => {
    if (!g || g.b !== s.batch) groups.push((g = { b: s.batch, items: [] }));
    g.items.push({ s, i });
  });
  const newCut = Date.now() - 3 * 864e5;
  el.innerHTML = groups
    .map(
      (gr) => `<div class="flex flex-none flex-col gap-1.5">
      <span class="whitespace-nowrap font-mono text-[11px] tracking-[.04em] text-muted">${gr.b === td ? '<b class="font-medium text-accent">今天</b> ' : ''}${esc(fmtDay(gr.b))}</span>
      <div class="flex gap-1.5">${gr.items.map(({ s, i }) => dotHTML(s, i, newCut)).join('')}</div></div>`,
    )
    .join('');
  const d = el.querySelector<HTMLElement>('[data-cur]');
  if (d) el.scrollLeft = Math.max(0, d.offsetLeft - el.clientWidth / 2 + d.offsetWidth / 2);
}

function dotHTML(s: Sentence, i: number, newCut: number): string {
  const r = rec(s.id);
  const tried = r || atts(s.id).length;
  const isCur = state.cur && s.id === state.cur.id;
  let tone = 'border-line bg-sheet text-muted';
  if (r?.done) tone = 'border-ok bg-ok-soft text-ok';
  else if (tried) tone = 'border-mid bg-sheet text-mid';
  if (isCur) tone = (r?.done ? 'bg-ok-soft' : 'bg-sheet') + ' border-accent text-accent ring-[3px] ring-accent-soft';
  const isNew = !tried && Date.parse(s.created) > newCut;
  return `<button data-sid="${esc(s.id)}" ${isCur ? 'data-cur' : ''} aria-label="第 ${i + 1} 句${r?.done ? '，已完成' : ''}"
    class="relative h-8 w-8 flex-none cursor-pointer rounded-full border-[1.5px] font-mono text-[12.5px] tabular-nums transition-transform hover:-translate-y-0.5 ${tone}">${i + 1}${isNew ? '<span class="absolute -top-0.5 -right-0.5 h-[9px] w-[9px] rounded-full border-2 border-paper bg-r-adv"></span>' : ''}</button>`;
}

export function initBank(): void {
  $('bank').addEventListener('click', (e) => {
    const b = closest(e, '[data-sid]');
    if (b?.dataset.sid) open(b.dataset.sid);
  });
}
