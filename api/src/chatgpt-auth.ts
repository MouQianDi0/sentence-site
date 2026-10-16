// Sign in with ChatGPT 的授权部分（开源 / 自托管应用使用 ChatGPT 套餐额度的流程）：
// 生成授权链接（PKCE + state + nonce）、解析粘贴回来的回调地址、换 token、校验 ID token、刷新、吊销。
// 文档：https://developers.openai.com/siwc/token-sharing-open-source/sign-in
//
// 回调地址必须是 127.0.0.1（OpenAI 的规定）。服务器在远端，所以浏览器最后跳到的那个页面打不开是正常的：
// 把地址栏里的整段地址复制回设置页，由服务器（通过 Clash）完成换 token，token 不会经过你的电脑。
import crypto from 'node:crypto';
import type { OpenaiFetch } from './openai-proxy.ts';

export const ISSUER = 'https://auth.openai.com';
/** 授权的资源：OpenAI 的 API */
export const API_RESOURCE = 'https://api.openai.com/v1';
/** 使用 ChatGPT 套餐额度的权限；只有 ID token、没有这个权限时不能调用模型 */
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', PLAN_SCOPE];
/** 授权完成后浏览器跳到这里（固定写法：http://127.0.0.1 + 端口 + 路径；换端口也行，但每次要一致） */
export const REDIRECT_URI = 'http://127.0.0.1:47391/auth/callback';
/** 第一次授权时用的 client_id；授权完成后 OpenAI 会发一个 oaiapp_ 开头的正式 client_id */
export const DYNAMIC_CLIENT = 'dynamic_agent_client';
/** 授权页上显示的应用名 */
export const APP_NAME = '长难句拆解台';

export interface AuthUrls {
  authorize: string;
  token: string;
  jwks: string;
  /** OpenID 配置，里面有吊销接口的地址 */
  config: string;
}

export const OPENAI_AUTH: AuthUrls = {
  authorize: `${ISSUER}/api/accounts/authorize`,
  token: `${ISSUER}/api/accounts/oauth/token`,
  jwks: `${ISSUER}/.well-known/jwks.json`,
  config: `${ISSUER}/.well-known/openid-configuration`,
};

/**
 * code：
 * - bad_callback：粘贴的地址不对
 * - denied：在 ChatGPT 页面上取消了授权
 * - terminal：refresh token 用不了了，要重新授权
 * - invalid_client：client_id 有问题
 * - id_token：ID token 校验没通过
 * - network：连不上 OpenAI（多半是代理）
 * - upstream：OpenAI 返回了别的错误
 */
export const AUTH_ERROR_CODES = [
  'bad_callback',
  'denied',
  'terminal',
  'invalid_client',
  'id_token',
  'network',
  'upstream',
] as const;
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

export class AuthError extends Error {
  code: AuthErrorCode;
  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const b64url = (b: Buffer) => b.toString('base64url');

/** PKCE：verifier 留在服务器，challenge 放进授权链接 */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(48));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}

export const randomToken = (): string => b64url(crypto.randomBytes(24));

/** 这台服务器的 ext_agent_host_id：第一次用时生成一次、一直保存（不是密钥，也不含个人信息） */
export const newHostId = (): string => `urn:uuid:${crypto.randomUUID()}`;

export interface AuthorizeParams {
  /** 已经有正式 client_id 时（重新授权）传入；第一次授权不传 */
  clientId?: string;
  hostId: string;
  state: string;
  nonce: string;
  challenge: string;
  /** 重新授权时传上次的 ID token（过期了也行），可以跳过选账号 */
  idTokenHint?: string;
  loginHint?: string;
}

/** 授权链接。注意里面可能带 ID token，不要写进日志 */
export function authorizeUrl(p: AuthorizeParams, urls: AuthUrls = OPENAI_AUTH): string {
  const first = !p.clientId;
  const q: [string, string][] = [['client_id', p.clientId || DYNAMIC_CLIENT]];
  if (first) q.push(['agent_name_hint', APP_NAME]);
  q.push(['ext_agent_host_id', p.hostId]);
  if (!first && p.idTokenHint) q.push(['id_token_hint', p.idTokenHint]);
  if (!first && p.loginHint) q.push(['login_hint', p.loginHint]);
  q.push(
    ['response_type', 'code'],
    ['redirect_uri', REDIRECT_URI],
    ['scope', SCOPES.join(' ')],
    ['resource', API_RESOURCE],
    ['state', p.state],
    ['nonce', p.nonce],
    ['code_challenge_method', 'S256'],
    ['code_challenge', p.challenge],
  );
  return `${urls.authorize}?${q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

export interface Callback {
  code: string;
  state: string;
  /** 第一次授权时 OpenAI 发的正式 client_id（oaiapp_…）；重新授权时可能没有 */
  clientId: string;
  scope: string;
  error: string;
  errorDescription: string;
}

/** 解析粘贴回来的回调地址：整段 http://127.0.0.1:…/auth/callback?code=…，或者只有 ? 后面那段 */
export function parseCallback(raw: unknown): Callback {
  const s = String(raw ?? '').trim();
  if (!s) throw new AuthError('bad_callback', '先把授权后浏览器地址栏里的整段地址粘贴进来');
  let params: URLSearchParams;
  if (/^https?:\/\//i.test(s)) {
    try {
      params = new URL(s).searchParams;
    } catch {
      throw new AuthError('bad_callback', '粘贴的不是一个完整的地址，请重新复制地址栏');
    }
  } else {
    params = new URLSearchParams(s.replace(/^[^?]*\?/, ''));
  }
  const get = (k: string) => (params.get(k) || '').trim();
  const out: Callback = {
    code: get('code'),
    state: get('state'),
    clientId: get('client_id'),
    scope: get('scope'),
    error: get('error'),
    errorDescription: get('error_description'),
  };
  if (!out.state) {
    throw new AuthError('bad_callback', '地址里没有 state。要复制的是授权完成后跳到的、127.0.0.1 开头的那个地址');
  }
  if (!out.error && !out.code) throw new AuthError('bad_callback', '地址里没有授权码（code），请重新授权一次');
  return out;
}

/** token 接口的回复 */
export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

type Json = Record<string, unknown> | null;

async function postForm(
  fetchImpl: OpenaiFetch,
  url: string,
  form: Record<string, string>,
  timeoutMs = 30_000,
): Promise<{ status: number; data: Json }> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new AuthError('network', `连不上 OpenAI 的授权服务器：${(e as Error).message}`);
  }
  const text = await res.text().catch(() => '');
  let data: Json = null;
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === 'object') data = v as Record<string, unknown>;
  } catch {
    // 不是 JSON
  }
  return { status: res.status, data };
}

/** OAuth 错误：error 可能是字符串，也可能是 {code, message} */
function oauthError(data: Json): { code: string; message: string } {
  const e = data?.error;
  if (typeof e === 'string') return { code: e, message: String(data?.error_description || e) };
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    return { code: String(o.code || o.type || ''), message: String(o.message || '') };
  }
  return { code: '', message: '' };
}

function tokenSet(data: Json): TokenSet {
  const access = data?.access_token;
  if (typeof access !== 'string' || !access) throw new AuthError('upstream', 'OpenAI 没有返回 access token');
  const opt = (k: string) => (typeof data?.[k] === 'string' && data[k] ? (data[k] as string) : undefined);
  const exp = Number(data?.expires_in);
  return {
    access_token: access,
    refresh_token: opt('refresh_token'),
    id_token: opt('id_token'),
    token_type: opt('token_type'),
    expires_in: Number.isFinite(exp) && exp > 0 ? exp : undefined,
    scope: opt('scope'),
  };
}

/** 用授权码换 token（公开客户端，没有 client secret，靠 PKCE 保证安全） */
export async function exchangeCode(
  fetchImpl: OpenaiFetch,
  p: { clientId: string; code: string; verifier: string },
  urls: AuthUrls = OPENAI_AUTH,
): Promise<TokenSet> {
  const { status, data } = await postForm(fetchImpl, urls.token, {
    grant_type: 'authorization_code',
    client_id: p.clientId,
    code: p.code,
    code_verifier: p.verifier,
    redirect_uri: REDIRECT_URI,
    resource: API_RESOURCE,
  });
  if (status >= 200 && status < 300) return tokenSet(data);
  const err = oauthError(data);
  if (err.code === 'invalid_grant') {
    throw new AuthError('terminal', '授权码已经用过或过期了，请重新点“连接 ChatGPT”授权一次');
  }
  throw new AuthError(
    'upstream',
    `换取 token 失败（${status}${err.code ? `，${err.code}` : ''}）${err.message ? `：${err.message}` : ''}`,
  );
}

/** refresh token 用不了了（要重新授权）的错误码 */
const TERMINAL = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

/** 刷新 token。refresh token 每次都会换新的，调用方要把新的存下来 */
export async function refreshTokens(
  fetchImpl: OpenaiFetch,
  p: { clientId: string; refreshToken: string },
  urls: AuthUrls = OPENAI_AUTH,
): Promise<TokenSet> {
  const { status, data } = await postForm(fetchImpl, urls.token, {
    grant_type: 'refresh_token',
    client_id: p.clientId,
    refresh_token: p.refreshToken,
    resource: API_RESOURCE,
  });
  if (status >= 200 && status < 300) return tokenSet(data);
  const err = oauthError(data);
  if (TERMINAL.has(err.code)) throw new AuthError('terminal', `ChatGPT 授权已失效（${err.code}），请重新连接`);
  if (err.code === 'invalid_client')
    throw new AuthError('invalid_client', 'ChatGPT 授权的 client_id 无效，请断开后重新连接');
  throw new AuthError(
    status >= 500 ? 'network' : 'upstream',
    `刷新 ChatGPT 授权失败（${status}${err.code ? `，${err.code}` : ''}）`,
  );
}

/** 断开时到 OpenAI 吊销 refresh token。返回 OpenAI 是否确认（200 空回复也算成功） */
export async function revokeToken(
  fetchImpl: OpenaiFetch,
  p: { clientId: string; refreshToken: string },
  urls: AuthUrls = OPENAI_AUTH,
): Promise<boolean> {
  let endpoint = '';
  try {
    const res = await fetchImpl(urls.config, { signal: AbortSignal.timeout(15_000) });
    const cfg = (await res.json()) as { revocation_endpoint?: unknown };
    endpoint = typeof cfg.revocation_endpoint === 'string' ? cfg.revocation_endpoint : '';
  } catch {
    return false;
  }
  if (!endpoint) return false;
  for (let i = 0; i < 3; i++) {
    try {
      const { status } = await postForm(
        fetchImpl,
        endpoint,
        { token: p.refreshToken, token_type_hint: 'refresh_token', client_id: p.clientId },
        15_000,
      );
      if (status >= 200 && status < 300) return true;
      if (status < 500) return false;
    } catch {
      // 网络问题：稍等再试
    }
    await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  return false;
}

// ---- ID token 校验 ---------------------------------------------------------------

export interface IdClaims {
  sub: string;
  email: string;
  name: string;
}

/** OpenAI 公布的公钥（JWK），只用到 kid 和交给 createPublicKey 的字段 */
type Jwk = Record<string, unknown> & { kid?: unknown };

const jwksCache = new Map<string, { at: number; keys: Jwk[] }>();
const JWKS_TTL = 60 * 60 * 1000;

async function jwks(fetchImpl: OpenaiFetch, url: string, force: boolean): Promise<Jwk[]> {
  const hit = jwksCache.get(url);
  if (hit && !force && Date.now() - hit.at < JWKS_TTL) return hit.keys;
  let keys: unknown;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    keys = ((await res.json()) as { keys?: unknown }).keys;
  } catch (e) {
    throw new AuthError('network', `取不到 OpenAI 的公钥：${(e as Error).message}`);
  }
  if (!Array.isArray(keys)) throw new AuthError('upstream', 'OpenAI 的公钥列表格式不对');
  const list = (keys as unknown[]).filter((k): k is Jwk => Boolean(k && typeof k === 'object'));
  jwksCache.set(url, { at: Date.now(), keys: list });
  return list;
}

const decodePart = (s: string): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (v && typeof v === 'object') return v as Record<string, unknown>;
  } catch {
    // 下面统一报错
  }
  throw new AuthError('id_token', 'ID token 格式不对');
};

/** 校验签名（OpenAI 公布的公钥）、签发方、受众（必须是这次的 client_id）、过期时间、nonce */
export async function verifyIdToken(
  fetchImpl: OpenaiFetch,
  token: string,
  expect: { clientId: string; nonce: string; now?: number },
  urls: AuthUrls = OPENAI_AUTH,
): Promise<IdClaims> {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new AuthError('id_token', 'OpenAI 没有返回合法的 ID token');
  const [h = '', p = '', sig = ''] = parts;
  const header = decodePart(h);
  const claims = decodePart(p);
  const alg = String(header.alg || '');
  if (alg !== 'RS256' && alg !== 'ES256') throw new AuthError('id_token', `不支持的 ID token 签名算法：${alg || '无'}`);

  let keys = await jwks(fetchImpl, urls.jwks, false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    // 公钥轮换了：强制重新取一次
    keys = await jwks(fetchImpl, urls.jwks, true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new AuthError('id_token', '找不到签发 ID token 的公钥');

  let ok = false;
  try {
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' } as Parameters<typeof crypto.createPublicKey>[0]);
    const data = Buffer.from(`${h}.${p}`);
    const signature = Buffer.from(sig, 'base64url');
    ok =
      alg === 'RS256'
        ? crypto.verify('RSA-SHA256', data, key, signature)
        : crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    ok = false;
  }
  if (!ok) throw new AuthError('id_token', 'ID token 签名校验没通过');

  const now = expect.now ?? Date.now();
  if (claims.iss !== ISSUER) throw new AuthError('id_token', 'ID token 的签发方不对');
  const aud = Array.isArray(claims.aud) ? (claims.aud as unknown[]) : [claims.aud];
  if (!aud.includes(expect.clientId)) throw new AuthError('id_token', 'ID token 不是发给这个应用的');
  if (!(Number(claims.exp) * 1000 > now - 60_000)) throw new AuthError('id_token', 'ID token 已经过期了，请重新授权');
  if (claims.nonce !== expect.nonce) throw new AuthError('id_token', 'ID token 的 nonce 对不上，请重新授权');
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  if (!sub) throw new AuthError('id_token', 'ID token 里没有账号编号');
  return {
    sub,
    email: typeof claims.email === 'string' ? claims.email : '',
    name: typeof claims.name === 'string' ? claims.name : '',
  };
}

/** 测试用：清掉公钥缓存 */
export const clearJwksCache = (): void => jwksCache.clear();
