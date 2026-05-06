# 正则残留审计

审计范围：`server/src/prompting/prompts/audit`、`server/src/prompting/prompts/novel/review.prompts.ts`、`server/src/prompting/prompts/novel/chapterWriter.prompts.ts`、`server/src/prompting/prompts/novel/chapterLayeredContext.ts`、`server/src/services/audit`、`server/src/services/novel/chapterContentSanitizer.ts`、`server/src/services/novel/chapterMeta.ts`。

审计命令：

```bash
rg -n --pcre2 '(/(?:\\/|[^/\n])+/[dgimsuvy]*|new RegExp|\.match\(|\.replace\(|\.split\(|\.test\()' \
  server/src/prompting/prompts/audit \
  server/src/prompting/prompts/novel/review.prompts.ts \
  server/src/prompting/prompts/novel/chapterWriter.prompts.ts \
  server/src/prompting/prompts/novel/chapterLayeredContext.ts \
  server/src/services/audit \
  server/src/services/novel/chapterContentSanitizer.ts \
  server/src/services/novel/chapterMeta.ts
```

## 结论

没有发现任何正则参与“贴身视角是否到位 / kind_of_hook 语义分类 / 对话是否多功能 / 世界观是否浸入 / 高能三段式是否齐全”这五类新增语义判定。五类新增质量审核由 Haiku 语义审核 prompt 承担；本审计中残留正则只用于字段归一化、文本清洗、跨章衔接、道具归属、旧版结尾多样性风险。

## 字段归一化用正则

1. `server/src/services/novel/chapterMeta.ts:51`

```ts
const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
```

用途：把外部输入的 `kind_of_hook` 别名做空白和连字符归一化，例如 `decision-reversal` 转为 `decision_reversal`。

分类：字段归一化用。

是否参与五类语义判定：否。它不读取正文，不判断章尾效果，只把已经给出的字段值标准化。

2. `server/src/services/novel/chapterMeta.ts:55-65`

```ts
if (/信息|反转|reveal/.test(value)) return "information_reversal";
if (/决策|抉择|选择|decision/.test(value)) return "decision_reversal";
if (/威胁|逼近|追杀|threat/.test(value)) return "threat_approaches";
if (/悬念|疑问|问题|suspense|question/.test(value)) return "suspense_question";
```

用途：兼容 LLM 或旧数据把 hook 字段写成中文短语、英文短语的情况。

分类：字段归一化用。

是否参与五类语义判定：否。真正的章尾钩子类别由状态快照提取 prompt 按正文实际章尾回填；这里只把提取结果规范成枚举。

3. `server/src/prompting/prompts/novel/chapterLayeredContext.ts:52-77`

```ts
return value?.replace(/\s+/g, " ").trim() || fallback;
(value ?? "").split(/\r?\n+/g)
line.replace(/^[-*\d.\s]+/, "").trim()
```

用途：压缩上下文空白、拆行、清理列表符号。

分类：字段归一化 / prompt 上下文格式化用。

是否参与五类语义判定：否。它只处理 prompt 输入格式，不判断生成质量。

## 生成文本清洗用正则

文件：`server/src/services/novel/chapterContentSanitizer.ts`

主要残留：

```ts
/<think\b[^>]*>[\s\S]*?<\/think>/gi
/<analysis\b[^>]*>[\s\S]*?<\/analysis>/gi
/<reasoning\b[^>]*>[\s\S]*?<\/reasoning>/gi
/<\/?(?:think|analysis|reasoning)\b[^>]*>/gi
/^\s*(?:Let me ...|好的|收到|让我|开始分析|...)/
/^[“‘「『【（\u3400-\u9fff]/u
/\^[_-]?\^/g
/[\p{Extended_Pictographic}\uFE0F❤♥♡❥❣]/gu
/^(?:第\s*[0-9一二三四五六七八九十百千万]+\s*章|chapter\s*\d+)/
/(上一章|下一章|本章|这一章|...|读者|作者|...)/
/(?<=[。！？!?])/g
```

用途：清除模型泄漏的 `<think>` / `<analysis>`、Markdown 标记、章节标题、完结标记、表情符号、ASCII 标点、重复段落、跨章句子重复等。

分类：生成后清洗 / 机械卫生处理。

是否参与五类语义判定：否。它不判断贴身视角、钩子类型、对话功能、浸入式世界观或三段式是否齐全。

## 旧版连续性和道具审计正则

1. `server/src/services/audit/TransitionValidator.ts:11-14`

```ts
const EXPLICIT_RESET_REGEX = /^(次日|翌日|第二天|...|再回到)/;
const TIME_SHIFT_REGEX = /^(次日|翌日|第二天|...|随后|接着)/;
const LOCATION_SHIFT_REGEX = /^(来到|离开|回到|返回|...|到了)/;
const CONTINUATION_REGEX = /(还在|仍在|继续|接着|...|刚才)/;
```

用途：判断章节开头是否存在时间 / 地点 / 承接桥接。

分类：质量判定用，但只服务跨章连续性。

是否参与五类语义判定：否。它不参与贴身视角、hook 类型、对话多功能、世界观浸入或高能三段式。

2. `server/src/services/audit/chapterBridgeAudit.ts:28-50`

```ts
const EXPLICIT_RESET_REGEX = /(...)/;
const BRIDGE_MARKER_REGEX = /(...)/;
const FORWARD_EXIT_REGEX = /(...)/;
const FUTURE_EVENT_TAIL_REGEX = /(...)/;
const UNRESOLVED_TAIL_REGEX = /(...)/;
```

用途：检测开头跳切、回卷、未承接上一章尾声、道具归属和旧版结尾重复风险。

分类：质量判定用，但只服务跨章桥接和连续性。

是否参与五类语义判定：否。它不写入 `chapter_meta.kind_of_hook`，也不判断新增六项改造的语义达标。

3. `server/src/services/audit/EntityOwnershipTracker.ts:1-190`

```ts
const SENTENCE_SPLIT_REGEX = /(?<=[。！？!?])/g;
const SINGULAR_OWNER_PRONOUN_REGEX = /(?:^|[^一-龥])(他|她|对方)(?!们)(?:[^一-龥]|$)/;
value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
new RegExp(`(?:^|[，；。、“”\\s])([一-龥]{2,4})的${itemPattern}`, "g")
new RegExp(`${itemPattern}[^。！？]{0,12}(?:在|落在|回到)([一-龥]{2,4})手里`, "g")
```

用途：跟踪“手机/钥匙/文件/名片/信封”等道具的持有人，识别跨章道具归属歧义。

分类：质量判定用，但只服务道具归属连续性。

是否参与五类语义判定：否。

4. `server/src/services/audit/EndingStrategyAnalyzer.ts:1-108`

```ts
const SENTENCE_SPLIT_REGEX = /(?<=[。！？!?])/g;
export const BANNED_ENDING_PATTERNS = [/这只是开始/, /才刚刚开始/, /转折来了/, /即将/] as const;
if (/(却|但|然而|...|来不及)/.test(sentence)) return "suspense";
if (/(决定|打算|准备|...|拒绝)/.test(sentence)) return "decision";
```

用途：旧版结尾策略多样性分析，避免连续章节都用同类收尾或固定套话。

分类：质量判定用，但属于旧版结尾多样性风险。

是否参与五类语义判定：否。它的 `suspense/decision/action-continuation/...` 不是新增 `chapter_meta.kind_of_hook` 四分类，且不会回填 `kind_of_hook`。

## Prompt 文件命中说明

`chapterWriter.prompts.ts`、`review.prompts.ts`、`audit.prompts.ts` 中 grep 命中的斜杠多为 prompt 文案里的分隔符，如“信息反转 / 决策颠覆 / 威胁逼近 / 悬念抛出”，不是可执行正则。新增五类语义审核问题写在审核 prompt 中，由 LLM 语义回答，不由这些 prompt 文件中的正则判定。
