// HTTP 小工具：错误类型、JSON 响应、读取请求体、Cookie、客户端 IP
import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from 'node:http';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 请求体：JSON 对象，字段都要自己检查 */
export type JsonBody = Record<string, unknown>;

export function send(res: ServerResponse, status: number, body: unknown, headers: OutgoingHttpHeaders = {}): void {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

export function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<JsonBody> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, '请求内容太大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          return reject(new HttpError(400, '请求内容必须是 JSON 对象'));
        }
        resolve(data as JsonBody);
      } catch {
        reject(new HttpError(400, '请求内容不是合法的 JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function parseCookies(header = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // 格式不对的 Cookie 直接忽略
    }
  }
  return out;
}

export function clientIp(req: IncomingMessage): string {
  return String(req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown');
}

export function isHttps(req: IncomingMessage): boolean {
  return req.headers['x-forwarded-proto'] === 'https';
}
