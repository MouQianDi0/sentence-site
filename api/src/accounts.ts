// 账户：你自己用访问密码登录（owner，可以管理邀请码和模型设置）；别人用你生成的邀请码登录（member）。
// 一个邀请码对应一个账户，邀请码就是它的登录密码；删除邀请码就删除这个账户和它的全部数据。
// 邀请账户用 AI 时用它自己在“设置”里填的模型和 API 密钥，不会用到你的。
// 每个邀请码最多能在 deviceLimit 台设备上登录（默认 2）：设备编号是网站发给浏览器的随机串，你可以在管理页移除设备。
// 有效期（30 / 90 / 180 / 360 天或永久）从对方第一次登录开始算；到期后登不进来、已登录的也会退出，
// 数据都保留，你在管理页改一下有效期（从改的时候重新算）就能续上。
import crypto from 'node:crypto';
import type { Invite, ValidDays } from '@sentence-site/shared';
import type { AppConfig } from './config.ts';
import * as repo from './repo.ts';
import { daysAgo } from './tokens.ts';
import type { AccountRow, DeviceRow } from './repo.ts';
import { HttpError, type JsonBody } from './http.ts';
import { encrypt, decrypt } from './secret.ts';

/** Cookie 里解出来的登录信息：账户 id、版本号、设备编号 */
export interface Token {
  a: string;
  v: unknown;
  d?: unknown;
}

// 去掉了容易看错的 0 O 1 I L
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const TOUCH_EVERY = 10 * 60 * 1000;

const sha256hex = (s: string) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** 输入的邀请码统一成大写、去掉空格和横线，abcd-efgh 和 ABCDEFGH 都能登录 */
export const normalizeCode = (s: unknown): string =>
  String(s ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
export const codeHash = (code: unknown): string => sha256hex(`invite:${normalizeCode(code)}`);
/** 8 位，显示成 ABCD-EFGH */
export function newCode(rand: (max: number) => number = crypto.randomInt): string {
  let c = '';
  for (let i = 0; i < 8; i++) c += ALPHABET[rand(ALPHABET.length)];
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}
const newId = () => `m${crypto.randomBytes(5).toString('hex')}`;
/** cookie 里带的版本号：owner 跟着访问密码变，member 跟着邀请码变 */
export const memberVersion = (acc: Pick<AccountRow, 'codeHash'>): string => String(acc.codeHash || '').slice(0, 12);

const cleanNote = (v: unknown) =>
  String(v ?? '')
    .trim()
    .slice(0, 30);

export const MAX_DEVICES = 10;

/** 能选的有效期（天）；null 表示永久。前端 web/src/settings/invites.ts 有一份同样的列表 */
export const VALID_DAYS: ValidDays[] = [30, 90, 180, 360];

/** 管理页传来的有效期：30 / 90 / 180 / 360，或者 null（永久）；别的值报错 */
export function parseValidDays(v: unknown): ValidDays | null {
  if (v === null || v === undefined || v === '' || v === 'forever') return null;
  const n = Number(v);
  if (!VALID_DAYS.includes(n as ValidDays)) throw new HttpError(400, '有效期只能选 30、90、180、360 天或永久');
  return n as ValidDays;
}

/** 已经过期了吗（永久、还没登录过的都不算） */
export const isExpired = (acc: Pick<AccountRow, 'expiresAt'>, now = Date.now()): boolean =>
  Boolean(acc.expiresAt) && Date.parse(acc.expiresAt ?? '') <= now;

/** 过期后登录、或者用着用着过期了时的提示 */
export const EXPIRED_MESSAGE = '这个邀请码已经过期了，请联系管理员续期。你的句库和练习记录都还在，续期后就能接着用。';
/** 网站发给浏览器的设备编号：22 位随机串 */
export const newDeviceId = () => crypto.randomBytes(16).toString('base64url');
export const isDeviceId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{22}$/.test(v);

/** 从浏览器信息里认出大概是什么设备，例如“iPhone · 微信”“Windows · Edge” */
export function deviceLabel(ua: unknown = ''): string {
  const u = String(ua);
  const os = /iPhone/.test(u)
    ? 'iPhone'
    : /iPad/.test(u)
      ? 'iPad'
      : /HarmonyOS|OpenHarmony/i.test(u)
        ? '鸿蒙'
        : /Android/.test(u)
          ? 'Android'
          : /Windows/.test(u)
            ? 'Windows'
            : /Macintosh|Mac OS X/.test(u)
              ? 'Mac'
              : /Linux/.test(u)
                ? 'Linux'
                : '未知系统';
  const browser = /MicroMessenger/i.test(u)
    ? '微信'
    : /MQQBrowser/.test(u)
      ? 'QQ 浏览器'
      : /\bQQ\//.test(u)
        ? 'QQ'
        : /Quark/i.test(u)
          ? '夸克'
          : /UCBrowser/i.test(u)
            ? 'UC'
            : /HuaweiBrowser/i.test(u)
              ? '华为浏览器'
              : /MiuiBrowser|XiaoMi/i.test(u)
                ? '小米浏览器'
                : /EdgA?\/|Edg\//.test(u)
                  ? 'Edge'
                  : /Firefox|FxiOS/.test(u)
                    ? 'Firefox'
                    : /CriOS|Chrome/.test(u)
                      ? 'Chrome'
                      : /Safari/.test(u)
                        ? 'Safari'
                        : '浏览器';
  return `${os} · ${browser}`;
}

export function createAccounts(cfg: Pick<AppConfig, 'cookieSecret'>) {
  /** 管理页显示的样子：邀请码解密后给你看，方便再发给对方 */
  const view = (
    a: AccountRow,
    devices: DeviceRow[] = [],
    used: { recent: number; total: number } = { recent: 0, total: 0 },
  ): Invite => ({
    id: a.id,
    note: a.note,
    code: decrypt(a.codeEnc, cfg.cookieSecret) || '（解不开：改过 COOKIE_SECRET）',
    createdAt: a.createdAt,
    lastSeenAt: a.lastSeenAt,
    deviceLimit: a.deviceLimit,
    devices: devices.map(({ id, label, ip, firstSeen, lastSeen }) => ({ id, label, ip, firstSeen, lastSeen })),
    tokens: { last30: used.recent, total: used.total },
    validDays: (a.validDays as ValidDays | null) ?? null,
    activatedAt: a.activatedAt,
    expiresAt: a.expiresAt,
    expired: isExpired(a),
  });

  /** 每个账户用掉的 token：近 30 天（含今天）和累计 */
  const tokens = () => repo.tokensByAccount(daysAgo(29));

  /** 登录时找邀请码对应的账户 */
  const findByCode = async (input: unknown): Promise<AccountRow | null> =>
    normalizeCode(input).length === 8 ? repo.findAccountByCode(codeHash(input)) : null;

  /**
   * 校验 cookie 里的账户还在、版本对得上；邀请账户还要这台设备没被移除、邀请码没过期。
   * 过期了抛出 401 并说明原因（登录页上显示）。顺便更新“最近使用”（10 分钟最多写一次）。
   */
  async function resolve(token: Token | null, ownerVersion: string, ip = ''): Promise<AccountRow | null> {
    if (!token?.a) return null;
    const acc = await repo.getAccount(token.a);
    if (!acc) return null;
    const ok = acc.role === 'owner' ? token.v === ownerVersion : token.v === memberVersion(acc);
    if (!ok) return null;
    if (acc.role === 'member' && isExpired(acc)) throw new HttpError(401, EXPIRED_MESSAGE);
    if (acc.role === 'member') {
      const device = isDeviceId(token.d) ? await repo.getDevice(acc.id, token.d) : null;
      if (!device) return null;
      if (Date.now() - Date.parse(device.lastSeen) > TOUCH_EVERY || device.ip !== ip) {
        repo.touchDevice(acc.id, device.id, ip).catch(() => {});
      }
    }
    if (!acc.lastSeenAt || Date.now() - Date.parse(acc.lastSeenAt) > TOUCH_EVERY) {
      acc.lastSeenAt = new Date().toISOString();
      repo.touchAccount(acc.id).catch(() => {});
    }
    return acc;
  }

  /** 邀请账户登录：过期了就不让进（不登记设备）；第一次登录时开始算有效期。返回最新的账户信息 */
  async function checkIn(acc: AccountRow): Promise<AccountRow> {
    if (isExpired(acc)) throw new HttpError(403, EXPIRED_MESSAGE);
    if (acc.activatedAt) return acc;
    await repo.activateAccount(acc.id);
    return (await repo.getAccount(acc.id)) ?? acc;
  }

  /**
   * 邀请账户登录时登记设备：登录过的设备直接放行；新设备在没到上限时登记，到了上限返回 false。
   */
  async function useDevice(
    acc: AccountRow,
    deviceId: string,
    { ua = '', ip = '' }: { ua?: string; ip?: string } = {},
  ): Promise<boolean> {
    if (await repo.getDevice(acc.id, deviceId)) {
      await repo.touchDevice(acc.id, deviceId, ip);
      return true;
    }
    return repo.addDevice({ accountId: acc.id, deviceId, label: deviceLabel(ua), ip });
  }

  async function list(): Promise<Invite[]> {
    const devices = await repo.listMemberDevices();
    const used = await tokens();
    return (await repo.listMembers()).map((a) =>
      view(
        a,
        devices.filter((d) => d.accountId === a.id),
        used[a.id],
      ),
    );
  }

  /** 改某个邀请码能登录的设备数（1–10）。调小时已经登录的设备不会被踢掉 */
  async function setDeviceLimit(id: string, n: unknown): Promise<Invite> {
    const v = Number(n);
    if (!Number.isInteger(v) || v < 1 || v > MAX_DEVICES) throw new HttpError(400, `设备数要在 1–${MAX_DEVICES} 之间`);
    if (!(await repo.setDeviceLimit(id, v))) throw new HttpError(404, '这个邀请码不存在');
    return one(id);
  }

  /**
   * 改有效期（30 / 90 / 180 / 360 天，null 是永久）。对方登录过的从现在开始重新算，所以过期的账户改一下就续上了；
   * 还没登录过的仍从第一次登录开始算。
   */
  async function setValidity(id: string, v: unknown): Promise<Invite> {
    if (!(await repo.setValidity(id, parseValidDays(v)))) throw new HttpError(404, '这个邀请码不存在');
    return one(id);
  }

  /** 移除一台设备：它马上退出登录，空出的名额可以给别的设备用 */
  async function removeDevice(id: string, deviceId: string): Promise<Invite> {
    if (!(await repo.deleteDevice(id, deviceId))) throw new HttpError(404, '这台设备不存在');
    return one(id);
  }

  async function one(id: string): Promise<Invite> {
    const acc = await repo.getAccount(id);
    if (!acc || acc.role !== 'member') throw new HttpError(404, '这个邀请码不存在');
    return view(
      acc,
      (await repo.listMemberDevices()).filter((d) => d.accountId === id),
      (await tokens())[id],
    );
  }

  /** 生成邀请码。body：{note 备注名, validDays 有效期天数（不传或 null 是永久）} */
  async function create(body: JsonBody = {}): Promise<Invite> {
    const validDays = parseValidDays(body.validDays);
    for (let tries = 0; tries < 5; tries++) {
      const code = newCode();
      const id = newId();
      if (
        await repo.insertMember({
          id,
          note: cleanNote(body.note),
          codeHash: codeHash(code),
          codeEnc: encrypt(code, cfg.cookieSecret),
          validDays,
        })
      ) {
        return one(id);
      }
    }
    throw new HttpError(500, '生成邀请码失败，再试一次');
  }

  async function remove(id: string): Promise<void> {
    if (!(await repo.deleteMember(id))) throw new HttpError(404, '这个邀请码不存在');
  }

  return {
    findByCode,
    resolve,
    checkIn,
    useDevice,
    list,
    create,
    remove,
    setDeviceLimit,
    setValidity,
    removeDevice,
  };
}
