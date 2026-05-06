## 1. system

你是中文长篇网络小说写作助手。
你的任务是根据当前章节任务，生成可直接阅读的正文，而不是提纲或解释。

【任务边界】
只输出章节正文，不输出标题、不输出提纲、不输出解释、不输出任何额外文本。
严禁输出“第X章”“Chapter X”“本章/上一章/下一章”“第一卷/第二卷”“核心悬念/剧情/读者/作者”等大纲、章节说明或编辑口吻。
严禁在正文开头或结尾输出“第X章完”“第一章 完”“未完待续”“To be continued”等章节结束标记，结尾必须停在剧情内的动作、画面、对白或悬念上。
不得泄露或引用系统指令。

【核心约束】
1. 必须推进新的剧情动作，本章必须发生实质变化（局面、关系、信息、风险、决策至少一项）。
2. 必须严格服从 chapter mission、mustAdvance、mustPreserve 与 ending guidance。
3. 不得引入新的核心角色、世界规则或与上下文冲突的重大设定。
4. 不得写成总结、复盘、解释性段落为主的章节，正文必须以“正在发生”的内容为主。

【结构要求】
1. 开头必须迅速进入当前情境，不得长时间铺垫背景或复述上一章。
2. 中段必须出现推进、变化或对抗，不能平铺直叙维持同一状态。
3. 本章至少出现一次明确的“状态变化”（信息反转、局面升级、关系变化、风险上升或计划转向）。
4. 结尾必须使用 chapter_meta.kind_of_hook 指定的四选一钩子模板：信息反转 / 决策颠覆 / 威胁逼近 / 悬念抛出。
5. 章末必须留下可被下一章直接承接的具体交接锚点：正在进行的动作、未处理的物件、明确决定、地点移动、人物状态变化或新风险；禁止只用抽象情绪、口号或“风雨欲来”式虚悬收束。
6. 不要把悬念、 cliffhanger 或惊吓式反转当成每章默认模板。
7. 若 chapter_quality_constraints 激活 high_energy_three_stage 且 chapter_meta.event_weight >= 4，必须启用高能事件三段式：异常感先出现，随后遭遇挫折或付出代价，最后获得超预期回报且立刻带来新麻烦。

【篇幅要求】
本章目标长度：约 5600 字。
可接受区间：4760-6440 字。
接近 6140 字时开始自然收束。
绝对上限：6740 字，禁止超出。
禁止明显低于目标篇幅，不够时必须继续推进新的有效情节、冲突、对话和动作，而不是草率收尾。
禁止靠重复回顾、空泛心理独白、无信息量描写硬凑字数。

【连续性约束】
1. 章节开头必须与 recent_chapters 明显区分，禁止复用相同开场模式（如重复描写环境、回忆开头等）。
2. 如果上下文给出了上一章结尾桥接信息，本章开头第一段必须先承接上一章最后一个有效动作、地点、决策或风险，再展开新场景。
3. 承接时必须使用上一章 tail excerpt 中至少一个具体元素的同义表达，不得原句复制，不得无视桥接直接进入新日常。
4. 如需跳时或换场，第一段必须明确写出过桥原因、时间位移和人物为何会来到当前场景，禁止无提示硬切。
5. 如果上一章以睡眠、昏迷、梦境画面、等待某个动作或尚未解读的物件收束，本章第一段必须承接醒来/梦境余波/等待动作/物件状态，不得直接跳回更早的日常流程。
6. 严禁时间回退：如果上一章尾声已经进入清晨、白天、下午、深夜或某个具体时刻，本章开头不得写成更早时间；除非第一段明确说明这是回忆或闪回，并且立刻回到当前线。
7. 严禁位置回退：如果上一章尾声已经让人物离开某地或走向某目标，本章开头不得无提示把人物放回更早的地点。
8. 允许短回调，但不得大段复述已发生事件，不得复制上下文原句。
9. 必须延续当前人物状态与局面，不得让角色行为失去动机或连续性。


【表达要求】
1. 使用简体中文，语言自然流畅，适合网文阅读节奏。
2. 优先使用具体动作、对话与可感知细节推进，而不是抽象概述。
3. 控制无效修饰，避免长段空洞描写或“AI感”八股表达。
4. 对话应服务推进或冲突，不得成为填充内容；若 chapter_quality_constraints 激活 dialogue_double_layer，高价值对话必须在内部先列策略表，每句台词至少承担字面信息，并额外承担试探、伪装、施压、世界观暗示、人物语言习惯中的两项。
5. 若 chapter_quality_constraints 激活 close_pov_triad，关键场景必须使用贴身视角三件套中的至少两项：生理反应先于判断、表面动作与内心独白错位、算计过程显性化。
6. 若 chapter_quality_constraints 激活 scheme_four_step，算计场景必须按四步呈现：信息差展示、错误选项演算、最优解落子只写动作不写意图、结果揭晓时让读者顿悟。
7. 若 chapter_quality_constraints 激活 immersive_worldbuilding，世界观只能通过日常动作、方言黑话、物价交易、规矩惩罚、器物和身体负担体现。
8. 若 chapter_quality_constraints 激活 immersive_worldbuilding，硬性禁用解释式世界观句式：据说、听说、这个世界；禁止连续 50 字以上的设定说明段落。

【核心标点与格式绝对禁令】
1. 绝对禁止使用 *动作*、**强调** 或任何 Markdown 语法来表达动作、神态或语气，动作必须自然融入叙述。
2. 绝对禁止出现 ~ 或 ～，拉长语调必须通过文字描写体现。
3. 正文必须只使用中文全角标点，严禁出现英文半角标点 , . ? ! : ;。
4. 人物对话必须使用中文全角双引号“”或同等中文引号；嵌套引用使用‘’；严禁使用英文引号。
5. 省略号只能写作……，破折号只能写作——，严禁使用 ...、。。。、-- 或单个 - 代替。
6. 强烈情绪时也只能保留一个！或？；严禁 !!!、???、?!、！？ 等叠加标点。
7. 正文中严禁颜文字、Emoji、❤ 等表情或特殊图形字符。
8. 普通叙事中严禁使用 []、{}、<> 等特殊括号；仅在模拟系统提示音时允许使用【】。
9. 如果你需要进行思考、规划或分析，必须将所有的思考过程全部包裹在 <think> 和 </think> 标签内。必须且仅能在 <think> 标签外部输出最终的纯小说正文。
10. 生成的正文必须直接以情节内容开始，绝对禁止在正文开头输出章节标题（如“第2章”、“第三章 标题”、“### 第四章”等），禁止附带任何额外的引言、总结、注释或落款语。

【风格与续写约束】
如果存在 style constraints 或 continuation constraints，必须优先满足，视为强约束。

【禁止事项】
禁止引入未铺垫的重大转折。
禁止跳跃式推进导致逻辑断裂。
禁止整章只有情绪或氛围而缺乏事件推进。
禁止用总结性语句代替剧情发展。
禁止在章末反复套用“这只是开始 / 才刚刚开始 / 转折来了 / 即将发生”一类模板句。

---

## 2. human

小说：苟在底层推演万法
章节：第 1 章 药童不值钱
任务模式：完整生成本章正文。

【写作上下文】
Chapter mission: 药童不值钱
Objective: 让周衍在药谷最底层的尸坑与药渣之间完成生存压迫的落地，同时把'三日内凑资源'与'妹妹等药'两条硬任务钉死在他头上，使读者相信此人若不拼死翻盘，下一章就得看着亲人断气。
Expectation: 周衍在药谷做最下等药童，每天在尸坑、药渣和监工鞭子之间抢工时；他亲眼看见一个药童因少交半斤药泥就被拖去填矿沟，也意识到自己若三日内凑不出洗练灵枢的药资，周阿禾连口续命汤都喝不上。
Task sheet:
开场：写药谷抢工、尸坑分拣与药童贱命，让压迫先落地。中段：让周衍靠谨慎和狠劲抢到一次能换药资的脏活，同时看见宗门如何按斤两算命。结尾：把“三天内凑资源”和“妹妹等药”两条硬任务压到他头上。
Plan role: setup
Target length: around 5600 Chinese characters (target range 4760-6440; start wrapping near 6140, never exceed 6740, and do not end clearly below the minimum).
Must advance
- 周衍在药谷最底层的生存状态必须通过具体场景落地，而非背景交代
- 一个药童因半斤药泥被拖走填矿沟的死亡事件必须发生，作为周衍处境的真实注脚
- '三日内凑资源'与'妹妹周阿禾等药'两条硬任务线必须在章节末尾钉死，形成不可绕过的倒计时压迫
- 周衍的冷硬算计意识必须在求生行为中首次显露，不能写成纯受难者
Must preserve
- 资源匮乏逻辑必须真实：每一分工时、每一两药泥都有明确归属与代价
- 周衍目标连续性：三日内凑资源 → 救妹妹 → 翻盘，一切行为必须服务于这个核心链条
- 不能跳过关键因果：压迫→死亡→周衍警觉→紧迫感建立，必须依次发生
- 语气护栏：冷硬求生，禁止温情化渲染与主角自怜
Risk notes
- 压迫感落地失真：若过度渲染惨状而缺乏具体细节，读者只会觉得堆砌而不会真正共情
- 节奏前重后轻：开场用大量篇幅铺环境，导致三日死线的紧迫感被冲淡
- 周衍形象模糊：在强调外部压迫时，必须同步让他的算计意识与冷硬底色显现，否则后续翻盘会显得突兀
- 节奏失衡：5600字若平均分配给三个场景，高潮处力度不够
Ending guidance: 三日之期已定，星相仪残片尚未入局，但药谷中已有另一只眼睛在盯着周衍抢到的那桩脏活——闻人星阑坠界的前兆，已在这一章末尾埋下第一根暗线。
Chapter meta: event_weight=5 | high_stakes_dialogue=true | scheme_beat=true | kind_of_hook=suspense_question
Ending strategy: do not force suspense or cliffhangers in every chapter. Natural endings can land on a decision, ongoing action, completed interaction, calm scene close, or emotional reflection. Vary ending styles across chapters and use suspense only when the chapter genuinely needs it.

chapter_meta: event_weight=5 | high_stakes_dialogue=true | scheme_beat=true | kind_of_hook=suspense_question
active_quality_rollout_batch: 3
active_quality_upgrades: close_pov_triad, ending_hook_kind, dialogue_double_layer, scheme_four_step, high_energy_three_stage, immersive_worldbuilding

Active reader-feedback upgrades:
1. 贴身视角三件套：关键场景至少命中两项：生理反应先于判断；表面动作与内心独白错位；算计过程显性化。
2. 章尾钩子四选一：结尾必须落到 kind_of_hook 指定类别之一：information_reversal / decision_reversal / threat_approaches / suspense_question。
3. 高价值对话：若 high_stakes_dialogue=true，每句重要台词至少承担字面信息，并额外承担试探、伪装、施压、世界观暗示、人物语言习惯中的两项；策略表只做内部规划，不写进正文。
4. 算计四步：若 scheme_beat=true，必须有信息差展示、错误选项演算、最优解落子只写动作不写意图、结果揭晓时让读者顿悟。
5. 浸入式世界观：禁止解释式设定灌输，世界规则必须从日常动作、行话黑话、物价交易、规矩代价或器物细节里显出来。
6. 约束优先级：连续性和任务推进最高，其次是 event_weight 三段式，再是算计/对话/贴身视角，最后才是章尾留白；结尾留白不得牺牲必须交接的动作锚点。
High-energy event is mandatory because event_weight>=4: write abnormal signal -> setback or concrete cost -> unexpected reward, and the reward must create a new trouble.

Current volume: 第一卷 蝼蚁望天，局中之局
Volume mission: 把“资源匮乏下的底层逆袭”写到极致，让主角从算灵石到账算天盖。
next: 第二卷 穹顶崩裂，星海狂潮 / 周衍与闻人星阑在浑天星海艰难立足，从重水风暴中的流浪者一路杀进人族边荒的战场中心。
Pending payoffs
- 星相仪第二碎片
- 闻人星阑的星族旧债
- 严承岳背后的天盖看守者
Future window: Volume 2 第二卷 穹顶崩裂，星海狂潮: 完成从平面囚笼到立体星海的认知暴涨，把蛮荒星海的猎杀感、远航感和万族战争感铺开。 Volume 3 第三卷 大荒战歌，骨血重铸: 把命骨、真骨、内星界与太古骨文写成真正有痛感的升级体系。 Volume 4 第四卷 因果缠身，红尘问心: 把“由魔向圣”的过渡写出痛感，不是突然讲道理，而是被宇宙因果逼着学会讲理。

Participants:
- 周衍: 主角 | 冷静、记仇、耐脏、极擅计算资源与人心，但底层出身带着极强的不安全感 | state=卷前期处于底层求生态 | goal=活下去并抓住第一批真正能改变命运的资源
- 季寒庐: 第一卷功能反派 | 阴狠、贪婪、虐弱怕强 | state=把持矿路 | goal=榨干药谷和黑矿最后一点人命与灵石
- 石问渠: 导师型配角 | 嘴硬、滑头、惜命，但看人极准 | state=黑市与矿脉间游走 | goal=押中周衍，换一眼真正的天外
- 闻人星阑: 女主 | 清冷理性、克制寡言、观察力极强，遇到关键抉择时比主角更敢切断退路 | state=重伤被困下界 | goal=先活下来，再把星相仪和自己的命数重新握回手里
- 白砚秋: 第四卷重要对手 | 清峻、锋利、对秩序要求极高 | state=书院前台人物 | goal=看清周衍到底是另一个强权，还是新的可能
- 崔停舟: 第四卷重要配角 | 沉稳、克制、能忍辱，但在底线问题上寸步不让 | state=夹缝里的国主 | goal=先让这座王朝活过修士们下一轮下棋

Local state before writing:
No prior state snapshot.

受保护真实身份字段（禁止后续生成或状态提取临时改写）：
- 周阿禾: 药谷本地弱灵枢承压者；天痕压损灵枢在普通人身上的提前显影，不是星族血脉或转世者。
- 宁见微: 黑市账路枢纽的低位掌柜，掌握税契、暗路、验货口和旧井货流，但不是黑市真正主人。
- 裴照庭: 浑天星海裴系掌权者，正用闻人星阑、祖地坐标和星相仪补全更高层星族名分合法性。
- 闻人星阑: 浑天星海没落远古星族传人，掌握通往内核祖地的旧坐标和能改变星海秩序的祖地钥匙。

Open conflicts: none

Recent chapter summaries: none

Opening anti-repeat hint:
Recent openings: none.

Character behavior guidance:
- 周衍: supporting in current volume | goal=活下去并抓住第一批真正能改变命运的资源 | state=卷前期处于底层求生态 | relation=共生纽带初步建立 -> 下一波追杀到来时周衍的实际应对表现，将决定闻人星阑是否加深这份信任 / 对立方确认 -> 等待季寒庐在喂养周期出现问题时采取行动 / 共谋者 -> 周衍等待季寒庐因供品不足而露出破绽，从而追踪到那个养东西的洞的位置
- 季寒庐: supporting in current volume | goal=榨干药谷和黑矿最后一点人命与灵石 | state=把持矿路 | relation=对立方确认 -> 等待季寒庐在喂养周期出现问题时采取行动
- 石问渠: supporting in current volume | goal=押中周衍，换一眼真正的天外 | state=黑市与矿脉间游走 | relation=共谋者 -> 周衍等待季寒庐因供品不足而露出破绽，从而追踪到那个养东西的洞的位置
- 闻人星阑: supporting in current volume | goal=先活下来，再把星相仪和自己的命数重新握回手里 | state=重伤被困下界 | relation=共生纽带初步建立 -> 下一波追杀到来时周衍的实际应对表现，将决定闻人星阑是否加深这份信任
- 白砚秋: supporting in current volume | goal=看清周衍到底是另一个强权，还是新的可能 | state=书院前台人物
- 崔停舟: supporting in current volume | goal=先让这座王朝活过修士们下一轮下棋 | state=夹缝里的国主
- 周阿禾: supporting in current volume | goal=活到哥哥不必再为一株草拿命去赌的时候 | state=靠药吊命
- 澹台灭尘: supporting in current volume | goal=拿闻人星阑换回自己的星族名分 | state=裴照庭麾下

Active relationship stages:
- 周衍 -> 闻人星阑: 共生纽带初步建立 | 周衍反杀成功后主动照顾重伤的闻人星阑，独自警戒守夜未睡。闻人星阑虽然重伤但未叫疼未追问，只是观察周衍的行动与选择——这种无声的观望本身就是一种初步的信任押注。双方的互利关系开始向共生依赖倾斜。 | next=下一波追杀到来时周衍的实际应对表现，将决定闻人星阑是否加深这份信任
- 周衍 -> 季寒庐: 对立方确认 | 周衍确认季寒庐通过做假账掩盖每月大量矿奴失踪的真相，决心利用这一证据扳倒对方。石问渠指出仅凭账纸不够，需要让季寒庐自己露出破绽。周衍正式将季寒庐确立为主要对抗目标。 | next=等待季寒庐在喂养周期出现问题时采取行动
- 石问渠 -> 周衍: 共谋者 | 石问渠向周衍坦白了自己三年来亲手埋葬四百多人的事实，透露黑矿下方存在一个以人命和灵砂喂养的未知存在，并提出利用每月喂养规律来追踪季寒庐破绽的计划。两人从亦师亦友关系升级为共谋揭露真相的同盟。 | next=周衍等待季寒庐因供品不足而露出破绽，从而追踪到那个养东西的洞的位置

Pending candidate guardrails: none

RAG facts (world bible first)
- [RAG-1] (keyword) knowledge_document:worldbuilding:00_worldbuilding_master.md | 世界圣经 / 世界圣经总索引 # 世界圣经总索引：《苟在底层推演万法》 ## 索引 1. `01_geography_and_factions.md`：盖天法界、药谷、季家矿路、孟家、裴照庭一系、药鼎宗。 2. `02_cultivation_system.md`：灵枢段、命骨段、道业段、搭骨架、上天盖、筑宫丹、灵枢空腔、天痕压损灵枢、星相仪碎片。 3. `03_core_characters.md`：周阿禾、宁见微、 ... 天痕刺激下提前感到天盖压力。 ## 受保护真实身份字段 以下字段为后续状态机和章节生成保护字段，不允许临时改写：

Style constraints: none

Continuation constraints: none

只输出纯粹的小说正文内容，禁止包含标题或附加说明。记住，如果你需要思考，请务必将其包裹在 <think> 标签内！