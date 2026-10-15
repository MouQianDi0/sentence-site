// 和后端说话。401 时通知页面回到输密码的界面。返回值的类型来自 @sentence-site/shared，和后端一致。
import type {
  Attempt,
  Invite,
  LlmForm,
  LlmSettingsView,
  LlmTestResult,
  LookupResult,
  MarkSpan,
  PracticeRecord,
  PracticeSettings,
  RecordPatch,
  Sentence,
  Session,
  TokenStats,
  Usage,
} from '@sentence-site/shared';

/** 接口出错：message 是后端给的中文说明，status 是 HTTP 状态码（连不上时是 0） */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized = (): void => {};
export const setUnauthorizedHandler = (fn: () => void): void => {
  onUnauthorized = fn;
};

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('连不上服务器，检查一下网络', 0);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // 非 JSON 响应（比如 Nginx 的错误页）
  }
  if (res.status === 401 && path !== '/api/unlock') onUnauthorized();
  if (!res.ok) {
    const fallback =
      res.status === 502 || res.status === 504 ? '后端暂时没有响应，稍后再试' : `请求失败（${res.status}）`;
    const msg = (data as { error?: unknown } | null)?.error;
    throw new ApiError(typeof msg === 'string' && msg ? msg : fallback, res.status);
  }
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  session: () => request<Session>('GET', '/api/session'),
  /** password：访问密码或邀请码 */
  unlock: (password: string) => request<Session & { ok: true }>('POST', '/api/unlock', { password }),
  lock: () => request<{ ok: true }>('POST', '/api/lock'),

  // 邀请码管理（只有你自己能用）
  invites: () => request<{ invites: Invite[] }>('GET', '/api/admin/invites'),
  createInvite: (note: string) => request<{ invite: Invite }>('POST', '/api/admin/invites', { note }),
  deleteInvite: (id: string) => request<{ ok: true }>('DELETE', `/api/admin/invites/${enc(id)}`),
  setDeviceLimit: (id: string, deviceLimit: number) =>
    request<{ invite: Invite }>('PUT', `/api/admin/invites/${enc(id)}`, { deviceLimit }),
  removeDevice: (id: string, deviceId: string) =>
    request<{ invite: Invite }>('DELETE', `/api/admin/invites/${enc(id)}/devices/${enc(deviceId)}`),

  // 句库
  sentences: (since?: string) =>
    request<{ sentences: Sentence[] }>('GET', `/api/sentences${since ? `?since=${enc(since)}` : ''}`),
  deleteSentence: (id: string) => request<{ ok: true }>('DELETE', `/api/sentences/${enc(id)}`),
  /** 谓语标错了：spans 按整句单词下标 */
  fixPredicates: (id: string, spans: MarkSpan[]) =>
    request<{ sentence: Sentence }>('PUT', `/api/sentences/${enc(id)}/predicates`, { spans }),
  /** 让 AI 复查这一句 */
  reviewSentence: (id: string) =>
    request<{ sentence: Sentence; changed: boolean; note: string }>('POST', `/api/sentences/${enc(id)}/review`),
  /** { kind: 'daily' } 生成或补齐今日任务；{ kind: 'extra', count } 加练 */
  generate: (body: { kind: 'daily' } | { kind: 'extra'; count: number }) =>
    request<{ added: string[] }>('POST', '/api/sentences/generate', body),

  // 每日任务设置（也存着 AI 批改的“准确度提升”开关）
  practiceSettings: () => request<PracticeSettings>('GET', '/api/settings/practice'),
  savePracticeSettings: (
    body: Partial<Pick<PracticeSettings, 'levels' | 'dailyCount' | 'autoDaily' | 'dailyAt' | 'accuracyBoost'>>,
  ) => request<PracticeSettings>('PUT', '/api/settings/practice', body),

  // 练习记录、批改、查词
  records: () => request<{ records: PracticeRecord[] }>('GET', '/api/records'),
  saveRecord: (id: string, patch: RecordPatch) =>
    request<{ record: PracticeRecord }>('PUT', `/api/records/${enc(id)}`, patch),
  attempts: () => request<{ attempts: Attempt[] }>('GET', '/api/attempts'),
  grade: (sentenceId: string, text: string) =>
    request<{ attempt: Attempt }>('POST', '/api/grade', { sentenceId, text }),
  lookup: (sentenceId: string, word: string) => request<LookupResult>('POST', '/api/lookup', { sentenceId, word }),
  usage: () => request<Usage>('GET', '/api/usage'),
  /** 自己的 token 用量；days：图表和分类统计看最近几天（7、30、90） */
  tokenStats: (days: number) => request<TokenStats>('GET', `/api/usage/tokens?days=${days}`),

  // 模型设置
  llmSettings: () => request<LlmSettingsView>('GET', '/api/settings/llm'),
  saveLlmSettings: (body: LlmForm) => request<LlmSettingsView>('PUT', '/api/settings/llm', body),
  /** 传 provider 删除这个平台的配置；不传表示改回使用 .env */
  resetLlmSettings: (provider?: string) =>
    request<LlmSettingsView>('DELETE', `/api/settings/llm${provider ? `?provider=${enc(provider)}` : ''}`),
  testLlm: (body: LlmForm) => request<LlmTestResult>('POST', '/api/settings/llm/test', body),
  listModels: (body: LlmForm) => request<{ models: string[] }>('POST', '/api/settings/llm/models', body),
};
