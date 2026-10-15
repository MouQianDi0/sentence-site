// 邀请码管理（只有你自己看得到）：从“设置”页的“邀请码管理”点进来的单独页面。
// 生成邀请码、复制发给别人、删除。每个邀请码对应一个独立账户；删除邀请码会同时删除这个账户和它的全部数据。
// 每个邀请码最多能在几台设备上登录（默认 2，可以调），能看到登录过的设备并移除；也能看到每个账户用掉的 token。
import type { AccountRole, Invite } from '@sentence-site/shared';
import { api } from '../lib/api.ts';
import { closest } from '../lib/dom.ts';
import { esc, fmtTime, fmtTokens } from '../lib/format.ts';
import * as A from '../lib/anim.ts';
import type { Toast } from '../lib/toast.ts';

const C = {
  card: 'rounded-2xl border border-line bg-sheet',
  label: 'font-mono text-[11px] tracking-[.1em] uppercase text-muted',
  input:
    'w-full min-w-0 rounded-xl border-[1.5px] border-line bg-sheet px-3 py-2 text-[15px] outline-none transition-colors focus:border-accent',
  btn: 'cursor-pointer rounded-full border-[1.5px] border-line bg-sheet px-3 py-1.5 text-[13.5px] transition-transform active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-45',
  btnPrimary:
    'flex-none cursor-pointer rounded-full border-[1.5px] border-accent bg-accent px-4 py-2 text-[14.5px] font-semibold text-on-accent transition-transform active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-45',
  spin: 'inline-block h-4 w-4 flex-none animate-spin rounded-full border-2 border-line border-t-accent',
};

const ICON = {
  back: '<svg class="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.5L5.5 8l4.5 4.5"/></svg>',
  next: '<svg class="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5"/></svg>',
  ticket:
    '<svg class="h-[18px] w-[18px]" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h11A1.5 1.5 0 0 1 17 6.5V8a2 2 0 0 0 0 4v1.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 13.5V12a2 2 0 0 0 0-4z"/><path d="M12 5.5v1.5M12 9.25v1.5M12 13v1.5" stroke-linecap="round"/></svg>',
};

/** 复制到剪贴板：HTTPS 下用浏览器的剪贴板接口；还是 http 或者接口不能用时，退回到老办法 */
async function copyText(text: string): Promise<boolean> {
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

/**
 * root：邀请码页面的容器。onBack：点“← 设置”。onChange：邀请码列表变了（设置页入口上的数字跟着变）。
 * 数据由设置页统一读取（load），读好之前不显示，免得页面一块一块跳出来。
 */
export function createInvites({
  root,
  toast,
  onBack,
  onChange,
}: {
  root: HTMLElement;
  toast?: Toast;
  onBack?: () => void;
  onChange?: () => void;
}) {
  let list: Invite[] | null = null;
  let err = '';
  let busy = false;
  let fresh: string | null = null; // 刚生成的邀请码 id，列表里高亮一下
  let armed: string | null = null; // 点了一次、等确认的操作：inv:<邀请码 id> 或 dev:<邀请码 id>:<设备 id>
  let armTimer: ReturnType<typeof setTimeout> | undefined;

  /** 读取邀请码列表；返回数据有没有变化 */
  async function load(): Promise<boolean> {
    try {
      const next = (await api.invites()).invites;
      const changed = !list || JSON.stringify(next) !== JSON.stringify(list);
      list = next;
      err = '';
      return changed;
    } catch (e) {
      if (list) return false; // 有上次读到的数据就继续显示它
      const msg = (e as Error).message;
      const changed = err !== msg;
      err = msg;
      return changed;
    }
  }

  const changed = () => onChange?.();

  /** 设置页入口上显示的摘要：几个邀请码、几台设备在用 */
  function summary(): { count: number; devices: number } | null {
    if (!list) return null;
    return { count: list.length, devices: list.reduce((n, x) => n + x.devices.length, 0) };
  }

  const stepBtn =
    'flex h-7 w-7 cursor-pointer items-center justify-center text-[17px] leading-none transition-colors hover:text-accent disabled:cursor-not-allowed disabled:opacity-35';

  function devicesHTML(x: Invite): string {
    const rows = x.devices
      .map((d) => {
        const sure = armed === `dev:${x.id}:${d.id}`;
        return `<li class="flex items-center gap-2 text-[13px]">
          <span class="flex min-w-0 flex-col"><span class="truncate">${esc(d.label || '未知设备')}</span>
            <span class="truncate text-[12px] text-muted">最近 ${fmtTime(d.lastSeen)}${d.ip ? ` · ${esc(d.ip)}` : ''}</span></span>
          <button type="button" data-act="rmDevice" data-dev="${esc(d.id)}" class="ml-auto flex-none cursor-pointer rounded-full border-[1.5px] px-2.5 py-0.5 text-[12.5px] ${sure ? 'border-bad bg-bad-soft text-bad' : 'border-line bg-sheet text-muted'}">${sure ? '确认移除？' : '移除'}</button>
        </li>`;
      })
      .join('');
    return `<div class="flex flex-col gap-2 border-t border-dashed border-line pt-2">
      <div class="flex flex-wrap items-center gap-2 text-[13px]">
        <span class="text-muted">设备 <b class="font-mono text-ink tabular-nums">${x.devices.length}</b> / ${x.deviceLimit}</span>
        <span class="ml-auto text-[12.5px] text-muted">最多</span>
        <span class="inline-flex items-center rounded-full border-[1.5px] border-line bg-sheet">
          <button type="button" data-act="limitMinus" aria-label="少一台" class="${stepBtn}" ${x.deviceLimit <= 1 ? 'disabled' : ''}>−</button>
          <span class="min-w-[1.6em] text-center font-mono text-[14px] tabular-nums">${x.deviceLimit}</span>
          <button type="button" data-act="limitPlus" aria-label="多一台" class="${stepBtn}" ${x.deviceLimit >= 10 ? 'disabled' : ''}>+</button>
        </span>
        <span class="text-[12.5px] text-muted">台</span>
      </div>
      ${rows ? `<ul class="m-0 flex list-none flex-col gap-1.5 p-0">${rows}</ul>` : '<span class="text-[12.5px] text-muted">还没有设备登录过。</span>'}
    </div>`;
  }

  function itemHTML(x: Invite): string {
    const seen = x.lastSeenAt ? `最近使用 ${fmtTime(x.lastSeenAt)}` : '还没登录过';
    const confirming = armed === `inv:${x.id}`;
    return `<li data-id="${esc(x.id)}" class="flex flex-col gap-2 rounded-xl border-[1.5px] px-3.5 py-3 ${x.id === fresh ? 'border-accent bg-accent-soft' : 'border-line bg-sheet'}">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <b class="min-w-0 truncate text-[15px]">${esc(x.note || '未命名')}</b>
        <span class="font-mono text-[16px] tracking-[.06em] select-all">${esc(x.code)}</span>
        <button type="button" data-act="copy" class="${C.btn} ml-auto">复制</button>
      </div>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted">
        <span>创建于 ${fmtTime(x.createdAt)}</span><span>${seen}</span>
        <span>Token 近 30 天 <b class="font-medium text-ink">${esc(fmtTokens(x.tokens?.last30))}</b> · 累计 <b class="font-medium text-ink">${esc(fmtTokens(x.tokens?.total))}</b></span>
        <button type="button" data-act="delete" class="ml-auto cursor-pointer rounded-full border-[1.5px] px-3 py-1 text-[13px] ${confirming ? 'border-bad bg-bad-soft text-bad' : 'border-line bg-sheet text-muted'}">${confirming ? '确认删除？账户和数据一起删' : '删除'}</button>
      </div>
      ${devicesHTML(x)}
    </li>`;
  }

  function headerHTML(): string {
    return `<header class="flex items-center gap-2.5">
      <button type="button" data-act="back" class="inline-flex flex-none cursor-pointer items-center gap-1 rounded-full border-[1.5px] border-line bg-sheet py-1.5 pr-3.5 pl-2.5 text-[13.5px] transition-transform active:scale-[.97]">${ICON.back}设置</button>
      <h2 class="m-0 min-w-0 truncate font-head text-[20px] font-bold leading-tight">邀请码管理</h2>
      ${list ? `<span class="ml-auto flex-none text-[12.5px] text-muted">${list.length ? `共 ${list.length} 个` : ''}</span>` : ''}
    </header>`;
  }

  function render(enter = false): void {
    if (err && !list) {
      root.innerHTML = `${headerHTML()}<div class="flex flex-col items-start gap-2 rounded-xl bg-bad-soft px-3.5 py-3 text-[14px]">读取邀请码失败：${esc(err)}
        <button type="button" data-act="retry" class="${C.btn}">重试</button></div>`;
    } else if (!list) {
      root.innerHTML = `${headerHTML()}<div class="flex items-center gap-2 text-[14px] text-muted"><span class="${C.spin}"></span>正在读取邀请码…</div>`;
    } else {
      root.innerHTML = `${headerHTML()}
      <section class="${C.card} flex flex-col gap-3 px-4 pt-3.5 pb-4" aria-label="生成邀请码">
        <span class="${C.label}">生成邀请码</span>
        <form data-form class="flex gap-2">
          <label for="inviteNote" class="sr-only">备注名</label>
          <input id="inviteNote" maxlength="30" autocomplete="off" placeholder="备注名，比如 小王" class="${C.input}">
          <button class="${C.btnPrimary}" ${busy ? 'disabled' : ''}>${busy ? '生成中…' : '生成'}</button>
        </form>
        <span class="text-[12.5px] text-muted">备注名只有你看得到，用来区分是谁的邀请码。生成后点“复制”发给对方。</span>
      </section>
      <details class="group ${C.card} px-4 py-3">
        <summary class="flex cursor-pointer list-none items-center gap-2 text-[14px] font-semibold [&::-webkit-details-marker]:hidden">邀请码怎么用、有什么限制
          <span class="ml-auto text-muted transition-transform group-open:rotate-90">${ICON.next}</span></summary>
        <ul class="m-0 mt-2.5 flex list-disc flex-col gap-1.5 pl-[1.15em] text-[13.5px] text-muted marker:text-line">
          <li>每个邀请码对应一个独立账户：对方在登录页输入邀请码就能用。句库、练习记录、每日任务和模型配置都和你的分开。</li>
          <li>AI 用的是对方自己在“设置”里填的 API 密钥，不会用到你的。每个邀请码下面显示的 token 用量花的是对方的额度，对方在自己的“设置 → Token 用量”里也能看到。</li>
          <li>每个邀请码只能在限定数量的设备（浏览器）上登录，超出的新设备会被拒绝。移除一台设备会让它马上退出、空出名额；对方清除浏览器数据或换浏览器，也算一台新设备。</li>
          <li>删除邀请码会同时删除这个账户和它的全部数据，不能恢复。</li>
          <li>登录页上也写了这些注意事项，对方第一次登录前能看到。</li>
        </ul>
      </details>
      ${list.length ? `<ul class="m-0 flex list-none flex-col gap-2 p-0" aria-label="已生成的邀请码">${list.map(itemHTML).join('')}</ul>` : `<p class="m-0 rounded-xl border-[1.5px] border-dashed border-line p-3.5 text-[14px] text-muted">还没有邀请码。填个备注名，点“生成”。</p>`}`;
    }
    if (enter) A.enter(root.children);
  }

  function disarm(): void {
    clearTimeout(armTimer);
    armed = null;
  }

  /** 离开页面时调用：收起等确认的按钮 */
  function reset(): void {
    disarm();
    fresh = null;
  }

  /** 第一次点：变成“确认”，4 秒内再点才执行 */
  function arm(key: string): void {
    disarm();
    armed = key;
    armTimer = setTimeout(() => {
      armed = null;
      render();
    }, 4000);
    render();
  }

  /** 调用接口改一个邀请码（设备数、移除设备），用返回的最新数据替换列表里那一项 */
  async function update(
    x: Invite,
    call: () => Promise<{ invite: Invite }>,
    msg: (inv: Invite) => string,
  ): Promise<void> {
    try {
      const { invite } = await call();
      list = (list || []).map((i) => (i.id === x.id ? invite : i));
      toast?.(msg(invite));
      changed();
    } catch (ex) {
      toast?.((ex as Error).message);
    }
    render();
  }

  root.addEventListener('submit', async (e) => {
    if (!closest(e, '[data-form]') || busy) return;
    e.preventDefault();
    const note = (root.querySelector<HTMLInputElement>('#inviteNote')?.value || '').trim();
    busy = true;
    disarm();
    render();
    try {
      const { invite } = await api.createInvite(note);
      list = [invite, ...(list || [])];
      fresh = invite.id;
      toast?.('邀请码已生成，点“复制”发给对方');
      changed();
    } catch (ex) {
      toast?.(`生成失败：${(ex as Error).message}`);
    } finally {
      busy = false;
      render();
      A.pop(root.querySelector(`[data-id="${CSS.escape(fresh || '')}"]`));
    }
  });

  root.addEventListener('click', async (e) => {
    const a = closest<HTMLButtonElement>(e, '[data-act]');
    if (!a) return;
    if (a.dataset.act === 'back') {
      onBack?.();
      return;
    }
    if (a.dataset.act === 'retry') {
      err = '';
      render();
      await load();
      render(true);
      return;
    }
    const li = closest(e, '[data-id]');
    if (!li || !list) return;
    const x = list.find((i) => i.id === li.dataset.id);
    if (!x) return;
    if (a.dataset.act === 'copy') {
      const ok = await copyText(x.code);
      toast?.(ok ? `已复制 ${x.code}` : '复制不了，长按邀请码手动复制');
      return;
    }
    if (a.dataset.act === 'limitMinus' || a.dataset.act === 'limitPlus') {
      const n = x.deviceLimit + (a.dataset.act === 'limitPlus' ? 1 : -1);
      if (n < 1 || n > 10) return;
      disarm();
      await update(
        x,
        () => api.setDeviceLimit(x.id, n),
        (inv) => `${inv.note || inv.code} 最多 ${inv.deviceLimit} 台设备`,
      );
      return;
    }
    if (a.dataset.act === 'rmDevice') {
      const key = `dev:${x.id}:${a.dataset.dev}`;
      if (armed !== key) {
        arm(key);
        return;
      }
      disarm();
      a.disabled = true;
      await update(
        x,
        () => api.removeDevice(x.id, a.dataset.dev ?? ''),
        () => '已移除，这台设备会马上退出登录',
      );
      return;
    }
    if (a.dataset.act === 'delete') {
      if (armed !== `inv:${x.id}`) {
        arm(`inv:${x.id}`);
        return;
      }
      disarm();
      a.disabled = true;
      try {
        await api.deleteInvite(x.id);
        list = (list || []).filter((i) => i.id !== x.id);
        toast?.(`已删除 ${x.note || x.code} 的账户和数据`);
        changed();
      } catch (ex) {
        toast?.(`删除失败：${(ex as Error).message}`);
      }
      render();
    }
  });

  return { load, render, reset, summary, hasData: () => Boolean(list) };
}

/** “设置”页里的邀请码入口（只有你自己看得到）：点进去是单独的邀请码管理页 */
export function inviteEntryHTML(sum: { count: number; devices: number } | null): string {
  const sub = !sum
    ? '生成、复制、删除邀请码，管理登录设备'
    : sum.count
      ? `共 ${sum.count} 个邀请码 · ${sum.devices} 台设备在用`
      : '还没有邀请码，点进来生成';
  return `<button type="button" data-act="openInvites" class="${C.card} flex w-full cursor-pointer items-center gap-3 px-4 py-3.5 text-left transition-colors hover:border-accent active:scale-[.99]">
    <span class="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-accent-soft text-accent">${ICON.ticket}</span>
    <span class="flex min-w-0 flex-col gap-0.5"><b class="text-[15px]">邀请码管理</b><span class="truncate text-[13px] text-muted">${esc(sub)}</span></span>
    <span class="ml-auto flex-none text-muted">${ICON.next}</span>
  </button>`;
}

/** “设置”页最下面的账户卡片：当前是谁、退出登录 */
export function accountHTML(me: { role: AccountRole; name: string }): string {
  const who = me.role === 'owner' ? '管理员（你自己）' : `邀请账户 · ${esc(me.name || '未命名')}`;
  return `<section class="${C.card} flex flex-wrap items-center gap-3 px-4 py-3.5" aria-label="账户">
    <span class="flex min-w-0 flex-col gap-0.5"><span class="${C.label}">账户</span><span class="text-[15px]">${who}</span></span>
    <button type="button" data-act="logout" class="${C.btn} ml-auto">退出登录</button>
  </section>`;
}
