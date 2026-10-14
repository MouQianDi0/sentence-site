// “设置”页里的“每日任务”卡片：出四级还是六级（可以都选，混合随机）、每天几句（1–10）、
// 每天几点自动生成（北京时间，也可以关掉）。改了自动保存。
import { api } from './api.js';
import { esc } from './text.js';
import * as A from './anim.js';

export const LEVELS = [
  { id: 'CET-4', name: '四级', sub: 'CET-4' },
  { id: 'CET-6', name: '六级', sub: 'CET-6' },
];

/** ['CET-4','CET-6'] → “四级 + 六级混合” */
export function levelText(levels = []) {
  const names = LEVELS.filter((l) => levels.includes(l.id)).map((l) => l.name);
  return names.length > 1 ? `${names.join(' + ')}混合` : names[0] || '';
}

/** 这个账户每天会不会自动生成：自己开着，服务器也没关 */
export const autoOn = (p) => Boolean(p?.autoDaily) && p?.serverDaily !== false;

/** '07:50' → '7:50'（页面上显示用） */
export const fmtAt = (s = '') => s.replace(/^0(\d)/, '$1');

const C = {
  card: 'rounded-2xl border border-line bg-sheet',
  label: 'font-mono text-[11px] tracking-[.1em] uppercase text-muted',
  step: 'flex h-10 w-10 cursor-pointer items-center justify-center text-[20px] leading-none transition-colors hover:text-accent disabled:cursor-not-allowed disabled:opacity-35',
};

/** role()：当前账户是 owner 还是 member（邀请账户的提示多一句） */
export function createTaskSettings({ root, toast, onChange, role = () => 'owner' }) {
  let cfg = null;
  let err = '';
  let saveTimer = null;
  let status = ''; // saving | saved | 错误信息

  /** 读取设置；返回数据有没有变化（设置页据此决定要不要重新画） */
  async function load() {
    try {
      const next = await api.practiceSettings();
      const changed = !cfg || JSON.stringify(next) !== JSON.stringify(cfg);
      cfg = next;
      err = '';
      return changed;
    } catch (e) {
      if (cfg) return false; // 有上次读到的数据就继续显示它
      const changed = err !== e.message;
      err = e.message;
      return changed;
    }
  }

  /** 正在保存、或者正在改时间：后台刷新时先别重画，免得打断 */
  const editing = () => status === 'saving' || root.contains(document.activeElement);

  function statusHTML() {
    if (status === 'saving') return '<span class="text-muted">保存中…</span>';
    if (status === 'saved') return '<span class="text-ok">已保存</span>';
    return status ? `<span class="text-bad">${esc(status)}</span>` : '';
  }

  function autoHint() {
    if (cfg.serverDaily === false) return '网站关闭了每日自动生成，每天在练习页点“现在生成”就行。';
    if (!cfg.autoDaily) return '已关闭：不会自动生成，每天在练习页点“现在生成”。';
    const member = role() === 'member' ? '需要先在下面配好模型；连续 7 天没登录会暂停，回来点一下就能生成。' : '';
    return `每天 ${esc(fmtAt(cfg.dailyAt))} 自动准备今天的 ${cfg.dailyCount} 句。改成已经过了的时间，今天还没生成的话一分钟内就会生成。${member}`;
  }

  function autoHTML() {
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

  function render(enter = false) {
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
          const on = cfg.levels.includes(l.id);
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

  function setStatus(s) {
    status = s;
    const el = root.querySelector('#taskSaveState');
    if (el) el.innerHTML = statusHTML();
  }

  // 连续点加减号时只保存最后一次。rerender=false：只改提示，不重画整张卡片（改时间时不打断时间选择器）
  function save(patch, { rerender = true } = {}) {
    cfg = { ...cfg, ...patch };
    if (rerender) render();
    else {
      const hint = root.querySelector('#taskAutoHint');
      if (hint) hint.innerHTML = autoHint();
    }
    setStatus('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        cfg = await api.savePracticeSettings({ levels: cfg.levels, dailyCount: cfg.dailyCount, autoDaily: cfg.autoDaily, dailyAt: cfg.dailyAt });
        setStatus('saved');
        onChange && onChange(cfg);
      } catch (e) {
        setStatus(e.message);
        toast && toast(`保存失败：${e.message}`);
      }
    }, 350);
  }

  root.addEventListener('click', (e) => {
    if (!cfg) return;
    const lv = e.target.closest('[data-level]');
    if (lv) {
      const id = lv.dataset.level;
      const on = cfg.levels.includes(id);
      if (on && cfg.levels.length === 1) {
        A.shake(lv);
        toast && toast('至少要选一个：四级或六级');
        return;
      }
      const levels = on ? cfg.levels.filter((x) => x !== id) : LEVELS.map((l) => l.id).filter((x) => x === id || cfg.levels.includes(x));
      save({ levels });
      A.pop(root.querySelector(`[data-level="${id}"]`));
      return;
    }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'auto') {
      save({ autoDaily: !cfg.autoDaily });
      return;
    }
    if (a.dataset.act === 'countMinus' && cfg.dailyCount > 1) save({ dailyCount: cfg.dailyCount - 1 });
    if (a.dataset.act === 'countPlus' && cfg.dailyCount < cfg.maxDaily) save({ dailyCount: cfg.dailyCount + 1 });
    A.pop(root.querySelector('#taskCount'));
  });

  // 时间选好（change）才保存；清空了就恢复原来的时间
  root.addEventListener('change', (e) => {
    if (e.target.id !== 'taskAt' || !cfg) return;
    const v = e.target.value;
    if (!/^\d{2}:\d{2}$/.test(v)) {
      e.target.value = cfg.dailyAt;
      return;
    }
    if (v !== cfg.dailyAt) save({ dailyAt: v }, { rerender: false });
  });

  return { load, render, editing, hasData: () => Boolean(cfg), get: () => cfg };
}
