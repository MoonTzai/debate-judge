// A8-P3b：统一轮次执行器·Node 宿主（文件 IO / API 调用 / 门禁重试 / 断点续跑 / 数据聚合）
// 真实 API 调用需环境变量 + 授权（P3d）；mock provider 用于冒烟与 CI。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./core.js');
const api = require('./api-provider.js');
const codexCli = require('./codex-cli.js');
const validator = require('./validator.js');

// Node 宿主 seam：共享 provider 只认 codexRunner 回调；CLI 进程细节集中在 codex-cli adapter。
function codexPromptFromMessages(messages, system) {
  const parts = [];
  if (system) parts.push('[system]\n' + String(system));
  for (const m of messages || []) {
    parts.push('[' + String(m.role || 'user') + ']\n' + String(m.content || ''));
  }
  return parts.join('\n\n');
}

async function defaultCodexRunner(cfg, messages, opts) {
  return codexCli.runCompletion(cfg, codexPromptFromMessages(messages, opts && opts.system));
}

function requestCompletionNode(cfg, messages, opts) {
  opts = opts || {};
  if (cfg && cfg.provider === 'codex-cli') {
    const runner = opts.codexRunner || defaultCodexRunner;
    return api.requestCompletion(cfg, messages, Object.assign({}, opts, { codexRunner: runner }));
  }
  return api.requestCompletion(cfg, messages, opts);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
}

// 源锚层 v1（N-1）：读取名册锚 workDir/source-anchor.json；不存在/解析失败 → null（表级锚降级）
function readAnchor(workDir) {
  const p = path.join(workDir, 'source-anchor.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return null; }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sourceAnchorExemptionError(message) {
  const e = new Error('[source-anchor exemption] ' + message);
  e.code = 'ERR_SOURCE_ANCHOR_EXEMPTION';
  return e;
}

function warningsForAdjudication(validationResult) {
  return ((validationResult && validationResult.warningRecords) || [])
    .filter(w => w && w.rule !== 'V-S8E-WX')
    .map(w => w.message);
}

// B1（260828）：人工豁免是独立场次 checkpoint，不混入 source-anchor.json / source-anchor.confirmed。
// 只做生命周期与审计字段验证；具体哪类 A3 可放行由 validator failureKind 白名单决定。
function loadSourceAnchorExemptions(workDir, anchor, opts) {
  opts = opts || {};
  const file = path.join(workDir, 'source-anchor-exemptions.json');
  if (!fs.existsSync(file)) return [];
  if (opts.force) throw sourceAnchorExemptionError('检测到 --force 与人工豁免 checkpoint 同时存在；请先删除/撤销旧 checkpoint，再重生成 P2');
  const debateFile = path.join(workDir, '.tmp-debate.txt');
  const p2File = path.join(workDir, 'P2.md');
  if (!fs.existsSync(debateFile)) throw sourceAnchorExemptionError('.tmp-debate.txt 缺失，无法验证人工豁免真源');
  if (!anchor || !anchor.extracted || !anchor.rosterHash) throw sourceAnchorExemptionError('当前 source-anchor 无有效 rosterHash，人工豁免不得生效');
  if (!fs.existsSync(p2File)) throw sourceAnchorExemptionError('P2.md 缺失；人工豁免只允许针对已经存在的失败 P2 创建');
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch (e) { throw sourceAnchorExemptionError('checkpoint JSON 解析失败: ' + e.message); }
  if (!doc || doc.version !== 1) throw sourceAnchorExemptionError('version 必须为 1');
  const transcriptSha = sha256File(debateFile);
  const p2Sha = sha256File(p2File);
  if (doc.transcript_sha256 !== transcriptSha) throw sourceAnchorExemptionError('transcript_sha256 与当前 .tmp-debate.txt 不一致');
  if (doc.roster_hash !== anchor.rosterHash) throw sourceAnchorExemptionError('roster_hash 与当前 source-anchor.json 不一致');
  if (!Array.isArray(doc.entries) || doc.entries.length === 0) throw sourceAnchorExemptionError('entries 必须为非空数组');
  const lineCount = fs.readFileSync(debateFile, 'utf-8').replace(/\r\n/g, '\n').split('\n').length;
  const seenRows = new Set();
  for (let i = 0; i < doc.entries.length; i++) {
    const e = doc.entries[i];
    const at = e && e.at;
    if (!e || e.scope !== 'A3_ROSTER_MATCH') throw sourceAnchorExemptionError('entries[' + i + '].scope 仅允许 A3_ROSTER_MATCH');
    if (e.artifact !== 'P2.md') throw sourceAnchorExemptionError('entries[' + i + '].artifact 仅允许 P2.md');
    if (e.artifact_sha256 !== p2Sha) throw sourceAnchorExemptionError('entries[' + i + '].artifact_sha256 与当前 P2.md 不一致');
    if (!Number.isInteger(e.table_row) || e.table_row < 1) throw sourceAnchorExemptionError('entries[' + i + '].table_row 必须为正整数');
    if (!/^M-(?:ZH|FA)-\d+$/.test(String(e.node_id || ''))) throw sourceAnchorExemptionError('entries[' + i + '].node_id 非法');
    if (typeof e.turn_raw !== 'string' || !e.turn_raw.trim()) throw sourceAnchorExemptionError('entries[' + i + '].turn_raw 不能为空');
    if (e.operator_side !== '正方' && e.operator_side !== '反方') throw sourceAnchorExemptionError('entries[' + i + '].operator_side 非法');
    if (typeof e.by !== 'string' || !e.by.trim()) throw sourceAnchorExemptionError('entries[' + i + '].by 不能为空');
    if (typeof e.reason !== 'string' || !e.reason.trim()) throw sourceAnchorExemptionError('entries[' + i + '].reason 不能为空');
    if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(at) || Number.isNaN(Date.parse(at))) throw sourceAnchorExemptionError('entries[' + i + '].at 必须为有效 ISO-8601 时间');
    if (!Array.isArray(e.evidence_lines) || e.evidence_lines.length === 0 ||
        e.evidence_lines.some(n => !Number.isInteger(n) || n < 1 || n > lineCount))
      throw sourceAnchorExemptionError('entries[' + i + '].evidence_lines 必须为当前辩词范围内的正整数行号');
    if (seenRows.has(e.table_row)) throw sourceAnchorExemptionError('同一 S8.2 table_row 只能有 1 条人工豁免 entry: table_row=' + e.table_row);
    seenRows.add(e.table_row);
  }
  return doc.entries;
}

function assertSourceAnchorExemptionArtifactBinding(round, text, exemptions) {
  if (!round || round.name !== 'R2' || !Array.isArray(exemptions) || exemptions.length === 0) return;
  const currentSha = crypto.createHash('sha256').update(Buffer.from(String(text || ''), 'utf-8')).digest('hex');
  if (exemptions.some(e => !e || e.artifact_sha256 !== currentSha))
    throw sourceAnchorExemptionError('当前 R2/P2 内容 SHA 已变化，旧人工豁免 checkpoint 失效；请重新人工核对后再创建新 checkpoint');
}

// Q3 登记项（260809 R8）：锚加载状态标签——门禁通过/断点跳过日志必须记录"以何配置通过"
function anchorStateLabel(workDir) { return readAnchor(workDir) ? '锚已加载' : '锚未加载'; }

// 源锚层 v1 名册确认机制——交互 y/n/e、文件确认标记（source-anchor.confirmed 含名册哈希）、--skip 开关；
// 类型 A/B 严重异常置顶展示；哈希不一致 → 旧标记失效（防"改名册但标记还在"）
async function confirmRoster(workDir, anchor, opts, onLog) {
  if (!anchor || !anchor.extracted) return true;                 // extracted:false → 无可确认名册，自动跳过
  if (opts.skipRosterConfirm) {
    onLog('[executor] --skip-roster-confirm：跳过名册人工确认（自动化/mock/CI）');
    return true;
  }
  const markFile = path.join(workDir, 'source-anchor.confirmed');
  if (fs.existsSync(markFile)) {
    try {
      const mark = JSON.parse(fs.readFileSync(markFile, 'utf-8'));
      if (mark.rosterHash === anchor.rosterHash) { onLog('[executor] 名册确认标记有效（哈希一致）——跳过暂停'); return true; }
      onLog('[executor] 名册已变更（哈希不一致）——旧确认标记失效，重新等待确认');
    } catch (e) { onLog('[executor] 确认标记解析失败，重新等待确认'); }
  }
  onLog('[source-anchor] 名册抽取完成 ⏸ 等待人工确认（--skip-roster-confirm 可跳过）');
  if (anchor.typeA) onLog('⚠ 严重（类型 A）：具体辩位不齐全 且 具体身份登记不齐全——继续将降级运行且最终报告带免责声明');
  if (anchor.typeB) onLog('⚠ 严重（类型 B）：结构性缺失（缺方/不对称/缺队伍行）——请检查输入；确认继续则同一免责声明');
  onLog('辩题: ' + (anchor.title || '（未识别）') + ' ｜ 完整性: ' + anchor.integrity);
  for (const side of ['正方', '反方']) {
    onLog(side + ' ｜ ' + (side === '正方' ? anchor.proTeam : anchor.conTeam));
    for (const r of anchor.roster.filter(x => x.side === side)) onLog('  ' + r.role + '  ' + (r.name || '（角色标签）'));
  }
  onLog('候选名单 candidates（发言行出现未入册）：' + (anchor.candidates.length ? anchor.candidates.map(c => c.name).join(', ') : '无'));
  onLog('候补/未上场 bench（介绍段有名字无槽位）：' + (anchor.bench.length ? anchor.bench.map(b => b.name).join(', ') : '无'));
  onLog('非辩手发言者（评委/嘉宾/教练）：' + (anchor.other_speakers.length ? anchor.other_speakers.map(o => o.name + '（' + o.category + '）').join(', ') : '无'));
  if (anchor.warnings.length) onLog('警告：' + anchor.warnings.join('；'));
  // 交互模式（TTY）：y 确认继续 / n 终止 / e 编辑后重抽；非 TTY（管道/自动化）→ 等待文件确认标记
  if (process.stdin.isTTY) {
    return await new Promise(resolve => {
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question('y = 确认继续 ｜ n = 终止（修正辩词后重开） ｜ e = 编辑（改名册后重抽）\n> ', ans => {
        rl.close();
        if (ans === 'y') {
          fs.writeFileSync(markFile, JSON.stringify({ by: 'CLI 交互', at: new Date().toISOString(), rosterHash: anchor.rosterHash }, null, 2));
          onLog('[executor] 名册已确认（交互 y）——确认标记落盘，断点续跑将跳过');
          resolve(true);
        } else if (ans === 'n') {
          onLog('[executor] 已终止——修正辩词后重开');
          resolve(false);
        } else if (ans === 'e') {
          onLog('[executor] 已选择编辑——请修改 source-anchor.json 后重新运行');
          resolve(false);
        } else { onLog('[executor] 无效输入，已按终止处理'); resolve(false); }
      });
    });
  }
  throw new Error('[source-anchor] 名册等待人工确认：请核对确认单后创建 ' + markFile + '（含确认人/时间/名册哈希），或使用 --skip-roster-confirm');
}

// A8-ERR-1：读取前端面板导出的 .api-config.json（Node 侧；无文件返回 null）
function loadFileConfig(file) {
  if (!file || !fs.existsSync(file)) return null;
  const j = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return {
    provider: j.provider || undefined,
    baseUrl: j.baseUrl || undefined,
    apiKey: j.apiKey || undefined,
    model: j.model || undefined,
    maxTokens: j.maxTokens || undefined,
    // R7 阶段 2：.api-config.json 可选 plain 字段（生成白话版开关；CLI --plain 优先）
    plain: j.plain !== undefined ? !!j.plain : undefined
  };
}

// A8-ERR-1：单轮产物真实校验（R1/R2/R2.5/R3 → PC.validate；R4 → JSON+checkStructure；R5 半区 → validateHalf）
// 供正常路径与断点续跑共用——断点只能跳过“真正通过全部校验”的产物
function validateRound(workDir, round, text, onLog, extra) {
  const PC = require('../pipeline-controller.js');
  // 源锚层 v1（N-1）：锚的唯一切入点——每轮门禁共用；缺失 → null → 表级锚降级（显式登记防静默失效）
  const anchor = readAnchor(workDir);
  let v = null;
  if (round.name === 'R5A' || round.name === 'R5B') {
    // semantic-authority fail-closed：R5 正向合同与 full-data 都是正式门禁权威，不得因读取失败退化成弱校验。
    let registry, data;
    try { registry = PC.parseInsertRegistry(resolveSkillPath()); }
    catch (e) { return { passed: false, errors: ['INSERT注册表加载失败: ' + e.message], warnings: [], warningRecords: [] }; }
    const fullData = readIfExists(path.join(workDir, 'full-data.md'));
    if (!fullData) return { passed: false, errors: ['R5 门禁数据源缺失: full-data.md'], warnings: [], warningRecords: [] };
    try { data = PC.extractDataMarkers(fullData); }
    catch (e) { return { passed: false, errors: ['R5 门禁数据源解析失败: ' + e.message], warnings: [], warningRecords: [] }; }
    v = PC.validateHalf(text, round.half, { registry, data });
  }
  else if (round.name === 'R4.5') {
    // 3B：R4.5 校验 = adjudication schema/白名单 + 同源性（ADJ-14）+ 机械复核（合并裁决后 validate/checkStructure/diffConflicts）
    let adj = null;
    try { adj = JSON.parse(text); } catch (e) {
      // 容错：模型可能用 ```json 围栏包裹（与 R4 structure 同一容错路径）
      try { adj = PC.parseStructureJson(text); } catch (e2) {
        v = { passed: false, errors: ['adjudication.json 解析失败: ' + e.message] };
        return { ...v, warnings: [] };   // 260809 R2.3：warnings 透传（六处返回点统一）
      }
    }
    // semantic-authority fail-closed：正式 real R4.5 的机械冲突登记表必须存在且可解析；缺失/损坏不得解释成“无冲突”。
    const regPath = path.join(workDir, '.tmp-conflicts.json');
    if (!fs.existsSync(regPath)) {
      return { passed: false, errors: ['R4.5 机械冲突登记表缺失: .tmp-conflicts.json'], warnings: [], warningRecords: [] };
    }
    let registryConflicts;
    try { registryConflicts = JSON.parse(fs.readFileSync(regPath, 'utf8')); }
    catch (e) { return { passed: false, errors: ['R4.5 机械冲突登记表解析失败: ' + e.message], warnings: [], warningRecords: [] }; }
    if (!Array.isArray(registryConflicts)) {
      return { passed: false, errors: ['R4.5 机械冲突登记表结构非法: 必须为数组'], warnings: [], warningRecords: [] };
    }
    const va = PC.validateAdjudication(adj, { registryConflicts });
    if (!va.passed) {
      v = { passed: false, errors: va.errors.map(e => e.rule + ': ' + e.message) };
      return { ...v, warnings: [] };   // 260809 R2.3
    }
    const recheck = adjudicationRecheck(workDir, adj, registryConflicts);
    if (!recheck.passed) {
      v = { passed: false, errors: recheck.errors };
      return { ...v, warnings: [] };   // 260809 R2.3
    }
    v = { passed: true, errors: [] };
  }
  else if (round.name === 'R4') {
    // P1：直接走 checkStructure——其内部 parseStructureJson 已容错剥离 [S_START]/```json 围栏；
    // 真非法内容仍 S0 BLOCKING，门禁不弱化。
    const cs = PC.checkStructure(path.join(workDir, round.outFile), { tfPath: path.join(workDir, 'transition-final.md') });
    v = { passed: cs.passed, errors: cs.errors.map(e => ({ message: e.message || e })) };
  } else if (['R1', 'R2', 'R2.5', 'R3'].includes(round.name)) {
    const validationOptions = { anchor, newContract: !!(extra && extra.newContract), sourceAnchorExemptions: (extra && extra.sourceAnchorExemptions) || [] };
    // C9a/C9b 的 R2 前置门禁需要 P1 的 S7 致命计数；P1 缺失时不伪造数据，
    // 由后续既有最终门禁报告，避免旧场次/断点场景静默改变语义。
    if (round.name === 'R2' || round.name === 'R2.5') {
      const p1 = readIfExists(path.join(workDir, 'P1.md'));
      if (p1) validationOptions.p1Data = PC.extractDataMarkers(p1);
    }
    v = PC.validate(text, round.name, validationOptions);
    // 降级显式登记（N-1：防静默失效——锚不执行≠报错，必须有日志标记）
    if (!anchor && onLog) onLog('[executor] source-anchor.json 未加载——锚 1/锚 2/锚 3 降级跳过');
    // 实测修复：transition-final 的 D1/D2（判决行/比分 vs S15）必须在 R3 门禁内反馈重试，
    // 否则 buildTransitionFinal 抛错会终止整条管道（P3 通过但比分 7:3 vs S15 3:7 的案例）
    if (round.name === 'R3' && v.passed) {
      const vc = PC.checkVerdictConsistency(text, PC.extractDataMarkers(text));
      if (vc.errors.length > 0) v = { passed: false, blocking: vc.errors };
    }
    // 260819 FG：契约↔产物形态必须在生产轮次反馈，避免最终 WARNING 过晚才暴露。
    // R1/R2/R3 只检查本轮负责的表；最终合并校验仍由 validator.validate(final) 检查全套表。
    if (['R1', 'R2', 'R3'].includes(round.name)) {
      const shapeErrors = [];
      validator.checkOutputShape(text, shapeErrors, round.name);
      // 兼容旧场次/旧 fixture：缺表仍由最终 WARNING 报告；已输出表但列数违约才前置阻断。
      const malformedTables = shapeErrors.filter(e => /表头列数=/.test(String(e.message || '')));
      if (malformedTables.length > 0) {
        const blockingShape = malformedTables.map(e => ({
          ...e,
          severity: 'BLOCKING',
          message: e.message + '——生产轮次门禁要求重跑 ' + round.name
        }));
        v = {
          ...v,
          passed: false,
          blocking: [...(v.blocking || []), ...blockingShape]
        };
      }
    }
  }
  if (!v) return { passed: true, errors: [], warnings: [], warningRecords: [] };   // 260809 R2.3
  const warningRecords = (v.warnings || []).map(w => w && typeof w === 'object' ? w : { rule: '', severity: 'WARNING', message: String(w) });
  const warningMessages = warningRecords.map(w => w.message);
  if (v.passed) return { passed: true, errors: [], warnings: warningMessages, warningRecords };   // 260809 R2.3
  const arr = v.blocking || v.errors || [];
  const msgs = arr.length ? arr.map(e => (e && typeof e === 'object' ? (e.message || e.reason || JSON.stringify(e)) : String(e))) : (v.reason ? [v.reason] : ['校验失败（无详细错误）']);
  return { passed: v.passed, errors: msgs, warnings: warningMessages, warningRecords };   // 260809 R2.3
}

// 冒烟用良好响应器：按 prompt 中的输出范围约束返回门禁可通过的产物（R5 半区含模块文本+表行数）
function goodMockResponder(messages) {
  const prompt = String((messages[messages.length - 1] || {}).content || '');
  const PC = require('../pipeline-controller.js');
  const registry = PC.parseInsertRegistry(resolveSkillPath());
  // Web 默认 R8 冒烟：只在 mock provider 经 requestCompletion 的 mockResponder seam 命中；
  // 生产 R8 仍由真实模型 + 机械门 + 独立复核执行，不共享这里的假数据。
  // PLAIN v4 mock contract: mock/CI 也必须经过独立 reviewer，只把 reviewer 响应确定性化；不得绕过 review orchestration。
  if (prompt.includes('checkedIds 必须恰好覆盖 targetIds')) {
    const m = prompt.match(/(?:^|\n)targetIds=(\[[^\n]*\])/);
    const checkedIds = m ? JSON.parse(m[1]) : [];
    return JSON.stringify({ approved: true, checkedIds, issues: [] });
  }
  if (prompt.includes('reader-guide-plain') && prompt.includes('semanticEquivalent') && prompt.includes('zeroBackgroundReadable')) {
    return JSON.stringify({
      approved: true,
      cardChecks: Array.from({ length: 12 }, (_, i) => ({
        sectionId: 'C' + (i + 1),
        semanticEquivalent: true,
        noJudgmentChange: true,
        factsConsistent: true,
        zeroBackgroundReadable: true,
        naturalReadable: true,
        noLocatorDependency: true
      }))
    });
  }
  if (prompt.includes('\n\nreader-guide:\n') && prompt.includes('\n\nguide-input:\n')) {
    const RG = require('../scripts/reader-guide.js');
    return JSON.stringify({
      approved: true,
      cardChecks: RG.SECTION_IDS.map(sectionId => ({ sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true }))
    });
  }
  if (prompt.includes('\n\nguide-input:\n') && prompt.includes('读者导览助手')) {
    const RG = require('../scripts/reader-guide.js');
    const rawInput = prompt.slice(prompt.lastIndexOf('\n\nguide-input:\n') + '\n\nguide-input:\n'.length);
    const input = JSON.parse(rawInput);
    const snapshotMatch = prompt.match(/"modelSnapshot":(\{[^\n]*?\}),"cards"/);
    const modelSnapshot = snapshotMatch ? JSON.parse(snapshotMatch[1]) : {};
    const cards = (input.sections || []).map(section => {
      const speech = (section.sources || []).filter(source => /^SPEECH:/.test(String(source && source.id || '')));
      const chosen = (section.sectionId === 'C3' || section.sectionId === 'C7') ? speech : speech.slice(0, 1);
      const firstEvidence = section.sources && section.sources[0] ? [section.sources[0].id] : [];
      const evidence = Array.from(new Set(firstEvidence.concat(chosen.map(source => source.id))));
      return {
        sectionId: section.sectionId,
        what: '本章把已有材料按读者容易理解的方式说明。',
        why: '它帮助读者理解本章在整份报告中的作用。',
        conclusion: '本章结论以来源材料为准。',
        evidence,
        anchors: chosen.map(source => ({
          sourceId: source.id,
          speaker: source.anchor && source.anchor.speaker || '',
          stage: source.anchor && source.anchor.stage || '',
          quote: source.anchor && source.anchor.quote || ''
        }))
      };
    });
    return JSON.stringify({
      schemaVersion: RG.SCHEMA_VERSION,
      inputHash: RG.hashGuideInput(input),
      promptVersion: RG.PROMPT_VERSION,
      modelSnapshot,
      cards
    });
  }
  const mockTable = name => '<!--TABLE:名称=Mock表-' + name + ',列=列A|列B|列C-->\n' +
    '| 列A | 列B | 列C |\n|---|---|---|\n| 甲 | 乙 | 丙 |\n| 丁 | 戊 | 己 |\n| 庚 | 辛 | 壬 |\n<!--/TABLE-->';
  const modText = n => {
    const ch = 'C' + n;
    // R8 Web 默认链会把 mock R5 叙事交给正式机械 renderer，因此 C1 也必须满足正式 R5→R6 C1 合同，
    // 不能继续依赖旧 R6b 手写 HTML 掩盖 mock 叙事缺口。
    if (ch === 'C1') {
      return '## C1\n\n<!--XP:这场比赛最终谁赢，依据是什么？-->\n\n' +
        '<!--INSERT_C1_01_POEM-->\n' +
        '风起两端各有声\n潮来一线见分明\n攻防有据方成势\n裁断归于证理中\n\n' +
        '<!--INSERT_C1_02_REASON-->\n' +
        '**反方胜（4:6）**\n\n反方在关键证明链上完成更稳定的回应，因此取得本场优势。\n\n' +
        '<!--INSERT_C1_03_HEXAD-->\n' +
        '<!--TABLE:名称=六向度,列=向度|正方|反方-->\n' +
        '| 向度 | 正方 | 反方 |\n|---|---:|---:|\n' +
        '| 证伪 | 4 | 6 |\n| 证成 | 4 | 6 |\n| 理性 | 4 | 6 |\n| 感性 | 5 | 5 |\n| 场面感 | 5 | 5 |\n| 意义感 | 5 | 5 |\n' +
        '<!--/TABLE-->\n\n' +
        '<!--INSERT_C1_04_JUDGMENT-->\n' +
        '<!--TABLE:名称=判准ABCD,列=判准|说明-->\n' +
        '| 判准 | 说明 |\n|---|---|\n| A | 关键主张是否得到证明 |\n| B | 对方核心攻击是否被处理 |\n| C | 比较关系是否清楚 |\n| D | 结论是否能从前述理由推出 |\n' +
        '<!--/TABLE-->\n';
    }
    const inserts = registry.inserts.filter(r => r.ch === ch && r.consumer === 'R6b' &&
      (r.producer === 'R5' || (ch === 'C8' && r.producer === 'R2.5')));
    let out = '## ' + ch + '\n\n<!--XP:' + ch + ' 的设问？-->\n\n';
    for (const ins of inserts) {
      if (ins.condition) continue; // mock 默认 S4=否 → C4 条件项豁免
      out += '<!--INSERT_' + ins.name + '-->\n';
      if (ins.type === 'table' || ins.type === 'table+prose' || ins.name.includes('TABLE')) out += mockTable(ins.name) + '\n\n';
      else out += '内容'.repeat(40) + '\n\n';
    }
    if (ch === 'C7') {
      out += '<!--DATA: C7.微消化.正方.实例表行数=0 -->\n' +
        '<!--DATA: C7.微消化.反方.实例表行数=0 -->\n' +
        '<!--DATA: C7.微消化.总有效数=0 -->\n' +
        '<!--DATA: C7.SC总览.正方.有效微消化=0 -->\n' +
        '<!--DATA: C7.SC总览.反方.有效微消化=0 -->\n';
    }
    return out;
  };
  if (prompt.includes('C1 到 C7')) {
    return [1, 2, 3, 4, 5, 6, 7].map(modText).join('\n\n');
  }
  if (prompt.includes('C8 到 C12')) {
    return [8, 9, 10, 11, 12].map(modText).join('\n\n');
  }
  // R4：mock 也返回最小可解析 structure，使默认 Web R8 能消费真实同形依赖；
  // realValidate=false 下不把这个占位结构送入正式结构语义门。
  if (prompt.includes('产出 `structure.json`') && prompt.includes('结构归约')) {
    return JSON.stringify({
      meta: { schema_version: 'v2', s11_original_type: '1b' },
      layers: [{ id: 'N1', label: '结构性交锋', side: '反方', nodes: [], opponent_nodes: [] }],
      mechanisms: []
    }, null, 2);
  }
  // R4.5：mock 最小合法裁决表（空 conflicts/authoritative，audit 自洽）
  if (prompt.includes('信息统筹轮')) {
    return JSON.stringify({
      schema_version: '0.1.0',
      meta: {
        round: 'R4.5',
        output_dir: 'mock',
        generated_at: new Date().toISOString(),
        source_conflicts_file: '.tmp-conflicts.json',
        source_warnings_file: '.tmp-validate-warnings.json',
        tendency: ''
      },
      conflicts: [],
      authoritative: {},
      structure_meta_override: null,
      audit: {
        merged_validate: { passed: true, blocking: 0 },
        post_diff_conflicts: 0,
        structure_check: { passed: true },
        recheck_notes: []
      }
    }, null, 2);
  }
  // R6b：返回满足 D3/D4/D5 + REG-RESIDUAL/TBL-EMPTY 的静态合法报告（R5 prompt 也含 “R6b” 字样，须最后判断）
  if (prompt.includes('R6b')) {
    const mods = [];
    for (let i = 1; i <= 12; i++) {
      let body = '<h2 class="st">C' + i + ' mock</h2><p class="in">mock 内容</p>';
      if (i === 1) {
        body = '<h2 class="st">C1 胜负判决</h2>' +
          '<div class="po">万物静观皆自得，千心一动始成春。</div>' +
          '<p class="wn">反方胜（4:6）</p>' +
          '<table><tr><td>向度</td><td>正方</td><td>反方</td></tr><tr><td>证伪</td><td>4</td><td>6</td></tr></table>' +
          '<table><tr><td>判准</td><td>说明</td></tr><tr><td>A</td><td>类型</td></tr></table>';
      }
      if (i === 3) body = '<h2 class="st">C3 主线全景图</h2><p class="in">mock 内容</p><span class="tg t1b">1b型</span>';
      mods.push('<div class="sk c-module c' + i + '" id="c' + i + '">' + body + '</div>');
    }
    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>mock 报告</title><style>body{}</style></head><body>' + mods.join('') + '</body></html>';
  }
  return '<!-- mock-good 产物 · ' + prompt.slice(0, 40) + ' -->';
}

// 单轮执行：断点（产物已存在且门禁通过 → 跳过）→ API → 落盘 → 门禁 → 重试（最多 3 次 + 指数退避）
async function runRound(opts) {
  const { workDir, round, cfg, mockResponder, onLog, force, newContract } = opts;
  const outFile = path.join(workDir, round.outFile);
  const promptFile = path.join(workDir, round.promptFile);
  // A8-ERR-1：断点判定 = 文件存在 + executor 门禁 + 真实 provider 下 PC 校验重验（防跳过未真正通过的产物）
  const existing = readIfExists(outFile);
  if (!force && existing && core.isArtifactUsable(round.name, existing)) {
    assertSourceAnchorExemptionArtifactBinding(round, existing, opts.sourceAnchorExemptions);
    const existingValidation = opts.realValidate
      ? validateRound(workDir, round, existing, onLog, { newContract, sourceAnchorExemptions: opts.sourceAnchorExemptions })
      : { passed: true, warningRecords: [] };
    if (existingValidation.passed) {
      const wxCount = (existingValidation.warningRecords || []).filter(w => w.rule === 'V-S8E-WX').length;
      if (wxCount) onLog('[executor] ' + round.name + ' audit-only V-S8E-WX ' + wxCount + ' 条（断点验证通过；不进入 R4.5 语义 warning 通道）');
      onLog('[executor] 断点命中 ' + round.name + ' → 跳过（产物门禁通过，' + anchorStateLabel(workDir) + '）');   // 260809 R8：锚状态
      return { round: round.name, skipped: true, ok: true };
    }
    if (round.name === 'R2' && Array.isArray(opts.sourceAnchorExemptions) && opts.sourceAnchorExemptions.length > 0) {
      throw sourceAnchorExemptionError('当前 P2 在应用人工豁免后仍有其他 BLOCKING；为保护人工签字绑定的原产物，拒绝调用模型覆盖 P2。请先处理其他 BLOCKING，或删除 checkpoint 后重新生成 R2');
    }
  }
  if (!fs.existsSync(promptFile)) {
    return { round: round.name, ok: false, errors: ['prompt 文件缺失: ' + round.promptFile + '（先运行 prompt 生成阶段）'] };
  }
  const promptText = fs.readFileSync(promptFile, 'utf-8');
  let lastGate = null;
  for (let attempt = 0; attempt <= core.MAX_RETRIES; attempt++) {
    onLog('[executor] ' + round.name + ' 开始调用 API（等待响应…）attempt=' + (attempt + 1));
    if (attempt > 0) {
      const d = core.retryDelayMs(attempt);
      onLog('[executor] ' + round.name + ' 重试 ' + attempt + '/' + core.MAX_RETRIES + ' · 退避 ' + d + 'ms');
      await sleep(d);
    }
    // A8-ERR-1：重试携带格式校验反馈（结构性提升模型遵守率，避免原样重发碰运气）
    const usePrompt = (attempt > 0 && lastGate && lastGate.errors.length)
      ? promptText + '\n\n---\n## 上次输出未通过机械格式校验，必须严格修正后完整重新输出（只输出修正后的完整产物）\n' +
        lastGate.errors.map(e => '- ' + e).join('\n') + '\n'
      : promptText;
    let text;
    try {
      // 批 1（260812）：apiStub seam——测试可注入（签名同 api.requestCompletion）；缺省走真实提供者
      const call = opts.apiStub || requestCompletionNode;
      const callOpts = { mockResponder };
      if (opts.codexRunner) callOpts.codexRunner = opts.codexRunner;
      text = await call(cfg, [{ role: 'user', content: usePrompt }], callOpts);
    } catch (e) {
      // 批 1（260812）：传输层异常（③收紧 流截断/断连/流异常族）纳入轮次重试循环——
      // 不再穿透循环导致管道退出；确定性错误（length 截断/HTTP/配置）仍直接抛（重试无意义）
      const msg = e && e.message ? String(e.message) : String(e);
      // 可重试 = 传输/断连/截断类（③收紧、流异常、缓冲超限、fetch 断连实况）。
      // 注意：不匹配「网络请求失败」宽词——2h 超时 AbortError 会被包装为
      // 「网络请求失败: This operation was aborted」，宽匹配将导致 4×2h 灾难性重试；
      // 真断连经 api-provider 包装后 message 仍保留 fetch failed/terminated/ECONNRESET 等实况词条
      const retryable = /未收到 finish_reason|fetch failed|ECONNRESET|terminated|other side closed|socket hang up|流中错误帧|流式响应无 body|缓冲超限/.test(msg);
      if (retryable && attempt < core.MAX_RETRIES) {
        lastGate = null;                       // 不把传输错误注入模型重试 prompt（非模型可修正项）
        onLog('[executor] ' + round.name + ' API 传输异常（纳入重试 attempt=' + (attempt + 1) + '）: ' + msg);
        continue;                              // 回到循环头 → 退避 sleep → 下一 attempt
      }
      throw e;                                 // 非可重试 / 预算耗尽：保持原失败语义（禁止部分产物已由 api-provider 保证）
    }
    // A8-ERR-1：PC 延迟 require——必须在主模块（pipeline-controller）导出之后加载，避免循环依赖拿到空导出
    const PC = require('../pipeline-controller.js');
    // S 标记机械归一化（漏写 [S_START] 时补齐，与 autoFixTables 同级）
    text = PC.autoFixSMarkers(text);
    // T2：V1 无损归一化回写（“半完成 · 解释尾巴”→规范枚举值），留日志；不可归一化仍由 V1 BLOCKING
    const fixed = PC.autoFixDataValues(text);
    if (fixed.fixes.length) {
      onLog('[executor] DATA 值归一化回写 ' + fixed.fixes.length + ' 处: ' +
        fixed.fixes.map(f => f.key + ':' + f.from + '→' + f.to).join('; '));
    }
    text = fixed.text;
    fs.writeFileSync(outFile, text, 'utf-8');
    assertSourceAnchorExemptionArtifactBinding(round, text, opts.sourceAnchorExemptions);
    // 3B：attempt 留档（防“失败 attempt 全文被后续重试覆盖”的历史缺口）
    try { fs.writeFileSync(outFile + '.attempt' + (attempt + 1), text, 'utf-8'); } catch (e) {}
    // 实测修复（2026-08-05）：先 PC.validate（A1-A4/D1-D2 等完整清单），再 assessArtifact，
    // 两类错误合并成一条重试反馈——避免 assessArtifact 短路导致模型看不到 A1 缺失清单。
    const gateErrors = [];
    let vr = null;                                    // 260809 R2：提至 if 外（原 const 块级作用域 → lastGate.ok 分支 ReferenceError）
    if (opts.realValidate) {
      vr = validateRound(workDir, round, text, onLog, { newContract, sourceAnchorExemptions: opts.sourceAnchorExemptions });
      if (!vr.passed) gateErrors.push('PC.validate: ' + vr.errors.join('; '));
    }
    const aa = core.assessArtifact(round.name, text);
    if (!aa.ok) gateErrors.push(aa.errors.join('; '));
    lastGate = gateErrors.length
      ? { ok: false, errors: gateErrors, warnings: [] }
      : { ok: true, errors: [], warnings: [] };
    if (lastGate.ok) {
      onLog('[executor] ' + round.name + ' ✓ 落盘 ' + round.outFile + ' (' + Buffer.byteLength(text, 'utf-8') + 'B)（' + anchorStateLabel(workDir) + '）');
      // R9.2（260809）：锚 3 旁证 warn 落盘（V-S8E-W3；R3 final 后由 buildTransitionFinal 覆盖属预期）
      if (opts.realValidate && vr && vr.warnings && vr.warnings.length) {
        try {
          const semanticWarnings = warningsForAdjudication(vr);
          if (semanticWarnings.length) {
            fs.writeFileSync(path.join(workDir, '.tmp-validate-warnings.json'), JSON.stringify(semanticWarnings, null, 2), 'utf-8');
            onLog('[executor] ' + round.name + ' warnings ' + semanticWarnings.length + ' 条 → .tmp-validate-warnings.json');
          }
          const auditOnly = (vr.warningRecords || []).filter(w => w.rule === 'V-S8E-WX');
          if (auditOnly.length) onLog('[executor] ' + round.name + ' audit-only V-S8E-WX ' + auditOnly.length + ' 条（不进入 R4.5 语义 warning 通道）');
        } catch (e) { /* 落盘失败不阻断 */ }
      }
      return { round: round.name, ok: true, attempt, bytes: Buffer.byteLength(text, 'utf-8') };
    }
    onLog('[executor] ' + round.name + ' 门禁失败: ' + lastGate.errors.join('; '));
  }
  return { round: round.name, ok: false, errors: lastGate ? lastGate.errors : ['未知失败'], attempt: core.MAX_RETRIES };
}

// R4 后数据聚合：P1+P2+P2.5+P3 → full-data.md（R5 唯一输入）
function buildFullData(workDir, onLog) {
  const files = ['P1.md', 'P2.md', 'P2.5.md', 'P3.md'];
  const parts = [];
  for (const f of files) {
    const p = path.join(workDir, f);
    // A8-P7：全量运行保障——任一前置产物缺失即阻断，禁止生成不完整 full-data 后继续
    if (!fs.existsSync(p)) {
      throw new Error('[executor] 数据聚合失败: 缺少 ' + f + '——禁止生成不完整 full-data（全量运行保障）。请修复对应轮次后重跑。');
    }
    parts.push('<!-- SECTION:' + f.replace(/\.md$/, '').toUpperCase() + '_START -->\n' + fs.readFileSync(p, 'utf-8') + '\n<!-- SECTION:' + f.replace(/\.md$/, '').toUpperCase() + '_END -->');
  }
  const full = parts.join('\n---\n');
  fs.writeFileSync(path.join(workDir, 'full-data.md'), full, 'utf-8');
  onLog('[executor] 数据聚合 → full-data.md (' + full.length + '字)');
}

// A8-ERR-1 R3 修复：R3 调用前重建 .tmp-R3-prompt.md——注入 P1/P2/P2.5 + 从 P1/P2 提取的唯一辩词引用块
// （对应旧机制技能步骤 3：主线程 grep '> "..."' 提取引用 + R3 Agent 读取前置数据；executor 单次调用需全部内联）
function buildR3Prompt(workDir, onLog) {
  const p1 = readIfExists(path.join(workDir, 'P1.md'));
  const p2 = readIfExists(path.join(workDir, 'P2.md'));
  const p25 = readIfExists(path.join(workDir, 'P2.5.md'));
  const base = readIfExists(path.join(workDir, '.tmp-R3-prompt.md'));
  if (!base || !p1 || !p2) throw new Error('[executor] R3 prompt 重建缺少 base/P1/P2');
  const quotes = [...new Set((p1 + '\n' + p2).split('\n').filter(l => /^\s*>\s*"/.test(l)).map(l => l.trim()))];
  const quotesText = quotes.length ? quotes.join('\n') : '（P1/P2 中未提取到引用行）';
  fs.writeFileSync(path.join(workDir, '.tmp-speech-quotes.txt'), quotesText + '\n', 'utf-8');
  const enriched = base
    .replace('<!-- SPEECH_QUOTES_PLACEHOLDER: 辩词引用块由管道编排器从 P1/P2 中 grep 提取后追加 -->', quotesText)
    + '\n\n---\n\n## 前置数据（R3 必读 · 全部来自本场产物）\n\n### P1（R1 产出）\n' + p1
    + '\n\n### P2（R2 产出）\n' + p2
    + (p25 ? '\n\n### P2.5（R2.5 产出）\n' + p25 : '');
  fs.writeFileSync(path.join(workDir, '.tmp-R3-prompt.md'), enriched, 'utf-8');
  assertPromptsWithinContext(workDir, undefined, onLog);  // A8-P7：重建后立即超限预检
  onLog('[executor] R3 prompt 已重建（P1/P2/P2.5 + ' + quotes.length + ' 条唯一引用）');
  return enriched;
}

// R5 半区拼接：A（C1-C7）+ B（C8-C12）→ 叙事.md
function mergeNarrative(workDir, onLog) {
  const a = readIfExists(path.join(workDir, '.tmp-r5-half-A.md'));
  const b = readIfExists(path.join(workDir, '.tmp-r5-half-B.md'));
  // A8-P7：全量运行保障——任一半区缺失即阻断，禁止部分拼接后继续
  if (!a && !b) {
    throw new Error('[executor] 叙事拼接失败: R5-A 与 R5-B 半区均缺失——禁止跳过叙事继续。');
  }
  if (!a || !b) {
    throw new Error('[executor] 叙事拼接失败: 缺少 ' + (!a ? '.tmp-r5-half-A.md' : '.tmp-r5-half-B.md') + '——禁止部分拼接/降级叙事，请补全 R5 半区产物。');
  }
  const merged = a + (a && b ? '\n\n' : '') + b;
  fs.writeFileSync(path.join(workDir, '叙事.md'), merged, 'utf-8');
  onLog('[executor] 叙事半区拼接 → 叙事.md (' + merged.length + '字)');
  return true;
}

// A8-ERR-1 C8：R3 通过后生成 transition-final.md（P1+P2+P2.5+P3 合并 + 校验），写入 workDir
// realValidate=false（mock 冒烟）：仅生成文件与 TABLE 配对，跳过严格 R3 校验
function buildTransitionFinal(workDir, onLog, realValidate) {
  const PC = require('../pipeline-controller.js');
  const p1 = readIfExists(path.join(workDir, 'P1.md'));
  const p2 = readIfExists(path.join(workDir, 'P2.md'));
  const p25 = readIfExists(path.join(workDir, 'P2.5.md'));
  const p3 = readIfExists(path.join(workDir, 'P3.md'));
  if (!p1 || !p2 || !p3) throw new Error('[executor] transition-final 合并缺少 P1/P2/P3');
  let merged = p1 + '\n---\n' + p2;
  if (p25) merged += '\n---\n' + p25;
  merged += '\n---\n' + p3;
  merged = PC.autoFixSMarkers(merged);
  merged = PC.autoFixTables(merged);
  const pair = PC.validateTablePairing(merged);
  if (!pair.passed) throw new Error('[executor] TABLE 配对失败: ' + pair.errors.join('; '));
  let result = null;
  // 260810 批次3（P1-B）：final validate 前读 P1 探测 newContract（同判定核心）
  const newContractFinal = PC.detectNewContractFromText(readIfExists(path.join(workDir, 'P1.md')));
  if (realValidate) {
    // A8-ERR-1：合并文件必须用 final 模式（跨三轮）校验，与 validate-final CLI 对齐——单轮 R3 语义会对全集合误报 F3
    result = PC.validate(merged, 'R3', {
      final: true,
      p1Data: PC.extractDataMarkers(p1),
      p2Data: PC.extractDataMarkers(p2),
      p25Data: p25 ? PC.extractDataMarkers(p25) : {},
      newContract: newContractFinal
    });
    if (!result.passed) throw new Error('[executor] transition-final 校验失败: ' + (result.blocking || []).map(e => e.message).join('; '));
  }
  // 260810 批次3：派生方向 DATA 行回写（完成度行后插入；旧数据已有方向键则不重写）
  merged = PC.injectDerivedDataLines(merged);
  fs.writeFileSync(path.join(workDir, 'transition-final.md'), merged, 'utf-8');
  if (realValidate && result) {
    // D1/D2：判决行/比分与 S15 DATA 一致性（合同固定 正方:反方）
    const vc = PC.checkVerdictConsistency(merged, PC.extractDataMarkers(merged));
    if (vc.errors.length)
      throw new Error('[executor] transition-final D1/D2 校验失败: ' + vc.errors.map(e => e.message).join('; '));
    // 第4项：WARNING 落盘供 R5 叙事轮加载
    if (result.warnings && result.warnings.length) {
      fs.writeFileSync(path.join(workDir, '.tmp-validate-warnings.json'), JSON.stringify(result.warnings, null, 2));
    }
    // 第4项：diffConflicts 机械矛盾登记表落盘（structure 尚未产出，先跑与 structure 无关的维度）
    try {
      const conflicts = PC.diffConflicts(PC.aggregateData(path.join(workDir, 'transition-final.md')), null);
      if (conflicts.length) fs.writeFileSync(path.join(workDir, '.tmp-conflicts.json'), JSON.stringify(conflicts, null, 2));
    } catch (e) {}
  }
  onLog('[executor] transition-final.md 已生成 (' + merged.length + '字)');
  return merged;
}

// A8-ERR-1：真实路径 R6 机械渲染（report.html 由渲染器确定性生成，替代 LLM 超长输出轮）
function renderReport(workDir) {
  const RR = require('../render-report.js');
  const PC = require('../pipeline-controller.js');
  // 3B：存在裁决合并视图时优先使用（渲染与 R4.5 权威值一致）
  const mergedTf = path.join(workDir, '.tmp-adjudicated-data.md');
  const mergedSt = path.join(workDir, '.tmp-adjudicated-structure.json');
  const tf = fs.existsSync(mergedTf) ? mergedTf : path.join(workDir, 'transition-final.md');
  const narr = path.join(workDir, '叙事.md');
  const st = fs.existsSync(mergedSt) ? mergedSt : path.join(workDir, 'structure.json');
  // A8-P7：禁止降级渲染——structure.json 缺失即阻断（C3 必须按推进层完整渲染）
  if (!fs.existsSync(tf) || !fs.existsSync(narr)) throw new Error('渲染缺少 transition-final.md 或 叙事.md——禁止降级渲染。');
  if (!fs.existsSync(st)) throw new Error('渲染缺少 structure.json——禁止降级渲染 C3（结构归约必须完整）。请先通过 R4 门禁。');
  const normalized = RR.normalizePhase1(fs.readFileSync(tf, 'utf-8'), fs.readFileSync(narr, 'utf-8'));
  const opts = {};
  // 批甲 HN-5：裁决正式产物注入渲染（C9c 标注消费；读 adjudication.json——正式产物，生命周期稳定）
  opts.adjudication = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(workDir, 'adjudication.json'), 'utf8')); }
    catch (e) { return null; }
  })();
  try { opts.structure = PC.parseStructureJson(fs.readFileSync(st, 'utf-8')); } catch (e) { throw new Error('structure.json 解析失败: ' + e.message); }
  // C1：机械渲染补 G0——effectiveType 必须经 G0 校验，C3 面板不再降级成 0 型
  const g0 = PC.checkEffectiveType(normalized.data || {}, opts.structure, null);
  if (g0.errors.length) {
    throw new Error('G0 门禁失败: ' + g0.errors.map(e => e.rule + ' ' + e.message).join(' | '));
  }
  opts.effectiveType = g0.effectiveType;
  // 源锚层 v1（J-1）：免责横幅渲染开关——类型 A/B 确认继续时 source-anchor.json 持久化 disclaimer:true
  try {
    const sa = JSON.parse(fs.readFileSync(path.join(workDir, 'source-anchor.json'), 'utf-8'));
    if (sa.disclaimer === true) opts.disclaimer = true;
  } catch (e) { /* 无 source-anchor → 不触发免责 */ }
  const html = RR.renderHTML(normalized, opts);
  fs.writeFileSync(path.join(workDir, 'report.html'), html, 'utf-8');
  return html.length;
}

// ---------- R8：独立读者章节导览（不接入管道控制器、不改写 R1—R7 产物） ----------

const READER_GUIDE_SYSTEM = '你是 R8 读者章节导览执行器。只可依据用户消息中的 guide-input 输出严格 JSON；不得补充、推断或改写任何裁决、事实、数字、主体、胜负、评分或 ID。';
const READER_GUIDE_PLAIN_REVIEW_SYSTEM = '你是 R8 章节导览白话层的独立语义复核器。按完整卡片上下文独立检查 semanticEquivalent、noJudgmentChange、factsConsistent、zeroBackgroundReadable、naturalReadable、noLocatorDependency。内部编号可以只是 locator，不要求逐个解释；但忽略编号后仍应能理解事件与判断。任何主体、胜负、事实、数字、因果、否定、限定、责任、程度或结论强度变化都必须拒绝。只输出严格 JSON。';
// R8 只允许生成独立导览派生层。以下 R1—R7 权威输入、裁决结果与白话正文必须全程逐字不变；
// report.html 仅允许在全部 R8 门禁通过后由机械 embedder 增加导览展示，因此不列入此不可变集合。
const R8_IMMUTABLE_FIXED_FILES = [
  'P1.md', 'P2.md', 'P2.5.md', 'P3.md', 'full-data.md',
  '.tmp-adjudicated-data.md', '.tmp-adjudicated-structure.json', 'transition-final.md',
  'structure.json', '叙事.md', 'adjudication.json', 'source-anchor.json',
  'report-plain.html', '.tmp-plain-review.json'
];
function r8ImmutableNames(workDir) {
  const batches = fs.existsSync(workDir)
    ? fs.readdirSync(workDir).filter(name => /^\.tmp-plain-batch-\d+\.json$/.test(name)).sort()
    : [];
  return R8_IMMUTABLE_FIXED_FILES.concat(batches);
}

function readerGuideModelSnapshot(cfg) {
  return {
    provider: String((cfg && cfg.provider) || ''),
    model: String((cfg && cfg.model) || '')
  };
}

function readerGuidePaths(workDir) {
  const adjudicatedData = path.join(workDir, '.tmp-adjudicated-data.md');
  const adjudicatedStructure = path.join(workDir, '.tmp-adjudicated-structure.json');
  return {
    adjudicatedData,
    transition: fs.existsSync(adjudicatedData) ? adjudicatedData : path.join(workDir, 'transition-final.md'),
    structure: fs.existsSync(adjudicatedStructure) ? adjudicatedStructure : path.join(workDir, 'structure.json'),
    adjudication: path.join(workDir, 'adjudication.json'),
    input: path.join(workDir, 'reader-guide-input.json'),
    guide: path.join(workDir, 'reader-guide.json'),
    plain: path.join(workDir, 'reader-guide-plain.json'),
    html: path.join(workDir, 'reader-guide.html'),
    cache: path.join(workDir, '.tmp-reader-guide-cache.json'),
    draft: path.join(workDir, '.tmp-reader-guide-draft.json'),
    plainDraft: path.join(workDir, '.tmp-reader-guide-plain-draft.json')
  };
}

function checkReaderGuideContract(RG, input, guide, snapshot) {
  const check = RG.validateGuide(input, guide);
  const errors = check.errors.slice();
  if (!guide || guide.promptVersion !== RG.PROMPT_VERSION) errors.push('reader-guide promptVersion 不匹配');
  if (!guide || RG.stableJson(guide.modelSnapshot || {}) !== RG.stableJson(snapshot)) errors.push('reader-guide modelSnapshot 不匹配');
  return { ok: errors.length === 0, errors };
}

function buildReaderGuideInputFromWorkDir(workDir, RG, RR, PC) {
  const files = readerGuidePaths(workDir);
  if (!fs.existsSync(files.transition) || !fs.existsSync(files.adjudicatedData) || !fs.existsSync(files.structure) || !fs.existsSync(path.join(workDir, '叙事.md'))) {
    throw new Error('缺少 R8 所需的裁决数据/transition-final/structure/叙事产物');
  }
  const adjudicatedText = fs.readFileSync(files.adjudicatedData, 'utf-8');
  const normalized = RR.normalizePhase1(
    fs.readFileSync(files.transition, 'utf-8'),
    fs.readFileSync(path.join(workDir, '叙事.md'), 'utf-8')
  );
  const structure = PC.parseStructureJson(fs.readFileSync(files.structure, 'utf-8'));
  let adjudication = null;
  if (fs.existsSync(files.adjudication)) {
    try { adjudication = JSON.parse(fs.readFileSync(files.adjudication, 'utf-8')); }
    catch (e) { throw new Error('adjudication.json 解析失败: ' + e.message); }
  }
  return { files, input: RG.buildGuideInput(normalized, structure, adjudication, adjudicatedText) };
}

async function buildPlainReaderGuideArtifact(workDir, cfg, input, guide, onLog, opts) {
  const RG = require('../scripts/reader-guide.js');
  const files = readerGuidePaths(workDir);
  const snapshot = readerGuideModelSnapshot(cfg);
  onLog = typeof onLog === 'function' ? onLog : () => {};
  opts = opts || {};

  if (opts.cache !== false && fs.existsSync(files.plain)) {
    try {
      const saved = JSON.parse(fs.readFileSync(files.plain, 'utf8'));
      const savedCheck = RG.validatePlainGuideReview(input, guide, saved);
      if (savedCheck.ok && RG.stableJson(saved.modelSnapshot || {}) === RG.stableJson(snapshot)) {
        onLog('[executor] R8 白话导览快照命中（原 guide / prompt / model / 复核一致）');
        return { artifact: saved, cached: true };
      }
      onLog('[executor] R8 白话导览快照失效，重新生成：' + savedCheck.errors.join('; '));
    } catch (e) {
      onLog('[executor] R8 白话导览快照不可用，重新生成：' + e.message);
    }
  }

  const units = [];
  for (const card of guide.cards || []) {
    for (const field of ['what', 'why', 'conclusion']) {
      units.push({
        id: 'R8P:' + card.sectionId + ':' + field,
        module: card.sectionId,
        blockType: 'reader-guide-' + field,
        text: card[field]
      });
    }
  }
  const PV2 = require('../scripts/plain-comprehension.js');
  annotatePlainComprehensionRequirements(units, PV2.PROFILE_GUIDE);
  const artifactFromTranslation = translated => ({
    schemaVersion: RG.PLAIN_SCHEMA_VERSION,
    sourceGuideHash: RG.hashPlainGuideSource(guide),
    promptVersion: RG.PLAIN_PROMPT_VERSION,
    modelSnapshot: snapshot,
    cards: (guide.cards || []).map(card => ({
      sectionId: card.sectionId,
      what: translated.get('R8P:' + card.sectionId + ':what'),
      why: translated.get('R8P:' + card.sectionId + ':why'),
      conclusion: translated.get('R8P:' + card.sectionId + ':conclusion')
    }))
  });
  const plainDraftKey = crypto.createHash('sha256')
    .update(RG.hashPlainGuideSource(guide) + '\u0000' + RG.PLAIN_PROMPT_VERSION + '\u0000' + RG.stableJson(snapshot))
    .digest('hex');
  const mapFromPlainDraft = draft => {
    if (!draft || draft.v !== 1 || draft.key !== plainDraftKey || !draft.results || typeof draft.results !== 'object') return null;
    const map = new Map();
    for (const unit of units) {
      if (typeof draft.results[unit.id] !== 'string') return null;
      map.set(unit.id, draft.results[unit.id]);
    }
    return map;
  };
  const writePlainDraft = (results, error) => {
    if (opts.cache === false || !(results instanceof Map)) return;
    const payload = {};
    for (const unit of units) if (typeof results.get(unit.id) === 'string') payload[unit.id] = results.get(unit.id);
    fs.writeFileSync(files.plainDraft, JSON.stringify({ v: 1, key: plainDraftKey, results: payload, error: String(error || '').slice(0, 6000) }, null, 2), 'utf8');
    if (typeof opts.onBatchCheckpoint === 'function') {
      try { opts.onBatchCheckpoint({ phase: 'r8-plain-draft', file: path.basename(files.plainDraft), workDir }); }
      catch (e) { onLog('[executor] R8 白话私有 draft checkpoint 状态回调失败（draft 已安全落盘）: ' + (e && e.message || e)); }
    }
  };

  let translated = null;
  let restoredDraft = null;
  let restoredDraftError = '';
  if (opts.cache !== false && fs.existsSync(files.plainDraft)) {
    try {
      const draft = JSON.parse(fs.readFileSync(files.plainDraft, 'utf8'));
      const restored = mapFromPlainDraft(draft);
      if (restored) {
        const restoredCandidate = artifactFromTranslation(restored);
        const restoredCheck = RG.validatePlainGuide(input, guide, restoredCandidate);
        if (restoredCheck.ok) {
          translated = restored;
          onLog('[executor] R8 白话私有 draft 经结构/事实硬门复核后通过，跳过整批重译');
        } else {
          // 跨 Job 恢复不能退回整批重译：保留当前完整候选作为冻结基底，
          // 下一步只把当前机械门精确点名的字段交给 translateUnitsLLM 定点修复。
          restoredDraft = restored;
          restoredDraftError = 'R8 白话导览机械语义门失败: ' + restoredCheck.errors.join('; ');
          onLog('[executor] R8 白话私有 draft 仍未过门，冻结其余字段并从失败字段定点续跑：' + restoredCheck.errors.join('; '));
        }
      }
    } catch (e) {
      onLog('[executor] R8 白话私有 draft 不可用，重新受控生成：' + e.message);
    }
  }

  if (!translated && cfg && cfg.provider === 'mock') {
    translated = new Map(units.map(unit => [unit.id, unit.text + '（白话）']));
  } else if (!translated) {
    const dict = loadPlainDict(workDir);
    translated = await translateUnitsLLM(cfg, units, onLog, dict, {
      cacheDir: null,
      promptVersion: RG.PLAIN_PROMPT_VERSION,
      comprehensionProfile: PV2.PROFILE_GUIDE,
      requestCompletion: opts.requestCompletion,
      codexRunner: opts.codexRunner,
      postValidate: ({ results }) => {
        const candidate = artifactFromTranslation(results);
        const mechanical = RG.validatePlainGuide(input, guide, candidate);
        if (!mechanical.ok) throw new Error('R8 白话导览结构/事实硬门失败: ' + mechanical.errors.join('; '));
      },
      onFailedCandidate: ({ results, error }) => writePlainDraft(results, error),
      initialResults: restoredDraft,
      initialError: restoredDraftError
    });
  }

  let artifact = artifactFromTranslation(translated);
  let mechanical = RG.validatePlainGuide(input, guide, artifact);
  if (!mechanical.ok) throw new Error('R8 白话导览结构/事实硬门失败: ' + mechanical.errors.join('; '));
  writePlainDraft(translated, 'hard-gates-pass-awaiting-independent-review');

  const requestCompletion = opts.requestCompletion || requestCompletionNode;
  let semanticRepairs = 0;
  while (true) {
    let review;
    if (cfg && cfg.provider === 'mock' && !opts.requestCompletion) {
      review = {
        approved: true,
        cardChecks: RG.SECTION_IDS.map(sectionId => ({
          sectionId,
          semanticEquivalent: true,
          noJudgmentChange: true,
          factsConsistent: true,
          zeroBackgroundReadable: true,
          naturalReadable: true,
          noLocatorDependency: true
        }))
      };
    } else {
      const rawReview = await requestCompletion(cfg, [{ role: 'user', content: RG.buildPlainGuideReviewPrompt(guide, artifact) }], {
        system: READER_GUIDE_PLAIN_REVIEW_SYSTEM,
        codexRunner: opts.codexRunner
      });
      review = RG.parseJson(rawReview, '白话导览独立语义复核响应');
    }
    artifact.review = review;
    const finalCheck = RG.validatePlainGuideReview(input, guide, artifact);
    if (finalCheck.ok) return { artifact, cached: false };

    // 语义 reviewer 不能覆盖结构/事实硬门；若此时硬门红，立即 fail-close。
    mechanical = RG.validatePlainGuide(input, guide, artifact);
    if (!mechanical.ok) throw new Error('R8 白话导览独立复核后结构/事实硬门失败: ' + mechanical.errors.join('; '));
    const failedSections = RG.plainGuideReviewFailedSections(review);
    if (!failedSections.length) throw new Error('R8 白话导览独立语义门失败但没有可定位失败卡: ' + finalCheck.errors.join('; '));
    if (semanticRepairs >= core.MAX_RETRIES) {
      throw new Error('R8 白话导览独立语义修复预算耗尽: ' + finalCheck.errors.join('; '));
    }

    // 先把 reviewer 结果持久化进私有 draft，形成下一笔模型调用前的 durability barrier。
    writePlainDraft(translated, 'semantic-review-failed:' + failedSections.join(','));
    if (typeof opts.onBatchCheckpoint === 'function') {
      await Promise.resolve(opts.onBatchCheckpoint({ phase: 'r8-plain-review', state: 'failed', failedSections: failedSections.slice(), workDir }));
    }

    const expectedIds = failedSections.flatMap(sectionId => ['what', 'why', 'conclusion'].map(field => 'R8P:' + sectionId + ':' + field));
    const repairPrompt = RG.buildPlainGuideRepairPrompt(guide, artifact, review, failedSections);
    core.assertWithinContextLimit(repairPrompt, 'R8 plain semantic targeted repair');
    if (semanticRepairs > 0) {
      const d = core.retryDelayMs(semanticRepairs);
      onLog('[executor] R8 白话语义定点修复 ' + semanticRepairs + '/' + core.MAX_RETRIES + ' · 退避 ' + d + 'ms');
      await sleep(d);
    }
    const rawRepair = await requestCompletion(cfg, [{ role: 'user', content: repairPrompt }], {
      system: '你是 R8 白话导览定点语义修复器。只能改失败卡，保持全部事实/主体/胜负/数字/因果/否定/限定/责任/程度与结论强度。内部编号可以只是 locator，不要强迫逐码解释。只输出严格 units JSON。',
      codexRunner: opts.codexRunner
    });
    const incoming = parseTranslateJson(rawRepair, expectedIds);
    const frozen = new Map(translated);
    for (const id of expectedIds) translated.set(id, incoming.get(id));
    for (const unit of units) {
      if (!expectedIds.includes(unit.id) && translated.get(unit.id) !== frozen.get(unit.id)) {
        throw new Error('R8 白话语义定点修复越界改写冻结字段: ' + unit.id);
      }
    }
    artifact = artifactFromTranslation(translated);
    mechanical = RG.validatePlainGuide(input, guide, artifact);
    if (!mechanical.ok) throw new Error('R8 白话语义定点修复破坏结构/事实硬门: ' + mechanical.errors.join('; '));
    writePlainDraft(translated, 'semantic-repair-draft');
    if (typeof opts.onBatchCheckpoint === 'function') {
      await Promise.resolve(opts.onBatchCheckpoint({ phase: 'r8-plain-repair-draft', state: 'draft', failedSections: failedSections.slice(), workDir }));
    }
    semanticRepairs++;
  }
}

// R8-M1 深 module 的内部读取端：把磁盘快照与当前 R6 权威输入交叉验证，
// 调用方只得到已经证明可机械呈现的 guide，不能绕过 review/cache/input/html 任一证据。
function readVerifiedReaderGuideSnapshot(workDir, inputWorkDir) {
  const RG = require('../scripts/reader-guide.js');
  const RR = require('../render-report.js');
  const PC = require('../pipeline-controller.js');
  const snapshotDir = workDir;
  const sourceDir = inputWorkDir || workDir;
  const files = readerGuidePaths(snapshotDir);
  const errors = [];
  let savedInput, guide, plainGuide, cache, html;
  try { savedInput = JSON.parse(fs.readFileSync(files.input, 'utf8')); }
  catch (e) { errors.push('reader-guide-input.json 不可解析: ' + e.message); }
  try { guide = JSON.parse(fs.readFileSync(files.guide, 'utf8')); }
  catch (e) { errors.push('reader-guide.json 不可解析: ' + e.message); }
  try { plainGuide = JSON.parse(fs.readFileSync(files.plain, 'utf8')); }
  catch (e) { errors.push('reader-guide-plain.json 不可解析: ' + e.message); }
  try { cache = JSON.parse(fs.readFileSync(files.cache, 'utf8')); }
  catch (e) { errors.push('.tmp-reader-guide-cache.json 不可解析: ' + e.message); }
  try { html = fs.readFileSync(files.html, 'utf8'); }
  catch (e) { errors.push('reader-guide.html 不可读取: ' + e.message); }
  let rebuilt;
  try { rebuilt = buildReaderGuideInputFromWorkDir(sourceDir, RG, RR, PC).input; }
  catch (e) { errors.push(e.message); }
  if (savedInput && rebuilt && RG.stableJson(savedInput) !== RG.stableJson(rebuilt)) errors.push('保存的 reader-guide-input 与当前 R6 权威输入不一致');
  const input = rebuilt || savedInput;
  const modelSnapshot = guide && guide.modelSnapshot;
  if (input && guide) {
    const guideCheck = checkReaderGuideContract(RG, input, guide, modelSnapshot);
    errors.push(...guideCheck.errors);
  }
  const inputHash = input && RG.hashGuideInput(input);
  if (!cache || cache.inputHash !== inputHash) errors.push('R8 cache inputHash 不匹配');
  if (!cache || cache.key !== RG.cacheKey(input, modelSnapshot || {})) errors.push('R8 cache key 不匹配');
  if (!cache || RG.stableJson(cache.guide || {}) !== RG.stableJson(guide || {})) errors.push('R8 cache guide 与保存 guide 不一致');
  if (input && guide) {
    const reviewCheck = RG.validateReview(input, guide, cache && cache.review);
    errors.push(...reviewCheck.errors);
    if (plainGuide) {
      const plainCheck = RG.validatePlainGuideReview(input, guide, plainGuide);
      errors.push(...plainCheck.errors);
    }
  }
  if (guide && html !== RR.renderReaderGuide(guide)) errors.push('reader-guide.html 与已验证 guide 的纯渲染结果不一致');
  if (errors.length) throw new Error('[executor] R8 主报告嵌入快照验证失败: ' + errors.join('; '));
  return { input, guide, plainGuide, review: cache.review, inputHash, cacheKey: cache.key };
}

// R8-M1 public seam：只读四件已验证 R8 快照，纯机械写入原文主报告；
// interface 故意没有 cfg/provider/model/requestCompletion/codexRunner，不能触及模型路径。
function embedVerifiedReaderGuide(workDir) {
  const RR = require('../render-report.js');
  const snapshot = readVerifiedReaderGuideSnapshot(workDir);
  const reportPath = path.join(workDir, 'report.html');
  if (!fs.existsSync(reportPath)) throw new Error('[executor] R8 主报告嵌入缺少 report.html');
  const reportHtml = fs.readFileSync(reportPath, 'utf8');
  const migratedRuntime = RR.migratePlainToggleRuntime(reportHtml);
  const embedded = RR.embedReaderGuideIntoReport(migratedRuntime, snapshot.guide, snapshot.plainGuide);
  fs.writeFileSync(reportPath, embedded, 'utf8');
  return { inputHash: snapshot.inputHash, cacheKey: snapshot.cacheKey, reportPath };
}

// R8 adapter public seam：仅以 workDir 已存在的 R4/R4.5/R6 结构化产物为输入，
// 经生成+独立复核后，才落 reader-guide-input/json/html 三个独立文件。
async function applyReaderGuide(workDir, cfg, onLog, opts) {
  const RG = require('../scripts/reader-guide.js');
  const RR = require('../render-report.js');
  const PC = require('../pipeline-controller.js');
  opts = opts || {};
  onLog = typeof onLog === 'function' ? onLog : () => {};
  const immutableBefore = fingerprintOptionalFiles(workDir, r8ImmutableNames(workDir));
  try {
    const prepared = buildReaderGuideInputFromWorkDir(workDir, RG, RR, PC);
    const files = prepared.files;
    const input = prepared.input;
    const snapshot = readerGuideModelSnapshot(cfg);
    const inputHash = RG.hashGuideInput(input);
    const key = RG.cacheKey(input, snapshot);
    let guide = null;
    let review = null;
    let cached = false;

    if (opts.cache !== false && fs.existsSync(files.cache)) {
      try {
        const saved = JSON.parse(fs.readFileSync(files.cache, 'utf-8'));
        if (saved && saved.key === key && saved.inputHash === inputHash) {
          const guideCheck = checkReaderGuideContract(RG, input, saved.guide, snapshot);
          const reviewCheck = RG.validateReview(input, saved.guide, saved.review);
          if (guideCheck.ok && reviewCheck.ok) {
            guide = saved.guide;
            review = saved.review;
            cached = true;
            onLog('[executor] R8 章节导览缓存命中（输入/提示/模型/契约一致）');
          } else {
            onLog('[executor] R8 章节导览缓存失效，重新生成：' + guideCheck.errors.concat(reviewCheck.errors).join('; '));
          }
        }
      } catch (e) {
        onLog('[executor] R8 章节导览缓存不可用，重新生成：' + e.message);
      }
    }

    let guideCheck = guide ? checkReaderGuideContract(RG, input, guide, snapshot) : null;

    // 私有 draft 只保存原导览候选，不代表 R8 完成。进程中断或机械门失败后可从候选继续定点修复，避免整卡重生。
    if (!guide && opts.cache !== false && fs.existsSync(files.draft)) {
      try {
        const savedDraft = JSON.parse(fs.readFileSync(files.draft, 'utf-8'));
        if (savedDraft && savedDraft.v === 1 && savedDraft.key === key && savedDraft.inputHash === inputHash && savedDraft.guide) {
          guide = savedDraft.guide;
          guideCheck = checkReaderGuideContract(RG, input, guide, snapshot);
          onLog('[executor] R8 检测到私有导览 draft，继续' + (guideCheck.ok ? '独立复核' : '定点修复') + '，不重生已保存候选');
        }
      } catch (e) {
        onLog('[executor] R8 私有导览 draft 不可用，回到受控生成：' + e.message);
      }
    }

    const requestCompletion = opts.requestCompletion || requestCompletionNode;
    if (!guide || !guideCheck || !guideCheck.ok) {
      let lastGuideError = null;
      for (let attempt = 0; attempt <= core.MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          const d = core.retryDelayMs(attempt);
          onLog('[executor] R8 原导览机械门纠错 ' + attempt + '/' + core.MAX_RETRIES + ' · 退避 ' + d + 'ms');
          await sleep(d);
        }
        try {
          const repairIds = guide && guideCheck && !guideCheck.ok ? RG.guideRepairSectionIds(guideCheck.errors, guide) : [];
          if (guide && repairIds.length) {
            const rawRepair = await requestCompletion(cfg, [{ role: 'user', content: RG.buildGuideRepairPrompt(input, guide, guideCheck.errors, repairIds) }], {
              system: READER_GUIDE_SYSTEM,
              codexRunner: opts.codexRunner
            });
            const parsedRepair = RG.parseJson(rawRepair, '导览定点修复响应');
            const repairCards = parsedRepair && Array.isArray(parsedRepair.cards) ? parsedRepair.cards : [];
            const repairCardIds = repairCards.map(card => card && card.sectionId);
            if (repairCardIds.length !== repairIds.length || new Set(repairCardIds).size !== repairIds.length || repairIds.some(id => !repairCardIds.includes(id))) {
              throw new Error('定点修复响应章节集合必须恰为: ' + repairIds.join(','));
            }
            const nextGuide = JSON.parse(JSON.stringify(guide));
            const byId = new Map(repairCards.map(card => [card.sectionId, card]));
            const frozenBefore = new Map((guide.cards || []).filter(card => !repairIds.includes(card.sectionId)).map(card => [card.sectionId, RG.stableJson(card)]));
            for (let i = 0; i < nextGuide.cards.length; i++) {
              const replacement = byId.get(nextGuide.cards[i].sectionId);
              if (replacement) nextGuide.cards[i] = replacement;
            }
            for (const card of nextGuide.cards || []) {
              if (!repairIds.includes(card.sectionId) && frozenBefore.get(card.sectionId) !== RG.stableJson(card)) {
                throw new Error('定点修复越界修改未点名章节: ' + card.sectionId);
              }
            }
            guide = nextGuide;
          } else {
            let prompt = RG.buildGuidePrompt(input, snapshot);
            if (guideCheck && guideCheck.errors && guideCheck.errors.length) {
              prompt += '\n\n上一版候选未通过机械门；本次必须纠正以下错误，所有原门禁继续生效：\n- ' + guideCheck.errors.join('\n- ');
            }
            const rawGuide = await requestCompletion(cfg, [{ role: 'user', content: prompt }], {
              system: READER_GUIDE_SYSTEM,
              codexRunner: opts.codexRunner
            });
            guide = RG.parseJson(rawGuide, '导览生成响应');
          }
          guideCheck = checkReaderGuideContract(RG, input, guide, snapshot);
          if (opts.cache !== false) {
            fs.writeFileSync(files.draft, JSON.stringify({ v: 1, key, inputHash, guide, errors: guideCheck.errors || [] }, null, 2), 'utf-8');
            if (typeof opts.onBatchCheckpoint === 'function') {
              try { opts.onBatchCheckpoint({ phase: 'r8-guide-draft', file: path.basename(files.draft), workDir }); }
              catch (e) { onLog('[executor] R8 原导览私有 draft checkpoint 状态回调失败（draft 已安全落盘）: ' + (e && e.message || e)); }
            }
          }
          if (guideCheck.ok) { lastGuideError = null; break; }
          lastGuideError = new Error('生成门禁失败: ' + guideCheck.errors.join('; '));
        } catch (e) {
          lastGuideError = e;
        }
        if (attempt === core.MAX_RETRIES) break;
      }
      if (!guideCheck || !guideCheck.ok) {
        throw new Error('生成门禁纠错预算耗尽: ' + (lastGuideError && lastGuideError.message ? lastGuideError.message : '未知错误'));
      }
    }

    if (!review) {
      let reviewCheck = null;
      let lastReviewError = null;
      for (let attempt = 0; attempt <= core.MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          const d = core.retryDelayMs(attempt);
          onLog('[executor] R8 独立复核纠错 ' + attempt + '/' + core.MAX_RETRIES + ' · 退避 ' + d + 'ms');
          await sleep(d);
        }
        try {
          let reviewPrompt = RG.buildReviewPrompt(input, guide);
          if (reviewCheck && reviewCheck.errors && reviewCheck.errors.length) {
            reviewPrompt += '\n\n上一版复核未通过机械门；请重新逐卡核查并纠正以下复核错误：\n- ' + reviewCheck.errors.join('\n- ');
          }
          const rawReview = await requestCompletion(cfg, [{ role: 'user', content: reviewPrompt }], {
            system: READER_GUIDE_SYSTEM,
            codexRunner: opts.codexRunner
          });
          review = RG.parseJson(rawReview, '独立复核响应');
          reviewCheck = RG.validateReview(input, guide, review);
          if (reviewCheck.ok) { lastReviewError = null; break; }
          lastReviewError = new Error('独立复核门禁失败: ' + reviewCheck.errors.join('; '));
        } catch (e) {
          lastReviewError = e;
        }
        if (attempt === core.MAX_RETRIES) break;
      }
      if (!reviewCheck || !reviewCheck.ok) {
        throw new Error('独立复核纠错预算耗尽: ' + (lastReviewError && lastReviewError.message ? lastReviewError.message : '未知错误'));
      }
    }

    // 原导览 + 独立复核一旦通过，先保存私有 checkpoint；若后续白话失败，重跑可复用前两次已验证 LLM 结果。
    // 这里只写 .tmp cache，不写任何公共 reader-guide 产物，也不改 report.html，因此不把半完成 R8 冒充完成态。
    if (!cached) {
      fs.writeFileSync(files.cache, JSON.stringify({ key, inputHash, guide, review }, null, 2), 'utf-8');
      if (fs.existsSync(files.draft)) fs.rmSync(files.draft, { force: true });
      if (typeof opts.onBatchCheckpoint === 'function') {
        try { opts.onBatchCheckpoint({ phase: 'r8-core-cache', file: path.basename(files.cache), workDir }); }
        catch (e) { onLog('[executor] R8 原导览复核 cache checkpoint 状态回调失败（cache 已安全落盘）: ' + (e && e.message || e)); }
      }
    }

    const plainBuilt = await buildPlainReaderGuideArtifact(workDir, cfg, input, guide, onLog, opts);
    const plainGuide = plainBuilt.artifact;
    const html = RR.renderReaderGuide(guide);
    // 公共产物与主报告仍须等原导览、独立复核、白话导览、白话独立复核全部通过后才提交。
    fs.writeFileSync(files.input, JSON.stringify(input, null, 2), 'utf-8');
    fs.writeFileSync(files.guide, JSON.stringify(guide, null, 2), 'utf-8');
    fs.writeFileSync(files.plain, JSON.stringify(plainGuide, null, 2), 'utf-8');
    fs.writeFileSync(files.html, html, 'utf-8');
    const embedded = embedVerifiedReaderGuide(workDir);
    if (fs.existsSync(files.plainDraft)) fs.rmSync(files.plainDraft, { force: true });
    assertSameFingerprints('R8 不得改写 R1—R7 权威输入/裁决/白话正文', immutableBefore, fingerprintOptionalFiles(workDir, r8ImmutableNames(workDir)));
    onLog('[executor] R8 章节导览完成：reader-guide-input.json + reader-guide.json + reader-guide-plain.json + reader-guide.html + report.html 机械嵌入' + (cached ? '（原导览缓存）' : '') + (plainBuilt.cached ? '（白话缓存）' : ''));
    return { cached, plainCached: plainBuilt.cached, inputHash, cacheKey: key, files: [files.input, files.guide, files.plain, files.html, embedded.reportPath] };
  } catch (e) {
    try {
      assertSameFingerprints('R8 失败态不得改写 R1—R7 权威输入/裁决/白话正文', immutableBefore, fingerprintOptionalFiles(workDir, r8ImmutableNames(workDir)));
    } catch (immutabilityError) {
      throw new Error('[executor] R8 章节导览失败且检测到上游权威产物漂移: ' + (immutabilityError && immutabilityError.message ? immutabilityError.message : String(immutabilityError)) + '；原错误=' + (e && e.message ? e.message : String(e)));
    }
    throw new Error('[executor] R8 章节导览失败: ' + (e && e.message ? e.message : String(e)));
  }
}

// ---------- R7 阶段 2：白话化（LLM 翻译 + 双版本合并 + 外部门禁） ----------

const TRANSLATE_SYSTEM = '你是辩论裁判报告的 PLAIN 语义白话生成器。你的职责是生成候选 draft，不负责给自己判定“已经足够易懂”。硬性规则：1. 不新增、不删除、不改变任何主体、判断、结论、事实、数据、因果、否定、条件、责任、程度与逻辑；2. 数字、比分、轮次编号、判决结论、枚举与 ID（N#、M-ID、CP-ID、S# 等）、辩手名、辩题名、专名、章节标题、证据回引和标记类内容必须原样、原次数保留；3. 术语表只是认知提示，可以用自然等价解释，不得机械强塞“术语（固定释义）”；4. 内部编号可以只是 locator，若邻接上下文已经把事件/判断说清，不要求逐个解释编号，更不得为解释编号重复该编号；5. 每个 DOM 文本单元仍独立回填，但阅读语义会由后续独立 reviewer 在完整有序上下文中判断；6. 输出必须是合法 JSON：{"units":[{"id":"...","text":"改写后文本"}]}，覆盖全部输入 id，禁止额外文字。';
const TRANSLATE_GUIDE_SYSTEM = '你是辩论裁判报告的 PLAIN 零背景章节导览生成器。保持原导览主体、胜负、事实、数字、因果方向、否定、条件、责任、程度和结论强度不变。术语表只是认知提示，可自然解释，不要求固定括号模板。原导览已有 N/M/CP/B0/Q/Phase/Lv/路径号等定位码必须原样、原次数保留，但 locator 本身不是读者必须学习的知识：同卡上下文已经把事件和判断说清时，不要求逐个解释。输出只负责候选 draft，最终 semanticEquivalent/zeroBackgroundReadable/naturalReadable/noLocatorDependency 由独立 reviewer 判断。只输出覆盖全部输入 id 的合法 JSON。';

// R7 阶段 3：核心字典（内嵌 PLAIN_DICT）＋可选外部扩展字典（--plain-dict，覆盖核心）
function loadPlainDict(workDir, extraPath) {
  // 核心词典随执行器交付，而 workDir 是每场输出目录；不得把二者混为一谈。
  const corePath = path.join(__dirname, '..', 'assets', 'plain-dict.json');
  let dict = {};
  if (fs.existsSync(corePath)) {
    try {
      dict = JSON.parse(fs.readFileSync(corePath, 'utf8'));
    } catch (e) {
      throw new Error('[executor] plain-dict.json 解析失败: ' + e.message);
    }
  }
  if (extraPath) {
    if (!fs.existsSync(extraPath)) throw new Error('[executor] --plain-dict 文件不存在: ' + extraPath);
    // 批 4（260812）：外部扩展字典损坏 → 明确报错（含文件路径；用户配置错误不静默、不遮蔽）
    const extRaw = fs.readFileSync(extraPath, 'utf8');
    let ext;
    try { ext = JSON.parse(extRaw); }
    catch (e) { throw new Error('[executor] 外部白话字典 ' + extraPath + ' 解析失败: ' + e.message + '（检查 --plain-dict 文件格式）'); }
    dict = Object.assign({}, dict, ext);
  }
  return dict;
}

// 翻译响应 → Map<id,text>：容错代码围栏/前后杂文本，校验 id 全覆盖
function parseTranslateJson(raw, ids) {
  let s = String(raw || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  const j = JSON.parse(s);
  const arr = Array.isArray(j) ? j : (j.units || j.results || []);
  if (!Array.isArray(arr)) throw new Error('翻译响应无 units 数组');
  const m = new Map();
  for (const it of arr) {
    if (it && it.id && typeof it.text === 'string') m.set(String(it.id), it.text);
  }
  const missing = ids.filter(id => !m.has(id));
  if (missing.length) throw new Error('翻译响应缺失 ' + missing.length + ' 个单元（' + missing.slice(0, 5).join(',') + '）');
  return m;
}

// S5：白话批断点缓存（审计 #9）——缓存格式版本常量；批次内容/首次术语要求/字典任一变化即失效
const PLAIN_CACHE_VERSION = 4;
const PLAIN_CACHE_PREFIX = '.tmp-plain-batch-';
const PLAIN_PROMPT_VERSION = 'r7-plain-v4';
const PLAIN_REVIEW_FILE = '.tmp-plain-review.json';
// A4 是冻结的旧无模型刷新合同，永远只认历史 v3/r7-plain-v2，不参与 live 语义权威。
const LEGACY_PLAIN_CACHE_VERSION = 3;
const LEGACY_PLAIN_PROMPT_VERSION = 'r7-plain-v2';
const PLAIN_REFRESH_TRANSACTION = '.tmp-plain-refresh-transaction.json';
const PLAIN_REFRESH_BATCHES = 14;
const PLAIN_REFRESH_OUTPUTS = ['report.html', 'report-plain.html'].concat(
  Array.from({ length: PLAIN_REFRESH_BATCHES }, (_, i) => PLAIN_CACHE_PREFIX + i + '.json')
);
const PLAIN_REFRESH_R6_INPUTS = [
  '.tmp-adjudicated-data.md', '.tmp-adjudicated-structure.json', 'transition-final.md',
  'structure.json', '叙事.md', 'adjudication.json', 'source-anchor.json'
];
const PLAIN_REFRESH_R8_OUTPUTS = ['reader-guide-input.json', 'reader-guide.json', 'reader-guide-plain.json', 'reader-guide.html', '.tmp-reader-guide-cache.json'];

function chunkHashOf(chunk) {
  return crypto.createHash('sha256')
    // PLAIN-V2：旧 glossary 义务与新 comprehension 义务都属于缓存键；任一改变必须失效。
    .update(chunk.map(it => it.id + '\u0000' + it.text + '\u0000' +
      (it.requiredGlosses || []).map(r => r.term + '\u0000' + r.gloss).join('\u0001') + '\u0000' +
      JSON.stringify(it.comprehensionRequirements || [])).join('\u0002'))
    .digest('hex').slice(0, 16);
}

function dictHashOf(dict) {
  const keys = Object.keys(dict || {}).sort();
  const body = keys.map(k => k + '\u0000' + dict[k]).join('\u0001');
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
}

function annotatePlainComprehensionRequirements(units, profile) {
  const PV2 = require('../scripts/plain-comprehension.js');
  const rows = PV2.requirementsForUnits(units || [], { profile: profile || PV2.PROFILE_BODY });
  const byId = new Map(rows.map(row => [row.unitId, row.requirements || []]));
  for (const u of units || []) u.comprehensionRequirements = byId.get(u.id) || [];
  return rows;
}

function plainComprehensionTerms(item) {
  const out = [];
  for (const req of item && item.comprehensionRequirements || []) {
    if (req && req.term) out.push(req.term);
  }
  return out;
}

function checkPlainComprehensionItems(items, textForItem, profile) {
  const PV2 = require('../scripts/plain-comprehension.js');
  const issues = [];
  for (const item of items || []) {
    const result = PV2.inspectPlainText(item.text, textForItem(item.id), {
      profile: profile || PV2.PROFILE_BODY,
      requiredConcepts: plainComprehensionTerms(item)
    });
    if (!result.ok) issues.push({ id: item.id, issues: result.issues });
  }
  return { ok: issues.length === 0, issues };
}

function plainCacheItems(units) {
  return (units || []).map(u => ({
    id: u.id,
    context: (u.module ? u.module + ' · ' : '') + (u.blockType || 'block'),
    text: u.text,
    requiredGlosses: Array.isArray(u.requiredGlosses) ? u.requiredGlosses : [],
    comprehensionRequirements: Array.isArray(u.comprehensionRequirements) ? u.comprehensionRequirements : []
  }));
}

function splitPlainCacheChunks(units) {
  const items = plainCacheItems(units);
  const chunks = [];
  let cur = [];
  let curChars = 0;
  for (const item of items) {
    if (cur.length >= 40 || (curChars + item.text.length > 6000 && cur.length)) {
      chunks.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(item);
    curChars += item.text.length;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// A4-P1a：从一份报告重建 R7 输入，必须与 processReportAsync 的词典/首现语义同口径。
function plainCacheInputsFromHtml(html, dict) {
  const PL = require('../scripts/plain-language.js');
  const all = PL.extractUnits(PL.parseHtml(html));
  const translatable = all.filter(u => PL.classifyUnit(u) === 'translate');
  for (const unit of translatable) unit.dictHints = PL.dictHintsForText(unit.text, dict);
  PL.annotateSemanticRequirements(translatable, dict);
  annotatePlainComprehensionRequirements(translatable, require('../scripts/plain-comprehension.js').PROFILE_BODY);
  return { all, translatable, chunks: splitPlainCacheChunks(translatable) };
}

function assertEqualPlainSignatures(label, actual, expected) {
  if (actual.length !== expected.length) {
    throw new Error('[executor] A4-P1a ' + label + ' 数量不一致: ' + actual.length + ' ≠ ' + expected.length);
  }
  for (let i = 0; i < actual.length; i++) {
    if (JSON.stringify(actual[i]) !== JSON.stringify(expected[i])) {
      throw new Error('[executor] A4-P1a ' + label + ' 第 ' + i + ' 项不一致');
    }
  }
}

function nonUiUnitSignatures(html) {
  const PL = require('../scripts/plain-language.js');
  return PL.extractUnits(PL.parseHtml(html)).filter(u => !PL.isReportUiUnit(u)).map(u => ({
    text: u.text,
    module: u.module,
    blockType: u.blockType,
    classifyUnit: PL.classifyUnit(u)
  }));
}

function plainItemSignatures(chunks) {
  return (chunks || []).flat().map(item => ({
    text: item.text,
    context: item.context,
    // unitId 只用于定位；跨 UI 偏移的语义签名比较受控释义与 PLAIN-V2 认知义务。
    requiredGlosses: (item.requiredGlosses || []).map(req => ({ term: req.term, gloss: req.gloss })),
    comprehensionRequirements: item.comprehensionRequirements || []
  }));
}

function plainCachePath(workDir, index) {
  return path.join(workDir, PLAIN_CACHE_PREFIX + index + '.json');
}

function assertExactPlainCacheSet(workDir) {
  const names = fs.readdirSync(workDir).filter(name => /^\.tmp-plain-batch-\d+\.json$/.test(name));
  const wanted = new Set(Array.from({ length: PLAIN_REFRESH_BATCHES }, (_, i) => PLAIN_CACHE_PREFIX + i + '.json'));
  const extras = names.filter(name => !wanted.has(name));
  const missing = [...wanted].filter(name => !names.includes(name));
  if (extras.length || missing.length) {
    throw new Error('[executor] A4-P1a 缓存批次必须恰为 0—' + (PLAIN_REFRESH_BATCHES - 1) +
      '；缺失=' + missing.join(',') + '；额外=' + extras.join(','));
  }
}

function readVerifiedPlainCache(workDir, index, chunk, dict) {
  const PL = require('../scripts/plain-language.js');
  const cachePath = plainCachePath(workDir, index);
  let cache;
  try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); }
  catch (e) { throw new Error('[executor] A4-P1a 缓存 ' + index + ' 不可解析: ' + e.message); }
  if (!cache || cache.v !== LEGACY_PLAIN_CACHE_VERSION || cache.promptVersion !== LEGACY_PLAIN_PROMPT_VERSION ||
    cache.chunkHash !== chunkHashOf(chunk) || cache.dictHash !== dictHashOf(dict) ||
    !cache.results || typeof cache.results !== 'object') {
    throw new Error('[executor] A4-P1a 缓存 ' + index + ' 元数据或键不匹配');
  }
  const missing = chunk.filter(item => typeof cache.results[item.id] !== 'string');
  if (missing.length) throw new Error('[executor] A4-P1a 缓存 ' + index + ' 缺少结果: ' + missing.slice(0, 5).map(x => x.id).join(','));
  const semantic = PL.checkRequiredGlosses(chunk, id => cache.results[id]);
  if (!semantic.ok) throw new Error('[executor] A4-P1a 缓存 ' + index + ' 首现术语解释缺失: ' + semantic.missing.map(x => x.term + '@' + x.unitId).join(','));
  const comprehension = checkPlainComprehensionItems(chunk, id => cache.results[id], require('../scripts/plain-comprehension.js').PROFILE_BODY);
  if (!comprehension.ok) throw new Error('[executor] A4-P1a 缓存 ' + index + ' PLAIN-V2 可理解性门失败: ' + JSON.stringify(comprehension.issues.slice(0, 5)));
  return cache;
}

function writePlainCache(workDir, index, chunk, dict, results) {
  fs.writeFileSync(plainCachePath(workDir, index), JSON.stringify({
    v: LEGACY_PLAIN_CACHE_VERSION,
    promptVersion: LEGACY_PLAIN_PROMPT_VERSION,
    chunkHash: chunkHashOf(chunk),
    dictHash: dictHashOf(dict),
    results
  }), 'utf8');
}

function fingerprintFiles(workDir, names) {
  const fingerprints = {};
  for (const name of names) {
    const file = path.join(workDir, name);
    if (!fs.existsSync(file)) throw new Error('[executor] A4-P1a 缺少固定产物: ' + name);
    fingerprints[name] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  return fingerprints;
}

function assertSameFingerprints(label, before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('[executor] A4-P1a ' + label + ' 指纹漂移');
}

function assertRefreshControls(dualHtml, plainHtml) {
  if (!dualHtml.includes('id="plainBtn"') || !dualHtml.includes('aria-keyshortcuts="Alt+T"') ||
    !dualHtml.includes('plain-toggle-host') || dualHtml.includes('Alt+P')) {
    throw new Error('[executor] A4-P1a 正式双版本 A1 Alt+T 控件契约失败');
  }
  if (/id="plainBtn"|Alt\+P|Alt\+T/.test(plainHtml)) {
    throw new Error('[executor] A4-P1a 纯白话版不得含原文/白话切换控件');
  }
}

function refreshTransactionPath(workDir) {
  return path.join(workDir, PLAIN_REFRESH_TRANSACTION);
}

function validateRefreshTransaction(workDir, tx) {
  if (!tx || tx.v !== 1 || !['prepared', 'committing', 'recovered', 'committed'].includes(tx.state) ||
    typeof tx.backupDir !== 'string' || !Array.isArray(tx.files) || !tx.files.length ||
    tx.files.some(name => !PLAIN_REFRESH_OUTPUTS.includes(name))) {
    throw new Error('[executor] A4-P1a 事务日志格式或目标不合法');
  }
  const backupDir = path.resolve(tx.backupDir);
  if (!fs.existsSync(backupDir)) throw new Error('[executor] A4-P1a 事务备份不存在: ' + backupDir);
  for (const name of tx.files) {
    if (!fs.existsSync(path.join(backupDir, name))) throw new Error('[executor] A4-P1a 事务备份缺少: ' + name);
  }
  return backupDir;
}

function recoverPlainRefreshTransaction(workDir, onLog) {
  const journal = refreshTransactionPath(workDir);
  if (!fs.existsSync(journal)) return false;
  let tx;
  try { tx = JSON.parse(fs.readFileSync(journal, 'utf8')); }
  catch (e) { throw new Error('[executor] A4-P1a 事务日志不可解析: ' + e.message); }
  // committed/recovered 都是完整状态点：即使进程恰在删备份后中断，也只需清日志，
  // 绝不能因不再需要的备份缺失把成功提交或完成回滚误判为无法恢复。
  if (tx && tx.v === 1 && ['committed', 'recovered'].includes(tx.state) && typeof tx.backupDir === 'string' &&
    Array.isArray(tx.files) && tx.files.length && tx.files.every(name => PLAIN_REFRESH_OUTPUTS.includes(name))) {
    onLog('[executor] A4-P1a 检测到已完成事务残留，清理日志');
    if (tx.ownedBackup === true && fs.existsSync(tx.backupDir)) fs.rmSync(tx.backupDir, { recursive: true, force: true });
    fs.unlinkSync(journal);
    return true;
  }
  const backupDir = validateRefreshTransaction(workDir, tx);
  if (tx.state !== 'committed') {
    for (const name of tx.files) fs.copyFileSync(path.join(backupDir, name), path.join(workDir, name));
    onLog('[executor] A4-P1a 检测到未完成事务，已由精确备份恢复 ' + tx.files.length + ' 项');
  }
  writeRefreshTransaction(workDir, tx, 'recovered');
  if (tx.ownedBackup === true) fs.rmSync(backupDir, { recursive: true, force: true });
  fs.unlinkSync(journal);
  return true;
}

function makeRefreshTransaction(workDir, files) {
  const backupDir = fs.mkdtempSync(path.join(workDir, '.tmp-plain-refresh-recovery-'));
  for (const name of files) fs.copyFileSync(path.join(workDir, name), path.join(backupDir, name));
  const tx = { v: 1, state: 'prepared', backupDir, files, ownedBackup: true };
  fs.writeFileSync(refreshTransactionPath(workDir), JSON.stringify(tx), 'utf8');
  return tx;
}

function writeRefreshTransaction(workDir, tx, state) {
  tx.state = state;
  fs.writeFileSync(refreshTransactionPath(workDir), JSON.stringify(tx), 'utf8');
}

function finishRefreshTransaction(workDir, tx) {
  writeRefreshTransaction(workDir, tx, 'committed');
  // committed 残留可接受备份已删；但在清理失败时必须保留 journal 供下次重试，
  // 不能吞掉失败后遗失唯一定位信息。
  fs.rmSync(tx.backupDir, { recursive: true, force: true });
  fs.unlinkSync(refreshTransactionPath(workDir));
}

function copyRefreshInputs(workDir, stageDir) {
  for (const name of PLAIN_REFRESH_R6_INPUTS) {
    const source = path.join(workDir, name);
    if (!fs.existsSync(source)) throw new Error('[executor] A4-P1a 缺少 R6 权威输入: ' + name);
    fs.copyFileSync(source, path.join(stageDir, name));
  }
}

// A4-P1a public seam：只在严格证明“旧缓存输入与现役 R6 基底仅 UI 不同”后，
// 才迁移 v2 缓存并重跑既有 R7 门禁。接口没有 provider/model/requestCompletion，
// 任何意外抵达模型路径都会被内部保险丝记录后硬阻断。
async function refreshPlainArtifacts(workDir, opts) {
  opts = opts || {};
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const onModelRequest = typeof opts.onModelRequest === 'function' ? opts.onModelRequest : () => {};
  const recovered = recoverPlainRefreshTransaction(workDir, onLog);
  const reportPath = path.join(workDir, 'report.html');
  if (!fs.existsSync(reportPath)) throw new Error('[executor] A4-P1a 缺少旧 report.html');
  const r8Before = fingerprintFiles(workDir, PLAIN_REFRESH_R8_OUTPUTS);
  const dict = loadPlainDict(workDir);
  const RR = require('../render-report.js');
  const legacyHtml = fs.readFileSync(reportPath, 'utf8');
  // R8-M1：旧生产报告可能已经嵌入导览；R7 缓存与语义等价只针对无导览基底。
  // 严格成对/唯一剥离由 renderer seam 负责，异常标记直接阻断，不做模糊 DOM 容错。
  const legacyBase = RR.stripEmbeddedReaderGuide(legacyHtml).html;
  const legacy = plainCacheInputsFromHtml(legacyBase, dict);
  assertExactPlainCacheSet(workDir);
  if (legacy.chunks.length !== PLAIN_REFRESH_BATCHES) {
    throw new Error('[executor] A4-P1a 旧报告应为 ' + PLAIN_REFRESH_BATCHES + ' 批，实际 ' + legacy.chunks.length + ' 批');
  }
  const legacyCaches = legacy.chunks.map((chunk, index) => readVerifiedPlainCache(workDir, index, chunk, dict));
  const stageDir = fs.mkdtempSync(path.join(path.dirname(path.resolve(workDir)), '.tmp-plain-refresh-stage-'));
  try {
    copyRefreshInputs(workDir, stageDir);
    renderReport(stageDir);
    const freshBase = fs.readFileSync(path.join(stageDir, 'report.html'), 'utf8');
    assertEqualPlainSignatures('非 UI 单元', nonUiUnitSignatures(legacyBase), nonUiUnitSignatures(freshBase));
    const fresh = plainCacheInputsFromHtml(freshBase, dict);
    if (fresh.chunks.length !== PLAIN_REFRESH_BATCHES) {
      throw new Error('[executor] A4-P1a 新 R6 基底应为 ' + PLAIN_REFRESH_BATCHES + ' 批，实际 ' + fresh.chunks.length + ' 批');
    }
    assertEqualPlainSignatures('可译单元 text/context/requiredGlosses', plainItemSignatures(legacy.chunks), plainItemSignatures(fresh.chunks));
    for (let index = 0; index < PLAIN_REFRESH_BATCHES; index++) {
      const oldChunk = legacy.chunks[index];
      const newChunk = fresh.chunks[index];
      if (oldChunk.length !== newChunk.length) throw new Error('[executor] A4-P1a 第 ' + index + ' 批单元数量不一致');
      const results = {};
      for (let i = 0; i < oldChunk.length; i++) results[newChunk[i].id] = legacyCaches[index].results[oldChunk[i].id];
      const semantic = require('../scripts/plain-language.js').checkRequiredGlosses(newChunk, id => results[id]);
      if (!semantic.ok) throw new Error('[executor] A4-P1a 第 ' + index + ' 批重键后首次术语解释缺失');
      writePlainCache(stageDir, index, newChunk, dict, results);
    }
    let modelCalls = 0;
    const modelFuse = async () => {
      modelCalls++;
      try { onModelRequest(); } finally { throw new Error('[executor] A4-P1a cache-only 保险丝：禁止模型请求'); }
    };
    await applyPlain(stageDir, { provider: 'cache-only' }, onLog, null, { cache: true, legacyV3: true, requestCompletion: modelFuse });
    if (modelCalls) throw new Error('[executor] A4-P1a cache-only 保险丝被触发');
    const stageReport = fs.readFileSync(path.join(stageDir, 'report.html'), 'utf8');
    const stagePlain = fs.readFileSync(path.join(stageDir, 'report-plain.html'), 'utf8');
    const PL = require('../scripts/plain-language.js');
    const PC = require('../pipeline-controller.js');
    const compare = PL.compareVersions(freshBase, stagePlain);
    if (!compare.ok) throw new Error('[executor] A4-P1a 暂存双版本比较失败');
    const semantic = PL.checkSemanticPlain(freshBase, stagePlain, dict);
    if (!semantic.ok) throw new Error('[executor] A4-P1a 暂存语义门禁失败');
    const dataSource = fs.existsSync(path.join(stageDir, '.tmp-adjudicated-data.md')) ? path.join(stageDir, '.tmp-adjudicated-data.md') : path.join(stageDir, 'transition-final.md');
    const data = PC.extractDataMarkers(fs.readFileSync(dataSource, 'utf8'));
    for (const file of ['report.html', 'report-plain.html']) {
      const check = PC.checkHtml(path.join(stageDir, file), { stage: 'final', skillPath: resolveSkillPath(), dataSource });
      if (check.blocking && check.blocking.length) throw new Error('[executor] A4-P1a 暂存 ' + file + ' HTML 合同失败: ' + check.blocking.map(x => x.message).join('; '));
    }
    const verdict = PC.checkVerdictConsistency(stagePlain, data);
    if (!verdict.passed) throw new Error('[executor] A4-P1a 暂存判决一致性失败: ' + verdict.errors.map(x => x.message).join('; '));
    assertRefreshControls(stageReport, stagePlain);
    assertSameFingerprints('R8 暂存前', r8Before, fingerprintFiles(workDir, PLAIN_REFRESH_R8_OUTPUTS));

    // R8-M1：只在 R7 暂存门禁全部通过后，才用原场次四件已验证快照对暂存 R6 输入重建证明。
    // readVerifiedReaderGuideSnapshot 会同时核对 input/guide/cache review/key/独立 HTML；不调用模型、不改快照。
    const r8Snapshot = readVerifiedReaderGuideSnapshot(workDir, stageDir);
    const embeddedStageReport = RR.embedReaderGuideIntoReport(stageReport, r8Snapshot.guide, r8Snapshot.plainGuide);
    const plainGuideState = RR.stripEmbeddedReaderGuide(stagePlain);
    if (plainGuideState.embedded) throw new Error('[executor] A4-P1a 纯白话页不得嵌入 R8 导览');
    fs.writeFileSync(path.join(stageDir, 'report.html'), embeddedStageReport, 'utf8');
    const embeddedCheck = PC.checkHtml(path.join(stageDir, 'report.html'), { stage: 'final', skillPath: resolveSkillPath(), dataSource });
    if (embeddedCheck.blocking && embeddedCheck.blocking.length) {
      throw new Error('[executor] A4-P1a 暂存 R8 嵌入后 HTML 合同失败: ' + embeddedCheck.blocking.map(x => x.message).join('; '));
    }

    const tx = makeRefreshTransaction(workDir, PLAIN_REFRESH_OUTPUTS);
    const nextFiles = [];
    try {
      for (const name of PLAIN_REFRESH_OUTPUTS) {
        const staged = path.join(stageDir, name);
        if (!fs.existsSync(staged)) throw new Error('[executor] A4-P1a 暂存缺少提交产物: ' + name);
        const next = path.join(workDir, '.' + name + '.refresh-next');
        fs.copyFileSync(staged, next);
        nextFiles.push({ name, next });
      }
      writeRefreshTransaction(workDir, tx, 'committing');
      for (const item of nextFiles) fs.renameSync(item.next, path.join(workDir, item.name));
      assertSameFingerprints('R8 提交后', r8Before, fingerprintFiles(workDir, PLAIN_REFRESH_R8_OUTPUTS));
      finishRefreshTransaction(workDir, tx);
    } catch (e) {
      for (const item of nextFiles) if (fs.existsSync(item.next)) fs.rmSync(item.next, { force: true });
      recoverPlainRefreshTransaction(workDir, onLog);
      throw e;
    }
    onLog('[executor] A4-P1a 无模型生产报告刷新完成：14 批缓存已重键，A1 Alt+T 已同步');
    return { cacheOnly: true, recovered, batches: PLAIN_REFRESH_BATCHES };
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

// ---------- PLAIN-V2：生产白话层窄重生成 seam ----------
// 只允许从现役 R6 权威产物机械重建 report，再重跑 R7 白话与 R8 白话导览；
// 不重算 R1—R6，不允许借“更白话”改变原 guide。所有会被改写的文件先精确备份，
// 中途失败或门禁失败必须恢复；进程意外中断留下 journal 时，下次调用先恢复。
const PLAIN_V2_REGEN_JOURNAL = '.tmp-plain-v2-regenerate-transaction.json';
const PLAIN_V2_REGEN_CHECKPOINT_PREFIX = '.tmp-plain-v2-regenerate-checkpoints-';
const PLAIN_V2_REGEN_FIXED_TARGETS = [
  'report.html', 'report-plain.html',
  'reader-guide-input.json', 'reader-guide.json', 'reader-guide-plain.json', 'reader-guide.html', '.tmp-reader-guide-cache.json', '.tmp-reader-guide-draft.json', '.tmp-reader-guide-plain-draft.json'
];
const PLAIN_V2_IMMUTABLE_FILES = [
  'P1.md', 'P2.md', 'P2.5.md', 'P3.md', 'full-data.md',
  '.tmp-adjudicated-data.md', '.tmp-adjudicated-structure.json', 'transition-final.md',
  'structure.json', '叙事.md', 'adjudication.json', 'source-anchor.json'
];

function plainV2CacheNames(workDir) {
  return fs.readdirSync(workDir).filter(name => /^\.tmp-plain-batch-\d+\.json$/.test(name)).sort();
}

function plainV2MutableNames(workDir) {
  // 生产事务只管理可发布派生产物；已逐批过门的正文 cache 与 R1—R6 轮次产物同属断点，禁止回滚。
  return PLAIN_V2_REGEN_FIXED_TARGETS.slice().sort();
}

function plainV2CheckpointCandidateNames(workDir) {
  const out = [];
  const proofFile = path.join(workDir, PLAIN_REVIEW_FILE);
  let proofHash = '';
  try {
    const bytes = fs.readFileSync(proofFile);
    const proof = JSON.parse(bytes.toString('utf8'));
    if (proof && proof.state === 'approved') proofHash = crypto.createHash('sha256').update(bytes).digest('hex');
  } catch (e) { proofHash = ''; }
  if (!proofHash) return out;
  for (const name of plainV2CacheNames(workDir)) {
    try {
      const cc = JSON.parse(fs.readFileSync(path.join(workDir, name), 'utf8'));
      if (cc && cc.v === PLAIN_CACHE_VERSION && cc.promptVersion === PLAIN_PROMPT_VERSION &&
          cc.approved === true && cc.reviewProofHash === proofHash) out.push(name);
    } catch (e) { /* 损坏缓存仍由 translateUnitsLLM 按 miss 处理 */ }
  }
  return out;
}

function fingerprintOptionalFiles(workDir, names) {
  const out = {};
  for (const name of names) {
    const file = path.join(workDir, name);
    if (!fs.existsSync(file)) continue;
    if (!fs.statSync(file).isFile()) throw new Error('[executor] PLAIN-V2 不可变输入不是普通文件: ' + name);
    out[name] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  return out;
}

function plainV2JournalPath(workDir) {
  return path.join(workDir, PLAIN_V2_REGEN_JOURNAL);
}

function validatePlainV2Transaction(workDir, tx) {
  if (!tx || ![1, 2].includes(tx.v) || !['prepared', 'running', 'committed', 'recovered'].includes(tx.state) ||
    typeof tx.backupDir !== 'string' || !Array.isArray(tx.originalFiles)) {
    throw new Error('[executor] PLAIN-V2 重生成事务日志格式不合法');
  }
  const backupDir = path.resolve(workDir, tx.backupDir);
  const rel = path.relative(path.resolve(workDir), backupDir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !path.basename(backupDir).startsWith('.tmp-plain-v2-regenerate-backup-')) {
    throw new Error('[executor] PLAIN-V2 重生成事务备份目录越界');
  }
  if (!fs.existsSync(backupDir) || !fs.statSync(backupDir).isDirectory()) {
    throw new Error('[executor] PLAIN-V2 重生成事务备份不存在: ' + tx.backupDir);
  }
  for (const name of tx.originalFiles) {
    if (!PLAIN_V2_REGEN_FIXED_TARGETS.includes(name) && !/^\.tmp-plain-batch-\d+\.json$/.test(name)) {
      throw new Error('[executor] PLAIN-V2 重生成事务含非法目标: ' + name);
    }
    if (!fs.existsSync(path.join(backupDir, name))) {
      throw new Error('[executor] PLAIN-V2 重生成事务备份缺少: ' + name);
    }
  }
  return backupDir;
}

function writePlainV2Transaction(workDir, tx, state) {
  tx.state = state;
  fs.writeFileSync(plainV2JournalPath(workDir), JSON.stringify(tx), 'utf8');
}

function cleanupLegacyPlainV2CheckpointDir(workDir, tx) {
  const name = String(tx && tx.checkpointDir || '');
  if (!name) return;
  if (path.basename(name) !== name || !name.startsWith(PLAIN_V2_REGEN_CHECKPOINT_PREFIX)) {
    throw new Error('[executor] PLAIN-V2 legacy checkpoint 目录越界');
  }
  const dir = path.resolve(workDir, name);
  const rel = path.relative(path.resolve(workDir), dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('[executor] PLAIN-V2 legacy checkpoint 目录越界');
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function beginPlainV2RegenerationTransaction(workDir) {
  const originalFiles = plainV2MutableNames(workDir).filter(name => fs.existsSync(path.join(workDir, name)));
  const backupDir = fs.mkdtempSync(path.join(workDir, '.tmp-plain-v2-regenerate-backup-'));
  for (const name of originalFiles) fs.copyFileSync(path.join(workDir, name), path.join(backupDir, name));
  const tx = { v: 2, state: 'prepared', backupDir: path.basename(backupDir), originalFiles };
  fs.writeFileSync(plainV2JournalPath(workDir), JSON.stringify(tx), 'utf8');
  return tx;
}

function removePlainV2MutableFiles(workDir) {
  for (const name of PLAIN_V2_REGEN_FIXED_TARGETS) {
    const file = path.join(workDir, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) fs.rmSync(file, { force: true });
  }
}

function recoverPlainV2RegenerationTransaction(workDir, onLog) {
  const journal = plainV2JournalPath(workDir);
  if (!fs.existsSync(journal)) return false;
  let tx;
  try { tx = JSON.parse(fs.readFileSync(journal, 'utf8')); }
  catch (e) { throw new Error('[executor] PLAIN-V2 重生成事务日志不可解析: ' + e.message); }
  if (tx && [1, 2].includes(tx.v) && ['committed', 'recovered'].includes(tx.state) && typeof tx.backupDir === 'string') {
    const backupDir = path.resolve(workDir, tx.backupDir);
    if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
    cleanupLegacyPlainV2CheckpointDir(workDir, tx);
    fs.rmSync(journal, { force: true });
    if (onLog) onLog('[executor] PLAIN-V2 清理已完成事务残留');
    return true;
  }
  const backupDir = validatePlainV2Transaction(workDir, tx);
  removePlainV2MutableFiles(workDir);
  // 兼容旧 v1/v2 journal：历史 backup 可能含 batch cache，但恢复时只还原发布产物，绝不以旧 cache 覆盖当前断点。
  for (const name of tx.originalFiles) {
    if (PLAIN_V2_REGEN_FIXED_TARGETS.includes(name)) fs.copyFileSync(path.join(backupDir, name), path.join(workDir, name));
  }
  writePlainV2Transaction(workDir, tx, 'recovered');
  fs.rmSync(backupDir, { recursive: true, force: true });
  cleanupLegacyPlainV2CheckpointDir(workDir, tx);
  fs.rmSync(journal, { force: true });
  if (onLog) onLog('[executor] PLAIN-V2 检测到未完成生产重生成事务，已精确恢复');
  return true;
}

function preparePlainV2RegenerationResume(workDir, onLog) {
  const journal = plainV2JournalPath(workDir);
  const checkpointNames = plainV2CheckpointCandidateNames(workDir);
  if (!fs.existsSync(journal)) {
    return { tx: null, recovered: false, resumed: checkpointNames.length > 0, resumedPlainBatches: checkpointNames.length };
  }
  let tx;
  try { tx = JSON.parse(fs.readFileSync(journal, 'utf8')); }
  catch (e) { throw new Error('[executor] PLAIN-V2 重生成事务日志不可解析: ' + e.message); }
  if (tx && [1, 2].includes(tx.v) && ['committed', 'recovered'].includes(tx.state)) {
    recoverPlainV2RegenerationTransaction(workDir, onLog);
    return { tx: null, recovered: true, resumed: checkpointNames.length > 0, resumedPlainBatches: checkpointNames.length };
  }
  const backupDir = validatePlainV2Transaction(workDir, tx);
  // 半成品发布产物不能作为 resume 输入；但已过门 batch cache 原地保留，稍后由现有 cache gate 逐批重新验真。
  removePlainV2MutableFiles(workDir);
  for (const name of tx.originalFiles) {
    if (PLAIN_V2_REGEN_FIXED_TARGETS.includes(name)) fs.copyFileSync(path.join(backupDir, name), path.join(workDir, name));
  }
  writePlainV2Transaction(workDir, tx, 'prepared');
  if (onLog) onLog('[executor] PLAIN-V2 检测到宿主中断：已恢复原生产发布快照并保留 ' + checkpointNames.length + ' 个原地正文 checkpoint 候选，后续逐批重新验真');
  return { tx, recovered: true, resumed: checkpointNames.length > 0, resumedPlainBatches: checkpointNames.length };
}

function finishPlainV2RegenerationTransaction(workDir, tx) {
  const backupDir = validatePlainV2Transaction(workDir, tx);
  writePlainV2Transaction(workDir, tx, 'committed');
  fs.rmSync(backupDir, { recursive: true, force: true });
  cleanupLegacyPlainV2CheckpointDir(workDir, tx);
  fs.rmSync(plainV2JournalPath(workDir), { force: true });
}

function validateExistingReaderGuideForPlainV2(workDir, cfg) {
  const RG = require('../scripts/reader-guide.js');
  const RR = require('../render-report.js');
  const PC = require('../pipeline-controller.js');
  const prepared = buildReaderGuideInputFromWorkDir(workDir, RG, RR, PC);
  const files = prepared.files;
  if (!fs.existsSync(files.guide) || !fs.existsSync(files.cache)) {
    throw new Error('[executor] PLAIN-V2 生产重生成要求已有经复核的原 reader-guide 与 cache；禁止顺带重生成原导览');
  }
  const guide = JSON.parse(fs.readFileSync(files.guide, 'utf8'));
  const cache = JSON.parse(fs.readFileSync(files.cache, 'utf8'));
  const snapshot = guide.modelSnapshot || {};
  const guideCheck = checkReaderGuideContract(RG, prepared.input, guide, snapshot);
  const reviewCheck = RG.validateReview(prepared.input, guide, cache.review);
  const inputHash = RG.hashGuideInput(prepared.input);
  if (!guideCheck.ok || !reviewCheck.ok || cache.inputHash !== inputHash ||
    cache.key !== RG.cacheKey(prepared.input, snapshot) || RG.stableJson(cache.guide || {}) !== RG.stableJson(guide)) {
    throw new Error('[executor] PLAIN-V2 原 reader-guide 证明链无效：' + guideCheck.errors.concat(reviewCheck.errors).join('; '));
  }
  const requested = cfg || {};
  if (String(requested.provider || '') !== String(snapshot.provider || '') || String(requested.model || '') !== String(snapshot.model || '')) {
    throw new Error('[executor] PLAIN-V2 provider/model 必须沿用已复核原 guide 的 modelSnapshot（' +
      String(snapshot.provider || '') + '/' + String(snapshot.model || '') + '）');
  }
  return { RG, guide, stableGuide: RG.stableJson(guide), snapshot };
}

async function regeneratePlainV2Artifacts(workDir, cfg, onLog, opts) {
  opts = opts || {};
  onLog = typeof onLog === 'function' ? onLog : () => {};
  if (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) {
    throw new Error('[executor] PLAIN-V2 production workDir 不存在');
  }
  const startNode = String(opts.startNode || 'auto');
  if (!['auto', 'r7-body', 'r8-guide'].includes(startNode)) {
    throw new Error('[executor] PLAIN-V2 startNode 非法: ' + startNode);
  }
  const resumeStart = preparePlainV2RegenerationResume(workDir, onLog);
  const recovered = resumeStart.recovered;
  const proof = validateExistingReaderGuideForPlainV2(workDir, cfg);
  if (String(cfg && cfg.provider || '') !== 'codex-cli' && opts.allowNonCodex !== true) {
    throw new Error('[executor] PLAIN-V2 生产窄入口默认只允许 codex-cli；其它 provider 必须由显式受控调用开放');
  }
  const immutableBefore = fingerprintOptionalFiles(workDir, PLAIN_V2_IMMUTABLE_FILES);
  const tx = resumeStart.tx || beginPlainV2RegenerationTransaction(workDir);
  try {
    writePlainV2Transaction(workDir, tx, 'running');
    // 从 R6 权威输入重新机械渲染，主动抛弃当前 report 中旧 PLAIN/R8/UI 状态。
    renderReport(workDir);
    // Judge 原生断点语义：不主动删除 `.tmp-plain-batch-*`。translateUnitsLLM 会对每批
    // v/prompt/chunk/dict + 首次术语 + PLAIN-V2 门重新验真；无效缓存自然 miss，只有缺失批才重跑。
    const checkpointCandidates = plainV2CheckpointCandidateNames(workDir).length;
    if (checkpointCandidates) onLog('[executor] PLAIN-V2 发现 ' + checkpointCandidates + ' 个原地正文 checkpoint 候选，逐批重新验真');

    await applyPlain(workDir, cfg, onLog, opts.extraDictPath || null, {
      cache: true,
      cacheDir: workDir,
      onBatchCheckpoint: opts.onBatchCheckpoint,
      requireCacheHit: startNode === 'r8-guide',
      requestCompletion: opts.requestCompletion,
      codexRunner: opts.codexRunner
    });

    const guideResult = await applyReaderGuide(workDir, cfg, onLog, {
      cache: true,
      requestCompletion: opts.requestCompletion,
      codexRunner: opts.codexRunner
    });

    const immutableAfter = fingerprintOptionalFiles(workDir, PLAIN_V2_IMMUTABLE_FILES);
    assertSameFingerprints('PLAIN-V2 R1—R6 不可变输入', immutableBefore, immutableAfter);
    const newGuide = JSON.parse(fs.readFileSync(path.join(workDir, 'reader-guide.json'), 'utf8'));
    if (proof.RG.stableJson(newGuide) !== proof.stableGuide) {
      throw new Error('[executor] PLAIN-V2 禁止修改原 reader-guide；本轮只允许更新白话派生层');
    }
    const plainGuide = JSON.parse(fs.readFileSync(path.join(workDir, 'reader-guide-plain.json'), 'utf8'));
    if (plainGuide.promptVersion !== proof.RG.PLAIN_PROMPT_VERSION) {
      throw new Error('[executor] PLAIN-V2 reader-guide-plain promptVersion 未升级');
    }
    const report = fs.readFileSync(path.join(workDir, 'report.html'), 'utf8');
    const pure = fs.readFileSync(path.join(workDir, 'report-plain.html'), 'utf8');
    if ((report.match(/<!--R8_REPORT_GUIDE_START:C\d{1,2}-->/g) || []).length !== 12) {
      throw new Error('[executor] PLAIN-V2 主报告未完整嵌入 C1—C12 导览');
    }
    if (pure.includes('R8_REPORT_GUIDE_START')) {
      throw new Error('[executor] PLAIN-V2 纯白话报告不得嵌入章节导览');
    }
    const cacheNames = plainV2CacheNames(workDir);
    if (!cacheNames.length) throw new Error('[executor] PLAIN 未生成任何 v4 白话批缓存');
    finishPlainV2RegenerationTransaction(workDir, tx);
    onLog('[executor] PLAIN-V2 生产全文重生成完成：R6 零漂移；R7 全量白话 + R8 白话导览已通过新旧双门');
    return {
      ok: true,
      recovered,
      resumed: !!resumeStart.resumed,
      resumedPlainBatches: resumeStart.resumedPlainBatches || 0,
      provider: proof.snapshot.provider,
      model: proof.snapshot.model,
      plainBatches: cacheNames.length,
      guideCached: !!(guideResult && guideResult.cached),
      plainGuideCached: !!(guideResult && guideResult.plainCached),
      files: ['report.html', 'report-plain.html', 'reader-guide-plain.json']
    };
  } catch (error) {
    try { recoverPlainV2RegenerationTransaction(workDir, onLog); }
    catch (rollbackError) {
      throw new Error('[executor] PLAIN-V2 重生成失败且回滚失败：原错误=' + (error && error.message || error) +
        '；回滚错误=' + (rollbackError && rollbackError.message || rollbackError));
    }
    throw error;
  }
}

function r8RepairIdsFromError(message, chunk) {
  const text = String(message || '');
  if (!text.includes('R8 白话导览机械语义门失败') && !text.includes('R8 白话导览结构/事实硬门失败')) return [];
  const wanted = new Set();
  const add = (sectionId, fields) => {
    for (const field of fields) {
      const id = 'R8P:' + sectionId + ':' + field;
      if ((chunk || []).some(item => item.id === id)) wanted.add(id);
    }
  };
  const sectionRe = /(C(?:1[0-2]|[1-9])) PLAIN-V2 零背景可理解性门失败:\s*([\s\S]*?)(?=;\s*C(?:1[0-2]|[1-9]) PLAIN-V2 零背景可理解性门失败:|;\s*reader-guide-plain 事实门:|$)/g;
  let match;
  while ((match = sectionRe.exec(text))) {
    const fields = [...match[2].matchAll(/"field":"(what|why|conclusion)"/g)].map(m => m[1]);
    if (fields.length) add(match[1], [...new Set(fields)]);
    else if (match[2].includes('reasoning-bridge')) add(match[1], ['why']);
    else add(match[1], ['what', 'why', 'conclusion']);
  }
  const factRe = /reader-guide-plain 事实门:\s*(C(?:1[0-2]|[1-9]))(?:\s+(what|why|conclusion))?\b[^;]*/g;
  while ((match = factRe.exec(text))) add(match[1], match[2] ? [match[2]] : ['what', 'why', 'conclusion']);
  return (chunk || []).map(item => item.id).filter(id => wanted.has(id));
}

function bodyRepairIdsFromError(message, chunk) {
  const text = String(message || '');
  const wanted = new Set();
  if (text.includes('PLAIN-V2 可理解性门失败')) {
    for (const match of text.matchAll(/"id":"([^"]+)"/g)) wanted.add(match[1]);
  }
  if (text.includes('首次术语受控解释缺失')) {
    for (const match of text.matchAll(/@([^,;\s]+)/g)) wanted.add(match[1]);
  }
  return (chunk || []).map(item => item.id).filter(id => wanted.has(id));
}

function plainRetryRequestFingerprint(cfg, system, prompt) {
  return crypto.createHash('sha256').update(JSON.stringify({
    provider: cfg && cfg.provider || '',
    baseUrl: cfg && cfg.baseUrl || '',
    model: cfg && cfg.model || '',
    system: String(system || ''),
    prompt: String(prompt || '')
  })).digest('hex');
}

function plainComprehensionRetryGuidance(errMsg) {
  const text = String(errMsg || '');
  const rules = [];
  if (text.includes('protected-token-drift')) {
    rules.push('对 protected-token-drift：原文已有的数字、比分、轮次和内部 ID 必须逐字、逐次数保留，不能新增、删除、改号或重复；解释时改用“这个编号”“这一步”“这一阶段”“这个比例”等自然语言指代。');
  }
  if (text.includes('opaque-concept')) {
    rules.push('对 opaque-concept：只处理机械诊断点名的单元/字段，使用本批“PLAIN-V2 认知义务”给出的受控解释就地说明该概念，优先写成“术语（受控解释）”或等价同句解释；不要只保留术语，也不要用另一个 Judge 内部术语解释它。');
  }
  if (text.includes('internal-marker')) {
    rules.push('对 internal-marker：原文已有的内部定位标记必须逐字保留且出现次数不变，不能删除、改号、新增或重复；同时要在同一单元/字段用自然语言说明这个标记对应哪个步骤或判断、对读者起什么定位作用，使读者不需要先懂内部编号体系。解释时不要再次复述该标记。');
  }
  if (text.includes('density')) {
    rules.push('对 density：不得删减信息；请在同一文本单元内拆成更短的句子，逐一解释诊断点名的概念/内部标记并补齐必要中间台阶，禁止跨单元搬运内容。');
  }
  if (text.includes('surface-only-rewrite')) {
    rules.push('对 surface-only-rewrite：不要只做同义词替换；必须把原文默认读者已知的概念作用、比较关系或推理台阶补成普通读者可直接理解的自然语言，同时保持原判断强度和事实不变。');
  }
  if (text.includes('reasoning-bridge')) {
    rules.push('对 reasoning-bridge：在被点名单元/字段内明确补出“前面的事实/比较 → 为什么产生影响 → 后面的判断/结论”的中间因果桥，可用“因为……所以……”或“因为……这意味着……”等自然表达；不能只说“重要”“有影响”而省略中间理由。');
  }
  return rules.length ? '\n' + rules.join('\n') : '';
}

// 批量 LLM 翻译：按 40 单元/6000 字符分批，沿用 core 重试退避，回填按 id；
// dict 提供术语表上下文（unit.dictHints 优先；未标注时按 dict 即时计算）；
// opts = { cacheDir, requestCompletion, codexRunner }（S5：cacheDir 非空时按批落盘/命中缓存；
// requestCompletion 缺省 Node 宿主 provider seam，测试可注入桩——仅真实 LLM 路径生效，mock 不适用）
async function translateUnitsLLM(cfg, units, onLog, dict, opts) {
  const out = new Map();
  const rc = (opts && opts.requestCompletion) || requestCompletionNode;
  const cacheDir = opts && opts.cacheDir ? opts.cacheDir : null;
  const legacyV3 = !!(opts && opts.legacyV3);
  const cacheVersion = legacyV3 ? LEGACY_PLAIN_CACHE_VERSION : PLAIN_CACHE_VERSION;
  const promptVersion = (opts && opts.promptVersion) || (legacyV3 ? LEGACY_PLAIN_PROMPT_VERSION : PLAIN_PROMPT_VERSION);
  const PV2 = require('../scripts/plain-comprehension.js');
  const comprehensionProfile = (opts && opts.comprehensionProfile) || PV2.PROFILE_BODY;
  annotatePlainComprehensionRequirements(units, comprehensionProfile);
  const MAX_UNITS = 40;
  const MAX_CHARS = 6000;
  const chunks = [];
  let cur = [];
  let curChars = 0;
  for (const u of units) {
    const item = {
      id: u.id,
      context: (u.module ? u.module + ' · ' : '') + (u.blockType || 'block'),
      text: u.text,
      requiredGlosses: Array.isArray(u.requiredGlosses) ? u.requiredGlosses : [],
      comprehensionRequirements: Array.isArray(u.comprehensionRequirements) ? u.comprehensionRequirements : []
    };
    if (cur.length >= MAX_UNITS || (curChars + item.text.length > MAX_CHARS && cur.length)) {
      chunks.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(item);
    curChars += item.text.length;
  }
  if (cur.length) chunks.push(cur);
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    // S5 断点缓存：批开始前检查命中（v/prompt/chunk/dict 全匹配且语义复核通过才复用；
    // 损坏/缺 id/缺首现解释 → 忽略重译，容错不阻断）
    if (cacheDir) {
      let cached = null;
      let cachedMeta = null;
      try {
        const cachePath = path.join(cacheDir, PLAIN_CACHE_PREFIX + ci + '.json');
        if (fs.existsSync(cachePath)) {
          const cc = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
          if (cc && cc.v === cacheVersion && cc.promptVersion === promptVersion && cc.chunkHash === chunkHashOf(chunk) && cc.dictHash === dictHashOf(dict) &&
              (!opts || !opts.requireCacheHit || legacyV3 || cc.approved === true)) {
            cached = cc.results;
            cachedMeta = cc;
          }
        }
      } catch (e) { cached = null; }
      if (cached) {
        const hit = chunk.every(it => typeof cached[it.id] === 'string');
        const PL = require('../scripts/plain-language.js');
        const legacySemantic = !legacyV3 || (hit && PL.checkRequiredGlosses(chunk, id => cached[id]).ok);
        const hard = hit ? checkPlainComprehensionItems(chunk, id => cached[id], comprehensionProfile) : { ok: false };
        if (hit && legacySemantic && hard.ok) {
          for (const it of chunk) out.set(it.id, cached[it.id]);
          onLog('[executor] 白话批缓存命中 ' + (ci + 1) + '/' + chunks.length + '（' + chunk.length + ' 单元；' +
            (legacyV3 ? 'legacy-v3' : (cachedMeta && cachedMeta.approved === true ? 'approved' : 'draft')) + '）');
          if (opts && typeof opts.onBatchCheckpoint === 'function') {
            await Promise.resolve(opts.onBatchCheckpoint({ phase: legacyV3 ? 'legacy' : 'draft', index: ci, total: chunks.length, cached: true, approved: !!(cachedMeta && cachedMeta.approved), cacheDir }));
          }
          continue;
        }
      }
    }
    if (opts && opts.requireCacheHit) {
      throw new Error('[executor] 指定 resume node 要求前置 R7 checkpoint 完整，但白话批 ' + (ci + 1) + '/' + chunks.length + ' cache miss；禁止静默回退调用正文模型');
    }
    const gloss = [];
    const seen = new Set();
    for (const u of chunk) {
      let hints = u.dictHints;
      if (!hints && dict) {
        const PL = require('../scripts/plain-language.js');
        hints = PL.dictHintsForText(u.text, dict);
      }
      for (const h of hints || []) {
        if (!seen.has(h.term)) { seen.add(h.term); gloss.push(h.term + ' → ' + h.gloss); }
      }
    }
    const comprehensionLines = chunk.flatMap(u => (u.comprehensionRequirements || []).map(req =>
      '- ' + u.id + ': ' + (req.term ? req.term + ' → ' + (req.explanation || '') : (req.markers || []).join('/') + ' → ' + req.mode)));
    const prompt = PV2.buildPromptContract({ profile: comprehensionProfile }) +
      '\n\n输入单元（JSON）：\n' + JSON.stringify({ units: chunk }, null, 2) +
      (gloss.length ? '\n\n术语表（认知提示，不是固定输出模板；可自然等价解释）：\n- ' + gloss.join('\n- ') : '') +
      (chunk.some(u => u.requiredGlosses.length) ? '\n\n首次出现术语提示（只帮助理解，不要求逐字括号复刻）：\n' + chunk.flatMap(u => u.requiredGlosses.map(r => '- ' + u.id + ': ' + r.term + ' → ' + r.gloss)).join('\n') : '') +
      (comprehensionLines.length ? '\n\nPLAIN 认知提示（由独立 reviewer 结合上下文判断，不是机械 hard gate）：\n' + comprehensionLines.join('\n') : '') +
      '\n\n请按规则对每个单元做白话改写，输出覆盖全部 id 的 JSON。';
    let parsed = null;
    let lastErr = null;
    let retryFeedback = '';
    // R8 整卡失败后的定点修复状态：保留上一版完整候选，只重写机械门点名字段。
    let repairBase = null;
    let repairIds = [];
    let lastRequestFingerprint = null;
    let lastRetryDeterministic = false;
    // 跨 Job draft 恢复：如果调用方已经持有一份完整失败候选，首笔模型请求就必须进入
    // 定点修复，不能先重译整批。其它字段在 repairBase 中冻结并由执行器机械合并。
    if (comprehensionProfile === PV2.PROFILE_GUIDE && opts && opts.initialResults instanceof Map && opts.initialError) {
      const complete = chunk.every(item => typeof opts.initialResults.get(item.id) === 'string');
      const initialRepairIds = complete ? r8RepairIdsFromError(String(opts.initialError), chunk) : [];
      if (initialRepairIds.length) {
        repairBase = new Map(opts.initialResults);
        repairIds = initialRepairIds;
        retryFeedback = '\n\n这是从私有 draft 恢复的定点续跑。当前机械门诊断必须逐项消除；未点名字段已经冻结，禁止重写。\n' + String(opts.initialError).slice(0, 6000);
        onLog('[executor] R8 白话 draft 断点续跑：冻结其它字段，只修 ' + repairIds.join(','));
      }
    }
    for (let attempt = 0; attempt <= core.MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const d = core.retryDelayMs(attempt);
        onLog('[executor] 白话翻译批 ' + (ci + 1) + '/' + chunks.length + ' 重试 ' + attempt + '/' + core.MAX_RETRIES + ' · 退避 ' + d + 'ms');
        await sleep(d);
      }
      try {
        let callPrompt = prompt + retryFeedback;
        let expectedIds = chunk.map(it => it.id);
        if (repairBase && repairIds.length) {
          const repairUnits = repairIds.map(id => {
            const source = chunk.find(item => item.id === id);
            return {
              id,
              context: source.context,
              originalText: source.text,
              text: repairBase.get(id),
              requiredGlosses: source.requiredGlosses || [],
              comprehensionRequirements: source.comprehensionRequirements || []
            };
          });
          expectedIds = repairIds.slice();
          const repairLabel = comprehensionProfile === PV2.PROFILE_GUIDE ? 'R8 定点修复模式' : 'R7 BODY 定点修复模式';
          const sourceLabel = comprehensionProfile === PV2.PROFILE_GUIDE ? '原导览' : '原正文';
          callPrompt = PV2.buildPromptContract({ profile: comprehensionProfile }) +
            '\n\n' + repairLabel + '：下面只列出上一版完整候选中仍未通过机械门的单元/字段。' +
            '\n`originalText` 是不可改变语义的' + sourceLabel + '，`text` 是上一版待修白话。只修这些 id；未列出的内容已经冻结，执行器会机械保留，不会采用你对它们的任何改写。' +
            '\n输出必须且只能是 {"units":[{"id":"...","text":"..."}]}，并覆盖下面全部 ' + repairUnits.length + ' 个 id，禁止返回 cards/review/说明文字。' +
            '\n\n待修字段（JSON）：\n' + JSON.stringify({ units: repairUnits }, null, 2) + retryFeedback;
        }
        const systemPrompt = comprehensionProfile === PV2.PROFILE_GUIDE ? TRANSLATE_GUIDE_SYSTEM : TRANSLATE_SYSTEM;
        const requestFingerprint = plainRetryRequestFingerprint(cfg, systemPrompt, callPrompt);
        if (lastRetryDeterministic && lastRequestFingerprint === requestFingerprint) {
          const stalled = new Error('PLAIN-V2 修复停滞：上一轮机械诊断与待修候选没有产生任何新请求内容；已阻止再次发送相同请求。最近机械诊断：' + String(lastErr && lastErr.message || '').slice(0, 1600));
          stalled.code = 'ERR_PLAIN_RETRY_STALLED';
          throw stalled;
        }
        lastRequestFingerprint = requestFingerprint;
        const raw = await rc(cfg, [{ role: 'user', content: callPrompt }], {
          system: systemPrompt,
          codexRunner: opts && opts.codexRunner
        });
        const incoming = parseTranslateJson(raw, expectedIds);
        if (repairBase && repairIds.length) {
          parsed = new Map(repairBase);
          for (const id of repairIds) parsed.set(id, incoming.get(id));
        } else {
          parsed = incoming;
        }
        const PL = require('../scripts/plain-language.js');
        if (legacyV3) {
          const semantic = PL.checkRequiredGlosses(chunk, id => parsed.get(id));
          if (!semantic.ok) throw new Error('legacy-v3 首次术语受控解释缺失: ' + semantic.missing.map(x => x.term + '@' + x.unitId).join(','));
        }
        const hard = checkPlainComprehensionItems(chunk, id => parsed.get(id), comprehensionProfile);
        if (!hard.ok) throw new Error('PLAIN hard invariant 失败: ' + JSON.stringify(hard.issues.slice(0, 8)));
        if (opts && typeof opts.postValidate === 'function') {
          await opts.postValidate({ results: parsed, chunk, index: ci, total: chunks.length });
        }
        break;
      } catch (e) {
        // parse 成功不等于门禁成功。R8 整卡门失败时先保留已解析候选，下一轮只修被点名字段；
        // 其它错误仍按普通重试处理。最后一次失败后 parsed 必须清空，绝不把未过门候选落盘。
        const failedCandidate = parsed instanceof Map ? new Map(parsed) : null;
        lastErr = e;
        const errMsg = String(e && e.message || '');
        // P0（260901）：旧 UI 只看得到“第 N 批重试”，看不到触发重试的实际原因，
        // 导致真实 R7/R8 门禁问题事后无法从日志复原。只记录有界错误摘要，不记录原始模型响应。
        onLog('[executor] 白话翻译批 ' + (ci + 1) + '/' + chunks.length + ' attempt ' + (attempt + 1) + ' 失败: ' + errMsg.slice(0, 1200));
        if (e && e.code === 'ERR_PLAIN_RETRY_STALLED') throw e;
        if (failedCandidate && comprehensionProfile === PV2.PROFILE_GUIDE &&
          (errMsg.includes('R8 白话导览机械语义门失败') || errMsg.includes('R8 白话导览结构/事实硬门失败'))) {
          const nextRepairIds = r8RepairIdsFromError(errMsg, chunk);
          if (nextRepairIds.length) {
            repairBase = failedCandidate;
            repairIds = nextRepairIds;
          }
          if (opts && typeof opts.onFailedCandidate === 'function') {
            try { opts.onFailedCandidate({ results: failedCandidate, error: errMsg, repairIds: nextRepairIds, chunk, index: ci, total: chunks.length }); }
            catch (checkpointError) { onLog('[executor] R8 白话私有 draft checkpoint 失败（不改变原门禁结果）: ' + (checkpointError && checkpointError.message || checkpointError)); }
          }
        } else if (failedCandidate && comprehensionProfile === PV2.PROFILE_BODY &&
          (errMsg.includes('PLAIN-V2 可理解性门失败') || errMsg.includes('首次术语受控解释缺失'))) {
          const nextRepairIds = bodyRepairIdsFromError(errMsg, chunk);
          if (nextRepairIds.length) {
            repairBase = failedCandidate;
            repairIds = nextRepairIds;
          }
        }
        parsed = null;
        // 只为可行动的语义缺口追加固定反馈；下一次仍携带完整受控字典，避免把模型
        // 自由文本或异常堆栈混进提示词。
        const shapeError = errMsg.includes('翻译响应缺失') || errMsg.includes('翻译响应无 units 数组') ||
          /Unexpected token|Expected property name|JSON.*(?:parse|position)|position\s+\d+/i.test(errMsg);
        lastRetryDeterministic = errMsg.includes('protected-token-drift') || errMsg.includes('首次术语受控解释缺失') || errMsg.includes('PLAIN-V2 可理解性门失败') ||
          errMsg.includes('R8 白话导览机械语义门失败') || errMsg.includes('R8 白话导览结构/事实硬门失败') || shapeError;
        const scopedCount = repairBase && repairIds.length ? repairIds.length : chunk.length;
        const scopedLabel = repairBase && repairIds.length ? '当前待修范围的全部 ' + scopedCount + ' 个 id' : '本批全部 ' + scopedCount + ' 个输入 id';
        retryFeedback = errMsg.includes('首次术语受控解释缺失')
          ? '\n\n上一次响应缺少首次术语受控解释。请严格按“首次术语硬约束”逐字修正对应单元；若已进入定点修复，只重发待修 id。'
          : (shapeError
              ? '\n\n上一次响应没有遵守输出结构。你必须输出且只输出 {"units":[{"id":"...","text":"..."}]} 这一种 JSON 结构。必须恰好包含' + scopedLabel + '，每个 id 恰好一次且逐字保留；不得返回 cards、guide、review、说明文字或 Markdown。' +
                (repairBase && repairIds.length
                  ? '当前为定点修复，只能返回当前待修范围，不能夹带未点名字段。'
                  : '即使只需要修正被点名的少数章节，也不得只返回修改项，必须重发本批全部 ' + chunk.length + ' 个 units。') +
                '结构错误：' + errMsg.slice(0, 1200)
              : ((errMsg.includes('R8 白话导览机械语义门失败') || errMsg.includes('R8 白话导览结构/事实硬门失败'))
                ? '\n\n上一次响应通过了字段级格式检查，但没有通过 R8 白话导览结构/事实硬门。以下诊断必须逐项消除；不得删减原导览信息、不得新增任何事实/胜负/主体/数字，也不得用新的内部术语替代旧术语。' +
                  plainComprehensionRetryGuidance(errMsg) +
                  (/含来源外事实 token:\s*(?:胜出|胜利|获胜|胜方|获胜方)/.test(errMsg)
                    ? '\n对胜负词事实漂移：白话不得创造或同义改写任何胜负词。被事实门点名的“胜出/胜利/获胜/胜方/获胜方”等词如果原字段没有，就必须删除；需要表达胜负时只能逐字沿用原导览该字段已有的胜负原词，禁止同义替换。'
                    : '') +
                  (repairIds.length
                    ? '\n本轮已进入定点修复：只输出待修字段的 ' + repairIds.length + ' 个 id；其它字段由执行器冻结并机械保留，禁止重写。'
                    : '\n无论只修改几个章节，都必须继续使用原 {"units":[...]} 结构并完整重发本批全部 ' + chunk.length + ' 个 id。') +
                  '\n请根据具体章节和字段修正后重发 JSON：\n' + errMsg.slice(0, 6000)
                : (errMsg.includes('PLAIN-V2 可理解性门失败')
                  ? '\n\n上一次响应没有通过 PLAIN-V2 可理解性门。不要只换同义词；必须逐项消除下面的机械诊断，同时保持所有事实、主体、数字、因果方向、否定、责任和结论强度不变。' +
                    plainComprehensionRetryGuidance(errMsg) +
                    (repairIds.length
                      ? '\n本轮已进入 BODY 定点修复：只输出待修的 ' + repairIds.length + ' 个 id；其它已绿单元由执行器冻结并机械保留，合并后会重新跑完整机械门。'
                      : '') +
                    '\n请只根据本批既有受控解释和机械诊断修正后重发 JSON。机械诊断：\n' + errMsg.slice(0, 6000)
                  : (errMsg.includes('protected-token-drift')
                    ? '\n\n上一次响应改变了受保护数字/编号。' + plainComprehensionRetryGuidance(errMsg) + '\n请修正后重发 JSON。'
                    : ''))));
      }
    }
    if (!parsed) throw new Error('[executor] 白话翻译批 ' + (ci + 1) + '/' + chunks.length + ' 失败: ' + (lastErr ? lastErr.message : '未知错误'));
    for (const it of chunk) out.set(it.id, parsed.get(it.id));
    // S5：仅在 parseTranslateJson 成功（含 id 全覆盖校验）后落盘——复用 executor 断点"产物已通过才跳过"语义
    if (cacheDir) {
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
        const results = {};
        for (const it of chunk) results[it.id] = parsed.get(it.id);
        const cachePayload = { v: cacheVersion, promptVersion, chunkHash: chunkHashOf(chunk), dictHash: dictHashOf(dict), results };
        if (!legacyV3) cachePayload.approved = false;
        fs.writeFileSync(path.join(cacheDir, PLAIN_CACHE_PREFIX + ci + '.json'), JSON.stringify(cachePayload), 'utf8');
      } catch (e) { /* 缓存写失败不阻断翻译 */ }
    }
    if (opts && typeof opts.onBatchCheckpoint === 'function') {
      await Promise.resolve(opts.onBatchCheckpoint({ phase: legacyV3 ? 'legacy' : 'draft', index: ci, total: chunks.length, cached: false, approved: legacyV3, cacheDir }));
    }
    onLog('[executor] 白话翻译批 ' + (ci + 1) + '/' + chunks.length + ' 完成（' + chunk.length + ' 单元）');
  }
  return out;
}

function plainReviewPath(cacheDir) {
  return path.join(cacheDir, PLAIN_REVIEW_FILE);
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value)).digest('hex');
}

function plainReviewBinding(cfg, units, results, dict) {
  const PV2 = require('../scripts/plain-comprehension.js');
  const ordered = (units || []).map(unit => ({ id: unit.id, text: unit.text }));
  const candidate = (units || []).map(unit => ({ id: unit.id, text: results.get(unit.id) }));
  return {
    sourceHash: sha256Text(JSON.stringify(ordered)),
    candidateHash: sha256Text(JSON.stringify(candidate)),
    dictHash: dictHashOf(dict),
    generatorPromptVersion: PLAIN_PROMPT_VERSION,
    generatorPromptHash: sha256Text(TRANSLATE_SYSTEM + '\n' + PV2.buildPromptContract({ profile: PV2.PROFILE_BODY })),
    reviewPromptVersion: PV2.READABILITY_REVIEW_PROMPT_VERSION,
    modelSnapshot: {
      provider: String(cfg && cfg.provider || ''),
      model: String(cfg && cfg.model || ''),
      baseUrl: String(cfg && cfg.baseUrl || '')
    }
  };
}

function parsePlainReviewJson(raw) {
  let text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  return JSON.parse(text);
}

function writePlainReviewProof(cacheDir, proof) {
  if (!cacheDir) return null;
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = plainReviewPath(cacheDir);
  const next = file + '.next';
  const bytes = JSON.stringify(proof, null, 2) + '\n';
  fs.writeFileSync(next, bytes, 'utf8');
  fs.renameSync(next, file);
  return { file, sha256: sha256Text(bytes) };
}

function livePlainCacheFiles(cacheDir) {
  if (!cacheDir || !fs.existsSync(cacheDir)) return [];
  return fs.readdirSync(cacheDir)
    .filter(name => /^\.tmp-plain-batch-\d+\.json$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
}

function rewriteLivePlainCaches(cacheDir, results, approved, reviewProofHash) {
  if (!cacheDir) return 0;
  let changed = 0;
  for (const name of livePlainCacheFiles(cacheDir)) {
    const file = path.join(cacheDir, name);
    let cache;
    try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { continue; }
    if (!cache || cache.v !== PLAIN_CACHE_VERSION || cache.promptVersion !== PLAIN_PROMPT_VERSION || !cache.results) continue;
    let touched = false;
    for (const id of Object.keys(cache.results)) {
      if (results.has(id) && cache.results[id] !== results.get(id)) {
        cache.results[id] = results.get(id);
        touched = true;
      }
    }
    if (cache.approved !== approved) { cache.approved = approved; touched = true; }
    if (approved) {
      if (cache.reviewProofHash !== reviewProofHash) { cache.reviewProofHash = reviewProofHash; touched = true; }
    } else if ('reviewProofHash' in cache) {
      delete cache.reviewProofHash;
      touched = true;
    }
    if (touched) {
      fs.writeFileSync(file, JSON.stringify(cache), 'utf8');
      changed++;
    }
  }
  return changed;
}

function verifyApprovedPlainReviewProof(cacheDir, cfg, units, results, dict) {
  const PV2 = require('../scripts/plain-comprehension.js');
  if (!cacheDir) return { ok: false, error: 'approved review proof requires cacheDir' };
  const file = plainReviewPath(cacheDir);
  if (!fs.existsSync(file)) return { ok: false, error: '缺少 ' + PLAIN_REVIEW_FILE };
  let proof;
  let bytes;
  try {
    bytes = fs.readFileSync(file, 'utf8');
    proof = JSON.parse(bytes);
  } catch (e) { return { ok: false, error: 'review proof 不可解析: ' + e.message }; }
  const binding = plainReviewBinding(cfg, units, results, dict);
  for (const key of ['sourceHash','candidateHash','dictHash','generatorPromptVersion','generatorPromptHash','reviewPromptVersion']) {
    if (proof && proof[key] !== binding[key]) return { ok: false, error: 'review proof binding drift: ' + key };
  }
  if (!proof || JSON.stringify(proof.modelSnapshot || {}) !== JSON.stringify(binding.modelSnapshot) || proof.state !== 'approved') {
    return { ok: false, error: 'review proof state/modelSnapshot 不匹配' };
  }
  const expectedIds = (units || []).map(unit => unit.id);
  const reviewCheck = PV2.validateReadabilityReview(proof.review, expectedIds);
  if (!reviewCheck.ok) return { ok: false, error: 'review proof coverage/approval 无效: ' + reviewCheck.errors.join('; ') };
  const proofHash = sha256Text(bytes);
  const caches = livePlainCacheFiles(cacheDir);
  if (!caches.length) return { ok: false, error: '没有 live v4 batch cache' };
  for (const name of caches) {
    let cache;
    try { cache = JSON.parse(fs.readFileSync(path.join(cacheDir, name), 'utf8')); }
    catch (e) { return { ok: false, error: name + ' 不可解析' }; }
    if (!cache || cache.v !== PLAIN_CACHE_VERSION || cache.promptVersion !== PLAIN_PROMPT_VERSION ||
        cache.approved !== true || cache.reviewProofHash !== proofHash) {
      return { ok: false, error: name + ' 尚未绑定 approved review proof' };
    }
  }
  return { ok: true, proof, proofHash };
}

async function reviewPlainUnits(cfg, units, initialResults, onLog, dict, opts) {
  opts = opts || {};
  onLog = typeof onLog === 'function' ? onLog : () => {};
  const PV2 = require('../scripts/plain-comprehension.js');
  const rc = opts.requestCompletion || requestCompletionNode;
  const cacheDir = opts.cacheDir || null;
  const results = initialResults instanceof Map ? new Map(initialResults) : new Map(Object.entries(initialResults || {}));
  const allIds = (units || []).map(unit => unit.id);
  const hard = checkPlainComprehensionItems(units, id => results.get(id), PV2.PROFILE_BODY);
  if (!hard.ok) throw new Error('[executor] R7 draft 硬不变量失败: ' + JSON.stringify(hard.issues.slice(0, 12)));

  const existingApproved = verifyApprovedPlainReviewProof(cacheDir, cfg, units, results, dict);
  if (existingApproved.ok) {
    onLog('[executor] R7 approved review proof 命中：跳过正文 reviewer/repair 模型');
    return { results, review: existingApproved.proof.review, proof: existingApproved.proof, changed: false, cachedApproved: true };
  }
  if (opts.requireApprovedProof) {
    throw new Error('[executor] r8-guide Resume 前置 R7 review proof 无效: ' + existingApproved.error);
  }

  let targetIds = allIds.slice();
  let repairCount = 0;
  let changed = false;
  const history = [];
  while (true) {
    const reviewPrompt = PV2.buildReadabilityReviewPrompt(units, id => results.get(id), dict, { targetIds });
    core.assertWithinContextLimit(reviewPrompt, 'R7 independent readability review');
    let raw;
    if (cfg && cfg.provider === 'mock' && !opts.requestCompletion) {
      raw = JSON.stringify({ approved: true, checkedIds: targetIds, issues: [] });
    } else {
      raw = await rc(cfg, [{ role: 'user', content: reviewPrompt }], {
        system: '你是 PLAIN 独立语义复核器。你与生成器职责分离，只依据原文、候选白话和有序上下文做 semanticEquivalent / zeroBackgroundReadable / naturalReadable / noLocatorDependency 判断。只输出严格 JSON。',
        codexRunner: opts.codexRunner
      });
    }
    let review;
    try { review = parsePlainReviewJson(raw); }
    catch (e) { throw new Error('[executor] R7 independent review JSON 无效: ' + e.message); }
    const validation = PV2.validateReadabilityReview(review, targetIds);
    const binding = plainReviewBinding(cfg, units, results, dict);
    const reviewRecord = {
      round: history.length + 1,
      targetIds: targetIds.slice(),
      reviewPromptHash: sha256Text(reviewPrompt),
      approved: review.approved === true,
      checkedIds: Array.isArray(review.checkedIds) ? review.checkedIds.slice() : [],
      issues: Array.isArray(review.issues) ? review.issues : [],
      valid: validation.valid === true,
      errors: validation.errors || []
    };
    history.push(reviewRecord);
    const interimProof = {
      v: 1,
      state: validation.ok ? 'review-passed' : (validation.valid ? 'review-failed' : 'invalid'),
      ...binding,
      reviewPromptHash: reviewRecord.reviewPromptHash,
      checkedIds: reviewRecord.checkedIds,
      review,
      history
    };
    writePlainReviewProof(cacheDir, interimProof);
    if (opts && typeof opts.onBatchCheckpoint === 'function') {
      await Promise.resolve(opts.onBatchCheckpoint({ phase: 'review', state: interimProof.state, targetIds: targetIds.slice(), cacheDir }));
    }
    // Durability barrier: review result is on disk (and Web callback, when present, has resolved)
    // before any next repair request can spend another model call.
    if (!validation.valid) {
      throw new Error('[executor] R7 independent review coverage/schema fail-close: ' + validation.errors.join('; '));
    }
    if (validation.ok) {
      const finalReview = { approved: true, checkedIds: allIds.slice(), issues: [] };
      const finalBinding = plainReviewBinding(cfg, units, results, dict);
      const finalProof = {
        v: 1,
        state: 'approved',
        ...finalBinding,
        reviewPromptHash: reviewRecord.reviewPromptHash,
        checkedIds: allIds.slice(),
        review: finalReview,
        history
      };
      const persisted = writePlainReviewProof(cacheDir, finalProof);
      const promoted = rewriteLivePlainCaches(cacheDir, results, true, persisted && persisted.sha256);
      if (opts && typeof opts.onBatchCheckpoint === 'function') {
        await Promise.resolve(opts.onBatchCheckpoint({ phase: 'approved', state: 'approved', approved: true, promotedBatches: promoted, cacheDir }));
      }
      onLog('[executor] R7 independent review APPROVED：checkedIds=' + allIds.length + '；promoted=' + promoted + ' batch');
      return { results, review: finalReview, proof: finalProof, changed, cachedApproved: false };
    }

    const failedIds = PV2.failedReviewIds(review, targetIds);
    if (!failedIds.length) throw new Error('[executor] R7 independent review 未批准但没有可定位失败 ID');
    if (repairCount >= core.MAX_RETRIES) {
      throw new Error('[executor] R7 independent review/repair 预算耗尽，仍失败: ' + failedIds.join(','));
    }
    const repairPrompt = PV2.buildReadabilityRepairPrompt(units, id => results.get(id), review, dict, { targetIds: failedIds });
    core.assertWithinContextLimit(repairPrompt, 'R7 readability targeted repair');
    if (repairCount > 0) {
      const delay = core.retryDelayMs(repairCount);
      onLog('[executor] R7 semantic repair 重试 ' + repairCount + '/' + core.MAX_RETRIES + ' · 退避 ' + delay + 'ms');
      await sleep(delay);
    }
    let repairRaw;
    if (cfg && cfg.provider === 'mock' && !opts.requestCompletion) {
      repairRaw = JSON.stringify({ units: failedIds.map(id => ({ id, text: results.get(id) })) });
    } else {
      repairRaw = await rc(cfg, [{ role: 'user', content: repairPrompt }], {
        system: '你是 PLAIN 定点语义修复器。只能修改指定失败 ID；其余上下文只读。保持事实与所有受保护 token，不要把 locator 写成机器说明书。只输出严格 units JSON。',
        codexRunner: opts.codexRunner
      });
    }
    const incoming = parseTranslateJson(repairRaw, failedIds);
    const before = new Map(results);
    for (const id of failedIds) results.set(id, incoming.get(id));
    for (const id of allIds) {
      if (!failedIds.includes(id) && results.get(id) !== before.get(id)) {
        throw new Error('[executor] R7 repair 越权改写已冻结 ID: ' + id);
      }
    }
    const repairedUnits = (units || []).filter(unit => failedIds.includes(unit.id));
    const repairedHard = checkPlainComprehensionItems(repairedUnits, id => results.get(id), PV2.PROFILE_BODY);
    if (!repairedHard.ok) throw new Error('[executor] R7 repair 硬不变量失败: ' + JSON.stringify(repairedHard.issues.slice(0, 8)));
    rewriteLivePlainCaches(cacheDir, results, false, null);
    if (opts && typeof opts.onBatchCheckpoint === 'function') {
      await Promise.resolve(opts.onBatchCheckpoint({ phase: 'repair-draft', state: 'draft', targetIds: failedIds.slice(), cacheDir }));
    }
    targetIds = failedIds;
    repairCount++;
    changed = true;
  }
}

function checkPlainComprehensionHtml(origHtml, plainHtml) {
  const PL = require('../scripts/plain-language.js');
  const PV2 = require('../scripts/plain-comprehension.js');
  const origAll = PL.extractUnits(PL.parseHtml(origHtml));
  const plainAll = PL.extractUnits(PL.parseHtml(plainHtml));
  if (origAll.length !== plainAll.length) return { ok: false, issues: [{ id: '*', issues: [{ code: 'unit-count', message: '原文/白话文本单元数量不一致' }] }] };
  const origUnits = origAll.filter(u => PL.classifyUnit(u) === 'translate');
  annotatePlainComprehensionRequirements(origUnits, PV2.PROFILE_BODY);
  const plainById = new Map(plainAll.map(u => [u.id, u.text]));
  return checkPlainComprehensionItems(origUnits, id => plainById.get(id) || '', PV2.PROFILE_BODY);
}

// R7 白话层收口：纯白话版（report-plain.html）+ 双版本合并（report.html）
// 外部门禁：checkHtml(final) + checkVerdictConsistency；合并后复跑 checkHtml。
// opts = { cache }（S5：默认 true → 断点缓存目录 = workDir；false → 全量重译）
async function applyPlain(workDir, cfg, onLog, extraDictPath, opts) {
  const PL = require('../scripts/plain-language.js');
  const PC = require('../pipeline-controller.js');
  const RR = require('../render-report.js');
  const cacheDir = opts && opts.cacheDir
    ? path.resolve(String(opts.cacheDir))
    : (!opts || opts.cache !== false ? workDir : null);
  if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true });
  const report = path.join(workDir, 'report.html');
  const html = fs.readFileSync(report, 'utf-8');
  const adjData = path.join(workDir, '.tmp-adjudicated-data.md');
  const dataSrc = fs.existsSync(adjData) ? adjData : path.join(workDir, 'transition-final.md');
  const topic = (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
  const data = PC.extractDataMarkers(fs.readFileSync(dataSrc, 'utf-8'));
  const dict = loadPlainDict(workDir, extraDictPath);
  onLog('[executor] R7 字典加载：' + Object.keys(dict).length + ' 词条' + (extraDictPath ? '（含外部 --plain-dict）' : '（核心 PLAIN_DICT）'));
  const legacyV3 = !!(opts && opts.legacyV3);
  let reviewUnits = [];
  let draftResults = null;
  const translateDraft = async units => {
    const PV2 = require('../scripts/plain-comprehension.js');
    annotatePlainComprehensionRequirements(units, PV2.PROFILE_BODY);
    reviewUnits = units.map(unit => ({ ...unit, path: Array.isArray(unit.path) ? unit.path.slice() : unit.path }));
    if (cfg.provider === 'mock' && !legacyV3) {
      draftResults = new Map(units.map(unit => [unit.id, unit.text + '（白话）']));
      return draftResults;
    }
    draftResults = await translateUnitsLLM(cfg, units, onLog, dict, {
      cacheDir,
      legacyV3,
      comprehensionProfile: PV2.PROFILE_BODY,
      onBatchCheckpoint: opts && opts.onBatchCheckpoint,
      requireCacheHit: !!(opts && opts.requireCacheHit),
      requestCompletion: opts && opts.requestCompletion,
      codexRunner: opts && opts.codexRunner
    });
    return draftResults;
  };
  let res = await PL.processReportAsync(html, {
    strictIdentity: false,
    context: { topic },
    dict,
    translateUnits: translateDraft
  });

  if (legacyV3) {
    // A4 compatibility lane only: retain the historical exact first-gloss contract for no-model refresh.
    const semantic = PL.checkSemanticPlain(html, res.html, dict);
    if (!semantic.ok) {
      throw new Error('[executor] legacy-v3 白话产物语义门禁失败：首次术语解释缺失 ' +
        semantic.missing.map(x => x.term + '@' + x.unitId).join(','));
    }
  } else {
    if (!(draftResults instanceof Map) || !reviewUnits.length) throw new Error('[executor] R7 未获得可复核的完整 draft 单元序列');
    const reviewed = await reviewPlainUnits(cfg, reviewUnits, draftResults, onLog, dict, {
      cacheDir,
      requestCompletion: opts && opts.requestCompletion,
      codexRunner: opts && opts.codexRunner,
      onBatchCheckpoint: opts && opts.onBatchCheckpoint,
      requireApprovedProof: !!(opts && opts.requireCacheHit)
    });
    draftResults = reviewed.results;
    if (reviewed.changed) {
      // Repair output scope is targeted, but final DOM is rebuilt mechanically from the original
      // document so all non-target units stay byte-identical to the last approved draft.
      res = await PL.processReportAsync(html, {
        strictIdentity: false,
        context: { topic },
        dict,
        translateUnits: async units => {
          const expected = units.map(unit => unit.id);
          const missing = expected.filter(id => !draftResults.has(id));
          if (missing.length) throw new Error('[executor] R7 repair 合并后缺失 ID: ' + missing.slice(0, 5).join(','));
          return draftResults;
        }
      });
    }
  }

  // Final mechanical safety remains fail-close. Semantic readability is already represented by
  // the independent review proof above, never by text-node regex heuristics.
  const comprehension = checkPlainComprehensionHtml(html, res.html);
  if (!comprehension.ok) {
    throw new Error('[executor] PLAIN 白话产物硬不变量失败：' + JSON.stringify(comprehension.issues.slice(0, 12)));
  }
  const plainFile = path.join(workDir, 'report-plain.html');
  // 源锚层 v1（E-2）：免责横幅 fixed 保护双保险——白话产物必须逐字保留 DISCLAIMER_TEXT，缺失 → BLOCKING
  if (readAnchor(workDir) && readAnchor(workDir).disclaimer === true) {
    const HC4 = require('../scripts/html-contract.js');
    if (!res.html.includes(HC4.DISCLAIMER_TEXT))
      throw new Error('[executor] 白话产物 BLOCKING：免责横幅（DISCLAIMER_TEXT）被改写/删除——fixed 单元保护失效');
  }
  fs.writeFileSync(plainFile, res.html, 'utf-8');
  const hv = PC.checkHtml(plainFile, { stage: 'final', skillPath: resolveSkillPath(), dataSource: dataSrc });
  if (hv.blocking && hv.blocking.length)
    throw new Error('[executor] 白话版 checkHtml 失败: ' + hv.blocking.map(b => b.message).join('; '));
  const vc = PC.checkVerdictConsistency(res.html, data);
  if (!vc.passed)
    throw new Error('[executor] 白话版判决一致性校验失败: ' + vc.errors.map(e => e.message).join('; '));
  const drift = PL.checkPlainContract(res.html);
  if (drift.warnings.length) onLog('[executor] R7 结构契约漂移告警（白话版）: ' + drift.warnings.join('; '));
  const merged = PL.mergePlainIntoOriginal(html, res.html);
  const final = RR.injectPlainToggle(merged);
  fs.writeFileSync(report, final, 'utf-8');
  const hv2 = PC.checkHtml(report, { stage: 'final', skillPath: resolveSkillPath(), dataSource: dataSrc });
  if (hv2.blocking && hv2.blocking.length)
    throw new Error('[executor] 双版本 report.html 校验失败: ' + hv2.blocking.map(b => b.message).join('; '));
  const drift2 = PL.checkPlainContract(final);
  if (drift2.warnings.length) onLog('[executor] R7 结构契约漂移告警（双版本）: ' + drift2.warnings.join('; '));
  onLog('[executor] R7 白话层完成：report.html（双版本）+ report-plain.html（纯白话，' +
    res.units.length + ' 单元 / ' + res.stats.translatable + ' 可译 / 覆盖率 ' + res.stats.coverage.coveragePct + '%）');
}

// 历史记录“重新出报告”专用窄 seam：只消费已经正式批准的 PLAIN-V4 产物，
// 纯机械重建双版本 report.html。接口故意不暴露 requestCompletion/codexRunner；任何 cache/proof
// 缺失或漂移直接 fail-close，绝不回退调用模型，也不改 report-plain/cache/proof。
async function rebuildApprovedPlainReport(workDir, cfg, extraDictPath) {
  const PL = require('../scripts/plain-language.js');
  const PV2 = require('../scripts/plain-comprehension.js');
  const PC = require('../pipeline-controller.js');
  const RR = require('../render-report.js');
  const reportPath = path.join(workDir, 'report.html');
  const plainPath = path.join(workDir, 'report-plain.html');
  if (!fs.existsSync(reportPath)) throw new Error('[executor] 历史 PLAIN 重建缺少 R6 基础 report.html');
  if (!fs.existsSync(plainPath)) throw new Error('[executor] 历史 PLAIN 重建缺少正式 report-plain.html');

  const baseHtml = fs.readFileSync(reportPath, 'utf8');
  const formalPlain = fs.readFileSync(plainPath, 'utf8');
  const adjData = path.join(workDir, '.tmp-adjudicated-data.md');
  const dataSrc = fs.existsSync(adjData) ? adjData : path.join(workDir, 'transition-final.md');
  if (!fs.existsSync(dataSrc)) throw new Error('[executor] 历史 PLAIN 重建缺少正式裁决数据源');
  const data = PC.extractDataMarkers(fs.readFileSync(dataSrc, 'utf8'));
  const dict = loadPlainDict(workDir, extraDictPath || null);
  const topic = (baseHtml.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
  let reviewUnits = [];
  let cacheResults = null;
  let fuseCalls = 0;
  const noModelFuse = async () => {
    fuseCalls++;
    throw new Error('[executor] 历史 PLAIN 重建 0-API 保险丝触发：禁止模型请求');
  };

  const replay = await PL.processReportAsync(baseHtml, {
    strictIdentity: false,
    context: { topic },
    dict,
    translateUnits: async units => {
      annotatePlainComprehensionRequirements(units, PV2.PROFILE_BODY);
      reviewUnits = units.map(unit => ({ ...unit, path: Array.isArray(unit.path) ? unit.path.slice() : unit.path }));
      cacheResults = await translateUnitsLLM(cfg, units, () => {}, dict, {
        cacheDir: workDir,
        legacyV3: false,
        comprehensionProfile: PV2.PROFILE_BODY,
        requireCacheHit: true,
        requestCompletion: noModelFuse
      });
      return cacheResults;
    }
  });
  if (fuseCalls) throw new Error('[executor] 历史 PLAIN 重建违反 0-API 合同');
  if (!(cacheResults instanceof Map) || !reviewUnits.length) throw new Error('[executor] 历史 PLAIN 重建未取得完整 approved cache');
  if (replay.html !== formalPlain) {
    throw new Error('[executor] 历史 PLAIN 重建阻断：正式 report-plain.html 与 approved cache 机械重放不一致');
  }

  await reviewPlainUnits(cfg, reviewUnits, cacheResults, () => {}, dict, {
    cacheDir: workDir,
    requestCompletion: noModelFuse,
    requireApprovedProof: true
  });
  if (fuseCalls) throw new Error('[executor] 历史 PLAIN 重建违反 0-API 合同');

  const compare = PL.compareVersions(baseHtml, formalPlain);
  if (!compare.ok) throw new Error('[executor] 历史 PLAIN 重建双版本结构/白名单校验失败');
  const comprehension = checkPlainComprehensionHtml(baseHtml, formalPlain);
  if (!comprehension.ok) throw new Error('[executor] 历史 PLAIN 重建硬不变量失败: ' + JSON.stringify(comprehension.issues.slice(0, 12)));
  const hv = PC.checkHtml(plainPath, { stage: 'final', skillPath: resolveSkillPath(), dataSource: dataSrc });
  if (hv.blocking && hv.blocking.length) throw new Error('[executor] 历史 PLAIN 正式 report-plain.html 合同失败: ' + hv.blocking.map(x => x.message).join('; '));
  const vc = PC.checkVerdictConsistency(formalPlain, data);
  if (!vc.passed) throw new Error('[executor] 历史 PLAIN 判决一致性失败: ' + vc.errors.map(x => x.message).join('; '));

  const merged = PL.mergePlainIntoOriginal(baseHtml, formalPlain);
  const finalHtml = RR.injectPlainToggle(merged);
  fs.writeFileSync(reportPath, finalHtml, 'utf8');
  try {
    const hv2 = PC.checkHtml(reportPath, { stage: 'final', skillPath: resolveSkillPath(), dataSource: dataSrc });
    if (hv2.blocking && hv2.blocking.length) throw new Error(hv2.blocking.map(x => x.message).join('; '));
  } catch (e) {
    fs.writeFileSync(reportPath, baseHtml, 'utf8');
    throw new Error('[executor] 历史 PLAIN 双版本主报告合同失败: ' + (e && e.message ? e.message : e));
  }
  return { reportPath, plainPath };
}

// P6：数据契约注入——每一轮声称要读的数据源必须内联进 prompt（幂等标记防断点续跑重复追加）
const DATA_SOURCE_MARK = '<!-- DATA_SOURCE_INJECTED -->';
const R25_CP_WHITELIST_MARK = '<!-- R2.5_CP_WHITELIST_INJECTED -->';
const R5A_STRUCTURE_SOURCE_MARK = '<!-- R5A_STRUCTURE_SOURCE_INJECTED -->';
const R5A_POEM_GUIDANCE_MARK = '<!-- R5A_C1_POEM_GUIDANCE_INJECTED -->';

function resolveSkillPath() {
  const candidates = [
    path.join(__dirname, '..', 'Skill-Judge.md'),
    path.join(process.cwd(), 'Skill-Judge.md')
  ];
  return candidates.find(p => fs.existsSync(p)) || candidates[0];
}

function injectDataSource(workDir, promptFile, sectionTitle, sourceFile, onLog) {
  const p = path.join(workDir, promptFile);
  // A8-P7：全量运行保障——prompt 或数据源缺失即阻断，禁止无数据运行
  if (!fs.existsSync(p)) throw new Error('[executor] 数据注入失败: prompt 文件缺失 ' + promptFile + '——禁止无数据运行。');
  if (!fs.existsSync(sourceFile)) throw new Error('[executor] 数据注入失败: 数据源缺失 ' + sourceFile + '（注入 ' + promptFile + '）——禁止裁剪/降级，请补全后重跑。');
  let text = fs.readFileSync(p, 'utf-8');
  if (text.includes(DATA_SOURCE_MARK)) {
    onLog('[executor] ' + promptFile + ' 已注入数据源（幂等跳过）');
    return true;
  }
  const data = fs.readFileSync(sourceFile, 'utf-8');
  text += '\n\n---\n\n## ' + sectionTitle + '\n\n' + DATA_SOURCE_MARK + '\n\n' + data + '\n';
  fs.writeFileSync(p, text, 'utf-8');
  assertPromptsWithinContext(workDir, undefined, onLog);  // A8-P7：注入后立即超限预检
  onLog('[executor] ' + promptFile + ' 已注入 ' + sourceFile + ' (' + data.length + '字)');
  return true;
}

// A8-P7：上下文超限预检——逐 prompt 文件估算 tokens，超过上限即抛错停止（禁止裁剪/降级）
function assertPromptsWithinContext(workDir, limitTokens, onLog) {
  const limit = parseInt(limitTokens, 10) > 0 ? parseInt(limitTokens, 10)
    : (parseInt(process.env.EXECUTOR_CONTEXT_LIMIT_TOKENS, 10) > 0 ? parseInt(process.env.EXECUTOR_CONTEXT_LIMIT_TOKENS, 10) : core.DEFAULT_CONTEXT_LIMIT_TOKENS);
  for (const round of core.ROUNDS) {
    const p = path.join(workDir, round.promptFile);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf-8');
    core.assertWithinContextLimit(text, round.promptFile, limit);
  }
  if (onLog) onLog('[executor] 上下文预检通过（limit=' + limit + ' tokens · 全量注入）');
}

function buildR25Prompt(workDir, onLog) {
  const PC = require('../pipeline-controller.js');
  // 260811 批甲 D：P1 全文注入 → S5 切片（消除模板污染源；S5 段实测 DATA 标记=0，纯正文）
  const p = path.join(workDir, '.tmp-R2.5-prompt.md');
  if (!fs.existsSync(p)) throw new Error('[executor] 数据注入失败: prompt 文件缺失 .tmp-R2.5-prompt.md——禁止无数据运行。');
  let text = fs.readFileSync(p, 'utf-8');
  if (text.includes(DATA_SOURCE_MARK) && text.includes(R25_CP_WHITELIST_MARK)) {
    onLog('[executor] .tmp-R2.5-prompt.md 已注入 S5 切片及 CP 白名单（幂等跳过）');
    return;
  }
  const p1 = readIfExists(path.join(workDir, 'P1.md'));
  const additions = [];
  if (!text.includes(DATA_SOURCE_MARK)) {
    const s5 = PC.sectionOfStep(p1, 5) || '（S5 段缺失）';
    additions.push('## 前置数据 P1 S5 段（R2.5 必读 · 因向/果向象限）\n\n' + DATA_SOURCE_MARK + '\n\n' + s5);
    onLog('[executor] R2.5 prompt 已注入 P1 S5 切片 (' + s5.length + '字)');
  }
  if (!text.includes(R25_CP_WHITELIST_MARK)) {
    const data = PC.extractDataMarkers(p1 || '');
    const cpIds = String(data['S7.CP入选列表'] || '')
      .split(/[|,，]/)
      .map(id => id.trim())
      .filter(id => /^CP-\d+$/.test(id));
    const whitelist = cpIds.length ? cpIds.join('|') : '（无可用 CP-ID 白名单）';
    additions.push('## R2.5 合法 CP-ID 白名单（P1 S7 回引 · 仅可使用下列 ID）\n\n' +
      R25_CP_WHITELIST_MARK + '\n\n' + whitelist +
      '\n\n**硬约束**：C8 的每个回引必须逐字取自上述白名单；白名单为空时禁止臆造任何 CP-ID。');
    onLog('[executor] R2.5 prompt 已注入 P1 S7 CP 白名单 (' + (cpIds.length ? cpIds.join('|') : '空') + ')');
  }
  if (additions.length) fs.writeFileSync(p, text + '\n\n---\n\n' + additions.join('\n\n---\n\n') + '\n', 'utf-8');
}

// 260813 P1批 B2（S2）：R2 prompt 注入 P1 五段（S2+S3+S4+S5+S7）——P6 原则（R2 prompt 声明读取集：
// S2.SC容量预判/S2.预判SC方向/S3交锋注册/S4.包着打联动/S5 因向果向/S7 SC过程角色+穿透度）
// 五段必须一次拼接为同一注入块后追加（单 DATA_SOURCE_MARK 早退语义——分次 append 会丢失后续段）；
// 缺失段镜像 buildR25Prompt「（Sx 段缺失）」兜底模式；注入节标题带「追迹判定以辩词原文为准」定位语
function buildR2Prompt(workDir, onLog) {
  const PC = require('../pipeline-controller.js');
  const p = path.join(workDir, '.tmp-R2-prompt.md');
  if (!fs.existsSync(p)) throw new Error('[executor] 数据注入失败: prompt 文件缺失 .tmp-R2-prompt.md——禁止无数据运行。');
  let text = fs.readFileSync(p, 'utf-8');
  if (text.includes(DATA_SOURCE_MARK)) {
    onLog('[executor] .tmp-R2-prompt.md 已注入 P1 五段（幂等跳过）');
    return;
  }
  const p1 = readIfExists(path.join(workDir, 'P1.md'));
  const sectionNums = [2, 3, 4, 5, 7];
  const block = sectionNums.map(n => {
    const s = PC.sectionOfStep(p1, n);
    return '### P1 S' + n + ' 段（R2 必读）\n\n' + (s || '（S' + n + ' 段缺失）') + '\n';
  }).join('\n');
  text += '\n\n---\n\n## 前置数据 P1 五段（R2 必读 · 追迹判定以辩词原文为准）\n\n' + DATA_SOURCE_MARK + '\n\n' + block + '\n';
  fs.writeFileSync(p, text, 'utf-8');
  assertPromptsWithinContext(workDir, undefined, onLog);  // A8-P7：注入后立即超限预检
  onLog('[executor] R2 prompt 已注入 P1 五段切片 (' + block.length + '字)');
}

function buildR4Prompt(workDir, onLog) {
  injectDataSource(workDir, '.tmp-R4-prompt.md', '前置数据 P2（R4 必读 · S8 Phase + S17.1/S17.2 节点表）', path.join(workDir, 'P2.md'), onLog);
  // T1：注入 R3 终判的 S11.类型 权威值——R4 的 meta.s11_original_type 必须照抄，禁止自行推断（根治 G0-1 重试）
  const p = path.join(workDir, '.tmp-R4-prompt.md');
  if (!fs.existsSync(p)) return;
  let text = fs.readFileSync(p, 'utf-8');
  const MARK = '<!-- S11_AUTHORITY_INJECTED -->';
  if (text.includes(MARK)) {
    const idx = text.indexOf(MARK);
    const segStart = text.lastIndexOf('\n\n---\n\n## ⛔ 主线类型权威值', idx);
    text = segStart >= 0 ? text.slice(0, segStart) : text.slice(0, idx);
  }
  const tf = readIfExists(path.join(workDir, 'transition-final.md'));
  const m = tf.match(/<!--DATA:\s*S11\.类型=([^ \n]+)\s*-->/);
  const authority = m ? '<!--DATA: S11.类型=' + m[1] + ' -->' : '（transition-final 中未找到 S11.类型）';
  text += '\n\n---\n\n## ⛔ 主线类型权威值（R3 终判 · R4 必须照抄）\n\n' + MARK + '\n\n' + authority +
    '\n\n**要求**：`meta.s11_original_type` 必须逐字等于上述值；禁止自行推断或使用其它来源；不一致 = 整轮重跑。\n';
  fs.writeFileSync(p, text, 'utf-8');
  onLog('[executor] R4 prompt 已注入 S11.类型权威值');
}

function enrichR5Prompts(workDir, onLog) {
  const full = path.join(workDir, 'full-data.md');
  injectDataSource(workDir, '.tmp-R5-A-prompt.md', '完整过渡文件 full-data.md（R5-A 唯一数据源）', full, onLog);
  injectDataSource(workDir, '.tmp-R5-B-prompt.md', '完整过渡文件 full-data.md（R5-B 唯一数据源）', full, onLog);
  const r5aPath = path.join(workDir, '.tmp-R5-A-prompt.md');
  const structurePath = path.join(workDir, 'structure.json');
  if (!fs.existsSync(structurePath)) {
    throw new Error('[executor] R5-A prompt 注入失败: structure.json 缺失——C3 禁止降级或从 full-data 猜测。');
  }
  let r5a = fs.readFileSync(r5aPath, 'utf-8');
  const additions = [];
  if (!r5a.includes(R5A_STRUCTURE_SOURCE_MARK)) {
    const structure = fs.readFileSync(structurePath, 'utf-8');
    additions.push('## 前置数据 structure.json（R5-A C3 必读 · 仅以此文件为结构归约源）\n\n' +
      R5A_STRUCTURE_SOURCE_MARK + '\n\n```json\n' + structure + '\n```');
  }
  if (!r5a.includes(R5A_POEM_GUIDANCE_MARK)) {
    additions.push('## R5-A C1_01_POEM 局部格式硬约束（输出前必查）\n\n' +
      R5A_POEM_GUIDANCE_MARK + '\n\n' +
      '- C1_01_POEM 必须输出四句直接可见的纯 Markdown/纯文本诗句，每句单独一行。\n' +
      '- “居中”只表示四句分别独立成行；禁止用任何 HTML/CSS/SVG 标签或属性，尤其禁止 `<p align>`、`<div>`、`<span>`、`<br>`。\n' +
      '- 禁止代码围栏；`<!--INSERT_C1_01_POEM-->` 必须原样保留，诗句直接写在其后。');
  }
  if (additions.length) {
    r5a += '\n\n---\n\n' + additions.join('\n\n---\n\n') + '\n';
    fs.writeFileSync(r5aPath, r5a, 'utf-8');
    assertPromptsWithinContext(workDir, undefined, onLog);
    onLog('[executor] R5-A prompt 已注入 structure.json 与 C1 纯 Markdown 约束');
  }
}

// 3B：R4.5 输入汇总表（全量 DATA + structure 摘要 + 冲突 + 警告 + 倾向）
function buildAdjudicationInput(workDir, onLog, strictAuthority) {
  const PC = require('../pipeline-controller.js');
  const tf = readIfExists(path.join(workDir, 'transition-final.md'));
  const st = readIfExists(path.join(workDir, 'structure.json'));
  // formal real 才把 structure/conflicts 作为 canonical authority；mock/CI 仅验证编排接线，不把占位结构冒充正式语义源。
  const stObj = (() => { try { return PC.parseStructureJson(st); } catch (e) { return null; } })();
  let conflicts;
  if (strictAuthority) {
    if (!stObj) throw new Error('[executor] R4.5 输入构建失败: structure.json 缺失或解析失败——禁止把结构权威降级为空冲突');
    try {
      const rebuilt = PC.diffConflicts(PC.aggregateData(path.join(workDir, 'transition-final.md')), stObj);
      conflicts = JSON.stringify(rebuilt, null, 2);
      fs.writeFileSync(path.join(workDir, '.tmp-conflicts.json'), conflicts, 'utf-8');
    } catch (e) {
      throw new Error('[executor] R4.5 机械冲突登记构建失败——禁止沿用旧登记表或假定无冲突: ' + e.message);
    }
  } else {
    if (stObj) {
      try {
        const rebuilt = PC.diffConflicts(PC.aggregateData(path.join(workDir, 'transition-final.md')), stObj);
        conflicts = JSON.stringify(rebuilt, null, 2);
      } catch (e) { conflicts = '[]'; }
    } else conflicts = '[]';
    fs.writeFileSync(path.join(workDir, '.tmp-conflicts.json'), conflicts, 'utf-8');
  }
  const warnings = readIfExists(path.join(workDir, '.tmp-validate-warnings.json'));
  let summary = '# R4.5 输入汇总表\n\n## 1) 全量 DATA（transition-final）\n';
  const data = PC.extractDataMarkers(tf);
  for (const [k, v] of Object.entries(data)) summary += '- `' + k + '=' + v + '`\n';
  summary += '\n## 2) structure 摘要\n';
  if (stObj) {
    summary += '- layers=' + (stObj.layers || []).length +
      ' nodes=' + (stObj.layers || []).reduce((a, l) => a + (l.nodes || []).length, 0) + '\n';
    summary += '- meta=' + JSON.stringify(stObj.meta || {}) + '\n';
  } else {
    summary += '- structure 解析失败或缺失\n';
  }
  summary += '\n## 3) 机械冲突登记（.tmp-conflicts.json）\n' + (conflicts === '[]' ? '（无）' : conflicts) + '\n';
  summary += '\n## 4) 机械警告登记（.tmp-validate-warnings.json）\n' + (warnings || '（无）') + '\n';
  summary += '\n## 5) 评委倾向（只读）\n（以管道参数为准，未提供则中立）\n';
  fs.writeFileSync(path.join(workDir, '.tmp-r45-input.md'), summary, 'utf-8');
  onLog('[executor] R4.5 输入汇总表 → .tmp-r45-input.md (' + summary.length + '字)');
}

// 3B：机械复核（合并裁决后 validate/checkStructure/diffConflicts；残留冲突 = 阻断）
function adjudicationRecheck(workDir, adj, registryConflicts) {
  const PC = require('../pipeline-controller.js');
  const tfPath = path.join(workDir, 'transition-final.md');
  const stPath = path.join(workDir, 'structure.json');
  if (!fs.existsSync(tfPath) || !fs.existsSync(stPath))
    return { passed: false, errors: ['复核缺少 transition-final.md 或 structure.json'] };
  const merged = PC.mergeAdjudicationData(fs.readFileSync(tfPath, 'utf-8'), adj);
  const mergedTfPath = path.join(workDir, '.tmp-adjudicated-data.md');
  fs.writeFileSync(mergedTfPath, merged, 'utf-8');
  // 批 4（260812）：structure.json 容错解析（与 R4 门禁 checkStructure 同链）——
  // R4 产物可含 ```json 围栏（门禁容错通过），裸 JSON.parse 同族崩溃；失败 → 结构化 recheck 失败（门禁重试）
  const stParsed = parseAdjArtifact(fs.readFileSync(stPath, 'utf-8'));
  if (!stParsed.ok) {
    return { passed: false, errors: ['复核 structure.json 解析失败: ' + stParsed.error] };
  }
  const mergedSt = PC.mergeStructureOverride(stParsed.obj, adj);
  const mergedStPath = path.join(workDir, '.tmp-adjudicated-structure.json');
  fs.writeFileSync(mergedStPath, JSON.stringify(mergedSt, null, 2), 'utf-8');
  // 批甲 F5：excluded 由「登记表 ∩ adjudicated」推导（ADJ-14 已保证 adj.conflicts ⊆ 登记表，双保险）
  const regDims = new Set((registryConflicts || []).map(r => r.dimension));
  const adjDims = (adj.conflicts || []).filter(c => c.adjudicated && regDims.has(c.dimension)).map(c => c.dimension);
  const adjInfo = (adj.conflicts || []).filter(c => c.adjudicated).map(c => ({ dimension: c.dimension, adjudicated: c.adjudicated, pair: c.pair }));
  const v = PC.validate(merged, 'R3', { final: true, adjudicatedDims: adjDims, adjudicatedDimsInfo: adjInfo });
  if (!v.passed)
    return { passed: false, errors: ['复核 validate 失败: ' + v.blocking.map(e => e.message).join('; ')] };
  const cs = PC.checkStructure(mergedStPath, { tfPath: mergedTfPath });
  if (!cs.passed)
    return { passed: false, errors: ['复核 structure 失败: ' + cs.errors.filter(e => e.severity === 'BLOCKING').map(e => e.message).join('; ')] };
  const conflicts = PC.diffConflicts(PC.aggregateData(mergedTfPath), mergedSt, { excluded: adjDims });
  if (conflicts.length > 0)
    return { passed: false, errors: ['复核后仍存在 ' + conflicts.length + ' 条冲突: ' + conflicts.map(c => c.dimension).join('; ')] };
  adj.audit = Object.assign({}, adj.audit, {
    merged_validate: { passed: true, blocking: 0 },
    post_diff_conflicts: 0,
    structure_check: { passed: true }
  });
  // 批甲 R7e：已裁决维度状态持久化（try/catch 缺省保护——F1 后文件恒存在，本分支仅防御损坏）
  try {
    const cfPath = path.join(workDir, '.tmp-conflicts.json');
    if (fs.existsSync(cfPath)) {
      const cf = JSON.parse(fs.readFileSync(cfPath, 'utf-8'));
      const dims = new Set((adj.conflicts || []).filter(c => c.adjudicated).map(c => c.dimension));
      let changed = false;
      for (const item of cf) if (dims.has(item.dimension) && item.status !== '已裁决') { item.status = '已裁决'; changed = true; }
      if (changed) fs.writeFileSync(cfPath, JSON.stringify(cf, null, 2));
    }
  } catch (e) {}
  fs.writeFileSync(path.join(workDir, 'adjudication.json'), JSON.stringify(adj, null, 2), 'utf-8');
  fs.writeFileSync(path.join(workDir, '.tmp-adjudication.json'), JSON.stringify(adj, null, 2), 'utf-8');
  return { passed: true, errors: [] };
}

const ADJUDICATION_INJECT_MARK = '<!-- ADJUDICATION_INJECTED -->';
// 批 4（260812）：R4.5/结构 JSON 产物解析器——门禁/消费同链（单一事实源）
// 与 validateRound R4.5 分支（JSON.parse → parseStructureJson 兜底）语义一致；
// parseStructureJson 的 normalizeStructureIds 为键白名单驱动（m_ids/m_id/from_m/to_m/citation_basis/evidence），
// 对 adjudication 的 conflicts/authoritative/meta/audit 逐字节零改写（260812 两路审计探针实证）。
// 返回 { ok:true, obj } 或 { ok:false, error }（不 throw，调用方决定处置）
function parseAdjArtifact(text) {
  const PC = require('../pipeline-controller.js');   // 延迟 require（防循环依赖，与 validateRound 同款）
  try { return { ok: true, obj: JSON.parse(text) }; }
  catch (e) {
    try { return { ok: true, obj: PC.parseStructureJson(text) }; }
    catch (e2) { return { ok: false, error: 'JSON 解析失败: ' + e.message }; }
  }
}
// 3B：把裁决表权威值幂等注入 R5-A/R5-B prompt（R4.5 通过后调用；重跑时先删旧段）
function injectAdjudication(workDir, onLog, strictAuthority = true) {
  const adjPath = path.join(workDir, 'adjudication.json');
  if (!fs.existsSync(adjPath)) {
    if (strictAuthority) throw new Error('[executor] adjudication.json 缺失——R4.5 已通过后禁止按“无裁决”继续');
    onLog('[executor] adjudication.json 缺失——mock/CI 裁决注入降级跳过（非正式语义路径）');
    return;
  }
  const parsed = parseAdjArtifact(fs.readFileSync(adjPath, 'utf-8'));
  if (!parsed.ok) {
    if (strictAuthority) throw new Error('[executor] adjudication.json 解析失败——canonical 裁决权威损坏，禁止进入 R5: ' + parsed.error);
    onLog('[executor] adjudication.json 解析失败——mock/CI 裁决注入降级跳过（非正式语义路径）: ' + parsed.error);
    return;
  }
  const adj = parsed.obj;
  const auth = Object.entries(adj.authoritative || {})
    .map(([k, val]) => '<!--DATA: ' + k + '=' + val + ' -->').join('\n');
  const conflictsText = (adj.conflicts || [])
    .map(c => '- ' + c.conflict_id + ' ' + c.dimension + ' → ' + c.adjudicated + '（' + c.confidence + '）').join('\n') || '（无）';
  const block = '\n\n---\n\n## ⛔ 裁决表权威值（R4.5 · 字段冲突时以本段为准）\n\n' + ADJUDICATION_INJECT_MARK + '\n\n' +
    (auth ? '**authoritative DATA：**\n' + auth + '\n\n' : '**authoritative：无**\n\n') +
    '**裁决记录：**\n' + conflictsText + '\n';
  for (const pf of ['.tmp-R5-A-prompt.md', '.tmp-R5-B-prompt.md']) {
    const p = path.join(workDir, pf);
    if (!fs.existsSync(p)) continue;
    let text = fs.readFileSync(p, 'utf-8');
    const idx = text.indexOf(ADJUDICATION_INJECT_MARK);
    if (idx >= 0) {
      const segStart = text.lastIndexOf('\n\n---\n\n## ⛔ 裁决表权威值', idx);
      text = segStart >= 0 ? text.slice(0, segStart) : text.slice(0, idx);
    }
    text += block;
    fs.writeFileSync(p, text, 'utf-8');
    onLog('[executor] ' + pf + ' 已注入裁决表权威值');
  }
}

// 全管道执行：R1 → R2 ∥ R2.5 → R3 → R4 → [聚合] → R5A ∥ R5B → [拼接] → R6a → R6b
async function runPipeline(opts) {
  const workDir = opts.workDir;
  const cfg = opts.cfg;
  const onLog = opts.onLog || (() => {});
  const realValidate = opts.realValidate !== false && cfg.provider !== 'mock';   // mock 仅链路冒烟，跳过真实校验
  let sourceAnchorExemptions = [];
  // 源锚层 v1（E-3）：启动阶段统一挂载名册抽取（resume/new-dir 两路径均经此处）——
  // .tmp-debate.txt 缺失 → 显式降级登记不崩溃（mock/非标准入口）；存在 → 抽取 + 确认暂停
  const debatePath = path.join(workDir, '.tmp-debate.txt');
  if (fs.existsSync(debatePath)) {
    // 260813 P1批 B4（S4-5）：空辩词/过短辩词预检——trim 后 <20 字直接 BLOCKING 早失败（浪费轮次守卫）
    const debateText = fs.readFileSync(debatePath, 'utf-8');
    if (debateText.trim().length < 20) {
      onLog('[executor] 辩词过短（trim 后 ' + debateText.trim().length + ' 字 < 20）——空/占位辩词禁止进入管道');
      return { ok: false, results: [{ round: 'SOURCE-ANCHOR', ok: false, errors: ['辩词过短（trim 后 <20 字）——空/占位辩词禁止进入管道'] }] };
    }
    const PC = require('../pipeline-controller.js');
    // B1（260809）：合并旧锚人工 aliases，防重抽覆盖人工编辑
    const old = readAnchor(workDir);
    const anchor = PC.mergeRosterAliases(PC.extractSourceAnchor(debateText), old);
    fs.writeFileSync(path.join(workDir, 'source-anchor.json'), JSON.stringify(anchor, null, 2), 'utf-8');
    try {
      sourceAnchorExemptions = loadSourceAnchorExemptions(workDir, anchor, { force: !!opts.force });
      if (sourceAnchorExemptions.length) onLog('[executor] source-anchor 人工豁免 checkpoint 预检通过：' + sourceAnchorExemptions.length + ' 条');
    } catch (e) {
      onLog('[executor] ' + e.message);
      return { ok: false, results: [{ round: 'SOURCE-ANCHOR-EXEMPTION', ok: false, errors: [e.message] }] };
    }
    // H-1：mock/CI 属自动化语义——自动跳过名册确认（等效 --skip-roster-confirm），防无交互 stdin 挂起
    const autoSkip = cfg.provider === 'mock' || opts.skipRosterConfirm === true;
    const confirmed = autoSkip ? true : await confirmRoster(workDir, anchor, opts, onLog);
    if (!confirmed) {
      return { ok: false, results: [{ round: 'SOURCE-ANCHOR', ok: false, errors: ['名册确认未通过（终止/编辑）'] }] };
    }
  } else {
    if (fs.existsSync(path.join(workDir, 'source-anchor-exemptions.json'))) {
      const msg = '[source-anchor exemption] .tmp-debate.txt 缺失但存在人工豁免 checkpoint——拒绝降级运行';
      onLog('[executor] ' + msg);
      return { ok: false, results: [{ round: 'SOURCE-ANCHOR-EXEMPTION', ok: false, errors: [msg] }] };
    }
    onLog('[executor] .tmp-debate.txt 缺失——锚 1/2/3 降级（mock 或非标准入口）');
  }
  assertPromptsWithinContext(workDir, undefined, onLog);  // A8-P7：启动前全量预检
  const results = [];
  const failFast = r => {
    results.push(r);
    if (!r.ok && !r.skipped) return true;
    return false;
  };
  // 260810 批次3（P1-B）：resume 场景 P1.md 已存在即探测新/旧合同（R2/final 判据分级用）；
  // fresh 场景 R1 通过后重算（见循环内 ③）
  const PC = require('../pipeline-controller.js');
  let newContract = PC.detectNewContractFromText(readIfExists(path.join(workDir, 'P1.md')));
  for (const round of core.ROUNDS) {
    if ((round.name === 'R6a' || round.name === 'R6b') && realValidate) {
      // 真实路径：R6a/R6b 由渲染器机械生成 report.html（确定性、可复现、无 LLM 超长输出风险）
      try {
        const bytes = renderReport(workDir);
        const PC = require('../pipeline-controller.js');
        const adjData = path.join(workDir, '.tmp-adjudicated-data.md');
        // 源锚层 v1（J-1）：final checkHtml 传 disclaimer（读自 source-anchor.json）——免责横幅缺失 → BLOCKING
        const sa1 = readAnchor(workDir);
        const hv = PC.checkHtml(path.join(workDir, 'report.html'), {
          stage: 'final',
          skillPath: resolveSkillPath(),
          dataSource: fs.existsSync(adjData) ? adjData : path.join(workDir, 'transition-final.md'),
          disclaimer: !!(sa1 && sa1.disclaimer === true)
        });
        if (hv.blocking && hv.blocking.length > 0)
          throw new Error('[executor] report.html 校验失败: ' + hv.blocking.map(b => b.message).join('; '));
        onLog('[executor] report.html 校验通过（blocking=0, warnings=' + (hv.warnings || []).length + '）');
        onLog('[executor] R6a/R6b 机械渲染 → report.html (' + bytes + 'B)');
        // P0（260901）：R6 机械渲染与 R7 白话层是两个独立阶段。
        // report.html 已通过 final gate 后必须立即把 R6a/R6b 记为成功；
        // 后续白话失败不得倒灌成“R6a 机械渲染失败”。
        results.push({ round: 'R6a', ok: true, mechanical: true });
        results.push({ round: 'R6b', ok: true, mechanical: true });
      } catch (e) {
        results.push({ round: 'R6a', ok: false, errors: ['机械渲染失败: ' + e.message] });
        break;
      }
      if (opts.plain) {
        onLog('[executor] R7 白话层开始');
        try {
          if (opts.plainReplayOnly) {
            // 定点 R8 + plain：R7 仍属上游正式权威，只允许 approved proof/cache 机械重放。
            // rebuildApprovedPlainReport 内部带 requireCacheHit + approved-proof + request fuse；任一失配 fail-close，绝不补发 R7 模型请求。
            await rebuildApprovedPlainReport(workDir, cfg, opts.plainDict);
            onLog('[executor] R7 approved cache/proof 机械重放完成（0 API）');
          } else {
            await applyPlain(workDir, cfg, onLog, opts.plainDict, {
              cache: !opts.force,
              onBatchCheckpoint: opts.onBatchCheckpoint,
              requestCompletion: opts.requestCompletion,
              codexRunner: opts.codexRunner
            });
          }
          results.push({ round: 'R7', ok: true, postprocess: true });
        } catch (e) {
          results.push({ round: 'R7', ok: false, postprocess: true, errors: ['白话层失败: ' + e.message] });
        }
      }
      break;
    }
    const r = await runRound({
      workDir, round, cfg, mockResponder: opts.mockResponder, onLog,
      force: opts.force, realValidate, newContract, sourceAnchorExemptions,
      codexRunner: opts.codexRunner
    });
    // 260810 批次3（P1-B）：R1 通过后重算 newContract（fresh 场景 P1.md 此刻才产出）——供后续轮次使用
    if (round.name === 'R1' && r.ok) {
      newContract = PC.detectNewContractFromText(readIfExists(path.join(workDir, 'P1.md')));
    }
    if (failFast(r)) break;
    if (round.name === 'R1') { buildR2Prompt(workDir, onLog); buildR25Prompt(workDir, onLog); }   // P6：R2/R2.5 读 P1
    if (round.name === 'R2.5') buildR3Prompt(workDir, onLog);   // A8-ERR-1 R3 修复：R3 前注入本场前置数据
    if (round.name === 'R3') {
      buildTransitionFinal(workDir, onLog, realValidate);       // A8-ERR-1 C8：渲染必需输入
      buildR4Prompt(workDir, onLog);                            // P6：R4 读 P2
    }
    if (round.name === 'R4') {
      buildFullData(workDir, onLog);
      enrichR5Prompts(workDir, onLog);                          // P6：R5 读 full-data
      // 3B：R4 重跑 → 旧 R4.5 产物失效；随后构建 R4.5 输入并注入 prompt
      if (!r.skipped) {
        for (const f of ['adjudication.json', '.tmp-adjudication.json', '.tmp-adjudicated-data.md', '.tmp-adjudicated-structure.json']) {
          const fp = path.join(workDir, f);
          if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch (e) {} }
        }
      }
      buildAdjudicationInput(workDir, onLog, realValidate);
      injectDataSource(workDir, '.tmp-R4.5-prompt.md', 'R4.5 输入汇总表（唯一数据源）', path.join(workDir, '.tmp-r45-input.md'), onLog);
    }
    if (round.name === 'R4.5' && r.ok) {
      // T7：mock 不跑正式机械复核；仍需物化与正式链同形的“裁决后视图”，
      // 供默认 Web R8 冒烟消费。这里只做既有 adjudication 的确定性 merge，不把 mock 升格为正式语义校验。
      if (!realValidate) {
        const adj = path.join(workDir, 'adjudication.json');
        const tmpAdj = path.join(workDir, '.tmp-adjudication.json');
        if (fs.existsSync(adj) && !fs.existsSync(tmpAdj)) fs.copyFileSync(adj, tmpAdj);
        if (fs.existsSync(adj)) {
          const parsed = parseAdjArtifact(fs.readFileSync(adj, 'utf-8'));
          if (parsed.ok) {
            const tfPath = path.join(workDir, 'transition-final.md');
            const stPath = path.join(workDir, 'structure.json');
            if (fs.existsSync(tfPath)) {
              let mergedMockData = PC.mergeAdjudicationData(fs.readFileSync(tfPath, 'utf-8'), parsed.obj);
              // R8 的读者锚点必须来自“关键CP逐回合轨迹”。正式路径由真实 R3/R4.5 数据提供；
              // mock 若没有该表，只为浏览器完整冒烟追加固定测试锚点，不进入真实 Judge 语义。
              if (!/<!--DATA:\s*S11\.类型=/.test(mergedMockData)) {
                mergedMockData += '\n<!--DATA: S11.类型=1b -->\n';
              }
              if (!mergedMockData.includes('**关键CP逐回合轨迹**')) {
                mergedMockData += '\n\n**关键CP逐回合轨迹**\n\n' +
                  '| CP-ID | 回合 | 发言方 | 动作 | 该点临时状态 | 辩词引用 |\n' +
                  '|---|---|---|---|---|---|\n' +
                  '| CP-3 | 1 | 反二 | 攻击 | 被削弱 | “mock 反方攻击引文” |\n' +
                  '| CP-3 | 2 | 正三 | 回应 | 被击穿 | “mock 正方回应引文” |\n' +
                  '| CP-6 | 1 | 反三 | 攻击 | 被削弱 | “mock 第二攻击引文” |\n' +
                  '| CP-6 | 2 | 正四 | 回应 | 被击穿 | “mock 第二回应引文” |\n';
              }
              fs.writeFileSync(path.join(workDir, '.tmp-adjudicated-data.md'), mergedMockData, 'utf-8');
            }
            if (fs.existsSync(stPath)) {
              try {
                const stObj = PC.parseStructureJson(fs.readFileSync(stPath, 'utf-8'));
                fs.writeFileSync(path.join(workDir, '.tmp-adjudicated-structure.json'),
                  JSON.stringify(PC.mergeStructureOverride(stObj, parsed.obj), null, 2), 'utf-8');
              } catch (e) { onLog('[executor] mock 裁决后 structure 视图物化跳过: ' + e.message); }
            }
          }
        }
      }
      injectAdjudication(workDir, onLog, realValidate);
    }
    if (round.name === 'R5B') {
      mergeNarrative(workDir, onLog);
      const PC = require('../pipeline-controller.js');
      const adjData = path.join(workDir, '.tmp-adjudicated-data.md');
      const nv = PC.checkNarrative(path.join(workDir, '叙事.md'), {
        skillPath: resolveSkillPath(),
        dataSource: fs.existsSync(adjData) ? adjData : path.join(workDir, 'transition-final.md')
      });
      if (!nv.passed) {
        results.push({ round: 'R5-FINAL', ok: false, errors: [nv.message] });
        break;
      }
      onLog('[executor] 叙事.md 最终校验通过（12 模块 + C7 计数）');
      continue;
    }
  }
  // mock 路径：R6a/R6b 走 runRound 占位产物，仍执行最终 HTML 校验（占位无 BLOCKING 项，主要防回归接线）
  if (!realValidate && fs.existsSync(path.join(workDir, 'report.html'))) {
    const PC = require('../pipeline-controller.js');
    const adjData = path.join(workDir, '.tmp-adjudicated-data.md');
    const sa2 = readAnchor(workDir);
    const hv = PC.checkHtml(path.join(workDir, 'report.html'), {
      stage: 'final',
      skillPath: resolveSkillPath(),
      dataSource: fs.existsSync(adjData) ? adjData : path.join(workDir, 'transition-final.md'),
      disclaimer: !!(sa2 && sa2.disclaimer === true)
    });
    if (hv.blocking && hv.blocking.length > 0)
      results.push({ round: 'R6-FINAL', ok: false, errors: hv.blocking.map(b => b.message) });
    else
      onLog('[executor] report.html 校验通过（blocking=0, warnings=' + (hv.warnings || []).length + '）');
  }
  // R7 阶段 2：白话层接线仅属 mock 链路（真实路径已在 R6a 机械渲染内 L920 执行，防双跑）；
  // 失败即终止语义（缺陷 G，260812）：任一失败轮次存在时不执行收口步骤——
  // 否则 applyPlain 读不存在的 report.html → ENOENT throw 遮蔽真实失败（CLI 只见 [pipeline run] ENOENT）
  if (opts.plain && !realValidate) {
    if (results.every(r => r.ok)) {
      if (opts.plainReplayOnly) {
        await rebuildApprovedPlainReport(workDir, cfg, opts.plainDict);
        onLog('[executor] R7 approved cache/proof 机械重放完成（mock/0 API）');
      } else {
        await applyPlain(workDir, cfg, onLog, opts.plainDict, {
          cache: !opts.force,
          onBatchCheckpoint: opts.onBatchCheckpoint,
          requestCompletion: opts.requestCompletion,
          codexRunner: opts.codexRunner
        });
      }
      results.push({ round: 'R6-PLAIN', ok: true, mock: true });
    } else {
      onLog('[executor] R6-PLAIN 跳过：管道存在失败轮次（失败即终止，不执行白话层收口，保留真实错误）');
    }
  }
  return { ok: results.every(r => r.ok), results };
}

module.exports = { runRound, runPipeline, buildFullData, buildR3Prompt, buildR25Prompt, buildR2Prompt, buildR4Prompt, enrichR5Prompts, injectDataSource, assertPromptsWithinContext, resolveSkillPath, mergeNarrative, buildTransitionFinal, renderReport, loadFileConfig, validateRound, goodMockResponder, sleep, adjudicationRecheck, buildAdjudicationInput, translateUnitsLLM, reviewPlainUnits, applyPlain, rebuildApprovedPlainReport, refreshPlainArtifacts, regeneratePlainV2Artifacts, applyReaderGuide, embedVerifiedReaderGuide, loadPlainDict, injectAdjudication, parseAdjArtifact, loadSourceAnchorExemptions, warningsForAdjudication, assertSourceAnchorExemptionArtifactBinding };
