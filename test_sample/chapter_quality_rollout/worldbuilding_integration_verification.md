# 世界圣经接入验证报告

## 构建验证

实测命令：

```bash
pnpm --filter @ai-novel/server build
```

实测结果：通过，`tsc -p tsconfig.json` 无报错。

## RAG 检索库接入

接入文件：`server/src/services/novel/worldbuildingWorldBible.ts`

关键片段：

```ts
export const WORLDBUILDING_BIBLE_FILES = [
  { fileName: "00_worldbuilding_master.md", title: "世界圣经总索引", priority: 100 },
  { fileName: "01_geography_and_factions.md", title: "地理与势力骨架", priority: 90 },
  { fileName: "02_cultivation_system.md", title: "修炼体系细节", priority: 90 },
  { fileName: "03_core_characters.md", title: "核心配角卡片", priority: 95 },
  { fileName: "04_foreshadowing_and_plan.md", title: "伏笔清单与 11-30 章规划", priority: 95 },
] as const;
```

接入文件：`server/src/services/rag/HybridRetrievalService.ts`

关键片段：

```ts
// Curated worldbuilding bible docs are canonical project knowledge. They are
// prepended ahead of vector/keyword chunks so chapter generation sees them
// before looser RAG hits.
const worldbuildingBibleRows = retrieveWorldbuildingBibleChunks(normalizedQuery, {
  novelId: options.novelId,
  worldId: options.worldId,
  finalTopK,
});
```

实测检索命令：

```bash
RAG_ENABLED=false node - <<'NODE'
const { ragServices } = require('./server/dist/services/rag');
(async () => {
  const query = '第13章 阿禾 天痕 星相仪 废炉区 地窖 宁见微 玄铁';
  const block = await ragServices.hybridRetrievalService.buildContextBlock(query, {
    novelId: 'cmo4g0x8w0003938okwij1zvx',
    currentChapterOrder: 13,
    finalTopK: 5,
  });
  console.log(block);
})();
NODE
```

实测命中：

```text
[RAG-1] (keyword) knowledge_document:worldbuilding:00_worldbuilding_master.md | 世界圣经 / 世界圣经总索引
周阿禾 | 药谷本地弱灵枢承压者；天痕压损灵枢在普通人身上的提前显影...

[RAG-2] (keyword) knowledge_document:worldbuilding:04_foreshadowing_and_plan.md | 世界圣经 / 伏笔清单与 11-30 章规划
F001 | 第 1 章 | 少交药泥的药童被拖去填矿沟...

[RAG-3] (keyword) knowledge_document:worldbuilding:03_core_characters.md | 世界圣经 / 核心配角卡片
宁见微...她是账路枢纽型灰盟友...
```

## 生成 prompt 引用

接入文件：`server/src/services/novel/runtime/GenerationContextAssembler.ts`

关键片段：

```ts
// Hybrid RAG prepends curated docs/worldbuilding bible chunks before
// looser DB/vector hits, so canonical world rules outrank incidental context.
ragText = await ragServices.hybridRetrievalService.buildContextBlock(ragQuery, {
  novelId,
  currentChapterOrder: chapter.order,
});
chapterWriteContext.ragFacts = buildRagFactsForWriter(ragText);
```

接入文件：`server/src/prompting/prompts/novel/chapterLayeredContext.ts`

关键片段：

```ts
createContextBlock({
  id: "rag_facts",
  group: "rag_facts",
  priority: 89,
  content: toListBlock("RAG facts (world bible first)", writeContext.ragFacts),
});
```

接入文件：`server/src/services/novel/runtime/runtimeContextBlocks.ts`

关键片段：

```ts
input.ragText ? `语义检索补充（rag_facts，世界圣经优先）：\n${input.ragText}` : "",
"作品圣经（world_rules）：",
```

实测 prompt 组装命令：

```bash
RAG_ENABLED=false CHAPTER_QUALITY_ROLLOUT_BATCH=3 LLM_DEBUG_LOG=0 \
node server/scripts/chapter-quality-rollout-sample.cjs \
  --mode prompt-proof --start 1 --provider minimax --model MiniMax-M2.7
```

实测输出：

```json
{
  "promptPath": "test_sample/chapter_quality_rollout/prompt_proof/high_pressure_prompt.md",
  "messages": 2,
  "estimatedFullPromptTokensLocalOnly": 5347,
  "promptInvocationEstimatedContextTokens": 1390
}
```

实测 prompt 命中：

```text
111:Chapter meta: event_weight=5 | high_stakes_dialogue=true | scheme_beat=true | kind_of_hook=suspense_question
147:受保护真实身份字段（禁止后续生成或状态提取临时改写）：
177:RAG facts (world bible first)
178:- [RAG-1] ... worldbuilding:00_worldbuilding_master.md | 世界圣经 / 世界圣经总索引 ...
```

## 状态机锚点

接入文件：`server/src/services/novel/worldbuildingWorldBible.ts`

关键片段：

```ts
export const PROTECTED_CHARACTER_IDENTITIES: ProtectedCharacterIdentity[] = [
  {
    characterName: "周阿禾",
    trueIdentity: "药谷本地弱灵枢承压者；天痕压损灵枢在普通人身上的提前显影，不是星族血脉或转世者。",
    sourceFile: "03_core_characters.md",
    protected: true,
  },
  ...
];
```

接入文件：`server/src/prompting/prompts/state/state.prompts.ts`

关键片段：

```ts
"6. 若提供“受保护真实身份字段”，它们是世界圣经定稿，不得被后续章节临时改写；正文出现冲突时，只能记录为角色误信或未揭露，不得覆盖真实身份。",
```

接入文件：`server/src/services/state/StateService.ts`

关键片段：

```ts
const protectedIdentityBlock = buildProtectedCharacterIdentityBlock(novelId);
if (!snapshot) {
  return protectedIdentityBlock;
}
...
const protectedInformationStates = getProtectedCharacterIdentities(input.novelId).map((item) => ({
  holderType: "reader",
  holderRefId: null,
  fact: `受保护真实身份｜${item.characterName}: ${item.trueIdentity}`,
  status: "known",
  summary: `protected_identity:${item.sourceFile}`,
}));
```

实测命令：

```bash
node - <<'NODE'
const { stateService } = require('./server/dist/services/state/StateService.js');
(async () => {
  const block = await stateService.buildStateContextBlock('cmo4g0x8w0003938okwij1zvx', 1);
  console.log(block);
})();
NODE
```

实测输出：

```text
受保护真实身份字段（禁止后续生成或状态提取临时改写）：
- 周阿禾: 药谷本地弱灵枢承压者；天痕压损灵枢在普通人身上的提前显影，不是星族血脉或转世者。
- 宁见微: 黑市账路枢纽的低位掌柜，掌握税契、暗路、验货口和旧井货流，但不是黑市真正主人。
- 裴照庭: 浑天星海裴系掌权者，正用闻人星阑、祖地坐标和星相仪补全更高层星族名分合法性。
- 闻人星阑: 浑天星海没落远古星族传人，掌握通往内核祖地的旧坐标和能改变星海秩序的祖地钥匙。
```
