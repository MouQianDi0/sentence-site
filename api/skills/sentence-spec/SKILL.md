---
name: sentence-spec
description: 长难句拆解台的出题规范：句子数据里谓语怎么标、片段怎么切、知识点键怎么选、主干怎么写，以及每个字段的要求。出题、复核题目，或修改网站里和句子数据相关的代码（提示词、校验、知识点、圈谓语和看结构页面）之前先读这份。
---

# 长难句拆解台 · 出题规范

这份文件是网站句子数据的唯一标准，三方都按它来：

- **网站里的 AI**：后端（`api/src/spec.js`）把下面每个 `<!-- prompt:名字 -->` 到 `<!-- /prompt -->` 之间的文字原样放进给大模型的提示词。出题用全部几段，谓语复核只用“谓语”一段。
- **校验代码**：`api/src/validate.js`、`api/src/predicates.js` 里的规则对应这里的要求，挡掉明显不合格的题。
- **页面上的知识点**：`web/js/kb.js` 的讲解要和这里的定义一致。

改规则时：先改这份文件，再同步改校验代码和 `kb.js`，然后在 `api/` 下运行 `npm test`。测试会检查知识点键是否和代码一致，以及下面的完整示例能否通过校验。提示词里的文字是给国内大模型看的，写成直接的要求，不要写只给人看的解释。

## 谓语怎么标

<!-- prompt:predicates -->
【谓语】
谓语是有时态、和主语搭配的限定动词。助动词、情态动词、否定词、被动语态的 be、完成时的 have 都和它算一个整体，例如 has been criticized、cannot provide、did not know、will be held、is expected。
- 主句谓语用 *…* 包起来，整句只标这一处。出题时主句不要用并列谓语（如 rose and fell）。
- 每个从句（定语从句、名词性从句、状语从句）的谓语用 ^…^ 包起来。从句里有并列谓语时，各自单独包。
- 被动、进行、完成时的助动词必须和动词包在一起：写 ^was published^，不能写 was ^published^。
- 标记后的标点放在标记外，如 ^cannot provide^,
以下都不是谓语，不要标：
- 引导词、关系词：that、which、who、whom、whose、what、when、where、why、how、whether、if、because、although 等。
- 不定式 to do。
- 现在分词和动名词 doing、having done。
- 前面没有 be / have 的过去分词，例如 the experiment conducted last week 里的 conducted、the policy, designed to reduce traffic 里的 designed。
- 形容词，例如 interested、surprising。
自检：没有并列谓语时，谓语个数 = 从句个数 + 1。trap 里说“不是谓语”的词，绝不能再标成谓语。
错误：The professor *explained* ^that^ the experiment, ^conducted^ last week, ^had failed^ due to a simple error.
正确：The professor *explained* that the experiment, conducted last week, ^had failed^ due to a simple error.
<!-- /prompt -->

## 片段怎么切

<!-- prompt:segments -->
【片段 segs】
按原句顺序把整句切成连续的片段。所有片段的 t 去掉 * 和 ^ 标记后，用空格连起来必须正好等于原句（含标点）。
每个片段的 r（成分）只能取：
- main：主句的主语、谓语、宾语、表语，以及主句里不单独讲的短语。
- attr：定语从句。
- noun：名词性从句（主语从句、宾语从句、表语从句、同位语从句）。
- adv：状语从句，或作状语的介词短语。
- nonfin：作定语、状语的非谓语短语（过去分词短语、现在分词短语、不定式短语）。
切分规则：
- 每个从句单独成段，引导词放在这一段的开头。
- 从句里面嵌着本句要讲的非谓语短语或另一个从句时，把它单独切出来，从句剩下的前后两段 r 不变。例如：that the experiment,（noun）｜conducted last week,（nonfin）｜^had failed^ due to a simple error.（noun）
- 修饰名词的介词短语（如 an error in measuring the temperature 里的 in measuring the temperature）留在所在片段里，不单独切。
- 作主语、宾语的动名词短语和不定式属于所在片段，不切成 nonfin。介词后面的动名词跟着介词短语走，不是“现在分词短语”。
- n 用中文写这一段是什么成分、修饰谁，40 字以内，必须和 r、k 说的一致。
<!-- /prompt -->

## 知识点键

每个片段的 k 选一个知识点键，页面会按它显示讲解卡片（讲解内容在 `web/js/kb.js`）。下面的列表就是全部可用的键，测试会核对它和代码里的键完全一致。

<!-- prompt:kb -->
【知识点 k】每个片段的 k 必须和这一段的实际内容对得上：
- main：主干部分（r 为 main 的片段都用它，除非这一段就是下面某个结构）
- it_formal：形式主语 / 形式宾语 it（It is … that / to do，find it hard to do）
- notbut：not A but B、not only … but also、rather than、instead of
- comparison：比较结构（-er … than、as … as、the more … the more）
- attr_r：逗号前没有停顿的限制性定语从句（who / which / that / whom / whose）
- attr_n：逗号 + which / who 的非限制性定语从句
- attr_where：where / when / why 引导的定语从句
- attr_omit：省略了关系词的定语从句（名词后直接跟主语 + 谓语）
- noun_obj：宾语从句
- noun_subj：主语从句（含 It 作形式主语时 that 后面的部分）
- noun_pred：表语从句
- noun_appos：同位语从句（fact / idea / belief / news / evidence + that）
- adv_concession：让步状语从句（although / though / while / even if）
- adv_time：时间状语从句（when / while / as / before / after / until / once / since）
- adv_cond：条件状语从句（if / unless / as long as / provided that）
- adv_reason：原因、目的、结果状语从句（because / since / so that / so … that）
- adv_phrase：作状语的介词短语（without / despite / due to / in terms of …）
- nf_pp：过去分词短语，这一段必须以过去分词（done）开头，如 conducted last week、designed to reduce traffic
- nf_ing：现在分词短语，这一段必须以 doing / having done 开头，作定语或状语
- nf_inf：不定式短语，这一段必须以 to do 开头
<!-- /prompt -->

## 主干怎么写

<!-- prompt:trunk -->
【主干 trunk】
- trunk 是主句的“主语 + 谓语 + 宾语 / 表语 / 宾补”的核心词，去掉定语、状语、非谓语短语和插入语。
- 主句的主语、宾语或表语本身是从句时，这个从句是主干缺不了的部分：保留它的引导词和它自己的主干。例如 The professor explained that the experiment had failed，不能只写 The professor explained。
- trunk 里的每个词都必须按原句顺序、一字不差地出自原句，只能删词，不能改写、换词形或补词。页面会按这些词把主干在原句里点亮。
- trunkZh 是主干的中文，按中文习惯写。
<!-- /prompt -->

## 其他字段

<!-- prompt:fields -->
【其他字段】
- level：只能是 "CET-4" 或 "CET-6"。
- focus：本句考点，10 字以内，和片段里讲的结构一致，例如“宾语从句+过去分词”。
- trap：最容易误判的地方，没有就给空字符串。trap 说的必须和谓语标注、片段一致。
- tip：翻译技巧，60 字以内。
- ref：最佳中文译文。
- opts：恰好 3 个译文选项，ok 为 true 的那个和 ref 一致；另外两个分别示范“逐词硬译 / 翻译腔”和“理解错结构或漏译”的典型错误。why 40 字以内。
- words：4–6 个较难的词，w 是句中原词。
- phrases：2–3 个固定搭配，m 必须是句中连续出现的原文。
<!-- /prompt -->

## 完整示例

下面这个例子也是测试用例：它必须能通过严格校验，trunk 也必须能在原句里按顺序找到。

<!-- prompt:example -->
【完整示例（只示范格式和标注，不要照抄内容）】
```json
{"level":"CET-4","focus":"宾语从句+过去分词","segs":[{"r":"main","t":"The professor *explained*","n":"主句的主语和谓语，宾语是后面整个 that 从句。","k":"main"},{"r":"noun","t":"that the experiment,","n":"宾语从句开头，that 不译，experiment 是从句主语。","k":"noun_obj"},{"r":"nonfin","t":"conducted last week,","n":"过去分词短语作后置定语，修饰 experiment，不是谓语。","k":"nf_pp"},{"r":"noun","t":"^had failed^ due to a simple error in measuring the temperature.","n":"宾语从句的谓语和原因状语，in measuring… 修饰 error。","k":"noun_obj"}],"trunk":"The professor explained that the experiment had failed.","trunkZh":"教授解释说实验失败了。","trap":"conducted 前面没有 be，是过去分词作定语，不是谓语。","tip":"宾语从句按原语序译成“解释说……”，过去分词短语译成“上周进行的”放在名词前。","ref":"教授解释说，上周进行的那项实验失败了，原因是测量温度时出了一个简单的错误。","opts":[{"t":"教授解释说，上周进行的那项实验失败了，原因是测量温度时出了一个简单的错误。","ok":true,"why":"结构清楚，原因单独成句，读来自然。"},{"t":"教授解释了那个实验，上周被进行的，已经失败了由于一个简单的错误在测量温度中。","ok":false,"why":"逐词硬译，语序照搬英文。"},{"t":"教授上周解释说实验因为测量温度出错而失败了。","ok":false,"why":"把 last week 错挂到 explained 上，时间理解错了。"}],"words":[{"w":"professor","lemma":"professor","pos":"n.","zh":"教授"},{"w":"explained","lemma":"explain","pos":"v.","zh":"解释说"},{"w":"experiment","lemma":"experiment","pos":"n.","zh":"实验"},{"w":"conducted","lemma":"conduct","pos":"v.","zh":"进行，开展"},{"w":"measuring","lemma":"measure","pos":"v.","zh":"测量"}],"phrases":[{"m":"due to","p":"due to","zh":"由于，因为"},{"m":"error in","p":"an error in (doing) sth","zh":"在……方面的错误"}]}
```
<!-- /prompt -->
