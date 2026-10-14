// 模型配置：每个平台单独保存一份（接口地址、API 密钥、模型、开关），其中一个是“正在使用”的。
// 网页上保存的优先；没有选用任何平台时，用 .env 里的配置。保存后立即生效，不用重启。
// 每个账户各有一份：你自己的存在 settings 表、可以退回 .env；邀请账户的存在 accounts.llm、没有 .env 可用（见 createSettingsHub）。
import * as repo from './repo.js';
import { encrypt, decrypt, maskKey } from './secret.js';
import { HttpError } from './http.js';

const KEY = 'llm';
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const envReady = (l) => Boolean(l.baseUrl && l.apiKey && l.mainModel);

/** 平台和它的接口域名；接口地址的域名决定配置属于哪个平台，其他域名都算“其他平台” */
export const PROVIDERS = {
  deepseek: { name: 'DeepSeek', host: 'api.deepseek.com', baseUrl: 'https://api.deepseek.com/v1' },
  qwen: { name: '通义千问', host: 'dashscope.aliyuncs.com', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  glm: { name: '智谱 GLM', host: 'open.bigmodel.cn', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  kimi: { name: 'Kimi', host: 'api.moonshot.cn', baseUrl: 'https://api.moonshot.cn/v1' },
  custom: { name: '其他平台', host: '', baseUrl: '' },
};
const IDS = Object.keys(PROVIDERS);

export const hostOf = (u) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return '';
  }
};

/** 按接口地址判断是哪个平台；地址为空时返回 null */
export function providerFor(baseUrl) {
  const h = hostOf(baseUrl);
  if (!h) return null;
  return IDS.find((id) => PROVIDERS[id].host === h) || 'custom';
}

/** 整理用户填的接口地址：去掉结尾的斜杠和误贴的 /chat/completions */
export function normalizeBaseUrl(v) {
  let u = str(v, 300).replace(/\/+$/, '');
  u = u.replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
  if (!u) return '';
  if (!/^https?:\/\/[^\s/]+/i.test(u)) throw new HttpError(400, '接口地址要以 http:// 或 https:// 开头');
  return u;
}

/** 数据库里的旧格式（只有一份配置）升级成按平台保存 */
function upgrade(raw) {
  if (!raw || typeof raw !== 'object') return { v: 2, active: null, providers: {} };
  if (raw.v === 2) return { v: 2, active: IDS.includes(raw.active) ? raw.active : null, providers: { ...(raw.providers || {}) } };
  const id = providerFor(raw.baseUrl) || 'custom';
  return { v: 2, active: id, providers: { [id]: raw } };
}

const NO_ENV = { baseUrl: '', apiKey: '', mainModel: '', lightModel: '', jsonMode: true, thinking: false };

/**
 * opts.target：生效的配置写到 target.llm（默认 cfg，也就是你自己的 llm 读的那份）
 * opts.useEnv：false 时不用 .env（邀请账户）
 * opts.store：{ get(), put(value) } 读写保存的配置（默认 settings 表的 llm）
 */
export function createSettings(cfg, { target = cfg, useEnv = true, store: db = null } = {}) {
  // .env 里的原始配置只记一次，之后 cfg.llm 会被网页配置覆盖
  cfg.envLlm ||= { ...cfg.llm };
  const env = useEnv ? cfg.envLlm : { ...NO_ENV, timeoutMs: cfg.llm.timeoutMs };
  const io = db || { get: () => repo.getSetting(KEY), put: (v) => (v ? repo.putSetting(KEY, v) : repo.deleteSetting(KEY)) };
  const envProvider = envReady(env) ? providerFor(env.baseUrl) : null;
  const envLight = env.lightModel === env.mainModel ? '' : env.lightModel;

  let store = upgrade(null);
  let source = 'none';
  let activeKeyBroken = false;

  /** 某个平台保存的配置（密钥已解密）；网页上没存过、但 .env 用的就是这个平台时，返回 .env 的 */
  function stored(id) {
    const e = store.providers[id];
    if (e) {
      const apiKey = e.apiKeyEnc ? decrypt(e.apiKeyEnc, cfg.cookieSecret) : '';
      return {
        saved: true,
        baseUrl: e.baseUrl || '',
        apiKey: apiKey || '',
        keyBroken: Boolean(e.apiKeyEnc) && apiKey === null,
        mainModel: e.mainModel || '',
        lightModel: e.lightModel || '',
        jsonMode: e.jsonMode !== false,
        thinking: e.thinking === true,
        updatedAt: e.updatedAt || null,
      };
    }
    if (id && id === envProvider) {
      return { saved: false, fromEnv: true, baseUrl: env.baseUrl, apiKey: env.apiKey, keyBroken: false, mainModel: env.mainModel, lightModel: envLight, jsonMode: env.jsonMode, thinking: Boolean(env.thinking), updatedAt: null };
    }
    return null;
  }

  function apply() {
    const s = store.active && store.providers[store.active] ? stored(store.active) : null;
    if (s) {
      Object.assign(target.llm, {
        baseUrl: s.baseUrl,
        apiKey: s.apiKey,
        mainModel: s.mainModel,
        lightModel: s.lightModel || s.mainModel,
        jsonMode: s.jsonMode,
        thinking: s.thinking,
      });
      activeKeyBroken = s.keyBroken;
      source = 'page';
    } else {
      Object.assign(target.llm, env);
      activeKeyBroken = false;
      source = envReady(env) ? 'env' : 'none';
    }
  }

  async function persist() {
    await io.put(!store.active && !Object.keys(store.providers).length ? null : store);
  }

  async function load() {
    const raw = await io.get();
    store = upgrade(raw);
    if (raw && raw.v !== 2) await persist(); // 旧格式升级后写回
    apply();
  }

  function providerView(id) {
    const s = stored(id);
    if (!s) return null;
    return {
      saved: s.saved,
      fromEnv: Boolean(s.fromEnv),
      baseUrl: s.baseUrl,
      mainModel: s.mainModel,
      lightModel: s.lightModel,
      jsonMode: s.jsonMode,
      thinking: s.thinking,
      hasKey: Boolean(s.apiKey),
      keyHint: s.apiKey ? maskKey(s.apiKey) : '',
      keyBroken: s.keyBroken,
      updatedAt: s.updatedAt,
    };
  }

  function view() {
    const provider = source === 'page' ? store.active : source === 'env' ? envProvider : null;
    const active = provider ? providerView(provider) : null;
    return {
      source, // page = 网页上保存的；env = .env 文件；none = 没配置
      ready: envReady(target.llm),
      provider,
      providerName: provider ? PROVIDERS[provider].name : '',
      baseUrl: target.llm.baseUrl,
      mainModel: target.llm.mainModel,
      lightModel: active ? active.lightModel : '',
      jsonMode: target.llm.jsonMode,
      thinking: Boolean(target.llm.thinking),
      hasKey: Boolean(target.llm.apiKey),
      keyHint: target.llm.apiKey ? maskKey(target.llm.apiKey) : '',
      keyBroken: activeKeyBroken,
      envAvailable: envReady(env),
      envProvider,
      updatedAt: active?.updatedAt || null,
      providers: Object.fromEntries(IDS.map((id) => [id, providerView(id)]).filter(([, v]) => v)),
    };
  }

  /**
   * 把请求里的字段和这个平台保存的配置合起来。
   * 密钥留空表示沿用这个平台保存的密钥（只在接口域名没变时沿用，换了域名必须重新填）。
   */
  function candidate(body = {}) {
    const baseUrlIn = 'baseUrl' in body ? normalizeBaseUrl(body.baseUrl) : null;
    const provider = IDS.includes(body.provider) ? body.provider : providerFor(baseUrlIn) || store.active || envProvider || 'custom';
    const s = stored(provider) || { baseUrl: PROVIDERS[provider].baseUrl, apiKey: '', mainModel: '', lightModel: '', jsonMode: true, thinking: false };
    const baseUrl = baseUrlIn ?? s.baseUrl;
    let apiKey = str(body.apiKey, 300);
    let keyHostChanged = false;
    if (!apiKey && s.apiKey) {
      if (hostOf(baseUrl) === hostOf(s.baseUrl)) apiKey = s.apiKey;
      else keyHostChanged = true;
    }
    const mainModel = 'mainModel' in body ? str(body.mainModel, 100) : s.mainModel;
    const lightRaw = 'lightModel' in body ? str(body.lightModel, 100) : s.lightModel;
    return {
      provider,
      baseUrl,
      apiKey,
      keyHostChanged,
      mainModel,
      lightModel: lightRaw || mainModel,
      lightRaw,
      jsonMode: 'jsonMode' in body ? body.jsonMode !== false : s.jsonMode !== false,
      thinking: 'thinking' in body ? body.thinking === true : s.thinking === true,
      timeoutMs: cfg.llm.timeoutMs,
    };
  }

  /** 没有密钥时的提示 */
  function keyError(c) {
    return c.keyHostChanged ? '接口地址换了，请重新填写这个地址对应的 API 密钥' : `请填写 ${PROVIDERS[c.provider].name} 的 API 密钥`;
  }

  /** 保存某个平台的配置，并切换成正在使用的平台 */
  async function save(body = {}) {
    const c = candidate(body);
    if (!c.baseUrl) throw new HttpError(400, '请填写接口地址');
    if (!c.mainModel) throw new HttpError(400, '请填写主力模型');
    if (!c.apiKey) throw new HttpError(400, keyError(c));
    store.providers[c.provider] = {
      baseUrl: c.baseUrl,
      mainModel: c.mainModel,
      lightModel: c.lightRaw,
      jsonMode: c.jsonMode,
      thinking: c.thinking,
      apiKeyEnc: encrypt(c.apiKey, cfg.cookieSecret),
      updatedAt: new Date().toISOString(),
    };
    store.active = c.provider;
    await persist();
    apply();
    return view();
  }

  /** 传 provider：删除这个平台保存的配置；不传：不再使用网页配置（改用 .env），各平台保存的配置保留 */
  async function reset(provider) {
    if (provider) {
      if (!IDS.includes(provider)) throw new HttpError(400, '没有这个平台');
      delete store.providers[provider];
      if (store.active === provider) store.active = null;
    } else {
      store.active = null;
    }
    await persist();
    apply();
    return view();
  }

  return { load, view, candidate, keyError, save, reset };
}

/**
 * 按账户取模型配置和 AI 客户端：你自己用 ownerSvc / ownerLlm（可以退回 .env）；
 * 邀请账户第一次用到时从 accounts.llm 读出来，各自一个 AI 客户端，只用它自己填的 API 密钥。
 */
export function createSettingsHub(cfg, { ownerSvc, ownerLlm, createLlm }) {
  const members = new Map(); // 账户 id -> Promise<{ svc, llm }>

  function get(account) {
    if (!account || account.role === 'owner') return Promise.resolve({ svc: ownerSvc, llm: ownerLlm });
    if (!members.has(account.id)) {
      const target = { llm: { ...NO_ENV, timeoutMs: cfg.llm.timeoutMs } };
      const svc = createSettings(cfg, {
        target,
        useEnv: false,
        store: { get: () => repo.getAccountLlm(account.id), put: (v) => repo.setAccountLlm(account.id, v) },
      });
      const p = svc.load().then(() => ({ svc, llm: createLlm(target) }));
      p.catch(() => members.delete(account.id)); // 读失败下次重试
      members.set(account.id, p);
    }
    return members.get(account.id);
  }

  return {
    get,
    llmFor: async (account) => (await get(account)).llm,
    /** 账户删除后丢掉缓存 */
    drop: (id) => members.delete(id),
  };
}
