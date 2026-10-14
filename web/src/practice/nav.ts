// 换句子：打开某一句、上一句 / 下一句、刚打开页面时挑哪一句、删除当前这一句
import { api } from '../lib/api.ts';
import { $ } from '../lib/dom.ts';
import { shuffle } from '../lib/format.ts';
import { toast } from '../lib/toast.ts';
import { state, saveUI, rec, taskInfo } from '../state.ts';
import { renderAll } from '../views.ts';
import { stopSpeak } from './reading.ts';
import { renderDone } from './task.ts';

/** 打开一句，所有步骤从头开始。keepView：不切回练习页（刷新时停在别的页） */
export function open(id: string, { keepView = false } = {}): void {
  const s = state.sentences.find((x) => x.id === id);
  if (!s) return;
  if (state.speaking) stopSpeak();
  state.cur = s;
  state.ui.cur = s.id;
  saveUI();
  Object.assign(state, {
    showDone: false,
    step: 1,
    picked: new Set<number>(),
    checked: false,
    mainOnly: false,
    segPick: -1,
    wordSel: null,
    quizOpen: false,
    grading: false,
    gradeErr: '',
    freshFb: false,
    fix: null,
    roleOn: { main: true, attr: true, noun: true, adv: true, nonfin: true },
    optOrder: shuffle(s.opts.length),
  });
  disarmDelete();
  $('panel').style.minHeight = '';
  const c = rec(s.id)?.choice;
  state.answer = c && c.pick >= 0 && c.pick < s.opts.length ? c.pick : -1;
  if (!keepView) state.view = 'practice';
  renderAll(true);
}

export function move(d: number): void {
  const { cur, sentences } = state;
  if (!cur || !sentences.length) return;
  const i = sentences.indexOf(cur);
  const next = sentences[(i + d + sentences.length) % sentences.length];
  if (next) open(next.id);
}

/** 刚打开页面：先做今日任务里没做完的，再回到上次那句，都没有就挑第一句没完成的 */
export function pickInitial(): void {
  const { sentences, ui } = state;
  if (!sentences.length) {
    state.cur = null;
    renderAll(false);
    return;
  }
  const t = taskInfo();
  const todo = t.list.find((s) => !rec(s.id)?.done);
  const lastInTask = ui.cur && t.list.some((s) => s.id === ui.cur) && !rec(ui.cur)?.done;
  if (todo && !lastInTask) open(todo.id, { keepView: true });
  else if (ui.cur && sentences.some((s) => s.id === ui.cur)) open(ui.cur, { keepView: true });
  else {
    const pick = sentences.find((s) => !rec(s.id)?.done) || sentences.at(-1);
    if (pick) open(pick.id, { keepView: true });
  }
  if (t.complete) {
    state.showDone = true;
    renderDone(false);
  }
}

// ---------- 删除 ----------
let deleteArmed: ReturnType<typeof setTimeout> | null = null;

export function disarmDelete(): void {
  if (deleteArmed) clearTimeout(deleteArmed);
  deleteArmed = null;
  const b = $('more');
  b.textContent = '删除';
  b.classList.remove('border-bad', 'text-bad');
}

/** 第一次点变成“确认删除？”，3 秒内再点才删 */
async function onDelete(): Promise<void> {
  const { cur } = state;
  if (!cur) return;
  if (!deleteArmed) {
    const b = $('more');
    b.textContent = '确认删除？';
    b.classList.add('border-bad', 'text-bad');
    deleteArmed = setTimeout(disarmDelete, 3000);
    return;
  }
  disarmDelete();
  const id = cur.id;
  const i = state.sentences.indexOf(cur);
  try {
    await api.deleteSentence(id);
    state.sentences = state.sentences.filter((x) => x.id !== id);
    delete state.records[id];
    delete state.attempts[id];
    toast('已删除这一句');
    const next = state.sentences[Math.min(i, state.sentences.length - 1)];
    if (next) open(next.id);
    else {
      state.cur = null;
      renderAll(false);
    }
  } catch (e) {
    toast((e as Error).message);
  }
}

export function initNav(): void {
  $('prev').onclick = () => move(-1);
  $('next').onclick = () => move(1);
  $('more').onclick = () => void onDelete();
}
