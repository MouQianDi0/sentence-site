// 真题题库（只有你自己看得到）：从“设置”页的“真题题库”点进来的单独页面，地址 /settings/bank。
// 看各状态的句数、停用 / 启用题库、在后台标注（只用国内模型，不用 ChatGPT），
// 以及逐句处理：确认原文、改原文、不要、重新标注。题库本身在服务器上用命令导入（见 README）。
import type { BankAdmin, BankItem, BankJob, BankStatus } from '@sentence-site/shared';
import { api } from '../lib/api.ts';
import { closest } from '../lib/dom.ts';
import { esc, fmtTime } from '../lib/format.ts';
import * as A from '../lib/anim.ts';
import type { Toast } from '../lib/toast.ts';

const C = {
  card: 'rounded-2xl border border-line bg-sheet',
  label: 'font-mono text-[11px] tracking-[.1em] uppercase text-muted',
  input:
    'w-full min-w-0 rounded-xl border-[1.5px] border-line bg-sheet px-3 py-2 text-[15px] outline-none transition-colors focus:border-accent',
  btn: 'cursor-pointer rounded-full border-[1.5px] border-line bg-sheet px-3 py-1.5 text-[13.5px] transition-transform active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-45',
  btnPrimary:
    'flex-none cursor-pointer rounded-full border-[1.5px] border-accent bg-accent px-4 py-2 text-[14.5px] font-semibold text-on-accent transition-transform active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-45',
  spin: 'inline-block h-4 w-4 flex-none animate-spin rounded-full border-2 border-line border-t-accent',
};

const ICON = {
  back: '<svg class="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.5L5.5 8l4.5 4.5"/></svg>',
  next: '<svg class="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5"/></svg>',
  book: '<svg class="h-[18px] w-[18px]" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H16v12.5H5.5A1.5 1.5 0 0 0 4 17z"/><path d="M4 17a1.5 1.5 0 0 0 1.5 1.5H16" stroke-linecap="round"/><path d="M7.5 7h5M7.5 10h3.5" stroke-linecap="round"/></svg>',
};

/** 列表能切换的状态，和每种状态能做的操作 */
const TABS: { status: BankStatus; name: string; note: string }[] = [
  {
    status: 'review',
    name: '待看原文',
    note: '题库里标着“拿不准”或还没核对的句子。原文没问题就确认，有错就改，不合适就不要。',
  },
  { status: 'rejected', name: '不要', note: '标注没通过校验、模型说拆不了，或者你点了不要的。可以改原文或重新标注。' },
  { status: 'raw', name: '待标注', note: '等着标注的句子。' },
  { status: 'ready', name: '可以抽', note: '标注好的句子，账户选了题库出题时会抽到。' },
  { status: 'retired', name: '已下架', note: '最近一次导入的文件里已经没有的句子，不会被抽到。' },
];
const ACTIONS: Record<BankStatus, { act: string; name: string }[]> = {
  review: [
    { act: 'confirm', name: '原文没问题' },
    { act: 'edit', name: '改原文' },
    { act: 'reject', name: '不要' },
  ],
  raw: [
    { act: 'edit', name: '改原文' },
    { act: 'reject', name: '不要' },
  ],
  rejected: [
    { act: 'requeue', name: '重新标注' },
    { act: 'edit', name: '改原文' },
  ],
  ready: [
    { act: 'requeue', name: '重新标注' },
    { act: 'reject', name: '不要' },
  ],
  retired: [],
};

/** root：页面容器。onBack：点“← 设置”。onChange：数据变了（设置主页入口上的摘要跟着变） */
export function createExamBank({
  root,
  toast,
  onBack,
  onChange,
}: {
  root: HTMLElement;
  toast?: Toast;
  onBack?: () => void;
  onChange?: () => void;
}) {
  let data: BankAdmin | null = null;
  let err = '';
  let tab: BankStatus = 'review';
  let items: BankItem[] = [];
  let total = 0;
  let listBusy = false;
  let editing: number | null = null; // 正在改原文的那一句
  let limit = 20;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** 读取各状态句数和标注进度；返回有没有变化 */
  async function load(): Promise<boolean> {
    try {
      const next = await api.bank();
      const changed = !data || JSON.stringify(next) !== JSON.stringify(data);
      data = next;
      err = '';
      return changed;
    } catch (e) {
      if (data) return false;
      const msg = (e as Error).message;
      const changed = err !== msg;
      err = msg;
      return changed;
    }
  }

  async function loadItems(more = false): Promise<void> {
    listBusy = true;
    renderList();
    try {
      const r = await api.bankItems(tab, more ? items.length : 0);
      items = more ? [...items, ...r.items] : r.items;
      total = r.total;
    } catch (e) {
      toast?.(`读取句子失败：${(e as Error).message}`);
    } finally {
      listBusy = false;
      renderList();
    }
  }

  /** 设置主页入口上的摘要 */
  function summary(): { ready: number; todo: number; running: boolean } | null {
    const b = data?.banks[0];
    if (!data || !b) return null;
    return { ready: b.counts.ready, todo: b.counts.review + b.counts.raw, running: Boolean(data.job?.running) };
  }

  function headerHTML(): string {
    return `<header class="flex items-center gap-2.5">
      <button type="button" data-act="back" class="inline-flex flex-none cursor-pointer items-center gap-1 rounded-full border-[1.5px] border-line bg-sheet py-1.5 pr-3.5 pl-2.5 text-[13.5px] transition-transform active:scale-[.97]">${ICON.back}设置</button>
      <h2 class="m-0 min-w-0 truncate font-head text-[20px] font-bold leading-tight">真题题库</h2>
    </header>`;
  }

  function jobHTML(job: BankJob | null): string {
    if (!job) return '';
    if (job.running) {
      return `<div class="flex items-center gap-2 text-[13.5px]" role="status"><span class="${C.spin}"></span>正在标注 ${job.done}/${job.total} 句：可以抽 ${job.ready}，不要 ${job.rejected}${job.failed ? `，出错 ${job.failed}` : ''}</div>`;
    }
    const line = `上一批（${esc(fmtTime(job.finishedAt))}）标注了 ${job.done}/${job.total} 句：可以抽 ${job.ready}，不要 ${job.rejected}${job.failed ? `，模型出错 ${job.failed}（留着下次再试）` : ''}`;
    return `<div class="flex flex-col gap-1 text-[13px] text-muted"><span>${line}</span>${job.error ? `<span class="text-bad">停下来的原因：${esc(job.error)}</span>` : ''}</div>`;
  }

  function bankHTML(d: BankAdmin): string {
    const b = d.banks[0];
    if (!b) {
      return `<section class="${C.card} flex flex-col gap-2 px-4 py-3.5 text-[14px] leading-[1.7]">
        <b>还没有导入题库</b>
        <span class="text-muted">把题库的 JSONL 文件传到服务器的项目目录，运行：</span>
        <code class="overflow-x-auto rounded-lg bg-raise px-2.5 py-2 font-mono text-[12px] whitespace-nowrap">sudo docker compose exec -T api node --experimental-strip-types scripts/import-bank.ts &lt; cet4_long_sentences.jsonl</code>
      </section>`;
    }
    const tiles = TABS.map(
      (t) =>
        `<div class="flex min-w-0 flex-col gap-0.5 ${C.card} px-3 py-2.5"><span class="text-[12px] text-muted">${t.name}</span><b class="font-mono text-[20px] font-medium tabular-nums">${b.counts[t.status]}</b></div>`,
    ).join('');
    const running = Boolean(d.job?.running);
    return `<section class="${C.card} flex flex-col gap-3 px-4 py-3.5">
        <div class="flex flex-wrap items-center gap-2">
          <b class="text-[15px]">${esc(b.name)}</b>
          <span class="rounded-full px-2 py-0.5 text-[12px] ${b.enabled ? 'bg-accent-soft text-accent' : 'bg-raise text-muted'}">${b.enabled ? '启用中' : '已停用'}</span>
          <button type="button" data-act="toggleBank" data-bank="${esc(b.id)}" data-on="${b.enabled ? '0' : '1'}" class="${C.btn} ml-auto">${b.enabled ? '停用' : '启用'}</button>
        </div>
        <span class="text-[12.5px] text-muted">${b.importedAt ? `最近导入：${esc(fmtTime(b.importedAt))}。` : ''}停用后账户不会再抽到这个题库的句子，已经抽走的不受影响。</span>
        <div class="grid grid-cols-3 gap-2 sm:grid-cols-5">${tiles}</div>
      </section>
      <section class="${C.card} flex flex-col gap-2.5 px-4 py-3.5" aria-label="标注">
        <span class="${C.label}">标注</span>
        <p class="m-0 text-[13px] leading-[1.7] text-muted">用你在“设置”里配的国内模型把“待标注”的句子拆解成题（不用 ChatGPT：标注结果所有账户都会用到）。拆解要过和 AI 出题一样的校验，片段拼回去要和原句一致，过不了的放进“不要”。用掉的 token 记在你名下的“标注题库”。</p>
        ${d.llmReady ? '' : '<p class="m-0 rounded-xl bg-bad-soft px-3 py-2 text-[13.5px]">还没配置国内模型，先在设置页的“模型设置”里配好。</p>'}
        <div class="flex flex-wrap items-center gap-2">
          <label class="flex items-center gap-2 text-[14px] whitespace-nowrap">这次标注
            <input data-limit type="number" min="1" max="2000" value="${limit}" class="${C.input} w-24" ${running ? 'disabled' : ''} /> 句</label>
          <button type="button" data-act="annotate" class="${C.btnPrimary}" ${running || !d.llmReady || !b.counts.raw ? 'disabled' : ''}>开始标注</button>
        </div>
        ${jobHTML(d.job)}
      </section>`;
  }

  function itemHTML(it: BankItem): string {
    const text = it.textFix ?? it.text;
    const edit =
      editing === it.id
        ? `<div class="flex flex-col gap-2"><textarea data-edit rows="4" class="${C.input} font-en text-[14.5px] leading-[1.6]">${esc(text)}</textarea>
          <div class="flex gap-2"><button type="button" data-act="save" data-id="${it.id}" class="${C.btnPrimary}">保存并重新标注</button><button type="button" data-act="cancel" class="${C.btn}">取消</button></div></div>`
        : `<p class="m-0 font-en text-[15px] leading-[1.6]">${esc(text)}</p>`;
    const acts =
      editing === it.id
        ? ''
        : ACTIONS[it.status]
            .map(
              (a) => `<button type="button" data-act="${a.act}" data-id="${it.id}" class="${C.btn}">${a.name}</button>`,
            )
            .join('');
    return `<li class="flex flex-col gap-2 border-b border-line px-4 py-3 last:border-0">
      <div class="flex flex-wrap gap-x-2 gap-y-0.5 text-[12px] text-muted"><span>${esc(it.origin)}</span><span>题库状态 ${esc(it.srcQuality)}</span><span class="font-mono">${esc(it.externalId)}</span></div>
      ${edit}
      ${it.textFix && editing !== it.id ? `<span class="text-[12.5px] text-muted">改过原文。题库里的原文：${esc(it.text)}</span>` : ''}
      ${it.rejectReason ? `<span class="text-[13px] text-bad">${esc(it.rejectReason)}</span>` : ''}
      ${acts ? `<div class="flex flex-wrap gap-2">${acts}</div>` : ''}
    </li>`;
  }

  function listHTML(): string {
    const cur = TABS.find((t) => t.status === tab);
    const tabs = TABS.map(
      (t) =>
        `<button type="button" data-tab="${t.status}" aria-pressed="${t.status === tab}" class="cursor-pointer rounded-full px-3 py-1 text-[13.5px] whitespace-nowrap transition-colors aria-pressed:bg-accent aria-pressed:font-semibold aria-pressed:text-on-accent">${t.name}</button>`,
    ).join('');
    const body = !items.length
      ? `<p class="m-0 px-4 py-6 text-center text-[14px] text-muted">${listBusy ? '正在读取…' : '这里没有句子。'}</p>`
      : `<ul class="m-0 list-none p-0">${items.map(itemHTML).join('')}</ul>`;
    const more =
      items.length < total
        ? `<div class="px-4 pb-3"><button type="button" data-act="more" class="${C.btn}" ${listBusy ? 'disabled' : ''}>再看 50 句（还有 ${total - items.length} 句）</button></div>`
        : '';
    return `<section data-list class="${C.card} flex flex-col" aria-label="题库里的句子">
      <div class="flex overflow-x-auto rounded-t-2xl border-b border-line p-1.5" role="group" aria-label="按状态看">${tabs}</div>
      <p class="m-0 px-4 pt-3 text-[12.5px] text-muted">${cur?.note ?? ''}${total ? ` 共 ${total} 句。` : ''}</p>
      ${body}${more}
    </section>`;
  }

  function renderList(): void {
    const el = root.querySelector('[data-list]');
    if (el) el.outerHTML = listHTML();
  }

  function render(enter = false): void {
    if (err && !data) {
      root.innerHTML = `${headerHTML()}<div class="flex flex-col items-start gap-2 rounded-xl bg-bad-soft px-3.5 py-3 text-[14px]">读取题库失败：${esc(err)}
        <button type="button" data-act="retry" class="${C.btn}">重试</button></div>`;
    } else if (!data) {
      root.innerHTML = `${headerHTML()}<div class="flex items-center gap-2 text-[14px] text-muted"><span class="${C.spin}"></span>正在读取题库…</div>`;
    } else {
      root.innerHTML = `${headerHTML()}${bankHTML(data)}${data.banks.length ? listHTML() : ''}`;
    }
    if (enter) A.enter(root.children);
    poll();
  }

  /** 标注在跑的时候每 3 秒看一次进度 */
  function poll(): void {
    if (timer || !data?.job?.running) return;
    timer = setTimeout(async () => {
      timer = null;
      if (!root.isConnected || root.classList.contains('hidden')) return;
      if (await load()) {
        render();
        onChange?.();
        if (!data?.job?.running) void loadItems();
      }
      poll();
    }, 3000);
  }

  async function act(name: string, id: number, btn: HTMLButtonElement): Promise<void> {
    if (name === 'edit') {
      editing = id;
      renderList();
      root.querySelector<HTMLTextAreaElement>('[data-edit]')?.focus();
      return;
    }
    btn.disabled = true;
    try {
      if (name === 'confirm') await api.bankConfirm(id);
      else if (name === 'reject') await api.bankReject(id);
      else if (name === 'requeue') await api.bankRequeue(id);
      else if (name === 'save') {
        const text = root.querySelector<HTMLTextAreaElement>('[data-edit]')?.value.trim() ?? '';
        if (!text) {
          toast?.('原文不能是空的');
          btn.disabled = false;
          return;
        }
        await api.bankFix(id, text);
        editing = null;
      }
      // 这一句换了状态，从当前列表里拿掉；句数重新读
      items = items.filter((x) => x.id !== id);
      total = Math.max(0, total - 1);
      await load();
      render();
      onChange?.();
    } catch (e) {
      toast?.((e as Error).message);
      btn.disabled = false;
    }
  }

  root.addEventListener('click', async (e) => {
    const t = closest<HTMLButtonElement>(e, '[data-tab]');
    if (t) {
      tab = t.dataset.tab as BankStatus;
      editing = null;
      items = [];
      total = 0;
      void loadItems();
      return;
    }
    const a = closest<HTMLButtonElement>(e, '[data-act]');
    if (!a) return;
    const name = a.dataset.act ?? '';
    if (name === 'back') return onBack?.();
    if (name === 'retry') {
      err = '';
      render();
      await load();
      render(true);
      if (data) void loadItems();
      return;
    }
    if (name === 'cancel') {
      editing = null;
      renderList();
      return;
    }
    if (name === 'more') return void loadItems(true);
    if (name === 'toggleBank') {
      a.disabled = true;
      try {
        await api.setBankEnabled(a.dataset.bank ?? '', a.dataset.on === '1');
        await load();
        render();
      } catch (er) {
        toast?.((er as Error).message);
        a.disabled = false;
      }
      return;
    }
    if (name === 'annotate') {
      const n = Number(root.querySelector<HTMLInputElement>('[data-limit]')?.value);
      if (!Number.isInteger(n) || n < 1 || n > 2000) {
        toast?.('一次标注 1–2000 句');
        return;
      }
      limit = n;
      a.disabled = true;
      try {
        await api.bankAnnotate(n);
        await load();
        render();
        onChange?.();
      } catch (er) {
        toast?.((er as Error).message);
        a.disabled = false;
      }
      return;
    }
    const id = Number(a.dataset.id);
    if (id) void act(name, id, a);
  });

  /** 离开页面时调用 */
  function reset(): void {
    editing = null;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  /** 进入页面：读句数，再读当前状态的句子 */
  async function open(): Promise<void> {
    if (await load()) render();
    if (data?.banks.length) await loadItems();
  }

  return { load, render, reset, open, summary, hasData: () => Boolean(data) };
}

/** “设置”主页上的入口：可以抽的句数、还要处理的句数 */
export function bankEntryHTML(sum: { ready: number; todo: number; running: boolean } | null): string {
  const sub = !sum
    ? '四级真题阅读长难句：导入、标注、逐句处理'
    : `可以抽 ${sum.ready} 句 · 待处理 ${sum.todo} 句${sum.running ? ' · 正在标注' : ''}`;
  return `<button type="button" data-act="openBank" class="${C.card} flex w-full cursor-pointer items-center gap-3 px-4 py-3.5 text-left transition-colors hover:border-accent active:scale-[.99]">
    <span class="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-accent-soft text-accent">${ICON.book}</span>
    <span class="flex min-w-0 flex-col gap-0.5"><b class="text-[15px]">真题题库</b><span class="truncate text-[13px] text-muted">${esc(sub)}</span></span>
    <span class="ml-auto flex-none text-muted">${ICON.next}</span>
  </button>`;
}
