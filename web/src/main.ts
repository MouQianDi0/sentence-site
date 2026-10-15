// 长难句拆解台 · 页面入口：接好各部分的事件，确认登录状态后加载数据
import './app.css';
import { api } from './lib/api.ts';
import { $ } from './lib/dom.ts';
import { esc } from './lib/format.ts';
import { state } from './state.ts';
import { initLock, remindExpiry, showLock } from './lock.ts';
import { initViews, renderAll } from './views.ts';
import { initRecords } from './records.ts';
import { initSettings } from './settings/index.ts';
import { initBank } from './practice/bank.ts';
import { initData, start } from './practice/data.ts';
import { initNav } from './practice/nav.ts';
import { initPanel } from './practice/panel.ts';
import { initPin } from './practice/pin.ts';
import { initReading } from './practice/reading.ts';
import { initSentence } from './practice/sentence.ts';
import { initTask } from './practice/task.ts';

initLock();
initViews();
initBank();
initNav();
initPin();
initTask();
initSentence();
initReading();
initPanel();
initRecords();
initSettings();
initData();
renderAll(false);

api
  .session()
  .then((s) => {
    if (!s.unlocked) {
      showLock(true, s.notice); // notice：比如邀请码过期了
      return;
    }
    state.me = { role: s.role, name: s.name, expiresAt: s.expiresAt ?? null };
    remindExpiry(state.me);
    void start();
  })
  .catch((e: Error) => {
    $('sentence').innerHTML = `<span class="font-zh text-[15px] text-bad">${esc(e.message)}</span>`;
  });
