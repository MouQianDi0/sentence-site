// 邀请码管理（只有你自己看得到）：从“设置”页的“邀请码管理”点进来的单独页面。
// 生成邀请码、复制发给别人、删除。每个邀请码对应一个独立账户；删除邀请码会同时删除这个账户和它的全部数据。
// 每个邀请码最多能在几台设备上登录（默认 2，可以调），能看到登录过的设备并移除；也能看到每个账户用掉的 token。
// 有效期（30 / 90 / 180 / 360 天或永久）在生成时选，之后随时能改：从对方第一次登录开始算，
// 到期后对方登不进来，数据都保留；登录过的账户改有效期从今天起重新算，过期的就续上了。
import type { AccountRole, Invite } from '@sentence-site/shared';
import { api } from '../lib/api.ts';
import { closest } from '../lib/dom.ts';
import { daysUntil, esc, fmtDate, fmtTime, fmtTokens } from '../lib/format.ts';
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

/** 能选的有效期（天），null 是永久。后端 api/src/accounts.ts 有一份同样的列表 */
const PERIODS: (number | null)[] = [30, 90, 180, 360, null];
const periodName = (d: number | null) => (d ? `${d} 天` : '永久');

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
  let newDays: number | null = null; // 生成邀请码时选的有效期，默认永久
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

  /** 设置页入口上显示的摘要：几个邀请码、几台设备在用、几个已过期 */
  function summary(): { count: number; devices: number; expired: number } | null {
    if (!list) return null;
    return {
      count: list.length,
      devices: list.reduce((n, x) => n + x.devices.length, 0),
      expired: list.filter((x) => x.expired).length,
    };
  }

  /** 有效期这一行：现在的状态，加一个改有效期的下拉框 */
  function validityHTML(x: Invite): string {
    let state: string;
    if (x.expired) {
      state = `<span class="rounded bg-bad-soft px-1.5 py-px text-[12px] font-semibold text-bad">已过期</span>
        <span class="text-muted">${esc(fmtDate(x.expiresAt))}到期 · 选个有效期就能续上，数据都还在</span>`;
    } else if (!x.validDays) {
      state = '<span class="text-muted">永久有效</span>';
    } else if (!x.activatedAt || !x.expiresAt) {
      state = `<span class="text-muted">首次登录后 ${x.validDays} 天有效（还没登录过，还没开始算）</span>`;
    } else {
      const left = daysUntil(x.expiresAt);
      state = `<span class="${left <= 7 ? 'font-semibold text-mid' : 'text-muted'}">${esc(fmtDate(x.expiresAt))}到期 · 还剩 ${Math.max(1, left)} 天${left <= 7 ? '，快到期了' : ''}</span>`;
    }
    const hint = x.activatedAt ? '改了从今天起重新算' : '从对方第一次登录开始算';
    // 登录过、有期限的：按现在的有效期从今天起再算一遍（下拉框选同一个值不会触发修改，所以单独放个按钮）
    const renewCls = x.expired
      ? 'border-accent bg-accent font-semibold text-on-accent'
      : 'border-line bg-sheet text-ink';
    const renew =
      x.activatedAt && x.validDays
        ? `<button type="button" data-act="renew" class="ml-auto cursor-pointer rounded-full border-[1.5px] px-3 py-1 text-[13px] transition-transform active:scale-[.97] disabled:opacity-45 ${renewCls}">续期 ${x.validDays} 天</button>`
        : '';
    return `<div class="flex flex-col gap-1.5 border-t border-dashed border-line pt-2 text-[13px]">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">${state}</div>
      <div class="flex flex-wrap items-center gap-2">
        <label for="valid-${esc(x.id)}" class="text-muted">有效期</label>
        <span class="relative inline-flex">
          <select id="valid-${esc(x.id)}" data-act="validity" class="cursor-pointer appearance-none rounded-full border-[1.5px] border-line bg-sheet py-1 pr-7 pl-3 text-[13px] text-ink outline-none transition-colors hover:border-accent focus:border-accent">${PERIODS.map(
            (d) => `<option value="${d ?? ''}" ${d === x.validDays ? 'selected' : ''}>${periodName(d)}</option>`,
          ).join('')}</select>
          <svg class="pointer-events-none absolute top-1/2 right-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>
        </span>
        <span class="text-[12px] text-muted">${hint}</span>
        ${renew}
      </div>
    </div>`;
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
    const seen = x.lastSeenAt
      ? `最近使用 ${fmtTime(x.lastSeenAt)}`
      : x.activatedAt
        ? `${fmtTime(x.activatedAt)} 第一次登录`
        : '还没登录过';
    const confirming = armed === `inv:${x.id}`;
    const tone =
      x.id === fresh ? 'border-accent bg-accent-soft' : x.expired ? 'border-bad bg-sheet' : 'border-line bg-sheet';
    return `<li data-id="${esc(x.id)}" class="flex flex-col gap-2 rounded-xl border-[1.5px] px-3.5 py-3 ${tone}">
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
      ${validityHTML(x)}
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
        <form data-form class="flex flex-col gap-3">
          <div class="flex gap-2">
            <label for="inviteNote" class="sr-only">备注名</label>
            <input id="inviteNote" maxlength="30" autocomplete="off" placeholder="备注名，比如 小王" class="${C.input}">
            <button class="${C.btnPrimary}" ${busy ? 'disabled' : ''}>${busy ? '生成中…' : '生成'}</button>
          </div>
          <div class="flex flex-col gap-1.5">
            <span id="inviteDaysLabel" class="text-[13.5px] font-semibold">有效期</span>
            <div role="group" aria-labelledby="inviteDaysLabel" class="grid grid-cols-5 gap-1.5">${PERIODS.map(
              (d) =>
                `<button type="button" data-days="${d ?? ''}" aria-pressed="${d === newDays}" class="cursor-pointer rounded-full border-[1.5px] border-line bg-sheet px-1 py-1 text-center text-[13.5px] whitespace-nowrap transition-colors aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:font-semibold aria-pressed:text-on-accent">${periodName(d)}</button>`,
            ).join('')}</div>
          </div>
        </form>
        <span class="text-[12.5px] text-muted">备注名只有你看得到，用来区分是谁的邀请码。有效期从对方第一次登录开始算，生成后也能随时改。生成后点“复制”发给对方。</span>
      </section>
      <details class="group ${C.card} px-4 py-3">
        <summary class="flex cursor-pointer list-none items-center gap-2 text-[14px] font-semibold [&::-webkit-details-marker]:hidden">邀请码怎么用、有什么限制
          <span class="ml-auto text-muted transition-transform group-open:rotate-90">${ICON.next}</span></summary>
        <ul class="m-0 mt-2.5 flex list-disc flex-col gap-1.5 pl-[1.15em] text-[13.5px] text-muted marker:text-line">
          <li>每个邀请码对应一个独立账户：对方在登录页输入邀请码就能用。句库、练习记录、每日任务和模型配置都和你的分开。</li>
          <li>AI 用的是对方自己在“设置”里填的 API 密钥，不会用到你的。每个邀请码下面显示的 token 用量花的是对方的额度，对方在自己的“设置 → Token 用量”里也能看到。</li>
          <li>每个邀请码只能在限定数量的设备（浏览器）上登录，超出的新设备会被拒绝。移除一台设备会让它马上退出、空出名额；对方清除浏览器数据或换浏览器，也算一台新设备。</li>
          <li>有效期从对方第一次登录开始算。到期后对方登不进来，已经登录的也会退出，但账户和数据都保留；给它选一个新的有效期就续上了（从今天起重新算）。</li>
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
      const { invite } = await api.createInvite(note, newDays);
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

  // 改某个邀请码的有效期
  root.addEventListener('change', async (e) => {
    const sel = e.target as HTMLSelectElement;
    if (sel.dataset?.act !== 'validity' || !list) return;
    const li = sel.closest<HTMLElement>('[data-id]');
    const x = list.find((i) => i.id === li?.dataset.id);
    if (!x) return;
    const days = sel.value ? Number(sel.value) : null;
    disarm();
    sel.disabled = true;
    await update(
      x,
      () => api.setValidity(x.id, days),
      (inv) => {
        const who = inv.note || inv.code;
        if (!inv.validDays) return `${who} 改成永久有效了`;
        if (!inv.expiresAt) return `${who}：首次登录后 ${inv.validDays} 天有效`;
        return `${who}${x.expired ? ' 已续期' : ''}：${fmtDate(inv.expiresAt)}到期`;
      },
    );
  });

  root.addEventListener('click', async (e) => {
    const d = closest<HTMLButtonElement>(e, '[data-days]');
    if (d) {
      newDays = d.dataset.days ? Number(d.dataset.days) : null;
      root
        .querySelectorAll<HTMLButtonElement>('[data-days]')
        .forEach((b) => b.setAttribute('aria-pressed', String(b === d)));
      return;
    }
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
    if (a.dataset.act === 'renew') {
      disarm();
      a.disabled = true;
      await update(
        x,
        () => api.setValidity(x.id, x.validDays),
        (inv) => `${inv.note || inv.code} 已续期：${fmtDate(inv.expiresAt)}到期`,
      );
      return;
    }
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
export function inviteEntryHTML(sum: { count: number; devices: number; expired: number } | null): string {
  const sub = !sum
    ? '生成、复制、删除邀请码，管理有效期和登录设备'
    : sum.count
      ? `共 ${sum.count} 个邀请码 · ${sum.devices} 台设备在用${sum.expired ? ` · ${sum.expired} 个已过期` : ''}`
      : '还没有邀请码，点进来生成';
  return `<button type="button" data-act="openInvites" class="${C.card} flex w-full cursor-pointer items-center gap-3 px-4 py-3.5 text-left transition-colors hover:border-accent active:scale-[.99]">
    <span class="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-accent-soft text-accent">${ICON.ticket}</span>
    <span class="flex min-w-0 flex-col gap-0.5"><b class="text-[15px]">邀请码管理</b><span class="truncate text-[13px] text-muted">${esc(sub)}</span></span>
    <span class="ml-auto flex-none text-muted">${ICON.next}</span>
  </button>`;
}

/** “设置”页最下面的账户卡片：当前是谁、邀请码的有效期、退出登录 */
export function accountHTML(me: { role: AccountRole; name: string; expiresAt?: string | null }): string {
  const who = me.role === 'owner' ? '管理员（你自己）' : `邀请账户 · ${esc(me.name || '未命名')}`;
  let valid = '';
  if (me.role === 'member') {
    const left = me.expiresAt ? daysUntil(me.expiresAt) : null;
    valid =
      left === null
        ? '<span class="text-[12.5px] text-muted">邀请码永久有效</span>'
        : `<span class="text-[12.5px] ${left <= 7 ? 'font-semibold text-mid' : 'text-muted'}">邀请码 ${esc(fmtDate(me.expiresAt))}到期 · 还剩 ${Math.max(1, left)} 天${left <= 7 ? '，到期前找管理员续期' : ''}</span>`;
  }
  return `<section class="${C.card} flex flex-wrap items-center gap-3 px-4 py-3.5" aria-label="账户">
    <span class="flex min-w-0 flex-col gap-0.5"><span class="${C.label}">账户</span><span class="text-[15px]">${who}</span>${valid}</span>
    <button type="button" data-act="logout" class="${C.btn} ml-auto">退出登录</button>
  </section>`;
}
