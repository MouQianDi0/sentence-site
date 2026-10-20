// 启动：检查配置 → 执行数据库迁移 → 首次启动时导入旧数据 → 开始监听 → 启动每日出题
import http from 'node:http';
import fs from 'node:fs/promises';
import { config, assertConfig } from './config.ts';
import { closeDb } from './db.ts';
import { migrate } from './migrate.ts';
import * as repo from './repo.ts';
import { importExport } from './importer.ts';
import { createLlm } from './llm.ts';
import { createApp } from './app.ts';
import { createAi } from './ai.ts';
import { startDailyJob } from './daily.ts';
import { createSettings, createSettingsHub } from './settings.ts';
import { createPractice } from './practice.ts';
import { createChatgpt } from './chatgpt.ts';
import { routeLlm } from './llm-route.ts';

async function waitForDb(tries = 30) {
  for (let i = 1; i <= tries; i++) {
    try {
      await repo.countSentences();
      return;
    } catch (e) {
      // 表还不存在也算连上了
      if ((e as { code?: string } | null)?.code === '42P01') return;
      if (i === tries) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function main() {
  assertConfig(config);
  await waitForDb();
  await migrate();

  if ((await repo.countSentences()) === 0) {
    try {
      const data = JSON.parse(await fs.readFile(config.seedFile, 'utf8'));
      const s = await importExport(data, (m) => console.log(`[seed] ${m}`));
      console.log(`[seed] 导入句子 ${s.sentences} 句、练习记录 ${s.records} 条、批改记录 ${s.attempts} 条`);
    } catch (e) {
      console.error(`[seed] 导入失败：${(e as Error).message}`);
    }
  }

  // 网页上保存过模型配置时，优先用它，否则用 .env
  const settings = createSettings(config);
  await settings.load();
  // 每日任务的句数和难度（每个账户各一份）
  const practice = createPractice(config);
  const llm = createLlm(config);
  // ChatGPT 套餐：只给你自己的账户用，出题改题按设置走它，用不了时回退到上面的国内模型
  const chatgpt = createChatgpt({ cfg: config, fallbackReady: () => llm.ready() });
  await chatgpt.load();
  // 模型配置按账户：你自己用上面这份（可以退回 .env，再加上 ChatGPT），邀请账户各用自己填的
  const hub = createSettingsHub(config, {
    ownerSvc: settings,
    ownerLlm: llm,
    createLlm,
    routeOwner: (base, use) => routeLlm({ plan: chatgpt, fallback: base, use }),
  });
  const ai = createAi({ cfg: config, llm, llmFor: hub.llmFor }); // 网页和每日定时任务共用一个，避免同时生成今日任务
  const handler = createApp(config, { llm, settings, practice, hub, ai, chatgpt });
  const server = http.createServer(handler);
  server.listen(config.port, () => {
    console.log(
      `[api] 已启动，端口 ${config.port}；AI 模型${llm.ready() ? `：${config.llm.mainModel}（${settings.view().source === 'page' ? '网页设置' : '.env'}）` : '：未配置，可以在网站的“设置”里填写'}`,
    );
    const g = chatgpt.view();
    if (g.status !== 'none') {
      console.log(
        `[api] ChatGPT 套餐：${g.ready ? `已连接（${g.mainModel}）` : g.status === 'ok' ? '已连接，暂时不可用' : '要重新连接'}`,
      );
    }
  });

  const stopDaily = startDailyJob({ cfg: config, ai, llmFor: hub.llmFor, practice });

  const shutdown = () => {
    stopDaily();
    server.close(() => closeDb().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e: unknown) => {
  console.error(`[api] 启动失败：${(e as Error).message}`);
  process.exit(1);
});
