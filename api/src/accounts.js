// 账户：你自己用访问密码登录（owner，可以管理邀请码和模型设置）；别人用你生成的邀请码登录（member）。
// 一个邀请码对应一个账户，邀请码就是它的登录密码；删除邀请码就删除这个账户和它的全部数据。
// 邀请账户用 AI 时用它自己在“设置”里填的模型和 API 密钥，不会用到你的。
import crypto from 'node:crypto';
import * as repo from './repo.js';
import { HttpError } from './http.js';
import { encrypt, decrypt } from './secret.js';

// 去掉了容易看错的 0 O 1 I L
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const TOUCH_EVERY = 10 * 60 * 1000;

const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** 输入的邀请码统一成大写、去掉空格和横线，abcd-efgh 和 ABCDEFGH 都能登录 */
export const normalizeCode = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const codeHash = (code) => sha256hex(`invite:${normalizeCode(code)}`);
/** 8 位，显示成 ABCD-EFGH */
export function newCode(rand = crypto.randomInt) {
  let c = '';
  for (let i = 0; i < 8; i++) c += ALPHABET[rand(ALPHABET.length)];
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}
const newId = () => `m${crypto.randomBytes(5).toString('hex')}`;
/** cookie 里带的版本号：owner 跟着访问密码变，member 跟着邀请码变 */
export const memberVersion = (acc) => String(acc.codeHash || '').slice(0, 12);

const cleanNote = (v) => String(v ?? '').trim().slice(0, 30);

export function createAccounts(cfg) {
  /** 管理页显示的样子：邀请码解密后给你看，方便再发给对方 */
  const view = (a) => ({
    id: a.id,
    note: a.note,
    code: decrypt(a.codeEnc, cfg.cookieSecret) || '（解不开：改过 COOKIE_SECRET）',
    createdAt: a.createdAt,
    lastSeenAt: a.lastSeenAt,
  });

  /** 登录时找邀请码对应的账户 */
  const findByCode = (input) => (normalizeCode(input).length === 8 ? repo.findAccountByCode(codeHash(input)) : null);

  /** 校验 cookie 里的账户还在、版本对得上；顺便更新“最近使用”（10 分钟最多写一次） */
  async function resolve(token, ownerVersion) {
    if (!token?.a) return null;
    const acc = await repo.getAccount(token.a);
    if (!acc) return null;
    const ok = acc.role === 'owner' ? token.v === ownerVersion : token.v === memberVersion(acc);
    if (!ok) return null;
    if (!acc.lastSeenAt || Date.now() - Date.parse(acc.lastSeenAt) > TOUCH_EVERY) {
      acc.lastSeenAt = new Date().toISOString();
      repo.touchAccount(acc.id).catch(() => {});
    }
    return acc;
  }

  async function list() {
    return (await repo.listMembers()).map(view);
  }

  async function create(body = {}) {
    for (let tries = 0; tries < 5; tries++) {
      const code = newCode();
      const id = newId();
      if (await repo.insertMember({ id, note: cleanNote(body.note), codeHash: codeHash(code), codeEnc: encrypt(code, cfg.cookieSecret) })) {
        return view(await repo.getAccount(id));
      }
    }
    throw new HttpError(500, '生成邀请码失败，再试一次');
  }

  async function remove(id) {
    if (!(await repo.deleteMember(id))) throw new HttpError(404, '这个邀请码不存在');
  }

  return { findByCode, resolve, list, create, remove };
}
