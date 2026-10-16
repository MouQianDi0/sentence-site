// ChatGPT 套餐（Sign in with ChatGPT）：只给你自己（owner）的账户用。
// 连接后，出题、改题按设置走你 ChatGPT 套餐里的额度；用不了时（没连、额度用完、出错）由 llm-route.ts 回退到国内模型。
//
// 凭据（access / refresh / ID token）用 COOKIE_SECRET 加密后存在 settings 表的 chatgpt 里。
// OpenAI 的条款要求这些凭据只能用于连接它的这个人自己的请求，所以邀请账户永远不会用到它（见 settings.ts 的 createSettingsHub）。
// 预览期的接口要求：/v1/responses 必须 stream: true、store: false，不支持 temperature、max_output_tokens 等参数，
// 只有收到 response.completed 才算成功。文档：https://developers.openai.com/siwc/token-sharing-open-source
import type { ChatgptModel, ChatgptStart, ChatgptUse, ChatgptView } from '@sentence-site/shared';
import type { AppConfig } from './config.ts';
import {
  LlmError,
  parseJsonLoose,
  SYSTEM_PROMPT,
  type ChatJsonOptions,
  type ChatJsonResult,
  type Llm,
  type NotJsonWhy,
} from './llm.ts';
import type { LlmUse, PlanSide } from './llm-route.ts';
import * as repo from './repo.ts';
import { encrypt, decrypt } from './secret.ts';
import { HttpError, type JsonBody } from './http.ts';
import { createOpenaiFetch, type OpenaiFetch } from './openai-proxy.ts';
import {
  AuthError,
  DYNAMIC_CLIENT,
  OPENAI_AUTH,
  PLAN_SCOPE,
  REDIRECT_URI,
  authorizeUrl,
  exchangeCode,
  newHostId,
  parseCallback,
  pkce,
  randomToken,
  refreshTokens,
  revokeToken,
  verifyIdToken,
  type AuthUrls,
  type Callback,
  type IdClaims,
  type TokenSet,
} from './chatgpt-auth.ts';

const KEY = 'chatgpt';
export const OPENAI_API = 'https://api.openai.com/v1';
/** 额度用完后暂停多久再试。OpenAI 不告诉什么时候恢复，到时间后先试一次，还不行就再暂停 */
export const LIMIT_PAUSE_MS = 60 * 60 * 1000;
/** 被拒绝（403，比如地区不支持）后暂停多久 */
const DENIED_PAUSE_MS = 30 * 60 * 1000;
/** 授权被拒绝（401，刷新后还是不行）后暂停多久 */
const AUTH_PAUSE_MS = 10 * 60 * 1000;
/** 点了“连接”之后多久内要把回调地址粘贴回来 */
const PENDING_TTL = 10 * 60 * 1000;
/** access token 还剩多久就提前刷新 */
const REFRESH_EARLY_MS = 2 * 60 * 1000;
/** 默认：改题、出题走 ChatGPT；查词频繁又简单，留给国内模型 */
export const DEFAULT_USE: ChatgptUse = { grade: true, generate: true, lookup: false };
const REAUTH = 'ChatGPT 授权失效了，到“设置”里重新连接';

/** settings 表里 chatgpt 这一项（token 都是密文） */
interface Stored {
  v: 1;
  /** 这台服务器的 ext_agent_host_id，生成后一直不变 */
  hostId: string;
  clientId?: string;
  sub?: string;
  email?: string;
  name?: string;
  idTokenEnc?: string;
  accessTokenEnc?: string;
  refreshTokenEnc?: string;
  expiresAt?: string;
  scopes?: string[];
  connectedAt?: string;
  status?: 'ok' | 'reauth' | 'ineligible';
  mainModel?: string;
  lightModel?: string;
  use?: Partial<ChatgptUse>;
  background?: boolean;
  pausedUntil?: string | null;
  pauseReason?: string;
  lastError?: { at: string; message: string } | null;
}

export interface ChatgptStore {
  get(): Promise<unknown>;
  put(value: Stored): Promise<void>;
}

export interface ChatgptService extends PlanSide {
  load(): Promise<void>;
  view(): ChatgptView;
  /** 生成授权链接（10 分钟内有效） */
  start(): Promise<ChatgptStart>;
  /** 粘贴回来的回调地址：换 token、校验、保存 */
  finish(callbackUrl: unknown): Promise<ChatgptView>;
  /** 选模型、用途开关、后台出题开关 */
  save(body: JsonBody): Promise<ChatgptView>;
  /** 取消暂停（额度恢复了、或者升级了套餐） */
  resume(): Promise<ChatgptView>;
  /** 到 OpenAI 吊销授权，删掉保存的凭据（模型和开关的设置保留） */
  disconnect(): Promise<{ view: ChatgptView; revoked: boolean }>;
  /** 这个 ChatGPT 账号能用的模型 */
  models(): Promise<ChatgptModel[]>;
  /** 测试连接用：不管是否暂停都会真的调用 */
  probe: Llm;
}

type Logger = Pick<Console, 'log' | 'error'> & { warn?: (...a: unknown[]) => void };
type Rec = Record<string, unknown>;
const obj = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown, max: number) =>
  String(v ?? '')
    .trim()
    .slice(0, max);
const num = (v: unknown): number | null =>
  v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
const SEP = /\r?\n\r?\n/;

/** 数据库里读出来的值整理成 Stored（只认识的字段） */
function normalize(raw: unknown): Stored {
  const r = obj(raw);
  if (!r || r.v !== 1) return { v: 1, hostId: '' };
  const s = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : undefined);
  const status = s('status');
  const use = obj(r.use);
  const lastError = obj(r.lastError);
  return {
    v: 1,
    hostId: s('hostId') || '',
    clientId: s('clientId'),
    sub: s('sub'),
    email: s('email'),
    name: s('name'),
    idTokenEnc: s('idTokenEnc'),
    accessTokenEnc: s('accessTokenEnc'),
    refreshTokenEnc: s('refreshTokenEnc'),
    expiresAt: s('expiresAt'),
    scopes: Array.isArray(r.scopes) ? (r.scopes as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    connectedAt: s('connectedAt'),
    status: status === 'ok' || status === 'reauth' || status === 'ineligible' ? status : undefined,
    mainModel: s('mainModel') || '',
    lightModel: s('lightModel') || '',
    use: use
      ? {
          grade: typeof use.grade === 'boolean' ? use.grade : undefined,
          generate: typeof use.generate === 'boolean' ? use.generate : undefined,
          lookup: typeof use.lookup === 'boolean' ? use.lookup : undefined,
        }
      : undefined,
    background: r.background === true,
    pausedUntil: s('pausedUntil') ?? null,
    pauseReason: s('pauseReason') || '',
    lastError:
      lastError && typeof lastError.message === 'string'
        ? { at: String(lastError.at || ''), message: lastError.message }
        : null,
  };
}

/** 回复里所有 output_text 拼起来（流里没收到文字增量时用） */
function outputText(resp: Rec | null): string {
  const out = Array.isArray(resp?.output) ? (resp.output as unknown[]) : [];
  const parts: string[] = [];
  for (const item of out) {
    const content = obj(item)?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content as unknown[]) {
      const o = obj(c);
      if (o?.type === 'output_text' && typeof o.text === 'string') parts.push(o.text);
    }
  }
  return parts.join('');
}

/** 流式回复读完以后的状态 */
interface StreamState {
  text: string;
  doneText: string;
  completed: Rec | null;
  incomplete: Rec | null;
  failed: { code: string; message: string } | null;
}

export function createChatgpt({
  cfg,
  fetch: fetchIn,
  store = null,
  urls = {},
  fallbackReady = () => false,
  log = console,
  now = () => Date.now(),
}: {
  cfg: Pick<AppConfig, 'cookieSecret' | 'openaiProxy' | 'llm'>;
  fetch?: OpenaiFetch;
  store?: ChatgptStore | null;
  urls?: { auth?: AuthUrls; api?: string };
  /** 国内模型配好了没有（设置页上提示用） */
  fallbackReady?: () => boolean;
  log?: Logger;
  now?: () => number;
}): ChatgptService {
  const authUrls = urls.auth || OPENAI_AUTH;
  const api = (urls.api || OPENAI_API).replace(/\/+$/, '');
  const io: ChatgptStore = store || { get: () => repo.getSetting(KEY), put: (v) => repo.putSetting(KEY, v) };

  // OPENAI_PROXY 写错了：启动时报一次错，之后每次请求都提示同一个原因
  let fetchImpl: OpenaiFetch;
  try {
    fetchImpl = fetchIn || createOpenaiFetch(cfg.openaiProxy);
  } catch (e) {
    const msg = (e as Error).message;
    log.error(`[chatgpt] ${msg}`);
    fetchImpl = () => Promise.reject(new Error(msg));
  }

  let s: Stored = { v: 1, hostId: '' };
  let jsonFormat = true; // OpenAI 不接受 text.format 时关掉，之后不再带
  let refreshing: Promise<void> | null = null;
  const pending = new Map<string, { verifier: string; nonce: string; at: number; clientId?: string }>();

  const iso = (t: number) => new Date(t).toISOString();
  const enc = (v: string) => encrypt(v, cfg.cookieSecret);
  const dec = (v: string | undefined): string | null => (v ? decrypt(v, cfg.cookieSecret) : null);

  const hasTokens = () => Boolean(s.clientId && dec(s.accessTokenEnc) && dec(s.refreshTokenEnc));
  const planGranted = () => (s.scopes || []).includes(PLAN_SCOPE);
  const paused = () => Boolean(s.pausedUntil && Date.parse(s.pausedUntil) > now());
  const connected = () => s.status === 'ok' && hasTokens();
  /** 能调用（不看是否暂停） */
  const canCall = () => connected() && planGranted() && Boolean(s.mainModel);
  const ready = () => canCall() && !paused();
  const use = (): ChatgptUse => ({
    grade: s.use?.grade ?? DEFAULT_USE.grade,
    generate: s.use?.generate ?? DEFAULT_USE.generate,
    lookup: s.use?.lookup ?? DEFAULT_USE.lookup,
  });

  function allowed(u: LlmUse): boolean {
    const set = use();
    if (u.kind === 'grade') return set.grade;
    if (u.kind === 'generate' || u.kind === 'review') return set.generate; // 谓语复核算出题的一部分
    if (u.kind === 'lookup') return set.lookup;
    return false; // 测试国内模型的连接不走 ChatGPT
  }

  async function persist(): Promise<void> {
    await io.put(s);
  }

  /** 后台状态变化（暂停、出错）写库失败不影响这次请求 */
  async function persistQuietly(): Promise<void> {
    try {
      await persist();
    } catch (e) {
      log.error('[chatgpt] 保存状态失败', (e as Error).message);
    }
  }

  function note(message: string): void {
    s.lastError = { at: iso(now()), message };
  }

  async function pause(ms: number, reason: string): Promise<void> {
    s.pausedUntil = iso(now() + ms);
    s.pauseReason = reason;
    note(reason);
    log.warn?.(`[chatgpt] ${reason}，暂停到 ${s.pausedUntil}，期间改用国内模型`);
    await persistQuietly();
  }

  function notReadyMessage(): string {
    if (s.status === 'reauth') return REAUTH;
    if (s.status === 'ineligible') return '这个 ChatGPT 账号不能用套餐额度（需要 Plus 或 Pro）';
    if (!connected()) return '还没连接 ChatGPT';
    if (!planGranted()) return '授权时没有同意“使用 ChatGPT 套餐”，请重新连接';
    if (!s.mainModel) return '还没选 ChatGPT 的模型';
    return `ChatGPT 暂停中：${s.pauseReason || '稍后再试'}`;
  }

  function applyTokens(t: TokenSet): void {
    s.accessTokenEnc = enc(t.access_token);
    if (t.refresh_token) s.refreshTokenEnc = enc(t.refresh_token);
    if (t.id_token) s.idTokenEnc = enc(t.id_token);
    s.expiresAt = iso(now() + (t.expires_in ?? 3600) * 1000);
    if (t.scope) s.scopes = t.scope.split(/\s+/).filter(Boolean);
  }

  /** refresh token 用不了了：清掉 token，保留账号和 client_id，方便重新授权时直接选同一个账号 */
  function dropTokens(reason: string): void {
    s.accessTokenEnc = undefined;
    s.refreshTokenEnc = undefined;
    s.expiresAt = undefined;
    s.status = 'reauth';
    note(reason);
  }

  async function doRefresh(): Promise<void> {
    const rt = dec(s.refreshTokenEnc);
    if (!rt || !s.clientId) {
      dropTokens('没有可用的 refresh token');
      await persistQuietly();
      throw new LlmError('auth', REAUTH);
    }
    try {
      applyTokens(await refreshTokens(fetchImpl, { clientId: s.clientId, refreshToken: rt }, authUrls));
      await persist();
    } catch (e) {
      if (e instanceof AuthError && (e.code === 'terminal' || e.code === 'invalid_client')) {
        dropTokens(e.message);
        await persistQuietly();
        log.warn?.(`[chatgpt] ${e.message}`);
        throw new LlmError('auth', REAUTH);
      }
      throw new LlmError('upstream', `刷新 ChatGPT 授权失败：${(e as Error).message}`);
    }
  }

  /** 同一时间只刷新一次（refresh token 每次都会换新的，两次同时刷新会互相作废） */
  function refresh(): Promise<void> {
    refreshing ||= doRefresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  /** 收到 401：如果用的还是当前这个 token 就刷新；已经被别的请求换掉了就直接用新的重试 */
  async function refreshAfter401(used: string): Promise<void> {
    if (dec(s.accessTokenEnc) === used) await refresh();
  }

  async function accessToken(): Promise<string> {
    const exp = s.expiresAt ? Date.parse(s.expiresAt) : 0;
    let token = dec(s.accessTokenEnc);
    if (!token || exp - now() < REFRESH_EARLY_MS) {
      await refresh();
      token = dec(s.accessTokenEnc);
    }
    if (!token) throw new LlmError('auth', REAUTH);
    return token;
  }

  async function request(path: string, init: { method?: string; body?: unknown; token: string; signal: AbortSignal }) {
    try {
      return await fetchImpl(`${api}${path}`, {
        method: init.method || 'GET',
        headers: {
          Authorization: `Bearer ${init.token}`,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          Accept: init.body === undefined ? 'application/json' : 'text/event-stream',
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: init.signal,
      });
    } catch (e) {
      const err = e as Error | undefined;
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new LlmError('timeout', 'ChatGPT 响应超时');
      throw new LlmError('upstream', `连不上 OpenAI：${err?.message || e}。检查 OPENAI_PROXY 和 Clash`);
    }
  }

  async function errorOf(res: Response): Promise<{ code: string; message: string; param: string; text: string }> {
    const text = await res.text().catch(() => '');
    let code = '';
    let message = '';
    let param = '';
    try {
      const d = obj(JSON.parse(text));
      const e = d?.error;
      if (obj(e)) {
        const o = obj(e) as Rec;
        code = String(o.code ?? o.type ?? '');
        message = String(o.message ?? '');
        param = String(o.param ?? '');
      } else if (typeof e === 'string') {
        code = e;
      } else if (typeof d?.detail === 'string') {
        message = d.detail;
      }
    } catch {
      // 不是 JSON
    }
    return { code, message, param, text: text.slice(0, 500) };
  }

  /** OpenAI 的错误转成 LlmError，顺便记下状态（暂停、需要重新授权、账号不能用套餐） */
  async function failWith(status: number, code: string, message: string, detail: string): Promise<LlmError> {
    if (code === 'subscription_sharing_usage_limit_exceeded') {
      await pause(LIMIT_PAUSE_MS, 'ChatGPT 套餐额度用完了');
      return new LlmError('rate_limited', 'ChatGPT 套餐额度用完了', detail);
    }
    if (code === 'subscription_sharing_user_not_eligible') {
      s.status = 'ineligible';
      note('这个 ChatGPT 账号不能用套餐额度（需要 Plus 或 Pro）');
      await persistQuietly();
      return new LlmError('auth', '这个 ChatGPT 账号不能用套餐额度（需要 Plus 或 Pro）', detail);
    }
    if (
      code === 'subscription_sharing_usage_unavailable' ||
      code === 'subscription_sharing_user_unavailable' ||
      status === 503
    ) {
      note('ChatGPT 暂时查不到套餐额度');
      return new LlmError('upstream', 'ChatGPT 暂时查不到套餐额度，稍后再试', detail);
    }
    if (code === 'chatpass_v2_scope_not_authorized' || code === 'chatpass_v2_invalid_authorization_context') {
      await pause(DENIED_PAUSE_MS, `ChatGPT 授权的权限不对（${code}）`);
      return new LlmError('auth', 'ChatGPT 授权的权限不对，请断开后重新连接', detail);
    }
    if (status === 401) {
      await pause(AUTH_PAUSE_MS, 'ChatGPT 拒绝了授权（401）');
      return new LlmError('auth', 'ChatGPT 拒绝了这次授权，过一会儿会再试；一直这样就重新连接', detail);
    }
    if (status === 403) {
      const why = `OpenAI 拒绝了请求（403${code ? `，${code}` : ''}）`;
      await pause(DENIED_PAUSE_MS, why);
      return new LlmError('auth', `${why}。如果是地区不支持，检查 Clash 给 openai.com 用的节点`, detail);
    }
    if (status === 429) {
      note('ChatGPT 请求太频繁');
      return new LlmError('rate_limited', 'ChatGPT 请求太频繁了', detail);
    }
    const msg = status
      ? `ChatGPT 接口返回错误 ${status}${code ? `（${code}）` : ''}${message ? `：${message.slice(0, 120)}` : ''}`
      : `ChatGPT 没完成这次回复${code ? `（${code}）` : ''}${message ? `：${message.slice(0, 120)}` : ''}`;
    note(msg);
    return new LlmError('upstream', msg, detail);
  }

  /** 读完流式回复。只有 response.completed 才算成功 */
  async function readStream(res: Response, model: string): Promise<ChatJsonResult> {
    const reader = res.body?.getReader();
    if (!reader) throw new LlmError('upstream', 'ChatGPT 没有返回内容');
    const decoder = new TextDecoder();
    const st: StreamState = { text: '', doneText: '', completed: null, incomplete: null, failed: null };
    let buf = '';

    const handle = (block: string) => {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data || data === '[DONE]') return;
      let ev: Rec | null;
      try {
        ev = obj(JSON.parse(data));
      } catch {
        return;
      }
      if (!ev) return;
      const type = String(ev.type || '');
      if (type === 'response.output_text.delta') st.text += String(ev.delta ?? '');
      else if (type === 'response.output_text.done' && typeof ev.text === 'string') st.doneText += ev.text;
      else if (type === 'response.completed') st.completed = obj(ev.response) || {};
      else if (type === 'response.incomplete') st.incomplete = obj(ev.response) || {};
      else if (type === 'response.failed') {
        const e = obj(obj(ev.response)?.error);
        st.failed = { code: String(e?.code ?? ''), message: String(e?.message ?? '') };
      } else if (type === 'error') {
        const e = obj(ev.error) || ev;
        st.failed = { code: String(e.code ?? ''), message: String(e.message ?? '') };
      }
    };

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (let m = SEP.exec(buf); m; m = SEP.exec(buf)) {
          handle(buf.slice(0, m.index));
          buf = buf.slice(m.index + m[0].length);
        }
      }
      buf += decoder.decode();
      if (buf.trim()) handle(buf);
    } catch (e) {
      // 已经收到完成信号后连接才断，不影响结果
      if (!st.completed) {
        const err = e as Error | undefined;
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError')
          throw new LlmError('timeout', 'ChatGPT 响应超时');
        throw new LlmError('upstream', `ChatGPT 的回复中途断了：${err?.message || e}`);
      }
    }

    const resp = st.completed ?? st.incomplete;
    const u = obj(resp?.usage);
    const usage = { input: num(u?.input_tokens), output: num(u?.output_tokens) };
    const answered = `chatgpt/${String(resp?.model || model)}`;
    if (st.failed) throw await failWith(0, st.failed.code, st.failed.message, st.failed.message);
    if (!resp) throw new LlmError('upstream', 'ChatGPT 的回复中途断了（没收到完成信号）');
    const text = st.text || st.doneText || outputText(resp);
    if (st.incomplete) {
      const err = new LlmError('invalid_json', 'ChatGPT 的回复太长被截断了', text.slice(0, 500));
      err.why = 'truncated';
      err.usage = usage;
      err.model = answered;
      throw err;
    }
    const parsed = parseJsonLoose(text);
    if (parsed === undefined) {
      const why: NotJsonWhy = text.trim() ? 'not_json' : 'empty';
      const err = new LlmError(
        'invalid_json',
        why === 'empty' ? 'ChatGPT 返回了空内容' : 'ChatGPT 返回的格式不对',
        text.slice(0, 500),
      );
      err.why = why;
      err.usage = usage;
      err.model = answered;
      throw err;
    }
    return { data: parsed, model: answered, usage };
  }

  async function call(opts: ChatJsonOptions, { ignorePause = false } = {}): Promise<ChatJsonResult> {
    if (!(ignorePause ? canCall() : ready())) throw new LlmError('not_configured', notReadyMessage());
    // 预览期不支持 temperature、max_output_tokens，所以 opts 里的这两个不传
    const body: Rec = {
      model: opts.model,
      instructions: SYSTEM_PROMPT,
      input: [{ role: 'user', content: opts.prompt }],
      store: false,
      stream: true,
    };
    if (jsonFormat) body.text = { format: { type: 'json_object' } };
    let refreshed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = await accessToken();
      // 推理模型比较慢：至少等 60 秒；超时覆盖整个流式回复
      const signal = AbortSignal.timeout(Math.max(opts.timeoutMs || cfg.llm.timeoutMs, 60_000));
      const res = await request('/responses', { method: 'POST', body, token, signal });
      if (res.ok) return readStream(res, opts.model);
      const err = await errorOf(res);
      if (res.status === 400 && body.text && /text|format|json/i.test(`${err.param} ${err.message}`)) {
        // 不支持 JSON 输出模式：去掉再试，以后也不带（回复本来就会宽松解析 JSON）
        jsonFormat = false;
        delete body.text;
        log.warn?.('[chatgpt] 不支持 text.format: json_object，去掉后重试');
        continue;
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await refreshAfter401(token);
        continue;
      }
      throw await failWith(res.status, err.code, err.message, err.text);
    }
    throw new LlmError('upstream', 'ChatGPT 这次请求没成功');
  }

  async function models(): Promise<ChatgptModel[]> {
    if (!connected()) throw new HttpError(400, s.status === 'reauth' ? REAUTH : '先连接 ChatGPT');
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await accessToken();
      const res = await request('/models', { token, signal: AbortSignal.timeout(20_000) });
      if (res.status === 401 && attempt === 0) {
        await res.text().catch(() => '');
        await refreshAfter401(token);
        continue;
      }
      if (!res.ok) {
        const err = await errorOf(res);
        throw new LlmError(
          'upstream',
          `取不到 ChatGPT 的模型列表（${res.status}${err.code ? `，${err.code}` : ''}）`,
          err.text,
        );
      }
      const data = obj(await res.json().catch(() => null));
      // 文档里的格式：{models: [{slug, display_name, visibility}]}；也兼容标准的 {data: [{id}]}
      const list: ChatgptModel[] = [];
      if (Array.isArray(data?.models)) {
        for (const m of data.models as unknown[]) {
          const o = obj(m);
          const slug = typeof o?.slug === 'string' ? o.slug : '';
          if (!slug || (o?.visibility !== undefined && o.visibility !== 'list')) continue;
          list.push({ slug, name: typeof o?.display_name === 'string' && o.display_name ? o.display_name : slug });
        }
      } else if (Array.isArray(data?.data)) {
        for (const m of data.data as unknown[]) {
          const id = obj(m)?.id;
          if (typeof id === 'string' && id) list.push({ slug: id, name: id });
        }
      }
      if (!list.length) throw new LlmError('upstream', 'ChatGPT 的模型列表是空的');
      return list;
    }
    throw new LlmError('auth', REAUTH);
  }

  function view(): ChatgptView {
    const status: ChatgptView['status'] = connected()
      ? 'ok'
      : s.status === 'reauth' || s.status === 'ineligible'
        ? s.status
        : 'none';
    const on = status !== 'none';
    return {
      proxy: Boolean(String(cfg.openaiProxy || '').trim()),
      status,
      email: on ? s.email || '' : '',
      name: on ? s.name || '' : '',
      planGranted: on && planGranted(),
      mainModel: s.mainModel || '',
      lightModel: s.lightModel || '',
      use: use(),
      background: s.background === true,
      pausedUntil: paused() ? s.pausedUntil || null : null,
      pauseReason: paused() ? s.pauseReason || '' : '',
      lastError: s.lastError || null,
      connectedAt: on ? s.connectedAt || null : null,
      ready: ready(),
      fallbackReady: fallbackReady(),
    };
  }

  async function load(): Promise<void> {
    s = normalize(await io.get());
  }

  async function start(): Promise<ChatgptStart> {
    // 这台服务器的编号：第一次连接时生成并保存，之后一直用同一个（没用过 ChatGPT 的话数据库里什么都不存）
    if (!s.hostId) {
      s.hostId = newHostId();
      await persist();
    }
    for (const [k, p] of pending) if (now() - p.at > PENDING_TTL) pending.delete(k);
    while (pending.size >= 5) pending.delete(pending.keys().next().value as string);
    const { verifier, challenge } = pkce();
    const state = randomToken();
    const nonce = randomToken();
    // 之前连过、授权失效了：用原来的 client_id 重新授权，ChatGPT 那边不会多出一个应用
    const reauth = Boolean(s.clientId && s.sub);
    const clientId = reauth ? s.clientId : undefined;
    pending.set(state, { verifier, nonce, at: now(), clientId });
    const url = authorizeUrl(
      {
        clientId,
        hostId: s.hostId,
        state,
        nonce,
        challenge,
        idTokenHint: reauth ? dec(s.idTokenEnc) || undefined : undefined,
        loginHint: reauth ? s.email || undefined : undefined,
      },
      authUrls,
    );
    return { url, redirectPrefix: REDIRECT_URI };
  }

  const toHttp = (e: unknown): Error => {
    if (e instanceof AuthError) {
      if (e.code === 'network') return new HttpError(502, `${e.message}。检查 OPENAI_PROXY 和 Clash`);
      return new HttpError(e.code === 'upstream' ? 502 : 400, e.message);
    }
    return e instanceof Error ? e : new Error(String(e));
  };

  async function finish(raw: unknown): Promise<ChatgptView> {
    let cb: Callback;
    try {
      cb = parseCallback(raw);
    } catch (e) {
      throw toHttp(e);
    }
    const p = pending.get(cb.state);
    pending.delete(cb.state); // 每个授权链接只能用一次
    if (!p || now() - p.at > PENDING_TTL) {
      throw new HttpError(400, '这次授权已经过期，或者不是从这里发起的。请重新点“连接 ChatGPT”');
    }
    if (cb.error) {
      throw new HttpError(
        400,
        cb.error === 'access_denied'
          ? '你在 ChatGPT 页面上取消了授权'
          : `授权没有完成：${cb.errorDescription || cb.error}`,
      );
    }
    let clientId: string;
    if (p.clientId) {
      if (cb.clientId && cb.clientId !== p.clientId) {
        throw new HttpError(400, '授权结果里的应用编号和原来的不一致。请先断开，再重新连接');
      }
      clientId = p.clientId;
    } else {
      if (!cb.clientId || cb.clientId === DYNAMIC_CLIENT) {
        throw new HttpError(400, '授权结果里没有正式的应用编号（client_id），注册没完成，请重新授权一次');
      }
      clientId = cb.clientId;
    }

    let tokens: TokenSet;
    let claims: IdClaims;
    try {
      tokens = await exchangeCode(fetchImpl, { clientId, code: cb.code, verifier: p.verifier }, authUrls);
      if (!tokens.id_token) throw new AuthError('upstream', 'OpenAI 没有返回 ID token');
      claims = await verifyIdToken(fetchImpl, tokens.id_token, { clientId, nonce: p.nonce, now: now() }, authUrls);
    } catch (e) {
      throw toHttp(e);
    }
    if (p.clientId && s.sub && claims.sub !== s.sub) {
      throw new HttpError(400, '授权的不是原来那个 ChatGPT 账号。要换账号，先点“断开”再重新连接');
    }

    const first = !s.connectedAt || s.sub !== claims.sub;
    s.clientId = clientId;
    s.sub = claims.sub;
    s.email = claims.email;
    s.name = claims.name;
    applyTokens({ ...tokens, scope: tokens.scope || cb.scope });
    if (first) s.connectedAt = iso(now());
    s.status = 'ok';
    s.pausedUntil = null;
    s.pauseReason = '';
    s.lastError = planGranted() ? null : { at: iso(now()), message: '授权时没有同意“使用 ChatGPT 套餐”' };
    await persist();
    log.log(`[chatgpt] 已连接 ${claims.email || claims.sub}${planGranted() ? '' : '（没有同意使用套餐额度）'}`);

    // 第一次连上还没选模型：自动选列表里的第一个，之后可以在设置里改
    if (!s.mainModel && planGranted()) {
      try {
        const list = await models();
        if (list[0]) {
          s.mainModel = list[0].slug;
          await persist();
        }
      } catch (e) {
        log.warn?.(`[chatgpt] 取模型列表失败：${(e as Error).message}`);
      }
    }
    return view();
  }

  async function save(body: JsonBody): Promise<ChatgptView> {
    if ('mainModel' in body) s.mainModel = str(body.mainModel, 100);
    if ('lightModel' in body) s.lightModel = str(body.lightModel, 100);
    const u = obj(body.use);
    if (u) {
      const next: Partial<ChatgptUse> = { ...s.use };
      for (const k of ['grade', 'generate', 'lookup'] as const) if (k in u) next[k] = u[k] === true;
      s.use = next;
    }
    if ('background' in body) s.background = body.background === true;
    await persist();
    return view();
  }

  async function resume(): Promise<ChatgptView> {
    s.pausedUntil = null;
    s.pauseReason = '';
    if (s.status === 'ineligible' && hasTokens()) s.status = 'ok';
    await persist();
    return view();
  }

  async function disconnect(): Promise<{ view: ChatgptView; revoked: boolean }> {
    const rt = dec(s.refreshTokenEnc);
    const revoked =
      rt && s.clientId ? await revokeToken(fetchImpl, { clientId: s.clientId, refreshToken: rt }, authUrls) : true;
    // 只留这台服务器的编号和你的模型、开关设置
    s = {
      v: 1,
      hostId: s.hostId,
      mainModel: s.mainModel,
      lightModel: s.lightModel,
      use: s.use,
      background: s.background,
    };
    await persist();
    log.log(`[chatgpt] 已断开${revoked ? '' : '（OpenAI 没有确认吊销）'}`);
    return { view: view(), revoked };
  }

  const llm: Llm = {
    ready,
    chatJson: (opts) => call(opts),
    listModels: async () => (await models()).map((m) => m.slug),
    models: () => ({ main: s.mainModel || '', light: s.lightModel || s.mainModel || '' }),
  };

  return {
    load,
    view,
    start,
    finish,
    save,
    resume,
    disconnect,
    models,
    llm,
    probe: { ...llm, ready: canCall, chatJson: (opts) => call(opts, { ignorePause: true }) },
    usable: (u: LlmUse) => ready() && allowed(u) && (!u.background || s.background === true),
  };
}
