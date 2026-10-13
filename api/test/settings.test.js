// 模型设置：网页保存、加密存储、立即生效、测试连接、模型列表、恢复 .env
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setQueryImpl } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createLlm } from '../src/llm.js';
import { normalizeBaseUrl } from '../src/settings.js';
import { encrypt, decrypt, maskKey } from '../src/secret.js';
import * as repo from '../src/repo.js';
import { importExport } from '../src/importer.js';
import { createTestDb, startFakeLlm, startApp } from './helpers.js';

const quiet = { log() {}, error() {}, warn() {} };
let db, fake, app, cfg;

before(async () => {
  db = createTestDb(`sentence_settings_${process.pid}`);
  setQueryImpl(db.query);
  await repo.ensureSchema(await fs.readFile(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  await importExport(JSON.parse(await fs.readFile(new URL('../seed/export.json', import.meta.url), 'utf8')));
  fake = await startFakeLlm({
    grade: () => ({ acc: 30, flu: 20, comp: 20, issues: [], good: [], level: 'ok', better: '' }),
    lookup: () => ({ zh: '测试' }),
    generate: () => ({ sentences: [] }),
  });
  // 和服务器第一次部署时一样：.env 里没有模型配置
  cfg = loadConfig({ ACCESS_PASSWORD: 'pw-123', COOKIE_SECRET: 'z'.repeat(64) });
  app = await startApp(createApp(cfg, { llm: createLlm(cfg), log: quiet }));
  await app.api('POST', '/api/unlock', { password: 'pw-123' });
});

after(() => {
  app?.close();
  fake?.close();
  db?.drop();
});

test('密钥加密和打码', () => {
  const enc = encrypt('sk-abcdef123456', 's'.repeat(40));
  assert.ok(!enc.includes('abcdef'));
  assert.equal(decrypt(enc, 's'.repeat(40)), 'sk-abcdef123456');
  assert.equal(decrypt(enc, 'other'.repeat(10)), null);
  assert.equal(maskKey('sk-abcdef123456'), 'sk-…3456');
  assert.equal(maskKey('short'), '••••');
});

test('接口地址会被整理', () => {
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1');
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/v1/chat/completions'), 'https://api.deepseek.com/v1');
  assert.throws(() => normalizeBaseUrl('api.deepseek.com'), /http/);
});

test('设置接口需要先输密码', async () => {
  const r = await fetch(`${app.base}/api/settings/llm`);
  assert.equal(r.status, 401);
});

test('一开始没有配置', async () => {
  const v = (await app.api('GET', '/api/settings/llm')).body;
  assert.equal(v.source, 'none');
  assert.equal(v.ready, false);
  assert.equal(v.hasKey, false);
  assert.equal((await app.api('GET', '/api/usage')).body.aiReady, false);
  assert.equal((await app.api('POST', '/api/grade', { sentenceId: 's-20261013-01', text: '译文' })).status, 503);
});

test('获取模型列表：密钥错误时提示，正确时返回列表', async () => {
  const bad = await app.api('POST', '/api/settings/llm/models', { baseUrl: fake.url, apiKey: 'bad-key' });
  assert.equal(bad.status, 502);
  assert.match(bad.body.error, /密钥/);
  const ok = await app.api('POST', '/api/settings/llm/models', { baseUrl: fake.url, apiKey: 'good-key' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.models, ['another', 'fake-light', 'fake-main']);
});

test('测试连接：没保存也能测，分别测主力和轻量模型', async () => {
  const r = await app.api('POST', '/api/settings/llm/test', { baseUrl: `${fake.url}/`, apiKey: 'good-key', mainModel: 'fake-main', lightModel: 'fake-light', jsonMode: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.results.map((x) => x.model), ['fake-main', 'fake-light']);
  const bad = await app.api('POST', '/api/settings/llm/test', { baseUrl: fake.url, apiKey: 'bad-key', mainModel: 'fake-main' });
  assert.equal(bad.body.ok, false);
  assert.match(bad.body.results[0].error, /密钥/);
  assert.equal((await app.api('GET', '/api/settings/llm')).body.source, 'none', '测试不会保存');
});

test('保存：密钥加密入库，返回时打码，立即生效', async () => {
  const missing = await app.api('PUT', '/api/settings/llm', { baseUrl: fake.url, mainModel: 'fake-main' });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /密钥/);

  const r = await app.api('PUT', '/api/settings/llm', { baseUrl: fake.url, apiKey: 'sk-secret-998877', mainModel: 'fake-main', lightModel: '', jsonMode: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'page');
  assert.equal(r.body.ready, true);
  assert.equal(r.body.keyHint, 'sk-…8877');
  assert.ok(!JSON.stringify(r.body).includes('secret-998877'));

  const stored = db.raw("SELECT value::text FROM settings WHERE key = 'llm'");
  assert.ok(!stored.includes('secret-998877'), '数据库里不是明文');

  assert.equal((await app.api('GET', '/api/usage')).body.aiReady, true);
  const g = await app.api('POST', '/api/grade', { sentenceId: 's-20261013-01', text: '一段译文' });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.equal(fake.calls.at(-1).auth, 'Bearer sk-secret-998877');
});

test('只改模型时可以不重新填密钥', async () => {
  const r = await app.api('PUT', '/api/settings/llm', { baseUrl: fake.url, apiKey: '', mainModel: 'another', lightModel: 'fake-light', jsonMode: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.mainModel, 'another');
  assert.equal(r.body.lightModel, 'fake-light');
  assert.equal(r.body.jsonMode, false);
  assert.equal(r.body.keyHint, 'sk-…8877');
  await app.api('POST', '/api/grade', { sentenceId: 's-20261013-01', text: '再来一段' });
  const call = fake.calls.at(-1);
  assert.equal(call.data.model, 'another');
  assert.equal(call.data.response_format, undefined, '关掉 JSON 模式后不再发送 response_format');
});

test('重启后从数据库读回配置', async () => {
  const cfg2 = loadConfig({ ACCESS_PASSWORD: 'pw-123', COOKIE_SECRET: 'z'.repeat(64) });
  const app2 = await startApp(createApp(cfg2, { llm: createLlm(cfg2), log: quiet }));
  await app2.api('POST', '/api/unlock', { password: 'pw-123' });
  const v = (await app2.api('GET', '/api/settings/llm')).body;
  assert.equal(v.source, 'page');
  assert.equal(v.mainModel, 'another');
  assert.equal(v.keyHint, 'sk-…8877');
  app2.close();
});

test('改了 COOKIE_SECRET 后提示密钥需要重填', async () => {
  const cfg3 = loadConfig({ ACCESS_PASSWORD: 'pw-123', COOKIE_SECRET: 'q'.repeat(64) });
  const app3 = await startApp(createApp(cfg3, { llm: createLlm(cfg3), log: quiet }));
  await app3.api('POST', '/api/unlock', { password: 'pw-123' });
  const v = (await app3.api('GET', '/api/settings/llm')).body;
  assert.equal(v.keyBroken, true);
  assert.equal(v.ready, false);
  app3.close();
});

test('改回使用 .env：不再用网页配置，但各平台保存的配置还在；单独删除某个平台', async () => {
  const r = await app.api('DELETE', '/api/settings/llm');
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'none');
  assert.equal(r.body.providers.custom.saved, true, '保存的配置保留');
  assert.equal((await app.api('GET', '/api/usage')).body.aiReady, false);
  const d = await app.api('DELETE', '/api/settings/llm?provider=custom');
  assert.equal(d.body.providers.custom, undefined);
  assert.equal(db.raw("SELECT count(*) FROM settings").trim(), '0');
  assert.equal((await app.api('DELETE', '/api/settings/llm?provider=nope')).status, 400);
});

test('.env 里有配置时显示来源为 .env，网页配置优先', async () => {
  const cfg4 = loadConfig({ ACCESS_PASSWORD: 'pw-123', COOKIE_SECRET: 'z'.repeat(64), LLM_BASE_URL: fake.url, LLM_API_KEY: 'env-key-0001', LLM_MODEL_MAIN: 'fake-main' });
  const app4 = await startApp(createApp(cfg4, { llm: createLlm(cfg4), log: quiet }));
  await app4.api('POST', '/api/unlock', { password: 'pw-123' });
  const v = (await app4.api('GET', '/api/settings/llm')).body;
  assert.equal(v.source, 'env');
  assert.equal(v.envAvailable, true);
  // 不填密钥就保存：沿用 .env 的密钥
  const s = await app4.api('PUT', '/api/settings/llm', { baseUrl: fake.url, mainModel: 'fake-light' });
  assert.equal(s.body.source, 'page');
  assert.equal(s.body.keyHint, 'env-…0001');
  const back = await app4.api('DELETE', '/api/settings/llm');
  assert.equal(back.body.source, 'env');
  assert.equal(back.body.mainModel, 'fake-main');
  app4.close();
});

// ---- 深度思考 ------------------------------------------------------------------
import { thinkingOffParams } from '../src/llm.js';

function stubFetch(responses) {
  const sent = [];
  const fn = async (url, init) => {
    sent.push(JSON.parse(init.body));
    const r = responses[Math.min(sent.length - 1, responses.length - 1)];
    return new Response(JSON.stringify(r.body), { status: r.status || 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fn, sent };
}
const okBody = { choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] };
const llmCfg = (over) => ({ llm: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', mainModel: 'deepseek-v4-pro', lightModel: 'deepseek-flash', jsonMode: true, thinking: false, timeoutMs: 5000, ...over } });

test('关闭思考的参数按平台区分', () => {
  assert.deepEqual(thinkingOffParams('https://api.deepseek.com/v1'), { thinking: { type: 'disabled' } });
  assert.deepEqual(thinkingOffParams('https://open.bigmodel.cn/api/paas/v4'), { thinking: { type: 'disabled' } });
  assert.deepEqual(thinkingOffParams('https://dashscope.aliyuncs.com/compatible-mode/v1'), { enable_thinking: false });
});

test('默认关闭深度思考：带上关闭参数和 max_tokens', async () => {
  const { fn, sent } = stubFetch([{ body: okBody }]);
  const r = await createLlm(llmCfg(), fn).chatJson({ prompt: 'x', model: 'deepseek-v4-pro', maxTokens: 300 });
  assert.deepEqual(r.data, { ok: true });
  assert.deepEqual(sent[0].thinking, { type: 'disabled' });
  assert.equal(sent[0].max_tokens, 300);
  assert.deepEqual(sent[0].response_format, { type: 'json_object' });
});

test('打开深度思考：不传关闭参数，也不限制 max_tokens', async () => {
  const { fn, sent } = stubFetch([{ body: okBody }]);
  await createLlm(llmCfg({ thinking: true }), fn).chatJson({ prompt: 'x', model: 'deepseek-v4-pro', maxTokens: 300 });
  assert.equal('thinking' in sent[0], false);
  assert.equal('max_tokens' in sent[0], false);
});

test('平台不认识关闭参数（400）时去掉再试，之后不再传', async () => {
  const { fn, sent } = stubFetch([{ status: 400, body: { error: { message: 'Unrecognized request argument supplied: thinking' } } }, { body: okBody }]);
  const llm = createLlm(llmCfg({ baseUrl: 'https://example.com/v1' }), fn);
  await llm.chatJson({ prompt: 'x', model: 'm' });
  await llm.chatJson({ prompt: 'x', model: 'm' });
  assert.equal(sent.length, 3);
  assert.ok('thinking' in sent[0]);
  assert.equal('thinking' in sent[1], false);
  assert.equal('thinking' in sent[2], false);
});

test('回复额度被思考用完时给出明确原因', async () => {
  const { fn } = stubFetch([{ body: { choices: [{ message: { content: '', reasoning_content: '嗯……' }, finish_reason: 'length' }] } }]);
  await assert.rejects(createLlm(llmCfg(), fn).chatJson({ prompt: 'x', model: 'm' }), (e) => e.code === 'invalid_json' && e.why === 'thinking' && /深度思考/.test(e.message));
});

test('测试连接：默认会思考的模型关掉思考后能通过，关不掉的给出换模型的提示', async () => {
  const base = { baseUrl: fake.url, apiKey: 'good-key', jsonMode: true };
  let r = await app.api('POST', '/api/settings/llm/test', { ...base, mainModel: 'think-default', lightModel: '' });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  r = await app.api('POST', '/api/settings/llm/test', { ...base, mainModel: 'think-only', lightModel: '' });
  assert.equal(r.body.ok, false);
  assert.match(r.body.results[0].error, /关不掉深度思考/);
  r = await app.api('POST', '/api/settings/llm/test', { ...base, mainModel: 'think-default', lightModel: '', thinking: true });
  assert.equal(r.body.ok, true, '开着思考时不限制长度，也能拿到答案');
  const last = fake.calls.at(-1).data;
  assert.equal('thinking' in last, false);
  assert.equal('max_tokens' in last, false);
});

test('测试连接：JSON 模式关着时提示打开它，并带上模型的原话', async () => {
  const strictFake = await startFakeLlm({ ping: () => '好的，收到', grade: () => ({}), lookup: () => ({}), generate: () => ({}) });
  try {
    const r = await app.api('POST', '/api/settings/llm/test', { baseUrl: strictFake.url, apiKey: 'good-key', mainModel: 'plain', lightModel: '', jsonMode: false });
    assert.equal(r.body.ok, false);
    assert.match(r.body.results[0].error, /打开“JSON 输出模式”/);
    assert.equal(r.body.results[0].sample, '好的，收到');
  } finally {
    strictFake.close();
  }
});

test('深度思考开关会保存，重新读取后还在', async () => {
  let r = await app.api('PUT', '/api/settings/llm', { baseUrl: fake.url, apiKey: 'good-key', mainModel: 'fake-main', lightModel: '', jsonMode: true, thinking: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.thinking, true);
  assert.equal(cfg.llm.thinking, true);
  r = await app.api('PUT', '/api/settings/llm', { mainModel: 'fake-main', thinking: false });
  assert.equal(r.body.thinking, false);
  assert.equal(cfg.llm.thinking, false);
  r = await app.api('GET', '/api/settings/llm');
  assert.equal(r.body.thinking, false);
});

test('严格接口（不认识 thinking 参数）也能正常批改', async () => {
  const strict = await startFakeLlm({ strict: true, ping: () => ({ ok: true }), grade: () => ({}), lookup: () => ({}), generate: () => ({}) });
  try {
    const r = await app.api('POST', '/api/settings/llm/test', { baseUrl: strict.url, apiKey: 'good-key', mainModel: 'm', lightModel: '' });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
  } finally {
    strict.close();
  }
});

// ---- 每个平台单独保存密钥 --------------------------------------------------------
test('每个平台单独保存密钥和模型，切换平台不用重新填', async () => {
  let r = await app.api('PUT', '/api/settings/llm', { provider: 'qwen', baseUrl: fake.url, apiKey: 'qwen-key-1111', mainModel: 'fake-main', lightModel: 'fake-light' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await app.api('PUT', '/api/settings/llm', { provider: 'kimi', baseUrl: fake.url, apiKey: 'kimi-key-2222', mainModel: 'another', lightModel: '' });
  assert.equal(r.body.provider, 'kimi');
  assert.equal(r.body.providerName, 'Kimi');
  assert.equal(r.body.providers.qwen.keyHint, 'qwen-…1111');
  assert.equal(r.body.providers.kimi.keyHint, 'kimi-…2222');
  assert.equal(r.body.providers.qwen.lightModel, 'fake-light');
  await app.api('POST', '/api/grade', { sentenceId: 's-20261013-01', text: '一段译文' });
  assert.equal(fake.calls.at(-1).auth, 'Bearer kimi-key-2222');
  assert.equal(fake.calls.at(-1).data.model, 'another');

  // 只传平台：用它保存的配置切换过去
  r = await app.api('PUT', '/api/settings/llm', { provider: 'qwen' });
  assert.equal(r.body.provider, 'qwen');
  assert.equal(r.body.mainModel, 'fake-main');
  await app.api('POST', '/api/grade', { sentenceId: 's-20261013-01', text: '另一段译文' });
  assert.equal(fake.calls.at(-1).auth, 'Bearer qwen-key-1111');
  assert.equal(r.body.providers.kimi.keyHint, 'kimi-…2222', '另一个平台的配置不受影响');
});

test('没存过密钥的平台不会借用别的平台的密钥', async () => {
  const r = await app.api('PUT', '/api/settings/llm', { provider: 'glm', baseUrl: fake.url, mainModel: 'fake-main' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /智谱 GLM 的 API 密钥/);
  const t = await app.api('POST', '/api/settings/llm/test', { provider: 'glm', baseUrl: fake.url, mainModel: 'fake-main' });
  assert.equal(t.status, 400);
  const m = await app.api('POST', '/api/settings/llm/models', { provider: 'glm', baseUrl: fake.url });
  assert.equal(m.status, 400);
  assert.equal(fake.calls.filter((c) => c.auth === 'Bearer qwen-key-1111' && c.path.endsWith('/models')).length, 0);
});

test('改了接口地址的域名时必须重新填密钥', async () => {
  const other = 'http://localhost:9/v1';
  for (const path of ['/api/settings/llm/test', '/api/settings/llm/models']) {
    const r = await app.api('POST', path, { provider: 'qwen', baseUrl: other, mainModel: 'fake-main' });
    assert.equal(r.status, 400, path);
    assert.match(r.body.error, /接口地址换了/);
  }
  const s = await app.api('PUT', '/api/settings/llm', { provider: 'qwen', baseUrl: other, mainModel: 'fake-main' });
  assert.equal(s.status, 400);
  // 同一个地址只改模型：沿用密钥
  const ok = await app.api('PUT', '/api/settings/llm', { provider: 'qwen', baseUrl: `${fake.url}/`, mainModel: 'another' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.providers.qwen.keyHint, 'qwen-…1111');
});

test('删除正在使用的平台后不再使用网页配置，其他平台还在', async () => {
  const r = await app.api('DELETE', '/api/settings/llm?provider=qwen');
  assert.equal(r.body.source, 'none');
  assert.equal(r.body.providers.qwen, undefined);
  assert.equal(r.body.providers.kimi.saved, true);
  const back = await app.api('PUT', '/api/settings/llm', { provider: 'kimi' });
  assert.equal(back.body.ready, true);
});

test('旧格式（只有一份配置）会按接口地址升级到对应平台', async () => {
  await repo.putSetting('llm', { baseUrl: 'https://api.deepseek.com/v1', mainModel: 'deepseek-chat', lightModel: '', jsonMode: true, apiKeyEnc: encrypt('sk-old-key-123456', 'z'.repeat(64)), updatedAt: '2026-10-13T00:00:00.000Z' });
  const cfg5 = loadConfig({ ACCESS_PASSWORD: 'pw-123', COOKIE_SECRET: 'z'.repeat(64) });
  const app5 = await startApp(createApp(cfg5, { llm: createLlm(cfg5), log: quiet }));
  await app5.api('POST', '/api/unlock', { password: 'pw-123' });
  const v = (await app5.api('GET', '/api/settings/llm')).body;
  assert.equal(v.source, 'page');
  assert.equal(v.provider, 'deepseek');
  assert.equal(v.providers.deepseek.keyHint, 'sk-…3456');
  assert.equal(cfg5.llm.apiKey, 'sk-old-key-123456');
  const raw = JSON.parse(db.raw("SELECT value::text FROM settings WHERE key = 'llm'"));
  assert.equal(raw.v, 2);
  assert.equal(raw.active, 'deepseek');
  app5.close();
});
