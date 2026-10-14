// 长难句拆解台 · 页面逻辑
import { api, setUnauthorizedHandler } from './api.js';
import { ROLES, ROLE_CLS, KB, DEFK } from './kb.js';
import { esc, toks, plain, flat, phraseMap, trunkWords, diff, fmtDay, fmtTime, scoreTone, shuffle } from './text.js';
import * as speech from './speech.js';
import * as A from './anim.js';
import { createSettingsView } from './settings.js';
import { createTaskSettings, levelText } from './practice.js';

const $ = (id) => document.getElementById(id);
const ls = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};
const LS_UI = 'ssite-ui';
const LS_DICT = 'ssite-dict';

// ---------- 样式（Tailwind 类名需完整写出） ----------
const C = {
  btn: 'cursor-pointer rounded-full border-[1.5px] border-line bg-sheet px-4 py-2 text-[14.5px] transition-transform active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-45',
  btnPrimary: 'cursor-pointer rounded-full border-[1.5px] border-accent bg-accent px-4 py-2 text-[14.5px] font-semibold text-on-accent transition-transform active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-45',
  btnSmall: 'cursor-pointer rounded-full border-[1.5px] border-line bg-sheet px-3 py-1.5 text-[13.5px] transition-transform active:scale-[.97]',
  iconBtn: 'inline-flex h-[30px] w-[30px] flex-none cursor-pointer items-center justify-center rounded-full border-[1.5px] border-line bg-sheet',
  label: 'font-mono text-[11px] tracking-[.1em] uppercase text-muted',
  row: 'flex flex-wrap items-center gap-2',
  card: 'rounded-xl border border-line bg-sheet',
  note: 'rounded-xl border-[1.5px] border-dashed border-line p-3.5 text-[14.5px] text-muted',
  shim: 'h-[11px] rounded-md bg-line animate-pulse',
  spin: 'inline-block h-4 w-4 flex-none animate-spin rounded-full border-2 border-line border-t-accent',
};
const TONE = {
  good: { text: 'text-ok', stroke: 'stroke-ok', bg: 'bg-ok', soft: 'bg-ok-soft' },
  mid: { text: 'text-mid', stroke: 'stroke-mid', bg: 'bg-mid', soft: 'bg-mid-soft' },
  low: { text: 'text-bad', stroke: 'stroke-bad', bg: 'bg-bad', soft: 'bg-bad-soft' },
};
const ICON = {
  play: '<svg class="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 6h2.5L9 3v10L5.5 10H3z"/><path d="M11.5 5.5a3.5 3.5 0 0 1 0 5M13 3.5a6 6 0 0 1 0 9"/></svg>',
  close: '<svg class="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
};

// ---------- 状态 ----------
let sentences = [];
let records = {}; // sentenceId -> record
let attempts = {}; // sentenceId -> [attempt]（新的在前）
let usage = null;
let ui = ls.get(LS_UI, {}) || {};
let dictCache = ls.get(LS_DICT, {}) || {};
let view = ['records', 'settings'].includes(ui.view) ? ui.view : 'practice';
let loaded = false;

let cur = null;
let step = 1;
let picked = new Set();
let checked = false;
let roleOn = {};
let mainOnly = false;
let segPick = -1;
let optOrder = [];
let answer = -1;
let freshAnswer = false;
let dictMode = false;
let wordSel = null;
let sweepPending = false;
let quizOpen = false;
let grading = false;
let gradeErr = '';
let freshFb = false;
let practiceCfg = { levels: ['CET-4', 'CET-6'], dailyCount: 5, maxDaily: 10, dailyAt: '7:50', autoDaily: true };
let showDone = false; // 今日任务全部完成时，练习页显示完成页（点开某一句复习时关掉）
let taskBusy = ''; // daily | extra：正在生成
let taskBusyN = 0;
let taskErr = '';
let extraOpen = false; // 任务卡片里的“加练”展开
let extraCount = 3;
let celebrate = false; // 刚完成最后一句，完成页要放庆祝动画
let deleteArmed = null;
let fix = null; // 修正谓语标注：{ tag: 每个单词是 'main' | 'sub' | null, busy: ''|'save'|'ai', msg }
let speaking = false;
let lookupBusy = null;
let lookupErr = null;

const saveUI = () => ls.set(LS_UI, ui);
const rec = (id) => records[id] || null;
const atts = (id) => attempts[id] || [];
const lastAttempt = (id) => atts(id)[0] || null;

// ---------- 数据 ----------
async function loadAll() {
  const [s, r, a, u, p] = await Promise.all([
    api.sentences(),
    api.records(),
    api.attempts(),
    api.usage().catch(() => null),
    api.practiceSettings().catch(() => null),
  ]);
  sentences = s.sentences;
  if (p) practiceCfg = p;
  records = {};
  r.records.forEach((x) => (records[x.sentenceId] = x));
  attempts = {};
  a.attempts.forEach((x) => (attempts[x.sentenceId] ||= []).push(x));
  usage = u;
  loaded = true;
  const lastVisit = ui.lastVisit ? Date.parse(ui.lastVisit) : 0;
  const fresh = lastVisit ? sentences.filter((x) => Date.parse(x.created) > lastVisit) : [];
  ui.lastVisit = new Date().toISOString();
  saveUI();
  pickInitial();
  if (fresh.length) toast(`自上次练习以来新增 ${fresh.length} 句`, { label: '去练习', fn: () => open(fresh[0].id) });
}

async function checkNewSentences(quiet = false) {
  if (!loaded || (document.hidden && !quiet)) return;
  const last = sentences.at(-1)?.created;
  try {
    const r = await api.sentences(last);
    const known = new Set(sentences.map((x) => x.id));
    const added = r.sentences.filter((x) => !known.has(x.id));
    if (!added.length) return;
    sentences = sentences.concat(added);
    renderBank();
    renderTask();
    if (cur) $('label').textContent = `句子 ${sentences.indexOf(cur) + 1} / ${sentences.length}`;
    if (quiet) return added;
    if (showDone && view === 'practice') {
      open(added[0].id); // 完成页上收到新句子（比如别的设备加练了），直接开始练
      return added;
    }
    toast(`句库更新：新增 ${added.length} 句`, { label: '去练习', fn: () => open(added[0].id) });
    return added;
  } catch {}
}

function saveRecord(id, patch) {
  records[id] = { ...(records[id] || { sentenceId: id, done: false }), ...patch, updatedAt: new Date().toISOString() };
  api.saveRecord(id, patch).catch((e) => toast(`保存失败：${e.message}`));
  renderBank();
  renderTask();
}

let draftTimer = null;
function saveDraft(id, text) {
  records[id] = { ...(records[id] || { sentenceId: id, done: false }), draft: text };
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => saveRecord(id, { draft: text }), 900);
}

// ---------- 句库 ----------
function renderBank() {
  const el = $('bank');
  const total = sentences.length;
  const done = sentences.filter((s) => rec(s.id)?.done).length;
  $('bankCount').textContent = total ? `共 ${total} 句 · 已完成 ${done}` : '';
  if (!total) {
    el.innerHTML = `<p class="m-0 text-[14px] text-muted">${loaded ? '句库还是空的，生成今天的任务就有句子了。' : '正在加载句库…'}</p>`;
    return;
  }
  const td = today();
  const groups = [];
  let g = null;
  sentences.forEach((s, i) => {
    if (!g || g.b !== s.batch) groups.push((g = { b: s.batch, items: [] }));
    g.items.push({ s, i });
  });
  const newCut = Date.now() - 3 * 864e5;
  el.innerHTML = groups
    .map((gr) => `<div class="flex flex-none flex-col gap-1.5">
      <span class="whitespace-nowrap font-mono text-[11px] tracking-[.04em] text-muted">${gr.b === td ? '<b class="font-medium text-accent">今天</b> ' : ''}${esc(fmtDay(gr.b))}</span>
      <div class="flex gap-1.5">${gr.items.map(({ s, i }) => dotHTML(s, i, newCut)).join('')}</div></div>`)
    .join('');
  const d = el.querySelector('[data-cur]');
  if (d) el.scrollLeft = Math.max(0, d.offsetLeft - el.clientWidth / 2 + d.offsetWidth / 2);
}

function dotHTML(s, i, newCut) {
  const r = rec(s.id);
  const tried = r || atts(s.id).length;
  const isCur = cur && s.id === cur.id;
  let tone = 'border-line bg-sheet text-muted';
  if (r?.done) tone = 'border-ok bg-ok-soft text-ok';
  else if (tried) tone = 'border-mid bg-sheet text-mid';
  if (isCur) tone = (r?.done ? 'bg-ok-soft' : 'bg-sheet') + ' border-accent text-accent ring-[3px] ring-accent-soft';
  const isNew = !tried && Date.parse(s.created) > newCut;
  return `<button data-sid="${esc(s.id)}" ${isCur ? 'data-cur' : ''} aria-label="第 ${i + 1} 句${r?.done ? '，已完成' : ''}"
    class="relative h-8 w-8 flex-none cursor-pointer rounded-full border-[1.5px] font-mono text-[12.5px] tabular-nums transition-transform hover:-translate-y-0.5 ${tone}">${i + 1}${isNew ? '<span class="absolute -top-0.5 -right-0.5 h-[9px] w-[9px] rounded-full border-2 border-paper bg-r-adv"></span>' : ''}</button>`;
}

// ---------- 句子 ----------
// 句子排版：每个单词放进左右各留 3px 的“槽”（data-wi），所有步骤、所有状态下槽都一样宽，单词之间只隔一个空格。
// 圈选、底色、描边、加粗、删除线都画在槽或分组上，不改变宽度；分组用可以跨行断开的 span，
// 所以句子在任何步骤、点选前后，换行位置都完全一样，不会跳动。
const SLOT = 'inline rounded-[5px] px-[3px] [line-height:inherit]';
const GROUP = 'rounded-full box-decoration-clone [line-height:inherit] transition-colors data-[reading]:bg-read';
// 单词前后的标点（引号、逗号、句号）用负边距收进槽的留白里，读起来紧贴单词，宽度在各步骤里同样不变
const leadHTML = (x) => (x.lead ? `<span class="-mr-[3px]">${esc(x.lead)}</span>` : '');
const trailHTML = (x) => (x.trail ? `<span class="-ml-[3px]">${esc(x.trail)}</span>` : '');
// 可点的单词也用 span（role=button），不用 button：button 是整块的行内元素，和普通文字的断行规则不同
const slotHTML = (x, i, cls = '', attrs = '') =>
  `${leadHTML(x)}<span data-wi="${i}" class="${SLOT} ${cls}" ${attrs}>${esc(x.core)}</span>`;
/** 把连续的单词按 key 分组（同一个词块 / 同一段），返回 [{key, a, b}]，a、b 是单词下标 */
function groupsOf(fw, key) {
  const out = [];
  fw.forEach((x, i) => {
    const last = out.at(-1);
    if (last && last.key === x[key]) last.b = i;
    else out.push({ key: x[key], a: i, b: i });
  });
  return out;
}
/** 一组单词：组内单词用空格隔开，最后一个词后面的标点放到组外 */
function groupHTML(fw, g, inner, open, close = '</span>') {
  const parts = [];
  for (let i = g.a; i <= g.b; i++) parts.push(inner(fw[i], i) + (i < g.b ? trailHTML(fw[i]) : ''));
  return `${open}${parts.join(' ')}${close}${trailHTML(fw[g.b])}`;
}

function renderSentence() {
  const el = $('sentence');
  const hint = $('hint');
  if (!cur) {
    $('label').textContent = '';
    $('focus').textContent = '';
    $('lvl').classList.add('hidden');
    $('tools').classList.add('invisible');
    $('pin').classList.add('invisible');
    el.innerHTML = loaded
      ? '<span class="flex flex-col gap-2 py-1.5"><span class="font-head text-[20px] font-bold">句库还是空的</span><span class="font-zh text-[15px] text-muted">每天早上 7:50 会自动加入 5 句新句子，也可以点上方“生成 5 句新句子”马上开始。</span></span>'
      : `<span class="flex flex-col gap-3 py-2"><span class="${C.shim} h-4"></span><span class="${C.shim} h-4 w-[86%]"></span><span class="${C.shim} h-4 w-[60%]"></span></span>`;
    hint.classList.add('hidden');
    $('wordCard').innerHTML = '';
    return;
  }
  $('tools').classList.remove('invisible');
  $('pin').classList.remove('invisible');
  hint.classList.remove('hidden');
  $('label').textContent = `句子 ${sentences.indexOf(cur) + 1} / ${sentences.length}`;
  $('lvl').classList.toggle('hidden', !cur.level);
  $('lvl').textContent = cur.level;
  $('focus').textContent = cur.focus;
  const dict = (dictMode && !fix) || step === 3;
  // 第 3 步一直是查词状态：按钮保持原位、显示为按下且不能点，工具栏不会因为它消失而挪动
  $('dict').disabled = step === 3 || !!fix;
  $('dict').setAttribute('aria-pressed', String(dict));
  const fw = flat(cur);

  if (dict) {
    const pm = phraseMap(cur, fw);
    el.innerHTML = fw
      .map((x, i) => {
        let c = 'cursor-pointer transition-colors hover:bg-accent-soft data-[reading]:bg-read';
        if (pm[i] != null) c += ' underline decoration-dotted decoration-accent decoration-2 underline-offset-[5px]';
        if (step === 3 && x.k) c += ' fake-bold';
        if (wordSel === i) c += ' bg-accent text-on-accent hover:bg-accent';
        return slotHTML(x, i, c, `data-w="${i}" data-a="${i}" data-b="${i}" role="button" tabindex="0"`) + trailHTML(x);
      })
      .join(' ');
    hint.textContent = (cur.phrases || []).length ? '点单词看释义，虚线下划线是固定搭配。' : '点单词看释义。';
  } else if (step === 1 && fix) {
    hint.textContent = '点词标出正确的谓语。';
    el.innerHTML = fw
      .map((x, i) => {
        const k = fix.tag[i];
        let c = `transition-colors ${fix.busy ? 'cursor-default' : 'cursor-pointer hover:bg-accent-soft'}`;
        if (k === 'main') c += ' bg-ok-soft fake-bold text-ok shadow-[inset_0_0_0_2px_var(--ok)]';
        else if (k === 'sub') c += ' text-ok shadow-[inset_0_0_0_2px_var(--ok)]';
        const label = `${esc(x.core)}：${k === 'main' ? '主句谓语' : k === 'sub' ? '从句谓语' : '不是谓语'}`;
        return slotHTML(x, i, c, `data-fx="${i}" aria-label="${label}" role="button" tabindex="0"`) + trailHTML(x);
      })
      .join(' ');
  } else if (step === 1) {
    hint.textContent = checked ? '绿框是谓语，绿底是主句谓语。' : '点出句子里所有的谓语动词。';
    // 词块用 span（不是 button），was published 这种多词词块到行尾时可以和别的步骤一样断开换行
    el.innerHTML = groupsOf(fw, 'ti')
      .map((g) => {
        const t = g.key;
        const k = fw[g.a].k;
        const sel = picked.has(t);
        let c = GROUP;
        if (checked) {
          if (k && sel) c += ' shadow-[inset_0_0_0_2px_var(--ok)] text-ok';
          else if (k) c += ' shadow-[inset_0_0_0_2px_var(--ok)] text-ok bg-[repeating-linear-gradient(135deg,var(--ok-soft)_0_4px,transparent_4px_8px)]';
          else if (sel) c += ' shadow-[inset_0_0_0_2px_var(--bad)] text-bad line-through';
          if (k === 'main') c += ' bg-ok-soft fake-bold';
          c += ' cursor-default';
        } else {
          c += ' cursor-pointer hover:bg-accent-soft';
          if (sel) c += ' shadow-[inset_0_0_0_2px_var(--accent)] text-accent';
        }
        const attrs = `class="${c}" data-t="${t}" data-a="${g.a}" data-b="${g.b}" role="button" ${checked ? 'aria-disabled="true"' : 'tabindex="0"'} aria-pressed="${sel}"`;
        return groupHTML(fw, g, (x, i) => slotHTML(x, i), `<span ${attrs}>`);
      })
      .join(' ');
  } else {
    hint.textContent = '点彩色片段，看它是什么成分、修饰谁。';
    // 只看主干：按主干句里的词点亮（宾语从句这类主干缺不了的从句骨架也会保留）；主干对不上原句时退回按成分颜色
    const tw = mainOnly ? trunkWords(cur) : null;
    el.innerHTML = groupsOf(fw, 'si')
      .map((sg) => {
        const si = sg.key;
        const g = cur.segs[si];
        const rc = ROLE_CLS[g.r] || ROLE_CLS.main;
        let c = `cursor-pointer rounded-[3px] py-0.5 box-decoration-clone bg-[linear-gradient(var(--hl),var(--hl))] bg-no-repeat border-b-[2.5px] transition-opacity duration-200 data-[reading]:outline-2 data-[reading]:outline-read ${rc.hl}`;
        const colored = roleOn[g.r] && !(tw && g.r !== 'main');
        c += colored ? ` ${rc.border}` : ' border-transparent';
        if (mainOnly && !tw && g.r !== 'main') c += ' opacity-20';
        if (segPick === si) c += ' outline-2 outline-offset-1 outline-ink';
        const word = (x, i) => slotHTML(x, i, tw && !tw.has(i) ? 'opacity-20' : '');
        // 段内再按词块分组：谓语词块整体加粗；主句谓语再画一条连贯的底线（用背景画，单词槽的留白处也连着）
        const parts = groupsOf(fw.slice(sg.a, sg.b + 1), 'ti').map((tg) => {
          const at = { a: tg.a + sg.a, b: tg.b + sg.a };
          const k = fw[at.a].k;
          if (!k) return groupHTML(fw, at, word, '', '');
          return groupHTML(fw, at, word, `<span class="fake-bold${k === 'main' ? ' box-decoration-clone bg-[linear-gradient(currentColor,currentColor)] bg-[length:100%_2px] bg-bottom bg-no-repeat' : ''}">`);
        });
        return `<span class="${c}" style="background-size:${colored ? '100%' : '0%'} 100%" data-seg="${si}" data-a="${sg.a}" data-b="${sg.b}" tabindex="0" role="button">${parts.join(' ')}</span>`;
      })
      .join(' ');
    if (sweepPending) {
      sweepPending = false;
      A.sweep(el.querySelectorAll('[data-seg]'));
    }
  }
  renderWordCard();
}

// ---------- 查词 ----------
function renderWordCard() {
  const box = $('wordCard');
  if (!cur || wordSel == null || !(dictMode || step === 3)) {
    box.innerHTML = '';
    return;
  }
  const fw = flat(cur);
  const w = fw[wordSel];
  if (!w) {
    box.innerHTML = '';
    return;
  }
  const pm = phraseMap(cur, fw);
  const ph = pm[wordSel] != null ? cur.phrases[pm[wordSel]] : null;
  const loc = (cur.words || []).find((x) => String(x.w || '').toLowerCase() === w.norm || String(x.lemma || '').toLowerCase() === w.norm);
  const key = `${w.norm}|${cur.id}`;
  const info = loc || dictCache[key];
  let body;
  if (info) {
    body = `<div class="text-[16px]">${esc(info.zh || '')}</div>${info.lemma && String(info.lemma).toLowerCase() !== w.norm ? `<div class="text-[13.5px] text-muted">原形 <span class="font-en">${esc(info.lemma)}</span></div>` : ''}${info.more ? `<div class="text-[13.5px] text-muted">其他常见义：${esc(info.more)}</div>` : ''}`;
  } else if (lookupBusy === key) {
    body = `<div class="${C.shim} w-[60%]"></div><div class="${C.shim} w-[40%]"></div>`;
  } else if (lookupErr && lookupErr.key === key) {
    body = `<div class="text-[13.5px] text-muted">${esc(lookupErr.msg)}</div>`;
  } else {
    body = '<div class="text-[13.5px] text-muted">正在查询…</div>';
    lookup(w, key);
  }
  const say = (t, label) => (speech.TTS ? `<button class="${C.iconBtn}" data-say="${esc(t)}" aria-label="${label}">${ICON.play}</button>` : '');
  const phHtml = ph
    ? `<div class="flex flex-wrap items-center gap-2 border-t border-dashed border-line pt-2 text-[14px]"><span class="rounded bg-accent-soft px-1.5 py-px font-mono text-[10.5px] tracking-[.08em] text-accent">搭配</span><span class="font-en font-semibold">${esc(ph.p || ph.m)}</span><span>${esc(ph.zh || '')}</span>${say(ph.p || ph.m, '朗读搭配')}</div>`
    : '';
  const fresh = !box.firstElementChild || box.firstElementChild.dataset.word !== key;
  box.innerHTML = `<div data-word="${esc(key)}" class="flex flex-col gap-1.5 rounded-xl bg-raise px-3.5 py-3">
    <div class="flex flex-wrap items-baseline gap-2"><span class="font-en text-[21px] font-semibold">${esc(w.core)}</span>${info?.pos ? `<span class="font-mono text-[12px] text-accent">${esc(info.pos)}</span>` : ''}${info?.ipa ? `<span class="font-en text-[14px] text-muted">${esc(info.ipa)}</span>` : ''}
      <span class="ml-auto flex gap-1.5">${say(w.core, '朗读单词')}<button class="${C.iconBtn}" data-act="closeWord" aria-label="关闭">${ICON.close}</button></span></div>
    ${body}${phHtml}</div>`;
  if (fresh) A.slideIn(box.firstElementChild);
}

async function lookup(w, key) {
  if (lookupBusy === key) return;
  lookupBusy = key;
  lookupErr = null;
  const s = cur;
  try {
    const r = await api.lookup(s.id, w.core);
    dictCache[key] = r.data;
    const keys = Object.keys(dictCache);
    if (keys.length > 500) keys.slice(0, 100).forEach((k) => delete dictCache[k]);
    ls.set(LS_DICT, dictCache);
  } catch (e) {
    lookupErr = { key, msg: e.message || '没查到，稍后再试' };
  }
  lookupBusy = null;
  if (cur === s) renderWordCard();
}

// ---------- 朗读 ----------
function updSpeakBtn() {
  const b = $('speak');
  b.classList.toggle('border-accent', speaking);
  b.classList.toggle('text-accent', speaking);
  $('speakTxt').textContent = speaking ? '停止' : '朗读';
  b.setAttribute('aria-label', speaking ? '停止朗读' : '朗读整句');
  A.equalizer(b.querySelectorAll('.eq'), speaking);
}
function clearReading() {
  document.querySelectorAll('#sentence [data-reading]').forEach((x) => x.removeAttribute('data-reading'));
}
function stopSpeak() {
  speech.stopSpeaking();
  speaking = false;
  clearReading();
  updSpeakBtn();
}
function sayText(text) {
  if (speaking) stopSpeak();
  speech.speak(text, { voiceName: ui.voice, rate: Number(ui.rate) || 0.9 });
}
function readSentence() {
  if (!cur) return;
  if (speaking) return stopSpeak();
  const text = plain(cur);
  const fw = flat(cur);
  const starts = [];
  let pos = 0;
  fw.forEach((w) => {
    const full = w.lead + w.core;
    const at = text.indexOf(full, pos);
    const st = at < 0 ? pos : at;
    starts.push(st + w.lead.length);
    pos = st + full.length;
  });
  speaking = true;
  updSpeakBtn();
  speech.speak(text, {
    voiceName: ui.voice,
    rate: Number(ui.rate) || 0.9,
    onWord: (ci) => {
      let wi = 0;
      for (let i = 0; i < starts.length; i++) {
        if (starts[i] <= ci + 1) wi = i;
        else break;
      }
      clearReading();
      for (const el of document.querySelectorAll('#sentence [data-a]')) {
        if (+el.dataset.a <= wi && wi <= +el.dataset.b) {
          el.setAttribute('data-reading', '');
          break;
        }
      }
    },
    onEnd: () => {
      speaking = false;
      clearReading();
      updSpeakBtn();
    },
  });
}
function fillVoices() {
  const voices = speech.loadVoices();
  const sel = $('voiceSel');
  sel.innerHTML = voices.length
    ? voices.map((v) => `<option value="${esc(v.name)}">${esc(v.name.replace(/^Microsoft |^Google /, ''))} · ${esc(v.lang)}</option>`).join('')
    : '<option value="">系统默认英文声音</option>';
  if (ui.voice && voices.some((v) => v.name === ui.voice)) sel.value = ui.voice;
}
function updRates() {
  const r = Number(ui.rate) || 0.9;
  document.querySelectorAll('#rates [data-rate]').forEach((b) => b.setAttribute('aria-pressed', String(Math.abs(+b.dataset.rate - r) < 0.01)));
}

// ---------- 步骤面板 ----------
function renderTabs() {
  A.moveIndicator($('tabInd'), step - 1);
  document.querySelectorAll('#tabs [data-s]').forEach((b) => b.setAttribute('aria-selected', String(+b.dataset.s === step)));
  ['tabs', 'nav', 'panel'].forEach((id) => $(id).classList.toggle('hidden', !cur));
}

/** 修正模式里标出的谓语：相邻、同一片段、中间没有标点的同类词连成一个 */
function fixSpans() {
  const fw = flat(cur);
  const spans = [];
  fix.tag.forEach((k, i) => {
    if (!k) return;
    const last = spans.at(-1);
    if (last && last.kind === k && last.b === i - 1 && fw[i - 1].si === fw[i].si && !fw[i - 1].trail) last.b = i;
    else spans.push({ kind: k, a: i, b: i });
  });
  return spans.map((sp) => ({ ...sp, text: fw.slice(sp.a, sp.b + 1).map((x) => x.core).join(' ') }));
}

function fixHTML() {
  const spans = fixSpans();
  const mains = spans.filter((x) => x.kind === 'main');
  const subs = spans.filter((x) => x.kind === 'sub');
  const ready = mains.length === 1;
  const list = (arr) => (arr.length ? arr.map((x) => `<b>${esc(x.text)}</b>`).join('、') : '无');
  return `<div class="flex flex-col gap-2 rounded-xl border-[1.5px] border-accent bg-sheet px-3.5 py-3 text-[14.5px]">
      <strong class="text-[15.5px]">修正这题的答案</strong>
      <span>在上面的句子里点词：点一下是<b>从句谓语</b>，再点是<b>主句谓语</b>（绿底），再点取消。相邻的词会连成一个，如 had failed。</span>
      <span class="text-[14px]">主句谓语：${list(mains)}；从句谓语：${list(subs)}</span>
      <span class="text-[13px] ${ready ? 'text-muted' : 'text-bad'}">${ready ? `本句 ${spans.length} 个谓语，${spans.length - 1} 个从句。` : '主句谓语要标且只标一处。'}</span>
      ${fix.msg ? `<span class="text-[13.5px] text-bad">${esc(fix.msg)}</span>` : ''}</div>
    <div class="${C.row}">
      <button class="${C.btnPrimary}" data-act="fixSave" ${ready && !fix.busy ? '' : 'disabled'}>${fix.busy === 'save' ? '保存中…' : '保存修改'}</button>
      <button class="${C.btn}" data-act="fixAi" ${aiOk() && !fix.busy ? '' : 'disabled'}>${fix.busy === 'ai' ? `<span class="inline-flex items-center gap-2"><span class="${C.spin}"></span>AI 复查中…</span>` : '让 AI 复查'}</button>
      <button class="${C.btn}" data-act="fixCancel" ${fix.busy ? 'disabled' : ''}>取消</button></div>`;
}

function step1HTML() {
  if (fix) return fixHTML();
  const t = [];
  cur.segs.forEach((g) => toks(g.t).forEach((x) => t.push(x)));
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
        sel ? ok++ : miss++;
      } else if (sel) wrong++;
    });
    const mainV = t.filter((x) => x.k === 'main').map((x) => x.t).join(' / ');
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

function kcardHTML(g) {
  const kb = KB[g.k] || KB[DEFK[g.r]];
  const rc = ROLE_CLS[g.r] || ROLE_CLS.main;
  const src = g.t.replace(/[*^]/g, '');
  return `<div data-kcard class="flex flex-col gap-2 rounded-[14px] border-[1.5px] bg-sheet p-3.5 ${rc.border}">
    <div class="flex flex-wrap items-center gap-2"><span class="rounded-full px-2 py-0.5 font-mono text-[11.5px] font-medium tracking-[.06em] ${rc.soft} ${rc.text}">${ROLES[g.r].name}</span><span class="text-[16px] font-bold">${esc(kb.t)}</span>
      ${speech.TTS ? `<button class="ml-auto ${C.iconBtn}" data-say="${esc(src)}" aria-label="朗读这一段">${ICON.play}</button>` : ''}</div>
    <p class="m-0">${esc(g.n)}</p>
    <p class="m-0 border-l-[3px] pl-2.5 font-en text-[14.5px] italic text-muted ${rc.border}">${esc(src)}</p>
    <div class="flex flex-col gap-1.5 rounded-[10px] bg-raise px-3 py-2.5"><span class="${C.label}">知识点</span>
      <dl class="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[14px]">
        <dt class="whitespace-nowrap font-semibold ${rc.text}">怎么认</dt><dd class="m-0 min-w-0">${esc(kb.how)}</dd>
        <dt class="whitespace-nowrap font-semibold ${rc.text}">怎么译</dt><dd class="m-0 min-w-0">${esc(kb.tr)}</dd>
        <dt class="whitespace-nowrap font-semibold ${rc.text}">例</dt><dd class="m-0 min-w-0 font-en">${esc(kb.ex)}</dd></dl></div></div>`;
}

function step2HTML() {
  const used = [...new Set(cur.segs.map((g) => g.r))];
  const ks = [...new Set(cur.segs.map((g) => g.k))];
  const pk = segPick >= 0 ? cur.segs[segPick].k : null;
  const chips = Object.entries(ROLES)
    .filter(([k]) => used.includes(k))
    .map(([k, v]) => `<button data-role="${k}" aria-pressed="${!!roleOn[k]}" class="inline-flex cursor-pointer items-center gap-1.5 rounded-full border-[1.5px] border-line bg-sheet py-1 pr-3 pl-2 text-[13.5px] transition-opacity aria-[pressed=false]:opacity-45"><i class="h-3 w-3 rounded-[3px] border-b-[2.5px] ${ROLE_CLS[k].swatch}"></i><span class="${roleOn[k] ? '' : 'line-through'}">${v.name}</span></button>`)
    .join('');
  return `<div class="flex flex-wrap gap-1.5">${chips}</div>
    <button role="switch" aria-checked="${mainOnly}" data-act="mainonly" class="group flex w-max cursor-pointer items-center gap-2.5 text-[14.5px] select-none">
      <span class="relative h-[23px] w-10 flex-none rounded-full bg-line transition-colors group-aria-checked:bg-accent"><span class="absolute top-[3px] left-[3px] h-[17px] w-[17px] rounded-full bg-sheet transition-transform group-aria-checked:translate-x-[17px]"></span></span>只看主干</button>
    <div class="flex flex-wrap items-center gap-1.5"><span class="${C.label}">本句知识点</span>${ks.map((k) => `<button data-k="${k}" class="cursor-pointer rounded-lg border-[1.5px] bg-sheet px-2.5 py-1 text-[13px] ${k === pk ? 'border-ink font-semibold' : 'border-line'}">${esc(KB[k].t)}</button>`).join('')}</div>
    <div id="kslot">${segPick >= 0 ? kcardHTML(cur.segs[segPick]) : `<div class="${C.note}">点句子里任意一段彩色部分，或上面的知识点，这里会讲它是什么成分、修饰谁、怎么认、怎么译。</div>`}</div>
    <div class="${C.card} flex flex-col gap-0.5 px-3.5 py-3"><span class="${C.label}">主干</span><span class="font-en text-[16px]">${esc(cur.trunk)}</span><span class="text-[14px] text-muted">${esc(cur.trunkZh)}</span></div>
    <div class="${C.row}"><button class="${C.btnPrimary}" data-go="3">下一步：翻译</button></div>`;
}

function fbHTML(a) {
  const total = a.total ?? 0;
  const tone = TONE[scoreTone(total)];
  const full = 2 * Math.PI * 42;
  const text = a.text || '';
  const fb = a.feedback || {};
  const issues = fb.issues || [];
  const ranges = [];
  issues.forEach((it, i) => {
    const at = text.indexOf(it.src || '\u0000');
    if (!it.src || at < 0 || ranges.some((r) => at < r.b && at + it.src.length > r.a)) return;
    ranges.push({ a: at, b: at + it.src.length, n: i + 1 });
  });
  ranges.sort((x, y) => x.a - y.a);
  let mine = '';
  let p = 0;
  ranges.forEach((r) => {
    mine += `${esc(text.slice(p, r.a))}<mark class="rounded-[2px] border-b-2 border-bad bg-bad-soft px-px text-inherit">${esc(text.slice(r.a, r.b))}<sup class="ml-px font-mono text-[10px] text-bad">${r.n}</sup></mark>`;
    p = r.b;
  });
  mine += esc(text.slice(p));
  const bar = (lbl, v, max) => {
    const pct = Math.round(((v ?? 0) / max) * 100);
    return `<div class="grid grid-cols-[3em_1fr_auto] items-center gap-2 text-[13.5px]"><span>${lbl}</span><span class="h-2 overflow-hidden rounded-full bg-line"><i data-bar class="block h-full rounded-full ${tone.bg}" style="width:${pct}%"></i></span><span class="whitespace-nowrap text-right font-mono text-[12px] tabular-nums text-muted">${v ?? '—'} / ${max}</span></div>`;
  };
  const df = fb.better ? diff(text, fb.better) : [];
  return `<div data-fb class="flex flex-col gap-3.5 rounded-2xl border border-line bg-sheet p-4">
    <div class="flex flex-wrap items-center gap-[18px]">
      <div class="relative h-[104px] w-[104px] flex-none">
        <svg viewBox="0 0 100 100" class="h-full w-full -rotate-90"><circle cx="50" cy="50" r="42" fill="none" stroke-width="9" class="stroke-line"/><circle data-arc data-full="${full.toFixed(2)}" cx="50" cy="50" r="42" fill="none" stroke-width="9" stroke-linecap="round" stroke-dasharray="${full.toFixed(2)}" stroke-dashoffset="${(full * (1 - total / 100)).toFixed(2)}" class="${tone.stroke}"/></svg>
        <div class="absolute inset-0 flex flex-col items-center justify-center leading-none"><b data-count="${total}" class="font-mono text-[30px] font-medium tabular-nums ${tone.text}">${total}</b><span class="mt-1 text-[11px] text-muted">总分 / 100</span></div>
      </div>
      <div class="flex min-w-0 flex-[1_1_200px] flex-col gap-2">${bar('准确', a.acc, 40)}${bar('通顺', a.flu, 30)}${bar('完整', a.comp, 30)}</div>
    </div>
    ${fb.level ? `<p class="m-0 text-[16px] font-semibold">${esc(fb.level)}</p>` : ''}
    <div class="flex flex-col gap-1.5"><span class="${C.label}">你的译文</span><p class="m-0 text-[15.5px] leading-[1.9]">${mine}</p></div>
    ${issues.length ? `<div class="flex flex-col gap-1.5"><span class="${C.label}">需要改的地方</span><ol class="m-0 flex list-none flex-col gap-2 p-0">${issues
      .map((it, i) => `<li data-issue class="grid grid-cols-[22px_1fr] gap-x-2 gap-y-1 rounded-[10px] bg-raise px-3 py-2.5 text-[14px]">
        <span class="row-span-2 mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-bad font-mono text-[11px] text-sheet">${i + 1}</span>
        <span class="flex min-w-0 flex-wrap items-baseline gap-1.5"><span class="rounded bg-bad-soft px-1.5 py-px font-mono text-[10.5px] tracking-[.06em] text-bad">${esc(it.type || '问题')}</span><span class="text-bad line-through">${esc(it.src)}</span><span>→</span><span class="font-semibold text-ok">${esc(it.fix)}</span></span>
        <span class="text-[13.5px] text-muted">${esc(it.why)}</span></li>`)
      .join('')}</ol></div>` : ''}
    ${(fb.good || []).length ? `<div class="flex flex-col gap-1.5"><span class="${C.label}">做得好的地方</span><ul class="m-0 flex list-disc flex-col gap-0.5 pl-[18px] text-[14px] marker:text-ok">${fb.good.map((g) => `<li>${esc(g)}</li>`).join('')}</ul></div>` : ''}
    ${fb.better ? `<div class="flex flex-col gap-1.5"><span class="${C.label}">在你的译文上修改</span><p data-diff class="m-0 text-[15.5px] leading-[1.9]">${df
      .map((d) => (d.t === '=' ? esc(d.s) : d.t === '+' ? `<span class="rounded-[2px] bg-ok-soft font-semibold text-ok">${esc(d.s)}</span>` : `<span class="rounded-[2px] bg-bad-soft text-bad line-through">${esc(d.s)}</span>`))
      .join('')}</p></div>` : ''}
  </div>`;
}

function quizHTML() {
  const answered = answer >= 0;
  const isLast = sentences.indexOf(cur) === sentences.length - 1;
  if (optOrder.length !== cur.opts.length) optOrder = shuffle(cur.opts.length);
  const t = taskInfo();
  const taskDone = t.complete && t.list.some((x) => x.id === cur.id);
  return `<div class="flex flex-col gap-2">${optOrder
    .map((oi, k) => {
      const o = cur.opts[oi];
      let c = 'border-line';
      let kc = 'text-muted';
      if (answered) {
        if (o.ok) [c, kc] = ['border-ok bg-ok-soft', 'text-ok'];
        else if (oi === answer) [c, kc] = ['border-bad bg-bad-soft', 'text-bad'];
      } else c += ' hover:border-accent cursor-pointer';
      return `<button data-opt="${oi}" ${answered ? 'tabindex="-1"' : ''} class="grid grid-cols-[auto_1fr] items-start gap-x-2.5 gap-y-1 rounded-xl border-[1.5px] bg-sheet px-3.5 py-3 text-left transition-colors ${answered ? 'cursor-default' : ''} ${c}">
        <span class="pt-px font-mono text-[13px] ${kc}">${'ABCD'[k]}</span><span class="min-w-0">${esc(o.t)}</span>
        ${answered ? `<span class="col-start-2 text-[13.5px] text-muted">${o.ok ? '✓ ' : ''}${esc(o.why)}</span>` : ''}</button>`;
    })
    .join('')}</div>
    ${answered ? `<div class="border-l-[3px] border-accent py-1 pl-3 text-[14.5px]"><b class="block font-mono text-[11px] font-medium tracking-[.1em] text-accent">翻译技巧</b>${esc(cur.tip)}</div>
      <div class="${C.row}">${taskDone ? `<button class="${C.btnPrimary}" data-act="showDone">今日任务完成，去看看 →</button>` : isLast ? '' : `<button class="${C.btnPrimary}" data-act="next">下一句 →</button>`}<button class="${C.btn}" data-act="retry">重选</button></div>` : ''}`;
}

function step3HTML() {
  const list = atts(cur.id);
  const best = list.length ? Math.max(...list.map((x) => x.total ?? 0)) : null;
  const draft = rec(cur.id)?.draft || '';
  const aiReady = usage ? usage.aiReady : true;
  const left = usage ? Math.max(0, usage.limits.grade - usage.grades) : null;
  let area = '';
  if (grading) {
    area = `<div class="flex flex-col gap-2 ${C.card} p-3.5"><div class="flex items-center justify-between gap-2"><span class="inline-flex items-center gap-2"><span class="${C.spin}"></span>AI 老师正在批改…</span></div>
      <div class="${C.shim}"></div><div class="${C.shim} w-[80%]"></div><div class="${C.shim} w-[55%]"></div></div>`;
  } else if (gradeErr) area = `<div class="rounded-xl bg-bad-soft px-3.5 py-2.5 text-[14px]">${esc(gradeErr)}</div>`;
  const last = lastAttempt(cur.id);
  const fb = last && !grading ? fbHTML(last) : '';
  const showQuiz = quizOpen || list.length > 0 || !!rec(cur.id)?.choice;
  let note = '';
  if (!aiReady) note = 'AI 模型还没配置。';
  else if (list.length) note = `已批改 ${list.length} 次 · 最高 ${best} 分${left != null ? ` · 今天还能批改 ${left} 次` : ''}`;
  else if (left != null) note = `今天还能批改 ${left} 次`;
  return `<label class="m-0" for="draft">先自己译一遍，AI 老师按准确、通顺、完整三项打分，并指出哪里要改、怎么改。</label>
    <textarea id="draft" maxlength="500" placeholder="在这里写你的中文译文……" class="min-h-24 w-full resize-y rounded-xl border-[1.5px] border-line bg-sheet px-3 py-2.5 text-[15.5px] outline-none transition-colors focus:border-accent">${esc(draft)}</textarea>
    <div class="${C.row}"><button class="${C.btnPrimary}" data-act="grade" ${aiReady && !grading ? '' : 'disabled'}>${list.length ? '重新批改' : 'AI 批改'}</button>${showQuiz ? '' : `<button class="${C.btn}" data-act="skip">跳过，直接选译文</button>`}
      <span class="text-[13px] text-muted">${esc(note)}</span>${aiReady ? '' : `<button class="cursor-pointer text-[13px] font-semibold text-accent underline underline-offset-4" data-act="gosettings">去设置模型</button>`}</div>
    ${area}${fb}
    ${showQuiz ? `<div class="flex items-center gap-2.5 text-[13px] text-muted before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">对照：选出最好的译文</div><div id="quiz" class="flex flex-col gap-3">${quizHTML()}</div>` : ''}`;
}

function renderPanel(enter) {
  const p = $('panel');
  if (!cur) {
    p.innerHTML = '';
    return;
  }
  p.innerHTML = step === 1 ? step1HTML() : step === 2 ? step2HTML() : step3HTML();
  if (enter) A.enter(p.children);
  if (step === 3 && freshFb) {
    freshFb = false;
    A.score(p.querySelector('[data-fb]'));
  }
}

function renderAll(enter) {
  renderBank();
  renderTask();
  renderDone(enter);
  renderTabs();
  renderSentence();
  renderPanel(enter);
  renderViews();
}

// ---------- 记录 ----------
const VIEWS = { practice: 'viewPractice', records: 'viewRecords', settings: 'viewSettings' };
let settingsOpened = false;
function renderViews() {
  A.moveIndicator($('viewInd'), Object.keys(VIEWS).indexOf(view));
  document.querySelectorAll('#views [data-view]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  for (const [name, id] of Object.entries(VIEWS)) {
    $(id).classList.toggle('hidden', view !== name);
    $(id).classList.toggle('flex', view === name);
  }
  if (view === 'records') renderRecords();
  if (view === 'settings' && !settingsOpened) {
    settingsOpened = true;
    taskSettings.open();
    settingsView.open();
  }
}

function showView(name) {
  if (name === 'practice' && view !== 'practice' && taskInfo().complete) showDone = true;
  view = name;
  ui.view = view;
  saveUI();
  if (speaking) stopSpeak();
  if (name === 'settings') settingsOpened = false; // 每次进入都重新读取
  renderViews();
  if (name === 'practice') renderDone(false);
  if (name !== 'settings') A.enter($(VIEWS[name]).children);
  window.scrollTo({ top: 0 });
}

function renderRecords() {
  const el = $('viewRecords');
  const byId = Object.fromEntries(sentences.map((s) => [s.id, s]));
  const ids = new Set([...Object.keys(records), ...Object.keys(attempts)].filter((id) => byId[id]));
  const items = [...ids]
    .map((id) => {
      const list = atts(id);
      const r = rec(id);
      const updated = [r?.updatedAt, list[0]?.createdAt].filter(Boolean).sort().at(-1) || '';
      return { id, s: byId[id], r, list, updated };
    })
    .sort((a, b) => b.updated.localeCompare(a.updated));
  if (!items.length) {
    el.innerHTML = `<div class="${C.note}">还没有练习记录。做完一句的“选译文”或提交一次 AI 批改后，就会出现在这里。</div>`;
    return;
  }
  const all = Object.values(attempts).flat().filter((a) => byId[a.sentenceId]).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const avg = all.length ? Math.round(all.reduce((s, a) => s + (a.total ?? 0), 0) / all.length) : null;
  const best = all.length ? Math.max(...all.map((a) => a.total ?? 0)) : null;
  let chart = '';
  if (all.length >= 2) {
    const pts = all.slice(-30);
    const W = 320;
    const H = 130;
    const x0 = 26;
    const x1 = 300;
    const yv = (v) => 12 + ((100 - v) / 100) * (H - 34);
    const xs = (i) => x0 + ((x1 - x0) * i) / (pts.length - 1);
    const line = pts.map((a, i) => `${xs(i).toFixed(1)},${yv(a.total ?? 0).toFixed(1)}`).join(' ');
    const lastPt = pts.at(-1);
    chart = `<div class="${C.card} flex flex-col gap-1.5 px-3.5 pt-3.5 pb-2.5"><span class="${C.label}">批改得分走势 · 最近 ${pts.length} 次</span>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="批改得分走势" class="block h-auto w-full">
      ${[60, 85, 100].map((v) => `<line class="stroke-line" stroke-dasharray="3 4" x1="${x0}" x2="${x1}" y1="${yv(v)}" y2="${yv(v)}"/><text class="fill-muted font-mono text-[10px]" x="0" y="${yv(v) + 3.5}">${v}</text>`).join('')}
      <path class="fill-accent-soft" d="M${xs(0).toFixed(1)},${yv(0).toFixed(1)} L${line.replace(/ /g, ' L')} L${xs(pts.length - 1).toFixed(1)},${yv(0).toFixed(1)} Z"/>
      <polyline class="fill-none stroke-accent" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" points="${line}"/>
      <circle class="fill-accent" cx="${xs(pts.length - 1).toFixed(1)}" cy="${yv(lastPt.total ?? 0).toFixed(1)}" r="4"/>
      <text class="fill-accent font-mono text-[11px]" x="${Math.min(xs(pts.length - 1) + 6, W - 22).toFixed(1)}" y="${(yv(lastPt.total ?? 0) - 8).toFixed(1)}">${lastPt.total}</text>
      <text class="fill-muted font-mono text-[10px]" x="${x0}" y="${H - 4}">较早</text><text class="fill-muted font-mono text-[10px]" x="${x1 - 22}" y="${H - 4}">最近</text></svg></div>`;
  }
  const stat = (n, label) => `<span><b class="mr-0.5 font-mono text-[20px] font-medium tabular-nums text-ink">${n}</b>${label}</span>`;
  el.innerHTML = `<div class="flex flex-wrap gap-x-[18px] gap-y-1.5 text-[14px] text-muted">${stat(items.length, '句练过')}${stat(items.filter((x) => x.r?.done).length, '句完成')}${stat(all.length, '次批改')}${avg != null ? stat(avg, '平均分') + stat(best, '最高分') : ''}</div>
    ${chart}
    <div class="flex flex-col gap-2">${items
      .map(({ id, s, r, list, updated }) => {
        const bs = list.length ? Math.max(...list.map((x) => x.total ?? 0)) : null;
        const tone = bs != null ? TONE[scoreTone(bs)] : null;
        return `<details class="overflow-hidden ${C.card}"><summary class="grid cursor-pointer list-none grid-cols-[auto_1fr] items-center gap-3 px-3.5 py-3 [&::-webkit-details-marker]:hidden">
          <span class="flex h-11 w-11 items-center justify-center rounded-xl font-mono text-[16px] tabular-nums ${tone ? `${tone.soft} ${tone.text}` : 'bg-raise text-muted'}">${bs ?? '—'}</span>
          <span class="flex min-w-0 flex-col gap-0.5"><span class="truncate font-en">${sentences.indexOf(s) + 1}. ${esc(plain(s))}</span>
          <span class="text-[12.5px] text-muted">${esc(s.focus)} · ${esc(fmtTime(updated))} · 批改 ${list.length} 次${r?.done ? ' · <span class="whitespace-nowrap text-ok">已完成</span>' : ''}</span></span></summary>
          <div class="flex flex-col gap-2.5 px-3.5 pb-3.5">
          ${list.length ? `<ul class="m-0 flex list-none flex-col gap-1.5 p-0">${list
            .map((x) => `<li class="grid grid-cols-[2.6em_1fr] gap-x-2.5 gap-y-0.5 rounded-lg bg-raise px-2.5 py-2 text-[14px]"><span class="row-span-2 font-mono ${TONE[scoreTone(x.total ?? 0)].text}">${x.total ?? '—'}</span><span>${esc(x.text)}</span><span class="text-[12px] text-muted">${esc(fmtTime(x.createdAt))} · 准确 ${x.acc ?? '—'} · 通顺 ${x.flu ?? '—'} · 完整 ${x.comp ?? '—'}${x.model ? ` · ${esc(x.model)}` : ''}</span></li>`)
            .join('')}</ul>` : r?.draft ? `<p class="m-0 text-muted">草稿：${esc(r.draft)}</p>` : ''}
          ${list[0]?.feedback?.level ? `<p class="m-0">最近一次点评：${esc(list[0].feedback.level)}</p>` : ''}
          <div class="${C.row}"><button class="${C.btnPrimary} px-3 py-1.5 text-[13.5px]" data-open="${esc(id)}">回到这句练习</button></div></div></details>`;
      })
      .join('')}</div>`;
}

// ---------- 导航 ----------
function open(id, { keepView = false } = {}) {
  const s = sentences.find((x) => x.id === id);
  if (!s) return;
  if (speaking) stopSpeak();
  cur = s;
  ui.cur = s.id;
  saveUI();
  showDone = false;
  step = 1;
  picked = new Set();
  checked = false;
  mainOnly = false;
  segPick = -1;
  wordSel = null;
  quizOpen = false;
  grading = false;
  gradeErr = '';
  freshFb = false;
  freshAnswer = false;
  disarmDelete();
  fix = null;
  $('panel').style.minHeight = '';
  roleOn = { main: 1, attr: 1, noun: 1, adv: 1, nonfin: 1 };
  optOrder = shuffle(s.opts.length);
  const c = rec(s.id)?.choice;
  answer = c && c.pick >= 0 && c.pick < s.opts.length ? c.pick : -1;
  if (!keepView) view = 'practice';
  renderAll(true);
}

/**
 * 重新渲染时让步骤标签停在屏幕上原来的位置：上方句子卡片高度变了就跟着滚动补回；
 * 下方内容变短、页面滚不回原位时，给面板补一点最小高度（换句子时清掉）。
 */
function pinTabs(fn) {
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

function setStep(n) {
  if (step === n || !cur) return;
  if (speaking) stopSpeak();
  step = n;
  wordSel = null;
  fix = null;
  if (n === 2) sweepPending = true;
  pinTabs(() => {
    renderTabs();
    renderSentence();
    renderPanel(true);
  });
}

function move(d) {
  if (!cur || !sentences.length) return;
  const i = sentences.indexOf(cur);
  open(sentences[(i + d + sentences.length) % sentences.length].id);
}

function pickInitial() {
  if (!sentences.length) {
    cur = null;
    renderAll(false);
    return;
  }
  const t = taskInfo();
  const todo = t.list.find((s) => !rec(s.id)?.done);
  if (todo && !(ui.cur && t.list.some((s) => s.id === ui.cur) && !rec(ui.cur)?.done)) open(todo.id, { keepView: true });
  else if (ui.cur && sentences.some((s) => s.id === ui.cur)) open(ui.cur, { keepView: true });
  else open((sentences.find((s) => !rec(s.id)?.done) || sentences.at(-1)).id, { keepView: true });
  if (t.complete) {
    showDone = true;
    renderDone(false);
  }
}

// ---------- 修正谓语标注 ----------
async function saveFix(useAi) {
  if (!cur || !fix || fix.busy) return;
  const id = cur.id;
  fix.busy = useAi ? 'ai' : 'save';
  fix.msg = '';
  renderPanel(false);
  try {
    const r = useAi ? await api.reviewSentence(id) : await api.fixPredicates(id, fixSpans().map(({ kind, a, b }) => ({ kind, a, b })));
    const i = sentences.findIndex((x) => x.id === id);
    if (i >= 0) sentences[i] = r.sentence;
    if (cur?.id !== id) return;
    cur = r.sentence;
    fix = null;
    picked = new Set();
    checked = false;
    renderSentence();
    renderPanel(true);
    if (useAi) toast(r.changed ? `AI 改正了答案${r.note ? `：${r.note}` : ''}，再做一次吧` : `AI 认为原答案没问题${r.note ? `：${r.note}` : ''}`);
    else toast('答案已修改，再做一次吧');
  } catch (e) {
    if (fix && cur?.id === id) {
      fix.busy = '';
      fix.msg = e.message;
      renderPanel(false);
    } else toast(e.message);
  }
}

// ---------- 固定句子 ----------
// 点图钉后句子卡片吸在屏幕顶部，往下看步骤和讲解时句子一直在；太高时卡片里面自己滚动。设置记在本机，换句子、刷新后还在
const PIN_CLS = ['sticky', 'top-[max(8px,env(safe-area-inset-top))]', 'z-20', 'max-h-[60vh]', 'overflow-y-auto', 'overscroll-contain'];
function updStuck() {
  const el = $('sheet');
  const top = parseFloat(getComputedStyle(el).top);
  el.toggleAttribute('data-stuck', !!ui.pin && window.scrollY > 0 && el.getBoundingClientRect().top <= top + 0.5);
}
/** scroll：刚点图钉时把句子卡片滚到屏幕顶部，马上看到效果 */
function applyPin(scroll = false) {
  const on = !!ui.pin;
  const b = $('pin');
  const el = $('sheet');
  b.setAttribute('aria-pressed', String(on));
  b.setAttribute('aria-label', on ? '取消固定句子' : '把句子固定在屏幕顶部');
  b.title = on ? '取消固定' : '固定句子';
  PIN_CLS.forEach((c) => el.classList.toggle(c, on));
  // 下面的内容很短时页面滚不动，卡片就到不了顶部；固定期间给练习区补足一屏高度
  $('work').classList.toggle('min-h-[calc(100dvh-8px)]', on);
  if (on && scroll) {
    const top = parseFloat(getComputedStyle(el).top) || 8;
    const d = el.getBoundingClientRect().top - top;
    if (d > 1) window.scrollTo({ top: window.scrollY + d, behavior: A.motion ? 'smooth' : 'auto' });
  }
  updStuck();
}
let stuckRaf = 0;
window.addEventListener(
  'scroll',
  () => {
    if (!ui.pin || stuckRaf) return;
    stuckRaf = requestAnimationFrame(() => {
      stuckRaf = 0;
      updStuck();
    });
  },
  { passive: true },
);

// ---------- 删除 ----------
function disarmDelete() {
  clearTimeout(deleteArmed);
  deleteArmed = null;
  const b = $('more');
  b.textContent = '删除';
  b.classList.remove('border-bad', 'text-bad');
}
async function onDelete() {
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
  const i = sentences.indexOf(cur);
  try {
    await api.deleteSentence(id);
    sentences = sentences.filter((x) => x.id !== id);
    delete records[id];
    delete attempts[id];
    toast('已删除这一句');
    if (sentences.length) open(sentences[Math.min(i, sentences.length - 1)].id);
    else {
      cur = null;
      renderAll(false);
    }
  } catch (e) {
    toast(e.message);
  }
}

// ---------- AI ----------
async function grade() {
  const ta = $('draft');
  const text = (ta ? ta.value : '').trim();
  if (!text) {
    gradeErr = '先写下你的译文再批改。';
    renderPanel(false);
    return;
  }
  if (grading) return;
  const s = cur;
  clearTimeout(draftTimer);
  saveRecord(s.id, { draft: text });
  grading = true;
  gradeErr = '';
  renderPanel(false);
  try {
    const r = await api.grade(s.id, text);
    attempts[s.id] = [r.attempt, ...atts(s.id)];
    if (usage) usage.grades += 1;
    if (cur === s) {
      freshFb = true;
      quizOpen = true;
    }
  } catch (e) {
    if (cur === s) gradeErr = e.message;
  } finally {
    grading = false;
    if (cur === s) renderPanel(false);
    renderBank();
  }
}

// ---------- 今日任务 ----------
// 今天（北京时间）的日期，和后端给句子打的 batch 一致，不受手机时区影响
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const TASK_SOURCES = new Set(['daily', 'extra', 'manual']);

/** 今日任务：今天生成的句子（每日任务 + 加练）。还差几句没生成、完成了几句 */
function taskInfo() {
  const d = today();
  const list = sentences.filter((s) => s.batch === d && TASK_SOURCES.has(s.source));
  const daily = list.filter((s) => s.source === 'daily').length;
  const done = list.filter((s) => rec(s.id)?.done).length;
  const missing = Math.max(0, practiceCfg.dailyCount - daily);
  return { list, daily, done, missing, complete: list.length > 0 && done === list.length && missing === 0 };
}

const aiOk = () => (usage ? usage.aiReady : true);
const LV_SHORT = { 'CET-4': '四级', 'CET-6': '六级' };

function busyHTML() {
  return `<div class="flex items-center gap-2.5 rounded-xl bg-raise px-3 py-2.5 text-[14px]"><span class="${C.spin}"></span>
    <span class="flex-1">AI 正在出 ${taskBusyN} 道${esc(levelText(practiceCfg.levels))}的题，${taskBusyN > 5 ? '一两分钟' : '大约 1 分钟'}，可以先练句库里的旧句子。</span></div>`;
}

function errHTML() {
  return taskErr ? `<div class="flex items-center gap-2.5 rounded-xl bg-bad-soft px-3 py-2.5 text-[14px]"><span class="flex-1">${esc(taskErr)}</span><button class="${C.btnSmall}" data-act="closeTaskErr">知道了</button></div>` : '';
}

/** 加练：选句数 + 开始按钮（任务卡片和完成页共用） */
function extraHTML(primary) {
  const max = practiceCfg.maxDaily || 10;
  const stepBtn = 'flex h-9 w-9 cursor-pointer items-center justify-center text-[18px] leading-none transition-colors hover:text-accent disabled:cursor-not-allowed disabled:opacity-35';
  return `<div class="flex flex-wrap items-center gap-2.5">
    <div class="inline-flex items-center rounded-full border-[1.5px] border-line bg-sheet">
      <button data-act="extraMinus" aria-label="少一句" class="${stepBtn}" ${extraCount <= 1 ? 'disabled' : ''}>−</button>
      <span data-extra-count class="min-w-[2.2em] text-center font-mono text-[16px] tabular-nums" aria-live="polite">${extraCount}</span>
      <button data-act="extraPlus" aria-label="多一句" class="${stepBtn}" ${extraCount >= max ? 'disabled' : ''}>+</button>
    </div>
    <span class="text-[14px] text-muted">句</span>
    <button class="${primary ? C.btnPrimary : C.btn}" data-act="extraGo" ${aiOk() && !taskBusy ? '' : 'disabled'}>开始加练</button>
  </div>`;
}

function renderTask() {
  const el = $('task');
  if (!loaded) {
    el.innerHTML = `<span class="${C.label}">今日任务</span><div class="${C.shim} w-[60%]"></div>`;
    return;
  }
  const t = taskInfo();
  const head = `<div class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
    <span class="${C.label}">今日任务</span>
    <span class="text-[13px] text-muted">${esc(levelText(practiceCfg.levels))} · 每天 ${practiceCfg.dailyCount} 句</span>
    <button class="ml-auto cursor-pointer text-[13px] text-accent underline underline-offset-4" data-act="taskSettings">调整</button></div>`;
  let body = '';
  if (!t.list.length) {
    body = taskBusy
      ? busyHTML()
      : aiOk()
        ? `<p class="m-0 text-[14.5px]">今天的 ${practiceCfg.dailyCount} 句还没生成。${practiceCfg.autoDaily ? `每天 ${esc(practiceCfg.dailyAt)} 会自动生成，` : ''}也可以现在生成。</p>
          <div class="${C.row}"><button class="${C.btnPrimary}" data-act="genDaily">现在生成今天的 ${practiceCfg.dailyCount} 句</button></div>`
        : `<p class="m-0 text-[14.5px]">还没配置 AI 模型，没法生成今天的句子。</p><div class="${C.row}"><button class="${C.btnPrimary}" data-act="taskSettings">去设置模型</button></div>`;
  } else {
    const pct = Math.round((t.done / (t.list.length + t.missing)) * 100);
    const bar = t.list
      .map((s, i) => {
        const done = rec(s.id)?.done;
        const isCur = cur && cur.id === s.id && !showDone;
        return `<button data-sid="${esc(s.id)}" aria-label="今日第 ${i + 1} 句${done ? '，已完成' : ''}" class="group flex min-w-0 flex-1 cursor-pointer py-1.5">
          <span class="h-2 w-full rounded-full transition-colors ${done ? 'bg-ok' : isCur ? 'bg-accent' : 'bg-line group-hover:bg-mid'}"></span></button>`;
      })
      .join('') + Array.from({ length: t.missing }, () => '<span class="flex min-w-0 flex-1 py-1.5"><span class="h-2 w-full rounded-full border border-dashed border-line"></span></span>').join('');
    body = `<div class="flex items-baseline gap-2">
        <b class="font-mono text-[26px] leading-none font-medium tabular-nums ${t.complete ? 'text-ok' : ''}">${t.done}</b>
        <span class="text-[14px] text-muted">/ ${t.list.length + t.missing} 句完成</span>
        ${t.complete ? '<span class="ml-auto rounded-full bg-ok-soft px-2.5 py-0.5 text-[13px] font-semibold whitespace-nowrap text-ok">✓ 已完成</span>' : `<span class="ml-auto font-mono text-[12px] text-muted">${pct}%</span>`}
      </div>
      <div class="flex gap-1" role="group" aria-label="今日任务进度">${bar}</div>
      ${taskBusy ? busyHTML() : `<div class="${C.row}">
        ${t.missing ? `<button class="${C.btnPrimary} px-3 py-1.5 text-[13.5px]" data-act="genDaily" ${aiOk() ? '' : 'disabled'}>补齐 ${t.missing} 句</button>` : ''}
        ${t.complete && !showDone ? `<button class="${C.btnSmall}" data-act="showDone">查看完成页</button>` : ''}
        <button class="${C.btnSmall}" data-act="extraToggle" aria-expanded="${extraOpen}">＋ 加练</button>
      </div>
      ${extraOpen ? `<div data-extra class="flex flex-col gap-1.5 rounded-xl bg-raise px-3 py-2.5">${extraHTML(false)}<span class="text-[12.5px] text-muted">加练的句子算进今天的任务，难度按设置：${esc(levelText(practiceCfg.levels))}。</span></div>` : ''}`}`;
  }
  el.innerHTML = head + body + errHTML();
}

/** 完成页：今日任务全部完成后，练习页显示它，代替句子和三个步骤 */
function renderDone(enter) {
  const el = $('doneView');
  const t = taskInfo();
  const on = showDone && t.complete;
  if (!on) showDone = false;
  el.classList.toggle('hidden', !on);
  el.classList.toggle('flex', on);
  $('work').classList.toggle('hidden', on);
  $('work').classList.toggle('flex', !on);
  if (!on) {
    el.innerHTML = '';
    return;
  }
  const count = (lv) => t.list.filter((s) => s.level === lv).length;
  const bests = t.list.map((s) => (atts(s.id).length ? Math.max(...atts(s.id).map((a) => a.total ?? 0)) : null));
  const scored = bests.filter((b) => b != null);
  const graded = t.list.reduce((n, s) => n + atts(s.id).length, 0);
  const avg = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null;
  const stat = (n, label) => `<span class="flex flex-col items-center gap-0.5"><b class="font-mono text-[22px] leading-none font-medium tabular-nums">${n}</b><span class="text-[12.5px] text-muted">${label}</span></span>`;
  const lv = [['CET-4', '四级'], ['CET-6', '六级']].filter(([k]) => count(k)).map(([k, n]) => `${n} ${count(k)} 句`).join(' · ');
  el.innerHTML = `<section class="flex flex-col items-center gap-2.5 rounded-2xl border border-line bg-sheet px-5 pt-7 pb-6 text-center">
      <span data-donecheck class="flex h-16 w-16 items-center justify-center rounded-full bg-ok text-on-accent"><svg class="h-8 w-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>
      <h2 class="m-0 text-[22px] font-semibold">今日任务完成</h2>
      <p class="m-0 text-[14.5px] text-muted">${t.list.length} 句全部完成${lv ? ` · ${lv}` : ''}</p>
      <div class="mt-2 flex flex-wrap justify-center gap-x-8 gap-y-3">${stat(t.list.length, '完成句数')}${stat(graded, 'AI 批改')}${avg != null ? stat(avg, '平均最高分') : ''}</div>
    </section>
    <section class="flex flex-col gap-3 rounded-2xl border border-line bg-sheet px-4 py-4">
      <div class="flex flex-col gap-0.5"><b class="text-[16px]">还想再练？</b><span class="text-[13px] text-muted">加练的句子会加进今天的任务，难度按设置：${esc(levelText(practiceCfg.levels))}。</span></div>
      ${taskBusy ? busyHTML() : extraHTML(true)}
      ${errHTML()}
    </section>
    <section class="flex flex-col gap-2">
      <span class="${C.label}">今天的句子 · 点开复习</span>
      ${t.list
        .map((s, i) => {
          const b = bests[i];
          const tone = b != null ? TONE[scoreTone(b)] : null;
          return `<button data-sid="${esc(s.id)}" class="grid cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-3 rounded-xl border border-line bg-sheet px-3.5 py-2.5 text-left transition-colors hover:border-accent">
            <span class="rounded-full border border-line px-2 py-px font-mono text-[11.5px] text-muted">${esc(LV_SHORT[s.level] || s.level || '—')}</span>
            <span class="flex min-w-0 flex-col"><span class="truncate font-en text-[15px]">${esc(plain(s))}</span><span class="truncate text-[12.5px] text-muted">${esc(s.focus || '')}</span></span>
            <span class="font-mono text-[15px] tabular-nums ${tone ? tone.text : 'text-ok'}">${b ?? '✓'}</span></button>`;
        })
        .join('')}
    </section>
    <p class="m-0 text-center text-[13px] text-muted">${practiceCfg.autoDaily ? `明天 ${esc(practiceCfg.dailyAt)} 会自动准备新的 ${practiceCfg.dailyCount} 句。` : ''}<button class="cursor-pointer text-accent underline underline-offset-4" data-act="taskSettings">调整每日任务</button></p>`;
  if (enter || celebrate) A.enter(el.children);
  if (celebrate) {
    celebrate = false;
    const c = el.querySelector('[data-donecheck]');
    A.pop(c);
    const r = c.getBoundingClientRect();
    setTimeout(() => A.burst(r.left + r.width / 2, r.top + r.height / 2), 120);
  }
}

function showDonePage() {
  if (!taskInfo().complete) return;
  if (speaking) stopSpeak();
  A.toastOut($('toast'));
  showDone = true;
  view = 'practice';
  renderViews();
  renderTask();
  renderDone(true);
  window.scrollTo({ top: 0, behavior: A.motion ? 'smooth' : 'auto' });
}

/** 生成今日任务（kind=daily，没生成或要补齐时）或加练（kind=extra） */
async function generateTask(kind) {
  if (taskBusy) return;
  taskBusyN = kind === 'daily' ? taskInfo().missing || practiceCfg.dailyCount : extraCount;
  taskBusy = kind;
  taskErr = '';
  renderTask();
  renderDone(false);
  try {
    const r = await api.generate(kind === 'daily' ? { kind } : { kind, count: extraCount });
    await checkNewSentences(true);
    usage = await api.usage().catch(() => usage);
    taskBusy = '';
    extraOpen = false;
    const short = taskBusyN - r.added.length;
    toast(`新增 ${r.added.length} 句${short > 0 ? `，有 ${short} 句没通过检查${kind === 'daily' ? '，可以点“补齐”' : ''}` : ''}`);
    const first = r.added.find((id) => sentences.some((x) => x.id === id));
    if (first) {
      open(first);
      window.scrollTo({ top: 0, behavior: A.motion ? 'smooth' : 'auto' });
    } else {
      renderTask();
      renderDone(false);
    }
  } catch (e) {
    taskBusy = '';
    taskErr = e.message;
    if (e.status === 409) await checkNewSentences(true); // 别处已经生成了
    renderTask();
    renderDone(false);
  }
}

function onTaskClick(e) {
  const b = e.target.closest('[data-sid]');
  if (b) {
    open(b.dataset.sid);
    $('sheet').scrollIntoView({ behavior: A.motion ? 'smooth' : 'auto', block: 'start' });
    return;
  }
  const a = e.target.closest('[data-act]');
  if (!a) return;
  const max = practiceCfg.maxDaily || 10;
  switch (a.dataset.act) {
    case 'genDaily':
      generateTask('daily');
      return;
    case 'extraGo':
      generateTask('extra');
      return;
    case 'extraToggle':
      extraOpen = !extraOpen;
      renderTask();
      if (extraOpen) A.slideIn($('task').querySelector('[data-extra]'));
      return;
    case 'extraMinus':
    case 'extraPlus':
      extraCount = Math.min(max, Math.max(1, extraCount + (a.dataset.act === 'extraPlus' ? 1 : -1)));
      document.querySelectorAll('[data-extra-count]').forEach((x) => {
        x.textContent = extraCount;
        A.pop(x);
      });
      document.querySelectorAll('[data-act="extraMinus"]').forEach((x) => (x.disabled = extraCount <= 1));
      document.querySelectorAll('[data-act="extraPlus"]').forEach((x) => (x.disabled = extraCount >= max));
      return;
    case 'showDone':
      showDonePage();
      return;
    case 'taskSettings':
      showView('settings');
      return;
    case 'closeTaskErr':
      taskErr = '';
      renderTask();
      renderDone(false);
      return;
    default:
  }
}

// ---------- 提示条 ----------
let toastTimer = null;
function toast(msg, action) {
  const t = $('toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="flex-none cursor-pointer rounded-full bg-accent px-3 py-1 text-[13.5px] font-semibold whitespace-nowrap text-on-accent">${esc(action.label)}</button>` : ''}`;
  t.style.paddingRight = action ? '8px' : '18px';
  if (action) t.querySelector('button').onclick = () => {
    action.fn();
    A.toastOut(t);
  };
  A.toastIn(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => A.toastOut(t), action ? 7000 : 2600);
}

// ---------- 访问密码 ----------
function showLock(show) {
  $('lock').classList.toggle('hidden', !show);
  $('lock').classList.toggle('flex', show);
  $('app').classList.toggle('hidden', show);
  if (show) setTimeout(() => $('lockInput').focus(), 50);
}
setUnauthorizedHandler(() => showLock(true));

$('lockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('lockBtn');
  const err = $('lockErr');
  btn.disabled = true;
  err.classList.add('hidden');
  try {
    await api.unlock($('lockInput').value);
    $('lockInput').value = '';
    showLock(false);
    if (!loaded) await start();
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
    A.shake($('lockForm'));
  } finally {
    btn.disabled = false;
  }
});

// ---------- 事件 ----------
$('views').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b && b.dataset.view !== view) showView(b.dataset.view);
});
$('bank').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sid]');
  if (b) open(b.dataset.sid);
});
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-s]');
  if (b) setStep(+b.dataset.s);
});
$('prev').onclick = () => move(-1);
$('next').onclick = () => move(1);
$('more').onclick = onDelete;
$('pin').onclick = () => {
  ui.pin = !ui.pin;
  saveUI();
  applyPin(true);
  toast(ui.pin ? '句子已固定在屏幕顶部，再点图钉取消' : '已取消固定');
};
applyPin();
$('task').addEventListener('click', onTaskClick);
$('doneView').addEventListener('click', onTaskClick);
$('dict').onclick = () => {
  dictMode = !dictMode;
  wordSel = null;
  if (speaking) stopSpeak();
  renderSentence();
};
$('speak').onclick = readSentence;
$('voiceBtn').onclick = () => {
  const p = $('voicePanel');
  const open_ = p.classList.contains('hidden');
  p.classList.toggle('hidden', !open_);
  p.classList.toggle('flex', open_);
  $('voiceBtn').setAttribute('aria-expanded', String(open_));
  if (open_) {
    fillVoices();
    A.slideIn(p);
  }
};
$('voiceSel').onchange = (e) => {
  ui.voice = e.target.value;
  saveUI();
  if (cur) sayText(cur.segs[0].t.replace(/[*^]/g, ''));
};
$('rates').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rate]');
  if (!b) return;
  ui.rate = +b.dataset.rate;
  saveUI();
  updRates();
});

$('sentence').addEventListener('click', (e) => {
  const w = e.target.closest('[data-w]');
  if (w) {
    const i = +w.dataset.w;
    wordSel = wordSel === i ? null : i;
    renderSentence();
    if (wordSel != null && speech.TTS && !speaking) sayText(flat(cur)[i].core);
    return;
  }
  const fx = e.target.closest('[data-fx]');
  if (fx && fix && !fix.busy) {
    const i = +fx.dataset.fx;
    const k = fix.tag[i];
    if (k === 'main') fix.tag[i] = null;
    else if (k === 'sub') {
      // 主句谓语只有一处：把别处的主句谓语改成从句谓语
      fix.tag = fix.tag.map((x) => (x === 'main' ? 'sub' : x));
      fix.tag[i] = 'main';
      const spans = fixSpans();
      const sp = spans.find((x) => x.a <= i && i <= x.b);
      // 同一个短语里的其他词跟着变成主句谓语
      for (let j = sp ? sp.a : i; j <= (sp ? sp.b : i); j++) fix.tag[j] = 'main';
    } else fix.tag[i] = 'sub';
    fix.msg = '';
    renderSentence();
    renderPanel(false);
    return;
  }
  const t = e.target.closest('[data-t]');
  if (t && step === 1 && !checked) {
    const i = +t.dataset.t;
    picked.has(i) ? picked.delete(i) : picked.add(i);
    renderSentence();
    renderPanel(false);
    return;
  }
  const g = e.target.closest('[data-seg]');
  if (g && step === 2) {
    segPick = +g.dataset.seg === segPick ? -1 : +g.dataset.seg;
    renderSentence();
    renderPanel(false);
    if (segPick >= 0) A.slideIn($('panel').querySelector('[data-kcard]'));
  }
});
$('sentence').addEventListener('keydown', (e) => {
  const d = e.target.dataset || {};
  if ((e.key === 'Enter' || e.key === ' ') && (d.seg !== undefined || d.t !== undefined || d.w !== undefined || d.fx !== undefined)) {
    e.preventDefault();
    e.target.click();
  }
});
document.addEventListener('click', (e) => {
  const s = e.target.closest('[data-say]');
  if (s) sayText(s.dataset.say);
});
$('wordCard').addEventListener('click', (e) => {
  if (e.target.closest('[data-act="closeWord"]')) {
    wordSel = null;
    renderSentence();
  }
});
$('viewRecords').addEventListener('click', (e) => {
  const b = e.target.closest('[data-open]');
  if (!b) return;
  ui.view = 'practice';
  saveUI();
  open(b.dataset.open);
  window.scrollTo({ top: 0, behavior: A.motion ? 'smooth' : 'auto' });
});

$('panel').addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) return setStep(+go.dataset.go);
  const chip = e.target.closest('[data-role]');
  if (chip) {
    const r = chip.dataset.role;
    roleOn[r] = roleOn[r] ? 0 : 1;
    renderSentence();
    renderPanel(false);
    return;
  }
  const kp = e.target.closest('[data-k]');
  if (kp) {
    const i = cur.segs.findIndex((g) => g.k === kp.dataset.k);
    segPick = segPick === i ? -1 : i;
    renderSentence();
    renderPanel(false);
    if (segPick >= 0) A.slideIn($('panel').querySelector('[data-kcard]'));
    return;
  }
  const opt = e.target.closest('[data-opt]');
  if (opt && answer < 0) {
    answer = +opt.dataset.opt;
    const ok = !!cur.opts[answer].ok;
    const wasDone = !!rec(cur.id)?.done;
    saveRecord(cur.id, { choice: { pick: answer, ok }, ...(ok ? { done: true } : {}) });
    const q = $('quiz');
    if (q) {
      q.innerHTML = quizHTML();
      A.enter(q.children);
      const okEl = [...q.querySelectorAll('[data-opt]')].find((b) => cur.opts[+b.dataset.opt].ok);
      const badEl = ok ? null : q.querySelector(`[data-opt="${answer}"]`);
      A.pulse(okEl);
      A.shake(badEl);
    }
    if (ok && !wasDone) {
      const rct = opt.getBoundingClientRect();
      A.burst(rct.left + rct.width / 2, rct.top + rct.height / 2);
      A.pop($('bank').querySelector(`[data-sid="${CSS.escape(cur.id)}"]`));
      const t = taskInfo();
      if (t.complete && t.list.some((x) => x.id === cur.id)) {
        celebrate = true;
        toast('今日任务全部完成！', { label: '查看', fn: () => showDonePage() });
      } else toast(`第 ${sentences.indexOf(cur) + 1} 句完成`);
    }
    return;
  }
  const a = e.target.closest('[data-act]');
  if (!a) return;
  switch (a.dataset.act) {
    case 'check': {
      checked = true;
      const t = [];
      cur.segs.forEach((g) => toks(g.t).forEach((x) => t.push(x)));
      let ok = 0;
      let total = 0;
      let wrong = 0;
      t.forEach((x, i) => {
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
      return;
    }
    case 'clear':
      picked.clear();
      break;
    case 'fix':
      wordSel = null;
      fix = { tag: flat(cur).map((x) => x.k), busy: '', msg: '' };
      pinTabs(() => {
        renderSentence();
        renderPanel(true);
      });
      return;
    case 'fixCancel':
      fix = null;
      break;
    case 'fixSave':
    case 'fixAi':
      saveFix(a.dataset.act === 'fixAi');
      return;
    case 'reset':
      picked.clear();
      checked = false;
      break;
    case 'mainonly':
      mainOnly = !mainOnly;
      break;
    case 'skip':
      quizOpen = true;
      renderPanel(false);
      A.enter($('quiz')?.children);
      return;
    case 'grade':
      grade();
      return;
    case 'retry': {
      answer = -1;
      optOrder = shuffle(cur.opts.length);
      const q = $('quiz');
      if (q) {
        q.innerHTML = quizHTML();
        A.enter(q.children);
      }
      return;
    }
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
});
$('panel').addEventListener('input', (e) => {
  if (e.target.id === 'draft' && cur) saveDraft(cur.id, e.target.value);
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkNewSentences();
});
setInterval(checkNewSentences, 10 * 60 * 1000);

// ---------- 设置页 ----------
const taskSettings = createTaskSettings({
  root: $('taskSettings'),
  toast,
  onChange: (p) => {
    practiceCfg = p;
    renderTask();
  },
});
const settingsView = createSettingsView({
  root: $('llmSettings'),
  toast,
  onSaved: async () => {
    usage = await api.usage().catch(() => usage);
    if (cur && step === 3) renderPanel(false);
    renderTask();
  },
});

// ---------- 启动 ----------
async function start() {
  renderAll(false);
  try {
    await loadAll();
  } catch (e) {
    if (e.status !== 401) {
      $('sentence').innerHTML = `<span class="font-zh text-[15px] text-bad">加载失败：${esc(e.message)}</span>`;
    }
  }
}

if (speech.TTS) {
  $('speak').classList.remove('hidden');
  $('speak').classList.add('inline-flex');
  $('voiceBtn').classList.remove('hidden');
  $('voiceBtn').classList.add('inline-flex');
  fillVoices();
  speech.onVoicesChanged(fillVoices);
}
updRates();
renderAll(false);

api
  .session()
  .then((s) => {
    if (s.unlocked) start();
    else showLock(true);
  })
  .catch((e) => {
    $('sentence').innerHTML = `<span class="font-zh text-[15px] text-bad">${esc(e.message)}</span>`;
  });
