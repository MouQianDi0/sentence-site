// “设置”页：每日任务、邀请码入口（只有你自己）、AI 批改（准确度提升）、Token 用量入口、模型设置、账户。
// 第一次进入时几块的数据一起读好再一起显示、只播一次进场动画；之后再进入先显示上次读到的，
// 后台读到新数据再悄悄更新（不再播动画），所以不会一块一块地闪出来。
// 邀请码管理、Token 用量是从设置主页点进去的单独页面（/settings/invites、/settings/usage），手机的返回手势能回到设置主页。
import { api } from '../lib/api.ts';
import * as A from '../lib/anim.ts';
import { $, closest } from '../lib/dom.ts';
import { confirmDialog } from '../lib/dialog.ts';
import { toast } from '../lib/toast.ts';
import { state } from '../state.ts';
import { renderPanel } from '../practice/panel.ts';
import { renderTask } from '../practice/task.ts';
import { PATHS, SUB_PATHS, atSub, pushPath, replacePath, setTitle, type SettingsSub } from '../router.ts';
import { createSettingsView } from './llm-settings.ts';
import { createTaskSettings } from './task-settings.ts';
import { createInvites, inviteEntryHTML, accountHTML } from './invites.ts';
import { createUsage, usageEntryHTML } from './usage.ts';

const isOwner = () => state.me?.role === 'owner';

let taskSettings: ReturnType<typeof createTaskSettings>;
let invitesView: ReturnType<typeof createInvites>;
let usageView: ReturnType<typeof createUsage>;
let llmView: ReturnType<typeof createSettingsView>;

let seq = 0;
let shown: SettingsSub | null = null; // 正在看的单独页面（邀请码管理 / Token 用量）；在设置主页时是 null
let pushed = false; // 从设置主页点进单独页面时加了一条历史记录（手机上的返回手势能回到设置主页）

/** 现在在设置下面的哪个单独页面（在设置主页时是 null） */
export const subOpen = (): SettingsSub | null => shown;

/** 这个账户能不能看这个单独页面：邀请码管理只有你自己能看，Token 用量谁都能看 */
const allowed = (sub: SettingsSub | null): SettingsSub | null => (sub === 'invites' && !isOwner() ? null : sub);

/** 单独页面的组件 */
const viewOf = (sub: SettingsSub) => (sub === 'invites' ? invitesView : usageView);

const MAIN_IDS = ['taskSettings', 'inviteEntry', 'gradeSettings', 'usageEntry', 'llmSettings', 'accountSettings'];

function renderInviteEntry(): void {
  $('inviteEntry').innerHTML = isOwner() ? inviteEntryHTML(invitesView.summary()) : '';
}

function renderUsageEntry(): void {
  $('usageEntry').innerHTML = usageEntryHTML(usageView.summary());
}

/** 设置主页上要显示的几块（不含单独页面） */
function settingsCards(): HTMLElement[] {
  return MAIN_IDS.map((id) => $(id)).filter((el) => el.firstElementChild);
}

function setLoading(on: boolean): void {
  $('settingsLoading').classList.toggle('hidden', !on);
  $('settingsLoading').classList.toggle('flex', on);
}

function renderSettingsMain(enter: boolean): void {
  taskSettings.render();
  renderInviteEntry();
  renderUsageEntry();
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
  usageView.reset();
  // 邀请码管理只有你自己（访问密码登录）看得到；模型设置、Token 用量每个账户都有，各看各的
  const parts = { task: taskSettings, llm: llmView, usage: usageView, invites: isOwner() ? invitesView : null };
  const list = Object.values(parts).filter((p) => p !== null);
  const cached = list.every((p) => p.hasData());
  const asked = shown || atSub();
  const want = allowed(asked);
  // 邀请码管理页只有你自己能看，别的账户打开这个地址时换成设置页
  if (asked && !want) replacePath(PATHS.settings);
  showSettingsPage(want);
  if (cached) {
    renderSettingsMain(!want);
    if (want) viewOf(want).render(true);
  } else {
    MAIN_IDS.forEach((id) => ($(id).innerHTML = ''));
    setLoading(true);
    if (want) viewOf(want).render();
  }
  const [task, llm, usage, invites] = await Promise.all([
    parts.task.load(),
    parts.llm.load(),
    parts.usage.load(),
    parts.invites ? parts.invites.load() : Promise.resolve(false),
  ]);
  if (mine !== seq || state.view !== 'settings') return;
  if (!cached) {
    renderSettingsMain(!shown);
    if (shown) viewOf(shown).render(true);
    return;
  }
  // 再次进入：只更新有变化的那几块，不播动画；正在改的那块先不动
  if (task && !taskSettings.editing()) taskSettings.render();
  if (llm) llmView.refresh();
  if (usage) {
    renderUsageEntry();
    if (shown === 'usage') usageView.render();
  }
  if (invites) {
    renderInviteEntry();
    if (shown === 'invites') invitesView.render();
  }
}

/** 设置页里切换“主页 / 邀请码管理页 / Token 用量页” */
function showSettingsPage(sub: SettingsSub | null): void {
  shown = sub;
  setTitle('settings', sub);
  const toggle = (id: string, on: boolean) => {
    $(id).classList.toggle('hidden', !on);
    $(id).classList.toggle('flex', on);
  };
  toggle('settingsMain', !sub);
  toggle('settingsInvites', sub === 'invites');
  toggle('settingsUsage', sub === 'usage');
}

function openSub(sub: SettingsSub): void {
  if (!allowed(sub)) return;
  if (atSub() !== sub) {
    pushPath(SUB_PATHS[sub]);
    pushed = true;
  }
  showSettingsPage(sub);
  const view = viewOf(sub);
  view.render(true);
  window.scrollTo({ top: 0 });
  // 进来时顺便刷新一下（设置主页读到的可能是几分钟前的）
  void view.load().then((changed) => {
    if (changed && shown === sub) view.render();
    if (changed && sub === 'invites') renderInviteEntry();
    if (changed && sub === 'usage') renderUsageEntry();
  });
}

/** 单独页面上点“← 设置”：是从设置主页点进来的就退回去（和手机返回手势一样），否则直接换成设置主页 */
export function closeSub(): void {
  if (pushed && atSub()) {
    history.back();
    return;
  }
  replacePath(PATHS.settings);
  backToSettingsMain();
}

function backToSettingsMain(): void {
  pushed = false;
  invitesView.reset();
  usageView.reset();
  showSettingsPage(null);
  A.enter(settingsCards());
  window.scrollTo({ top: 0 });
}

/** 切到别的页（练习、记录）时离开单独页面（地址由换页的地方改） */
export function leaveSub(): void {
  if (!shown) return;
  pushed = false;
  invitesView.reset();
  usageView.reset();
  showSettingsPage(null);
}

/** 浏览器前进、后退到 /settings 或它下面的单独页面时，设置页里跟着换 */
export function syncSub(asked: SettingsSub | null): void {
  const want = allowed(asked);
  if (asked && !want) replacePath(PATHS.settings);
  if (want && want !== shown) {
    showSettingsPage(want);
    viewOf(want).render(true);
    window.scrollTo({ top: 0 });
  } else if (!want && shown) backToSettingsMain();
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
  location.replace(location.pathname + location.search);
}

export function initSettings(): void {
  taskSettings = createTaskSettings({
    root: $('taskSettings'),
    gradeRoot: $('gradeSettings'),
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
    onBack: () => closeSub(),
    onChange: () => renderInviteEntry(),
  });
  usageView = createUsage({
    root: $('settingsUsage'),
    toast,
    onBack: () => closeSub(),
    boost: () => state.practiceCfg.accuracyBoost,
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

  $('inviteEntry').addEventListener('click', (e) => {
    if (closest(e, '[data-act="openInvites"]')) openSub('invites');
  });
  $('usageEntry').addEventListener('click', (e) => {
    if (closest(e, '[data-act="openUsage"]')) openSub('usage');
  });

  $('accountSettings').addEventListener('click', (e) => {
    const b = closest<HTMLButtonElement>(e, '[data-act="logout"]');
    if (b) void logout(b);
  });
}
