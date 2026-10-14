// 登录页：输入访问密码或邀请码
import { api, setUnauthorizedHandler } from './lib/api.ts';
import * as A from './lib/anim.ts';
import { $ } from './lib/dom.ts';
import { state } from './state.ts';
import { start } from './practice/data.ts';

export function showLock(show: boolean): void {
  $('lock').classList.toggle('hidden', !show);
  $('lock').classList.toggle('flex', show);
  $('app').classList.toggle('hidden', show);
  if (show) setTimeout(() => $('lockInput').focus(), 50);
}

export function initLock(): void {
  setUnauthorizedHandler(() => showLock(true));
  $('lockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $<HTMLButtonElement>('lockBtn');
    const err = $('lockErr');
    const input = $<HTMLInputElement>('lockInput');
    btn.disabled = true;
    err.classList.add('hidden');
    try {
      const r = await api.unlock(input.value);
      input.value = '';
      // 页面上已经有别的账户（或过期前）的数据时，整页刷新，免得混在一起
      if (state.loaded) {
        location.reload();
        return;
      }
      if (r.unlocked) state.me = { role: r.role, name: r.name };
      showLock(false);
      await start();
    } catch (ex) {
      err.textContent = (ex as Error).message;
      err.classList.remove('hidden');
      A.shake($('lockForm'));
    } finally {
      btn.disabled = false;
    }
  });
}
