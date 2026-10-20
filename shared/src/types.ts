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

/** 后台每一次独立评分的三项分数 */
export interface RunScore {
  acc: number;
  flu: number;
  comp: number;
}

export interface Feedback {
  level: string;
  good: string[];
  issues: Issue[];
  better: string;
  /** 开着“准确度提升”时，后台几次独立评分各自的分数（页面不显示，留着核对；只评 1 次时没有） */
  runs?: RunScore[];
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

// ---- token 用量 -----------------------------------------------------------------
/** 用到模型的地方：批改、查词、出题、复核谓语、测试连接、标注题库（只有 owner，永远不走 ChatGPT） */
export type TokenKind = 'grade' | 'lookup' | 'generate' | 'review' | 'test' | 'annotate';

/** 一段时间里的用量：输入、输出 token 数和调用次数 */
export interface TokenCount {
  input: number;
  output: number;
  calls: number;
}

/** GET /api/usage/tokens?days=7|30|90：当前账户自己的用量 */
export interface TokenStats {
  /** daily、byKind、byModel 统计的是最近几天（含今天） */
  days: number;
  today: TokenCount;
  last7: TokenCount;
  last30: TokenCount;
  total: TokenCount;
  /** 每天的用量，从早到晚，没用的那天是 0 */
  daily: (TokenCount & { day: string })[];
  /** 这几天里按用途、按模型分开的用量，多的在前 */
  byKind: (TokenCount & { kind: TokenKind })[];
  byModel: (TokenCount & { model: string })[];
  /** 最早有记录的那天（YYYY-MM-DD）；还没有记录时是 null */
  since: string | null;
}

// ---- 账户 --------------------------------------------------------------------
export type AccountRole = 'owner' | 'member';

/** 邀请码能选的有效期（天）；null 表示永久。后端 accounts.ts、前端 invites.ts 各有一份同样的列表 */
export type ValidDays = 30 | 90 | 180 | 360;

/**
 * GET /api/session。notice：没登录的原因（比如邀请码过期了），登录页上显示。
 * expiresAt：邀请账户的到期时间（永久或你自己是 null）
 */
type SignedOut = { unlocked: false; notice?: string };
type SignedIn = { unlocked: true; role: AccountRole; name: string; expiresAt?: string | null };
export type Session = SignedOut | SignedIn;

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
  /** 这个账户用掉的 token（输入 + 输出）：近 30 天、累计 */
  tokens: { last30: number; total: number };
  /** 有效期天数（30 / 90 / 180 / 360），null 表示永久。从对方第一次登录开始算 */
  validDays: ValidDays | null;
  /** 第一次登录的时间，还没登录过是 null */
  activatedAt: string | null;
  /** 到期时间；永久或还没登录过是 null */
  expiresAt: string | null;
  /** 已经过期：对方登不进来，数据还在，改有效期就能续上 */
  expired: boolean;
}

// ---- 外部题库（只有你自己能管理）---------------------------------------------------
/** review 原文要看一眼；raw 等着标注；ready 能抽；rejected 不要；retired 最近一次导入的文件里没有了 */
export type BankStatus = 'review' | 'raw' | 'ready' | 'rejected' | 'retired';

/** 后台标注的进度（同一时间只跑一批） */
export interface BankJob {
  running: boolean;
  total: number;
  done: number;
  ready: number;
  rejected: number;
  /** 模型出错、留在 raw 等下次的句数 */
  failed: number;
  startedAt: string;
  finishedAt: string | null;
  /** 停下来的原因（模型没配好、密钥无效……），正常跑完是空字符串 */
  error: string;
}

/** GET /api/admin/bank */
export interface BankAdmin {
  banks: {
    id: string;
    name: string;
    enabled: boolean;
    importedAt: string | null;
    counts: Record<BankStatus, number>;
  }[];
  job: BankJob | null;
  /** 标注用的国内模型配好了没有（标注不用 ChatGPT） */
  llmReady: boolean;
}

/** 管理页列出的一句 */
export interface BankItem {
  id: number;
  bankId: string;
  externalId: string;
  text: string;
  /** 改过的原文；没改过是 null */
  textFix: string | null;
  status: BankStatus;
  /** 题库自己的质量状态 */
  srcQuality: string;
  rejectReason: string | null;
  origin: string;
  tags: string[];
  updatedAt: string;
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
  /** AI 批改的“准确度提升”：开着时后台独立评分 5 次取平均、再汇总批注；关着只评 1 次 */
  accuracyBoost: boolean;
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

// ---- ChatGPT 套餐（Sign in with ChatGPT，只有你自己的账户能用）--------------------------
/** 哪些用途走 ChatGPT 套餐：改题；出题（含出题后的谓语复核）；查词 */
export interface ChatgptUse {
  grade: boolean;
  generate: boolean;
  lookup: boolean;
}

/** ChatGPT 账号能用的模型（/v1/models 里 visibility 是 list 的） */
export interface ChatgptModel {
  slug: string;
  name: string;
}

/**
 * GET /api/settings/chatgpt
 * status：none 没连接；ok 正常；reauth 授权失效要重新连接；ineligible 这个账号不能用套餐额度（要 Plus 或 Pro）
 */
export interface ChatgptView {
  /** .env 里有没有配 OPENAI_PROXY（服务器在国内时必须配） */
  proxy: boolean;
  status: 'none' | 'ok' | 'reauth' | 'ineligible';
  email: string;
  name: string;
  /** 授权时同意了“使用 ChatGPT 套餐”（chatgpt.tokens.use.direct） */
  planGranted: boolean;
  mainModel: string;
  lightModel: string;
  use: ChatgptUse;
  /** 每日任务定时自动出题时也用 ChatGPT（后台调用，打开才算同意） */
  background: boolean;
  /** 额度用完后暂停到什么时候；没暂停是 null */
  pausedUntil: string | null;
  pauseReason: string;
  lastError: { at: string; message: string } | null;
  connectedAt: string | null;
  /** 现在能用 ChatGPT 出题改题 */
  ready: boolean;
  /** 国内模型配好了没有（ChatGPT 用不了时回退到它） */
  fallbackReady: boolean;
}

/** POST /api/settings/chatgpt/start：在浏览器里打开 url 授权 */
export interface ChatgptStart {
  url: string;
  /** 授权完成后浏览器会跳到这个前缀开头的地址（打不开是正常的），把整段地址粘贴回来 */
  redirectPrefix: string;
}

/** DELETE /api/settings/chatgpt：revoked 是 OpenAI 那边确认吊销了授权 */
export interface ChatgptDisconnect {
  view: ChatgptView;
  revoked: boolean;
}
