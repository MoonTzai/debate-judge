// ============================================================
// ui.js — Judge 网页版控制台 · 圣堂裁判所五步场景流（G1 骨架）
// 场景：① 圣堂之门（风险提示）② 识海连接（设置）③ 呈现诉求（上传）
//       ④ 裁决进行（运行）⑤ 裁决显现（报告）
// 功能级对照青春版（Debate-Coach-Backup/裁判所2.0.html）清单：
//   API 面板（Key/端点/模型/输出上限/连通测试）
//   辩词上传（拖拽/多格式/粘贴）+ 长文 Token 警告
//   模式弹窗（完整报告 / 自定义深度；无引导复盘——既定决议）
//   深度三档（verdict/mainline/clash）
//   六向度调节 = 六个独立轴 0–100 相对权重 + 人格画像预览（核心差异）
//   轮次时间线（10 轮发光节点链）+ 实时日志 + 活性指示
//   名册确认弹窗（源锚层 v1 浏览器化：确认/跳过/编辑）
//   报告 iframe 预览 + 导出 HTML/MD/复制 + 会话产物导出/导入（断点迁移）
//   深浅色主题（= 圣堂场景切换：黑暗圣堂/光明圣堂）/ 清除缓存 / 会话列表
// 内核 = 根目录 Judge 主版本同源打包；报告导出 = 原始 report.html（不换肤）
// ============================================================
'use strict';

(function () {
  var BUNDLE = (typeof window !== 'undefined' ? window : globalThis).JUDGE_BUNDLE;
  if (!BUNDLE) { console.error('[judge-web] JUDGE_BUNDLE 未就绪'); return; }

  var tendencyMod = BUNDLE.modules.tendency();
  var judgeContextMod = BUNDLE.modules.judgeContext();
  var historyGovernance = BUNDLE.modules.historyGovernance();
  var flightExportMod = BUNDLE.modules.flightExport();
  var judgeHostIOMod = BUNDLE.modules.judgeHostIO();
  var reportHostMod = BUNDLE.modules.reportHost();
  var judgeHostIO = judgeHostIOMod.createJudgeHostIO();
  var engine = null;   // 延迟创建（Node 测试不加载 UI）
  var flightRecorder = null;   // Web 外围 sidecar；绝不进入 Judge 分析/门禁/续跑权威
  var flightRecorderWarning = '';
  var NATIVE_FETCH = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;

  // 官方供应商预设仅属于 Web 配置层：Judge 引擎只消费最终 baseUrl/model/provider。
  // modelsUrl 仅在厂商官方文档明确提供模型列表 API 时登记；查询绝不使用可编辑 Base URL 拼接，防止 Key 误投第三方。
  var PROVIDER_PRESETS = {
    deepseek: {
      label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-v4-flash', defaultMaxTokens: 384000,
      modelsUrl: 'https://api.deepseek.com/models',
      reference: ['上下文 1M', '最大输出 384K', '支持思考模式']
    },
    glm: {
      label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-5.3-flash', defaultMaxTokens: 131072,
      modelsUrl: null,
      reference: ['上下文 1M', '最大输出 128K', '原生多模态', '支持思考模式']
    },
    kimi: {
      label: 'Kimi / Moonshot', baseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'kimi-k3', defaultMaxTokens: 384000,
      modelsUrl: 'https://api.moonshot.cn/v1/models',
      reference: ['上下文 1M', '最大输出 1M', '支持文本 / 图片 / 视频输入', '始终开启思考；reasoning_effort=low/high/max']
    },
    openai: {
      label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-5.6-luna', defaultMaxTokens: 131072,
      modelsUrl: 'https://api.openai.com/v1/models',
      reference: ['上下文 1.05M', '最大输出 128K', '支持文本 / 图片输入与推理']
    }
  };

  // ================= 文案字典（TXT · 用户可见中文文案单一事实源） =================
  // 纯重构：仅字符串引用改为 TXT.xxx，DOM id/类名/逻辑/值语义零变化；
  // 例外保留硬编码：代码注释、console 输出、样式判定正则、tendency.js 注入层、
  // settings 值语义（value 键）、HTML 结构串（'block'/'none' 等）。
  var TXT = {
    brand: {
      title: '辩论筑基 · Debate-Judge · 评委与复盘AI · 完全版',
      ver: '深度评审·完整剖析·AI评委斩杀线'
    },
    top: {
      sessions: '🗂 历史记录',
      flight: '🛩 飞行记录',
      themeDark: '☀ 界面颜色',
      themeLight: '🌙 界面颜色',
      clearCache: '🗑 清除缓存',
      questSteps: ['①', '②', '③', '④', '⑤'],
      questNames: ['圣堂之门', '识海连接', '呈现诉求', '裁决进行', '裁决显现']
    },
    flight: {
      title: '🛩 Web Flight Recorder',
      intro: '旁路保存真实 API request body 与浏览器已收到的原始 SSE 字节。它只用于取证与兜底，不参与 Judge 的 prompt、重试、门禁、轮次完成或断点续跑判断。',
      privacy: '⚠ 飞行记录不保存 Authorization/API Key，但会保存完整辩词、prompt、reasoning 与模型回答；导出文件可能包含敏感内容，请自行妥善保管。',
      partial: 'partial 仅表示已收到部分证据，绝不代表该轮完成。',
      empty: '当前没有真实 API 飞行记录。mock 与“查询厂商模型列表”不会进入 Recorder。',
      storage: '浏览器存储：',
      persist: '请求持久化存储',
      clear: '清空全部飞行记录',
      close: '关闭',
      requests: '请求',
      request: 'request.json',
      response: 'response.sse.raw',
      summary: 'summary.json',
      clearConfirm: '确定清空全部 Web Flight Recorder 记录？此操作不会删除 Judge 正式会话产物。',
      persistGranted: '浏览器已允许持久化存储。',
      persistDenied: '浏览器未授予持久化存储；Recorder 仍可使用，但可能受存储回收策略影响。'
    },
    gate: {
      line: '你确定向圣堂申请裁决，并承受相应的代价吗？',
      fee: '<b>费用</b>：建议按约<strong class="gate-risk-emphasis">120–180万 Token</strong>预留；最近一次全链路实测累计约161.6万 Token（含 R8 多次尝试/续跑成本）。比赛长度、模型与重试次数会影响消耗，复杂场次可能更高。',
      time: '<b>耗时</b>：建议按约<strong class="gate-risk-emphasis">120–180分钟</strong>预留；最近一次全链路实测累计约142分钟（含 R8 多次尝试/续跑耗时）。可中途中止，已完成轮次的产物保存在本地缓存，但断点续跑仍不应视为绝对可靠。',
      accuracy: '<b>AI 误差</b>：裁决由 AI 生成，可能存在错漏、误判或争议；结果仅供技术学习与辩论训练参考，不构成任何专业意见；使用须遵守相关法律法规。',
      key: '<b>密钥</b>：API Key 仅保存在你的浏览器本地，但仍须提高安全意识，泄漏风险自负，请勿在公共机器使用。',
      enter: '🔱 进入圣堂',
      leave: '离开',
      leftNote: '圣堂之门已闭……愿你在门外想清楚再来。',
      reenter: '🔱 重新叩门'
    },
    setup: {
      line: '现在连接你的识海，并提出你的诉求',
      sub: '配置连接（供应商/密钥/端点/模型/思考模式），或保持默认；「本地冒烟」不调用网络，仅验证流程。',
      cardTitle: '🔑 连接识海（API 配置）',
      coreTitle: '核心连接',
      connectionCredentialsTitle: '连接凭据',
      connectionEndpointTitle: '模型与端点',
      connectionRequestTitle: '请求模式',
      outputTitle: '本次裁决 · 输出与阅读',
      outputAdvancedTitle: '高级 · 白话字典',
      tendencySummaryTitle: '裁判倾向摘要',
      contextSummaryTitle: '裁判额外设定摘要',
      judgeAdvancedTitle: '高级 · 裁判参数',
      transportAdvancedTitle: '高级 · Transport',
      provider: '供应商',
      providerDeepseek: 'DeepSeek 官方（默认）',
      providerGlm: '智谱 GLM 官方',
      providerKimi: 'Kimi / Moonshot 官方',
      providerOpenai: 'OpenAI 官方',
      providerCustom: '自定义 OpenAI 兼容端点',
      providerMock: '本地冒烟（mock·不调用网络·仅验证流程）',
      providerHint: '官方供应商会自动填充官方 Base URL 与默认模型；模型名称仍可手动调整。自定义端点需允许浏览器跨域（CORS）。',
      officialRisk: '<b>建议使用模型厂商官方 API Key 与官方 endpoint。</b>第三方 API 中转、聚合或集合平台可能存在模型版本、上下文/输出上限、思考实现、计费与隐私策略差异；Debate-Judge 不建议使用此类平台。',
      customRisk: '<b>⚠ 自定义端点风险提示：</b>请确认你信任该 API 服务方。第三方中转/聚合平台可能与官方模型行为不一致，并可能接触你的 API Key 与辩词内容；优先使用上方厂商官方 API。',
      apiKey: 'API Key（按厂商分别仅存浏览器本地）',
      baseUrl: '端点 Base URL',
      model: '模型',
      defaultModelPre: '默认模型：',
      officialReferencePre: '官方文档参考：',
      queryModels: '🔎 查询该厂商模型列表',
      modelListTitle: '官方模型列表',
      modelListLoading: '正在查询厂商官方模型列表……',
      modelListNeedKey: '请先填写当前厂商的 API Key。',
      modelListUnsupported: '该厂商当前没有经官方文档确认的模型列表查询接口。',
      modelListEmpty: '官方 API 未返回可用模型。',
      modelListFail: '无法读取官方模型列表：',
      modelListNote: '模型列表来自该厂商官方 API；选择模型不会自动判断其是否适合 Debate-Judge，请自行判断使用。',
      modelListSearch: '筛选模型名称……',
      modelUse: '使用此模型',
      modelCopy: '复制',
      modelCopied: '已复制',
      maxTokens: '输出上限 tokens',
      thinking: '思考模式',
      thinkingOn: '开启（默认）',
      thinkingOff: '关闭',
      thinkingCustom: '自定义思考参数（JSON）',
      thinkingHint: '思维链流程故障时可关闭，开启后模型先「思考」再作答（reasoning 内容不计入报告，只取最终回答，但会占用模型生成预算）。',
      thinkingJsonLabel: '思考参数 JSON（原样并入请求体，高级自定义）',
      thinkingJsonHint: '示例：DeepSeek 系 {"thinking":{"type":"enabled"},"thinking_budget":4096}；OpenAI 系 {"reasoning_effort":"medium"}。端点不支持时会自动降级为不附加（自适应保险）。',
      costHint: '费用提示：完整全链路实际消耗可能达到百万级 Token，请以风险提示页的实测区间为参考并留意账户余额。默认单请求输出上限 384K；Judge 核心上下文硬门为 1M tokens（超限即停止，不裁剪降级）。「本地冒烟」= 不联网、用假数据跑通全流程。',
      testApi: '🔌 连通性测试',
      tendTitle: '⚖️ 裁判倾向（三维度六向度权重调节）',
      tendH4a: '① 三维整体权重（评委大倾向）+ 随机性（第四轴）',
      tendNoteA: '说服 / 证明 / 第三方 三个维度的整体权重，0–100。全部为 0 = <b>中立（自动）</b>——由比赛内容驱动，LLM 自行选择匹配的判准框架。<b>随机性</b>与三轴并列（第四轴）：模型采样随机性 0.00–1.00（轴值 ÷100），默认推荐 30（=0.30）。',
      tendH4b: '② 六向度看重程度（单向 · 100=极高，0=不在意，50=常规）',
      tendH4c: '③ 维内倾向（派生 · 由同轴一对向度对比决定）',
      tendNoteB: '六向度都是<b>单向的看重程度</b>（不是双向人格滑杆）：每个维度内部倾向（如批判者 vs 审判者）不是单独调的，而是由该轴对应一对向度的权重对比<b>自动派生</b>。全部三维 0 + 六向度 50 = 内容驱动（auto）。',
      axisPairs: '轴与向度对应：证明轴=证伪↔证成（批判者↔审判者）｜ 说服轴=理性↔感性（卫道者↔问道者）｜ 第三方轴=场面感↔意义感（技术者↔艺术者）',
      tendReset: '🔄 还原默认（三维 0 + 六向度 50）',
      tendHelp: '📖 倾向说明',
      tendProfileLocal: '🧬 应用本机人格测试结果',
      tendProfileFile: '📥 导入人格 JSON',
      tendProfileNone: '本机没有已明确保存的评委人格测试配置。请先在“评委人格测试”结果页手工保存，或使用 JSON 导入。',
      tendProfileInvalid: '评委人格配置无效：',
      tendProfileConfirmPre: '检测到评委人格测试配置',
      tendProfileConfirmV1Tail: '。\n这是旧版 v1：仅覆盖六向度；三维整体权重与随机性保持当前值不变。\n确认应用？',
      tendProfileConfirmV2Tail: '。\n这是新版 v2：将覆盖三维整体权重与六向度；随机性保持当前值不变。\n确认应用？',
      tendProfileAppliedV1: '已应用旧版评委人格测试的六向度配置。三维整体权重与随机性未修改。',
      tendProfileAppliedV2: '已应用新版评委人格测试的三维整体权重与六向度配置。随机性未修改。',
      depthTitle: '🎚 报告深度与选项',
      depthHint: '默认三项均为<b>管道默认档</b>（质量最优配置，与 CLI 管道完全一致）；调高/调低会相应增删报告内容。',
      depthVerdict: '胜负判决详细度',
      depthVerdictBrief: '简明',
      depthVerdictStd: '标准（管道默认）',
      depthVerdictDetail: '详细',
      depthMainline: '主线分析深度',
      depthMainlineBrief: '简述类型',
      depthMainlineStd: '标准全景图（管道默认）',
      depthMainlineDetail: '逐环节追踪',
      depthClash: '交锋裁决详细度',
      depthClashBrief: '仅关键2-3个',
      depthClashStd: '标准5-8个（管道默认）',
      depthClashDetail: '逐回合全部',
      optPlain: ' 生成白话版报告（--plain，默认开启·追加 LLM 翻译批）',
      optReaderGuide: ' 生成章节导览（R8，默认开启·主裁决完成后追加导览与独立复核）',
      optSkipRoster: ' 跳过名册人工确认（--skip-roster-confirm）',
      plainDictLabel: '外部白话字典（--plain-dict，可选）',
      plainDictHint: '上传 {词:释义} JSON 覆盖核心词条；不传则用核心字典。',
      plainDictLoadedPre: '已加载 ',
      plainDictLoadedTail: ' 词条（覆盖核心）',
      plainDictLogPre: '📖 外部白话字典已加载（',
      plainDictLogTail: ' 词条，运行生效）',
      plainDictNone: '未加载（用核心字典）',
      plainDictInvalid: '外部字典格式无效：须为 {词: 释义} 的 JSON 对象',
      plainDictClear: '✖ 清除',
      sessTitle: '🗂 会话（断点续跑）',
      sessEmpty: '暂无会话。完成/中断的场次会自动保存在浏览器本地（IndexedDB）。',
      importSession: '📥 导入会话产物 JSON',
      backGate: '← 返回圣堂之门',
      nextSetup: '连接完成，进入下一步 →'
    },
    upload: {
      line: '完整呈现你要裁决的所有内容',
      sub: '上传或粘贴完整辩词（.txt / .md 等文本格式；.docx / .pdf 需联网按需加载解析库）。',
      cardTitle: '📜 辩词呈递',
      dropText: '点击上传辩词文件 / 拖拽到此处',
      dropHint: '支持 .txt .md（.docx/.pdf 需联网按需加载解析库），也可直接粘贴文本',
      pasteLabel: '或直接粘贴辩词文本：',
      pastePlaceholder: '粘贴完整的辩词文本……&#10;&#10;示例格式：&#10;正方一辩：……&#10;反方一辩：……&#10;正方二辩：……&#10;……',
      tokenWarn: '⚠️ 辩词较长（约 <span id="token-warn-n"></span>k tokens），完整管道（R1/R2 全文注入）可能消耗大量 Token。建议保留立论+自由辩+结辩关键环节。',
      backSetup: '← 返回设置',
      clear: '清空本场',
      run: '⚔ 开始审判',
      filesTitle: '本次案卷',
      noFiles: '尚未选择文件；也可以直接粘贴辩词。',
      configTitle: '当前配置'
    },
    run: {
      line: '圣堂正在聆听双方的陈词……',
      sub: '裁决轮次与后处理进度 · 实时状态 · 运行日志。',
      cardTitle: '📡 审判进程',
      stop: '⏹ 中止',
      resumeStart: '▶ 续跑',
      resumeReady: '断点已载入 · 等待手动续跑',
      resumeReadyStatus: '尚未调用 API。确认后点击“续跑”。',
      resumeStalePre: '尚未调用 API。⚠ ',
      resumeStaleTail: ' 轮产物基于旧版 prompt；续跑会保留现有断点，按新版 prompt 重算需另行重跑。',
      resumeLoadedLog: '↻ 已载入历史断点，尚未调用 API。',
      returnReport: '↩ 返回本场报告',
      backRun: '← 返回上一步',
      closeWarning: '⚠ 等待裁决或模型响应期间请勿关闭、刷新或离开本页面，以免当前请求中断。',
      statusRunning: '运行中……',
      statusAborted: '已中止',
      statusFailed: '失败',
      statusDone: '完成 ✓',
      statusException: '异常',
      tlSkipped: '断点',
      tlPending: '·',
      tlActive: '…',
      tlDone: '✓',
      tlFail: '✗',
      pnRounds: '轮次：',
      pnRoundsSep: '/',
      pnRetries: '重试：',
      pnRetriesUnit: ' 次',
      logSkip: '断点命中 ',
      logSkipTail: ' → 跳过',
      logDone: '✓ ',
      logDoneTail: ' 完成',
      logFail: '✗ ',
      logFailTail: ' 门禁失败',
      logPostFailTail: ' 后处理失败',
      logAborted: '⏹ 已中止（本轮产物未落盘）',
      logPipelineFail: '✗ 管道失败：',
      gateBlocked: '门禁阻断',
      logReportDone: '报告已生成：',
      logReportMissing: '⚠ 管道通过但未找到 report.html（请检查日志）',
      logException: '✗ 运行异常：',
      logHint: '💡 提示：',
      logStopRequest: '⏹ 用户请求中止……',
      liveElapsed: '⏱ ',
      liveChars: ' · 已接收 ',
      liveCharsTail: ' 字',
      liveReason: ' · 思考 ',
      liveTokenHead: ' · 估算 Token：正文≈',
      liveTokenReason: ' / 思考≈',
      liveTokenCurrent: ' / 当前≈',
      liveTokenRun: ' · 本次累计≈',
      liveTokenSession: ' · 本场累计≈',
      liveTokenTail: ' Token',
      liveFinal: ' · 本轮流已结束',
      liveIdle: ' · 活动 ',
      liveIdleTail: 's 前',
      liveStuck: ' ⚠ 长时间无新数据——如确认卡死可点「中止」（不落盘半成品）',
      liveWaiting: ' · 等待模型响应…（连接建立后实时显示接收字数）',
      anchorLoaded: '锚已加载',
      anchorAbnormal: '⚠ 名册严重异常（',
      anchorAbnormalA: '类型A',
      anchorAbnormalB: '类型B',
      anchorAbnormalTail: '）——继续将带免责声明',
      anchorExtracted: '名册抽取完成：辩题「',
      anchorUnknownTitle: '未识别',
      anchorExtractedTail: '」',
      anchorSides: ' 正方 ',
      anchorVs: ' 人 / 反方 ',
      anchorWait: ' 人 ⏸ 等待确认',
      adaptive: '⚠ 自适应保险：max_tokens 已自动调整为 ',
      adaptiveTail: '（青春版同款机制：截断→提高 / 拒绝→减半）',
      notePrefix: 'ℹ '
    },
    roster: {
      title: '👥 名册确认（圣堂名录核查）',
      topic: '辩题：',
      unknown: '（未识别）',
      integrity: ' ｜ 完整性：',
      alert: '⚠ 严重异常（',
      typeA: '类型 A：辩位/身份不齐全',
      typeB: '类型 B：结构性缺失',
      alertTail: '）——继续将降级运行且最终报告带免责声明',
      bench: '候补/未上场：',
      none: '无',
      otherSpeakers: '　｜　非辩手发言者：',
      warn: '警告：',
      edit: '✏ 编辑名册 JSON',
      abort: '✖ 终止（修正辩词后重开）',
      confirm: '✔ 确认继续',
      cancel: '取消',
      apply: '应用并重新确认',
      jsonInvalid: '名册 JSON 无效：',
      roleLabel: '（角色标签）',
      emptySide: '（无）'
    },
    sess: {
      historyTitle: '🗂 历史记录与本地储存',
      historyIntro: 'Judge 正式会话与 Flight Recorder 分库存放、分权管理。历史记录可以续跑或重新出报告；飞行记录只作旁路取证，不能替代正式断点。',
      retentionTitle: '正式分析历史保留上限',
      retentionHint: '默认 100 场，绝对上限 100。可向下调；应用更低上限时会先确认，再完整删除最旧且非运行中的会话。',
      retentionApply: '应用保留上限',
      retentionConfirmPre: '当前共有 ',
      retentionConfirmMid: ' 场；应用后预计删除最旧 ',
      retentionConfirmTail: ' 场正式历史。确认继续？',
      retentionProtected: '有运行中的会话受到保护，当前暂时无法完全降到目标上限；运行结束后会再次治理。',
      storageTitle: '本地储存',
      browserStorage: '浏览器报告总占用 / 配额',
      judgeStorage: 'Judge 正式历史逻辑体量（估算）',
      recorderStorage: 'Flight Recorder 逻辑体量（估算）',
      orphanStorage: 'Judge 孤儿文件记录',
      storageUnknown: '不可用',
      orphanScan: '扫描并清理孤儿数据',
      orphanNone: '未发现 Judge 孤儿文件记录。',
      orphanConfirmPre: '发现 ',
      orphanConfirmTail: ' 条无对应正式会话的 sessionFiles 记录。确认清理？',
      orphanDone: '孤儿数据已清理：',
      clearJudge: '清空全部 Judge 历史',
      clearJudgeConfirm: '确定删除全部 Judge 正式历史及其 BASE / FINAL / R* 本地产物？Flight Recorder 不会被删除。',
      manageRecorder: '打开飞行记录管理',
      closeHistory: '关闭',
      countPre: '正式历史：',
      countSep: ' / ',
      countTail: ' 场',
      empty: '暂无正式历史。完成/中断的场次会自动保存在浏览器本地（IndexedDB）。',
      resume: '续跑',
      reissue: '重新出报告',
      export: '导出会话',
      del: '删除',
      rename: '重命名',
      meta: '元数据',
      metaFile: 'judge-web-run-',
      previewSkip: '断点预估：',
      previewSkipListPre: ' 等 ',
      previewSkipListTail: ' 轮续跑将跳过（实际以续跑判定为准）',
      previewNone: '断点预估：无跳过',
      previewRunning: '断点预估：运行结束后更新',
      stDone: '完成',
      stSkipped: '跳过',
      stFail: '失败',
      stPending: '未到达',
      retries: '重试',
      promptHash: 'prompt',
      // W-PH：promptHash 失配（产物基于旧版 prompt）
      staleBadge: ' · ⚠ prompt 已变更',
      staleHintPre: ' ⚠ ',
      staleHintTail: ' 轮产物基于旧版 prompt（prompt 已变更），建议重跑',
      statusDone: '完成',
      statusRunning: '运行中',
      statusFailed: '失败',
      statusAborted: '已中止',
      statusInterrupted: '中断',
      renamePrompt: '新标题：',
      delConfirm: '删除历史「',
      delConfirmTail: '」及其全部本地产物？',
      noReport: '该会话没有可恢复的 report.html，且机械重建失败：',
      reissueBuilt: '已从既有正式产物机械重建 report.html；未重新调用 LLM。',
      noSession: '暂无会话',
      sessionFile: 'judge-web-会话-',
      notValid: '不是有效的 judge-web 会话产物 JSON',
      imported: '会话已导入：',
      importedTail: '\n可从「历史记录」续跑或重新出报告。',
      importFailed: '导入失败：'
    },
    report: {
      line: '裁决已成，记得保存XD',
      sub: '报告为内核原始产物（含白话版切换按钮）——导出 HTML 可离线查看；再点一次审判会生成新一场。',
      cardTitle: '📋 裁判报告',
      exportHtml: '⬇ 导出 HTML',
      exportMd: '⬇ 导出 MD（纯文本）',
      copy: '📋 复制文本',
      exportSession: '💾 导出会话产物（断点迁移）',
      importHtml: '📥 导入报告 HTML 查看',
      backRun: '← 返回流程（查看审判日志）',
      noReport: '暂无报告',
      fileHtml: '裁判报告-',
      fileMd: '裁判报告-',
      copied: '已复制到剪贴板',
      copyFailed: '复制失败',
      footnote: '本工具仅供技术学习与辩论训练参考。用户需自行承担使用 API 产生的费用及遵守相关法律法规的责任。'
    },
    api: {
      mockNoTest: '✅ 本地冒烟模式：不调用网络，无需连通性测试。',
      mockNoKey: '本地冒烟模式：不调用网络，无需 Key。',
      testing: '测试中……',
      ok: '✅ 连通（HTTP ',
      okTail: '）',
      warn: '⚠ HTTP ',
      warnTail: '（若返回 401/403 属正常鉴权响应，端点可达）',
      fail: '✗ 不可达：',
      failTail: '（注意 CORS/网络）'
    },
    ctx: {
      title: '④ 裁判额外设定 · Judge Persona Context',
      enable: '启用本场裁判额外设定',
      useMode: '使用范围',
      backgroundMode: '背景类型',
      domains: '熟悉领域（最多 3 项；Ctrl/Cmd 可多选）',
      familiarity: '术语熟悉程度',
      values: '价值关注（最多 4 项；Ctrl/Cmd 可多选）',
      perspective: '裁判视角',
      note: '受限短补充说明（单行 ≤120 字符）',
      notePlaceholder: '例如：熟悉公共法与规范伦理学术语。',
      guard: '独立于三维/六向度：不进入 R1–R4；默认只影响 R5 的解释表达。高级模式仅让 R4.5 在机械已登记冲突中使用结构化标签作次级解释；不会修改事实、举证责任、实际交锋、既有 Judge 合同、胜负/比分、temperature 或 randomness。',
      invalid: '裁判额外设定无效：',
      useModes: { presentation_only: '默认：仅报告表达（R5）', registered_conflicts_plus_presentation: '高级：已登记冲突（R4.5）+ 报告表达（R5）' },
      backgroundModes: { none: '无特定背景', academic: '学术背景', practitioner: '实务背景', mixed: '学术 + 实务' },
      familiarityLabels: { general: '通用', working: '熟悉', deep: '深入' },
      domainLabels: {
        law_public_policy: '法律 / 公共政策', economics_business: '经济 / 商业', philosophy_ethics: '哲学 / 伦理', social_science: '社会科学',
        natural_science: '自然科学', engineering_technology: '工程 / 技术', medicine_public_health: '医学 / 公共卫生', education: '教育',
        history_humanities: '历史 / 人文', media_communication: '媒体 / 传播', arts_culture: '艺术 / 文化', public_administration: '公共管理'
      },
      valueLabels: {
        procedural_fairness: '程序公平', substantive_fairness: '实质公平', individual_autonomy: '个体自主', rights_dignity: '权利 / 尊严',
        welfare_harm: '福祉 / 伤害', responsibility_accountability: '责任 / 问责', equality_inclusion: '平等 / 包容', order_predictability: '秩序 / 可预期性',
        long_term_sustainability: '长期可持续', truth_accuracy: '真实 / 准确', social_trust: '社会信任', feasibility_execution: '可行性 / 执行'
      },
      perspectiveLabels: {
        neutral_observer: '中立观察者', general_public: '一般公众', directly_affected: '直接受影响者', domain_practitioner: '领域实务者',
        institutional_operator: '机构执行者', policy_decision_maker: '政策决策者', academic_observer: '学术观察者', community_observer: '社区观察者'
      }
    },
    tend: {
      randomAxis: '随机性',
      dimAuto: '中立（自动）',
      tempDefault: '默认推荐30',
      derivedPrefix: '偏',
      neutral: '中立',
      autoPreview: '当前 = 内容驱动（auto）',
      relativePreview: '六向度相对占比预览',
      helpTitle: '📖 裁判倾向说明（三维度六向度权重调节）',
      helpP1: '<p><b>① 三维整体权重（评委大倾向）+ 随机性（第四轴）</b>：说服 / 证明 / 第三方，各 0–100。决定你作为裁判的整体侧重（比如「我主要看论证严谨性，说服力次之」）。<b>全部为 0 = 中立（自动）</b>——由比赛内容驱动，LLM 根据辩词自行选择匹配的判准框架；同一场多次运行结果基本一致。第四轴<b>随机性</b>与三维并列：模型采样随机性 0.00–1.00（轴值 ÷100），默认推荐 30（=0.30）。</p>',
      helpP2: '<p><b>② 六向度看重程度</b>：证伪 / 证成 / 理性 / 感性 / 场面感 / 意义感，各 0–100。<b>单向语义</b>：100 = 极高，0 = 不在意，50 = 常规。六个向度始终全部参与评判，只是看重程度不同。</p>',
      helpP3: '<p><b>③ 维内倾向（派生，不单独调节）</b>：每个轴的人格倾向不是独立滑杆，而是由同轴一对向度的对比<b>自动派生</b>——证明轴：证伪 vs 证成（证伪高 → 偏批判者·证伪导向；证成高 → 偏审判者·自证导向）；说服轴：理性 vs 感性（理性高 → 偏卫道者·常识侧；感性高 → 偏问道者·新视角侧）；第三方轴：场面感 vs 意义感（场面感高 → 偏技术者·操作流畅；意义感高 → 偏艺术者·深度审美）；相等 = 该轴中立。</p>',
      helpP4: '<p><b>生效方式</b>：全部滑块 → 自然语言注意力引导文本 → 注入每一轮提示词头（与 CLI <code>--tendency</code> 同通道）。是注意力倾向性引导，不是数学公式。</p>',
      helpP5: '<p><b>示例</b>：三维证明 80 / 六向度证伪 90、证成 50 → 裁判整体侧重证明侧，证明轴内偏批判者（证伪导向），证成向度仍按常规权重参与。</p>',
      helpClose: '知道了'
    },
    files: {
      loaded: '✅ 已加载（',
      loadedTail: ' KB）',
      readFail: '以下文件无法读取：\n',
      needLib: '（需联网加载解析库）',
      unsupported: '（不支持的格式）',
      pdfEmpty: '（空 PDF，无页面）',
      pdfBlank: '（未提取到文本，可能是扫描版 PDF）'
    },
    alert: {
      noTranscript: '请先上传或粘贴辩词文本',
      noKey: '请填写 API Key（或选择「本地冒烟」模式）',
      clearCache: '清除本地缓存？\n将清除：API Key、端点配置、主题与倾向设置（会话产物保留）。\n页面将自动刷新。',
      abortRun: '审判正在进行——返回将中止本轮运行（已完成的轮次产物仍保留，未落盘的半成品将丢弃）。确认中止并返回？'
    },
    err: {
      e402: '账户余额不足或欠费（402）——请检查充值后重试。',
      e429: '请求频率/配额限制（429）——稍等片刻后重试。',
      e401: 'API Key 无效或无权限（401/403）——请检查密钥。',
      e404: '端点或模型名错误（404）——请检查 Base URL 与模型名。',
      eNet: '网络或跨域问题——检查网络连接；自定义端点需允许浏览器跨域（CORS）。'
    }
  };

  // ================= 状态 =================
  // 设置存储键带版本号：默认值修订时升版本，旧缓存自动弃用（API Key 另存，不受影响）
  var LS_KEY = 'judge_web_settings_v9';
  var API_KEYS_LS_KEY = 'judge_web_api_keys_v1';
  var HISTORY_POLICY_LS_KEY = 'judge_web_history_policy_v1';
  var TENDENCY_PROFILE_LS_KEY = 'debate_judge_tendency_profile_v1';
  var TENDENCY_PROFILE_V2_LS_KEY = 'debate_judge_tendency_profile_v2';
  var DB_NAME = 'judge-web';
  var DB_STORE = 'sessions';
  var settings = loadSettings();
  var historyPolicy = loadHistoryPolicy();
  // UI 2.0：canonical ReportDocument 与 presentation runtime 分离；html 字段仅保留为兼容投影。
  var reportState = { document: null, html: null, workDir: null };
  var reportHost = null;
  var reportPlainMode = false;
  var reportNavHistory = [];
  var reportCurrentSection = null;
  var running = false;
  var abortController = null;
  var currentSession = null;   // {dir, title}
  var pendingResume = null;    // {dir}：历史断点已恢复到 VFS，但尚未开始任何 API
  var fetchManager = null;
  var modelListItems = [];
  var historyOverlay = null;
  var archiveSelectedSessionId = null;
  var archiveSearchQuery = '';
  var archiveVisibleCount = 0;
  var archiveFlightRefreshGeneration = 0;
  var archiveFlightSelectedSessionIds = Object.create(null);
  var archiveFlightSelectionInitialized = false;
  var currentScene = 'gate';
  var transientLayers = [];

  function transientDialogOf(el) {
    if (!el) return null;
    if (el.matches && el.matches('.modal')) return el;
    return el.querySelector ? el.querySelector('.modal') : null;
  }
  function transientFocusables(el) {
    if (!el || !el.querySelectorAll) return [];
    return Array.prototype.slice.call(el.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')).filter(function (node) {
      return !node.disabled && node.getAttribute('aria-hidden') !== 'true' && node.offsetParent !== null;
    });
  }
  function trapTransientFocus(el, e) {
    if (!e || e.key !== 'Tab') return;
    var dialog = transientDialogOf(el) || el;
    var nodes = transientFocusables(dialog);
    if (!nodes.length) { e.preventDefault(); if (dialog && dialog.focus) dialog.focus(); return; }
    var first = nodes[0], last = nodes[nodes.length - 1], active = document.activeElement;
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }
  function registerTransientLayer(el, onBack) {
    if (!el) return el;
    var dialog = transientDialogOf(el);
    if (dialog) {
      if (!dialog.getAttribute('role')) dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
    }
    var restoreFocus = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    transientLayers.push({ el: el, onBack: onBack || null, restoreFocus: restoreFocus });
    document.body.classList.add('transient-open');
    setTimeout(function () {
      if (!el.parentNode) return;
      var target = transientFocusables(dialog || el)[0] || dialog;
      if (target && target.focus) target.focus();
    }, 0);
    return el;
  }
  function unregisterTransientLayer(el) {
    var removed = null;
    transientLayers = transientLayers.filter(function (x) {
      if (x.el === el) { removed = x; return false; }
      return true;
    });
    if (!transientLayers.length) document.body.classList.remove('transient-open');
    return removed;
  }
  function restoreTransientFocus(layer) {
    var restoreFocus = layer && layer.restoreFocus;
    if (!restoreFocus || !restoreFocus.focus) return;
    setTimeout(function () { try { restoreFocus.focus(); } catch (e) {} }, 0);
  }
  function removeTransientLayer(el) {
    if (!el) return;
    var layer = unregisterTransientLayer(el);
    if (el.parentNode) el.parentNode.removeChild(el);
    restoreTransientFocus(layer);
  }
  function consumeTopTransientLayer() {
    while (transientLayers.length && (!transientLayers[transientLayers.length - 1].el || !transientLayers[transientLayers.length - 1].el.parentNode)) transientLayers.pop();
    if (!transientLayers.length) { document.body.classList.remove('transient-open'); return false; }
    var layer = transientLayers[transientLayers.length - 1];
    if (typeof layer.onBack === 'function') layer.onBack();
    else removeTransientLayer(layer.el);
    return true;
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (consumeTopTransientLayer() || consumeReportTransientUI()) { e.preventDefault(); return; }
    }
    if (e.key !== 'Tab') return;
    if (transientLayers.length) { trapTransientFocus(transientLayers[transientLayers.length - 1].el, e); return; }
    if (isMobileReportOutlineOpen()) trapTransientFocus($('report-outline'), e);
  });
  // P0-3｜原生 details 保留自身 toggle；document capture 只补 outside-click，避免 target handler 先打开其它 transient 后留下后台菜单。
  document.addEventListener('click', function (e) {
    if (currentScene !== 'report') return;
    var menu = $('report-export-menu');
    if (menu && menu.open && e && e.target && !menu.contains(e.target)) menu.open = false;
  }, true);

  function loadSettings() {
    var d = {
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      maxTokens: 384000,
      temperature: 0.3,
      thinking: 'on',
      thinkingJson: '{"thinking":{"type":"enabled"},"thinking_budget":4096}',
      plain: true,
      readerGuide: true,
      skipRosterConfirm: false,
      plainDictExt: null,
      depth: { verdict: '标准', mainline: '标准全景图', clash: '标准5-8个' },
      dimWeights: { 说服: 0, 证明: 0, 第三方: 0 },
      tendencyWeights: { 证伪: 50, 证成: 50, 理性: 50, 感性: 50, 场面感: 50, 意义感: 50 },
      judgeContext: judgeContextMod.normalizeJudgeContext(null),
      theme: 'dark'
    };
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) {
        // 260831：v8→v9 新增 R8 章节导览默认开关；更早缓存继续逐级迁移。
        raw = localStorage.getItem('judge_web_settings_v8') || localStorage.getItem('judge_web_settings_v7') || localStorage.getItem('judge_web_settings_v6') || localStorage.getItem('judge_web_settings_v5');
      }
      if (raw) {
        var j = normalizeSettingsKeys(JSON.parse(raw));
        if (Number(j.maxTokens) === 65536) j.maxTokens = 384000;
        else if (Number(j.maxTokens) > 384000) j.maxTokens = 384000;
        else if (Number(j.maxTokens) > 0 && Number(j.maxTokens) < 4096) j.maxTokens = 4096;
        if (j.thinkingPrefSet !== undefined) d.thinkingPrefSet = j.thinkingPrefSet;
        for (var k in d) if (j[k] !== undefined) d[k] = j[k];
        try { d.judgeContext = judgeContextMod.normalizeJudgeContext(j.judgeContext === undefined ? null : j.judgeContext); }
        catch (ctxErr) { d.judgeContext = judgeContextMod.normalizeJudgeContext(null); }
        if (!d.dimWeights) d.dimWeights = { 说服: 0, 证明: 0, 第三方: 0 }; 
        if (d.tendencyWeights && Object.keys(d.tendencyWeights).length < 6) d.tendencyWeights = { 证伪: 50, 证成: 50, 理性: 50, 感性: 50, 场面感: 50, 意义感: 50 };
        if (!j.thinkingPrefSet) d.thinking = 'on';
        if (!PROVIDER_PRESETS[d.provider] && d.provider !== 'custom' && d.provider !== 'mock') d.provider = 'custom';
        localStorage.setItem(LS_KEY, JSON.stringify(d));
      }
    } catch (e) {}
    return d;
  }
  function saveSettings() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch (e) {}
  }
  // 历史保留策略是纯外围状态：不进入 settings，不随 Judge 会话快照或 API 请求传播。
  function loadHistoryPolicy() {
    var p = { maxSessions: historyGovernance.DEFAULT_RETENTION_LIMIT };
    try {
      var raw = localStorage.getItem(HISTORY_POLICY_LS_KEY);
      if (raw) {
        var j = JSON.parse(raw);
        p.maxSessions = historyGovernance.normalizeRetentionLimit(j && j.maxSessions);
      }
    } catch (e) {}
    return p;
  }
  function saveHistoryPolicy() {
    historyPolicy.maxSessions = historyGovernance.normalizeRetentionLimit(historyPolicy.maxSessions);
    try { localStorage.setItem(HISTORY_POLICY_LS_KEY, JSON.stringify(historyPolicy)); } catch (e) {}
  }
  // C3（260815）：旧键归一化（weights→tendencyWeights、skipRoster→skipRosterConfirm）——
  // 存量会话快照/导入会话/旧 localStorage 缓存均可能携带旧键；仅旧键存在时迁移，返回原对象（就地修改，无拷贝）
  function normalizeSettingsKeys(s) {
    if (!s || typeof s !== 'object') return s;
    if (s.weights && s.tendencyWeights === undefined) { s.tendencyWeights = s.weights; delete s.weights; }
    if (s.skipRoster !== undefined && s.skipRosterConfirm === undefined) { s.skipRosterConfirm = s.skipRoster; delete s.skipRoster; }
    // R8 产品默认 = 开启。旧设置/历史会话没有该键时显式补 true；只有用户主动关闭才保持 false。
    if (s.readerGuide === undefined) s.readerGuide = true;
    try { s.judgeContext = judgeContextMod.normalizeJudgeContext(s.judgeContext === undefined ? null : s.judgeContext); }
    catch (ctxErr) { s.judgeContext = judgeContextMod.normalizeJudgeContext(null); }
    if (s.provider === 'opencode-go') s.provider = 'custom';
    return s;
  }
  function apiKeySlot(provider) {
    return PROVIDER_PRESETS[provider] ? provider : (provider === 'custom' ? 'custom' : '');
  }
  function loadApiKeys() {
    var keys = {};
    try {
      var raw = localStorage.getItem(API_KEYS_LS_KEY);
      if (raw) keys = JSON.parse(raw) || {};
      var legacy = localStorage.getItem('judge_web_api_key') || '';
      var slot = apiKeySlot(settings.provider);
      var migratedLegacy = false;
      if (legacy && slot && !keys[slot]) {
        keys[slot] = legacy;
        localStorage.setItem(API_KEYS_LS_KEY, JSON.stringify(keys));
        migratedLegacy = true;
      }
      // 当前为 mock 等无法判断归属的旧 Key 不猜厂商、不误投，也不删除；待用户切换/重新填写后再由新槽接管。
      if (migratedLegacy) localStorage.removeItem('judge_web_api_key');
    } catch (e) { keys = {}; }
    return keys;
  }
  var API_KEYS = loadApiKeys();
  var API_KEY = API_KEYS[apiKeySlot(settings.provider)] || '';
  function saveApiKeys() {
    try { localStorage.setItem(API_KEYS_LS_KEY, JSON.stringify(API_KEYS)); } catch (e) {}
  }
  function setApiKey(v) {
    API_KEY = v;
    var provider = ($('cfg-provider') && $('cfg-provider').value) || settings.provider;
    var slot = apiKeySlot(provider);
    if (slot) { API_KEYS[slot] = v; saveApiKeys(); }
  }
  function syncApiKeyForProvider(provider) {
    var slot = apiKeySlot(provider);
    API_KEY = slot ? (API_KEYS[slot] || '') : '';
    var el = $('cfg-key');
    if (el) el.value = API_KEY;
  }

  // ================= IndexedDB =================
  // C5（260815）+ W-T1 durability：连接复用单例；blocked 当前调用必须 fail-close，versionchange 主动让锁。
  var idbPending = null;
  function idbOpen() {
    if (idbPending) return idbPending;
    idbPending = new Promise(function (resolve, reject) {
      var abandoned = false;
      var req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          var os = db.createObjectStore(DB_STORE, { keyPath: 'id' });
          os.createIndex('updatedAt', 'updatedAt');
        }
        // C5 v2：sessionFiles 独立 store——files 与元数据分离（增量写 + 列表读轻量化）
        if (!db.objectStoreNames.contains('sessionFiles')) db.createObjectStore('sessionFiles', { keyPath: 'id' });
      };
      req.onsuccess = function () {
        var db = req.result;
        if (abandoned) { try { db.close(); } catch (e) {} return; }
        db.onversionchange = function () { try { db.close(); } catch (e) {} idbPending = null; };
        db.onclose = function () { idbPending = null; };   // 连接被关闭/淘汰 → 下次重开
        resolve(db);
      };
      req.onblocked = function () {
        abandoned = true;
        idbPending = null;
        reject(new Error('Judge IndexedDB 升级被旧页面阻塞；请关闭其它旧 Judge 页面后重试'));
      };
      req.onerror = function () { idbPending = null; reject(req.error || new Error('Judge IndexedDB open failed')); };
    });
    return idbPending;
  }
  function idbPut(rec) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(rec);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  function idbAll() {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readonly');
        var req = tx.objectStore(DB_STORE).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  function idbDel(id) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).delete(id);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  function idbGet(id) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readonly');
        var req = tx.objectStore(DB_STORE).get(id);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  // C5：sessionFiles store 专用 API（记录 id = dir + '#BASE' / '#R{n}' / '#FINAL'；前缀过滤统一内存侧——真实 IDB 与桩均无前缀 API）
  function idbPutFile(id, files) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('sessionFiles', 'readwrite');
        tx.objectStore('sessionFiles').put({ id: id, files: files, logicalBytes: historyGovernance.estimateValueBytes(files) });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  // 指定节点续跑的旧终态只读版本。物理复用 sessionFiles store，但使用 @VERSION: 命名空间；
  // idbAllFiles(dir) 只读取 dir#...，因此版本永远不会进入 checkpoint merge / resume authority。
  function idbCreateSessionVersionSnapshot(session, files) {
    if (!session || !session.id || !session.dir || !files || typeof files !== 'object') return Promise.reject(new Error('session version snapshot 输入不完整'));
    var createdAt = new Date().toISOString();
    var versionId = '@VERSION:' + encodeURIComponent(String(session.dir)) + ':' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 10);
    var settingsCopy = null, summaryCopy = null;
    try { settingsCopy = session.settings ? JSON.parse(JSON.stringify(session.settings)) : null; } catch (e) {}
    try { summaryCopy = session.run && session.run.summary ? JSON.parse(JSON.stringify(session.run.summary)) : null; } catch (e2) {}
    var record = {
      id: versionId,
      kind: 'judge-session-version-v1',
      versionId: versionId,
      sessionId: String(session.dir),
      createdAt: createdAt,
      sourceUpdatedAt: session.updatedAt || null,
      title: session.title || String(session.dir).split('/').pop(),
      status: session.status || null,
      reportReady: !!session.reportReady,
      settings: settingsCopy,
      runSummary: summaryCopy,
      files: files,
      logicalBytes: historyGovernance.estimateValueBytes(files)
    };
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('sessionFiles', 'readwrite');
        tx.objectStore('sessionFiles').put(record);
        tx.oncomplete = function () { resolve(record); };
        tx.onerror = function () { reject(tx.error || new Error('session version snapshot write failed')); };
        tx.onabort = function () { reject(tx.error || new Error('session version snapshot write aborted')); };
      });
    });
  }
  function idbListSessionVersions(dir) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('sessionFiles', 'readonly');
        var req = tx.objectStore('sessionFiles').getAll();
        req.onsuccess = function () {
          resolve((req.result || []).filter(function (row) {
            return row && row.kind === 'judge-session-version-v1' && row.sessionId === dir;
          }).sort(function (a, b) { return String(a.createdAt || '').localeCompare(String(b.createdAt || '')); }));
        };
        req.onerror = function () { reject(req.error || new Error('session version list failed')); };
      });
    });
  }
  // 新 resume epoch：新 BASE 与旧 FINAL/R* 的退役必须是同一事务。
  // 这样任意刷新只能看到“旧 epoch 完整不动”或“新 epoch BASE 已 durable”，不存在旧 FINAL 复活窗口。
  function idbCommitResumeEpoch(rec, baseFiles, dir) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        function fail(e) { if (settled) return; settled = true; reject(e || new Error('resume epoch transaction failed')); }
        try {
          var tx = db.transaction([DB_STORE, 'sessionFiles'], 'readwrite');
          var meta = tx.objectStore(DB_STORE);
          var files = tx.objectStore('sessionFiles');
          tx.oncomplete = function () { if (settled) return; settled = true; resolve(true); };
          tx.onerror = function () { fail(tx.error || new Error('resume epoch transaction error')); };
          tx.onabort = function () { fail(tx.error || new Error('resume epoch transaction aborted')); };
          meta.put(rec);
          files.put({ id: dir + '#BASE', files: baseFiles, logicalBytes: historyGovernance.estimateValueBytes(baseFiles) });
          var req = files.getAll();
          req.onsuccess = function () {
            var rPre = dir + '#R';
            var finalId = dir + '#FINAL';
            (req.result || []).forEach(function (row) {
              var id = row && row.id;
              if (id === finalId || (id && id.slice(0, rPre.length) === rPre)) files.delete(id);
            });
          };
          req.onerror = function () { try { tx.abort(); } catch (e) { fail(req.error || e); } };
        } catch (e) { fail(e); }
      });
    });
  }
  // W-T1：正式 Judge checkpoint 单一原子提交 primitive。metadata + file record + FINAL 清旧 R* 同一 transaction；只有 oncomplete 才算 durable。
  function idbCommitSessionCheckpoint(rec, fileRecord, clearRoundDir) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        function fail(e) { if (settled) return; settled = true; reject(e || new Error('Judge checkpoint transaction failed')); }
        try {
          var tx = db.transaction([DB_STORE, 'sessionFiles'], 'readwrite');
          var meta = tx.objectStore(DB_STORE);
          var files = tx.objectStore('sessionFiles');
          tx.oncomplete = function () { if (settled) return; settled = true; resolve(true); };
          tx.onerror = function () { fail(tx.error || new Error('Judge checkpoint transaction error')); };
          tx.onabort = function () { fail(tx.error || new Error('Judge checkpoint transaction aborted')); };
          meta.put(rec);
          if (fileRecord) files.put(fileRecord);
          if (clearRoundDir) {
            var req = files.getAll();
            req.onsuccess = function () {
              var rPre = clearRoundDir + '#R';
              (req.result || []).forEach(function (row) {
                var id = row && row.id;
                if (id && id.slice(0, rPre.length) === rPre) files.delete(id);
              });
            };
            req.onerror = function () { try { tx.abort(); } catch (e) { fail(req.error || e); } };
          }
        } catch (e) { fail(e); }
      });
    });
  }
  function idbAllFiles(dir) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('sessionFiles', 'readonly');
        var req = tx.objectStore('sessionFiles').getAll();
        req.onsuccess = function () {
          var pre = dir + '#';
          resolve((req.result || []).filter(function (r) { return r.id.slice(0, pre.length) === pre; }));
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  function idbAllFileIds() {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('sessionFiles', 'readonly');
        var os = tx.objectStore('sessionFiles');
        var req = typeof os.getAllKeys === 'function' ? os.getAllKeys() : os.getAll();
        req.onsuccess = function () {
          var rows = req.result || [];
          resolve(rows.map(function (r) { return typeof r === 'string' ? r : r.id; }).filter(Boolean));
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  // 完整删除 primitive：metadata + BASE + FINAL + 全部 R* 在同一 IDB readwrite transaction 中删除。
  function idbDeleteSessionComplete(dir) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction([DB_STORE, 'sessionFiles'], 'readwrite');
        var meta = tx.objectStore(DB_STORE);
        var files = tx.objectStore('sessionFiles');
        var req = typeof files.getAllKeys === 'function' ? files.getAllKeys() : files.getAll();
        req.onsuccess = function () {
          var pre = dir + '#';
          (req.result || []).forEach(function (row) {
            var id = typeof row === 'string' ? row : row.id;
            var versionOwned = !!(row && typeof row === 'object' && row.kind === 'judge-session-version-v1' && row.sessionId === dir);
            if ((id && id.slice(0, pre.length) === pre) || versionOwned) files.delete(id);
          });
          meta.delete(dir);
        };
        req.onerror = function () { reject(req.error); };
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('history delete aborted')); };
      });
    });
  }
  function idbClearAllHistory() {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction([DB_STORE, 'sessionFiles'], 'readwrite');
        tx.objectStore(DB_STORE).clear();
        tx.objectStore('sessionFiles').clear();
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('history clear aborted')); };
      });
    });
  }
  function idbScanOrphans() {
    return Promise.all([idbAll(), idbAllFileIds()]).then(function (parts) {
      var rows = parts[1].map(function (id) { return { id: id }; });
      return historyGovernance.findOrphanFileRecords(rows, parts[0]);
    });
  }
  function idbCleanupOrphans(orphanRows) {
    var ids = (orphanRows || []).map(function (r) { return r && r.id; }).filter(Boolean);
    if (!ids.length) return Promise.resolve(0);
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('sessionFiles', 'readwrite');
        var os = tx.objectStore('sessionFiles');
        ids.forEach(function (id) { os.delete(id); });
        tx.oncomplete = function () { resolve(ids.length); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  function idbEstimateStoreBytes(storeName) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var total = 0;
        var tx = db.transaction(storeName, 'readonly');
        var os = tx.objectStore(storeName);
        if (typeof os.openCursor === 'function') {
          var req = os.openCursor();
          req.onsuccess = function () {
            var cur = req.result;
            if (!cur) return;
            var row = cur.value;
            if (storeName === 'sessionFiles' && row && Number(row.logicalBytes) >= 0) total += Number(row.logicalBytes) + String(row.id || '').length * 2;
            else total += historyGovernance.estimateValueBytes(row);
            cur.continue();
          };
          req.onerror = function () { reject(req.error); };
          tx.oncomplete = function () { resolve(total); };
          tx.onerror = function () { reject(tx.error); };
          return;
        }
        var all = os.getAll();
        all.onsuccess = function () {
          (all.result || []).forEach(function (row) {
            if (storeName === 'sessionFiles' && row && Number(row.logicalBytes) >= 0) total += Number(row.logicalBytes) + String(row.id || '').length * 2;
            else total += historyGovernance.estimateValueBytes(row);
          });
          resolve(total);
        };
        all.onerror = function () { reject(all.error); };
      });
    });
  }
  function idbEstimateHistoryBytes() {
    return Promise.all([idbEstimateStoreBytes(DB_STORE), idbEstimateStoreBytes('sessionFiles')]).then(function (n) { return n[0] + n[1]; });
  }
  // 清轮级记录（dir#R*）——终态后防冗余累积；BASE/FINAL 保留（FINAL 终态全量、BASE 基线，合并时被 FINAL 覆盖）
  // 修正（实施期）：原前缀 dir# 会误删刚写入的 FINAL/BASE（final 链 put FINAL → 自删 → sessionFiles 恒空）
  function idbClearRounds(dir) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('sessionFiles', 'readwrite');
        var os = tx.objectStore('sessionFiles');
        var req = os.getAll();
        req.onsuccess = function () {
          var rPre = dir + '#R';
          var victims = (req.result || []).filter(function (r) { return r.id.slice(0, rPre.length) === rPre; });
          victims.forEach(function (r) { os.delete(r.id); });
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(tx.error); };
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // ================= 工具 =================
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtBytes(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + 'MB' : n > 1024 ? (n / 1024).toFixed(1) + 'KB' : n + 'B'; }
  function estTokens(chars) { return Math.ceil(chars / 2.5); }
  function fmtTokenCount(n) {
    n = Math.max(0, Math.round(Number(n) || 0));
    return n >= 100000 ? (n / 1000).toFixed(0) + 'k' : n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  }

  // ================= DOM 骨架（五步场景流） =================
  var SCENE_IDS = ['gate', 'setup', 'upload', 'run', 'report'];
  var SCENE_MODES = { gate: 'ceremony', setup: 'work', upload: 'work', run: 'tribunal', report: 'reading' };
  var SCENE_QT = {
    gate: [TXT.top.questSteps[0], TXT.top.questNames[0], 1],
    setup: [TXT.top.questSteps[1], TXT.top.questNames[1], 2],
    upload: [TXT.top.questSteps[2], TXT.top.questNames[2], 3],
    run: [TXT.top.questSteps[3], TXT.top.questNames[3], 4],
    report: [TXT.top.questSteps[4], TXT.top.questNames[4], 5]
  };
  function showScene(name) {
    if (SCENE_IDS.indexOf(name) < 0) return;
    currentScene = name;
    document.body.dataset.scene = name;
    document.body.dataset.mode = SCENE_MODES[name] || 'work';
    for (var i = 0; i < SCENE_IDS.length; i++) {
      var el = $('scene-' + SCENE_IDS[i]);
      if (el) el.classList.toggle('hidden', SCENE_IDS[i] !== name);
    }
    // 任务追踪条（游戏 HUD：当前步骤 + 进度点）
    var qt = SCENE_QT[name];
    var qtStep = $('qt-step'), qtName = $('qt-name'), qtDots = $('qt-dots');
    if (qt && qtStep && qtName && qtDots) {
      qtStep.textContent = qt[0];
      qtName.textContent = qt[1];
      var dots = '';
      for (var d = 0; d < 5; d++) dots += '<i' + (d < qt[2] ? ' class="on"' : '') + '></i>';
      qtDots.innerHTML = dots;
    }
    if (name === 'upload') refreshUploadConfigSummary();
    window.scrollTo(0, 0);
  }
  function renderShell() {
    var root = $('app-root');
    root.innerHTML = '' +
      '<div class="hall-fx">' +
      '  <span class="hf-core"></span>' +
      '  <span class="hf-beam"></span>' +
      '  <span class="hf-floor"></span>' +
      '</div>' +
      '<div class="wrap">' +
      '  <header class="sanctum-rail">' +
      '    <div class="brand shell-brand"><div><h1>' + TXT.brand.title + '</h1><div class="ver">' + TXT.brand.ver + '</div></div></div>' +
      '    <div class="quest-tracker shell-stage" id="quest-tracker"><span class="qt-step" id="qt-step">' + TXT.top.questSteps[0] + '</span><span class="qt-name" id="qt-name">' + TXT.top.questNames[0] + '</span><span class="qt-dots" id="qt-dots"></span></div>' +
      '    <div class="topbtns shell-utilities">' +
      '      <button class="btn" id="btn-sessions">' + TXT.top.sessions + '</button>' +
      '      <button class="btn" id="btn-theme">' + TXT.top.themeDark + '</button>' +
      '      <button class="btn" id="btn-clear-cache">' + TXT.top.clearCache + '</button>' +
      '    </div>' +
      '  </header>' +
      '' +
      // ========== ① 圣堂之门（风险提示页） ==========
      '  <section class="scene scene-gate" id="scene-gate">' +
      '    <div class="gate-stage">' +
      '      <h1 class="scene-line" id="gate-line">' + TXT.gate.line + '</h1>' +
      '      <div class="gate-notes"><div class="gate-risk-list">' +
      '        <div class="gate-risk-item" data-risk="cost">' + TXT.gate.fee + '</div>' +
      '        <div class="gate-risk-item" data-risk="time">' + TXT.gate.time + '</div>' +
      '        <div class="gate-risk-item" data-risk="accuracy">' + TXT.gate.accuracy + '</div>' +
      '        <div class="gate-risk-item" data-risk="key">' + TXT.gate.key + '</div>' +
      '      </div></div>' +
      '      <div class="gate-btns">' +
      '        <button class="btn primary" id="btn-gate-enter">' + TXT.gate.enter + '</button>' +
      '        <button class="btn" id="btn-gate-leave">' + TXT.gate.leave + '</button>' +
      '      </div>' +
      '    </div>' +
      '    <div class="gate-left-note" id="gate-left-note" hidden>' +
      '      <div class="scene-line" style="font-size:17px">' + TXT.gate.leftNote + '</div>' +
      '      <div class="gate-btns"><button class="btn primary" id="btn-gate-reenter">' + TXT.gate.reenter + '</button></div>' +
      '    </div>' +
      '  </section>' +
      '' +
      // ========== ② 识海连接（设置页） ==========
      '  <section class="scene hidden" id="scene-setup">' +
      '    <div class="scene-head"><div class="scene-line">' + TXT.setup.line + '</div>' +
      '      <div class="scene-sub">' + TXT.setup.sub + '</div></div>' +
      '    <div class="docket-desk">' +
      '      <div class="docket-core">' +
      '        <div class="work-surface docket-core-surface">' +
      '          <div class="surface-title">' + TXT.setup.coreTitle + '</div>' +
      '    <div class="docket-connection-section docket-connection-credentials">' +
      '      <div class="docket-connection-kicker">' + TXT.setup.connectionCredentialsTitle + '</div>' +
      '    <div class="row">' +
      '      <div class="field"><label>' + TXT.setup.provider + '</label><select id="cfg-provider">' +
      '        <option value="deepseek">' + TXT.setup.providerDeepseek + '</option>' +
      '        <option value="glm">' + TXT.setup.providerGlm + '</option>' +
      '        <option value="kimi">' + TXT.setup.providerKimi + '</option>' +
      '        <option value="openai">' + TXT.setup.providerOpenai + '</option>' +
      '        <option value="custom">' + TXT.setup.providerCustom + '</option>' +
      '        <option value="mock">' + TXT.setup.providerMock + '</option>' +
      '      </select>' +
      '        <div class="hint">' + TXT.setup.providerHint + '</div></div>' +
      '      <div class="field"><label>' + TXT.setup.apiKey + '</label><input type="password" id="cfg-key" placeholder="sk-……"></div>' +
      '    </div>' +
      '    <div class="hint docket-connection-notice">' + TXT.setup.officialRisk + '</div>' +
      '    </div>' +
      '    <div class="docket-connection-section docket-connection-endpoint">' +
      '      <div class="docket-connection-kicker">' + TXT.setup.connectionEndpointTitle + '</div>' +
      '    <div class="row">' +
      '      <div class="field"><label>' + TXT.setup.baseUrl + '</label><input type="text" id="cfg-base" placeholder="https://api.deepseek.com"></div>' +
      '      <div class="field"><label>' + TXT.setup.model + '</label><input type="text" id="cfg-model" placeholder="deepseek-v4-flash">' +
      '        <div class="hint" id="provider-default-hint"></div>' +
      '        <button class="btn small" id="btn-query-models" type="button" style="margin-top:6px;display:none">' + TXT.setup.queryModels + '</button>' +
      '      </div>' +
      '      <div class="field"><label>' + TXT.setup.maxTokens + '</label><input type="number" id="cfg-max" min="4096" max="384000" step="1024" placeholder="384000"></div>' +
      '    </div>' +
      '    <div id="model-list-panel" style="display:none;margin:4px 0 12px;padding:10px;border:1px solid var(--line);border-radius:10px">' +
      '      <div style="display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap"><b id="model-list-title">' + TXT.setup.modelListTitle + '</b><input id="model-list-search" type="text" placeholder="' + TXT.setup.modelListSearch + '" style="max-width:280px"></div>' +
      '      <div id="model-list-status" class="hint" style="margin:7px 0"></div>' +
      '      <div id="model-list-items" style="display:grid;gap:7px;max-height:360px;overflow:auto"></div>' +
      '      <div class="hint" style="margin-top:8px">' + TXT.setup.modelListNote + '</div>' +
      '    </div>' +
      '    </div>' +
      '    <div class="docket-connection-section docket-connection-request">' +
      '      <div class="docket-connection-kicker">' + TXT.setup.connectionRequestTitle + '</div>' +
      '    <div class="row">' +
      '      <div class="field"><label>' + TXT.setup.thinking + '</label><select id="cfg-thinking">' +
      '        <option value="on">' + TXT.setup.thinkingOn + '</option>' +
      '        <option value="off">' + TXT.setup.thinkingOff + '</option>' +
      '        <option value="custom">' + TXT.setup.thinkingCustom + '</option>' +
      '      </select>' +
      '        <div class="hint">' + TXT.setup.thinkingHint + '</div></div>' +
      '    </div>' +
      '    <div class="hint docket-connection-cost">' + TXT.setup.costHint + '</div>' +
      '    <div class="row docket-api-test"><button class="btn small" id="btn-test-api">' + TXT.setup.testApi + '</button><span id="api-test-result" class="hint"></span></div>' +
      '    </div>' +
      '        </div>' +
      '        <div class="docket-tendency-overview"><div class="surface-subtitle">' + TXT.setup.tendencySummaryTitle + '</div>' +
      '          <div class="docket-summary" id="docket-tendency-summary"></div></div>' +
      '        <div class="docket-context-overview"><div class="surface-subtitle">' + TXT.setup.contextSummaryTitle + '</div>' +
      '          <div class="docket-summary" id="docket-context-summary"></div></div>' +
      '        <details class="docket-advanced docket-judge-advanced"><summary>' + TXT.setup.judgeAdvancedTitle + '</summary><div class="docket-advanced-body">' +
      '    <h4 style="font-size:13px;color:var(--brand);margin-bottom:6px">' + TXT.setup.tendH4a + '</h4>' +
      '    <div class="tend-note" style="margin-top:0">' + TXT.setup.tendNoteA + '</div>' +
      '    <div class="tend-grid" id="dim-grid"></div>' +
      '    <h4 style="font-size:13px;color:var(--brand);margin:12px 0 6px">' + TXT.setup.tendH4b + '</h4>' +
      '    <div class="tend-grid" id="tend-grid"></div>' +
      '    <div class="relative-bars" id="relative-bars"></div>' +
      '    <h4 style="font-size:13px;color:var(--brand);margin:12px 0 6px">' + TXT.setup.tendH4c + '</h4>' +
      '    <div id="derived-axes" class="tend-note" style="margin-top:0"></div>' +
      '    <div class="tend-note">' + TXT.setup.tendNoteB + '</div>' +
      '    <div class="axis-pairs">' + TXT.setup.axisPairs + '</div>' +
      '    <div class="tend-actions">' +
      '      <button class="btn small" id="btn-tend-reset">' + TXT.setup.tendReset + '</button>' +
      '      <button class="btn small" id="btn-tend-help">' + TXT.setup.tendHelp + '</button>' +
      '      <button class="btn small" id="btn-tend-profile-local">' + TXT.setup.tendProfileLocal + '</button>' +
      '      <button class="btn small" id="btn-tend-profile-file">' + TXT.setup.tendProfileFile + '</button>' +
      '      <input type="file" id="cfg-tend-profile" accept=".json,application/json" hidden>' +
      '    </div>' +
      '    <div class="judge-context-panel" style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line)">' +
      '      <h4 style="font-size:13px;color:var(--brand);margin:0 0 8px">' + TXT.ctx.title + '</h4>' +
      '      <label class="docket-run-option"><input type="checkbox" id="ctx-enabled">' + TXT.ctx.enable + '</label>' +
      '      <div class="row judge-context-fields">' +
      '        <div class="field"><label>' + TXT.ctx.useMode + '</label><select id="ctx-use-mode">' + contextOptions(judgeContextMod.USE_MODES, TXT.ctx.useModes) + '</select></div>' +
      '        <div class="field"><label>' + TXT.ctx.backgroundMode + '</label><select id="ctx-background-mode">' + contextOptions(judgeContextMod.BACKGROUND_MODES, TXT.ctx.backgroundModes) + '</select></div>' +
      '        <div class="field"><label>' + TXT.ctx.familiarity + '</label><select id="ctx-familiarity">' + contextOptions(judgeContextMod.FAMILIARITY, TXT.ctx.familiarityLabels) + '</select></div>' +
      '        <div class="field"><label>' + TXT.ctx.perspective + '</label><select id="ctx-perspective">' + contextOptions(judgeContextMod.PERSPECTIVES, TXT.ctx.perspectiveLabels) + '</select></div>' +
      '      </div>' +
      '      <div class="row judge-context-fields">' +
      '        <div class="field"><label>' + TXT.ctx.domains + '</label><select id="ctx-domains" multiple size="5">' + contextOptions(judgeContextMod.BACKGROUND_DOMAINS, TXT.ctx.domainLabels) + '</select></div>' +
      '        <div class="field"><label>' + TXT.ctx.values + '</label><select id="ctx-values" multiple size="5">' + contextOptions(judgeContextMod.VALUE_CONCERNS, TXT.ctx.valueLabels) + '</select></div>' +
      '      </div>' +
      '      <div class="field"><label>' + TXT.ctx.note + '</label><input type="text" id="ctx-note" maxlength="120" placeholder="' + TXT.ctx.notePlaceholder + '"></div>' +
      '      <div class="tend-note">' + TXT.ctx.guard + '</div>' +
      '    </div>' +
      '        </div></details>' +
      '      </div>' +
      '      <aside class="docket-side">' +
      '        <div class="work-surface"><div class="docket-output-reading">' +
      '          <div class="surface-title">' + TXT.setup.outputTitle + '</div>' +
      '          <div class="hint docket-side-hint">' + TXT.setup.depthHint + '</div>' +
      '          <div class="docket-checks">' +
      '            <label><input type="checkbox" id="opt-plain">' + TXT.setup.optPlain + '</label>' +
      '            <label><input type="checkbox" id="opt-reader-guide">' + TXT.setup.optReaderGuide + '</label>' +
      '          </div>' +
      '          <div class="docket-depth-grid">' +
      '            <div class="field"><label>' + TXT.setup.depthVerdict + '</label><select id="depth-verdict">' +
      '              <option value="简明">' + TXT.setup.depthVerdictBrief + '</option><option value="标准" selected>' + TXT.setup.depthVerdictStd + '</option><option value="详细">' + TXT.setup.depthVerdictDetail + '</option></select></div>' +
      '            <div class="field"><label>' + TXT.setup.depthMainline + '</label><select id="depth-mainline">' +
      '              <option value="简述类型">' + TXT.setup.depthMainlineBrief + '</option><option value="标准全景图" selected>' + TXT.setup.depthMainlineStd + '</option><option value="逐环节追踪">' + TXT.setup.depthMainlineDetail + '</option></select></div>' +
      '            <div class="field"><label>' + TXT.setup.depthClash + '</label><select id="depth-clash">' +
      '              <option value="仅关键2-3个">' + TXT.setup.depthClashBrief + '</option><option value="标准5-8个" selected>' + TXT.setup.depthClashStd + '</option><option value="逐回合全部">' + TXT.setup.depthClashDetail + '</option></select></div>' +
      '          </div>' +
      '          <details class="docket-advanced docket-output-advanced"><summary>' + TXT.setup.outputAdvancedTitle + '</summary><div class="docket-advanced-body">' +
      '            <div class="field docket-dict"><label>' + TXT.setup.plainDictLabel + '</label>' +
      '              <div class="docket-file-control"><input type="file" id="cfg-plain-dict" accept=".json,application/json"><button class="btn small" id="btn-plain-dict-clear">' + TXT.setup.plainDictClear + '</button></div>' +
      '              <div class="hint" id="plain-dict-status">' + TXT.setup.plainDictNone + '</div>' +
      '              <div class="hint">' + TXT.setup.plainDictHint + '</div></div>' +
      '          </div></details>' +
      '          <details class="docket-advanced docket-transport-advanced" id="transport-advanced"><summary>' + TXT.setup.transportAdvancedTitle + '</summary><div class="docket-advanced-body">' +
      '            <div class="hint docket-transport-hint">仅在自定义 Provider 或自定义思考参数时需要配置；使用官方 Provider 的常规开/关思考模式时无需设置。</div>' +
      '            <div class="hint" id="custom-api-risk" style="display:none;color:var(--red)">' + TXT.setup.customRisk + '</div>' +
      '            <div class="field" id="thinking-json-field" style="display:none;min-width:100%"><label>' + TXT.setup.thinkingJsonLabel + '</label>' +
      '              <textarea id="cfg-thinking-json" style="min-height:90px;font-family:Consolas,monospace;font-size:12px" placeholder=\'{"thinking":{"type":"enabled"},"thinking_budget":4096}\'></textarea>' +
      '              <div class="hint">' + TXT.setup.thinkingJsonHint + '</div></div>' +
      '          </div></details>' +
      '          <label class="docket-run-option"><input type="checkbox" id="opt-skip-roster">' + TXT.setup.optSkipRoster + '</label>' +
      '          <button class="btn primary docket-next" id="btn-next-setup">' + TXT.setup.nextSetup + '</button>' +
      '        </div></div>' +
      '      </aside>' +
      '    </div>' +
      '    <div class="scene-nav scene-nav-secondary">' +
      '      <button class="btn" id="btn-back-setup">' + TXT.setup.backGate + '</button>' +
      '    </div>' +
      '  </section>' +
      '' +
      // ========== ③ 呈现诉求（上传页） ==========
      '  <section class="scene hidden" id="scene-upload">' +
      '    <div class="scene-head"><div class="scene-line">' + TXT.upload.line + '</div>' +
      '      <div class="scene-sub">' + TXT.upload.sub + '</div></div>' +
      '    <div class="submission-desk">' +
      '      <div class="submission-main">' +
      '        <div class="work-surface submission-editor">' +
      '          <div class="surface-title">' + TXT.upload.cardTitle + '</div>' +
      '          <div class="upload-zone" id="upload-zone">' +
      '            <div class="icon">📜</div>' +
      '            <div class="text">' + TXT.upload.dropText + '</div>' +
      '            <div class="hint">' + TXT.upload.dropHint + '</div>' +
      '          </div>' +
      '          <input type="file" id="file-input" style="display:none" multiple>' +
      '          <div class="field submission-transcript"><label>' + TXT.upload.pasteLabel + '</label>' +
      '            <textarea id="transcript" placeholder="' + TXT.upload.pastePlaceholder + '"></textarea></div>' +
      '          <div class="warn" id="token-warn">' + TXT.upload.tokenWarn + '</div>' +
      '        </div>' +
      '      </div>' +
      '      <aside class="submission-side">' +
      '        <div class="work-surface submission-meta">' +
      '          <div class="surface-title">' + TXT.upload.filesTitle + '</div>' +
      '          <div class="submission-file-list" id="upload-file-list">' + TXT.upload.noFiles + '</div>' +
      '          <div class="file-info" id="file-info"></div>' +
      '          <div class="surface-subtitle">' + TXT.upload.configTitle + '</div>' +
      '          <div class="submission-config" id="upload-config-summary"></div>' +
      '          <button class="btn primary submission-run" id="btn-run">' + TXT.upload.run + '</button>' +
      '        </div>' +
      '      </aside>' +
      '    </div>' +
      '    <div class="scene-nav scene-nav-secondary">' +
      '      <button class="btn" id="btn-back-upload">' + TXT.upload.backSetup + '</button>' +
      '      <button class="btn" id="btn-clear">' + TXT.upload.clear + '</button>' +
      '    </div>' +
      '  </section>' +
      '' +
      // ========== ④ 裁决进行（运行页） ==========
      '  <section class="scene hidden" id="scene-run">' +
      '    <div class="scene-head"><div class="scene-line">' + TXT.run.line + '</div>' +
      '      <div class="scene-sub">' + TXT.run.sub + '</div>' +
      '      <div class="run-close-warning" id="run-close-warning">' + TXT.run.closeWarning + '</div></div>' +
      '    <div class="tribunal-layout">' +
      '      <section class="work-surface tribunal-timeline" aria-label="轮次时间线">' +
      '        <div class="surface-title">裁决与后处理 Timeline</div>' +
      '        <div class="timeline" id="timeline"></div>' +
      '      </section>' +
      '      <section class="work-surface tribunal-current" id="run-current-status" aria-live="polite">' +
      '        <div class="surface-title">Current Status · 当前裁决</div>' +
      '        <div class="tribunal-current-round" id="run-current-round">—</div>' +
      '        <div class="run-status-line" id="run-status"></div>' +
      '        <div class="tribunal-actions">' +
      '          <button class="btn primary" id="btn-resume-run" style="display:none">' + TXT.run.resumeStart + '</button>' +
      '          <button class="btn danger" id="btn-stop" disabled>' + TXT.run.stop + '</button>' +
      '          <button class="btn" id="btn-return-report" type="button" style="display:none">' + TXT.run.returnReport + '</button>' +
      '          <button class="btn" id="btn-back-run">' + TXT.run.backRun + '</button>' +
      '        </div>' +
      '        <div class="tribunal-evidence">' +
      '          <div class="surface-subtitle">Log / Evidence</div>' +
      '          <div class="logbox" id="logbox"></div>' +
      '        </div>' +
      '      </section>' +
      '      <aside class="work-surface tribunal-telemetry" id="run-telemetry" aria-label="运行遥测">' +
      '        <div class="surface-title">Telemetry</div>' +
      '        <div class="progress-note tribunal-telemetry-list"><span id="pn-live"></span><span id="pn-rounds"></span><span id="pn-retries"></span><span id="pn-anchor"></span></div>' +
      '      </aside>' +
      '    </div>' +
      '  </section>' +
      '' +
      // ========== ⑤ 判决书 / Codex（报告页） ==========
      '  <section class="scene hidden" id="scene-report">' +
      '    <div class="scene-head"><div class="scene-line">' + TXT.report.line + '</div>' +
      '      <div class="scene-sub">' + TXT.report.sub + '</div></div>' +
      '    <div class="report-codex">' +
      '      <div class="report-toolbar" id="report-toolbar" role="toolbar" aria-label="报告工具栏">' +
      '        <button class="btn small" id="report-plain-toggle" type="button" aria-pressed="false">原文 / 白话</button>' +
      '        <button class="btn small" id="report-sections-toggle" type="button" aria-expanded="true">章节</button>' +
      '        <button class="btn small" id="report-theme-toggle" type="button">主题</button>' +
      '        <details class="report-export" id="report-export-menu"><summary class="btn small">导出</summary><div class="report-export-popover">' +
      '          <button class="btn small primary" id="btn-export-html">' + TXT.report.exportHtml + '</button>' +
      '          <button class="btn small" id="btn-export-md">' + TXT.report.exportMd + '</button>' +
      '          <button class="btn small" id="btn-copy">' + TXT.report.copy + '</button>' +
      '          <button class="btn small" id="btn-export-session">' + TXT.report.exportSession + '</button>' +
      '        </div></details>' +
      '        <button class="btn small" id="report-history" type="button">历史</button>' +
      '        <button class="btn small" id="btn-report-run-log" type="button" style="display:none">审判日志</button>' +
      '        <button class="btn small" id="btn-import-report">' + TXT.report.importHtml + '</button>' +
      '        <button class="btn small" id="btn-back-report">' + TXT.report.backRun + '</button>' +
      '        <span class="report-trust-status" id="report-trust-status" aria-live="polite"></span>' +
      '      </div>' +
      '      <div class="report-layout">' +
      '        <aside class="report-outline" id="report-outline" aria-label="报告章节导航"><div class="surface-title">章节 / R8 <span id="report-reading-progress" class="report-reading-progress">0%</span></div><div id="report-outline-list"></div></aside>' +
      '        <main class="report-document">' +
      '          <section class="report-verdict-cover" id="report-verdict-cover" aria-live="polite"></section>' +
      '          <div class="report-reader" id="report-reader"><iframe id="report-frame" class="report-frame" style="height:600px" title="裁判报告正文"></iframe></div>' +
      '        </main>' +
      '      </div>' +
      '    </div>' +
      '  </section>' +
      '' +
      '  <div class="footnote">' + TXT.report.footnote + '</div>' +
      '</div>';
  }

  function contextOptions(values, labels) {
    return values.map(function (v) { return '<option value="' + esc(v) + '">' + esc(labels[v] || v) + '</option>'; }).join('');
  }

  // ================= 裁判倾向（三维 + 六向度） =================
  var TEND_DIMS = tendencyMod.DIMENSIONS;          // 六向度
  var TEND_DIM_KEYS = tendencyMod.DIM_KEYS;        // 三维
  function clampIntRange(v, min, max) {
    return Math.min(max, Math.max(min, Math.round(v)));
  }
  function renderTendency() {
    renderSliderGrid($('dim-grid'), TEND_DIM_KEYS,
      function (k) { return settings.dimWeights[k] || 0; },
      0,
      function (k, v) { settings.dimWeights[k] = v; });
    renderTempAxis($('dim-grid'));    // 第四轴：温度（与三维并列）
    renderSliderGrid($('tend-grid'), TEND_DIMS,
      function (d) { return settings.tendencyWeights[d]; },
      50,
      function (d, v) { settings.tendencyWeights[d] = v; });
    refreshTendency();
  }
  // 温度轴：滑杆 0–100 ↔ 实际温度 0.00–1.00（settings.temperature 为浮点）
  function renderTempAxis(container) {
    var row = document.createElement('div');
    row.className = 'tend-row tend-row-temp';
    var axisVal = Math.round((settings.temperature || 0.3) * 100);
    row.innerHTML = '<span class="tname">' + TXT.tend.randomAxis + '</span>' +
      '<input type="range" class="trange" min="0" max="100" step="1" value="' + axisVal + '">' +
      '<input type="number" class="tval-in" min="0" max="100" step="1" value="' + axisVal + '" inputmode="numeric">' +
      '<span class="tdev"></span>';
    var range = row.querySelector('.trange');
    var num = row.querySelector('.tval-in');
    function apply(v) {
      var n = clampIntRange(v, 0, 100);
      settings.temperature = Math.round(n) / 100;
      range.value = n;
      num.value = n;
      saveSettings();
      refreshTendency();
    }
    range.addEventListener('input', function () { apply(parseInt(this.value, 10)); });
    range.addEventListener('dblclick', function (e) { e.preventDefault(); apply(30); });
    num.addEventListener('input', function () {
      var v = parseInt(this.value, 10);
      if (!isFinite(v)) return;
      apply(v);
    });
    num.addEventListener('blur', function () {
      var v = parseInt(this.value, 10);
      if (!isFinite(v)) { this.value = Math.round((settings.temperature || 0.3) * 100); }
      else this.value = clampIntRange(v, 0, 100);
    });
    container.appendChild(row);
  }
  // 通用滑杆行：滑杆 + 可编辑数字框（输入即时生效，无需回车）+ 双击滑杆恢复默认
  function renderSliderGrid(el, keys, getVal, defaultVal, onSet) {
    el.innerHTML = '';
    for (var i = 0; i < keys.length; i++) {
      (function (k) {
        var row = document.createElement('div');
        row.className = 'tend-row';
        row.innerHTML = '<span class="tname">' + k + '</span>' +
          '<input type="range" class="trange" min="0" max="100" step="1" value="' + getVal(k) + '">' +
          '<input type="number" class="tval-in" min="0" max="100" step="1" value="' + getVal(k) + '" inputmode="numeric">' +
          '<span class="tdev"></span>';
        var range = row.querySelector('.trange');
        var num = row.querySelector('.tval-in');
        function apply(v) {
          var n = clampIntRange(v, 0, 100);
          onSet(k, n);
          range.value = n;
          num.value = n;
          saveSettings();
          refreshTendency();
        }
        range.addEventListener('input', function () { apply(parseInt(this.value, 10)); });
        range.addEventListener('dblclick', function (e) { e.preventDefault(); apply(defaultVal); });
        num.addEventListener('input', function () {
          var v = parseInt(this.value, 10);
          if (!isFinite(v)) return;   // 输入中（空/半角输入）暂不生效，失焦归整
          apply(v);                    // 即时生效（自动钳制 0-100）
        });
        num.addEventListener('blur', function () {
          var v = parseInt(this.value, 10);
          if (!isFinite(v)) { this.value = getVal(k); }   // 空/非法 → 还原为当前生效值
          else this.value = clampIntRange(v, 0, 100);     // 归整显示
        });
        el.appendChild(row);
      })(keys[i]);
    }
  }
  function refreshTendency() {
    // 三维标签：0 = 中立（自动），其余 = 看重程度
    var dRows = document.querySelectorAll('#dim-grid .tend-row');
    for (var i = 0; i < TEND_DIM_KEYS.length; i++) {
      var k = TEND_DIM_KEYS[i];
      var dv = settings.dimWeights[k] || 0;
      if (dRows[i]) dRows[i].querySelector('.tdev').textContent = dv === 0 ? TXT.tend.dimAuto : tendencyMod.valueLabel(dv);
    }
    // 随机性轴标签（第四轴）
    var tempRow = document.querySelector('#dim-grid .tend-row-temp');
    if (tempRow) tempRow.querySelector('.tdev').textContent = TXT.tend.tempDefault;
    // 六向度标签：单向看重程度
    var rows = document.querySelectorAll('#tend-grid .tend-row');
    for (var j = 0; j < TEND_DIMS.length; j++) {
      var d = TEND_DIMS[j];
      if (rows[j]) rows[j].querySelector('.tdev').textContent = tendencyMod.valueLabel(settings.tendencyWeights[d]);
    }
    // 维内倾向派生
    var derived = tendencyMod.deriveAllAxes(settings.tendencyWeights);
    var dHtml = '';
    for (var a = 0; a < derived.length; a++) {
      var ax = derived[a];
      var pair = tendencyMod.AXES[a];
      var strong = ax.side
        ? '<b style="color:var(--blue)">' + TXT.tend.derivedPrefix + ax.side.name + '</b>（' + ax.side.tag + '）'
        : '<span style="color:var(--dim)">' + TXT.tend.neutral + '</span>';
      dHtml += '<div>' + pair.key + '：' + pair.pair[0] + ' ' + settings.tendencyWeights[pair.pair[0]] + ' vs ' +
        pair.pair[1] + ' ' + settings.tendencyWeights[pair.pair[1]] + ' → ' + strong + '</div>';
    }
    $('derived-axes').innerHTML = dHtml;
    // 相对权重条（六向度）
    var w = tendencyMod.normalizeVectorWeights(settings.tendencyWeights);
    var auto = tendencyMod.isAuto(settings.dimWeights, settings.tendencyWeights);
    var total = 0;
    for (var t = 0; t < TEND_DIMS.length; t++) total += w[TEND_DIMS[t]];
    var bars = $('relative-bars');
    var html = '<h4>' + (auto ? TXT.tend.autoPreview : TXT.tend.relativePreview) + '</h4>';
    for (var b = 0; b < TEND_DIMS.length; b++) {
      var dd = TEND_DIMS[b];
      var pct = total > 0 ? Math.round(w[dd] / total * 1000) / 10 : 0;
      html += '<div class="rb-row"><span class="rb-name">' + dd + '</span>' +
        '<div class="rb-track"><div class="rb-fill" style="width:' + Math.min(100, pct * 0.97) + '%"></div></div>' +
        '<span class="rb-pct">' + pct + '%</span></div>';
    }
    bars.innerHTML = html;
    var docketSummary = $('docket-tendency-summary');
    if (docketSummary) docketSummary.textContent = tendencySummaryText();
  }
  function tendencySummaryText() {
    var auto = tendencyMod.isAuto(settings.dimWeights, settings.tendencyWeights);
    var temp = Number(settings.temperature == null ? 0.3 : settings.temperature).toFixed(2);
    if (auto) return '内容驱动（自动） · 随机性 ' + temp;
    var dims = TEND_DIM_KEYS.map(function (k) { return k + ' ' + (settings.dimWeights[k] || 0); }).join(' / ');
    var vectorAdjusted = TEND_DIMS.some(function (d) { return Number(settings.tendencyWeights[d]) !== 50; });
    return '三维：' + dims + ' · 六向度：' + (vectorAdjusted ? '已调整' : '中立') + ' · 随机性 ' + temp;
  }
  function contextSummaryText() {
    return judgeContextMod.contextSummary(settings.judgeContext);
  }
  function selectedValues(id) {
    var el = $(id);
    if (!el) return [];
    return Array.prototype.filter.call(el.options, function (o) { return o.selected; }).map(function (o) { return o.value; });
  }
  function setSelectedValues(id, values) {
    var el = $(id), set = {};
    (values || []).forEach(function (v) { set[v] = true; });
    if (!el) return;
    Array.prototype.forEach.call(el.options, function (o) { o.selected = !!set[o.value]; });
  }
  function updateJudgeContextEnabledState() {
    var enabled = !!($('ctx-enabled') && $('ctx-enabled').checked);
    ['ctx-use-mode','ctx-background-mode','ctx-familiarity','ctx-perspective','ctx-domains','ctx-values','ctx-note'].forEach(function (id) {
      var el = $(id); if (el) el.disabled = !enabled;
    });
  }
  function refreshJudgeContextSummary() {
    var el = $('docket-context-summary');
    if (el) el.textContent = contextSummaryText();
  }
  function syncJudgeContextToForm() {
    var c;
    try { c = judgeContextMod.normalizeJudgeContext(settings.judgeContext); }
    catch (e) { c = judgeContextMod.normalizeJudgeContext(null); settings.judgeContext = c; }
    $('ctx-enabled').checked = !!c.enabled;
    $('ctx-use-mode').value = c.useMode;
    $('ctx-background-mode').value = c.background.mode;
    $('ctx-familiarity').value = c.background.familiarity;
    $('ctx-perspective').value = c.perspective;
    $('ctx-note').value = c.note || '';
    setSelectedValues('ctx-domains', c.background.domains);
    setSelectedValues('ctx-values', c.valueConcerns);
    updateJudgeContextEnabledState();
    refreshJudgeContextSummary();
  }
  function commitJudgeContextFromForm(showError) {
    try {
      var raw = {
        kind: 'debate-judge-context-v1', version: 1,
        enabled: !!$('ctx-enabled').checked,
        useMode: $('ctx-use-mode').value,
        background: { mode: $('ctx-background-mode').value, domains: selectedValues('ctx-domains'), familiarity: $('ctx-familiarity').value },
        valueConcerns: selectedValues('ctx-values'),
        perspective: $('ctx-perspective').value,
        note: $('ctx-note').value || ''
      };
      settings.judgeContext = judgeContextMod.normalizeJudgeContext(raw);
      saveSettings();
      refreshJudgeContextSummary();
      return true;
    } catch (e) {
      if (showError) alert(TXT.ctx.invalid + e.message);
      return false;
    }
  }
  function tendencyProfileLabel(profile) {
    var bits = [];
    if (profile.code) bits.push(profile.code);
    if (profile.generatedAt) {
      var d = new Date(profile.generatedAt);
      bits.push(isNaN(d.getTime()) ? profile.generatedAt : d.toLocaleString());
    }
    return bits.length ? '（' + bits.join(' · ') + '）' : '';
  }
  function applyTendencyProfilePayload(payload) {
    var profile;
    try { profile = tendencyMod.normalizeTendencyProfile(payload); }
    catch (e) { alert(TXT.setup.tendProfileInvalid + e.message); return false; }
    var confirmTail = profile.dimWeights ? TXT.setup.tendProfileConfirmV2Tail : TXT.setup.tendProfileConfirmV1Tail;
    if (!confirm(TXT.setup.tendProfileConfirmPre + tendencyProfileLabel(profile) + confirmTail)) return false;
    var next = {};
    for (var i = 0; i < TEND_DIMS.length; i++) next[TEND_DIMS[i]] = profile.vectorWeights[TEND_DIMS[i]];
    settings.tendencyWeights = next;
    if (profile.dimWeights) {
      settings.dimWeights = {};
      for (var d = 0; d < TEND_DIM_KEYS.length; d++) settings.dimWeights[TEND_DIM_KEYS[d]] = profile.dimWeights[TEND_DIM_KEYS[d]];
    }
    saveSettings();
    renderTendency();
    alert(profile.dimWeights ? TXT.setup.tendProfileAppliedV2 : TXT.setup.tendProfileAppliedV1);
    return true;
  }
  function applyLocalTendencyProfile() {
    var raw = null;
    try { raw = localStorage.getItem(TENDENCY_PROFILE_V2_LS_KEY) || localStorage.getItem(TENDENCY_PROFILE_LS_KEY); } catch (e) {}
    if (!raw) { alert(TXT.setup.tendProfileNone); return; }
    try { applyTendencyProfilePayload(JSON.parse(raw)); }
    catch (e) { alert(TXT.setup.tendProfileInvalid + e.message); }
  }

  // ================= 轮次时间线 / 日志 =================
  // W-RS（260814）：轮次表单一事实源收敛——惰性派生自 core.ROUNDS（内核权威），
  // 回退数组仅 core 模块不可用/加载异常时兜底（与 REGISTRY 缺省回退同构；回退态观察登记 TODO.md）
  var POSTPROCESS_STEPS = ['R7', 'R8'];
  var ROUND_LABELS = {
    R1: '架构提取', R2: '交锋追迹', 'R2.5': '修辞合成', R3: '终判合成', R4: '结构归约', 'R4.5': '裁决仲裁',
    R5A: '前半叙事', R5B: '后半叙事', R6a: '结构图表', R6b: '报告组装', R7: '白话报告', R8: '章节导览'
  };
  function roundLabel(round) { return ROUND_LABELS[round] || round; }
  function isPostprocessStage(round) { return POSTPROCESS_STEPS.indexOf(round) >= 0; }
  var ROUND_STEPS = null;
  function roundSteps() {
    if (ROUND_STEPS) return ROUND_STEPS;
    var names = null;
    try {
      var core = BUNDLE.modules.core ? BUNDLE.modules.core() : null;
      if (core && Array.isArray(core.ROUNDS) && core.ROUNDS.length) {
        names = core.ROUNDS.map(function (r) { return r.name; });
      }
    } catch (e) {}
    ROUND_STEPS = (names || ['R1', 'R2', 'R2.5', 'R3', 'R4', 'R4.5', 'R5A', 'R5B', 'R6a', 'R6b']).concat(POSTPROCESS_STEPS);
    return ROUND_STEPS;
  }
  var roundState = {};
  var retryCount = 0;
  var anchorLabel = '';
  // 活性指示状态（SSE 进度遥测）
  var liveProgress = null;
  var liveLastAt = 0;
  var runTimer = null;
  var runStartAt = 0;
  var runEstimatedTokensCommitted = 0;
  var sessionEstimatedTokensBase = 0;
  function fmtMMSS(ms) {
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    return String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  function liveEstimatedTokens(p) {
    if (!p) return { content: 0, reasoning: 0, total: 0 };
    var content = estTokens(Number(p.chars) || 0);
    var reasoning = estTokens(Number(p.reasonChars) || 0);
    return { content: content, reasoning: reasoning, total: content + reasoning };
  }
  function commitLiveEstimate() {
    if (!liveProgress || liveProgress.estimateCommitted) return;
    runEstimatedTokensCommitted += liveEstimatedTokens(liveProgress).total;
    liveProgress.estimateCommitted = true;
  }
  function currentRunEstimatedTokens() {
    var pending = (!liveProgress || liveProgress.estimateCommitted) ? 0 : liveEstimatedTokens(liveProgress).total;
    return runEstimatedTokensCommitted + pending;
  }
  function currentSessionEstimatedTokens() {
    return sessionEstimatedTokensBase + currentRunEstimatedTokens();
  }
  function estimateRecordedSessionTokens(workDir) {
    if (!flightRecorder || !workDir) return Promise.resolve(0);
    return flightRecorder.listRuns().then(function (runs) {
      var matched = (runs || []).filter(function (r) { return r && r.workDir === workDir; });
      return Promise.all(matched.map(function (r) { return flightRecorder.listRequests(r.id); })).then(function (groups) {
        var total = 0;
        groups.forEach(function (reqs) {
          (reqs || []).forEach(function (req) {
            total += estTokens(Number(req && req.contentChars || 0));
            total += estTokens(Number(req && req.reasoningChars || 0));
          });
        });
        return total;
      });
    }).catch(function () { return 0; });
  }
  function telemetryLine(text) {
    return String(text || '').replace(/^\s*·\s*/, '').trim();
  }
  function updateLiveIndicator() {
    if (!running) return;
    var el = $('pn-live');
    if (!el) return;
    var now = Date.now();
    var lines = [TXT.run.liveElapsed + fmtMMSS(now - runStartAt)];
    if (liveProgress) {
      lines.push(telemetryLine(TXT.run.liveChars + liveProgress.chars + TXT.run.liveCharsTail));
      if (liveProgress.reasonChars > 0) lines.push(telemetryLine(TXT.run.liveReason + liveProgress.reasonChars + TXT.run.liveCharsTail));
      var tok = liveEstimatedTokens(liveProgress);
      var runTok = currentRunEstimatedTokens();
      var sessionTok = sessionEstimatedTokensBase + runTok;
      lines.push(telemetryLine(TXT.run.liveTokenHead + fmtTokenCount(tok.content) + TXT.run.liveTokenReason + fmtTokenCount(tok.reasoning) + TXT.run.liveTokenCurrent + fmtTokenCount(tok.total) + TXT.run.liveTokenTail));
      lines.push(telemetryLine(TXT.run.liveTokenRun + fmtTokenCount(runTok) + TXT.run.liveTokenTail));
      lines.push(telemetryLine(TXT.run.liveTokenSession + fmtTokenCount(sessionTok) + TXT.run.liveTokenTail));
      el.dataset.contentChars = String(Number(liveProgress.chars) || 0);
      el.dataset.reasoningChars = String(Number(liveProgress.reasonChars) || 0);
      el.dataset.estimatedContentTokens = String(tok.content);
      el.dataset.estimatedReasoningTokens = String(tok.reasoning);
      el.dataset.estimatedCurrentTokens = String(tok.total);
      el.dataset.estimatedRunTokens = String(runTok);
      el.dataset.estimatedSessionTokens = String(sessionTok);
      var idle = now - liveLastAt;
      if (liveProgress.final) lines.push(telemetryLine(TXT.run.liveFinal));
      else lines.push(telemetryLine(TXT.run.liveIdle + Math.round(idle / 1000) + TXT.run.liveIdleTail));
      if (idle > 120000) lines.push(TXT.run.liveStuck.trim());
    } else {
      lines.push(telemetryLine(TXT.run.liveWaiting));
      var idleRunTok = currentRunEstimatedTokens();
      var idleSessionTok = sessionEstimatedTokensBase + idleRunTok;
      if (idleRunTok > 0 || sessionEstimatedTokensBase > 0) {
        lines.push(telemetryLine(TXT.run.liveTokenRun + fmtTokenCount(idleRunTok) + TXT.run.liveTokenTail));
        lines.push(telemetryLine(TXT.run.liveTokenSession + fmtTokenCount(idleSessionTok) + TXT.run.liveTokenTail));
      }
      el.dataset.contentChars = '0';
      el.dataset.reasoningChars = '0';
      el.dataset.estimatedContentTokens = '0';
      el.dataset.estimatedReasoningTokens = '0';
      el.dataset.estimatedCurrentTokens = '0';
      el.dataset.estimatedRunTokens = String(idleRunTok);
      el.dataset.estimatedSessionTokens = String(idleSessionTok);
    }
    el.textContent = lines.filter(Boolean).join('\n');
  }
  function renderTimeline(active) {
    var el = $('timeline');
    if (!el) return;
    el.innerHTML = '';
    var steps = roundSteps();
    for (var i = 0; i < steps.length; i++) {
      var r = steps[i];
      var st = roundState[r] || 'pending';   // pending|active|done|fail|skipped
      var cls = 'tl-node';
      if (st === 'done' || st === 'skipped') cls += ' ' + st;
      if (st === 'active') cls += ' active';
      if (st === 'fail') cls += ' fail';
      var label = st === 'skipped' ? TXT.run.tlSkipped : st === 'done' ? TXT.run.tlDone : st === 'fail' ? TXT.run.tlFail : st === 'active' ? TXT.run.tlActive : TXT.run.tlPending;
      el.innerHTML += '<div class="' + cls + '" id="tl-' + r + '"><span class="tl-dot"></span><span class="tl-name"><span class="tl-code">' + r + '</span><span class="tl-desc">' + esc(roundLabel(r)) + '</span></span><span class="tl-status">' + label + '</span></div>'; 
    }
    updateProgressNote();
  }
  function updateProgressNote() {
    $('pn-rounds').textContent = TXT.run.pnRounds + Object.keys(roundState).filter(function (r) { return roundState[r] === 'done' || roundState[r] === 'skipped'; }).length + TXT.run.pnRoundsSep + roundSteps().length;
    $('pn-retries').textContent = TXT.run.pnRetries + retryCount + TXT.run.pnRetriesUnit;
    $('pn-anchor').textContent = anchorLabel;
  }
  function setRunCloseWarningActive(active) {
    var el = $('run-close-warning');
    if (!el) return;
    var on = !!active;
    el.classList.toggle('is-active', on);
    el.dataset.active = on ? 'true' : 'false';
    el.setAttribute('aria-live', on ? 'polite' : 'off');
  }
  function classifyLogSeverity(text) {
    var s = String(text == null ? '' : text);
    // 终态先于可恢复态：若同一行明确写了预算耗尽/管道终止，就必须是 error。
    if (/预算耗尽|管道失败|后处理失败|最终失败|终态失败|BLOCKING|\bError\b|✗/.test(s)) return 'error';
    // attempt/retry/纠错/候选拒绝均属于执行器仍会自动继续的过程事件。
    if (/attempt\s*\d+\s*失败|重试\s*\d+(?:\s*\/\s*\d+)?|纠错\s*\d+(?:\s*\/\s*\d+)?|候选(?:门禁)?(?:被)?拒绝|candidate[^\n]{0,40}reject/i.test(s)) return 'warning';
    if (/警告|WARNING|warn/i.test(s)) return 'warning';
    // 未被识别为可恢复事件的错误/失败继续保持红色，避免吞掉真实异常。
    if (/错误|失败/.test(s)) return 'error';
    return 'neutral';
  }
  function logLine(text) {
    var box = $('logbox');
    if (!box) return;
    var line = document.createElement('div');
    line.textContent = text;
    var severity = classifyLogSeverity(text);
    if (severity === 'error') line.className = 'l-error';
    else if (severity === 'warning') line.className = 'l-warn';
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
    if (box.childNodes.length > 800) box.removeChild(box.firstChild);
  }
  function setTribunalCurrentRound(round, note) {
    var el = $('run-current-round');
    if (!el) return;
    if (!round) { el.textContent = note || '—'; return; }
    el.textContent = round + ' · ' + roundLabel(round) + (note ? ' · ' + note : '');
    if (!roundState[round] || roundState[round] === 'pending') roundState[round] = 'active';
    renderTimeline(round);
  }
  function activateNextTribunalRound(completedRound) {
    var steps = roundSteps();
    var idx = steps.indexOf(completedRound);
    var next = idx + 1;
    while (next >= 0 && next < steps.length && roundState[steps[next]] === 'skipped') next++;
    if (next >= 0 && next < steps.length) {
      var stage = steps[next];
      setTribunalCurrentRound(stage, isPostprocessStage(stage) ? '待处理' : '待裁决');
    } else setTribunalCurrentRound(null, '裁决与后处理已完成');
  }
  function markRound(round, status) {
    roundState[round] = status;
    renderTimeline(round);
  }

  // ================= 名册确认 =================
  function showRosterModal(anchor, workDir, resolve) {
    var ov = document.createElement('div');
    ov.className = 'overlay';
    var sideHtml = function (side, team) {
      var rows = anchor.roster.filter(function (r) { return r.side === side; })
        .map(function (r) { return '<li>' + esc(r.role) + '　' + esc(r.name || TXT.roster.roleLabel) + '</li>'; }).join('');
      return '<div class="roster-side"><h4>' + esc(side) + '　' + esc(team || '') + '</h4><ul>' + (rows || '<li>' + TXT.roster.emptySide + '</li>') + '</ul></div>';
    };
    ov.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="roster-modal-title">' +
      '<h2 id="roster-modal-title">' + TXT.roster.title + '</h2>' +
      '<div class="msub">' + TXT.roster.topic + esc(anchor.title || TXT.roster.unknown) + TXT.roster.integrity + esc(anchor.integrity || '') + '</div>' +
      ((anchor.typeA || anchor.typeB) ? '<div class="roster-alert">' + TXT.roster.alert + (anchor.typeA ? TXT.roster.typeA : '') + (anchor.typeB ? TXT.roster.typeB : '') + TXT.roster.alertTail + '</div>' : '') +
      '<div class="roster-grid">' + sideHtml('正方', anchor.proTeam) + sideHtml('反方', anchor.conTeam) + '</div>' +
      '<div class="msub">' + TXT.roster.bench + (anchor.bench && anchor.bench.length ? anchor.bench.map(function (b) { return esc(b.name); }).join('、') : TXT.roster.none) +
      TXT.roster.otherSpeakers + (anchor.other_speakers && anchor.other_speakers.length ? anchor.other_speakers.map(function (o) { return esc(o.name) + '（' + esc(o.category) + '）'; }).join('、') : TXT.roster.none) + '</div>' +
      (anchor.warnings && anchor.warnings.length ? '<div class="msub" style="color:var(--gold)">' + TXT.roster.warn + esc(anchor.warnings.join('；')) + '</div>' : '') +
      '<div class="modal-btns">' +
      '<button class="btn" id="roster-edit">' + TXT.roster.edit + '</button>' +
      '<button class="btn" id="roster-abort">' + TXT.roster.abort + '</button>' +
      '<button class="btn primary" id="roster-confirm">' + TXT.roster.confirm + '</button>' +
      '</div>' +
      '<div id="roster-edit-area" style="display:none;margin-top:10px"><textarea id="roster-json" style="min-height:200px;font-family:Consolas,monospace;font-size:12px">' + esc(JSON.stringify(anchor, null, 2)) + '</textarea>' +
      '<div class="modal-btns"><button class="btn" id="roster-edit-cancel">' + TXT.roster.cancel + '</button><button class="btn primary" id="roster-edit-apply">' + TXT.roster.apply + '</button></div></div>' +
      '</div>';
    document.body.appendChild(ov);
    registerTransientLayer(ov, function () { removeTransientLayer(ov); resolve({ action: 'abort' }); });
    $('roster-confirm').onclick = function () { removeTransientLayer(ov); resolve({ action: 'confirm' }); };
    $('roster-abort').onclick = function () { removeTransientLayer(ov); resolve({ action: 'abort' }); };
    $('roster-edit').onclick = function () { $('roster-edit-area').style.display = 'block'; };
    $('roster-edit-cancel').onclick = function () { $('roster-edit-area').style.display = 'none'; };
    $('roster-edit-apply').onclick = function () {
      try {
        var edited = JSON.parse($('roster-json').value);
        removeTransientLayer(ov);
        resolve({ action: 'edit', editedAnchor: edited });
      } catch (e) {
        alert(TXT.roster.jsonInvalid + e.message);
      }
    };
  }

  // ================= 会话持久化 =================
  // W-T5（U1）：rec.run 单写者——patch.runModel 存在才写 rec.run（仅终态/中断时点经 persist 钩子传入，R3-1）；
  // 带 patch 时 rec.status 直映 runModel.summary.derivedStatus（D11/R18-1 迁移同款：done/failed/aborted/interrupted；
  // 顺带修复现状「门禁耗尽失败/中止后 rec.status 残留 running」）；'pending' 为防御保留值不写（rec.status 值域无此项）。
  // C5（260815）：files 写入策略 = 基线 + 轮级增量 + 终态全量——
  //  - pipeline-start：写 BASE（起始基线）
  //  - round-done：与内存基线 diff（vfs.snapshot 浅拷贝 → === 引用比较）→ 仅写变更到 dir#R{n}
  //  - pipeline-done/error：写 FINAL 全量 + 清 dir#R* 轮级记录（防冗余累积）
  // 顺序不变式（A9）：先完成 filesOp 计算（diff/快照/基线更新）→ 再 idbPut(rec)（reportReady 已定稿）→ 再文件写——
  // IDB 结构化克隆在 put 调用时即发生，rec 必须在 put 前定稿
  var persistFileBase = null;
  function snapshotDiffFromBase(workDir, base) {
    var cur = engine.snapshotSession(workDir, ['/input']);
    var changed = {};
    if (base) {
      for (var k in cur) if (cur[k] !== base[k]) changed[k] = cur[k];               // 新增或内容变更（引用比较）
      for (var k2 in base) if (!(k2 in cur)) changed[k2] = null;                    // 删除标记
    } else {
      changed = cur;
    }
    return { current: cur, changed: changed };
  }
  function makeSessionFileRecord(id, files) {
    return { id: id, files: files, logicalBytes: historyGovernance.estimateValueBytes(files) };
  }
  function persistSession(workDir, patch) {
    if (!engine) return Promise.resolve(false);
    patch = patch || {};
    var rec = {
      id: workDir,
      dir: workDir,
      title: currentSession && currentSession.title ? currentSession.title : workDir.split('/').pop(),
      createdAt: currentSession && currentSession.createdAt ? currentSession.createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: running ? 'running' : 'done',
      settings: JSON.parse(JSON.stringify(settings)),
      reportReady: false,
      estimatedTokensTotal: currentSessionEstimatedTokens()
    };
    if (patch.runModel && patch.runModel.summary && typeof patch.runModel.summary.derivedStatus === 'string') {
      var ds = patch.runModel.summary.derivedStatus;
      if (ds === 'done' || ds === 'failed' || ds === 'aborted' || ds === 'interrupted' || ds === 'running') {
        rec.run = patch.runModel;
        rec.status = ds;
      }
    }
    var fileRecord = null;
    var clearRoundDir = null;
    var nextBase = null;
    if (patch.filesOp === 'base') {
      nextBase = engine.snapshotSession(workDir, ['/input']);                       // 仅事务成功后提交为内存基线
      rec.reportReady = !!(nextBase[workDir + '/report.html']);
      fileRecord = makeSessionFileRecord(workDir + '#BASE', nextBase);
    } else if (patch.filesOp === 'round') {
      var diff = snapshotDiffFromBase(workDir, persistFileBase);
      nextBase = diff.current;
      rec.reportReady = !!(nextBase[workDir + '/report.html']);
      if (Object.keys(diff.changed).length) fileRecord = makeSessionFileRecord(workDir + '#R' + patch.roundName, diff.changed);
    } else if (patch.filesOp === 'plain-batch') {
      // W-T1：只持久化 host 已安全写入 VFS 的目标 PLAIN batch cache；缺失必须 fail-close，不能伪装 checkpoint 成功。
      var batchIndex = Number(patch.batchIndex);
      if (!isFinite(batchIndex) || batchIndex < 0 || Math.floor(batchIndex) !== batchIndex) {
        console.warn('[judge-web] PLAIN checkpoint index 无效:', patch.batchIndex);
        return Promise.resolve(false);
      }
      var batchName = '.tmp-plain-batch-' + batchIndex + '.json';
      var batchPath = workDir + '/' + batchName;
      var batchSnapshot = engine.snapshotSession(workDir);
      if (!(batchPath in batchSnapshot)) {
        console.warn('[judge-web] PLAIN checkpoint cache 缺失:', batchPath);
        return Promise.resolve(false);
      }
      rec.reportReady = !!(batchSnapshot[workDir + '/report.html']);
      var batchFiles = {};
      batchFiles[batchPath] = batchSnapshot[batchPath];
      var batchRecordId = workDir + '#RZZPLAIN-' + String(batchIndex).padStart(4, '0');
      fileRecord = makeSessionFileRecord(batchRecordId, batchFiles);
    } else if (patch.filesOp === 'plain-state') {
      // PLAIN v4：review / repair-draft / approved 都会改写“整份语义状态”，且没有 batch index。
      // 用固定覆盖记录同时保存 review proof + 当前全部 live batch cache：
      // - review：保存 interim proof；
      // - repair-draft：保存被定点修复后改写的 batch cache；
      // - approved：保存 approved proof + reviewProofHash 已绑定的全部 batch cache。
      // 固定 id 会覆盖上一状态，避免每轮 reviewer/repair 复制堆积；排序晚于 #RZZPLAIN-0000…，恢复时自然覆盖早期 draft。
      var plainStateSnapshot = engine.snapshotSession(workDir);
      var plainReviewPath = workDir + '/.tmp-plain-review.json';
      if (!(plainReviewPath in plainStateSnapshot)) {
        console.warn('[judge-web] PLAIN v4 state checkpoint 缺少 review proof:', plainReviewPath, patch.phase || '');
        return Promise.resolve(false);
      }
      var plainStateFiles = {};
      plainStateFiles[plainReviewPath] = plainStateSnapshot[plainReviewPath];
      var plainPrefix = workDir + '/';
      var plainBatchCount = 0;
      for (var plainKey in plainStateSnapshot) {
        if (plainKey.slice(0, plainPrefix.length) !== plainPrefix) continue;
        var plainName = plainKey.slice(plainPrefix.length);
        if (/^\.tmp-plain-batch-\d+\.json$/.test(plainName)) {
          plainStateFiles[plainKey] = plainStateSnapshot[plainKey];
          plainBatchCount++;
        }
      }
      if (!plainBatchCount) {
        console.warn('[judge-web] PLAIN v4 state checkpoint 没有 live batch cache:', workDir, patch.phase || '');
        return Promise.resolve(false);
      }
      rec.reportReady = !!(plainStateSnapshot[workDir + '/report.html']);
      fileRecord = makeSessionFileRecord(workDir + '#RZZPLAINSTATE', plainStateFiles);
    } else if (patch.filesOp === 'r8-checkpoint') {
      // W-T1/R8：把当前三件私有 R8 状态作为一个整体覆盖记录持久化；缺失项写 null 墓碑，
      // 防止 guide draft → core cache → plain draft 演进时旧私有文件在恢复合并后被“复活”。
      var r8Snapshot = engine.snapshotSession(workDir);
      var r8Names = ['.tmp-reader-guide-draft.json', '.tmp-reader-guide-cache.json', '.tmp-reader-guide-plain-draft.json'];
      var r8Files = {};
      for (var r8i = 0; r8i < r8Names.length; r8i++) {
        var r8Path = workDir + '/' + r8Names[r8i];
        r8Files[r8Path] = (r8Path in r8Snapshot) ? r8Snapshot[r8Path] : null;
      }
      rec.reportReady = !!(r8Snapshot[workDir + '/report.html']);
      fileRecord = makeSessionFileRecord(workDir + '#RZZR8', r8Files);
    } else if (patch.filesOp === 'final') {
      nextBase = engine.snapshotSession(workDir, ['/input']);
      rec.reportReady = !!(nextBase[workDir + '/report.html']);
      fileRecord = makeSessionFileRecord(workDir + '#FINAL', nextBase);
      clearRoundDir = workDir;                                                       // 与 FINAL put 同一事务清普通/PLAIN #R* 增量；BASE/FINAL 不匹配该前缀
    }
    var commitPromise = (patch.filesOp === 'base' && patch.resumeEpoch)
      ? idbCommitResumeEpoch(rec, nextBase, workDir)
      : idbCommitSessionCheckpoint(rec, fileRecord, clearRoundDir);
    return commitPromise.then(function () {
      if (nextBase) persistFileBase = nextBase;                                     // Memory follows disk：仅 oncomplete 后推进
      return true;
    }).catch(function (e) {
      console.warn('[judge-web] 会话持久化失败:', e);
      return false;
    });
  }
  function enforceHistoryLimit(protectedDir) {
    var limit = historyGovernance.normalizeRetentionLimit(historyPolicy.maxSessions);
    var protectedIds = {};
    if (protectedDir) protectedIds[protectedDir] = true;
    return idbAll().then(function (list) {
      var victims = historyGovernance.selectEvictionVictims(list, limit, protectedIds);
      var p = Promise.resolve();
      victims.forEach(function (s) {
        p = p.then(function () {
          return idbDeleteSessionComplete(s.id).then(function () {
            if (engine) engine.removeSession(s.dir || s.id);
          });
        });
      });
      return p.then(function () {
        return { before: list.length, deleted: victims.length, target: limit, remaining: list.length - victims.length };
      });
    }).catch(function (e) {
      console.warn('[judge-web] 历史保留治理失败:', e);
      return { before: 0, deleted: 0, target: limit, remaining: 0, error: String(e && e.message || e) };
    });
  }
  function scheduleHistoryLimit(protectedDir) {
    setTimeout(function () {
      enforceHistoryLimit(protectedDir).then(function () {
        if (historyOverlay && historyOverlay.parentNode) refreshHistoryManager();
      });
    }, 0);
  }
  function estimateFlightRecorderLogicalBytes() {
    if (!flightRecorder) return Promise.resolve(0);
    return flightRecorder.listRuns().then(function (runs) {
      var total = historyGovernance.estimateValueBytes(runs || []);
      return Promise.all((runs || []).map(function (run) {
        return flightRecorder.listRequests(run.id).then(function (reqs) {
          (reqs || []).forEach(function (r) {
            total += historyGovernance.estimateValueBytes(r);
            total += Number(r && r.rawBytes || 0);
          });
        });
      })).then(function () { return total; });
    }).catch(function () { return 0; });
  }
  // C5：读侧合并——BASE + R1..Rn 按 id 序覆盖合并；'#FINAL' 强制置末（'#FINAL' 字符串序 < '#R*'，不置末会被轮级记录覆盖，
  // 孤儿窗口残留 R 记录将陈旧覆盖 FINAL）；null 值 = 删除标记（round diff 用）。
  // 词序限制登记：现轮名 R1..R6b 字符串序 = 时序（'R2'<'R2.5'<'R6a'<'R6b'）；'R10'<'R2' 理论不触发，防 R10
  function mergeFileRecords(items) {
    var merged = {};
    var seq = items.slice().sort(function (a, b) {
      var fa = a.id.slice(-6) === '#FINAL', fb = b.id.slice(-6) === '#FINAL';
      if (fa !== fb) return fa ? 1 : -1;                 // FINAL 恒置末
      return a.id < b.id ? -1 : 1;
    });
    for (var i = 0; i < seq.length; i++) {
      for (var k in seq[i].files) { if (seq[i].files[k] === null) delete merged[k]; else merged[k] = seq[i].files[k]; }
    }
    return merged;
  }
  async function getSessionFiles(dir) {
    var items = await idbAllFiles(dir);
    if (!items.length) {
      var rec = await idbGet(dir);
      if (rec && rec.files) {   // v1 惰性迁移：回退 + 回写 FINAL + rec.files 清空（写失败回退原值）
        try {
          var rec2 = JSON.parse(JSON.stringify(rec));
          delete rec2.files;
          await idbPutFile(dir + '#FINAL', rec.files);
          await idbPut(rec2);
        } catch (e) {}
        return rec.files;
      }
      return null;
    }
    return mergeFileRecords(items);
  }
  // 历史“重新出报告”专用只读路径：不得借读取动作触发 v1 → v2 惰性迁移，
  // 更不得写 FINAL/R*。v2 只合并现有 sessionFiles；v1 直接返回旧 rec.files。
  async function getSessionFilesReadOnly(dir) {
    var items = await idbAllFiles(dir);
    if (items.length) return mergeFileRecords(items);
    var rec = await idbGet(dir);
    return rec && rec.files ? rec.files : null;
  }
  // ================= W-T5：run 徽章 / 断点预览 / 迁移（UI 投影层消费侧） =================
  // 徽章状态词与 si-meta 状态词语义不同，须独立键（R17-1）；未知值透传原文
  var SESSION_STATUS_WORDS = {
    done: TXT.sess.statusDone,
    running: TXT.sess.statusRunning,
    failed: TXT.sess.statusFailed,
    aborted: TXT.sess.statusAborted,
    interrupted: TXT.sess.statusInterrupted
  };
  function statusWord(st) {
    return SESSION_STATUS_WORDS[st] || String(st == null ? '' : st);
  }
  var BADGE_STATUS_WORDS = { done: TXT.sess.stDone, skipped: TXT.sess.stSkipped, fail: TXT.sess.stFail, pending: TXT.sess.stPending };
  // 徽章行 HTML（R11-3：全字段 null 防御 + try/catch 失败返回 '' 隐藏徽章行——forEach 内抛错会拖垮整个列表渲染）
  function buildBadgesHtml(runModel) {
    try {
      if (!runModel) return '';
      var items = [];
      if (runModel.rounds && runModel.rounds.length) {
        items = runModel.rounds;   // 数据源选择规则（R2-4）：rounds 优先
      } else if (runModel.events && runModel.events.length) {
        // R16-4 防御分支：events-only（理论不可达——rec.run 只在终态写）；按 events 推导该轮状态
        var steps = roundSteps();
        for (var i = 0; i < steps.length; i++) {
          var name = steps[i];
          var st = 'pending';
          for (var j = 0; j < runModel.events.length; j++) {
            var ev = runModel.events[j];
            if (ev && ev.round === name) st = ev.skipped ? 'skipped' : ev.ok ? 'done' : st;
          }
          items.push({ round: name, status: st });
        }
      } else {
        return '';
      }
      var html = '';
      for (var k = 0; k < items.length; k++) {
        var it = items[k];
        var rn = it.round || '';
        var st2 = it.status || 'pending';
        if (['done', 'skipped', 'fail', 'pending'].indexOf(st2) < 0) st2 = 'pending';
        var title = '「' + rn + ' · ' + (BADGE_STATUS_WORDS[st2] || st2) + '」';
        // R2-1：attempts!=null 才显示重试（中止轮留档数 ≠ 实尝试数）；attemptFiles/gateHit 仅导出字段不展示
        if (it.attempts !== null && it.attempts !== undefined) title += ' · ' + TXT.sess.retries + it.attempts;
        // R11-3：promptHash=null（旧会话 prompt 缺失）时省略 prompt 段，禁止 slice 空值
        if (it.promptHash) title += ' · ' + TXT.sess.promptHash + ' ' + String(it.promptHash).slice(0, 8);
        // W-PH：失配轮（产物基于旧版 prompt）→ title 追加提示 + st-stale 类
        var staleCls = '';
        var staleByRound = runModel.staleRounds || {};
        if (staleByRound[rn]) { title += TXT.sess.staleBadge; staleCls = ' st-stale'; }
        html += '<span class="si-badge st-' + st2 + staleCls + '" title="' + esc(title) + '"></span>';
      }
      return '<div class="si-badges">' + html + '</div>';
    } catch (e) { return ''; }
  }
  // 断点预览行（U4）：'running' 为防御分支（R16-2：persist 时点规则表无产出，实际不可达）；
  // interrupted 走正常预览（R16-1 降级后 rounds 有意义——中止轮产物未过门禁 → 不计入 → 「无跳过」= 续跑从该轮重跑，语义正确）
  function buildPreviewHtml(runModel) {
    try {
      if (!runModel || !runModel.summary) return '';
      if (runModel.summary.derivedStatus === 'running') return '<div class="si-preview">' + TXT.sess.previewRunning + '</div>';
      var n = runModel.summary.precheckSkipCount || 0;
      var html;
      if (n > 0) {
        var names = [];
        for (var i = 0; i < (runModel.rounds || []).length; i++) {
          var r = runModel.rounds[i];
          if ((r.status === 'pending' || r.status === 'fail') && r.precheckSkippable) names.push(r.round);
        }
        // R11-5：N≤3 列全部轮名；N>3 列前 3 + 「等 N 轮」（动态数字代码拼接，TXT 键不内嵌数值 R9-2）
        var shown = names.slice(0, 3).join('、');
        var tail = names.length > 3 ? TXT.sess.previewSkipListPre + names.length + TXT.sess.previewSkipListTail : TXT.sess.previewSkipListTail;
        html = TXT.sess.previewSkip + shown + tail;
      } else {
        html = TXT.sess.previewNone;
      }
      // W-PH：失配汇总提示（独立 span 附加于既有内容尾部，空格衔接——A3）
      var staleCount = runModel.summary.staleCount || 0;
      if (staleCount > 0) {
        html += '<span class="si-stale-hint">' + TXT.sess.staleHintPre + staleCount + TXT.sess.staleHintTail + '</span>';
      }
      return '<div class="si-preview">' + html + '</div>';
    } catch (e) { return ''; }
  }
  // C6（260815）：迁移显式化——惰性迁移从渲染期副作用（refreshSessionList 内 idbPut 回写）移到显式时点：
  // migrateAll() 在 boot 调用（initEngine 后、refreshSessionList 前，await 链）；导入会话在导入路径显式迁移；
  // refreshSessionList 渲染只读（无 run 会话只读派生，不写库）。R3-3 防渲染循环守卫随迁移移除而不再需要。
  // v2 会话 files 在 sessionFiles store——s.files（v1）缺失时经 getSessionFiles 合并（async 化）；
  // 语义：无 rec.run 的旧/导入会话 → files 推导 runModel（纯函数）+ 回写 s.run + s.status（R18-1 与 D11 同款直映）
  async function migrateSession(s) {
    try {
      if (!engine) initEngine();
      var files = s.files || (await getSessionFiles(s.dir)) || {};
      var plain = !!(s.settings && s.settings.plain) || !!files[s.dir + '/report-plain.html'];   // R13-1：plain 推断
      var runModel = engine.buildRunModelFromFiles(s.dir, files, { plain: plain });
      // derivedStatus 派生（F8 时点规则近似）：running → interrupted；done → reportReady? done : failed；其余值直通
      var derived;
      if (s.status === 'running') derived = 'interrupted';
      else if (s.status === 'done') derived = runModel.summary.reportReady ? 'done' : 'failed';
      else derived = s.status;
      runModel.summary.derivedStatus = derived;
      s.run = runModel;
      s.status = derived;
      await idbPut(s).catch(function () {});   // A2：await 串行确定性（原 fire-and-forget）
    } catch (e) {}
  }
  // C6：boot 一次性迁移全部无 run 会话（逐会话 try/catch 不阻断 boot；失败 console.warn 有信号，A5）
  async function migrateAll() {
    try {
      if (!engine) initEngine();
      var list = await idbAll();
      for (var i = 0; i < list.length; i++) {
        if (!list[i].run) {
          try { await migrateSession(list[i]); }
          catch (e) { console.warn('[judge-web] 会话迁移失败:', e); }
        }
      }
    } catch (e) { console.warn('[judge-web] 会话迁移失败:', e); }
  }
  function closeHistoryManager() {
    if (historyOverlay) removeTransientLayer(historyOverlay);
    historyOverlay = null;
  }
  function showHistoryManager(initialTab) {
    if (running) return;
    initialTab = initialTab || 'records';
    if (historyOverlay && historyOverlay.parentNode) {
      if (typeof historyOverlay._selectArchiveTab === 'function') historyOverlay._selectArchiveTab(initialTab);
      else refreshHistoryManager();
      return;
    }
    var ov = document.createElement('div');
    ov.className = 'overlay';
    ov.id = 'history-overlay';
    ov.innerHTML = '<div class="modal archive-shell" role="dialog" aria-modal="true" aria-labelledby="history-modal-title">' +
      '<div class="archive-shell-head"><div><h2 id="history-modal-title">' + TXT.sess.historyTitle + '</h2>' +
      '<div class="msub">' + TXT.sess.historyIntro + '</div></div>' +
      '<button class="archive-close" id="archive-close" type="button" aria-label="关闭档案馆">×</button></div>' +
      '<div class="archive-tabs" role="tablist" aria-label="档案馆视图">' +
      '  <button class="archive-tab active" id="archive-tab-records" type="button" role="tab" aria-selected="true" aria-controls="archive-records-panel">裁决记录</button>' +
      '  <button class="archive-tab" id="archive-tab-flight" type="button" role="tab" aria-selected="false" aria-controls="archive-flight-panel">飞行记录</button>' +
      '  <button class="archive-tab" id="archive-tab-storage" type="button" role="tab" aria-selected="false" aria-controls="archive-storage-panel">存储与治理</button>' +
      '</div>' +
      '<section class="archive-panel" id="archive-records-panel" role="tabpanel" aria-labelledby="archive-tab-records">' +
      '  <div class="archive-records-head"><div class="archive-records-title"><b>Judge 正式分析历史</b><span class="hint" id="history-count"></span></div>' +
      '    <div class="archive-records-tools"><input id="history-search" type="search" placeholder="筛选标题 / 状态 / 时间" aria-label="筛选历史会话"><button class="btn small" id="btn-history-import">' + TXT.setup.importSession + '</button></div></div>' +
      '  <div class="archive-records-grid">' +
      '    <div class="session-list" id="session-list"><div class="hint">' + TXT.sess.empty + '</div></div>' +
      '    <aside class="archive-detail" id="archive-detail-panel"><div class="surface-title">记录与动作</div><div class="hint">选择左侧记录查看详情与操作。</div></aside>' +
      '  </div>' +
      '</section>' +
      '<section class="archive-panel archive-flight-panel diagnostics-surface" id="archive-flight-panel" role="tabpanel" aria-labelledby="archive-tab-flight" hidden>' +
      '  <div class="archive-flight-head"><div><b>' + TXT.flight.title + '</b><div class="hint">' + TXT.flight.intro + '</div></div><button class="btn small" id="btn-flight-refresh" type="button">刷新</button></div>' +
      '  <div class="hint archive-hint" style="color:var(--gold)">' + TXT.flight.privacy + '</div>' +
      '  <div class="hint archive-hint">' + TXT.flight.partial + '</div>' +
      '  <div class="archive-flight-export"><div class="archive-flight-export-head"><b>选择历史会话</b><button class="btn small" id="fr-select-all" type="button">全选</button></div><div id="fr-session-select" class="archive-flight-session-select"><span class="hint">正在读取历史会话…</span></div><div class="archive-flight-export-actions"><button class="btn small primary" id="fr-export-all" type="button" disabled>导出所有运行记录</button><span class="hint" id="fr-export-status"></span></div></div>' +
      '  <div class="archive-flight-controls"><span class="hint" id="fr-storage">' + TXT.flight.storage + '…</span><button class="btn small" id="fr-persist">' + TXT.flight.persist + '</button><button class="btn small" id="fr-clear">' + TXT.flight.clear + '</button></div>' +
      '  <div id="fr-warning" class="hint" style="color:var(--red);margin-bottom:8px"></div>' +
      '  <div id="fr-list"><div class="hint">进入本页后将刷新飞行记录。</div></div>' +
      '</section>' +
      '<section class="archive-panel" id="archive-storage-panel" role="tabpanel" aria-labelledby="archive-tab-storage" hidden>' +
      '  <div class="archive-governance-block">' +
      '    <b>' + TXT.sess.retentionTitle + '</b>' +
      '    <div class="hint archive-hint">' + TXT.sess.retentionHint + '</div>' +
      '    <div class="archive-retention-row">' +
      '      <input id="history-limit-range" type="range" min="1" max="100" step="1" value="' + historyPolicy.maxSessions + '">' +
      '      <input id="history-limit-number" type="number" min="1" max="100" step="1" value="' + historyPolicy.maxSessions + '">' +
      '      <button class="btn small" id="btn-history-limit">' + TXT.sess.retentionApply + '</button>' +
      '      <span class="hint" id="history-limit-status"></span>' +
      '    </div>' +
      '  </div>' +
      '  <div class="archive-governance-block">' +
      '    <b>' + TXT.sess.storageTitle + '</b>' +
      '    <div class="archive-storage-grid">' +
      '      <div class="archive-metric"><b>' + TXT.sess.browserStorage + '</b><span id="history-storage-browser">…</span></div>' +
      '      <div class="archive-metric"><b>' + TXT.sess.judgeStorage + '</b><span id="history-storage-judge">…</span></div>' +
      '      <div class="archive-metric"><b>' + TXT.sess.recorderStorage + '</b><span id="history-storage-recorder">…</span></div>' +
      '      <div class="archive-metric"><b>' + TXT.sess.orphanStorage + '</b><span id="history-storage-orphans">…</span></div>' +
      '    </div>' +
      '    <div class="archive-governance-actions">' +
      '      <button class="btn small" id="btn-history-orphans">' + TXT.sess.orphanScan + '</button>' +
      '      <button class="btn small" id="btn-history-recorder">' + TXT.sess.manageRecorder + '</button>' +
      '      <button class="btn small danger" id="btn-history-clear">' + TXT.sess.clearJudge + '</button>' +
      '    </div>' +
      '  </div>' +
      '</section>' +
      '<div class="modal-btns"><button class="btn primary" id="btn-history-close">' + TXT.sess.closeHistory + '</button></div>' +
      '</div>';
    document.body.appendChild(ov);
    historyOverlay = ov;
    registerTransientLayer(ov, closeHistoryManager);
    function selectArchiveTab(name) {
      if (['records', 'flight', 'storage'].indexOf(name) < 0) name = 'records';
      ['records', 'flight', 'storage'].forEach(function (tabName) {
        var active = name === tabName;
        var tab = $('archive-tab-' + tabName);
        var panel = $('archive-' + tabName + '-panel');
        if (tab) { tab.classList.toggle('active', active); tab.setAttribute('aria-selected', active ? 'true' : 'false'); }
        if (panel) panel.hidden = !active;
      });
      historyOverlay._activeArchiveTab = name;
      if (name === 'flight') { renderFlightSessionSelector(); refreshArchiveFlight(); }
      else if (name === 'storage') refreshHistoryManager();
      else refreshSessionList();
    }
    historyOverlay._selectArchiveTab = selectArchiveTab;
    $('archive-tab-records').onclick = function () { selectArchiveTab('records'); };
    $('archive-tab-flight').onclick = function () { selectArchiveTab('flight'); };
    $('archive-tab-storage').onclick = function () { selectArchiveTab('storage'); };
    var historySearch = $('history-search');
    if (historySearch) {
      historySearch.value = archiveSearchQuery;
      historySearch.oninput = function () {
        archiveSearchQuery = String(historySearch.value || '').trim().toLowerCase();
        refreshSessionList();
      };
    }
    var range = $('history-limit-range'), number = $('history-limit-number');
    range.oninput = function () { number.value = range.value; };
    number.oninput = function () { range.value = historyGovernance.normalizeRetentionLimit(number.value); };
    $('archive-close').onclick = closeHistoryManager;
    $('btn-history-close').onclick = closeHistoryManager;
    $('btn-history-import').onclick = importSessionFromFile;
    $('btn-history-recorder').onclick = function () { selectArchiveTab('flight'); };
    $('btn-flight-refresh').onclick = function () { refreshArchiveFlight(); };
    $('fr-select-all').onclick = function () {
      var boxes = historyOverlay ? historyOverlay.querySelectorAll('#fr-session-select input[type=checkbox]') : [];
      Array.prototype.forEach.call(boxes, function (box) { box.checked = true; archiveFlightSelectedSessionIds[box.value] = true; });
      updateFlightExportSelectionState();
    };
    $('fr-export-all').onclick = exportSelectedFlightRecords;
    $('fr-persist').onclick = function () {
      if (!flightRecorder) return;
      flightRecorder.requestPersistence().then(function (ok) { alert(ok ? TXT.flight.persistGranted : TXT.flight.persistDenied); });
    };
    $('fr-clear').onclick = function () {
      if (!flightRecorder || !confirm(TXT.flight.clearConfirm)) return;
      flightRecorder.clearAll().then(function () { refreshArchiveFlight(); });
    };
    $('btn-history-limit').onclick = function () {
      var next = historyGovernance.normalizeRetentionLimit(number.value);
      idbAll().then(function (list) {
        var victims = historyGovernance.selectEvictionVictims(list, next, {});
        if (victims.length && !confirm(TXT.sess.retentionConfirmPre + list.length + TXT.sess.retentionConfirmMid + victims.length + TXT.sess.retentionConfirmTail)) return;
        historyPolicy.maxSessions = next;
        saveHistoryPolicy();
        range.value = number.value = next;
        return enforceHistoryLimit().then(function (r) {
          $('history-limit-status').textContent = (r.remaining > r.target) ? TXT.sess.retentionProtected : '';
          refreshHistoryManager();
        });
      }).catch(function (e) { $('history-limit-status').textContent = String(e && e.message || e); });
    };
    $('btn-history-orphans').onclick = function () {
      idbScanOrphans().then(function (orphans) {
        if (!orphans.length) { alert(TXT.sess.orphanNone); return; }
        if (!confirm(TXT.sess.orphanConfirmPre + orphans.length + TXT.sess.orphanConfirmTail)) return;
        return idbCleanupOrphans(orphans).then(function (n) { alert(TXT.sess.orphanDone + n); refreshHistoryManager(); });
      }).catch(function (e) { alert(String(e && e.message || e)); });
    };
    $('btn-history-clear').onclick = function () {
      if (!confirm(TXT.sess.clearJudgeConfirm)) return;
      idbAll().then(function (list) {
        return idbClearAllHistory().then(function () {
          if (engine) list.forEach(function (s) { engine.removeSession(s.dir || s.id); });
          currentSession = null;
          refreshHistoryManager();
        });
      }).catch(function (e) { alert(String(e && e.message || e)); });
    };
    selectArchiveTab(initialTab);
    refreshHistoryManager();
  }
  function refreshHistoryManager() {
    if (!historyOverlay || !historyOverlay.parentNode) return;
    refreshSessionList();
    var browserP = flightRecorder ? flightRecorder.estimateStorage() :
      ((navigator.storage && navigator.storage.estimate) ? navigator.storage.estimate().catch(function () { return null; }) : Promise.resolve(null));
    Promise.all([idbEstimateHistoryBytes(), estimateFlightRecorderLogicalBytes(), idbScanOrphans(), browserP, idbAll()]).then(function (parts) {
      if (!historyOverlay || !historyOverlay.parentNode) return;
      $('history-storage-judge').textContent = fmtBytes(parts[0]);
      $('history-storage-recorder').textContent = fmtBytes(parts[1]);
      $('history-storage-orphans').textContent = parts[2].length + ' 条';
      var est = parts[3];
      $('history-storage-browser').textContent = est && est.quota != null ? (fmtBytes(est.usage || 0) + ' / ' + fmtBytes(est.quota)) : TXT.sess.storageUnknown;
      $('history-count').textContent = TXT.sess.countPre + parts[4].length + TXT.sess.countSep + historyPolicy.maxSessions + TXT.sess.countTail + (archiveSearchQuery ? ' · 显示 ' + archiveVisibleCount : '');
    }).catch(function () {});
  }
  function exportSessionRunMeta(s) {
    try {
      if (!engine) initEngine();
      var dumpMeta = function (run) {
        exportFile(TXT.sess.metaFile + tsName() + '.json', JSON.stringify({
          kind: 'judge-web-run-v1',
          session: { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, status: s.status },
          run: run
        }, null, 2), 'application/json', { kind: 'run-meta' });
      };
      if (s.run) { dumpMeta(s.run); return; }
      getSessionFiles(s.dir).then(function (files) { dumpMeta(engine.buildRunModelFromFiles(s.dir, files || {})); }).catch(function () {});
    } catch (e) {}
  }
  function versionReportHtml(version) {
    var files = version && version.files && typeof version.files === 'object' ? version.files : {};
    var direct = version && version.sessionId ? String(version.sessionId).replace(/\/+$/, '') + '/report.html' : '';
    if (direct && files[direct] != null) return String(files[direct]);
    var keys = Object.keys(files);
    for (var i = 0; i < keys.length; i++) if (/\/report\.html$/.test(keys[i]) && files[keys[i]] != null) return String(files[keys[i]]);
    return null;
  }
  function exportSessionVersion(version, displayIndex) {
    if (!version) return;
    var payload = {
      kind: 'judge-web-session-version-v1', versionId: version.versionId, sessionId: version.sessionId,
      createdAt: version.createdAt, sourceUpdatedAt: version.sourceUpdatedAt || null, title: version.title || '',
      settings: version.settings || null, runSummary: version.runSummary || null, files: version.files || {}
    };
    exportFile('Judge历史版本-v' + String(displayIndex || 1) + '-' + tsName() + '.json', JSON.stringify(payload, null, 2), 'application/json', { kind: 'history-version' });
  }
  function viewSessionVersion(version, displayIndex) {
    var html = versionReportHtml(version);
    if (!html) { alert('该只读版本没有 report.html。'); return; }
    closeHistoryManager();
    // 旧版本属于 Judge 自产可信文档，但 workDir=null：可阅读/章节导航，不具备 Run 返回、续跑或会话导出 authority。
    showReport(html, null, 'internal', '只读历史版本 v' + String(displayIndex || 1));
  }
  function renderSessionVersions(s, hostEl) {
    if (!hostEl || !s) return;
    hostEl.setAttribute('data-session-version-owner', s.id);
    hostEl.innerHTML = '<div class="hint">读取只读版本…</div>';
    idbListSessionVersions(s.dir).then(function (versions) {
      if (!hostEl.parentNode || hostEl.getAttribute('data-session-version-owner') !== s.id) return;
      if (!versions.length) { hostEl.innerHTML = '<div class="hint">暂无定点续跑前版本。</div>'; return; }
      hostEl.innerHTML = versions.map(function (v, idx) {
        var n = idx + 1;
        return '<div class="archive-version-row" data-version-id="' + esc(v.versionId) + '">' +
          '<span><b>v' + n + '</b> · ' + esc((v.createdAt || '').replace('T', ' ').slice(0, 19)) + ' · 只读</span>' +
          '<span class="archive-version-actions"><button class="btn small" data-version-action="view" data-version-index="' + idx + '">查看报告</button>' +
          '<button class="btn small" data-version-action="export" data-version-index="' + idx + '">导出版本</button></span></div>';
      }).join('');
      Array.prototype.forEach.call(hostEl.querySelectorAll('[data-version-action]'), function (btn) {
        btn.onclick = function () {
          var idx = Number(btn.getAttribute('data-version-index'));
          var v = versions[idx];
          if (!v) return;
          if (btn.getAttribute('data-version-action') === 'view') viewSessionVersion(v, idx + 1);
          else exportSessionVersion(v, idx + 1);
        };
      });
    }).catch(function (e) {
      if (hostEl.parentNode) hostEl.innerHTML = '<div class="hint">版本读取失败：' + esc(e && e.message ? e.message : e) + '</div>';
    });
  }
  function showTargetedResumeDialog(s, runModel) {
    if (running) return;
    if (!engine) initEngine();
    var historicalSettings;
    try { historicalSettings = normalizeSettingsKeys(JSON.parse(JSON.stringify(s.settings || settings || {}))); }
    catch (e) { historicalSettings = normalizeSettingsKeys({}); }
    var nodes = engine.resumeNodeOrder(historicalSettings);
    var ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="resume-target-title">' +
      '<h2 id="resume-target-title">从指定节点重算</h2>' +
      '<div class="hint" style="margin-bottom:10px">会先保存当前完整终态为只读版本，再按共享依赖图失效所选节点及必要下游。旧 Flight Run 不删除，本次真实模型请求会形成新的 Flight Run。</div>' +
      '<label class="field"><span>请求节点</span><select id="resume-target-node"></select></label>' +
      '<div id="resume-target-plan" class="hint" style="white-space:pre-wrap;margin-top:10px"></div>' +
      '<div class="modal-btns"><button class="btn" id="resume-target-cancel">取消</button><button class="btn primary" id="resume-target-confirm">载入并准备续跑</button></div></div>';
    document.body.appendChild(ov);
    registerTransientLayer(ov, function () { removeTransientLayer(ov); });
    var select = $('resume-target-node'), preview = $('resume-target-plan'), confirmBtn = $('resume-target-confirm');
    select.innerHTML = nodes.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n === 'R6' ? 'R6 · 报告重建' : n) + '</option>'; }).join('');
    function refreshPlan() {
      var plan = engine.planResumeStart({ requestedNode: select.value, runModel: runModel || s.run || { staleRounds: {} }, settings: historicalSettings });
      select._resumePlan = plan;
      confirmBtn.disabled = !plan.allowed;
      preview.textContent = plan.allowed
        ? ('请求：' + plan.requestedNode + '\n实际起点：' + plan.effectiveStartNode + '\n将重算：' + plan.invalidatedNodes.join(' → ') + '\n保留复用：' + (plan.preservedNodes.join('、') || '无') + (plan.staleExpansion.length ? '\n因 stale 自动扩张：' + plan.staleExpansion.join('、') : '') + '\n\n实际执行前会在当前 prompt 生成后再次用同一 planner 复核。')
        : ('不可执行：' + plan.blockingReason);
    }
    select.onchange = refreshPlan;
    $('resume-target-cancel').onclick = function () { removeTransientLayer(ov); };
    confirmBtn.onclick = function () {
      var plan = select._resumePlan;
      if (!plan || !plan.allowed) return;
      var node = plan.requestedNode;
      removeTransientLayer(ov);
      closeHistoryManager();
      resumeSession(s, node);
    };
    refreshPlan();
  }
  function renderArchiveDetail(s, runModel) {
    var el = $('archive-detail-panel');
    if (!el) return;
    if (!s) {
      el.innerHTML = '<div class="surface-title">记录与动作</div><div class="hint">暂无可显示记录。</div>';
      return;
    }
    var badges = buildBadgesHtml(runModel);
    var preview = buildPreviewHtml(runModel);
    el.innerHTML = '<div class="surface-title">记录与动作</div>' +
      '<div class="archive-detail-title">' + esc(s.title) + '</div>' +
      '<div class="archive-detail-meta">' + esc((s.updatedAt || '').replace('T', ' ').slice(0, 19)) + ' · ' + esc(statusWord(s.status)) + (s.reportReady ? ' · 📋' : '') + '</div>' +
      badges + preview +
      '<div class="archive-detail-actions">' +
      '<button class="btn primary" data-archive-act="resume-auto">继续最后断点</button>' +
      '<button class="btn" data-archive-act="resume-target">从指定节点重算</button>' +
      '<button class="btn" data-archive-act="view-report" disabled title="正在核验已有 report.html">查看报告</button>' +
      '<button class="btn" data-archive-act="reissue">' + TXT.sess.reissue + '</button>' +
      '<button class="btn" data-archive-act="export">' + TXT.sess.export + '</button>' +
      '<button class="btn" data-archive-act="rename">' + TXT.sess.rename + '</button>' +
      '<button class="btn" data-archive-act="meta">' + TXT.sess.meta + '</button>' +
      '<button class="btn danger" data-archive-act="delete">' + TXT.sess.del + '</button>' +
      '</div>' +
      '<div class="archive-version-section"><div class="surface-title" style="margin-top:14px">定点续跑前版本</div><div data-archive-versions></div></div>';
    el.setAttribute('data-session-owner', s.id);
    el.querySelector('[data-archive-act=resume-auto]').onclick = function () { closeHistoryManager(); resumeSession(s, 'auto'); };
    el.querySelector('[data-archive-act=resume-target]').onclick = function () { showTargetedResumeDialog(s, runModel); };
    var viewReportBtn = el.querySelector('[data-archive-act=view-report]');
    viewReportBtn.onclick = function () { viewSavedSessionReport(s); };
    getSessionFilesReadOnly(s.dir).then(function (files) {
      if (!viewReportBtn.parentNode || el.getAttribute('data-session-owner') !== s.id) return;
      var reportPath = String(s.dir || '').replace(/\/+$/, '') + '/report.html';
      var available = !!(files && typeof files[reportPath] === 'string' && files[reportPath].trim());
      viewReportBtn.disabled = !available;
      viewReportBtn.title = available ? '只读打开历史快照中现有 report.html' : '该历史会话没有现成 report.html；不会自动重新生成';
    }).catch(function () {
      if (viewReportBtn.parentNode) { viewReportBtn.disabled = true; viewReportBtn.title = '历史报告读取失败；不会自动重新生成'; }
    });
    el.querySelector('[data-archive-act=reissue]').onclick = function () { closeHistoryManager(); reissueSessionReport(s); };
    el.querySelector('[data-archive-act=export]').onclick = function () { exportSessionRecord(s); };
    el.querySelector('[data-archive-act=meta]').onclick = function () { exportSessionRunMeta(s); };
    el.querySelector('[data-archive-act=rename]').onclick = function () {
      var nt = prompt(TXT.sess.renamePrompt, s.title);
      if (nt && nt !== s.title) {
        s.title = nt;
        idbPut(s).then(function () {
          if (currentSession && currentSession.dir === s.dir) currentSession.title = nt;
          refreshSessionList();
        }).catch(function () {});
      }
    };
    renderSessionVersions(s, el.querySelector('[data-archive-versions]'));
    el.querySelector('[data-archive-act=delete]').onclick = function () {
      if (!confirm(TXT.sess.delConfirm + s.title + TXT.sess.delConfirmTail)) return;
      idbDeleteSessionComplete(s.id).then(function () {
        if (engine) engine.removeSession(s.dir || s.id);
        if (currentSession && currentSession.dir === s.dir) currentSession = null;
        archiveSelectedSessionId = null;
        refreshHistoryManager();
      }).catch(function (e) { alert(String(e && e.message || e)); });
    };
  }
  function refreshSessionList() {
    idbAll().then(function (list) {
      var el = $('session-list');
      if (!el) return;
      list.sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
      var visible = list.filter(function (s) {
        if (!archiveSearchQuery) return true;
        var haystack = [s.title, statusWord(s.status), s.status, s.updatedAt].join(' ').toLowerCase();
        return haystack.indexOf(archiveSearchQuery) >= 0;
      });
      archiveVisibleCount = visible.length;
      if (!list.length) {
        archiveSelectedSessionId = null;
        renderArchiveDetail(null, null);
        el.innerHTML = '<div class="hint">' + TXT.sess.empty + '</div>';
        return;
      }
      if (!visible.length) {
        archiveSelectedSessionId = null;
        renderArchiveDetail(null, null);
        el.innerHTML = '<div class="hint">没有匹配的会话。</div>';
        return;
      }
      el.innerHTML = '';
      if (!visible.some(function (row) { return row.id === archiveSelectedSessionId; })) archiveSelectedSessionId = visible[0].id;
      visible.forEach(function (s) {
        // 左栏只负责多会话选择；run 徽章、断点预览和所有动作统一在右侧详情渲染。
        var runModel = null;
        var statusText = s.status;
        if (s.run && s.run.rounds) runModel = s.run;
        else if (s.run && s.run.events && !s.run.rounds) runModel = s.run;
        var item = document.createElement('div');
        item.className = 'session-item archive-session-row';
        item.setAttribute('data-session-id', s.id);
        item.setAttribute('role', 'button');
        item.setAttribute('tabindex', '0');
        item.setAttribute('aria-pressed', archiveSelectedSessionId === s.id ? 'true' : 'false');
        if (archiveSelectedSessionId === s.id) item.classList.add('selected');
        item.innerHTML = '<div class="archive-session-main"><span class="si-title">' + esc(s.title) + '</span>' +
          '<span class="archive-session-status" data-status="' + esc(statusText) + '">' + esc(statusWord(statusText)) + '</span></div>' +
          '<span class="si-meta">' + esc((s.updatedAt || '').replace('T', ' ').slice(0, 19)) + (s.reportReady ? ' · 已有报告' : '') + '</span>';
        function selectThisArchiveSession() {
          archiveSelectedSessionId = s.id;
          var rows = el.querySelectorAll('[data-session-id]');
          for (var ri = 0; ri < rows.length; ri++) {
            var selected = rows[ri] === item;
            rows[ri].classList.toggle('selected', selected);
            rows[ri].setAttribute('aria-pressed', selected ? 'true' : 'false');
          }
          renderArchiveDetail(s, runModel);
        }
        item.onclick = selectThisArchiveSession;
        item.onkeydown = function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectThisArchiveSession(); }
        };
        el.appendChild(item);
        if (archiveSelectedSessionId === s.id) renderArchiveDetail(s, runModel);
      });
    }).catch(function () {});
  }
  function setResumeReadyState(ready) {
    var resumeBtn = $('btn-resume-run');
    var stopBtn = $('btn-stop');
    if (resumeBtn) {
      resumeBtn.style.display = ready ? 'inline-flex' : 'none';
      resumeBtn.disabled = !ready;
    }
    if (stopBtn) {
      stopBtn.style.display = ready ? 'none' : '';
      if (ready) stopBtn.disabled = true;
    }
  }
  function prepareResumeSession(s, runModel, requestedNode) {
    var startNode = requestedNode || 'auto';
    pendingResume = { dir: s.dir, startNode: startNode };
    var resumeText = engine ? engine.readDebateCopy(s.dir) : null;
    if (resumeText !== null) $('transcript').value = resumeText;
    roundState = {};
    if (runModel && Array.isArray(runModel.rounds)) {
      runModel.rounds.forEach(function (r) {
        if (!r || !r.round) return;
        var st = r.status;
        if (st === 'done' || st === 'skipped' || st === 'fail' || st === 'pending') roundState[r.round] = st;
      });
    }
    if (!settings.plain) roundState.R7 = 'skipped';
    if (settings.readerGuide !== true) roundState.R8 = 'skipped';
    $('logbox').innerHTML = '';
    showScene('run');
    renderTimeline(null);
    setTribunalCurrentRound(null, TXT.run.resumeReady);
    var staleCount = runModel && runModel.summary ? Number(runModel.summary.staleCount || 0) : 0;
    $('run-status').textContent = startNode !== 'auto'
      ? ('已载入历史场次 · 准备从 ' + startNode + ' 定点重算')
      : (staleCount > 0 ? TXT.run.resumeStalePre + staleCount + TXT.run.resumeStaleTail : TXT.run.resumeReadyStatus);
    setResumeReadyState(true);
    logLine(TXT.run.resumeLoadedLog + (startNode !== 'auto' ? ' · 定点节点 ' + startNode : ''));
    if (staleCount > 0 && runModel && runModel.staleRounds) {
      var staleNames = Object.keys(runModel.staleRounds).filter(function (k) { return runModel.staleRounds[k]; });
      if (staleNames.length) logLine('⚠ prompt 已变更：' + staleNames.join('、'));
    }
  }
  async function resumeSession(s, requestedNode) {
    if (running) return;
    if (!engine) initEngine();
    var files = await getSessionFiles(s.dir);   // C5：v2 经 sessionFiles 合并恢复（v1 惰性迁移）
    if (!files) { alert(TXT.sess.noReport); return; }
    // 历史 session 快照是续跑 authority；restore 前先清同 workDir VFS，避免旧内存残留补回磁盘快照已不存在的下游产物。
    engine.removeSession(s.dir);
    engine.restoreSession(files);
    currentSession = { dir: s.dir, title: s.title, createdAt: s.createdAt };
    settings = normalizeSettingsKeys(s.settings) || settings;
    syncSettingsToForm();
    if (settings.baseUrl) $('cfg-base').value = settings.baseUrl;   // Resume 必须沿用该 session 保存的 transport endpoint；preset 只负责 UI 默认值。
    var runModel = s.run || engine.buildRunModelFromFiles(s.dir, files || {});
    prepareResumeSession(s, runModel, requestedNode || 'auto');
  }
  async function exportSessionRecord(s) {
    try {
      var files = await getSessionFiles(s.dir);
      if (!files) { alert(TXT.sess.noSession); return; }
      var payload = { kind: 'judge-web-session-v1', exportedAt: new Date().toISOString(), workDir: s.dir, files: files, settings: s.settings || settings };
      await exportFile(TXT.sess.sessionFile + tsName() + '.json', JSON.stringify(payload, null, 2), 'application/json', { kind: 'history-session' });
    } catch (e) { alert(String(e && e.message || e)); }
  }
  async function viewSavedSessionReport(s) {
    if (!engine) initEngine();
    var files = await getSessionFilesReadOnly(s.dir);   // 严格只读：不迁移、不重建、不写 Judge history。
    if (!files) { alert(TXT.sess.noSession); return; }
    var workDir = s.dir;
    var reportPath = String(workDir || '').replace(/\/+$/, '') + '/report.html';
    var html = files[reportPath];
    if (typeof html !== 'string' || !html.trim()) {
      alert('该历史会话没有现成 report.html；“查看报告”不会自动重新生成。');
      return;
    }
    // 仅同步浏览器内存 VFS，保证该 report 的同 workDir 导出读取同一历史快照；不改变 currentSession / Run authority。
    engine.removeSession(workDir);
    engine.restoreSession(files);
    closeHistoryManager();
    showReport(html, workDir, 'internal', '历史现有 report.html');
  }
  async function reissueSessionReport(s) {
    if (!engine) initEngine();
    var files = await getSessionFilesReadOnly(s.dir);   // 纯读取正式 Judge session；Recorder 与 v1 惰性迁移都不参与。
    if (!files) { alert(TXT.sess.noSession); return; }
    var workDir = s.dir;
    // restore 是覆盖式而非镜像式；必须先清同 workDir 旧 VFS，防缺失正式产物被内存残留假满足。
    engine.removeSession(workDir);
    engine.restoreSession(files);
    try {
      var historicalSettings = normalizeSettingsKeys(JSON.parse(JSON.stringify(s.settings || {})));
      // P0-6：用户点击“重新出报告”即明确要求走现有 0-API 四组合机械重建；即使已有 report.html 也不走查看捷径。
      var rebuilt = await engine.rebuildHistoricalReport(workDir, historicalSettings);
      var html = rebuilt && rebuilt.html;
      if (!html) throw new Error('机械重建未生成 report.html');
      // 重新出报告是纯派生恢复：不写 #FINAL、不清 #R*、不改 reportReady/updatedAt/淘汰顺序。
      logLine(TXT.sess.reissueBuilt);
      currentSession = { dir: workDir, title: s.title, createdAt: s.createdAt };
      showReport(html, workDir);
    } catch (e) {
      alert(TXT.sess.noReport + (e && e.message ? e.message : e));
    }
  }

  // ================= 报告展示 / 导出 =================
  function navigateReportSection(sectionId, recordHistory) {
    if (!reportHost || !reportState.document || reportState.document.trust !== 'internal') return false;
    var next = sectionId ? String(sectionId) : null;
    if (recordHistory !== false && next !== reportCurrentSection) reportNavHistory.push(reportCurrentSection);
    if (next) {
      if (!reportHost.navigate(next)) {
        if (recordHistory !== false) reportNavHistory.pop();
        return false;
      }
    } else {
      var scene = $('scene-report');
      if (scene) {
        var top = (window.pageYOffset || document.documentElement.scrollTop || 0) + scene.getBoundingClientRect().top - 82;
        window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
    }
    reportCurrentSection = next;
    return true;
  }
  function consumeReportNavigationBack() {
    if (!reportState.document || reportState.document.trust !== 'internal') return false;
    if (!reportNavHistory.length && reportCurrentSection == null) return false;
    var previous = reportNavHistory.length ? reportNavHistory.pop() : null;
    navigateReportSection(previous, false);
    return true;
  }
  function renderExternalReportCover() {
    var el = $('report-verdict-cover');
    if (!el) return;
    el.innerHTML = '<div class="report-cover-kicker">Isolated Document</div><h2>外部 HTML · 隔离阅读</h2>' +
      '<div class="report-cover-reason">该文件保持原始 canonical 内容用于导出；预览使用无脚本 opaque sandbox。父页面不会读取其 C1/C6、PLAIN 或内部导航。</div>';
  }
  function renderReportVerdictCover(summary) {
    var el = $('report-verdict-cover');
    if (!el) return;
    if (!summary) {
      el.innerHTML = '<div class="report-cover-kicker">Verdict</div><h2>裁决报告</h2><button class="btn small" data-report-jump="C1">查看 C1</button>';
      return;
    }
    var winner = summary.winner || '裁决已生成';
    var why = summary.why || '';
    var clash = summary.keyClash || '';
    el.innerHTML = '<div class="report-cover-kicker">Verdict</div><h2>' + esc(winner) + '</h2>' +
      (summary.reportTitle ? '<div class="report-cover-title">' + esc(summary.reportTitle) + '</div>' : '') +
      (why ? '<div class="report-cover-reason"><b>为什么：</b>' + esc(why) + '</div>' : '<div class="report-cover-reason"><button class="btn small" data-report-jump="C1">查看 C1</button></div>') +
      (clash ? '<div class="report-cover-clash"><b>关键交锋：</b>' + esc(clash) + '</div>' : '<div class="report-cover-clash"><button class="btn small" data-report-jump="C6">查看 C6 关键交锋</button></div>');
    Array.prototype.forEach.call(el.querySelectorAll('[data-report-jump]'), function (btn) {
      btn.onclick = function () { navigateReportSection(btn.getAttribute('data-report-jump'), true); };
    });
  }
  function updateReportReadingState() {
    if (!reportHost || !reportState.document || reportState.document.trust !== 'internal') return;
    var state = reportHost.getReadingState();
    if (!state) return;
    var progress = $('report-reading-progress');
    if (progress) progress.textContent = String(state.progress || 0) + '%';
    var list = $('report-outline-list');
    if (!list) return;
    Array.prototype.forEach.call(list.querySelectorAll('[data-report-section]'), function (btn) {
      var active = btn.getAttribute('data-report-section') === state.activeSection;
      btn.classList.toggle('active', active);
      if (active) btn.setAttribute('aria-current', 'true'); else btn.removeAttribute('aria-current');
    });
  }
  function renderReportOutline() {
    var list = $('report-outline-list');
    if (!list) return;
    var outline = reportHost ? reportHost.getOutline() : [];
    if (!outline || !outline.length) { list.innerHTML = '<div class="hint">暂无可用章节导航</div>'; return; }
    list.innerHTML = outline.map(function (item) {
      return '<button class="report-outline-item" type="button" data-report-section="' + esc(item.id) + '"><span>' + esc(item.id + ' · ' + (item.title || item.id)) + '</span>' +
        (item.r8 ? '<small>' + esc(item.r8) + '</small>' : '') + '</button>';
    }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('[data-report-section]'), function (btn) {
      btn.onclick = function () {
        if (navigateReportSection(btn.getAttribute('data-report-section'), true)) {
          updateReportReadingState();
          closeMobileReportOutline();
        }
      };
    });
    updateReportReadingState();
  }
  function refreshReportChrome(doc) {
    var internal = !!(doc && doc.trust === 'internal');
    var trust = $('report-trust-status');
    if (trust) trust.textContent = internal ? 'Judge 正式报告 · 可信阅读' : '外部 HTML · 隔离阅读';
    var plain = $('report-plain-toggle'), sections = $('report-sections-toggle'), theme = $('report-theme-toggle');
    if (plain) plain.disabled = !internal;
    if (sections) sections.disabled = !internal;
    if (theme) theme.disabled = !internal;
    var sessionExport = $('btn-export-session');
    if (sessionExport) sessionExport.disabled = !internal || !doc.workDir;
    if (!internal) {
      renderExternalReportCover();
      var l = $('report-outline-list'); if (l) l.innerHTML = '<div class="hint">外部 HTML 处于隔离阅读，不读取其 DOM。</div>';
      var externalProgress = $('report-reading-progress');
      if (externalProgress) externalProgress.textContent = '0%';
      return;
    }
    var hostReadyForDoc = !!(reportHost && reportHost.getDocument && reportHost.getDocument() === doc);
    if (!hostReadyForDoc) {
      var cover = $('report-verdict-cover');
      if (cover) cover.innerHTML = '<div class="report-cover-kicker">Verdict</div><h2>裁决报告</h2><div class="report-cover-reason">报告载入中…</div>';
      var pendingList = $('report-outline-list');
      if (pendingList) pendingList.innerHTML = '<div class="hint">正在建立章节导航…</div>';
      var pendingProgress = $('report-reading-progress');
      if (pendingProgress) pendingProgress.textContent = '0%';
      return;
    }
    renderReportVerdictCover(reportHost.getSummary());
    renderReportOutline();
  }
  function ensureReportHost() {
    if (!reportHost) reportHost = reportHostMod.createReportHost({
      frame: $('report-frame'),
      exportFile: function (blob, filename, meta) { return judgeHostIO.saveBlob(blob, filename, meta || { kind: 'hosted-report-download' }); },
      onExportError: function (e) { alert('报告内部导出失败：' + (e && e.message ? e.message : e)); },
      onReady: function (doc) {
        if (doc && doc.trust === 'internal' && reportHost) {
          reportHost.setTheme(settings.theme);
          reportHost.setPlain(reportPlainMode);
        }
        refreshReportChrome(doc);
      }
    });
    return reportHost;
  }
  function setReportOutlineOpen(open) {
    var outline = $('report-outline');
    var toggle = $('report-sections-toggle');
    if (!outline || !toggle) return false;
    var mobile = !!(window.matchMedia && window.matchMedia('(max-width: 767px)').matches);
    var layout = outline.parentNode && outline.parentNode.classList && outline.parentNode.classList.contains('report-layout') ? outline.parentNode : null;
    outline.classList.toggle('report-outline-collapsed', !open);
    if (layout) layout.classList.toggle('report-layout-outline-open', !!open && !mobile);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    return !!open;
  }
  function syncReportOutlineForViewport() {
    var outline = $('report-outline');
    var toggle = $('report-sections-toggle');
    if (!outline || !toggle) return;
    var mobile = !!(window.matchMedia && window.matchMedia('(max-width: 767px)').matches);
    var focusInside = !!(document.activeElement && outline.contains(document.activeElement));
    setReportOutlineOpen(!mobile);
    outline.removeAttribute('role');
    outline.removeAttribute('aria-modal');
    outline.removeAttribute('tabindex');
    if (mobile && focusInside && toggle.focus) toggle.focus();
  }
  function canReturnToCurrentReport() {
    return !!(!running && reportState.document && reportState.document.trust === 'internal' && reportState.workDir && currentSession && currentSession.dir === reportState.workDir);
  }
  function refreshReportRouteActions() {
    var returnBtn = $('btn-return-report');
    if (returnBtn) returnBtn.style.display = canReturnToCurrentReport() ? '' : 'none';
    var logBtn = $('btn-report-run-log');
    var canOpenLog = !!(reportState.document && reportState.document.trust === 'internal' && reportState.workDir && currentSession && currentSession.dir === reportState.workDir);
    if (logBtn) logBtn.style.display = canOpenLog ? '' : 'none';
  }
  function openRunLogFromReport() {
    if (!reportState.document || reportState.document.trust !== 'internal' || !reportState.workDir || !currentSession || currentSession.dir !== reportState.workDir) return false;
    showScene('run');
    refreshReportRouteActions();
    return true;
  }
  function returnToCurrentReport() {
    if (!canReturnToCurrentReport()) return false;
    showScene('report');
    refreshReportRouteActions();
    return true;
  }
  function invalidateReportRoute() {
    reportState = { document: null, html: null, workDir: null };
    reportNavHistory = [];
    reportCurrentSection = null;
    refreshReportRouteActions();
  }
  function showReportDocument(doc) {
    showScene('report');
    reportPlainMode = false;
    reportNavHistory = [];
    reportCurrentSection = null;
    var plainBtn = $('report-plain-toggle');
    if (plainBtn) { plainBtn.setAttribute('aria-pressed', 'false'); plainBtn.textContent = '原文 · 切到白话'; }
    syncReportOutlineForViewport();
    reportState.document = doc;
    reportState.html = doc.canonicalHtml; // compatibility projection; canonical authority remains ReportDocument.
    reportState.workDir = doc.workDir;
    refreshReportRouteActions();
    refreshReportChrome(doc);
    ensureReportHost().load(doc);
  }
  function showReport(html, workDir, trust, sourceName) {
    var doc = reportHostMod.createReportDocument({
      canonicalHtml: String(html == null ? '' : html),
      workDir: workDir,
      trust: trust || 'internal',
      sourceName: sourceName || (workDir ? 'report.html' : '')
    });
    showReportDocument(doc);
  }
  function currentReportHtml() {
    return reportState.document ? reportState.document.canonicalHtml : reportState.html;
  }
  function exportFile(name, content, type, meta) {
    var blob = content instanceof Blob ? content : new Blob([content], { type: type || 'application/octet-stream' });
    return judgeHostIO.saveBlob(blob, name, meta || { mimeType: type || 'application/octet-stream' }).catch(function (e) {
      alert('导出失败：' + (e && e.message ? e.message : e));
      return { ok: false, error: e };
    });
  }
  function noteFlightRecorderWarning(msg) {
    flightRecorderWarning = String(msg || 'Recorder warning');
    try { console.warn('[judge-web flight-recorder] ' + flightRecorderWarning); } catch (e) {}
    var b = $('btn-sessions');
    if (b) { b.textContent = TXT.top.sessions + ' ⚠'; b.title = flightRecorderWarning; }
    var warning = $('fr-warning');
    if (warning) warning.textContent = flightRecorderWarning;
  }
  function initFlightRecorder() {
    if (flightRecorder) return;
    try {
      var mod = BUNDLE.modules.flightRecorder();
      flightRecorder = mod.createFlightRecorder({
        sha256: BUNDLE.sha256Hex,
        onWarning: noteFlightRecorderWarning
      });
      var root = (typeof window !== 'undefined') ? window : globalThis;
      root.JUDGE_WEB_FLIGHT_OBSERVER = flightRecorder.observer;
      flightRecorder.init();   // 后台初始化，不 await，不作为 Judge 启动前置条件
    } catch (e) {
      flightRecorder = null;
      noteFlightRecorderWarning('Recorder 初始化失败：' + (e && e.message ? e.message : e));
    }
  }
  function flightStorageText(est) {
    if (!est || !Number(est.quota)) return TXT.flight.storage + '浏览器未提供配额信息';
    return TXT.flight.storage + fmtBytes(Number(est.usage || 0)) + ' / ' + fmtBytes(Number(est.quota || 0));
  }
  function buildFlightRunOrdinals(runs) {
    var grouped = Object.create(null);
    (runs || []).forEach(function (run) {
      var key = String(run && run.workDir || '');
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(run);
    });
    var out = Object.create(null);
    Object.keys(grouped).forEach(function (key) {
      grouped[key].sort(function (a, b) { return String(a.startedAt || '').localeCompare(String(b.startedAt || '')); });
      grouped[key].forEach(function (run, index) { out[run.id] = String(index + 1).padStart(2, '0'); });
    });
    return out;
  }
  function flightLocalParts(value) {
    var d = value ? new Date(value) : null;
    if (!d || isNaN(d.getTime())) return null;
    return { d: d, y: d.getFullYear(), m: d.getMonth() + 1, day: d.getDate() };
  }
  function flightClock(parts, withDate) {
    if (!parts) return '';
    var d = parts.d;
    var clock = [d.getHours(), d.getMinutes(), d.getSeconds()].map(function (n) { return String(n).padStart(2, '0'); }).join(':');
    if (!withDate) return clock;
    return String(parts.m).padStart(2, '0') + '-' + String(parts.day).padStart(2, '0') + ' ' + clock;
  }
  function formatFlightRunRange(run) {
    run = run || {};
    var start = flightLocalParts(run.startedAt);
    var end = flightLocalParts(run.endedAt);
    var runningState = String(run.status || '') === 'running';
    var crossDate = !!(start && end && (start.y !== end.y || start.m !== end.m || start.day !== end.day));
    var startText = start ? flightClock(start, crossDate) : '未记录开始时间';
    if (runningState && !end) return startText + ' → 进行中';
    if (!end) return startText + ' → 未记录结束时间';
    return startText + ' → ' + flightClock(end, crossDate);
  }
  function updateFlightExportSelectionState() {
    var btn = $('fr-export-all');
    if (!btn) return;
    var selected = Object.keys(archiveFlightSelectedSessionIds).filter(function (id) { return !!archiveFlightSelectedSessionIds[id]; });
    btn.disabled = !flightRecorder || !selected.length;
  }
  function renderFlightSessionSelector() {
    var host = $('fr-session-select');
    if (!host) return Promise.resolve([]);
    return idbAll().then(function (list) {
      list = (list || []).slice().sort(function (a, b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });
      if (!archiveFlightSelectionInitialized) {
        archiveFlightSelectedSessionIds = Object.create(null);
        list.forEach(function (s) { archiveFlightSelectedSessionIds[s.id] = true; });
        archiveFlightSelectionInitialized = true;
      } else {
        var liveIds = Object.create(null);
        list.forEach(function (s) { liveIds[s.id] = true; });
        Object.keys(archiveFlightSelectedSessionIds).forEach(function (id) { if (!liveIds[id]) delete archiveFlightSelectedSessionIds[id]; });
      }
      if (!list.length) {
        host.innerHTML = '<span class="hint">暂无 Judge 历史会话可选择。</span>';
        updateFlightExportSelectionState();
        return list;
      }
      host.innerHTML = list.map(function (s) {
        var checked = archiveFlightSelectedSessionIds[s.id] ? ' checked' : '';
        var workDir = s.dir || s.id || '';
        return '<label class="archive-flight-session-option"><input type="checkbox" value="' + esc(s.id) + '"' + checked + '><span><b>' + esc(s.title || workDir) + '</b><small>' + esc(workDir) + ' · ' + esc(statusWord(s.status)) + '</small></span></label>';
      }).join('');
      Array.prototype.forEach.call(host.querySelectorAll('input[type=checkbox]'), function (box) {
        box.onchange = function () { archiveFlightSelectedSessionIds[box.value] = !!box.checked; updateFlightExportSelectionState(); };
      });
      updateFlightExportSelectionState();
      return list;
    }).catch(function (e) {
      host.innerHTML = '<span class="hint" style="color:var(--red)">历史会话读取失败：' + esc(e && e.message ? e.message : e) + '</span>';
      updateFlightExportSelectionState();
      return [];
    });
  }
  async function exportSelectedFlightRecords() {
    var status = $('fr-export-status');
    if (!flightRecorder || !flightExportMod || typeof flightExportMod.buildFlightExportArchive !== 'function') {
      if (status) status.textContent = '导出模块当前不可用。';
      return;
    }
    var selectedIds = Object.keys(archiveFlightSelectedSessionIds).filter(function (id) { return !!archiveFlightSelectedSessionIds[id]; });
    if (!selectedIds.length) { if (status) status.textContent = '请至少选择一个历史会话。'; return; }
    var button = $('fr-export-all');
    if (button) button.disabled = true;
    if (status) status.textContent = '正在只读取证据并打包…';
    try {
      // P0-7：导出路径严禁 flush/migrate/persist/retention；所有数据都来自当前已经持久化的只读快照。
      var sessions = await idbAll();
      var selectedSet = Object.create(null);
      selectedIds.forEach(function (id) { selectedSet[id] = true; });
      sessions = (sessions || []).filter(function (s) { return !!selectedSet[s.id]; });
      if (!sessions.length) throw new Error('所选历史会话已不存在');
      var allRuns = await flightRecorder.listRuns();
      var sources = [];
      for (var si = 0; si < sessions.length; si++) {
        var s = sessions[si];
        var workDir = s.dir || s.id;
        var matchedRuns = (allRuns || []).filter(function (r) { return r && r.workDir === workDir; }).slice();
        matchedRuns.sort(function (a, b) { return String(a.startedAt || '').localeCompare(String(b.startedAt || '')); });
        var flightRuns = [];
        for (var ri = 0; ri < matchedRuns.length; ri++) {
          var run = matchedRuns[ri];
          var reqs = await flightRecorder.listRequests(run.id);
          var requestSources = [];
          for (var qi = 0; qi < reqs.length; qi++) {
            var req = reqs[qi];
            var artifact = await flightRecorder.getRequestArtifact(req.id);
            requestSources.push({
              record: artifact && artifact.request ? artifact.request : req,
              requestText: artifact && artifact.request ? artifact.requestText : String(req.requestBodyText || ''),
              rawBytes: artifact && artifact.rawBytes ? artifact.rawBytes : new Uint8Array(0),
              actualRawBytes: artifact && artifact.actualRawBytes != null ? artifact.actualRawBytes : 0,
              actualChunkCount: artifact && artifact.actualChunkCount != null ? artifact.actualChunkCount : 0,
              readError: artifact && artifact.readError ? artifact.readError : null
            });
          }
          flightRuns.push({ run: JSON.parse(JSON.stringify(run)), requests: requestSources });
        }
        sources.push({
          sessionRecord: JSON.parse(JSON.stringify(s)),
          runModel: s.run == null ? null : JSON.parse(JSON.stringify(s.run)),
          flightRuns: flightRuns
        });
      }
      var exportedAt = new Date().toISOString();
      var archive = flightExportMod.buildFlightExportArchive({ sessions: sources, exportedAt: exportedAt });
      await exportFile('judge-web-flight-all-' + tsName() + '.zip', archive.bytes, 'application/zip', { kind: 'flight-batch-evidence', sessionCount: sources.length });
      if (status) status.textContent = '已导出 ' + sources.length + ' 个历史会话的已持久化 Flight 证据；缺失/截断项见 manifest.json。';
    } catch (e) {
      if (status) status.textContent = '导出失败：' + (e && e.message ? e.message : e);
    } finally {
      updateFlightExportSelectionState();
    }
  }
  function refreshArchiveFlight() {
    var generation = ++archiveFlightRefreshGeneration;
    var listEl = $('fr-list');
    if (!listEl) return Promise.resolve([]);
    if (flightRecorderWarning && $('fr-warning')) $('fr-warning').textContent = flightRecorderWarning;
    if (!flightRecorder) {
      listEl.innerHTML = '<div class="hint">Recorder 当前不可用。</div>';
      if ($('fr-persist')) $('fr-persist').disabled = true;
      if ($('fr-clear')) $('fr-clear').disabled = true;
      return Promise.resolve([]);
    }
    listEl.innerHTML = '<div class="hint">正在刷新飞行记录……</div>';
    flightRecorder.estimateStorage().then(function (est) {
      if (generation !== archiveFlightRefreshGeneration) return;
      var el = $('fr-storage'); if (el) el.textContent = flightStorageText(est);
    });
    return Promise.resolve(typeof flightRecorder.flush === 'function' ? flightRecorder.flush() : null)
      .then(function () { return flightRecorder.listRuns(); })
      .then(function (runs) {
        runs = (runs || []).slice(0, 50);
        return Promise.all(runs.map(function (run) {
          return flightRecorder.listRequests(run.id).then(function (requests) { return { run: run, requests: requests || [] }; });
        })).then(function (groups) { return { runs: runs, groups: groups }; });
      }).then(function (payload) {
        if (generation !== archiveFlightRefreshGeneration || !historyOverlay || !historyOverlay.parentNode) return [];
        var groups = payload.groups || [];
        var currentList = $('fr-list');
        if (!currentList) return groups;
        if (!groups.length) { currentList.innerHTML = '<div class="hint">' + TXT.flight.empty + '</div>'; return groups; }
        var ordinals = buildFlightRunOrdinals(payload.runs || []);
        var html = '';
        groups.forEach(function (g) {
          var run = g.run || {};
          var ordinal = ordinals[run.id] || '—';
          var shortRunId = String(run.id || '').slice(-12);
          html += '<div class="card archive-flight-run"><div class="card-b" style="display:block">' +
            '<div class="archive-flight-run-title">本场运行 ' + esc(ordinal) + ' · ' + esc(formatFlightRunRange(run)) + ' · ' + esc(g.requests.length) + ' requests</div>' +
            '<div class="hint" style="user-select:text">' + esc(run.provider || '') + ' · ' + esc(run.model || '') + ' · ' + esc(run.status || '') +
            (run.captureTruncated ? ' · ⚠ capture_truncated' : '') + '</div>' +
            '<div class="hint" style="user-select:text;margin-top:3px">workDir: ' + esc(run.workDir || '—') + ' · runId: ' + esc(shortRunId || '—') + '</div>';
          if (!g.requests.length) html += '<div class="hint" style="margin-top:8px">尚无真实 API request。</div>';
          g.requests.forEach(function (r) {
            var usage = r.usage ? esc(JSON.stringify(r.usage)) : '—';
            html += '<div class="archive-flight-request">' +
              '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b>#' + esc(r.index) + '</b>' +
              '<code style="user-select:text">' + esc(r.model || '') + '</code><span class="hint">' + esc(r.status || '') +
              ' · HTTP ' + esc(r.httpStatus == null ? '—' : r.httpStatus) + ' · raw ' + fmtBytes(Number(r.rawBytes || 0)) +
              ' / ' + esc(r.chunkCount || 0) + ' chunks · DONE=' + esc(!!r.done) + ' · finish=' + esc(r.finishReason || '—') + '</span></div>' +
              '<div class="hint" style="margin-top:4px;user-select:text">endpoint: ' + esc(r.endpoint || '') + '</div>' +
              '<div class="hint" style="margin-top:2px">content=' + esc(r.contentChars || 0) + ' chars · reasoning=' + esc(r.reasoningChars || 0) +
              ' chars · usage=' + usage + (r.captureTruncated ? ' · ⚠ capture_truncated' : '') + '</div>' +
              '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">' +
              '<button class="btn small" data-fr-export="request" data-fr-id="' + esc(r.id) + '">' + TXT.flight.request + '</button>' +
              '<button class="btn small" data-fr-export="raw" data-fr-id="' + esc(r.id) + '">' + TXT.flight.response + '</button>' +
              '<button class="btn small" data-fr-export="summary" data-fr-id="' + esc(r.id) + '">' + TXT.flight.summary + '</button></div></div>';
          });
          html += '</div></div>';
        });
        currentList.innerHTML = html;
        currentList.querySelectorAll('[data-fr-export]').forEach(function (btn) {
          btn.onclick = function () {
            var requestId = btn.getAttribute('data-fr-id');
            var kind = btn.getAttribute('data-fr-export');
            flightRecorder.getRequestArtifact(requestId).then(function (a) {
              if (!a || !a.request) { alert('飞行记录读取失败'); return; }
              var base = 'judge-web-flight-' + String(a.request.runId || 'run').replace(/[^A-Za-z0-9._-]/g, '_') + '-r' + a.request.index;
              if (kind === 'request') exportFile(base + '-request.json', a.requestText, 'application/json', { kind: 'flight-request' });
              else if (kind === 'raw') exportFile(base + '-response.sse.raw', a.rawBytes, 'application/octet-stream', { kind: 'flight-raw' });
              else {
                var s = Object.assign({}, a.summary || {}); delete s.requestBodyText;
                exportFile(base + '-summary.json', JSON.stringify(s, null, 2), 'application/json', { kind: 'flight-summary' });
              }
            });
          };
        });
        return groups;
      }).catch(function (e) {
        if (generation !== archiveFlightRefreshGeneration) return [];
        var el = $('fr-list'); if (el) el.innerHTML = '<div class="hint" style="color:var(--red)">读取失败：' + esc(e && e.message ? e.message : e) + '</div>';
        return [];
      });
  }
  function showFlightRecorder() {
    showHistoryManager('flight');
  }

  function stripHtml(html) {
    return String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
  }

  // ================= 主流程 =================
  function initEngine() {
    if (engine) return;
    engine = BUNDLE.modules.engine().createEngine(BUNDLE, {
      onAdaptive: function (newMax) {
        var el = $('cfg-max');
        if (el) el.value = newMax;
        settings.maxTokens = newMax;
        saveSettings();
        logLine(TXT.run.adaptive + newMax + TXT.run.adaptiveTail);
      },
      onNote: function (msg) {
        logLine(TXT.run.notePrefix + msg);
      },
      onProgress: function (p) {
        if (!liveProgress || (p.elapsedMs < liveProgress.elapsedMs)) {
          if (liveProgress) commitLiveEstimate();
          liveProgress = { chars: 0, reasonChars: 0, elapsedMs: 0, final: false, estimateCommitted: false };
        }
        liveProgress.chars = p.chars;
        liveProgress.reasonChars = p.reasonChars;
        liveProgress.elapsedMs = p.elapsedMs;
        liveProgress.final = !!p.final;
        liveLastAt = Date.now();
      }
    });
    // fetch 管理器只负责 run-level 粘性拒绝；真实请求的 AbortController/timeout 生命周期归共享 api-provider 唯一所有。
    // W-T10：Stop 先置 abortedFlag 阻断后续新 fetch，再由 run-level abortController.signal 直接贯通 provider → native fetch body。
    var realFetch = window.fetch.bind(window);
    var abortedFlag = false;
    fetchManager = {
      fetch: function (input, init) {
        if (abortedFlag) {
          var ae = new Error('aborted');
          ae.name = 'AbortError';
          throw ae;
        }
        return realFetch(input, init);
      },
      abortAll: function () { abortedFlag = true; },
      reset: function () { abortedFlag = false; },
      activeCount: function () { return 0; }
    };
    window.fetch = function (input, init) { return fetchManager.fetch(input, init); };
  }

  function readFormSettings() {
    settings.provider = $('cfg-provider').value;
    settings.baseUrl = $('cfg-base').value.trim();
    settings.model = $('cfg-model').value.trim();
    settings.maxTokens = Math.min(384000, Math.max(4096, parseInt($('cfg-max').value, 10) || 384000));
    settings.thinking = $('cfg-thinking').value;
    settings.thinkingPrefSet = true;
    settings.thinkingJson = $('cfg-thinking-json').value.trim() || settings.thinkingJson;
    settings.plain = $('opt-plain').checked;
    settings.readerGuide = $('opt-reader-guide').checked;
    settings.skipRosterConfirm = $('opt-skip-roster').checked;
    settings.depth = { verdict: $('depth-verdict').value, mainline: $('depth-mainline').value, clash: $('depth-clash').value };
    saveSettings();
  }
  // 官方供应商预设（只在 Web 配置层生效；Judge 内核只看最终 settings）。
  function providerPreset(v) { return PROVIDER_PRESETS[v] || null; }
  function providerReferenceText(p) {
    if (!p) return '';
    var bits = [TXT.setup.defaultModelPre + p.defaultModel];
    if (p.reference && p.reference.length) bits.push(TXT.setup.officialReferencePre + p.reference.join(' · '));
    return bits.join(' ｜ ');
  }
  function clearModelListPanel() {
    modelListItems = [];
    var panel = $('model-list-panel');
    if (panel) panel.style.display = 'none';
    if ($('model-list-items')) $('model-list-items').innerHTML = '';
    if ($('model-list-status')) $('model-list-status').textContent = '';
    if ($('model-list-search')) $('model-list-search').value = '';
  }
  function applyProviderPreset(useDefaultModel) {
    var v = $('cfg-provider').value;
    var p = providerPreset(v);
    var mock = v === 'mock';
    var custom = v === 'custom';
    if (p) {
      $('cfg-base').value = p.baseUrl;
      $('cfg-base').placeholder = p.baseUrl;
      if (useDefaultModel || !$('cfg-model').value.trim()) $('cfg-model').value = p.defaultModel;
      if (useDefaultModel && p.defaultMaxTokens) $('cfg-max').value = p.defaultMaxTokens;
      $('cfg-model').placeholder = p.defaultModel;
    }
    $('cfg-base').readOnly = !!p;
    $('cfg-base').disabled = mock;
    $('cfg-model').disabled = mock;
    $('cfg-max').disabled = mock;
    $('cfg-thinking').disabled = mock;
    $('cfg-key').disabled = mock;
    $('custom-api-risk').style.display = custom ? 'block' : 'none';
    if (custom && $('transport-advanced')) $('transport-advanced').open = true;
    $('provider-default-hint').textContent = p ? providerReferenceText(p) : ''; 
    $('btn-query-models').style.display = p && p.modelsUrl ? 'inline-block' : 'none';
    syncProviderThinkingPolicy();
    syncThinkingJsonVisibility();
    clearModelListPanel();
  }
  function syncProviderThinkingPolicy() {
    var select = $('cfg-thinking');
    if (!select) return;
    var off = select.querySelector('option[value="off"]');
    var isK3 = $('cfg-provider').value === 'kimi' && /^kimi-k3(?:$|-)/i.test($('cfg-model').value.trim());
    if (off) off.disabled = isK3;
    if (isK3 && select.value === 'off') select.value = 'on';
  }
  function syncThinkingJsonVisibility() {
    var custom = $('cfg-thinking').value === 'custom';
    $('thinking-json-field').style.display = custom ? 'block' : 'none';
    if (custom && $('transport-advanced')) $('transport-advanced').open = true;
  }
  // W-T6：外部白话字典状态行（已加载 N 词条 / 未加载）
  function syncPlainDictStatus() {
    var el = $('plain-dict-status');
    if (!el) return;
    if (settings.plainDictExt && String(settings.plainDictExt).trim()) {
      try {
        var n = Object.keys(JSON.parse(settings.plainDictExt)).length;
        el.textContent = TXT.setup.plainDictLoadedPre + n + TXT.setup.plainDictLoadedTail;
      } catch (e) { el.textContent = TXT.setup.plainDictNone; }
    } else {
      el.textContent = TXT.setup.plainDictNone;
    }
  }
  function formatModelDate(v) {
    if (v == null || v === '') return '';
    var n = Number(v);
    if (isFinite(n) && n > 1000000000) {
      try { return new Date(n * 1000).toISOString().slice(0, 10); } catch (e) {}
    }
    return String(v);
  }
  function modelMetaParts(item) {
    var parts = [];
    if (item.context_length != null) parts.push('上下文：' + fmtTokenCount(item.context_length));
    if (item.max_output_tokens != null) parts.push('最大输出：' + fmtTokenCount(item.max_output_tokens));
    if (item.max_completion_tokens != null) parts.push('最大输出：' + fmtTokenCount(item.max_completion_tokens));
    if (item.supports_reasoning != null) parts.push('推理：' + (item.supports_reasoning ? '支持' : '不支持'));
    if (item.supports_image_in != null) parts.push('图片输入：' + (item.supports_image_in ? '支持' : '不支持'));
    if (item.supports_video_in != null) parts.push('视频输入：' + (item.supports_video_in ? '支持' : '不支持'));
    if (item.owned_by) parts.push('所属：' + item.owned_by);
    if (item.created != null) parts.push('创建：' + formatModelDate(item.created));
    if (item.shutdown_date != null) parts.push('停用：' + formatModelDate(item.shutdown_date));
    Object.keys(item || {}).sort().forEach(function (k) {
      if (!/^supports_/.test(k) || ['supports_reasoning','supports_image_in','supports_video_in'].indexOf(k) >= 0) return;
      var v = item[k];
      if (typeof v === 'boolean') parts.push(k + '：' + (v ? '支持' : '不支持'));
    });
    return parts;
  }
  function renderModelList(filterText) {
    var box = $('model-list-items');
    if (!box) return;
    var q = String(filterText || '').trim().toLowerCase();
    var rows = modelListItems.filter(function (m) { return !q || String(m.id || '').toLowerCase().indexOf(q) >= 0; });
    if (!rows.length) {
      box.innerHTML = '<div class="hint">' + TXT.setup.modelListEmpty + '</div>';
      return;
    }
    box.innerHTML = rows.map(function (m) {
      var id = String(m.id || '');
      var meta = modelMetaParts(m);
      return '<div class="model-list-row" style="padding:8px 9px;border:1px solid var(--line);border-radius:8px">' +
        '<div style="display:flex;align-items:center;gap:8px;justify-content:space-between;flex-wrap:wrap">' +
        '<code style="font-size:13px;user-select:text;overflow-wrap:anywhere">' + esc(id) + '</code>' +
        '<span style="display:flex;gap:6px"><button class="btn small model-use" type="button" data-model="' + esc(id) + '">' + TXT.setup.modelUse + '</button>' +
        '<button class="btn small model-copy" type="button" data-model="' + esc(id) + '">' + TXT.setup.modelCopy + '</button></span></div>' +
        (meta.length ? '<div class="hint" style="margin-top:5px">' + meta.map(esc).join(' · ') + '</div>' : '') +
        '</div>';
    }).join('');
  }
  function copyModelText(text, button) {
    function done() {
      if (!button) return;
      var old = button.textContent;
      button.textContent = TXT.setup.modelCopied;
      setTimeout(function () { button.textContent = old; }, 1200);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () {});
      return;
    }
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) {}
    document.body.removeChild(ta);
  }
  function queryProviderModels() {
    var provider = $('cfg-provider').value;
    var p = providerPreset(provider);
    var panel = $('model-list-panel');
    var status = $('model-list-status');
    if (!p || !p.modelsUrl) {
      panel.style.display = 'block';
      status.textContent = TXT.setup.modelListUnsupported;
      modelListItems = [];
      renderModelList('');
      return;
    }
    if (!API_KEY) {
      panel.style.display = 'block';
      status.textContent = TXT.setup.modelListNeedKey;
      modelListItems = [];
      renderModelList('');
      return;
    }
    panel.style.display = 'block';
    $('model-list-title').textContent = p.label + ' · ' + TXT.setup.modelListTitle;
    status.textContent = TXT.setup.modelListLoading;
    $('model-list-items').innerHTML = '';
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 20000);
    (NATIVE_FETCH || window.fetch)(p.modelsUrl, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + API_KEY },
      signal: ctrl.signal
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (payload) {
      clearTimeout(timer);
      modelListItems = payload && Array.isArray(payload.data) ? payload.data.filter(function (m) { return m && typeof m.id === 'string' && m.id; }) : [];
      status.textContent = modelListItems.length ? ('共 ' + modelListItems.length + ' 个模型') : TXT.setup.modelListEmpty;
      renderModelList($('model-list-search').value);
    }).catch(function (e) {
      clearTimeout(timer);
      modelListItems = [];
      status.textContent = TXT.setup.modelListFail + (e && e.message ? e.message : String(e));
      renderModelList('');
    });
  }
  function syncSettingsToForm() {
    $('cfg-provider').value = settings.provider || 'deepseek';
    $('cfg-base').value = settings.baseUrl || '';
    $('cfg-model').value = settings.model || 'deepseek-v4-flash';
    $('cfg-max').value = settings.maxTokens || 384000;
    $('cfg-thinking').value = settings.thinking || 'on';
    $('cfg-thinking-json').value = settings.thinkingJson || '{"thinking":{"type":"enabled"},"thinking_budget":4096}';
    $('opt-plain').checked = !!settings.plain;
    $('opt-reader-guide').checked = settings.readerGuide !== false;
    $('opt-skip-roster').checked = !!settings.skipRosterConfirm;
    syncPlainDictStatus();
    $('depth-verdict').value = settings.depth.verdict || '标准';
    $('depth-mainline').value = settings.depth.mainline || '标准全景图';
    $('depth-clash').value = settings.depth.clash || '标准5-8个';
    syncApiKeyForProvider($('cfg-provider').value);
    applyProviderPreset(false);
    renderTendency();
    syncJudgeContextToForm();
  }

  async function startRun(opts) {
    opts = opts || {};
    var transcript = $('transcript').value;
    // 历史续跑的辩词权威 = 该会话已保存的 .tmp-debate.txt。页面编辑框可能残留其它上传/粘贴内容，
    // 不能让它污染 resume；若用户要分析另一份辩词，应走“新建分析”而不是复用旧 workDir。
    // C4：readDebateCopy 缺失返回 null，存在即返回内容（可为空串，与原文 existsSync 语义等价）。
    var resumeText = opts.resumeDir && engine ? engine.readDebateCopy(opts.resumeDir) : null;
    if (resumeText !== null) {
      transcript = resumeText;
      $('transcript').value = transcript;
    }
    if (!transcript.trim()) { alert(TXT.alert.noTranscript); return; }
    if (!commitJudgeContextFromForm(true)) return;
    readFormSettings();
    if (settings.provider !== 'mock' && !API_KEY) { alert(TXT.alert.noKey); return; }

    // “本次累计”每次启动从 0 计；“本场累计”以同一 workDir 的历史持久值为基线。
    // 旧会话没有 estimatedTokensTotal 时，尝试用 Flight Recorder 同 workDir 的正文/思考字数按同一估算公式回填；
    // 若两者同时存在则取较大值，补上异常关闭时可能尚未来得及写入 session checkpoint 的已接收响应。
    sessionEstimatedTokensBase = 0;
    if (opts.resumeDir) {
      try {
        var priorRec = await idbGet(opts.resumeDir);
        var storedTotal = priorRec && priorRec.estimatedTokensTotal != null ? Number(priorRec.estimatedTokensTotal) : 0;
        if (!isFinite(storedTotal) || storedTotal < 0) storedTotal = 0;
        var recordedTotal = await estimateRecordedSessionTokens(opts.resumeDir);
        sessionEstimatedTokensBase = Math.max(storedTotal, Number(recordedTotal) || 0);
      } catch (tokenRestoreErr) {
        sessionEstimatedTokensBase = 0;
      }
    }

    // 非 auto 定点续跑：任何 rewind / 新 epoch 之前，先把当前正式终态固化为不可变只读版本。
    // snapshot 失败直接返回；此时 running=false、旧 FINAL/R* 未动、engine.runSession 尚未进入，因此 paid request=0。
    var resumeStartNode = opts.resumeStartNode || 'auto';
    if (opts.resumeDir && resumeStartNode !== 'auto') {
      try {
        var versionSession = await idbGet(opts.resumeDir);
        var versionFiles = await getSessionFilesReadOnly(opts.resumeDir);
        if (!versionSession || !versionFiles) throw new Error('缺少可归档的正式历史终态');
        var savedVersion = await idbCreateSessionVersionSnapshot(versionSession, versionFiles);
        opts.resumeVersionId = savedVersion.versionId;
      } catch (versionErr) {
        alert('定点续跑未启动：旧版本归档失败。' + (versionErr && versionErr.message ? versionErr.message : versionErr));
        return;
      }
    }

    pendingResume = null;
    setResumeReadyState(false);
    invalidateReportRoute();
    running = true;
    setRunCloseWarningActive(true);
    if (fetchManager) fetchManager.reset();   // W-T10：新运行重置粘性标志（上次中止不影响本次）
    abortController = new AbortController();
    $('btn-run').disabled = true;
    $('btn-stop').disabled = false;
    $('btn-sessions').disabled = true;
    $('logbox').innerHTML = '';
    roundState = {};
    if (!settings.plain) roundState.R7 = 'skipped';
    if (settings.readerGuide !== true) roundState.R8 = 'skipped';
    setTribunalCurrentRound(roundSteps()[0], '准备裁决');
    retryCount = 0;
    anchorLabel = '';
    persistFileBase = null;   // C5：本 run 内存基线重置（BASE 首写时初始化）
    showScene('run');
    renderTimeline(null);
    $('run-status').textContent = TXT.run.statusRunning;
    // 活性指示：1s 心跳计时器（字数/耗时实时跳动，证明没卡死）
    liveProgress = null;
    liveLastAt = Date.now();
    runStartAt = Date.now();
    runEstimatedTokensCommitted = 0;
    if (runTimer) clearInterval(runTimer);
    runTimer = setInterval(updateLiveIndicator, 1000);
    updateLiveIndicator();

    try {
      var res = await engine.runSession({
        speech: transcript,
        // C3（260815）：投影块删除——settings 模块全局浅拷贝 + apiKey 并入（A1：settings 无 apiKey 键，
        // 独立变量 API_KEY；直传会丢 Authorization；浅拷贝隔离 theme/thinkingPrefSet 等非 engine 字段）
        settings: Object.assign({}, settings, { apiKey: API_KEY }),
        force: !!opts.force,
        resumeDir: opts.resumeDir || null,
        resumeStartNode: opts.resumeStartNode || 'auto',
        abortSignal: abortController.signal,   // W-T10：引擎层中止信号（apiStub 前置检查 + P3-1 进行中请求合并）
        onLog: logLine,
        onRoster: function (info) {
          anchorLabel = TXT.run.anchorLoaded;
          if (info.anchor) {
            if (info.anchor.typeA || info.anchor.typeB) logLine(TXT.run.anchorAbnormal + (info.anchor.typeA ? TXT.run.anchorAbnormalA : '') + (info.anchor.typeB ? TXT.run.anchorAbnormalB : '') + TXT.run.anchorAbnormalTail);
            logLine(TXT.run.anchorExtracted + (info.anchor.title || TXT.run.anchorUnknownTitle) + TXT.run.anchorExtractedTail +
              TXT.run.anchorSides + (info.anchor.roster.filter(function (r) { return r.side === '正方'; }).length) + TXT.run.anchorVs +
              (info.anchor.roster.filter(function (r) { return r.side === '反方'; }).length) + TXT.run.anchorWait);
          }
          return new Promise(function (resolve) { showRosterModal(info.anchor, info.workDir, resolve); });
        },
        onRound: function (r) {
          commitLiveEstimate();
          liveProgress = null;   // 每轮结束先结算当前 API attempt，再重置为下一轮自己的遥测
          liveLastAt = Date.now();
          if (r.gate) { retryCount++; }
          if (r.ok && r.skipped) { markRound(r.round, 'skipped'); activateNextTribunalRound(r.round); logLine(TXT.run.logSkip + r.round + TXT.run.logSkipTail); }
          else if (r.ok) { markRound(r.round, 'done'); activateNextTribunalRound(r.round); logLine(TXT.run.logDone + r.round + TXT.run.logDoneTail); }
          else {
            markRound(r.round, 'fail');
            var post = !!r.postprocess;
            var detail = r.errors && r.errors.length ? '：' + r.errors.join('; ') : '';
            setTribunalCurrentRound(r.round, post ? '处理失败' : '门禁失败');
            logLine(TXT.run.logFail + r.round + (post ? TXT.run.logPostFailTail : TXT.run.logFailTail) + detail);
          }
        },
        onStage: function (s) {
          if (!s || !s.stage) return;
          if (s.state === 'active') {
            roundState[s.stage] = 'active';
            setTribunalCurrentRound(s.stage, '处理中');
          } else if (s.state === 'done') {
            markRound(s.stage, 'done');
            activateNextTribunalRound(s.stage);
            logLine(TXT.run.logDone + s.stage + TXT.run.logDoneTail);
          } else if (s.state === 'fail') {
            markRound(s.stage, 'fail');
            setTribunalCurrentRound(s.stage, '处理失败');
            logLine(TXT.run.logFail + s.stage + TXT.run.logPostFailTail + (s.errors && s.errors.length ? '：' + s.errors.join('; ') : ''));
          }
        },
        persist: function (step, payload) {
          var dir = payload && payload.workDir ? payload.workDir : null;
          if (dir && !currentSession) currentSession = { dir: dir, title: dir.split('/').pop(), createdAt: new Date().toISOString() };
          // W-T5（U6，R7-A2）：persist 钩子 = rec.run 唯一写入口——pipeline-done/error 两时点带 patch（含 !res.ok 门禁耗尽失败路径——
          // engine L313-315 在 !res.ok 时也调 persist('pipeline-done')，无 L1188-1190 分支补写）；round-done/start 不带 patch（不写 rec.run）
          // C5：filesOp 三态——base（起始基线）/ round（轮级增量）/ final（终态全量 + 清轮级）
          if (step === 'pipeline-start') {
            // Flight Recorder 只在正式真实 API run 绑定；同步旁路，不 await、不进入 Judge persist 结果。
            if (flightRecorder && settings.provider !== 'mock') {
              try { flightRecorder.bindRun({ workDir: dir, provider: settings.provider, baseUrl: settings.baseUrl, model: settings.model }); } catch (e) { noteFlightRecorderWarning(e.message || e); }
            }
            return persistSession(dir, { filesOp: 'base', resumeEpoch: !!opts.resumeDir }).then(function (ok) {
              if (ok) scheduleHistoryLimit(dir);   // BASE 成功后才旁路治理；不 await 淘汰，不阻塞 Judge 分析。
              return ok;
            });
          }
          if (step === 'plain-batch-checkpoint') {
            // durability barrier 依赖真实 boolean 结果；这里不得 catch/吞掉 false。
            // PLAIN v4 semantic phases 没有 batch index，必须显式路由，不能落入旧 plain-batch 分支。
            var checkpointPhase = payload && payload.phase;
            if (checkpointPhase === 'review' || checkpointPhase === 'approved' || checkpointPhase === 'repair-draft') {
              return persistSession(dir, { filesOp: 'plain-state', phase: checkpointPhase });
            }
            if (checkpointPhase === 'r8-guide-draft' || checkpointPhase === 'r8-core-cache' || checkpointPhase === 'r8-plain-draft' ||
                checkpointPhase === 'r8-plain-review' || checkpointPhase === 'r8-plain-repair-draft') {
              return persistSession(dir, { filesOp: 'r8-checkpoint', phase: checkpointPhase });
            }
            return persistSession(dir, { filesOp: 'plain-batch', batchIndex: payload && payload.index });
          }
          if (step === 'round-done') return persistSession(dir, { filesOp: 'round', roundName: payload && payload.round ? payload.round.round : null });
          if (step === 'pipeline-done' || step === 'pipeline-error') {
            if (flightRecorder && settings.provider !== 'mock') {
              try {
                var frStatus = step === 'pipeline-error' ? ((payload && payload.aborted) ? 'aborted' : 'failed') : ((payload && payload.ok) ? 'done' : 'failed');
                flightRecorder.finishRun(frStatus);
              } catch (e2) { noteFlightRecorderWarning(e2.message || e2); }
            }
            return persistSession(dir, { filesOp: 'final', runModel: payload && payload.runModel });
          }
          return persistSession(dir).catch(function () {});
        }
      });

      if (res.aborted) {
        $('run-status').textContent = TXT.run.statusAborted;
        logLine(TXT.run.logAborted);
      } else if (!res.ok) {
        $('run-status').textContent = TXT.run.statusFailed;
        logLine(TXT.run.logPipelineFail + (res.error || TXT.run.gateBlocked));
      } else {
        $('run-status').textContent = TXT.run.statusDone;
        currentSession = { dir: res.workDir, title: res.workDir.split('/').pop(), createdAt: new Date().toISOString() };
        // terminal FINAL 已由 engine 的必达 persist hook 原子提交；UI 只投影结果，禁止第二次独立写盘制造新的半提交窗口。
        refreshSessionList();
        if (res.reportHtml) {
          showReport(res.reportHtml, res.workDir);
          logLine(TXT.run.logReportDone + res.reportFile + '（' + fmtBytes(res.reportHtml.length) + '）');
        } else {
          logLine(TXT.run.logReportMissing);
        }
      }
    } catch (e) {
      $('run-status').textContent = TXT.run.statusException;
      var emsg = e && e.message ? e.message : String(e);
      logLine(TXT.run.logException + emsg);
      var hint = apiErrorHint(emsg);
      if (hint) logLine(TXT.run.logHint + hint);
    } finally {
      commitLiveEstimate();
      if (runTimer) { clearInterval(runTimer); runTimer = null; }
      updateLiveIndicator();   // running 仍为 true：结束前把最终字符/Token累计写回可见文本与 data-* 只读投影
      running = false;
      setRunCloseWarningActive(false);
      refreshReportRouteActions();
      $('btn-run').disabled = false;
      $('btn-stop').disabled = true;
      $('btn-sessions').disabled = false;
    }
  }

  function stopRun() {
    if (!running) return;
    logLine(TXT.run.logStopRequest);
    if (fetchManager) fetchManager.abortAll();
    if (abortController) abortController.abort();
  }
  function startPreparedResume() {
    if (!pendingResume || running) return;
    var pending = { dir: pendingResume.dir, startNode: pendingResume.startNode || 'auto' };
    startRun({ resumeDir: pending.dir, force: false, resumeStartNode: pending.startNode || 'auto' });
  }

  // ================= 上传 / 文件 =================
  function setupUpload() {
    var uz = $('upload-zone');
    var fi = $('file-input');
    uz.addEventListener('click', function () { fi.click(); });
    uz.addEventListener('dragover', function (e) { e.preventDefault(); uz.classList.add('drag'); });
    uz.addEventListener('dragleave', function () { uz.classList.remove('drag'); });
    uz.addEventListener('drop', function (e) {
      e.preventDefault(); uz.classList.remove('drag');
      if (e.dataTransfer.files.length) readFiles(e.dataTransfer.files);
    });
    fi.addEventListener('change', function (e) { if (e.target.files.length) readFiles(e.target.files); });
    $('transcript').addEventListener('input', function () { updateTokenWarn(); });
  }
  function refreshUploadConfigSummary() {
    var el = $('upload-config-summary');
    if (!el) return;
    var providerEl = $('cfg-provider'), modelEl = $('cfg-model'), thinkingEl = $('cfg-thinking');
    var provider = providerEl && providerEl.selectedIndex >= 0 ? providerEl.options[providerEl.selectedIndex].text : String(settings.provider || '');
    var model = modelEl ? modelEl.value.trim() : String(settings.model || '');
    var thinking = thinkingEl && thinkingEl.selectedIndex >= 0 ? thinkingEl.options[thinkingEl.selectedIndex].text : String(settings.thinking || '');
    var plain = $('opt-plain') && $('opt-plain').checked ? '白话：开' : '白话：关';
    var guide = $('opt-reader-guide') && $('opt-reader-guide').checked ? '导览：开' : '导览：关';
    var depth = [];
    for (var i = 0; i < ['depth-verdict','depth-mainline','depth-clash'].length; i++) {
      var d = $(['depth-verdict','depth-mainline','depth-clash'][i]);
      if (d) depth.push(d.value);
    }
    el.textContent = provider + ' · ' + model + '\n' + thinking + ' · ' + plain + ' · ' + guide + '\n深度：' + depth.join(' / ') + '\n倾向：' + tendencySummaryText() + '\n额外设定：' + contextSummaryText();
  }
  function renderUploadFileList(files) {
    var el = $('upload-file-list');
    if (!el) return;
    var arr = Array.prototype.slice.call(files || []);
    if (!arr.length) { el.textContent = TXT.upload.noFiles; return; }
    el.innerHTML = '';
    arr.forEach(function (f) {
      var row = document.createElement('div');
      row.className = 'submission-file-row';
      row.textContent = String(f.name || '未命名文件') + ' · ' + fmtBytes(Number(f.size) || 0);
      el.appendChild(row);
    });
  }
  function readFiles(files) {
    renderUploadFileList(files);
    var pending = Array.prototype.slice.call(files);
    var allText = '';
    var errors = [];
    function next() {
      var f = pending.shift();
      if (!f) {
        if (allText) { $('transcript').value = allText; $('file-info').style.display = 'block'; $('file-info').textContent = TXT.files.loaded + (allText.length / 1024).toFixed(1) + TXT.files.loadedTail; updateTokenWarn(); }
        if (errors.length) alert(TXT.files.readFail + errors.join('\n'));
        return;
      }
      var ext = f.name.split('.').pop().toLowerCase();
      var reader = new FileReader();
      reader.onload = function (e) { allText += '--- ' + f.name + ' ---\n' + e.target.result + '\n\n'; next(); };
      reader.onerror = function () { errors.push(f.name); next(); };
      if (['txt', 'md', 'json', 'csv', 'srt', 'vtt', 'sbv', 'html', 'xml'].indexOf(ext) > -1) {
        reader.readAsText(f, 'UTF-8');
      } else if (ext === 'docx') {
        loadCdn('https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js', 'mammoth', function (ok) {
          if (!ok) { errors.push(f.name + TXT.files.needLib); next(); return; }
          var r2 = new FileReader();
          r2.onload = function (e) {
            mammoth.extractRawText({ arrayBuffer: e.target.result }).then(function (r) { allText += '--- ' + f.name + ' ---\n' + r.value + '\n\n'; next(); })
              .catch(function () { errors.push(f.name); next(); });
          };
          r2.readAsArrayBuffer(f);
        });
      } else if (ext === 'pdf') {
        loadCdn('https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js', 'pdfjsLib', function (ok) {
          if (!ok) { errors.push(f.name + TXT.files.needLib); next(); return; }
          pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
          var r2 = new FileReader();
          r2.onerror = function () { errors.push(f.name); next(); };
          r2.onload = function (e) {
            pdfjsLib.getDocument({ data: e.target.result }).promise.then(function (pdf) {
              if (!pdf.numPages) { errors.push(f.name + TXT.files.pdfEmpty); next(); return; }
              var pages = new Array(pdf.numPages), loaded = 0;
              for (var i = 1; i <= pdf.numPages; i++) {
                (function (idx) {
                  pdf.getPage(idx).then(function (page) { return page.getTextContent(); }).then(function (tc) {
                    pages[idx - 1] = tc.items.map(function (it) { return it.str; }).join(' ');
                  }).catch(function () {
                    pages[idx - 1] = '';
                  }).then(function () {
                    loaded++;
                    if (loaded === pdf.numPages) {
                      var txt = pages.filter(function (s) { return s && s.trim(); }).join('\n\n');
                      if (txt) { allText += '--- ' + f.name + ' ---\n' + txt + '\n\n'; }
                      else { errors.push(f.name + TXT.files.pdfBlank); }
                      next();
                    }
                  });
                })(i);
              }
            }).catch(function () { errors.push(f.name); next(); });
          };
          r2.readAsArrayBuffer(f);
        });
      } else { errors.push(f.name + TXT.files.unsupported); next(); }
    }
    next();
  }
  function loadCdn(url, globalName, cb) {
    if (window[globalName]) { cb(true); return; }
    var s = document.createElement('script');
    s.src = url;
    s.onload = function () { cb(!!window[globalName]); };
    s.onerror = function () { cb(false); };
    document.head.appendChild(s);
  }
  function updateTokenWarn() {
    var len = $('transcript').value.length;
    var est = estTokens(len);
    var warn = $('token-warn');
    if (est > 30000) { warn.style.display = 'block'; $('token-warn-n').textContent = Math.round(est / 1000); }
    else warn.style.display = 'none';
  }

  // ================= 连通性测试 =================
  function testApi() {
    readFormSettings();
    if (settings.provider === 'mock') {
      var el0 = $('api-test-result');
      el0.textContent = TXT.api.mockNoTest;
      el0.style.color = 'var(--green)';
      return;
    }
    var base = settings.baseUrl.replace(/\/+$/, '');
    var preset = providerPreset(settings.provider);
    var el = $('api-test-result');
    el.textContent = TXT.api.testing;
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 20000);
    var headers = { 'Content-Type': 'application/json' };
    if (API_KEY) headers['Authorization'] = 'Bearer ' + API_KEY;
    var url = preset && preset.modelsUrl ? preset.modelsUrl : base + '/models';
    var init = { method: 'GET', headers: headers, signal: controller.signal };
    // GLM 当前没有经官方文档确认的 /models；用 1 token 的官方 Chat Completions 探针验证 Key/端点/模型，避免误报。
    if (settings.provider === 'glm') {
      url = preset.baseUrl.replace(/\/+$/, '') + '/chat/completions';
      init = {
        method: 'POST', headers: headers, signal: controller.signal,
        body: JSON.stringify({ model: settings.model, messages: [{ role: 'user', content: 'OK' }], max_tokens: 1, stream: false, thinking: { type: 'disabled' } })
      };
    }
    (NATIVE_FETCH || window.fetch)(url, init)
      .then(function (r) {
        clearTimeout(timer);
        if (r.ok) { el.textContent = TXT.api.ok + r.status + TXT.api.okTail; el.style.color = 'var(--green)'; }
        else { el.textContent = TXT.api.warn + r.status + TXT.api.warnTail; el.style.color = 'var(--gold)'; }
      })
      .catch(function (e) {
        clearTimeout(timer);
        el.textContent = TXT.api.fail + (e && e.message ? e.message : e) + TXT.api.failTail;
        el.style.color = 'var(--red)';
      });
  }

  // ================= 主题 =================
  function applyTheme() {
    if (settings.theme === 'light') {
      document.body.classList.add('sanctum-light');
      $('btn-theme').textContent = TXT.top.themeLight;
    } else {
      document.body.classList.remove('sanctum-light');
      $('btn-theme').textContent = TXT.top.themeDark;
    }
    if (reportHost) reportHost.setTheme(settings.theme);
  }

  // ================= 倾向说明弹窗 =================
  function showTendHelp() {
    var ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="tend-help-title">' +
      '<h2 id="tend-help-title">' + TXT.tend.helpTitle + '</h2>' +
      '<div style="font-size:13px;line-height:1.9">' +
      TXT.tend.helpP1 + TXT.tend.helpP2 + TXT.tend.helpP3 + TXT.tend.helpP4 + TXT.tend.helpP5 +
      '</div>' +
      '<div class="modal-btns"><button class="btn primary" id="help-close">' + TXT.tend.helpClose + '</button></div></div>';
    document.body.appendChild(ov);
    registerTransientLayer(ov, function () { removeTransientLayer(ov); });
    $('help-close').onclick = function () { removeTransientLayer(ov); };
  }

  function importSessionFromFile() {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json';
    inp.onchange = function (e) {
      var f = e.target.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function (ev) {
        try {
          var payload = JSON.parse(ev.target.result);
          if (payload.kind !== 'judge-web-session-v1' || !payload.workDir || !payload.files) { alert(TXT.sess.notValid); return; }
          if (!engine) initEngine();
          engine.restoreSession(payload.files);
          settings = normalizeSettingsKeys(payload.settings) || settings;
          syncSettingsToForm();
          currentSession = { dir: payload.workDir, title: payload.workDir.split('/').pop(), createdAt: payload.exportedAt };
          persistSession(payload.workDir, { filesOp: 'final' }).then(function (ok) {
            if (!ok) throw new Error('导入会话持久化失败');
            return idbGet(payload.workDir).then(function (rec) {
              if (rec && !rec.run) return migrateSession(rec);
              return null;
            });
          }).then(function () {
            scheduleHistoryLimit();
            refreshHistoryManager();
            alert(TXT.sess.imported + payload.workDir + TXT.sess.importedTail);
          }).catch(function (err) { alert(TXT.sess.importFailed + (err && err.message ? err.message : err)); });
        } catch (err) { alert(TXT.sess.importFailed + err.message); }
      };
      r.readAsText(f, 'UTF-8');
    };
    inp.click();
  }

  // ================= Back：Transient UI → Scene → Coach Route =================
  function isMobileReportOutlineOpen() {
    var outline = $('report-outline');
    return !!(currentScene === 'report' && outline && window.matchMedia && window.matchMedia('(max-width: 767px)').matches && !outline.classList.contains('report-outline-collapsed'));
  }
  function openMobileReportOutline() {
    if (currentScene !== 'report' || !window.matchMedia || !window.matchMedia('(max-width: 767px)').matches) return false;
    var outline = $('report-outline');
    var sections = $('report-sections-toggle');
    if (!outline) return false;
    setReportOutlineOpen(true);
    outline.setAttribute('role', 'dialog');
    outline.setAttribute('aria-modal', 'true');
    outline.setAttribute('tabindex', '-1');
    if (sections) sections.setAttribute('aria-expanded', 'true');
    setTimeout(function () {
      var first = transientFocusables(outline)[0] || outline;
      if (first && first.focus) first.focus();
    }, 0);
    return true;
  }
  function closeMobileReportOutline() {
    if (!isMobileReportOutlineOpen()) return false;
    var outline = $('report-outline');
    var sections = $('report-sections-toggle');
    setReportOutlineOpen(false);
    outline.removeAttribute('role');
    outline.removeAttribute('aria-modal');
    outline.removeAttribute('tabindex');
    if (sections) { sections.setAttribute('aria-expanded', 'false'); if (sections.focus) sections.focus(); }
    return true;
  }
  function consumeReportTransientUI() {
    if (currentScene !== 'report') return false;
    var menu = $('report-export-menu');
    if (menu && menu.open) {
      menu.open = false;
      var summary = menu.querySelector && menu.querySelector('summary');
      if (summary && summary.focus) summary.focus();
      return true;
    }
    if (closeMobileReportOutline()) return true;
    return false;
  }
  function navigateJudgeBack() {
    if (consumeTopTransientLayer()) return true;
    if (currentScene === 'report') {
      if (consumeReportTransientUI()) return true;
      if (consumeReportNavigationBack()) return true;
      showScene('run'); return true;
    }
    if (currentScene === 'run') {
      if (running) {
        if (confirm(TXT.alert.abortRun)) {
          stopRun();
          showScene('upload');
        }
        return true; // 用户取消 Abort 仍已消费本次 Back，绝不能继续退出 Coach route。
      }
      pendingResume = null;
      setResumeReadyState(false);
      showScene('upload');
      return true;
    }
    if (currentScene === 'upload') { showScene('setup'); return true; }
    if (currentScene === 'setup') { showScene('gate'); return true; }
    if (currentScene === 'gate') return false;
    return false;
  }
  window.DCHandleBack = navigateJudgeBack;

  // ================= 绑定 =================
  function bind() {
    document.querySelectorAll('.card-h').forEach(function (h) {
      h.addEventListener('click', function () { h.parentNode.classList.toggle('closed'); });
    });
    $('btn-theme').onclick = function () {
      settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
      saveSettings(); applyTheme();
    };
    $('btn-clear-cache').onclick = function () {
      if (confirm(TXT.alert.clearCache)) {
        localStorage.removeItem(LS_KEY);
        localStorage.removeItem('judge_web_settings_v7');
        localStorage.removeItem('judge_web_settings_v6');
        localStorage.removeItem('judge_web_settings_v5');
        localStorage.removeItem(API_KEYS_LS_KEY);
        localStorage.removeItem('judge_web_api_key');
        location.reload();
      }
    };
    $('btn-tend-reset').onclick = function () {
      for (var i = 0; i < TEND_DIMS.length; i++) settings.tendencyWeights[TEND_DIMS[i]] = 50;
      for (var j = 0; j < TEND_DIM_KEYS.length; j++) settings.dimWeights[TEND_DIM_KEYS[j]] = 0;
      settings.temperature = 0.3;
      saveSettings(); renderTendency();
    };
    $('btn-tend-help').onclick = showTendHelp;
    $('btn-tend-profile-local').onclick = applyLocalTendencyProfile;
    $('btn-tend-profile-file').onclick = function () { $('cfg-tend-profile').click(); };
    $('cfg-tend-profile').addEventListener('change', function (e) {
      var f = e.target.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function (ev) {
        try { applyTendencyProfilePayload(JSON.parse(String(ev.target.result || ''))); }
        catch (err) { alert(TXT.setup.tendProfileInvalid + err.message); }
        $('cfg-tend-profile').value = '';
      };
      r.readAsText(f, 'UTF-8');
    });
    $('btn-test-api').onclick = testApi;
    $('btn-query-models').onclick = queryProviderModels;
    $('model-list-search').addEventListener('input', function () { renderModelList(this.value); });
    $('model-list-items').addEventListener('click', function (e) {
      var use = e.target.closest && e.target.closest('.model-use');
      var copy = e.target.closest && e.target.closest('.model-copy');
      var btn = use || copy;
      if (!btn) return;
      var id = btn.getAttribute('data-model') || '';
      if (!id) return;
      if (use) {
        $('cfg-model').value = id;
        syncProviderThinkingPolicy();
        readFormSettings();
      } else {
        copyModelText(id, btn);
      }
    });
    $('cfg-key').addEventListener('input', function () { setApiKey(this.value.trim()); });
    $('cfg-model').addEventListener('input', syncProviderThinkingPolicy);
    $('cfg-thinking').addEventListener('change', syncThinkingJsonVisibility);
    ['ctx-enabled','ctx-use-mode','ctx-background-mode','ctx-familiarity','ctx-perspective','ctx-domains','ctx-values'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        updateJudgeContextEnabledState();
        commitJudgeContextFromForm(false);
      });
    });
    $('ctx-note').addEventListener('blur', function () { commitJudgeContextFromForm(false); });
    // W-T6：外部白话字典上传/清除
    $('cfg-plain-dict').addEventListener('change', function (e) {
      var f = e.target.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function (ev) {
        var raw = String(ev.target.result);
        try {
          var j = JSON.parse(raw);
          if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('非对象');
          if (Object.keys(j).length === 0) throw new Error('空对象');
          var vals = Object.keys(j).map(function (k) { return j[k]; });
          if (vals.some(function (v) { return typeof v !== 'string'; })) throw new Error('值非字符串');
          settings.plainDictExt = raw;
          saveSettings();
          syncPlainDictStatus();
          logLine(TXT.setup.plainDictLogPre + Object.keys(j).length + TXT.setup.plainDictLogTail);
        } catch (err) {
          alert(TXT.setup.plainDictInvalid);
        }
      };
      r.readAsText(f, 'UTF-8');
    });
    $('btn-plain-dict-clear').onclick = function () {
      settings.plainDictExt = null;
      $('cfg-plain-dict').value = '';
      saveSettings();
      syncPlainDictStatus();
    };
    $('cfg-provider').addEventListener('change', function () {
      var v = this.value;
      syncApiKeyForProvider(v);
      applyProviderPreset(true);
      $('api-test-result').textContent = '';
      if (v === 'mock') {
        $('api-test-result').textContent = TXT.api.mockNoKey;
        $('api-test-result').style.color = 'var(--green)';
      }
    });
    // ① 圣堂之门
    $('btn-gate-enter').onclick = function () { showScene('setup'); };
    $('btn-gate-leave').onclick = function () {
      $('gate-left-note').hidden = false;
      $('scene-gate').classList.add('closed');
    };
    $('btn-gate-reenter').onclick = function () {
      $('gate-left-note').hidden = true;
      $('scene-gate').classList.remove('closed');
    };
    // ②–⑤ 可见 Back 与 system Back 共用唯一 navigation seam。
    $('btn-back-setup').onclick = navigateJudgeBack;
    $('btn-next-setup').onclick = function () {
      if (!commitJudgeContextFromForm(true)) return;
      readFormSettings();
      refreshUploadConfigSummary();
      showScene('upload');
    };
    $('btn-back-upload').onclick = navigateJudgeBack;
    $('btn-run').onclick = function () { startRun({ force: false }); };
    $('btn-resume-run').onclick = startPreparedResume;
    $('btn-stop').onclick = stopRun;
    $('btn-return-report').onclick = returnToCurrentReport;
    $('btn-back-run').onclick = navigateJudgeBack;
    $('btn-report-run-log').onclick = openRunLogFromReport;
    $('btn-back-report').onclick = navigateJudgeBack;
    $('report-history').onclick = showHistoryManager;
    var reportScrollPending = false;
    window.addEventListener('scroll', function () {
      if (reportScrollPending || currentScene !== 'report' || !reportState.document || reportState.document.trust !== 'internal') return;
      reportScrollPending = true;
      requestAnimationFrame(function () { reportScrollPending = false; updateReportReadingState(); });
    }, { passive: true });
    $('report-plain-toggle').onclick = function () {
      if (!reportHost || !reportState.document || reportState.document.trust !== 'internal') return;
      var next = !reportPlainMode;
      if (reportHost.setPlain(next)) {
        reportPlainMode = next;
        this.setAttribute('aria-pressed', next ? 'true' : 'false');
        this.textContent = next ? '白话 · 切回原文' : '原文 · 切到白话';
        renderReportVerdictCover(reportHost.getSummary());
        renderReportOutline();
      }
    };
    $('report-theme-toggle').onclick = function () {
      if (!reportState.document || reportState.document.trust !== 'internal') return;
      settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
      saveSettings(); applyTheme();
    };
    $('report-sections-toggle').onclick = function () {
      var outline = $('report-outline');
      if (!outline) return;
      var mobile = !!(window.matchMedia && window.matchMedia('(max-width: 767px)').matches);
      if (mobile) {
        if (isMobileReportOutlineOpen()) closeMobileReportOutline();
        else openMobileReportOutline();
        return;
      }
      setReportOutlineOpen(outline.classList.contains('report-outline-collapsed'));
    };
    var reportOutlineMedia = window.matchMedia ? window.matchMedia('(max-width: 767px)') : null;
    if (reportOutlineMedia) {
      if (reportOutlineMedia.addEventListener) reportOutlineMedia.addEventListener('change', syncReportOutlineForViewport);
      else if (reportOutlineMedia.addListener) reportOutlineMedia.addListener(syncReportOutlineForViewport);
    }
    $('btn-clear').onclick = function () {
      if (running) return;
      $('transcript').value = '';
      $('file-input').value = '';
      renderUploadFileList([]);
      updateTokenWarn();
      $('file-info').style.display = 'none';
      invalidateReportRoute();
      roundState = {};
      renderTimeline(null);
      $('run-status').textContent = '';
      if (reportHost) { reportHost.destroy(); reportHost = null; }
    };
    $('btn-export-html').onclick = function () {
      var html = currentReportHtml();
      if (!html) { alert(TXT.report.noReport); return; }
      exportFile(TXT.report.fileHtml + tsName() + '.html', html, 'text/html', { kind: 'report-html', trust: reportState.document && reportState.document.trust });
    };
    $('btn-export-md').onclick = function () {
      var html = currentReportHtml();
      if (!html) { alert(TXT.report.noReport); return; }
      exportFile(TXT.report.fileMd + tsName() + '.md', stripHtml(html), 'text/markdown', { kind: 'report-md' });
    };
    $('btn-copy').onclick = function () {
      var html = currentReportHtml();
      if (!html) { alert(TXT.report.noReport); return; }
      navigator.clipboard.writeText(stripHtml(html)).then(function () { alert(TXT.report.copied); })
        .catch(function () { alert(TXT.report.copyFailed); });
    };
    $('btn-export-session').onclick = function () {
      var workDir = reportState.workDir;
      if (!workDir || !engine) { alert(TXT.sess.noSession); return; }
      var files = engine.snapshotSession(workDir, ['/input']);
      var payload = { kind: 'judge-web-session-v1', exportedAt: new Date().toISOString(), workDir: workDir, files: files, settings: settings };
      exportFile(TXT.sess.sessionFile + tsName() + '.json', JSON.stringify(payload, null, 2), 'application/json', { kind: 'report-session' });
    };
    $('btn-import-report').onclick = function () {
      var inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.html,.htm';
      inp.onchange = function (e) {
        var f = e.target.files[0];
        if (!f) return;
        var r = new FileReader();
        r.onload = function (ev) {
          var html = String(ev.target.result == null ? '' : ev.target.result);
          var importedDoc = reportHostMod.createReportDocument({ canonicalHtml: html, workDir: null, trust: 'external', sourceName: f.name || 'external.html' });
          showReportDocument(importedDoc);
        };
        r.readAsText(f, 'UTF-8');
      };
      inp.click();
    };
    $('btn-sessions').onclick = showHistoryManager;
  }

  function tsName() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  // 常见 API 错误分类提示（对齐青春版 streamChat 错误提示机制）
  function apiErrorHint(msg) {
    if (/402|余额|balance|insufficient|billing/i.test(msg)) return TXT.err.e402;
    if (/429|rate.?limit|quota|限流|频率/i.test(msg)) return TXT.err.e429;
    if (/401|403|invalid.*key|api key|authentication/i.test(msg)) return TXT.err.e401;
    if (/404/i.test(msg)) return TXT.err.e404;
    if (/CORS|cross-origin|Failed to fetch|NetworkError|network request failed/i.test(msg)) return TXT.err.eNet;
    return '';
  }

  // ================= 启动 =================
  function boot() {
    // 预览参数：?theme=light / ?theme=dark 仅本次生效（D4 静态预览用，不写缓存）
    var pm = /[?&]theme=(dark|light)/.exec(location.search);
    if (pm) settings.theme = pm[1];
    renderShell();
    initFlightRecorder();
    bind();
    applyTheme();
    syncSettingsToForm();
    setupUpload();
    updateTokenWarn();
    initEngine();               // C6：提前——migrateAll 依赖 engine（原 refreshSessionList 先于 initEngine 的惰性依赖移除）
    migrateAll().then(function () { scheduleHistoryLimit(); });   // 迁移完成后仅后台治理历史上限；历史 UI 按需打开
    // 风险页：每次打开/刷新一律先显示圣堂之门（不读取任何缓存标记）
    showScene('gate');
    console.log('[judge-web] 圣堂裁判所就绪 · 内核 ' + BUNDLE.modules.pipelineController().toString().length + ' 字节模块已装载');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
