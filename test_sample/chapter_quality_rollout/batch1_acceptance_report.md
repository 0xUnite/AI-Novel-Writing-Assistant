# Batch1 实测验收报告

## 样本生成

实测命令：

```bash
CHAPTER_QUALITY_ROLLOUT_BATCH=1 LLM_DEBUG_LOG=0 \
node server/scripts/chapter-quality-rollout-sample.cjs \
  --mode batch --start 1 --end 5 --provider minimax --model MiniMax-M2.7
```

输出目录：`test_sample/chapter_quality_rollout/batch1_after/`

生成文件：`chapter_1.txt` 至 `chapter_5.txt`，以及每章完整 prompt：`chapter_1_prompt.md` 至 `chapter_5_prompt.md`。

## 五章实测数据

| 章节 | 标题 | 基线字符数 | 新版字符数 | 差值 | kind_of_hook 实际回填 | 实际 prompt tokens | 生成耗时 |
| --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 药童不值钱 | 7722 | 6398 | -1324 | suspense_question | 3786 | 160143 ms |
| 2 | 断炊山谷 | 10129 | 7570 | -2559 | suspense_question | 4744 | 246433 ms |
| 3 | 星相仪初鸣 | 5574 | 6159 | +585 | decision_reversal | 4852 | 513947 ms |
| 4 | 一株借命草 | 5645 | 6062 | +417 | threat_approaches | 5228 | 91280 ms |
| 5 | 黑市换命 | 5198 | 5959 | +761 | suspense_question | 5245 | 176731 ms |

五章实际 prompt tokens 均值：4771。

五章实际 prompt tokens 最大值：5245。

最大值未超过 6000，因此没有执行 `promptBudgetProfiles.ts` line 36 的二次裁剪。

## Batch1 灰度隔离

实测 prompt 片段：

```text
active_quality_rollout_batch: 1
active_quality_upgrades: close_pov_triad, ending_hook_kind
```

结论：batch1 样本只启用“贴身视角三件套”和“章尾钩子四选一”，没有推进 batch2/batch3。

## 效果判断

机械验收通过：真实生成、prompt token、kind_of_hook 回填和生成耗时均已落盘。

灰度推进暂停：第 3 章和第 4 章的实际 hook 回填分别为 `decision_reversal`、`threat_approaches`，而旧计划层仍大量默认 `suspense_question`。这说明回填有效，但旧 beat sheet 的 hook 分配需要再归一化，不应自动推进 batch2/batch3。

额外风险：第 1、2 章较基线明显缩短，尤其第 2 章少 2559 个非空白字符。后续若继续灰度，应先调整目标字数或 prompt 压缩策略。
