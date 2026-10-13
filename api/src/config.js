// 从环境变量读取配置（服务器上来自 /opt/sentence-site/.env）
const env = process.env;
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export function loadConfig(e = env) {
  return {
    port: num(e.PORT, 3000),
    db: {
      host: e.DB_HOST || 'db',
      port: num(e.DB_PORT, 5432),
      database: e.POSTGRES_DB,
      user: e.POSTGRES_USER,
      password: e.POSTGRES_PASSWORD,
    },
    accessPassword: e.ACCESS_PASSWORD || '',
    cookieSecret: e.COOKIE_SECRET || '',
    // 只有开了 HTTPS 才需要设成 1；也会根据 Nginx 传来的 X-Forwarded-Proto 自动判断
    cookieSecure: e.COOKIE_SECURE === '1',
    llm: {
      // 任何兼容 OpenAI 接口格式的国内模型都可以：填到 /v1 这一级，例如 https://api.deepseek.com/v1
      baseUrl: (e.LLM_BASE_URL || '').trim(),
      apiKey: (e.LLM_API_KEY || '').trim(),
      mainModel: (e.LLM_MODEL_MAIN || '').trim(),
      lightModel: (e.LLM_MODEL_LIGHT || e.LLM_MODEL_MAIN || '').trim(),
      // 模型不支持 response_format: json_object 时设成 0
      jsonMode: e.LLM_JSON_MODE !== '0',
      // 深度思考：默认关掉（批改、查词不需要，开着又慢又贵）；想开设成 1
      thinking: e.LLM_THINKING === '1',
      timeoutMs: num(e.LLM_TIMEOUT_MS, 90_000),
    },
    limits: {
      grade: num(e.DAILY_GRADE_LIMIT, 100),
      lookup: num(e.DAILY_LOOKUP_LIMIT, 300),
      generate: num(e.DAILY_GENERATE_LIMIT, 10),
    },
    daily: {
      enabled: e.DAILY_GENERATE !== '0',
      hour: num(e.DAILY_GENERATE_HOUR, 7),
      minute: num(e.DAILY_GENERATE_MINUTE, 50),
      count: num(e.DAILY_GENERATE_COUNT, 5),
    },
    seedFile: e.SEED_FILE || new URL('../seed/export.json', import.meta.url).pathname,
  };
}

export const config = loadConfig();

export function assertConfig(cfg = config) {
  const missing = [];
  if (!cfg.accessPassword) missing.push('ACCESS_PASSWORD');
  if (!cfg.cookieSecret || cfg.cookieSecret.length < 32) missing.push('COOKIE_SECRET（至少 32 个字符）');
  if (missing.length) throw new Error(`.env 里缺少：${missing.join('、')}`);
}

export const llmReady = (cfg) => Boolean(cfg.llm.baseUrl && cfg.llm.apiKey && cfg.llm.mainModel);
