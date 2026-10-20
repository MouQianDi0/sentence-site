// 标注题库：用你自己配的国内模型（网页“设置”里保存的，没保存过就用 .env 的；永远不用 ChatGPT），
// 把等着标注（raw）的句子拆解成题，token 记在你自己名下（用途“标注题库”）。
//   sudo docker compose exec -T api node --experimental-strip-types scripts/annotate-bank.ts --limit 50
//   --limit N：这次标注几句（默认 20，最多 2000）；--concurrency N：同时标注几句（默认 3，最多 8）
// 可以随时 Ctrl+C 停下：做完的句子已经存好，没做完的还是 raw，下次接着标。不要和网页上的“开始标注”同时跑。
import { config } from '../src/config.ts';
import { closeDb } from '../src/db.ts';
import { createLlm } from '../src/llm.ts';
import { createSettings, createSettingsHub } from '../src/settings.ts';
import { createAnnotator } from '../src/annotate.ts';
import * as repo from '../src/repo.ts';

const arg = (name: string, d: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : d;
  return Number.isInteger(v) && v > 0 ? v : d;
};
const limit = Math.min(2000, arg('limit', 20));
const concurrency = Math.min(8, arg('concurrency', 3));

try {
  const settings = createSettings(config);
  await settings.load();
  const hub = createSettingsHub(config, { ownerSvc: settings, ownerLlm: createLlm(config), createLlm });
  const annotator = createAnnotator({ cfg: config, llmFor: hub.llmFor });
  console.log(`开始标注：最多 ${limit} 句，同时 ${concurrency} 句，模型 ${config.llm.mainModel || '（未配置）'}`);
  const job = await annotator.run({ limit, concurrency }, (item, o) => {
    const head = `[${item.externalId}]`;
    if (o.status === 'ready') console.log(`${head} 可以抽`);
    else if (o.status === 'rejected') console.log(`${head} 不要：${o.reason}`);
    else console.log(`${head} 模型出错，留着下次再试：${o.error.message}`);
  });
  console.log(
    `标注完 ${job.done}/${job.total} 句：可以抽 ${job.ready}，不要 ${job.rejected}，出错 ${job.failed}${job.error ? `。停下来的原因：${job.error}` : ''}`,
  );
  const counts = await repo.bankCounts();
  console.log(
    `题库现在：待看原文 ${counts.review}，待标注 ${counts.raw}，可以抽 ${counts.ready}，不要 ${counts.rejected}，已下架 ${counts.retired}`,
  );
  if (job.error) process.exitCode = 1;
} catch (e) {
  console.error(`标注失败：${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
