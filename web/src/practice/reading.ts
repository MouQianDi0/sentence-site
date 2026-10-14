// 朗读：整句朗读时逐词高亮、点词或点知识点卡片朗读、选声音和语速
import { flat, plain } from '@sentence-site/shared/text';
import * as speech from '../lib/speech.ts';
import * as A from '../lib/anim.ts';
import { $, all, closest } from '../lib/dom.ts';
import { esc } from '../lib/format.ts';
import { state, saveUI } from '../state.ts';

function updSpeakBtn(): void {
  const b = $('speak');
  b.classList.toggle('border-accent', state.speaking);
  b.classList.toggle('text-accent', state.speaking);
  $('speakTxt').textContent = state.speaking ? '停止' : '朗读';
  b.setAttribute('aria-label', state.speaking ? '停止朗读' : '朗读整句');
  A.equalizer(b.querySelectorAll('.eq'), state.speaking);
}

function clearReading(): void {
  all('#sentence [data-reading]').forEach((x) => x.removeAttribute('data-reading'));
}

export function stopSpeak(): void {
  speech.stopSpeaking();
  state.speaking = false;
  clearReading();
  updSpeakBtn();
}

/** 朗读一段文字（单词、搭配、某一段） */
export function sayText(text: string): void {
  if (state.speaking) stopSpeak();
  speech.speak(text, { voiceName: state.ui.voice, rate: Number(state.ui.rate) || 0.9 });
}

/** 朗读整句：读到哪个词，就高亮句子里对应的那一块 */
function readSentence(): void {
  const { cur } = state;
  if (!cur) return;
  if (state.speaking) return stopSpeak();
  const text = plain(cur);
  const fw = flat(cur);
  const starts: number[] = [];
  let pos = 0;
  fw.forEach((w) => {
    const full = w.lead + w.core;
    const at = text.indexOf(full, pos);
    const st = at < 0 ? pos : at;
    starts.push(st + w.lead.length);
    pos = st + full.length;
  });
  state.speaking = true;
  updSpeakBtn();
  speech.speak(text, {
    voiceName: state.ui.voice,
    rate: Number(state.ui.rate) || 0.9,
    onWord: (ci) => {
      let wi = 0;
      for (let i = 0; i < starts.length; i++) {
        if ((starts[i] ?? 0) <= ci + 1) wi = i;
        else break;
      }
      clearReading();
      for (const el of all('#sentence [data-a]')) {
        if (Number(el.dataset.a) <= wi && wi <= Number(el.dataset.b)) {
          el.setAttribute('data-reading', '');
          break;
        }
      }
    },
    onEnd: () => {
      state.speaking = false;
      clearReading();
      updSpeakBtn();
    },
  });
}

function fillVoices(): void {
  const voices = speech.loadVoices();
  const sel = $<HTMLSelectElement>('voiceSel');
  sel.innerHTML = voices.length
    ? voices
        .map(
          (v) =>
            `<option value="${esc(v.name)}">${esc(v.name.replace(/^Microsoft |^Google /, ''))} · ${esc(v.lang)}</option>`,
        )
        .join('')
    : '<option value="">系统默认英文声音</option>';
  const { voice } = state.ui;
  if (voice && voices.some((v) => v.name === voice)) sel.value = voice;
}

function updRates(): void {
  const r = Number(state.ui.rate) || 0.9;
  all('#rates [data-rate]').forEach((b) =>
    b.setAttribute('aria-pressed', String(Math.abs(Number(b.dataset.rate) - r) < 0.01)),
  );
}

export function initReading(): void {
  if (speech.TTS) {
    for (const id of ['speak', 'voiceBtn']) {
      $(id).classList.remove('hidden');
      $(id).classList.add('inline-flex');
    }
    fillVoices();
    speech.onVoicesChanged(fillVoices);
  }
  updRates();
  $('speak').onclick = readSentence;
  $('voiceBtn').onclick = () => {
    const p = $('voicePanel');
    const show = p.classList.contains('hidden');
    p.classList.toggle('hidden', !show);
    p.classList.toggle('flex', show);
    $('voiceBtn').setAttribute('aria-expanded', String(show));
    if (show) {
      fillVoices();
      A.slideIn(p);
    }
  };
  $<HTMLSelectElement>('voiceSel').onchange = (e) => {
    state.ui.voice = (e.target as HTMLSelectElement).value;
    saveUI();
    const first = state.cur?.segs[0];
    if (first) sayText(first.t.replace(/[*^]/g, ''));
  };
  $('rates').addEventListener('click', (e) => {
    const b = closest(e, '[data-rate]');
    if (!b) return;
    state.ui.rate = Number(b.dataset.rate);
    saveUI();
    updRates();
  });
  // 页面上任何 data-say 按钮：朗读它带的文字
  document.addEventListener('click', (e) => {
    const s = closest(e, '[data-say]');
    if (s?.dataset.say) sayText(s.dataset.say);
  });
}
