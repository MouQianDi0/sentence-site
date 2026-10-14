// 极简路由：支持 /api/records/:sentenceId 这样的路径参数
export interface RouteOpts {
  /** 不用登录就能访问 */
  public?: boolean;
  /** 只有你自己（访问密码登录的账户）能用 */
  owner?: boolean;
}

export interface Route<H> {
  method: string;
  re: RegExp;
  keys: string[];
  handler: H;
  opts: RouteOpts;
}

export type RouteMatch<H> = { route: Route<H>; params: Record<string, string> } | { route: null; pathMatched: boolean };

export function createRouter<H>() {
  const routes: Route<H>[] = [];

  function add(method: string, pattern: string, handler: H, opts: RouteOpts = {}): void {
    const keys: string[] = [];
    const source = pattern.replace(/:([A-Za-z]+)/g, (_, key: string) => {
      keys.push(key);
      return '([^/]+)';
    });
    routes.push({ method, re: new RegExp(`^${source}$`), keys, handler, opts });
  }

  /** 路径里的参数解码失败（如 %E0）时抛出 URIError */
  function match(method: string, path: string): RouteMatch<H> {
    let pathMatched = false;
    for (const route of routes) {
      const m = route.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(m[i + 1] ?? '');
      });
      return { route, params };
    }
    return { route: null, pathMatched };
  }

  return { add, match };
}
