// 确认框：退出登录这类需要再问一次的操作。返回 Promise<boolean>（点确认是 true）。
// 点背景、按 Esc 或点“取消”都算取消；打开时焦点在“取消”上，免得误按回车就执行了。
import { esc } from './format.ts';
import * as A from './anim.ts';

const BTN =
  'cursor-pointer rounded-full border-[1.5px] px-4 py-2 text-[14.5px] transition-transform active:scale-[.97]';

let seq = 0;

export interface ConfirmOptions {
  title: string;
  body?: string;
  ok?: string;
  cancel?: string;
  /** 确认按钮用红色（退出、删除这类） */
  danger?: boolean;
}

export function confirmDialog({
  title,
  body = '',
  ok = '确定',
  cancel = '取消',
  danger = false,
}: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const id = `dlg${++seq}`;
    const back = document.createElement('div');
    back.className =
      'fixed inset-0 z-50 flex items-end justify-center bg-black/45 px-4 pb-[calc(16px+env(safe-area-inset-bottom,0px))] sm:items-center sm:pb-0';
    back.innerHTML = `<div role="alertdialog" aria-modal="true" aria-labelledby="${id}t" aria-describedby="${id}b"
      class="flex w-full max-w-sm flex-col gap-3 rounded-2xl border border-line bg-sheet p-5 shadow-[0_18px_48px_-12px_rgba(0,0,0,.4)]">
      <h2 id="${id}t" class="m-0 text-[17px] font-semibold">${esc(title)}</h2>
      ${body ? `<p id="${id}b" class="m-0 text-[14px] leading-relaxed text-muted">${esc(body)}</p>` : ''}
      <div class="mt-1 flex justify-end gap-2">
        <button type="button" data-v="0" class="${BTN} border-line bg-sheet">${esc(cancel)}</button>
        <button type="button" data-v="1" class="${BTN} font-semibold ${danger ? 'border-bad bg-bad text-on-accent' : 'border-accent bg-accent text-on-accent'}">${esc(ok)}</button>
      </div>
    </div>`;
    const panel = back.firstElementChild as HTMLElement;
    const prevFocus = document.activeElement as HTMLElement | null;
    let closed = false;

    function close(v: boolean) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      A.dialogOut(back, panel, () => {
        back.remove();
        prevFocus?.focus?.({ preventScroll: true });
      });
      resolve(v);
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
      } else if (e.key === 'Tab') {
        // 焦点只在两个按钮之间转
        const btns = [...panel.querySelectorAll('button')];
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        e.preventDefault();
        btns[(i + (e.shiftKey ? btns.length - 1 : 1)) % btns.length]?.focus();
      }
    }

    back.addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLElement>('[data-v]');
      if (b) close(b.dataset.v === '1');
      else if (e.target === back) close(false);
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(back);
    A.dialogIn(back, panel);
    panel.querySelector<HTMLElement>('[data-v="0"]')?.focus({ preventScroll: true });
  });
}
