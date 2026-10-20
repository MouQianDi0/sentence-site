// 路由和请求处理。createApp() 返回一个 (req, res) 处理函数，测试里也直接用它。
import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from 'node:http';
import type { AccountRole, ChatgptDisconnect, Invite, LlmTestItem } from '@sentence-site/shared';
import type { AppConfig } from './config.ts';
import * as repo from './repo.ts';
import type { AccountRow } from './repo.ts';
import { createAuth, COOKIE_NAME, DEVICE_COOKIE } from './auth.ts';
import { createRouter } from './router.ts';
import { HttpError, send, readJson, parseCookies, clientIp, isHttps } from './http.ts';
import { checkRecordPatch } from './validate.ts';
import { createAi, toHttpError, type Ai } from './ai.ts';
import { createLlm, LlmError, type Llm, type NotJsonWhy } from './llm.ts';
import {
  createSettings,
  createSettingsHub,
  type Candidate,
  type SettingsHub,
  type SettingsService,
} from './settings.ts';
import { createPractice, MAX_DAILY } from './practice.ts';
import { metered, tokenStats } from './tokens.ts';
import { createChatgpt, type ChatgptService } from './chatgpt.ts';
import { routeLlm, type LlmUse } from './llm-route.ts';
import { createAccounts, memberVersion, newDeviceId, isDeviceId, isExpired, EXPIRED_MESSAGE } from './accounts.ts';
import { shanghaiDate } from './time.ts';

/** 处理函数拿到的东西。不需要登录的接口里 account 是 null，不要读它 */
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  account: AccountRow;
}

interface Out {
  status?: number;
  body?: unknown;
  headers?: OutgoingHttpHeaders;
}

type Handler = (ctx: Ctx) => Promise<Out | void>;
type Logger = Pick<Console, 'log' | 'error'> & { warn?: (...a: unknown[]) => void };

export interface AppDeps {
  llm?: Llm;
  settings?: SettingsService | null;
  practice?: ReturnType<typeof createPractice> | null;
  hub?: SettingsHub | null;
  ai?: Ai | null;
  /** ChatGPT 套餐（只给你自己用）；不传时自己建一个 */
  chatgpt?: ChatgptService | null;
  log?: Logger;
}

/** 连接测试没拿到 JSON 时，告诉用户该怎么改 */
function testHint(why: NotJsonWhy | undefined, c: Candidate): string {
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

export function createApp(
  cfg: AppConfig,
  {
    llm = createLlm(cfg),
    settings = null,
    practice = null,
    hub: hubIn = null,
    ai: aiIn = null,
    chatgpt: chatgptIn = null,
    log = console,
  }: AppDeps = {},
) {
  const auth = createAuth(cfg);
  const accounts = createAccounts(cfg);
  const router = createRouter<Handler>();
  const pub = { public: true };
  const ownerOnly = { owner: true }; // 只有你自己（访问密码登录的账户）能用
  // 没有从外面传入时自己读取一次数据库里的模型配置
  const settingsSvc = settings || createSettings(cfg);
  // ChatGPT 套餐：只有你自己的账户会用（按用途走它，出错回退到国内模型）
  const chatgpt = chatgptIn || createChatgpt({ cfg, fallbackReady: () => llm.ready(), log });
  const routeOwner = (base: Llm, use: LlmUse) => routeLlm({ plan: chatgpt, fallback: base, use, log });
  // 模型配置按账户：你自己用 settingsSvc / llm（再加上 ChatGPT），邀请账户各用各的（只用它自己填的 API 密钥）
  const hub = hubIn || createSettingsHub(cfg, { ownerSvc: settingsSvc, ownerLlm: llm, createLlm, routeOwner });
  const ai = aiIn || createAi({ cfg, llm, llmFor: hub.llmFor, log });
  const practiceSvc = practice || createPractice(cfg);
  const settingsReady = Promise.all([
    settings ? null : settingsSvc.load().catch((e: Error) => log.error('[settings]', e.message)),
    chatgptIn ? null : chatgpt.load().catch((e: Error) => log.error('[chatgpt]', e.message)),
  ]);
  const sessionOf = (req: IncomingMessage) =>
    accounts.resolve(auth.verify(parseCookies(req.headers.cookie)[COOKIE_NAME]), auth.ownerVersion, clientIp(req));

  // ---- 不需要密码 -------------------------------------------------------------
  router.add(
    'GET',
    '/api/health',
    async () => {
      try {
        await repo.countSentences();
        return { body: { ok: true, db: true } };
      } catch {
        return { status: 503, body: { ok: false, db: false } };
      }
    },
    pub,
  );

  // role：owner 是你自己，member 是邀请账户；name：邀请账户的备注名；expiresAt：邀请账户的到期时间（永久是 null）
  const me = (acc: { role: AccountRole; note?: string; expiresAt?: string | null }) => ({
    unlocked: true as const,
    role: acc.role,
    name: acc.role === 'owner' ? '' : acc.note || '',
    ...(acc.role === 'member' ? { expiresAt: acc.expiresAt ?? null } : {}),
  });

  router.add(
    'GET',
    '/api/session',
    async ({ req }) => {
      try {
        const acc = await sessionOf(req);
        return { body: acc ? me(acc) : { unlocked: false } };
      } catch (e) {
        // 邀请码过期了：告诉登录页为什么要重新登录
        if (e instanceof HttpError && e.status === 401) return { body: { unlocked: false, notice: e.message } };
        throw e;
      }
    },
    pub,
  );

  // password 可以是访问密码，也可以是邀请码
  router.add(
    'POST',
    '/api/unlock',
    async ({ req }) => {
      const body = await readJson(req);
      const r = await auth.tryLogin(clientIp(req), body.password, accounts.findByCode);
      if (!r.ok && r.locked) throw new HttpError(429, `输错次数太多，请 ${r.locked} 分钟后再试`);
      if (!r.ok) throw new HttpError(401, `密码或邀请码不对，还可以再试 ${'left' in r ? r.left : 0} 次`);
      const secure = cfg.cookieSecure || isHttps(req);
      if (r.account === 'owner') {
        return {
          body: { ok: true, ...me({ role: 'owner' }) },
          headers: { 'Set-Cookie': auth.cookie(auth.issue(), secure) },
        };
      }
      // 邀请账户：过期了不让进（也不占设备名额）；认这个浏览器的设备编号，新设备要占一个名额
      let acc = r.account;
      if (isExpired(acc)) throw new HttpError(403, EXPIRED_MESSAGE);
      const had = parseCookies(req.headers.cookie)[DEVICE_COOKIE];
      const device = isDeviceId(had) ? had : newDeviceId();
      if (!(await accounts.useDevice(acc, device, { ua: req.headers['user-agent'] || '', ip: clientIp(req) }))) {
        throw new HttpError(403, `这个邀请码已经在 ${acc.deviceLimit} 台设备上登录过了，请联系管理员移除不用的设备`);
      }
      acc = await accounts.checkIn(acc); // 第一次登录：有效期从现在开始算
      const token = auth.issue(acc.id, memberVersion(acc), device);
      return {
        body: { ok: true, ...me(acc) },
        headers: { 'Set-Cookie': [auth.cookie(token, secure), auth.deviceCookie(device, secure)] },
      };
    },
    pub,
  );

  router.add(
    'POST',
    '/api/lock',
    async () => ({
      body: { ok: true },
      headers: { 'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` },
    }),
    pub,
  );

  // ---- 句库 -------------------------------------------------------------------
  // ---- 下面的接口都只读写当前登录账户自己的数据 ----------------------------------
  router.add('GET', '/api/sentences', async ({ url, account }) => {
    const since = url.searchParams.get('since');
    if (since && Number.isNaN(Date.parse(since))) throw new HttpError(400, 'since 不是合法的时间');
    return { body: { sentences: await repo.listSentences(account.id, since || null) } };
  });

  router.add('DELETE', '/api/sentences/:id', async ({ params, account }) => {
    if (!(await repo.deleteSentence(account.id, params.id))) throw new HttpError(404, '句子不存在');
    return { body: { ok: true } };
  });

  // 谓语标错了：自己按单词位置改（spans），或者让 AI 复查这一句
  router.add('PUT', '/api/sentences/:id/predicates', async ({ req, params, account }) => ({
    body: await ai.setMarks(account, params.id, (await readJson(req)).spans),
  }));
  router.add('POST', '/api/sentences/:id/review', async ({ params, account }) => ({
    body: await ai.reviewOne(account, params.id),
  }));

  // kind=daily：生成（或补齐）今日任务；kind=extra（默认）：加练 count 句（1–10）。难度按“每日任务”设置
  router.add('POST', '/api/sentences/generate', async ({ req, account }) => {
    const body = await readJson(req);
    const p = practiceSvc.get(account);
    if (body.kind === 'daily') {
      const n = p.dailyCount - (await repo.countDailyFor(account.id, shanghaiDate()));
      if (n <= 0) throw new HttpError(409, '今天的任务已经生成好了');
      return { body: { added: await ai.generate(account, { source: 'daily', n, levels: p.levels }) } };
    }
    const n = body.count === undefined ? 5 : Number(body.count);
    if (!Number.isInteger(n) || n < 1 || n > MAX_DAILY) throw new HttpError(400, `一次加练 1–${MAX_DAILY} 句`);
    return { body: { added: await ai.generate(account, { source: 'extra', n, levels: p.levels }) } };
  });

  // ---- 练习记录 ---------------------------------------------------------------
  router.add('GET', '/api/records', async ({ account }) => ({ body: { records: await repo.listRecords(account.id) } }));

  router.add('PUT', '/api/records/:sentenceId', async ({ req, params, account }) => {
    const checked = checkRecordPatch(await readJson(req));
    if ('error' in checked) throw new HttpError(400, checked.error);
    const sentenceId = params.sentenceId;
    if (!(await repo.getSentence(account.id, sentenceId))) throw new HttpError(404, '句子不存在');
    try {
      return { body: { record: await repo.upsertRecord(account.id, sentenceId, checked.fields) } };
    } catch (e) {
      if ((e as { code?: string } | null)?.code === '23503') throw new HttpError(404, '句子不存在');
      throw e;
    }
  });

  // ---- 批改、查词 -------------------------------------------------------------
  router.add('GET', '/api/attempts', async ({ url, account }) => ({
    body: { attempts: await repo.listAttempts(account.id, url.searchParams.get('sentenceId') || null) },
  }));

  router.add('POST', '/api/grade', async ({ req, account }) => {
    const body = await readJson(req);
    // 设置里开了“准确度提升”：后台独立评分 5 次取平均，再汇总批注；没开只评 1 次
    const boost = practiceSvc.get(account).accuracyBoost;
    return { body: { attempt: await ai.grade(account, body.sentenceId, body.text, { boost }) } };
  });

  router.add('POST', '/api/lookup', async ({ req, account }) => {
    const body = await readJson(req);
    return { body: await ai.lookup(account, body.sentenceId, body.word) };
  });

  router.add('GET', '/api/usage', async ({ account }) => {
    const day = shanghaiDate();
    return {
      body: {
        day,
        ...(await repo.getUsage(account.id, day)),
        limits: { grade: cfg.limits.grade, lookup: cfg.limits.lookup, generate: cfg.limits.generate },
        aiReady: (await hub.llmFor(account, { kind: 'grade' })).ready(),
      },
    };
  });

  // 当前账户自己的 token 用量（设置 → Token 用量）。?days=7|30|90：图表和分类统计的范围
  router.add('GET', '/api/usage/tokens', async ({ url, account }) => ({
    body: await tokenStats(account.id, url.searchParams.get('days')),
  }));

  // ---- 每日任务设置（每个账户自己的）---------------------------------------------
  router.add('GET', '/api/settings/practice', async ({ account }) => ({ body: practiceSvc.get(account) }));
  router.add('PUT', '/api/settings/practice', async ({ req, account }) => ({
    body: await practiceSvc.save(account, await readJson(req)),
  }));

  // ---- 邀请码管理（只有你自己能用）------------------------------------------------
  router.add('GET', '/api/admin/invites', async () => ({ body: { invites: await accounts.list() } }), ownerOnly);
  // {note}：备注名
  router.add(
    'POST',
    '/api/admin/invites',
    async ({ req }) => ({ body: { invite: await accounts.create(await readJson(req)) } }),
    ownerOnly,
  );
  // {deviceLimit}：这个邀请码最多能在几台设备上登录（1–10）；
  // {validDays}：有效期 30 / 90 / 180 / 360 天，null 是永久（对方登录过的从现在开始重新算）
  router.add(
    'PUT',
    '/api/admin/invites/:id',
    async ({ req, params }) => {
      const body = await readJson(req);
      if (!('deviceLimit' in body) && !('validDays' in body)) throw new HttpError(400, '要改设备数或有效期');
      let invite: Invite | null = null;
      if ('validDays' in body) invite = await accounts.setValidity(params.id, body.validDays);
      if ('deviceLimit' in body) invite = await accounts.setDeviceLimit(params.id, body.deviceLimit);
      return { body: { invite } };
    },
    ownerOnly,
  );
  // 移除一台设备：它马上退出登录，空出名额
  router.add(
    'DELETE',
    '/api/admin/invites/:id/devices/:deviceId',
    async ({ params }) => ({
      body: { invite: await accounts.removeDevice(params.id, params.deviceId) },
    }),
    ownerOnly,
  );
  // 删除邀请码 = 删除这个账户和它的全部数据（包括它自己填的模型配置）
  router.add(
    'DELETE',
    '/api/admin/invites/:id',
    async ({ params }) => {
      await accounts.remove(params.id);
      hub.drop(params.id);
      return { body: { ok: true } };
    },
    ownerOnly,
  );

  // ---- 模型设置（每个账户自己的；邀请账户没有 .env 可用，只能用自己填的 API 密钥）----------
  const svcOf = async (account: AccountRow) => (await hub.get(account)).svc;
  router.add('GET', '/api/settings/llm', async ({ account }) => ({ body: (await svcOf(account)).view() }));

  router.add('PUT', '/api/settings/llm', async ({ req, account }) => ({
    body: await (await svcOf(account)).save(await readJson(req)),
  }));

  // ?provider=deepseek 删除这个平台的配置；不带参数表示改回使用 .env（各平台保存的配置保留）
  router.add('DELETE', '/api/settings/llm', async ({ url, account }) => ({
    body: await (await svcOf(account)).reset(url.searchParams.get('provider') || null),
  }));

  // 用填写的配置（还没保存也可以）试着调用一次模型
  router.add('POST', '/api/settings/llm/test', async ({ req, account }) => {
    const svc = await svcOf(account);
    const c = svc.candidate(await readJson(req));
    if (!c.baseUrl) throw new HttpError(400, '请填写接口地址');
    if (!c.apiKey) throw new HttpError(400, svc.keyError(c));
    if (!c.mainModel) throw new HttpError(400, '请填写主力模型');
    // 测试连接也会用掉一点 token，同样记到这个账户名下
    const probe = metered(createLlm({ llm: c }), account.id, 'test', log);
    const results: LlmTestItem[] = [];
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
        const result: LlmTestItem = {
          model,
          ok: false,
          latencyMs: Date.now() - started,
          error: toHttpError(e).message,
        };
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

  router.add('POST', '/api/settings/llm/models', async ({ req, account }) => {
    const svc = await svcOf(account);
    const c = svc.candidate(await readJson(req));
    if (c.baseUrl && !c.apiKey) throw new HttpError(400, svc.keyError(c));
    try {
      return { body: { models: await createLlm({ llm: c }).listModels() } };
    } catch (e) {
      throw toHttpError(e);
    }
  });

  // ---- ChatGPT 套餐（Sign in with ChatGPT，只有你自己能用）--------------------------------
  // OpenAI 规定套餐凭据只能用于连接它的这个人自己的请求，所以这些接口和 ChatGPT 本身都只对 owner 开放
  router.add('GET', '/api/settings/chatgpt', async () => ({ body: chatgpt.view() }), ownerOnly);

  // 选模型、用途开关、后台出题开关：{mainModel, lightModel, use: {grade, generate, lookup}, background}
  router.add(
    'PUT',
    '/api/settings/chatgpt',
    async ({ req }) => ({ body: await chatgpt.save(await readJson(req)) }),
    ownerOnly,
  );

  // 生成授权链接：在浏览器里打开，授权完成后把跳转到的 127.0.0.1 地址整段粘贴回来
  router.add('POST', '/api/settings/chatgpt/start', async () => ({ body: await chatgpt.start() }), ownerOnly);

  // {callbackUrl}：粘贴回来的地址。服务器（通过 OPENAI_PROXY）换 token、校验后保存
  router.add(
    'POST',
    '/api/settings/chatgpt/finish',
    async ({ req }) => ({ body: await chatgpt.finish((await readJson(req)).callbackUrl) }),
    ownerOnly,
  );

  router.add(
    'POST',
    '/api/settings/chatgpt/models',
    async () => {
      try {
        return { body: { models: await chatgpt.models() } };
      } catch (e) {
        throw toHttpError(e);
      }
    },
    ownerOnly,
  );

  // 用主力、轻量模型各调用一次；都成功时顺便取消暂停
  router.add(
    'POST',
    '/api/settings/chatgpt/test',
    async ({ account }) => {
      const v = chatgpt.view();
      if (v.status !== 'ok') throw new HttpError(400, v.status === 'none' ? '先连接 ChatGPT' : '先重新连接 ChatGPT');
      if (!v.mainModel) throw new HttpError(400, '先选择 ChatGPT 的主力模型');
      const probe = metered(chatgpt.probe, account.id, 'test', log);
      const results: LlmTestItem[] = [];
      for (const model of [...new Set([v.mainModel, v.lightModel || v.mainModel])]) {
        const started = Date.now();
        try {
          const r = await probe.chatJson({ prompt: '这是一次连接测试。请只回复这个 JSON 对象：{"ok": true}', model });
          results.push({ model, ok: true, latencyMs: Date.now() - started, answeredBy: r.model });
        } catch (e) {
          const item: LlmTestItem = {
            model,
            ok: false,
            latencyMs: Date.now() - started,
            error: toHttpError(e).message,
          };
          if (e instanceof LlmError && e.detail) item.sample = e.detail.slice(0, 200);
          results.push(item);
        }
      }
      const ok = results.every((r) => r.ok);
      if (ok && chatgpt.view().pausedUntil) await chatgpt.resume();
      return { body: { ok, results } };
    },
    ownerOnly,
  );

  router.add('POST', '/api/settings/chatgpt/resume', async () => ({ body: await chatgpt.resume() }), ownerOnly);

  // 断开：到 OpenAI 吊销授权，删掉保存的凭据；revoked 为 false 时提示到 ChatGPT 设置里手动断开
  router.add(
    'DELETE',
    '/api/settings/chatgpt',
    async (): Promise<{ body: ChatgptDisconnect }> => ({ body: await chatgpt.disconnect() }),
    ownerOnly,
  );

  // ---- 处理请求 ---------------------------------------------------------------
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    let status = 500;
    try {
      await settingsReady;
      const url = new URL(req.url || '/', 'http://localhost');
      let found: ReturnType<typeof router.match>;
      try {
        found = router.match(req.method || 'GET', url.pathname);
      } catch {
        throw new HttpError(400, '路径格式不对');
      }
      if (!found.route) {
        throw found.pathMatched ? new HttpError(405, '不支持这个请求方法') : new HttpError(404, '接口不存在');
      }
      const account = found.route.opts.public ? null : await sessionOf(req);
      if (!found.route.opts.public && !account) throw new HttpError(401, '需要先输入访问密码或邀请码');
      if (found.route.opts.owner && account?.role !== 'owner') throw new HttpError(403, '只有管理员可以使用这个功能');
      let out: Out;
      try {
        // 不需要登录的接口里 account 是 null（这些处理函数不读它）
        out =
          (await found.route.handler({ req, res, url, params: found.params, account: account as AccountRow })) || {};
      } catch (e) {
        // 邀请账户没有 .env 可用，提示里去掉 .env
        if (
          account?.role === 'member' &&
          e instanceof HttpError &&
          e.status === 503 &&
          /还没配置 AI 模型/.test(e.message)
        ) {
          throw new HttpError(503, '还没配置 AI 模型：到“设置”页填写你自己的模型和 API 密钥');
        }
        throw e;
      }
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
