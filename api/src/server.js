// 启动：检查配置 → 建表 → 首次启动时导入旧数据 → 开始监听 → 启动每日出题
import http from 'node:http';
import fs from 'node:fs/promises';
import { config, assertConfig } from './config.js';
import { closeDb } from './db.js';
import * as repo from './repo.js';
import { importExport } from './importer.js';
import { createLlm } from './llm.js';
import { createApp } from './app.js';
import { createAi } from './ai.js';
import { startDailyJob } from './daily.js';
import { createSettings } from './settings.js';
import { createPractice } from './practice.js';

async function waitForDb(tries = 30) {
  for (let i = 1; i <= tries; i++) {
    try {
      await repo.countSentences();
      return;
    } catch (e) {
      // 表还不存在也算连上了
      if (e?.code === '42P01') return;
      if (i === tries) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function main() {
  assertConfig(config);
  await waitForDb();
  await repo.ensureSchema(await fs.readFile(new URL('./schema.sql', import.meta.url), 'utf8'));

  if ((await repo.countSentences()) === 0) {
    try {
      const data = JSON.parse(await fs.readFile(config.seedFile, 'utf8'));
      const s = await importExport(data, (m) => console.log(`[seed] ${m}`));
      console.log(`[seed] 导入句子 ${s.sentences} 句、练习记录 ${s.records} 条、批改记录 ${s.attempts} 条`);
    } catch (e) {
      console.error(`[seed] 导入失败：${e.message}`);
    }
  }

  // 网页上保存过模型配置时，优先用它，否则用 .env
  const settings = createSettings(config);
  await settings.load();
  // 每日任务的句数和难度
  const practice = createPractice(config);
  await practice.load();
  const llm = createLlm(config);
  const ai = createAi({ cfg: config, llm }); // 网页和每日定时任务共用一个，避免同时生成今日任务
  const handler = createApp(config, { llm, settings, practice, ai });
  const server = http.createServer(handler);
  server.listen(config.port, () => {
    console.log(`[api] 已启动，端口 ${config.port}；AI 模型${llm.ready() ? `：${config.llm.mainModel}（${settings.view().source === 'page' ? '网页设置' : '.env'}）` : '：未配置，可以在网站的“设置”里填写'}`);
  });

  const stopDaily = startDailyJob({ cfg: config, ai, llm, practice });

  const shutdown = () => {
    stopDaily();
    server.close(() => closeDb().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error(`[api] 启动失败：${e.message}`);
  process.exit(1);
});
