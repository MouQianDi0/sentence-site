// 给发往 OpenAI 的请求走 HTTP 代理（服务器上的 Clash）。国内模型的请求不经过这里，照旧直连。
// 做法：先向代理发 HTTP CONNECT 建一条到 OpenAI 的隧道，再在隧道里走 TLS 和普通的 HTTP/1.1。
// 不依赖任何 npm 包；返回标准的 Response，body 边收边读（ChatGPT 的回复是流式的）。
// .env 里没配 OPENAI_PROXY 时直接用全局 fetch（服务器本来就在海外时）。
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { Readable } from 'node:stream';

/** OpenAI 相关请求用到的 fetch 参数（全局 fetch 的一个子集） */
export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type OpenaiFetch = (url: string, init?: FetchInit) => Promise<Response>;

/** 解析代理地址：只支持 http://（Clash 的 mixed-port / port 都是 HTTP 代理），可以带用户名密码 */
export function parseProxy(raw: string | null | undefined): URL | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`OPENAI_PROXY 不是合法的地址：${s}`);
  }
  if (u.protocol !== 'http:') {
    throw new Error('OPENAI_PROXY 要以 http:// 开头，填 Clash 的 HTTP 代理端口，例如 http://host.docker.internal:7890');
  }
  return u;
}

/** 代理地址去掉用户名密码（日志里显示用） */
export const proxyLabel = (u: URL): string => `${u.protocol}//${u.host}`;

/** IPv6 地址在 URL 里带方括号，连接时要去掉 */
const bare = (host: string) => host.replace(/^\[|\]$/g, '');

function abortError(signal: AbortSignal): Error {
  const r: unknown = signal.reason;
  if (r instanceof Error) return r;
  const e = new Error('请求被中止');
  e.name = 'AbortError';
  return e;
}

/** 通过代理建一条到 host:port 的 TCP 隧道 */
function tunnel(proxy: URL, host: string, port: number, signal?: AbortSignal): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `${host}:${port}` };
    if (proxy.username || proxy.password) {
      const cred = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(cred).toString('base64')}`;
    }
    const req = http.request({
      host: bare(proxy.hostname),
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
      agent: false,
    });
    const onAbort = () => req.destroy(abortError(signal as AbortSignal));
    signal?.addEventListener('abort', onAbort, { once: true });
    req.once('connect', (res, socket) => {
      signal?.removeEventListener('abort', onAbort);
      if (res.statusCode !== 200) {
        socket.destroy();
        const hint =
          res.statusCode === 407 ? '，代理要求用户名密码，写在 OPENAI_PROXY 里：http://用户名:密码@地址:端口' : '';
        reject(new Error(`代理 ${proxyLabel(proxy)} 拒绝连接 ${host}（${res.statusCode}）${hint}`));
        return;
      }
      resolve(socket);
    });
    req.once('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(abortError(signal));
      else
        reject(new Error(`连不上代理 ${proxyLabel(proxy)}：${e.message}。检查 Clash 有没有运行、有没有打开 allow-lan`));
    });
    req.end();
  });
}

/** 在隧道上握手 TLS（目标是 https 时）。ca 只给测试用：信任测试里临时生成的证书 */
function secure(raw: net.Socket, host: string, signal?: AbortSignal, ca?: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({
      socket: raw,
      servername: net.isIP(host) ? undefined : host,
      ALPNProtocols: ['http/1.1'],
      ...(ca ? { ca } : {}),
    });
    const onAbort = () => s.destroy(abortError(signal as AbortSignal));
    signal?.addEventListener('abort', onAbort, { once: true });
    s.once('secureConnect', () => {
      signal?.removeEventListener('abort', onAbort);
      resolve(s);
    });
    s.once('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.aborted ? abortError(signal) : e);
    });
  });
}

/** 把 Node 的响应头转成标准 Headers */
function toHeaders(raw: http.IncomingHttpHeaders): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) h.append(k, x);
    else h.set(k, String(v));
  }
  return h;
}

/**
 * 返回一个走代理的 fetch。proxyUrl 为空时就是全局 fetch。
 * opts.ca 只给测试用（信任临时生成的自签证书），正式运行不传，用系统自带的根证书。
 */
export function createOpenaiFetch(proxyUrl: string | null | undefined, opts: { ca?: string } = {}): OpenaiFetch {
  const proxy = parseProxy(proxyUrl);
  if (!proxy) return (url, init) => globalThis.fetch(url, init);

  return async (url, init = {}) => {
    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    if (!isHttps && target.protocol !== 'http:') throw new Error(`不支持的地址：${url}`);
    const host = bare(target.hostname);
    const port = Number(target.port) || (isHttps ? 443 : 80);
    const { signal } = init;
    if (signal?.aborted) throw abortError(signal);

    const raw = await tunnel(proxy, host, port, signal);
    let socket: net.Socket;
    try {
      socket = isHttps ? await secure(raw, host, signal, opts.ca) : raw;
    } catch (e) {
      raw.destroy();
      throw e;
    }

    return new Promise<Response>((resolve, reject) => {
      const body = init.body;
      const headers: Record<string, string> = {
        // 不要压缩：Node 的 http 不会自动解压
        'Accept-Encoding': 'identity',
        ...init.headers,
        Host: target.host,
        Connection: 'close',
      };
      if (body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(body));
      const req = http.request(
        {
          method: init.method || 'GET',
          host,
          port,
          path: `${target.pathname}${target.search}`,
          headers,
          // 隧道已经连好（https 时 TLS 也握手完了），直接在上面发 HTTP 请求。
          // 注意不能写 agent: false：那样 Node 会新建一个 Agent、不用这里的 createConnection，
          // 自己直连目标地址的 443 端口发明文，绕过代理（OpenAI 那边回 400）。
          createConnection: () => socket,
        },
        (res) => {
          const status = res.statusCode || 502;
          const empty = status === 204 || status === 304 || req.method === 'HEAD';
          res.once('close', () => {
            signal?.removeEventListener('abort', onAbort);
            socket.destroy();
          });
          if (empty) res.resume();
          const stream = empty ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
          resolve(
            new Response(stream, { status, statusText: res.statusMessage || '', headers: toHeaders(res.headers) }),
          );
        },
      );
      // 收到响应头之后中止（比如流式回复超时）：断开连接，正在读的 body 会报这个错误
      const onAbort = () => req.destroy(abortError(signal as AbortSignal));
      signal?.addEventListener('abort', onAbort, { once: true });
      req.once('error', (e) => {
        signal?.removeEventListener('abort', onAbort);
        socket.destroy();
        reject(signal?.aborted ? abortError(signal) : e);
      });
      req.end(body);
    });
  };
}
