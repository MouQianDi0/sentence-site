// 加密保存在数据库里的 API 密钥（AES-256-GCM，密钥由 COOKIE_SECRET 派生）。
// 这样数据库备份里看不到明文密钥。注意：改了 COOKIE_SECRET 之后，已保存的密钥需要重新填写。
import crypto from 'node:crypto';

const keyFrom = (secret: string) => crypto.createHash('sha256').update(`llm-api-key:${secret}`).digest();

export function encrypt(text: string, secret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join(
    '.',
  );
}

/** 解不开（密文被改过、COOKIE_SECRET 变了）时返回 null */
export function decrypt(payload: unknown, secret: string): string | null {
  try {
    const [v, iv, tag, data] = String(payload).split('.');
    if (v !== 'v1' || !iv || !tag || !data) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** sk-abcdefgh1234 → sk-…1234 */
export function maskKey(key: string | null | undefined): string {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 8) return '••••';
  const prefix = /^[A-Za-z]{2,4}-/.exec(k)?.[0] || '';
  return `${prefix}…${k.slice(-4)}`;
}
