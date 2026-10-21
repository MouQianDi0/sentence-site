// “设置”页：ChatGPT 套餐（只有你自己看得到）。用 Sign in with ChatGPT 连接后，出题、改题用你 ChatGPT 套餐的额度；
// ChatGPT 用不了时（没连、额度用完、出错）自动改用下面配的国内模型。邀请账户永远只用它们自己的模型。
// 授权最后会跳到一个打不开的 127.0.0.1 地址（OpenAI 的规定，服务器又在远端），把地址栏整段复制回来即可。
// 按 OpenAI 的界面规范：连上后显示 “Using ChatGPT plan” 和 “Manage usage”（ChatGPT 设置里的用量页）。
import type { ChatgptModel, ChatgptStart, ChatgptUse, ChatgptView, LlmTestResult } from '@sentence-site/shared';
import { api } from '../lib/api.ts';
import { closest } from '../lib/dom.ts';
import { esc, fmtTime } from '../lib/format.ts';
import { confirmDialog } from '../lib/dialog.ts';
import * as A from '../lib/anim.ts';
import type { Toast } from '../lib/toast.ts';

const MANAGE_USAGE = 'https://chatgpt.com/settings/usage';

type Busy = '' | 'start' | 'finish' | 'models' | 'test' | 'save' | 'resume' | 'disconnect';
const BUSY_WORDS: Record<Exclude<Busy, ''>, string> = {
  start: '正在生成授权链接…',
  finish: '正在连接 ChatGPT…',
  models: '正在获取模型列表…',
  test: '正在调用 ChatGPT 测试连接…',
  save: '正在保存…',
  resume: '正在恢复…',
  disconnect: '正在断开…',
};
type Result = { kind: 'ok' | 'err'; text: string } | ({ kind: 'test' } & LlmTestResult);

const C = {
  card: 'rounded-2xl border border-line bg-sheet',
  label: 'font-mono text-[11px] tracking-[.1em] uppercase text-muted',
  input:
    'w-full min-w-0 rounded-xl border-[1.5px] border-line bg-sheet px-3 py-2 text-[15px] outline-none transition-colors focus:border-accent',
  select:
    'w-full min-w-0 cursor-pointer appearance-none rounded-xl border-[1.5px] border-line bg-sheet py-2 pr-8 pl-3 font-mono text-[14px] outline-none transition-colors hover:border-accent focus:border-accent disabled:cursor-not-allowed',
  btn: 'cursor-pointer rounded-full border-[1.5px] border-line bg-sheet px-4 py-2 text-[14.5px] transition-transform active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-45',
  btnPrimary:
    'cursor-pointer rounded-full border-[1.5px] border-accent bg-accent px-4 py-2 text-[14.5px] font-semibold text-on-accent transition-transform active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-45',
  spin: 'inline-block h-4 w-4 flex-none animate-spin rounded-full border-2 border-line border-t-accent',
  link: 'w-max cursor-pointer text-[13.5px] text-muted underline underline-offset-4 hover:text-ink',
  pill: 'inline-flex flex-none items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-[12.5px] font-semibold text-accent',
};
/** 下拉框右边的箭头（和每日任务里的时间下拉框一样） */
const CHEVRON =
  '<svg class="pointer-events-none absolute top-1/2 right-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';
const EXT =
  '<svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 3.5h-3v9h9v-3M9 2.5h4.5V7M13.5 2.5L7.5 8.5"/></svg>';

const USES: { key: keyof ChatgptUse; label: string; hint: string }[] = [
  { key: 'grade', label: '改题', hint: '批改译文（开着“准确度提升”时一次改题会调用 6 次），以及记录页的 AI 学习分析' },
  { key: 'generate', label: '出题', hint: '加练、生成今日任务，以及出题后的谓语复核' },
  { key: 'lookup', label: '查词', hint: '查词频繁又简单，默认留给国内模型，省下 ChatGPT 的额度' },
];

const switchHTML = (act: string, on: boolean, label: string, hint: string, disabled = false) =>
  `<div class="flex flex-col gap-1"><button type="button" role="switch" aria-checked="${on}" data-act="${act}" ${disabled ? 'disabled' : ''} class="group flex w-max cursor-pointer items-center gap-2.5 text-[14.5px] select-none disabled:cursor-not-allowed disabled:opacity-50">
    <span class="relative h-[23px] w-10 flex-none rounded-full bg-line transition-colors group-aria-checked:bg-accent"><span class="absolute top-[3px] left-[3px] h-[17px] w-[17px] rounded-full bg-sheet transition-transform group-aria-checked:translate-x-[17px]"></span></span>${label}</button>
    <span class="text-[12.5px] text-muted">${hint}</span></div>`;

export function createChatgptSettings({ root, toast }: { root: HTMLElement; toast?: Toast }) {
  let view: ChatgptView | null = null;
  let models: ChatgptModel[] = [];
  let pending: ChatgptStart | null = null; // 点了“连接”、还没把回调地址粘贴回来
  let pasted = '';
  let busy: Busy = '';
  let result: Result | null = null;
  let loadErr = '';

  /** 读取状态；返回有没有变化（设置页据此决定要不要重新画） */
  async function load(): Promise<boolean> {
    try {
      const v = await api.chatgpt();
      const changed = !view || Boolean(loadErr) || JSON.stringify(v) !== JSON.stringify(view);
      view = v;
      loadErr = '';
      return changed;
    } catch (e) {
      if (view) return false;
      const msg = (e as Error).message;
      const changed = loadErr !== msg;
      loadErr = msg;
      return changed;
    }
  }

  /** 每次进入设置页：丢掉没完成的连接步骤和上次的提示 */
  function reset(): void {
    pending = null;
    pasted = '';
    result = null;
    busy = '';
  }

  /** 后台读到新数据：正在连接（粘贴地址）或者正忙时不重画，免得冲掉 */
  function refresh(): void {
    if (pending || busy) return;
    render(false);
  }

  function resultHTML(): string {
    if (busy) {
      return `<div class="flex items-center gap-2 text-[14px] text-muted"><span class="${C.spin}"></span>${BUSY_WORDS[busy]}</div>`;
    }
    if (!result) return '';
    if (result.kind === 'test') {
      return `<div class="flex flex-col gap-1.5 rounded-xl px-3.5 py-3 text-[14px] ${result.ok ? 'bg-ok-soft' : 'bg-bad-soft'}">
        <b>${result.ok ? 'ChatGPT 连接正常' : '连接没有成功'}</b>
        ${result.results
          .map(
            (r) =>
              `<span class="flex flex-wrap gap-x-2"><span class="${r.ok ? 'text-ok' : 'text-bad'}">${r.ok ? '✓' : '✗'}</span><span class="font-mono text-[13px]">${esc(r.model)}</span><span class="text-muted">${r.ok ? `${(r.latencyMs / 1000).toFixed(1)} 秒` : esc(r.error)}</span></span>`,
          )
          .join('')}</div>`;
    }
    return `<div class="rounded-xl px-3.5 py-3 text-[14px] [overflow-wrap:anywhere] ${result.kind === 'ok' ? 'bg-ok-soft' : 'bg-bad-soft'}">${esc(result.text)}</div>`;
  }

  /** 状态行：圆点颜色 + 一句话 */
  function statusHTML(v: ChatgptView): string {
    let dot = 'bg-muted';
    let title = '还没连接';
    let sub = '';
    if (v.status === 'ok') {
      title = `已连接 ${v.email || v.name || 'ChatGPT'}`;
      if (!v.planGranted) {
        dot = 'bg-bad';
        sub = '授权时没有同意“使用 ChatGPT 套餐”，现在用不了。断开后重新连接，在授权页上同意它。';
      } else if (v.pausedUntil) {
        dot = 'bg-mid';
        sub = `暂停到 ${fmtTime(v.pausedUntil)}：${v.pauseReason}。这段时间出题改题用国内模型，到时间会自动再试。`;
      } else if (!v.mainModel) {
        dot = 'bg-mid';
        sub = '先在下面选一个模型。';
      } else {
        dot = 'bg-ok';
        sub = `出题、改题用 ${v.mainModel}${v.lightModel && v.lightModel !== v.mainModel ? `，轻量任务用 ${v.lightModel}` : ''}。`;
      }
    } else if (v.status === 'reauth') {
      dot = 'bg-bad';
      title = `${v.email || 'ChatGPT'} 的授权失效了`;
      sub = '点“重新连接”授权一次就好（会直接选原来的账号）。这期间出题改题用国内模型。';
    } else if (v.status === 'ineligible') {
      dot = 'bg-bad';
      title = `${v.email || '这个账号'} 不能用套餐额度`;
      sub = '要 ChatGPT Plus 或 Pro 才能在别的网站里用套餐额度。升级后点“已升级，恢复使用”。';
    }
    return `<div class="flex items-start gap-3"><span class="mt-[7px] h-2.5 w-2.5 flex-none rounded-full ${dot}"></span>
      <div class="flex min-w-0 flex-col gap-0.5"><b class="text-[16px] [overflow-wrap:anywhere]">${esc(title)}</b>${sub ? `<span class="text-[13.5px] text-muted">${esc(sub)}</span>` : ''}</div></div>`;
  }

  /** 连接的第二步：打开授权页、把跳转后的地址粘贴回来 */
  function pendingHTML(p: ChatgptStart): string {
    return `<div class="flex flex-col gap-3 rounded-xl bg-raise px-3.5 py-3.5">
      <div class="flex flex-col gap-1 text-[14px]"><b>① 在 ChatGPT 授权页上登录、同意</b>
        <span class="text-[13px] text-muted">已经在新窗口打开了；没打开的话 <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer" class="text-accent underline underline-offset-4">点这里打开授权页</a>。授权页上要同意“使用 ChatGPT 套餐”，不然连上了也用不了。</span></div>
      <div class="flex flex-col gap-1.5 text-[14px]"><label for="gptCallback"><b>② 把跳转后的地址粘贴到这里</b></label>
        <span class="text-[13px] text-muted">同意后浏览器会跳到一个打不开的页面，地址以 <span class="font-mono text-[12.5px]">${esc(p.redirectPrefix)}</span> 开头，这是正常的。把地址栏里的整段地址复制下来粘贴进来（10 分钟内有效）。</span>
        <textarea id="gptCallback" rows="3" spellcheck="false" autocomplete="off" class="${C.input} resize-y font-mono text-[13px] [overflow-wrap:anywhere]" placeholder="${esc(p.redirectPrefix)}?code=…&amp;state=…">${esc(pasted)}</textarea></div>
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" data-act="finish" class="${C.btnPrimary}" ${busy ? 'disabled' : ''}>完成连接</button>
        <button type="button" data-act="cancel" class="${C.btn}" ${busy ? 'disabled' : ''}>取消</button>
      </div></div>`;
  }

  function modelOptions(current: string, allowEmpty: string): string {
    const list = [...models];
    if (current && !list.some((m) => m.slug === current)) list.unshift({ slug: current, name: current });
    const empty = allowEmpty ? `<option value="" ${current ? '' : 'selected'}>${esc(allowEmpty)}</option>` : '';
    return (
      empty +
      list
        .map(
          (m) =>
            `<option value="${esc(m.slug)}" ${m.slug === current ? 'selected' : ''}>${esc(m.name === m.slug ? m.slug : `${m.name}（${m.slug}）`)}</option>`,
        )
        .join('')
    );
  }

  /** 连上以后：模型、用途、后台出题开关、测试、断开 */
  function connectedHTML(v: ChatgptView): string {
    const off = !v.planGranted;
    const dis = busy || off ? 'disabled' : '';
    return `
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="flex flex-col gap-1.5"><label for="gptMain" class="text-[14px] font-semibold">主力模型</label>
          <div class="relative"><select id="gptMain" data-field="mainModel" class="${C.select}" ${dis}>${modelOptions(v.mainModel, v.mainModel ? '' : '选择模型')}</select>${CHEVRON}</div>
          <span class="text-[12.5px] text-muted">出题、改题用。</span></div>
        <div class="flex flex-col gap-1.5"><label for="gptLight" class="text-[14px] font-semibold">轻量模型（可选）</label>
          <div class="relative"><select id="gptLight" data-field="lightModel" class="${C.select}" ${dis}>${modelOptions(v.lightModel, '和主力模型一样')}</select>${CHEVRON}</div>
          <span class="text-[12.5px] text-muted">打开“查词”时查词用它。</span></div>
      </div>
      <div class="flex flex-col gap-2.5"><span class="${C.label}">这些地方用 ChatGPT</span>
        ${USES.map((u) => switchHTML(`use:${u.key}`, v.use[u.key], u.label, u.hint, Boolean(busy) || off)).join('')}</div>
      ${switchHTML(
        'background',
        v.background,
        '每日任务定时出题也用 ChatGPT',
        '打开表示你同意网站在你不在的时候（每天定时生成今日任务）使用你的 ChatGPT 套餐——OpenAI 要求后台调用必须经过你同意。关着时定时出题用国内模型；你手动点“生成今日任务”不受影响。',
        Boolean(busy) || off,
      )}
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" data-act="models" class="${C.btn}" ${dis}>刷新模型列表</button>
        <button type="button" data-act="test" class="${C.btn}" ${dis}>测试连接</button>
        ${v.pausedUntil ? `<button type="button" data-act="resume" class="${C.btn}" ${busy ? 'disabled' : ''}>现在就恢复</button>` : ''}
      </div>`;
  }

  function render(enter = false): void {
    if (loadErr) {
      root.innerHTML = `<div class="rounded-xl bg-bad-soft px-3.5 py-3 text-[14px]">读取 ChatGPT 设置失败：${esc(loadErr)}</div>`;
      return;
    }
    const v = view;
    if (!v) {
      root.innerHTML = '';
      return;
    }
    const on = v.status === 'ok' && v.planGranted;
    const badge = on
      ? `<span class="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1"><span class="${C.pill}">Using ChatGPT plan</span><a href="${MANAGE_USAGE}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-[12.5px] text-muted underline underline-offset-4 hover:text-ink">Manage usage ${EXT}</a></span>`
      : '';
    const warnings = [
      !v.proxy
        ? '服务器的 .env 里还没配 OPENAI_PROXY。服务器在国内时连不上 OpenAI，先按 README 里“ChatGPT 套餐”一节配好 Clash 代理。'
        : '',
      !v.fallbackReady ? '下面还没配国内模型：ChatGPT 用不了的时候就没有备用的了。' : '',
    ].filter(Boolean);
    const intro =
      v.status === 'none'
        ? `<p class="m-0 text-[14px] leading-relaxed text-muted">用你的 ChatGPT Plus / Pro 套餐额度出题、改题，不用另付 API 费用。ChatGPT 用不了时（没连、额度用完、出错）自动改用下面配的国内模型。只有你自己的账户会用到，邀请账户永远只用它们自己的模型。建议在电脑浏览器上连接。</p>`
        : '';
    const startBtn =
      v.status === 'ok'
        ? ''
        : `<button type="button" data-act="start" class="${C.btnPrimary} w-max" ${busy ? 'disabled' : ''}>${v.status === 'none' ? 'Continue with ChatGPT' : '重新连接'}</button>`;
    const links = [
      v.status === 'ineligible'
        ? `<button type="button" data-act="resume" class="${C.link}">已升级，恢复使用</button>`
        : '',
      v.status !== 'none' ? `<button type="button" data-act="disconnect" class="${C.link}">断开 ChatGPT</button>` : '',
    ].filter(Boolean);
    const lastErr =
      v.lastError && v.status !== 'none'
        ? `<span class="text-[12.5px] text-muted [overflow-wrap:anywhere]">最近一次问题（${esc(fmtTime(v.lastError.at))}）：${esc(v.lastError.message)}</span>`
        : '';
    root.innerHTML = `<section class="${C.card} flex flex-col gap-4 px-4 pt-3.5 pb-4" aria-label="ChatGPT 套餐">
      <div class="flex flex-wrap items-center gap-2"><span class="${C.label}">ChatGPT 套餐</span>${badge}</div>
      ${v.status === 'none' ? intro : statusHTML(v)}
      ${warnings.map((w) => `<div class="rounded-xl bg-mid-soft px-3.5 py-3 text-[13.5px]">${esc(w)}</div>`).join('')}
      ${pending ? pendingHTML(pending) : startBtn}
      ${v.status === 'ok' ? connectedHTML(v) : ''}
      <div id="gptResult">${resultHTML()}</div>
      ${lastErr}
      ${links.length ? `<div class="flex flex-col gap-2.5">${links.join('')}</div>` : ''}
    </section>`;
    if (enter) A.enter(root.children);
  }

  const setResult = (r: Result | null) => {
    result = r;
    const el = root.querySelector('#gptResult');
    if (el) {
      el.innerHTML = resultHTML();
      A.slideIn(el.firstElementChild);
    }
  };

  /** 开一个空白窗口（必须在点击时同步打开，不然会被拦截），拿到授权链接后再跳过去 */
  function openBlank(): Window | null {
    try {
      return window.open('', '_blank');
    } catch {
      return null;
    }
  }

  async function run(kind: Exclude<Busy, ''>, work: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = kind;
    result = null;
    render(false);
    try {
      await work();
      busy = '';
      render(false);
      const el = root.querySelector('#gptResult');
      if (el) A.slideIn(el.firstElementChild);
    } catch (e) {
      busy = '';
      result = { kind: 'err', text: (e as Error).message };
      render(false);
    }
  }

  async function save(body: Parameters<typeof api.saveChatgpt>[0], text: string): Promise<void> {
    await run('save', async () => {
      view = await api.saveChatgpt(body);
      toast?.(text);
    });
  }

  root.addEventListener('input', (e) => {
    const t = e.target as HTMLElement;
    if (t.id === 'gptCallback') pasted = (t as HTMLTextAreaElement).value;
  });

  root.addEventListener('change', (e) => {
    const t = e.target as HTMLSelectElement;
    const field = t.dataset.field;
    if (field === 'mainModel' || field === 'lightModel') {
      const body = field === 'mainModel' ? { mainModel: t.value } : { lightModel: t.value };
      void save(body, field === 'mainModel' ? `主力模型改成 ${t.value}` : '轻量模型已保存');
    }
  });

  root.addEventListener('click', (e) => {
    const a = closest(e, '[data-act]');
    if (!a || !view) return;
    const act = a.dataset.act || '';
    if (act === 'start') {
      const win = openBlank();
      void run('start', async () => {
        try {
          pending = await api.startChatgpt();
        } catch (err) {
          win?.close();
          throw err;
        }
        pasted = '';
        if (win) {
          win.opener = null;
          win.location.href = pending.url;
        }
      }).then(() => root.querySelector<HTMLElement>('#gptCallback')?.focus());
    } else if (act === 'cancel') {
      pending = null;
      pasted = '';
      render(false);
    } else if (act === 'finish') {
      const url = (root.querySelector<HTMLTextAreaElement>('#gptCallback')?.value || pasted).trim();
      if (!url) {
        setResult({ kind: 'err', text: '先把跳转后的整段地址粘贴进来' });
        return;
      }
      void run('finish', async () => {
        view = await api.finishChatgpt(url);
        pending = null;
        pasted = '';
        models = await api
          .chatgptModels()
          .then((r) => r.models)
          .catch(() => models);
        result = view.planGranted
          ? { kind: 'ok', text: `已连接 ${view.email || 'ChatGPT'}，出题改题会用你的 ChatGPT 套餐。` }
          : {
              kind: 'err',
              text: '连上了，但授权时没有同意“使用 ChatGPT 套餐”，现在用不了。断开后重新连接，在授权页上同意它。',
            };
        if (view.planGranted) toast?.('已连接 ChatGPT');
      });
    } else if (act === 'models') {
      void run('models', async () => {
        models = (await api.chatgptModels()).models;
        result = { kind: 'ok', text: `获取到 ${models.length} 个模型。` };
      });
    } else if (act === 'test') {
      void run('test', async () => {
        const r = await api.testChatgpt();
        result = { kind: 'test', ...r };
        if (r.ok) view = await api.chatgpt();
      });
    } else if (act === 'resume') {
      void run('resume', async () => {
        view = await api.resumeChatgpt();
        result = { kind: 'ok', text: '已恢复，下一次出题改题会先用 ChatGPT。' };
      });
    } else if (act === 'disconnect') {
      void (async () => {
        const sure = await confirmDialog({
          title: '断开 ChatGPT？',
          body: '会到 OpenAI 那边吊销这次授权，并删掉保存在服务器上的凭据。之后出题改题用国内模型；模型和开关的设置会保留。',
          ok: '断开',
          danger: true,
        });
        if (!sure) return;
        await run('disconnect', async () => {
          const r = await api.disconnectChatgpt();
          view = r.view;
          models = [];
          result = r.revoked
            ? { kind: 'ok', text: '已断开。' }
            : {
                kind: 'err',
                text: '已删掉服务器上的凭据，但 OpenAI 那边没有确认吊销。可以到 ChatGPT 设置里手动断开这个应用。',
              };
        });
      })();
    } else if (act === 'background') {
      void save(
        { background: !view.background },
        view.background ? '定时出题不再使用 ChatGPT' : '定时出题也会用 ChatGPT',
      );
    } else if (act.startsWith('use:')) {
      const key = act.slice(4) as keyof ChatgptUse;
      const next = !view.use[key];
      const label = USES.find((u) => u.key === key)?.label || '';
      const use: Partial<ChatgptUse> = { [key]: next };
      void save({ use }, `${label}${next ? '改用 ChatGPT' : '改用国内模型'}`);
    }
  });

  /** 第一次显示连接好的卡片时顺便取一次模型列表（下拉框里要有选项） */
  async function ensureModels(): Promise<void> {
    if (models.length || view?.status !== 'ok' || !view.planGranted) return;
    try {
      models = (await api.chatgptModels()).models;
      if (!busy && !pending) render(false);
    } catch {
      // 取不到就只显示当前选的模型
    }
  }

  return {
    load,
    reset,
    refresh,
    render: (enter = false) => {
      render(enter);
      void ensureModels();
    },
    hasData: () => Boolean(view) || Boolean(loadErr),
  };
}
