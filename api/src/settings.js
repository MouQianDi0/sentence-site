// 模型配置：可以在网页上设置（存数据库，优先使用），没设置时用 .env 里的。
// 保存后立即生效，不用重启。
import * as repo from './repo.js';
import { encrypt, decrypt, maskKey } from './secret.js';
import { HttpError } from './http.js';

const KEY = 'llm';
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const envReady = (l) => Boolean(l.baseUrl && l.apiKey && l.mainModel);

/** 整理用户填的接口地址：去掉结尾的斜杠和误贴的 /chat/completions */
export function normalizeBaseUrl(v) {
  let u = str(v, 300).replace(/\/+$/, '');
  u = u.replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
  if (!u) return '';
  if (!/^https?:\/\/[^\s/]+/i.test(u)) throw new HttpError(400, '接口地址要以 http:// 或 https:// 开头');
  return u;
}

export function createSettings(cfg) {
  // .env 里的原始配置只记一次，之后 cfg.llm 会被网页配置覆盖
  cfg.envLlm ||= { ...cfg.llm };
  let source = envReady(cfg.envLlm) ? 'env' : 'none';
  let lightRaw = cfg.envLlm.lightModel === cfg.envLlm.mainModel ? '' : cfg.envLlm.lightModel;
  let keyBroken = false;
  let updatedAt = null;

  function apply(saved) {
    if (saved) {
      const apiKey = saved.apiKeyEnc ? decrypt(saved.apiKeyEnc, cfg.cookieSecret) : '';
      keyBroken = Boolean(saved.apiKeyEnc) && apiKey === null;
      Object.assign(cfg.llm, {
        baseUrl: saved.baseUrl || '',
        apiKey: apiKey || '',
        mainModel: saved.mainModel || '',
        lightModel: saved.lightModel || saved.mainModel || '',
        jsonMode: saved.jsonMode !== false,
        thinking: saved.thinking === true,
      });
      lightRaw = saved.lightModel || '';
      updatedAt = saved.updatedAt || null;
      source = 'page';
    } else {
      Object.assign(cfg.llm, cfg.envLlm);
      lightRaw = cfg.envLlm.lightModel === cfg.envLlm.mainModel ? '' : cfg.envLlm.lightModel;
      keyBroken = false;
      updatedAt = null;
      source = envReady(cfg.envLlm) ? 'env' : 'none';
    }
  }

  async function load() {
    apply(await repo.getSetting(KEY));
  }

  function view() {
    return {
      source, // page = 网页上保存的；env = .env 文件；none = 没配置
      ready: envReady(cfg.llm),
      baseUrl: cfg.llm.baseUrl,
      mainModel: cfg.llm.mainModel,
      lightModel: lightRaw,
      jsonMode: cfg.llm.jsonMode,
      thinking: Boolean(cfg.llm.thinking),
      hasKey: Boolean(cfg.llm.apiKey),
      keyHint: maskKey(cfg.llm.apiKey),
      keyBroken,
      envAvailable: envReady(cfg.envLlm),
      updatedAt,
    };
  }

  /** 把请求里的字段和当前配置合起来；密钥留空表示沿用当前的 */
  function candidate(body = {}) {
    const baseUrl = 'baseUrl' in body ? normalizeBaseUrl(body.baseUrl) : cfg.llm.baseUrl;
    const apiKey = str(body.apiKey, 300) || cfg.llm.apiKey;
    const mainModel = 'mainModel' in body ? str(body.mainModel, 100) : cfg.llm.mainModel;
    const lightModel = 'lightModel' in body ? str(body.lightModel, 100) : lightRaw;
    const jsonMode = 'jsonMode' in body ? body.jsonMode !== false : cfg.llm.jsonMode;
    const thinking = 'thinking' in body ? body.thinking === true : Boolean(cfg.llm.thinking);
    return {
      baseUrl,
      apiKey,
      mainModel,
      lightModel: lightModel || mainModel,
      jsonMode,
      thinking,
      timeoutMs: cfg.llm.timeoutMs,
    };
  }

  async function save(body = {}) {
    const c = candidate(body);
    if (!c.baseUrl) throw new HttpError(400, '请填写接口地址');
    if (!c.mainModel) throw new HttpError(400, '请填写主力模型');
    if (!c.apiKey) throw new HttpError(400, '请填写 API 密钥');
    const saved = {
      baseUrl: c.baseUrl,
      mainModel: c.mainModel,
      lightModel: str(body.lightModel, 100),
      jsonMode: c.jsonMode,
      thinking: c.thinking,
      apiKeyEnc: encrypt(c.apiKey, cfg.cookieSecret),
      updatedAt: new Date().toISOString(),
    };
    await repo.putSetting(KEY, saved);
    apply(saved);
    return view();
  }

  async function reset() {
    await repo.deleteSetting(KEY);
    apply(null);
    return view();
  }

  return { load, view, candidate, save, reset };
}
