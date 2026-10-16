// 检查服务器能不能连上 OpenAI（走 .env 里的 OPENAI_PROXY），以及 OpenAI 看到的是哪个国家或地区。
// 在服务器上运行：sudo docker compose exec api node scripts/check-openai.ts
import { createOpenaiFetch, parseProxy, proxyLabel } from '../src/openai-proxy.ts';

const raw = process.env.OPENAI_PROXY || '';
let proxy: URL | null = null;
try {
  proxy = parseProxy(raw);
} catch (e) {
  console.log(`✗ ${(e as Error).message}`);
  process.exit(1);
}
console.log(proxy ? `代理：${proxyLabel(proxy)}` : '代理：没配 OPENAI_PROXY（直连）');
const f = createOpenaiFetch(raw);
let ok = true;

async function step(name: string, url: string, check: (status: number, text: string) => string | null) {
  try {
    const res = await f(url, { signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    const bad = check(res.status, text);
    if (bad) {
      ok = false;
      console.log(`✗ ${name}：${bad}`);
    } else {
      console.log(`✓ ${name}`);
    }
    return text;
  } catch (e) {
    ok = false;
    console.log(`✗ ${name}：${(e as Error).message}`);
    return '';
  }
}

await step('OpenAI 授权服务器', 'https://auth.openai.com/.well-known/openid-configuration', (s) =>
  s === 200 ? null : `返回 ${s}`,
);
const trace = await step('出口地区', 'https://chatgpt.com/cdn-cgi/trace', (s) => (s === 200 ? null : `返回 ${s}`));
const loc = /^loc=(\w+)/m.exec(trace)?.[1];
if (loc) {
  const blocked = ['CN', 'HK', 'MO'].includes(loc);
  if (blocked) ok = false;
  console.log(
    `${blocked ? '✗' : '✓'} OpenAI 看到的地区：${loc}${blocked ? '（不在 OpenAI 支持的地区，在 Clash 里给 openai.com 换个节点）' : ''}`,
  );
}
// 不带 token 调用：能连上的话是 401；地区不支持时是 403
await step('OpenAI API', 'https://api.openai.com/v1/models', (s, text) =>
  s === 401 ? null : s === 403 ? `地区不支持（${text.slice(0, 120)}）` : `返回 ${s}`,
);
console.log(
  ok ? '\n都没问题，可以到网站“设置”→“ChatGPT 套餐”里连接了。' : '\n有问题，按上面的提示检查 Clash 和 OPENAI_PROXY。',
);
process.exit(ok ? 0 : 1);
