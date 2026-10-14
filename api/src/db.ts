// 数据库访问只经过这一个 query()。
// 正式运行用 pg 连接池；测试时用 setQueryImpl() 换成别的实现。
import type pg from 'pg';
import { config } from './config.ts';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

// 返回的行是什么样子由调用方（repo.ts）说明
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type QueryImpl = (text: string, params: unknown[]) => Promise<QueryResult<any>>;

let impl: QueryImpl | null = null;
let pool: pg.Pool | null = null;

export function setQueryImpl(fn: QueryImpl): void {
  impl = fn;
}

async function pgImpl(): Promise<QueryImpl> {
  const { default: pgLib } = await import('pg');
  const p = new pgLib.Pool({ ...config.db, max: 5, idleTimeoutMillis: 30_000 });
  p.on('error', (err) => console.error('[db] idle client error', err.message));
  pool = p;
  return async (text, params) => {
    const r = await p.query(text, params);
    return { rows: r.rows, rowCount: r.rowCount ?? 0 };
  };
}

export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  if (!impl) impl = await pgImpl();
  return impl(text, params) as Promise<QueryResult<T>>;
}

export async function closeDb(): Promise<void> {
  if (pool) await pool.end();
}
