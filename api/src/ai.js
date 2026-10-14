// AI 批改、查词、出题的业务逻辑（不关心 HTTP）。
import * as repo from './repo.js';
import { HttpError } from './http.js';
import { LlmError } from './llm.js';
import { gradePrompt, lookupPrompt, generatePrompt, reviewPrompt } from './prompts.js';
import { extractMarks, locate, markByIndex } from './predicates.js';
import { checkSentence } from './validate.js';
import { shanghaiDate, shanghaiClock } from './time.js';
import { LEVELS, planLevels } from './practice.js';

const clamp = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const shuffleCopy = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

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

const markKey = (segs) => extractMarks(segs).map((m) => `${m.kind}:${m.a}-${m.b}`).join(',');

export function createAi({ cfg, llm, log = console }) {
  /**
   * 让 AI 复核一批句子的谓语标注。返回和 items 一样长的数组，每项：
   * {status:'ok', segs, changed, note}；{status:'unknown'}（回复里没有这一句）；{status:'mismatch'}（给的谓语在原句里找不到）
   */
  async function reviewMarks(items) {
    const r = await llm.chatJson({
      prompt: reviewPrompt(items),
      model: cfg.llm.mainModel,
      maxTokens: 400 + 250 * items.length,
      temperature: 0.1,
      timeoutMs: Math.max(cfg.llm.timeoutMs, 90_000),
    });
    const list = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.items) ? r.data.items : [];
    return items.map((s, i) => {
      const it = list.find((x) => Number(x?.i) === i + 1);
      if (!it || !it.main) return { status: 'unknown' };
      const spans = locate(s.segs, it.main, Array.isArray(it.sub) ? it.sub : []);
      if (!spans) return { status: 'mismatch' };
      const segs = markByIndex(s.segs, spans);
      const changed = markKey(segs) !== markKey(s.segs);
      return { status: 'ok', segs: changed ? segs : s.segs, changed, note: str(it.note, 60) };
    });
  }

  /** 做题时发现标错了：让 AI 单独复查这一句，标注有变就存回去 */
  async function reviewOne(id) {
    const sentence = await repo.getSentence(String(id || ''));
    if (!sentence) throw new HttpError(404, '句子不存在');
    let res;
    try {
      [res] = await reviewMarks([sentence]);
    } catch (e) {
      throw toHttpError(e);
    }
    if (res.status !== 'ok') throw new HttpError(502, 'AI 复查的结果对不上原句，再试一次，或者自己点词修改');
    if (!res.changed) return { sentence, changed: false, note: res.note };
    await repo.updateSegs(sentence.id, res.segs);
    return { sentence: await repo.getSentence(sentence.id), changed: true, note: res.note };
  }

  /** 自己改谓语：spans 是按整句单词下标标出的 [{kind, a, b}] */
  async function setMarks(id, spans) {
    const sentence = await repo.getSentence(String(id || ''));
    if (!sentence) throw new HttpError(404, '句子不存在');
    if (!Array.isArray(spans) || spans.filter((x) => x?.kind === 'main').length !== 1) {
      throw new HttpError(400, '要标出且只标出一个主句谓语');
    }
    let segs;
    try {
      segs = markByIndex(sentence.segs, spans);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    await repo.updateSegs(sentence.id, segs);
    return { sentence: await repo.getSentence(sentence.id) };
  }

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

  /** 模型写的难度统一成 CET-4 / CET-6，认不出来返回空 */
  const normLevel = (v) => (/6/.test(String(v)) ? 'CET-6' : /4/.test(String(v)) ? 'CET-4' : '');
  const CHUNK = 5; // 一次最多让模型出 5 句，句数多时分几批同时请求，避免回复太长被截断
  const TOPICS = ['科技', '教育', '环境', '健康', '社会', '经济', '文化', '职场', '城市生活', '心理', '历史', '媒体'];
  let dailyBusy = false;

  /** 从还缺的句数里取一批（两种难度轮流取），返回这批每句的难度 */
  function takeChunk(need) {
    const out = [];
    const left = { ...need };
    while (out.length < CHUNK && LEVELS.some((l) => left[l] > 0)) {
      for (const l of LEVELS) {
        if (left[l] > 0 && out.length < CHUNK) {
          out.push(l);
          left[l] -= 1;
        }
      }
    }
    return out;
  }

  /**
   * 生成 n 句并写入数据库，返回新句子的 id。
   * source：daily = 今日任务（不算进手动出题次数），extra = 加练。
   * levels：要出的难度，两种都选时各占一半、顺序随机。句子没通过校验或难度不对时会补出，最多多请求 2 次。
   */
  async function generate({ source = 'extra', n = 5, levels = LEVELS } = {}) {
    if (source === 'daily') {
      if (dailyBusy) throw new HttpError(409, '今天的任务正在生成，稍等一下');
      dailyBusy = true;
    }
    try {
      if (source !== 'daily') await checkLimit('gens', cfg.limits.generate, '今天加练出题的次数用完了（{n} 次）');
      const day = shanghaiDate();
      const clock = shanghaiClock();
      const now = Date.now();
      const offset = source === 'daily' ? await repo.countDailyFor(day) : 0;
      const need = {};
      for (const l of planLevels(n, levels)) need[l] = (need[l] || 0) + 1;
      const accepted = [];
      const reasons = [];
      const recentDb = await repo.recentSentences(40);
      const ask = async (plan, topics) => {
        try {
          const r = await llm.chatJson({
            prompt: generatePrompt(plan, [...accepted, ...recentDb].slice(0, 50), topics),
            model: cfg.llm.mainModel,
            maxTokens: 8000,
            temperature: 0.8,
            timeoutMs: Math.max(cfg.llm.timeoutMs, 180_000),
          });
          const raw = Array.isArray(r.data) ? r.data : r.data?.sentences;
          return { list: await vet(Array.isArray(raw) ? raw : []) };
        } catch (e) {
          return { error: e };
        }
      };
      // 先按规则校验，再让 AI 复核谓语标注：标错的按复核结果改正，改完再校验一遍；复核本身出错时保留规则校验通过的句子
      const vet = async (raw) => {
        const list = [];
        for (const item of raw) {
          const checked = checkSentence(item, { strict: true });
          if (checked.ok) list.push(checked.value);
          else reasons.push(checked.reason);
        }
        if (!list.length) return list;
        let reviews;
        try {
          reviews = await reviewMarks(list);
        } catch (e) {
          reasons.push(`谓语复核没做成：${e.message}`);
          return list;
        }
        const out = [];
        list.forEach((s, i) => {
          const rv = reviews[i];
          if (rv.status === 'mismatch') return reasons.push('复核给出的谓语在原句里找不到');
          if (rv.status !== 'ok' || !rv.changed) return out.push(s);
          const again = checkSentence({ ...s, segs: rv.segs }, { strict: true });
          if (!again.ok) return reasons.push(`复核改正后仍不合格：${again.reason}`);
          log.warn?.(`[ai] 复核改正了谓语标注：${rv.note || markKey(s.segs)}`);
          out.push(again.value);
        });
        return out;
      };
      const take = (list) => {
        for (const item of list) {
          if (accepted.length >= n) break;
          const level = normLevel(item.level);
          if (!need[level]) {
            reasons.push(`难度 ${item.level || '未标注'} 不是这次要的`);
            continue;
          }
          need[level] -= 1;
          accepted.push({ ...item, level });
        }
      };

      // 第一轮：按 5 句一批同时请求，每批分到不同的话题，句数多时也不会等太久
      const firstPlan = [];
      for (const l of LEVELS) for (let i = 0; i < (need[l] || 0); i++) firstPlan.push(l);
      const plans = [];
      const shuffled = shuffleCopy(firstPlan);
      for (let i = 0; i < shuffled.length; i += CHUNK) plans.push(shuffled.slice(i, i + CHUNK));
      const topicStart = Math.floor(Math.random() * TOPICS.length);
      const topicsFor = (k) => Array.from({ length: 6 }, (_, j) => TOPICS[(topicStart + k * 6 + j) % TOPICS.length]);
      const first = await Promise.all(plans.map((plan, k) => ask(plan, plans.length > 1 ? topicsFor(k) : null)));
      let lastError = null;
      for (const r of first) {
        if (r.error) {
          lastError = r.error;
          reasons.push(r.error.message);
        } else take(r.list);
      }
      // 认证失败、额度用完这类错误，补出也没用
      const fatal = (e) => e instanceof LlmError && ['auth', 'rate_limited', 'not_configured'].includes(e.code);
      // 补出：没通过校验或难度不对的，最多再请求 2 次
      for (let round = 0; round < 2 && accepted.length < n && !(lastError && fatal(lastError)); round++) {
        const r = await ask(shuffleCopy(takeChunk(need)), null);
        if (r.error) {
          lastError = r.error;
          reasons.push(r.error.message);
          if (fatal(r.error)) break;
        } else take(r.list);
      }
      if (!accepted.length && lastError) throw toHttpError(lastError);
      if (reasons.length) log.warn?.(`[ai] 生成时丢弃：${reasons.join('；')}`);

      // 打乱顺序后再写入，四级六级混着出现。编号被占用时（删过句子、同一秒内加练两次）顺延
      const ids = [];
      const d = day.replace(/-/g, '');
      let next = source === 'daily' ? offset + 1 : 1;
      for (const item of shuffleCopy(accepted)) {
        const created = new Date(now + ids.length + 1).toISOString();
        for (let tries = 0; tries < 30; tries++, next++) {
          const id = source === 'daily' ? `s-${d}-d${next}` : `s-${d}-${clock}-${next}`;
          if (await repo.insertSentence({ ...item, id, created, batch: day, source })) {
            ids.push(id);
            next++;
            break;
          }
        }
      }
      if (!ids.length) throw new HttpError(502, 'AI 这次出的题都没通过校验，再试一次');
      if (source !== 'daily') await repo.bumpUsage(day, 'gens');
      return ids;
    } finally {
      if (source === 'daily') dailyBusy = false;
    }
  }

  return { grade, lookup, generate, reviewOne, setMarks };
}
