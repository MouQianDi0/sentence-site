// AI 批改、查词、出题的业务逻辑（不关心 HTTP）。
import * as repo from './repo.js';
import { HttpError } from './http.js';
import { LlmError } from './llm.js';
import { gradePrompt, lookupPrompt, generatePrompt } from './prompts.js';
import { checkSentence } from './validate.js';
import { shanghaiDate, shanghaiClock } from './time.js';

const clamp = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
const str = (v, max) => String(v ?? '').trim().slice(0, max);

export function toHttpError(e) {
  if (e instanceof HttpError) return e;
  if (e instanceof LlmError) {
    console.error(`[ai] ${e.code}: ${e.message}${e.detail ? ` | ${e.detail}` : ''}`);
    const status = { not_configured: 503, rate_limited: 429, auth: 502, timeout: 504 }[e.code] || 502;
    return new HttpError(status, e.message);
  }
  return e;
}

/** 整理批改结果：分数夹到范围内，总分由后端相加，问题片段必须能在译文里找到 */
export function cleanFeedback(data, text) {
  const acc = clamp(data?.acc, 40);
  const flu = clamp(data?.flu, 30);
  const comp = clamp(data?.comp, 30);
  const issues = (Array.isArray(data?.issues) ? data.issues : [])
    .map((x) => ({ src: str(x?.src, 200), type: str(x?.type, 10), why: str(x?.why, 120), fix: str(x?.fix, 200) }))
    .filter((x) => x.src && text.includes(x.src))
    .slice(0, 4);
  return {
    acc, flu, comp,
    total: acc + flu + comp,
    level: str(data?.level, 60),
    good: (Array.isArray(data?.good) ? data.good : []).map((g) => str(g, 120)).filter(Boolean).slice(0, 3),
    issues,
    better: str(data?.better, 600),
  };
}

export function createAi({ cfg, llm, log = console }) {
  async function checkLimit(field, limit, message) {
    const usage = await repo.getUsage(shanghaiDate());
    if (usage[field] >= limit) throw new HttpError(429, message.replace('{n}', limit));
  }

  async function grade(sentenceId, rawText) {
    const text = String(rawText ?? '').trim();
    if (!text) throw new HttpError(400, '先写下你的译文');
    if (text.length > 500) throw new HttpError(400, '译文太长了（最多 500 字）');
    const sentence = await repo.getSentence(String(sentenceId || ''));
    if (!sentence) throw new HttpError(404, '句子不存在');
    await checkLimit('grades', cfg.limits.grade, '今天的批改次数用完了（{n} 次），明天再来');

    let result;
    for (let i = 0; i < 2; i++) {
      try {
        result = await llm.chatJson({ prompt: gradePrompt(sentence, text), model: cfg.llm.mainModel, maxTokens: 1500 });
        break;
      } catch (e) {
        if (e instanceof LlmError && e.code === 'invalid_json' && i === 0) continue;
        throw toHttpError(e);
      }
    }
    const fb = cleanFeedback(result.data, text);
    const attempt = await repo.insertAttempt({
      sentenceId: sentence.id,
      text,
      acc: fb.acc, flu: fb.flu, comp: fb.comp, total: fb.total,
      feedback: { level: fb.level, good: fb.good, issues: fb.issues, better: fb.better },
      model: result.model,
      inputTokens: result.usage.input,
      outputTokens: result.usage.output,
    });
    await repo.bumpUsage(shanghaiDate(), 'grades');
    return attempt;
  }

  async function lookup(sentenceId, rawWord) {
    const word = String(rawWord ?? '').trim().toLowerCase().replace(/’/g, "'");
    if (!/^[a-z][a-z'-]{0,39}$/.test(word)) throw new HttpError(400, '只能查英文单词');
    const sentence = await repo.getSentence(String(sentenceId || ''));
    if (!sentence) throw new HttpError(404, '句子不存在');
    const cached = await repo.getDict(sentence.id, word);
    if (cached) return { word, data: cached, cached: true };
    await checkLimit('lookups', cfg.limits.lookup, '今天的查词次数用完了（{n} 次）');

    let result;
    try {
      result = await llm.chatJson({
        prompt: lookupPrompt(sentence, word),
        model: cfg.llm.lightModel || cfg.llm.mainModel,
        maxTokens: 300,
        temperature: 0.1,
        timeoutMs: 30_000,
      });
    } catch (e) {
      throw toHttpError(e);
    }
    const d = result.data || {};
    const data = { lemma: str(d.lemma, 40), ipa: str(d.ipa, 40), pos: str(d.pos, 10), zh: str(d.zh, 60), more: str(d.more, 80) };
    if (!data.zh) throw new HttpError(502, '没查到这个词的意思');
    await repo.putDict(sentence.id, word, data);
    await repo.bumpUsage(shanghaiDate(), 'lookups');
    return { word, data, cached: false };
  }

  /** 生成 n 句并写入数据库。不足 n 句时最多补 2 轮。返回新句子的 id。 */
  async function generate({ source = 'manual', n = 5 } = {}) {
    if (source === 'manual') {
      await checkLimit('gens', cfg.limits.generate, '今天手动生成的次数用完了（{n} 次）');
    }
    const day = shanghaiDate();
    const clock = shanghaiClock();
    const now = Date.now();
    const accepted = [];
    const reasons = [];
    for (let round = 0; round < 3 && accepted.length < n; round++) {
      const recent = await repo.recentSentences(40);
      let result;
      try {
        result = await llm.chatJson({
          prompt: generatePrompt(n - accepted.length, recent),
          model: cfg.llm.mainModel,
          maxTokens: 8000,
          temperature: 0.8,
          timeoutMs: Math.max(cfg.llm.timeoutMs, 180_000),
        });
      } catch (e) {
        if (e instanceof LlmError && e.code === 'invalid_json' && round < 2) {
          reasons.push('返回格式不对');
          continue;
        }
        throw toHttpError(e);
      }
      const list = Array.isArray(result.data) ? result.data : result.data?.sentences;
      for (const item of Array.isArray(list) ? list : []) {
        if (accepted.length >= n) break;
        const checked = checkSentence(item, { strict: true });
        if (!checked.ok) {
          reasons.push(checked.reason);
          continue;
        }
        const idx = accepted.length + 1;
        const id = source === 'daily'
          ? `s-${day.replace(/-/g, '')}-d${idx}`
          : `s-${day.replace(/-/g, '')}-${clock}-${idx}`;
        const inserted = await repo.insertSentence({
          ...checked.value,
          id,
          created: new Date(now + idx).toISOString(),
          batch: day,
          source,
        });
        if (inserted) accepted.push(id);
      }
    }
    if (reasons.length) log.warn?.(`[ai] 生成时丢弃：${reasons.join('；')}`);
    if (!accepted.length) throw new HttpError(502, 'AI 这次出的题都没通过校验，再试一次');
    await repo.bumpUsage(day, 'gens');
    return accepted;
  }

  return { grade, lookup, generate };
}
