// key-checker.js — 键形核对器（只读审计 + --strict 门禁，260814 门禁化批）
// 目标（全项目审计意见书-260812 §3.5）：消费侧引用的每个键形必须命中字典声明，miss 即 FAIL。
// 四方键集：提示词 DATA / 消费侧 7 形态 / REGISTRY.enums / input-contract.json。
// 消费侧 7 形态：① data['X'] 字面量 ② data['X.' + c] 拼接前缀 ③ 'X' in data
//   ④ 数组清单/比较/别名读值中的键形字面量 ⑤ 模板插值前缀 data[`X.${v}`]
//   ⑥ 双引号（并入①） ⑦ 无插值模板串（并入①）。
// 前缀形态（②⑤）按「字典含该前缀任一完整键」核对（静态不可枚举插值后全键）。
// --strict：MISS（非豁免）→ exit 1；--verify：自检（字典规模/注入假键必红/噪声回归/豁免逐项）。
// 已知漂移候选（登记不修，被引用且不在字典时输出 EXEMPT 而非 FAIL）：
//   S8.COMPLETE/S15.COMPLETE 双写、S8.压缩度（正形 S8.PhaseIII.压缩度）、S4.场C.*（元场争议族）
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKILL = path.join(ROOT, 'Skill-Judge.md');
const CONTRACT = path.join(ROOT, 'schemas', 'input-contract.json');
// 卡 5（260815）：键形提取单一引擎
const KE = require('./key-extract.js');
const CONSUME_FILES = [
  'pipeline-controller.js',
  'render-report.js',
  'render-tables.js',
  'scripts/html-contract.js',
  'scripts/plain-language.js',
  'executor/host-node.js',
  'executor/validator.js'
];  // 卡1（260816）：校验器簇迁入 validator.js——消费面补入
const STRICT = process.argv.includes('--strict');
const VERIFY = process.argv.includes('--verify');

const KNOWN_DRIFT = [
  'S8.COMPLETE',
  'S15.COMPLETE',
  'S8.压缩度',
  'S4.场C',
  'S4.场C.元场争议',
  'S4.场C.对SC影响'
];

// 未消费豁免（字典声明但消费侧未引用，登记不修）——260815 增强：初值为空（实证未消费=0）
const UNUSED_EXEMPT = [];

// ---------- 四方键集提取 ----------

function keysOfSkill() {
  const md = fs.readFileSync(SKILL, 'utf8');
  const keys = [];
  const re = /<!--DATA:\s*([^\r\n=<>]+?)\s*=/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    const k = m[1].trim();
    if (k && k.length <= 60 && !k.includes('-->')) keys.push(k);
  }
  return [...new Set(keys)];
}

function keysOfRegistry() {
  const md = fs.readFileSync(SKILL, 'utf8');
  const match = md.match(/<!--REGISTRY_START-->\n```json\n([\s\S]*?)\n```\n<!--REGISTRY_END-->/);
  if (!match) return [];
  try {
    const reg = JSON.parse(match[1].trim());
    const keys = new Set();
    for (const ins of (reg.inserts || [])) if (ins.name) keys.add(ins.name);
    return [...keys];
  } catch (e) { return ['<REGISTRY 解析失败: ' + e.message + '>']; }
}

// 字典单一事实源：input-contract.json data[].id（键形；inserts[].id 为插入槽位 C#_XX，非数据键形，不并入）
function keysOfContract() {
  try {
    const c = JSON.parse(fs.readFileSync(CONTRACT, 'utf8'));
    const keys = new Set();
    if (Array.isArray(c.data)) c.data.forEach(d => { if (d.id) keys.add(d.id); });
    return [...keys];
  } catch (e) { return ['<input-contract 读取失败: ' + e.message + '>']; }
}

// 键形严格校验（排除消息文本/文件名/段名/跨行残留/碎片）——单一引擎（卡 5）
const isKeyShape = KE.isKeyShape;

// ---------- 消费侧 7 形态提取（附来源 file:line 供核实） ----------

function consumeKeys() {
  const literal = new Map();  // 键 -> [file:line, ...]
  const prefixes = new Map(); // 前缀 -> [file:line, ...]
  const addL = (k, loc) => { if (!isKeyShape(k)) return; if (!literal.has(k)) literal.set(k, []); literal.get(k).push(loc); };
  const addP = (p, loc) => {
    if (typeof p !== 'string') return;
    const bare = p.endsWith('.') ? p.slice(0, -1) : p;
    // 裸段前缀（S2.）/ 段路径前缀（S2.正方.论证完成度.）/ R 轮名族前缀（R2.5.，260815 形态⑧——R2.5.* 为合法字典族；
    // 裸轮名 R2.5 不带点不构成前缀形态，仍被拒，噪声可控）
    const valid = /^[SC]\d+(\.\d+)?$/.test(bare) || /^R\d+(\.\d+)?$/.test(bare) || isKeyShape(bare);
    if (!valid) return;
    if (!prefixes.has(p)) prefixes.set(p, []);
    prefixes.get(p).push(loc);
  };
  for (const f of CONSUME_FILES) {
    const full = path.join(ROOT, f);
    const t = fs.readFileSync(full, 'utf8');
    const lines = t.split(/\r?\n/);
    const lineOf = (idx) => t.slice(0, idx).split(/\r?\n/).length;
    const clean = (line) => line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // ①⑥⑦ 直接字面量 data['X'] / data["X"] / data[`X`]
    for (const { key, index } of KE.scanDataQuote(t)) addL(key, f + ':' + lineOf(index));
    // ② 拼接前缀 data['X.' + ...]
    for (const { key, index } of KE.scanConcatPrefix(t)) {
      if (key.endsWith('.')) addP(key, f + ':' + lineOf(index)); else addL(key, f + ':' + lineOf(index));
    }
    // ③ 'X' in data
    for (const { key, index } of KE.scanInData(t)) addL(key, f + ':' + lineOf(index));
    // ④ 数组清单/比较/别名读值中的键形字面量（行级去注释后扫描；260815 增强：行级消费上下文判定）
    // 注册表消费形态排除：enums[...]/registry.enums/getEnums() 为 REGISTRY 单一事实源，非 data 字典视域
    const CONSUME_CTX = /data|in\s|===|!==|push\(|includes\(|indexOf\(|=\s*\[|=\s*\{|,\s*['"]|\[['"]|==/;
    const lineFilter = (cl) => !/enums\s*\[|registry\.enums|getEnums\(/.test(cl) && CONSUME_CTX.test(cl);
    for (const { key, line } of KE.scanLineQuote(lines.map(clean), lineFilter)) {
      if (isKeyShape(key)) addL(key, f + ':' + line);
    }
    // ⑤ 模板插值前缀 data[`X.${v}`]
    for (const { key, index } of KE.scanTemplateInterp(t)) {
      if (key.endsWith('.')) addP(key, f + ':' + lineOf(index)); else if (isKeyShape(key)) addP(key.split('.')[0] + '.', f + ':' + lineOf(index) + '*');
    }
    // ⑧ 模板串变量构造（260815 增强）：`const key = \`R2.5.${side}.${q}.对方对抗象限\`` 中间变量形态——
    //    静态段前缀按前缀族核对（动态段不可枚举，族级覆盖与 ②⑤ 同构）
    //    消息文本排除：errors.push/message:/log 等行内模板串非数据消费（实证误收：S1.${side}人数 消息模板）
    for (const { key, index } of KE.scanVarTemplate(t)) {
      const line = lines[lineOf(index) - 1] || '';
      if (/message:|errors\.push|console\.|\.log\(|warn\(|throw|警告|提示/.test(line)) continue;
      const sp = key.split('${')[0].trim();
      if (sp.endsWith('.')) addP(sp, f + ':' + lineOf(index) + '⑧');
      else if (/^[SC]\d+(\.\d+)?$/.test(sp)) addP(sp + '.', f + ':' + lineOf(index) + '⑧');
    }
  }
  return { literal, prefixes };
}

// ---------- 核对 ----------

const skillKeys = keysOfSkill();
const registryKeys = keysOfRegistry();
const contractKeys = keysOfContract();
const dict = new Set(contractKeys);
const { literal, prefixes } = consumeKeys();

const miss = [];
for (const [k, locs] of literal) if (!dict.has(k)) miss.push({ k, locs });
const exempt = [];
for (const [k, locs] of literal) if (KNOWN_DRIFT.includes(k)) exempt.push({ k, locs });
const realMiss = miss.filter(x => !KNOWN_DRIFT.includes(x.k)); // 豁免项不构成 FAIL
const prefixMiss = [];
const prefixOk = [];
for (const [p, locs] of prefixes) {
  const family = [...dict].filter(d => d.startsWith(p));
  if (family.length) prefixOk.push({ p, family: family.slice(0, 3) });
  else prefixMiss.push({ p, locs });
}
// W-PH 增强（260815）：字典侧未消费核对——字典声明但消费侧（字面量/前缀族）未引用 → unused（报告 + --strict FAIL）
const prefixList = [...prefixes.keys()];
const unused = [];
for (const k of dict) {
  if (literal.has(k)) continue;
  if (prefixList.some(p => k.startsWith(p))) continue;
  if (UNUSED_EXEMPT.includes(k)) continue;
  unused.push(k);
}

// ---------- 报告 ----------

const out = [];
out.push('===== 键形核对器报告 =====');
out.push('提示词 DATA 键: ' + skillKeys.length);
out.push('REGISTRY.enums 键: ' + registryKeys.length);
out.push('字典 data[].id: ' + contractKeys.length + '（input-contract.json；inserts 槽位 ID 非键形不并入）');
out.push('消费侧文件: ' + CONSUME_FILES.join(' / '));
out.push('提取: 字面量 ' + literal.size + ' / 拼接·插值前缀 ' + prefixes.size);
out.push('');
out.push('--- MISS（消费侧引用但字典无声明' + (STRICT ? ' → FAIL' : '') + '） ---');
miss.forEach(x => out.push('  ' + x.k + '  @ ' + x.locs.join(' ')));
if (!miss.length) out.push('  （无）');
out.push('');
out.push('--- EXEMPT（已知漂移候选，登记不修） ---');
exempt.forEach(x => out.push('  ' + x.k + '  @ ' + x.locs.join(' ')));
if (!exempt.length) out.push('  （无）');
out.push('');
out.push('--- 前缀核对（拼接/模板插值，字典含族即 OK） ---');
prefixOk.forEach(x => out.push('  ' + x.p + ' → 字典族: ' + x.family.join(' / ')));
prefixMiss.forEach(x => out.push('  ' + x.p + ' → 无字典族  @ ' + x.locs.join(' ')));
if (!prefixOk.length && !prefixMiss.length) out.push('  （无前缀形态）');
out.push('');
out.push('--- 未消费键（字典声明但消费侧未引用' + (STRICT ? ' → FAIL' : '') + '） ---');
unused.forEach(x => out.push('  ' + x + ''));
if (!unused.length) out.push('  （无）');
out.push('');
out.push('--- 已知漂移候选核对（提示词=✓ 消费=✓ 注册=✓ 字典=✓） ---');
const cand = ['S8.COMPLETE', 'S15.COMPLETE', 'S8.压缩度', 'S8.PhaseIII.压缩度', 'S10.1.总数', 'S10.1.通过数', 'S10.1.不通过项号', 'S10.2.通过', 'S4.场C', 'S4.场C.元场争议', 'S4.场C.对SC影响'];
for (const k of cand) {
  out.push('  ' + k + ': 提示词=' + (skillKeys.includes(k) ? '✓' : '—') + ' 消费=' + (literal.has(k) ? '✓' : '—') + ' 注册=' + (registryKeys.includes(k) ? '✓' : '—') + ' 字典=' + (dict.has(k) ? '✓' : '—'));
}
out.push('');
out.push('（只读报告——--strict 时 MISS 非空将 FAIL；本工具不修改任何文件）');

// ---------- --verify 自检 ----------

let verifyFails = [];
if (VERIFY) {
  const fake = 'S99.探针.FAKE';
  if (dict.has(fake)) verifyFails.push('自检: 假键不应在字典（' + fake + '）');
  // 真实注入：把假键并入消费键集，断言走 FAIL 判定路径（miss 且非豁免）
  const probeKeys = [...literal.keys(), fake];
  const probeMiss = probeKeys.filter(k => !dict.has(k) && !KNOWN_DRIFT.includes(k));
  if (!probeMiss.includes(fake)) verifyFails.push('自检: 注入假键未被判为 MISS（FAIL 路径失灵）');
  if (contractKeys.length < 100) verifyFails.push('自检: 字典键数异常（' + contractKeys.length + '，预期 ≥100）');
  for (const k of ['S1.COMPLETE', 'C7.SC总览.正方.有效微消化', 'S7.正方赢.致命', 'S8.PhaseIII.压缩度', 'S10.1.总数']) {
    if (!dict.has(k)) verifyFails.push('自检: 字典缺基准键 ' + k);
  }
  // W-PH 增强（260815）：圈号族基准键必须被消费侧提取命中（提取盲区回归）——修复前应红
  for (const k of ['S8.PhaseIII.④容纳自洽', 'S8.PhaseIII.⑤价值深度', 'S8.PhaseIII.④致命交锋复核.未覆盖数', 'S3.反驳路径①数']) {
    if (!literal.has(k)) verifyFails.push('自检: 圈号族键未被消费侧提取（提取盲区）' + k);
  }
  // W-PH 增强：模板变量族基准键须经前缀族覆盖（形态⑧）——修复前应红
  if (!prefixList.some(p => 'R2.5.反方.Q1.对方对抗象限'.startsWith(p))) verifyFails.push('自检: R2.5. 模板变量族前缀未提取（形态⑧盲区）');
  // W-PH 增强：字典全部消费（unused=0）或逐项豁免（UNUSED_EXEMPT 精确集）
  if (unused.length !== UNUSED_EXEMPT.length) verifyFails.push('自检: 未消费键 ' + unused.length + ' 与豁免集 ' + UNUSED_EXEMPT.length + ' 不一致（字典应有消费或登记豁免）: ' + unused.join(' / '));
  const noise = ['S7.赢家=正方', '5:5判胜·S15.2判准', 'R2.5', 'S2.反方.论证完成度.被击穿-->', 'S11类型=1d但S8.PhaseIII', 'S1.'];
  for (const n of noise) {
    if (literal.has(n) || prefixes.has(n)) verifyFails.push('自检: 噪声误入键集（' + n + '）');
  }
  for (const k of KNOWN_DRIFT) {
    if (literal.has(k) && !dict.has(k) && !exempt.some(x => x.k === k)) verifyFails.push('自检: 豁免项未走 EXEMPT（' + k + '）');
  }
  out.push('');
  out.push('--- --verify 自检 ---');
  out.push(verifyFails.length ? verifyFails.map(v => '  FAIL ' + v).join('\n') : '  全部通过（字典规模/注入假键必红/噪声回归/豁免逐项）');
}

console.log(out.join('\n'));
if (STRICT && (realMiss.length || unused.length)) process.exit(1);
if (VERIFY && verifyFails.length) process.exit(1);
process.exit(0);
