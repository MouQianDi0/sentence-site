// 导入从旧版拆解台页面导出的数据：句子 + 练习记录（含批改历史）。可重复运行，不会重复写入。
import * as repo from './repo.js';
import { checkSentence } from './validate.js';

const SOURCES = ['seed', 'daily', 'manual'];
const isoOrNull = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);
const int = (v, max) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(max, Math.round(Number(v)))) : null);

export async function importExport(data, log = () => {}) {
  const summary = { sentences: 0, skippedSentences: 0, records: 0, attempts: 0 };
  const known = new Set();

  for (const raw of Array.isArray(data?.sentences) ? data.sentences : []) {
    const id = String(raw?.id || '').trim();
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
      batch: /^\d{4}-\d{2}-\d{2}$/.test(raw.batch || '') ? raw.batch : created.slice(0, 10),
      source: SOURCES.includes(raw.source) ? raw.source : 'seed',
    });
    if (inserted) summary.sentences += 1;
    known.add(id);
  }

  for (const r of Array.isArray(data?.records) ? data.records : []) {
    const sid = String(r?.sid || r?.sentenceId || '').trim();
    if (!sid) continue;
    if (!known.has(sid) && !(await repo.getSentence(sid))) {
      log(`跳过记录 ${sid}：句子不存在`);
      continue;
    }
    const fields = {};
    if (typeof r.done === 'boolean') fields.done = r.done;
    if (r.verbs && Number.isInteger(r.verbs.ok)) fields.verbs = { ok: r.verbs.ok, total: r.verbs.total, wrong: r.verbs.wrong };
    if (r.choice && Number.isInteger(r.choice.pick)) fields.choice = { pick: r.choice.pick, ok: Boolean(r.choice.ok) };
    if (typeof r.draft === 'string') fields.draft = r.draft.slice(0, 2000);
    if (isoOrNull(r.first)) fields.firstAt = r.first;
    if (isoOrNull(r.updated)) fields.updatedAt = r.updated;
    if (Object.keys(fields).length) {
      await repo.upsertRecord(sid, fields);
      summary.records += 1;
    }

    const attempts = (Array.isArray(r.attempts) ? r.attempts : [])
      .filter((a) => a && typeof a.text === 'string' && a.text.trim())
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    if (attempts.length && (await repo.countAttemptsFor(sid)) === 0) {
      for (const a of attempts) {
        // 旧页面只保存了最近一次的完整点评
        const fb = r.fb && r.fb.text === a.text ? r.fb : null;
        await repo.insertAttempt({
          sentenceId: sid,
          text: a.text.slice(0, 500),
          acc: int(a.acc, 40),
          flu: int(a.flu, 30),
          comp: int(a.comp, 30),
          total: int(a.total, 100),
          feedback: fb ? { level: fb.level || '', good: fb.good || [], issues: fb.issues || [], better: fb.better || '' } : null,
          model: 'claude（旧页面）',
          createdAt: isoOrNull(a.at),
        });
        summary.attempts += 1;
      }
    }
  }
  return summary;
}
