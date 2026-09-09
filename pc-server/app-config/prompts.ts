// app-config/prompts.ts — 内置默认提示词与辅助生成限制（标题/建议/翻译/OCR/压缩/提示词优化）
// 纪律：纯搬迁自 server.ts（阶段 5.3g），行为不变。文案为跨端对齐契约，不可随意改动。

export const TITLE_CHARACTER_LIMIT = 15;
export const SUGGESTION_CHARACTER_LIMIT = 18;

// 内部任务的输出预算(不是用户的选择,故必须经 internalOutputCap 收进模型真实上限——
// 目录里存在输出上限低于这些常数的现役对话模型,硬发就是自找 400)。
/** OCR:抽一张图上的文字,几千 token 足够。 */
export const OCR_OUTPUT_TOKENS = 2048;
/** 提示词优化:优化结果可能比原文长(结构化展开),给足余量避免截断。 */
export const PROMPT_OPTIMIZE_OUTPUT_TOKENS = 4096;

export const DEFAULT_TITLE_PROMPT = `I will give you some dialogue content in the \`<content>\` block.
You need to summarize the conversation between user and assistant into a short title.
1. The title language should be consistent with the user's primary language
2. Do not use punctuation or other special symbols
3. Reply directly with the title
4. Summarize using {locale} language
5. The title should not exceed ${TITLE_CHARACTER_LIMIT} characters

<content>
{content}
</content>`;

export const DEFAULT_SUGGESTION_PROMPT = `I will provide you with some chat content in the \`<content>\` block, including conversations between the User and the AI assistant.
You need to act as the **User** to reply to the assistant, generating 3~5 appropriate and contextually relevant responses to the assistant.

Rules:
1. Reply directly with suggestions, do not add any formatting, and separate suggestions with newlines, no need to add markdown list formats.
2. Use {locale} language.
3. Ensure each suggestion is valid.
4. Each suggestion should not exceed ${SUGGESTION_CHARACTER_LIMIT} characters.
5. Imitate the user's previous conversational style.
6. Act as a User, not an Assistant!

<content>
{content}
</content>`;

export const DEFAULT_TRANSLATION_PROMPT = `You are a translation expert, skilled in translating various languages, and maintaining accuracy, faithfulness, and elegance in translation.
Next, I will send you text. Please translate it into {target_lang}, and return the translation result directly, without adding any explanations or other content.

Please translate the <source_text> section:

<source_text>
{source_text}
</source_text>`;

export const DEFAULT_OCR_PROMPT = `You are an OCR assistant.

Extract all visible text from the image and also describe any non-text elements (icons, shapes, arrows, objects, symbols, or emojis).

For each element, specify:
- The exact text (for text) or a short description (for non-text).
- For document-type content, please use markdown and latex format.
- If there are objects like buildings or characters, try to identify who they are.
- Its approximate position in the image (e.g., 'top left', 'center right', 'bottom middle').
- Its spatial relationship to nearby elements (e.g., 'above', 'below', 'next to', 'on the left of').

Keep the original reading order and layout structure as much as possible.
Do not interpret or translate—only transcribe and describe what is visually present.`;

export const DEFAULT_COMPRESS_PROMPT = `You are a conversation compression assistant. Compress the following conversation into a concise summary.

Requirements:
1. Preserve key facts, decisions, and important context that would be needed to continue the conversation
2. Keep the summary in the same language as the original conversation
3. Target approximately {target_tokens} tokens
4. Output the summary directly without any explanations or meta-commentary
5. Format the summary as context information that can be used to continue the conversation
6. Use {locale} language
7. Start the output with a clear indicator that this is a summary (e.g., "[Summary of previous conversation]" or equivalent in the target language)

{additional_context}

<conversation>
{content}
</conversation>`;

// 提示词优化 meta-prompt —— 用户在对话界面点"优化提示词"时,把输入框原文(+可选的最近几轮
// 对话背景)+ 本提示词一起发给"提示词优化模型"。模型返回的优化版直接替换输入框,所以
// 输出必须纯净(无前言/解释/引号)。设计目标:把口语化、混乱的草稿打磨成清晰专业的版本,
// 同时严格不改原意、不膨胀简单请求、保留占位符和固定内容。开头明确"不限于某个领域"防止
// 模型默认偏向任何场景(如 coding)。上下文是可选的——首条消息或无对话时省略,且注入时
// 明确告诉模型"只在提示词承接对话时才用,否则忽略",防止无关上下文污染独立提示词。
export const DEFAULT_PROMPT_OPTIMIZE_PROMPT = `你是一位资深的提示词优化专家。下面会给你一段用户准备发给 AI 助手的话(提示词草稿),你的任务是把它打磨成清晰、得体、表达专业的版本,让 AI 更容易准确理解、给出更好的回复。这段话可能是提问、写作请求、修改要求、闲聊,或任何日常诉求——不限于某个领域。

## 优化原则

1. **严格保留原意,不要无中生有** —— 只能基于用户实际写出的内容来优化,不增加用户没有提出的诉求,不删减已表达的内容,不擅自改变核心意图。不要替用户补充他没有提供的具体信息(比如他说"帮我写封邮件",你不能擅自编造收件人、事由、语气);某处信息缺失或含糊时,就让表达更清楚、更有条理,但不要凭空捏造细节。你的职责是打磨表达,不是替用户重新定义需求。如果原文已经清晰得体,原样输出即可,不要为了优化而画蛇添足。

2. **消除歧义** —— 用户常用模糊或笼统的表述("弄一下""优化一下""帮我处理那个")。如果下方附带了对话背景、且提示词明显在承接它(出现"那个""上面说的""再…一下"等指代),请结合背景理解这些指代具体指向什么;如果没有背景或仍无法确定,保留原表述,不要凭空猜测后替换——错误的猜测比模糊更糟。

3. **让表达更清楚、更有条理** —— 把口语化、啰嗦、跳跃的表述梳理得通顺连贯。如果诉求包含多个要点(背景、需求、约束、期望的输出格式或语气),用分节或编号列表清晰组织;如果只是一句话的简单请求,保持简洁,不要用多余的框架稀释重点——简洁本身就是专业。

4. **用词得体专业** —— 在不改变原意的前提下,把模糊、随意的说法换成更准确、更得体的表达,让模糊的动词变成具体的动作。例如:"帮我弄个东西" → 点明具体要做什么;"写个东西给老板" → 明确是邮件 / 汇报 / 请示中的哪一种;"弄好看点" → 指明是调整措辞 / 优化排版 / 精简结构;"翻译一下" → 点明源语言、目标语言、要保留的风格。注意保持原文的语域——正式的保持规整,轻松的别写得僵硬。

5. **必要时点明隐含期望** —— 如果提示词隐含了目标读者、语气、篇幅、输出格式(如希望分点回答、举例、简短)或希望 AI 扮演的角色,且能从上下文或常识中合理推断,将其显式写出。无法合理推断的不要编造,也不要强加用户没有暗示的要求。

6. **保持原文语言** —— 中文保持中文,英文保持英文,不要翻译,不要自行添加用户未要求的外语。

7. **原样保留特殊内容** —— 原文中的模板占位符(如 {{name}}、{topic}、<url>、[日期])、代码块、数据、公式、引用原样保留,不修改、不"改进"。只优化这些固定内容之外的说明性文字。

## 输出要求

只输出优化后的那段话本身。不要写任何前言、解释、"以下是优化版本"之类的引导语,不要用引号包裹结果,不要在末尾追加说明。用户会把你的输出直接读进输入框——任何提示词以外的文字都是干扰。`;

// 运行平台（用于自动更新：Windows 走 Tauri NSIS 安装器，Linux 走二进制原地替换）。
// 与 analyticsOs() 的划分保持一致 —— Docker 容器内 process.platform 也是 "linux"，
// 这是对的：Docker 镜像就是 Linux 二进制，只是它的更新路径不同（见下）。

// 容器化部署检测。Docker 内即使替换了 /app/rikkahub-pc，容器一旦重建就会回到镜像里的
// 旧版本，原地更新没有意义 —— 这类部署应当 docker pull 新镜像。检测 /.dockerenv（Docker
// 标准标记）或显式注入的环境变量（兼容其他容器运行时）。

// 应用内更新下载源:Cloudflare R2 镜像,与官网(rikkahub-desktop.pages.dev)同源,国内/全球
