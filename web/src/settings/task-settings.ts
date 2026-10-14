// “设置”页里的“每日任务”卡片：出四级还是六级（可以都选，混合随机）、每天几句（1–10）、
// 每天几点自动生成（北京时间，也可以关掉）。改了自动保存。
import type { AccountRole, Level, PracticeSettings } from '@sentence-site/shared';
import { api } from '../lib/api.ts';
import { closest } from '../lib/dom.ts';
import { esc } from '../lib/format.ts';
import * as A from '../lib/anim.ts';
import type { Toast } from '../lib/toast.ts';

export const LEVELS: { id: Level; name: string; sub: string }[] = [
  { id: 'CET-4', name: '四级', sub: 'CET-4' },
  { id: 'CET-6', name: '六级', sub: 'CET-6' },
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
  step: 'flex h-10 w-10 cursor-pointer items-center justify-center text-[20px] leading-none transition-colors hover:text-accent disabled:cursor-not-allowed disabled:opacity-35',
};

/** role()：当前账户是 owner 还是 member（邀请账户的提示多一句） */
export function createTaskSettings({
  root,
  toast,
  onChange,
  role = () => 'owner',
}: {
  root: HTMLElement;
  toast?: Toast;
  onChange?: (cfg: PracticeSettings) => void;
  role?: () => AccountRole | undefined;
}) {
  let cfg: PracticeSettings | null = null;
  let err = '';
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let status = ''; // saving | saved | 错误信息

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
  const editing = () => status === 'saving' || root.contains(document.activeElement);

  function statusHTML(): string {
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

  function autoHTML(): string {
    if (!cfg) return '';
    const server = cfg.serverDaily !== false;
    const on = server && cfg.autoDaily;
    return `<div class="flex flex-col gap-2 border-t border-line pt-3.5">
      <button type="button" role="switch" aria-checked="${on}" data-act="auto" ${server ? '' : 'disabled'} class="group flex w-max cursor-pointer items-center gap-2.5 text-[14px] font-semibold select-none disabled:cursor-not-allowed disabled:opacity-50">
        <span class="relative h-[23px] w-10 flex-none rounded-full bg-line transition-colors group-aria-checked:bg-accent"><span class="absolute top-[3px] left-[3px] h-[17px] w-[17px] rounded-full bg-sheet transition-transform group-aria-checked:translate-x-[17px]"></span></span>每天自动生成</button>
      <div class="flex flex-wrap items-center gap-2 text-[14px] ${on ? '' : 'opacity-50'}">
        <label for="taskAt">生成时间</label>
        <input id="taskAt" type="time" step="60" required value="${esc(cfg.dailyAt)}" ${on ? '' : 'disabled'}
          class="min-w-[7em] rounded-xl border-[1.5px] border-line bg-sheet px-2.5 py-1.5 font-mono text-[15px] tabular-nums outline-none transition-colors focus:border-accent disabled:cursor-not-allowed">
        <span class="text-[12.5px] text-muted">北京时间</span>
      </div>
      <span id="taskAutoHint" class="text-[12.5px] text-muted">${autoHint()}</span>
    </div>`;
  }

  function render(enter = false): void {
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

  function setStatus(st: string): void {
    status = st;
    const el = root.querySelector('#taskSaveState');
    if (el) el.innerHTML = statusHTML();
  }

  // 连续点加减号时只保存最后一次。rerender=false：只改提示，不重画整张卡片（改时间时不打断时间选择器）
  function save(patch: Partial<PracticeSettings>, { rerender = true } = {}): void {
    if (!cfg) return;
    cfg = { ...cfg, ...patch };
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
        const { levels, dailyCount, autoDaily, dailyAt } = cfg;
        cfg = await api.savePracticeSettings({ levels, dailyCount, autoDaily, dailyAt });
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

  // 时间选好（change）才保存；清空了就恢复原来的时间
  root.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    if (input.id !== 'taskAt' || !cfg) return;
    const v = input.value;
    if (!/^\d{2}:\d{2}$/.test(v)) {
      input.value = cfg.dailyAt;
      return;
    }
    if (v !== cfg.dailyAt) save({ dailyAt: v }, { rerender: false });
  });

  return { load, render, editing, hasData: () => Boolean(cfg), get: () => cfg };
}
