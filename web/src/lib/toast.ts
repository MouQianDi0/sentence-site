// 屏幕底部的提示条：一句话，可以带一个按钮（比如“去练习”）
import { $ } from './dom.ts';
import { esc } from './format.ts';
import * as A from './anim.ts';

export interface ToastAction {
  label: string;
  fn: () => void;
}

let timer: ReturnType<typeof setTimeout> | undefined;

export function toast(msg: string, action?: ToastAction): void {
  const t = $('toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="flex-none cursor-pointer rounded-full bg-accent px-3 py-1 text-[13.5px] font-semibold whitespace-nowrap text-on-accent">${esc(action.label)}</button>` : ''}`;
  t.style.paddingRight = action ? '8px' : '18px';
  const btn = t.querySelector('button');
  if (action && btn) {
    btn.onclick = () => {
      action.fn();
      A.toastOut(t);
    };
  }
  A.toastIn(t);
  clearTimeout(timer);
  timer = setTimeout(() => A.toastOut(t), action ? 7000 : 2600);
}

export type Toast = typeof toast;
