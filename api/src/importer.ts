// 导入从旧版拆解台页面导出的数据：句子 + 练习记录（含批改历史），都归到你自己的账户（owner）。可重复运行，不会重复写入。
import type { SentenceSource } from '@sentence-site/shared';
import * as repo from './repo.ts';
import type { RecordFields } from './repo.ts';
import { checkSentence } from './validate.ts';

const SOURCES: SentenceSource[] = ['seed', 'daily', 'manual'];
type Loose = Record<string, unknown>;
const obj = (v: unknown): Loose | null => (v && typeof v === 'object' ? (v as Loose) : null);
const arr = (v: unknown): Loose[] =>
  Array.isArray(v) ? (v as unknown[]).map(obj).filter((x): x is Loose => Boolean(x)) : [];
const isoOrNull = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);
const int = (v: unknown, max: number): number | null =>
  Number.isFinite(Number(v)) ? Math.max(0, Math.min(max, Math.round(Number(v)))) : null;

export interface ImportSummary {
  sentences: number;
  skippedSentences: number;
  records: number;
  attempts: number;
}

export async function importExport(data: unknown, log: (msg: string) => void = () => {}): Promise<ImportSummary> {
  const summary: ImportSummary = { sentences: 0, skippedSentences: 0, records: 0, attempts: 0 };
  const known = new Set<string>();
  const root = obj(data);

  for (const raw of arr(root?.sentences)) {
    const id = String(raw.id || '').trim();
    const checked = checkSentence(raw);
    if (!id || !checked.ok) {
      summary.skippedSentences += 1;
      log(`跳过句子 ${id || '(没有 id)'}：${checked.ok ? '缺少 id' : checked.reason}`);
      continue;
    }
    const created = isoOrNull(raw.created) || new Date().toISOString();
    const inserted = await repo.insertSentence({
      ...checked.value,
      id,
      created,
      batch: typeof raw.batch === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.batch) ? raw.batch : created.slice(0, 10),
      source: SOURCES.find((x) => x === raw.source) ?? 'seed',
    });
    if (inserted) summary.sentences += 1;
    known.add(id);
  }

  for (const r of arr(root?.records)) {
    const sid = String(r.sid || r.sentenceId || '').trim();
    if (!sid) continue;
    if (!known.has(sid) && !(await repo.getSentence('owner', sid))) {
      log(`跳过记录 ${sid}：句子不存在`);
      continue;
    }
    const fields: RecordFields = {};
    const verbs = obj(r.verbs);
    const choice = obj(r.choice);
    const first = isoOrNull(r.first);
    const updated = isoOrNull(r.updated);
    if (typeof r.done === 'boolean') fields.done = r.done;
    if (verbs && Number.isInteger(verbs.ok)) {
      fields.verbs = { ok: verbs.ok as number, total: verbs.total as number, wrong: verbs.wrong as number };
    }
    if (choice && Number.isInteger(choice.pick))
      fields.choice = { pick: choice.pick as number, ok: Boolean(choice.ok) };
    if (typeof r.draft === 'string') fields.draft = r.draft.slice(0, 2000);
    if (first) fields.firstAt = first;
    if (updated) fields.updatedAt = updated;
    if (Object.keys(fields).length) {
      await repo.upsertRecord(sid, fields);
      summary.records += 1;
    }

    const attempts = arr(r.attempts)
      .filter((a): a is Loose & { text: string } => typeof a.text === 'string' && Boolean(a.text.trim()))
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    if (attempts.length && (await repo.countAttemptsFor(sid)) === 0) {
      for (const a of attempts) {
        // 旧页面只保存了最近一次的完整点评
        const rfb = obj(r.fb);
        const fb = rfb && rfb.text === a.text ? rfb : null;
        await repo.insertAttempt({
          sentenceId: sid,
          text: a.text.slice(0, 500),
          acc: int(a.acc, 40),
          flu: int(a.flu, 30),
          comp: int(a.comp, 30),
          total: int(a.total, 100),
          feedback: fb
            ? {
                level: String(fb.level || ''),
                good: (fb.good as string[]) || [],
                issues: (fb.issues as []) || [],
                better: String(fb.better || ''),
              }
            : null,
          model: 'claude（旧页面）',
          createdAt: isoOrNull(a.at),
        });
        summary.attempts += 1;
      }
    }
  }
  return summary;
}
