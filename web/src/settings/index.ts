// “设置”页：每日任务、邀请码入口（只有你自己）、模型设置、账户。
// 第一次进入时几块的数据一起读好再一起显示、只播一次进场动画；之后再进入先显示上次读到的，
// 后台读到新数据再悄悄更新（不再播动画），所以不会一块一块地闪出来。
// 邀请码管理是从设置页点进去的单独页面，地址带 #invites，手机的返回手势能回到设置主页。
import { api } from '../lib/api.ts';
import * as A from '../lib/anim.ts';
import { $, closest } from '../lib/dom.ts';
import { confirmDialog } from '../lib/dialog.ts';
import { toast } from '../lib/toast.ts';
import { state } from '../state.ts';
import { renderPanel } from '../practice/panel.ts';
import { renderTask } from '../practice/task.ts';
import { showView } from '../views.ts';
import { createSettingsView } from './llm-settings.ts';
import { createTaskSettings } from './task-settings.ts';
import { createInvites, inviteEntryHTML, accountHTML } from './invites.ts';

const isOwner = () => state.me?.role === 'owner';

let taskSettings: ReturnType<typeof createTaskSettings>;
let invitesView: ReturnType<typeof createInvites>;
let llmView: ReturnType<typeof createSettingsView>;

let seq = 0;
let invitesShown = false; // 正在看邀请码管理页
let invitesPushed = false; // 打开邀请码页时往浏览器历史里加了一条（手机上的返回手势能回到设置主页）

/** 现在是不是在邀请码管理页 */
export const invitesOpen = (): boolean => invitesShown;

function renderInviteEntry(): void {
  $('inviteEntry').innerHTML = isOwner() ? inviteEntryHTML(invitesView.summary()) : '';
}

/** 设置主页上要显示的几块（不含邀请码页） */
function settingsCards(): HTMLElement[] {
  return ['taskSettings', 'inviteEntry', 'llmSettings', 'accountSettings']
    .map((id) => $(id))
    .filter((el) => el.firstElementChild);
}

function setLoading(on: boolean): void {
  $('settingsLoading').classList.toggle('hidden', !on);
  $('settingsLoading').classList.toggle('flex', on);
}

function renderSettingsMain(enter: boolean): void {
  taskSettings.render();
  renderInviteEntry();
  llmView.render();
  $('accountSettings').innerHTML = state.me ? accountHTML(state.me) : '';
  setLoading(false);
  if (enter) A.enter(settingsCards());
}

/** 每次进入设置页时调用 */
export async function openSettings(): Promise<void> {
  const mine = ++seq;
  llmView.reset();
  invitesView.reset();
  // 邀请码管理只有你自己（访问密码登录）看得到；模型设置每个账户都有，各填各的
  const parts = [taskSettings, llmView, ...(isOwner() ? [invitesView] : [])];
  const cached = parts.every((p) => p.hasData());
  const wantInvites = isOwner() && (invitesShown || location.hash === '#invites');
  showSettingsPage(wantInvites ? 'invites' : 'main');
  if (cached) {
    renderSettingsMain(!wantInvites);
    if (wantInvites) invitesView.render(true);
  } else {
    ['taskSettings', 'inviteEntry', 'llmSettings', 'accountSettings'].forEach((id) => ($(id).innerHTML = ''));
    setLoading(true);
    if (wantInvites) invitesView.render();
  }
  const changed = await Promise.all(parts.map((p) => p.load()));
  if (mine !== seq || state.view !== 'settings') return;
  if (!cached) {
    renderSettingsMain(!invitesShown);
    if (invitesShown) invitesView.render(true);
    return;
  }
  // 再次进入：只更新有变化的那几块，不播动画；正在改的那块先不动
  if (changed[0] && !taskSettings.editing()) taskSettings.render();
  if (changed[1]) llmView.refresh();
  if (changed[2]) {
    renderInviteEntry();
    if (invitesShown) invitesView.render();
  }
}

/** 设置页里切换“主页 / 邀请码管理页” */
function showSettingsPage(page: 'main' | 'invites'): void {
  invitesShown = page === 'invites';
  $('settingsMain').classList.toggle('hidden', invitesShown);
  $('settingsMain').classList.toggle('flex', !invitesShown);
  $('settingsInvites').classList.toggle('hidden', !invitesShown);
  $('settingsInvites').classList.toggle('flex', invitesShown);
}

function openInvites(): void {
  if (!isOwner()) return;
  if (location.hash !== '#invites') {
    history.pushState({ page: 'invites' }, '', '#invites');
    invitesPushed = true;
  }
  showSettingsPage('invites');
  invitesView.render(true);
  window.scrollTo({ top: 0 });
  // 进来时顺便刷新一下列表（设置主页读到的可能是几分钟前的）
  void invitesView.load().then((changed) => {
    if (changed && invitesShown) invitesView.render();
    if (changed) renderInviteEntry();
  });
}

const plainUrl = () => location.pathname + location.search;

/** 邀请码页上点“← 设置”：有自己加的历史记录就退回去（和手机返回手势一样），否则直接切回 */
export function closeInvites(): void {
  if (invitesPushed && location.hash === '#invites') {
    history.back();
    return;
  }
  history.replaceState(null, '', plainUrl());
  backToSettingsMain();
}

function backToSettingsMain(): void {
  invitesPushed = false;
  invitesView.reset();
  showSettingsPage('main');
  A.enter(settingsCards());
  window.scrollTo({ top: 0 });
}

/** 切到别的页（练习、记录）时离开邀请码页，去掉地址栏里的 #invites */
export function leaveInvites(): void {
  if (!invitesShown && location.hash !== '#invites') return;
  invitesShown = false;
  invitesPushed = false;
  invitesView.reset();
  showSettingsPage('main');
  if (location.hash === '#invites') history.replaceState(null, '', plainUrl());
}

/** 退出登录前再问一次 */
async function logout(btn: HTMLButtonElement): Promise<void> {
  const sure = await confirmDialog({
    title: '退出登录？',
    body: isOwner()
      ? '退出后要重新输入访问密码才能进来。练习记录都保存在服务器上，不会丢。'
      : '退出后要重新输入邀请码才能进来。练习记录都保存在服务器上，不会丢；在这台设备上重新登录也不会多占设备名额。',
    ok: '退出登录',
    danger: true,
  });
  if (!sure) return;
  btn.disabled = true;
  try {
    await api.lock();
  } catch {
    // 退出失败也照样回到登录页
  }
  location.replace(plainUrl());
}

export function initSettings(): void {
  taskSettings = createTaskSettings({
    root: $('taskSettings'),
    toast,
    role: () => state.me?.role,
    onChange: (p) => {
      state.practiceCfg = p;
      renderTask();
    },
  });
  invitesView = createInvites({
    root: $('settingsInvites'),
    toast,
    onBack: () => closeInvites(),
    onChange: () => renderInviteEntry(),
  });
  llmView = createSettingsView({
    root: $('llmSettings'),
    toast,
    onSaved: async () => {
      state.usage = await api.usage().catch(() => state.usage);
      if (state.cur && state.step === 3) renderPanel(false);
      renderTask();
    },
  });

  window.addEventListener('popstate', () => {
    const want = location.hash === '#invites' && isOwner();
    if (want && state.view !== 'settings') {
      invitesShown = true;
      showView('settings');
      return;
    }
    if (state.view !== 'settings') return;
    if (want && !invitesShown) {
      showSettingsPage('invites');
      invitesView.render(true);
      window.scrollTo({ top: 0 });
    } else if (!want && invitesShown) backToSettingsMain();
  });

  $('inviteEntry').addEventListener('click', (e) => {
    if (closest(e, '[data-act="openInvites"]')) openInvites();
  });

  $('accountSettings').addEventListener('click', (e) => {
    const b = closest<HTMLButtonElement>(e, '[data-act="logout"]');
    if (b) void logout(b);
  });
}
