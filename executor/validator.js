// executor/validator.js——校验器簇独立模块（卡 1 阶段 1，260816）
// 单一接口 validate(artifact, round, options)；66 符号迁移自 pipeline-controller.js（依赖图闭包自洽）
// 依赖：executor/contract.js（契约层）；禁止反向 require pipeline-controller
'use strict';
const fs = require('fs');
const path = require('path');
const contract = require('./contract.js');
const { extractDataMarkers, parseStructureJson, parseInsertRegistry, normalizeMId, normalizeMIdText, normalizeStructureIds, isMid, isCpId, isRef, sideOfMid, DIMENSION_S7_SC, DIMENSIONS, DERIVED_KEYS, ADJUDICABLE_PREFIXES, ADJUDICATION_WHITELIST, aggregateData, validateAdjudication, mergeAdjudicationData, adjudicableKeys, adjudicationWhitelist, loadInputContract, validateContract, parseInputs } = contract;
let ENUMS_CACHE = null;
const SKILL_PATH = path.join(__dirname, '..', 'Skill-Judge.md');
function validate(md, round, options = {}) {
  const data = extractDataMarkers(md);
  const errors = [];
  const isFinal = options.final || false;
  const hasP1P2P3 = options.p1Data && options.p2Data;

  // 合并多文件数据（用于最终验证）
  let allData = data;
  if (options.p1Data) Object.assign(allData, options.p1Data);
  if (options.p2Data) Object.assign(allData, options.p2Data);
  if (options.p25Data) Object.assign(allData, options.p25Data);
  // 260810 批次3：方向派生注入（字段缺失时；已存在→WARNING 回放标注）
  applyDerivations(allData, errors);

  // === 类别F：文件完整性（始终执行） ===
  checkF1_F5(md, errors, round, isFinal);

  // === 类别S：步骤完整性（轮次特定） ===
  if (round === 'R1') {
    checkS1_S7(allData, errors); checkS7Contract(md, allData, errors); checkCompletionMatrix(md, allData, errors);
    // 锚 1（源锚层 v1，V-S8E-A1）：名册槽位数 == S1 人数声明（候补 bench/候选 candidates 不计；N-2）
    // 无槽位可数（该方无任何角色槽）→ WARNING"无法对账"（第三态，防裸名误杀）
    const anchor = options.anchor;
    if (anchor && anchor.extracted) {
      for (const side of ['正方', '反方']) {
        const sideRoster = anchor.roster.filter(r => r.side === side);
        const slotCount = sideRoster.filter(r => r.slot).length;
        const declared = allData['S1.' + side + '人数'];
        if (declared === undefined) continue;
        if (sideRoster.length === 0) {
          errors.push({ rule: 'V-S8E-A1', severity: 'WARNING', message: `S1.${side}人数(${declared})无法对账——名册无 ${side} 角色槽位（无槽位可数），跳过人数校验` });
          continue;
        }
        if (declared !== slotCount) {
          const benchNames = anchor.bench.filter(b => b.side === side).map(b => b.name);
          errors.push({ rule: 'V-S8E-A1', severity: 'BLOCKING',
            message: `S1.${side}人数(${declared})≠名册槽位数(${slotCount})——名册: ${sideRoster.map(r => r.name || r.role).join(', ')}${benchNames.length ? '；候补（不计）: ' + benchNames.join(', ') : ''}` });
        }
      }
    }
  }
  if (round === 'R2') {
    checkS8(allData, errors, md, options.anchor, options.sourceAnchorExemptions);
    // C9a/C9b 的前置门禁只依赖 P2 的 Phase III 与 P1 的 S7 致命计数；
    // 不提前执行完整 C1-C7，避免 R2 因缺少 P3/最终数据产生跨轮误报。
    if (options.p1Data) checkC9FatalReview(data, errors, options.p1Data);
  }
  if (round === 'R2') checkS17Table(md, errors);          // 缺陷 H（260812）：S17.1 表列数一致性（产出轮下沉）
  if (round === 'R2.5') {
    const e = validateP2_5(md);
    errors.push(...e);
    // R2.5 读取到 P1 后前置校验 C8 回引存在性；无 P1 时保持旧场次/断点兼容。
    if (options.p1Data) checkC8ReferenceIntegrity(allData, errors, 'BLOCKING');
  }  // 新增
  if (round === 'R3') checkS15(allData, errors, false);
  if (round === 'R4') { const cs = checkStructure(md); errors.push(...cs.errors, ...cs.warnings); }
  if (isFinal) { checkS1_S7(allData, errors); checkS7Contract(md, allData, errors); checkS8(allData, errors, md, options.anchor, options.sourceAnchorExemptions); checkS17Table(md, errors); checkS15(allData, errors, true); }

  // === 类别V：值域（始终执行） ===
  checkV1_V6(allData, errors);

  // === 类别C：跨步骤一致性（仅最终验证或全部数据可用时） ===
  if (isFinal || hasP1P2P3) checkC1_C7(allData, errors, { adjudicatedDims: options.adjudicatedDims, adjudicatedDimsInfo: options.adjudicatedDimsInfo });

  // === 类别P：Phase逻辑（S8数据存在时；260811 批甲：仅 R2/final——v6 终裁防 R2.5/R3 照抄 S8.COMPLETE 误触发 S8C-R） ===
  if ((round === 'R2' || isFinal) && allData['S8.COMPLETE'] === '是') {
    // 260810 P1-B 修订：newContract 三来源（显式参数 > md 文本 > tfPath）
    // ——R2/final 门禁的 md 文本无 S7 段（S7 在 P1.md），由 host-node 探测 P1 后显式透传
    const newContract = !!(options.newContract || detectNewContractFromText(md) || detectNewContract(options.tfPath));
    checkP1_P3(allData, errors, newContract);
  }
  // 260811 批甲 D（A2）：V-C9 模板污染检测（WARNING 不阻断；必须 !isFinal——final 为全键合并校验，merged 全键合法）
  if (!isFinal && (round === 'R2.5' || round === 'R3')) {
    const domainRe = round === 'R2.5' ? R2_5_DOMAIN_RE : R3_DOMAIN_RE;
    const outOfDomain = Object.keys(data).filter(k => !domainRe.test(k));
    if (outOfDomain.length) errors.push({ rule: 'V-C9', severity: 'WARNING',
      message: '模板污染：检测到非 ' + round + ' 键域 ' + outOfDomain.slice(0, 5).join(', ') + '（照抄前置模板？）' });
  }
  // 260810 批次3：5:5 判胜护栏（仅 5:5 场次触发；md=P3/merged 全文）
  check55Guard(md, allData, errors);
  // 260810 批次3：S10.2 自评过严检测（仅 WARNING）
  checkS102Overstrict(allData, errors);
  // 260814 待修项批：契约↔产物形态断言（仅 final——merged 含 P1/P2/P3 全文；WARNING 级不阻断旧场次）
  if (isFinal) checkOutputShape(md, errors);

  const blocking = errors.filter(e => e.severity === 'BLOCKING');
  const warnings = errors.filter(e => e.severity === 'WARNING');
  const infos = errors.filter(e => e.severity === 'INFO');

  return { passed: blocking.length === 0, blocking, warnings, infos };
}

// ==================== F类规则 ====================

// A8-ERR-1：S 标记解析支持子步骤（S8.x/S10.x 归并为主步骤）——与 R2/R3 输出合同对齐

function checkF1_F5(md, errors, round, isFinal) {
  // F1: FILE_END — 仅R3需要（TRANSITION SCHEMA规定只有P3末尾有[FILE_END]）
  const lines = md.split('\n');
  let lastLine = '';
  for (let i = lines.length - 1; i >= 0; i--) { if (lines[i].trim()) { lastLine = lines[i].trim(); break; } }
  if (round === 'R3' && lastLine !== '[FILE_END]') {
    errors.push({ rule: 'F1', severity: 'BLOCKING', message: 'P3缺少[FILE_END]标记' });
  }

  // F2: S_START/S_END配对（A8-ERR-1 分形态：集合级兜底 + 无子步骤主步骤严格数量检测）
  const { starts, ends } = parseSMarkers(md);
  const uniqStarts = [...new Set(starts)];
  const uniqEnds = [...new Set(ends)];
  if (JSON.stringify(uniqStarts) !== JSON.stringify(uniqEnds)) {
    errors.push({ rule: 'F2', severity: 'BLOCKING', message: `S_START/S_END不配对: starts=[${uniqStarts}] ends=[${uniqEnds}]` });
  } else {
    // 无子步骤的主步骤仍要求 START/END 数量一致（防重复标记）；有子步骤的主步骤允许整体 START + 多个子步骤 END
    const det = parseSMarkerDetail(md);
    const byMain = {};
    for (const x of det) {
      if (!byMain[x.n]) byMain[x.n] = { starts: 0, ends: 0, hasSub: false };
      const b = byMain[x.n];
      if (x.isStart) b.starts++; else b.ends++;
      if (x.sub !== null) b.hasSub = true;
    }
    for (const s of uniqStarts) {
      const b = byMain[s];
      if (b && !b.hasSub && b.starts !== b.ends) {
        errors.push({ rule: 'F2', severity: 'BLOCKING', message: `S${s}标记数量不对称: START=${b.starts} END=${b.ends}` });
      }
    }
  }

  // F3: 步骤顺序 — final模式(合并文件跨三轮)跳过；单轮模式使用传入round
  if (!isFinal) {
    const expected = { R1: [1,2,3,4,5,7], R2: [8,17], R3: [9,10,11,13,14,15], R4: [] };
    if (expected[round] && JSON.stringify(uniqStarts) !== JSON.stringify(expected[round])) {
      if (round === 'R1' && uniqStarts.includes(6)) { /* 允许归档S6标记 */ }
      else if (round === 'R3' && uniqStarts.includes(12)) { /* 允许归档S12标记 */ }
      else errors.push({ rule: 'F3', severity: 'BLOCKING', message: `${round}步驟集合异常: ${uniqStarts}` });
    }
  }

  // F4: 每步骤DATA标记（A8-ERR-1：S10 兼容 S10.1/S10.2.COMPLETE）
  for (const s of [...new Set(starts)]) {
    const ok = md.includes(`S${s}.COMPLETE=是`) || md.includes(`S${s}.1.COMPLETE=是`) || md.includes(`S${s}.2.COMPLETE=是`);
    if (!ok) {
      errors.push({ rule: 'F4', severity: 'BLOCKING', message: `S${s}缺少COMPLETE标记` });
    }
  }

  // F5: 三子块 — R1/R2/R3分析轮缺少"### 结论"视为阻断（R4不输出"### 结论"·跳过·V3.0变更）
  for (const s of [...new Set(starts)]) {
    const section = sectionOfStep(md, s);
    if (!section.includes('### 结论')) {
      const sev = (round === 'R1' || round === 'R2' || round === 'R3') ? 'BLOCKING' : 'WARNING';
      errors.push({ rule: 'F5', severity: sev, message: `S${s}缺少"### 结论"子块` });
    }
  }
}

// ==================== S类规则 ====================

function checkS1_S7(data, errors) {
  const required = ['S1.COMPLETE','S1.赛制','S1.正方人数','S1.反方人数','S1.辩题','S1.辩词完整度',
                     'S2.COMPLETE','S2.正方.B0','S2.反方.B0','S2.正方.SC容量预判','S2.反方.SC容量预判','S2.预判SC方向',
                     'S3.COMPLETE','S4.COMPLETE','S4.碰撞诊断','S4.包着打.正方','S4.包着打.反方','S5.COMPLETE',
                     'S7.COMPLETE'];
  for (const k of required) {
    if (!(k in data)) errors.push({ rule: 'S1', severity: 'BLOCKING', message: `缺少必须字段: ${k}` });
  }
  const s3 = data['S3.交锋点总数'];
  if (s3 !== undefined && s3 < 0) errors.push({ rule: 'S3', severity: 'BLOCKING', message: 'S3交锋点总数为负' });
  const s7 = data['S7.关键交锋数'];
  if (s7 !== undefined && s7 < 3) errors.push({ rule: 'S7', severity: 'WARNING', message: `S7关键交锋数=${s7}，少于3个` });
  else if (s7 !== undefined && s7 < 5) errors.push({ rule: 'S7', severity: 'WARNING', message: `S7关键交锋数=${s7}，建议>=5` });
}

// 260806 段1B-A：S7 合同扩展机械校验（靶心/削弱指向/强度标签/回合深度/逐回合轨迹状态机）
// 260814 N2：表解析有界化（collectTableBlock 复用）+ 表头 CP/CP-ID 兼容 + 回合 R 前缀/状态方位前缀归一
//           + 状态机自环放行 + 轨迹格式不可识别时输出单条提示性 WARNING（替换误导性 0≠DATA）

function checkS7Contract(md, data, errors) {
  const sec = String(md || '').match(/\[S_START=S7\][\s\S]*?\[S_END=S7\]/);
  if (!sec) return;
  const secLines = sec[0].split('\n').map(l => l.trim());
  const hdrIdx = secLines.findIndex(l => l.startsWith('|')
    && (l.includes('CP-ID') || /^\|?\s*CP\s*\|/.test(l))
    && (l.includes('靶心') || l.includes('削弱指向') || l.includes('穿透度')));
  if (hdrIdx < 0) return;
  const kRows = collectTableBlock(secLines, hdrIdx, ['CP-ID', '靶心', '穿透度', '削弱指向']);
  if (!kRows.length) return;
  const header = kRows[0];
  const idx = name => header.findIndex(h => h.includes(name));
  const iCP = idx('CP-ID') >= 0 ? idx('CP-ID') : idx('CP');
  const iTarget = idx('靶心'), iCrit = idx('削弱指向'), iPen = idx('穿透度'), iDepth = idx('回合深度');
  const newContract = iTarget >= 0 && iCrit >= 0;
  if (!newContract) {
    errors.push({ rule: 'S7-C', severity: 'WARNING', message: '旧合同场次：S7 缺靶心/削弱指向列（C5 攻击环回退关键词反推+标注；真字段待新合同场次）' });
    return;
  }
  const critEnum = ['唯一支撑', '冗余', '边缘'];
  const penEnum = ['高', '中', '低'];
  let rowCount = 0;
  for (const cells of kRows.slice(1)) {
    if (cells.length < 3 || !/^CP-\d+/.test(cells[iCP].replace(/\*\*/g, ''))) continue;
    rowCount++;
    if (iTarget >= 0 && !cells[iTarget]) errors.push({ rule: 'S7-C', severity: 'WARNING', message: 'S7 靶心为空：' + cells[iCP] });
    if (iCrit >= 0 && critEnum.indexOf(cells[iCrit]) < 0) errors.push({ rule: 'S7-C', severity: 'WARNING', message: 'S7 削弱指向/关键性非法：' + (cells[iCrit] || '空') });
    if (iPen >= 0 && penEnum.indexOf(cells[iPen]) < 0) errors.push({ rule: 'S7-C', severity: 'WARNING', message: 'S7 穿透度（强度标签）非法：' + (cells[iPen] || '空') });
    if (iDepth >= 0) {
      const d = parseInt(cells[iDepth], 10);
      if (!(d >= 1)) errors.push({ rule: 'S7-C', severity: 'WARNING', message: 'S7 回合深度非法（须≥1）：' + (cells[iDepth] || '空') });
    }
  }
  if (rowCount > 0 && data['S7.关键交锋数'] !== undefined && rowCount !== Number(data['S7.关键交锋数']))
    errors.push({ rule: 'S7-C', severity: 'WARNING', message: `S7 表格行数(${rowCount})≠DATA 关键交锋数(${data['S7.关键交锋数']})` });

  // 逐回合轨迹（定向关键 CP）：动作/状态枚举 + ≤3 回合 + 状态机
  const trajSec = sec[0].match(/逐回合轨迹[\s\S]*?(?=\n##|\n###|\n\[S_END)/);
  const perCp = {};
  let trajParsed = false;
  if (trajSec) {
    const tLines = trajSec[0].split('\n').map(l => l.trim());
    const h = tLines.findIndex(l => l.startsWith('|')
      && (l.includes('CP-ID') || /^\|?\s*CP\s*\|/.test(l))
      && l.includes('回合'));
    if (h >= 0) {
      const tRows = collectTableBlock(tLines, h, ['回合', '动作', '临时状态']);
      const th = tRows[0];
      const ti = name => th.findIndex(x => x.includes(name));
      const iTCP = ti('CP-ID') >= 0 ? ti('CP-ID') : ti('CP');
      const iAct = ti('动作'), iState = ti('临时状态'), iTurn = ti('回合');
      const acts = ['攻击', '回应', '追击', '追加回应'];
      const states = ['未定', '被削弱', '被击穿', '修复', '守住'];
      const normState = s => String(s || '').replace(/^(正方|反方)/, '').replace(/（.*?）|\(.*?\)/g, '').trim();
      const normTurn = s => parseInt(String(s || '').replace(/^R/i, ''), 10);
      for (const cells of tRows.slice(1)) {
        if (cells.length < 4 || !/^CP-\d+/.test(cells[iTCP].replace(/\*\*/g, ''))) continue;
        const cp = cells[iTCP].replace(/\*\*/g, '');
        perCp[cp] = perCp[cp] || [];
        perCp[cp].push(cells);
        if (acts.indexOf(cells[iAct]) < 0) errors.push({ rule: 'S7-T', severity: 'WARNING', message: `逐回合轨迹动作非法（${cp}）：${cells[iAct]}` });
        const st = normState(cells[iState]);
        if (states.indexOf(st) < 0) errors.push({ rule: 'S7-T', severity: 'WARNING', message: `逐回合轨迹临时状态非法（${cp}）：${cells[iState]}` });
        if (iTurn >= 0) { const t = normTurn(cells[iTurn]); if (!(t >= 1 && t <= 3)) errors.push({ rule: 'S7-T', severity: 'WARNING', message: `逐回合轨迹回合数须1-3（${cp}）：${cells[iTurn]}` }); }
      }
      for (const cp of Object.keys(perCp)) {
        const seq = perCp[cp].map(c => normState(c[iState]));
        for (let j = 1; j < seq.length; j++) {
          if (seq[j] === seq[j - 1]) continue;
          const ok = (seq[j - 1] === '未定' && (seq[j] === '被削弱' || seq[j] === '被击穿'))
            || (seq[j - 1] === '被削弱' && (seq[j] === '被击穿' || seq[j] === '修复' || seq[j] === '守住'))
            || (seq[j - 1] === '被击穿' && seq[j] === '修复')
            || (seq[j - 1] === '修复' && (seq[j] === '守住' || seq[j] === '被击穿'))
            || (seq[j - 1] === '守住' && seq[j] === '被击穿');
          if (!ok) errors.push({ rule: 'S7-T', severity: 'WARNING', message: `逐回合轨迹状态机非法（${cp}）：${seq[j - 1]}→${seq[j]}` });
        }
        if (perCp[cp].length > 3) errors.push({ rule: 'S7-T', severity: 'WARNING', message: `逐回合轨迹超过3回合（${cp}）：${perCp[cp].length}` });
      }
      trajParsed = true;
    }
  }
  const trajCount = data['S7.逐回合轨迹.CP数'];
  if (trajCount !== undefined && Number(trajCount) > 0 && !trajSec)
    errors.push({ rule: 'S7-T', severity: 'WARNING', message: 'S7.逐回合轨迹.CP数>0 但无逐回合轨迹段' });
  else if (trajSec && trajCount !== undefined && Number(trajCount) > 0 && !trajParsed)
    errors.push({ rule: 'S7-T', severity: 'WARNING', message: 'S7 逐回合轨迹段存在但表格式无法识别（期望表头含 CP/CP-ID 与 回合 列）——跳过轨迹校验' });
  if (trajParsed && trajCount !== undefined && Number(trajCount) > 0 && Object.keys(perCp).length !== Number(trajCount))
    errors.push({ rule: 'S7-T', severity: 'WARNING', message: `S7 逐回合轨迹 CP 数(${Object.keys(perCp).length})≠DATA(${trajCount})` });
}

// A7：论证完成度矩阵 ↔ DATA 交叉校验（R1）
// 矩阵格式：| 层级 | 论点 | A→B0状态 | B0→C状态 |（正反方各一张表）
// M5：矩阵可解析才断言；解析失败 → WARNING；两者可解析且不一致 → BLOCKING

function checkCompletionMatrix(md, data, errors) {
  const ENUM = ['充分', '初步', '未论证', '被击穿'];
  const norm = s => {
    const c = String(s || '').replace(/（.*）/g, '').replace(/\(.*\)/g, '').trim();
    return ENUM.find(e => c.includes(e)) || null;
  };
  const counts = { 正方: { 充分: 0, 初步: 0, 未论证: 0, 被击穿: 0 }, 反方: { 充分: 0, 初步: 0, 未论证: 0, 被击穿: 0 } };
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let inMatrix = false, mode = null, side = null, rows = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const h = l.match(/^#{2,4}\s*(正方|反方)(?:\s|$)/);
    if (h) { side = h[1]; inMatrix = false; mode = null; continue; }
    if (!l.trim().startsWith('|')) { inMatrix = false; mode = null; continue; }
    const cells = l.split('|').map(s => s.trim()).slice(1, -1);
    if (cells.length < 4) continue;
    if (cells[0] === '层级' && cells[2] === 'A→B0状态') { inMatrix = true; mode = 'dual'; continue; }
    if (cells[0] === '层级' && cells[2] === '作用环' && cells[3] === '状态') { inMatrix = true; mode = 'single'; continue; }
    if (!inMatrix) continue;
    if (cells.every(c => /^:?-{3,}:?$/.test(c))) continue;
    const s = side || (cells[0].includes('正方') ? '正方' : cells[0].includes('反方') ? '反方' : null);
    if (!s) continue;
    if (mode === 'single') {
      const st = norm(cells[3]);
      if (st) { counts[s][st]++; rows++; }
    } else {
      const a = norm(cells[2]), b = norm(cells[3]);
      if (a) { counts[s][a]++; rows++; }
      if (b) { counts[s][b]++; rows++; }
    }
  }
  const dataOk = ['正方', '反方'].every(sd => ENUM.every(st => data['S2.' + sd + '.论证完成度.' + st] !== undefined));
  if (!dataOk) {
    errors.push({ rule: 'A7', severity: 'WARNING', message: 'S2.论证完成度 DATA 不完整，跳过矩阵交叉校验' });
    return;
  }
  if (rows === 0) {
    errors.push({ rule: 'A7', severity: 'WARNING', message: '论证完成度矩阵无法解析（表头/行数异常），无法交叉校验' });
    return;
  }
  for (const sd of ['正方', '反方']) {
    for (const st of ENUM) {
      const expect = data['S2.' + sd + '.论证完成度.' + st];
      if (counts[sd][st] !== expect) {
        errors.push({ rule: 'A7', severity: 'BLOCKING', message: `论证完成度矩阵 ${sd}.${st}=${counts[sd][st]} 与 DATA=${expect} 不一致` });
      }
    }
  }
}

// 签名：(data, errors, md, anchor)——md/anchor 为源锚层 v1（N-1 桥接）V-S8E 表级锚的数据依赖；
// md 缺省 → 表级跳过；anchor 缺省/未抽取 → 锚 2 仍可解析时执行（D-2 守卫分域），锚 3 跳过。

function checkS8(data, errors, md, anchor, sourceAnchorExemptions) {
  if (data['S8.第一层完成'] !== '是') errors.push({ rule: 'S8', severity: 'BLOCKING', message: 'S8第一层未完成' });
  if (data['S8.第二层完成'] !== '是') errors.push({ rule: 'S8', severity: 'BLOCKING', message: 'S8第二层未完成(诊断层被跳过)' });
  // V-S8D-R（260809 Q4）：S8.PhaseII 四键必出（键存在即可，空值允许）——缺失 = 键漂移（S8.2.*）或未输出，BLOCKING 归因 R2
  for (const side of ['正方', '反方']) {
    if (data[`S8.PhaseII.${side}.有效数`] === undefined)
      errors.push({ rule: 'V-S8D', severity: 'BLOCKING', message: `缺少 S8.PhaseII.${side}.有效数（若模型输出为 S8.2.* 属键漂移——契约键为 S8.PhaseII.*，需重跑 R2）` });
    if (data[`S8.PhaseII.${side}.节点列表`] === undefined)
      errors.push({ rule: 'V-S8D', severity: 'BLOCKING', message: `缺少 S8.PhaseII.${side}.节点列表——需重跑 R2` });
  }
  // C4 专项（260806·D2）：S8.碰撞终判 必填；缺失=旧产物，阻断并提示重跑 R2
  if (data['S8.碰撞终判'] === undefined) errors.push({ rule: 'S8', severity: 'BLOCKING', message: '缺少 S8.碰撞终判（旧产物）·需重跑 R2' });
  if (data['S17.COMPLETE'] !== '是') errors.push({ rule: 'S17', severity: 'WARNING', message: 'S17节点链缺失·C3全景图渲染将受阻' });
  // H5: ④或⑤任一不通过但Phase III已结晶（260810 扩展：原仅④——⑤价值深度不通过现无拦截，假结晶漏网）
  const _d4 = data['S8.PhaseIII.④容纳自洽'];
  const _d5 = data['S8.PhaseIII.⑤价值深度'];
  const _d6 = data['S8.PhaseIII.⑥双方SC关系'];
  if ((_d4 === '不通过' || _d5 === '不通过') && data['S8.PhaseIII.状态'] === '已结晶') {
    errors.push({ rule: 'H5', severity: 'BLOCKING', message: '④或⑤不通过但PhaseIII已结晶（假结晶·须改判未结晶）' });
  }
  // ⑥-b 字段层（260810）：⑥=独立平行 → PhaseIII 必须=未结晶（L2620 明文）；完成度层豁免见 S8C 矩阵
  if (_d6 === '独立平行' && data['S8.PhaseIII.状态'] === '已结晶') {
    errors.push({ rule: 'H5', severity: 'BLOCKING', message: '⑥=独立平行但PhaseIII已结晶（⑥-b：比赛层面未结晶）' });
  }
  checkS8Coherence(data, errors);
  // V-S8D（260808）：S8 锚点自洽——每方 有效数 == |节点列表| 基数 + 元素合法性（意见 4-2 + 意见 5-2）
  for (const side of ['正方', '反方']) {
    const eff = data[`S8.PhaseII.${side}.有效数`];
    const list = String(data[`S8.PhaseII.${side}.节点列表`] || '').split('|').map(x => x.trim()).filter(Boolean);
    if (eff === undefined) continue;
    if (eff > 0 && list.length === 0) {
      errors.push({ rule: 'V-S8D', severity: 'WARNING', message: `S8.PhaseII.${side}.有效数=${eff} 但节点列表为空——C7 门禁将降级为计数锚定` });
    } else if (!list.every(isMid)) {
      errors.push({ rule: 'V-S8D', severity: 'BLOCKING', message: `S8.PhaseII.${side}.节点列表含非法 M-ID: ${list.filter(x => !isMid(x)).join(',')}——需重跑 R2` });
    } else if (list.length !== eff) {
      errors.push({ rule: 'V-S8D', severity: 'BLOCKING', message: `S8.PhaseII.${side}.有效数=${eff} ≠ 节点列表基数=${list.length}——S8 内部自洽违约，需重跑 R2` });
    }
  }
  // V-S8E（源锚层 v1，表级；守卫分域 D-2：md + anchor 对象可用即进入——锚 2 仅依赖 md 可解析，不查 extracted）
  if (md && anchor) {
    const s82 = parseS82Table(md);
    if (s82.found) {
      const res = checkS82Anchors(s82, anchor, { exemptions: sourceAnchorExemptions });
      errors.push(...res.errors);
      if (res.stats && res.stats.w2)
        errors.push({ rule: 'V-S8E-W2', severity: 'WARNING', message: res.stats.w2 });
    }
  }
}

// C4 专项（260806）：S8 内部一致性派生门 V-S8A/B/C

function checkS8Coherence(data, errors) {
  const finalDiag = data['S8.碰撞终判'];
  if (finalDiag === undefined) return; // 缺失已由 S8 必填拦截
  // V-S8A: 终判=各跑各的 ⇒ PhaseI 双≠完成 + PhaseII 有效合计=0 + PhaseIII=未结晶 + SC完成度∈{不存在,未启动} + 方向∈{2a,2b,2c,0}（防御性超集）
  if (finalDiag === '各跑各的') {
    const problems = [];
    const phaseIok = data['S8.PhaseI.正方'] !== '完成' && data['S8.PhaseI.反方'] !== '完成';
    const phaseIIsum = (Number(data['S8.PhaseII.正方.有效数']) || 0) + (Number(data['S8.PhaseII.反方.有效数']) || 0);
    if (!phaseIok) problems.push('PhaseI 存在完成方');
    if (phaseIIsum !== 0) problems.push('PhaseII 有效数合计=' + phaseIIsum);
    if (data['S8.PhaseIII.状态'] !== undefined && data['S8.PhaseIII.状态'] !== '未结晶') problems.push('PhaseIII=' + data['S8.PhaseIII.状态']);
    if (data['S8.SC完成度'] !== undefined && !['不存在', '未启动'].includes(data['S8.SC完成度'])) problems.push('SC完成度=' + data['S8.SC完成度']);
    if (data['S8.S11类型方向'] !== undefined && !['2a', '2b', '2c', '0'].includes(data['S8.S11类型方向'])) problems.push('方向=' + data['S8.S11类型方向']);
    if (problems.length > 0) errors.push({ rule: 'V-S8A', severity: 'BLOCKING', message: 'V-S8A：终判=各跑各的但 S8 内部不一致：' + problems.join('；') });
  }
  // V-S8B: PhaseIII=已结晶 ⇒ 终判≠各跑各的 + SC完成度=完成 + 方向=1型
  if (data['S8.PhaseIII.状态'] === '已结晶') {
    const problems = [];
    if (finalDiag === '各跑各的') problems.push('终判=各跑各的');
    if (data['S8.SC完成度'] !== undefined && data['S8.SC完成度'] !== '完成') problems.push('SC完成度=' + data['S8.SC完成度']);
    if (data['S8.S11类型方向'] !== undefined && data['S8.S11类型方向'] !== '1型') problems.push('方向=' + data['S8.S11类型方向']);
    if (problems.length > 0) errors.push({ rule: 'V-S8B', severity: 'BLOCKING', message: 'V-S8B：PhaseIII=已结晶但 S8 内部不一致：' + problems.join('；') });
  }
  // V-S8C: 预判 vs 终判 不一致 → WARNING（数据守卫：R2 单轮拿不到 S4，最终校验生效）
  if (data['S4.碰撞诊断'] !== undefined && data['S4.碰撞诊断'] !== finalDiag) {
    errors.push({ rule: 'V-S8C', severity: 'WARNING', message: 'V-S8C：立论预判=' + data['S4.碰撞诊断'] + ' ≠ 全场终判=' + finalDiag + '·认知修正记录（供 C2 叙事）' });
  }
}

function getReferenceSets(data) {
  const mIdSet = new Set();
  for (const side of ['正方', '反方']) {
    const list = data[`S8.PhaseII.${side}.节点列表`];
    if (list !== undefined) String(list).split('|').forEach(x => {
      const t = String(x).trim();
      if (t) mIdSet.add(t);
    });
  }
  const cpRaw = data['S7.CP入选列表'];
  const cpIdSet = new Set();
  if (cpRaw !== undefined) String(cpRaw).split(/[|,，]/).forEach(x => {
    const t = String(x).trim();
    if (t) cpIdSet.add(t);
  });
  const hasRefBase = mIdSet.size > 0 || cpIdSet.size > 0;
  const refExists = ref => ref.startsWith('M-') ? mIdSet.has(ref) : cpIdSet.has(ref);
  return { mIdSet, cpIdSet, hasRefBase, refExists };
}

function checkC8ReferenceIntegrity(data, errors, severity = 'WARNING') {
  const { hasRefBase, refExists } = getReferenceSets(data);
  const winRaw = data['C8.人格胜负'];
  if (winRaw === undefined) return;
  const wref = normalizeMId(String(winRaw).split('|').pop() || '');
  if (wref && isRef(wref) && hasRefBase && !refExists(wref)) {
    errors.push({ rule: 'V-C8W', severity,
      message: 'C8.人格胜负 回引 ID 查不到: ' + wref });
  }
}

function checkS15(data, errors, isFinal) {
  if (!data['S15.获胜方'] || data['S15.正方得分'] === undefined || data['S15.反方得分'] === undefined) {
    errors.push({ rule: 'S15', severity: 'BLOCKING', message: 'S15缺少获胜方或正方得分/反方得分' });
  }
  // 叙事人格专项（260806·B3）：V-C8W-ID + V-S14E（ID 存在性需 final 全量数据；单轮缺键时跳过）
  checkC8ReferenceIntegrity(data, errors, 'WARNING');
  const { hasRefBase, refExists } = getReferenceSets(data);
  const countPro = data['S14.教育洞察.正方'];
  const countCon = data['S14.教育洞察.反方'];
  const sideCounts = [['正方', countPro], ['反方', countCon]];
  for (const [side, count] of sideCounts) {
    if (count === undefined) continue;
    const n = Number(count);
    if (![0, 1, 2].includes(n)) { errors.push({ rule: 'V-S14E', severity: 'BLOCKING', message: `S14.教育洞察.${side}=${count} 非法（须 0-2）` }); continue; }
    let seen = 0;
    for (let i = 1; i <= n; i++) {
      const item = data[`S14.教育洞察.${side}.${i}`];
      if (item === undefined) { errors.push({ rule: 'V-S14E', severity: 'BLOCKING', message: `S14.教育洞察.${side}.${i} 缺失` }); continue; }
      seen++;
      const parts = String(item).split('|');
      const ref = normalizeMId((parts[parts.length - 1] || '').trim());
      if (parts.length < 2 || !isRef(ref)) {
        errors.push({ rule: 'V-S14E', severity: 'BLOCKING', message: `S14.教育洞察.${side}.${i} 回引缺失/非法` });
      } else if (hasRefBase && !refExists(ref)) {
        if (isFinal) {
          errors.push({ rule: 'V-S14E', severity: 'BLOCKING', message: `S14.教育洞察.${side}.${i} 回引 ID 不存在·无源建议: ${ref}` });
        } else {
          errors.push({ rule: 'V-S14E', severity: 'WARNING', message: `S14.教育洞察.${side}.${i} 回引 ID 查不到: ${ref}` });
        }
      }
      // 批甲 R5（P2-2 落码）：长度门禁移除（60→无限制）；结构契约非空（空文本=可证明语义缺失）
      if (!(parts[0] || '').trim()) errors.push({ rule: 'V-S14E', severity: 'BLOCKING', message: `S14.教育洞察.${side}.${i} 文本为空（须 文本|回引）` });
    }
    if (seen !== n) errors.push({ rule: 'V-S14E', severity: 'BLOCKING', message: `S14.教育洞察.${side} 条数=${seen} 与声明 ${count} 不一致` });
  }
}

// ==================== V类规则 ====================

// 主线类型族（2026-08-05 审计统一）：1 型 = 聚合主线（1a 事件 / 1b 过程 / 1c 框架内置 / 1d 层间迭代）

function check55Guard(md, data, errors) {
  if (data['S15.正方得分'] !== 5 || data['S15.反方得分'] !== 5) return;   // 仅 5:5
  const body = extractAdjudicationReason(String(md || ''));
  if (body.length < 10) {
    errors.push({ rule: 'V2-55', severity: 'BLOCKING', message: '5:5判胜·S15.2判准应用推理缺失或<10字（5:5须附判准裁定理由）' });
    return;
  }
  if (body.length < R5_WARN_MIN_LEN) {
    errors.push({ rule: 'V2-55W', severity: 'WARNING', message: '5:5判胜·判准裁定理由偏短·报告标注' });
  }
}

// S10.2 自评过严检测（第三方审计 S3 定案：只做 WARNING；S10.2-1 有意删除——机械阻断本身即重试信号）

function checkS102Overstrict(data, errors) {
  if (data['S10.2.通过'] !== '否') return;
  const hasBlock = errors.some(e => e.severity === 'BLOCKING' && S15_GATE_RULES.includes(e.rule));
  if (!hasBlock) errors.push({ rule: 'S10.2-2', severity: 'WARNING', message: 'S10.2自评=否但S15前置机械校验全过·自评过严·报告标注' });
}

// 方向派生（260805 拍板：方向=纯标签投影·程序派生；260810：胜方派生已取消）
// 单一事实源 = S8.4 规则表第 3 列（Skill-Judge L2645-2651）：完成→1型/未完成→2b/半完成→2b/启动未推进→2a/未启动→2c/不存在→0
// 变更须同步规则表 + 本表 + batch3 规则表映射一致性断言（P2-3 终审）

function checkV1_V6(data, errors) {
  // V1: 枚举有效性
  let v1enums;
  try { v1enums = getEnums(SKILL_PATH); } catch (e) { v1enums = {}; }
  for (const [key, allowed] of Object.entries(v1enums)) {
    if (allowed.length === 0) continue;
    if (!(key in data)) continue;
    const raw = String(data[key]);
    // A8-P7：S2 分论点结构允许组合值（如 "并集式+价值补强式"）——真实辩论可混合多种结构；
    // 组合规则：1 个或多个枚举值用 "+" 连接，每段必须合法、不得重复、不得空段。
    const combinable = key.endsWith('分论点结构');
    let ok;
    if (combinable) {
      const parts = raw.split('+').map(p => normalizeEnumValue(p) || p.trim());
      ok = parts.length >= 1 && parts.every(p => allowed.includes(p)) && new Set(parts).size === parts.length;
    } else {
      ok = allowed.includes(raw);
      if (!ok) {
        const norm = normalizeEnumValue(raw);
        ok = norm !== null && allowed.includes(norm);
      }
    }
    if (!ok) {
      const hint = combinable ? '（分论点结构允许组合，如 并集式+价值补强式）' : '';
      errors.push({ rule: 'V1', severity: 'BLOCKING', message: `${key}="${raw}"不在允许值[${allowed}]中${hint}` });
    }
  }
  // V2: 比分绝对坐标校验（V6.8 升级 · 260810 5:5 判胜合法化：比分差≥2 时胜方得分必须更高；5:5 由 check55Guard 护栏）
  const zhengScore = data['S15.正方得分'];
  const fanScore = data['S15.反方得分'];
  if (zhengScore !== undefined && fanScore !== undefined) {
    if (zhengScore + fanScore !== 10) {
      errors.push({ rule: 'V2', severity: 'BLOCKING', message: `正方得分=${zhengScore} + 反方得分=${fanScore} ≠ 10` });
    }
    if (zhengScore < 0 || zhengScore > 10 || fanScore < 0 || fanScore > 10) {
      errors.push({ rule: 'V2', severity: 'BLOCKING', message: `得分超出值域[0,10]: 正方=${zhengScore}, 反方=${fanScore}` });
    }
    if (!Number.isInteger(zhengScore) || !Number.isInteger(fanScore)) {
      errors.push({ rule: 'V2', severity: 'BLOCKING', message: `得分必须为整数: 正方=${zhengScore}, 反方=${fanScore}` });
    }
    if (zhengScore !== fanScore) {   // 比分差≥2（合计10→差仅偶数，两态全覆盖）
      if (data['S15.获胜方'] === '正方' && zhengScore <= fanScore) {
        errors.push({ rule: 'V2', severity: 'BLOCKING', message: `获胜方=正方但得分正方=${zhengScore} <= 反方=${fanScore}` });
      }
      if (data['S15.获胜方'] === '反方' && fanScore <= zhengScore) {
        errors.push({ rule: 'V2', severity: 'BLOCKING', message: `获胜方=反方但得分反方=${fanScore} <= 正方=${zhengScore}` });
      }
    }
    // 5:5 → 允许任一方胜，护栏见 check55Guard（validate 层调用）
  }
  // 向后兼容：若旧数据仍有 S15.比分，输出 WARNING 但不阻断
  if (data['S15.比分'] && (zhengScore === undefined || fanScore === undefined)) {
    errors.push({ rule: 'V2', severity: 'WARNING', message: `检测到旧字段 S15.比分=${data['S15.比分']}，建议升级为新字段 S15.正方得分/S15.反方得分` });
  }
  // V3: Phase状态
  if (data['S8.PhaseIII.状态'] === '已结晶') {
    if (data['S8.PhaseIII.完成方'] === '无') errors.push({ rule: 'V3', severity: 'BLOCKING', message: 'PhaseIII已结晶但完成方=无' });
    if (!(data['S8.PhaseIII.压缩度'] >= 1)) errors.push({ rule: 'V3', severity: 'BLOCKING', message: 'PhaseIII已结晶但压缩度<1' });
    // 压缩度类型与数值一致性（WARNING级别·B10新增）
    const compType = data['S8.PhaseIII.压缩度类型'];
    const compVal = data['S8.PhaseIII.压缩度'];
    if (compType && compVal !== undefined) {
      if (compType === '事件型' && compVal > 3) {
        errors.push({ rule: 'V3', severity: 'WARNING', message: `压缩度类型=事件型但压缩度=${compVal}>3·建议复核是否应为过程型` });
      }
      if (compType === '过程型' && compVal < 4) {
        errors.push({ rule: 'V3', severity: 'WARNING', message: `压缩度类型=过程型但压缩度=${compVal}<4·建议复核是否应为事件型` });
      }
    }
  }
  if (data['S8.PhaseIII.状态'] === '未结晶' && data['S8.PhaseIII.压缩度类型'] && data['S8.PhaseIII.压缩度类型'] !== '不适用') {
    errors.push({ rule: 'V3', severity: 'WARNING', message: `PhaseIII未结晶但压缩度类型≠不适用（=${data['S8.PhaseIII.压缩度类型']}）` });
  }
  // V4: S10.1计数自洽（V3.2更新·S10已分裂为S10.1+S10.2）
  if (data['S10.1.通過数'] !== undefined || data['S10.1.通过数'] !== undefined) {
    const total = data['S10.1.总数'] || 0;
    const passed = data['S10.1.通过数'] !== undefined ? data['S10.1.通过数'] : (data['S10.1.通過数'] !== undefined ? data['S10.1.通過数'] : 0);
    const failed = data['S10.1.不通过项号'] ? String(data['S10.1.不通过项号']).split('|').filter(Boolean).length : 0;
    if (total > 0 && passed + failed !== total)
      errors.push({ rule: 'V4', severity: 'WARNING', message: `S10.1计数不一致: 通过=${passed} 不通过=${failed} 总数=${total}` });
  }
  // V5: 数值非负
  for (const [key, val] of Object.entries(data)) {
    if (typeof val === 'number' && val < 0)
      errors.push({ rule: 'V5', severity: 'BLOCKING', message: `${key}=${val} 为负数` });
  }
  // V6: 压缩度vs类型
  if (data['S11.类型'] && data['S11.压缩度'] !== undefined) {
    const isType1 = TYPE1.includes(String(data['S11.类型']));
    if (isType1 && data['S11.压缩度'] < 1) errors.push({ rule: 'V6', severity: 'BLOCKING', message: '1型但压缩度<1' });
    if (!isType1 && data['S11.压缩度'] !== 0) errors.push({ rule: 'V6', severity: 'BLOCKING', message: '非1型但压缩度≠0' });
  }
}

// ==================== C类规则 ====================

// C9a/C9b 单一事实源：当前产物提供 Phase III，前置产物提供 S7 致命计数。
// R2 使用 (P2 data, P1 data)，最终校验使用合并后的 data；不负责 C9c 的 R4.5 豁免。
function checkC9FatalReview(data, errors, s7Data) {
  const c9Party = String(data['S8.PhaseIII.完成方'] || '');
  const c9Status = String(data['S8.PhaseIII.状态'] || '');
  const c9Review = data['S8.PhaseIII.④致命交锋复核'] || '';
  if (c9Status !== '已结晶' || !c9Party || c9Party === '无') return;

  const source = s7Data || data;
  const oppSide = c9Party === '正方' ? '反方' : '正方';
  const oppFatal = Number(source[`S7.${oppSide}赢.致命`] || 0);
  if (oppFatal < 2) return;

  // C9a：④(d) 未执行 → 数据源缺失，需重跑 R2。
  if (!c9Review || c9Review === '不适用') {
    errors.push({
      rule: 'C9a',
      severity: 'BLOCKING',
      message: `SC完成方=${c9Party}，对方致命赢=${oppFatal}≥2，但④致命交锋复核未执行。` +
               `数据源在 P2（R2 产出），请重跑 R2 补全 ④(d) 数据。`
    });
  }

  // C9b：④(d) 已执行但有未覆盖项 → 数据完整但 S11 判定需修正，重跑 R3。
  if (c9Review && c9Review.includes('有未覆盖项')) {
    const uncovered = data['S8.PhaseIII.④致命交锋复核.未覆盖数'] || '?';
    errors.push({
      rule: 'C9b',
      severity: 'BLOCKING',
      message: `SC完成方=${c9Party}，对方致命赢=${oppFatal}≥2，存在 ${uncovered} 项未被微消化覆盖的致命交锋。` +
               `P2 数据完整，请重跑 R3，重新检查 S8.3 ④(d) 数据并修正 S11 判定。`
    });
  }
}

function checkC1_C7(data, errors, opts) {
  opts = opts || {};
  // C1: S8方向→S11类型
  const directionMap = { '1型': TYPE1, '2b型': ['2b'], '2a型': ['2a'], '2c型': ['2c'], '0型': ['0'] };
  if (data['S8.S11类型方向'] && data['S11.类型']) {
    const allowed = directionMap[String(data['S8.S11类型方向'])];
    if (allowed && !allowed.includes(String(data['S11.类型']))) {
      errors.push({ rule: 'C1', severity: 'BLOCKING', message: `S8方向=${data['S8.S11类型方向']}但S11类型=${data['S11.类型']}` });
    }
  }
  // C2: 容量≠低+包着打=成立（异常组合）
  for (const side of ['正方','反方']) {
    const cap = data[`S2.${side}.SC容量预判`];
    const bao = data[`S4.包着打.${side}`];
    if (cap && cap !== '低' && bao === '成立') {
      errors.push({ rule: 'C2', severity: 'WARNING', message: `${side}: SC容量=${cap}但包着打=成立·异常组合` });
    }
  }
  // C3: 假价值+1型 / 果向+2型+高质量微消化
  for (const side of ['正方','反方']) {
    const fake = data[`S5.${side}.真假价值`];
    const direction = data[`S5.${side}.因向果向`];
    const eff = data[`S8.PhaseII.${side}.有效数`] || 0;
    if (fake === '假' && TYPE1.includes(String(data['S11.类型']))) {
      errors.push({ rule: 'C3', severity: 'WARNING', message: `${side}假价值但S11=1型` });
    }
    if (direction === '果向' && ['2a','2b','2c'].includes(String(data['S11.类型'])) && eff >= 2) {
      errors.push({ rule: 'C3', severity: 'WARNING', message: `${side}果向+2型+${eff}个有效微消化·隐性矛盾` });
    }
  }
  // C4: 各跑各的（S8 终判）+1型（260806 换源；fallback 仅为纵深防御）
  const finalDiagC4 = data['S8.碰撞终判'];
  if (finalDiagC4 === '各跑各的' && TYPE1.includes(String(data['S11.类型']))) {
    errors.push({ rule: 'C4', severity: 'BLOCKING', message: '碰撞终判=各跑各的但S11=1型·SC不可能完成' });
  } else if (finalDiagC4 === undefined && data['S4.碰撞诊断'] === '各跑各的' && TYPE1.includes(String(data['S11.类型']))) {
    errors.push({ rule: 'C4', severity: 'BLOCKING', message: '缺少 S8.碰撞终判（旧产物）·需重跑 R2 后再终判' });
  }
  // C5: S7↔S8双向
  const s7Push = data['S7.SC角色.推进节点数'];
  const s8Eff = (data['S8.PhaseII.正方.有效数'] || 0) + (data['S8.PhaseII.反方.有效数'] || 0);
  if (s7Push > 0 && s8Eff === 0) errors.push({ rule: 'C5', severity: 'WARNING', message: `S7推进节点=${s7Push}但S8有效=0` });
  if (s7Push === 0 && s8Eff > 0) errors.push({ rule: 'C5', severity: 'WARNING', message: `S8独立发现${s8Eff}个推进·S7未预标·可能S7漏标` });
  // C6: SC完成方引用
  if (data['S8.SC完成度'] === '完成' && data['S14.SC完成方'] !== data['S8.PhaseIII.完成方']) {
    errors.push({ rule: 'C6', severity: 'WARNING', message: 'S8完成方≠S14引用' });
  }
  if (data['S8.SC完成度'] !== '完成' && data['S14.SC完成方'] !== '无') {
    errors.push({ rule: 'C6', severity: 'WARNING', message: 'S8未完成但S14标注完成方≠无' });
  }
  // C7: 跨轮数据一致性原子校验（C2·V6.5新增·纯DATA比对·不做NLP）
  const s11type = String(data['S11.类型'] || '');
  const phase3Party = String(data['S8.PhaseIII.完成方'] || '');
  if (TYPE1.includes(s11type) && phase3Party === '无') {
    errors.push({ rule: 'C7', severity: 'BLOCKING', message: `S11类型=${s11type}(1型)但PhaseIII完成方=无·SC不可能完成` });
  }
  if (s11type === '2b' && phase3Party !== '无' && phase3Party !== '') {
    errors.push({ rule: 'C7', severity: 'BLOCKING', message: `S11类型=2b(有推进未结晶)但PhaseIII完成方=${phase3Party}≠无·矛盾` });
  }
  // 2026-08-05 审计补充：2a/2c 无结晶 → 完成方必须=无（与 C7 2b 同族约束）
  if (['2a', '2c'].includes(s11type) && phase3Party !== '无' && phase3Party !== '') {
    errors.push({ rule: 'C7', severity: 'BLOCKING', message: `S11类型=${s11type}(无结晶)但PhaseIII完成方=${phase3Party}≠无·矛盾` });
  }
  // 2026-08-05 1d 双完成方字段（S8.PhaseIII.被覆盖完成方）：
  // C14：S11=1d 时被覆盖完成方（先完成方 B'）必出且非空；C15：与完成方互斥（双方各完成一层）；
  // C16：非 1d 时禁止出现；C17：与 structure 首序聚合单元 producer 一致性（DATA 权威，结构回读 WARNING）
  const coveredParty = String(data['S8.PhaseIII.被覆盖完成方'] || '').trim();
  if (s11type === '1d' && coveredParty === '') {
    errors.push({ rule: 'C14', severity: 'BLOCKING', message: 'S11类型=1d但S8.PhaseIII.被覆盖完成方缺失·1d必出先完成方' });
  }
  if (s11type === '1d' && coveredParty !== '' && coveredParty === phase3Party) {
    errors.push({ rule: 'C15', severity: 'BLOCKING', message: `S11类型=1d但被覆盖完成方=${coveredParty}=完成方·双SC完成方不可能同一方` });
  }
  if (s11type !== '1d' && coveredParty !== '') {
    errors.push({ rule: 'C16', severity: 'BLOCKING', message: `S11类型=${s11type}但S8.PhaseIII.被覆盖完成方=${coveredParty}·该字段仅1d有效` });
  }
  // C8: 预判方向vs实际
  if (data['S2.预判SC方向'] === '无向' && data['S8.PhaseIII.完成方'] !== '无') {
    errors.push({ rule: 'C8', severity: 'WARNING', message: 'S2预判无向但SC实际有完成方·锚定效应?' });
  }

  // ==================== C9a + C9b：S7致命交锋 ↔ SC完成方交叉阻断 ====================

  const c9Party = String(data['S8.PhaseIII.完成方'] || '');

  // 批甲 R7f + 七审增强：S7_SC 维度经 R4.5 裁决 → C9 阻断豁免（C9c）；并验证数据侧不再复现矛盾
  const c9Dims = (opts && opts.adjudicatedDims) || [];
  if (c9Dims.includes(DIMENSION_S7_SC)) {
    const s7ProF = Number((data || {})['S7.正方赢.致命'] || 0), s7ConF = Number((data || {})['S7.反方赢.致命'] || 0);
    const s7W = s7ProF > s7ConF ? '正方' : s7ConF > s7ProF ? '反方' : '平';
    const reproduced = (s7W === '反方' && c9Party === '正方') || (s7W === '正方' && c9Party === '反方');
    const adjInfo = (opts && opts.adjudicatedDimsInfo) || [];
    const adjSide = adjInfo.find(i => i.dimension === DIMENSION_S7_SC);
    const side = adjSide && adjSide.pair[(adjSide.adjudicated === 'right') ? 1 : 0];
    const sideVal = side ? String(side).split('=')[1] : '';
    errors.push({ rule: 'C9c', severity: 'WARNING',
      message: reproduced
        ? 'S7致命↔SC完成方矛盾经 R4.5 裁决豁免，但数据仍复现矛盾（完成方=' + c9Party + ' vs 赢家=' + s7W + '）——以标注「' + sideVal + '」为准'
        : 'S7致命↔SC完成方矛盾经 R4.5 裁决，C9 阻断豁免（以裁决为准）' });
  } else {
    checkC9FatalReview(data, errors);
  }

  // ==================== C10a + C10b：操作层外延一致性校验 ====================

  const driftChecked = data['S8.PhaseIII.④外延漂移.检查完成'] || '否';
  const driftSignal = data['S8.PhaseIII.④外延漂移信号'] || '';
  const rationality = data['S8.PhaseIII.④外延漂移.合理性'] || '';
  const s4Relation = data['S8.PhaseIII.④外延漂移.S4关联'] || '';

  // ---- C10a：检查是否执行 ----
  if (driftChecked !== '是') {
    errors.push({ rule: 'C10a', severity: 'WARNING',
      message: 'S8.3 ④(e) 外延一致性检查未执行，建议 R3 复核时补查。' });
  }

  // ---- C10b：检测漂移信号（管道仅读取Agent显式分类·不做语义判断） ----
  if (driftSignal && driftSignal.startsWith('有')) {
    if (rationality.includes('偷换外延')) {
      let msg = `检测到明确标注为"偷换外延"的漂移信号：${driftSignal}。外延已超出合法聚焦范围。`;
      if (s4Relation === '潜在风险已实现') msg += '（S4黄色信号已预警·双重确认）';
      errors.push({ rule: 'C10b', severity: 'BLOCKING', message: msg });
    } else {
      let msg = `检测到外延漂移信号（聚焦子集/边界模糊）：${driftSignal}`;
      if (s4Relation === '潜在风险已实现') msg += '。S4黄色信号已预警·建议优先复核。';
      errors.push({ rule: 'C10b', severity: 'WARNING', message: msg });
    }
  }

  // ---- C10b 追加：Agent未发现漂移但S4曾预警 → 潜在漏检 ----
  if ((!driftSignal || driftSignal === '无') && s4Relation === '潜在风险未实现') {
    errors.push({ rule: 'C10b', severity: 'WARNING',
      message: 'Agent外延检查未发现漂移，但S4曾预警黄色信号——潜在漏检。R3须在T1.6中确认。' });
  }

  // ==================== C11a/C11b：判定质量信号校验 ====================

  const c11Visibility = data['S8.PhaseIII.③显性程度'] || '';
  const c11S11type = String(data['S11.类型'] || '');
  const c11Closure = data['S11.闭合'] || '';

  // ---- C11a：③=语义承接且S11=1型 → 闭合状态必须为"边界" ----
  if (c11Visibility === '语义承接' && ['1a','1b','1c','1d'].includes(c11S11type)) {
    if (c11Closure === '封口' || !c11Closure) {
      errors.push({ rule: 'C11a', severity: 'WARNING',
        message: 'Phase III ③显性程度=语义承接，S11=1型——决胜逻辑应标注"证据强度降级"，S11.闭合应标注为"边界"而非"封口"。' });
    }
  }

  // ---- C11b：质量诊断≥2类触发但S9感性降权未确认已执行 ----
  const diagTrigger = data['S8.7.质量诊断触发'] || '否';
  const degradationDone = data['S9.感性.质量降权已执行'] || '';

  if (diagTrigger === '是(≥2类)' && degradationDone !== '是') {
    errors.push({ rule: 'C11b', severity: 'WARNING',
      message: 'S8.7质量诊断触发=是(≥2类)，但S9.感性.质量降权已执行≠是。请确认感性向度已执行降权。' });
  }
}

// ==================== 新/旧合同判定（260810·批次3：P1-B 修订·单一事实源） ====================
// S7 表头含 CP-ID+靶心+削弱指向 = 新合同（260806 后靶心格式）；否则旧合同。
// 判据分级（S8C-R）、V-B6e、host-node P1 探测共用本判定核心。

function checkP1_P3(data, errors, newContract) {
  // P1: Phase I→II
  for (const side of ['正方','反方']) {
    const ph1 = data[`S8.PhaseI.${side}`];
    const ph2 = data[`S8.PhaseII.${side}.有效数`];
    if ((ph1 === '否决' || ph1 === '未完成') && ph2 > 0) {
      errors.push({ rule: 'P1', severity: 'BLOCKING', message: `${side} PhaseI=${ph1}但PhaseII有效=${ph2}` });
    }
  }
  // P2: Phase III→II
  if (data['S8.PhaseIII.状态'] === '已结晶') {
    const side = data['S8.PhaseIII.完成方'];
    if (side && side !== '无') {
      const eff = data[`S8.PhaseII.${side}.有效数`] || 0;
      if (eff < 1) errors.push({ rule: 'P2', severity: 'BLOCKING', message: `${side} PhaseIII已结晶但PhaseII有效=0` });
    }
  }
  // P3（260810 重写）：L1 定义自洽 BLOCKING + L2 结构期望 WARNING + 判据检查（S8C 段）
  checkCompletionConsistency(data, errors, { newContract });
}

// ==================== S8C 完成度一致性（260810·批次3：L1 定义自洽 + L2 结构期望 + 判据） ====================
// 原则：机械层管一致性，LLM 管语义裁定（用户 260810 拍板）。
// L1 矩阵（16 格·封闭集合，新增组合须走方案审核）：
//   完成5：未结晶/④不通过/⑤不通过/PhaseII=0/⑥独立平行
//   未完成3：PhaseII=0/已结晶（V-S8B 兜底·双层闭合）/⑥独立平行
//   半完成2：PhaseII=0/已结晶且非⑥-b例外
//   启动未推进2：PhaseII>0/已结晶
//   未启动2：任一方PhaseI完成/S3=0
//   不存在1：S3>0
//   全局格1（R6）：⑥=独立平行 且 PhaseII=0（⑥ 仅双方有结晶候选时触发·L2612）

function checkCompletionConsistency(data, errors, opts) {
  for (const h of getCompletionHardConflicts(data)) {
    errors.push({ rule: 'S8C-L1', severity: 'BLOCKING', message: `完成度=${h.value} 与定义冲突: ${h.reason}` });
  }
  const expected = deriveCompletionExpected(data);
  if (expected && data['S8.SC完成度'] && expected !== data['S8.SC完成度']) {
    errors.push({ rule: 'S8C-L2', severity: 'WARNING', message: `完成度判定=${data['S8.SC完成度']} 与结构期望=${expected} 存在分歧（LLM 语义判定·报告标注，非错误提示）` });
  }
  const rationale = String(data['S8.SC完成度.判据'] || '').trim();
  const newContract = !!(opts && opts.newContract);
  if (rationale.length < 10) {
    const sev = newContract ? 'BLOCKING' : 'WARNING';
    errors.push({ rule: 'S8C-R', severity: sev, message: newContract
      ? '完成度判据（S8.SC完成度.判据）缺失或<10字·必出（≤40字，回引Phase/④⑤⑥或场感描述）'
      : '完成度判据缺失（旧合同·不阻断·建议补充）' });
  }
}

// ==================== 加载器（边界标记驱动 V7.5.3） ====================

let sectionIndexCache = null;

function checkR5Contract(narrative, registry, opts) {
  opts = opts || {};
  const chapters = opts.chapters || ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12'];
  const errors = [];
  const warnings = [];
  if (!registry || !Array.isArray(registry.inserts)) {
    return { passed: false, errors: [{ rule: 'A0', severity: 'BLOCKING', message: 'INSERT注册表不可用' }], warnings };
  }
  const regNames = new Set(registry.inserts.map(r => r.name));
  const allNames = (narrative.match(/<!--INSERT_(C\d+_[A-Z0-9_]+)-->/g) || [])
    .map(m => m.replace('<!--INSERT_', '').replace('-->', ''));
  const unregistered = [...new Set(allNames.filter(n => !regNames.has(n)))];
  for (const n of unregistered) errors.push({ rule: 'A2', severity: 'BLOCKING', message: '未注册INSERT名: ' + n });

  const parts = narrative.replace(/\r\n/g, '\n').split(/^##\s*C(\d{1,2})\b[^\n]*\n?/gm);
  const sections = {};
  for (let i = 1; i < parts.length; i += 2) sections['C' + parts[i]] = parts[i + 1] || '';

  for (const ch of chapters) {
    const sec = sections[ch];
    if (sec === undefined) {
      errors.push({ rule: 'A1', severity: 'BLOCKING', message: ch + ' 章节缺失' });
      continue;
    }
    const xp = sec.match(/<!--XP:([\s\S]*?)-->/);
    if (!xp || !xp[1].trim()) errors.push({ rule: 'A3', severity: 'BLOCKING', message: ch + ' 缺少非空 <!--XP:...-->' });
    const chInserts = registry.inserts.filter(r => r.ch === ch && r.consumer === 'R6b' &&
      (r.producer === 'R5' || (ch === 'C8' && r.producer === 'R2.5')));
    for (const r of chInserts) {
      if (r.condition) {
        const { key, val } = conditionKeyVal(r.condition);
        const actual = (key === 'S4.定义争议触发' && opts.s4DefTrigger !== undefined)
          ? opts.s4DefTrigger : (opts.data ? opts.data[key] : undefined);
        if (actual === val) {
          if (!insertSlotHasContent(sec, r.name))
            errors.push({ rule: 'A1', severity: 'BLOCKING', message: '条件INSERT ' + r.name + ' 缺失或为空（' + ch + '）' });
        } else if (actual !== undefined && sec.includes('<!--INSERT_' + r.name + '-->')) {
          warnings.push({ rule: 'A1W', severity: 'WARNING', message: '条件不满足仍输出 ' + r.name + '（' + ch + '，条件 ' + r.condition + '）' });
        }
        continue;
      }
      if (!insertSlotHasContent(sec, r.name))
        errors.push({ rule: 'A1', severity: 'BLOCKING', message: '无条件INSERT ' + r.name + ' 缺失或为空（' + ch + '）' });
    }
    // R5 规范要求纯 Markdown；C1 诗评若携带 HTML 容器，R6a 的诗行装配会将其误判为空。
    // 在半区门禁前置反馈，避免把可修正的格式问题推迟到最终 HTML 门禁。
    if (ch === 'C1') {
      const poemMatch = sec.match(/<!--INSERT_C1_01_POEM-->([\s\S]*?)(?=<!--INSERT_C\d+_[A-Z0-9_]+-->|$)/);
      const poem = poemMatch ? poemMatch[1] : '';
      if (/<\/?[A-Za-z][^>]*>/.test(poem)) {
        errors.push({ rule: 'A1', severity: 'BLOCKING', message: 'C1_01_POEM 诗评必须保持纯 Markdown，禁止 HTML 容器（如 <div>），否则 R6a 无法装配 .po' });
      }
    }
  }
  return { passed: errors.length === 0, errors, warnings };
}

// D1/D2：判决行/比分与 S15 DATA 一致性（合同固定 正方:反方 顺序，M1）
// 判决行：**反方（队名）胜（4 : 6）**（兼容无队名/无空格/无粗体变体）

function checkVerdictConsistency(narrative, data) {
  const errors = [];
  const warnings = [];
  const pro = data['S15.正方得分'];
  const con = data['S15.反方得分'];
  const winner = data['S15.获胜方'];
  if (pro === undefined || con === undefined || !winner) {
    return { passed: true, errors, warnings: [{ rule: 'D0', severity: 'WARNING', message: 'S15 DATA 缺失，跳过判决一致性校验' }] };
  }
  const vRe = /\*{0,2}(正方|反方)\s*(?:（[^）]*）)?\s*胜\s*（\s*(\d+)\s*:\s*(\d+)\s*）\s*\*{0,2}/g;
  let m, foundVerdict = false;
  while ((m = vRe.exec(narrative)) !== null) {
    foundVerdict = true;
    const side = m[1] === '正方' ? '正方' : '反方';
    const a = parseInt(m[2], 10), b = parseInt(m[3], 10);
    if (a !== pro || b !== con)
      errors.push({ rule: 'D1', severity: 'BLOCKING', message: '判决行「' + m[0] + '」与 S15 不符（应为 ' + pro + ':' + con + '，合同固定 正方:反方）' });
    if (side !== winner)
      errors.push({ rule: 'D1', severity: 'BLOCKING', message: '判决行获胜方=' + side + ' 与 S15.获胜方=' + winner + ' 不符' });
  }
  if (!foundVerdict) warnings.push({ rule: 'D1', severity: 'WARNING', message: '叙事中未找到 **X方胜（A:B）** 判决行' });
  // D2（2026-08-05 收窄）：只拦“判决/最终/获胜”语境下的比分（如“最终判决：反方获胜。比分6:4”），
  // 放行校准链中间比分（6:4→7:3）与完整性注释（S15比分=…）——避免对非终判文本误杀。
  const verdictKw = /(获胜|判决|最终|方胜)/;
  for (const line of narrative.replace(/\r\n/g, '\n').split('\n')) {
    const rm = line.match(/比分\s*(\d+)\s*:\s*(\d+)/);
    if (!rm || !verdictKw.test(line)) continue;
    const a = parseInt(rm[1], 10), b = parseInt(rm[2], 10);
    if (a !== pro || b !== con)
      errors.push({ rule: 'D2', severity: 'BLOCKING', message: '比分「' + rm[0] + '」与 S15 不符（应为 ' + pro + ':' + con + '，合同固定 正方:反方）' });
  }
  return { passed: errors.length === 0, errors, warnings };
}

function checkNarrative(file, options) {
  options = options || {};
  const md = fs.readFileSync(file, 'utf-8');
  const missing = [];
  const warnings = [];
  // P2：R5 输出禁止 ``` 围栏包裹（与 assessArtifact 同一规则，最终防线）
  if (/(^|\n)```[^\n]*\n[\s\S]*?\n```/.test(md)) missing.push('代码围栏残留（```）');
  for (let i = 1; i <= 12; i++) {
    const pattern = new RegExp(`## C${i}\\b`);
    if (!pattern.test(md)) missing.push(`C${i}`);
  }
  // Z''：未显式声明 dataSource 的 standalone/legacy 检查可按旧方式回落；
  // formal host 一旦显式传入 dataSource，即把它声明为语义权威：缺失/不可读必须 BLOCKING，禁止弱化为自洽检查。
  const dir = path.dirname(path.resolve(file));
  const hasExplicitDataSource = Object.prototype.hasOwnProperty.call(options, 'dataSource') && !!options.dataSource;
  const dataSource = hasExplicitDataSource ? options.dataSource :
    (fs.existsSync(path.join(dir, 'transition-final.md')) ? path.join(dir, 'transition-final.md') : null);
  let data = {};
  if (dataSource) {
    if (!fs.existsSync(dataSource)) {
      if (hasExplicitDataSource) missing.push('正式叙事数据源缺失: ' + dataSource);
    } else {
      try { data = extractDataMarkers(fs.readFileSync(dataSource, 'utf-8')); }
      catch (e) { if (hasExplicitDataSource) missing.push('正式叙事数据源读取/解析失败: ' + e.message); }
    }
  }
  // L2: C7 微消化计数一致性（DATA 标记比对 + S8 锚定）——共享契约检查（validateHalf 轮门禁同用，单一实现）
  for (const e of checkC7DataContract(md, { s8: data })) missing.push(e);
  // A1-A3：R5/R2.5 输出合同（INSERT 全覆盖+非空、注册名、XP）
  let registry = null;
  try { registry = parseInsertRegistry(options.skillPath || SKILL_PATH); }
  catch (e) { missing.push('INSERT注册表加载失败: ' + e.message); }
  if (registry) {
    const cr = checkR5Contract(md, registry, { s4DefTrigger: data['S4.定义争议触发'], data });
    for (const e of cr.errors) missing.push(e.rule + ': ' + e.message);
  }
  // D1/D2：判决行/比分一致性
  const vc = checkVerdictConsistency(md, data);
  for (const e of vc.errors) missing.push(e.rule + ': ' + e.message);
  // C4 专项（260806·B4）：C2 认知修正三件套存在性校验（WARNING·不阻断，缺任一提示补写）
  const c2Start = md.indexOf('## C2');
  const c2End = md.indexOf('## C3');
  if (c2Start >= 0 && c2End > c2Start) {
    const c2 = md.substring(c2Start, c2End);
    if (!/预判/.test(c2)) warnings.push({ rule: 'C2-TRIPLE', severity: 'WARNING', message: 'C2 缺“立论预判”表述（认知修正三件套）' });
    if (!/终判/.test(c2)) warnings.push({ rule: 'C2-TRIPLE', severity: 'WARNING', message: 'C2 缺“全场终判”表述（认知修正三件套）' });
    if (!/(修正|证据|M-ID|CP-ID)/.test(c2)) warnings.push({ rule: 'C2-TRIPLE', severity: 'WARNING', message: 'C2 缺“修正证据”（M-ID/CP-ID 引用·认知修正三件套）' });
  }
  // 叙事人格专项（260806·B3）：V-TR4 R5-3.5 四级拓展（WARNING·不阻断）
  for (const line of md.replace(/\r\n/g, '\n').split('\n')) {
    const t = normalizeMIdText(line.trim());
    if (!t) continue;
    if (/(建议|下次|不妨|可以试着)/.test(t) && !/(M-ID|CP-ID|M-(?:ZH|FA)-\d+|CP-\d+|S\d+\.|→|（教学发挥)/.test(t)) {
      warnings.push({ rule: 'V-TR4', severity: 'WARNING', message: 'C 级建议缺源引用（需 M-ID/CP-ID/字段引用）: ' + t.slice(0, 40) });
    }
    if (/(应该|必须|应当)/.test(t) && !/(M-ID|CP-ID|M-(?:ZH|FA)-\d+|CP-\d+|S\d+\.|→|（教学发挥·非裁决事实）)/.test(t)) {
      warnings.push({ rule: 'V-TR4', severity: 'WARNING', message: '疑似无源判断（D 级）·需标注“（教学发挥·非裁决事实）”: ' + t.slice(0, 40) });
    }
  }
  // V-C11E（260807）：C11 技术失误列零失误率复核（WARNING·不阻断）
  for (const side of ['正方', '反方']) {
    const dashN = countC11Dash(md, side);
    if (dashN >= 2) warnings.push({ rule: 'V-C11E', severity: 'WARNING', message: `C11 ${side} 技术失误为“—” ${dashN} 人（≥2）·零失误率高，需复核是否遗漏` });
  }
  if (missing.length > 0) {
    return { passed: false, missing, warnings, message: `叙事.md 验证失败: ${missing.join('; ')}` };
  }
  return { passed: true, warnings, message: '叙事.md 12个 C 模块标记完整 + L2 C7计数一致 + R5契约/D1-D2一致' };
}

// S1（D3）：关键块存在性断言正则——属性无关匹配（单一事实源 = scripts/html-contract.js；加载失败回退旧精确匹配）

function checkHtml(file, options) {
  options = options || {};
  var html = fs.readFileSync(file, 'utf-8');
  var skillPath = (options.skillPath) || SKILL_PATH;
  var stage = options.stage || 'final';
  var dataSource = options.dataSource || null;
  var blocking = [];
  var warnings = [];

  var registry;
  try { registry = parseInsertRegistry(skillPath); } catch (e) {
    return { passed: false, blocking: [{ rule: 'REG-PARSE', severity: 'BLOCKING', message: e.message }], warnings: [] };
  }

  var htmlInserts = html.match(/<!--INSERT_([A-Z0-9_]+)-->/g) || [];
  var htmlNames = htmlInserts.map(function(m) { return m.replace('<!--INSERT_', '').replace('-->', ''); });
  var htmlNameSet = {};
  htmlNames.forEach(function(n) { htmlNameSet[n] = true; });

  // 提取 DATA：formal 调用若显式声明 dataSource，则该文件是最终语义权威，缺失/不可读必须阻断；
  // 未显式 dataSource 的 standalone/legacy 检查仍可从 HTML DATA 注释回落。
  var data = {};
  var hasExplicitDataSource = Object.prototype.hasOwnProperty.call(options, 'dataSource') && !!dataSource;
  if (hasExplicitDataSource) {
    if (!fs.existsSync(dataSource)) {
      blocking.push({ rule: 'DATA-SOURCE', severity: 'BLOCKING', message: '正式 HTML 数据源缺失: ' + dataSource });
    } else {
      try { data = extractDataMarkers(fs.readFileSync(dataSource, 'utf-8')); }
      catch (e) { blocking.push({ rule: 'DATA-SOURCE', severity: 'BLOCKING', message: '正式 HTML 数据源读取/解析失败: ' + e.message }); }
    }
  } else {
    var dataMatches = html.match(/<!--DATA:\s*(\S+?)=(.+?)\s*-->/g) || [];
    dataMatches.forEach(function(m) {
      var kv = m.match(/<!--DATA:\s*(\S+?)=(.+?)\s*-->/);
      if (kv) data[kv[1]] = kv[2].trim();
    });
  }

  if (stage === 'scaffold') {
    var required = registry.inserts.filter(function(r) { return r.consumer === 'R6b'; });
    required.forEach(function(r) {
      var shouldAppear = true;
      if (r.condition) {
        var parts = r.condition.split('=');
        var key = parts[0] === 'def' ? 'S4.定义争议触发' : parts[0];
        shouldAppear = (data[key] === parts[1]);
      }
      if (shouldAppear && !htmlNameSet[r.name]) {
        blocking.push({ rule: 'REG-MISS', severity: 'BLOCKING', message: 'INSERT缺失: ' + r.name + ' (' + r.ch + ')' });
      }
    });
    htmlNames.forEach(function(name) {
      if (!registry.inserts.some(function(r) { return r.name === name; })) {
        blocking.push({ rule: 'REG-UNREG', severity: 'BLOCKING', message: '未注册INSERT: ' + name });
      }
    });
  } else {
    if (htmlInserts.length > 0) {
      var unique = [];
      htmlNames.forEach(function(n) { if (unique.indexOf(n) < 0) unique.push(n); });
      blocking.push({ rule: 'REG-RESIDUAL', severity: 'BLOCKING', message: 'INSERT残留: ' + unique.length + '类/' + htmlInserts.length + '个' });
    }
    var radarMatch = html.match(/<!--RADAR_DATA:\s*([^>]+)-->/);
    if (!radarMatch) warnings.push({ rule: 'RADAR-MISS', severity: 'WARNING', message: 'RADAR_DATA注释缺失' });
    else {
      var vals = radarMatch[1].split(',').filter(function(p) { return /=\d+/.test(p); });
      if (vals.length !== 12) warnings.push({ rule: 'RADAR-COUNT', severity: 'WARNING', message: 'RADAR_DATA数值数=' + vals.length + '(预期12)' });
    }
    // 检测 HTML 中残留的表格分隔行单元格（分隔行进入 HTML 后已被拆成 <td>/<th> 单元格）
    if (/<\s*t[dh][^>]*>\s*[-:]{3,}\s*<\/\s*t[dh]\s*>/i.test(html))
      warnings.push({ rule: 'TABLE-SEP', severity: 'WARNING', message: 'HTML中疑似残留表格分隔行单元格' });
    for (var i = 1; i <= 12; i++) {
      if (html.indexOf('c-module c' + i + '"') < 0 && html.indexOf('c-module c' + i + ' ') < 0)
        warnings.push({ rule: 'C-DIV', severity: 'WARNING', message: 'C' + i + '-div 缺失' });
    }
    if (!/<style[^>]*>[\s\S]*?<\/style>/.test(html)) warnings.push({ rule: 'STYLE', severity: 'WARNING', message: '<style>标签缺失' });
    // D3/D4/D5：模块级验收（模块 div 为兄弟节点，可用前瞻切分）
    var modRe = /<div class="sk[^"]* c-module c(\d+)"[^>]*>([\s\S]*?)(?=<div class="sk[^"]* c-module c\d+"[^>]*>|$)/g;
    var modMatch;
    while ((modMatch = modRe.exec(html)) !== null) {
      var modId = 'C' + modMatch[1];
      var modBody = modMatch[2];
      // D4：同模块内同名 h3 重复 → BLOCKING
      var h3Seen = {};
      var h3Re = /<h3[^>]*>([\s\S]*?)<\/h3>/g;
      var h3m;
      while ((h3m = h3Re.exec(modBody)) !== null) {
        var h3key = h3m[1].replace(/<[^>]+>/g, '').trim();
        if (h3Seen[h3key]) blocking.push({ rule: 'D4', severity: 'BLOCKING', message: modId + ' 重复 h3: ' + h3key });
        h3Seen[h3key] = true;
      }
      // D3：C1 关键块（诗评/判决/六向度表/判准表；简明档豁免判准表）
      if (modId === 'C1') {
        var po, wn;
        try {
          // S1 完整版：关键块清单/属性无关正则单一事实源 = scripts/html-contract.js
          var HC = require('../scripts/html-contract.js');
          var KB = HC.HTML_KEY_BLOCKS || [];
          var kbPo = KB.find(function(k) { return k.cls === 'po'; }) || D3_FALLBACK_BLOCKS.po;
          var kbWn = KB.find(function(k) { return k.cls === 'wn'; }) || D3_FALLBACK_BLOCKS.wn;
          po = modBody.match(HC.buildKeyBlockRegex(kbPo));
          wn = modBody.match(HC.buildKeyBlockRegex(kbWn));
        } catch (e) {
          // 回退：html-contract 加载失败 → 旧版精确匹配（当前行为），校验层不中断
          po = modBody.match(/<div class="po">([\s\S]*?)<\/div>/);
          wn = modBody.match(/<p class="wn">([\s\S]*?)<\/p>/);
        }
        if (!po || !po[1].trim()) blocking.push({ rule: 'D3', severity: 'BLOCKING', message: 'C1 缺少非空诗评 .po' });
        if (!wn || !wn[1].trim()) blocking.push({ rule: 'D3', severity: 'BLOCKING', message: 'C1 缺少非空胜负宣告 .wn' });
        var c1Tables = modBody.match(/<table[^>]*>([\s\S]*?)<\/table>/g) || [];
        var hasHexad = c1Tables.some(function(t) { return t.indexOf('向度') >= 0; });
        var hasJudgment = c1Tables.some(function(t) { return t.indexOf('判准') >= 0; });
        if (!hasHexad) blocking.push({ rule: 'D3', severity: 'BLOCKING', message: 'C1 缺少六向度表' });
        if (!(options.depth && options.depth.verdict === '简明') && !hasJudgment)
          blocking.push({ rule: 'D3', severity: 'BLOCKING', message: 'C1 缺少判准表' });
      }
      // D5：C3 面板类型 vs S11.类型（需要 dataSource）
      if (modId === 'C3' && data['S11.类型']) {
        var tg = modBody.match(/class="tg\s+t([0-9a-z]+)"/);
        if (!tg) blocking.push({ rule: 'D5', severity: 'BLOCKING', message: 'C3 面板缺少类型徽章 tg tX' });
        else if (tg[1] !== String(data['S11.类型']))
          blocking.push({ rule: 'D5', severity: 'BLOCKING', message: 'C3 面板类型 t' + tg[1] + ' 与 S11.类型=' + data['S11.类型'] + ' 不一致' });
      } else if (modId === 'C3' && !dataSource) {
        warnings.push({ rule: 'D5', severity: 'WARNING', message: '未提供 dataSource，跳过 C3 面板类型一致性校验' });
      }
    }
    // V7.7·7fixes 新增检测
    // TBL-EMPTY: 每张 table.tb 的 tbody 必须 ≥1 行（<details> 内子表例外）
    var tbRegex = /<table class="tb"[^>]*>([\s\S]*?)<\/table>/gi;
    var tbMatch;
    while ((tbMatch = tbRegex.exec(html)) !== null) {
      var tableContent = tbMatch[1];
      var inDetails = /<details[^>]*>[\s\S]*$/.test(html.substring(0, tbMatch.index));
      var tbodyMatch = tableContent.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
      var tbodyContent = tbodyMatch ? tbodyMatch[1].trim() : '';
      var hasDataRow = /<tr[^>]*>[\s\S]*?<t[dh][^>]*>[\s\S]*?<\/t[dh]>/.test(tbodyContent);
      if (!hasDataRow && !inDetails) {
        blocking.push({ rule: 'TBL-EMPTY', severity: 'BLOCKING', message: '表格 tbody 无数据行（<details>内子表例外）' });
        break; // 只报告一次
      }
    }
    // TBL-EMPTY-COLSPAN: 空 colspan 格检测
    if (/<td colspan="[^"]*"><\/td>/i.test(html))
      warnings.push({ rule: 'TBL-EMPTY-COLSPAN', severity: 'WARNING', message: '空单元格被赋予colspan' });
    // MD-BOLD-RESIDUE: 裸 ** 残留检测
    if (/\*\*[^*]+\*\*/.test(html))
      warnings.push({ rule: 'MD-BOLD-RESIDUE', severity: 'WARNING', message: 'HTML中疑似残留未转义的粗体标记**' });
    // MD-LIST-RESIDUE: 列表前缀残留检测
    if (/<p[^>]*>\s*-{1,2}\s+/.test(html))
      warnings.push({ rule: 'MD-LIST-RESIDUE', severity: 'WARNING', message: 'HTML中疑似残留Markdown列表前缀' });
    // CMT-RESIDUE: 非 WARNING 注释残留检测
    // A7-B5：RADAR_DATA 为规则 4.1 强制输出的数据忠实度注释，加入白名单
    var cmtMatches = html.match(/<!--(?!WARNING:)(?!RADAR_DATA:)[\s\S]*?-->/g) || [];
    if (cmtMatches.length > 0)
      warnings.push({ rule: 'CMT-RESIDUE', severity: 'WARNING', message: 'HTML中残留非WARNING注释: ' + cmtMatches.length + '处' });
  }
  // H-2/J-1（源锚层 v1）：disclaimer=true 时最终报告必须含免责横幅（DISCLAIMER_TEXT 单一事实源 = html-contract.js）
  // disclaimer 缺省（如 CLI check-html 无 source-anchor 上下文）→ 跳过横幅校验，不误报
  if (options.disclaimer === true) {
    try {
      var HC2 = require('../scripts/html-contract.js');
      if (html.indexOf(HC2.DISCLAIMER_TEXT) < 0)
        blocking.push({ rule: 'H2-DISCLAIMER', severity: 'BLOCKING', message: '报告缺失免责声明横幅（DISCLAIMER_TEXT）——渲染注入缺失' });
    } catch (e) {
      blocking.push({ rule: 'H2-DISCLAIMER', severity: 'BLOCKING', message: 'html-contract 加载失败，无法校验免责横幅: ' + e.message });
    }
  }
  if (blocking.length > 0) return { passed: false, blocking: blocking, warnings: warnings };
  return { passed: true, blocking: [], warnings: warnings };
}
// ==================== B2: TABLE 标记验证 ====================

function checkTables(file) {
  const md = fs.readFileSync(file, 'utf-8');
  const warnings = [];

  // T1: TABLE 标记配对检查
  const tableStarts = (md.match(/<!--TABLE:([^>]+)-->/g) || []).length;
  const tableEnds = (md.match(/<!--\/TABLE-->/g) || []).length;
  if (tableStarts !== tableEnds) {
    return { passed: false, warnings, message: `TABLE 标记未配对: 开始=${tableStarts} 结束=${tableEnds}` };
  }

  // T2: C5-C12 表格存在性检查（基于 TABLE 标记名称）
  const expectedTables = [
    '架构对比表', '论证完成度表',           // C5
    '交锋裁决表',                           // C6
    'SC总览表', '微消化实例表',             // C7
    '修辞动力分析·正方', '修辞动力分析·反方', // C8
    '证明轴', '说服轴', '第三方轴',          // C9
    '持方互换',                             // C10
    '辩手点评·正方', '辩手点评·反方',       // C11
    '数据完整性扫描',                        // C12
  ];
  const tableBlocks = md.match(/<!--TABLE:([^>]+)-->/g) || [];
  for (const expected of expectedTables) {
    const found = tableBlocks.some(b => b.includes(`名称=${expected}`));
    if (!found) warnings.push(`缺少表格: ${expected}`);
  }

  // T3: verdict 类型列名匹配警告
  const verdictBlocks = [...md.matchAll(/<!--TABLE:([^>]*类型=verdict[^>]*)-->/g)];
  for (const match of verdictBlocks) {
    const attrs = match[1];
    const colMatch = attrs.match(/列=([^,]+)/);
    if (colMatch) {
      const cols = colMatch[1].split('|');
      const hasWinnerCol = cols.some(c => /赢家|胜方|裁决结果/.test(c));
      if (!hasWinnerCol) {
        const nameMatch = attrs.match(/名称=([^,]+)/);
        const name = nameMatch ? nameMatch[1] : '未知';
        warnings.push(`verdict表[${name}]列名不含"赢家/胜方/裁决结果"→颜色规则不触发`);
      }
    }
  }

  if (warnings.length > 0) {
    return { passed: true, warnings, message: `TABLE 标记验证通过·${warnings.length}个警告: ${warnings.join('; ')}` };
  }
  return { passed: true, message: `TABLE 标记验证通过·${tableStarts}个表格·配对正确` };
}

// ==================== V3.2新增：R2.5 跨方修辞合成轮验证 ====================

function checkStructure(jsonPath, opts) {
  opts = opts || {};
  const errors = [];
  const warnings = [];
  let data;
  try { data = parseStructureJson(fs.readFileSync(jsonPath, 'utf-8')); }
  catch (e) { errors.push({ rule: 'S0', severity: 'BLOCKING', message: `structure.json 解析失败: ${e.message}` }); return { passed: false, errors, warnings }; }

  if (!data.meta || !data.layers || !data.cross_reference) {
    errors.push({ rule: 'S1', severity: 'BLOCKING', message: '缺少顶层字段' }); return { passed: false, errors, warnings };
  }
  // G0-1 提前到 R4 门禁（2026-08-05 实测发现）：meta.s11_original_type 必须与 transition-final 的 S11.类型 一致，
  // 否则渲染端 G0 会阻断——让 R4 轮带反馈重试，而不是在 R6 才暴露
  if (opts && opts.tfPath && fs.existsSync(opts.tfPath)) {
    try {
      const tfData = extractDataMarkers(fs.readFileSync(opts.tfPath, 'utf-8'));
      const s11 = tfData['S11.类型'];
      const orig = data.meta && data.meta.s11_original_type;
      if (s11 && orig && s11 !== orig)
        errors.push({ rule: 'G0-1', severity: 'BLOCKING', message: `R4类型记录(${orig})与S11 DATA(${s11})不一致` });
    } catch (e) { /* 读取失败不阻断，由渲染端 G0 兜底 */ }
  }

  const layers = data.layers;
  // 非法 R4 产物（例如把 mechanisms 对象误放进 layers）也必须返回门禁错误，
  // 不能因 type 缺失在 startsWith 上抛异常，遮蔽可重试反馈。
  const layerType = layer => layer && typeof layer.type === 'string' ? layer.type : '';
  // V-B1（F3 修正）：0型（s11_original_type 或 type_override=0）允许 layers=1；其余 2-4
  const isZero = (data.meta && (data.meta.s11_original_type === '0' || data.meta.type_override === '0'));
  const minLayers = isZero ? 1 : 2;
  if (!Array.isArray(layers) || layers.length < minLayers || layers.length > 4)
    errors.push({ rule: 'V-B1', severity: 'BLOCKING', message: `layers长度=${layers?.length}·预期${minLayers}-4` });

  if (layers?.length > 0) {
    if (layerType(layers[0]) !== '框架铺设')
      errors.push({ rule: 'V-B2', severity: 'BLOCKING', message: `layers[0].type≠框架铺设` });
    if (!layerType(layers[layers.length - 1]).startsWith('收束'))
      errors.push({ rule: 'V-B3', severity: 'BLOCKING', message: `layers[-1].type不以收束开头` });
    for (let i=1; i<layers.length-1; i++)
      if (layerType(layers[i]) !== 'SC推进')
        errors.push({ rule: 'V-B4', severity: 'BLOCKING', message: `layers[${i}].type≠SC推进` });

    // V-B5a: 枚举合法
    const validRels = ['上位覆盖','独立并列','同层加固'];
    for (let i=1; i<layers.length; i++)
      if (layers[i].relation_to_prev && !validRels.includes(layers[i].relation_to_prev))
        errors.push({ rule: 'V-B5a', severity: 'BLOCKING', message: `layers[${i}].relation非法` });

    // V-B5b: 上位覆盖/同层加固必须有citation_basis且≥10字
    for (let i=1; i<layers.length; i++)
      if (['上位覆盖','同层加固'].includes(layers[i].relation_to_prev) && (!layers[i].citation_basis || layers[i].citation_basis.length < 10))
        errors.push({ rule: 'V-B5b', severity: 'BLOCKING', message: `layers[${i}]上位/同层但citation_basis缺失或<10字` });

    // V-B5c【V3.0新增·评审意见机制盲区2】: citation_basis必须含推进层ID或M-ID
    for (const layer of layers) {
      if (layerType(layer) === 'SC推进' && layer.citation_basis) {
        const hasLayerRef = /推进层\s*[0-9]|层\s*[0-9]|前[一二三四]推进层|上一推进层|layer\s*[0-9]/i.test(layer.citation_basis);
        const hasMRef = /M-(?:ZH|FA)-\d+/.test(normalizeMIdText(layer.citation_basis));
        if (!hasLayerRef && !hasMRef)
          errors.push({ rule: 'V-B5c', severity: 'BLOCKING', message: `citation_basis必须引用具体推进层或M-ID: "${layer.citation_basis.substring(0,50)}..."` });
      }
    }
  }

  // V-B6（A8）：nodes 格式——v2 对象必填（string → BLOCKING）；
  // A8-P7：完整管道链（tfPath 存在）下 v1 string 一律 BLOCKING，禁止兼容降级继续；独立 check-structure 仍允许 WARNING 查看旧数据
  const version = (data.meta && data.meta.schema_version) || 'v1';
  const inPipelineChain = !!(opts && opts.tfPath);
  for (const layer of layers) {
    if (!layer.nodes) continue;
    let v1Warned = false;
    for (const n of layer.nodes) {
      if (typeof n === 'string') {
        if (version === 'v2') errors.push({ rule: 'V-B6', severity: 'BLOCKING', message: `v2 产物含旧格式节点: ${n}` });
        else if (inPipelineChain) errors.push({ rule: 'V-B6', severity: 'BLOCKING', message: `完整管道校验收到 v1 字符串节点 "${n}"——禁止兼容降级，必须由 R4 产出 v2 节点对象` });
        else if (!/^N\d+$/.test(n)) errors.push({ rule: 'V-B6', severity: 'WARNING', message: `节点格式异常: "${n}"` });
        else if (!v1Warned) { warnings.push({ rule: 'V-B6a', severity: 'WARNING', message: `layer ${layer.id} 含 v1 字符串节点（无元数据）·C3 走兼容降级` }); v1Warned = true; }
      } else if (n && typeof n === 'object') {
        if (!/^N\d+$/.test(n.id || '')) errors.push({ rule: 'V-B6', severity: 'BLOCKING', message: `节点对象缺合法 id` });
        if (!['正方', '反方', '双方'].includes(n.side)) errors.push({ rule: 'V-B6', severity: 'BLOCKING', message: `节点 ${n.id} side 非法` });
        if (!n.label || !String(n.label).trim()) errors.push({ rule: 'V-B6', severity: 'BLOCKING', message: `节点 ${n.id} label 为空` });
        else if (String(n.label).length > 25) warnings.push({ rule: 'V-B6d', severity: 'WARNING', message: `节点 ${n.id} label 超 25 字（${String(n.label).length}）` });
      } else {
        errors.push({ rule: 'V-B6', severity: 'BLOCKING', message: `节点元素类型非法` });
      }
    }
  }

  // V-B6e（260806·R4 label 硬约束）：opponent_nodes 必须为完整元数据对象（含非空 label/event_type/sc_mark）
  // 新合同（S7 靶心列存在）→ BLOCKING；旧合同/独立查看 → WARNING（防旧场次回放全挂）
  // 260810：内联探测替换为共享判定核心 detectNewContract（消除重复实现）
  const newContract = detectNewContract(opts && opts.tfPath);
  for (const layer of layers) {
    if (!layer.opponent_nodes) continue;
    for (const n of layer.opponent_nodes) {
      const sev = newContract ? 'BLOCKING' : 'WARNING';
      if (typeof n === 'string') {
        errors.push({ rule: 'V-B6e', severity: sev, message: `opponent_nodes 含裸 ID "${n}"（禁止只输出节点 ID·需完整元数据对象）` });
      } else if (n && typeof n === 'object') {
        if (!/^N\d+$/.test(n.id || '')) errors.push({ rule: 'V-B6e', severity: sev, message: `opponent_nodes 节点缺合法 id` });
        if (!n.label || !String(n.label).trim()) errors.push({ rule: 'V-B6e', severity: sev, message: `opponent_nodes 节点 ${n.id} label 为空` });
        if (n.event_type === undefined && n.sc_mark === undefined) errors.push({ rule: 'V-B6e', severity: sev, message: `opponent_nodes 节点 ${n.id} 缺 event_type/sc_mark 元数据` });
      } else {
        errors.push({ rule: 'V-B6e', severity: sev, message: 'opponent_nodes 节点元素类型非法' });
      }
    }
  }

  // V-B7: type_override非空→override_reason非空
  if (data.meta.type_override && !data.meta.override_reason)
    errors.push({ rule: 'V-B7', severity: 'WARNING', message: 'type_override非空但reason为空' });

  // V-B8【V3.1新增·C3渲染修复】: 2b型推进层双边性检查
  const s11Type = (data.meta && data.meta.s11_original_type) || '';
  if (s11Type === '2b') {
    for (const layer of (data.layers || [])) {
      if (layerType(layer) === 'SC推进') {
        if (!layer.opponent_nodes || layer.opponent_nodes.length === 0) {
          errors.push({ rule: 'V-B8', severity: 'WARNING',
            message: `2b型推进层${layer.id}缺少opponent_nodes·R6a将使用兜底推断` });
        }
      }
    }
  }

  // V-B9（A8）：structure 节点 id ⊆ transition-final S17 段 N#（单向包含；S17.1 未归入不阻断）
  if (opts.tfPath && fs.existsSync(opts.tfPath)) {
    const tf = fs.readFileSync(opts.tfPath, 'utf8');
    const s17 = (tf.match(/\[S_START=S17\][\s\S]*?\[S_END=S17\]/) || [''])[0];
    const s17Nums = new Set([...s17.matchAll(/^\|\s*(N\d+)\s*\|/gm)].map(m => m[1]));
    const structNums = new Set(layers.flatMap(l => (l.nodes || []).map(n => typeof n === 'string' ? n : (n && n.id) || '')));
    for (const id of structNums) if (id && !s17Nums.has(id))
      errors.push({ rule: 'V-B9', severity: 'BLOCKING', message: `structure 节点 ${id} 不在 S17.1 N# 集合` });
    // V-B9a/b/c【P4·语义交叉】：side/event_type/sc_mark 与 S17.1 表逐节点比对（a=WARNING / b/c=BLOCKING）
    const s17Rows = [];
    const lines = s17.split(/\r?\n/);
    let headerCols = null;
    let idCol = -1;
    for (const line of lines) {
      const m = line.trim().match(/^\|(.+)\|$/);
      if (!m) continue;
      const cells = m[1].split('|').map(c => c.trim());
      if (!headerCols) {
        idCol = cells.findIndex(c => /^N\s*#?\s*$/i.test(c) || c === '节点ID' || /^节点\s*ID$/i.test(c));
        if (idCol < 0) idCol = cells.findIndex(c => /^N\d*$/i.test(c) && c.length <= 3);
        if (idCol >= 0) { headerCols = cells; continue; }
      }
      if (headerCols && /^N\d+$/.test(cells[idCol] || '')) {
        const row = {};
        headerCols.forEach((c, j) => { row[c] = cells[j] || ''; });
        row.__id = cells[idCol];
        s17Rows.push(row);
      }
    }
    const s17RowMap = new Map(s17Rows.map(r => [r.__id, r]));
    if (s17Rows.length === 0) {
      warnings.push({ rule: 'V-B9d', severity: 'WARNING', message: '无法解析 transition-final 的 S17.1 表（表头/行格式异常）·V-B9a/b/c 跳过' });
    } else {
      const colOf = name => headerCols.findIndex(c => c === name || c.includes(name));
      const dirIdx = colOf('方向');
      const etIdx = colOf('事件类型');
      const smIdx = colOf('SC标记');
      if (dirIdx < 0) warnings.push({ rule: 'V-B9e', severity: 'WARNING', message: 'S17.1 表缺"方向"列·V-B9a 跳过' });
      if (etIdx < 0) warnings.push({ rule: 'V-B9f', severity: 'WARNING', message: 'S17.1 表缺"事件类型"列·V-B9b 跳过' });
      if (smIdx < 0) warnings.push({ rule: 'V-B9g', severity: 'WARNING', message: 'S17.1 表缺"SC标记"列·V-B9c 跳过' });
      // 2026-08-05 实测容错：去空白/分隔符后做“严格前缀缩写”容忍——
      // 结构值 = S17.1 值的前缀（如 收束 vs 收束未结晶）→ WARNING 放行；
      // 语义翻转（收束·已结晶 vs 收束·未结晶）不在前缀关系内 → 仍 BLOCKING。
      const norm = s => String(s || '').replace(/\s+/g, '').replace(/·/g, '');
      const isPrefixAbbr = (short, full) => !!full && !!short && full.length > short.length && full.startsWith(short);
      for (const layer of layers) {
        for (const n of layer.nodes || []) {
          if (typeof n !== 'object' || !n) continue;
          const row = s17RowMap.get(n.id);
          if (!row) continue;
          const dir = dirIdx >= 0 ? (row[headerCols[dirIdx]] || '').trim() : '';
          if (dir === '→反' && n.side !== '反方')
            errors.push({ rule: 'V-B9a', severity: 'WARNING', message: `节点 ${n.id} side=${n.side} 与 S17.1 方向(${dir})不一致` });
          if (dir === '→正' && n.side !== '正方')
            errors.push({ rule: 'V-B9a', severity: 'WARNING', message: `节点 ${n.id} side=${n.side} 与 S17.1 方向(${dir})不一致` });
          const et = etIdx >= 0 ? (row[headerCols[etIdx]] || '').trim() : '';
          const etn = normalizeForCompare(n.event_type), etRef = normalizeForCompare(et);
          if (etIdx >= 0 && et && et !== '-' && et !== '—' && etn !== etRef && !isPrefixAbbr(etn, etRef))
            errors.push({ rule: 'V-B9b', severity: 'BLOCKING', message: `节点 ${n.id} event_type=${n.event_type} 与 S17.1(${et})不一致` });
          else if (etIdx >= 0 && et && et !== '-' && et !== '—' && etn !== etRef && isPrefixAbbr(etn, etRef))
            warnings.push({ rule: 'V-B9b-w', severity: 'WARNING', message: `节点 ${n.id} event_type=${n.event_type} 为 S17.1(${et}) 的缩写，按同义放行` });
          const sm = smIdx >= 0 ? (row[headerCols[smIdx]] || '').trim() : '';
          const smn = normalizeForCompare(n.sc_mark), smRef = normalizeForCompare(sm);
          if (smIdx >= 0 && sm && sm !== '-' && sm !== '—' && smn !== smRef && !isPrefixAbbr(smn, smRef))
            errors.push({ rule: 'V-B9c', severity: 'BLOCKING', message: `节点 ${n.id} sc_mark=${n.sc_mark} 与 S17.1(${sm})不一致` });
          else if (smIdx >= 0 && sm && sm !== '-' && sm !== '—' && smn !== smRef && isPrefixAbbr(smn, smRef))
            warnings.push({ rule: 'V-B9c-w', severity: 'WARNING', message: `节点 ${n.id} sc_mark=${n.sc_mark} 为 S17.1(${sm}) 的缩写，按同义放行` });
        }
      }
    }
  }
  return { passed: errors.filter(e => e.severity === 'BLOCKING').length === 0, errors, warnings };
}

// V3.0新增：表格自动修复 —— 在 validate-final 中调用，修复合并后过渡文件中的表格格式问题

function checkEffectiveType(data, structure, presentation) {
  const errors = [];
  const s11 = data && data['S11.类型'];
  if (!s11) errors.push({ rule: 'G0-0', severity: 'BLOCKING', message: 'S11.类型 DATA 缺失' });

  const meta = (structure && structure.meta) || {};
  const orig = meta.s11_original_type;
  if (orig && s11 && orig !== s11)
    errors.push({ rule: 'G0-1', severity: 'BLOCKING', message: `R4类型记录(${orig})与S11 DATA(${s11})不一致` });

  let effectiveType = s11;
  if (meta.type_override) {
    if (!['2b', '2c', '0'].includes(meta.type_override))
      errors.push({ rule: 'G0-2a', severity: 'BLOCKING', message: `type_override非法: ${meta.type_override}` });
    if (!meta.override_reason)
      errors.push({ rule: 'G0-2b', severity: 'BLOCKING', message: 'type_override非空但override_reason为空' });
    effectiveType = meta.type_override;
  }

  // G0-4：presentation 模板族一致
  if (presentation && presentation.模板族 && effectiveType && presentation.模板族 !== effectiveType)
    errors.push({ rule: 'G0-4', severity: 'BLOCKING', message: `presentation模板族(${presentation.模板族})≠有效类型(${effectiveType})` });

  // C17（2026-08-05 1d 双完成方）：S11=1d 时，structure 首个聚合单元 producer 应与被覆盖完成方一致（DATA 权威，结构回读 WARNING）
  const coveredParty = String((data && data['S8.PhaseIII.被覆盖完成方']) || '').trim();
  if (effectiveType === '1d' && coveredParty !== '' && structure && Array.isArray(structure.layers)) {
    const aggLayers = structure.layers.slice(1, -1);
    const firstAgg = aggLayers[0];
    const firstProducer = firstAgg && (firstAgg.producer || ((firstAgg.nodes || [])[0] && firstAgg.nodes[0].side) || '');
    if (firstProducer && firstProducer !== coveredParty) {
      errors.push({ rule: 'C17', severity: 'WARNING', message: `S11=1d被覆盖完成方=${coveredParty}但structure首个聚合单元producer=${firstProducer}·DATA与结构不一致` });
    }
  }

  return { effectiveType, errors };
}

// ==================== R4.5 信息统筹轮（3B） ====================

// ==================== 批甲 B：仲裁键空间单一事实源（260811——定义在 executor/contract.js，卡 6） ====================
// 维度常量表/派生键注册表/可裁决键域前缀/白名单均已移入 contract.js——本文件解构引用

// 留痕问责例外（批甲反模式断言白名单）：缺失/过短=可证明的留痕缺失，允许设 BLOCKING

function checkC7DataContract(content, opts) {
  opts = opts || {};
  const c7Start = content.indexOf('## C7');
  const c7End = content.indexOf('## C8');
  const c7 = c7Start < 0 ? '' : content.substring(c7Start, c7End > 0 ? c7End : content.length);
  const c7Data = extractDataMarkers(c7);
  const c7Keys = ['C7.微消化.正方.实例表行数', 'C7.微消化.反方.实例表行数', 'C7.微消化.总有效数', 'C7.SC总览.正方.有效微消化', 'C7.SC总览.反方.有效微消化'];
  const errors = [];
  // P5：C7 DATA 标记缺失不静默——R5 C7 模板强制输出这 5 个标记，缺失即格式违约
  const missingC7 = c7Keys.filter(k => c7Data[k] === undefined);
  if (missingC7.length > 0) errors.push('C7 DATA 标记缺失: ' + missingC7.join(', '));
  const zhengRows = c7Data['C7.微消化.正方.实例表行数'];
  const fanRows = c7Data['C7.微消化.反方.实例表行数'];
  const totalEff = c7Data['C7.微消化.总有效数'];
  const scZheng = c7Data['C7.SC总览.正方.有效微消化'];
  const scFan = c7Data['C7.SC总览.反方.有效微消化'];
  if (zhengRows !== undefined && fanRows !== undefined && totalEff !== undefined) {
    if (zhengRows + fanRows !== totalEff) {
      errors.push(`C7微消化计数矛盾: 正方行数(${zhengRows})+反方行数(${fanRows})≠总有效数(${totalEff})`);
    }
  }
  if (scZheng !== undefined && zhengRows !== undefined && scZheng !== zhengRows) {
    errors.push(`C7 SC总览正方(${scZheng})≠实例表正方行数(${zhengRows})`);
  }
  if (scFan !== undefined && fanRows !== undefined && scFan !== fanRows) {
    errors.push(`C7 SC总览反方(${scFan})≠实例表反方行数(${fanRows})`);
  }
  // Z'' 锚定校验（opts.s8 含 S8.PhaseII 数据时执行；缺失 → 回落自洽，意见 2-C）
  const s8 = opts.s8 || {};
  const s8Pro = s8['S8.PhaseII.正方.有效数'];
  const s8Con = s8['S8.PhaseII.反方.有效数'];
  const s8ProList = String(s8['S8.PhaseII.正方.节点列表'] || '');
  const s8ConList = String(s8['S8.PhaseII.反方.节点列表'] || '');
  // 意见 4-4 小项 1：节点列表元素 trim + 过滤空串
  const s8Mids = new Set([...s8ProList.split('|'), ...s8ConList.split('|')]
    .map(x => x.trim()).filter(Boolean));
  const s8ListOk = s8Mids.size > 0 || (s8Pro === 0 && s8Con === 0);   // 有效数为 0 时列表可为空（R2 合同：有效数 0 → 空值）
  if (s8Pro !== undefined && s8Con !== undefined) {
    // 规则 a：标记 = S8（计数锚定，始终执行）
    if (zhengRows !== undefined && zhengRows !== s8Pro)
      errors.push(`C7 实例表正方行数标记(${zhengRows})≠S8.PhaseII.正方.有效数(${s8Pro})——须与 S8.PhaseII 权威数据一致`);
    if (fanRows !== undefined && fanRows !== s8Con)
      errors.push(`C7 实例表反方行数标记(${fanRows})≠S8.PhaseII.反方.有效数(${s8Con})——须与 S8.PhaseII 权威数据一致`);
    if (totalEff !== undefined && totalEff !== s8Pro + s8Con)
      errors.push(`C7 总有效数标记(${totalEff})≠S8 有效数合计(${s8Pro + s8Con})——须与 S8.PhaseII 权威数据一致`);

    // 规则 b'（集合级锚定）：仅当节点列表可用（s8ListOk）时执行
    // 降级扩展（意见 4-2）：节点列表缺失/为空且有效数>0 → 跳过 b'（仅规则 a），S8 侧由 V-S8D WARNING 登记
    if (s8ListOk) {
      const inst = parseC7InstanceTable(c7);          // 双形态解析
      if (!inst.found)
        errors.push('C7 微消化实例表未找到（须输出表头含"节点ID|辩手·轮次|接收内容|重定位方式|质量"的表格）');
      else {
        const ids = [];
        for (const row of inst.rows) {
          const id = normalizeMId(row[inst.idCol]);   // 'M1' 原样返回 → isMid=false → 非法 M-ID 报错
          if (!isMid(id)) { errors.push('C7 实例表节点ID列非法 M-ID（须回引 S8.PhaseII 节点列表，形如 M-FA-1，禁止自造序号 M1/M2）：' + row[inst.idCol]); continue; }
          if (sideOfMid(id) === null) { errors.push('C7 实例表节点ID列无法判方: ' + id); continue; }
          ids.push(id);
        }
        const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
        if (dup.length > 0) errors.push('C7 实例表节点ID列重复 M-ID: ' + [...new Set(dup)].join(','));
        const missing = [...s8Mids].filter(m => !ids.includes(m));     // 漏呈现（F2 完整呈现强制）
        const extra = ids.filter(id => !s8Mids.has(id));               // 多呈现/错 ID
        if (missing.length > 0) errors.push('C7 实例表未完整呈现 S8.2 实例（漏）: ' + missing.join(','));
        if (extra.length > 0) errors.push('C7 实例表包含非 S8.2 实例（多/错）: ' + extra.join(','));
      }
    }

    // 规则 b'（SC总览表）：'有效微消化'行 == S8 对应有效数
    const ov = parseSCOverview(c7);
    if (!ov.found) errors.push('C7 SC总览表未找到"有效微消化"行（阶段|正方|反方 表）');
    else {
      if (ov.pro !== s8Pro) errors.push(`C7 SC总览表有效微消化正方(${ov.pro})≠S8.PhaseII.正方.有效数(${s8Pro})`);
      if (ov.con !== s8Con) errors.push(`C7 SC总览表有效微消化反方(${ov.con})≠S8.PhaseII.反方.有效数(${s8Con})`);
    }
  }
  return errors;
}

function checkSideTriplet({ mid, midSide, opSide, turnSide, turnRaw }) {
  const errors = [];
  // 边 1（锚 2 主边）：操作方列 == M-ID 前缀方别
  if (midSide && opSide) {
    if (opSide !== '正方' && opSide !== '反方')
      errors.push({ rule: 'V-S8E-A2', severity: 'BLOCKING', message: `S8.2 表操作方列非法（须"正方/反方"）: ${opSide}（${mid}）——需重跑 R2` });
    else if (opSide !== midSide)
      errors.push({ rule: 'V-S8E-A2', severity: 'BLOCKING', message: `S8.2 表操作方(${opSide})≠M-ID 前缀方别(${midSide})（${mid}）——需重跑 R2` });
  }
  // 边 2（锚 3 交叉边）：发言轮次列方别 == 操作方列（turnSide 来自模式 A/C/B 解析）
  if (turnSide && opSide && (opSide === '正方' || opSide === '反方') && turnSide !== opSide)
    errors.push({ rule: 'V-S8E-A3', severity: 'BLOCKING', message: `S8.2 发言轮次方别(${turnSide})≠操作方列(${opSide})（${mid}，原文: ${turnRaw}）——需重跑 R2` });
  return errors;
}

// 锚 2 + 锚 3（V-S8E 家族；守卫分域 D-2：锚 2 仅依赖 md 可解析，锚 3 依赖 anchor.extracted）

const EXEMPTIBLE_A3_FAILURE_KINDS = new Set([
  'SOURCE_SLOT_MISSING',
  'SOURCE_CANDIDATE_UNREGISTERED',
  'SOURCE_NAME_VARIANT',
  'SOURCE_IDENTITY_UNRESOLVED'
]);

function findExactSourceAnchorExemption(exemptions, rowIndex, mid, turnRaw, opSide) {
  const list = Array.isArray(exemptions) ? exemptions : [];
  const matches = list.filter(e => e && e.scope === 'A3_ROSTER_MATCH' &&
    e.table_row === rowIndex + 1 && e.node_id === mid && e.turn_raw === turnRaw && e.operator_side === opSide);
  return matches.length === 1 ? matches[0] : null;
}

function checkS82Anchors(s82, anchor, opts) {
  opts = opts || {};
  const errors = [];
  const stats = { total: s82.rows.length, unresolvable: 0 };
  for (let rowIndex = 0; rowIndex < s82.rows.length; rowIndex++) {
    const row = s82.rows[rowIndex];
    const mid = normalizeMId(row[s82.idCol]);
    const opSide = (row[s82.opCol] || '').trim();
    const turnRaw = (row[s82.turnCol] || '').trim();
    let midSide = null;
    if (isMid(mid)) midSide = sideOfMid(mid);
    else {
      // 非法 M-ID 行不静默（N-1 修正③）：锚 2 的 ID 合法性与方别核对一并拦截
      errors.push({ rule: 'V-S8E-A2', severity: 'BLOCKING', message: `S8.2 表行节点ID非法（须 M-ZH-n/M-FA-n）: ${row[s82.idCol]}——需重跑 R2` });
      continue;
    }
    let turnSide = null;
    if (anchor && anchor.extracted) {
      const r = matchTurnToRoster(turnRaw, anchor);
      if (r.unresolvable) {
        stats.unresolvable++;
        errors.push({ rule: 'V-S8E-W', severity: 'WARNING', message: `S8.2 发言轮次列不可判（自由文本，跳过名册核对）: ${turnRaw}（${mid}）` });
      } else if (!r.ok) {
        const exemption = EXEMPTIBLE_A3_FAILURE_KINDS.has(r.failureKind) ?
          findExactSourceAnchorExemption(opts.exemptions, rowIndex, mid, turnRaw, opSide) : null;
        if (exemption) {
          errors.push({ rule: 'V-S8E-WX', severity: 'WARNING', message: `S8.2 第${rowIndex + 1}行发言轮次(${turnRaw}) 名册核对失败已由人工精确豁免（${r.failureKind}，${mid}）` });
        } else {
          errors.push({ rule: 'V-S8E-A3', severity: 'BLOCKING', message: `S8.2 发言轮次(${turnRaw}) 名册核对失败: ${r.reason}（${mid}）——需重跑 R2；诊断包见源锚层 §2.6c` });
        }
      } else {
        turnSide = r.side;
        // R9.2（260809）：接线旁证 warn——新规则码 V-S8E-W3（WARNING；不计 unresolvable/W2 密度）
        if (r.warn) errors.push({ rule: 'V-S8E-W3', severity: 'WARNING', message: `S8.2 发言轮次(${turnRaw}) ${r.warn}（${mid}）` });
      }
    }
    errors.push(...checkSideTriplet({ mid, midSide, opSide, turnSide, turnRaw }));
  }
  // V-S8E-W2（D-3）密度聚合：不可判 ≥2 且占比 >0.3 → 锚 3 覆盖不足
  if (stats.total > 0) {
    const ratio = stats.unresolvable / stats.total;
    if (stats.unresolvable >= W2_MIN_UNRESOLVABLE && ratio > W2_RATIO)
      stats.w2 = `S8.2 发言轮次不可判密度过高（${stats.unresolvable}/${stats.total}），锚 3 覆盖不足——建议人工复核或修正辩词`;
  }
  return { errors, stats };
}

function checkS17Table(md, errors) {
  const s17 = sectionOfStep(md, 17);
  if (!s17) return;                                   // S17 段缺失：S17.COMPLETE WARNING + V-B9d 已覆盖，不重复报
  const lines = s17.split(/\r?\n/);
  let header = null, idCol = -1, hdrLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(/^\|(.+)\|$/);
    if (!m) continue;
    const cells = m[1].split('|').map(c => c.trim());
    // 两段式判定（与 V-B9 L2254-2255 逐字同构）：① N#/节点ID/节点 ID 精确匹配；② 兜底 N\d* 短值
    let ic = cells.findIndex(c => /^N\s*#?\s*$/i.test(c) || c === '节点ID' || /^节点\s*ID$/i.test(c));
    if (ic < 0) ic = cells.findIndex(c => /^N\d*$/i.test(c) && c.length <= 3);
    if (ic >= 0) { header = cells; idCol = ic; hdrLine = i; break; }
  }
  if (!header) return;                                 // 无 S17.1 表头（V-B9d 兜底）
  for (let i = hdrLine + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.startsWith('[S_END=')) break;                // 段边界
    if (/^\|[\s:|-]+\|$/.test(l)) continue;            // 分隔行
    const m = l.match(/^\|(.+)\|$/);
    if (!m) continue;
    const cells = m[1].split('|').map(c => c.trim());
    if (!/^N\d+$/.test(cells[idCol] || '')) continue;  // 仅 S17.1 节点行（S17.2 行首 CP-ID 等跳过，与 V-B9 同口径）
    if (cells.length !== header.length)
      errors.push({ rule: 'V-S17H', severity: 'BLOCKING', message: `S17.1 表行 ${cells[idCol]} 列数=${cells.length}≠表头列数=${header.length}——行缺列将致 R4 V-B9 错位死锁（如 SC推进 挤入行为列），需重跑 R2 修正表格` });
  }
}

// 260814 待修项批：契约↔产物形态断言（V-OUT-{S#}，WARNING 级）
// 仅 final 模式调用（md = merged P1+P2+P2.5+P3 全文）；核心列名子串匹配（禁整表头精确匹配——
// 实测产物存在全角/半角括号漂移，精确匹配会漏检）；表块收集复用 collectTableBlock（防 Duplicated Code）。

function checkOutputShape(md, errors, roundName) {
  const tables = [
    { s: 'S3', probe: 'CP-ID', probe2: '交锋点', cols: 7, round: 'P1' },
    { s: 'S8PI', probe: '检测维度', probe2: '正方', cols: 4, round: 'P2' },
    { s: 'S8PII', probe: '节点ID', probe2: '发言轮次', cols: 10, round: 'P2' },
    { s: 'S9', probe: '向度', probe2: '正方表现', cols: 7, round: 'P3' },
    { s: 'S13', probe: '辩手名（角色）', probe2: '技术亮点', cols: 5, round: 'P3' },
  ];
  const roundMap = { R1: 'P1', R2: 'P2', R3: 'P3' };
  const scopedTables = roundName
    ? tables.filter(t => t.round === (roundMap[roundName] || roundName))
    : tables;
  const lines = md.split(/\r?\n/);
  for (const t of scopedTables) {
    let hit = -1;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (l.startsWith('|') && l.includes(t.probe) && l.includes(t.probe2)) { hit = i; break; }
    }
    if (hit < 0) {
      errors.push({ rule: 'V-OUT-' + t.s, severity: 'WARNING',
        message: t.round + ' ' + t.s + ' 表头未找到（期望含 ' + t.probe + ' 与 ' + t.probe2 + ' 的表头——契约列数 ' + t.cols + '）' });
      continue;
    }
    const rows = collectTableBlock(lines, hit, []);
    const hdrCells = rows.length ? rows[0].length : 0;
    if (hdrCells !== t.cols) {
      errors.push({ rule: 'V-OUT-' + t.s, severity: 'WARNING',
        message: t.round + ' ' + t.s + ' 表头列数=' + hdrCells + '（契约 ' + t.cols + '）' });
    }
  }
}

function checkTerminology(skillPath) {
  const content = fs.readFileSync(skillPath || SKILL_PATH, 'utf-8');
  return checkTerminologyContent(content);
}

// ==================== V7.9: 版本标记扫描（指令正文禁版本标记·两级） ====================

function checkTerminologyContent(content) {
  const errors = [];
  // 区域定位：indexOf 首个标记 = 真实标记（均位于 JS 块之前）——无自引用问题
  const sharedStart = content.indexOf('<!-- SECTION:SHARED_START -->');
  const sharedEnd = content.indexOf('<!-- SECTION:SHARED_END -->');
  // A8-P4 修复：标记字符串拆串，避免内嵌源码含完整字面量导致 indexOf 自引用歧义
  const jsStart = content.indexOf('<!-- PIPELINE_CONTROLLER_' + 'START -->');
  // 卡1（260816 E3）：body 截止到首个内嵌块标记（EMBED_ASSET 或 PC_START 更早者）——
  // 原 jsStart 截止，但 EMBED_ASSET 块（含 EXECUTOR_VALIDATOR 哨兵词字面量）位于 PC_START 之前 → 误报
  // 行首锚定完整块形态（^m）：文档头部协议说明含 '<!-- EMBED_ASSET_LIST -->'（非块标记）——indexOf 前缀会误命中
  const embM = content.match(/^<!-- EMBED_ASSET:[A-Z0-9_]+_START -->/m);
  const bodyEnd = embM ? embM.index : (jsStart >= 0 ? jsStart : content.length);
  const body = jsStart >= 0 ? content.slice(0, bodyEnd) : content;          // 指令体（内嵌代码块天然排除）
  const shared = (sharedStart >= 0 && sharedEnd > sharedStart)
    ? content.slice(sharedStart, sharedEnd) : body;                         // 共享资源区

  // 锚点1: #36 三分类——精确子串断言（缺失/调换/改写均失败）
  const m36 = shared.match(/\| 36 \| 反驳路径[^|]*\| (.*?) \|/);
  if (!m36) errors.push('TERM-01: #36 反驳路径条目缺失');
  else {
    const v = m36[1];
    if (!v.includes('①A未必→B')) errors.push('TERM-01a: #36 缺"①A未必→B"');
    if (!v.includes('②B未必→C')) errors.push('TERM-01b: #36 缺"②B未必→C"');
    if (!v.includes('③B不重要')) errors.push('TERM-01c: #36 缺"③B不重要"');
  }

  // 锚点2/3: #11/#12 语义互斥断言
  const m11 = shared.match(/\| 11 \| 消化 \| (.*?) \|/);
  if (!m11) errors.push('TERM-02: #11 消化条目缺失');
  else {
    if (!/B'/.test(m11[1]) && !/更重要的/.test(m11[1])) errors.push('TERM-02a: #11 缺 B\' 机制');
    if (!m11[1].includes('不重要')) errors.push('TERM-02b: #11 缺"不重要"');
    if (m11[1].includes('恰恰')) errors.push('TERM-02c: #11 误含反转语义"恰恰"');
  }
  const m12 = shared.match(/\| 12 \| 反转 \| (.*?) \|/);
  if (!m12) errors.push('TERM-03: #12 反转条目缺失');
  else {
    if (!m12[1].includes('恰恰')) errors.push('TERM-03a: #12 缺"恰恰支持"');
    if (!m12[1].includes('不改变外延')) errors.push('TERM-03b: #12 缺"不改变外延"');
    if (m12[1].includes('不重要')) errors.push('TERM-03c: #12 误含消化语义"不重要"');
  }

  // 锚点4: 关系锚点小节
  if (!/反驳-消化-反转-外延\s*关系锚点/.test(body)) errors.push('TERM-04: 关系锚点小节缺失');

  // 锚点5: 哨兵词——只扫指令体；豁免 #12 中"与...指出内在矛盾...不同"
  const scan = body.replace(/与.{0,10}指出内在矛盾.{0,10}不同/g, '');
  if (scan.includes('直接否定前提')) errors.push('TERM-S01: 残留偏差词"直接否定前提"');
  if (scan.includes('提出替代框架')) errors.push('TERM-S02: 残留偏差词"提出替代框架"');
  if (scan.includes('指出内在矛盾')) errors.push('TERM-S03: 残留偏差词"指出内在矛盾"');

  return { passed: errors.length === 0, errors };
}

function collectTableBlock(lines, start, headerNeed) {
  const rows = [];
  const hdrCells = (lines[start] || '').replace(/^\||\|$/g, '').split('|').length;
  for (let i = start; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.includes('[S_END=')) break;                                    // T1
    if (!l.startsWith('|')) break;                                       // T2
    if (/^\|[\s:|-]+\|$/.test(l)) continue;                              // 分隔行跳过（表内）
    if (i > start) {
      const cells = l.replace(/^\||\|$/g, '').split('|').length;
      const keyHits = headerNeed.filter(k => l.includes(k)).length;
      if (keyHits >= 2 || (keyHits === 0 && cells !== hdrCells)) break;  // T3
    }
    rows.push(l.replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
  }
  return rows;
}

// Z''：微消化实例表解析——优先 TABLE 标记，兜底 Markdown 表（表头含"节点ID/节点"与"辩手·轮次"、
// 后续至少 2 行以 | 开头，防 prose 误匹配——意见 4-5①）

function applyDerivations(data, errors) {
  const completion = data['S8.SC完成度'];
  if (completion === undefined) return;
  const dir = deriveDirection(completion);
  if (dir === null) return;
  if (data['S8.S11类型方向'] === undefined) {
    data['S8.S11类型方向'] = dir;   // 新数据：注入派生值
  } else if (data['S8.S11类型方向'] !== dir) {
    errors.push({ rule: 'S8C-D', severity: 'WARNING', message: `方向=${data['S8.S11类型方向']}（旧字段·将随重跑派生为${dir}）` });
  }
}
// 写盘回写（host-node buildTransitionFinal 调用）：完成度 DATA 行后插方向行（文本中无方向键时）

function detectNewContract(tfPath) {
  let newContract = false;
  try {
    if (tfPath && fs.existsSync(tfPath)) newContract = detectNewContractFromText(fs.readFileSync(tfPath, 'utf-8'));
  } catch (e) { /* 读取失败按旧合同 */ }
  return newContract;
}

// ==================== P类规则 ====================

function detectNewContractFromText(md) {
  if (!md) return false;
  const s7 = String(md).match(/\[S_START=S7\][\s\S]*?\[S_END=S7\]/);
  if (!s7) return false;
  return s7[0].split('\n').some(l => isNewContractHeader(l.trim()));
}
// tfPath 版保留（checkStructure 用）：同一判定核心，消除重复实现

function validateP2_5(content) {
  const data = extractDataMarkers(content);
  const errors = [];

  // V-C1: R2.5 COMPLETE（阻断）
  if (data['R2.5.COMPLETE'] !== '是') {
    errors.push({ rule: 'V-C1', severity: 'BLOCKING', message: 'R2.5.COMPLETE=是 缺失' });
  }

  // V-C2: 8条对方对抗象限 DATA（阻断）
  const quadrants = ['Q1','Q2','Q3','Q4'];
  const sides = ['正方','反方'];
  for (const side of sides) {
    for (const q of quadrants) {
      const key = `R2.5.${side}.${q}.对方对抗象限`;
      if (!(key in data)) {
        errors.push({ rule: 'V-C2', severity: 'BLOCKING', message: `${key} 缺失` });
      }
    }
  }

  // V-C3: 判准校准信号（阻断——S15.5-0 依赖）
  if (!('C8.判准校准.正方.意义感加权' in data)) {
    errors.push({ rule: 'V-C3', severity: 'BLOCKING', message: 'C8.判准校准.正方.意义感加权 缺失' });
  }
  if (!('C8.判准校准.反方.意义感加权' in data)) {
    errors.push({ rule: 'V-C3', severity: 'BLOCKING', message: 'C8.判准校准.反方.意义感加权 缺失' });
  }

  // V-C4: 聚合指标（WARNING·不阻断）
  const aggKeys = ['C8.正方.对角对子非空数','C8.反方.对角对子非空数',
                   'C8.正方.被对方对抗象限数','C8.反方.被对方对抗象限数'];
  for (const key of aggKeys) {
    if (!(key in data)) {
      errors.push({ rule: 'V-C4', severity: 'WARNING', message: `${key} 缺失` });
    }
  }

  // V-C5: 终端锚点（WARNING）
  if (!content.match(/\[R2\.5 完成\]/)) {
    errors.push({ rule: 'V-C5', severity: 'WARNING', message: '[R2.5 完成] 终端锚点缺失' });
  }

  // V-C6: C8预制散文块（WARNING）
  if (!content.includes('<!--C8_PROSE_START-->') || !content.includes('<!--C8_PROSE_END-->')) {
    errors.push({ rule: 'V-C6', severity: 'WARNING', message: 'C8_PROSE 块缺失或未闭合' });
  }

  // V-C7: 判准校准信号与推导链一致性（WARNING）
  for (const side of sides) {
    const weight = data[`C8.判准校准.${side}.意义感加权`];
    const derive = data[`C8.判准校准.${side}.推导`];
    if (weight === '+0.5' && derive && derive.includes('对角对子非空0/2')) {
      errors.push({ rule: 'V-C7', severity: 'WARNING', message: `${side}校准信号与推导链不一致` });
    }
  }

  // V-C8P（260806·叙事人格专项）：C8.叙事人格 成对 + 枚举 + 解读非空（批甲：长度门禁移除）
  // 260813 P1批 B1（S1 三源收敛）：姿态标签枚举改读 REGISTRY.enums（单一事实源，删除内联副本）
  const personaKeys = ['C8.叙事人格.正方', 'C8.叙事人格.反方'];
  const personaMissing = personaKeys.filter(k => !(k in data));
  if (personaMissing.length > 0) {
    errors.push({ rule: 'V-C8P', severity: 'BLOCKING', message: 'C8 叙事人格缺失（须成对）: ' + personaMissing.join(',') });
  }
  let PERSONAS = null;
  try {
    PERSONAS = getEnums()['C8.叙事人格.姿态标签'];
  } catch (e) {
    PERSONAS = null;
  }
  if (!Array.isArray(PERSONAS) || PERSONAS.length === 0) {
    // 260813 P1批：注册表缺键/解析失败 → BLOCKING + 早退（跳过姿态校验循环——personas=[] 会使
    // includes 恒 false 报「姿态标签非法」破坏消息区分 + 双 BLOCKING 噪音 + 重试死循环风险；
    // 配置故障显式失败优先，不回退内联值——避免第四份硬编码副本）
    errors.push({ rule: 'V-C8P', severity: 'BLOCKING', message: '注册表缺 C8.叙事人格.姿态标签 键或解析失败' });
  } else {
    const personaRaw = [data['C8.叙事人格.正方'], data['C8.叙事人格.反方']];
    for (let i = 0; i < personaKeys.length; i++) {
      const k = personaKeys[i];
      if (personaRaw[i] === undefined) continue;
      const parts = String(personaRaw[i]).split('|');
      if (parts.length < 2) { errors.push({ rule: 'V-C8P', severity: 'BLOCKING', message: k + ' 格式错误（需 姿态|解读[|回引]）' }); continue; }
      if (!PERSONAS.includes(parts[0].trim())) errors.push({ rule: 'V-C8P', severity: 'BLOCKING', message: k + ' 姿态标签非法: ' + parts[0] });
      // 批甲 R5（P2-2 落码）：长度门禁移除（30→无限制）；结构契约非空（空解读=可证明语义缺失）
      if (!(parts[1] || '').trim()) errors.push({ rule: 'V-C8P', severity: 'BLOCKING', message: k + ' 解读为空（须 姿态|解读 两字段，回引不强制）' });
    }
  }

  // V-C8W（260806·叙事人格专项）：C8.人格胜负 结构（无回引字段→阻断；ID 存在性在最终校验→WARNING）
  if (!('C8.人格胜负' in data)) {
    errors.push({ rule: 'V-C8W', severity: 'BLOCKING', message: 'C8.人格胜负 缺失' });
  } else {
    const wparts = String(data['C8.人格胜负']).split('|');
    if (!['正方', '反方', '持平'].includes((wparts[0] || '').trim())) errors.push({ rule: 'V-C8W', severity: 'BLOCKING', message: 'C8.人格胜负 首段非法（需 正方|反方|持平）' });
    // 批甲 R5（P2-2 落码）：长度门禁移除（40→无限制）；结构契约非空
    if (!(wparts[1] || '').trim()) errors.push({ rule: 'V-C8W', severity: 'BLOCKING', message: 'C8.人格胜负 依据为空（须 胜负|依据|回引）' });
    const wref = normalizeMId((wparts[wparts.length - 1] || '').trim());
    if (!isRef(wref)) errors.push({ rule: 'V-C8W', severity: 'BLOCKING', message: 'C8.人格胜负 回引字段缺失或格式非法（需恰好 1 个 M-ID/CP-ID）' });
  }

  return errors;
}

// ==================== B3: 结构归约验证（R4 结构归约轮·V3.0变更） ====================

// A8-P1b：checkStructure 结构化返回 {passed, errors, warnings}；opts.tfPath 提供时执行 V-B9（单向包含）
// A8-ERR-1 R4 修复：structure.json 容错解析（定义在 executor/contract.js，卡 6——剥离标记行 → ```json 围栏 → 首{到末} → JSON.parse）

// ==================== 批甲 A：跨格式比较归一（260811） ====================
// 不变式：跨格式比较点唯一清单（structure JSON ↔ markdown 表 的比较必须登记于此并走 normalizeForCompare）；
// 其余 norm（selfCheck trim / S2 矩阵 L768-771）为同格式/哈希比对，不涉及。

function parseSMarkers(md) {
  // 统一由 parseSMarkerDetail 派生，避免两套正则重复
  const starts = [], ends = [];
  for (const x of parseSMarkerDetail(md)) {
    (x.isStart ? starts : ends).push(x.n);
  }
  starts.sort((a, b) => a - b);
  ends.sort((a, b) => a - b);
  return { starts, ends };
}

// A8-ERR-1：S 标记明细（主步骤 + 子步骤 + 类型），供 F2 分形态校验

function parseSMarkerDetail(md) {
  const re = /\[S_(START|END)=S(\d+)(?:\.(\d+))?\]/g;
  const out = [];
  let m;
  while ((m = re.exec(md)) !== null) {
    out.push({ n: parseInt(m[2], 10), sub: m[3] ? parseInt(m[3], 10) : null, isStart: m[1] === 'START' });
  }
  return out;
}

// A8-ERR-1：主步骤段边界（兼容 [S_START=S8] + [S_END=S8.x]… 子步骤闭合形态）

function sectionOfStep(md, s) {
  const startRe = new RegExp('\\[S_START=S' + s + '(?:\\.\\d+)?\\]');
  const endRe = new RegExp('\\[S_END=S' + s + '(?:\\.\\d+)?\\]', 'g');
  const sm = md.match(startRe);
  if (!sm) return '';
  const ends = [...md.matchAll(endRe)];
  const endAt = ends.length ? ends[ends.length - 1].index + ends[ends.length - 1][0].length : md.length;
  return md.slice(sm.index, endAt);
}

// 缺陷 H（260812）：S17.1 表列数一致性校验——数据行缺列 → R4 V-B9 错位死锁（确定性死锁根治）
// 定位逻辑与 checkStructure V-B9 同构（两段式 idCol 判定逐字同 V-B9 L2254-2255，同一张表识别口径，防两套判定漂移）；
// 校验语义 = 表内相对一致性（数据行格数 == 表头格数），非绝对值（全表统一 N 列不拦——V-B9 正常解析、无死锁风险）

function parseS82Table(md) {
  // ① 子围栏优先（兼容既有 12 处测试构造；真实产物无则走 ②）
  let seg = md.match(/\[S_START=S8\.2\][\s\S]*?\[S_END=S8\.2\]/);
  // ② S8 段内「### S8.2」小节定位（真实形态：attempt1/attempt4 标题含「·」，如「### S8.2 Phase II·微消化实例化追迹」）
  if (!seg) {
    const s8m = md.match(/\[S_START=S8\][\s\S]*?\[S_END=S8\]/);
    const s8txt = s8m ? s8m[0] : md;
    const sLines = s8txt.split('\n');
    let hStart = -1;
    for (let i = 0; i < sLines.length; i++) {
      if (/^#{1,4}\s*S8\.2/.test(sLines[i].trim())) { hStart = i; break; }
    }
    if (hStart >= 0) {
      let hEnd = sLines.length;
      for (let i = hStart + 1; i < sLines.length; i++) {
        const l = sLines[i].trim();
        if (/^#{1,4}\s*S8\.3/.test(l) || l.startsWith('[S_END=S8.2]') || l.startsWith('[S_END=S8]')) { hEnd = i; break; }
      }
      seg = [sLines.slice(hStart + 1, hEnd).join('\n')];
    }
  }
  const src = seg ? seg[0] : md;
  const m = src.match(/<!--TABLE:[^>]*名称=微消化实例表[^>]*-->\s*([\s\S]*?)<!--\/TABLE-->/);
  let rows;
  if (m) rows = extractTableRows(m[1]);
  else {
    const lines = src.split('\n');
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (l.startsWith('|') && l.endsWith('|') && l.includes('操作方') && l.includes('发言轮次')) {
        if (lines.slice(i + 1).filter(x => x.trim().startsWith('|')).length >= 2) { start = i; break; }
      }
    }
    if (start < 0) return { found: false, rows: [] };
    rows = collectTableBlock(lines, start, ['操作方', '发言轮次']);   // 260809 Q1：有界（原截到文件尾吞 S8.3/CP 表）
  }
  if (!rows || rows.length < 2) return { found: false, rows: [] };
  const hdr = rows[0];
  const idCol = hdr.indexOf('节点ID') >= 0 ? hdr.indexOf('节点ID') : hdr.indexOf('节点');
  const turnCol = hdr.indexOf('发言轮次');
  const opCol = hdr.indexOf('操作方');
  if (idCol < 0 || turnCol < 0 || opCol < 0) return { found: false, rows: [] };
  return { found: true, rows: rows.slice(1), idCol, turnCol, opCol };
}

// 发言轮次形态词表（260809 Q2 终版：单一事实源；与 SLOT_RE/ROLE_TAG_RE 字符类逐字核对一致）

function extractAdjudicationReason(p3Text) {
  const s15 = (p3Text.match(/\[S_START=S15\][\s\S]*?\[S_END=S15\]/) || [''])[0];
  if (!s15) return '';
  const seg = s15.match(/S15\.2[\s\S]*?(?=S15\.3|$)/);
  if (!seg) return '';
  return seg[0].replace(/S15\.2\s*判准应用[：:\s]*/, '').replace(/\s+/g, '').trim();
}

function normalizeEnumValue(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let a = s.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim();
  a = a.split('·')[0].split('•')[0].trim();
  return a.length > 0 ? a : null;
}

// T2：写盘前确定性回写——把“归一化后精确命中枚举”的脏 DATA 行替换为规范值，并留日志。
// 必须与 checkV1_V6 使用同一 normalizeEnumValue，避免“校验放行但报告显示脏值”。

function deriveCompletionExpected(data) {
  const ph3 = data['S8.PhaseIII.状态'];
  const d4 = data['S8.PhaseIII.④容纳自洽'];
  const d5 = data['S8.PhaseIII.⑤价值深度'];
  const d6 = data['S8.PhaseIII.⑥双方SC关系'];
  const eff = (data['S8.PhaseII.正方.有效数'] || 0) + (data['S8.PhaseII.反方.有效数'] || 0);
  const ph1ok = data['S8.PhaseI.正方'] === '完成' || data['S8.PhaseI.反方'] === '完成';
  const s3 = data['S3.交锋点总数'];
  if (d6 === '独立平行') return '半完成';                              // ①⑥-b 定序首位
  if (ph3 === '已结晶') {
    if (d4 === '不通过' || d5 === '不通过') return null;               // ③H5 字段层拦截域：不产期望
    return '完成';                                                     // ②
  }
  if (d4 === '不通过' || d5 === '不通过') return eff >= 1 ? '未完成' : null; // ④（eff=0 时 L1 已拦）
  if (eff >= 1) return '半完成';                                        // ⑤
  if (ph1ok) return '启动未推进';                                      // ⑥
  return s3 === 0 ? '不存在' : '未启动';                                // ⑦⑧
}

// 完成度一致性总入口（替代原 P3 期望比对；L1 BLOCKING / L2 WARNING / 判据分级）

function getCompletionHardConflicts(data) {
  const c = data['S8.SC完成度'];
  const ph3 = data['S8.PhaseIII.状态'];
  const d4 = data['S8.PhaseIII.④容纳自洽'];
  const d5 = data['S8.PhaseIII.⑤价值深度'];
  const d6 = data['S8.PhaseIII.⑥双方SC关系'];
  const eff = (data['S8.PhaseII.正方.有效数'] || 0) + (data['S8.PhaseII.反方.有效数'] || 0);
  const ph1ok = data['S8.PhaseI.正方'] === '完成' || data['S8.PhaseI.反方'] === '完成';
  const s3 = data['S3.交锋点总数'];
  const independent = d6 === '独立平行';
  const out = [];
  const A = (cond, reason) => { if (cond) out.push({ value: c, reason }); };
  if (c === '完成') {
    A(ph3 !== '已结晶', '完成但PhaseIII未结晶');
    A(d4 === '不通过', '完成但④不通过');
    A(d5 === '不通过', '完成但⑤不通过');
    A(eff === 0, '完成但PhaseII有效=0');
    A(independent, '完成但⑥=独立平行（⑥-b强制半完成）');
  } else if (c === '未完成') {
    A(eff === 0, '未完成但PhaseII有效=0（无推进则应为启动未推进）');
    A(ph3 === '已结晶', '未完成但PhaseIII已结晶（V-S8B兜底：已结晶⇒完成度=完成，双层闭合）');
    A(independent, '未完成但⑥=独立平行（⑥-b强制半完成）');
  } else if (c === '半完成') {
    A(eff === 0, '半完成但PhaseII有效=0（无推进则应为启动未推进）');
    A(ph3 === '已结晶' && !independent, '半完成但PhaseIII已结晶（非⑥-b例外）');
  } else if (c === '启动未推进') {
    A(eff > 0, '启动未推进但PhaseII有效>0');
    A(ph3 === '已结晶', '启动未推进但PhaseIII已结晶');
  } else if (c === '未启动') {
    A(ph1ok, '未启动但任一方PhaseI完成');
    A(s3 === 0, '未启动但S3=0（应判不存在）');
  } else if (c === '不存在') {
    A(s3 > 0, '不存在但S3>0');
  }
  // 全局格（R6·260810）：⑥=独立平行 仅在双方各有结晶候选时触发（L2612）→ PhaseII=0 与⑥ 互斥
  if (independent && eff === 0)
    out.push({ value: c, reason: '⑥=独立平行但PhaseII有效=0（⑥仅双方有结晶候选时触发）' });
  return out;
}

// L2 期望（9 分支·仅期望参考 WARNING；P1 修订：不可用旧 5 值逻辑，否则合法"未完成"被误标偏离）

function conditionKeyVal(cond) {
  const eq = cond.indexOf('=');
  let key = eq >= 0 ? cond.slice(0, eq) : cond;
  const val = eq >= 0 ? cond.slice(eq + 1) : '';
  if (key === 'def') key = 'S4.定义争议触发';
  return { key, val };
}

// A1 辅助：某 INSERT 在章节内是否“出现且非空”（M4：去空白/分隔行后仍有内容）

function insertSlotHasContent(section, name) {
  const marker = '<!--INSERT_' + name + '-->';
  let from = 0;
  while (true) {
    const idx = section.indexOf(marker, from);
    if (idx < 0) return false;
    let rest = section.slice(idx + marker.length);
    const next = rest.search(/<!--INSERT_C\d+_[A-Z0-9_]+-->/);
    if (next >= 0) rest = rest.slice(0, next);
    const content = rest.split('\n')
      .map(l => l.trim())
      .filter(l => l && !/^:?-{3,}:?$/.test(l) && !/^\|:?-{3,}/.test(l))
      .join('');
    if (content.length > 0) return true;
    from = idx + marker.length;
  }
}

// A1-A3：R5/R2.5 输出合同机械强制
// - 章节内无条件 INSERT（producer=R5 或 C8 的 R2.5）必须出现且非空（A1）
// - 叙事内全部 INSERT 名必须命中注册表（A2）
// - 每章必须含非空 <!--XP:...-->（A3）
// - 条件 INSERT（condition=def=是）仅当 S4.定义争议触发=是 时必出；条件不满足仍输出 → WARNING

function countC11Dash(md, side) {
  const c11Start = md.indexOf('## C11');
  const c12Start = md.indexOf('## C12');
  const c11 = c11Start < 0 ? '' : md.substring(c11Start, c12Start > 0 ? c12Start : md.length);
  const hIdx = c11.indexOf('### ' + side);
  if (hIdx < 0) return 0;
  let seg = c11.slice(hIdx + ('### ' + side).length);
  const nextH = seg.search(/\n### |\n## /);
  if (nextH >= 0) seg = seg.slice(0, nextH);
  const lines = seg.split('\n').map(l => l.trim()).filter(l => l.startsWith('|'));
  if (lines.length < 2) return 0;
  const hdr = lines[0].split('|').map(s => s.trim());
  const col = hdr.indexOf('技术失误');
  if (col < 0) return 0;
  let dash = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split('|').map(s => s.trim());
    if (cells.length > col && cells[col] === '—') dash++;
  }
  return dash;
}

// 机械标题：取段内首个完整句（≤40 字）

function parseC7InstanceTable(c7) {
  const m = c7.match(/<!--TABLE:[^>]*名称=微消化实例表[^>]*-->\s*([\s\S]*?)<!--\/TABLE-->/);
  let rows;
  if (m) rows = extractTableRows(m[1]);
  else {
    const lines = c7.split('\n');
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (l.startsWith('|') && l.endsWith('|') && l.includes('辩手·轮次')) {
        const nxt = lines.slice(i + 1).filter(x => x.trim().startsWith('|'));
        if (nxt.length >= 2) { start = i; break; }
      }
    }
    if (start < 0) return { found: false, rows: [] };
    rows = collectTableBlock(lines, start, ['节点ID', '辩手·轮次']);   // 260809 Q1：有界（原截到文件尾吞后续表）
  }
  if (!rows || rows.length < 2) return { found: false, rows: [] };
  const hdr = rows[0];
  const idCol = hdr.indexOf('节点ID') >= 0 ? hdr.indexOf('节点ID') : hdr.indexOf('节点');
  const sideCol = hdr.indexOf('辩手·轮次');
  if (idCol < 0 || sideCol < 0) return { found: false, rows: [] };
  return { found: true, rows: rows.slice(1), idCol };
}

// Z''：SC总览表解析——"N个"单位剥离（/^\s*(\d+)\s*个?\s*$/），取首个含"有效微消化"的行（模板单行无拆分风险）

function parseSCOverview(c7) {
  const m = c7.match(/<!--TABLE:[^>]*名称=SC总览表[^>]*-->\s*([\s\S]*?)<!--\/TABLE-->/);
  let rows;
  if (m) rows = extractTableRows(m[1]);
  else {
    const lines = c7.split('\n');
    let start = -1;
    for (let i = 0; i < lines.length; i++)
      if (lines[i].trim().startsWith('|') && lines[i].includes('阶段')) { start = i; break; }   // 260809 Q1：定位收敛到 | 行
    if (start < 0) return { found: false };
    rows = collectTableBlock(lines, start, ['阶段', '正方', '反方']);   // 260809 Q1：有界（原截到文件尾吞后续表）
  }
  if (!rows || rows.length < 2) return { found: false };
  const hdr = rows[0];
  const proCol = hdr.indexOf('正方'), conCol = hdr.indexOf('反方');
  if (proCol < 0 || conCol < 0) return { found: false };
  for (const r of rows.slice(1)) {
    if (r[0] && r[0].includes('有效微消化')) {
      const num = v => /^\s*(\d+)\s*个?\s*$/.test(String(v)) ? parseInt(String(v), 10) : null;
      const p = num(r[proCol]), c = num(r[conCol]);
      if (p === null || c === null) return { found: false };
      return { found: true, pro: p, con: c };
    }
  }
  return { found: false };
}

function matchTurnToRoster(turn, anchor) {
  const t = String(turn || '').trim();
  if (!t) return { unresolvable: true };
  // ① → 切分：锚定首段（N-1 修正①：取首个方别=操作方；目标段仅登记，不参与定位）
  const primary = t.split('→')[0].trim();
  // ② 段内 ·/、 切分 token
  const segs = primary.split(/[·、]/).map(x => x.trim()).filter(Boolean);
  let side = null, role = null, nameHit = null, nameCand = null;
  for (const seg of segs) {
    let s = seg;
    // 方别前缀（SIDE_VOCAB 长词优先：正方/反方 → 正/反）
    const ms = s.match(/^(正方|反方|正|反)/);
    if (ms && !side) { side = ms[1].startsWith('正') ? '正方' : '反方'; s = s.slice(ms[1].length); }
    // 角色前缀剥取（R1：数字+辩/辯 或 自由人/主辩/结辩/助辩，含尾部数字容差）
    if (!role) {
      const rm = s.match(/^([一二三四五六1-6１-６])(?:辩|辯)?|^(自由人|主辩|主辯|结辩|結辯|助辩|助辯)[一-六1-6１-６]?/);
      if (rm) { role = normalizeRoleTag(rm[1] || rm[2]); s = s.slice(rm[0].length); }
    }
    // 名字：名册 name/aliases 精确包含命中（6.1/aliases；整段匹配——含 盘问·反二樊登 张冠李戴场景）
    const hit = anchor.roster.find(x => x.name && (seg.includes(x.name) || (x.aliases || []).some(a => a && seg.includes(a))));
    if (hit) { nameHit = hit; continue; }
    // 多人形态（/ 分隔）逐名尝试（"自由辩论·反方郭宇宽/樊登等"）
    if (s.includes('/')) {
      const multi = s.split('/').map(x => x.trim()).find(n =>
        anchor.roster.some(x => x.name && (n.includes(x.name) || (x.aliases || []).some(a => a && n.includes(a)))));
      if (multi) nameHit = anchor.roster.find(x => x.name && (multi.includes(x.name) || (x.aliases || []).some(a => a && multi.includes(a))));
    }
    // 简体候选登记（R9.1 覆盖语义：仅"消费过方别/角色前缀的余串"可作候选且覆盖前置；环节词排除）
    if (!nameHit && s !== seg && !isPhaseToken(s) && /^[\u4e00-\u9fff]{2,8}$/.test(s)) nameCand = s;
  }
  // ── 判定链（R12 重排：槽位核对优先；DP1=A 旁证 W3）──
  // 1) side+role → 槽位查名册
  if (side && role) {
    const slot = anchor.roster.find(r0 => r0.side === side && r0.role === role);
    if (!slot) {
      // 槽位缺失：nameHit 命中 → 宽口径 ok（L137/L146 语义保持）；无 nameHit → BLOCKING（L140 保持）
      if (nameHit) return { ok: true, side: nameHit.side, name: nameHit.name, mode: 'B' };
      const names = anchor.roster.filter(r0 => r0.side === side).map(r0 => r0.name || r0.role).join('、');
      return { ok: false, failureKind: 'SOURCE_SLOT_MISSING', reason: `名册无 ${side}${role} 槽位（${side}现有：${names || '无'}）`, mode: 'A' };
    }
    // 槽位存在：名字判定（A+异人必拦）
    if (nameHit) {
      const same = nameHit.name === slot.name || (slot.aliases || []).includes(nameHit.name) || (nameHit.aliases || []).includes(slot.name);
      if (same) return { ok: true, side, role, mode: 'A' };
      return { ok: false, failureKind: 'IDENTITY_CONFLICT', reason: `张冠李戴：${side}${role}=${slot.name}，单元格写 ${nameHit.name}`, mode: 'A' };
    }
    if (nameCand && slot.name && nameCand !== slot.name) {
      const other = anchor.roster.find(x => x.name === nameCand && x !== slot);
      if (other) return { ok: false, failureKind: 'IDENTITY_CONFLICT', reason: `张冠李戴：${side}${role}=${slot.name}，单元格写 ${nameCand}`, mode: 'A' };
      // DP1=A：写法违约（简繁等）→ ok + warn（V-S8E-W3 接线见 checkS82Anchors）
      return { ok: true, side, role, mode: 'A', warn: `名字旁证不符：名册标准写法「${slot.name}」，单元格含「${nameCand}」（原样保留 6.1）` };
    }
    return { ok: true, side, role, mode: 'A' };
  }
  // 2) 纯名字命中（无 side+role；模式 B，6.1 精确/aliases）
  if (nameHit) return { ok: true, side: nameHit.side, name: nameHit.name, mode: 'B' };
  // 3) side-only（"盘问·反→正"取首方别；N-1 修正①回归点）
  if (side) return { ok: true, side, role: null, mode: 'A' };
  // 4) 候选名单闭合（v1.4c）
  if (anchor.candidates && anchor.candidates.some(c => t.includes(c.name)))
    return { ok: false, failureKind: 'SOURCE_CANDIDATE_UNREGISTERED', reason: '该名字在候选名单（抽取器疑似漏抽），请修 source-anchor.json 后重跑', mode: 'B' };
  // 5) 近名启发式（R1 终版：简体违约——纯中文名、名册同长度±2、共享至少一个汉字、≠ 名册名 → 附标准写法）
  const near = anchor.roster.find(x => x.name && /^[\u4e00-\u9fff]{2,8}$/.test(t) &&
    x.name.length >= 2 && Math.abs(x.name.length - t.length) <= 2 &&
    [...x.name].some(ch => t.includes(ch)) && x.name !== t);
  if (near) return { ok: false,
    failureKind: 'SOURCE_NAME_VARIANT',
    reason: `辩手名与名册不符（原样保留 6.1）：名册标准写法「${near.name}」，当前「${t}」——请按原文逐字书写；若与名册无关请核对是否编造（R6）`,
    mode: 'B' };
  // 6) 兜底保守化（N-1 修正②保持）：标点自由文本 → W；强角色特征 → 幻觉 BLOCKING
  if (/[，,。．；;、（）()“”"']/.test(t)) return { unresolvable: true };
  if (/[一-六1-6]辩|自由人|主辩|结辩|助辩|·/.test(t))
    return { ok: false, failureKind: 'SOURCE_IDENTITY_UNRESOLVED', reason: '名册/候选均无此人，疑似幻觉或方别错', mode: 'B' };
  return { unresolvable: true };
}

// 方别三元组核对（D-2 单一实现：两条边，每条只报一次；传递闭合覆盖第三边）

function getEnums(skillPath) {
  if (ENUMS_CACHE) return ENUMS_CACHE;
  const registry = parseInsertRegistry(skillPath || SKILL_PATH);
  ENUMS_CACHE = registry.enums || {};
  return ENUMS_CACHE;
}

function normalizeForCompare(s) {
  let t = String(s || '');
  t = t.replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)); // 全角→半角
  t = t.replace(/\s+/g, '');                       // 去空白（含全角空格）
  t = t.replace(/[\u2019\u02bc\uff07]/g, "'");     // 弯撇/修饰符撇/全角撇 → ASCII
  t = t.replace(/[·•⋅∙]/g, '·').replace(/·/g, ''); // 点号变体归一后去除（保持原 norm 去 · 语义）
  return t;
}

// 轮次消费域（批甲 D/G；事实源 = scripts/generate-input-contract.js ROUND_CONTRACT_DEFS producerRe；FILE.* 为公共头豁免）

function deriveDirection(completion) { return DIRECTION_MAP[completion] || null; }

function extractTableRows(body) {
  return body.split('\n').map(l => l.trim())
    .filter(l => l.startsWith('|'))
    .filter(l => !/^\|[\s:|-]+\|$/.test(l))          // 分隔行
    .map(l => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
}

// 有界表块提取（260809 Q1/R8/R10 终版）：从表头行起收集连续表行；三态边界任一先到即停：
//   T1 段终点：行含 [S_END= → break（真实产物 attempt3/4 的 [S_END=S8.2]）
//   T2 非表行：非 | 开头（标题/空行/正文）→ break（真实 4 份 attempt 表后均有空行）
//   T3 新表头：非分隔行且 (keyHits>=2 || (keyHits===0 && cells!==hdrCells)) → break
//     keyHits>=2 = 含 ≥2 个当前表头关键列名 → 视为新表头（L76 型紧贴表头，含 操作方/发言轮次/节点ID）
//     keyHits===0 && 列数≠表头 → 新表（S8.3 三要素表 4 列 vs S8.2 9 列）

function normalizeRoleTag(tag) {
  const t = String(tag || '').trim().replace(/[\s\u3000]/g, '');
  if (!t) return null;
  let s = t;
  // v1.10（260809 Q2）：尾部数字/序号容差——"自由人1/自由人一/主辩2" → "自由人/主辩"（原逻辑分支不动）
  s = s.replace(/^(自由人|主辩|主辯|结辩|結辯|助辩|助辯)[一-六1-6１-６]?$/, '$1');
  s = s.replace(/１/g, '1').replace(/２/g, '2').replace(/３/g, '3').replace(/４/g, '4').replace(/５/g, '5').replace(/６/g, '6');
  const numMap = { 一: '一', 二: '二', 三: '三', 四: '四', 五: '五', 六: '六', 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六' };
  const m = s.match(/^([一二三四五六1-6])(?:辩|辯)?$/);
  if (m) return numMap[m[1]] + '辩';
  if (s === '自由人') return '自由人';
  if (s === '主辩' || s === '主辯') return '主辩';
  if (s === '结辩' || s === '結辯') return '结辩';
  if (s === '助辩' || s === '助辯') return '助辩';
  return null;
}

// 角色标签 → {side, role}（规则 6/8 共用；"正方一辩"/"反方二辯"/"正方自由人"/"正1"）

const isPhaseToken = s => PHASE_VOCAB.includes(s) || /(陈词|小结)$/.test(s);

// 发言轮次列 → 名册（260809 Q2 终版：顺序 token 消费——→ 切分 → 方别前缀 → 角色前缀 → 名字/环节余串；
// R12 重排：槽位核对优先于 nameHit——张冠李戴分支可达；DP1=A：写法违约 ok+W3、张冠李戴/槽位缺失 BLOCKING）

const TYPE1 = ['1a', '1b', '1c', '1d'];

const TYPE2 = ['2a', '2b', '2c'];

// T2：V1 无损归一化——只做可逆/无歧义清洗：去空白、剥（中文/英文括号）及其内容、截断 “·/•” 后解释尾巴。
// 归一化后必须精确命中枚举；命中不了 = 语义脏（如“无”），仍由 V1 BLOCKING。

const CROSS_FORMAT_COMPARE_POINTS = ['V-B9b', 'V-B9c'];
// 变体集合单一事实源：全角→半角 + 去空白 + 撇号变体→ASCII + 点号变体归一去除

const R2_5_DOMAIN_RE = /^(R2\.5|C8|FILE)\./;

const R3_DOMAIN_RE = /^(S9|S10|S11|S13|S14|S15|S16|FILE)\./;

const LENGTH_GATE_RULES = ['S8C-R', 'V2-55', 'V-B5b', 'ADJ-4b', 'ADJ-8'];

// 白名单单一事实源/仲裁校验（定义在 executor/contract.js，卡 6——adjudicableKeys/adjudicationWhitelist/validateAdjudication/mergeAdjudicationData）


// R4.5：structure 副本合并（裁决 S11 时同步 meta；type_override 覆盖）

const W2_MIN_UNRESOLVABLE = 2;

const W2_RATIO = 0.3;

// S8.2 实例表解析（260809 Q1 终版：① 子围栏优先 → ② S8 段内「### S8.2」小节定位 → TABLE 标记 → 有界 Markdown 兜底）

const R5_WARN_MIN_LEN = 20;   // 弱信号长度阈值（批 0 校准·宁弱勿强）

const S15_GATE_RULES = ['S15', 'V2', 'V2-55', 'V6', 'C1', 'C4', 'C7', 'H5', 'P2', 'P3', 'S8C-L1', 'V-S8A', 'V-S8B'];
// 维护责任：新增 S15 前置机械规则须同步本集合

const DIRECTION_MAP = { 完成: '1型', 未完成: '2b型', 半完成: '2b型', 启动未推进: '2a型', 未启动: '2c型', 不存在: '0型' };

const D3_FALLBACK_BLOCKS = { po: { cls: 'po', tag: 'div' }, wn: { cls: 'wn', tag: 'p' } };

const PHASE_VOCAB = ['立论', '盘问', '盘问小结', '自由辩论', '自由辩', '对辩', '总结', '总结陈词', '陈词', '质询', '答辩', '结辩陈词'];
// 环节判定：精确命中词表 或 以「陈词/小结」结尾（覆盖 盘问陈词/自由辩论陈词 等复合形态）

function isNewContractHeader(hdrLine) {
  return !!(hdrLine && hdrLine.includes('CP-ID') && hdrLine.includes('靶心') && hdrLine.includes('削弱指向'));
}

module.exports = { validate, checkNarrative, checkHtml, checkStructure, getEnums, checkTerminology, checkTerminologyContent, checkEffectiveType, parseSMarkers, parseSMarkerDetail, sectionOfStep, checkR5Contract, checkVerdictConsistency, checkCompletionMatrix, checkS7Contract, normalizeEnumValue, TYPE1, TYPE2, checkV1_V6, checkC1_C7, checkS8Coherence, parseS82Table, checkS82Anchors, matchTurnToRoster, checkSideTriplet, normalizeRoleTag, W2_MIN_UNRESOLVABLE, W2_RATIO, checkS8, checkS17Table, checkOutputShape, checkCompletionConsistency, detectNewContract, detectNewContractFromText, deriveDirection, applyDerivations, check55Guard, checkS102Overstrict, normalizeForCompare, CROSS_FORMAT_COMPARE_POINTS, R2_5_DOMAIN_RE, R3_DOMAIN_RE, LENGTH_GATE_RULES, checkC7DataContract, isNewContractHeader };
