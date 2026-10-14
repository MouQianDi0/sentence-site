// 页面地址：练习、记录、设置各有自己的地址，邀请码管理是设置下面的一页。
//   /practice   /records   /settings   /settings/invites
// 换页只改地址栏、不重新加载，切换动画和以前一样；刷新、收藏、前进后退都会停在对应的页面。
// 服务器（nginx/default.conf 的 try_files）对这些地址都返回同一个 index.html。
import type { ViewName } from './state.ts';

export const PATHS: Record<ViewName, string> = {
  practice: '/practice',
  records: '/records',
  settings: '/settings',
};
export const INVITES_PATH = '/settings/invites';

const TITLES: Record<ViewName, string> = { practice: '练习', records: '记录', settings: '设置' };
const SITE = '长难句拆解台';

export interface Route {
  view: ViewName;
  invites: boolean;
}

/** 从地址认出是哪一页；认不出（比如首页 /）返回 null */
export function parseRoute(path = location.pathname, hash = location.hash): Route | null {
  const p = path.replace(/\/+$/, '') || '/';
  // #invites 是以前邀请码页的地址，收藏过的还能打开
  if (p === INVITES_PATH || hash === '#invites') return { view: 'settings', invites: true };
  for (const view of Object.keys(PATHS) as ViewName[]) {
    if (PATHS[view] === p) return { view, invites: false };
  }
  return null;
}

/** 现在的地址是不是邀请码管理页 */
export const atInvites = (): boolean => !!parseRoute()?.invites;

/** 地址栏换成这个地址，不加历史记录 */
export function replacePath(path: string): void {
  if (location.pathname !== path || location.hash) history.replaceState(null, '', path + location.search);
}

/** 进入另一页：加一条历史记录，浏览器的返回能回来 */
export function pushPath(path: string): void {
  if (location.pathname !== path) history.pushState(null, '', path + location.search);
}

export function setTitle(view: ViewName, invites = false): void {
  document.title = `${invites ? '邀请码管理' : TITLES[view]} · ${SITE}`;
}
