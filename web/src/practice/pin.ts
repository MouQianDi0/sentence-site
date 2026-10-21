// 固定句子：点图钉后句子卡片吸在屏幕顶部，往下看步骤和讲解时句子一直在；太高时卡片里面自己滚动。
// 设置记在本机，换句子、刷新后还在。
// 手机上弹出键盘时（Chrome 默认只缩小可见区域，不缩小布局视口），按 visualViewport 把卡片贴到看得见的顶部、
// 压矮一些，并把正在输入的框挪到卡片下面，免得被卡片或键盘挡住
import * as A from '../lib/anim.ts';
import { $ } from '../lib/dom.ts';
import { toast } from '../lib/toast.ts';
import { state, saveUI } from '../state.ts';

const PIN_CLS = [
  'sticky',
  'top-[calc(max(8px,env(safe-area-inset-top))+var(--vv-top,0px))]',
  'z-20',
  'max-h-[var(--pin-max,60vh)]',
  'overflow-y-auto',
  'overscroll-contain',
];

/** 键盘弹出时卡片最多占可见高度的比例，留出地方给输入框 */
const KB_RATIO = 0.35;

/** 卡片真的吸在顶部时加上阴影 */
function updStuck(): void {
  const el = $('sheet');
  const top = parseFloat(getComputedStyle(el).top);
  el.toggleAttribute('data-stuck', !!state.ui.pin && window.scrollY > 0 && el.getBoundingClientRect().top <= top + 0.5);
}

/** 键盘是不是开着：可见区域明显比布局视口矮（乘 scale 排除双指放大） */
function keyboardOpen(): boolean {
  const vv = window.visualViewport;
  return !!vv && vv.height * vv.scale < document.documentElement.clientHeight * 0.8;
}

/** 卡片外面正在输入的框 */
function editingOutside(): HTMLElement | null {
  const a = document.activeElement;
  if (!(a instanceof HTMLElement) || $('sheet').contains(a)) return null;
  return a.matches('textarea, input, [contenteditable="true"]') ? a : null;
}

/** 按可见区域更新卡片位置和高度；move：键盘开着时把输入框挪到卡片下面、键盘上面 */
function fitViewport(move = true): void {
  const el = $('sheet');
  const vv = window.visualViewport;
  const kb = !!state.ui.pin && keyboardOpen();
  if (!vv || !kb) {
    el.style.removeProperty('--vv-top');
    el.style.removeProperty('--pin-max');
    return;
  }
  el.style.setProperty('--vv-top', `${Math.max(0, vv.offsetTop)}px`);
  el.style.setProperty('--pin-max', `${Math.round(vv.height * KB_RATIO)}px`);
  const f = move && editingOutside();
  if (!f) return;
  const below = el.getBoundingClientRect().bottom + 8;
  const end = vv.offsetTop + vv.height - 8;
  const r = f.getBoundingClientRect();
  let d = 0;
  if (r.top < below) d = r.top - below;
  else if (r.bottom > end) d = Math.min(r.bottom - end, r.top - below);
  if (Math.abs(d) > 1) window.scrollBy({ top: d, behavior: 'auto' });
}

/** scroll：刚点图钉时把句子卡片滚到屏幕顶部，马上看到效果 */
function applyPin(scroll = false): void {
  const on = !!state.ui.pin;
  const b = $('pin');
  const el = $('sheet');
  b.setAttribute('aria-pressed', String(on));
  b.setAttribute('aria-label', on ? '取消固定句子' : '把句子固定在屏幕顶部');
  b.title = on ? '取消固定' : '固定句子';
  PIN_CLS.forEach((c) => el.classList.toggle(c, on));
  // 下面的内容很短时页面滚不动，卡片就到不了顶部；固定期间给练习区补足一屏高度
  $('work').classList.toggle('min-h-[calc(100dvh-8px)]', on);
  fitViewport();
  if (on && scroll) {
    const top = parseFloat(getComputedStyle(el).top) || 8;
    const d = el.getBoundingClientRect().top - top;
    if (d > 1) window.scrollTo({ top: window.scrollY + d, behavior: A.motion ? 'smooth' : 'auto' });
  }
  updStuck();
}

export function initPin(): void {
  $('pin').onclick = () => {
    state.ui.pin = !state.ui.pin;
    saveUI();
    applyPin(true);
    toast(state.ui.pin ? '句子已固定在屏幕顶部，再点图钉取消' : '已取消固定');
  };
  applyPin();
  let raf = 0;
  window.addEventListener(
    'scroll',
    () => {
      if (!state.ui.pin || raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        updStuck();
      });
    },
    { passive: true },
  );
  // 键盘弹出、收起会改变可见区域；只在大小变化和刚聚焦时挪输入框，用户自己滚动时只跟着更新位置
  const vv = window.visualViewport;
  if (!vv) return;
  let vvRaf = 0;
  const onViewport = (move: boolean) => {
    if (!state.ui.pin) return;
    cancelAnimationFrame(vvRaf);
    vvRaf = requestAnimationFrame(() => {
      fitViewport(move);
      updStuck();
    });
  };
  vv.addEventListener('resize', () => onViewport(true));
  vv.addEventListener('scroll', () => onViewport(false));
  document.addEventListener('focusin', () => onViewport(true));
}
