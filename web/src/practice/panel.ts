// 三个步骤：标签栏、下面的面板（圈谓语 / 看结构 / 翻译），以及面板里的各种按钮
import type { Seg } from '@sentence-site/shared';
import { DEFK, KB, ROLES } from '@sentence-site/shared/kb';
import { flat, toks, type Tok } from '@sentence-site/shared/text';
import * as A from '../lib/anim.ts';
import { $, all, closest } from '../lib/dom.ts';
import { esc } from '../lib/format.ts';
import * as speech from '../lib/speech.ts';
import { C, ICON, ROLE_CLS } from '../styles.ts';
import { state } from '../state.ts';
import { renderBank } from './bank.ts';
import { showView } from '../views.ts';
import { saveDraft, saveRecord } from './data.ts';
import { fixHTML, saveFix } from './fix.ts';
import { move } from './nav.ts';
import { stopSpeak } from './reading.ts';
import { renderSentence } from './sentence.ts';
import { showDonePage } from './task.ts';
import { grade, pickOption, retryQuiz, step3HTML } from './translate.ts';

export function renderTabs(): void {
  A.moveIndicator($('tabInd'), state.step - 1);
  all('#tabs [data-s]').forEach((b) => b.setAttribute('aria-selected', String(Number(b.dataset.s) === state.step)));
  // 这一句正在批改：第 3 步的标签上转个小圈（在第 1、2 步时也看得到）
  const busy = !!state.cur && state.grading.has(state.cur.id);
  $('tabSpin').classList.toggle('hidden', !busy);
  ['tabs', 'nav', 'panel'].forEach((id) => $(id).classList.toggle('hidden', !state.cur));
}

/** 整句的词块（第 1 步点选的单位） */
function allToks(segs: Seg[]): Tok[] {
  const t: Tok[] = [];
  segs.forEach((g) => toks(g.t).forEach((x) => t.push(x)));
  return t;
}

function step1HTML(): string {
  const { cur, checked, picked } = state;
  if (!cur) return '';
  if (state.fix) return fixHTML();
  const t = allToks(cur.segs);
  let res = '';
  if (checked) {
    let ok = 0;
    let miss = 0;
    let wrong = 0;
    let total = 0;
    t.forEach((x, i) => {
      const sel = picked.has(i);
      if (x.k) {
        total++;
        if (sel) ok++;
        else miss++;
      } else if (sel) wrong++;
    });
    const mainV = t
      .filter((x) => x.k === 'main')
      .map((x) => x.t)
      .join(' / ');
    const perfect = !miss && !wrong;
    res = `<div class="flex flex-col gap-1.5 rounded-xl px-3.5 py-3 text-[14.5px] ${perfect ? 'bg-ok-soft' : 'bg-bad-soft'}">
        <strong class="text-[15.5px]">${perfect ? '全部找对。' : `找对 ${ok} / ${total} 个${miss ? `，漏选 ${miss} 个` : ''}${wrong ? `，多选 ${wrong} 个` : ''}。`}</strong>
        <span>主句谓语是 <b>${esc(mainV)}</b>（绿底），其余圈出的是从句里的谓语。条纹表示漏选，划线表示它不是谓语。</span>
        <span class="text-muted">规律：本句有 ${total} 个谓语，就说明有 ${total - 1} 个从句。</span>
        ${cur.trap ? `<span class="text-[14px]"><span class="font-mono text-[11px] font-medium tracking-[.08em] text-bad">陷阱 </span>${esc(cur.trap)}</span>` : ''}</div>
      <div class="${C.row}"><button class="${C.btnPrimary}" data-go="2">下一步：看结构</button><button class="${C.btn}" data-act="reset">再做一次</button><button class="${C.btn}" data-act="fix">这题有误</button></div>`;
  }
  return `<p class="m-0">点出句子里<b>所有谓语动词</b>，包括从句里的。<small class="mt-0.5 block text-[13px] text-muted">短语算一个整体，例如 was published。</small></p>
    <details class="${C.card} px-3.5 py-2.5 text-[14px]"><summary class="cursor-pointer font-semibold text-accent">知识点：谓语和非谓语怎么区分</summary>
      <ul class="mt-2 mb-0.5 flex list-disc flex-col gap-1 pl-[18px]">
        <li><b>谓语</b>有时态、能和主语搭配：is / was / has done / will do / can do / does。</li>
        <li><b>非谓语</b>不能单独做谓语：to do（不定式）、doing（现在分词 / 动名词）、done（前面没有 be / have 的过去分词）。</li>
        <li><b>数量规律</b>：谓语个数 = 从句个数 + 1。每多一个引导词（who / which / that / when…），就多一个谓语。</li></ul></details>
    ${checked ? res : `<div class="${C.row}"><button class="${C.btnPrimary}" data-act="check" ${picked.size ? '' : 'disabled'}>检查</button><button class="${C.btn}" data-act="clear" ${picked.size ? '' : 'disabled'}>清空</button><span class="text-[13px] text-muted">已选 ${picked.size} 个</span></div>`}`;
}

/** 第 2 步点开某一段时的知识点卡片 */
function kcardHTML(g: Seg): string {
  const kb = KB[g.k] || KB[DEFK[g.r]];
  const rc = ROLE_CLS[g.r] || ROLE_CLS.main;
  const src = g.t.replace(/[*^]/g, '');
  return `<div data-kcard class="flex flex-col gap-2 rounded-[14px] border-[1.5px] bg-sheet p-3.5 ${rc.border}">
    <div class="flex flex-wrap items-center gap-2"><span class="rounded-full px-2 py-0.5 font-mono text-[11.5px] font-medium tracking-[.06em] ${rc.soft} ${rc.text}">${ROLES[g.r].name}</span><span class="text-[16px] font-bold">${esc(kb?.t)}</span>
      ${speech.TTS ? `<button class="ml-auto ${C.iconBtn}" data-say="${esc(src)}" aria-label="朗读这一段">${ICON.play}</button>` : ''}</div>
    <p class="m-0">${esc(g.n)}</p>
    <p class="m-0 border-l-[3px] pl-2.5 font-en text-[14.5px] italic text-muted ${rc.border}">${esc(src)}</p>
    <div class="flex flex-col gap-1.5 rounded-[10px] bg-raise px-3 py-2.5"><span class="${C.label}">知识点</span>
      <dl class="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[14px]">
        <dt class="whitespace-nowrap font-semibold ${rc.text}">怎么认</dt><dd class="m-0 min-w-0">${esc(kb?.how)}</dd>
        <dt class="whitespace-nowrap font-semibold ${rc.text}">怎么译</dt><dd class="m-0 min-w-0">${esc(kb?.tr)}</dd>
        <dt class="whitespace-nowrap font-semibold ${rc.text}">例</dt><dd class="m-0 min-w-0 font-en">${esc(kb?.ex)}</dd></dl></div></div>`;
}

function step2HTML(): string {
  const { cur, segPick, roleOn, mainOnly } = state;
  if (!cur) return '';
  const used = [...new Set(cur.segs.map((g) => g.r))];
  const ks = [...new Set(cur.segs.map((g) => g.k))];
  const picked = segPick >= 0 ? cur.segs[segPick] : undefined;
  const pk = picked ? picked.k : null;
  const chips = Object.entries(ROLES)
    .filter(([k]) => used.includes(k as Seg['r']))
    .map(
      ([k, v]) =>
        `<button data-role="${k}" aria-pressed="${!!roleOn[k]}" class="inline-flex cursor-pointer items-center gap-1.5 rounded-full border-[1.5px] border-line bg-sheet py-1 pr-3 pl-2 text-[13.5px] transition-opacity aria-[pressed=false]:opacity-45"><i class="h-3 w-3 rounded-[3px] border-b-[2.5px] ${ROLE_CLS[k as Seg['r']].swatch}"></i><span class="${roleOn[k] ? '' : 'line-through'}">${v.name}</span></button>`,
    )
    .join('');
  return `<div class="flex flex-wrap gap-1.5">${chips}</div>
    <button role="switch" aria-checked="${mainOnly}" data-act="mainonly" class="group flex w-max cursor-pointer items-center gap-2.5 text-[14.5px] select-none">
      <span class="relative h-[23px] w-10 flex-none rounded-full bg-line transition-colors group-aria-checked:bg-accent"><span class="absolute top-[3px] left-[3px] h-[17px] w-[17px] rounded-full bg-sheet transition-transform group-aria-checked:translate-x-[17px]"></span></span>只看主干</button>
    <div class="flex flex-wrap items-center gap-1.5"><span class="${C.label}">本句知识点</span>${ks.map((k) => `<button data-k="${k}" class="cursor-pointer rounded-lg border-[1.5px] bg-sheet px-2.5 py-1 text-[13px] ${k === pk ? 'border-ink font-semibold' : 'border-line'}">${esc(KB[k]?.t)}</button>`).join('')}</div>
    <div id="kslot">${picked ? kcardHTML(picked) : `<div class="${C.note}">点句子里任意一段彩色部分，或上面的知识点，这里会讲它是什么成分、修饰谁、怎么认、怎么译。</div>`}</div>
    <div class="${C.card} flex flex-col gap-0.5 px-3.5 py-3"><span class="${C.label}">主干</span><span class="font-en text-[16px]">${esc(cur.trunk)}</span><span class="text-[14px] text-muted">${esc(cur.trunkZh)}</span></div>
    <div class="${C.row}"><button class="${C.btnPrimary}" data-go="3">下一步：翻译</button></div>`;
}

export function renderPanel(enter: boolean): void {
  const p = $('panel');
  if (!state.cur) {
    p.innerHTML = '';
    return;
  }
  p.innerHTML = state.step === 1 ? step1HTML() : state.step === 2 ? step2HTML() : step3HTML();
  if (enter) A.enter(p.children);
  // 看到了后台批改好的结果：句库圆点上的小点去掉
  if (state.step === 3 && state.view === 'practice' && state.gradeUnseen.delete(state.cur.id)) renderBank();
  if (state.step === 3 && state.freshFb) {
    state.freshFb = false;
    A.score(p.querySelector('[data-fb]'));
  }
}

/**
 * 重新渲染时让步骤标签停在屏幕上原来的位置：上方句子卡片高度变了就跟着滚动补回；
 * 下方内容变短、页面滚不回原位时，给面板补一点最小高度（换句子时清掉）。
 */
export function pinTabs(fn: () => void): void {
  const tabs = $('tabs');
  const panel = $('panel');
  const top = () => tabs.getBoundingClientRect().top;
  const before = top();
  fn();
  let d = top() - before;
  if (Math.abs(d) < 1) return;
  window.scrollBy({ top: d, behavior: 'instant' });
  d = top() - before;
  if (d >= 1) {
    panel.style.minHeight = `${panel.offsetHeight + d}px`;
    window.scrollBy({ top: d, behavior: 'instant' });
  }
}

export function setStep(n: 1 | 2 | 3): void {
  if (state.step === n || !state.cur) return;
  if (state.speaking) stopSpeak();
  state.step = n;
  state.wordSel = null;
  state.fix = null;
  if (n === 2) state.sweepPending = true;
  pinTabs(() => {
    renderTabs();
    renderSentence();
    renderPanel(true);
  });
}

const toStep = (v: string | undefined): 1 | 2 | 3 => (v === '2' ? 2 : v === '3' ? 3 : 1);

/** 第 1 步“检查”：统计找对、漏选、多选，存进练习记录 */
function check(): void {
  const { cur, picked } = state;
  if (!cur) return;
  state.checked = true;
  let ok = 0;
  let total = 0;
  let wrong = 0;
  allToks(cur.segs).forEach((x, i) => {
    const sel = picked.has(i);
    if (x.k) {
      total++;
      if (sel) ok++;
    } else if (sel) wrong++;
  });
  saveRecord(cur.id, { verbs: { ok, total, wrong } });
  pinTabs(() => {
    renderSentence();
    renderPanel(true);
  });
  A.popTextEach($('sentence').querySelectorAll('[data-t]'));
}

function onPanelClick(e: MouseEvent): void {
  const { cur } = state;
  if (!cur) return;
  const go = closest(e, '[data-go]');
  if (go) return setStep(toStep(go.dataset.go));
  const chip = closest(e, '[data-role]');
  if (chip?.dataset.role) {
    const r = chip.dataset.role;
    state.roleOn[r] = !state.roleOn[r];
    renderSentence();
    renderPanel(false);
    return;
  }
  const kp = closest(e, '[data-k]');
  if (kp) {
    const i = cur.segs.findIndex((g) => g.k === kp.dataset.k);
    state.segPick = state.segPick === i ? -1 : i;
    renderSentence();
    renderPanel(false);
    if (state.segPick >= 0) A.slideIn($('panel').querySelector('[data-kcard]'));
    return;
  }
  const opt = closest(e, '[data-opt]');
  if (opt && state.answer < 0) {
    pickOption(opt);
    return;
  }
  const a = closest(e, '[data-act]');
  if (!a) return;
  switch (a.dataset.act) {
    case 'check':
      check();
      return;
    case 'clear':
      state.picked.clear();
      break;
    case 'fix':
      state.wordSel = null;
      state.fix = { tag: flat(cur).map((x) => x.k), busy: '', msg: '' };
      pinTabs(() => {
        renderSentence();
        renderPanel(true);
      });
      return;
    case 'fixCancel':
      state.fix = null;
      break;
    case 'fixSave':
    case 'fixAi':
      void saveFix(a.dataset.act === 'fixAi');
      return;
    case 'reset':
      state.picked.clear();
      state.checked = false;
      break;
    case 'mainonly':
      state.mainOnly = !state.mainOnly;
      break;
    case 'skip':
      state.quizOpen = true;
      renderPanel(false);
      A.enter(document.getElementById('quiz')?.children);
      return;
    case 'grade':
      void grade();
      return;
    case 'retry':
      retryQuiz();
      return;
    case 'next':
      move(1);
      return;
    case 'showDone':
      showDonePage();
      return;
    case 'gosettings':
      showView('settings');
      return;
    default:
      return;
  }
  pinTabs(() => {
    renderSentence();
    renderPanel(false);
  });
}

export function initPanel(): void {
  $('tabs').addEventListener('click', (e) => {
    const b = closest(e, '[data-s]');
    if (b) setStep(toStep(b.dataset.s));
  });
  $('panel').addEventListener('click', onPanelClick);
  $('panel').addEventListener('input', (e) => {
    const t = e.target as HTMLTextAreaElement;
    if (t.id === 'draft' && state.cur) saveDraft(state.cur.id, t.value);
  });
}
