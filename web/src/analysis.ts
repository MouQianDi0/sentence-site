// 记录页的“AI 学习分析”：读最近一份报告；点“开始分析”让 AI 根据批改记录写一份报告——
// 学习曲线怎么看、要改的翻译习惯（带上自己译文里的例子）、薄弱的结构、接下来怎么练。
// 分析在后台进行（半分钟到一分钟），可以先去别的页面，写好了会提示。
import type { Analysis, LearningStats } from '@sentence-site/shared';
import { KB } from '@sentence-site/shared/kb';
import { api } from './lib/api.ts';
import * as A from './lib/anim.ts';
import { closest } from './lib/dom.ts';
import { esc, fmtTime, scoreTone } from './lib/format.ts';
import { toast } from './lib/toast.ts';
import { C, TONE } from './styles.ts';
import { aiOk, saveUI, state } from './state.ts';
import { showView } from './views.ts';

/** 至少批改过几句才能分析（和后端 analysis.ts 的 MIN_SENTENCES 一样） */
const MIN_SENTENCES = 3;

const ICON = {
  spark:
    '<svg class="h-[18px] w-[18px]" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M9 2.5l1.7 4.6 4.6 1.7-4.6 1.7L9 15.1l-1.7-4.6-4.6-1.7 4.6-1.7z"/><path d="M15.3 12.6l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z"/></svg>',
  down: '<svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>',
  up: '<svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10l4-4 4 4"/></svg>',
};

/** 批改过（有分数）的句子数，和后端一样只算句库里还在的句子 */
function gradedCount(): number {
  const ids = new Set(state.sentences.map((s) => s.id));
  return Object.entries(state.attempts).filter(([id, list]) => ids.has(id) && list.some((a) => a.total != null)).length;
}

/** 这份报告之后又批改了几次 */
function newSince(a: Analysis): number {
  const t = Date.parse(a.createdAt);
  return Object.values(state.attempts)
    .flat()
    .filter((x) => Date.parse(x.createdAt) > t).length;
}

/** 今天还能分析几次；还没读到用量时是 null */
function left(): number | null {
  const u = state.usage;
  return u ? Math.max(0, u.limits.analyze - u.analyses) : null;
}

async function load(): Promise<void> {
  state.analysisLoad = 'loading';
  try {
    state.analysis = (await api.analysis()).analysis;
    state.analysisLoad = 'ok';
  } catch {
    state.analysisLoad = 'error';
  }
  renderAnalysis();
}

/** 开始分析：写好了展开报告；不在记录页时弹个提示 */
async function analyze(): Promise<void> {
  if (state.analysisBusy) return;
  state.analysisBusy = true;
  state.analysisErr = '';
  renderAnalysis();
  try {
    state.analysis = (await api.analyze()).analysis;
    state.analysisLoad = 'ok';
    if (state.usage) state.usage.analyses++;
    state.ui.analysisFold = false;
    saveUI();
    if (state.view !== 'records') toast('学习分析写好了', { label: '去看看', fn: () => showView('records') });
  } catch (e) {
    state.analysisErr = (e as Error).message;
    if (state.view !== 'records') toast(`学习分析没做成：${state.analysisErr}`);
  } finally {
    state.analysisBusy = false;
  }
  renderAnalysis(true);
}

const section = (title: string, inner: string) =>
  `<section class="flex flex-col gap-2"><h3 class="m-0 ${C.label} font-normal">${title}</h3>${inner}</section>`;

/** 前一半句子 → 后一半句子的平均分 */
function deltaChip(label: string, a: number, b: number): string {
  const d = b - a;
  const cls = d > 0 ? 'text-ok' : d < 0 ? 'text-bad' : 'text-muted';
  return `<span class="flex items-baseline gap-1.5 rounded-lg bg-raise px-2.5 py-1.5 text-[13px]"><span class="text-muted">${label}</span><span class="font-mono tabular-nums">${a} → ${b}</span><span class="font-mono text-[12px] tabular-nums ${cls}">${d > 0 ? '+' : ''}${d}</span></span>`;
}

function curveHTML(s: LearningStats, text: string): string {
  const chips =
    s.sentences >= 2
      ? `<div class="flex flex-col gap-1"><div class="flex flex-wrap gap-1.5">${deltaChip('总分', s.earlier.total, s.recent.total)}${deltaChip('准确', s.earlier.acc, s.recent.acc)}${deltaChip('通顺', s.earlier.flu, s.recent.flu)}${deltaChip('完整', s.earlier.comp, s.recent.comp)}</div>
        <span class="text-[12px] text-muted">每句第一次提交的平均分：前一半句子 → 后一半句子</span></div>`
      : '';
  const v = s.verbs;
  const other = [
    v.total ? `圈谓语找对 ${Math.round((v.ok / v.total) * 100)}%` : '',
    s.choice.sentences ? `选译文一次选对 ${s.choice.ok}/${s.choice.sentences}` : '',
    s.retry.sentences ? `改了再交平均提高 ${s.retry.gain} 分` : '',
  ].filter(Boolean);
  return section(
    '学习曲线',
    `${chips}${text ? `<p class="m-0 text-[14.5px] leading-[1.75]">${esc(text)}</p>` : ''}${other.length ? `<p class="m-0 text-[12.5px] text-muted">${other.join(' · ')}</p>` : ''}`,
  );
}

function habitsHTML(a: Analysis): string {
  const { habits } = a.report;
  const known = new Set(state.sentences.map((s) => s.id));
  const types = a.stats.issues.slice(0, 4);
  const common = types.length
    ? `<p class="m-0 text-[12.5px] text-muted">批注里最常见的问题：${types.map((t) => `${esc(t.type)} ${t.n} 次`).join(' · ')}</p>`
    : '';
  if (!habits.length) return common ? section('要改的翻译习惯', common) : '';
  const items = habits
    .map(
      (h, i) => `<li class="flex flex-col gap-2 rounded-xl bg-raise px-3 py-2.5">
        <div class="flex items-center gap-2"><span class="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-bad font-mono text-[11px] text-sheet">${i + 1}</span><b class="text-[15px] font-semibold">${esc(h.name)}</b></div>
        ${h.detail ? `<p class="m-0 text-[14px] leading-[1.7]">${esc(h.detail)}</p>` : ''}
        ${h.examples
          .map(
            (x) => `<div class="flex flex-col gap-1.5 rounded-lg border border-line bg-sheet px-2.5 py-2 text-[14px]">
          <div class="grid grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-1"><span class="text-[12px] text-muted">你写的</span><span class="text-bad line-through">${esc(x.src)}</span><span class="text-[12px] text-muted">改成</span><span class="font-semibold text-ok">${esc(x.fix)}</span></div>
          ${known.has(x.sentenceId) ? `<button class="cursor-pointer self-end text-[12.5px] text-accent" data-open="${esc(x.sentenceId)}">回到这句 →</button>` : ''}</div>`,
          )
          .join('')}
        ${h.advice ? `<p class="m-0 text-[14px] leading-[1.7]"><span class="font-semibold text-accent">怎么改：</span>${esc(h.advice)}</p>` : ''}</li>`,
    )
    .join('');
  return section('要改的翻译习惯', `${common}<ol class="m-0 flex list-none flex-col gap-2 p-0">${items}</ol>`);
}

function weakHTML(a: Analysis): string {
  const { weak } = a.report;
  const points = a.stats.points.slice(0, 5);
  if (!weak.length && !points.length) return '';
  const list = weak.length
    ? `<ul class="m-0 flex list-none flex-col gap-1.5 p-0">${weak.map((w) => `<li class="text-[14px] leading-[1.7]"><b class="font-semibold">${esc(w.name)}</b>${w.detail ? `：${esc(w.detail)}` : ''}</li>`).join('')}</ul>`
    : '';
  const bars = points.length
    ? `<div class="flex flex-col gap-1.5"><span class="text-[12px] text-muted">含这种结构的句子，第一次提交的平均分</span>
      <div class="grid grid-cols-[minmax(0,9em)_1fr_auto] items-center gap-x-2.5 gap-y-1.5 text-[13px]">${points
        .map((p) => {
          const name = KB[p.k]?.t ?? p.k;
          return `<span class="truncate text-muted" title="${esc(name)}">${esc(name)}</span><span class="h-1.5 overflow-hidden rounded-full bg-line"><span class="block h-full rounded-full ${TONE[scoreTone(p.avg)].bg}" style="width:${p.avg}%"></span></span><span class="text-right font-mono text-[12px] whitespace-nowrap tabular-nums">${p.avg}<span class="text-muted"> · ${p.n} 句</span></span>`;
        })
        .join('')}</div></div>`
    : '';
  return section('薄弱的结构', list + bars);
}

function reportHTML(a: Analysis): string {
  const r = a.report;
  const fold = !!state.ui.analysisFold;
  const toggle = `<button class="flex cursor-pointer items-center gap-1 self-start text-[13.5px] text-accent" data-analysis-fold aria-expanded="${!fold}">${fold ? `展开完整报告${ICON.down}` : `收起报告${ICON.up}`}</button>`;
  const summary = r.summary ? `<p class="m-0 text-[15.5px] leading-[1.75]">${esc(r.summary)}</p>` : '';
  if (fold) return summary + toggle;
  const good = r.strengths.length
    ? section(
        '做得好的',
        `<ul class="m-0 flex list-disc flex-col gap-0.5 pl-[18px] text-[14px] leading-[1.7] marker:text-ok">${r.strengths.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>`,
      )
    : '';
  const plan = r.plan.length
    ? section(
        '接下来怎么练',
        `<ol class="m-0 flex list-none flex-col gap-2 p-0">${r.plan
          .map(
            (p, i) =>
              `<li class="grid grid-cols-[22px_1fr] gap-2 text-[14px] leading-[1.7]"><span class="mt-0.5 flex h-[22px] w-[22px] items-center justify-center rounded-full bg-accent-soft font-mono text-[12px] text-accent">${i + 1}</span><span>${esc(p)}</span></li>`,
          )
          .join('')}</ol>`,
      )
    : '';
  return summary + curveHTML(a.stats, r.curve) + good + habitsHTML(a) + weakHTML(a) + plan + toggle;
}

function cardHTML(): string {
  const a = state.analysis;
  const n = gradedCount();
  const remain = left();
  let meta = '根据批改记录，总结学习曲线和要改的翻译习惯';
  let body = '';
  let action = '';
  const disabled = state.analysisBusy || n < MIN_SENTENCES || remain === 0 || !aiOk();
  const why = !aiOk()
    ? '先在“设置”里配好 AI 模型'
    : n < MIN_SENTENCES
      ? `再批改 ${MIN_SENTENCES - n} 句就能分析（至少 ${MIN_SENTENCES} 句）`
      : remain === 0
        ? '今天的分析次数用完了，明天再来'
        : remain != null
          ? `今天还能分析 ${remain} 次`
          : '';

  if (state.analysisLoad !== 'ok' && state.analysisLoad !== 'error') {
    body = `<div class="flex flex-col gap-2"><div class="${C.shim} w-11/12"></div><div class="${C.shim} w-3/4"></div></div>`;
  } else if (state.analysisLoad === 'error') {
    meta = '没读到上次的报告';
    action = `<button class="${C.btnSmall}" data-analysis-reload>重试</button>`;
  } else if (a) {
    const more = newSince(a);
    meta = `${esc(fmtTime(a.createdAt))} · 根据 ${a.stats.sentences} 句、${a.stats.attempts} 次批改${more ? ` · 之后又批改了 ${more} 次` : ''}`;
    action = `<button class="${C.btnSmall} disabled:cursor-not-allowed disabled:opacity-45" data-analyze ${disabled ? 'disabled' : ''} title="${esc(why)}">重新分析</button>`;
    body = reportHTML(a);
  } else {
    body = `<p class="m-0 text-[14px] leading-[1.7] text-muted">AI 会看你每句第一次提交的分数和批注，告诉你分数怎么变、哪些翻译习惯反复出错（带上你自己译文里的例子）、哪种结构最弱，以及接下来怎么练。</p>
      <div class="${C.row}"><button class="${C.btnPrimary} px-3.5 py-1.5 text-[14px]" data-analyze ${disabled ? 'disabled' : ''}>开始分析</button>${why ? `<span class="text-[12.5px] text-muted">${esc(why)}</span>` : ''}</div>`;
  }
  const busy = state.analysisBusy
    ? `<div class="flex items-center gap-2 rounded-lg bg-raise px-3 py-2 text-[13.5px] text-muted" role="status"><span class="${C.spin}"></span>AI 正在看你的批改记录，大约半分钟到一分钟，可以先去做别的</div>`
    : '';
  const err = state.analysisErr
    ? `<p class="m-0 text-[13.5px] text-bad" role="alert">${esc(state.analysisErr)}</p>`
    : '';
  return `<div class="flex items-center gap-2.5">
      <span class="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-accent-soft text-accent">${ICON.spark}</span>
      <div class="flex min-w-0 flex-1 flex-col"><b class="text-[15.5px] font-semibold">AI 学习分析</b><span class="text-[12.5px] text-muted">${meta}</span></div>${action}</div>
    ${busy}${err}${body}`;
}

/** 画分析卡片（记录页上的 #analysisCard）；还没读过报告时先去读。enter：播一次进场动画 */
export function renderAnalysis(enter = false): void {
  const el = document.getElementById('analysisCard');
  if (!el) return;
  if (!state.analysisLoad) void load();
  el.innerHTML = cardHTML();
  if (enter) A.enter(el.children);
}

/** 卡片上的按钮；是分析卡片的点击时返回 true */
export function onAnalysisClick(e: Event): boolean {
  if (closest(e, '[data-analyze]')) {
    void analyze();
    return true;
  }
  if (closest(e, '[data-analysis-reload]')) {
    void load();
    return true;
  }
  if (closest(e, '[data-analysis-fold]')) {
    state.ui.analysisFold = !state.ui.analysisFold;
    saveUI();
    renderAnalysis();
    return true;
  }
  return false;
}
