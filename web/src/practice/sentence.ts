// 句子卡片：按当前步骤画出句子（圈谓语 / 看结构 / 查词 / 修正答案），以及查词卡片
import { flat, phraseMap, trunkWords, type FlatWord } from '@sentence-site/shared/text';
import { api } from '../lib/api.ts';
import * as A from '../lib/anim.ts';
import { $, closest } from '../lib/dom.ts';
import { esc } from '../lib/format.ts';
import * as speech from '../lib/speech.ts';
import { C, ICON, ROLE_CLS } from '../styles.ts';
import { state, saveDict } from '../state.ts';
import { renderPanel } from './panel.ts';
import { fixSpans } from './fix.ts';
import { sayText, stopSpeak } from './reading.ts';

// 句子排版：每个单词放进左右各留 3px 的“槽”（data-wi），所有步骤、所有状态下槽都一样宽，单词之间只隔一个空格。
// 圈选、底色、描边、加粗、删除线都画在槽或分组上，不改变宽度；分组用可以跨行断开的 span，
// 所以句子在任何步骤、点选前后，换行位置都完全一样，不会跳动。
const SLOT = 'inline rounded-[5px] px-[3px] [line-height:inherit]';
const GROUP = 'rounded-full box-decoration-clone [line-height:inherit] transition-colors data-[reading]:bg-read';
// 单词前后的标点（引号、逗号、句号）用负边距收进槽的留白里，读起来紧贴单词，宽度在各步骤里同样不变
const leadHTML = (x: FlatWord) => (x.lead ? `<span class="-mr-[3px]">${esc(x.lead)}</span>` : '');
const trailHTML = (x: FlatWord | undefined) => (x?.trail ? `<span class="-ml-[3px]">${esc(x.trail)}</span>` : '');
// 可点的单词也用 span（role=button），不用 button：button 是整块的行内元素，和普通文字的断行规则不同
const slotHTML = (x: FlatWord, i: number, cls = '', attrs = '') =>
  `${leadHTML(x)}<span data-wi="${i}" class="${SLOT} ${cls}" ${attrs}>${esc(x.core)}</span>`;

type Group<K> = { key: K; a: number; b: number };

/** 把连续的单词按 key 分组（同一个词块 / 同一段），返回 [{key, a, b}]，a、b 是单词下标 */
function groupsOf<K extends 'ti' | 'si'>(fw: FlatWord[], key: K): Group<FlatWord[K]>[] {
  const out: Group<FlatWord[K]>[] = [];
  fw.forEach((x, i) => {
    const last = out.at(-1);
    if (last && last.key === x[key]) last.b = i;
    else out.push({ key: x[key], a: i, b: i });
  });
  return out;
}

/** 一组单词：组内单词用空格隔开，最后一个词后面的标点放到组外 */
function groupHTML(
  fw: FlatWord[],
  g: { a: number; b: number },
  inner: (x: FlatWord, i: number) => string,
  open: string,
  close = '</span>',
): string {
  const parts: string[] = [];
  for (let i = g.a; i <= g.b; i++) {
    const x = fw[i];
    if (x) parts.push(inner(x, i) + (i < g.b ? trailHTML(x) : ''));
  }
  return `${open}${parts.join(' ')}${close}${trailHTML(fw[g.b])}`;
}

export function renderSentence(): void {
  A.clearPops();
  const el = $('sentence');
  const hint = $('hint');
  const { cur, step, fix } = state;
  if (!cur) {
    $('label').textContent = '';
    $('focus').textContent = '';
    $('lvl').classList.add('hidden');
    $('tools').classList.add('invisible');
    $('pin').classList.add('invisible');
    el.innerHTML = state.loaded
      ? '<span class="flex flex-col gap-2 py-1.5"><span class="font-head text-[20px] font-bold">句库还是空的</span><span class="font-zh text-[15px] text-muted">每天早上 7:50 会自动加入 5 句新句子，也可以点上方“生成 5 句新句子”马上开始。</span></span>'
      : `<span class="flex flex-col gap-3 py-2"><span class="${C.shim} h-4"></span><span class="${C.shim} h-4 w-[86%]"></span><span class="${C.shim} h-4 w-[60%]"></span></span>`;
    hint.classList.add('hidden');
    $('wordCard').innerHTML = '';
    return;
  }
  $('tools').classList.remove('invisible');
  $('pin').classList.remove('invisible');
  hint.classList.remove('hidden');
  $('label').textContent = `句子 ${state.sentences.indexOf(cur) + 1} / ${state.sentences.length}`;
  $('lvl').classList.toggle('hidden', !cur.level);
  $('lvl').textContent = cur.level ?? '';
  $('focus').textContent = cur.focus ?? '';
  const dict = (state.dictMode && !fix) || step === 3;
  // 第 3 步一直是查词状态：按钮保持原位、显示为按下且不能点，工具栏不会因为它消失而挪动
  const dictBtn = $<HTMLButtonElement>('dict');
  dictBtn.disabled = step === 3 || !!fix;
  dictBtn.setAttribute('aria-pressed', String(dict));
  const fw = flat(cur);

  if (dict) {
    const pm = phraseMap(cur, fw);
    el.innerHTML = fw
      .map((x, i) => {
        let c = 'cursor-pointer transition-colors hover:bg-accent-soft data-[reading]:bg-read';
        if (pm[i] != null) c += ' underline decoration-dotted decoration-accent decoration-2 underline-offset-[5px]';
        if (step === 3 && x.k) c += ' fake-bold';
        if (state.wordSel === i) c += ' bg-accent text-on-accent hover:bg-accent';
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
    const { checked, picked } = state;
    hint.textContent = checked ? '绿框是谓语，绿底是主句谓语。' : '点出句子里所有的谓语动词。';
    // 词块用 span（不是 button），was published 这种多词词块到行尾时可以和别的步骤一样断开换行
    el.innerHTML = groupsOf(fw, 'ti')
      .map((g) => {
        const t = g.key;
        const k = fw[g.a]?.k;
        const sel = picked.has(t);
        let c = GROUP;
        if (checked) {
          if (k && sel) c += ' shadow-[inset_0_0_0_2px_var(--ok)] text-ok';
          else if (k)
            c +=
              ' shadow-[inset_0_0_0_2px_var(--ok)] text-ok bg-[repeating-linear-gradient(135deg,var(--ok-soft)_0_4px,transparent_4px_8px)]';
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
    const { mainOnly, roleOn, segPick } = state;
    hint.textContent = '点彩色片段，看它是什么成分、修饰谁。';
    // 只看主干：按主干句里的词点亮（宾语从句这类主干缺不了的从句骨架也会保留）；主干对不上原句时退回按成分颜色
    const tw = mainOnly ? trunkWords(cur) : null;
    el.innerHTML = groupsOf(fw, 'si')
      .map((sg) => {
        const si = sg.key;
        const g = cur.segs[si];
        if (!g) return '';
        const rc = ROLE_CLS[g.r] || ROLE_CLS.main;
        let c = `cursor-pointer rounded-[3px] py-0.5 box-decoration-clone bg-[linear-gradient(var(--hl),var(--hl))] bg-no-repeat border-b-[2.5px] transition-opacity duration-200 data-[reading]:outline-2 data-[reading]:outline-read ${rc.hl}`;
        const colored = roleOn[g.r] && !(tw && g.r !== 'main');
        c += colored ? ` ${rc.border}` : ' border-transparent';
        if (mainOnly && !tw && g.r !== 'main') c += ' opacity-20';
        if (segPick === si) c += ' outline-2 outline-offset-1 outline-ink';
        const word = (x: FlatWord, i: number) => slotHTML(x, i, tw && !tw.has(i) ? 'opacity-20' : '');
        // 段内再按词块分组：谓语词块整体加粗；主句谓语再画一条连贯的底线（用背景画，单词槽的留白处也连着）
        const parts = groupsOf(fw.slice(sg.a, sg.b + 1), 'ti').map((tg) => {
          const at = { a: tg.a + sg.a, b: tg.b + sg.a };
          const k = fw[at.a]?.k;
          if (!k) return groupHTML(fw, at, word, '', '');
          return groupHTML(
            fw,
            at,
            word,
            `<span class="fake-bold${k === 'main' ? ' box-decoration-clone bg-[linear-gradient(currentColor,currentColor)] bg-[length:100%_2px] bg-bottom bg-no-repeat' : ''}">`,
          );
        });
        return `<span class="${c}" style="background-size:${colored ? '100%' : '0%'} 100%" data-seg="${si}" data-a="${sg.a}" data-b="${sg.b}" tabindex="0" role="button">${parts.join(' ')}</span>`;
      })
      .join(' ');
    if (state.sweepPending) {
      state.sweepPending = false;
      A.sweep(el.querySelectorAll('[data-seg]'));
    }
  }
  renderWordCard();
}

// ---------- 查词 ----------
function renderWordCard(): void {
  const box = $('wordCard');
  const { cur, wordSel } = state;
  if (!cur || wordSel == null || !(state.dictMode || state.step === 3)) {
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
  const pi = pm[wordSel];
  const ph = pi != null ? cur.phrases[pi] : null;
  const loc = (cur.words || []).find(
    (x) => String(x.w || '').toLowerCase() === w.norm || String(x.lemma || '').toLowerCase() === w.norm,
  );
  const key = `${w.norm}|${cur.id}`;
  const cached = state.dictCache[key];
  const info: { zh?: string; lemma?: string; pos?: string; ipa?: string; more?: string } | undefined = loc || cached;
  let body: string;
  if (info) {
    body = `<div class="text-[16px]">${esc(info.zh || '')}</div>${info.lemma && String(info.lemma).toLowerCase() !== w.norm ? `<div class="text-[13.5px] text-muted">原形 <span class="font-en">${esc(info.lemma)}</span></div>` : ''}${info.more ? `<div class="text-[13.5px] text-muted">其他常见义：${esc(info.more)}</div>` : ''}`;
  } else if (state.lookupBusy === key) {
    body = `<div class="${C.shim} w-[60%]"></div><div class="${C.shim} w-[40%]"></div>`;
  } else if (state.lookupErr && state.lookupErr.key === key) {
    body = `<div class="text-[13.5px] text-muted">${esc(state.lookupErr.msg)}</div>`;
  } else {
    body = '<div class="text-[13.5px] text-muted">正在查询…</div>';
    void lookup(w, key);
  }
  const say = (t: string, label: string) =>
    speech.TTS ? `<button class="${C.iconBtn}" data-say="${esc(t)}" aria-label="${label}">${ICON.play}</button>` : '';
  const phHtml = ph
    ? `<div class="flex flex-wrap items-center gap-2 border-t border-dashed border-line pt-2 text-[14px]"><span class="rounded bg-accent-soft px-1.5 py-px font-mono text-[10.5px] tracking-[.08em] text-accent">搭配</span><span class="font-en font-semibold">${esc(ph.p || ph.m)}</span><span>${esc(ph.zh || '')}</span>${say(ph.p || ph.m, '朗读搭配')}</div>`
    : '';
  const prev = box.firstElementChild as HTMLElement | null;
  const fresh = !prev || prev.dataset.word !== key;
  box.innerHTML = `<div data-word="${esc(key)}" class="flex flex-col gap-1.5 rounded-xl bg-raise px-3.5 py-3">
    <div class="flex flex-wrap items-baseline gap-2"><span class="font-en text-[21px] font-semibold">${esc(w.core)}</span>${info?.pos ? `<span class="font-mono text-[12px] text-accent">${esc(info.pos)}</span>` : ''}${info?.ipa ? `<span class="font-en text-[14px] text-muted">${esc(info.ipa)}</span>` : ''}
      <span class="ml-auto flex gap-1.5">${say(w.core, '朗读单词')}<button class="${C.iconBtn}" data-act="closeWord" aria-label="关闭">${ICON.close}</button></span></div>
    ${body}${phHtml}</div>`;
  if (fresh) A.slideIn(box.firstElementChild);
}

async function lookup(w: FlatWord, key: string): Promise<void> {
  if (state.lookupBusy === key || !state.cur) return;
  state.lookupBusy = key;
  state.lookupErr = null;
  const s = state.cur;
  try {
    const r = await api.lookup(s.id, w.core);
    state.dictCache[key] = r.data;
    const keys = Object.keys(state.dictCache);
    if (keys.length > 500) keys.slice(0, 100).forEach((k) => delete state.dictCache[k]);
    saveDict();
  } catch (e) {
    state.lookupErr = { key, msg: (e as Error).message || '没查到，稍后再试' };
  }
  state.lookupBusy = null;
  if (state.cur === s) renderWordCard();
}

// ---------- 点句子 ----------
function onSentenceClick(e: MouseEvent): void {
  const { cur, fix } = state;
  if (!cur) return;
  const w = closest(e, '[data-w]');
  if (w) {
    const i = Number(w.dataset.w);
    state.wordSel = state.wordSel === i ? null : i;
    renderSentence();
    const word = flat(cur)[i];
    if (state.wordSel != null && speech.TTS && !state.speaking && word) sayText(word.core);
    return;
  }
  const fx = closest(e, '[data-fx]');
  if (fx && fix && !fix.busy) {
    const i = Number(fx.dataset.fx);
    const k = fix.tag[i];
    if (k === 'main') fix.tag[i] = null;
    else if (k === 'sub') {
      // 主句谓语只有一处：把别处的主句谓语改成从句谓语
      fix.tag = fix.tag.map((x) => (x === 'main' ? 'sub' : x));
      fix.tag[i] = 'main';
      const sp = fixSpans().find((x) => x.a <= i && i <= x.b);
      // 同一个短语里的其他词跟着变成主句谓语
      for (let j = sp ? sp.a : i; j <= (sp ? sp.b : i); j++) fix.tag[j] = 'main';
    } else fix.tag[i] = 'sub';
    fix.msg = '';
    renderSentence();
    renderPanel(false);
    return;
  }
  const t = closest(e, '[data-t]');
  if (t && state.step === 1 && !state.checked) {
    const i = Number(t.dataset.t);
    if (state.picked.has(i)) state.picked.delete(i);
    else state.picked.add(i);
    renderSentence();
    renderPanel(false);
    if (state.picked.has(i)) A.popText($('sentence').querySelector<HTMLElement>(`[data-t="${i}"]`));
    return;
  }
  const g = closest(e, '[data-seg]');
  if (g && state.step === 2) {
    const si = Number(g.dataset.seg);
    state.segPick = si === state.segPick ? -1 : si;
    renderSentence();
    renderPanel(false);
    if (state.segPick >= 0) A.slideIn($('panel').querySelector('[data-kcard]'));
  }
}

export function initSentence(): void {
  $('sentence').addEventListener('click', onSentenceClick);
  // 句子里可点的 span 也能用键盘操作
  $('sentence').addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    const d = t.dataset || {};
    if (
      (e.key === 'Enter' || e.key === ' ') &&
      (d.seg !== undefined || d.t !== undefined || d.w !== undefined || d.fx !== undefined)
    ) {
      e.preventDefault();
      t.click();
    }
  });
  $('wordCard').addEventListener('click', (e) => {
    if (closest(e, '[data-act="closeWord"]')) {
      state.wordSel = null;
      renderSentence();
    }
  });
  $('dict').onclick = () => {
    state.dictMode = !state.dictMode;
    state.wordSel = null;
    if (state.speaking) stopSpeak();
    renderSentence();
  };
}
