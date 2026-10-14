// 手动导入数据：docker compose exec -T api node scripts/import.ts < 导出文件.json
import { importExport } from '../src/importer.ts';
import { closeDb } from '../src/db.ts';

const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const s = await importExport(data, (m) => console.log(m));
console.log(
  `导入完成：句子 ${s.sentences} 句（跳过 ${s.skippedSentences}），练习记录 ${s.records} 条，批改记录 ${s.attempts} 条`,
);
await closeDb();
