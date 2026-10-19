// “设置”页：配置国内大模型。每个平台单独保存一份配置（接口地址、API 密钥、模型、开关），
// 点平台就能切换，保存的那个平台就是正在使用的。
import type { LlmForm, LlmSettingsView, LlmTestResult, ProviderId, ProviderView, Usage } from '@sentence-site/shared';
import { api } from '../lib/api.ts';
import { closest } from '../lib/dom.ts';
import { esc } from '../lib/format.ts';
import * as A from '../lib/anim.ts';
import type { Toast } from '../lib/toast.ts';

interface Preset {
  id: ProviderId;
  name: string;
  baseUrl: string;
  main: string;
  light: string;
  models: string[];
  /** 创建 API Key 的页面（登录后才能看到） */
  keyUrl?: string;
  /** 链接上显示的平台名 */
  keySite?: string;
}

/** 表单里当前选中平台的值 */
interface Form {
  preset: ProviderId | null;
  baseUrl: string;
  apiKey: string;
  mainModel: string;
  lightModel: string;
  jsonMode: boolean;
  thinking: boolean;
}

type Busy = '' | 'models' | 'test' | 'save' | 'delete' | 'reset';
const BUSY_WORDS: Record<Exclude<Busy, ''>, string> = {
  models: '正在获取模型列表…',
  test: '正在调用模型测试连接…',
  save: '正在保存…',
  delete: '正在删除…',
  reset: '正在恢复…',
};
type Result = { kind: 'ok' | 'err'; text: string } | ({ kind: 'test' } & LlmTestResult);

// 模型名会随平台更新，这里只是起点；可以点“获取模型列表”拿到平台当前提供的。id 和后端 settings.ts 的 PROVIDERS 一致
// keyUrl：各平台创建 API Key 的页面（登录后才能看到），keySite：链接上显示的平台名
const PRESETS: Preset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    main: 'deepseek-v4-pro',
    light: 'deepseek-flash',
    models: ['deepseek-v4-pro', 'deepseek-flash'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
    keySite: 'DeepSeek 开放平台',
  },
  {
    id: 'qwen',
    name: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    main: 'qwen-plus',
    light: 'qwen-turbo',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
    keyUrl: 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key',
    keySite: '阿里云百炼',
  },
  {
    id: 'glm',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    main: 'glm-4-plus',
    light: 'glm-4-flash',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    keySite: '智谱开放平台',
  },
  {
    id: 'kimi',
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    main: 'moonshot-v1-8k',
    light: '',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k'],
    keyUrl: 'https://platform.kimi.com/console/api-keys',
    keySite: 'Kimi 开放平台',
  },
  { id: 'custom', name: '其他平台', baseUrl: '', main: '', light: '', models: [] },
];
const presetById = (id: ProviderId | null | undefined): Preset | null => PRESETS.find((p) => p.id === id) || null;
const hostOf = (u: string | undefined): string => {
  try {
    return new URL(u || '').hostname.toLowerCase();
  } catch {
    return '';
  }
};

const C = {
  card: 'rounded-2xl border border-line bg-sheet',
  label: 'font-mono text-[11px] tracking-[.1em] uppercase text-muted',
  input:
    'w-full min-w-0 rounded-xl border-[1.5px] border-line bg-sheet px-3 py-2 text-[15px] outline-none transition-colors focus:border-accent',
  btn: 'cursor-pointer rounded-full border-[1.5px] border-line bg-sheet px-4 py-2 text-[14.5px] transition-transform active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-45',
  btnPrimary:
    'cursor-pointer rounded-full border-[1.5px] border-accent bg-accent px-4 py-2 text-[14.5px] font-semibold text-on-accent transition-transform active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-45',
  spin: 'inline-block h-4 w-4 flex-none animate-spin rounded-full border-2 border-line border-t-accent',
  link: 'w-max cursor-pointer text-[13.5px] text-muted underline underline-offset-4 hover:text-ink',
  keyLink:
    'inline-flex flex-none items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-[12.5px] font-semibold text-accent transition-transform active:scale-[.97]',
};
const EXT =
  '<svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 3.5h-3v9h9v-3M9 2.5h4.5V7M13.5 2.5L7.5 8.5"/></svg>';

export function createSettingsView({
  root,
  toast,
  onSaved,
}: {
  root: HTMLElement;
  toast?: Toast;
  onSaved?: () => void;
}) {
  let cfg: LlmSettingsView | null = null; // 服务器返回的当前配置（含各平台保存的配置）
  let usage: Usage | null = null;
  let form: Form = blankForm(null); // 当前选中平台表单里的值
  let drafts: Partial<Record<ProviderId, Form>> = {}; // 各平台还没保存的修改（切换平台时暂存，离开页面就丢掉）
  let fetched: Partial<Record<ProviderId, string[]>> = {}; // 各平台获取到的模型列表
  let busy: Busy = '';
  let result: Result | null = null;
  let loadErr = '';
  let showKey = false;
  let chipTarget: 'mainModel' | 'lightModel' | null = null; // 点模型名时填进哪个输入框（最后点过的那个）
  let touched = false; // 进入页面后动过表单：后台刷新时不重画表单，免得把正在填的内容冲掉

  /** 某个平台的表单：没保存的修改 → 保存过的配置 → 平台默认值 */
  function blankForm(id: ProviderId | null): Form {
    const p = presetById(id);
    return {
      preset: id,
      baseUrl: p?.baseUrl || '',
      apiKey: '',
      mainModel: p?.main || '',
      lightModel: p?.light || '',
      jsonMode: true,
      thinking: false,
    };
  }

  function formFor(id: ProviderId | null): Form {
    const draft = id ? drafts[id] : undefined;
    if (draft) return { ...draft };
    const saved = id ? cfg?.providers?.[id] : undefined;
    if (saved) {
      return {
        preset: id,
        baseUrl: saved.baseUrl,
        apiKey: '',
        mainModel: saved.mainModel,
        lightModel: saved.lightModel,
        jsonMode: saved.jsonMode !== false,
        thinking: saved.thinking === true,
      };
    }
    return blankForm(id);
  }

  /** 读取配置和今天的用量；返回数据有没有变化（设置页据此决定要不要重新画） */
  async function load(): Promise<boolean> {
    try {
      const [c, u] = await Promise.all([api.llmSettings(), api.usage().catch(() => null)]);
      const first = !cfg;
      const changed = first || Boolean(loadErr) || JSON.stringify([c, u]) !== JSON.stringify([cfg, usage]);
      cfg = c;
      usage = u;
      loadErr = '';
      if (first || !touched) form = formFor(c.provider || null);
      return changed;
    } catch (e) {
      if (cfg) return false; // 有上次读到的数据就继续显示它
      const msg = (e as Error).message;
      const changed = loadErr !== msg;
      loadErr = msg;
      return changed;
    }
  }

  /** 每次进入设置页：丢掉上次没保存的修改，回到正在用的平台 */
  function reset(): void {
    drafts = {};
    fetched = {};
    result = null;
    chipTarget = null;
    touched = false;
    busy = '';
    if (cfg) form = formFor(cfg.provider || null);
  }

  /** 后台读到新数据：没动过表单就整张重画，动过就只更新上面的状态卡片 */
  function refresh(): void {
    if (!cfg || loadErr) return render(false);
    if (!touched && !busy) return render(false);
    const el = root.querySelector('#llmStatus');
    if (el) el.outerHTML = statusHTML();
  }

  const nameOf = (id: ProviderId | null) => presetById(id)?.name || '这个平台';
  const savedOf = (id: ProviderId | null): ProviderView | null => (id ? cfg?.providers?.[id] || null : null);
  const inUse = (id: ProviderId | null) => Boolean(id) && Boolean(cfg?.ready) && cfg?.provider === id;

  function statusHTML(): string {
    if (!cfg) return '';
    let dot = 'bg-muted';
    let title = '还没配置 AI 模型';
    let sub = '选一个平台，填好下面的信息并保存后，AI 批改、查词和出题就能用了。';
    if (cfg.keyBroken) {
      dot = 'bg-bad';
      title = `${cfg.providerName} 保存的 API 密钥读不出来了`;
      sub = '服务器的 COOKIE_SECRET 改过，请重新填写 API 密钥并保存。';
    } else if (cfg.ready) {
      dot = 'bg-ok';
      title = `已接入 ${cfg.providerName ? `${cfg.providerName} · ` : ''}${cfg.mainModel}`;
      sub = `${cfg.source === 'page' ? '使用这里保存的配置' : '使用服务器 .env 文件里的配置'}${cfg.lightModel ? ` · 查词用 ${cfg.lightModel}` : ''}`;
    }
    const u = usage
      ? `<div class="flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3 text-[13px] text-muted">
          <span>今天批改 <b class="font-mono font-medium text-ink">${usage.grades}</b> / ${usage.limits.grade}</span>
          <span>查词 <b class="font-mono font-medium text-ink">${usage.lookups}</b> / ${usage.limits.lookup}</span>
          <span>加练出题 <b class="font-mono font-medium text-ink">${usage.gens}</b> / ${usage.limits.generate}</span></div>`
      : '';
    return `<div id="llmStatus" class="${C.card} flex flex-col gap-3 px-4 py-3.5">
      <div class="flex items-start gap-3"><span class="mt-[7px] h-2.5 w-2.5 flex-none rounded-full ${dot}"></span>
        <div class="flex min-w-0 flex-col gap-0.5"><b class="text-[16px] [overflow-wrap:anywhere]">${esc(title)}</b><span class="text-[13.5px] text-muted">${esc(sub)}</span></div></div>
      ${u}</div>`;
  }

  function presetChip(p: Preset): string {
    const saved = savedOf(p.id);
    const mark = inUse(p.id)
      ? '<span class="rounded-full bg-ok px-1.5 py-px text-[10.5px] font-semibold text-on-accent">使用中</span>'
      : saved?.hasKey && !saved.keyBroken
        ? '<span class="h-1.5 w-1.5 rounded-full bg-ok" title="已保存密钥"></span>'
        : '';
    return `<button type="button" data-preset="${p.id}" aria-pressed="${form.preset === p.id}" class="inline-flex cursor-pointer items-center gap-1.5 rounded-full border-[1.5px] border-line bg-sheet px-3 py-1.5 text-[13.5px] aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:text-accent">${p.name}${mark}</button>`;
  }

  /** extra：放在标题右边的东西（比如申请密钥的链接） */
  function field(id: string, label: string, input: string, hint: string, extra = ''): string {
    const head = extra
      ? `<div class="flex flex-wrap items-center gap-x-3 gap-y-1"><label for="${id}" class="text-[14px] font-semibold">${label}</label><span class="ml-auto">${extra}</span></div>`
      : `<label for="${id}" class="text-[14px] font-semibold">${label}</label>`;
    return `<div class="flex flex-col gap-1.5">${head}${input}${hint ? `<span class="text-[12.5px] text-muted">${hint}</span>` : ''}</div>`;
  }

  /** API 密钥标题右边：去这个平台申请密钥的链接（新窗口打开） */
  function keyLinkHTML(): string {
    const p = presetById(form.preset);
    if (!p?.keyUrl) return '';
    return `<a href="${esc(p.keyUrl)}" target="_blank" rel="noopener noreferrer" class="${C.keyLink}" title="打开 ${esc(p.keySite)} 的 API Key 页面">去${esc(p.keySite)}申请 ${EXT}</a>`;
  }

  function keyHint(): string {
    const p = presetById(form.preset);
    const how = p?.keyUrl
      ? `没有密钥的话点右上角，登录${esc(p.keySite)}后创建一个 API Key，复制粘贴到这里。`.replace(
          /([\u4e00-\u9fff])([A-Za-z])|([A-Za-z])([\u4e00-\u9fff])/g,
          (_m, a?: string, b?: string, c?: string, d?: string) => (a ? `${a} ${b}` : `${c} ${d}`),
        )
      : form.preset === 'custom'
        ? '在你用的平台的控制台里创建 API Key，复制粘贴到这里。'
        : '';
    return `${how}只用于这个平台、只给你这个账户用。加密后保存在网站的数据库里，不会再发回浏览器。`;
  }

  function toggle(act: string, on: boolean, label: string, hint: string): string {
    return `<div class="flex flex-col gap-1.5"><button type="button" role="switch" aria-checked="${on}" data-act="${act}" class="group flex w-max cursor-pointer items-center gap-2.5 text-[14.5px] select-none">
        <span class="relative h-[23px] w-10 flex-none rounded-full bg-line transition-colors group-aria-checked:bg-accent"><span class="absolute top-[3px] left-[3px] h-[17px] w-[17px] rounded-full bg-sheet transition-transform group-aria-checked:translate-x-[17px]"></span></span>${label}</button>
      <span class="text-[12.5px] text-muted">${hint}</span></div>`;
  }

  function suggestions(): string[] {
    const got = form.preset ? fetched[form.preset] : undefined;
    return [...new Set([...(got || []), ...(presetById(form.preset)?.models || [])])];
  }

  /** 密钥输入框的提示：这个平台有没有保存过密钥、接口地址的域名是不是改了 */
  function keyPlaceholder(): string {
    const saved = savedOf(form.preset);
    if (saved?.hasKey && !saved.keyBroken) {
      if (hostOf(form.baseUrl) !== hostOf(saved.baseUrl)) return '接口地址换了，请重新填写这个地址的密钥';
      return `已保存 ${saved.keyHint}${saved.fromEnv ? '（.env 里的）' : ''}，不修改就留空`;
    }
    return form.preset && form.preset !== 'custom'
      ? `粘贴 ${nameOf(form.preset)} 的 API Key`
      : '粘贴平台给你的 API Key';
  }

  function resultHTML(): string {
    if (busy) {
      const words = BUSY_WORDS[busy];
      return `<div class="flex items-center gap-2 text-[14px] text-muted"><span class="${C.spin}"></span>${words}</div>`;
    }
    if (!result) return '';
    if (result.kind === 'test') {
      return `<div class="flex flex-col gap-1.5 rounded-xl px-3.5 py-3 text-[14px] ${result.ok ? 'bg-ok-soft' : 'bg-bad-soft'}">
        <b>${result.ok ? '连接成功，可以保存了' : '连接没有成功'}</b>
        ${result.results
          .map(
            (r) =>
              `<span class="flex flex-wrap gap-x-2"><span class="${r.ok ? 'text-ok' : 'text-bad'}">${r.ok ? '✓' : '✗'}</span><span class="font-mono text-[13px]">${esc(r.model)}</span><span class="text-muted">${r.ok ? `${(r.latencyMs / 1000).toFixed(1)} 秒` : esc(r.error)}</span></span>${r.sample ? `<span class="ml-5 font-mono text-[12px] text-muted [overflow-wrap:anywhere]">模型回复：${esc(r.sample)}</span>` : ''}`,
          )
          .join('')}</div>`;
    }
    return `<div class="rounded-xl px-3.5 py-3 text-[14px] ${result.kind === 'ok' ? 'bg-ok-soft' : 'bg-bad-soft'}">${esc(result.text)}</div>`;
  }

  function render(enter = false): void {
    if (loadErr) {
      root.innerHTML = `<div class="rounded-xl bg-bad-soft px-3.5 py-3 text-[14px]">读取设置失败：${esc(loadErr)}</div>`;
      return;
    }
    if (!cfg) {
      root.innerHTML = '';
      return;
    }
    const list = suggestions();
    const saved = savedOf(form.preset);
    const saveLabel =
      inUse(form.preset) && cfg.source === 'page'
        ? '保存'
        : form.preset && form.preset !== 'custom'
          ? `保存并使用 ${nameOf(form.preset)}`
          : '保存并使用';
    const links = [
      saved?.saved
        ? `<button type="button" data-act="delete" class="${C.link}">删除 ${esc(nameOf(form.preset))} 保存的配置</button>`
        : '',
      cfg.source === 'page' && cfg.envAvailable
        ? `<button type="button" data-act="reset" class="${C.link}">改回使用服务器 .env 里的配置</button>`
        : '',
    ].filter(Boolean);
    root.innerHTML = `${statusHTML()}
    <form id="llmForm" class="${C.card} flex flex-col gap-4 px-4 pt-4 pb-5" autocomplete="off">
      <div class="flex flex-col gap-2"><span class="${C.label}">选择平台</span>
        <div class="flex flex-wrap gap-1.5">${PRESETS.map(presetChip).join('')}</div>
        <span class="text-[12.5px] text-muted">每个平台的密钥和模型分开保存，点一下就能切换。绿点表示已经保存过密钥。</span></div>
      ${field('llmBaseUrl', '接口地址', `<input id="llmBaseUrl" name="baseUrl" type="url" inputmode="url" spellcheck="false" class="${C.input} font-mono text-[14px]" placeholder="https://…/v1" value="${esc(form.baseUrl)}">`, '兼容 OpenAI 格式的地址，填到 /v1 这一级。')}
      ${field('llmKey', 'API 密钥', `<div class="flex gap-2"><input id="llmKey" name="apiKey" type="${showKey ? 'text' : 'password'}" spellcheck="false" autocomplete="new-password" class="${C.input} font-mono text-[14px]" placeholder="${esc(keyPlaceholder())}" value="${esc(form.apiKey)}"><button type="button" data-act="toggleKey" class="${C.btn} flex-none px-3 text-[13px]">${showKey ? '隐藏' : '显示'}</button></div>`, keyHint(), keyLinkHTML())}
      <datalist id="llmModels">${list.map((m) => `<option value="${esc(m)}"></option>`).join('')}</datalist>
      ${field('llmMain', '主力模型', `<input id="llmMain" name="mainModel" list="llmModels" spellcheck="false" class="${C.input} font-mono text-[14px]" placeholder="例如 deepseek-v4-pro" value="${esc(form.mainModel)}">`, '用于批改译文和出题，选能力强一些的。')}
      ${field('llmLight', '轻量模型（可选）', `<input id="llmLight" name="lightModel" list="llmModels" spellcheck="false" class="${C.input} font-mono text-[14px]" placeholder="留空就用主力模型" value="${esc(form.lightModel)}">`, '用于查词，选便宜、快的。')}
      ${
        list.length
          ? `<div class="flex flex-wrap items-center gap-1.5"><span class="text-[12.5px] text-muted">可选模型（先点上面要填的输入框，再点名字）：</span>${list
              .slice(0, 24)
              .map(
                (m) =>
                  `<button type="button" data-model="${esc(m)}" class="cursor-pointer rounded-lg border border-line bg-raise px-2 py-0.5 font-mono text-[12px] hover:border-accent">${esc(m)}</button>`,
              )
              .join(
                '',
              )}${list.length > 24 ? `<span class="text-[12px] text-muted">等 ${list.length} 个，可在输入框里搜索</span>` : ''}</div>`
          : ''
      }
      ${toggle('thinking', !form.thinking, '关闭深度思考', '建议开着：批改、查词用不到深度思考，开着会慢很多、也更费钱。DeepSeek 等新模型默认会思考，开着这个开关网站会让模型直接回答。')}
      ${toggle('jsonMode', form.jsonMode, 'JSON 输出模式', '大多数平台都支持（包括 DeepSeek），建议开着。测试时如果报错提到 response_format 或 JSON，再关掉它。')}
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" data-act="models" class="${C.btn}" ${busy ? 'disabled' : ''}>获取模型列表</button>
        <button type="button" data-act="test" class="${C.btn}" ${busy ? 'disabled' : ''}>测试连接</button>
        <button type="submit" class="${C.btnPrimary}" ${busy ? 'disabled' : ''}>${esc(saveLabel)}</button>
      </div>
      <div id="llmResult">${resultHTML()}</div>
      ${links.length ? `<div class="flex flex-col gap-2.5">${links.join('')}</div>` : ''}
    </form>`;
    if (enter) A.enter(root.children);
  }

  const body = (): LlmForm => {
    const { preset, ...rest } = form;
    return { ...rest, provider: preset || undefined };
  };
  const setResult = (r: Result) => {
    result = r;
    const el = root.querySelector('#llmResult');
    if (el) {
      el.innerHTML = resultHTML();
      A.slideIn(el.firstElementChild);
    }
  };
  const setBusy = (b: Busy) => {
    busy = b;
    root
      .querySelectorAll<HTMLButtonElement>(
        '#llmForm button[data-act="models"], #llmForm button[data-act="test"], #llmForm button[type="submit"]',
      )
      .forEach((x) => (x.disabled = Boolean(b)));
    const el = root.querySelector('#llmResult');
    if (el) el.innerHTML = resultHTML();
  };

  /** 保存、删除之后：用服务器返回的配置刷新页面，停留在 id 这个平台 */
  async function refreshAfter(next: LlmSettingsView, id: ProviderId | null, text: string): Promise<void> {
    cfg = next;
    usage = await api.usage().catch(() => usage);
    if (id) delete drafts[id];
    form = formFor(id);
    busy = '';
    result = { kind: 'ok', text };
    render(false);
    onSaved?.();
  }

  async function run(kind: Exclude<Busy, ''>): Promise<void> {
    if (busy) return;
    setBusy(kind);
    const id = form.preset;
    try {
      if (kind === 'models') {
        const models = (await api.listModels(body())).models;
        if (id) fetched[id] = models;
        busy = '';
        result = { kind: 'ok', text: `获取到 ${models.length} 个模型，点下面的名字就能填进去。` };
        render(false);
        return;
      }
      if (kind === 'test') {
        const r = await api.testLlm(body());
        setBusy('');
        setResult({ kind: 'test', ...r });
        return;
      }
      if (kind === 'save') {
        const next = await api.saveLlmSettings(body());
        await refreshAfter(next, next.provider, `已保存，正在使用 ${next.providerName}，立即生效。`);
        toast?.(`已切换到 ${next.providerName}`);
        return;
      }
      if (kind === 'delete') {
        const name = nameOf(id);
        const next = await api.resetLlmSettings(id || undefined);
        await refreshAfter(
          next,
          id,
          next.ready
            ? `已删除 ${name} 保存的配置。`
            : `已删除 ${name} 保存的配置。现在没有在用的模型，选一个平台保存后 AI 功能就能用。`,
        );
        return;
      }
      if (kind === 'reset') {
        const next = await api.resetLlmSettings();
        await refreshAfter(
          next,
          next.provider || id,
          next.ready ? '已改回使用 .env 里的配置，各平台保存的配置还在。' : '已停用网页上的配置，AI 功能暂时不可用。',
        );
      }
    } catch (e) {
      busy = '';
      setBusy('');
      setResult({ kind: 'err', text: (e as Error).message });
    }
  }

  const TEXT_FIELDS = ['baseUrl', 'apiKey', 'mainModel', 'lightModel'] as const;
  type TextField = (typeof TEXT_FIELDS)[number];
  const isTextField = (n: string): n is TextField => (TEXT_FIELDS as readonly string[]).includes(n);

  root.addEventListener('input', (e) => {
    const input = e.target as HTMLInputElement;
    const n = input.name;
    if (!isTextField(n)) return;
    touched = true;
    form[n] = input.value;
    if (n === 'baseUrl') {
      const key = root.querySelector<HTMLInputElement>('#llmKey');
      if (key) key.placeholder = keyPlaceholder();
    }
  });

  root.addEventListener('focusin', (e) => {
    const id = (e.target as HTMLElement).id;
    if (id === 'llmMain') chipTarget = 'mainModel';
    else if (id === 'llmLight') chipTarget = 'lightModel';
  });

  root.addEventListener('submit', (e) => {
    e.preventDefault();
    void run('save');
  });

  root.addEventListener('click', (e) => {
    if (closest(e, '#llmForm')) touched = true;
    const p = closest(e, '[data-preset]');
    if (p) {
      const id = p.dataset.preset as ProviderId;
      if (busy || id === form.preset) return;
      if (form.preset) drafts[form.preset] = { ...form }; // 暂存没保存的修改，切回来还在
      form = formFor(id);
      chipTarget = null;
      result = null;
      render(false);
      const needsKey = !savedOf(form.preset)?.hasKey && !form.apiKey;
      const focus = form.preset === 'custom' && !form.baseUrl ? '#llmBaseUrl' : needsKey ? '#llmKey' : '';
      if (focus) root.querySelector<HTMLElement>(focus)?.focus();
      return;
    }
    const m = closest(e, '[data-model]');
    if (m) {
      // 填进最后点过的输入框；都没点过时，主力空着填主力，否则填轻量
      const target = chipTarget || (!form.mainModel ? 'mainModel' : 'lightModel');
      const model = m.dataset.model ?? '';
      form[target] = model;
      const input = root.querySelector<HTMLInputElement>(target === 'mainModel' ? '#llmMain' : '#llmLight');
      if (input) input.value = model;
      A.pop(m);
      return;
    }
    const a = closest(e, '[data-act]');
    if (!a) return;
    const act = a.dataset.act;
    if (act === 'toggleKey') {
      showKey = !showKey;
      const input = root.querySelector<HTMLInputElement>('#llmKey');
      if (input) input.type = showKey ? 'text' : 'password';
      a.textContent = showKey ? '隐藏' : '显示';
    } else if (act === 'jsonMode') {
      form.jsonMode = !form.jsonMode;
      a.setAttribute('aria-checked', String(form.jsonMode));
    } else if (act === 'thinking') {
      form.thinking = !form.thinking;
      a.setAttribute('aria-checked', String(!form.thinking));
    } else if (act === 'delete') {
      if (confirm(`删除 ${nameOf(form.preset)} 保存的接口地址、密钥和模型？`)) void run('delete');
    } else if (act === 'models' || act === 'test' || act === 'reset') {
      void run(act);
    }
  });

  return { load, reset, refresh, render, hasData: () => Boolean(cfg) };
}
