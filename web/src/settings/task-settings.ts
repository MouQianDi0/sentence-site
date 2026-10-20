// “设置”页里的“每日任务”卡片：出四级还是六级（可以都选，混合随机）、题目来源（AI 出题 / 真题题库 / 先题库不够再 AI）、
// 每天几句（1–10）、每天几点自动生成（北京时间，也可以关掉）；以及“AI 批改”卡片的“准确度提升”开关。
// 两张卡片的设置存在一起（/api/settings/practice），改了自动保存。
import type { AccountRole, Level, PracticeSettings, QuestionSource } from '@sentence-site/shared';
import { api } from '../lib/api.ts';
import { closest } from '../lib/dom.ts';
import { esc } from '../lib/format.ts';
import * as A from '../lib/anim.ts';
import type { Toast } from '../lib/toast.ts';

export const LEVELS: { id: Level; name: string; sub: string }[] = [
  { id: 'CET-4', name: '四级', sub: 'CET-4' },
  { id: 'CET-6', name: '六级', sub: 'CET-6' },
];

/** 题目来源的几个选项 */
const SOURCES: { id: QuestionSource; name: string; sub: string }[] = [
  { id: 'ai', name: 'AI 出题', sub: '每次原创新句子' },
  { id: 'bank', name: '真题题库', sub: '四级真题阅读原句' },
  { id: 'bankFirst', name: '先题库', sub: '不够再 AI 出题' },
];

/** ['CET-4','CET-6'] → “四级 + 六级混合” */
export function levelText(levels: Level[] = []): string {
  const names = LEVELS.filter((l) => levels.includes(l.id)).map((l) => l.name);
  return names.length > 1 ? `${names.join(' + ')}混合` : names[0] || '';
}

/** 这个账户每天会不会自动生成：自己开着，服务器也没关 */
export const autoOn = (p: PracticeSettings | null | undefined): boolean =>
  Boolean(p?.autoDaily) && p?.serverDaily !== false;

/** '07:50' → '7:50'（页面上显示用） */
export const fmtAt = (s = ''): string => s.replace(/^0(\d)/, '$1');

const C = {
  card: 'rounded-2xl border border-line bg-sheet',
  label: 'font-mono text-[11px] tracking-[.1em] uppercase text-muted',
  select:
    'cursor-pointer appearance-none rounded-xl border-[1.5px] border-line bg-sheet py-1.5 pr-7 pl-3 font-mono text-[15px] text-ink tabular-nums outline-none transition-colors hover:border-accent focus:border-accent disabled:cursor-not-allowed disabled:hover:border-line',
  step: 'flex h-10 w-10 cursor-pointer items-center justify-center text-[20px] leading-none transition-colors hover:text-accent disabled:cursor-not-allowed disabled:opacity-35',
};

/** 开关的样子，和模型设置里的开关一样 */
const switchHTML = (act: string, on: boolean, label: string, disabled = false) =>
  `<button type="button" role="switch" aria-checked="${on}" data-act="${act}" ${disabled ? 'disabled' : ''} class="group flex w-max cursor-pointer items-center gap-2.5 text-[14px] font-semibold select-none disabled:cursor-not-allowed disabled:opacity-50">
    <span class="relative h-[23px] w-10 flex-none rounded-full bg-line transition-colors group-aria-checked:bg-accent"><span class="absolute top-[3px] left-[3px] h-[17px] w-[17px] rounded-full bg-sheet transition-transform group-aria-checked:translate-x-[17px]"></span></span>${label}</button>`;

/**
 * root：“每日任务”卡片；gradeRoot：“AI 批改”卡片（准确度提升开关）。
 * role()：当前账户是 owner 还是 member（邀请账户的提示多一句）
 */
export function createTaskSettings({
  root,
  gradeRoot,
  toast,
  onChange,
  role = () => 'owner',
}: {
  root: HTMLElement;
  gradeRoot?: HTMLElement;
  toast?: Toast;
  onChange?: (cfg: PracticeSettings) => void;
  role?: () => AccountRole | undefined;
}) {
  let cfg: PracticeSettings | null = null;
  let err = '';
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let status = ''; // saving | saved | 错误信息
  let statusOf: 'task' | 'grade' = 'task'; // 保存状态显示在哪张卡片上（改的是哪张就显示在哪张）

  /** 读取设置；返回数据有没有变化（设置页据此决定要不要重新画） */
  async function load(): Promise<boolean> {
    try {
      const next = await api.practiceSettings();
      const changed = !cfg || JSON.stringify(next) !== JSON.stringify(cfg);
      cfg = next;
      err = '';
      return changed;
    } catch (e) {
      if (cfg) return false; // 有上次读到的数据就继续显示它
      const msg = (e as Error).message;
      const changed = err !== msg;
      err = msg;
      return changed;
    }
  }

  /** 正在保存、或者正在改时间：后台刷新时先别重画，免得打断 */
  const editing = () =>
    status === 'saving' ||
    root.contains(document.activeElement) ||
    Boolean(gradeRoot?.contains(document.activeElement));

  function statusHTML(card: 'task' | 'grade' = 'task'): string {
    if (card !== statusOf) return '';
    if (status === 'saving') return '<span class="text-muted">保存中…</span>';
    if (status === 'saved') return '<span class="text-ok">已保存</span>';
    return status ? `<span class="text-bad">${esc(status)}</span>` : '';
  }

  function autoHint(): string {
    if (!cfg) return '';
    if (cfg.serverDaily === false) return '网站关闭了每日自动生成，每天在练习页点“现在生成”就行。';
    if (!cfg.autoDaily) return '已关闭：不会自动生成，每天在练习页点“现在生成”。';
    const member = role() === 'member' ? '需要先在下面配好模型；连续 7 天没登录会暂停，回来点一下就能生成。' : '';
    return `每天 ${esc(fmtAt(cfg.dailyAt))} 自动准备今天的 ${cfg.dailyCount} 句。改成已经过了的时间，今天还没生成的话一分钟内就会生成。${member}`;
  }

  /** 时、分两个下拉框，样式和页面上其他输入框一样（不用浏览器自带的时间控件，它在各家浏览器里长得都不一样） */
  function timeHTML(on: boolean): string {
    if (!cfg) return '';
    const [h = '07', m = '50'] = cfg.dailyAt.split(':');
    const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
    // 分钟按 5 分钟一档；以前存的不在档上的时间也保留在列表里
    const mins = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'));
    if (!mins.includes(m)) {
      mins.push(m);
      mins.sort();
    }
    const select = (id: string, label: string, list: string[], value: string) =>
      `<span class="relative inline-flex">
        <select id="${id}" aria-label="${label}" ${on ? '' : 'disabled'} class="${C.select}">${list
          .map((v) => `<option value="${v}" ${v === value ? 'selected' : ''}>${v}</option>`)
          .join('')}</select>
        <svg class="pointer-events-none absolute top-1/2 right-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>
      </span>`;
    return `${select('taskHour', '时', hours, h)}<span class="font-mono text-[16px] text-muted">:</span>${select('taskMin', '分', mins, m)}`;
  }

  function autoHTML(): string {
    if (!cfg) return '';
    const server = cfg.serverDaily !== false;
    const on = server && cfg.autoDaily;
    return `<div class="flex flex-col gap-2 border-t border-line pt-3.5">
      ${switchHTML('auto', on, '每天自动生成', !server)}
      <div class="flex flex-wrap items-center gap-1.5 text-[14px] ${on ? '' : 'opacity-50'}">
        <label for="taskHour" class="mr-1">生成时间</label>
        ${timeHTML(on)}
        <span class="ml-1 text-[12.5px] text-muted">北京时间</span>
      </div>
      <span id="taskAutoHint" class="text-[12.5px] text-muted">${autoHint()}</span>
    </div>`;
  }

  /** “AI 批改”卡片：准确度提升开关，和开了之后多花 token 的说明 */
  function gradeHTML(): string {
    if (!cfg) return '';
    const on = cfg.accuracyBoost;
    return `<section class="${C.card} flex flex-col gap-3 px-4 pt-3.5 pb-4" aria-label="AI 批改">
      <div class="flex items-center gap-2"><span class="${C.label}">AI 批改</span><span id="gradeSaveState" class="ml-auto text-[12.5px]">${statusHTML('grade')}</span></div>
      ${switchHTML('boost', on, '准确度提升')}
      <span class="text-[13.5px] leading-[1.7]">${
        on
          ? '已开启：每次批改，后台会让模型独立评分 5 次、取平均分，再把这 5 次的意见汇总成一份批注给你看。'
          : '已关闭：每次批改只让模型评分 1 次。开启后会独立评分 5 次取平均分，再汇总成一份批注，减少单次评分的偶然性。'
      }</span>
      <div class="flex gap-2 rounded-xl bg-mid-soft px-3 py-2.5 text-[12.5px] leading-[1.7]">
        <svg class="mt-[3px] h-3.5 w-3.5 flex-none text-mid" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M8 1.8L15 14H1L8 1.8z"/><path d="M8 6.5v3.2M8 11.8v.1"/></svg>
        <span>开启此开关后会增大模型的 token 消耗量：每次批改要调用 6 次模型，用量约为关闭时的 6 倍，批改也会慢一些；但评分和批注会更准确。每天的批改次数仍按 1 次计算。</span>
      </div>
    </section>`;
  }

  function renderGrade(enter = false): void {
    if (!gradeRoot) return;
    gradeRoot.innerHTML = err ? '' : gradeHTML();
    if (enter) A.enter(gradeRoot.children);
  }

  function render(enter = false): void {
    renderGrade(enter);
    if (err) {
      root.innerHTML = `<div class="rounded-xl bg-bad-soft px-3.5 py-3 text-[14px]">读取每日任务设置失败：${esc(err)}</div>`;
      return;
    }
    if (!cfg) {
      root.innerHTML = '';
      return;
    }
    const both = cfg.levels.length > 1;
    root.innerHTML = `<section class="${C.card} flex flex-col gap-4 px-4 pt-3.5 pb-4" aria-label="每日任务">
      <div class="flex items-center gap-2"><span class="${C.label}">每日任务</span><span id="taskSaveState" class="ml-auto text-[12.5px]">${statusHTML()}</span></div>
      <div class="flex flex-col gap-2"><span class="text-[14px] font-semibold">难度（可以多选）</span>
        <div class="grid grid-cols-2 gap-2">${LEVELS.map((l) => {
          const on = cfg?.levels.includes(l.id);
          return `<button type="button" data-level="${l.id}" aria-pressed="${on}" class="flex cursor-pointer items-center gap-2.5 rounded-xl border-[1.5px] border-line bg-sheet px-3 py-2.5 text-left transition-colors aria-pressed:border-accent aria-pressed:bg-accent-soft">
            <span class="flex h-5 w-5 flex-none items-center justify-center rounded-md border-[1.5px] ${on ? 'border-accent bg-accent text-on-accent' : 'border-line'}">${on ? '<svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3.5 8.5l3 3 6-7"/></svg>' : ''}</span>
            <span class="flex flex-col"><b class="text-[15px] ${on ? 'text-accent' : ''}">${l.name}</b><span class="font-mono text-[11.5px] text-muted">${l.sub}</span></span></button>`;
        }).join('')}</div>
        <span class="text-[12.5px] text-muted">${both ? '两个都选：四级、六级各占一半，顺序随机。' : `只出${levelText(cfg.levels)}的句子。两个都选可以混合练。`}</span></div>
      ${sourceHTML(cfg)}
      <div class="flex flex-col gap-2"><span class="text-[14px] font-semibold">每天几句</span>
        <div class="flex items-center gap-3">
          <div class="inline-flex items-center rounded-full border-[1.5px] border-line bg-sheet">
            <button type="button" data-act="countMinus" aria-label="少一句" class="${C.step}" ${cfg.dailyCount <= 1 ? 'disabled' : ''}>−</button>
            <span id="taskCount" class="min-w-[2.4em] text-center font-mono text-[18px] tabular-nums" aria-live="polite">${cfg.dailyCount}</span>
            <button type="button" data-act="countPlus" aria-label="多一句" class="${C.step}" ${cfg.dailyCount >= cfg.maxDaily ? 'disabled' : ''}>+</button>
          </div>
          <span class="text-[14px] text-muted">句 / 天（最多 ${cfg.maxDaily} 句）</span>
        </div>
        <span class="text-[12.5px] text-muted">今天的已经生成了的话，调多了可以在练习页“补齐”；完成后还可以加练。</span></div>
      ${autoHTML()}
    </section>`;
    if (enter) A.enter(root.children);
  }

  /** 题目来源：三个选项 + 说明（题库只有四级） */
  function sourceHTML(c: PracticeSettings): string {
    const cur = c.questionSource;
    const note =
      cur === 'ai'
        ? '每次让 AI 原创新句子，要配好模型，加练占每日出题次数。'
        : !c.levels.includes('CET-4')
          ? '题库只有四级真题，只选六级时用不到题库，照旧 AI 出题。'
          : `四级从真题阅读里抽（抽过的不会再抽，不用模型、不占出题次数）${cur === 'bank' ? '，题库抽完了就少几句' : '，题库不够的再让 AI 出'}${c.levels.includes('CET-6') ? '；六级照旧 AI 出题' : ''}。`;
    return `<div class="flex flex-col gap-2"><span class="text-[14px] font-semibold">题目来源</span>
      <div class="grid grid-cols-3 gap-2" role="radiogroup" aria-label="题目来源">${SOURCES.map((s) => {
        const on = s.id === cur;
        return `<button type="button" role="radio" data-source="${s.id}" aria-checked="${on}" class="flex cursor-pointer flex-col items-start gap-0.5 rounded-xl border-[1.5px] border-line bg-sheet px-2.5 py-2 text-left transition-colors aria-checked:border-accent aria-checked:bg-accent-soft">
          <b class="text-[14.5px] ${on ? 'text-accent' : ''}">${s.name}</b><span class="text-[11.5px] leading-snug text-muted">${s.sub}</span></button>`;
      }).join('')}</div>
      <span class="text-[12.5px] text-muted">${note}</span></div>`;
  }

  function setStatus(st: string): void {
    status = st;
    const el = root.querySelector('#taskSaveState');
    if (el) el.innerHTML = statusHTML('task');
    const g = gradeRoot?.querySelector('#gradeSaveState');
    if (g) g.innerHTML = statusHTML('grade');
  }

  // 连续点加减号时只保存最后一次。rerender=false：只改提示，不重画整张卡片（改时间时不打断时间选择器）
  function save(patch: Partial<PracticeSettings>, { rerender = true } = {}): void {
    if (!cfg) return;
    cfg = { ...cfg, ...patch };
    statusOf = 'accuracyBoost' in patch ? 'grade' : 'task';
    if (rerender) render();
    else {
      const hint = root.querySelector('#taskAutoHint');
      if (hint) hint.innerHTML = autoHint();
    }
    setStatus('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      if (!cfg) return;
      try {
        const { levels, questionSource, dailyCount, autoDaily, dailyAt, accuracyBoost } = cfg;
        cfg = await api.savePracticeSettings({ levels, questionSource, dailyCount, autoDaily, dailyAt, accuracyBoost });
        setStatus('saved');
        onChange?.(cfg);
      } catch (e) {
        const msg = (e as Error).message;
        setStatus(msg);
        toast?.(`保存失败：${msg}`);
      }
    }, 350);
  }

  root.addEventListener('click', (e) => {
    const c = cfg;
    if (!c) return;
    const lv = closest(e, '[data-level]');
    if (lv) {
      const id = lv.dataset.level as Level;
      const on = c.levels.includes(id);
      if (on && c.levels.length === 1) {
        A.shake(lv);
        toast?.('至少要选一个：四级或六级');
        return;
      }
      const levels = on
        ? c.levels.filter((x) => x !== id)
        : LEVELS.map((l) => l.id).filter((x) => x === id || c.levels.includes(x));
      save({ levels });
      A.pop(root.querySelector(`[data-level="${id}"]`));
      return;
    }
    const src = closest(e, '[data-source]');
    if (src) {
      const id = src.dataset.source as QuestionSource;
      if (id !== c.questionSource) save({ questionSource: id });
      return;
    }
    const a = closest(e, '[data-act]');
    if (!a) return;
    if (a.dataset.act === 'auto') {
      save({ autoDaily: !c.autoDaily });
      return;
    }
    if (a.dataset.act === 'countMinus' && c.dailyCount > 1) save({ dailyCount: c.dailyCount - 1 });
    if (a.dataset.act === 'countPlus' && c.dailyCount < c.maxDaily) save({ dailyCount: c.dailyCount + 1 });
    A.pop(root.querySelector('#taskCount'));
  });

  gradeRoot?.addEventListener('click', (e) => {
    const c = cfg;
    if (!c || !closest(e, '[data-act="boost"]')) return;
    const on = !c.accuracyBoost;
    save({ accuracyBoost: on });
    toast?.(on ? '准确度提升已开启：批改更准，token 用量约为原来的 6 倍' : '准确度提升已关闭：每次批改只评分 1 次');
  });

  // 选好时或分就保存（不重画卡片，免得打断正在选的下拉框）
  root.addEventListener('change', (e) => {
    const id = (e.target as HTMLElement).id;
    if ((id !== 'taskHour' && id !== 'taskMin') || !cfg) return;
    const h = root.querySelector<HTMLSelectElement>('#taskHour')?.value;
    const m = root.querySelector<HTMLSelectElement>('#taskMin')?.value;
    if (!h || !m) return;
    const v = `${h}:${m}`;
    if (v !== cfg.dailyAt) save({ dailyAt: v }, { rerender: false });
  });

  return { load, render, editing, hasData: () => Boolean(cfg), get: () => cfg };
}
