// 页面状态：句库、练习记录、当前句子和各步骤的进度。各模块直接读写 state 里的字段，改完再调对应的 render。
import type {
  AccountRole,
  Attempt,
  DictEntry,
  PracticeRecord,
  PracticeSettings,
  Sentence,
  Usage,
} from '@sentence-site/shared';
import { ls } from './lib/storage.ts';
import { parseRoute } from './router.ts';

export type ViewName = 'practice' | 'records' | 'settings';

/** 记在本机的界面设置 */
export interface UiPrefs {
  /** 上次停在哪一页（直接打开首页 / 时回到这一页） */
  view?: ViewName;
  /** 上次练到的句子 */
  cur?: string;
  /** 上次打开页面的时间（提示“新增了几句”用） */
  lastVisit?: string;
  /** 句子卡片固定在屏幕顶部 */
  pin?: boolean;
  voice?: string;
  rate?: number;
}

/** 页面上的练习记录：本地先改，再异步存到服务器，所以有的字段可能还没有 */
export type LocalRecord = Partial<PracticeRecord> & { sentenceId: string; done: boolean };

/** 第 1 步修正谓语标注：每个单词是 main / sub / null */
export interface FixState {
  tag: ('main' | 'sub' | null)[];
  busy: '' | 'save' | 'ai';
  msg: string;
}

export interface Me {
  role: AccountRole;
  name: string;
}

const LS_UI = 'ssite-ui';
const LS_DICT = 'ssite-dict';

const ui = ls.get<UiPrefs>(LS_UI, {}) || {};

export const state = {
  sentences: [] as Sentence[],
  records: {} as Record<string, LocalRecord>,
  /** sentenceId -> 批改历史（新的在前） */
  attempts: {} as Record<string, Attempt[]>,
  usage: null as Usage | null,
  ui,
  /** 查词缓存：`单词|句子 id` -> 释义 */
  dictCache: (ls.get<Record<string, DictEntry>>(LS_DICT, {}) || {}) as Record<string, DictEntry>,
  /** 现在显示哪一页：地址说了算（/practice、/records、/settings），首页 / 回到上次那一页 */
  view: (parseRoute()?.view ?? (ui.view === 'records' || ui.view === 'settings' ? ui.view : 'practice')) as ViewName,
  loaded: false,
  /** 当前登录的账户 */
  me: null as Me | null,

  cur: null as Sentence | null,
  step: 1 as 1 | 2 | 3,
  /** 第 1 步点选了哪些词块 */
  picked: new Set<number>(),
  checked: false,
  /** 第 2 步各成分是否上色 */
  roleOn: {} as Record<string, boolean>,
  mainOnly: false,
  /** 第 2 步点开了第几段（-1 = 没点） */
  segPick: -1,
  /** 第 3 步选项的显示顺序 */
  optOrder: [] as number[],
  /** 第 3 步选了哪个选项（-1 = 还没选） */
  answer: -1,
  dictMode: false,
  /** 查词时选中的单词下标 */
  wordSel: null as number | null,
  /** 进入第 2 步时播一次荧光笔动画 */
  sweepPending: false,
  quizOpen: false,
  grading: false,
  gradeErr: '',
  /** 刚批改完，播一次分数动画 */
  freshFb: false,
  practiceCfg: {
    levels: ['CET-4', 'CET-6'],
    dailyCount: 5,
    maxDaily: 10,
    dailyAt: '07:50',
    autoDaily: true,
    serverDaily: true,
  } as PracticeSettings,
  /** 今日任务全部完成时，练习页显示完成页（点开某一句复习时关掉） */
  showDone: false,
  /** 正在生成：daily = 今日任务，extra = 加练 */
  taskBusy: '' as '' | 'daily' | 'extra',
  taskBusyN: 0,
  taskErr: '',
  /** 任务卡片里的“加练”展开 */
  extraOpen: false,
  extraCount: 3,
  /** 刚完成最后一句，完成页要放庆祝动画 */
  celebrate: false,
  fix: null as FixState | null,
  speaking: false,
  /** 正在查的词（`单词|句子 id`） */
  lookupBusy: null as string | null,
  lookupErr: null as { key: string; msg: string } | null,
};

export const saveUI = (): void => ls.set(LS_UI, state.ui);
export const saveDict = (): void => ls.set(LS_DICT, state.dictCache);

export const rec = (id: string): LocalRecord | null => state.records[id] || null;
export const atts = (id: string): Attempt[] => state.attempts[id] || [];
export const lastAttempt = (id: string): Attempt | null => atts(id)[0] || null;

/** AI 能不能用（还没读到用量时先当能用） */
export const aiOk = (): boolean => (state.usage ? state.usage.aiReady : true);

/** 今天（北京时间）的日期，和后端给句子打的 batch 一致，不受手机时区影响 */
export const today = (): string => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

const TASK_SOURCES = new Set(['daily', 'extra', 'manual']);

/** 今日任务：今天生成的句子（每日任务 + 加练）。还差几句没生成、完成了几句 */
export function taskInfo() {
  const d = today();
  const list = state.sentences.filter((s) => s.batch === d && TASK_SOURCES.has(s.source));
  const daily = list.filter((s) => s.source === 'daily').length;
  const done = list.filter((s) => rec(s.id)?.done).length;
  const missing = Math.max(0, state.practiceCfg.dailyCount - daily);
  return { list, daily, done, missing, complete: list.length > 0 && done === list.length && missing === 0 };
}
