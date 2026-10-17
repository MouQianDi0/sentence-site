// 第 3 步“翻译”：写译文交给 AI 批改、看批改结果，再从三个译文里选出最好的。
// 批改在后台进行：交上去以后可以去做别的句子（也可以同时批改好几句），批改好了屏幕下方提醒，点“查看”回到那一句。
import type { Attempt } from '@sentence-site/shared';
import { diff } from '@sentence-site/shared/text';
import { api } from '../lib/api.ts';
import { $ } from '../lib/dom.ts';
import { esc, scoreTone, shuffle } from '../lib/format.ts';
import * as A from '../lib/anim.ts';
import { toast } from '../lib/toast.ts';
import { C, TONE } from '../styles.ts';
import { state, rec, atts, lastAttempt, taskInfo } from '../state.ts';
import { showView } from '../views.ts';
import { renderRecords } from '../records.ts';
import { cancelDraftSave, saveRecord } from './data.ts';
import { renderBank } from './bank.ts';
import { open } from './nav.ts';
import { renderPanel, renderTabs, setStep } from './panel.ts';
import { renderDone, showDonePage } from './task.ts';

/** 批改结果：总分圆环、三项分数、译文里标出的问题、修改建议 */
function fbHTML(a: Attempt): string {
  const total = a.total ?? 0;
  const tone = TONE[scoreTone(total)];
  const full = 2 * Math.PI * 42;
  const text = a.text || '';
  const fb = a.feedback || { level: '', good: [], issues: [], better: '' };
  const issues = fb.issues || [];
  const ranges: { a: number; b: number; n: number }[] = [];
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
  const bar = (lbl: string, v: number | null, max: number) => {
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
    ${
      issues.length
        ? `<div class="flex flex-col gap-1.5"><span class="${C.label}">需要改的地方</span><ol class="m-0 flex list-none flex-col gap-2 p-0">${issues
            .map(
              (
                it,
                i,
              ) => `<li data-issue class="grid grid-cols-[22px_1fr] gap-x-2 gap-y-1 rounded-[10px] bg-raise px-3 py-2.5 text-[14px]">
        <span class="row-span-2 mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-bad font-mono text-[11px] text-sheet">${i + 1}</span>
        <span class="flex min-w-0 flex-wrap items-baseline gap-1.5"><span class="rounded bg-bad-soft px-1.5 py-px font-mono text-[10.5px] tracking-[.06em] text-bad">${esc(it.type || '问题')}</span><span class="text-bad line-through">${esc(it.src)}</span><span>→</span><span class="font-semibold text-ok">${esc(it.fix)}</span></span>
        <span class="text-[13.5px] text-muted">${esc(it.why)}</span></li>`,
            )
            .join('')}</ol></div>`
        : ''
    }
    ${(fb.good || []).length ? `<div class="flex flex-col gap-1.5"><span class="${C.label}">做得好的地方</span><ul class="m-0 flex list-disc flex-col gap-0.5 pl-[18px] text-[14px] marker:text-ok">${fb.good.map((g) => `<li>${esc(g)}</li>`).join('')}</ul></div>` : ''}
    ${
      fb.better
        ? `<div class="flex flex-col gap-1.5"><span class="${C.label}">在你的译文上修改</span><p data-diff class="m-0 text-[15.5px] leading-[1.9]">${df
            .map((d) =>
              d.t === '='
                ? esc(d.s)
                : d.t === '+'
                  ? `<span class="rounded-[2px] bg-ok-soft font-semibold text-ok">${esc(d.s)}</span>`
                  : `<span class="rounded-[2px] bg-bad-soft text-bad line-through">${esc(d.s)}</span>`,
            )
            .join('')}</p></div>`
        : ''
    }
  </div>`;
}

/** 选译文：选之前随机排列；选了以后标出对错和每个选项好在哪、错在哪 */
export function quizHTML(): string {
  const { cur } = state;
  if (!cur) return '';
  const answered = state.answer >= 0;
  const isLast = state.sentences.indexOf(cur) === state.sentences.length - 1;
  if (state.optOrder.length !== cur.opts.length) state.optOrder = shuffle(cur.opts.length);
  const t = taskInfo();
  const taskDone = t.complete && t.list.some((x) => x.id === cur.id);
  return `<div class="flex flex-col gap-2">${state.optOrder
    .map((oi, k) => {
      const o = cur.opts[oi];
      if (!o) return '';
      let c = 'border-line';
      let kc = 'text-muted';
      if (answered) {
        if (o.ok) [c, kc] = ['border-ok bg-ok-soft', 'text-ok'];
        else if (oi === state.answer) [c, kc] = ['border-bad bg-bad-soft', 'text-bad'];
      } else c += ' hover:border-accent cursor-pointer';
      return `<button data-opt="${oi}" ${answered ? 'tabindex="-1"' : ''} class="grid grid-cols-[auto_1fr] items-start gap-x-2.5 gap-y-1 rounded-xl border-[1.5px] bg-sheet px-3.5 py-3 text-left transition-colors ${answered ? 'cursor-default' : ''} ${c}">
        <span class="pt-px font-mono text-[13px] ${kc}">${'ABCD'[k]}</span><span class="min-w-0">${esc(o.t)}</span>
        ${answered ? `<span class="col-start-2 text-[13.5px] text-muted">${o.ok ? '✓ ' : ''}${esc(o.why)}</span>` : ''}</button>`;
    })
    .join('')}</div>
    ${
      answered
        ? `<div class="border-l-[3px] border-accent py-1 pl-3 text-[14.5px]"><b class="block font-mono text-[11px] font-medium tracking-[.1em] text-accent">翻译技巧</b>${esc(cur.tip)}</div>
      <div class="${C.row}">${taskDone ? `<button class="${C.btnPrimary}" data-act="showDone">今日任务完成，去看看 →</button>` : isLast ? '' : `<button class="${C.btnPrimary}" data-act="next">下一句 →</button>`}<button class="${C.btn}" data-act="retry">重选</button></div>`
        : ''
    }`;
}

export function step3HTML(): string {
  const { cur, usage } = state;
  if (!cur) return '';
  const list = atts(cur.id);
  const best = list.length ? Math.max(...list.map((x) => x.total ?? 0)) : null;
  const draft = rec(cur.id)?.draft || '';
  const aiReady = usage ? usage.aiReady : true;
  const left = usage ? Math.max(0, usage.limits.grade - usage.grades) : null;
  const grading = state.grading.has(cur.id);
  const err = state.gradeErr[cur.id];
  let area = '';
  if (grading) {
    // 开着准确度提升时后台要评 5 次再汇总，告诉一声会慢一点
    const boost = state.practiceCfg.accuracyBoost ? '开着准确度提升，会多花一点时间。' : '';
    const hasNext = state.sentences.length > 1;
    area = `<div class="flex flex-col gap-2 ${C.card} p-3.5"><span class="inline-flex items-center gap-2"><span class="${C.spin}"></span>AI 老师正在批改…</span>
      <div class="${C.shim}"></div><div class="${C.shim} w-[80%]"></div><div class="${C.shim} w-[55%]"></div>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2 pt-1"><span class="min-w-0 flex-[1_1_220px] text-[13px] text-muted">${boost}不用在这里等，可以先去做别的句子，批改好了会在屏幕下方提醒你。</span>${hasNext ? `<button class="${C.btn}" data-act="next">先做下一句 →</button>` : ''}</div></div>`;
  } else if (err) area = `<div class="rounded-xl bg-bad-soft px-3.5 py-2.5 text-[14px]">${esc(err)}</div>`;
  const last = lastAttempt(cur.id);
  const fb = last && !grading ? fbHTML(last) : '';
  const showQuiz = state.quizOpen || list.length > 0 || !!rec(cur.id)?.choice;
  let note = '';
  if (!aiReady) note = 'AI 模型还没配置。';
  else if (list.length)
    note = `已批改 ${list.length} 次 · 最高 ${best} 分${left != null ? ` · 今天还能批改 ${left} 次` : ''}`;
  else if (left != null) note = `今天还能批改 ${left} 次`;
  return `<label class="m-0" for="draft">先自己译一遍，AI 老师按准确、通顺、完整三项打分，并指出哪里要改、怎么改。</label>
    <textarea id="draft" maxlength="500" placeholder="在这里写你的中文译文……" class="min-h-24 w-full resize-y rounded-xl border-[1.5px] border-line bg-sheet px-3 py-2.5 text-[15.5px] outline-none transition-colors focus:border-accent">${esc(draft)}</textarea>
    <div class="${C.row}"><button class="${C.btnPrimary}" data-act="grade" ${aiReady && !grading ? '' : 'disabled'}>${list.length ? '重新批改' : 'AI 批改'}</button>${showQuiz ? '' : `<button class="${C.btn}" data-act="skip">跳过，直接选译文</button>`}
      <span class="text-[13px] text-muted">${esc(note)}</span>${aiReady ? '' : `<button class="cursor-pointer text-[13px] font-semibold text-accent underline underline-offset-4" data-act="gosettings">去设置模型</button>`}</div>
    ${area}${fb}
    ${showQuiz ? `<div class="flex items-center gap-2.5 text-[13px] text-muted before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">对照：选出最好的译文</div><div id="quiz" class="flex flex-col gap-3">${quizHTML()}</div>` : ''}`;
}

/** 现在是不是正看着这一句的第 3 步（看着的话结果直接出现在面前，不用另外提醒） */
const watching = (id: string): boolean =>
  state.view === 'practice' && !state.showDone && state.cur?.id === id && state.step === 3 && !document.hidden;

/** 重画面板时，正在译文框里打字的话，光标留在原来的位置 */
function keepCaret(fn: () => void): void {
  const el = document.activeElement;
  const at = el instanceof HTMLTextAreaElement && el.id === 'draft' ? [el.selectionStart, el.selectionEnd] : null;
  fn();
  const ta = document.getElementById('draft');
  if (at && ta instanceof HTMLTextAreaElement) {
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(at[0] ?? 0, at[1] ?? 0);
  }
}

/** 提醒里点“查看”：回到练习页、打开那一句的第 3 步 */
export function showResult(id: string): void {
  if (!state.sentences.some((s) => s.id === id)) return;
  if (state.view !== 'practice') showView('practice');
  if (state.cur?.id !== id) open(id);
  else if (state.showDone) {
    state.showDone = false;
    renderDone(false);
  }
  if (state.step !== 3) setStep(3);
  else renderPanel(false);
  $('tabs').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/**
 * 交给 AI 批改。批改在后台进行，这期间可以换到别的句子、别的页面；每句同时只批改一份。
 * 批改好了：正看着这一句的第 3 步就直接显示结果（播分数动画），没在看就在屏幕下方提醒，句库圆点上留个小点。
 */
export async function grade(): Promise<void> {
  const s = state.cur;
  if (!s || state.grading.has(s.id)) return;
  const ta = document.getElementById('draft') as HTMLTextAreaElement | null;
  const text = (ta ? ta.value : '').trim();
  if (!text) {
    state.gradeErr[s.id] = '先写下你的译文再批改。';
    renderPanel(false);
    return;
  }
  cancelDraftSave();
  saveRecord(s.id, { draft: text });
  state.grading.add(s.id);
  delete state.gradeErr[s.id];
  state.gradeUnseen.delete(s.id);
  renderPanel(false);
  renderTabs();
  renderBank();
  let note = '';
  let ok = false;
  try {
    const r = await api.grade(s.id, text);
    state.attempts[s.id] = [r.attempt, ...atts(s.id)];
    if (state.usage) state.usage.grades += 1;
    if (state.cur === s) state.quizOpen = true;
    note = `批改好了：${r.attempt.total ?? 0} 分`;
    ok = true;
  } catch (e) {
    state.gradeErr[s.id] = (e as Error).message;
    note = `没批改成：${(e as Error).message}`;
  } finally {
    state.grading.delete(s.id);
  }
  const no = state.sentences.indexOf(s) + 1;
  if (!no) return; // 批改期间这一句被删掉了
  if (watching(s.id)) {
    if (ok) state.freshFb = true;
  } else {
    if (ok) state.gradeUnseen.add(s.id);
    toast(`第 ${no} 句${note}`, { label: '查看', fn: () => showResult(s.id) });
  }
  // 停在这一句时更新步骤标签（第 3 步上的小圈），在第 3 步就把结果画出来；在记录页时把新的批改加进去
  if (state.cur === s && state.view === 'practice') {
    renderTabs();
    if (state.step === 3) keepCaret(() => renderPanel(false));
  }
  if (state.view === 'records') renderRecords();
  renderBank();
}

/** 选了一个译文：记下来，选对了这句就算完成 */
export function pickOption(opt: HTMLElement): void {
  const { cur } = state;
  if (!cur || state.answer >= 0) return;
  state.answer = Number(opt.dataset.opt);
  const ok = !!cur.opts[state.answer]?.ok;
  const wasDone = !!rec(cur.id)?.done;
  saveRecord(cur.id, { choice: { pick: state.answer, ok }, ...(ok ? { done: true } : {}) });
  const q = document.getElementById('quiz');
  if (q) {
    q.innerHTML = quizHTML();
    A.enter(q.children);
    const okEl = [...q.querySelectorAll<HTMLElement>('[data-opt]')].find((b) => cur.opts[Number(b.dataset.opt)]?.ok);
    const badEl = ok ? null : q.querySelector(`[data-opt="${state.answer}"]`);
    A.pulse(okEl);
    A.shake(badEl);
  }
  if (ok && !wasDone) {
    const rct = opt.getBoundingClientRect();
    A.burst(rct.left + rct.width / 2, rct.top + rct.height / 2);
    A.pop($('bank').querySelector(`[data-sid="${CSS.escape(cur.id)}"]`));
    const t = taskInfo();
    if (t.complete && t.list.some((x) => x.id === cur.id)) {
      state.celebrate = true;
      toast('今日任务全部完成！', { label: '查看', fn: () => showDonePage() });
    } else toast(`第 ${state.sentences.indexOf(cur) + 1} 句完成`);
  }
}

/** 重选：重新打乱顺序 */
export function retryQuiz(): void {
  const { cur } = state;
  if (!cur) return;
  state.answer = -1;
  state.optOrder = shuffle(cur.opts.length);
  const q = document.getElementById('quiz');
  if (q) {
    q.innerHTML = quizHTML();
    A.enter(q.children);
  }
}
