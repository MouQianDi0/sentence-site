// 开发用：一个进程里同时跑 API（数据库走本机 psql）、假的大模型接口，以及构建好的页面（web/dist）。
// 用法：npm run dev:demo，然后二选一：
//   - 改前端时：另开一个终端 API_URL=http://127.0.0.1:3100 npm run dev，打开 http://127.0.0.1:5173（改了代码页面自动刷新）
//   - 看构建结果：先 npm run build，再打开 http://127.0.0.1:3100
// 密码 dev-password。数据库连接方式见 helpers.ts。
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setQueryImpl } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { createLlm } from '../src/llm.ts';
import * as repo from '../src/repo.ts';
import { importExport } from '../src/importer.ts';
import { createTestDb, startFakeLlm } from './helpers.ts';

const PORT = Number(process.env.DEV_PORT || 3100);
const WEB = new URL('../../web/dist/', import.meta.url).pathname;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const db = createTestDb('sentence_dev');
setQueryImpl(db.query);
await repo.ensureSchema(await fs.readFile(new URL('../src/schema.sql', import.meta.url), 'utf8'));
await importExport(JSON.parse(await fs.readFile(new URL('../seed/export.json', import.meta.url), 'utf8')));

let devSeq = 0;
const TOPIC = [
  'remote work',
  'online courses',
  'city parks',
  'sleep habits',
  'electric cars',
  'museum visits',
  'part-time jobs',
  'social media',
];
const devSentence = (level: string, i: number) => {
  const topic = TOPIC[i % TOPIC.length];
  return {
    level,
    focus: level === 'CET-6' ? '让步从句 + 定语从句' : '让步状语从句',
    segs: [
      {
        r: 'adv',
        t: `Although ${topic} ^offers^ obvious benefits,`,
        n: '让步状语从句，译成“尽管……”。',
        k: 'adv_concession',
      },
      { r: 'main', t: 'many students *still worry about*', n: '主句主语和谓语。', k: 'main' },
      { r: 'main', t: 'the hidden costs', n: '宾语。', k: 'main' },
      {
        r: 'attr',
        t: `that ^are^ rarely discussed in public debates about ${topic} (${i}).`,
        n: '定语从句，修饰 costs。',
        k: 'attr_r',
      },
    ],
    trunk: 'Many students still worry about the hidden costs.',
    trunkZh: '许多学生仍然担心隐性成本。',
    trap: '',
    tip: '让步从句放在句首，译成“尽管……，但……”。',
    ref: `尽管${topic}好处明显，但许多学生仍然担心那些在公开讨论中很少被提及的隐性成本。`,
    opts: [
      {
        t: `尽管${topic}好处明显，但许多学生仍然担心那些在公开讨论中很少被提及的隐性成本。`,
        ok: true,
        why: '结构清楚，表达自然。',
      },
      { t: '虽然它提供明显的好处，许多学生仍然担心隐藏的成本那些很少被讨论。', ok: false, why: '逐词硬译，语序别扭。' },
      { t: '它的好处很明显，所以学生不担心成本。', ok: false, why: '理解反了让步关系。' },
    ],
    words: [{ w: 'hidden', lemma: 'hidden', pos: 'adj.', zh: '隐藏的' }],
    phrases: [{ m: 'worry about', p: 'worry about', zh: '担心' }],
  };
};

/** 假批改：把译文开头几个字标成“用词”问题。评分和汇总批注都用它（汇总只要文字） */
const demoFeedback = (prompt: string) => {
  const text = /<student_translation>\n([\s\S]*?)\n<\/student_translation>/.exec(prompt)?.[1] || '';
  const piece = text.slice(0, Math.min(4, text.length));
  return {
    level: '意思基本对，语序还可以更自然',
    good: ['主干理解正确'],
    issues: piece ? [{ src: piece, type: '用词', why: '这里可以说得更地道', fix: '改进后' }] : [],
    better: `改进后${text.slice(piece.length)}`,
  };
};

const fake = await startFakeLlm({
  // 后台几次评分的分数略有出入，取平均
  grade: (prompt) => ({ acc: 29 + Math.floor(Math.random() * 5), flu: 22, comp: 26, ...demoFeedback(prompt) }),
  summary: (prompt) => demoFeedback(prompt),
  lookup: () => ({ lemma: 'example', ipa: '/ɪɡˈzæmpəl/', pos: 'n.', zh: '例子（假模型）', more: '榜样；样本' }),
  // 按提示词里“按顺序出：第 1 句 CET-6，…”的难度出几句能通过校验的句子
  generate: (prompt) => {
    const order = /按顺序出：(.*?)。/.exec(prompt)?.[1].match(/CET-[46]/g) || ['CET-4'];
    return { sentences: order.map((level) => devSentence(level, ++devSeq)) };
  },
});

// DEV_NO_LLM=1：模拟还没配置模型，在网页“设置”里填写（接口地址见下面打印的 fake llm）
const cfg = loadConfig({
  ACCESS_PASSWORD: 'dev-password',
  COOKIE_SECRET: 'd'.repeat(64),
  ...(process.env.DEV_NO_LLM ? {} : { LLM_BASE_URL: fake.url, LLM_API_KEY: 'dev', LLM_MODEL_MAIN: 'fake-main' }),
});
console.log(`fake llm ${fake.url}`);
const handle = createApp(cfg, { llm: createLlm(cfg), log: { log() {}, error: console.error, warn() {} } });

http
  .createServer(async (req, res) => {
    const url = req.url || '/';
    if (url.startsWith('/api/')) return handle(req, res);
    const rel = decodeURIComponent(new URL(url, 'http://x').pathname);
    // 页面地址（/practice、/records、/settings/invites……）都返回 index.html，和 nginx/default.conf 的 try_files 一样
    const file = path.join(WEB, path.normalize(path.extname(rel) ? rel : 'index.html'));
    if (!file.startsWith(WEB)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    try {
      const data = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('not found（先运行 npm run build 生成 web/dist）');
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log(`dev server http://127.0.0.1:${PORT}`));

process.on('SIGTERM', () => {
  fake.close();
  db.drop();
  process.exit(0);
});
