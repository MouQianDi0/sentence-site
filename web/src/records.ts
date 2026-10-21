// “记录”页：练过的句子、批改得分走势、AI 学习分析（analysis.ts）、每句的批改历史
import type { Attempt, Sentence } from '@sentence-site/shared';
import { plain } from '@sentence-site/shared/text';
import * as A from './lib/anim.ts';
import { $, closest } from './lib/dom.ts';
import { esc, fmtTime, scoreTone } from './lib/format.ts';
import { C, TONE } from './styles.ts';
import { state, rec, atts, saveUI } from './state.ts';
import { open } from './practice/nav.ts';
import { onAnalysisClick, renderAnalysis } from './analysis.ts';

export function renderRecords(): void {
  const el = $('viewRecords');
  const { sentences, records, attempts } = state;
  const byId: Record<string, Sentence> = Object.fromEntries(sentences.map((s) => [s.id, s]));
  const ids = new Set([...Object.keys(records), ...Object.keys(attempts)].filter((id) => byId[id]));
  const items = [...ids]
    .map((id) => {
      const list = atts(id);
      const r = rec(id);
      const updated =
        [r?.updatedAt, list[0]?.createdAt]
          .filter((x): x is string => !!x)
          .sort()
          .at(-1) || '';
      return { id, s: byId[id] as Sentence, r, list, updated };
    })
    .sort((a, b) => b.updated.localeCompare(a.updated));
  if (!items.length) {
    el.innerHTML = `<div class="${C.note}">还没有练习记录。做完一句的“选译文”或提交一次 AI 批改后，就会出现在这里。</div>`;
    return;
  }
  const allAtts: Attempt[] = Object.values(attempts)
    .flat()
    .filter((a) => byId[a.sentenceId])
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const avg = allAtts.length ? Math.round(allAtts.reduce((s, a) => s + (a.total ?? 0), 0) / allAtts.length) : null;
  const best = allAtts.length ? Math.max(...allAtts.map((a) => a.total ?? 0)) : null;
  let chart = '';
  const lastPt = allAtts.at(-1);
  if (allAtts.length >= 2 && lastPt) {
    const pts = allAtts.slice(-30);
    const W = 320;
    const H = 130;
    const x0 = 26;
    const x1 = 300;
    const yv = (v: number) => 12 + ((100 - v) / 100) * (H - 34);
    const xs = (i: number) => x0 + ((x1 - x0) * i) / (pts.length - 1);
    const line = pts.map((a, i) => `${xs(i).toFixed(1)},${yv(a.total ?? 0).toFixed(1)}`).join(' ');
    const lastY = yv(lastPt.total ?? 0);
    chart = `<div class="${C.card} flex flex-col gap-1.5 px-3.5 pt-3.5 pb-2.5"><span class="${C.label}">批改得分走势 · 最近 ${pts.length} 次</span>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="批改得分走势" class="block h-auto w-full">
      ${[60, 85, 100].map((v) => `<line class="stroke-line" stroke-dasharray="3 4" x1="${x0}" x2="${x1}" y1="${yv(v)}" y2="${yv(v)}"/><text class="fill-muted font-mono text-[10px]" x="0" y="${yv(v) + 3.5}">${v}</text>`).join('')}
      <path class="fill-accent-soft" d="M${xs(0).toFixed(1)},${yv(0).toFixed(1)} L${line.replace(/ /g, ' L')} L${xs(pts.length - 1).toFixed(1)},${yv(0).toFixed(1)} Z"/>
      <polyline class="fill-none stroke-accent" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" points="${line}"/>
      <circle class="fill-accent" cx="${xs(pts.length - 1).toFixed(1)}" cy="${lastY.toFixed(1)}" r="4"/>
      <text class="fill-accent font-mono text-[11px]" x="${Math.min(xs(pts.length - 1) + 6, W - 22).toFixed(1)}" y="${(lastY - 8).toFixed(1)}">${lastPt.total}</text>
      <text class="fill-muted font-mono text-[10px]" x="${x0}" y="${H - 4}">较早</text><text class="fill-muted font-mono text-[10px]" x="${x1 - 22}" y="${H - 4}">最近</text></svg></div>`;
  }
  const stat = (n: number, label: string) =>
    `<span><b class="mr-0.5 font-mono text-[20px] font-medium tabular-nums text-ink">${n}</b>${label}</span>`;
  el.innerHTML = `<div class="flex flex-wrap gap-x-[18px] gap-y-1.5 text-[14px] text-muted">${stat(items.length, '句练过')}${stat(items.filter((x) => x.r?.done).length, '句完成')}${stat(allAtts.length, '次批改')}${avg != null && best != null ? stat(avg, '平均分') + stat(best, '最高分') : ''}</div>
    ${chart}
    <div id="analysisCard" class="${C.card} flex flex-col gap-3.5 p-3.5"></div>
    <div class="flex flex-col gap-2">${items
      .map(({ id, s, r, list, updated }) => {
        const bs = list.length ? Math.max(...list.map((x) => x.total ?? 0)) : null;
        const tone = bs != null ? TONE[scoreTone(bs)] : null;
        return `<details class="overflow-hidden ${C.card}"><summary class="grid cursor-pointer list-none grid-cols-[auto_1fr] items-center gap-3 px-3.5 py-3 [&::-webkit-details-marker]:hidden">
          <span class="flex h-11 w-11 items-center justify-center rounded-xl font-mono text-[16px] tabular-nums ${tone ? `${tone.soft} ${tone.text}` : 'bg-raise text-muted'}">${bs ?? '—'}</span>
          <span class="flex min-w-0 flex-col gap-0.5"><span class="truncate font-en">${sentences.indexOf(s) + 1}. ${esc(plain(s))}</span>
          <span class="text-[12.5px] text-muted">${esc(s.focus)} · ${esc(fmtTime(updated))} · 批改 ${list.length} 次${r?.done ? ' · <span class="whitespace-nowrap text-ok">已完成</span>' : ''}</span></span></summary>
          <div class="flex flex-col gap-2.5 px-3.5 pb-3.5">
          ${
            list.length
              ? `<ul class="m-0 flex list-none flex-col gap-1.5 p-0">${list
                  .map(
                    (x) =>
                      `<li class="grid grid-cols-[2.6em_1fr] gap-x-2.5 gap-y-0.5 rounded-lg bg-raise px-2.5 py-2 text-[14px]"><span class="row-span-2 font-mono ${TONE[scoreTone(x.total ?? 0)].text}">${x.total ?? '—'}</span><span>${esc(x.text)}</span><span class="text-[12px] text-muted">${esc(fmtTime(x.createdAt))} · 准确 ${x.acc ?? '—'} · 通顺 ${x.flu ?? '—'} · 完整 ${x.comp ?? '—'}${x.model ? ` · ${esc(x.model)}` : ''}</span></li>`,
                  )
                  .join('')}</ul>`
              : r?.draft
                ? `<p class="m-0 text-muted">草稿：${esc(r.draft)}</p>`
                : ''
          }
          ${list[0]?.feedback?.level ? `<p class="m-0">最近一次点评：${esc(list[0].feedback.level)}</p>` : ''}
          <div class="${C.row}"><button class="${C.btnPrimary} px-3 py-1.5 text-[13.5px]" data-open="${esc(id)}">回到这句练习</button></div></div></details>`;
      })
      .join('')}</div>`;
  renderAnalysis();
}

export function initRecords(): void {
  $('viewRecords').addEventListener('click', (e) => {
    if (onAnalysisClick(e)) return;
    const b = closest(e, '[data-open]');
    if (!b?.dataset.open) return;
    state.ui.view = 'practice';
    saveUI();
    open(b.dataset.open);
    window.scrollTo({ top: 0, behavior: A.motion ? 'smooth' : 'auto' });
  });
}
