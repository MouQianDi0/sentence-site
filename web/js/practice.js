// “设置”页里的“每日任务”卡片：出四级还是六级（可以都选，混合随机）、每天几句（1–10）。改了自动保存。
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

const C = {
  card: 'rounded-2xl border border-line bg-sheet',
  label: 'font-mono text-[11px] tracking-[.1em] uppercase text-muted',
  step: 'flex h-10 w-10 cursor-pointer items-center justify-center text-[20px] leading-none transition-colors hover:text-accent disabled:cursor-not-allowed disabled:opacity-35',
};

export function createTaskSettings({ root, toast, onChange }) {
  let cfg = null;
  let err = '';
  let saveTimer = null;
  let status = ''; // saving | saved | 错误信息

  async function open() {
    err = '';
    status = '';
    try {
      cfg = await api.practiceSettings();
    } catch (e) {
      err = e.message;
    }
    render();
    if (root.firstElementChild) A.enter(root.children);
  }

  function statusHTML() {
    if (status === 'saving') return '<span class="text-muted">保存中…</span>';
    if (status === 'saved') return '<span class="text-ok">已保存</span>';
    return status ? `<span class="text-bad">${esc(status)}</span>` : '';
  }

  function render() {
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
        <span class="text-[12.5px] text-muted">${cfg.autoDaily ? `每天 ${esc(cfg.dailyAt)} 自动生成今天的句子。` : ''}今天的已经生成了的话，调多了可以在练习页“补齐”；完成后还可以加练。</span></div>
    </section>`;
  }

  function setStatus(s) {
    status = s;
    const el = root.querySelector('#taskSaveState');
    if (el) el.innerHTML = statusHTML();
  }

  // 连续点加减号时只保存最后一次
  function save(patch) {
    cfg = { ...cfg, ...patch };
    render();
    setStatus('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        cfg = await api.savePracticeSettings({ levels: cfg.levels, dailyCount: cfg.dailyCount });
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
    if (a.dataset.act === 'countMinus' && cfg.dailyCount > 1) save({ dailyCount: cfg.dailyCount - 1 });
    if (a.dataset.act === 'countPlus' && cfg.dailyCount < cfg.maxDaily) save({ dailyCount: cfg.dailyCount + 1 });
    A.pop(root.querySelector('#taskCount'));
  });

  return { open, get: () => cfg };
}
