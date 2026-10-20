// 外部题库（四级真题阅读长难句）：把题库的 JSONL 整理成 bank_items 的一行，以及出处的显示文字。
// 题库文件本身不放进仓库（仓库是公开的），在服务器上用 scripts/import-bank.ts 从标准输入导入。
// JSONL 每行一句，字段见题库的 README：id、text_en、level、structures、complexity_score、quality_status、
// text_source、text_raw、cloze、sources（[{year, month, set_number, section, passage, locator, file}]）。
import type { Level } from '@sentence-site/shared';

/** 现在只有这一个题库 */
export const CET4_BANK = { id: 'cet4-reading', name: '四级真题阅读长难句' };

export type BankStatus = 'review' | 'raw' | 'ready' | 'rejected' | 'retired';
export const BANK_STATUSES: BankStatus[] = ['review', 'raw', 'ready', 'rejected', 'retired'];

/** 要写进 bank_items 的一行（字段名和列名一样，整批交给 jsonb_to_recordset） */
export interface BankRow {
  external_id: string;
  text: string;
  level: Level;
  exam_year: number | null;
  exam_month: number | null;
  paper: number | null;
  section: string | null;
  tags: string[];
  complexity: number | null;
  src_quality: string;
  meta: Record<string, unknown>;
  /** 按题库的质量状态初筛出来的状态（新句子、原文变了的句子用它） */
  status: BankStatus;
  reject_reason: string | null;
}

type Loose = Record<string, unknown>;
const obj = (v: unknown): Loose | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Loose) : null);
const int = (v: unknown): number | null => (Number.isInteger(v) ? (v as number) : null);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * 题库的质量状态 → 初筛：核对过的（reviewed、cloze_filled）直接等着标注；
 * 选词填空还有空没填的不要；拿不准的（needs_review）和没核对过的新句子先让你看一眼原文。
 */
export function initialStatus(quality: string): { status: BankStatus; reason: string | null } {
  if (quality === 'reviewed' || quality === 'cloze_filled') return { status: 'raw', reason: null };
  if (quality === 'incomplete_cloze') return { status: 'rejected', reason: '选词填空还有没填的空' };
  return { status: 'review', reason: null };
}

/** 整理 JSONL 的一行；格式不对时抛出错误（说明哪个字段不对） */
export function parseBankLine(input: unknown): BankRow {
  const o = obj(input);
  if (!o) throw new Error('不是 JSON 对象');
  const id = str(o.id);
  if (!id) throw new Error('缺少 id');
  const text = str(o.text_en).replace(/\s+/g, ' ');
  if (!text) throw new Error(`${id}：缺少 text_en`);
  const level = str(o.level) || 'CET-4';
  if (level !== 'CET-4' && level !== 'CET-6') throw new Error(`${id}：level 只能是 CET-4 或 CET-6`);
  const quality = str(o.quality_status);
  if (!quality) throw new Error(`${id}：缺少 quality_status`);
  const sources = (Array.isArray(o.sources) ? (o.sources as unknown[]) : []).map(obj).filter((s) => s !== null);
  const first = sources[0] ?? {};
  const month = int(first.month);
  const meta: Loose = {
    sources: sources.map((s) => ({
      year: int(s.year),
      month: int(s.month),
      set: int(s.set_number),
      section: str(s.section) || null,
      passage: str(s.passage) || null,
      locator: str(s.locator) || null,
      file: str(s.file) || null,
    })),
  };
  if (str(o.text_raw)) meta.text_raw = str(o.text_raw);
  if (str(o.text_source)) meta.text_source = str(o.text_source);
  const cloze = (Array.isArray(o.cloze) ? (o.cloze as unknown[]) : [])
    .map(obj)
    .filter((c): c is Loose => c !== null && Number.isInteger(c.no))
    .map((c) => ({ no: c.no as number, word: str(c.word) }));
  if (cloze.length) meta.cloze = cloze;
  const { status, reason } = initialStatus(quality);
  return {
    external_id: id,
    text,
    level,
    exam_year: int(first.year),
    exam_month: month !== null && month >= 1 && month <= 12 ? month : null,
    paper: int(first.set_number),
    section: str(first.section) || null,
    tags: (Array.isArray(o.structures) ? (o.structures as unknown[]) : []).map(str).filter(Boolean),
    complexity: int(o.complexity_score),
    src_quality: quality,
    meta,
    status,
    reject_reason: reason,
  };
}

/**
 * 读整份 JSONL：空行跳过；有一行不对就整份不导入（抛出的错误带行号）。
 * 同一个 id 出现两次时用后面那行。
 */
export function parseBankJsonl(text: string): BankRow[] {
  const rows = new Map<string, BankRow>();
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      throw new Error(`第 ${i + 1} 行不是合法的 JSON`);
    }
    try {
      const row = parseBankLine(data);
      rows.set(row.external_id, row);
    } catch (e) {
      throw new Error(`第 ${i + 1} 行：${(e as Error).message}`);
    }
  });
  return [...rows.values()];
}

const SECTIONS: Record<string, string> = { A: '选词填空', B: '段落匹配', C: '仔细阅读' };

/** 出处的显示文字，如“四级真题 2023 年 12 月第 2 套 · 仔细阅读”；什么都不知道时返回空字符串 */
export function originText(o: {
  level?: string | null;
  year: number | null;
  month: number | null;
  paper: number | null;
  section: string | null;
}): string {
  const when = [o.year ? `${o.year} 年` : '', o.month ? ` ${o.month} 月` : '', o.paper ? `第 ${o.paper} 套` : '']
    .join('')
    .trim();
  const part = o.section ? (SECTIONS[o.section] ?? o.section) : '';
  const exam = o.level === 'CET-6' ? '六级真题' : '四级真题';
  const head = when ? `${exam} ${when}` : exam;
  return part ? `${head} · ${part}` : head;
}

/** 比较原句时统一直 / 弯引号、破折号两边的空格和空白（片段在破折号处切开时拼回去会多一个空格） */
export function sameText(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .replace(/[‘’ʼ`]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\s*([—–])\s*/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  return norm(a) === norm(b);
}
