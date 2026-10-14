// 今日任务：练习页最上面的任务卡片（进度、生成、补齐、加练），以及全部完成后的完成页
import { plain } from '@sentence-site/shared/text';
import { api, ApiError } from '../lib/api.ts';
import * as A from '../lib/anim.ts';
import { $, all, closest } from '../lib/dom.ts';
import { esc, scoreTone } from '../lib/format.ts';
import { toast } from '../lib/toast.ts';
import { C, TONE } from '../styles.ts';
import { state, rec, atts, aiOk, taskInfo } from '../state.ts';
import { autoOn, fmtAt, levelText } from '../settings/task-settings.ts';
import { renderViews, showView } from '../views.ts';
import { checkNewSentences } from './data.ts';
import { open } from './nav.ts';
import { stopSpeak } from './reading.ts';

const LV_SHORT: Record<string, string> = { 'CET-4': '四级', 'CET-6': '六级' };

function busyHTML(): string {
  const n = state.taskBusyN;
  return `<div class="flex items-center gap-2.5 rounded-xl bg-raise px-3 py-2.5 text-[14px]"><span class="${C.spin}"></span>
    <span class="flex-1">AI 正在出 ${n} 道${esc(levelText(state.practiceCfg.levels))}的题，${n > 5 ? '一两分钟' : '大约 1 分钟'}，可以先练句库里的旧句子。</span></div>`;
}

function errHTML(): string {
  return state.taskErr
    ? `<div class="flex items-center gap-2.5 rounded-xl bg-bad-soft px-3 py-2.5 text-[14px]"><span class="flex-1">${esc(state.taskErr)}</span><button class="${C.btnSmall}" data-act="closeTaskErr">知道了</button></div>`
    : '';
}

/** 加练：选句数 + 开始按钮（任务卡片和完成页共用） */
function extraHTML(primary: boolean): string {
  const max = state.practiceCfg.maxDaily || 10;
  const { extraCount } = state;
  const stepBtn =
    'flex h-9 w-9 cursor-pointer items-center justify-center text-[18px] leading-none transition-colors hover:text-accent disabled:cursor-not-allowed disabled:opacity-35';
  return `<div class="flex flex-wrap items-center gap-2.5">
    <div class="inline-flex items-center rounded-full border-[1.5px] border-line bg-sheet">
      <button data-act="extraMinus" aria-label="少一句" class="${stepBtn}" ${extraCount <= 1 ? 'disabled' : ''}>−</button>
      <span data-extra-count class="min-w-[2.2em] text-center font-mono text-[16px] tabular-nums" aria-live="polite">${extraCount}</span>
      <button data-act="extraPlus" aria-label="多一句" class="${stepBtn}" ${extraCount >= max ? 'disabled' : ''}>+</button>
    </div>
    <span class="text-[14px] text-muted">句</span>
    <button class="${primary ? C.btnPrimary : C.btn}" data-act="extraGo" ${aiOk() && !state.taskBusy ? '' : 'disabled'}>开始加练</button>
  </div>`;
}

export function renderTask(): void {
  const el = $('task');
  const cfg = state.practiceCfg;
  if (!state.loaded) {
    el.innerHTML = `<span class="${C.label}">今日任务</span><div class="${C.shim} w-[60%]"></div>`;
    return;
  }
  const t = taskInfo();
  const head = `<div class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
    <span class="${C.label}">今日任务</span>
    <span class="text-[13px] text-muted">${esc(levelText(cfg.levels))} · 每天 ${cfg.dailyCount} 句</span>
    <button class="ml-auto cursor-pointer text-[13px] text-accent underline underline-offset-4" data-act="taskSettings">调整</button></div>`;
  let body = '';
  if (!t.list.length) {
    body = state.taskBusy
      ? busyHTML()
      : aiOk()
        ? `<p class="m-0 text-[14.5px]">今天的 ${cfg.dailyCount} 句还没生成。${autoOn(cfg) ? `每天 ${esc(fmtAt(cfg.dailyAt))} 会自动生成，` : ''}也可以现在生成。</p>
          <div class="${C.row}"><button class="${C.btnPrimary}" data-act="genDaily">现在生成今天的 ${cfg.dailyCount} 句</button></div>`
        : `<p class="m-0 text-[14.5px]">还没配置 AI 模型，没法生成今天的句子。</p><div class="${C.row}"><button class="${C.btnPrimary}" data-act="taskSettings">去设置模型</button></div>`;
  } else {
    const pct = Math.round((t.done / (t.list.length + t.missing)) * 100);
    const bar =
      t.list
        .map((s, i) => {
          const done = rec(s.id)?.done;
          const isCur = state.cur && state.cur.id === s.id && !state.showDone;
          return `<button data-sid="${esc(s.id)}" aria-label="今日第 ${i + 1} 句${done ? '，已完成' : ''}" class="group flex min-w-0 flex-1 cursor-pointer py-1.5">
          <span class="h-2 w-full rounded-full transition-colors ${done ? 'bg-ok' : isCur ? 'bg-accent' : 'bg-line group-hover:bg-mid'}"></span></button>`;
        })
        .join('') +
      Array.from(
        { length: t.missing },
        () =>
          '<span class="flex min-w-0 flex-1 py-1.5"><span class="h-2 w-full rounded-full border border-dashed border-line"></span></span>',
      ).join('');
    body = `<div class="flex items-baseline gap-2">
        <b class="font-mono text-[26px] leading-none font-medium tabular-nums ${t.complete ? 'text-ok' : ''}">${t.done}</b>
        <span class="text-[14px] text-muted">/ ${t.list.length + t.missing} 句完成</span>
        ${t.complete ? '<span class="ml-auto rounded-full bg-ok-soft px-2.5 py-0.5 text-[13px] font-semibold whitespace-nowrap text-ok">✓ 已完成</span>' : `<span class="ml-auto font-mono text-[12px] text-muted">${pct}%</span>`}
      </div>
      <div class="flex gap-1" role="group" aria-label="今日任务进度">${bar}</div>
      ${
        state.taskBusy
          ? busyHTML()
          : `<div class="${C.row}">
        ${t.missing ? `<button class="${C.btnPrimary} px-3 py-1.5 text-[13.5px]" data-act="genDaily" ${aiOk() ? '' : 'disabled'}>补齐 ${t.missing} 句</button>` : ''}
        ${t.complete && !state.showDone ? `<button class="${C.btnSmall}" data-act="showDone">查看完成页</button>` : ''}
        <button class="${C.btnSmall}" data-act="extraToggle" aria-expanded="${state.extraOpen}">＋ 加练</button>
      </div>
      ${state.extraOpen ? `<div data-extra class="flex flex-col gap-1.5 rounded-xl bg-raise px-3 py-2.5">${extraHTML(false)}<span class="text-[12.5px] text-muted">加练的句子算进今天的任务，难度按设置：${esc(levelText(cfg.levels))}。</span></div>` : ''}`
      }`;
  }
  el.innerHTML = head + body + errHTML();
}

/** 完成页：今日任务全部完成后，练习页显示它，代替句子和三个步骤 */
export function renderDone(enter: boolean): void {
  const el = $('doneView');
  const t = taskInfo();
  const cfg = state.practiceCfg;
  const on = state.showDone && t.complete;
  if (!on) state.showDone = false;
  el.classList.toggle('hidden', !on);
  el.classList.toggle('flex', on);
  $('work').classList.toggle('hidden', on);
  $('work').classList.toggle('flex', !on);
  if (!on) {
    el.innerHTML = '';
    return;
  }
  const count = (lv: string) => t.list.filter((s) => s.level === lv).length;
  const bests = t.list.map((s) => (atts(s.id).length ? Math.max(...atts(s.id).map((a) => a.total ?? 0)) : null));
  const scored = bests.filter((b): b is number => b != null);
  const graded = t.list.reduce((n, s) => n + atts(s.id).length, 0);
  const avg = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null;
  const stat = (n: number, label: string) =>
    `<span class="flex flex-col items-center gap-0.5"><b class="font-mono text-[22px] leading-none font-medium tabular-nums">${n}</b><span class="text-[12.5px] text-muted">${label}</span></span>`;
  const lv = [
    ['CET-4', '四级'],
    ['CET-6', '六级'],
  ]
    .filter(([k]) => count(k as string))
    .map(([k, n]) => `${n} ${count(k as string)} 句`)
    .join(' · ');
  el.innerHTML = `<section class="flex flex-col items-center gap-2.5 rounded-2xl border border-line bg-sheet px-5 pt-7 pb-6 text-center">
      <span data-donecheck class="flex h-16 w-16 items-center justify-center rounded-full bg-ok text-on-accent"><svg class="h-8 w-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>
      <h2 class="m-0 text-[22px] font-semibold">今日任务完成</h2>
      <p class="m-0 text-[14.5px] text-muted">${t.list.length} 句全部完成${lv ? ` · ${lv}` : ''}</p>
      <div class="mt-2 flex flex-wrap justify-center gap-x-8 gap-y-3">${stat(t.list.length, '完成句数')}${stat(graded, 'AI 批改')}${avg != null ? stat(avg, '平均最高分') : ''}</div>
    </section>
    <section class="flex flex-col gap-3 rounded-2xl border border-line bg-sheet px-4 py-4">
      <div class="flex flex-col gap-0.5"><b class="text-[16px]">还想再练？</b><span class="text-[13px] text-muted">加练的句子会加进今天的任务，难度按设置：${esc(levelText(cfg.levels))}。</span></div>
      ${state.taskBusy ? busyHTML() : extraHTML(true)}
      ${errHTML()}
    </section>
    <section class="flex flex-col gap-2">
      <span class="${C.label}">今天的句子 · 点开复习</span>
      ${t.list
        .map((s, i) => {
          const b = bests[i];
          const tone = b != null ? TONE[scoreTone(b)] : null;
          return `<button data-sid="${esc(s.id)}" class="grid cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-3 rounded-xl border border-line bg-sheet px-3.5 py-2.5 text-left transition-colors hover:border-accent">
            <span class="rounded-full border border-line px-2 py-px font-mono text-[11.5px] text-muted">${esc(LV_SHORT[s.level ?? ''] || s.level || '—')}</span>
            <span class="flex min-w-0 flex-col"><span class="truncate font-en text-[15px]">${esc(plain(s))}</span><span class="truncate text-[12.5px] text-muted">${esc(s.focus || '')}</span></span>
            <span class="font-mono text-[15px] tabular-nums ${tone ? tone.text : 'text-ok'}">${b ?? '✓'}</span></button>`;
        })
        .join('')}
    </section>
    <p class="m-0 text-center text-[13px] text-muted">${autoOn(cfg) ? `明天 ${esc(fmtAt(cfg.dailyAt))} 会自动准备新的 ${cfg.dailyCount} 句。` : ''}<button class="cursor-pointer text-accent underline underline-offset-4" data-act="taskSettings">调整每日任务</button></p>`;
  if (enter || state.celebrate) A.enter(el.children);
  if (state.celebrate) {
    state.celebrate = false;
    const c = el.querySelector('[data-donecheck]');
    if (c) {
      A.pop(c);
      const r = c.getBoundingClientRect();
      setTimeout(() => A.burst(r.left + r.width / 2, r.top + r.height / 2), 120);
    }
  }
}

export function showDonePage(): void {
  if (!taskInfo().complete) return;
  if (state.speaking) stopSpeak();
  A.toastOut($('toast'));
  state.showDone = true;
  state.view = 'practice';
  renderViews();
  renderTask();
  renderDone(true);
  window.scrollTo({ top: 0, behavior: A.motion ? 'smooth' : 'auto' });
}

/** 生成今日任务（kind=daily，没生成或要补齐时）或加练（kind=extra） */
async function generateTask(kind: 'daily' | 'extra'): Promise<void> {
  if (state.taskBusy) return;
  state.taskBusyN = kind === 'daily' ? taskInfo().missing || state.practiceCfg.dailyCount : state.extraCount;
  state.taskBusy = kind;
  state.taskErr = '';
  renderTask();
  renderDone(false);
  try {
    const r = await api.generate(kind === 'daily' ? { kind } : { kind, count: state.extraCount });
    await checkNewSentences(true);
    state.usage = await api.usage().catch(() => state.usage);
    state.taskBusy = '';
    state.extraOpen = false;
    const short = state.taskBusyN - r.added.length;
    toast(
      `新增 ${r.added.length} 句${short > 0 ? `，有 ${short} 句没通过检查${kind === 'daily' ? '，可以点“补齐”' : ''}` : ''}`,
    );
    const first = r.added.find((id) => state.sentences.some((x) => x.id === id));
    if (first) {
      open(first);
      window.scrollTo({ top: 0, behavior: A.motion ? 'smooth' : 'auto' });
    } else {
      renderTask();
      renderDone(false);
    }
  } catch (e) {
    state.taskBusy = '';
    state.taskErr = (e as Error).message;
    if (e instanceof ApiError && e.status === 409) await checkNewSentences(true); // 别处已经生成了
    renderTask();
    renderDone(false);
  }
}

function onTaskClick(e: MouseEvent): void {
  const b = closest(e, '[data-sid]');
  if (b?.dataset.sid) {
    open(b.dataset.sid);
    $('sheet').scrollIntoView({ behavior: A.motion ? 'smooth' : 'auto', block: 'start' });
    return;
  }
  const a = closest(e, '[data-act]');
  if (!a) return;
  const max = state.practiceCfg.maxDaily || 10;
  switch (a.dataset.act) {
    case 'genDaily':
      void generateTask('daily');
      return;
    case 'extraGo':
      void generateTask('extra');
      return;
    case 'extraToggle':
      state.extraOpen = !state.extraOpen;
      renderTask();
      if (state.extraOpen) A.slideIn($('task').querySelector('[data-extra]'));
      return;
    case 'extraMinus':
    case 'extraPlus':
      state.extraCount = Math.min(max, Math.max(1, state.extraCount + (a.dataset.act === 'extraPlus' ? 1 : -1)));
      all('[data-extra-count]').forEach((x) => {
        x.textContent = String(state.extraCount);
        A.pop(x);
      });
      all<HTMLButtonElement>('[data-act="extraMinus"]').forEach((x) => (x.disabled = state.extraCount <= 1));
      all<HTMLButtonElement>('[data-act="extraPlus"]').forEach((x) => (x.disabled = state.extraCount >= max));
      return;
    case 'showDone':
      showDonePage();
      return;
    case 'taskSettings':
      showView('settings');
      return;
    case 'closeTaskErr':
      state.taskErr = '';
      renderTask();
      renderDone(false);
      return;
    default:
  }
}

export function initTask(): void {
  $('task').addEventListener('click', onTaskClick);
  $('doneView').addEventListener('click', onTaskClick);
}
