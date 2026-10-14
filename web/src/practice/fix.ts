// 第 1 步“这题有误”：自己在句子里点出正确的谓语，或者让 AI 复查这一句
import type { MarkSpan, Sentence } from '@sentence-site/shared';
import { flat } from '@sentence-site/shared/text';
import { api } from '../lib/api.ts';
import { esc } from '../lib/format.ts';
import { toast } from '../lib/toast.ts';
import { C } from '../styles.ts';
import { state, aiOk } from '../state.ts';
import { renderPanel } from './panel.ts';
import { renderSentence } from './sentence.ts';

/** 修正模式里标出的谓语：相邻、同一片段、中间没有标点的同类词连成一个 */
export function fixSpans(): (MarkSpan & { text: string })[] {
  const { cur, fix } = state;
  if (!cur || !fix) return [];
  const fw = flat(cur);
  const spans: MarkSpan[] = [];
  fix.tag.forEach((k, i) => {
    if (!k) return;
    const last = spans.at(-1);
    const prev = fw[i - 1];
    if (last && last.kind === k && last.b === i - 1 && prev && prev.si === fw[i]?.si && !prev.trail) last.b = i;
    else spans.push({ kind: k, a: i, b: i });
  });
  return spans.map((sp) => ({
    ...sp,
    text: fw
      .slice(sp.a, sp.b + 1)
      .map((x) => x.core)
      .join(' '),
  }));
}

export function fixHTML(): string {
  const { fix } = state;
  if (!fix) return '';
  const spans = fixSpans();
  const mains = spans.filter((x) => x.kind === 'main');
  const subs = spans.filter((x) => x.kind === 'sub');
  const ready = mains.length === 1;
  const list = (arr: { text: string }[]) => (arr.length ? arr.map((x) => `<b>${esc(x.text)}</b>`).join('、') : '无');
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

/** 保存自己标的答案（useAi=false），或者让 AI 复查（useAi=true） */
export async function saveFix(useAi: boolean): Promise<void> {
  const { cur, fix } = state;
  if (!cur || !fix || fix.busy) return;
  const id = cur.id;
  fix.busy = useAi ? 'ai' : 'save';
  fix.msg = '';
  renderPanel(false);
  try {
    let msg: string;
    let r: { sentence: Sentence };
    if (useAi) {
      const rv = await api.reviewSentence(id);
      r = rv;
      const note = rv.note ? `：${rv.note}` : '';
      msg = rv.changed ? `AI 改正了答案${note}，再做一次吧` : `AI 认为原答案没问题${note}`;
    } else {
      r = await api.fixPredicates(
        id,
        fixSpans().map(({ kind, a, b }) => ({ kind, a, b })),
      );
      msg = '答案已修改，再做一次吧';
    }
    const i = state.sentences.findIndex((x) => x.id === id);
    if (i >= 0) state.sentences[i] = r.sentence;
    if (state.cur?.id !== id) return;
    state.cur = r.sentence;
    state.fix = null;
    state.picked = new Set();
    state.checked = false;
    renderSentence();
    renderPanel(true);
    toast(msg);
  } catch (e) {
    if (state.fix && state.cur?.id === id) {
      state.fix.busy = '';
      state.fix.msg = (e as Error).message;
      renderPanel(false);
    } else toast((e as Error).message);
  }
}
