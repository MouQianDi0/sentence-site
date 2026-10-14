// 句子成分与从句知识点（和后端 validate.js 里的键保持一致）
export const ROLES = {
  main: { name: '主干' },
  attr: { name: '定语从句' },
  noun: { name: '名词性从句' },
  adv: { name: '状语' },
  nonfin: { name: '非谓语' },
};

// Tailwind 只认完整写出来的类名，所以每种成分的颜色类都单独列出来
export const ROLE_CLS = {
  main: { hl: '[--hl:var(--main-soft)]', border: 'border-r-main', text: 'text-r-main', soft: 'bg-r-main-soft', swatch: 'bg-r-main-soft border-r-main' },
  attr: { hl: '[--hl:var(--attr-soft)]', border: 'border-r-attr', text: 'text-r-attr', soft: 'bg-r-attr-soft', swatch: 'bg-r-attr-soft border-r-attr' },
  noun: { hl: '[--hl:var(--noun-soft)]', border: 'border-r-noun', text: 'text-r-noun', soft: 'bg-r-noun-soft', swatch: 'bg-r-noun-soft border-r-noun' },
  adv: { hl: '[--hl:var(--adv-soft)]', border: 'border-r-adv', text: 'text-r-adv', soft: 'bg-r-adv-soft', swatch: 'bg-r-adv-soft border-r-adv' },
  nonfin: { hl: '[--hl:var(--non-soft)]', border: 'border-r-non', text: 'text-r-non', soft: 'bg-r-non-soft', swatch: 'bg-r-non-soft border-r-non' },
};

export const DEFK = { main: 'main', attr: 'attr_r', noun: 'noun_obj', adv: 'adv_phrase', nonfin: 'nf_inf' };

export const KB = {
  main: { t: '句子主干', how: '主句的“主语 + 谓语 + 宾语/表语”，去掉定语、状语和非谓语短语。主语、宾语或表语本身是从句时，要带上这个从句的引导词和它的主干。主句谓语不在任何引导词后面。', tr: '先译主干把句意定下来，再把修饰成分一层层挂回去；主干太长时可以先断句。', ex: 'The researchers found that… → 研究人员发现……' },
  it_formal: { t: '形式主语 / 形式宾语 it', how: 'It is + 形容词/过去分词 + that/to do；find / make / think + it + 形容词 + to do。it 本身没有意思，真正的主语或宾语在后面。', tr: 'it 不译成“它”。It is said/believed/reported that… 固定译成“据说 / 人们认为 / 据报道……”；find it hard to do 译成“发现很难……”。', ex: 'It is widely believed that… → 人们普遍认为……' },
  notbut: { t: '对比结构 not A but B', how: 'not…but…、not only…but also…、rather than、instead of 连接两个并列成分，重点落在 but 后面。', tr: '译成“不是 A，而是 B”“不仅……而且……”，两边保持结构对称。', ex: 'not the size but the speed → 不是规模，而是速度' },
  comparison: { t: '比较结构', how: 'more/less/-er … than、as … as、the more…the more…。than 后的比较对象常被省略，或用 those / that 代替。', tr: '译成“比……更……”，把省略的比较对象补全；those who… 补成“……的人”。', ex: 'more likely … than those who… → 比……的人更容易……' },
  attr_r: { t: '限制性定语从句', how: '名词后紧跟 who / which / that / whom / whose，中间没有逗号，用来限定“哪一个”。', tr: '从句短就前置成“……的”；从句长就后置拆开，用“这 / 其 / 该”重复先行词。', ex: 'people who sleep less → 睡得少的人' },
  attr_n: { t: '非限制性定语从句', how: '逗号 + which / who 开头，只做补充说明；which 有时指代前面一整句话。', tr: '多数拆成独立短句，用“这 / 他们 / 这一点”起头；注意它可能暗含因果或转折。', ex: 'shop owners, who argue that… → 商户……，他们认为……' },
  attr_where: { t: '关系副词引导的定语从句', how: '先行词是地点、时间或原因，后面跟 where / when / why。', tr: '常拆开译成“在那里 / 那时”，或按语境转成原因“因为……”。', ex: 'her hometown, where everything had changed → 家乡……，因为一切都变了' },
  attr_omit: { t: '省略关系词的定语从句', how: '名词后直接跟“主语 + 谓语”，中间省掉了 that / which / whom。看到“名词 + 代词 + 动词”就要警惕。', tr: '和限制性定语从句一样，短的前置成“……的”。', ex: 'the interaction they are used to → 他们习惯的交流' },
  noun_obj: { t: '宾语从句', how: '及物动词或介词后跟 that / whether / if / what / how 等，整块做宾语；that 常被省略。', tr: '基本按原语序译成“认为 / 发现 / 表示……”，that 不译。', ex: 'found that people… → 发现人们……' },
  noun_subj: { t: '主语从句', how: '句首 What / Whether / That / How 开头的一整块做主语，后面才出现主句谓语；也常用 It 作形式主语放在句首。', tr: 'What… 译成“……的（事）”放在句首；It…that 结构先译 that 后面的内容。', ex: 'What surprised them most was… → 最让他们吃惊的是……' },
  noun_pred: { t: '表语从句', how: '系动词 be / seem / remain 后跟 that / what / how / why / because 从句，说明主语“是什么”。', tr: '译成“是……”；The reason is that… 译成“原因是……”。', ex: 'was how quickly the ice had melted → 是冰融化的速度之快' },
  noun_appos: { t: '同位语从句', how: '抽象名词 fact / idea / belief / news / evidence 后接 that，从句完整，that 在从句里不做成分（定语从句里 that 要做成分）。', tr: '译成“……这一事实 / 观点”，或用冒号、“即”引出。', ex: 'the fact that he left → 他离开了这一事实' },
  adv_concession: { t: '让步状语从句', how: 'although / though / while / even if / even though 开头，表示“尽管”。', tr: '中文要成对：尽管……，但（仍）……。英文不能 although 和 but 连用，中文却要补“但”。', ex: 'Although it offers flexibility, … → 尽管……，但……' },
  adv_time: { t: '时间状语从句', how: 'when / while / as / before / after / until / once / since 引导，表示时间。', tr: '一般放句首；“当……时”里的“当”常可省略。', ex: 'When he arrived, … → 他到达时，……' },
  adv_cond: { t: '条件状语从句', how: 'if / unless / provided that / as long as / once 引导，表示条件。', tr: '放句首译成“如果……就……”；unless 译“除非 / 如果不”。', ex: 'unless it rains → 除非下雨' },
  adv_reason: { t: '原因 / 目的 / 结果状语从句', how: 'because / since / as（原因），so that / in order that（目的），so…that / such…that（结果）。', tr: '中文习惯前因后果，原因从句常提前；so…that 译“如此……以至于……”。', ex: 'because the policy failed → 因为政策失败了' },
  adv_phrase: { t: '介词短语作状语', how: 'without / despite / due to / in terms of 等介词短语修饰整个动作，补充条件、方式或原因。', tr: '提到动作前面，或扩展成短句；without 常译“没有……（的话）”。', ex: 'without face-to-face interaction → 没有了面对面交流' },
  nf_pp: { t: '过去分词短语', how: 'done 形式，前面没有 be / have，所以不是谓语。紧跟名词后是定语（被动），句首加逗号是状语。', tr: '作定语译“被……的 / ……的”，可灵活译成“旨在、由……制定的”；作状语译“在……之后 / 由于……”。', ex: 'the policy, designed to reduce traffic → 旨在减少交通的政策' },
  nf_ing: { t: '现在分词短语', how: 'doing / having done 开头，前面没有 be，表示主动。having done 表示动作先于主句发生。', tr: '作状语提到句首，拆成短句“……之后 / 由于……”；作定语译“正在……的”。', ex: 'Having lived abroad for ten years, she… → 她在国外生活了十年，……' },
  nf_inf: { t: '不定式', how: 'to do 可作主语、宾语、定语、目的状语或补语，本身不是谓语。', tr: '作目的译“为了……”；作宾语直接动宾搭配；find it hard to do 里它才是真正的宾语。', ex: 'to stay motivated → 保持动力' },
};
