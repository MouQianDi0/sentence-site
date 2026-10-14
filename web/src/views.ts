// 三个页面（练习 / 记录 / 设置）的切换，以及整页重画
import * as A from './lib/anim.ts';
import { $, all, closest } from './lib/dom.ts';
import { state, saveUI, taskInfo, type ViewName } from './state.ts';
import { renderBank } from './practice/bank.ts';
import { renderPanel, renderTabs } from './practice/panel.ts';
import { stopSpeak } from './practice/reading.ts';
import { renderSentence } from './practice/sentence.ts';
import { renderDone, renderTask } from './practice/task.ts';
import { renderRecords } from './records.ts';
import { closeInvites, invitesOpen, leaveInvites, openSettings } from './settings/index.ts';

const VIEWS: Record<ViewName, string> = { practice: 'viewPractice', records: 'viewRecords', settings: 'viewSettings' };
const NAMES = Object.keys(VIEWS) as ViewName[];
let settingsOpened = false;

export function renderViews(): void {
  A.moveIndicator($('viewInd'), NAMES.indexOf(state.view));
  all('#views [data-view]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === state.view)));
  for (const name of NAMES) {
    const el = $(VIEWS[name]);
    el.classList.toggle('hidden', state.view !== name);
    el.classList.toggle('flex', state.view === name);
  }
  if (state.view === 'records') renderRecords();
  // 要等知道是哪个账户之后再打开设置页（刷新时停在设置页的情况）
  if (state.view === 'settings' && !settingsOpened && state.me) {
    settingsOpened = true;
    void openSettings();
  }
}

export function showView(name: ViewName): void {
  if (name === 'practice' && state.view !== 'practice' && taskInfo().complete) state.showDone = true;
  if (state.view === 'settings' && name !== 'settings') leaveInvites();
  state.view = name;
  state.ui.view = name;
  saveUI();
  if (state.speaking) stopSpeak();
  if (name === 'settings') settingsOpened = false; // 每次进入都重新读取
  renderViews();
  if (name === 'practice') renderDone(false);
  if (name !== 'settings') A.enter($(VIEWS[name]).children);
  window.scrollTo({ top: 0 });
}

export function renderAll(enter: boolean): void {
  renderBank();
  renderTask();
  renderDone(enter);
  renderTabs();
  renderSentence();
  renderPanel(enter);
  renderViews();
}

const isView = (v: string | undefined): v is ViewName => !!v && v in VIEWS;

export function initViews(): void {
  $('views').addEventListener('click', (e) => {
    const b = closest(e, '[data-view]');
    const v = b?.dataset.view;
    if (!isView(v)) return;
    if (v !== state.view) showView(v);
    else if (v === 'settings' && invitesOpen()) closeInvites(); // 在邀请码页上点“设置”回到设置主页
  });
}
