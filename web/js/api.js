// 和后端说话。401 时通知页面回到输密码的界面。
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => (onUnauthorized = fn);

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error('连不上服务器，检查一下网络'), { status: 0 });
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // 非 JSON 响应（比如 Nginx 的错误页）
  }
  if (res.status === 401 && path !== '/api/unlock') onUnauthorized();
  if (!res.ok) {
    const fallback = res.status === 502 || res.status === 504 ? '后端暂时没有响应，稍后再试' : `请求失败（${res.status}）`;
    throw Object.assign(new Error(data?.error || fallback), { status: res.status });
  }
  return data;
}

export const api = {
  session: () => request('GET', '/api/session'),
  unlock: (password) => request('POST', '/api/unlock', { password }),
  sentences: (since) => request('GET', `/api/sentences${since ? `?since=${encodeURIComponent(since)}` : ''}`),
  deleteSentence: (id) => request('DELETE', `/api/sentences/${encodeURIComponent(id)}`),
  generate: () => request('POST', '/api/sentences/generate'),
  records: () => request('GET', '/api/records'),
  saveRecord: (id, patch) => request('PUT', `/api/records/${encodeURIComponent(id)}`, patch),
  attempts: () => request('GET', '/api/attempts'),
  grade: (sentenceId, text) => request('POST', '/api/grade', { sentenceId, text }),
  lookup: (sentenceId, word) => request('POST', '/api/lookup', { sentenceId, word }),
  usage: () => request('GET', '/api/usage'),
  llmSettings: () => request('GET', '/api/settings/llm'),
  saveLlmSettings: (body) => request('PUT', '/api/settings/llm', body),
  // 传 provider 删除这个平台的配置；不传表示改回使用 .env
  resetLlmSettings: (provider) => request('DELETE', `/api/settings/llm${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`),
  testLlm: (body) => request('POST', '/api/settings/llm/test', body),
  listModels: (body) => request('POST', '/api/settings/llm/models', body),
};
