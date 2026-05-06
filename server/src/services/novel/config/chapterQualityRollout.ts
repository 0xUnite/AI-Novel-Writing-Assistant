export type ChapterQualityUpgradeId =
  | "close_pov_triad"
  | "ending_hook_kind"
  | "dialogue_double_layer"
  | "scheme_four_step"
  | "high_energy_three_stage"
  | "immersive_worldbuilding"
  | "reader_value_density"
  | "stakes_motivation_lock";

export interface ChapterQualityRolloutBatch {
  batch: 1 | 2 | 3;
  enabledUpgrades: ChapterQualityUpgradeId[];
  compareChapterCount: number;
  baselineSampleDir: string;
  notes: string;
}

export const CHAPTER_QUALITY_BASELINE_SAMPLE_DIR =
  "test_sample/chapter_quality_rollout/baseline_before_quality_upgrade";

export const CHAPTER_QUALITY_ROLLOUT: ChapterQualityRolloutBatch[] = [
  {
    batch: 1,
    enabledUpgrades: ["close_pov_triad", "ending_hook_kind"],
    compareChapterCount: 5,
    baselineSampleDir: CHAPTER_QUALITY_BASELINE_SAMPLE_DIR,
    notes: "先验证贴身视角与章尾钩子，保留前 5 章旧样本对照。",
  },
  {
    batch: 2,
    enabledUpgrades: ["dialogue_double_layer", "scheme_four_step"],
    compareChapterCount: 5,
    baselineSampleDir: CHAPTER_QUALITY_BASELINE_SAMPLE_DIR,
    notes: "在第一批稳定后叠加高价值对话与算计四步，不覆盖旧样本。",
  },
  {
    batch: 3,
    enabledUpgrades: ["high_energy_three_stage", "immersive_worldbuilding", "reader_value_density", "stakes_motivation_lock"],
    compareChapterCount: 5,
    baselineSampleDir: CHAPTER_QUALITY_BASELINE_SAMPLE_DIR,
    notes: "最后叠加高能事件三段式、世界观浸入、读者信息量与不可退让动机，避免一次性提高所有约束造成生成漂移。",
  },
];

function normalizeRolloutBatch(value: unknown): 1 | 2 | 3 {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number.parseInt(value.trim(), 10)
      : 3;
  if (parsed === 1 || parsed === 2 || parsed === 3) {
    return parsed;
  }
  return 3;
}

export function getActiveChapterQualityRolloutBatch(): 1 | 2 | 3 {
  return normalizeRolloutBatch(process.env.CHAPTER_QUALITY_ROLLOUT_BATCH);
}

export function listEnabledChapterQualityUpgrades(batch: 1 | 2 | 3 = getActiveChapterQualityRolloutBatch()): ChapterQualityUpgradeId[] {
  return CHAPTER_QUALITY_ROLLOUT
    .filter((item) => item.batch <= batch)
    .flatMap((item) => item.enabledUpgrades);
}
