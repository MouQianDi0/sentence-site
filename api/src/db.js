// 数据库访问只经过这一个 query()。
// 正式运行用 pg 连接池；测试时用 setQueryImpl() 换成别的实现。
import { config } from './config.js';

let impl = null;
let pool = null;

export function setQueryImpl(fn) {
  impl = fn;
}

async function pgImpl() {
  const { default: pg } = await import('pg');
  pool = new pg.Pool({ ...config.db, max: 5, idleTimeoutMillis: 30_000 });
  pool.on('error', (err) => console.error('[db] idle client error', err.message));
  return (text, params) => pool.query(text, params);
}

/** @returns {Promise<{rows: any[], rowCount: number}>} */
export async function query(text, params = []) {
  if (!impl) impl = await pgImpl();
  return impl(text, params);
}

export async function closeDb() {
  if (pool) await pool.end();
}
