// 出题规范：读 skills/sentence-spec/SKILL.md，按 <!-- prompt:名字 --> … <!-- /prompt --> 取出各段，原样放进提示词。
// 规范文件缺失或少了某一段时直接报错，服务起不来，自动更新会退回上一个版本。
import fs from 'node:fs';

export const SPEC_FILE = new URL('../skills/sentence-spec/SKILL.md', import.meta.url);
const NEEDED = ['predicates', 'segments', 'kb', 'trunk', 'fields', 'example'];

export function parseSpec(text) {
  const out = {};
  const re = /<!-- prompt:([a-z]+) -->\r?\n([\s\S]*?)<!-- \/prompt -->/g;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[2].trim();
  const missing = NEEDED.filter((k) => !out[k]);
  if (missing.length) throw new Error(`出题规范 SKILL.md 里缺少这些段：${missing.join(', ')}`);
  return out;
}

const SECTIONS = parseSpec(fs.readFileSync(SPEC_FILE, 'utf8'));

/** 取规范里的一段文字 */
export const spec = (name) => SECTIONS[name];

/** 规范“知识点”一段列出的键（- key：说明） */
export const specKbKeys = () => [...SECTIONS.kb.matchAll(/^- ([a-z_]+)：/gm)].map((m) => m[1]);

/** 规范里的完整示例句子（JSON） */
export const specExample = () => JSON.parse(/```json\s*([\s\S]*?)```/.exec(SECTIONS.example)[1]);
