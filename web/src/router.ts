// 页面地址：练习、记录、设置各有自己的地址；设置下面还有两个单独的页面：邀请码管理、Token 用量。
//   /practice   /records   /settings   /settings/invites   /settings/usage
// 换页只改地址栏、不重新加载，切换动画和以前一样；刷新、收藏、前进后退都会停在对应的页面。
// 服务器（nginx/default.conf 的 try_files）对这些地址都返回同一个 index.html。
import type { ViewName } from './state.ts';

export const PATHS: Record<ViewName, string> = {
  practice: '/practice',
  records: '/records',
  settings: '/settings',
};

/** 设置下面的单独页面：邀请码管理（只有你自己）、Token 用量（每个账户都有） */
export type SettingsSub = 'invites' | 'usage';
export const SUB_PATHS: Record<SettingsSub, string> = {
  invites: '/settings/invites',
  usage: '/settings/usage',
};
const SUBS = Object.keys(SUB_PATHS) as SettingsSub[];

const TITLES: Record<ViewName, string> = { practice: '练习', records: '记录', settings: '设置' };
const SUB_TITLES: Record<SettingsSub, string> = { invites: '邀请码管理', usage: 'Token 用量' };
const SITE = '长难句拆解台';

export interface Route {
  view: ViewName;
  /** 设置下面的哪个单独页面；在设置主页或别的页时是 null */
  sub: SettingsSub | null;
}

/** 从地址认出是哪一页；认不出（比如首页 /）返回 null */
export function parseRoute(path = location.pathname, hash = location.hash): Route | null {
  const p = path.replace(/\/+$/, '') || '/';
  // #invites 是以前邀请码页的地址，收藏过的还能打开
  if (hash === '#invites') return { view: 'settings', sub: 'invites' };
  const sub = SUBS.find((s) => SUB_PATHS[s] === p);
  if (sub) return { view: 'settings', sub };
  for (const view of Object.keys(PATHS) as ViewName[]) {
    if (PATHS[view] === p) return { view, sub: null };
  }
  return null;
}

/** 现在的地址是设置下面的哪个单独页面（不是的话 null） */
export const atSub = (): SettingsSub | null => parseRoute()?.sub ?? null;

/** 地址栏换成这个地址，不加历史记录 */
export function replacePath(path: string): void {
  if (location.pathname !== path || location.hash) history.replaceState(null, '', path + location.search);
}

/** 进入另一页：加一条历史记录，浏览器的返回能回来 */
export function pushPath(path: string): void {
  if (location.pathname !== path) history.pushState(null, '', path + location.search);
}

export function setTitle(view: ViewName, sub: SettingsSub | null = null): void {
  document.title = `${sub ? SUB_TITLES[sub] : TITLES[view]} · ${SITE}`;
}
