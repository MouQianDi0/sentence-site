// ChatGPT 套餐（Sign in with ChatGPT）：代理隧道、授权、流式回复、刷新、出错回退到国内模型，
// 以及最重要的一条——邀请账户在任何情况下都不会用到你的 ChatGPT 凭据。
// 用一个假的 OpenAI（授权 + 公钥 + /v1/responses 流式回复）和一个假的 Clash（HTTP CONNECT 代理）。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setQueryImpl } from '../src/db.ts';
import { loadConfig, type AppConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { createLlm, LlmError } from '../src/llm.ts';
import { createSettings, createSettingsHub } from '../src/settings.ts';
import { routeLlm } from '../src/llm-route.ts';
import { createChatgpt, type ChatgptService, type ChatgptStore } from '../src/chatgpt.ts';
import { createOpenaiFetch, parseProxy } from '../src/openai-proxy.ts';
import {
  API_RESOURCE,
  ISSUER,
  PLAN_SCOPE,
  REDIRECT_URI,
  authorizeUrl,
  clearJwksCache,
  parseCallback,
  verifyIdToken,
  type AuthUrls,
} from '../src/chatgpt-auth.ts';
import * as repo from '../src/repo.ts';
import { migrate } from '../src/migrate.ts';
import { importExport } from '../src/importer.ts';
import { createTestDb, startFakeLlm, startApp, type FakeLlm, type TestApp, type TestDb } from './helpers.ts';

const quiet = { log() {}, error() {}, warn() {} };
const SECRET = 'c'.repeat(64);
const GRADE = { acc: 33, flu: 22, comp: 21, level: 'ChatGPT 批改', good: ['好'], issues: [], better: '' };

// ---- 假的 OpenAI ------------------------------------------------------------------

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = {
  ...crypto.createPublicKey(privateKey).export({ format: 'jwk' }),
  kid: 'test-key',
  alg: 'RS256',
  use: 'sig',
};
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function signJwt(claims: Record<string, unknown>, kid = 'test-key'): string {
  const h = b64({ alg: 'RS256', typ: 'JWT', kid });
  const p = b64(claims);
  return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`;
}

type RespMode = 'ok' | 'limit' | 'midfail' | 'cut' | 'rejectText' | 'unauthOnce' | 'ineligible';

interface FakeOpenai {
  base: string;
  auth: AuthUrls;
  api: string;
  /** 浏览器那一步：授权页上用户同意后，记下这个授权码对应的 PKCE、nonce */
  grant(p: { state: string; challenge: string; nonce: string; clientId: string; scope?: string; sub?: string }): string;
  access: string;
  refresh: string;
  refreshes: number;
  revoked: string[];
  bodies: Record<string, unknown>[];
  mode: { responses: RespMode; refresh: 'ok' | 'invalid_grant'; expiresIn: number };
  close(): void;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((r) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => r(b));
  });
}

async function startFakeOpenai(): Promise<FakeOpenai> {
  const codes = new Map<string, { challenge: string; nonce: string; clientId: string; scope: string; sub: string }>();
  let n = 0;
  const f = {
    access: '',
    refresh: '',
    refreshes: 0,
    revoked: [] as string[],
    bodies: [] as Record<string, unknown>[],
    mode: { responses: 'ok' as RespMode, refresh: 'ok' as 'ok' | 'invalid_grant', expiresIn: 3600 },
  };
  const issue = () => {
    n++;
    f.access = `at-${n}`;
    f.refresh = `rt-${n}`;
  };
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    const raw = await readBody(req);
    if (url.pathname === '/.well-known/jwks.json') return json(res, 200, { keys: [JWK] });
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(res, 200, { issuer: ISSUER, revocation_endpoint: `http://${req.headers.host}/oauth/revoke` });
    }
    if (url.pathname === '/oauth/revoke') {
      f.revoked.push(new URLSearchParams(raw).get('token') || '');
      res.writeHead(200);
      return res.end();
    }
    if (url.pathname === '/api/accounts/oauth/token') {
      const q = new URLSearchParams(raw);
      if (q.get('resource') !== API_RESOURCE) return json(res, 400, { error: 'invalid_target' });
      if (q.get('grant_type') === 'authorization_code') {
        const g = codes.get(q.get('code') || '');
        codes.delete(q.get('code') || '');
        if (!g) return json(res, 400, { error: 'invalid_grant' });
        const challenge = crypto
          .createHash('sha256')
          .update(q.get('code_verifier') || '')
          .digest('base64url');
        if (challenge !== g.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'pkce' });
        if (q.get('client_id') !== g.clientId || q.get('redirect_uri') !== REDIRECT_URI) {
          return json(res, 400, { error: 'invalid_request' });
        }
        issue();
        const idToken = signJwt({
          iss: ISSUER,
          aud: g.clientId,
          sub: g.sub,
          email: 'me@example.com',
          name: '我',
          nonce: g.nonce,
          exp: Math.floor(Date.now() / 1000) + 3600,
        });
        return json(res, 200, {
          access_token: f.access,
          refresh_token: f.refresh,
          id_token: idToken,
          token_type: 'Bearer',
          expires_in: f.mode.expiresIn,
          scope: g.scope,
        });
      }
      if (q.get('grant_type') === 'refresh_token') {
        await new Promise((r) => setTimeout(r, 30)); // 让同时发起的刷新有机会撞在一起
        if (f.mode.refresh === 'invalid_grant' || q.get('refresh_token') !== f.refresh) {
          return json(res, 400, { error: 'invalid_grant' });
        }
        f.refreshes++;
        issue();
        return json(res, 200, { access_token: f.access, refresh_token: f.refresh, expires_in: f.mode.expiresIn });
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (req.headers.authorization !== `Bearer ${f.access}`) {
      return json(res, 401, { error: { code: 'subscription_sharing_invalid_user', message: 'bad token' } });
    }
    if (url.pathname === '/v1/models') {
      return json(res, 200, {
        models: [
          { slug: 'gpt-test', display_name: 'GPT Test', visibility: 'list' },
          { slug: 'gpt-mini', display_name: 'GPT Mini', visibility: 'list' },
          { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' },
        ],
      });
    }
    if (url.pathname === '/v1/responses') {
      const body = JSON.parse(raw) as Record<string, unknown>;
      f.bodies.push(body);
      const mode = f.mode.responses;
      if (mode === 'unauthOnce') {
        f.mode.responses = 'ok';
        return json(res, 401, { error: { code: 'subscription_sharing_invalid_user' } });
      }
      if (mode === 'limit') return json(res, 429, { error: { code: 'subscription_sharing_usage_limit_exceeded' } });
      if (mode === 'ineligible') return json(res, 403, { error: { code: 'subscription_sharing_user_not_eligible' } });
      if (mode === 'rejectText' && body.text) {
        return json(res, 400, {
          error: { code: 'subscription_sharing_unsupported_capability', param: 'text.format', message: 'nope' },
        });
      }
      const input = (body.input as { content: string }[])[0]?.content || '';
      const answer = input.includes('<student_translation>')
        ? GRADE
        : input.includes('连接测试')
          ? { ok: true }
          : { level: '汇总', good: [], issues: [], better: '' };
      const text = JSON.stringify(answer);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const ev = (o: Record<string, unknown>) => `event: ${String(o.type)}\ndata: ${JSON.stringify(o)}\n\n`;
      // 故意把事件拆在两次写入中间，检查按空行分事件的缓冲
      const head =
        ev({ type: 'response.created', response: { id: 'r1' } }) +
        ev({ type: 'response.output_text.delta', delta: text.slice(0, 7) });
      res.write(head.slice(0, head.length - 9));
      await new Promise((r) => setTimeout(r, 5));
      res.write(head.slice(head.length - 9));
      if (mode === 'midfail') {
        res.end(
          ev({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }),
        );
        return;
      }
      if (mode === 'cut') return res.end(ev({ type: 'response.output_text.delta', delta: text.slice(7) }));
      res.write(ev({ type: 'response.output_text.delta', delta: text.slice(7) }));
      res.end(
        ev({
          type: 'response.completed',
          response: { model: String(body.model), usage: { input_tokens: 120, output_tokens: 34 }, output: [] },
        }),
      );
      return;
    }
    json(res, 404, { error: 'not found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return Object.assign(f, {
    base,
    auth: {
      authorize: `${base}/api/accounts/authorize`,
      token: `${base}/api/accounts/oauth/token`,
      jwks: `${base}/.well-known/jwks.json`,
      config: `${base}/.well-known/openid-configuration`,
    },
    api: `${base}/v1`,
    grant(p: { state: string; challenge: string; nonce: string; clientId: string; scope?: string; sub?: string }) {
      const code = `code-${crypto.randomUUID()}`;
      codes.set(code, {
        challenge: p.challenge,
        nonce: p.nonce,
        clientId: p.clientId,
        scope: p.scope ?? `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`,
        sub: p.sub ?? 'user-1',
      });
      return code;
    },
    close: () => server.close(),
  });
}

// ---- 假的 Clash：HTTP CONNECT 代理 -----------------------------------------------------
// 以 .invalid 结尾的域名只有这个代理认识（转到 127.0.0.1），本机直接解析不了：
// 请求要是绕过了隧道直连，就会报“域名解析不了”，测试立刻失败。
const tunnelOnly = (host: string) => (host.endsWith('.invalid') ? '127.0.0.1' : host);

interface FakeProxy {
  url: string;
  connects: string[];
  auths: (string | undefined)[];
  close(): void;
}

async function startProxy(requireAuth?: string): Promise<FakeProxy> {
  const connects: string[] = [];
  const auths: (string | undefined)[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  server.on('connect', (req, client: net.Socket, head: Buffer) => {
    connects.push(String(req.url));
    auths.push(req.headers['proxy-authorization']);
    if (requireAuth && req.headers['proxy-authorization'] !== requireAuth) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }
    const [host = '', port] = String(req.url).split(':');
    const up = net.connect(Number(port), tunnelOnly(host), () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    sockets.add(up).add(client);
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    connects,
    auths,
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

/** 内存里的存储（不经过数据库的单元测试用） */
function memStore(): ChatgptStore & { value: unknown } {
  const m = {
    value: null as unknown,
    get: async () => m.value,
    put: async (v: unknown) => {
      m.value = JSON.parse(JSON.stringify(v));
    },
  };
  return m;
}

/** 模拟浏览器：打开授权链接、同意，返回浏览器最后跳到的回调地址 */
function browserApprove(fake: FakeOpenai, startUrl: string, opts: { scope?: string; sub?: string } = {}): string {
  const u = new URL(startUrl);
  const q = u.searchParams;
  const issued = q.get('client_id') === 'dynamic_agent_client' ? 'oaiapp_test' : String(q.get('client_id'));
  const code = fake.grant({
    state: String(q.get('state')),
    challenge: String(q.get('code_challenge')),
    nonce: String(q.get('nonce')),
    clientId: issued,
    ...opts,
  });
  const back = new URL(REDIRECT_URI);
  back.searchParams.set('code', code);
  back.searchParams.set('state', String(q.get('state')));
  back.searchParams.set('scope', opts.scope ?? `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`);
  if (q.get('client_id') === 'dynamic_agent_client') back.searchParams.set('client_id', issued);
  return back.toString();
}

/** 单元测试用：连好 ChatGPT 的服务（不经过数据库、直接请求假的 OpenAI） */
async function connected(fake: FakeOpenai, cfg: AppConfig, extra: { now?: () => number } = {}) {
  const store = memStore();
  const svc = createChatgpt({ cfg, store, urls: { auth: fake.auth, api: fake.api }, log: quiet, ...extra });
  await svc.load();
  const { url } = await svc.start();
  await svc.finish(browserApprove(fake, url));
  return { svc, store };
}

// ---- 不需要数据库的部分 --------------------------------------------------------------

test('OPENAI_PROXY：只接受 http:// 代理，写错时说明原因', () => {
  assert.equal(parseProxy(''), null);
  assert.equal(parseProxy('http://host.docker.internal:7890')?.port, '7890');
  assert.throws(() => parseProxy('socks5://127.0.0.1:7891'), /http:\/\//);
  assert.throws(() => parseProxy('不是地址'), /不是合法/);
});

test('代理隧道：经过 CONNECT 代理请求，带上代理的用户名密码，回复边到边读', async () => {
  const target = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Path': String(req.url) });
    res.write('第一段');
    setTimeout(() => res.end('第二段'), 20);
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  const port = (target.address() as { port: number }).port;
  const proxy = await startProxy(`Basic ${Buffer.from('u:p w').toString('base64')}`);
  try {
    const f = createOpenaiFetch(proxy.url.replace('http://', 'http://u:p%20w@'));
    // 只有代理认识这个域名：拿到回复就说明请求确实走了隧道
    const r = await f(`http://only-via-proxy.invalid:${port}/v1/x?y=1`, { method: 'POST', body: '{}' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-path'), '/v1/x?y=1');
    assert.equal(await r.text(), '第一段第二段');
    assert.deepEqual(proxy.connects, [`only-via-proxy.invalid:${port}`]);

    // 用户名密码不对：说明是代理拒绝了
    const bad = createOpenaiFetch(proxy.url);
    await assert.rejects(bad(`http://127.0.0.1:${port}/`), /407/);
    // 代理没开：提示检查 Clash
    const off = createOpenaiFetch('http://127.0.0.1:1');
    await assert.rejects(off(`http://127.0.0.1:${port}/`), /Clash/);
  } finally {
    proxy.close();
    target.close();
  }
});

test('代理隧道：超时会中止，错误名是 TimeoutError（和全局 fetch 一样）', async () => {
  const slow = http.createServer(() => {
    // 一直不回复
  });
  await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
  const port = (slow.address() as { port: number }).port;
  const proxy = await startProxy();
  try {
    const f = createOpenaiFetch(proxy.url);
    await assert.rejects(f(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(100) }), {
      name: 'TimeoutError',
    });
  } finally {
    proxy.close();
    slow.closeAllConnections();
    slow.close();
  }
});

/** 临时生成一张自签证书（CI 和本机都有 openssl；没有就跳过 https 的测试） */
async function selfSigned(name: string): Promise<{ key: string; cert: string } | null> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ss-tls-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        `/CN=${name}`,
        '-addext',
        `subjectAltName=DNS:${name}`,
        '-addext',
        'basicConstraints=critical,CA:TRUE',
        '-keyout',
        path.join(dir, 'k.pem'),
        '-out',
        path.join(dir, 'c.pem'),
      ],
      { stdio: 'ignore' },
    );
    return {
      key: await fs.readFile(path.join(dir, 'k.pem'), 'utf8'),
      cert: await fs.readFile(path.join(dir, 'c.pem'), 'utf8'),
    };
  } catch {
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('代理隧道：https 在隧道里握手 TLS（OpenAI 的真实情况），GET 和流式 POST 都通', async (t) => {
  const name = 'secure-openai.invalid';
  const tls = await selfSigned(name);
  if (!tls) return t.skip('没有 openssl');
  const target = https.createServer(tls, (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Host': String(req.headers.host) });
      res.write(`${req.method} ${body}|`);
      setTimeout(() => res.end('完'), 20);
    });
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  const port = (target.address() as { port: number }).port;
  const proxy = await startProxy();
  try {
    const f = createOpenaiFetch(proxy.url, { ca: tls.cert });
    const g = await f(`https://${name}:${port}/.well-known/openid-configuration`);
    assert.equal(g.status, 200);
    assert.equal(g.headers.get('x-host'), `${name}:${port}`);
    assert.equal(await g.text(), 'GET |完');
    const p = await f(`https://${name}:${port}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
    assert.equal(await p.text(), 'POST {"a":1}|完');
    assert.deepEqual(proxy.connects, [`${name}:${port}`, `${name}:${port}`]);
    // 证书不受信任时要报错，不能悄悄降级成明文
    await assert.rejects(createOpenaiFetch(proxy.url)(`https://${name}:${port}/`));
  } finally {
    proxy.close();
    target.close();
  }
});

test('授权链接：第一次注册和重新授权带的参数', () => {
  const first = new URL(
    authorizeUrl({ hostId: 'urn:uuid:h', state: 's1', nonce: 'n1', challenge: 'c1', idTokenHint: 'ignored' }),
  );
  const q = first.searchParams;
  assert.equal(first.origin + first.pathname, `${ISSUER}/api/accounts/authorize`);
  assert.equal(q.get('client_id'), 'dynamic_agent_client');
  assert.equal(q.get('agent_name_hint'), '长难句拆解台');
  assert.equal(q.get('ext_agent_host_id'), 'urn:uuid:h');
  assert.equal(q.get('redirect_uri'), REDIRECT_URI);
  assert.equal(q.get('resource'), API_RESOURCE);
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.ok(q.get('scope')?.split(' ').includes(PLAN_SCOPE));
  assert.equal(q.get('id_token_hint'), null, '第一次注册不带 ID token');
  assert.ok(!first.toString().includes('+'), '空格编码成 %20');

  const again = new URL(
    authorizeUrl({ clientId: 'oaiapp_x', hostId: 'h', state: 's', nonce: 'n', challenge: 'c', idTokenHint: 'tok' }),
  ).searchParams;
  assert.equal(again.get('client_id'), 'oaiapp_x');
  assert.equal(again.get('agent_name_hint'), null);
  assert.equal(again.get('id_token_hint'), 'tok');
});

test('解析粘贴回来的回调地址：整段地址或只有参数都行，粘错时说明原因', () => {
  const full = parseCallback(`${REDIRECT_URI}?code=abc&state=st&client_id=oaiapp_1&scope=openid%20${PLAN_SCOPE}`);
  assert.deepEqual([full.code, full.state, full.clientId], ['abc', 'st', 'oaiapp_1']);
  assert.ok(full.scope.includes(PLAN_SCOPE));
  assert.equal(parseCallback('  ?code=x&state=y  ').code, 'x');
  assert.equal(parseCallback('state=y&error=access_denied').error, 'access_denied');
  assert.throws(() => parseCallback(''), /粘贴/);
  assert.throws(() => parseCallback('https://chatgpt.com/'), /state/);
  assert.throws(() => parseCallback('state=y'), /授权码/);
});

test('ID token：签名、签发方、受众、过期、nonce 都要对', async () => {
  const fake = await startFakeOpenai();
  clearJwksCache();
  try {
    const fetchImpl = createOpenaiFetch('');
    const good = { iss: ISSUER, aud: 'oaiapp_1', sub: 'u1', email: 'a@b.c', nonce: 'n1', exp: Date.now() / 1000 + 600 };
    const expect = { clientId: 'oaiapp_1', nonce: 'n1' };
    const ok = await verifyIdToken(fetchImpl, signJwt(good), expect, fake.auth);
    assert.deepEqual(ok, { sub: 'u1', email: 'a@b.c', name: '' });

    const bad = async (claims: Record<string, unknown>, re: RegExp, kid?: string) =>
      assert.rejects(verifyIdToken(fetchImpl, signJwt({ ...good, ...claims }, kid), expect, fake.auth), re);
    await bad({ iss: 'https://evil.example' }, /签发方/);
    await bad({ aud: 'oaiapp_other' }, /不是发给/);
    await bad({ exp: Date.now() / 1000 - 3600 }, /过期/);
    await bad({ nonce: 'other' }, /nonce/);
    await bad({}, /公钥/, 'unknown-kid');
    const [h, p] = signJwt(good).split('.');
    const forged = `${h}.${p}.${Buffer.from('x'.repeat(256)).toString('base64url')}`;
    await assert.rejects(verifyIdToken(fetchImpl, forged, expect, fake.auth), /签名/);
  } finally {
    fake.close();
  }
});

// ---- 服务本身（内存存储） --------------------------------------------------------------

let fake: FakeOpenai;
const unitCfg = loadConfig({ ACCESS_PASSWORD: 'pw', COOKIE_SECRET: SECRET });

before(async () => {
  fake = await startFakeOpenai();
});
beforeEach(() => {
  fake.mode.responses = 'ok';
  fake.mode.refresh = 'ok';
  fake.mode.expiresIn = 3600;
  clearJwksCache();
});

test('连接：换 token、校验后保存；凭据加密，自动选第一个模型', async () => {
  const { svc, store } = await connected(fake, unitCfg);
  const v = svc.view();
  assert.equal(v.status, 'ok');
  assert.equal(v.email, 'me@example.com');
  assert.equal(v.planGranted, true);
  assert.equal(v.mainModel, 'gpt-test');
  assert.equal(v.ready, true);
  assert.deepEqual(v.use, { grade: true, generate: true, lookup: false });
  const raw = JSON.stringify(store.value);
  assert.ok(!raw.includes(fake.access) && !raw.includes(fake.refresh), '数据库里看不到明文 token');
  assert.match(raw, /"clientId":"oaiapp_test"/);
  assert.match(raw, /"hostId":"urn:uuid:/);
  assert.deepEqual(
    (await svc.models()).map((m) => m.slug),
    ['gpt-test', 'gpt-mini'],
    'visibility 不是 list 的不显示',
  );
});

test('授权链接只能用一次；没同意使用套餐时能连上但不能用', async () => {
  const store = memStore();
  const svc = createChatgpt({ cfg: unitCfg, store, urls: { auth: fake.auth, api: fake.api }, log: quiet });
  await svc.load();
  const { url } = await svc.start();
  const back = browserApprove(fake, url, { scope: 'openid profile email offline_access' });
  const v = await svc.finish(back);
  assert.equal(v.status, 'ok');
  assert.equal(v.planGranted, false);
  assert.equal(v.ready, false);
  await assert.rejects(svc.finish(back), /过期|不是从这里发起/);
  await assert.rejects(svc.finish(`${REDIRECT_URI}?state=nope&error=access_denied`), /过期|不是从这里发起/);
  const again = await svc.start();
  const st = new URL(again.url).searchParams.get('state');
  await assert.rejects(svc.finish(`${REDIRECT_URI}?state=${st}&error=access_denied`), /取消了授权/);
});

test('调用：流式读完、只认 response.completed；请求带 store:false、stream:true，不带 temperature', async () => {
  const { svc } = await connected(fake, unitCfg);
  fake.bodies.length = 0;
  const r = await svc.llm.chatJson({
    prompt: '<student_translation>x</student_translation>',
    model: 'gpt-test',
    temperature: 0.5,
    maxTokens: 10,
  });
  assert.deepEqual(r.data, GRADE);
  assert.equal(r.model, 'chatgpt/gpt-test');
  assert.deepEqual(r.usage, { input: 120, output: 34 });
  const b = fake.bodies[0] as Record<string, unknown>;
  assert.equal(b.store, false);
  assert.equal(b.stream, true);
  assert.ok(!('temperature' in b) && !('max_output_tokens' in b));
  assert.ok(typeof b.instructions === 'string' && !JSON.stringify(b.input).includes('"system"'));
  assert.deepEqual(b.text, { format: { type: 'json_object' } });

  fake.mode.responses = 'cut';
  await assert.rejects(svc.llm.chatJson({ prompt: 'x', model: 'gpt-test' }), (e: LlmError) => e.code === 'upstream');
});

test('不支持 JSON 输出模式时去掉重试，之后也不再带', async () => {
  const { svc } = await connected(fake, unitCfg);
  fake.mode.responses = 'rejectText';
  fake.bodies.length = 0;
  const r = await svc.llm.chatJson({ prompt: '连接测试', model: 'gpt-test' });
  assert.deepEqual(r.data, { ok: true });
  assert.equal(fake.bodies.length, 2);
  await svc.llm.chatJson({ prompt: '连接测试', model: 'gpt-test' });
  assert.equal(fake.bodies.length, 3);
  assert.ok(!('text' in (fake.bodies[2] as object)));
});

test('access token 快过期时先刷新；同时发起的几次请求只刷新一次（refresh token 会轮换）', async () => {
  fake.mode.expiresIn = 30; // 比提前刷新的时间还短：每次调用前都要刷新
  const { svc } = await connected(fake, unitCfg);
  const before = fake.refreshes;
  const rs = await Promise.all(
    Array.from({ length: 5 }, () => svc.llm.chatJson({ prompt: '连接测试', model: 'gpt-test' })),
  );
  assert.equal(rs.length, 5);
  assert.equal(fake.refreshes - before, 1);
});

test('收到 401 时强制刷新一次再试', async () => {
  const { svc } = await connected(fake, unitCfg);
  fake.mode.responses = 'unauthOnce';
  const before = fake.refreshes;
  const r = await svc.llm.chatJson({ prompt: '连接测试', model: 'gpt-test' });
  assert.deepEqual(r.data, { ok: true });
  assert.equal(fake.refreshes - before, 1);
});

test('refresh token 失效：要重新授权，重新授权用原来的 client_id 和 ID token 提示', async () => {
  fake.mode.expiresIn = 30;
  const { svc } = await connected(fake, unitCfg);
  fake.mode.refresh = 'invalid_grant';
  await assert.rejects(svc.llm.chatJson({ prompt: 'x', model: 'gpt-test' }), (e: LlmError) => e.code === 'auth');
  const v = svc.view();
  assert.equal(v.status, 'reauth');
  assert.equal(v.ready, false);
  fake.mode.refresh = 'ok';
  const { url } = await svc.start();
  const q = new URL(url).searchParams;
  assert.equal(q.get('client_id'), 'oaiapp_test');
  assert.ok(q.get('id_token_hint'));
  assert.equal(q.get('login_hint'), 'me@example.com');
  assert.equal((await svc.finish(browserApprove(fake, url))).status, 'ok');

  // 重新授权时换成了别的 ChatGPT 账号：不接受
  fake.mode.expiresIn = 30;
  fake.mode.refresh = 'invalid_grant';
  await assert.rejects(svc.llm.chatJson({ prompt: 'x', model: 'gpt-test' }));
  fake.mode.refresh = 'ok';
  const again = await svc.start();
  await assert.rejects(svc.finish(browserApprove(fake, again.url, { sub: 'someone-else' })), /不是原来那个/);
});

test('额度用完（包括流到一半才报）：暂停，暂停期间不再请求 OpenAI；取消暂停后恢复', async () => {
  let t = Date.now();
  const { svc } = await connected(fake, unitCfg, { now: () => t });
  fake.mode.responses = 'limit';
  await assert.rejects(
    svc.llm.chatJson({ prompt: 'x', model: 'gpt-test' }),
    (e: LlmError) => e.code === 'rate_limited',
  );
  assert.ok(svc.view().pausedUntil);
  assert.equal(svc.view().ready, false);
  const n = fake.bodies.length;
  await assert.rejects(
    svc.llm.chatJson({ prompt: 'x', model: 'gpt-test' }),
    (e: LlmError) => e.code === 'not_configured',
  );
  assert.equal(fake.bodies.length, n, '暂停期间不请求 OpenAI');
  t += 61 * 60 * 1000; // 一小时后自动再试
  assert.equal(svc.view().ready, true);

  fake.mode.responses = 'midfail';
  await assert.rejects(
    svc.llm.chatJson({ prompt: 'x', model: 'gpt-test' }),
    (e: LlmError) => e.code === 'rate_limited',
  );
  assert.ok(svc.view().pausedUntil);
  fake.mode.responses = 'ok';
  assert.equal((await svc.resume()).ready, true);
});

test('账号不能用套餐（不是 Plus / Pro）：标记出来，不再反复请求', async () => {
  const { svc } = await connected(fake, unitCfg);
  fake.mode.responses = 'ineligible';
  await assert.rejects(svc.llm.chatJson({ prompt: 'x', model: 'gpt-test' }), /Plus 或 Pro/);
  assert.equal(svc.view().status, 'ineligible');
  assert.equal(svc.view().ready, false);
  fake.mode.responses = 'ok';
  assert.equal((await svc.resume()).status, 'ok', '升级套餐后可以手动恢复');
});

test('断开：到 OpenAI 吊销 refresh token，删掉凭据，模型和开关设置保留', async () => {
  const { svc, store } = await connected(fake, unitCfg);
  await svc.save({ background: true, use: { lookup: true } });
  const rt = fake.refresh;
  const r = await svc.disconnect();
  assert.equal(r.revoked, true);
  assert.ok(fake.revoked.includes(rt));
  assert.equal(r.view.status, 'none');
  assert.equal(r.view.mainModel, 'gpt-test');
  assert.equal(r.view.background, true);
  assert.equal(r.view.use.lookup, true);
  assert.ok(!/TokenEnc|clientId|"sub"/.test(JSON.stringify(store.value)));
  // 断开后重新连接是全新注册
  const { url } = await svc.start();
  assert.equal(new URL(url).searchParams.get('client_id'), 'dynamic_agent_client');
});

test('按用途和后台开关分流；出错回退到国内模型；回复格式不对不回退', async () => {
  const { svc } = await connected(fake, unitCfg);
  const calls: string[] = [];
  const domestic = {
    ready: () => true,
    models: () => ({ main: 'deepseek-main', light: 'deepseek-light' }),
    listModels: async () => [],
    chatJson: async (o: { model: string }) => {
      calls.push(o.model);
      return { data: { from: 'domestic' }, model: o.model, usage: { input: 1, output: 1 } };
    },
  };
  const route = (kind: 'grade' | 'lookup' | 'generate' | 'review', background = false) =>
    routeLlm({ plan: svc, fallback: domestic, use: { kind, background }, log: quiet });

  assert.equal(route('grade').models().main, 'gpt-test');
  assert.equal(route('review').models().main, 'gpt-test', '谓语复核跟着出题走');
  assert.equal(route('lookup').models().main, 'deepseek-main', '查词默认用国内模型');
  assert.equal(route('generate', true).models().main, 'deepseek-main', '定时出题默认不用 ChatGPT');
  await svc.save({ background: true });
  assert.equal(route('generate', true).models().main, 'gpt-test');

  fake.mode.responses = 'limit';
  const g = route('grade');
  const r = await g.chatJson({ prompt: 'x', model: g.models().main });
  assert.deepEqual(r.data, { from: 'domestic' });
  assert.deepEqual(calls, ['deepseek-main'], 'ChatGPT 的模型名换成国内的主力模型');
  // 已经暂停：直接走国内模型，轻量模型也对应上
  await svc.save({ lightModel: 'gpt-mini' });
  await route('grade').chatJson({ prompt: 'x', model: 'gpt-mini' });
  assert.deepEqual(calls, ['deepseek-main', 'deepseek-light']);

  // ChatGPT 回复了但不是 JSON：不回退，交给调用方重试
  await svc.resume();
  const bad = {
    ...svc,
    llm: {
      ...svc.llm,
      chatJson: async () => {
        throw new LlmError('invalid_json', '格式不对');
      },
    },
  } as ChatgptService;
  await assert.rejects(
    routeLlm({ plan: bad, fallback: domestic, use: { kind: 'grade' } }).chatJson({ prompt: 'x', model: 'gpt-test' }),
    /格式不对/,
  );
});

test('邀请账户：模型设置中心永远不给它 ChatGPT，哪怕它没配国内模型', async () => {
  const { svc } = await connected(fake, unitCfg);
  const ownerLlm = createLlm({ llm: { ...unitCfg.llm } });
  const hub = createSettingsHub(unitCfg, {
    ownerSvc: createSettings(unitCfg, { store: { get: async () => null, put: async () => {} } }),
    ownerLlm,
    createLlm,
    routeOwner: (base, use) => routeLlm({ plan: svc, fallback: base, use, log: quiet }),
  });
  const owner = { id: 'owner', role: 'owner' };
  assert.equal((await hub.llmFor(owner, { kind: 'grade' })).models().main, 'gpt-test');
  assert.equal((await hub.llmFor(owner, { kind: 'grade' })).ready(), true);
  // 邀请账户的配置从数据库读：m-test 在数据库里没有任何模型配置
  const member = { id: 'm-test', role: 'member' };
  for (const kind of ['grade', 'generate', 'review', 'lookup'] as const) {
    const L = await hub.llmFor(member, { kind });
    assert.equal(L.ready(), false, `${kind}：没配模型就是没配，不会退到你的 ChatGPT`);
    assert.notEqual(L.models().main, 'gpt-test');
  }
});

test('标注题库：哪怕是你自己、哪怕所有用途和后台都开着，也永远不走 ChatGPT', async () => {
  // 标注结果所有账户都会用到，而 OpenAI 规定套餐凭据只能用于连接它的这个人自己的请求。这一条不许改
  const { svc } = await connected(fake, unitCfg);
  await svc.save({ use: { grade: true, generate: true, lookup: true }, background: true });
  const sent = fake.bodies.length;
  const calls: string[] = [];
  const domestic = {
    ready: () => true,
    models: () => ({ main: 'deepseek-main', light: 'deepseek-light' }),
    listModels: async () => [],
    chatJson: async (o: { model: string }) => {
      calls.push(o.model);
      return { data: { from: 'domestic' }, model: o.model, usage: { input: 1, output: 1 } };
    },
  };
  for (const background of [false, true]) {
    const L = routeLlm({ plan: svc, fallback: domestic, use: { kind: 'annotate', background }, log: quiet });
    assert.equal(L.models().main, 'deepseek-main');
    assert.deepEqual((await L.chatJson({ prompt: 'x', model: L.models().main })).data, { from: 'domestic' });
  }
  assert.deepEqual(calls, ['deepseek-main', 'deepseek-main']);
  assert.equal(fake.bodies.length, sent, '一次都没有请求 OpenAI');

  // 模型设置中心：你自己的 annotate 拿到的就是国内模型本身，不套 ChatGPT 那一层
  const hub = createSettingsHub(unitCfg, {
    ownerSvc: createSettings(unitCfg, { store: { get: async () => null, put: async () => {} } }),
    ownerLlm: domestic,
    createLlm,
    routeOwner: (base, use) => routeLlm({ plan: svc, fallback: base, use, log: quiet }),
  });
  const owner = { id: 'owner', role: 'owner' };
  assert.equal((await hub.llmFor(owner, { kind: 'grade' })).models().main, 'gpt-test', '改题照常走 ChatGPT');
  assert.equal(await hub.llmFor(owner, { kind: 'annotate' }), domestic);
  assert.equal(await hub.llmFor(owner, { kind: 'annotate', background: true }), domestic);
});

// ---- 整个网站（数据库 + 代理 + 两个账户） ---------------------------------------------------

let db: TestDb, domestic: FakeLlm, memberFake: FakeLlm, proxy: FakeProxy, owner: TestApp, member: TestApp;
let cfg: AppConfig;
let memberSentence = '';

before(async () => {
  db = createTestDb(`sentence_chatgpt_${process.pid}`);
  setQueryImpl(db.query);
  await migrate();
  await importExport(JSON.parse(await fs.readFile(new URL('../seed/export.json', import.meta.url), 'utf8')));
  const grade = (level: string) => () => ({ acc: 20, flu: 15, comp: 15, issues: [], good: [], level, better: '' });
  domestic = await startFakeLlm({ grade: grade('国内批改'), lookup: () => ({ zh: '国内查词' }) });
  memberFake = await startFakeLlm({ grade: grade('邀请账户自己的模型') });
  proxy = await startProxy();
  cfg = loadConfig({ ACCESS_PASSWORD: 'pw-1', COOKIE_SECRET: SECRET, OPENAI_PROXY: proxy.url, DAILY_GENERATE: '0' });
  const llm = createLlm(cfg);
  // 经过假的 Clash 访问假的 OpenAI（OPENAI_PROXY 生效）。地址换成只有代理认识的域名，请求绕过隧道就会失败
  const viaProxy = (u: string) => u.replace('://127.0.0.1:', '://fake-openai.invalid:');
  const chatgpt = createChatgpt({
    cfg,
    urls: {
      auth: {
        authorize: viaProxy(fake.auth.authorize),
        token: viaProxy(fake.auth.token),
        jwks: viaProxy(fake.auth.jwks),
        config: viaProxy(fake.auth.config),
      },
      api: viaProxy(fake.api),
    },
    fallbackReady: () => llm.ready(),
    log: quiet,
  });
  const handler = createApp(cfg, { llm, chatgpt, log: quiet });
  owner = await startApp(handler);
  member = await startApp(handler);
  await owner.api('POST', '/api/unlock', { password: 'pw-1' });
  await owner.api('PUT', '/api/settings/llm', { baseUrl: domestic.url, apiKey: 'k', mainModel: 'fake-main' });

  const inv = (await owner.api('POST', '/api/admin/invites', { note: '朋友' })).body.invite;
  assert.equal((await member.api('POST', '/api/unlock', { password: inv.code })).status, 200);
  await member.api('PUT', '/api/settings/llm', { baseUrl: memberFake.url, apiKey: 'm', mainModel: 'fake-main' });
  const src = await repo.getSentence('owner', 's-20261013-01');
  assert.ok(src);
  memberSentence = `${inv.id}-s-test-1`;
  await repo.insertSentence({
    ...src,
    level: src.level || 'CET-6',
    id: memberSentence,
    created: new Date().toISOString(),
    batch: '2026-10-16',
    source: 'extra',
    accountId: inv.id,
  } as Parameters<typeof repo.insertSentence>[0]);
});

after(() => {
  owner?.close();
  member?.close();
  domestic?.close();
  memberFake?.close();
  proxy?.close();
  fake?.close();
  db?.drop();
});

test('网站：ChatGPT 的接口只有你自己能用', async () => {
  for (const [method, path] of [
    ['GET', '/api/settings/chatgpt'],
    ['PUT', '/api/settings/chatgpt'],
    ['POST', '/api/settings/chatgpt/start'],
    ['POST', '/api/settings/chatgpt/finish'],
    ['POST', '/api/settings/chatgpt/models'],
    ['POST', '/api/settings/chatgpt/test'],
    ['POST', '/api/settings/chatgpt/resume'],
    ['DELETE', '/api/settings/chatgpt'],
  ] as const) {
    assert.equal(
      (await member.api(method, path, method === 'GET' || method === 'DELETE' ? undefined : {})).status,
      403,
      path,
    );
  }
  const v = (await owner.api('GET', '/api/settings/chatgpt')).body;
  assert.equal(v.status, 'none');
  assert.equal(v.proxy, true);
  assert.equal(v.fallbackReady, true);
  assert.equal(db.raw("SELECT count(*) FROM settings WHERE key = 'chatgpt'").trim(), '0', '没连过就不在数据库里存东西');
});

test('网站：连接 ChatGPT（经过代理），你的改题走 ChatGPT，查词走国内模型，邀请账户只用它自己的模型', async () => {
  const start = (await owner.api('POST', '/api/settings/chatgpt/start')).body;
  assert.equal(start.redirectPrefix, REDIRECT_URI);
  const fin = await owner.api('POST', '/api/settings/chatgpt/finish', { callbackUrl: browserApprove(fake, start.url) });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  assert.equal(fin.body.ready, true);
  assert.ok(
    proxy.connects.some((c) => c.startsWith('fake-openai.invalid:')),
    '换 token、取公钥都经过了代理（只有代理认识这个域名）',
  );
  const raw = db.raw("SELECT value::text FROM settings WHERE key = 'chatgpt'");
  assert.ok(!raw.includes(fake.access), '数据库里没有明文 token');

  const sent = fake.bodies.length;
  const g = await owner.api('POST', '/api/grade', { sentenceId: 's-20261013-01', text: '我的译文' });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.equal(g.body.attempt.feedback.level, 'ChatGPT 批改');
  assert.equal(g.body.attempt.model, 'chatgpt/gpt-test');
  assert.equal(fake.bodies.length, sent + 1);

  const domesticCalls = domestic.calls.length;
  const lk = await owner.api('POST', '/api/lookup', { sentenceId: 's-20261013-01', word: 'policy' });
  assert.equal(lk.status, 200, JSON.stringify(lk.body));
  assert.equal(lk.body.data.zh, '国内查词');
  assert.equal(domestic.calls.length, domesticCalls + 1);

  const tokens = (await owner.api('GET', '/api/usage/tokens?days=7')).body;
  assert.ok(
    tokens.byModel.some((m: { model: string }) => m.model === 'chatgpt/gpt-test'),
    'Token 用量页能分开看到 ChatGPT 的用量',
  );

  // 邀请账户：只用它自己配的模型，你的 ChatGPT 一次都没被请求
  const before = fake.bodies.length;
  const mg = await member.api('POST', '/api/grade', { sentenceId: memberSentence, text: '朋友的译文' });
  assert.equal(mg.status, 200, JSON.stringify(mg.body));
  assert.equal(mg.body.attempt.feedback.level, '邀请账户自己的模型');
  assert.equal(fake.bodies.length, before);
  assert.ok(memberFake.calls.every((c) => c.auth === 'Bearer m'));
});

test('网站：额度用完时这次改题自动改用国内模型，设置页显示暂停；测试连接成功会取消暂停', async () => {
  fake.mode.responses = 'limit';
  const g = await owner.api('POST', '/api/grade', { sentenceId: 's-20261013-01', text: '第二次' });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.equal(g.body.attempt.feedback.level, '国内批改');
  const v = (await owner.api('GET', '/api/settings/chatgpt')).body;
  assert.ok(v.pausedUntil);
  assert.equal(v.ready, false);
  assert.equal((await owner.api('GET', '/api/usage')).body.aiReady, true, '还有国内模型可用');

  fake.mode.responses = 'ok';
  const t = (await owner.api('POST', '/api/settings/chatgpt/test')).body;
  assert.equal(t.ok, true, JSON.stringify(t));
  assert.equal(t.results[0].answeredBy, 'chatgpt/gpt-test');
  assert.equal((await owner.api('GET', '/api/settings/chatgpt')).body.ready, true);
});

test('网站：保存设置、取模型列表、断开', async () => {
  const s = await owner.api('PUT', '/api/settings/chatgpt', {
    mainModel: 'gpt-mini',
    use: { grade: false, generate: true },
    background: true,
  });
  assert.equal(s.status, 200);
  assert.equal(s.body.mainModel, 'gpt-mini');
  assert.deepEqual(s.body.use, { grade: false, generate: true, lookup: false });
  const g = await owner.api('POST', '/api/grade', { sentenceId: 's-20261013-01', text: '第三次' });
  assert.equal(g.body.attempt.feedback.level, '国内批改', '改题的开关关了就用国内模型');

  const m = await owner.api('POST', '/api/settings/chatgpt/models');
  assert.deepEqual(
    m.body.models.map((x: { slug: string }) => x.slug),
    ['gpt-test', 'gpt-mini'],
  );
  const bad = await owner.api('POST', '/api/settings/chatgpt/finish', { callbackUrl: 'https://example.com/' });
  assert.equal(bad.status, 400);

  const d = await owner.api('DELETE', '/api/settings/chatgpt');
  assert.equal(d.status, 200);
  assert.equal(d.body.revoked, true);
  assert.equal(d.body.view.status, 'none');
  assert.equal((await owner.api('POST', '/api/settings/chatgpt/test')).status, 400);
});
