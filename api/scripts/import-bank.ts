// 导入外部题库（四级真题阅读长难句）：
//   sudo docker compose exec -T api node --experimental-strip-types scripts/import-bank.ts < cet4_long_sentences.jsonl
// 可以重复运行：按编号更新，原文没变的句子保留标注；这次文件里没有的标成 retired。整份要么都写进去，要么都不写。
import { CET4_BANK, parseBankJsonl, type BankStatus } from '../src/bank.ts';
import * as repo from '../src/repo.ts';
import { closeDb } from '../src/db.ts';

const NAMES: Record<BankStatus, string> = {
  review: '待看原文',
  raw: '待标注',
  ready: '可以抽',
  rejected: '不要',
  retired: '已下架',
};

const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
try {
  const rows = parseBankJsonl(Buffer.concat(chunks).toString('utf8'));
  if (!rows.length) throw new Error('没有读到句子：把 JSONL 文件从标准输入传进来（命令最后加 < 文件名）');
  const r = await repo.importBank(CET4_BANK, rows);
  console.log(`导入完成：文件里 ${rows.length} 句，新增 ${r.added}，更新 ${r.updated}，下架 ${r.retired}`);
  const counts = await repo.bankCounts(CET4_BANK.id);
  console.log(
    `题库现在：${Object.entries(counts)
      .map(([k, n]) => `${NAMES[k as BankStatus]} ${n}`)
      .join('，')}`,
  );
} catch (e) {
  console.error(`导入失败，题库没有改动：${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
