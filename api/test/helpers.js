// 测试工具：用本机 psql 代替 pg 驱动（开发环境装不了 npm 包），外加一个假的大模型接口。
import { execFileSync } from 'node:child_process';
import http from 'node:http';

const PG = {
  host: process.env.TEST_PGHOST || '/var/tmp/sspg',
  port: process.env.TEST_PGPORT || '54329',
  user: process.env.TEST_PGUSER || 'postgres',
};

function psql(db, sql) {
  try {
    return execFileSync(
      'psql',
      ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-h', PG.host, '-p', PG.port, '-U', PG.user, '-d', db, '-c', sql],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    const msg = String(e.stderr || e.message);
    const err = new Error(msg.trim());
    const m = /ERROR:\s+([0-9A-Z]{5}):/.exec(msg);
    if (m) err.code = m[1];
    throw err;
  }
}

function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') v = JSON.stringify(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

export function createTestDb(name = `sentence_test_${process.pid}`) {
  psql('postgres', `DROP DATABASE IF EXISTS ${name}`);
  psql('postgres', `CREATE DATABASE ${name}`);
  const query = async (text, params = []) => {
    const sql = text.replace(/\$(\d+)/g, (_, n) => lit(params[Number(n) - 1])).trim();
    if (/^(select|with)\b/i.test(sql)) {
      const rows = JSON.parse(psql(name, `SELECT coalesce(json_agg(t), '[]'::json) FROM (${sql}) t`).trim() || '[]');
      return { rows, rowCount: rows.length };
    }
    if (/^(insert|update|delete)\b/i.test(sql)) {
      if (/\breturning\b/i.test(sql)) {
        const rows = JSON.parse(psql(name, `WITH t AS (${sql}) SELECT coalesce(json_agg(t), '[]'::json) FROM t`).trim() || '[]');
        return { rows, rowCount: rows.length };
      }
      const n = Number(psql(name, `WITH t AS (${sql} RETURNING 1) SELECT count(*) FROM t`).trim());
      return { rows: [], rowCount: n };
    }
    psql(name, sql);
    return { rows: [], rowCount: 0 };
  };
  const drop = () => psql('postgres', `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  return { query, drop, raw: (sql) => psql(name, sql) };
}

/** 假的 OpenAI 兼容接口：根据提示词内容返回批改 / 查词 / 出题结果 */
export function startFakeLlm(handlers) {
  const calls = [];
  const server = http.createServer((req, res) => {
    if (req.headers.authorization === 'Bearer bad-key') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
      return;
    }
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      calls.push({ path: req.url, auth: req.headers.authorization });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-main' }, { id: 'fake-light' }, { id: 'another' }] }));
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const data = JSON.parse(body);
      const prompt = data.messages.at(-1).content;
      calls.push({ path: req.url, auth: req.headers.authorization, data, prompt });
      const kind = prompt.includes('<student_translation>') ? 'grade' : prompt.includes('解释英文单词') ? 'lookup' : prompt.includes('连接测试') ? 'ping' : prompt.includes('逐句核对句子里') ? 'review' : 'generate';
      if (kind === 'ping' && !handlers.ping) handlers.ping = () => ({ ok: true });
      // 没指定时，复核一律回复“没有意见”，句子保持原样
      if (kind === 'review' && !handlers.review) handlers.review = () => ({ items: [] });
      // 模拟不认识 thinking 参数的严格接口
      if (handlers.strict && ('thinking' in data || 'enable_thinking' in data)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: thinking' } }));
        return;
      }
      // 模拟默认会深度思考的模型（像 DeepSeek 新模型）：think-default 没关思考时回复额度全花在思考上；think-only 关不掉
      const thinkingOn = data.model === 'think-only' || (data.model === 'think-default' && data.thinking?.type !== 'disabled');
      if (thinkingOn && data.max_tokens && data.max_tokens < 500) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model: data.model, choices: [{ message: { content: '', reasoning_content: '用户让我回复一个 JSON……' }, finish_reason: 'length' }] }));
        return;
      }
      const out = handlers[kind](prompt, data);
      if (out && out.status) {
        res.writeHead(out.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.body || {}));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: data.model,
        choices: [{ message: { content: typeof out === 'string' ? out : JSON.stringify(out) } }],
        usage: { prompt_tokens: 700, completion_tokens: 600 },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}/v1`, calls, handlers, close: () => server.close() });
    });
  });
}

/** opts.ua：模拟的浏览器信息（User-Agent） */
export async function startApp(handler, { ua = '' } = {}) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = new Map(); // 像浏览器一样记住多个 Cookie
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const api = async (method, path, body, { auth = true } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(ua ? { 'User-Agent': ua } : {}),
        ...(auth && jar.size ? { Cookie: cookieHeader() } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (!value || attrs.some((a) => /max-age=0\b/i.test(a.trim()))) jar.delete(name);
      else jar.set(name, value);
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
  return {
    api,
    base,
    close: () => server.close(),
    setCookie: (c) => {
      jar.clear();
      const i = c.indexOf('=');
      if (i > 0) jar.set(c.slice(0, i), c.slice(i + 1));
    },
    /** 模拟清除浏览器数据：丢掉所有 Cookie */
    clearCookies: () => jar.clear(),
    cookies: () => Object.fromEntries(jar),
  };
}
