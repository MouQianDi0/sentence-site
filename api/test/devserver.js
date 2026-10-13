// 开发用：一个进程里同时跑 API（数据库走本机 psql）、静态页面和假的大模型接口。
// 用法：node test/devserver.js   然后打开 http://127.0.0.1:3100 ，密码 dev-password
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setQueryImpl } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createLlm } from '../src/llm.js';
import * as repo from '../src/repo.js';
import { importExport } from '../src/importer.js';
import { createTestDb, startFakeLlm } from './helpers.js';

const PORT = Number(process.env.DEV_PORT || 3100);
const WEB = new URL('../../web/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const db = createTestDb('sentence_dev');
setQueryImpl(db.query);
await repo.ensureSchema(await fs.readFile(new URL('../src/schema.sql', import.meta.url), 'utf8'));
await importExport(JSON.parse(await fs.readFile(new URL('../seed/export.json', import.meta.url), 'utf8')));

const fake = await startFakeLlm({
  grade: (prompt) => {
    const text = /<student_translation>\n([\s\S]*?)\n<\/student_translation>/.exec(prompt)?.[1] || '';
    const piece = text.slice(0, Math.min(4, text.length));
    return {
      acc: 31, flu: 22, comp: 26,
      level: '意思基本对，语序还可以更自然',
      good: ['主干理解正确'],
      issues: piece ? [{ src: piece, type: '用词', why: '这里可以说得更地道', fix: '改进后' }] : [],
      better: `改进后${text.slice(piece.length)}`,
    };
  },
  lookup: () => ({ lemma: 'example', ipa: '/ɪɡˈzæmpəl/', pos: 'n.', zh: '例子（假模型）', more: '榜样；样本' }),
  generate: () => ({ sentences: [] }),
});

// DEV_NO_LLM=1：模拟还没配置模型，在网页“设置”里填写（接口地址见下面打印的 fake llm）
const cfg = loadConfig({
  ACCESS_PASSWORD: 'dev-password',
  COOKIE_SECRET: 'd'.repeat(64),
  ...(process.env.DEV_NO_LLM ? {} : { LLM_BASE_URL: fake.url, LLM_API_KEY: 'dev', LLM_MODEL_MAIN: 'fake-main' }),
});
console.log(`fake llm ${fake.url}`);
const handle = createApp(cfg, { llm: createLlm(cfg), log: { log() {}, error: console.error, warn() {} } });

http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) return handle(req, res);
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(WEB, rel === '/' ? 'index.html' : rel);
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`dev server http://127.0.0.1:${PORT}`));

process.on('SIGTERM', () => {
  fake.close();
  db.drop();
  process.exit(0);
});
