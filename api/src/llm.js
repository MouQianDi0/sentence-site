// 调用国内大模型。用的是 OpenAI 兼容的 /chat/completions 接口，
// DeepSeek、通义千问（兼容模式）、智谱 GLM、Kimi 等都支持这种格式。
export class LlmError extends Error {
  constructor(code, message, detail = '') {
    super(message);
    this.code = code; // not_configured | rate_limited | auth | upstream | timeout | invalid_json
    this.detail = detail;
  }
}

/** 宽松解析：整段 JSON → 代码块里的 JSON → 第一个 { 或 [ 到最后一个 } 或 ] */
export function parseJsonLoose(text) {
  const t = String(text || '').trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {}
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {}
  }
  const start = t.search(/[[{]/);
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {}
  }
  return undefined;
}

/** 关闭“深度思考”要传的参数：各平台写法不同 */
export function thinkingOffParams(baseUrl) {
  let host = '';
  try {
    host = new URL(baseUrl).hostname;
  } catch {}
  if (/dashscope/i.test(host)) return { enable_thinking: false }; // 通义千问
  return { thinking: { type: 'disabled' } }; // DeepSeek、智谱 GLM、Kimi 等
}

/** 模型没给出合法 JSON 时，判断是哪一种情况，方便提示 */
function whyNotJson(message, finish) {
  const content = String(message?.content ?? '').trim();
  const reasoning = String(message?.reasoning_content ?? message?.reasoning ?? '').trim();
  if (!content && (reasoning || finish === 'length')) return 'thinking';
  if (!content) return 'empty';
  if (finish === 'length') return 'truncated';
  return 'not_json';
}

export function createLlm(cfg, fetchImpl = globalThis.fetch) {
  const ready = () => Boolean(cfg.llm.baseUrl && cfg.llm.apiKey && cfg.llm.mainModel);
  // 不认识“关闭思考”参数的接口（返回 400），记下来以后不再传
  const noThinkingParam = new Set();

  async function post(url, body, timeoutMs) {
    try {
      return await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.llm.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs || cfg.llm.timeoutMs),
      });
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new LlmError('timeout', 'AI 模型响应超时');
      throw new LlmError('upstream', `连不上 AI 模型接口：${e?.message || e}`);
    }
  }

  async function chatJson({ prompt, model, maxTokens = 1500, temperature = 0.3, timeoutMs }) {
    if (!ready()) {
      throw new LlmError('not_configured', '还没配置 AI 模型：到网站的“设置”页填写，或者在 .env 里配置');
    }
    const url = `${cfg.llm.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const thinking = Boolean(cfg.llm.thinking);
    const body = {
      model,
      messages: [
        { role: 'system', content: '你是严谨的英语教学助手。只输出一个合法的 JSON 对象，不要输出任何其他文字。' },
        { role: 'user', content: prompt },
      ],
    };
    // 开着深度思考时，思考过程也算在 max_tokens 里，所以不限制长度，交给平台默认值
    if (!thinking) Object.assign(body, { temperature, max_tokens: maxTokens });
    if (cfg.llm.jsonMode) body.response_format = { type: 'json_object' };
    const extra = !thinking && !noThinkingParam.has(cfg.llm.baseUrl) ? thinkingOffParams(cfg.llm.baseUrl) : null;

    let res = await post(url, extra ? { ...body, ...extra } : body, timeoutMs);
    if (extra && res.status === 400) {
      // 有的平台不认识这个参数，去掉再试一次
      await res.text().catch(() => '');
      res = await post(url, body, timeoutMs);
      if (res.ok) noThinkingParam.add(cfg.llm.baseUrl);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 500);
      if (res.status === 401 || res.status === 403) throw new LlmError('auth', 'AI 模型的 API 密钥无效或没有权限', detail);
      if (res.status === 429) throw new LlmError('rate_limited', 'AI 模型请求太频繁或额度用完了', detail);
      throw new LlmError('upstream', `AI 模型接口返回错误 ${res.status}`, detail);
    }
    const data = await res.json().catch(() => null);
    const choice = data?.choices?.[0];
    const text = choice?.message?.content ?? '';
    const parsed = parseJsonLoose(text);
    if (parsed === undefined) {
      const why = whyNotJson(choice?.message, choice?.finish_reason);
      const msg = {
        thinking: 'AI 模型一直在深度思考，没给出答案',
        empty: 'AI 模型返回了空内容',
        truncated: 'AI 模型的回复太长被截断了',
        not_json: 'AI 返回的格式不对',
      }[why];
      const err = new LlmError('invalid_json', msg, String(text).slice(0, 500));
      err.why = why;
      throw err;
    }
    return {
      data: parsed,
      model: data?.model || model,
      usage: { input: data?.usage?.prompt_tokens ?? null, output: data?.usage?.completion_tokens ?? null },
    };
  }

  /** 获取平台提供的模型列表（GET /models）。有的平台不提供，会抛出错误。 */
  async function listModels() {
    if (!cfg.llm.baseUrl || !cfg.llm.apiKey) {
      throw new LlmError('not_configured', '先填写接口地址和 API 密钥');
    }
    let res;
    try {
      res = await fetchImpl(`${cfg.llm.baseUrl.replace(/\/+$/, '')}/models`, {
        headers: { Authorization: `Bearer ${cfg.llm.apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new LlmError('timeout', '获取模型列表超时');
      throw new LlmError('upstream', `连不上接口地址：${e?.message || e}`);
    }
    if (res.status === 401 || res.status === 403) throw new LlmError('auth', 'API 密钥无效或没有权限');
    if (!res.ok) throw new LlmError('upstream', `这个平台没有提供模型列表（${res.status}），请手动填写模型名`);
    const data = await res.json().catch(() => null);
    const ids = (Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [])
      .map((m) => (typeof m === 'string' ? m : m?.id))
      .filter((id) => typeof id === 'string' && id)
      .sort();
    if (!ids.length) throw new LlmError('upstream', '模型列表是空的，请手动填写模型名');
    return ids;
  }

  return { ready, chatJson, listModels };
}
