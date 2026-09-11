// 第 5 步：四方一致性校验（规则文本 ↔ 注册表 ↔ 渲染器 ↔ 轮次输出）
// 运行：node tests/dictionary-consistency.test.js（并被 tests/run-all.js 收录）
// 断言：①渲染器消费键⊆字典；②字典 producer/规则文本可追溯；③注册表↔骨架闭合；
//       ④R5 prompt 必出清单=注册表无条件子集；⑤cross_checks 均有实现；⑥字典生成幂等。
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const PC = require('../pipeline-controller.js');
const KE = require('../scripts/key-extract.js');
const { ROUNDS } = require('../executor/core.js');

const root = path.join(__dirname, '..');
const contract = JSON.parse(fs.readFileSync(path.join(root, 'schemas', 'input-contract.json'), 'utf-8'));
const skillMd = fs.readFileSync(path.join(root, 'Skill-Judge.md'), 'utf-8');
const codeAll = fs.readFileSync(path.join(root, 'pipeline-controller.js'), 'utf-8') +
  fs.readFileSync(path.join(root, 'render-report.js'), 'utf-8') +
  fs.readFileSync(path.join(root, 'executor', 'host-node.js'), 'utf-8') +
  fs.readFileSync(path.join(root, 'executor', 'validator.js'), 'utf-8');  // 卡1（260816）：校验器簇迁入 validator.js——实现扫描面补入

let failed = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' :: ' + detail : ''));
  if (!cond) failed++;
};

const contractDataIds = new Set(contract.data.map(d => d.id));
const contractInsertIds = new Set(contract.inserts.map(i => i.id));

// ---- ① 渲染器/门禁消费键 ⊆ 字典 ----
function extractDataKeys(src) {
  return [...new Set(KE.scanDictQuote(src).map(x => x.key))]
    .filter(k => /^(S|R2\.5|C7|C8)/.test(k));
}
const rrKeys = extractDataKeys(fs.readFileSync(path.join(root, 'render-report.js'), 'utf-8'));
const pcKeys = extractDataKeys(fs.readFileSync(path.join(root, 'pipeline-controller.js'), 'utf-8') + '\n' + fs.readFileSync(path.join(root, 'executor', 'validator.js'), 'utf-8'));  // 卡1：校验器簇迁入
const hnKeys = extractDataKeys(fs.readFileSync(path.join(root, 'executor', 'host-node.js'), 'utf-8'));
const allKeys = [...new Set([...rrKeys, ...pcKeys, ...hnKeys])];
const missing = allKeys.filter(k => !contractDataIds.has(k));
check('① 渲染器+门禁字面消费键 ⊆ 字典（' + allKeys.length + ' 个）', missing.length === 0, missing.join(','));
const aliasProbe = extractDataKeys("const x = allData['S8.COMPLETE']; const y = allData['S1.' + side + '人数'];");
check('①a shared extractor 可识别 allData 字面量且不物化动态表达式',
  aliasProbe.includes('S8.COMPLETE') && !aliasProbe.some(k => k === 'S1.' || k.includes('+ side')),
  JSON.stringify(aliasProbe));
check('①b S8.COMPLETE 为 compatibility-only：不再是 live consumer / input-contract authority',
  !allKeys.includes('S8.COMPLETE') && !contractDataIds.has('S8.COMPLETE'),
  'live=' + allKeys.includes('S8.COMPLETE') + ' contract=' + contractDataIds.has('S8.COMPLETE'));
const c7InContract = ['C7.微消化.正方.实例表行数', 'C7.微消化.反方.实例表行数', 'C7.微消化.总有效数', 'C7.SC总览.正方.有效微消化', 'C7.SC总览.反方.有效微消化'];
check('①b R5 校验 DATA 5 键在字典', c7InContract.every(k => contractDataIds.has(k)));
check('①c S4 动态键（data-condition）在字典', contractDataIds.has('S4.定义争议触发'));

// ---- 批甲（260811）：轮次消费域对称断言（防域正则漂移） ----
check('⑥ R2.5 producer 键全部命中 PC.R2_5_DOMAIN_RE（防域正则漂移）',
  contract.data.filter(d => d.producer === 'R2.5').every(d => PC.R2_5_DOMAIN_RE.test(d.id)),
  contract.data.filter(d => d.producer === 'R2.5').map(d => d.id).filter(id => !PC.R2_5_DOMAIN_RE.test(id)).join(','));
check('⑥b R3 producer 键全部命中 PC.R3_DOMAIN_RE（防域正则漂移，含 S16）',
  contract.data.filter(d => d.producer === 'R3').every(d => PC.R3_DOMAIN_RE.test(d.id)),
  contract.data.filter(d => d.producer === 'R3').map(d => d.id).filter(id => !PC.R3_DOMAIN_RE.test(id)).join(','));

// ---- ② 字典 producer 规则 + 规则文本可追溯 ----
const producerRule = k =>
  /^S(1|2|3|4|5|7)\./.test(k) ? 'R1' :
  /^S(8|17)\./.test(k) ? 'R2' :
  /^R2\.5\./.test(k) ? 'R2.5' :
  /^C8\./.test(k) ? 'R2.5' :
  /^S(9|10|11|13|14|15|16)\./.test(k) ? 'R3' :
  /^C7\./.test(k) ? 'R5A' : 'UNKNOWN';
const badProducer = contract.data.filter(d => d.producer === 'UNKNOWN' || d.producer !== producerRule(d.id));
check('② 字典 data 均有合法 producer 且前缀规则一致（' + contract.data.length + ' 条）', badProducer.length === 0, badProducer.map(d => d.id + ':' + d.producer).join(','));
const notInRules = contract.data.filter(d => !skillMd.includes(d.id));
check('②b 字典 data 键在规则文本（Skill-Judge.md）中可追溯', notInRules.length === 0, notInRules.map(d => d.id).join(','));

// ---- ③ 注册表 ↔ 骨架双向闭合 ----
const regCheck = PC.validateRegistry(path.join(root, 'Skill-Judge.md'), { crossRef: true });
check('③ 注册表↔骨架双向闭合（validate-registry --cross-ref）', regCheck.passed === true, regCheck.errors.join(';'));
const skeleton = fs.readFileSync(path.join(root, 'assets', 'skeleton.html'), 'utf-8');
const skelNames = new Set((skeleton.match(/<!--INSERT_([A-Z0-9_]+)-->/g) || []).map(m => m.replace('<!--INSERT_', '').replace('-->', '')));
const activeInserts = contract.inserts.filter(i => i.consumer === 'R6b').map(i => i.id);
check('③b 字典活跃 INSERT ⊆ 骨架且骨架 ⊆ 字典', activeInserts.every(id => skelNames.has(id)) && [...skelNames].every(id => contractInsertIds.has(id)),
  '骨架=' + skelNames.size + ' 字典活跃=' + activeInserts.length);

// ---- ④ R5 prompt 必出清单 = 注册表无条件子集 ----
const registry = PC.parseInsertRegistry(path.join(root, 'Skill-Judge.md'));
const expectedUncond = new Set(registry.inserts
  .filter(r => r.consumer === 'R6b' && !r.condition && (r.producer === 'R5' || (r.ch === 'C8' && r.producer === 'R2.5')))
  .map(r => r.name));
const r5Contract = PC.generateInsertContract(registry, 'R5');
const mustSection = r5Contract.split('### 🚫 必出清单')[1].split(/\n### |\n---/)[0] || '';
const listed = new Set((mustSection.match(/<!--INSERT_([A-Z0-9_]+)-->/g) || []).map(m => m.replace('<!--INSERT_', '').replace('-->', '')));
const diffListed = [...expectedUncond].filter(n => !listed.has(n));
const diffExtra = [...listed].filter(n => !expectedUncond.has(n));
check('④ R5 必出清单=注册表无条件子集（' + expectedUncond.size + ' 个）', diffListed.length === 0 && diffExtra.length === 0,
  '缺=' + diffListed.join(',') + ' 多=' + diffExtra.join(','));

// ---- ⑤ cross_checks 均有实现 + executed_at 硬编码精确期望（Z'' 意见 5-1：防漂移固化） ----
const missingImpl = [];
for (const rule of contract.cross_check_rules) {
  for (const impl of rule.impl) {
    if (!codeAll.includes(impl)) missingImpl.push(rule.id + ':' + impl);
  }
}
const crossInstances = contract.data.reduce((a, d) => a + d.cross_checks.length, 0);
check('⑤ 字典 cross_checks 均有代码实现（' + contract.cross_check_rules.length + ' 类规则 / ' + crossInstances + ' 条字段实例）', missingImpl.length === 0, missingImpl.join(','));
const EXPECTED_EXECUTED_AT = {
  'S15 三元组': 'R3', 'S4 条件': 'R5A', 'S11 类型': 'R6a', 'S8 有效数↔C7': 'R5A',
  'S7 赢家↔SC 完成方': 'R3', 'S9 六向度↔S15': 'R3', '1d 双完成方': 'R3',
  'S2 矩阵↔DATA': 'R1', 'C7 五键自洽': 'R5A'
};
const ROUND_ORDER = ROUNDS.map(r => r.name);
const badExecutedAt = contract.cross_check_rules.filter(r =>
  !r.executed_at || r.executed_at !== EXPECTED_EXECUTED_AT[r.id] || !ROUND_ORDER.includes(r.executed_at));
check('⑤b executed_at 9 项硬编码精确期望 + 轮次记法统一（' + contract.cross_check_rules.length + ' 项）', badExecutedAt.length === 0,
  badExecutedAt.map(r => r.id + ':' + r.executed_at).join(','));
const c7Producer = contract.data.find(d => d.id === 'C7.微消化.总有效数');
check('⑤c producerOf(C7)===R5A（与 ROUND_CONTRACT_DEFS 记法统一）', c7Producer && c7Producer.producer === 'R5A', JSON.stringify(c7Producer));
const s8c7Rule = contract.cross_check_rules.find(r => r.id === 'S8 有效数↔C7');
check('⑤d S8有效数↔C7 impl 不含 diffConflicts（死代码已删段）', s8c7Rule && !s8c7Rule.impl.includes('diffConflicts'), JSON.stringify(s8c7Rule && s8c7Rule.impl));
// ⑤d2 C7 键 consumer 标注不含 diffConflicts（260809 清理：diffConflicts 不再读 C7 键，防标注漂移回归）
const c7Consumers = contract.data.filter(d => /^C7\./.test(d.id)).flatMap(d => d.consumer);
check('⑤d2 C7 键 consumer 标注不含 diffConflicts（清理防回归）', !c7Consumers.includes('diffConflicts'), JSON.stringify(c7Consumers));
// ⑤e L2↔机械一致性：L2 说明含「节点ID」回引 + 「完整呈现」关键词（与机械规则 b' 同义）
check('⑤e L2 说明含「节点ID」回引与「完整呈现」（规则 b\' 的提示词层同义）',
  skillMd.includes('「节点ID」列必须逐行回引 S8.PhaseII.节点列表中的 M-ID') && skillMd.includes('完整呈现 S8.2 全部有效实例'), '');

// ---- ⑥ 字典生成幂等（--check） ----
try {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'generate-input-contract.js'), '--check'], { stdio: 'pipe', encoding: 'utf-8' });
  check('⑥ input-contract.json 生成幂等（--check 通过）', true);
} catch (e) {
  check('⑥ input-contract.json 生成幂等（--check 通过）', false, String(e.stdout || e.message));
}

// ---- ⑦ 正推视图：round_contracts（2A 新增） ----
const rc = contract.round_contracts || [];
const expectedRounds = ['R1', 'R2', 'R2.5', 'R3', 'R4', 'R5A', 'R5B', 'R6a', 'R6b'];
check('⑦ round_contracts 覆盖 9 轮', rc.length === 9 && expectedRounds.every(r => rc.some(x => x.round === r)), rc.map(r => r.round).join(','));
const rcAssign = {};
for (const r of rc) for (const k of (r.data_keys || [])) {
  if (rcAssign[k.id]) rcAssign[k.id].push(r.round); else rcAssign[k.id] = [r.round];
}
const dupAssign = Object.entries(rcAssign).filter(([, v]) => v.length !== 1);
const noAssign = contract.data.filter(d => !rcAssign[d.id]);
check('⑦b 每个 data 键恰好归属一个 round_contract', dupAssign.length === 0 && noAssign.length === 0,
  '重复=' + JSON.stringify(dupAssign) + ' 未归属=' + noAssign.map(d => d.id).join(','));
const r5a = rc.find(r => r.round === 'R5A');
const r5b = rc.find(r => r.round === 'R5B');
check('⑦c R5A 无条件 26 / R5B 无条件 39（审计口径·260806 C12 成长建议槽 +1）', r5a.insert_ids.length === 26 && r5b.insert_ids.length === 39,
  'R5A=' + r5a.insert_ids.length + ' R5B=' + r5b.insert_ids.length);
const dcR1 = PC.generateDataContract(contract, 'R1');
const dcR5A = PC.generateDataContract(contract, 'R5A');
const dcR4 = PC.generateDataContract(contract, 'R4');
check('⑦d generateDataContract R1 含 S1.辩题', dcR1.includes('S1.辩题'));
check('⑦e generateDataContract R5A 含 C7 5 键与 INSERT 清单', dcR5A.includes('C7.微消化.总有效数') && dcR5A.includes('INSERT_C7_01_SC_TABLE'));
check('⑦f generateDataContract R4 含 structure 必填字段', dcR4.includes('structure.json 必填字段') && dcR4.includes('s11_original_type'));
// ⑦g（260809 Q4）：S8.PhaseII.*.节点列表 已注册且 producer=R2
check('⑦g Q4 契约：S8.PhaseII.*.节点列表 已注册且 producer=R2',
  contract.data.some(d => d.id === 'S8.PhaseII.正方.节点列表' && d.producer === 'R2' && d.required === true) &&
  contract.data.some(d => d.id === 'S8.PhaseII.反方.节点列表' && d.producer === 'R2'),
  '节点列表未注册或 producer 非 R2');

console.log(failed === 0 ? '=== ALL PASS ===' : '=== FAILED: ' + failed + ' ===');
process.exit(failed === 0 ? 0 : 1);
