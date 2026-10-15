// 登录页：输入访问密码或邀请码
import { api, setUnauthorizedHandler } from './lib/api.ts';
import * as A from './lib/anim.ts';
import { $ } from './lib/dom.ts';
import { daysUntil, fmtDate } from './lib/format.ts';
import { toast } from './lib/toast.ts';
import { state, type Me } from './state.ts';
import { start } from './practice/data.ts';

/** notice：为什么要重新登录（比如邀请码过期了），显示在输入框下面 */
export function showLock(show: boolean, notice = ''): void {
  $('lock').classList.toggle('hidden', !show);
  $('lock').classList.toggle('flex', show);
  $('app').classList.toggle('hidden', show);
  if (show && notice) {
    $('lockErr').textContent = notice;
    $('lockErr').classList.remove('hidden');
  }
  if (show) setTimeout(() => $('lockInput').focus(), 50);
}

/** 邀请码 7 天内到期时提醒一下（登录后、打开网站时） */
export function remindExpiry(me: Me | null): void {
  if (me?.role !== 'member' || !me.expiresAt) return;
  const left = daysUntil(me.expiresAt);
  if (left > 7) return;
  toast(`邀请码${fmtDate(me.expiresAt)}到期（还剩 ${Math.max(1, left)} 天），到期前找管理员续期`);
}

export function initLock(): void {
  setUnauthorizedHandler((notice) => showLock(true, notice));
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
      if (r.unlocked) state.me = { role: r.role, name: r.name, expiresAt: r.expiresAt ?? null };
      showLock(false);
      remindExpiry(state.me);
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
