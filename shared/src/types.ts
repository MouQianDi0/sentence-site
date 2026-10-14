// 前后端共用的数据类型：后端接口返回的样子，前端按这个读。
// 改了接口返回的字段，先改这里，两边的类型检查都会提示哪里要跟着改。

// ---- 句子 ----------------------------------------------------------------------
/** 句子成分：主干、定语从句、名词性从句、状语、非谓语 */
export type RoleId = 'main' | 'attr' | 'noun' | 'adv' | 'nonfin';
export type Level = 'CET-4' | 'CET-6';
/** seed = 旧页面导入，daily = 今日任务，manual = 旧版手动出题，extra = 加练 */
export type SentenceSource = 'seed' | 'daily' | 'manual' | 'extra';

/** 句子的一段：r 成分，t 英文（*主句谓语* ^从句谓语^），n 中文说明，k 知识点键 */
export interface Seg {
  r: RoleId;
  t: string;
  n: string;
  k: string;
}

/** 译文选项：恰好一个 ok */
export interface Opt {
  t: string;
  ok: boolean;
  why: string;
}

/** 句子里的重点词 */
export interface WordNote {
  w: string;
  lemma: string;
  pos: string;
  zh: string;
}

/** 固定搭配：m 句中原文，p 词典形式 */
export interface Phrase {
  m: string;
  p: string;
  zh: string;
}

/** 通过校验后的句子内容（出题、导入时用） */
export interface SentenceBody {
  level: string;
  focus: string;
  segs: Seg[];
  trunk: string;
  trunkZh: string;
  trap: string;
  tip: string;
  ref: string;
  opts: Opt[];
  words: WordNote[];
  phrases: Phrase[];
}

/** 句库里的一句（GET /api/sentences）。旧数据里有的文字字段可能是 null */
export interface Sentence {
  id: string;
  created: string;
  batch: string;
  source: SentenceSource;
  level: string | null;
  focus: string | null;
  segs: Seg[];
  trunk: string | null;
  trunkZh: string | null;
  trap: string | null;
  tip: string | null;
  ref: string | null;
  opts: Opt[];
  words: WordNote[];
  phrases: Phrase[];
}

/** 谓语标注的一处：按整句单词下标，a 到 b（含） */
export interface MarkSpan {
  kind: 'main' | 'sub';
  a: number;
  b: number;
}

// ---- 练习记录、批改 -------------------------------------------------------------
export interface VerbsResult {
  ok: number;
  total: number;
  wrong: number;
}

export interface ChoiceResult {
  pick: number;
  ok: boolean;
}

export interface PracticeRecord {
  sentenceId: string;
  done: boolean;
  verbs: VerbsResult | null;
  choice: ChoiceResult | null;
  draft: string | null;
  firstAt: string;
  updatedAt: string;
}

/** PUT /api/records/:id 的请求体：只写传了的字段 */
export interface RecordPatch {
  done?: boolean;
  verbs?: VerbsResult | null;
  choice?: ChoiceResult | null;
  draft?: string | null;
}

export interface Issue {
  src: string;
  type: string;
  why: string;
  fix: string;
}

export interface Feedback {
  level: string;
  good: string[];
  issues: Issue[];
  better: string;
}

export interface Attempt {
  id: number;
  sentenceId: string;
  text: string;
  acc: number | null;
  flu: number | null;
  comp: number | null;
  total: number | null;
  feedback: Feedback | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string;
}

/** 查词结果 */
export interface DictEntry {
  lemma: string;
  ipa: string;
  pos: string;
  zh: string;
  more: string;
}

export interface LookupResult {
  word: string;
  data: DictEntry;
  cached: boolean;
}

export interface Usage {
  day: string;
  grades: number;
  lookups: number;
  gens: number;
  limits: { grade: number; lookup: number; generate: number };
  aiReady: boolean;
}

// ---- 账户 --------------------------------------------------------------------
export type AccountRole = 'owner' | 'member';

export type Session = { unlocked: false } | { unlocked: true; role: AccountRole; name: string };

export interface Device {
  id: string;
  label: string;
  ip: string | null;
  firstSeen: string;
  lastSeen: string;
}

/** 邀请码管理页的一项 */
export interface Invite {
  id: string;
  note: string;
  code: string;
  createdAt: string;
  lastSeenAt: string | null;
  deviceLimit: number;
  devices: Device[];
}

// ---- 设置 --------------------------------------------------------------------
/** 每日任务设置（GET/PUT /api/settings/practice） */
export interface PracticeSettings {
  levels: Level[];
  dailyCount: number;
  /** 这个账户有没有开自动生成 */
  autoDaily: boolean;
  /** 每天自动生成的时间，北京时间 HH:MM */
  dailyAt: string;
  maxDaily: number;
  /** 服务器 .env 有没有开每日出题 */
  serverDaily: boolean;
}

export type ProviderId = 'deepseek' | 'qwen' | 'glm' | 'kimi' | 'custom';

/** 某个平台保存的模型配置（不含密钥原文） */
export interface ProviderView {
  saved: boolean;
  fromEnv: boolean;
  baseUrl: string;
  mainModel: string;
  lightModel: string;
  jsonMode: boolean;
  thinking: boolean;
  hasKey: boolean;
  keyHint: string;
  keyBroken: boolean;
  updatedAt: string | null;
}

/** GET /api/settings/llm */
export interface LlmSettingsView {
  /** page = 网页上保存的；env = .env 文件；none = 没配置 */
  source: 'page' | 'env' | 'none';
  ready: boolean;
  provider: ProviderId | null;
  providerName: string;
  baseUrl: string;
  mainModel: string;
  lightModel: string;
  jsonMode: boolean;
  thinking: boolean;
  hasKey: boolean;
  keyHint: string;
  keyBroken: boolean;
  envAvailable: boolean;
  envProvider: ProviderId | null;
  updatedAt: string | null;
  providers: Partial<Record<ProviderId, ProviderView>>;
}

/** 测试连接、获取模型列表、保存时提交的表单 */
export interface LlmForm {
  provider?: ProviderId;
  baseUrl?: string;
  apiKey?: string;
  mainModel?: string;
  lightModel?: string;
  jsonMode?: boolean;
  thinking?: boolean;
}

export interface LlmTestItem {
  model: string;
  ok: boolean;
  latencyMs: number;
  answeredBy?: string;
  error?: string;
  sample?: string;
}

export interface LlmTestResult {
  ok: boolean;
  results: LlmTestItem[];
}
