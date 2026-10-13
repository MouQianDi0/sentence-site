// 朗读：用浏览器自带的英文语音，优先挑轻柔清晰的女声
export const TTS = 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';

const PREF = ['aria', 'jenny', 'ava', 'samantha', 'allison', 'serena', 'libby', 'sonia', 'google us english', 'google uk english female', 'zira', 'karen', 'moira', 'tessa', 'susan', 'victoria'];

function rank(v) {
  const n = v.name.toLowerCase();
  let s = 0;
  const i = PREF.findIndex((p) => n.includes(p));
  if (i >= 0) s += 100 - i * 3;
  if (/natural|neural|online|enhanced|premium/.test(n)) s += 40;
  if (/en[-_]us/i.test(v.lang)) s += 8;
  if (/en[-_]gb/i.test(v.lang)) s += 5;
  if (/male|david|mark|daniel|alex|fred|guy|ryan|james|thomas/.test(n) && !/female/.test(n)) s -= 30;
  return s;
}

let voices = [];
let speakId = 0;

export function loadVoices() {
  if (!TTS) return [];
  try {
    voices = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang)).sort((a, b) => rank(b) - rank(a));
  } catch {
    voices = [];
  }
  return voices;
}

export function onVoicesChanged(fn) {
  if (TTS) {
    try {
      speechSynthesis.addEventListener('voiceschanged', fn);
    } catch {
      speechSynthesis.onvoiceschanged = fn;
    }
  }
}

export function speak(text, { voiceName, rate = 0.9, onWord, onEnd } = {}) {
  if (!TTS || !text) return;
  try {
    speechSynthesis.cancel();
  } catch {}
  const id = ++speakId;
  const u = new SpeechSynthesisUtterance(text);
  const v = voices.find((x) => x.name === voiceName) || voices[0];
  if (v) {
    u.voice = v;
    u.lang = v.lang;
  } else u.lang = 'en-US';
  u.rate = rate;
  u.pitch = 1.05;
  if (onWord) u.onboundary = (e) => id === speakId && (e.name === 'word' || e.name === undefined) && onWord(e.charIndex);
  const end = () => id === speakId && onEnd && onEnd();
  u.onend = end;
  u.onerror = end;
  try {
    speechSynthesis.speak(u);
  } catch {
    end();
  }
}

export function stopSpeaking() {
  speakId++;
  try {
    speechSynthesis.cancel();
  } catch {}
}
