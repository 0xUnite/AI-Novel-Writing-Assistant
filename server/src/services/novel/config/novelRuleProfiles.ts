export type NovelProfileSeverity = "low" | "medium" | "high" | "critical";

export interface NovelProfilePatternRule {
  code: string;
  severity: NovelProfileSeverity;
  description: string;
  fixSuggestion: string;
  pattern: RegExp;
}

export interface NovelRuleConstraint {
  label: string;
  rules: string[];
  forbiddenPatterns?: NovelProfilePatternRule[];
}

export interface NovelItemTrackingRule {
  item: string;
  aliases?: string[];
  rules: string[];
  forbiddenPatterns?: NovelProfilePatternRule[];
}

export interface NovelRuleProfile {
  novelId: string;
  title: string;
  characterIdentityConstraints: NovelRuleConstraint[];
  relationshipProgression: NovelRuleConstraint[];
  worldSettingContinuity: NovelRuleConstraint[];
  foreshadowingRules: NovelRuleConstraint[];
  itemClueTracking: NovelItemTrackingRule[];
}

const REBIRTH_2005_NOVEL_ID = "cmnvhbpjb004zt4jui6ac85tn";

export const novelRuleProfiles: Record<string, NovelRuleProfile> = {
  [REBIRTH_2005_NOVEL_ID]: {
    novelId: REBIRTH_2005_NOVEL_ID,
    title: "重生2005",
    characterIdentityConstraints: [
      {
        label: "陆子野身份",
        rules: [
          "陆子野是重生者，但该身份只能通过行动优势、内心判断或极少量高度遮蔽线索体现。",
          "不得让陆子野突然公开承认重生者身份，也不得让旁人毫无铺垫地直接坐实这个秘密。",
        ],
        forbiddenPatterns: [
          {
            code: "profile_rebirth2005_luziye_identity_exposed",
            severity: "critical",
            description: "陆子野的重生者身份被直接说破或公开化，破坏了既有身份遮蔽约束。",
            fixSuggestion: "把相关内容改回隐性表现，只保留策略、经验或反应优势，不要直接公开重生秘密。",
            pattern: /陆子野[^。！？]{0,60}(?:(公开|坦白|直说|承认|告诉[^。！？]{0,12}(?:老周|夏小沫|李志强|别人|所有人))[^。！？]{0,24}(重生|重来一次|重活一世)|(重生|重来一次|重活一世)[^。！？]{0,24}(公开|坦白|直说|承认|告诉[^。！？]{0,12}(?:老周|夏小沫|李志强|别人|所有人)))/,
          },
        ],
      },
      {
        label: "老周定位",
        rules: [
          "老周保持导师型、稳定支点的定位，不能被写成同龄同学或少年室友。",
        ],
        forbiddenPatterns: [
          {
            code: "profile_rebirth2005_laozhou_role_drift",
            severity: "high",
            description: "老周的导师/稳定支点定位发生漂移。",
            fixSuggestion: "把老周修回成熟导师型角色，不要写成同龄学生、室友或少年形象。",
            pattern: /老周[^。！？]{0,40}(室友|同班同学|少年|学生)/,
          },
        ],
      },
    ],
    relationshipProgression: [
      {
        label: "夏小沫情感线",
        rules: [
          "夏小沫与陆子野的关系要克制递进，不能突发式越级推进。",
        ],
        forbiddenPatterns: [
          {
            code: "profile_rebirth2005_xiaxiaomo_relationship_jump",
            severity: "high",
            description: "夏小沫的情感推进出现无铺垫的越级跳转。",
            fixSuggestion: "把情感推进改回克制递进，保留试探、靠近、观察式变化，不要直接跳到热恋或明牌表白。",
            pattern: /夏小沫[^。！？]{0,40}(立刻拥抱|马上表白|当场确定关系|突然热恋|毫无铺垫地亲吻|毫不相干|陌生女人|普通路人)/,
          },
        ],
      },
      {
        label: "李志强背叛线",
        rules: [
          "李志强的背叛线只能递进加深，不能被一口气洗白成绝对可靠。",
        ],
        forbiddenPatterns: [
          {
            code: "profile_rebirth2005_lizhiqiang_betrayal_reset",
            severity: "high",
            description: "李志强的背叛伏笔被直接抹平。",
            fixSuggestion: "保留李志强表面合作、细节异常逐步加深的状态，不要直接写成永远可信。",
            pattern: /李志强[^。！？]{0,50}(绝对可靠|完全可信|永远不会背叛|毫无异心)/,
          },
        ],
      },
    ],
    worldSettingContinuity: [
      {
        label: "都市商战重生语境",
        rules: [
          "《重生2005》只能停留在都市、校园、商战、重生语境内，不能混入别的项目设定。",
        ],
        forbiddenPatterns: [
          {
            code: "profile_rebirth2005_cross_project_contamination",
            severity: "critical",
            description: "正文混入其他项目角色或赛博/修仙设定，破坏《重生2005》的世界观边界。",
            fixSuggestion: "删除串书角色与异项目设定，恢复到《重生2005》的都市校园商战语境。",
            pattern: /(裴言|小青|白泽|裂纹老人|金丹|修仙|精神病院|数据流|院长AI|药童)/,
          },
        ],
      },
    ],
    foreshadowingRules: [
      {
        label: "背叛伏笔递进",
        rules: [
          "李志强的异常必须循序加深，不能突然盖棺定论，也不能突然提前彻底引爆。",
        ],
      },
    ],
    itemClueTracking: [
      {
        item: "名片",
        aliases: ["卡片"],
        rules: [
          "名片类线索涉及供货商与人脉入口，转手或遗失时必须写清当前持有人。",
        ],
      },
      {
        item: "账本",
        rules: [
          "账本类线索牵涉商业盘面，出现时要保持持有者和来源清晰。",
        ],
      },
    ],
  },
};

export function getNovelRuleProfile(novelId: string): NovelRuleProfile | null {
  return novelRuleProfiles[novelId] ?? null;
}
