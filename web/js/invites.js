// “设置”页里的“邀请码”卡片（只有你自己看得到）：生成邀请码、复制发给别人、删除。
// 每个邀请码对应一个独立账户；删除邀请码会同时删除这个账户和它的全部数据。
import { api } from './api.js';
import { esc, fmtTime } from './text.js';
import * as A from './anim.js';

const C = {
  card: 'rounded-2xl border border-line bg-sheet',
  label: 'font-mono text-[11px] tracking-[.1em] uppercase text-muted',
  input: 'w-full min-w-0 rounded-xl border-[1.5px] border-line bg-sheet px-3 py-2 text-[15px] outline-none transition-colors focus:border-accent',
  btn: 'cursor-pointer rounded-full border-[1.5px] border-line bg-sheet px-3 py-1.5 text-[13.5px] transition-transform active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-45',
  btnPrimary: 'flex-none cursor-pointer rounded-full border-[1.5px] border-accent bg-accent px-4 py-2 text-[14.5px] font-semibold text-on-accent transition-transform active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-45',
};

/** 网站现在是 http，浏览器的剪贴板接口用不了，退回到老办法 */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续用下面的办法
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

export function createInvites({ root, toast }) {
  let list = null;
  let err = '';
  let busy = false;
  let fresh = null; // 刚生成的邀请码 id，列表里高亮一下
  let armed = null; // 点了一次“删除”、等确认的邀请码 id
  let armTimer = null;

  async function open() {
    err = '';
    armed = null;
    try {
      list = (await api.invites()).invites;
    } catch (e) {
      err = e.message;
    }
    render();
    if (root.firstElementChild) A.enter(root.children);
  }

  function itemHTML(x) {
    const seen = x.lastSeenAt ? `最近使用 ${fmtTime(x.lastSeenAt)}` : '还没登录过';
    const confirming = armed === x.id;
    return `<li data-id="${esc(x.id)}" class="flex flex-col gap-2 rounded-xl border-[1.5px] px-3.5 py-3 ${x.id === fresh ? 'border-accent bg-accent-soft' : 'border-line'}">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <b class="min-w-0 truncate text-[15px]">${esc(x.note || '未命名')}</b>
        <span class="font-mono text-[16px] tracking-[.06em] select-all">${esc(x.code)}</span>
        <button type="button" data-act="copy" class="${C.btn} ml-auto">复制</button>
      </div>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted">
        <span>创建于 ${fmtTime(x.createdAt)}</span><span>${seen}</span>
        <button type="button" data-act="delete" class="ml-auto cursor-pointer rounded-full border-[1.5px] px-3 py-1 text-[13px] ${confirming ? 'border-bad bg-bad-soft text-bad' : 'border-line bg-sheet text-muted'}">${confirming ? '确认删除？账户和数据一起删' : '删除'}</button>
      </div>
    </li>`;
  }

  function render() {
    if (err) {
      root.innerHTML = `<div class="rounded-xl bg-bad-soft px-3.5 py-3 text-[14px]">读取邀请码失败：${esc(err)}</div>`;
      return;
    }
    if (!list) {
      root.innerHTML = '';
      return;
    }
    root.innerHTML = `<section class="${C.card} flex flex-col gap-3.5 px-4 pt-3.5 pb-4" aria-label="邀请码">
      <div class="flex items-center gap-2"><span class="${C.label}">邀请码</span><span class="ml-auto text-[12.5px] text-muted">${list.length ? `共 ${list.length} 个` : ''}</span></div>
      <p class="m-0 text-[13.5px] text-muted">每个邀请码对应一个独立账户：对方在登录页输入邀请码就能用。句库、练习记录、每日任务和模型配置都和你的分开，AI 用的是对方自己在“设置”里填的 API 密钥。删除邀请码会同时删除这个账户和它的全部数据。</p>
      <form data-form class="flex gap-2">
        <label for="inviteNote" class="sr-only">备注名</label>
        <input id="inviteNote" maxlength="30" autocomplete="off" placeholder="备注名，比如 小王" class="${C.input}">
        <button class="${C.btnPrimary}" ${busy ? 'disabled' : ''}>${busy ? '生成中…' : '生成邀请码'}</button>
      </form>
      ${list.length ? `<ul class="m-0 flex list-none flex-col gap-2 p-0">${list.map(itemHTML).join('')}</ul>` : '<p class="m-0 text-[14px] text-muted">还没有邀请码。</p>'}
    </section>`;
  }

  function disarm() {
    clearTimeout(armTimer);
    armed = null;
  }

  root.addEventListener('submit', async (e) => {
    if (!e.target.closest('[data-form]') || busy) return;
    e.preventDefault();
    const note = root.querySelector('#inviteNote').value.trim();
    busy = true;
    disarm();
    render();
    try {
      const { invite } = await api.createInvite(note);
      list = [invite, ...list];
      fresh = invite.id;
      toast && toast('邀请码已生成，点“复制”发给对方');
    } catch (ex) {
      toast && toast(`生成失败：${ex.message}`);
    } finally {
      busy = false;
      render();
      A.pop(root.querySelector(`[data-id="${CSS.escape(fresh || '')}"]`));
    }
  });

  root.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-act]');
    const li = e.target.closest('[data-id]');
    if (!a || !li || !list) return;
    const x = list.find((i) => i.id === li.dataset.id);
    if (!x) return;
    if (a.dataset.act === 'copy') {
      const ok = await copyText(x.code);
      toast && toast(ok ? `已复制 ${x.code}` : '复制不了，长按邀请码手动复制');
      return;
    }
    if (a.dataset.act === 'delete') {
      if (armed !== x.id) {
        disarm();
        armed = x.id;
        armTimer = setTimeout(() => {
          armed = null;
          render();
        }, 4000);
        render();
        return;
      }
      disarm();
      a.disabled = true;
      try {
        await api.deleteInvite(x.id);
        list = list.filter((i) => i.id !== x.id);
        toast && toast(`已删除 ${x.note || x.code} 的账户和数据`);
      } catch (ex) {
        toast && toast(`删除失败：${ex.message}`);
      }
      render();
    }
  });

  return { open };
}

/** “设置”页最下面的账户卡片：当前是谁、退出登录 */
export function accountHTML(me) {
  const who = me.role === 'owner' ? '管理员（你自己）' : `邀请账户 · ${esc(me.name || '未命名')}`;
  return `<section class="${C.card} flex flex-wrap items-center gap-3 px-4 py-3.5" aria-label="账户">
    <span class="flex min-w-0 flex-col gap-0.5"><span class="${C.label}">账户</span><span class="text-[15px]">${who}</span></span>
    <button type="button" data-act="logout" class="${C.btn} ml-auto">退出登录</button>
  </section>`;
}
