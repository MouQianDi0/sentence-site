// 你自己（owner）的 AI 客户端：按用途决定走 ChatGPT 套餐还是国内模型；ChatGPT 这次出错（额度用完、授权失效、
// 网络不通……）就自动改用国内模型。模型回复了但格式不对（invalid_json）不回退，交给调用方原来的重试逻辑。
// 邀请账户不经过这里（见 settings.ts 的 createSettingsHub），所以永远不会用到你的 ChatGPT 凭据。
// 标注题库（annotate）也永远不走 ChatGPT：标注结果所有账户都会用到，而套餐凭据只能用于你自己的请求。
import type { TokenKind } from '@sentence-site/shared';
import { LlmError, type Llm } from './llm.ts';

/** 这次调用模型是做什么用的；background：定时任务（没人在页面上点）触发的 */
export interface LlmUse {
  kind: TokenKind;
  background?: boolean;
}

/** ChatGPT 套餐那一边：这个用途现在能不能用，以及它的 AI 客户端 */
export interface PlanSide {
  usable(use: LlmUse): boolean;
  llm: Llm;
}

type Logger = { warn?: (...a: unknown[]) => void };

export function routeLlm({
  plan,
  fallback,
  use,
  log = console,
}: {
  plan: PlanSide;
  fallback: Llm;
  use: LlmUse;
  log?: Logger;
}): Llm {
  const onPlan = () => use.kind !== 'annotate' && plan.usable(use);

  /** 调用方是按 ChatGPT 的模型名（主力 / 轻量）来的，改用国内模型时换成国内模型对应的那个 */
  const toFallback = (model: string): string => {
    const p = plan.llm.models();
    const f = fallback.models();
    if (model === p.light && p.light !== p.main) return f.light;
    if (model === p.main) return f.main;
    return model;
  };

  return {
    ready: () => onPlan() || fallback.ready(),
    models: () => (onPlan() ? plan.llm.models() : fallback.models()),
    // 模型设置页的“获取模型列表”只管国内模型；ChatGPT 的模型列表在它自己的设置卡片里
    listModels: () => fallback.listModels(),
    async chatJson(opts) {
      if (!onPlan()) return fallback.chatJson({ ...opts, model: toFallback(opts.model) });
      try {
        return await plan.llm.chatJson(opts);
      } catch (e) {
        if (!(e instanceof LlmError) || e.code === 'invalid_json' || !fallback.ready()) throw e;
        log.warn?.(`[chatgpt] ${e.message}，这次改用国内模型`);
        return fallback.chatJson({ ...opts, model: toFallback(opts.model) });
      }
    },
  };
}
