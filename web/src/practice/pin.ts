// 固定句子：点图钉后句子卡片吸在屏幕顶部，往下看步骤和讲解时句子一直在；太高时卡片里面自己滚动。
// 设置记在本机，换句子、刷新后还在
import * as A from '../lib/anim.ts';
import { $ } from '../lib/dom.ts';
import { toast } from '../lib/toast.ts';
import { state, saveUI } from '../state.ts';

const PIN_CLS = [
  'sticky',
  'top-[max(8px,env(safe-area-inset-top))]',
  'z-20',
  'max-h-[60vh]',
  'overflow-y-auto',
  'overscroll-contain',
];

/** 卡片真的吸在顶部时加上阴影 */
function updStuck(): void {
  const el = $('sheet');
  const top = parseFloat(getComputedStyle(el).top);
  el.toggleAttribute('data-stuck', !!state.ui.pin && window.scrollY > 0 && el.getBoundingClientRect().top <= top + 0.5);
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
}
