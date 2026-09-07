// Debate-Judge V1.0 管道控制器
// 用法: node pipeline-controller.js <command> [args]
//   validate <file> <round>          验证单个轮次产出
//   validate-final <p1> <p2> <p3>    拼接并最终验证
//   check-narrative <file>           检查叙事.md 的 12 个 C 模块标记
//   check-html <file>                检查 report.html 的 C 模块 div + <style>
//   load-prompt <round>              输出指定轮次的提示词到stdout

const fs = require('fs');
const path = require('path');
// 卡7（260815）：ROUNDS 单一源——executor/core.js 声明，runAll 直接引用（auditAttention L2797 函数级 require 先例）
const { ROUNDS, R5_HALVES, SECTION_ROUNDS, SECTION_ENDMAP } = require('./executor/core.js');  // 260816 切片契约维度单一源
// 卡 6（260815）：产物契约模块单一源——解析器/ID 契约/仲裁键空间移入 contract.js，
// 本文件解构引用（内部调用点零改动）；module.exports 同名导出即委托
const contract = require('./executor/contract.js');
const validator = require('./executor/validator.js');
const {
  MID_SPEC, CP_SPEC,
  normalizeMId, normalizeMIdText, normalizeStructureIds,
  isMid, isCpId, isRef, sideOfMid,
  extractDataMarkers, parseStructureJson, aggregateData,
  validateAdjudication, mergeAdjudicationData,
  adjudicableKeys, adjudicationWhitelist, loadInputContract,
  parseInsertRegistry,
  DIMENSION_S7_SC, DIMENSIONS, DERIVED_KEYS, ADJUDICABLE_PREFIXES, ADJUDICATION_WHITELIST
} = contract;

// ==================== Resume Node Policy（Web / HTML / CLI / Skill 单一事实源） ====================
// 只做纯规划与相对文件名计算；Node CLI 与 Web VFS 各自负责实际 IO。
const RESUME_NODE_ORDER_BASE = ['R1','R2','R2.5','R3','R4','R4.5','R5A','R5B','R6'];
const RESUME_NODE_ALIASES = {
  'R5-A': 'R5A', 'R5-B': 'R5B', 'R6a': 'R6', 'R6b': 'R6', 'R6A': 'R6', 'R6B': 'R6',
  'r5a': 'R5A', 'r5b': 'R5B', 'r5-a': 'R5A', 'r5-b': 'R5B', 'r6a': 'R6', 'r6b': 'R6',
  'r1': 'R1', 'r2': 'R2', 'r2.5': 'R2.5', 'r3': 'R3', 'r4': 'R4', 'r4.5': 'R4.5',
  'r6': 'R6', 'r7': 'R7', 'r8': 'R8', 'auto': 'auto'
};
function canonicalResumeNode(node) {
  const raw = String(node == null ? 'auto' : node).trim();
  return RESUME_NODE_ALIASES[raw] || RESUME_NODE_ALIASES[raw.toLowerCase()] || raw;
}
function resumeNodeOrder(settings) {
  settings = settings || {};
  const order = RESUME_NODE_ORDER_BASE.slice();
  if (settings.plain === true) order.push('R7');
  if (settings.readerGuide === true) order.push('R8');
  return order;
}
function planResumeStart(input) {
  input = input || {};
  const settings = input.settings || {};
  const requested = canonicalResumeNode(input.requestedNode || 'auto');
  const order = resumeNodeOrder(settings);
  const active = {};
  order.forEach(n => { active[n] = true; });
  if (requested === 'auto') {
    return { requestedNode: 'auto', effectiveStartNode: 'auto', effectiveNodes: [], invalidatedNodes: [], preservedNodes: order.slice(), staleExpansion: [], reasons: [], requirePlainCacheHit: false, allowed: true, blockingReason: null };
  }
  if (!active[requested]) {
    const why = requested === 'R7' && settings.plain !== true ? 'R7 仅在 plain=true 时可选'
      : requested === 'R8' && settings.readerGuide !== true ? 'R8 仅在 readerGuide=true 时可选'
      : '未知或当前设置下不可用的续跑节点: ' + requested;
    return { requestedNode: requested, effectiveStartNode: null, effectiveNodes: [], invalidatedNodes: [], preservedNodes: order.slice(), staleExpansion: [], reasons: [why], requirePlainCacheHit: false, allowed: false, blockingReason: why };
  }
  const deps = {
    R1: [], R2: ['R1'], 'R2.5': ['R1'], R3: ['R2','R2.5'], R4: ['R3'], 'R4.5': ['R4'],
    R5A: ['R4.5'], R5B: ['R4.5'], R6: ['R5A','R5B'], R7: ['R6'], R8: [settings.plain === true ? 'R7' : 'R6']
  };
  function descendants(seed) {
    const hit = {}; hit[seed] = true;
    let changed = true;
    while (changed) {
      changed = false;
      order.forEach(node => {
        if (hit[node]) return;
        const ds = deps[node] || [];
        for (let i = 0; i < ds.length; i++) {
          if (hit[ds[i]]) { hit[node] = true; changed = true; break; }
        }
      });
    }
    return hit;
  }
  function ancestorsOfSet(set) {
    const hit = {};
    Object.keys(set).forEach(n => { if (set[n]) hit[n] = true; });
    let changed = true;
    while (changed) {
      changed = false;
      Object.keys(hit).forEach(node => {
        (deps[node] || []).forEach(dep => {
          if (active[dep] && !hit[dep]) { hit[dep] = true; changed = true; }
        });
      });
    }
    return hit;
  }
  const invalid = descendants(requested);
  const staleRaw = input.runModel && input.runModel.staleRounds ? input.runModel.staleRounds : {};
  const stale = {};
  Object.keys(staleRaw).forEach(raw => {
    if (!staleRaw[raw]) return;
    const n = canonicalResumeNode(raw);
    if (active[n]) stale[n] = true;
  });
  const staleExpansion = [];
  let expanded = true;
  while (expanded) {
    expanded = false;
    const needed = ancestorsOfSet(invalid);
    order.forEach(n => {
      if (!stale[n] || invalid[n] || !needed[n]) return;
      staleExpansion.push(n);
      const extra = descendants(n);
      Object.keys(extra).forEach(x => { if (!invalid[x]) { invalid[x] = true; expanded = true; } });
    });
  }
  const invalidated = order.filter(n => !!invalid[n]);
  const preserved = order.filter(n => !invalid[n]);
  const reasons = ['用户请求从 ' + requested + ' 回退并重新执行该节点及其依赖下游'];
  if (staleExpansion.length) reasons.push('检测到本次重算所依赖的 stale 上游，自动扩张: ' + staleExpansion.join('、'));
  return {
    requestedNode: requested,
    effectiveStartNode: invalidated.length ? invalidated[0] : requested,
    effectiveNodes: invalidated.slice(), invalidatedNodes: invalidated, preservedNodes: preserved,
    staleExpansion, reasons,
    requirePlainCacheHit: requested === 'R8' && settings.plain === true && !invalid.R7,
    allowed: true, blockingReason: null
  };
}
const RESUME_R8_FILES = [
  'report.html', 'reader-guide-input.json', 'reader-guide.json', 'reader-guide-plain.json', 'reader-guide.html',
  '.tmp-reader-guide-cache.json', '.tmp-reader-guide-draft.json', '.tmp-reader-guide-plain-draft.json'
];
const RESUME_R7_FILES = RESUME_R8_FILES.concat(['report-plain.html', '.tmp-plain-review.json', '.tmp-plain-refresh-transaction.json']);
const RESUME_R6_FILES = RESUME_R7_FILES.concat(['.tmp-r6a-out.html']);
const RESUME_NODE_FILES = {
  R1: ['P1.md'], R2: ['P2.md'], 'R2.5': ['P2.5.md'],
  R3: ['P3.md', 'transition-final.md', '.tmp-validate-warnings.json', '.tmp-conflicts.json', '.tmp-speech-quotes.txt'],
  R4: ['structure.json', 'full-data.md', '.tmp-r45-input.md'],
  'R4.5': ['adjudication.json', '.tmp-adjudication.json', '.tmp-adjudicated-data.md', '.tmp-adjudicated-structure.json'],
  R5A: ['.tmp-r5-half-A.md', '叙事.md'], R5B: ['.tmp-r5-half-B.md', '叙事.md'],
  R6: RESUME_R6_FILES, R7: RESUME_R7_FILES, R8: RESUME_R8_FILES
};
const RESUME_OUT_FILES = {
  R1: 'P1.md', R2: 'P2.md', 'R2.5': 'P2.5.md', R3: 'P3.md', R4: 'structure.json',
  'R4.5': 'adjudication.json', R5A: '.tmp-r5-half-A.md', R5B: '.tmp-r5-half-B.md', R6: 'report.html'
};
function resumeInvalidationNames(plan, existingNames) {
  const nodes = plan && Array.isArray(plan.invalidatedNodes) ? plan.invalidatedNodes : [];
  const wanted = {};
  nodes.forEach(node => (RESUME_NODE_FILES[node] || []).forEach(name => { wanted[name] = true; }));
  (existingNames || []).forEach(rawName => {
    const name = String(rawName || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (name.includes('/')) return; // resume 正式产物均在 workDir 根；禁止借 planner 递归扫目录。
    for (let i = 0; i < nodes.length; i++) {
      const out = RESUME_OUT_FILES[nodes[i]];
      if (out && name.indexOf(out + '.attempt') === 0 && /^\.attempt\d+$/.test(name.slice(out.length))) wanted[name] = true;
    }
    if ((nodes.includes('R7') || nodes.includes('R6')) && /^\.tmp-plain-batch-\d+\.json$/.test(name)) wanted[name] = true;
  });
  return Object.keys(wanted).sort();
}

function inferResumeSettings(workDir, cliArgs, fileCfg, requestedNode) {
  const has = name => fs.existsSync(path.join(workDir, name));
  const argv = cliArgs || [];
  const plain = argv.includes('--plain') || (fileCfg && fileCfg.plain === true) || has('report-plain.html') || has('.tmp-plain-review.json');
  const readerGuide = argv.includes('--reader-guide') || (fileCfg && fileCfg.readerGuide === true) || has('reader-guide.json') || canonicalResumeNode(requestedNode) === 'R8';
  return { plain: !!plain, readerGuide: !!readerGuide };
}
function buildResumePlanForDir(workDir, requestedNode, settings) {
  // CLI/Skill 没有 Web runModel 时仍使用同一依赖图；已有 Web stale 只能由 Web runModel 做扩张，
  // 因此 CLI 不伪造 stale。现有轮产物仍会在 host.runPipeline 中逐轮正式 validate 后才允许 skip。
  return planResumeStart({ requestedNode, runModel: { staleRounds: {} }, settings: settings || {} });
}
function applyResumeRewindFs(workDir, plan) {
  const names = fs.readdirSync(workDir, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name);
  const remove = resumeInvalidationNames(plan, names);
  for (const name of remove) {
    const p = path.join(workDir, name);
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  }
  return remove;
}
function createResumeVersionSnapshotFs(workDir, meta) {
  const parent = path.dirname(workDir);
  const root = path.join(parent, '.resume-versions', path.basename(workDir));
  fs.mkdirSync(root, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  let versionId = stamp;
  let n = 1;
  while (fs.existsSync(path.join(root, versionId))) versionId = stamp + '-' + (++n);
  const finalDir = path.join(root, versionId);
  const tmpDir = finalDir + '.tmp-' + process.pid + '-' + Math.random().toString(16).slice(2);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const copied = [];
    for (const ent of fs.readdirSync(workDir, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      // API 配置可能含凭据；版本归档只保存裁决/断点/报告，不复制凭据文件。
      if (ent.name === '.api-config.json') continue;
      fs.copyFileSync(path.join(workDir, ent.name), path.join(tmpDir, ent.name));
      copied.push(ent.name);
    }
    fs.writeFileSync(path.join(tmpDir, 'version-manifest.json'), JSON.stringify({
      schema: 'judge-resume-version-v1', versionId, sourceDir: path.basename(workDir), createdAt: new Date().toISOString(),
      requestedNode: meta && meta.requestedNode || null, files: copied.sort()
    }, null, 2), 'utf8');
    fs.renameSync(tmpDir, finalDir);
    return { versionId, dir: finalDir, files: copied.sort() };
  } catch (e) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    throw e;
  }
}

// ==================== ID 契约工具（M-ID/CP-ID 单一事实源·纯函数·无状态——定义在 executor/contract.js，卡 6/卡 9） ====================

// structure.json 内 ID 字段递归归一（m_ids / m_id / cross_reference.m_to_layer[].m_id——定义在 executor/contract.js，卡 6）

// ==================== 数据提取 ====================

// ==================== 枚举约束表
// ENUMS 已迁移至 JSON 注册表 (V7.4)
let ENUMS_CACHE = null;

// INSERT 注册表读取（定义在 executor/contract.js，卡 9——getEnums/ENUMS_CACHE 留本文件）

function generateInsertContract(registry, agentType) {
  const filterMap = {
    // A1 修正：R5-B 半区负责输出 C8 整章（6 个 INSERT 的 producer 是 R2.5），合同必须一并包含
    'R5':   r => r.producer === 'R5' || (r.ch === 'C8' && r.producer === 'R2.5'),
    'R6a':  r => r.producer === 'R6a',
    'R6b':  r => r.consumer === 'R6b',
    'R2.5': r => r.producer === 'R2.5'
  };
  const filtered = registry.inserts.filter(filterMap[agentType] || (() => true));
  const byChapter = {};
  for (const r of filtered) {
    if (!byChapter[r.ch]) byChapter[r.ch] = [];
    byChapter[r.ch].push(r);
  }
  let contract = '\n\n---\n\n## ⛔ INSERT 合同（V7.4·自动生成）\n\n';
  const labels = {
    'R5':   '以下 INSERT 必须按顺序作为块标记出现（仅 producer=R5）。\n',
    'R6a':  '以下 INSERT 必须由你生产并放入 HTML 骨架对应占位符（仅 producer=R6a）。\n',
    'R6b':  '以下 INSERT 必须在 HTML 中全部被替换。残留 = 阻断。\n',
    'R2.5': '以下 INSERT 由你生产。\n'
  };
  contract += labels[agentType] || '';
  for (const [ch, inserts] of Object.entries(byChapter)) {
    const names = inserts.map(r => {
      const cond = r.condition ? ' [条件:' + r.condition + ']' : '';
      return '<!--INSERT_' + r.name + '-->' + cond;
    }).join('\n  ');
    contract += '\n**' + ch + '** (' + inserts.length + '个):\n  ' + names + '\n';
  }
  if (agentType === 'R5') {
    // A5：把合同从“提示”升级为“硬约束 + 对照表”
    contract += '\n\n### 🚫 必出清单（无条件 INSERT · 漏写即整轮重跑）\n';
    for (const [ch, inserts] of Object.entries(byChapter)) {
      const uncond = inserts.filter(r => !r.condition);
      if (!uncond.length) continue;
      contract += '\n**' + ch + '**（' + uncond.length + '个 · 必须出现且非空）:\n  ' +
        uncond.map(r => '<!--INSERT_' + r.name + '-->').join('\n  ') + '\n';
    }
    contract += '\n\n### XP 行硬约束\n' +
      '- 每章 `## CN` 标题后首行输出 `<!--XP:[引导性设问·≤60字]-->`，不可省略、不可留空。\n' +
      '- 严禁自造 INSERT 名（未注册名 = 阻断）；每个无条件 INSERT 标记后必须紧跟非空内容。\n' +
      '- 禁止输出 `[块N]`、模板字面 `[N]`、枚举整串（如 `正方/反方/持平`）——全部替换为真实内容/单一枚举值。\n' +
      '- 判决/比分固定 正方:反方 顺序：`反方胜（3:7）`/`最终判决·反方获胜·比分3:7`，禁止写 7:3。\n';
  }
  // 260813 P1批 B1（S1 三源收敛）：R2.5 专用「枚举权威值」节——模型可见枚举值随注册表自动同步
  // （非 INSERT 条目，不影响上方 C8 (N个)/必出 DATA 键 计数；仅 R2.5 agentType 注入）
  if (agentType === 'R2.5') {
    const personas = registry.enums && Array.isArray(registry.enums['C8.叙事人格.姿态标签'])
      ? registry.enums['C8.叙事人格.姿态标签']
      : null;
    if (personas && personas.length > 0) {
      contract += '\n\n### 枚举权威值（R2.5 专用 · 随注册表自动同步）\n' +
        '- `C8.叙事人格.姿态标签` 唯一合法取值（首批，可扩展——扩展后随注册表同步生效）: ' +
        personas.join('|') + '\n';
    }
  }
  contract += '\n---\n**注意**：此合同从 JSON 注册表自动生成。\n';
  return contract;
}

// 2A：加载 input-contract 核心字典（定义在 executor/contract.js，卡 6——源文件优先，内嵌块回退）

// 2A：按轮次生成“必出 DATA/结构合同”（正推视图，供 runAll 注入 prompt）
function generateDataContract(contract, roundName) {
  const rc = (contract && contract.round_contracts || []).find(r => r.round === roundName);
  if (!rc) return '';
  let out = '\n\n---\n\n## ⛔ 本轮必出 DATA/结构合同（input-contract 自动生成）\n\n';
  if (rc.data_keys && rc.data_keys.length) {
    out += '**必出 DATA 键（' + rc.data_keys.length + '个）：**\n';
    for (const k of rc.data_keys) out += '- ' + (k.required ? '✅ 必出' : '⚠️ 条件/建议') + ' `' + k.id + '`\n';
  }
  if (rc.insert_ids && rc.insert_ids.length) {
    out += '\n**必出 INSERT（' + rc.insert_ids.length + '个 · 出现且非空）：**\n  ' +
      rc.insert_ids.map(n => '<!--INSERT_' + n + '-->').join('\n  ') + '\n';
  }
  if (rc.structure_fields) {
    out += '\n**structure.json 必填字段：**\n';
    for (const [k, arr] of Object.entries(rc.structure_fields)) out += '- ' + k + ': ' + arr.join(', ') + '\n';
  }
  if (rc.format) out += '\n**格式约束**：' + rc.format + '\n';
  out += '\n**输出硬约束**：禁止输出 `[块N]`、模板字面 `[N]`、枚举整串；DATA 键名逐字一致，值为真实内容。\n';
  out += '\n---\n**注意**：合同由 input-contract.json 自动生成；漏写/写错键名 = 阻断。\n';
  return out;
}

function validateRegistry(skillPath, options) {
  options = options || {};
  const crossRef = options.crossRef || false;
  try {
    const registry = parseInsertRegistry(skillPath);
    const result = { passed: true, count: registry.inserts.length, errors: [], warnings: [] };
    const names = registry.inserts.map(r => r.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    if (dupes.length > 0) { result.errors.push('重复 INSERT 名: ' + dupes.join(', ')); result.passed = false; }
    if (crossRef) {
      const content = fs.readFileSync(skillPath, 'utf-8');
      const allInsertsInMd = content.match(/<!--INSERT_([A-Z0-9_]+)-->/g) || [];
      const mdNames = allInsertsInMd.map(m => m.replace('<!--INSERT_', '').replace('-->', ''));
      const mdNameSet = {};
      mdNames.forEach(n => { mdNameSet[n] = true; });
      registry.inserts.forEach(r => {
        if (r.consumer === 'R6b' && !mdNameSet[r.name] && !r.condition)
          { result.errors.push('骨架中缺失: ' + r.name); result.passed = false; }
      });
      for (const name in mdNameSet) {
        if (!registry.inserts.some(r => r.name === name))
          { result.errors.push('未注册: ' + name); result.passed = false; }
      }
    }
    return result;
  } catch (e) {
    return { passed: false, count: 0, errors: [e.message], warnings: [] };
  }
}

// ==================== V7.9: 术语定义一致性检查（区域扫描·纯函数） ====================

function scanVersionMarkersContent(content) {
  const findings = [];
  const lines = content.split('\n');
  const yamlEnd = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  for (let i = 0; i < lines.length; i++) {
    if (yamlEnd >= 0 && i <= yamlEnd) continue;                    // YAML 头
    // 卡1（260816 E6）：EMBED_ASSET 块（PC_START 之前）内代码注释含括号版本形态——一并排除（只扫指令正文，与术语检查同构）
    if (/^<!-- EMBED_ASSET:[A-Z0-9_]+_START -->/.test(lines[i]) || lines[i].includes('PIPELINE_CONTROLLER_START')) break;
    const t1 = lines[i].match(/[（(][^）)]*[vV]\d+\.\d+[^）)]*[）)]/);   // 阻断：括号内任意位置含版本号
    if (t1) findings.push({ line: i + 1, tier: 1, text: t1[0] });
    else {
      const t2 = lines[i].match(/\b[Vv]\d+\.\d+/);                  // 警告：裸版本号
      if (t2) findings.push({ line: i + 1, tier: 2, text: t2[0] });
    }
  }
  const blocking = findings.filter(f => f.tier === 1);
  return { passed: blocking.length === 0, blocking, warnings: findings.filter(f => f.tier === 2) };
}

// ==================== V7.9: 内嵌 JS 块提取（纯函数·供 self-check 与测试使用） ====================

function extractEmbeddedBlock(content) {
  // A8-P4 修复：正则拆串（内嵌源码不再含完整标记字面量）
  const m = content.match(new RegExp('<!-- PIPELINE_CONTROLLER_' + 'START -->\\s*```javascript\\s*([\\s\\S]*?)\\s*```\\s*<!-- PIPELINE_CONTROLLER_' + 'END -->'));
  if (!m) return { ok: false, code: '', after: '' };
  return { ok: true, code: m[1].trim(), after: content.slice(m.index + m[0].length) };
}

// ==================== V7.9: self-check 统一门禁 ====================

function selfCheck() {
  const vm = require('vm');
  const norm = s => s.replace(/\r\n/g, '\n').trim();
  const src = norm(fs.readFileSync(__dirname + '/pipeline-controller.js', 'utf-8'));
  const skill = fs.readFileSync(__dirname + '/Skill-Judge.md', 'utf-8').replace(/\r\n/g, '\n');
  const results = [];

  // 1) 内嵌 JS 内容一致（哈希级）+ 块后无残留（结构断言，防同步操作截断留下旧尾）
  const eb = extractEmbeddedBlock(skill);
  // A8-P4：块后允许且仅允许 EMBED_ASSET_LIST 区块（构建期硬编码）
  const after = eb.after.trim();
  const afterOk = after === '' || /^<!-- EMBED_ASSET_LIST -->[\s\S]*$/.test(after);
  results.push({ name: 'JS内嵌一致', ok: eb.ok && norm(eb.code) === src && afterOk });

  // 2) 三镜像一致
  const peers = ['Debate-Judge.md', '.claude/skills/debate-judge/SKILL.md']
    .map(p => { try { return norm(fs.readFileSync(__dirname + '/' + p, 'utf-8')); } catch (e) { return ''; } });
  // 单文件交付模式：镜像副本不存在（接收者只拿到 Skill-Judge.md）→ 跳过比对视为通过；
  // 开发工作区（镜像齐全）→ 仍严格逐字一致
  const missingMirror = !fs.existsSync(__dirname + '/Debate-Judge.md') || !fs.existsSync(__dirname + '/.claude/skills/debate-judge/SKILL.md');
  results.push({ name: '三镜像一致', ok: missingMirror || (peers[0] === norm(skill) && peers[1] === peers[0]) });

  // 2b) 项目根 Claude 入口壳形态检查（批 5 / 260812 P0-1）：存在但过期视同 FAIL——
  // 根 .claude/skills/debate-judge/SKILL.md 与根 Debate-Judge.md 必须为轻量壳（shellTemplate 生成物，
  // 含壳特征标记且 <50KB）；若为全量副本（>100KB）则必须逐字等于权威（历史形态兼容）。
  // 当前仓库根布局守卫（AGENTS.md 存在性）：不得跨到父级 workspace；单文件交付/异地解包等无根布局场景跳过。
  const rootLayoutOk = fs.existsSync(path.join(__dirname, 'AGENTS.md'));
  const shellMark = '按需从权威文件切片加载规则';
  if (rootLayoutOk) {
    for (const rel of ['.claude/skills/debate-judge/SKILL.md', 'Debate-Judge.md']) {
      const p = path.join(__dirname, rel);
      const name = '根壳同步: ' + rel;
      if (!fs.existsSync(p)) { results.push({ name, ok: false }); continue; }
      const c = fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n');
      const ok = c.length > 100 * 1024
        ? (norm(c) === norm(skill))
        : (c.includes(shellMark) && c.length < 50 * 1024);
      results.push({ name, ok });
    }
  }

  // 3) JS 语法（编译，不执行）
  let syntaxOk = true;
  try { new vm.Script(src); } catch (e) { syntaxOk = false; }
  results.push({ name: 'JS语法', ok: syntaxOk });

  // 4) 术语定义
  const term = validator.checkTerminologyContent(skill);
  results.push({ name: '术语定义', ok: term.passed, detail: term.errors });

  // 5) 注册表
  const reg = validateRegistry(__dirname + '/Skill-Judge.md', { crossRef: true });
  results.push({ name: '注册表', ok: reg.passed, detail: reg.errors });

  // 6) 版本标记
  const vmScan = scanVersionMarkersContent(skill);
  results.push({ name: '版本标记', ok: vmScan.passed,
    detail: vmScan.blocking.map(f => 'L' + f.line + ' ' + f.text),
    warnings: vmScan.warnings.map(f => 'L' + f.line + ' ' + f.text) });

  // 7) 单元测试
  let testsOk = true, testOut = '';
  try {
    const testPath = __dirname + '/tests/self-check.test.js';
    if (fs.existsSync(testPath)) {
      testOut = require('child_process').execFileSync(process.execPath, ['--test', testPath], { encoding: 'utf-8' });
    } else {
      // 单文件交付模式：tests 是开发资产不随单文件交付，self-check 跳过单元测试项（运行时完整性由其余 7 项覆盖）
      testsOk = true; testOut = '单文件模式：tests 未交付，单元测试项跳过（其余 7 项已全绿）';
    }
  } catch (e) { testsOk = false; testOut = (e.stdout || '').toString(); }
  results.push({ name: '单元测试', ok: testsOk });

  // 8) Ω1 产物（schema 合法 + 渲染器可加载 + 资产闭合）
  let o1ok = true, o1detail = [];
  try {
    for (const f of ['tendency', 'criteria', 'index', 'model-snapshot', 'presentation']) {
      JSON.parse(fs.readFileSync(__dirname + '/schemas/' + f + '.schema.json', 'utf-8'));
    }
  } catch (e) { o1ok = false; o1detail.push('schema 解析失败: ' + e.message); }
  try { require(__dirname + '/render-report.js'); } catch (e) { o1ok = false; o1detail.push('render-report 加载失败: ' + e.message); }
  const assetClosure = syncAssets();
  if (!assetClosure.ok) { o1ok = false; o1detail = o1detail.concat(assetClosure.errors); }
  results.push({ name: 'Ω1产物', ok: o1ok, detail: o1detail });

  const failed = results.filter(r => !r.ok);
  return { passed: failed.length === 0, results, testOutput: testOut };
}

// ==================== 规则引擎 ====================

// ==================== A8-ERR-1 输出目录机制（场次隔离） ====================

// 有效场次目录格式（唯一可识别格式）：judge-YYMMDD.HHMMSS[-<slug>]；archive/ 与其它目录一律不识别
// \p{Script=Han} 覆盖 CJK 基本区+扩展区（生僻字/日韩变体），需 u 标志；撞名序号（-2/-3…）由尾段兼容
const VALID_OUTPUT_DIR_RE = /^judge-\d{6}\.\d{6}(-[A-Za-z0-9\p{Script=Han}-]+)?$/u;
const ERR_OUTPUT_ISOLATION = 'ERR_OUTPUT_ISOLATION';
function outputIsolationError(msg) {
  const e = new Error(msg);
  e.code = ERR_OUTPUT_ISOLATION;
  return e;
}

// 输出目录唯一解析入口：显式目录优先（允许“基于某目录继续”）；否则自动新建时间戳目录
// slugOverride：可选覆盖 slug（供测试/调用方注入）；rootOverride：仅测试注入临时根
// 返回 { dir, created }：created=false 表示目录已存在（非本次新建）
function defaultOutputRoot() {
  return path.join(__dirname, 'Output');
}

function resolveOutputDir(speechFile, explicitDir, slugOverride, rootOverride) {
  const path = require('path');
  const fs = require('fs');
  if (explicitDir) {
    if (!fs.existsSync(explicitDir)) fs.mkdirSync(explicitDir, { recursive: true });
    return { dir: path.resolve(explicitDir), created: false };
  }
  const ts = new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = String(ts.getFullYear()).slice(2) + pad(ts.getMonth() + 1) + pad(ts.getDate()) + '.' +
    pad(ts.getHours()) + pad(ts.getMinutes()) + pad(ts.getSeconds());
  const slug = (slugOverride || path.basename(speechFile, path.extname(speechFile)) || '')
    .replace(/[\\/:*?"<>|.]/g, '-').replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 24);   // T5：清理点号/前缀后缀连字符（.tmp-debate → tmp-debate）
  const root = rootOverride || defaultOutputRoot();   // 输出根固定在当前 Debate-Judge 项目内，不随辩词位置漂移
  let dir = path.join(root, 'judge-' + stamp + (slug ? '-' + slug : ''));
  let n = 1;
  while (fs.existsSync(dir)) dir = dir + '-' + (++n);                  // 同秒撞名加序号
  // 不变量内聚于生成处：自动路径必须产出合法格式名（slug 清洗有 bug 时立即暴露）
  if (!VALID_OUTPUT_DIR_RE.test(path.basename(dir))) {
    throw outputIsolationError('内部错误：生成的目录名不符合有效格式: ' + dir);
  }
  fs.mkdirSync(dir, { recursive: true });
  return { dir: path.resolve(dir), created: true };
}

// 场次隔离门禁：显式目录分级（archive 阻断 / 非标准需 --force / 标准允许）；自动分支由 resolveOutputDir 保证新建+合法名
function ensureFreshOutputDir(speechFile, explicitDir, force, rootOverride) {
  const r = resolveOutputDir(speechFile, explicitDir, null, rootOverride);
  const path = require('path');
  const name = path.basename(r.dir);
  if (explicitDir) {
    if (path.basename(explicitDir) === 'archive' || /(^|[\\/])archive([\\/]|$)/.test(explicitDir)) {
      throw outputIsolationError('归档目录不可写: ' + explicitDir);
    }
    if (!VALID_OUTPUT_DIR_RE.test(name) && !force) {
      throw outputIsolationError('非标准输出目录（缺 .HHMMSS 或格式不符）: ' + name + '；确认请 --force');
    }
    return r;
  }
  return r;
}

// A8-ERR-1 C10：递归记录目录下所有文件（排除 .baseline.json 自身）的相对路径 + MD5
function baselineManifest(dir) {
  const path = require('path');
  const fs = require('fs');
  const crypto = require('crypto');
  const out = {};
  const walk = d => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && ent.name !== '.baseline.json') {
        out[path.relative(dir, p).replace(/\\/g, '/')] = crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
      }
    }
  };
  walk(dir);
  return out;
}

// 卡1（260816）：validate 分发迁至 executor/validator.js（单一接口）——PC 薄 wrapper 委托
function validate(md, round, options = {}) {
  return validator.validate(md, round, options);
}

// ==================== F类规则 ====================

// A8-ERR-1：S 标记解析支持子步骤（S8.x/S10.x 归并为主步骤）——与 R2/R3 输出合同对齐
function autoFixDataValues(content) {
  let enums;
  try { enums = validator.getEnums(__dirname + '/Skill-Judge.md'); } catch (e) { enums = {}; }
  const fixes = [];
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  const out = lines.map(line => {
    const m = line.match(/^<!--DATA:\s*(\S+?)=(.+?)\s*-->$/);
    if (!m) return line;
    const key = m[1];
    const allowed = enums[key];
    if (!allowed || allowed.length === 0) return line;
    const raw = m[2].trim();
    if (allowed.includes(raw)) return line;
    const norm = validator.normalizeEnumValue(raw);
    if (norm === null || !allowed.includes(norm)) return line;
    fixes.push({ key, from: raw, to: norm });
    return line.replace(m[2].trim(), norm);
  });
  return { text: out.join('\n'), fixes };
}

// ==================== 批次3 新增（260810） ====================

// 5:5 判胜护栏：S15.2 判准应用推理必出（prose 提取·仅 5:5 触发·机械不做语义充分性判定）
function injectDerivedDataLines(mergedText) {
  const m = mergedText.match(/^<!--DATA: S8\.SC完成度=([^\s>]+)\s*-->$/m);
  if (!m) return mergedText;
  if (/^<!--DATA: S8\.S11类型方向=/m.test(mergedText)) return mergedText;   // 旧数据已有 → 不重写
  const dir = validator.deriveDirection(String(m[1]).split(/[|，,]/)[0].trim());
  if (dir === null) return mergedText;
  return mergedText.replace(m[0], m[0] + '\n<!--DATA: S8.S11类型方向=' + dir + ' -->');
}

// 文本版（R2/final 门禁可用：P1.md / merged 文本）
function stripJavaScriptBlocks(content) {
  return content.replace(/\x60\x60\x60javascript[\s\S]*?\x60\x60\x60/g, '');
}

function buildSectionIndex(skillPath) {
  const content = fs.readFileSync(skillPath, 'utf-8');
  const stripped = stripJavaScriptBlocks(content);
  const index = {};

  const sharedMatch = content.match(/<!-- SECTION:SHARED_START -->([\s\S]*?)<!-- SECTION:SHARED_END -->/);
  if (sharedMatch) {
    index.shared = sharedMatch[1];
  } else {
    const fallback = stripped.match(/## 共享资源[\s\S]*?(?=\n## R1 PROMPT)/);
    index.shared = fallback ? fallback[0] : null;
  }

  const roundRegex = /<!-- SECTION:(R[1-9](?:\.[0-9])?[ab]?)_START -->([\s\S]*?)<!-- SECTION:\1_END -->/g;
  let match;
  while ((match = roundRegex.exec(content)) !== null) {
    index[match[1]] = match[2];
  }

  const roundKeys = SECTION_ROUNDS;  // 260816 切片契约单一源（executor/core.js）
  for (const key of roundKeys) {
    if (!index[key]) {
      const num = key.replace('R', '');
      // 260815 卡8：行首锚定——防命中内嵌代码文本（Skill-Judge.md L636 含 '## R2.5 PROMPT' 字符串）→ 垃圾切片静默污染 LLM
      const fallbackRegex = new RegExp('^## R' + num + ' PROMPT[\\s\\S]*?(?=\\n## R[1-9]|$)', 'm');
      const fallbackMatch = stripped.match(fallbackRegex);
      if (fallbackMatch) {
        index[key] = fallbackMatch[0];
        index[key + '_FALLBACK'] = true;
      } else {
        index[key] = null;
      }
    }
  }

  return index;
}

function loadRoundPromptFallback(roundNumber, fullContent) {
  const full = fullContent || fs.readFileSync(__dirname + '/Skill-Judge.md', 'utf-8');
  const roundKey = String(roundNumber);
  const clean = stripJavaScriptBlocks(full);

  const sharedMatch = clean.match(/## 共享资源[\s\S]*?(?=\n## R1 PROMPT)/);
  const shared = sharedMatch ? sharedMatch[0] : '';

  const startMarker = '## R' + roundKey + ' PROMPT';
  const endMap = SECTION_ENDMAP;  // 260816 切片契约单一源（executor/core.js）
  const endMarker = endMap[roundKey];

  // 260815 卡8：行首锚定——防命中内嵌代码文本；roundKey 含小数点（2.5/4.5）须转义
  const startRe = new RegExp('^## R' + String(roundKey).replace('.', '\\.') + ' PROMPT', 'm');
  const startMatch = clean.match(startRe);
  const startIdx = startMatch ? startMatch.index : -1;
  if (startIdx === -1) throw new Error('回退失败：未找到 ' + startMarker + '（SECTION 解析已失败且行首标题缺失——请修复 Skill-Judge.md 标记）');
  const endIdx = endMarker ? clean.indexOf(endMarker, startIdx) : clean.length;
  const section = clean.substring(startIdx, endIdx);

  return shared + '\n' + section;
}

// 切片缓存（loadRoundPrompt 模块级状态；卡1 迁移时原定义随 checkCompletionConsistency 块误删——260816 E2 修复回插）
let sectionIndexCache = null;

function loadRoundPrompt(roundNumber) {
  const skillPath = __dirname + '/Skill-Judge.md';
  const roundKey = String(roundNumber);

  // 卡7（260815）：ROUNDS 单一源派生——valid = num 集去重；nameMap = num→name（num '5' 双条目特判 → 'R5' 通用轮名）
  const ROUND_NUMS = [...new Set(ROUNDS.map(r => r.num))];
  const valid = ROUND_NUMS;
  if (!valid.includes(roundKey)) throw new Error('轮次必须在 1-5 或 2.5/6a/6b 之间');

  if (!sectionIndexCache) {
    try {
      sectionIndexCache = buildSectionIndex(skillPath);
    } catch (e) {
      console.warn('[loadRoundPrompt] 标记解析失败，回退到旧版搜索:', e.message);
      const full = fs.readFileSync(skillPath, 'utf-8');
      return loadRoundPromptFallback(roundNumber, full);
    }
  }

  const nameMap = Object.fromEntries(ROUNDS.map(r => [r.num, r.name]));
  nameMap['5'] = 'R5';
  const cacheKey = nameMap[roundKey];

  if (!sectionIndexCache.shared) {
    throw new Error('未找到共享资源段。请插入 <!-- SECTION:SHARED_START --> 标记。');
  }

  if (!sectionIndexCache[cacheKey]) {
    const isFallback = sectionIndexCache[cacheKey + '_FALLBACK'];
    throw new Error(isFallback
      ? '轮次 ' + cacheKey + ' 使用降级路径加载（未找到边界标记）。请插入标记。'
      : '未找到轮次 ' + cacheKey + '。请插入边界标记。');
  }

  if (sectionIndexCache[cacheKey + '_FALLBACK']) {
    console.warn('[loadRoundPrompt] ' + cacheKey + ' 使用降级路径加载，建议插入边界标记。');
  }

  return sectionIndexCache.shared + '\n\n' + sectionIndexCache[cacheKey];
}

// ==================== 重试 ====================

function formatErrorReport(blocking) {
  const lines = [
    '\n⚠️ 上一次产出未通过逻辑一致性验证。以下是具体错误：\n',
    ...blocking.map((e, i) => `[${i+1}] ${e.rule}: ${e.message}`),
  ];

  // F5增强：提取缺失步骤名称，给出具体修正指引
  const f5Errors = blocking.filter(e => e.rule === 'F5');
  if (f5Errors.length > 0) {
    const missingSteps = f5Errors.map(e => {
      const m = e.message.match(/S(\d+(?:\.\d+)?)/);
      return m ? `S${m[1]}` : null;
    }).filter(Boolean);
    lines.push(`\n📋 **缺失步骤汇总**：以下 ${missingSteps.length} 个步骤缺少 \`### 结论\` 子块——`, ...missingSteps.map(s => `  - ${s}`));
    lines.push(`\n🔧 **修正指引**：在每个缺失步骤的 \`[S_END=${missingSteps[0].split('.')[0]}]\` 之前，插入：\n\`\`\`\n### 结论\n[该步骤的核心发现·≤120字]\n\`\`\``);
  }

  lines.push(
    '\n请只修正上述错误涉及的字段。其他已通过验证的字段不要改动。',
    '如果你认为验证脚本的判断有误，请解释原因，不要强行修改正确的数据。\n'
  );
  return lines.join('\n');
}

// ==================== C8: R5 叙事输出验证 ====================

// A1 辅助：条件字段解析（def → S4.定义争议触发，与 checkHtml scaffold 同口径）
function autoFixTables(merged) {
  // 修复常见表格格式问题：补齐缺失的管道符、统一分隔行格式
  let fixed = merged;
  // 确保表格分隔行格式一致
  fixed = fixed.replace(/^\|[-|:\s]+$/gm, (match) => {
    // 计算列数并补齐管道符
    const cols = (match.match(/\|/g) || []).length - 1;
    // F-13 审计响应：单列分隔行（如 |---|）直接放行，防止 C2 等 COLSPAN 表被膨胀列数
    if (cols < 2) return match;
    const cells = [];
    for (let i = 0; i < cols; i++) cells.push('---');
    return '|' + cells.join('|') + '|';
  });
  return fixed;
}

// A8-ERR-1：S 标记机械归一化——模型输出可能漏写开/闭标记（内容完整但标记缺失），
// 与 autoFixTables 同级：孤立 [S_END=Sn] → 在最近前标记后补 [S_START=Sn]；孤立 [S_START=Sn] → 在下一标记前补 [S_END=Sn]
function autoFixSMarkers(md) {
  if (!md) return md;
  const lines = String(md).split('\n');
  const starts = new Set(), ends = new Set();
  for (const l of lines) {
    const m = l.trim().match(/^\[S_START=S(\d+)(?:\.\d+)?\]$/);
    if (m) starts.add(m[1]);
    const n = l.trim().match(/^\[S_END=S(\d+)(?:\.\d+)?\]$/);
    if (n) ends.add(n[1]);
  }
  const isMarker = t => /^\[S_(START|END)=S\d+(?:\.\d+)?\]$/.test(t);
  const out = [];
  // 第一遍：孤立 END → 补 START（最近前标记之后）
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const mEnd = t.match(/^\[S_END=S(\d+)(?:\.\d+)?\]$/);
    if (mEnd && !starts.has(mEnd[1])) {
      let insertAt = 0;   // 无前标记（文件开头）→ 插到最前
      for (let j = out.length - 1; j >= 0; j--) {
        if (isMarker(out[j].trim())) {
          insertAt = j + 1;
          break;
        }
      }
      out.splice(insertAt, 0, '[S_START=S' + mEnd[1] + ']');
      starts.add(mEnd[1]);
    }
    out.push(lines[i]);
  }
  // 第二遍：孤立 START → 补 END（下一个标记之前；从后往前插入避免索引偏移）
  const missingEnd = [];
  for (let i = 0; i < out.length; i++) {
    const m = out[i].trim().match(/^\[S_START=S(\d+)(?:\.\d+)?\]$/);
    if (m && !ends.has(m[1])) missingEnd.push({ n: m[1], at: i });
  }
  for (const item of missingEnd.reverse()) {
    let insertIdx = out.length;
    for (let j = item.at + 1; j < out.length; j++) {
      if (isMarker(out[j].trim())) { insertIdx = j; break; }
    }
    out.splice(insertIdx, 0, '[S_END=S' + item.n + ']');
  }
  return out.join('\n');
}

// ==================== TABLE 配对校验（栈式算法·P0-2·D+方案第三层） ====================

function validateTablePairing(content) {
  const regex = /<!--TABLE:[^>]+-->|<!--\/TABLE-->/g;
  const tokens = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    tokens.push({
      token: match[0],
      index: match.index,
      isOpen: match[0].startsWith('<!--TABLE:')
    });
  }

  const stack = [];
  const errors = [];

  for (const t of tokens) {
    if (t.isOpen) {
      stack.push(t);
    } else {
      if (stack.length === 0) {
        errors.push('多余的 CLOSE（位置 ' + t.index + '），栈为空');
      } else {
        stack.pop();
      }
    }
  }

  if (stack.length > 0) {
    errors.push('未闭合的 OPEN 剩余 ' + stack.length + ' 个（最早位置 ' + stack[0].index + '）');
  }

  if (errors.length > 0) {
    return { passed: false, errors };
  }
  return { passed: true, count: tokens.length / 2 };
}

function buildRoundPrompt(prompt, roundNum, speech, tendency) {
  let full = `# Debate-Judge V1.0 · R${roundNum} Prompt\n`;
  full += `> 生成时间: ${new Date().toISOString()}\n`;
  if (tendency) full += `> 裁判倾向: ${tendency}\n`;

  // B10: 辩词转义——防止辩词原文中的管道控制字符干扰 DATA 标记解析
  if (speech) {
    speech = speech
      .replace(/\[S_START/g, '[S\\_START')
      .replace(/\[S_END/g, '[S\\_END')
      .replace(/\[FILE_END\]/g, '[FILE\\_END]')
      .replace(/<!--DATA:/g, '<\\!--DATA:');
  }

  const rn = String(roundNum);
  if (rn === '1' || rn === '2') {
    if (speech) full += `\n---\n\n## 辩词原文\n\n${speech}\n`;
  } else if (rn === '3') {
    // C4: R3 不嵌入辩词全文——辩词引用块由管道编排器从 P1/P2 中提取后追加
    full += `\n---\n\n## 辩词引用块\n\n<!-- SPEECH_QUOTES_PLACEHOLDER: 辩词引用块由管道编排器从 P1/P2 中 grep 提取后追加 -->\n`;
  }
  full += `\n---\n\n${prompt}\n`;
  return full;
}

/**
 * 按章节列表裁剪 R5 Prompt
 * @param {string} basePrompt - loadRoundPrompt 返回的完整 R5 内容
 * @param {string[]} chapters - 需要保留的章节列表
 * @param {string} label - 半区标签
 * @returns {string} 裁剪后的内容
 * @throws {Error} 如果任何章节缺失，阻断管道
 */
function cropPromptByChapters(basePrompt, chapters, label) {
  // 1. 提取头部：到第一个 #### C 之前的所有内容（共享资源 + R5-0~R5-4 通用指令）
  var headerMatch = basePrompt.match(/^([\s\S]*?)(?=\n#### C\d)/);
  var header = headerMatch ? headerMatch[1] : '';

  // 2. 逐个提取章节
  var chapterContents = [];
  var missingChapters = [];

  for (var i = 0; i < chapters.length; i++) {
    var c = chapters[i];
    var re = new RegExp('#### ' + c + '[\\s\\S]*?(?=\\n#### C\\d|$)');
    var match = basePrompt.match(re);
    if (match) {
      chapterContents.push(match[0]);
    } else {
      missingChapters.push(c);
    }
  }

  // 3. 任何章节缺失 → 阻断
  if (missingChapters.length > 0) {
    throw new Error(
      '[cropPromptByChapters] 半区 ' + label + ' 缺少章节: ' + missingChapters.join(', ')
    );
  }

  // 4. 用单换行符拼接
  var result = header + chapterContents.join('\n');

  // 5. 验证非空
  if (result.trim().length === 0) {
    throw new Error('[cropPromptByChapters] 半区 ' + label + ' 裁剪结果为空');
  }

  return result;
}

const ERR_DEBATE_BINDING_MISMATCH = 'ERR_DEBATE_BINDING_MISMATCH';
const ERR_SEMANTIC_AUTHORITY = 'ERR_SEMANTIC_AUTHORITY';

function normalizeDebateBindingText(text) {
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n');
}

function debateBindingSha256(text) {
  return require('crypto').createHash('sha256').update(normalizeDebateBindingText(text), 'utf8').digest('hex');
}

function assertDebateBinding(workDir, currentSpeech) {
  const debatePath = require('path').join(workDir, '.tmp-debate.txt');
  if (!require('fs').existsSync(debatePath)) {
    require('fs').writeFileSync(debatePath, currentSpeech, 'utf-8');
    return { created: true, sha256: debateBindingSha256(currentSpeech) };
  }
  const existing = require('fs').readFileSync(debatePath, 'utf-8');
  const oldSha = debateBindingSha256(existing);
  const newSha = debateBindingSha256(currentSpeech);
  if (oldSha !== newSha) {
    const e = new Error('当前历史会话已绑定另一份辩词，不能混场续跑。请恢复该会话原辩词，或新建一次分析。 old_sha256=' + oldSha + ' new_sha256=' + newSha);
    e.code = ERR_DEBATE_BINDING_MISMATCH;
    throw e;
  }
  return { created: false, sha256: oldSha };
}

function semanticAuthorityError(message) {
  const e = new Error(message);
  e.code = ERR_SEMANTIC_AUTHORITY;
  return e;
}

function loadRunSemanticAuthorities(skillPath, options) {
  options = options || {};
  const registryLoader = options.registryLoader || parseInsertRegistry;
  const registryValidator = options.registryValidator || validateRegistry;
  const inputContractLoader = options.inputContractLoader || loadInputContract;
  const terminologyCheck = options.terminologyCheck || validator.checkTerminology;
  let registry;
  try { registry = registryLoader(skillPath); }
  catch (e) { throw semanticAuthorityError('INSERT 注册表加载失败——禁止启动正式管道: ' + e.message); }
  const rv = registryValidator(skillPath, { crossRef: true });
  if (!rv || !rv.passed) throw semanticAuthorityError('INSERT 注册表交叉校验失败——禁止启动正式管道: ' + ((rv && rv.errors) || []).join('; '));
  let inputContract;
  try { inputContract = inputContractLoader(); }
  catch (e) { throw semanticAuthorityError('input-contract 加载失败——禁止启动正式管道: ' + e.message); }
  if (!inputContract || !Array.isArray(inputContract.data) || !Array.isArray(inputContract.round_contracts)) {
    throw semanticAuthorityError('input-contract 结构非法——data / round_contracts 必须为数组');
  }
  const termCheck = terminologyCheck(skillPath);
  if (!termCheck || !termCheck.passed) {
    throw semanticAuthorityError('术语定义一致性检查未通过——禁止启动正式管道: ' + (((termCheck && termCheck.errors) || []).join('; ') || '未知术语错误'));
  }
  return { registry, inputContract, termCheck };
}

function runAll(speechFile, options = {}) {
  const speech = fs.readFileSync(speechFile, 'utf-8');
  const tendency = options.tendency || '';
  // A8-ERR-1：工作目录统一经场次隔离门禁——未显式指定时自动新建时间戳目录，不再跟随辩词文件所在目录
  const { dir: workDir } = ensureFreshOutputDir(speechFile, options.outputDir, options.force);
  // 正式场次事务绑定：同一 output dir 只能对应同一份规范化辩词；force 只控制重算，不得绕过绑定。
  assertDebateBinding(workDir, speech);
  // mandatory semantic-authority preflight：在任何 prompt / 并行元数据落盘前完成。
  const authorities = loadRunSemanticAuthorities(__dirname + '/Skill-Judge.md');
  const registry = authorities.registry;
  const inputContract = authorities.inputContract;
  const startTime = Date.now();

  // 卡7（260815）：ROUNDS 单一源——直接引用 core.ROUNDS（含 parallelGroup 字段；R5A/R5B 拆开）
  const rounds = ROUNDS;
// 新增：输出并行组元数据供编排层使用
  const parallelGroups = {};
  for (const r of rounds) {
    if (r.parallelGroup !== null) {
      if (!parallelGroups[r.parallelGroup]) parallelGroups[r.parallelGroup] = [];
      parallelGroups[r.parallelGroup].push(r.name);
    }
  }
  const groupsPath = require('path').join(workDir, '.tmp-parallel-groups.json');
  require('fs').writeFileSync(groupsPath, JSON.stringify({ groups: parallelGroups, note: '登记：并行调度环境预留（半完成·260813 注记）——当前执行器顺序执行；R5∥R6a 组失真：R6a 机械渲染依赖 R5 产物不可并行；R2/R4 为单成员组；R2.5/R4.5 null 组=等待前组全部完成（非失真）' }, null, 2));
  console.log(`[run-all] 并行组元数据: ${groupsPath}`);

  console.log(`[run-all] 辩词: ${speechFile} (${speech.length}字) → 生成 ${rounds.length} 个 prompt 文件`);

  console.log(`[run-all] INSERT注册表已加载并交叉校验 (${registry.inserts.length}条)`);

  for (const round of rounds) {
    // V7.4-二分法: R5 拆为两个半区 Agent（卡7：half 分支——R5_HALVES 单一源，round 为 core.ROUNDS 项）
    if (round.half) {
      const half = R5_HALVES[round.half];
      const basePrompt = loadRoundPrompt(round.num);
      // 按半区裁剪章节内容
      let croppedPrompt;
      try {
        croppedPrompt = cropPromptByChapters(basePrompt, half.chapters, half.label);
      } catch (e) {
        console.error('[runAll] 章节裁剪失败:', e.message);
        throw e;
      }
      let full = buildRoundPrompt(croppedPrompt, round.num, round.hasSpeech ? speech : null, tendency);
      const halfRegistry = {
        ...registry,
        inserts: registry.inserts.filter(r => half.chapters.includes(r.ch))
      };
      // 卡7：filterMap 无 R5A/R5B 键——显式传 'R5' 防 fallback 全量注入（halfRegistry 已半区过滤）
      const contract = generateInsertContract(halfRegistry, 'R5');
      full = full + contract;
      const constraint = '\n\n---\n## 输出范围约束\n\n**你只负责输出 ' + half.range + ' 章节。** 不要输出 ' + half.exclude + '。\n\n**INSERT 处理规则**：\n- 只填充属于 ' + half.range + ' 的 INSERT\n- 不属于你范围的 INSERT 直接忽略，不输出、不删除、不修改\n\n示例：你负责 ' + half.range + '，看到 INSERT_' + (half.label === 'A' ? 'C8' : 'C1') + '_PROSE → 忽略它。\n';
      full = full + constraint;
      const outFile = require('path').join(workDir, round.promptFile);
      fs.writeFileSync(outFile, full, 'utf-8');
      console.log('  R5-' + half.label + ': ' + outFile + ' (' + full.length + '字)');
      continue;
    }

    const prompt = loadRoundPrompt(round.num);
    let full = buildRoundPrompt(prompt, round.num, round.hasSpeech ? speech : null, tendency);

    // INSERT 合同注入 (从注册表自动生成)——卡7：删 'R5'（half 分支已注入半区合同并 continue）
    if (['R6a','R6b','R2.5'].includes(round.name)) {
      const contract = generateInsertContract(registry, round.name);
      const count = contract ? (contract.match(/<!--INSERT_/g) || []).length : 0;
      full = full + contract;
      console.log('  ' + round.name + ': INSERT合同已注入 (' + count + '个占位)');
    }
    // 2A：input-contract 正推合同注入（本轮必出 DATA/结构清单）
    if (['R1','R2','R2.5','R3','R4'].includes(round.name)) {
      const dc = generateDataContract(inputContract, round.name);
      if (dc) {
        full = full + dc;
        console.log('  ' + round.name + ': DATA合同已注入 (input-contract)');
      }
    }

    const outFile = require('path').join(workDir, round.promptFile);
    fs.writeFileSync(outFile, full, 'utf-8');
    console.log('  ' + round.name + ': ' + outFile + ' (' + full.length + '字)');
  }
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[run-all] 完成。共 ${rounds.length} 个 prompt 文件，耗时 ${elapsed}s。`);

  // 新增：数据聚合阶段说明
  // 数据聚合在 R4 完成后、R5 之前执行（编排层负责）：
  //   cat P1.md P2.md P2.5.md P3.md > full-data.md（带 SECTION 分区和 INDEX 索引）
  // R5 仅读取 full-data.md 单文件。
  // 详情见 Skill-Judge.md §R5-1 数据完整性扫描（V3.2）。
  console.log('[run-all] V3.2: 数据聚合阶段（R4后·R5前）——编排层需将P1+P2+P2.5+P3拼接为full-data.md');

  // A8-P7：降级级别机制已移除——structure.json 的完整性由 R4 门禁机械强制（缺失/非法 → 阻断），
  // 渲染层禁止降级（render-report 缺 structure.json 直接报错），不再生成 .tmp-degrade-level.txt。
  console.log('[run-all] 降级机制已移除：structure.json 由 R4 门禁强制，缺失/非法即阻断，禁止降级渲染。');
}

// ==================== CLI ====================

// ==================== Omega1 机械层（C2·阶段一·零 LLM） ====================

// ==================== Omega1 验证扩展（C8） ====================

// VER 机械子集：span 偏移合法性 + 报告数值 vs 快照（语义支持验证留阶段二）
function verifyMechanical(transitionFile, reportHtmlPath, indexPath) {
  const errors = [], warnings = [];
  const report = fs.readFileSync(reportHtmlPath, 'utf-8');
  const snap = aggregateData(transitionFile);
  let checked = 0;
  // 数值键：报告中必须出现该数值（图表/判决相关键全量检查，不再抽查前 40 个）
  const numKeys = Object.keys(snap.values).filter(k => typeof snap.values[k] === 'number');
  for (const k of numKeys) {
    const v = String(snap.values[k]);
    if (v && !report.includes(v)) warnings.push('数值缺失于报告: ' + k + '=' + v);
    checked++;
  }
  // span 合法性（提供 index 时）
  if (indexPath && fs.existsSync(indexPath)) {
    const idx = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const segs = idx.segments || [];
    const spans = report.match(/seg\d+:\d+-\d+/g) || [];
    for (const s of spans) {
      const m = s.match(/^seg(\d+):(\d+)-(\d+)$/);
      const seg = segs.find(x => x.id === Number(m[1]));
      if (!seg) { errors.push('span 段不存在: ' + s); continue; }
      if (Number(m[2]) < seg.char_span.start || Number(m[3]) > seg.char_span.end) errors.push('span 越界: ' + s);
    }
  }
  return { ok: errors.length === 0, errors, warnings, checked };
}

// G-14：注意力衰退审计工具——扫描运行目录各轮 prompt 大小 + timing 离群点
// A8-P7：与 executor 统一估算口径（core.estimateTokens：1 字符 ≤1.5 token 保守）；窗口按 1M（1048576）计。
function auditAttention(runDir) {
  const core = require('./executor/core.js');
  const files = fs.readdirSync(runDir).filter(f => /^\.tmp-(R[1-6](?:\.[0-9])?[ab]?|R5-[AB])-prompt\.md$/i.test(f)).sort();
  const rows = files.map(f => {
    const p = path.join(runDir, f);
    const bytes = fs.statSync(p).size;
    const text = fs.readFileSync(p, 'utf-8');
    const chars = text.length;
    const estTokens = core.estimateTokens(text);
    const window = +(estTokens / core.DEFAULT_CONTEXT_LIMIT_TOKENS).toFixed(3);
    const tier = window > 0.85 ? 'RED' : window > 0.6 ? 'YELLOW' : 'GREEN';
    return { file: f, bytes, chars, estTokens, window, tier };
  });
  // timing 离群点：单轮耗时 > 平均 × 2.5（Agent 反复重读/上下文溢出的常见伴随信号）
  const timingFile = path.join(runDir, '.tmp-timing.log');
  const timing = fs.existsSync(timingFile)
    ? fs.readFileSync(timingFile, 'utf-8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean)
    : [];
  const mean = timing.length ? timing.reduce((s, t) => s + (t.elapsed || 0), 0) / timing.length : 0;
  const timingAnomalies = timing
    .filter(t => (t.elapsed || 0) > mean * 2.5)
    .map(t => ({ name: t.name, elapsed: t.elapsed, mean: Math.round(mean) }));
  return { rows, timing: timing.map(t => ({ name: t.name, elapsed: t.elapsed })), timing_anomalies: timingAnomalies, note: 'token 估算 = 统一 executor 口径（chars×1.5 保守）；窗口占用按 1M（1048576）计；分级 >0.85 RED / >0.6 YELLOW' };
}

// A7-B5/L2：深度感知字段覆盖检查（required_fields 按深度档调整；--strict 忽略豁免；阶段二 CHK-1 复用同逻辑）
function depthCheck(transitionFile, narrativeFile, depth, strict) {
  const rr = require('./render-report.js');
  const d = {
    verdict: depth.verdict || '标准',
    mainline: depth.mainline || '标准全景图',
    clash: depth.clash || '标准5-8个'
  };
  const errors = [];
  const normalized = rr.normalizePhase1(fs.readFileSync(transitionFile, 'utf-8'), fs.readFileSync(narrativeFile, 'utf-8'));
  const slotText = id => Object.values((normalized.modules[id] && normalized.modules[id].slots) || {}).join('\n');
  const requireC1 = strict || d.verdict !== '简明';
  const requireC3 = strict || d.mainline !== '简述类型';
  if (requireC1 && !slotText('C1').includes('判准')) errors.push('C1 判准四要素缺失（depth.verdict=' + d.verdict + (strict ? '·strict' : '') + '）');
  if (requireC3 && !(normalized.modules.C3 && normalized.modules.C3.prose.trim())) errors.push('C3 评委解读缺失（depth.mainline=' + d.mainline + (strict ? '·strict' : '') + '）');
  if (!slotText('C6').includes('|') && !slotText('C6').includes('TABLE')) errors.push('C6 交锋裁决表缺失');
  for (let i = 1; i <= 12; i++) {
    const mod = normalized.modules['C' + i];
    if (!mod || (!mod.xp && Object.keys(mod.slots || {}).length === 0)) errors.push('C' + i + ' 模块缺失');
  }
  return { ok: errors.length === 0, errors, depth: d, strict: !!strict };
}

// 闭包资产清单单一源（卡 3，260815）：install-skill BLOCKS 为唯一权威；
// getAssetBlocks 惰性派生 ASSET_BLOCKS 等价物（BLOCKS∖PIPELINE_CONTROLLER），
// 函数级 require 防破坏步骤 0 单件自举与 C10b 最小工作区（触发面仅 selfCheck 第 8 项 + sync-assets CLI）
let _assetBlocks = null;
function getAssetBlocks() {
  if (!_assetBlocks) {
    const { BLOCKS } = require('./install-skill.js');
    _assetBlocks = BLOCKS.filter(b => b.name !== 'PIPELINE_CONTROLLER').map(({ name, file }) => ({ name, file }));
  }
  return _assetBlocks;
}

// 内嵌资产块提取（L5）：<!-- EMBED_ASSET:NAME_START --> ```lang content ``` <!-- EMBED_ASSET:NAME_END -->
function extractEmbeddedAsset(content, name) {
  const re = new RegExp('<!-- EMBED_ASSET:' + name + '_START -->\\s*```(?:css|html|javascript|json)\\s*([\\s\\S]*?)\\s*```\\s*<!-- EMBED_ASSET:' + name + '_END -->');
  const m = content.match(re);
  if (!m) return { ok: false, code: '', after: content };
  return { ok: true, code: m[1].trim(), after: content.slice(m.index + m[0].length) };
}

// sync-assets：资产与源模板计数闭合 + 内嵌块与文件一致性 + 常量可加载
function syncAssets() {
  const errors = [];
  const skill = fs.readFileSync(__dirname + '/Skill-Judge.md', 'utf-8').replace(/\r\n/g, '\n');
  const cssIdx = skill.indexOf('### R6a-3 CSS');
  if (cssIdx >= 0) {
    const s = skill.indexOf('```css', cssIdx), e = skill.indexOf('```', s + 6);
    const srcCss = skill.slice(s + 6, e).trim();
    const assetCss = fs.readFileSync(__dirname + '/assets/report.css', 'utf-8').trim();
    const norm = x => x.replace(/\s+/g, '');
    if (norm(srcCss) !== norm(assetCss)) errors.push('assets/report.css 与 R6a-3 模板不一致');
  }
  // 卡 3（260815）：清单单一源派生——syncAssets 覆盖 BLOCKS∖PC；
  // PC 块由 selfCheck 第 1 项（hash 级）独立覆盖，合计 BLOCKS.length 块不重复校验
  for (const b of getAssetBlocks()) {
    const eb = extractEmbeddedAsset(skill, b.name);
    if (!eb.ok) { errors.push('内嵌块缺失: ' + b.name); continue; }
    const fileContent = fs.readFileSync(__dirname + '/' + b.file, 'utf-8').replace(/\r\n/g, '\n').trim();
    if (eb.code !== fileContent) errors.push('内嵌块与文件不一致: ' + b.name);
  }
  try { require(__dirname + '/assets/charts-constants.js'); } catch (e) { errors.push('charts-constants 加载失败: ' + e.message); }
  return { ok: errors.length === 0, errors };
}

// V-C11E：统计 C11 某方“技术失误”列为 “—” 的人数（零失误率复核）
function mechanicalHeadline(body) {
  const m = body.match(/[^。！？\n]{2,40}[。！？]?/);
  return m ? m[0].trim() : body.slice(0, 40).trim();
}

// 环节识别：按关键词机械判定（v1；后续可并入 index 元数据）
const PHASE_KEYWORDS = ['立论', '盘问', '自由辩论', '对辩', '自由人', '结辩', '总结', '陈词'];
function detectPhase(text) {
  for (const kw of PHASE_KEYWORDS) if (text.includes(kw)) return kw;
  return '';
}

// 关键词提取：中文双字词频（去标点空白），取前 5
function extractKeywords(text) {
  const cleaned = text.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  const freq = {};
  for (let i = 0; i < cleaned.length - 1; i++) {
    const gram = cleaned.slice(i, i + 2);
    freq[gram] = (freq[gram] || 0) + 1;
  }
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0]);
}

// 1) buildIndex：分段 + 逐段一行索引 + 轻量关键词聚类（v1·接口对齐 index.schema.json）
function buildIndex(text, opts = {}) {
  const maxChars = opts.maxChars || 2000;
  const paragraphs = text.replace(/\r\n/g, '\n').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const segments = [];
  let id = 0, offset = 0, buf = [], bufChars = 0;
  const flush = () => {
    if (!buf.length) return;
    const body = buf.join('\n\n');
    const start = offset;
    segments.push({
      id, phase: detectPhase(body), speaker: '',
      char_span: { start, end: start + body.length },
      headline: mechanicalHeadline(body)
    });
    id++; offset = start + body.length + 2; buf = []; bufChars = 0;
  };
  for (const p of paragraphs) {
    if (bufChars + p.length > maxChars && buf.length) flush();
    buf.push(p); bufChars += p.length + 2;
  }
  flush();

  // 关键词聚类（v1：共享关键词并查集；embedding 升级时接口不变）
  const segMeta = segments.map(s => ({
    id: s.id,
    phase: s.phase,
    keywords: extractKeywords(text.slice(s.char_span.start, s.char_span.end))
  }));
  const parent = segments.map((_, i) => i);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < segMeta.length; i++)
    for (let j = i + 1; j < segMeta.length; j++)
      if (segMeta[i].keywords.some(k => segMeta[j].keywords.includes(k))) union(i, j);

  const groups = {};
  segMeta.forEach((m, i) => { const r = find(i); (groups[r] = groups[r] || []).push(m); });
  const clusters = Object.values(groups).map((members, ci) => {
    const ids = members.map(m => m.id).sort((a, b) => a - b);
    const phases = [...new Set(members.map(m => m.phase).filter(Boolean))];
    const kwFreq = {};
    members.forEach(m => m.keywords.forEach(k => { kwFreq[k] = (kwFreq[k] || 0) + 1; }));
    return {
      id: ci,
      segments: ids,
      phases_span: { start: ids[0], end: ids[ids.length - 1] },
      keywords: Object.entries(kwFreq).sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0])
    };
  });

  const cross_phase_clusters = clusters
    .filter(c => {
      const phases = new Set(c.segments.map(sid => segments[sid].phase).filter(Boolean));
      return phases.size >= 2;
    })
    .map(c => c.id);

  return { segments, clusters, cross_phase_clusters };
}

// 2) aggregateData：DATA 机械聚合 → model-snapshot.json（定义在 executor/contract.js，卡 6）

// 3) diffConflicts：机械冲突检测（同维度字段比对 → 冲突登记表）
// 输入：snapshot（aggregateData 输出）+ structure（structure.json 对象或 null）+ opts.excluded（已裁决维度，默认空=现行为，回放安全）
// 输出：conflicts[{conflict_id, dimension, pair, status:'未裁决'}]
function diffConflicts(snapshot, structure, opts) {
  opts = opts || {};
  const excluded = opts.excluded || [];
  const v = snapshot.values || {};
  const conflicts = [];
  const push = (dimension, a, b) => {
    if (excluded.includes(dimension)) return;
    conflicts.push({
      conflict_id: 'CF-' + String(conflicts.length + 1).padStart(3, '0'),
      dimension, pair: [String(a), String(b)], status: '未裁决'
    });
  };

  // S7 赢家 ↔ SC 完成方（批甲 R7a：pair 改真实键——S7.赢家 为 DERIVED_KEYS 注册派生键，模型可写；完成方为 DATA 真实键）
  const s7Pro = v['S7.正方赢.致命'], s7Con = v['S7.反方赢.致命'];
  const scCompleter = v['S8.PhaseIII.完成方'];
  if (scCompleter && s7Pro !== undefined && s7Con !== undefined) {
    const s7Winner = (s7Pro || 0) > (s7Con || 0) ? '正方' : (s7Con || 0) > (s7Pro || 0) ? '反方' : '平';
    if (s7Winner === '反方' && scCompleter === '正方') push('S7赢家↔SC完成方', 'S7.赢家=反方', 'S8.PhaseIII.完成方=正方');
    if (s7Winner === '正方' && scCompleter === '反方') push('S7赢家↔SC完成方', 'S7.赢家=正方', 'S8.PhaseIII.完成方=反方');
  }

  // S11 类型 ↔ structure 类型记录
  const s11 = v['S11.类型'];
  if (structure && s11) {
    const orig = structure.meta && structure.meta.s11_original_type;
    if (orig && orig !== s11) push('S11↔structure类型', 'S11.类型=' + s11, 'structure.s11_original_type=' + orig);
  }

  // C4 专项（260806）：S8.碰撞终判 一致性冲突对（登记供 R4.5 仲裁）
  if (v['S8.碰撞终判'] === '各跑各的') {
    const dirC = v['S8.S11类型方向'];
    if (dirC === '1型') push('终判↔S8方向', 'S8.碰撞终判=各跑各的', 'S8.S11类型方向=1型');
    if (v['S8.PhaseIII.状态'] === '已结晶') push('终判↔PhaseIII', 'S8.碰撞终判=各跑各的', 'S8.PhaseIII.状态=已结晶');
    if (s11 !== undefined && validator.TYPE1.includes(String(s11))) push('终判↔S11类型', 'S8.碰撞终判=各跑各的', 'S11.类型=' + s11);
  }

  // 比分 ↔ 六向度合计（零和 10/维；胜负方向核对）
  const proScore = v['S15.正方得分'], conScore = v['S15.反方得分'];
  const hexadKeys = ['证伪', '证成', '理性', '感性', '场面感', '意义感'];
  let hexPro = 0, hexCon = 0, hexOk = true;
  for (const d of hexadKeys) {
    const p = v['S9.' + d + '.正方'], c = v['S9.' + d + '.反方'];
    if (p === undefined || c === undefined) { hexOk = false; break; }
    hexPro += p; hexCon += c;
  }
  if (hexOk && proScore !== undefined && conScore !== undefined) {
    const hexWinner = hexPro > hexCon ? '正方' : hexCon > hexPro ? '反方' : '平';
    const scoreWinner = proScore > conScore ? '正方' : conScore > proScore ? '反方' : '平';
    if (hexWinner !== '平' && scoreWinner !== '平' && hexWinner !== scoreWinner)
      push('比分↔六向度', '六向度合计=' + hexWinner, 'S15比分=' + scoreWinner);
  }

  return conflicts;
}

// 4) checkEffectiveType：G0 门禁（有效类型 = type_override ?? S11.类型）
// data: 聚合后的 DATA values；structure: structure.json 对象；presentation: 可选
function mergeStructureOverride(structure, adjudication) {
  const copy = JSON.parse(JSON.stringify(structure || {}));
  const auth = (adjudication && adjudication.authoritative) || {};
  if (auth['S11.类型'] && copy.meta) copy.meta.s11_original_type = String(auth['S11.类型']);
  const smo = adjudication && adjudication.structure_meta_override;
  if (smo && copy.meta) {
    copy.meta.type_override = smo.type_override;
    copy.meta.override_reason = smo.override_reason;
  }
  return copy;
}

function main() {
  const rawArgs = process.argv.slice(2);

  // 提取全局 --output-dir / -o 参数；未显式传入时由各命令经 ensureFreshOutputDir 自动新建唯一时间戳目录
  let outputDir = null;
  for (let i = 0; i < rawArgs.length; i++) {
    if ((rawArgs[i] === '--output-dir' || rawArgs[i] === '-o') && i + 1 < rawArgs.length) {
      outputDir = require('path').resolve(rawArgs[i + 1]);
      rawArgs.splice(i, 2);
      i -= 2;
    }
  }
  // outputDir 仅当 --output-dir 显式传入时使用；未传则为 null，各命令自行 fallback
  if (outputDir && !require('fs').existsSync(outputDir)) require('fs').mkdirSync(outputDir, { recursive: true });

  const args = rawArgs;
  const cmd = args[0];

  if (cmd === 'load-prompt') {
    const raw = args[1];
    const round = /^\d+$/.test(raw) ? parseInt(raw) : raw;
    console.log(loadRoundPrompt(round));
  }
  else if (cmd === 'validate') {
    const file = args[1];
    const round = args[2] || 'R1';
    const md = fs.readFileSync(file, 'utf-8');
    const result = validator.validate(md, round);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.passed ? 0 : 1);
  }
  else if (cmd === 'validate-final') {
    const p1 = fs.readFileSync(args[1], 'utf-8');
    const p2 = fs.readFileSync(args[2], 'utf-8');
    // A8-P1d：可选 --structure <structure.json>，合并后执行 V-B9 跨产物一致性
    const structIdx = args.indexOf('--structure');
    const structurePath = structIdx >= 0 ? args[structIdx + 1] : null;
    let p25 = '';
    let p3Index = 3;
    if (args[3] && args[3].includes('P2.5')) {
        if (fs.existsSync(args[3])) {
            p25 = fs.readFileSync(args[3], 'utf-8');
            console.log('[validate-final] P2.5.md 已合并');
        } else {
            console.warn('[validate-final] P2.5.md 不存在，继续');
        }
        p3Index = 4;
    }
    const p3 = fs.readFileSync(args[p3Index], 'utf-8');
    const outFile = args[p3Index + 1] || 'transition-final.md';
    let merged = p1 + '\n---\n' + p2;
    if (p25) merged += '\n---\n' + p25;
    merged += '\n---\n' + p3;
    merged = autoFixTables(merged);
    // V7.6·P0-2: TABLE 配对栈式校验（第三层·最终兜底）
    const pairResult = validateTablePairing(merged);
    if (!pairResult.passed) {
      const blocking = pairResult.errors.map(function(e) { return { rule: 'TABLE-PAIR', severity: 'BLOCKING', message: e }; });
      console.log(JSON.stringify({ passed: false, blocking: blocking, warnings: [] }));
      process.exit(1);
    }
    console.log('[validate-final] TABLE 配对通过: ' + pairResult.count + ' 对');
    const result = validator.validate(merged, 'R3', {
      final: true,
      p1Data: extractDataMarkers(p1),
      p2Data: extractDataMarkers(p2),
      p25Data: p25 ? extractDataMarkers(p25) : {}
    });
    if (result.passed) {
      // outFile already defined above with correct p3Index
      fs.writeFileSync(outFile, merged);
      // D1/D2：判决行/比分与 S15 DATA 一致性（合同固定 正方:反方，M1）
      const vc = validator.checkVerdictConsistency(merged, extractDataMarkers(merged));
      if (vc.errors.length > 0) {
        console.log(JSON.stringify({ passed: false, blocking: vc.errors, note: 'D1/D2 判决/比分一致性阻断' }));
        process.exit(1);
      }
      // diffConflicts 接入 validate-final（机械矛盾登记；有 structure 时含 S11↔structure 维度）
      let conflicts = null;
      if (structurePath && fs.existsSync(structurePath)) {
        try {
          conflicts = diffConflicts(aggregateData(outFile), JSON.parse(fs.readFileSync(structurePath, 'utf-8')));
        } catch (e) {
          conflicts = [{ conflict_id: 'CF-ERR', dimension: '解析失败', pair: [e.message], status: '未裁决' }];
        }
      }
      // A8-P1d：V-B9（structure 节点 id ⊆ transition-final S17 段；单向包含）
      let v9 = null;
      if (structurePath && fs.existsSync(structurePath)) {
        v9 = validator.checkStructure(structurePath, { tfPath: outFile });
        if (!v9.passed) {
          console.log(JSON.stringify({ passed: false, blocking: v9.errors.filter(e => e.severity === 'BLOCKING'), warnings: v9.warnings, note: 'V-B9 跨产物一致性阻断' }));
          process.exit(1);
        }
      }
      const warnDir = outputDir || require('path').dirname(require('path').resolve(args[1]));
      // B6/第4项：WARNING 落盘供 R5 叙事轮加载
      if (result.warnings && result.warnings.length > 0) {
        const warningsFile = require('path').join(warnDir, '.tmp-validate-warnings.json');
        fs.writeFileSync(warningsFile, JSON.stringify(result.warnings, null, 2));
        console.log(`[validate-final] ${result.warnings.length}个WARNING已写入 ${warningsFile}`);
      }
      // 第4项：diffConflicts 登记表落盘（机械矛盾，供后续统筹轮/人工复核）
      if (conflicts && conflicts.length > 0) {
        const conflictsFile = require('path').join(warnDir, '.tmp-conflicts.json');
        fs.writeFileSync(conflictsFile, JSON.stringify(conflicts, null, 2));
        console.log(`[validate-final] ${conflicts.length}个机械冲突已写入 ${conflictsFile}`);
      }
      console.log(JSON.stringify({
        passed: true,
        file: outFile,
        warnings: result.warnings,
        v9: v9 ? { passed: true, warnings: v9.warnings } : null,
        conflicts: conflicts
      }));
    } else {
      console.log(JSON.stringify(result, null, 2));
      process.exit(1);
    }
  }
  else if (cmd === 'check-narrative') {
    const result = validator.checkNarrative(args[1]);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.passed ? 0 : 1);
  }
  else if (cmd === 'check-html') {
    var file = args[1];
    var stage = 'final';
    var dataSource = null;
    for (var i = 2; i < args.length; i++) {
      if (args[i].indexOf('--stage=') === 0) stage = args[i].split('=')[1];
      if (args[i] === '--data-source') dataSource = args[i + 1];   // T6：支持空格形式
      if (args[i].indexOf('--data-source=') === 0) dataSource = args[i].split('=')[1];
    }
    var result = validator.checkHtml(file, { stage: stage, dataSource: dataSource });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.passed ? 0 : 1);
  }
else if (cmd === 'check-structure') {
    const jsonPath = args[1];
    const tfIdx = args.indexOf('--tf');
    const cs = validator.checkStructure(jsonPath, { tfPath: tfIdx >= 0 ? args[tfIdx + 1] : null });
    console.log(JSON.stringify({ passed: cs.passed, blocking: cs.errors.filter(e => e.severity === 'BLOCKING'), warnings: cs.warnings, errors: cs.errors.filter(e => e.severity !== 'BLOCKING') }, null, 2));
    process.exit(cs.passed ? 0 : 1);
  }
    else if (cmd === 'validate-registry') {
    var vSkillPath = __dirname + '/Skill-Judge.md';
    for (var vi = 1; vi < args.length; vi++) { if (args[vi] && args[vi].indexOf('--') !== 0) vSkillPath = args[vi]; }
    var crossRef = args.indexOf('--cross-ref') >= 0;
    var vResult = validateRegistry(vSkillPath, { crossRef: crossRef });
    console.log(JSON.stringify(vResult, null, 2));
    process.exit(vResult.passed ? 0 : 1);
  }
else if (cmd === 'check-terminology') {
    var tSkillPath = __dirname + '/Skill-Judge.md';
    var tResult = validator.checkTerminology(tSkillPath);
    console.log(JSON.stringify(tResult, null, 2));
    process.exit(tResult.passed ? 0 : 1);
  }
else if (cmd === 'self-check') {
    const r = selfCheck();
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.passed ? 0 : 1);
  }
else if (cmd === 'sync-embed') {
    const srcSync = fs.readFileSync(__dirname + '/pipeline-controller.js', 'utf-8').replace(/\r\n/g, '\n');
    const contentSync = fs.readFileSync(__dirname + '/Skill-Judge.md', 'utf-8').replace(/\r\n/g, '\n');
    const startMarker = '<!-- PIPELINE_CONTROLLER_' + 'START -->';
    const endMarker = '<!-- PIPELINE_CONTROLLER_' + 'END -->';
    const startIdx = contentSync.indexOf(startMarker);
    const endIdx = contentSync.lastIndexOf(endMarker);
    if (startIdx < 0 || endIdx <= startIdx) {
      console.error('[sync-embed] 标记缺失或顺序异常，拒绝执行');
      process.exit(1);
    }
    const block = startMarker + '\n```javascript\n' + srcSync.trim() + '\n```\n' + endMarker;
    const result = contentSync.slice(0, startIdx) + block + contentSync.slice(endIdx + endMarker.length);
    fs.writeFileSync(__dirname + '/Skill-Judge.md', result, 'utf-8');
    fs.copyFileSync(__dirname + '/Skill-Judge.md', __dirname + '/Debate-Judge.md');
    fs.copyFileSync(__dirname + '/Skill-Judge.md', __dirname + '/.claude/skills/debate-judge/SKILL.md');
    console.log('[sync-embed] 完成：Skill-Judge.md 内嵌块已更新 + 三镜像已同步');
  }
else if (cmd === 'build-index') {
    const speechFile = args[1];
    if (!speechFile) { console.error('用法: node pipeline-controller.js build-index <辩词文件> [--max-chars N]'); process.exit(1); }
    let maxChars = 2000;
    for (let i = 2; i < args.length; i++) if (args[i] === '--max-chars' && i + 1 < args.length) maxChars = parseInt(args[++i]) || 2000;
    const idx = buildIndex(fs.readFileSync(speechFile, 'utf-8'), { maxChars });
    console.log(JSON.stringify(idx, null, 2));
  }
else if (cmd === 'source-anchor') {
    // 源锚层 v1（E-3）：名册抽取器 CLI——抽取 + 确认单展示 + 交互 y/n/e；落盘由 host-node runPipeline 挂载负责
    const speechFile = args[1];
    if (!speechFile) { console.error('用法: node pipeline-controller.js source-anchor <辩词文件>'); process.exit(1); }
    const anchor = extractSourceAnchor(fs.readFileSync(speechFile, 'utf-8'));
    console.log('=== source-anchor.json ===');
    console.log(JSON.stringify(anchor, null, 2));
    console.log('=== 确认单 ===');
    if (!anchor.extracted) {
      console.log('抽取失败（extracted=false）：无名单段且无角色标签——锚 1/锚 3 降级跳过，锚 2 表内自洽仍执行');
      process.exit(0);
    }
    if (anchor.typeA) console.log('⚠ 严重（类型 A）：具体辩位不齐全 且 具体身份登记不齐全——继续将降级运行且最终报告带免责声明');
    if (anchor.typeB) console.log('⚠ 严重（类型 B）：结构性缺失（缺方/不对称/缺队伍行）——请检查输入；确认继续则同一免责声明');
    console.log('辩题: ' + (anchor.title || '（未识别）'));
    console.log('完整性: ' + anchor.integrity + ' ｜ 正方: ' + anchor.proTeam + ' ｜ 反方: ' + anchor.conTeam);
    for (const side of ['正方', '反方']) {
      console.log(side + '：');
      for (const r of anchor.roster.filter(x => x.side === side)) console.log('  ' + r.role + '\t' + (r.name || '（角色标签）') + (r.slot ? '' : '（无槽位）'));
    }
    console.log('候选名单 candidates（发言行出现未入册）：' + (anchor.candidates.length ? anchor.candidates.map(c => c.name).join(', ') : '无'));
    console.log('候补/未上场 bench（介绍段有名字无槽位）：' + (anchor.bench.length ? anchor.bench.map(b => b.name).join(', ') : '无'));
    console.log('非辩手发言者（评委/嘉宾/教练）：' + (anchor.other_speakers.length ? anchor.other_speakers.map(o => o.name + '（' + o.category + '）').join(', ') : '无'));
    if (anchor.warnings.length) console.log('警告：' + anchor.warnings.join('；'));
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('y = 确认继续 ｜ n = 终止（修正辩词后重开） ｜ e = 编辑（改名册后重抽）\n> ', ans => {
      rl.close();
      if (ans === 'y') { console.log('已确认（CLI 会话）——断点续跑将跳过名册确认'); process.exit(0); }
      if (ans === 'n') { console.error('已终止——修正辩词后重开'); process.exit(2); }
      if (ans === 'e') { console.error('已选择编辑——请修改 source-anchor.json 后重新运行'); process.exit(3); }
      console.error('无效输入，已终止'); process.exit(2);
    });
  }
else if (cmd === 'aggregate') {
    const tf = args[1];
    if (!tf) { console.error('用法: node pipeline-controller.js aggregate <transition-final.md>'); process.exit(1); }
    console.log(JSON.stringify(aggregateData(tf), null, 2));
  }
else if (cmd === 'conflicts') {
    const tf = args[1], st = args[2];
    if (!tf) { console.error('用法: node pipeline-controller.js conflicts <transition-final.md> [structure.json]'); process.exit(1); }
    const snap = aggregateData(tf);
    const structure = st && fs.existsSync(st) ? JSON.parse(fs.readFileSync(st, 'utf-8')) : null;
    console.log(JSON.stringify(diffConflicts(snap, structure), null, 2));
  }
else if (cmd === 'g0-check') {
    const tf = args[1], st = args[2];
    if (!tf || !st) { console.error('用法: node pipeline-controller.js g0-check <transition-final.md> <structure.json> [presentation.json]'); process.exit(1); }
    // 卡 6：契约层消费（parseInputs 统一读取/归一化——签名不变，checkEffectiveType 消费契约对象字段）
    const c = contract.parseInputs({ transition: tf, structure: st, adjudication: null, presentation: args[3] && fs.existsSync(args[3]) ? args[3] : null });
    const r = validator.checkEffectiveType(c.data, c.structure, c.presentation);
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.errors.length ? 1 : 0);
  }
else if (cmd === 'ver') {
    const tf = args[1], rep = args[2], idx = args[3];
    if (!tf || !rep) { console.error('用法: node pipeline-controller.js ver <transition-final.md> <report.html> [index.json]'); process.exit(1); }
    const r = verifyMechanical(tf, rep, idx);
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }
else if (cmd === 'sync-assets') {
    const r = syncAssets();
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }
else if (cmd === 'audit-attention') {
    const runDir = args[1];
    if (!runDir) { console.error('用法: node pipeline-controller.js audit-attention <运行目录> [--table]'); process.exit(1); }
    const r = auditAttention(runDir);
    if (args.includes('--table')) {
      console.log('| 轮次文件 | bytes | chars | estTokens | 1M占用 | 分级 |');
      console.log('|:---|:---:|:---:|:---:|:---:|:---:|');
      for (const row of r.rows) console.log('| ' + row.file + ' | ' + row.bytes + ' | ' + row.chars + ' | ' + row.estTokens + ' | ' + row.window + ' | ' + row.tier + ' |');
      if (r.timing_anomalies.length) {
        console.log('');
        console.log('**耗时离群点（> 均值×2.5）**：');
        for (const a of r.timing_anomalies) console.log('- ' + a.name + ': ' + a.elapsed + 'ms（均值 ' + a.mean + 'ms）');
      }
      console.log('');
      console.log('> ' + r.note);
    } else {
      console.log(JSON.stringify(r, null, 2));
    }
    process.exit(0);
  }
else if (cmd === 'depth-check') {
    const tf = args[1], narr = args[2];
    if (!tf || !narr) { console.error('用法: node pipeline-controller.js depth-check <transition-final.md> <叙事.md> [--depth-verdict 简明|标准|详细] [--depth-mainline 简述类型|标准全景图|逐环节追踪] [--depth-clash 仅关键2-3个|标准5-8个|逐回合全部] [--strict]'); process.exit(1); }
    const depth = {};
    for (const flag of ['--depth-verdict', '--depth-mainline', '--depth-clash']) {
      const i = args.indexOf(flag);
      if (i >= 0 && args[i + 1]) depth[flag.replace('--depth-', '')] = args[i + 1];
    }
    const r = depthCheck(tf, narr, depth, args.includes('--strict'));
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }
else if (cmd === 'pipeline' && args[1] === 'resume-plan') {
    if (!outputDir || !fs.existsSync(outputDir) || !fs.statSync(outputDir).isDirectory()) {
      console.error('用法: node pipeline-controller.js pipeline resume-plan --output-dir <已有时间戳目录> [--from R1|R2|R2.5|R3|R4|R4.5|R5A|R5B|R6|R7|R8] [--plain] [--reader-guide]');
      process.exit(2);
    }
    const fromIdx = args.indexOf('--from');
    const requestedNode = canonicalResumeNode(fromIdx >= 0 && args[fromIdx + 1] ? args[fromIdx + 1] : 'auto');
    let fileCfg = null;
    try {
      const cfgPath = path.join(outputDir, '.api-config.json');
      if (fs.existsSync(cfgPath)) fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (_) {}
    const settings = inferResumeSettings(outputDir, args.slice(2), fileCfg, requestedNode);
    const plan = buildResumePlanForDir(outputDir, requestedNode, settings);
    const existingNames = fs.readdirSync(outputDir, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name);
    console.log(JSON.stringify({
      ok: !!plan.allowed,
      protocol: 'RESUME-NODE-PROTOCOL-v1',
      workDir: outputDir,
      availableNodes: resumeNodeOrder(settings),
      settings,
      plan,
      invalidationNames: resumeInvalidationNames(plan, existingNames),
      versionPolicy: 'non-auto resume 必须先创建 .resume-versions 只读快照；快照失败则不 rewind、不调用 API'
    }, null, 2));
    process.exit(plan.allowed ? 0 : 1);
  }
else if (cmd === 'pipeline' && args[1] === 'run') {
    // A8-P3c：单一编排主入口（D1）——prompt 生成（与 run-all 同底层）→ 统一执行器 → 落盘门禁重试
    const speechFile = args[2];
    if (!speechFile) {
      console.error('用法: node pipeline-controller.js pipeline run <辩词文件> [--provider mock|openai-compatible|codex-cli] [--dry-run] [--force] [--mock-good] [--skip-roster-confirm] [--plain] [--reader-guide] [--resume-from <节点>] [--plain-dict <外部字典.json>]');
      process.exit(1);
    }
    const pIdx = args.indexOf('--provider');
    const provider = pIdx >= 3 && args[pIdx + 1] ? args[pIdx + 1] : 'auto';
    const dryRun = args.slice(3).includes('--dry-run');
    const resumeFromIdx = args.indexOf('--resume-from');
    const resumeFrom = canonicalResumeNode(resumeFromIdx >= 3 && args[resumeFromIdx + 1] ? args[resumeFromIdx + 1] : 'auto');
    const targetedResume = !!outputDir && resumeFrom !== 'auto';
    const forceRequested = args.slice(3).includes('--force');
    const force = targetedResume ? false : forceRequested;
    const mockGood = args.slice(3).includes('--mock-good');
    // B1（260809 实测轮 B）：名册确认跳过开关透传——host-node 层已支持 opts.skipRosterConfirm（mock 因 provider 判定自动跳过掩盖缺口），CLI 侧补齐接线
    const skipRosterConfirm = args.slice(3).includes('--skip-roster-confirm');
    const apiCfgIdx = args.indexOf('--api-config');
    const plainDictIdx = args.indexOf('--plain-dict');
    const plainDict = plainDictIdx >= 3 && args[plainDictIdx + 1] ? args[plainDictIdx + 1] : null;
    const host = require('./executor/host-node.js');
    const apiProvider = require('./executor/api-provider.js');
    if (resumeFrom !== 'auto' && !outputDir) {
      console.error('[ERR_RESUME_NODE] --resume-from 只能用于显式 --output-dir 的既有场次；禁止在新场次伪造定点续跑');
      process.exit(2);
    }
    // A8-ERR-1：workDir 单一来源（runAll 与执行器同目录）+ 场次隔离门禁
    let workDir;
    try {
      workDir = ensureFreshOutputDir(speechFile, outputDir, force).dir;
    } catch (e) {
      console.error('[' + (e.code || 'ERR') + '] ' + e.message);
      process.exit(1);
    }
    // A8-ERR-1：API 配置来源——显式 --api-config 优先；否则自动读工作目录 .api-config.json（前端面板导出）；最后 env auto 探测
    let fileCfg = null;
    try {
      if (apiCfgIdx >= 3 && args[apiCfgIdx + 1]) fileCfg = host.loadFileConfig(args[apiCfgIdx + 1]);
      else fileCfg = host.loadFileConfig(require('path').join(workDir, '.api-config.json'));
    } catch (e) {
      console.error('[ERR_API_CONFIG] API 配置文件解析失败: ' + e.message);
      process.exit(1);
    }
    const cfg = apiProvider.resolveConfig(Object.assign({}, process.env, { EXECUTOR_PROVIDER: provider }), fileCfg);
    // R7/R8 设置：plain 延续既有三层解析；readerGuide 对历史场次可由正式 R8 产物推断，也可 --reader-guide 显式开启。
    const plain = resolvePlainFlag(args.slice(3), fileCfg);
    const resumeSettings = inferResumeSettings(workDir, args.slice(3), fileCfg, resumeFrom);
    resumeSettings.plain = plain;
    const readerGuide = !!resumeSettings.readerGuide;
    let resumePlan = null;
    let resumeVersion = null;
    if (targetedResume) {
      resumePlan = buildResumePlanForDir(workDir, resumeFrom, resumeSettings);
      if (!resumePlan.allowed) {
        console.error('[ERR_RESUME_NODE] ' + resumePlan.blockingReason);
        process.exit(2);
      }
      // 先快照、后任何 rewind；快照失败时尚未调用 API，也未删除旧正式结果。
      if (!dryRun) {
        try { resumeVersion = createResumeVersionSnapshotFs(workDir, { requestedNode: resumePlan.requestedNode }); }
        catch (e) {
          console.error('[ERR_RESUME_VERSION] 旧终态版本归档失败，定点续跑未启动: ' + e.message);
          process.exit(1);
        }
      }
    }
    runAll(speechFile, { tendency: '', auto: false, force, outputDir: workDir });
    if (dryRun) {
      console.log(JSON.stringify({ ok: true, mode: 'dry-run', provider, resolvedProvider: cfg.provider, plain, readerGuide, resumePlan, plainDict, apiConfigFile: fileCfg ? (apiCfgIdx >= 3 ? args[apiCfgIdx + 1] : require('path').join(workDir, '.api-config.json')) : null, workDir, note: '仅生成 prompt 文件；定点 dry-run 不做版本快照/rewind，也不调用 API' }));
      process.exit(0);
    }
    let rewindRemoved = [];
    if (targetedResume) {
      rewindRemoved = applyResumeRewindFs(workDir, resumePlan);
      console.log('[resume] 已归档旧版本 ' + resumeVersion.versionId + '；请求 ' + resumePlan.requestedNode + ' → 实际 ' + resumePlan.effectiveStartNode + '；失效 ' + resumePlan.invalidatedNodes.join('、'));
    }
    const mockResponder = provider === 'mock' ? (mockGood ? host.goodMockResponder : () => '<!-- mock 冒烟响应 -->') : undefined;
    host.runPipeline({
      workDir, cfg, mockResponder, onLog: m => console.log(m), force, plain,
      plainReplayOnly: !!(resumePlan && resumePlan.requirePlainCacheHit),
      plainDict, skipRosterConfirm
    }).then(async res => {
      let readerGuideApplied = false;
      if (res.ok && readerGuide) {
        await host.applyReaderGuide(workDir, cfg, m => console.log(m), { cache: !force });
        readerGuideApplied = true;
      }
      console.log(JSON.stringify({
        ok: res.ok,
        resumePlan,
        resumeVersion: resumeVersion ? { versionId: resumeVersion.versionId, dir: resumeVersion.dir } : null,
        rewindRemoved,
        readerGuideApplied,
        results: res.results.map(r => ({ round: r.round, ok: !!r.ok, skipped: !!r.skipped, errors: r.errors || [] }))
      }, null, 2));
      process.exit(res.ok ? 0 : 1);
    }).catch(e => {
      console.error('[pipeline run] ' + e.message);
      process.exit(1);
    });
  }
else if (cmd === 'pipeline' && args[1] === 'new-dir') {
    // A8-ERR-1 C9a：完整报告渲染的目录创建唯一机械入口（自动新建时间戳目录 + 辩词落位）
    const speechFile = args[2];
    if (!speechFile) {
      console.error('用法: node pipeline-controller.js pipeline new-dir <辩词文件> [--force]');
      process.exit(2);
    }
    try {
      const { dir } = ensureFreshOutputDir(speechFile, null, args.slice(3).includes('--force'));
      const fs = require('fs');
      if (!fs.existsSync(require('path').join(dir, '.tmp-debate.txt'))) {
        fs.copyFileSync(speechFile, require('path').join(dir, '.tmp-debate.txt'));
      }
      console.log(JSON.stringify({ ok: true, dir, note: '请将本次中间文件写入该目录，再用 render-report --out-dir <dir> 渲染' }));
      process.exit(0);
    } catch (e) {
      console.error('[' + (e.code || 'ERR') + '] ' + e.message);
      process.exit(1);
    }
  }
else if (cmd === 'run-all') {
    const speechFile = args[1];
    if (!speechFile) {
      console.error('用法: node pipeline-controller.js run-all <辩词文件> [--tendency <倾向>] [--auto]');
      process.exit(1);
    }
    const opts = { tendency: '', auto: false, force: false, outputDir };
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--tendency' && i+1 < args.length) opts.tendency = args[++i];
      if (args[i] === '--auto') opts.auto = true;
      if (args[i] === '--force') opts.force = true;
    }
    runAll(speechFile, opts);
  }
else if (cmd === 'record-baseline') {
    // A8-ERR-1 C10：递归记录 <dir> 下所有文件相对路径 + MD5 → Output/.baselines/<name>.json（不触碰旧目录）
    const target = require('path').resolve(args[1] || '');
    if (!args[1] || !require('fs').existsSync(target)) {
      console.error('用法: node pipeline-controller.js record-baseline <dir>');
      process.exit(2);
    }
    const baseDir = require('path').join(__dirname, '..', 'Output', '.baselines');
    require('fs').mkdirSync(baseDir, { recursive: true });
    const bf = require('path').join(baseDir, require('path').basename(target) + '.json');
    const manifest = baselineManifest(target);
    require('fs').writeFileSync(bf, JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify({ ok: true, dir: target, baseline: bf, files: Object.keys(manifest).length }));
  }
else if (cmd === 'verify-baseline') {
    // A8-ERR-1 C10：与 .baseline.json 比对，任何新增/缺失/变更 → 非 0 退出
    const target = require('path').resolve(args[1] || '');
    const bf = require('path').join(__dirname, '..', 'Output', '.baselines', require('path').basename(target) + '.json');
    if (!args[1] || !require('fs').existsSync(bf)) {
      console.error('用法: node pipeline-controller.js verify-baseline <dir>（需先 record-baseline）: ' + bf);
      process.exit(2);
    }
    const base = JSON.parse(require('fs').readFileSync(bf, 'utf-8'));
    const cur = baselineManifest(target);
    const added = Object.keys(cur).filter(k => !(k in base));
    const missing = Object.keys(base).filter(k => !(k in cur));
    const changed = Object.keys(base).filter(k => (k in cur) && base[k] !== cur[k]);
    const ok = added.length === 0 && missing.length === 0 && changed.length === 0;
    console.log(JSON.stringify({ ok, added, missing, changed: changed.map(k => ({ file: k, before: base[k], after: cur[k] })) }, null, 2));
    process.exit(ok ? 0 : 1);
  }
  else {
    console.log('用法: node pipeline-controller.js <command> [args]');
    console.log('  管道验证:');
    console.log('    load-prompt <1-5|6a|6b>    输出指定轮次提示词');
    console.log('    validate <file> <round>   验证单轮产出');
    console.log('    validate-final <p1> <p2> <p3> [out]  拼接+最终验证');
    console.log('    check-narrative <file>    检查叙事.md 的 12 个 C 模块标记');
    console.log('    check-html <file>         检查 report.html 的 C 模块 div + <style>');
    console.log('    check-structure <file>     验证 R4 结构归约轮产出的 structure.json');
    console.log('    run-all <file> [--tendency <倾向>] [--auto] [--force]  自动编排管道');
    console.log('    pipeline run <file> [--provider mock|openai-compatible|codex-cli] [--dry-run] [--force] [--mock-good] [--skip-roster-confirm] [--plain] [--reader-guide] [--resume-from <节点>] [--plain-dict <外部字典.json>]  单一编排主入口（执行器）');
    console.log('      普通续跑：pipeline run <file> --provider auto --output-dir <已有时间戳目录>（不带 --force；逐轮门禁复用）');
    console.log('      定点规划：pipeline resume-plan --output-dir <已有时间戳目录> --from <R1|R2|R2.5|R3|R4|R4.5|R5A|R5B|R6|R7|R8>');
    console.log('      定点续跑：pipeline run <file> --provider auto --output-dir <已有时间戳目录> --resume-from <节点> [--plain] [--reader-guide]（先只读版本归档，再共享 planner rewind）');
    console.log('    pipeline new-dir <file> [--force]  新建唯一时间戳输出目录（完整报告渲染入口）');
    console.log('    record-baseline <dir> / verify-baseline <dir>  旧目录 MD5 基线记录与零改动验收');
    console.log('  元检查:');
    console.log('    self-check                 统一门禁（7项聚合·全绿=可交付）');
    console.log('    check-terminology          术语定义一致性（5锚点哨兵）');
    console.log('    validate-registry [--cross-ref]  注册表校验');
  }
}

// ==================== V7.4-二分法: R5 半区拼接与验证 ====================

function concatHalves(halfA, halfB) {
  return halfA.trim() + '\n\n' + halfB.trim();
}

// L2/C7 契约（260808 提取为共享实现）：R5A 输出 5 个 C7 DATA 标记——存在性 + 标记间一致性。
// 单一事实源：validateHalf（R5A 轮门禁，缺失/矛盾 → 重试反馈）与 checkNarrative（合并后最终防线）共用。
// Z''（260808 外部审计交付）：opts.s8 含 S8.PhaseII 数据时执行锚定校验——规则 a（标记=S8，始终）+ 规则 b'
// （表 M-ID 集合==S8 节点列表并集，集合级完整呈现）+ SC总览表校验；s8 键缺失 → 回落 260807 自洽。
// 报错格式指引（意见 1-1）：所有错误消息含契约指引，便于模型按格式修正。
function validateHalf(content, label, opts) {
  opts = opts || {};
  const errors = [];
  const warnings = [];
  const otherRange = label === 'A' ? /<!--INSERT_(C[8-9]|C1[0-2])_/g : /<!--INSERT_(C[1-7])_/g;
  const invalid = content.match(otherRange) || [];
  if (invalid.length > 0) {
    errors.push('包含不应处理的INSERT: ' + invalid.join(', '));
  }
  // A4：半区正向约束——本半区无条件 INSERT 全覆盖 + 注册名校验 + XP（C4 条件项按 S4 豁免）
  let registry = opts.registry || null;
  if (!registry && opts.skillPath) {
    try { registry = parseInsertRegistry(opts.skillPath); } catch (e) { errors.push('INSERT注册表加载失败: ' + e.message); }
  }
  if (registry) {
    const chapters = label === 'A'
      ? ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']
      : ['C8', 'C9', 'C10', 'C11', 'C12'];
    const cr = validator.checkR5Contract(content, registry, {
      chapters,
      s4DefTrigger: opts.s4DefTrigger,
      data: opts.data
    });
    for (const e of cr.errors) errors.push(e.rule + ': ' + e.message);
    for (const w of cr.warnings) warnings.push(w.rule + ': ' + w.message);
  }
  // L2/C7（260808）：R5A 输出契约在轮门禁强制——5 个 C7 DATA 标记存在性 + 标记间一致性，
  // 缺失/矛盾 → 门禁失败携带反馈重试（此前仅 R5-FINAL 检查，重试反馈够不到）
  if (label === 'A') {
    for (const e of validator.checkC7DataContract(content, { s8: opts.data })) errors.push(e);
  }
  if (errors.length > 0) return { passed: false, reason: errors.join('; '), warnings };
  return { passed: true, warnings };
}

// R7 阶段 2：--plain 三层开关解析（CLI > .api-config.json plain 字段 > 默认 false）
// --plain / --plain=true|1 → true；--plain=false|0 → 显式 false；未传 → 读 fileCfg.plain
function resolvePlainFlag(argv, fileCfg) {
  const plainArg = (argv || []).find(a => a === '--plain' || /^--plain=/.test(a));
  if (plainArg !== undefined) {
    if (plainArg === '--plain') return true;
    return /^(true|1)$/i.test(String(plainArg).split('=')[1] || '');
  }
  return !!(fileCfg && fileCfg.plain === true);
}

// ==================== 源锚层 v1（260809）：名册抽取器 + 锚 1/2/3 ====================
// 真问题：事实层（S8.2 表/S8 DATA/C7 表/C7 标记）悬浮于模型自述——抽取器把"谁、什么立场、第几轮"
// 从模型转述中剥离为确定性机械抽取（外部源锚 = 锚 1 人数 + 锚 3 人名/身份；锚 2 表内自洽不冒充外部锚）。
// 源锚层 v1.9；契约基线标识：N1N2/E1E2E3E4/D1D2D3。公开运行不依赖私有设计/审计文件。

// ---- 正则常量（E-1/E-4/N-2，单一事实源） ----
// 规则 1：队伍行两形态（E-1：冒号 + 是字；形态 B 剥离句尾标点）
const TEAM_RE = /^(正方|反方)(?:[：:]|是)\s*([^\s，,。．.!！?？]+)/;
// 规则 2：名单行（角色词表可扩展；繁简仅"辩/辯"双写；真实辩词介绍段带"主　席："前缀——主席代读名单）
const SLOT_RE = /^(?:主\s*席[：:]?\s*)?((?:一|二|三|四|五|六)(?:辩|辯)|自由人|主辩|主辯|结辩|結辯|助辩|助辯)([^，,：:]{1,6})[，,]/;
// 候补/未上场行（N-2：介绍段有名字、无角色槽可挂 → bench，不计锚 1）
const BENCH_RE = /^(?:候补|替补|后备|未上场)[：:]?([^\s，,。]{1,6})/;
// 规则 10：显式非辩手标签行（5.1：主席台词过滤；v1.9：评委/嘉宾/教练等单独标记）
const NON_DEBATER_RE = /^(主\s*席|评\s*委|評\s*委|嘉宾|點評嘉賓|点评嘉宾|教练|教練|观众|觀衆|计时员)[：:]/;
// 规则 10 后半：介绍段非辩手识别（"评委是…女士/先生"、"点评嘉宾："、"教练："）
// v1.9 修正（260809 Q5）：行内含匹配（"擔任決賽的七位評委是：張靄珠女士"）；姓名捕获排除冒号/头衔后缀
const OTHER_INTRO_RE = /(?:评\s*委|評\s*委|评委团|評委團|点评嘉宾|點評嘉賓|教练|教練)(?:是)?[：:]?\s*([^，,。．、：:\s]{1,14}?)(?:女士|先生|教授|老師|老师)?(?=[，,。．、]|$)/;
const OTHER_TITLE_PREFIX = /^(著名學者|著名学者|學者|学者)/;
// 规则 3：发言行（前缀 ≤8 字）
const SPEAKER_RE = /^([^：:]{1,8})[：:]\s*(.+)/;
// 规则 6：角色标签行前缀（方别+角色，无姓名；6.2 角色名册）
const ROLE_TAG_RE = /^(正|反|正方|反方)((?:一|二|三|四|五|六|1|2|3|4|5|6|１|２|３|４|５|６)(?:辩|辯)?|自由人|主辩|主辯|结辩|結辯|助辩|助辯)$/;

// 角色词归一（v1.7/v1.8：阿拉伯/中文/全角数字统一转中文；简繁仅"辩/辯"双写；去空格/全角空格）
// 输入为纯角色词（无方别）："一辩"→"一辩"；"2"→"二辩"；"二辯"→"二辩"；"自由人"→"自由人"；非角色词 → null
function roleTagToSideRole(tag) {
  const t = String(tag || '').trim().replace(/[\s\u3000]/g, '');
  const m = t.match(/^(正|反)(?:方)?(.+)$/);
  if (!m) return null;
  const side = m[1] === '正' ? '正方' : '反方';
  const role = validator.normalizeRoleTag(m[2]);
  return role ? { side, role } : null;
}

// 全角空格归一（"樊　登"→"樊登"）；名字一律按辩词原文保留（6.1：繁体辩词 → 繁体名，不简繁转换）
function normalizeFullWidth(s) {
  return String(s || '').replace(/[\s\u3000]/g, '');
}

// 角色槽序号（完整性自检：序列连续判定用）
const ROLE_ORDER = { 一辩: 1, 二辩: 2, 三辩: 3, 四辩: 4, 五辩: 5, 六辩: 6 };

// 名册完整性自检（§2.6a：roles 两维 + identity 两维 → full/partial/missing；不预设 4v4）
function assessAnchorIntegrity(roster, proTeam, conTeam, hasNames) {
  const detail = { teams: false, rolesSym: false, rolesSeq: false, identity: false };
  detail.teams = !!proTeam && !!conTeam;
  const sides = ['正方', '反方'];
  const perSide = s => roster.filter(r => r.side === s);
  const rolesOf = s => perSide(s).map(r => r.role);
  // 对称：双方角色槽数量一致（按源材料实际角色集判定，不硬编码 4v4）
  detail.rolesSym = rolesOf('正方').length === rolesOf('反方').length && rolesOf('正方').length > 0;
  // 序列连续：数字辩位按 1..n 连续无缺号（自由人/主辩/结辩/助辩 为附加槽，不参与缺号判定）
  const numSeq = roles => {
    const nums = roles.map(r => ROLE_ORDER[r]).filter(n => n !== undefined).sort((a, b) => a - b);
    for (let i = 0; i < nums.length; i++) if (nums[i] !== i + 1) return false;
    return true;
  };
  detail.rolesSeq = numSeq(rolesOf('正方')) && numSeq(rolesOf('反方'));
  // 身份：每个槽位有人名或（无名字源时）角色标签即身份（v1.7：角色标签直接作为身份，不降级）
  detail.identity = roster.length === 0 ? false : roster.every(r => !!r.name || !hasNames);
  const bothRoles = detail.rolesSym && detail.rolesSeq;
  const bothIdentity = detail.identity;
  if (roster.length === 0) return { level: 'missing', detail, typeAB: false, typeB: false };
  const level = (bothRoles && bothIdentity) ? 'full' : 'partial';
  // 类型 A：辩位不齐 且 身份登记不齐（材料在场但角色/人名均无法形成归属条目）
  const typeAB = !bothRoles && !bothIdentity;
  // 类型 B：结构性缺失（仅一方 / 明显不对称 / 缺队伍行）
  const typeB = !detail.teams || rolesOf('正方').length === 0 || rolesOf('反方').length === 0;
  return { level, detail, typeAB, typeB };
}

// 抽取器（规则 1-11 逐行分类：队伍行→名单行→候补行→非辩手标签→介绍段非辩手→发言行；互斥不重叠）
// 输出：{ extracted, hasNames, title, proTeam, conTeam, roster, bench, candidates, other_speakers,
//         chair_paras, speaker_paras, integrity, integrity_detail, warnings, rosterHash }
function extractSourceAnchor(transcript) {
  const lines = String(transcript || '').replace(/\r\n/g, '\n').split('\n');
  const roster = [];
  const bench = [];
  const candidates = [];
  const otherSpeakers = new Map();   // name → category
  const warnings = [];
  const chairParas = [];
  const speakerParas = [];
  const seenTeams = new Map();       // side → team（同方异名 → 源质量问题 WARNING）
  let proTeam = null, conTeam = null, title = null, currentSide = null;

  const firstLine = lines.find(l => l.trim());
  // 260809 B2：title 放行"是"字辩题行（"美是客觀存在/美是主觀感受"）；排除队伍行形态（正方：/反方： 开头）
  if (firstLine && firstLine.trim() && !firstLine.includes('：') && !firstLine.includes(':') && !/^(正方|反方)/.test(firstLine.trim())) {
    title = firstLine.trim().replace(/^#+\s*/, '');
  }

  const setTeam = (side, team) => {
    if (seenTeams.has(side) && seenTeams.get(side) !== team)
      warnings.push(`源质量问题：${side}队伍行出现两种写法（${seenTeams.get(side)} vs ${team}）——取首次出现`);
    if (!seenTeams.has(side)) seenTeams.set(side, team);
    if (side === '正方' && !proTeam) proTeam = team;
    if (side === '反方' && !conTeam) conTeam = team;
    currentSide = side;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // 规则 1：队伍行（两形态；幂等覆盖）
    const mTeam = line.match(TEAM_RE);
    if (mTeam) { setTeam(mTeam[1] === '正方' ? '正方' : '反方', mTeam[2]); continue; }
    // 规则 2：名单行（繁简双写；名字后必须跟逗号——真名单行格式）
    const mSlot = line.match(SLOT_RE);
    if (mSlot) {
      const roleRaw = mSlot[1];
      const role = validator.normalizeRoleTag(roleRaw) || roleRaw;
      const name = normalizeFullWidth(mSlot[2]);
      const side = currentSide || '未知';
      if (roster.some(r => r.name === name && r.side === side && r.role === role)) continue;
      roster.push({ name, side: currentSide ? currentSide : null, role, slot: true, aliases: [] });
      continue;
    }
    // 候补/未上场行（N-2）
    const mBench = line.match(BENCH_RE);
    if (mBench) {
      bench.push({ name: normalizeFullWidth(mBench[1]), side: currentSide });
      continue;
    }
    // 规则 10：显式非辩手标签行（主席台词单独存，不归属辩手）
    const mNon = line.match(NON_DEBATER_RE);
    if (mNon) {
      const t = normalizeFullWidth(mNon[1]);
      const cat = /主/.test(mNon[1]) ? 'chair' : /评|評/.test(mNon[1]) ? 'judge' : /嘉宾|嘉賓/.test(mNon[1]) ? 'guest' : /教练|教練/.test(mNon[1]) ? 'coach' : /观众|觀衆/.test(mNon[1]) ? 'audience' : 'other';
      if (cat === 'chair') chairParas.push({ speaker: t, text: line });
      continue;
    }
    // 介绍段非辩手识别（"评委是…" / "点评嘉宾：" / "教练："）
    const mOther = line.match(OTHER_INTRO_RE);
    if (mOther) {
      let name = normalizeFullWidth(mOther[1]).replace(OTHER_TITLE_PREFIX, '');
      // R4（260809）：类别按匹配关键词判定——嘉宾优先（"點評嘉賓"含「評」不得误判 judge）
      const cat = /嘉宾|嘉賓/.test(mOther[0]) ? 'guest' : /评|評/.test(mOther[0]) ? 'judge' : 'coach';
      if (!otherSpeakers.has(name)) otherSpeakers.set(name, cat);
      continue;
    }
    // 规则 3：发言行
    const mSpk = line.match(SPEAKER_RE);
    if (mSpk) {
      const speaker = normalizeFullWidth(mSpk[1]);
      const text = mSpk[2];
      // 规则 5：归属过滤——发言者 ∈ roster.names 才归属辩手发言
      const hit = roster.find(r => r.name === speaker);
      if (hit) {
        speakerParas.push({ speaker, side: hit.side, role: hit.role, text });
        continue;
      }
      // 规则 6：角色标签行（方别+角色，无姓名）——同时建立角色槽位（6.2：name:null，角色即身份）
      const tag = roleTagToSideRole(speaker);
      if (tag) {
        if (!roster.some(r => r.side === tag.side && r.role === tag.role))
          roster.push({ name: null, side: tag.side, role: tag.role, slot: true, aliases: [] });
        speakerParas.push({ speaker, side: tag.side, role: tag.role, text, roleTag: true });
        continue;
      }
      // 规则 10 后半：具名非辩手（评委/嘉宾/教练）
      if (otherSpeakers.has(speaker)) {
        speakerParas.push({ speaker, side: null, role: null, text, other: otherSpeakers.get(speaker) });
        continue;
      }
      // 未知前缀：登记（不归属；v2 段落归属用）
      candidates.push({ name: speaker, source: 'unknown-prefix' });
      continue;
    }
    // 其他行：忽略（正文、引文、空白）
  }

  // 候选名单（candidates）：发言行出现但未入册（roster/otherSpeakers 均无）——已在主循环登记，去重
  const candSeen = new Set();
  const dedupCand = [];
  for (const c of candidates) {
    if (!candSeen.has(c.name)) { candSeen.add(c.name); dedupCand.push(c); }
  }
  // 候选名单闭合（§2.6c）：名字在原文任意位置逐字出现过 → 归类"源写法不一致"（补 alias），不视为幻觉
  const candFinal = [];
  for (const c of dedupCand) {
    if (roster.some(r => r.name === c.name)) continue;
    const nameInTranscript = String(transcript || '').includes(c.name);
    const aliasHit = roster.find(r => r.name !== c.name && String(transcript || '').includes(c.name) && r.aliases && !r.aliases.includes(c.name));
    if (nameInTranscript && !aliasHit) {
      warnings.push(`候选名单：发言者「${c.name}」在原文出现但未入册（抽取器疑似漏抽）——请核对名册`);
    }
    candFinal.push({ name: c.name, source: c.source });
  }

  const hasNames = roster.some(r => !!r.name);
  const integrity = assessAnchorIntegrity(roster, proTeam, conTeam, hasNames);
  if (integrity.level === 'missing') {
    const otherSpeakersArr = [...otherSpeakers.entries()].map(([name, category]) => ({ name, category }));
    return {
      extracted: false, hasNames: false, title, proTeam, conTeam,
      roster: [], bench, candidates: candFinal, other_speakers: otherSpeakersArr,
      chair_paras: chairParas, speaker_paras: [],
      integrity: 'missing', integrity_detail: integrity.detail, warnings,
      disclaimer: false, rosterHash: null
    };
  }
  const otherSpeakersArr = [...otherSpeakers.entries()].map(([name, category]) => ({ name, category }));
  const rosterHash = require('crypto').createHash('sha256')
    .update(JSON.stringify({ proTeam, conTeam, roster: roster.map(r => ({ name: r.name, side: r.side, role: r.role, slot: r.slot, aliases: r.aliases || [] })) }))
    .digest('hex').slice(0, 16);
  return {
    extracted: true, hasNames, title, proTeam, conTeam,
    roster, bench, candidates: candFinal, other_speakers: otherSpeakersArr,
    chair_paras: chairParas, speaker_paras: speakerParas,
    integrity: integrity.level, integrity_detail: integrity.detail,
    typeA: integrity.typeAB, typeB: integrity.typeB,
    warnings, disclaimer: false, rosterHash
  };
}

// 合并人工 aliases（260809 B1）：人工编辑 source-anchor.json 补的 aliases 在重抽后保留；
// 重算 rosterHash（纳入 aliases——alias 变更 → 旧确认标记失效，需重新确认）
function mergeRosterAliases(freshAnchor, oldAnchor) {
  if (!oldAnchor || !Array.isArray(oldAnchor.roster)) return freshAnchor;
  for (const r of freshAnchor.roster) {
    const old = oldAnchor.roster.find(p => p.name === r.name && p.side === r.side && p.role === r.role);
    if (old && Array.isArray(old.aliases) && old.aliases.length) {
      r.aliases = [...new Set([...(r.aliases || []), ...old.aliases])];
    }
  }
  const hash = require('crypto').createHash('sha256')
    .update(JSON.stringify({ proTeam: freshAnchor.proTeam, conTeam: freshAnchor.conTeam,
      roster: freshAnchor.roster.map(r0 => ({ name: r0.name, side: r0.side, role: r0.role, slot: r0.slot, aliases: r0.aliases || [] })) }))
    .digest('hex').slice(0, 16);
  return Object.assign({}, freshAnchor, { rosterHash: hash });
}

// 锚 3 模式常量与 W2 阈值（D-3，单一事实源）

module.exports = { validate: validator.validate, extractDataMarkers, normalizeMId, normalizeMIdText, isMid, isCpId, isRef, sideOfMid, normalizeStructureIds, loadRoundPrompt, loadRoundPromptFallback, buildSectionIndex, cropPromptByChapters, runAll, normalizeDebateBindingText, debateBindingSha256, assertDebateBinding, loadRunSemanticAuthorities, ERR_DEBATE_BINDING_MISMATCH, ERR_SEMANTIC_AUTHORITY, buildRoundPrompt, checkNarrative: validator.checkNarrative, checkHtml: validator.checkHtml, checkStructure: validator.checkStructure, parseStructureJson, autoFixTables, autoFixSMarkers, validateTablePairing, parseInsertRegistry, getEnums: validator.getEnums, validateRegistry, checkTerminology: validator.checkTerminology, checkTerminologyContent: validator.checkTerminologyContent, scanVersionMarkersContent, extractEmbeddedBlock, extractEmbeddedAsset, selfCheck, generateInsertContract, concatHalves, validateHalf, buildIndex, aggregateData, diffConflicts, checkEffectiveType: validator.checkEffectiveType, verifyMechanical, auditAttention, depthCheck, syncAssets, getAssetBlocks, VALID_OUTPUT_DIR_RE, ERR_OUTPUT_ISOLATION, outputIsolationError, defaultOutputRoot, resolveOutputDir, ensureFreshOutputDir, baselineManifest, parseSMarkers: validator.parseSMarkers, parseSMarkerDetail: validator.parseSMarkerDetail, sectionOfStep: validator.sectionOfStep, checkR5Contract: validator.checkR5Contract, checkVerdictConsistency: validator.checkVerdictConsistency, checkCompletionMatrix: validator.checkCompletionMatrix, checkS7Contract: validator.checkS7Contract, loadInputContract, generateDataContract, validateAdjudication, mergeAdjudicationData, mergeStructureOverride, ADJUDICATION_WHITELIST, normalizeEnumValue: validator.normalizeEnumValue, autoFixDataValues, adjudicationWhitelist, TYPE1: validator.TYPE1, TYPE2: validator.TYPE2, checkV1_V6: validator.checkV1_V6, checkC1_C7: validator.checkC1_C7, checkS8Coherence: validator.checkS8Coherence, resolvePlainFlag, extractSourceAnchor, parseS82Table: validator.parseS82Table, checkS82Anchors: validator.checkS82Anchors, matchTurnToRoster: validator.matchTurnToRoster, checkSideTriplet: validator.checkSideTriplet, normalizeRoleTag: validator.normalizeRoleTag, mergeRosterAliases, roleTagToSideRole, W2_MIN_UNRESOLVABLE: validator.W2_MIN_UNRESOLVABLE, W2_RATIO: validator.W2_RATIO, checkS8: validator.checkS8, checkS17Table: validator.checkS17Table, checkCompletionConsistency: validator.checkCompletionConsistency, detectNewContract: validator.detectNewContract, detectNewContractFromText: validator.detectNewContractFromText, isNewContractHeader: validator.isNewContractHeader, deriveDirection: validator.deriveDirection, applyDerivations: validator.applyDerivations, injectDerivedDataLines, check55Guard: validator.check55Guard, checkS102Overstrict: validator.checkS102Overstrict, normalizeForCompare: validator.normalizeForCompare, CROSS_FORMAT_COMPARE_POINTS: validator.CROSS_FORMAT_COMPARE_POINTS, R2_5_DOMAIN_RE: validator.R2_5_DOMAIN_RE, R3_DOMAIN_RE: validator.R3_DOMAIN_RE, DIMENSIONS, DIMENSION_S7_SC, DERIVED_KEYS, ADJUDICABLE_PREFIXES, LENGTH_GATE_RULES: validator.LENGTH_GATE_RULES, adjudicableKeys, canonicalResumeNode, resumeNodeOrder, planResumeStart, resumeInvalidationNames, inferResumeSettings, buildResumePlanForDir, applyResumeRewindFs, createResumeVersionSnapshotFs };
if (require.main === module) main();
