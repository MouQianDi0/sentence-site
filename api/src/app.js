// 路由和请求处理。createApp() 返回一个 (req, res) 处理函数，测试里也直接用它。
import * as repo from './repo.js';
import { createAuth, COOKIE_NAME } from './auth.js';
import { createRouter } from './router.js';
import { HttpError, send, readJson, parseCookies, clientIp, isHttps } from './http.js';
import { checkRecordPatch } from './validate.js';
import { createAi, toHttpError } from './ai.js';
import { createLlm, LlmError } from './llm.js';
import { createSettings } from './settings.js';
import { shanghaiDate } from './time.js';

/** 连接测试没拿到 JSON 时，告诉用户该怎么改 */
function testHint(why, c) {
  if (why === 'thinking') {
    return c.thinking
      ? '连上了，但模型一直在深度思考，没给出答案。打开“关闭深度思考”再试'
      : '连上了，但这个模型关不掉深度思考，没给出答案。换一个非思考模型试试';
  }
  if (why === 'empty') return '连上了，但模型返回了空内容。换一个模型试试';
  if (why === 'truncated') return '连上了，但模型的回复被截断了。换一个模型试试';
  return c.jsonMode
    ? '连上了，但模型没有按 JSON 格式回复。可以试试关掉“JSON 输出模式”'
    : '连上了，但模型没有按 JSON 格式回复。可以试试打开“JSON 输出模式”，或者换一个模型';
}

export function createApp(cfg, { llm = createLlm(cfg), settings = null, log = console } = {}) {
  const auth = createAuth(cfg);
  const ai = createAi({ cfg, llm, log });
  const router = createRouter();
  const pub = { public: true };
  // 没有从外面传入时自己读取一次数据库里的模型配置
  const settingsSvc = settings || createSettings(cfg);
  const settingsReady = settings ? Promise.resolve() : settingsSvc.load().catch((e) => log.error('[settings]', e.message));

  // ---- 不需要密码 -------------------------------------------------------------
  router.add('GET', '/api/health', async () => {
    try {
      await repo.countSentences();
      return { body: { ok: true, db: true } };
    } catch {
      return { status: 503, body: { ok: false, db: false } };
    }
  }, pub);

  router.add('GET', '/api/session', async ({ req }) => ({
    body: { unlocked: auth.verify(parseCookies(req.headers.cookie)[COOKIE_NAME]) },
  }), pub);

  router.add('POST', '/api/unlock', async ({ req }) => {
    const body = await readJson(req);
    const r = auth.tryPassword(clientIp(req), body.password);
    if (r.locked) throw new HttpError(429, `密码输错次数太多，请 ${r.locked} 分钟后再试`);
    if (!r.ok) throw new HttpError(401, `密码不对，还可以再试 ${r.left} 次`);
    const secure = cfg.cookieSecure || isHttps(req);
    return { body: { ok: true }, headers: { 'Set-Cookie': auth.cookie(auth.issue(), secure) } };
  }, pub);

  router.add('POST', '/api/lock', async () => ({
    body: { ok: true },
    headers: { 'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` },
  }), pub);

  // ---- 句库 -------------------------------------------------------------------
  router.add('GET', '/api/sentences', async ({ url }) => {
    const since = url.searchParams.get('since');
    if (since && Number.isNaN(Date.parse(since))) throw new HttpError(400, 'since 不是合法的时间');
    return { body: { sentences: await repo.listSentences(since || null) } };
  });

  router.add('DELETE', '/api/sentences/:id', async ({ params }) => {
    if (!(await repo.deleteSentence(params.id))) throw new HttpError(404, '句子不存在');
    return { body: { ok: true } };
  });

  router.add('POST', '/api/sentences/generate', async () => {
    const ids = await ai.generate({ source: 'manual', n: 5 });
    return { body: { added: ids } };
  });

  // ---- 练习记录 ---------------------------------------------------------------
  router.add('GET', '/api/records', async () => ({ body: { records: await repo.listRecords() } }));

  router.add('PUT', '/api/records/:sentenceId', async ({ req, params }) => {
    const checked = checkRecordPatch(await readJson(req));
    if (checked.error) throw new HttpError(400, checked.error);
    try {
      return { body: { record: await repo.upsertRecord(params.sentenceId, checked.fields) } };
    } catch (e) {
      if (e?.code === '23503') throw new HttpError(404, '句子不存在');
      throw e;
    }
  });

  // ---- 批改、查词 -------------------------------------------------------------
  router.add('GET', '/api/attempts', async ({ url }) => ({
    body: { attempts: await repo.listAttempts(url.searchParams.get('sentenceId') || null) },
  }));

  router.add('POST', '/api/grade', async ({ req }) => {
    const body = await readJson(req);
    return { body: { attempt: await ai.grade(body.sentenceId, body.text) } };
  });

  router.add('POST', '/api/lookup', async ({ req }) => {
    const body = await readJson(req);
    return { body: await ai.lookup(body.sentenceId, body.word) };
  });

  router.add('GET', '/api/usage', async () => {
    const day = shanghaiDate();
    return {
      body: {
        day,
        ...(await repo.getUsage(day)),
        limits: { grade: cfg.limits.grade, lookup: cfg.limits.lookup, generate: cfg.limits.generate },
        aiReady: llm.ready(),
      },
    };
  });

  // ---- 模型设置 ---------------------------------------------------------------
  router.add('GET', '/api/settings/llm', async () => ({ body: settingsSvc.view() }));

  router.add('PUT', '/api/settings/llm', async ({ req }) => ({ body: await settingsSvc.save(await readJson(req)) }));

  router.add('DELETE', '/api/settings/llm', async () => ({ body: await settingsSvc.reset() }));

  // 用填写的配置（还没保存也可以）试着调用一次模型
  router.add('POST', '/api/settings/llm/test', async ({ req }) => {
    const c = settingsSvc.candidate(await readJson(req));
    if (!c.baseUrl || !c.apiKey || !c.mainModel) throw new HttpError(400, '接口地址、API 密钥和主力模型都要填写');
    const probe = createLlm({ llm: c });
    const results = [];
    for (const model of [...new Set([c.mainModel, c.lightModel])]) {
      const started = Date.now();
      try {
        const r = await probe.chatJson({
          prompt: '这是一次连接测试。请只回复这个 JSON 对象：{"ok": true}',
          model,
          maxTokens: 50,
          temperature: 0,
          timeoutMs: c.thinking ? 90_000 : 30_000,
        });
        results.push({ model, ok: true, latencyMs: Date.now() - started, answeredBy: r.model });
      } catch (e) {
        const result = { model, ok: false, latencyMs: Date.now() - started, error: toHttpError(e).message };
        if (e instanceof LlmError && e.code === 'invalid_json') {
          result.error = testHint(e.why, c);
          if (e.detail) result.sample = e.detail.slice(0, 120);
        } else if (e instanceof LlmError && e.detail) {
          result.sample = e.detail.slice(0, 200);
        }
        results.push(result);
      }
    }
    return { body: { ok: results.every((r) => r.ok), results } };
  });

  router.add('POST', '/api/settings/llm/models', async ({ req }) => {
    const c = settingsSvc.candidate(await readJson(req));
    try {
      return { body: { models: await createLlm({ llm: c }).listModels() } };
    } catch (e) {
      throw toHttpError(e);
    }
  });

  // ---- 处理请求 ---------------------------------------------------------------
  return async function handle(req, res) {
    const started = Date.now();
    let status = 500;
    try {
      await settingsReady;
      const url = new URL(req.url || '/', 'http://localhost');
      let found;
      try {
        found = router.match(req.method, url.pathname);
      } catch {
        throw new HttpError(400, '路径格式不对');
      }
      if (!found.route) {
        throw found.pathMatched ? new HttpError(405, '不支持这个请求方法') : new HttpError(404, '接口不存在');
      }
      if (!found.route.opts.public && !auth.verify(parseCookies(req.headers.cookie)[COOKIE_NAME])) {
        throw new HttpError(401, '需要先输入访问密码');
      }
      const out = (await found.route.handler({ req, res, url, params: found.params })) || {};
      status = out.status || 200;
      send(res, status, out.body ?? {}, out.headers);
    } catch (e) {
      const err = e instanceof HttpError ? e : null;
      status = err ? err.status : 500;
      if (!err) log.error('[api]', e);
      if (!res.headersSent) send(res, status, { error: err ? err.message : '服务器出错了，看一下 api 容器的日志' });
    } finally {
      if (req.url !== '/api/health') {
        log.log(`${req.method} ${req.url} ${status} ${Date.now() - started}ms`);
      }
    }
  };
}
