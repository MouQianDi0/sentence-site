// 长难句拆解台 · 页面逻辑
import { api, setUnauthorizedHandler } from './api.js';
import { ROLES, ROLE_CLS, KB, DEFK } from './kb.js';
import { esc, toks, plain, flat, phraseMap, diff, localDate, fmtDay, fmtTime, scoreTone, shuffle } from './text.js';
import * as speech from './speech.js';
import * as A from './anim.js';
import { createSettingsView } from './settings.js';

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
let generating = false;
let deleteArmed = null;
let speaking = false;
let lookupBusy = null;
let lookupErr = null;

const saveUI = () => ls.set(LS_UI, ui);
const rec = (id) => records[id] || null;
const atts = (id) => attempts[id] || [];
const lastAttempt = (id) => atts(id)[0] || null;

// ---------- 数据 ----------
async function loadAll() {
  const [s, r, a, u] = await Promise.all([api.sentences(), api.records(), api.attempts(), api.usage().catch(() => null)]);
  sentences = s.sentences;
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

async function checkNewSentences() {
  if (!loaded || document.hidden) return;
  const last = sentences.at(-1)?.created;
  try {
    const r = await api.sentences(last);
    const known = new Set(sentences.map((x) => x.id));
    const added = r.sentences.filter((x) => !known.has(x.id));
    if (!added.length) return;
    sentences = sentences.concat(added);
    renderBank();
    if (cur) $('label').textContent = `句子 ${sentences.indexOf(cur) + 1} / ${sentences.length}`;
    toast(`句库更新：新增 ${added.length} 句`, { label: '去练习', fn: () => open(added[0].id) });
    return added;
  } catch {}
}

function saveRecord(id, patch) {
  records[id] = { ...(records[id] || { sentenceId: id, done: false }), ...patch, updatedAt: new Date().toISOString() };
  api.saveRecord(id, patch).catch((e) => toast(`保存失败：${e.message}`));
  renderBank();
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
    el.innerHTML = `<p class="m-0 text-[14px] text-muted">${loaded ? '句库还是空的，点“生成 5 句新句子”开始。' : '正在加载句库…'}</p>`;
    return;
  }
  const today = localDate(new Date());
  const groups = [];
  let g = null;
  sentences.forEach((s, i) => {
    if (!g || g.b !== s.batch) groups.push((g = { b: s.batch, items: [] }));
    g.items.push({ s, i });
  });
  const newCut = Date.now() - 3 * 864e5;
  el.innerHTML = groups
    .map((gr) => `<div class="flex flex-none flex-col gap-1.5">
      <span class="whitespace-nowrap font-mono text-[11px] tracking-[.04em] text-muted">${gr.b === today ? '<b class="font-medium text-accent">今天</b> ' : ''}${esc(fmtDay(gr.b))}</span>
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
const W_BASE = 'inline cursor-pointer rounded-[5px] px-0.5 -mx-px [line-height:inherit] transition-colors hover:bg-accent-soft data-[reading]:bg-read';
const T_BASE = 'inline rounded-full px-[3px] -mx-px [line-height:inherit] transition-colors data-[reading]:bg-read';

function renderSentence() {
  const el = $('sentence');
  const hint = $('hint');
  if (!cur) {
    $('label').textContent = '';
    $('focus').textContent = '';
    $('lvl').classList.add('hidden');
    $('tools').classList.add('invisible');
    el.innerHTML = loaded
      ? '<span class="flex flex-col gap-2 py-1.5"><span class="font-head text-[20px] font-bold">句库还是空的</span><span class="font-zh text-[15px] text-muted">每天早上 7:50 会自动加入 5 句新句子，也可以点上方“生成 5 句新句子”马上开始。</span></span>'
      : `<span class="flex flex-col gap-3 py-2"><span class="${C.shim} h-4"></span><span class="${C.shim} h-4 w-[86%]"></span><span class="${C.shim} h-4 w-[60%]"></span></span>`;
    hint.classList.add('hidden');
    $('wordCard').innerHTML = '';
    return;
  }
  $('tools').classList.remove('invisible');
  $('label').textContent = `句子 ${sentences.indexOf(cur) + 1} / ${sentences.length}`;
  $('lvl').classList.toggle('hidden', !cur.level);
  $('lvl').textContent = cur.level;
  $('focus').textContent = cur.focus;
  const dict = dictMode || step === 3;
  $('dict').classList.toggle('hidden', step === 3);
  $('dict').setAttribute('aria-pressed', String(dictMode));
  const fw = flat(cur);

  if (dict) {
    const pm = phraseMap(cur, fw);
    el.innerHTML = fw
      .map((x, i) => {
        let c = W_BASE;
        if (pm[i] != null) c += ' underline decoration-dotted decoration-accent decoration-2 underline-offset-[5px]';
        if (step === 3 && x.k) c += ' font-semibold';
        if (wordSel === i) c += ' bg-accent text-on-accent hover:bg-accent';
        return `${esc(x.lead)}<button class="${c}" data-w="${i}" data-a="${i}" data-b="${i}">${esc(x.core)}</button>${esc(x.trail)}`;
      })
      .join(' ');
    hint.classList.remove('hidden');
    hint.textContent = (cur.phrases || []).length ? '点单词看释义，虚线下划线是固定搭配。' : '点单词看释义。';
  } else if (step === 1) {
    hint.classList.add('hidden');
    const t = [];
    let wi = 0;
    cur.segs.forEach((g) =>
      toks(g.t).forEach((tk) => {
        const n = tk.t.split(/\s+/).length;
        t.push({ a: wi, b: wi + n - 1, ...tk });
        wi += n;
      }),
    );
    el.innerHTML = t
      .map((tk, i) => {
        let c = T_BASE;
        if (checked) {
          const sel = picked.has(i);
          if (tk.k && sel) c += ' shadow-[inset_0_0_0_2px_var(--ok)] text-ok';
          else if (tk.k) c += ' shadow-[inset_0_0_0_2px_var(--ok)] text-ok bg-[repeating-linear-gradient(135deg,var(--ok-soft)_0_4px,transparent_4px_8px)]';
          else if (sel) c += ' shadow-[inset_0_0_0_2px_var(--bad)] text-bad line-through';
          if (tk.k === 'main') c += ' bg-ok-soft font-semibold';
          c += ' cursor-default';
        } else {
          c += ' cursor-pointer hover:bg-accent-soft';
          if (picked.has(i)) c += ' shadow-[inset_0_0_0_2px_var(--accent)] text-accent';
        }
        return `<button class="${c}" data-t="${i}" data-a="${tk.a}" data-b="${tk.b}" ${checked ? 'tabindex="-1"' : ''} aria-pressed="${picked.has(i)}">${esc(tk.t)}</button>${esc(tk.p)}`;
      })
      .join(' ');
  } else {
    hint.classList.add('hidden');
    let wi = 0;
    el.innerHTML = cur.segs
      .map((g, si) => {
        const tk = toks(g.t);
        const n = tk.reduce((acc, x) => acc + x.t.split(/\s+/).length, 0);
        const a = wi;
        wi += n;
        const rc = ROLE_CLS[g.r] || ROLE_CLS.main;
        let c = `cursor-pointer rounded-[3px] px-0.5 py-0.5 box-decoration-clone bg-[linear-gradient(var(--hl),var(--hl))] bg-no-repeat border-b-[2.5px] transition-opacity duration-200 data-[reading]:outline-2 data-[reading]:outline-read ${rc.hl}`;
        c += roleOn[g.r] ? ` ${rc.border}` : ' border-transparent';
        if (mainOnly && g.r !== 'main') c += ' opacity-20';
        if (segPick === si) c += ' outline-2 outline-offset-1 outline-ink';
        const inner = tk
          .map((x) => (x.k === 'main' ? `<b class="font-semibold underline decoration-2 underline-offset-4">${esc(x.t)}</b>${esc(x.p)}` : x.k === 'sub' ? `<b class="font-semibold">${esc(x.t)}</b>${esc(x.p)}` : esc(x.t)))
          .join(' ');
        return `<span class="${c}" style="background-size:${roleOn[g.r] ? '100%' : '0%'} 100%" data-seg="${si}" data-a="${a}" data-b="${wi - 1}" tabindex="0" role="button">${inner}</span>`;
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

function step1HTML() {
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
      <div class="${C.row}"><button class="${C.btnPrimary}" data-go="2">下一步：看结构</button><button class="${C.btn}" data-act="reset">再做一次</button></div>`;
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
  const allDone = sentences.length && sentences.every((x) => rec(x.id)?.done);
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
      <div class="${C.row}">${isLast ? '' : `<button class="${C.btnPrimary}" data-act="next">下一句 →</button>`}<button class="${C.btn}" data-act="retry">重选</button></div>
      ${allDone ? '<p class="m-0 text-center text-[14px] text-muted">句库里的句子全部完成了。明天早上会有 5 句新句子，或者现在点上方“生成 5 句新句子”。</p>' : ''}` : ''}`;
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
    settingsView.open();
  }
}

function showView(name) {
  view = name;
  ui.view = view;
  saveUI();
  if (speaking) stopSpeak();
  if (name === 'settings') settingsOpened = false; // 每次进入都重新读取
  renderViews();
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
  roleOn = { main: 1, attr: 1, noun: 1, adv: 1, nonfin: 1 };
  optOrder = shuffle(s.opts.length);
  const c = rec(s.id)?.choice;
  answer = c && c.pick >= 0 && c.pick < s.opts.length ? c.pick : -1;
  if (!keepView) view = 'practice';
  renderAll(true);
}

function setStep(n) {
  if (step === n || !cur) return;
  if (speaking) stopSpeak();
  step = n;
  wordSel = null;
  if (n === 2) sweepPending = true;
  renderTabs();
  renderSentence();
  renderPanel(true);
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
  if (ui.cur && sentences.some((s) => s.id === ui.cur)) return open(ui.cur, { keepView: true });
  const nd = sentences.find((s) => !rec(s.id)?.done);
  open((nd || sentences.at(-1)).id, { keepView: true });
}

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

async function generate() {
  if (generating) return;
  generating = true;
  $('gen').disabled = true;
  const st = $('genStatus');
  st.innerHTML = `<span class="${C.spin}"></span><span class="flex-1">AI 正在出 5 道新题，大约需要 1 分钟…</span>`;
  st.classList.remove('hidden');
  st.classList.add('flex');
  try {
    const r = await api.generate();
    st.classList.add('hidden');
    st.classList.remove('flex');
    const added = await checkNewSentences();
    const first = r.added[0];
    if (first && sentences.some((x) => x.id === first)) open(first);
    if (!added) toast(`新增 ${r.added.length} 句，已为你打开第一句`);
  } catch (e) {
    st.innerHTML = `<span class="flex-1">${esc(e.message)}</span><button class="${C.btnSmall}" data-act="closeGen">知道了</button>`;
  } finally {
    generating = false;
    $('gen').disabled = false;
  }
}

// ---------- 提示条 ----------
let toastTimer = null;
function toast(msg, action) {
  const t = $('toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="cursor-pointer rounded-full bg-accent px-3 py-1 text-[13.5px] font-semibold text-on-accent">${esc(action.label)}</button>` : ''}`;
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
$('gen').onclick = generate;
$('more').onclick = onDelete;
$('genStatus').addEventListener('click', (e) => {
  if (e.target.closest('[data-act="closeGen"]')) {
    $('genStatus').classList.add('hidden');
    $('genStatus').classList.remove('flex');
  }
});
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
  const t = e.target.closest('[data-t]');
  if (t && step === 1 && !checked) {
    const i = +t.dataset.t;
    picked.has(i) ? picked.delete(i) : picked.add(i);
    renderSentence();
    renderPanel(false);
    if (picked.has(i)) A.pop($('sentence').querySelector(`[data-t="${i}"]`));
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
  if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset.seg !== undefined) {
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
      toast(`第 ${sentences.indexOf(cur) + 1} 句完成`);
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
      renderSentence();
      renderPanel(true);
      A.popEach($('sentence').querySelectorAll('[data-t]'));
      return;
    }
    case 'clear':
      picked.clear();
      break;
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
    case 'gosettings':
      showView('settings');
      return;
    default:
      return;
  }
  renderSentence();
  renderPanel(false);
});
$('panel').addEventListener('input', (e) => {
  if (e.target.id === 'draft' && cur) saveDraft(cur.id, e.target.value);
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkNewSentences();
});
setInterval(checkNewSentences, 10 * 60 * 1000);

// ---------- 设置页 ----------
const settingsView = createSettingsView({
  root: $('viewSettings'),
  toast,
  onSaved: async () => {
    usage = await api.usage().catch(() => usage);
    if (cur && step === 3) renderPanel(false);
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
