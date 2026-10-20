// 数据库迁移：启动时按编号执行 migrations/ 里还没执行过的文件，执行过的记在 schema_migrations。
//
// 写迁移文件的规矩：
// - 文件名 NNNN_说明.sql（四位编号、小写字母数字下划线），已经发布的文件不再改，改表结构就新加一个。
// - 每个文件连同它那条 schema_migrations 记录作为一次不带参数的查询发出（简单查询协议），
//   多条语句在同一个事务里，出错整份不生效，下次启动再试。所以文件里不能写 BEGIN / COMMIT，
//   也不能用 CREATE INDEX CONCURRENTLY（不能在事务里执行）。
// - 更新失败会退回上一个版本，旧代码会跑在已经升级的库上：会让旧代码写不进去的改动，
//   分“扩”（先加、兼容旧代码）和“收”（下一次发布再收紧）两次发布。
// 只有一个 api 容器，启动时不会有两个进程同时迁移，所以不加锁。
import fs from 'node:fs/promises';
import { query } from './db.ts';

const DIR = new URL('./migrations/', import.meta.url);
const FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

export async function migrate(log: (msg: string) => void = console.log): Promise<string[]> {
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    int PRIMARY KEY,
    name       text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  // 测试用的 psql 替身返回的是字符串
  const { rows } = await query<{ version: number | string }>('SELECT version FROM schema_migrations');
  const done = new Set(rows.map((r) => Number(r.version)));

  const files = (await fs.readdir(DIR)).filter((f) => FILE.test(f)).sort();
  const applied: string[] = [];
  for (const name of files) {
    const version = Number(name.slice(0, 4));
    if (done.has(version)) continue;
    const sql = await fs.readFile(new URL(name, DIR), 'utf8');
    // 文件名过了上面的正则，可以直接拼进去
    await query(`${sql}\n;\nINSERT INTO schema_migrations (version, name) VALUES (${version}, '${name}');`);
    log(`[migrate] ${name}`);
    applied.push(name);
  }
  return applied;
}
