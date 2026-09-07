// 双向投影 v1 生成器：扫描代码/注册表 → 输出 schemas/input-contract.json（单一事实源字典）
// 运行：node scripts/generate-input-contract.js [--write|--check]
// --write：落盘；--check：重新生成并与现有文件比对（幂等，供四方一致性测试）
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const PC = require(path.join(root, 'pipeline-controller.js'));
const { ROUNDS, R5_HALVES } = require(path.join(root, 'executor/core.js'));
// 卡 5（260815）：键形提取单一引擎（key-extract——消费侧/字典侧形态原语）
const KE = require('./key-extract.js');

function read(p) { return fs.readFileSync(path.join(root, p), 'utf-8'); }

// ---------- 1) DATA 键：渲染器 + 门禁字面消费 ----------
// 批 5（260812 P0-4）：五形态识别（字面量/(data||{})/in/模板静态展开）+ 变量分类（side→正方反方、q→Q1-Q4、
// 索引类跳过由补丁表覆盖）——防伪键（如 S14.教育洞察.正方.正方）入库（销账 M-2/B5）
// 卡 5（260815）：形态原语移入 key-extract 单一引擎（KE.scanDict*）；字典侧过滤器（S/R2.5/C7/C8）保留
function extractDataKeys(src) {
  const set = new Set();
  const add = k => { if (KE.dictKeyFilter(k)) set.add(k); };
  for (const { key } of KE.scanDictQuote(src)) add(key);
  for (const { key } of KE.scanDictOrEmpty(src)) add(key);
  for (const { key } of KE.scanDictInData(src)) add(key);
  // 契约键清单数组字面量（如 checkS1_S7 的 required=[...]——审计 B4 清单变量形态）
  for (const { match } of KE.scanDictArray(src)) {
    for (const km of match.matchAll(/['"]((?:S|R2\.5|C7|C8)[A-Za-z0-9_.\u4e00-\u9fa5]*)['"]/g)) add(km[1]);
  }
  for (const { key: t } of KE.scanDictTemplate(src)) {
    if (!t.includes('${')) { add(t); continue; }
    const vs = [...t.matchAll(/\$\{([^}]+)\}/g)].map(x => x[1]);
    if (vs.length === 1 && /^side(Name)?$/.test(vs[0])) {
      add(t.replace(/\$\{[^}]+\}/g, '正方'));
      add(t.replace(/\$\{[^}]+\}/g, '反方'));
    } else if (vs.length === 1 && /^q$/i.test(vs[0])) {
      for (const q of ['Q1', 'Q2', 'Q3', 'Q4']) add(t.replace(/\$\{[^}]+\}/g, q));
    }
  }
  return [...set];
}
const rrKeys = extractDataKeys(read('render-report.js'));
const pcKeys = extractDataKeys(read('pipeline-controller.js') + '\n' + read('executor/validator.js'));  // 卡1（260816）：校验器簇迁入 validator.js——生成键面补入
const hnKeys = extractDataKeys(read('executor/host-node.js'));
const dataKeys = [...new Set([...rrKeys, ...pcKeys, ...hnKeys])].sort();
// R5 校验 DATA（checkNarrative 经 c7Data 变量消费，字面提取不到，静态补入）
const c7Keys = [
  'C7.微消化.正方.实例表行数',
  'C7.微消化.反方.实例表行数',
  'C7.微消化.总有效数',
  'C7.SC总览.正方.有效微消化',
  'C7.SC总览.反方.有效微消化'
];
// R2 契约键（V-S8D 消费；模板 `data[\`S8.PhaseII.${side}...\`]` 由 re3+side 展开覆盖——Q4 补丁可移除，
// 保留兜底防展开边界；审计共识 c7Keys 保留、s8Keys 验证后移除）
const s8Keys = [
  'S8.PhaseII.正方.节点列表',
  'S8.PhaseII.反方.节点列表'
];
// 批 5（260812 P0-4）补丁治理（卡 5，260815）：R2.5 8 键已被 re1 字面量提取（render-report L252-253）——删除；
// S2 8 键由 key-extract 物化（render-report L220 cats 逐字——非 PC ENUM，登记「论证完成度枚举单一源」待后续）
const patchKeys = [
  ...KE.s2CompletionKeys()
];
const allDataKeys = [...new Set([...dataKeys, ...c7Keys, ...s8Keys, ...patchKeys])].sort();

// ---------- 2) producer 映射（前缀 → 轮次） ----------
function producerOf(key) {
  if (/^S(1|2|3|4|5|7)\./.test(key)) return 'R1';
  if (/^S(8|17)\./.test(key)) return 'R2';
  if (/^R2\.5\./.test(key)) return 'R2.5';
  if (/^C8\./.test(key)) return 'R2.5';
  if (/^S(9|10|11|13|14|15|16)\./.test(key)) return 'R3';
  if (/^C7\./.test(key)) return 'R5A';
  return 'UNKNOWN';
}

// ---------- 2a) 消费声明真实性校验（批 2，260812 结构修复） ----------
// 语义 = 文件级包含检查：「声明的消费函数存在 + 键前缀在任一消费源文件被引用」。
// 放弃函数体级提取——消费常发生在子函数/装配链（buildChartData 等），函数体级必系统性误报（审计实证）。
// 已知边界（登记）：文件级无法发现「文件内存在但语义上不消费」的极端情况；消费函数须为 function 声明式
// （render-report.js / pipeline-controller.js 全部分发器为 function 声明，已核实）。
const CONSUMER_FILES = {
  'render-report.js': path.join(root, 'render-report.js'),
  'pipeline-controller.js': path.join(root, 'pipeline-controller.js'),
  'executor/validator.js': path.join(root, 'executor', 'validator.js')  // 卡1（260816）：校验器簇迁入 validator.js——消费面补入
};
// 键前缀提取：转义点还原为字面点，取首个 长度≥3 的字面量段（含点/汉字/数字）
// （/^S1\.辩题$/ → S1.辩题；/^S8\.PhaseII\./ → S8.PhaseII.；/^C8\.叙事人格\.(…)$/ → C8.叙事人格.）
function consumerKeyPrefix(re) {
  const s = String(re).replace(/^\/\^?/, '').replace(/\\./g, '.');
  const m = s.match(/[A-Za-z0-9_.\u4e00-\u9fa5]{3,}/);
  return m ? m[0] : null;
}
function validateConsumerClaims(overrideMap) {
  const errors = [];
  const map = overrideMap || CONSUMER_MAP;
  const cache = {};
  const srcOf = f => {
    if (!CONSUMER_FILES[f]) return null;
    if (!cache[f]) cache[f] = fs.readFileSync(CONSUMER_FILES[f], 'utf-8');
    return cache[f];
  };
  for (const m of map) {
    const pref = consumerKeyPrefix(m.re);
    if (!pref) { errors.push(`CONSUMER ${m.re}: 键前缀提取失败（re 无字面量段）`); continue; }
    for (const c of m.consumer) {
      const fn = String(c).split('.')[0];                      // 「函数.规则锚点」→ 仅取函数名首段
      if (!/^[A-Za-z_$][\w$]*$/.test(fn)) continue;            // 自由文本标签（如 'c6 表头/进度'）豁免
      const fnExists = ['render-report.js', 'pipeline-controller.js', 'executor/validator.js']
        .some(f => { const s = srcOf(f); return s && s.indexOf('function ' + fn) >= 0; });
      if (!fnExists) {
        errors.push(`CONSUMER ${m.re} → ${c}: 函数 ${fn} 不存在于 render-report.js/pipeline-controller.js`);
        continue;
      }
      const inRR = srcOf('render-report.js').indexOf(pref) >= 0;
      const inPC = srcOf('pipeline-controller.js').indexOf(pref) >= 0;
      const inVA = srcOf('executor/validator.js').indexOf(pref) >= 0;
      if (!inRR && !inPC && !inVA)
        errors.push(`CONSUMER ${m.re} → ${c}: 键前缀 ${pref} 在消费源文件均无引用（声明不实）`);
    }
  }
  return errors;
}


// ---------- 3) 消费者/必填/缺省（按前缀静态映射） ----------
// 批 2（260812）修订：假声明全量修正（审计 21 条）——仅保留实证消费方；
// 「假-字面（装配链真）」条目（S3→donutSVG、S9→radarSVG/c9GaugeSVG、R2.5→c8Chart1-3、
// S8.PhaseII→scBarSVG 等）消费发生在 buildChartData 装配链，文件级校验通过，保留。
const CONSUMER_MAP = [
  { re: /^S1\.辩题$/, consumer: ['renderHTML.title'], required: true, default: '（辩题未提供）' },
  { re: /^S1\.(正方|反方)人数$/, consumer: ['validate.V-S8E-A1'], required: true, default: null },
  { re: /^S2\.(正方|反方)\.B0$/, consumer: ['c2ScPanelHTML'], required: true, default: null },
  { re: /^S2\.预判SC方向$/, consumer: ['checkS1_S7'], required: true, default: null },
  { re: /^S3\./, consumer: ['donutSVG'], required: true, default: '0' },
  { re: /^S4\.定义争议触发$/, consumer: ['removeDataConditionBlocks', 'checkR5Contract', 'checkHtml.scaffold'], required: true, default: '≠是→移除条件块' },
  { re: /^S4\.碰撞诊断$/, consumer: ['checkS1_S7'], required: true, default: null },
  { re: /^S7\.关键交锋数$/, consumer: ['c6 表头/进度'], required: false, default: '0' },
  // 卡 5：负向前瞻消除与 S7.关键交锋数 的歧义重叠（一键多匹配）
  { re: /^S7\.(?!关键交锋数$)/, consumer: ['c7 进度'], required: false, default: '0' },
  { re: /^S8\.SC完成度\.判据$/, consumer: ['checkCompletionConsistency'], required: true, default: null },
  { re: /^S8\.PhaseII\./, consumer: ['scBarSVG'], required: true, default: '0' },
  { re: /^S8\.PhaseIII\.被覆盖完成方$/, consumer: ['checkS8', 'checkEffectiveType'], required: false, default: '仅 1d 预判（⑥=上位覆盖 且 ⑤=通过）时必出；其余类型禁止' },
  // 卡 5：负向前瞻消除与 S8.PhaseIII.被覆盖完成方 的歧义重叠
  { re: /^S8\.PhaseIII\.(?!被覆盖完成方$)/, consumer: ['checkS8'], required: true, default: null },
  { re: /^S8\.PhaseI\./, consumer: ['checkS8', 'o5ScProgress'], required: true, default: null },
  { re: /^S8\.7\./, consumer: ['c7 条件块'], required: false, default: '未触发' },
  { re: /^S8\.SC完成度$/, consumer: ['checkS8Coherence'], required: true, default: null },
  { re: /^S8\.S11类型方向$/, consumer: ['checkS8Coherence'], required: true, default: null },
  { re: /^S8\.碰撞终判$/, consumer: ['checkS8'], required: true, default: null },
  { re: /^S8\.(第一层完成|第二层完成)$/, consumer: ['validate.S8'], required: true, default: null },
  { re: /^C8\.叙事人格\.(正方|反方)$/, consumer: ['validateP2_5', 'renderC8Persona'], required: true, default: null },
  { re: /^C8\.人格胜负$/, consumer: ['validateP2_5', 'renderC8Persona', 'checkS15'], required: true, default: null },
  { re: /^S14\.教育洞察\./, consumer: ['validate.S14E'], required: false, default: '缺失警告' },
  { re: /^S9\.(证伪|证成|理性|感性|场面感|意义感)\.(正方|反方)$/, consumer: ['radarSVG', 'c9GaugeSVG'], required: true, default: '0' },
  { re: /^S9\.感性\.质量降权已执行$/, consumer: ['validate.C11b'], required: false, default: '未触发' },
  { re: /^S10\.1\./, consumer: ['validate.V4'], required: false, default: '缺失警告' },
  { re: /^S11\.类型$/, consumer: ['checkEffectiveType', 'c2ScPanelHTML', 'checkHtml.D5'], required: true, default: '缺失=G0-0 阻断' },
  { re: /^S11\.压缩度$/, consumer: ['validate.V6'], required: true, default: null },
  { re: /^S11\.闭合$/, consumer: ['validate.C11a'], required: true, default: null },
  { re: /^S14\.(?!教育洞察\.)/, consumer: ['o4ContentProgress', 'validate.C6'], required: false, default: '缺失警告' },
  { re: /^S15\.(正方得分|反方得分|获胜方)$/, consumer: ['verdictText', 'checkVerdictConsistency', 'diffConflicts'], required: true, default: '缺失=S15 阻断' },
  { re: /^S15\.比分$/, consumer: ['validate.V2'], required: false, default: 'legacy 兼容警告' },
  { re: /^S17\./, consumer: ['validate.S17', 'checkStructure.V-B9', 'validate.V-S17H'], required: false, default: '缺失警告' },
  { re: /^R2\.5\./, consumer: ['c8Chart1', 'c8Chart2', 'c8Chart3', 'validateP2_5'], required: true, default: '空缺' },
  { re: /^C7\./, consumer: ['checkNarrative.L2'], required: true, default: '缺失=BLOCKING' }
];
function metaOf(key) {
  for (const m of CONSUMER_MAP) if (m.re.test(key)) return m;
  return { consumer: ['UNKNOWN'], required: true, default: null };
}

// ---------- 4) cross_checks（规则 ID → 实现方 + executed_at 最早执行点） ----------
// executed_at 核实（Z'' §4.3b，意见 4-3/5-1）：= 任一 impl 在数据就绪后最早执行的代码位点；
// 'S7 赢家↔SC 完成方'=R3（diffConflicts 在 R3 后 buildTransitionFinal）；'S11 类型'=R6a（checkEffectiveType 渲染前门禁）
const ROUND_ORDER = ROUNDS.map(r => r.name);
const CROSS_CHECKS = {
  'S15 三元组': { keys: ['S15.正方得分', 'S15.反方得分', 'S15.获胜方'], impl: ['V2', 'D1', 'D2', 'diffConflicts'], executed_at: 'R3' },
  'S4 条件': { keys: ['S4.定义争议触发'], impl: ['A1', 'A4', 'B6', 'REG-MISS'], executed_at: 'R5A' },
  'S11 类型': { keys: ['S11.类型'], impl: ['G0', 'D5', 'G0-1'], executed_at: 'R6a' },
  'S8 有效数↔C7': { keys: ['S8.PhaseII.正方.有效数', 'S8.PhaseII.反方.有效数', 'C7.微消化.总有效数'], impl: ['L2'], executed_at: 'R5A' },
  'S7 赢家↔SC 完成方': { keys: ['S7.正方赢.致命', 'S7.反方赢.致命', 'S8.PhaseIII.完成方'], impl: ['diffConflicts'], executed_at: 'R3' },
  'S9 六向度↔S15': { keys: ['S9.证伪.正方', 'S9.证伪.反方', 'S15.正方得分', 'S15.反方得分'], impl: ['diffConflicts', 'V2'], executed_at: 'R3' },
  '1d 双完成方': { keys: ['S11.类型', 'S8.PhaseIII.完成方', 'S8.PhaseIII.被覆盖完成方'], impl: ['C14', 'C15', 'C16', 'C17'], executed_at: 'R3' },
  'S2 矩阵↔DATA': { keys: ['S2.正方.论证完成度.充分', 'S2.正方.论证完成度.初步', 'S2.正方.论证完成度.未论证', 'S2.正方.论证完成度.被击穿', 'S2.反方.论证完成度.充分', 'S2.反方.论证完成度.初步', 'S2.反方.论证完成度.未论证', 'S2.反方.论证完成度.被击穿'], impl: ['A7'], executed_at: 'R1' },
  'C7 五键自洽': { keys: c7Keys, impl: ['L2'], executed_at: 'R5A' }
};
// 生成时校验（意见 1-2/4-3）：executed_at 不得早于依赖键 producer 最早时点——防时点错位固化进字典
const idx = r => ROUND_ORDER.indexOf(r);
for (const [id, c] of Object.entries(CROSS_CHECKS)) {
  if (!c.executed_at || idx(c.executed_at) < 0) throw new Error(`CROSS_CHECK ${id}: executed_at(${c.executed_at}) 非法或缺失`);
  const maxProducer = Math.max(...c.keys.map(k => idx(producerOf(k))));
  if (idx(c.executed_at) < maxProducer)
    throw new Error(`CROSS_CHECK ${id}: executed_at(${c.executed_at}) 早于依赖键 producer(${c.keys.map(producerOf).join('/')})——时点错位`);
}

// ---------- 5) INSERT 条目（来自注册表，自动） ----------
const registry = PC.parseInsertRegistry(path.join(root, 'Skill-Judge.md'));
const inserts = registry.inserts
  .filter(r => r.consumer !== 'deprecated')
  .map(r => ({
    id: r.name,
    type: r.type,
    ch: r.ch,
    producer: r.producer,
    consumer: r.consumer,
    condition: r.condition || null,
    required: !r.condition && (r.producer === 'R5' || (r.ch === 'C8' && r.producer === 'R2.5') || r.producer === 'R6a'),
    owner: (r.producer === 'R5' || (r.ch === 'C8' && r.producer === 'R2.5')) ? 'narrative' : 'skeleton'
  }))
  .sort((a, b) => a.id.localeCompare(b.id));

// ---------- 6) 非注册表输入（8 类，与核心字典 §3.3 同步） ----------
const nonRegistry = [
  { id: 'NR-1', name: 'transition-final.md', itemCount: 71, detail: 'DATA 键 69（67 语义 + 2 别名）+ S2 矩阵表 2', producer: 'R1-R3/R2.5 合并', consumer: ['normalizePhase1', 'A7', 'D5'], required: true },
  { id: 'NR-2', name: '叙事.md', itemCount: 106, detail: 'XP 12 + INSERT 槽 70（64 无条件 = 58 R5 + 6 C8/R2.5；6 条件）+ raw 12 + pre 12', producer: 'R5-A/R5-B', consumer: ['extractModules', 'checkNarrative'], required: true },
  { id: 'NR-3', name: 'structure.json', itemCount: 88, detail: '实场示例：顶层 4 + meta 6 + 层字段 40（3 层·29 种）+ 节点字段 30（6 节点·5 种）+ mechanisms 4 + cross_reference 4；字段类型固定 52 种', producer: 'R4', consumer: ['renderC3Panel', 'checkEffectiveType', 'checkStructure', 'diffConflicts'], required: true },
  { id: 'NR-4', name: 'S1.辩题→title', itemCount: 1, detail: '已含于 NR-1 的 69 键', producer: 'R1', consumer: ['renderHTML.title'], required: true },
  { id: 'NR-5', name: 'S4.定义争议触发→条件块', itemCount: 1, detail: '已含于 NR-1 的 69 键', producer: 'R1', consumer: ['removeDataConditionBlocks', 'A1', 'A4'], required: true },
  { id: 'NR-6', name: 'depth 参数', itemCount: 3, detail: '参数 3 个（verdict/mainline/clash），取值 9 个', producer: '用户/CLI', consumer: ['renderHTML', 'checkHtml.D3'], required: false },
  { id: 'NR-7', name: '资产', itemCount: 4, detail: 'skeleton.html / report.css / charts-constants.js / frontendJs', producer: '仓库', consumer: ['renderHTML'], required: true },
  { id: 'NR-8', name: '落盘文件', itemCount: 2, detail: '.tmp-validate-warnings.json / .tmp-conflicts.json', producer: 'validate-final/executor', consumer: ['R5 参考', 'R4.5 统筹轮'], required: false },
  { id: 'NR-9', name: 'source-anchor.json', itemCount: 9, detail: '名册锚（源锚层 v1）：roster/bench/candidates/other_speakers/integrity/typeA/typeB/disclaimer/rosterHash', producer: '抽取器（机械，无模型参与）', consumer: ['validate.V-S8E-A1', 'validate.V-S8E-A2/A3', 'renderHTML.disclaimer', 'checkHtml.H2'], required: false }
];

// ---------- 7) 字典 data 条目（先于正推视图构建） ----------
const data = allDataKeys.map(key => {
  const m = metaOf(key);
  const cross = Object.keys(CROSS_CHECKS)
    .filter(id => CROSS_CHECKS[id].keys.includes(key))
    .map(id => id + '→' + CROSS_CHECKS[id].impl.join('/'));
  return {
    id: key,
    type: 'data',
    producer: producerOf(key),
    consumer: m.consumer,
    required: m.required,
    default: m.default,
    cross_checks: cross
  };
});

// ---------- 8) 正推视图：按轮次输出合同 ----------
const STRUCTURE_FIELDS = {
  top: ['meta', 'layers', 'cross_reference'],
  meta: ['schema_version', 'total_layers', 's11_original_type', 'type_override', 'override_reason', 'dominant_narrative'],
  layer: ['id', 'type', 'nodes', 'opponent_nodes', 'citation_basis', 'friction_nodes'],
  node: ['id', 'side', 'label', 'event_type', 'sc_mark']
};
const ROUND_CONTRACT_DEFS = [
  { round: 'R1', producerRe: /^S(1|2|3|4|5|7)\./, format: 'DATA 标记格式：<!--DATA: 键=值 -->；键名与清单逐字一致；S1.辩题=辩题原文' },
  { round: 'R2', producerRe: /^S(8|17)\./, format: 'DATA 标记格式同 R1；S17.1 节点表必须输出（V-B9 交叉校验源）；S8.PhaseII.*.节点列表 M-ID 规范为 M-ZH-n/M-FA-n' },
  { round: 'R2.5', producerRe: /^(R2\.5\.|C8\.)/, format: '8 个对方对抗象限 DATA 必出；C8 预制散文用 PROSE:XXX_START/END 包裹；C8.叙事人格/人格胜负（Step 8）必出且回引仅限 M-ZH-n/M-FA-n/CP-n' },
  { round: 'R3', producerRe: /^S(9|10|11|13|14|15|16)\./, format: 'S15 判决行原料（获胜方/正方得分/反方得分）必出；S14.教育洞察 回引仅限 M-ZH-n/M-FA-n/CP-n，禁止字段名；每条精炼为宜，无硬性字数限制；如含多段以 | 连接（回引必须为末段）' },
  { round: 'R4', structureFields: STRUCTURE_FIELDS, format: 'structure.json 按 R4 合同输出：顶层/meta/层/节点字段齐全，v2 对象节点' },
  { round: 'R5A', producerRe: /^C7\./, chapters: R5_HALVES.A.chapters, format: '每章 XP 必出；无条件 INSERT 出现且非空；C4 条件项仅 S4=是 时输出；C7 五个 DATA 标记必出' },
  { round: 'R5B', chapters: R5_HALVES.B.chapters, format: '每章 XP 必出；无条件 INSERT 出现且非空（C8 的 6 个 R2.5 槽由本半区拼装）' },
  { round: 'R6a', insertProducer: 'R6a', format: '渲染侧预建：XP/图表占位由机械渲染填充，无 LLM' },
  { round: 'R6b', format: '机械渲染轮：render-report.js 消费全部源信息，无 LLM' }
];

const round_contracts = ROUND_CONTRACT_DEFS.map(def => {
  const entry = {
    round: def.round,
    data_keys: def.producerRe ? data.filter(d => def.producerRe.test(d.id)).map(d => ({ id: d.id, required: d.required })) : [],
    insert_ids: def.chapters
      ? inserts.filter(i => def.chapters.includes(i.ch) && i.owner === 'narrative' && !i.condition).map(i => i.id)
      : def.insertProducer ? inserts.filter(i => i.producer === def.insertProducer).map(i => i.id) : [],
    structure_fields: def.structureFields || null,
    format: def.format || null
  };
  return entry;
});

// ---------- 9) R4.5 仲裁元数据（T3/T4：白名单 + 字段→范式映射 + 语义标尺） ----------
// 批甲 B1：whitelist 由 PC.adjudicableKeys(data) 派生（字典 DATA 键 ∩ 前缀域 ∪ DERIVED_KEYS）；传内存 data 防读磁盘旧快照
const adjudication = {
  whitelist: PC.adjudicableKeys(data),
  field_paradigms: {
    'S11.类型': ['semantic_fit', 'structural_coherence'],
    'S8.PhaseIII.完成方': ['semantic_fit'],
    'S8.PhaseIII.被覆盖完成方': ['semantic_fit', 'provenance'],
    'S9.*': ['explanatory_power', 'criteria_derivation'],
    'C7.*': ['structural_coherence'],
    'S7.*': ['structural_coherence', 'provenance'],
    'S15.*': ['criteria_derivation', 'explanatory_power']
  },
  semantics: {
    'S11.类型': '主线类型：1a=三阶段集中在单次交锋；1b=分布全场渐进；1c=立论预置容纳通道；1d=双SC链·后完成方B\'\'上位覆盖先完成方B\'（决胜层在最外层）；2a/2b/2c=双边碰撞无统一结晶（2b 含 B0=B\' 容纳）；0=无真正交锋。',
    'S8.PhaseIII.完成方': '结构性交锋结晶归属方（正方/反方/无）。',
    'S8.PhaseIII.被覆盖完成方': '1d 中先完成第一层 SC（B\'）的一方；后完成方 B\'\' 上位覆盖该方。仅 S11=1d 时输出；枚举 {正方,反方}，无“无”值。',
    'S9.*': '六向度各轴双方得分 0-10，判定哪方在该轴更优（数值语义=相对强度，非证据计数）。',
    'C7.*': '微消化计数：C7 总有效数=S8 PhaseII 正方+反方有效数；实例表行数=SC总览有效微消化。',
    'S7.*': '关键交锋推进/赢家计数，与 S8.PhaseIII.完成方 交叉。',
    'S15.*': '最终比分/胜方：由判准链（S7 权重 × S9 倾向）推导；固定 正方:反方 顺序。'
  }
};

// ---------- 10) 组装 ----------
const contract = {
  schema: 'input-contract',
  schema_version: '0.1.0',
  note: '双向投影核心字典机器可读版 v1（由 scripts/generate-input-contract.js 自动生成，勿手改）',
  data: data,
  inserts: inserts,
  round_contracts: round_contracts,
  adjudication: adjudication,
  non_registry_inputs: nonRegistry,
  cross_check_rules: Object.keys(CROSS_CHECKS).map(id => ({
    id: id,
    keys: CROSS_CHECKS[id].keys,
    impl: CROSS_CHECKS[id].impl,
    executed_at: CROSS_CHECKS[id].executed_at
  }))
};

// 批 2（260812）：require.main 守卫——测试可 require 导入校验函数（consumer-claims.test.js）
// 顶层仅保留数据/映射定义与导出；主流程（生成/校验/落盘）仅在直跑时执行
module.exports = { validateConsumerClaims, consumerKeyPrefix, CONSUMER_MAP };
if (require.main === module) {
  const outPath = path.join(root, 'schemas', 'input-contract.json');
  const json = JSON.stringify(contract, null, 2) + '\n';

  // 批 2（260812）：消费声明真实性校验——在 --check 与 --write 双路径先跑（失败拒绝生成/报 FAIL）
  const consumerClaims = validateConsumerClaims();

  const mode = process.argv.includes('--check') ? 'check' : 'write';
  if (consumerClaims.length) {
    console.error('CHECK FAIL: consumer-claims ' + consumerClaims.length + ' 条——CONSUMER_MAP 声明不实（修正后再 --write/--check）');
    for (const e of consumerClaims) console.error('  - ' + e);
    process.exit(1);
  }
  if (mode === 'check') {
    if (!fs.existsSync(outPath)) {
      console.error('CHECK FAIL: ' + outPath + ' 不存在');
      process.exit(1);
    }
    const cur = fs.readFileSync(outPath, 'utf-8');
    if (cur !== json) {
      console.error('CHECK FAIL: input-contract.json 与代码现状不一致（先运行 --write 再提交）');
      console.error('diff chars: 现有=' + cur.length + ' 新生成=' + json.length);
      process.exit(1);
    }
    console.log('CHECK PASS: input-contract.json 与代码现状一致（data=' + data.length + ', inserts=' + inserts.length + '）');
    process.exit(0);
  }
  fs.writeFileSync(outPath, json, 'utf-8');
  console.log('WRITE OK: ' + outPath);
  console.log('data=' + data.length + '（69 字面 + 5 C7 静态）');
  console.log('inserts=' + inserts.length + '（92 活跃）');
  console.log('non_registry_inputs=' + nonRegistry.length + ' 类，合计去重项=' + nonRegistry.reduce((a, b) => a + b.itemCount, 0) + '（含重复 2）');
  console.log('round_contracts=' + round_contracts.map(r => r.round + ':' + (r.data_keys.length + r.insert_ids.length)).join(' '));
  console.log('adjudication whitelist=' + adjudication.whitelist.length);
  process.exit(0);
}
