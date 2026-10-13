// “设置”页：配置国内大模型（预设平台、获取模型列表、测试连接、保存后立即生效）
import { api } from './api.js';
import { esc } from './text.js';
import * as A from './anim.js';

// 模型名会随平台更新，这里只是起点；可以点“获取模型列表”拿到平台当前提供的
const PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', main: 'deepseek-v4-pro', light: 'deepseek-flash', models: ['deepseek-v4-pro', 'deepseek-flash'] },
  { id: 'qwen', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', main: 'qwen-plus', light: 'qwen-turbo', models: ['qwen-max', 'qwen-plus', 'qwen-turbo'] },
  { id: 'glm', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', main: 'glm-4-plus', light: 'glm-4-flash', models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'] },
  { id: 'kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', main: 'moonshot-v1-8k', light: '', models: ['moonshot-v1-8k', 'moonshot-v1-32k'] },
  { id: 'custom', name: '其他平台', baseUrl: '', main: '', light: '', models: [] },
];
const presetFor = (url) => PRESETS.find((p) => p.baseUrl && url && url.replace(/\/+$/, '') === p.baseUrl) || (url ? PRESETS.at(-1) : null);

const C = {
  card: 'rounded-2xl border border-line bg-sheet',
  label: 'font-mono text-[11px] tracking-[.1em] uppercase text-muted',
  input: 'w-full min-w-0 rounded-xl border-[1.5px] border-line bg-sheet px-3 py-2 text-[15px] outline-none transition-colors focus:border-accent',
  btn: 'cursor-pointer rounded-full border-[1.5px] border-line bg-sheet px-4 py-2 text-[14.5px] transition-transform active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-45',
  btnPrimary: 'cursor-pointer rounded-full border-[1.5px] border-accent bg-accent px-4 py-2 text-[14.5px] font-semibold text-on-accent transition-transform active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-45',
  spin: 'inline-block h-4 w-4 flex-none animate-spin rounded-full border-2 border-line border-t-accent',
};

export function createSettingsView({ root, toast, onSaved }) {
  let cfg = null; // 服务器返回的当前配置
  let usage = null;
  let form = null; // 表单里正在编辑的值
  let fetched = []; // 获取到的模型列表
  let busy = ''; // models | test | save | reset
  let result = null; // { kind: 'ok' | 'err' | 'test', ... }
  let loadErr = '';
  let showKey = false;
  let chipTarget = null; // 点模型名时填进哪个输入框（最后点过的那个）

  async function open() {
    loadErr = '';
    try {
      [cfg, usage] = await Promise.all([api.llmSettings(), api.usage().catch(() => null)]);
      form = {
        preset: presetFor(cfg.baseUrl)?.id || null,
        baseUrl: cfg.baseUrl || '',
        apiKey: '',
        mainModel: cfg.mainModel || '',
        lightModel: cfg.lightModel || '',
        jsonMode: cfg.jsonMode !== false,
        thinking: cfg.thinking === true,
      };
      fetched = [];
      chipTarget = null;
      result = null;
    } catch (e) {
      loadErr = e.message;
    }
    render(true);
  }

  function statusHTML() {
    let dot = 'bg-muted';
    let title = '还没配置 AI 模型';
    let sub = '填好下面的信息并保存后，AI 批改、查词和出题就能用了。';
    if (cfg.keyBroken) {
      dot = 'bg-bad';
      title = '保存的 API 密钥读不出来了';
      sub = '服务器的 COOKIE_SECRET 改过，请重新填写 API 密钥并保存。';
    } else if (cfg.ready) {
      dot = 'bg-ok';
      title = `已接入 ${cfg.mainModel}`;
      sub = `${cfg.source === 'page' ? '使用这里保存的配置' : '使用服务器 .env 文件里的配置'}${cfg.lightModel ? ` · 查词用 ${cfg.lightModel}` : ''}`;
    }
    const u = usage
      ? `<div class="flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3 text-[13px] text-muted">
          <span>今天批改 <b class="font-mono font-medium text-ink">${usage.grades}</b> / ${usage.limits.grade}</span>
          <span>查词 <b class="font-mono font-medium text-ink">${usage.lookups}</b> / ${usage.limits.lookup}</span>
          <span>手动出题 <b class="font-mono font-medium text-ink">${usage.gens}</b> / ${usage.limits.generate}</span></div>`
      : '';
    return `<div class="${C.card} flex flex-col gap-3 px-4 py-3.5">
      <div class="flex items-start gap-3"><span class="mt-[7px] h-2.5 w-2.5 flex-none rounded-full ${dot}"></span>
        <div class="flex min-w-0 flex-col gap-0.5"><b class="text-[16px] [overflow-wrap:anywhere]">${esc(title)}</b><span class="text-[13.5px] text-muted">${esc(sub)}</span></div></div>
      ${u}</div>`;
  }

  function field(id, label, input, hint) {
    return `<div class="flex flex-col gap-1.5"><label for="${id}" class="text-[14px] font-semibold">${label}</label>${input}${hint ? `<span class="text-[12.5px] text-muted">${hint}</span>` : ''}</div>`;
  }

  function toggle(act, on, label, hint) {
    return `<div class="flex flex-col gap-1.5"><button type="button" role="switch" aria-checked="${on}" data-act="${act}" class="group flex w-max cursor-pointer items-center gap-2.5 text-[14.5px] select-none">
        <span class="relative h-[23px] w-10 flex-none rounded-full bg-line transition-colors group-aria-checked:bg-accent"><span class="absolute top-[3px] left-[3px] h-[17px] w-[17px] rounded-full bg-sheet transition-transform group-aria-checked:translate-x-[17px]"></span></span>${label}</button>
      <span class="text-[12.5px] text-muted">${hint}</span></div>`;
  }

  function suggestions() {
    const preset = PRESETS.find((p) => p.id === form.preset);
    return [...new Set([...(fetched || []), ...(preset?.models || [])])];
  }

  function resultHTML() {
    if (busy) {
      const words = { models: '正在获取模型列表…', test: '正在调用模型测试连接…', save: '正在保存…', reset: '正在恢复…' }[busy];
      return `<div class="flex items-center gap-2 text-[14px] text-muted"><span class="${C.spin}"></span>${words}</div>`;
    }
    if (!result) return '';
    if (result.kind === 'test') {
      return `<div class="flex flex-col gap-1.5 rounded-xl px-3.5 py-3 text-[14px] ${result.ok ? 'bg-ok-soft' : 'bg-bad-soft'}">
        <b>${result.ok ? '连接成功，可以保存了' : '连接没有成功'}</b>
        ${result.results.map((r) => `<span class="flex flex-wrap gap-x-2"><span class="${r.ok ? 'text-ok' : 'text-bad'}">${r.ok ? '✓' : '✗'}</span><span class="font-mono text-[13px]">${esc(r.model)}</span><span class="text-muted">${r.ok ? `${(r.latencyMs / 1000).toFixed(1)} 秒` : esc(r.error)}</span></span>${r.sample ? `<span class="ml-5 font-mono text-[12px] text-muted [overflow-wrap:anywhere]">模型回复：${esc(r.sample)}</span>` : ''}`).join('')}</div>`;
    }
    return `<div class="rounded-xl px-3.5 py-3 text-[14px] ${result.kind === 'ok' ? 'bg-ok-soft' : 'bg-bad-soft'}">${esc(result.text)}</div>`;
  }

  function render(enter) {
    if (loadErr) {
      root.innerHTML = `<div class="rounded-xl bg-bad-soft px-3.5 py-3 text-[14px]">读取设置失败：${esc(loadErr)}</div>`;
      return;
    }
    if (!cfg) {
      root.innerHTML = `<div class="flex items-center gap-2 text-[14px] text-muted"><span class="${C.spin}"></span>正在读取设置…</div>`;
      return;
    }
    const keyPlaceholder = cfg.hasKey && !cfg.keyBroken ? `已保存 ${cfg.keyHint}，不修改就留空` : '粘贴平台给你的 API Key';
    const list = suggestions();
    root.innerHTML = `${statusHTML()}
    <form id="llmForm" class="${C.card} flex flex-col gap-4 px-4 pt-4 pb-5" autocomplete="off">
      <div class="flex flex-col gap-2"><span class="${C.label}">选择平台</span>
        <div class="flex flex-wrap gap-1.5">${PRESETS.map((p) => `<button type="button" data-preset="${p.id}" aria-pressed="${form.preset === p.id}" class="cursor-pointer rounded-full border-[1.5px] border-line bg-sheet px-3 py-1.5 text-[13.5px] aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:text-accent">${p.name}</button>`).join('')}</div>
        <span class="text-[12.5px] text-muted">选平台会自动填好接口地址和常用模型。模型名会随平台更新，可以点“获取模型列表”看平台当前提供哪些。</span></div>
      ${field('llmBaseUrl', '接口地址', `<input id="llmBaseUrl" name="baseUrl" type="url" inputmode="url" spellcheck="false" class="${C.input} font-mono text-[14px]" placeholder="https://…/v1" value="${esc(form.baseUrl)}">`, '兼容 OpenAI 格式的地址，填到 /v1 这一级。')}
      ${field('llmKey', 'API 密钥', `<div class="flex gap-2"><input id="llmKey" name="apiKey" type="${showKey ? 'text' : 'password'}" spellcheck="false" autocomplete="new-password" class="${C.input} font-mono text-[14px]" placeholder="${esc(keyPlaceholder)}" value="${esc(form.apiKey)}"><button type="button" data-act="toggleKey" class="${C.btn} flex-none px-3 text-[13px]">${showKey ? '隐藏' : '显示'}</button></div>`, '密钥加密后保存在你服务器的数据库里，不会再发回浏览器。')}
      <datalist id="llmModels">${list.map((m) => `<option value="${esc(m)}"></option>`).join('')}</datalist>
      ${field('llmMain', '主力模型', `<input id="llmMain" name="mainModel" list="llmModels" spellcheck="false" class="${C.input} font-mono text-[14px]" placeholder="例如 deepseek-v4-pro" value="${esc(form.mainModel)}">`, '用于批改译文和出题，选能力强一些的。')}
      ${field('llmLight', '轻量模型（可选）', `<input id="llmLight" name="lightModel" list="llmModels" spellcheck="false" class="${C.input} font-mono text-[14px]" placeholder="留空就用主力模型" value="${esc(form.lightModel)}">`, '用于查词，选便宜、快的。')}
      ${list.length ? `<div class="flex flex-wrap items-center gap-1.5"><span class="text-[12.5px] text-muted">可选模型（先点上面要填的输入框，再点名字）：</span>${list.slice(0, 24).map((m) => `<button type="button" data-model="${esc(m)}" class="cursor-pointer rounded-lg border border-line bg-raise px-2 py-0.5 font-mono text-[12px] hover:border-accent">${esc(m)}</button>`).join('')}${list.length > 24 ? `<span class="text-[12px] text-muted">等 ${list.length} 个，可在输入框里搜索</span>` : ''}</div>` : ''}
      ${toggle('thinking', !form.thinking, '关闭深度思考', '建议开着：批改、查词用不到深度思考，开着会慢很多、也更费钱。DeepSeek 等新模型默认会思考，开着这个开关网站会让模型直接回答。')}
      ${toggle('jsonMode', form.jsonMode, 'JSON 输出模式', '大多数平台都支持（包括 DeepSeek），建议开着。测试时如果报错提到 response_format 或 JSON，再关掉它。')}
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" data-act="models" class="${C.btn}" ${busy ? 'disabled' : ''}>获取模型列表</button>
        <button type="button" data-act="test" class="${C.btn}" ${busy ? 'disabled' : ''}>测试连接</button>
        <button type="submit" class="${C.btnPrimary}" ${busy ? 'disabled' : ''}>保存</button>
      </div>
      <div id="llmResult">${resultHTML()}</div>
      ${cfg.source === 'page' ? `<button type="button" data-act="reset" class="w-max cursor-pointer text-[13.5px] text-muted underline underline-offset-4 hover:text-ink">${cfg.envAvailable ? '改回使用服务器 .env 里的配置' : '清除这里保存的配置'}</button>` : ''}
    </form>`;
    if (enter) A.enter(root.children);
  }

  const body = () => ({ ...form, preset: undefined });
  const setResult = (r) => {
    result = r;
    const el = root.querySelector('#llmResult');
    if (el) {
      el.innerHTML = resultHTML();
      A.slideIn(el.firstElementChild);
    }
  };
  const setBusy = (b) => {
    busy = b;
    root.querySelectorAll('#llmForm button[data-act="models"], #llmForm button[data-act="test"], #llmForm button[type="submit"]').forEach((x) => (x.disabled = Boolean(b)));
    const el = root.querySelector('#llmResult');
    if (el) el.innerHTML = resultHTML();
  };

  async function run(kind) {
    if (busy) return;
    setBusy(kind);
    try {
      if (kind === 'models') {
        fetched = (await api.listModels(body())).models;
        busy = '';
        result = { kind: 'ok', text: `获取到 ${fetched.length} 个模型，点下面的名字就能填进去。` };
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
        cfg = await api.saveLlmSettings(body());
        usage = await api.usage().catch(() => usage);
        form.apiKey = '';
        busy = '';
        result = { kind: 'ok', text: '已保存，立即生效。' };
        render(false);
        toast('模型配置已保存');
        onSaved && onSaved();
        return;
      }
      if (kind === 'reset') {
        cfg = await api.resetLlmSettings();
        usage = await api.usage().catch(() => usage);
        form = { preset: presetFor(cfg.baseUrl)?.id || null, baseUrl: cfg.baseUrl || '', apiKey: '', mainModel: cfg.mainModel || '', lightModel: cfg.lightModel || '', jsonMode: cfg.jsonMode !== false, thinking: cfg.thinking === true };
        busy = '';
        result = { kind: 'ok', text: cfg.ready ? '已改回使用 .env 里的配置。' : '已清除，AI 功能暂时不可用。' };
        render(false);
        onSaved && onSaved();
      }
    } catch (e) {
      busy = '';
      setBusy('');
      setResult({ kind: 'err', text: e.message });
    }
  }

  root.addEventListener('input', (e) => {
    const n = e.target.name;
    if (!form || !n || !(n in form)) return;
    form[n] = e.target.value;
    if (n === 'baseUrl') {
      const p = presetFor(form.baseUrl);
      form.preset = p?.id || null;
      root.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === form.preset)));
    }
  });

  root.addEventListener('focusin', (e) => {
    if (e.target.id === 'llmMain') chipTarget = 'mainModel';
    else if (e.target.id === 'llmLight') chipTarget = 'lightModel';
  });

  root.addEventListener('submit', (e) => {
    e.preventDefault();
    run('save');
  });

  root.addEventListener('click', (e) => {
    const p = e.target.closest('[data-preset]');
    if (p) {
      const preset = PRESETS.find((x) => x.id === p.dataset.preset);
      form.preset = preset.id;
      if (preset.id !== 'custom') {
        form.baseUrl = preset.baseUrl;
        form.mainModel = preset.main;
        form.lightModel = preset.light;
      }
      fetched = [];
      result = null;
      render(false);
      root.querySelector(preset.id === 'custom' ? '#llmBaseUrl' : '#llmKey')?.focus();
      return;
    }
    const m = e.target.closest('[data-model]');
    if (m) {
      // 填进最后点过的输入框；都没点过时，主力空着填主力，否则填轻量
      const target = chipTarget || (!form.mainModel ? 'mainModel' : 'lightModel');
      form[target] = m.dataset.model;
      root.querySelector(target === 'mainModel' ? '#llmMain' : '#llmLight').value = m.dataset.model;
      A.pop(m);
      return;
    }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'toggleKey') {
      showKey = !showKey;
      const input = root.querySelector('#llmKey');
      input.type = showKey ? 'text' : 'password';
      a.textContent = showKey ? '隐藏' : '显示';
    } else if (a.dataset.act === 'jsonMode') {
      form.jsonMode = !form.jsonMode;
      a.setAttribute('aria-checked', String(form.jsonMode));
    } else if (a.dataset.act === 'thinking') {
      form.thinking = !form.thinking;
      a.setAttribute('aria-checked', String(!form.thinking));
    } else if (['models', 'test', 'reset'].includes(a.dataset.act)) {
      run(a.dataset.act);
    }
  });

  return { open, render };
}
