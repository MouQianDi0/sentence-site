// 数据：第一次加载句库和练习记录、定时检查新句子、保存练习记录和草稿
import type { RecordPatch } from '@sentence-site/shared';
import { api } from '../lib/api.ts';
import { $ } from '../lib/dom.ts';
import { esc } from '../lib/format.ts';
import { toast } from '../lib/toast.ts';
import { state, saveUI } from '../state.ts';
import { renderAll } from '../views.ts';
import { renderBank } from './bank.ts';
import { renderTask } from './task.ts';
import { open, pickInitial } from './nav.ts';

export async function loadAll(): Promise<void> {
  const [s, r, a, u, p] = await Promise.all([
    api.sentences(),
    api.records(),
    api.attempts(),
    api.usage().catch(() => null),
    api.practiceSettings().catch(() => null),
  ]);
  state.sentences = s.sentences;
  if (p) state.practiceCfg = p;
  state.records = {};
  r.records.forEach((x) => (state.records[x.sentenceId] = x));
  state.attempts = {};
  a.attempts.forEach((x) => (state.attempts[x.sentenceId] ||= []).push(x));
  state.usage = u;
  state.loaded = true;
  const lastVisit = state.ui.lastVisit ? Date.parse(state.ui.lastVisit) : 0;
  const fresh = lastVisit ? state.sentences.filter((x) => Date.parse(x.created) > lastVisit) : [];
  state.ui.lastVisit = new Date().toISOString();
  saveUI();
  pickInitial();
  const first = fresh[0];
  if (first) toast(`自上次练习以来新增 ${fresh.length} 句`, { label: '去练习', fn: () => open(first.id) });
}

/** 登录后开始：先画出骨架，再读数据 */
export async function start(): Promise<void> {
  renderAll(false);
  try {
    await loadAll();
  } catch (e) {
    if ((e as { status?: number }).status !== 401) {
      $('sentence').innerHTML =
        `<span class="font-zh text-[15px] text-bad">加载失败：${esc((e as Error).message)}</span>`;
    }
  }
}

/** 看看别处（每日任务、别的设备）有没有加新句子。quiet：不提示，直接返回新句子 */
export async function checkNewSentences(quiet = false) {
  if (!state.loaded || (document.hidden && !quiet)) return;
  const last = state.sentences.at(-1)?.created;
  try {
    const r = await api.sentences(last);
    const known = new Set(state.sentences.map((x) => x.id));
    const added = r.sentences.filter((x) => !known.has(x.id));
    const first = added[0];
    if (!first) return;
    state.sentences = state.sentences.concat(added);
    renderBank();
    renderTask();
    if (state.cur)
      $('label').textContent = `句子 ${state.sentences.indexOf(state.cur) + 1} / ${state.sentences.length}`;
    if (quiet) return added;
    if (state.showDone && state.view === 'practice') {
      open(first.id); // 完成页上收到新句子（比如别的设备加练了），直接开始练
      return added;
    }
    toast(`句库更新：新增 ${added.length} 句`, { label: '去练习', fn: () => open(first.id) });
    return added;
  } catch {
    // 下次再看
  }
}

/** 先改本地，再存到服务器 */
export function saveRecord(id: string, patch: RecordPatch): void {
  state.records[id] = {
    ...(state.records[id] || { sentenceId: id, done: false }),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  api.saveRecord(id, patch).catch((e: Error) => toast(`保存失败：${e.message}`));
  renderBank();
  renderTask();
}

let draftTimer: ReturnType<typeof setTimeout> | undefined;

/** 译文草稿：停止输入 0.9 秒后再存 */
export function saveDraft(id: string, text: string): void {
  state.records[id] = { ...(state.records[id] || { sentenceId: id, done: false }), draft: text };
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => saveRecord(id, { draft: text }), 900);
}

/** 马上要存整份草稿时，取消还没存的那次 */
export const cancelDraftSave = (): void => clearTimeout(draftTimer);

export function initData(): void {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void checkNewSentences();
  });
  setInterval(() => void checkNewSentences(), 10 * 60 * 1000);
}
