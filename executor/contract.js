// executor/contract.js — 产物契约模块（卡 6，260815——方案见 Upload/方案-260815-卡6-产物契约模块-细化方案.md）
// parseInputs：读取/校验/归一化 transition-final + structure.json + adjudication.json + presentation.json
//   → 单一契约对象 { data, structure, adjudication, presentation, modelSnapshot }
// 解析器单一事实源：extractDataMarkers/parseStructureJson/aggregateData/validateAdjudication/mergeAdjudicationData
//   （自 pipeline-controller 移入——PC 导出委托，RR/host-node 调用点零改动）
// 纯逻辑模块（零 require 项目模块）：fs 仅路径注入层（options.readFile——浏览器端 VFS 接线登记 web 会话）
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ==================== ID 契约工具（M-ID/CP-ID 单一事实源·纯函数·无状态） ====================
// 规范格式：M-ZH-<数字>（正方）/ M-FA-<数字>（反方）/ CP-<数字>
// 归一化：兼容 M-正/M-反、展示名 正方-N/反方-N、小写、cp 小写；
//         无法识别原样返回（不置 null、不丢弃）；幂等（规范值返回原值）。
const MID_SPEC = /^M-(ZH|FA)-\d+$/;
const CP_SPEC = /^CP-\d+$/;

function normalizeMId(raw) {
  if (typeof raw !== 'string') return raw;
  const t = raw.trim();
  if (MID_SPEC.test(t) || CP_SPEC.test(t)) return t;
  let m = /^M-(正|反)[- ]?(\d+)$/.exec(t) || /^m-(zh|fa|正|反)[- ]?(\d+)$/i.exec(t);
  if (m) return (m[1].toLowerCase() === '正' || m[1].toLowerCase() === 'zh' ? 'M-ZH-' : 'M-FA-') + m[2];
  m = /^(正方|反方)[-—]?(\d+)$/.exec(t);
  if (m) return (m[1] === '正方' ? 'M-ZH-' : 'M-FA-') + m[2];
  m = /^cp-(\d+)$/i.exec(t);
  if (m) return 'CP-' + m[1];
  return t;
}

function normalizeMIdText(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\bM-(正|反)-(\d+)\b/g, (_, d, n) => (d === '正' ? 'M-ZH-' : 'M-FA-') + n)
    .replace(/(正方|反方)-(\d+)\b/g, (_, d, n) => (d === '正方' ? 'M-ZH-' : 'M-FA-') + n)
    .replace(/\b(m-zh|m-fa)-(\d+)\b/gi, (_, d, n) => (d.toLowerCase() === 'm-zh' ? 'M-ZH-' : 'M-FA-') + n)
    .replace(/\bcp-(\d+)\b/gi, 'CP-$1');
}

// ID 判定/方位（卡 9，260815——自 pipeline-controller 移入，ID 契约工具全族收拢）
function isMid(value) { return MID_SPEC.test(String(value).trim()); }
function isCpId(value) { return CP_SPEC.test(String(value).trim()); }
function isRef(value) { return isMid(value) || isCpId(value); }
function sideOfMid(mid) {
  const n = normalizeMId(mid);
  if (/^M-ZH-\d+$/.test(n)) return '正方';
  if (/^M-FA-\d+$/.test(n)) return '反方';
  return null;
}

function normalizeStructureIds(obj) {
  if (Array.isArray(obj)) return obj.map(normalizeStructureIds);
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'm_ids' && Array.isArray(v)) out[k] = v.map(normalizeMId);
    else if (k === 'm_to_layer' && Array.isArray(v)) out[k] = v.map(item => (item && typeof item === 'object' && item.m_id ? Object.assign({}, item, { m_id: normalizeMId(item.m_id) }) : item));
    else if (k === 'm_id') out[k] = normalizeMId(v);
    else if (k === 'from_m' || k === 'to_m') out[k] = normalizeMId(v);
    // Evidence/citation prose is source-bearing text, not an ID field. Recursion
    // may normalize explicitly typed reference keys, but never arbitrary strings.
    else out[k] = normalizeStructureIds(v);
  }
  return out;
}

// ==================== 数据提取 ====================

function extractDataMarkers(md) {
  const data = {};
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    // 260806 实测容错：模型偶发输出闭合式 <!--/DATA: ... -->，按 <!--DATA: 解析
    const m = line.match(/^<!--\s*\/?DATA:\s*(\S+?)=(.+?)\s*-->$/);
    if (m) {
      const key = m[1];
      let value = m[2].trim();
      if (/^-?\d+$/.test(value)) value = parseInt(value);
      // M-ID 归一化（ID 契约工具）：仅白名单键，防止误伤 prose
      if (key === 'S8.PhaseII.正方.节点列表' || key === 'S8.PhaseII.反方.节点列表' || key === 'S7.CP入选列表') {
        value = String(value).split(/[|,，]/).map(normalizeMId).join('|');
      } else if (/^S14\.教育洞察\.(正方|反方)\.\d+$/.test(key)) {
        const parts = String(value).split('|');
        if (parts.length >= 2) parts[parts.length - 1] = normalizeMId(parts[parts.length - 1]);
        value = parts.join('|');
      } else if (key === 'C8.叙事人格.正方' || key === 'C8.叙事人格.反方' || key === 'C8.人格胜负') {
        const parts = String(value).split('|');
        if (parts.length >= 3) parts[parts.length - 1] = normalizeMId(parts[parts.length - 1]);
        value = parts.join('|');
      }
      data[key] = value;
    }
  }
  return data;
}

// ==================== structure.json 解析 ====================

function parseStructureJson(content) {
  if (typeof content !== 'string') throw new Error('内容非字符串');
  let t = content.replace(/^\[S_START\]\s*/m, '').replace(/\s*\[S_END\]\s*$/m, '');
  t = t.replace(/^#+ .*$/gm, '').replace(/^<!--.*-->$/gm, '');
  const fence = t.match(/```json\s*([\s\S]*?)```/);
  if (fence) t = fence[1];
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s < 0 || e <= s) throw new Error('未找到 JSON 对象边界');
  return normalizeStructureIds(JSON.parse(t.slice(s, e + 1)));
}

// ==================== 仲裁键空间单一事实源（维度常量/派生键/可裁决前缀/白名单） ====================
// 维度常量表：与 diffConflicts 六类对逐一对应（新增维度必须同步 DIMENSIONS + diffConflicts + ADJ-13 测试）
const DIMENSION_S7_SC = 'S7赢家↔SC完成方';
const DIMENSIONS = [DIMENSION_S7_SC, 'S11↔structure类型', '终判↔S8方向', '终判↔PhaseIII', '终判↔S11类型', '比分↔六向度'];

// 派生键注册表：机械派生（比较源键得出），模型只能裁决源键（right/left 表态）；新派生键必须入本表
const DERIVED_KEYS = {
  'S7.赢家': {
    derive: v => (v['S7.正方赢.致命'] || 0) > (v['S7.反方赢.致命'] || 0) ? '正方'
      : (v['S7.反方赢.致命'] || 0) > (v['S7.正方赢.致命'] || 0) ? '反方' : '平',
    sources: ['S7.正方赢.致命', 'S7.反方赢.致命'],
    dimension: DIMENSION_S7_SC
  }
};

// 可裁决键域前缀（覆盖原白名单全部键前缀；白名单 = 字典 DATA ∩ 本域 ∪ DERIVED_KEYS）
const ADJUDICABLE_PREFIXES = [/^S7\./, /^S8\./, /^S9\./, /^S11\./, /^S15\./, /^C7\./];

const ADJUDICATION_WHITELIST = (() => {
  const list = [
    'S11.类型', 'S8.PhaseIII.完成方', 'S8.PhaseIII.被覆盖完成方',
    'S8.碰撞终判', 'S8.S11类型方向', 'S8.PhaseIII.状态',      // +2（A3：字典已有、手动枚举漏）
    'S15.获胜方', 'S15.正方得分', 'S15.反方得分',
    'S7.SC角色.推进节点数', 'S7.关键交锋数',
    'C7.微消化.正方.实例表行数', 'C7.微消化.反方.实例表行数', 'C7.微消化.总有效数',
    'C7.SC总览.正方.有效微消化', 'C7.SC总览.反方.有效微消化'
  ];
  for (const d of ['证伪', '证成', '理性', '感性', '场面感', '意义感'])
    for (const s of ['正方', '反方']) list.push('S9.' + d + '.' + s);
  return list;
})();

// 2A：加载 input-contract 核心字典（源文件优先，内嵌块回退——轻量壳单文件交付）
let INPUT_CONTRACT_CACHE = null;
function loadInputContract() {
  if (INPUT_CONTRACT_CACHE) return INPUT_CONTRACT_CACHE;
  const file = path.join(__dirname, '..', 'schemas', 'input-contract.json');
  if (fs.existsSync(file)) {
    INPUT_CONTRACT_CACHE = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return INPUT_CONTRACT_CACHE;
  }
  const content = fs.readFileSync(path.join(__dirname, '..', 'Skill-Judge.md'), 'utf-8');
  // A8-P4 拆串纪律：避免内嵌源码含完整块标记字面量（embed-assets 删除正则跨内容误删）
  const m = content.match(new RegExp('<!-- EMBED_ASSET:SCHEMA_INPUT_CONTRACT_' + 'START -->\\s*```json\\s*([\\s\\S]*?)\\s*```\\s*<!-- EMBED_ASSET:SCHEMA_INPUT_CONTRACT_' + 'END -->'));
  if (!m) throw new Error('input-contract.json 未找到（源文件或内嵌块均缺失）');
  INPUT_CONTRACT_CACHE = JSON.parse(m[1].trim());
  return INPUT_CONTRACT_CACHE;
}

// T4：白名单（派生实现替换原「读字典 whitelist 字段」；字典 whitelist 字段由生成器同源产出）
// dataOverride 由 generate-input-contract.js 传内存 data（防读磁盘旧快照）；缺省回退常量（字典不可用时）
function adjudicableKeys(dataOverride) {
  let base = null;
  if (dataOverride && Array.isArray(dataOverride)) base = dataOverride.map(d => d.id);
  else {
    const dict = loadInputContract();
    base = dict && Array.isArray(dict.data) ? dict.data.map(d => d.id) : ADJUDICATION_WHITELIST;
  }
  const ok = base.filter(k => ADJUDICABLE_PREFIXES.some(re => re.test(k)));
  return [...new Set([...ok, ...Object.keys(DERIVED_KEYS)])];
}

function adjudicationWhitelist() {
  return adjudicableKeys();
}

// S4A-I2：contract 只消费 host/controller 已验证的 authority plan。
// 未提供 authorityPlan = legacy-unversioned，完全保持旧场次行为；semantic-bound 下
// authoritative/left/right 只能是同 semantic/projection version 的表示修复，绝无 semantic current 写权限。
function adjudicationAuthorityState(opts) {
  opts = opts || {};
  const plan = opts.authorityPlan || null;
  if (!plan) return { mode: 'legacy-unversioned', allowed: true, projectionRepair: false, semanticRevisionAuthority: false };
  if (plan.mode !== 'semantic-bound') return { mode: plan.mode || 'unknown', allowed: false, projectionRepair: false, semanticRevisionAuthority: false, blockingReason: 'semantic adjudication authority plan mode 非法' };
  if (plan.allowed !== true) return { mode: 'semantic-bound', allowed: false, projectionRepair: false, semanticRevisionAuthority: false, blockingReason: plan.blockingReason || 'semantic adjudication authority plan 未获准' };
  if (plan.mutationKind !== 'projection_repair' || plan.projectionRepair !== true || plan.semanticRevisionAuthority !== false) {
    return { mode: 'semantic-bound', allowed: false, projectionRepair: false, semanticRevisionAuthority: false, blockingReason: 'R4.5/contract 仅允许 same-version projection_repair；semantic revision 必须走 review + CAS' };
  }
  return { mode: 'semantic-bound', allowed: true, projectionRepair: true, semanticRevisionAuthority: false, versionKey: plan.versionKey || null };
}
function pairAssignment(expr) {
  const m = String(expr || '').match(/^([^=]+)=(.*)$/);
  return m ? { key: m[1].trim(), value: m[2] } : null;
}

// R4.5：adjudication 结构/白名单/登记一致性校验（BLOCKING = 越权/缺 reason/复核未过）
function validateAdjudication(adj, opts) {
  opts = opts || {};
  const errors = [];
  const warnings = [];
  const authorityState = adjudicationAuthorityState(opts);
  const semanticBound = authorityState.mode === 'semantic-bound';
  if (semanticBound && !authorityState.allowed) {
    errors.push({ rule: 'ADJ-AUTH', severity: 'BLOCKING', message: authorityState.blockingReason || 'semantic-bound adjudication authority 无效' });
  }
  if (!adj || typeof adj !== 'object') return { passed: false, errors: [{ rule: 'ADJ-0', severity: 'BLOCKING', message: 'adjudication 不是对象' }], warnings };
  if (adj.schema_version !== '0.1.0') errors.push({ rule: 'ADJ-1', severity: 'BLOCKING', message: 'schema_version 必须为 0.1.0' });
  if (!Array.isArray(adj.conflicts)) errors.push({ rule: 'ADJ-2', severity: 'BLOCKING', message: 'conflicts 必须是数组' });
  const seen = new Set();
  for (const c of (adj.conflicts || [])) {
    if (!/^CF-\d{3}$/.test(c.conflict_id || '')) errors.push({ rule: 'ADJ-3', severity: 'BLOCKING', message: 'conflict_id 格式非法: ' + c.conflict_id });
    if (seen.has(c.conflict_id)) errors.push({ rule: 'ADJ-3b', severity: 'BLOCKING', message: 'conflict_id 重复: ' + c.conflict_id });
    seen.add(c.conflict_id);
    if (!['left', 'right', 'reject'].includes(c.adjudicated)) errors.push({ rule: 'ADJ-4', severity: 'BLOCKING', message: c.conflict_id + ' adjudicated 必须为 left/right/reject' });
    if (!c.reason || !String(c.reason).trim()) errors.push({ rule: 'ADJ-4b', severity: 'BLOCKING', message: c.conflict_id + ' reason 缺失' });
    else if (String(c.reason).length < 30) warnings.push({ rule: 'ADJ-4b', severity: 'WARNING', message: c.conflict_id + ' reason <30 字（长度仅作质量提示，不决定语义合法性）' });
    if (!['高', '中', '低'].includes(c.confidence)) errors.push({ rule: 'ADJ-4c', severity: 'BLOCKING', message: c.conflict_id + ' confidence 非法' });
    if (c.reviewed_by !== 'R4.5') errors.push({ rule: 'ADJ-4d', severity: 'BLOCKING', message: c.conflict_id + ' reviewed_by 必须为 R4.5' });
    // T3：多范式——每条裁决必须声明范式；计数式理由被机械拒绝
    const paradigms = ['semantic_fit', 'explanatory_power', 'structural_coherence', 'provenance', 'criteria_derivation'];
    if (!paradigms.includes(c.paradigm)) errors.push({ rule: 'ADJ-12', severity: 'BLOCKING', message: c.conflict_id + ' paradigm 非法（必须为 ' + paradigms.join('/') + '）' });
    if (/(\d+\s*(处|项|条|个)\s*(证据|支持|一致))|((证据|支持|一致)\s*(处|项|条|个)\s*\d+)|多数|投票|\d+\s*:\s*\d+\s*支持/.test(String(c.reason || '')))
      warnings.push({ rule: 'ADJ-REASON-COUNT', severity: 'WARNING', message: c.conflict_id + ' reason 命中计数/投票词汇启发式；不得据此机械否定语义，必要时由 reviewer 判断理由是否真的以计数代替解释' });
    // ADJ-13（批甲 A6）：dimension 必须 ∈ DIMENSIONS（防 excluded 失配）
    if (!DIMENSIONS.includes(c.dimension)) errors.push({ rule: 'ADJ-13', severity: 'BLOCKING', message: c.conflict_id + ' dimension 非法: ' + c.dimension + '（须 ∈ DIMENSIONS 六类之一）' });
  }

  // ADJ-14（批甲 D2）：与机械冲突登记表同源逐字一致（opts.registryConflicts 非数组=跳过，回放安全）
  if (Array.isArray(opts.registryConflicts)) {
    const regById = new Map(opts.registryConflicts.map(c => [c.conflict_id, c]));
    const adjSeen = new Set();
    for (const c of (adj.conflicts || [])) {
      const r = regById.get(c.conflict_id);
      if (!r) errors.push({ rule: 'ADJ-14', severity: 'BLOCKING',
        message: c.conflict_id + ' 不在机械冲突登记表（.tmp-conflicts.json）——conflicts 必须与登记表逐字一致（不得新增/改名）' });
      else {
        if (r.dimension !== c.dimension) errors.push({ rule: 'ADJ-14', severity: 'BLOCKING',
          message: c.conflict_id + ' dimension 与登记表不一致: 模型「' + c.dimension + '」 vs 登记「' + r.dimension + '」' });
        if (JSON.stringify(r.pair) !== JSON.stringify(c.pair)) errors.push({ rule: 'ADJ-14', severity: 'BLOCKING',
          message: c.conflict_id + ' pair 与登记表不一致' });
      }
      adjSeen.add(c.conflict_id);
    }
    for (const r of opts.registryConflicts) if (!adjSeen.has(r.conflict_id))
      errors.push({ rule: 'ADJ-14', severity: 'BLOCKING',
        message: r.conflict_id + ' 未裁决（登记表冲突必须全部处理）——复核将失败，提前拦截' });
  }

  // ADJ-15/16 legacy 行为原样保留。semantic-bound 下，transition S11 是已绑定 same-version
  // projection 的 canonical 类型输入，R4 的 structure 只允许忠实复制。S11↔structure 冲突因此只能
  // 选择 left：保留 bound S11，并把 structure 修回该值；right/reject/authoritative 都会把错误
  // downstream projection 反向升级成新的 semantic type，属于越权。
  for (const c of (adj.conflicts || [])) {
    if (c.dimension === 'S11↔structure类型') {
      if (semanticBound) {
        if (c.adjudicated !== 'left' || Object.prototype.hasOwnProperty.call(adj.authoritative || {}, 'S11.类型')) {
          errors.push({ rule: 'ADJ-15-PROJECTION-DIRECTION', severity: 'BLOCKING',
            message: 'semantic-bound S11↔structure projection repair 只能选择 left（保留 bound S11、修 structure）；禁止 right/reject/authoritative 改写 S11' });
        }
      } else {
        if (c.adjudicated !== 'reject')
          errors.push({ rule: 'ADJ-15', severity: 'BLOCKING',
            message: 'S11↔structure类型 冲突必须 reject 裁决（authoritative 写 S11.类型）——right/left 不写值将导致渲染 G0-1 死锁' });
        if (c.adjudicated === 'reject' && !((adj.authoritative || {})['S11.类型']))
          errors.push({ rule: 'ADJ-15', severity: 'BLOCKING', message: 'S11↔structure类型 reject 裁决必须同时写 authoritative[\'S11.类型\']' });
      }
    }
  }

  const TERMINAL_DIMS = ['终判↔S8方向', '终判↔PhaseIII', '终判↔S11类型'];
  for (const c of (adj.conflicts || [])) {
    if (!semanticBound && TERMINAL_DIMS.includes(c.dimension) && c.adjudicated !== 'reject')
      errors.push({ rule: 'ADJ-16', severity: 'BLOCKING',
        message: c.dimension + ' 冲突必须 reject 裁决（写 S8.碰撞终判 或对侧真实键）——类型门禁只消费 S8.碰撞终判，right/left 裁决无生效路径' });
    if (!semanticBound && TERMINAL_DIMS.includes(c.dimension) && c.adjudicated === 'reject'
        && !((adj.authoritative || {})['S8.碰撞终判']) && !((adj.authoritative || {})['S8.S11类型方向'])
        && !((adj.authoritative || {})['S8.PhaseIII.状态']) && !((adj.authoritative || {})['S11.类型']))
      errors.push({ rule: 'ADJ-16', severity: 'BLOCKING', message: c.dimension + ' reject 裁决必须写真实键（S8.碰撞终判/S8.S11类型方向/S8.PhaseIII.状态/S11.类型 之一）' });
    if (semanticBound && TERMINAL_DIMS.includes(c.dimension) && c.adjudicated === 'reject'
        && !((adj.authoritative || {})['S8.碰撞终判']) && !((adj.authoritative || {})['S8.S11类型方向'])
        && !((adj.authoritative || {})['S8.PhaseIII.状态']) && !((adj.authoritative || {})['S11.类型']))
      errors.push({ rule: 'ADJ-16-PROJECTION', severity: 'BLOCKING', message: c.dimension + ' semantic-bound reject 表示修复必须给出被修 projection 的真实键；不得由机械一致性生成 semantic truth' });
  }

  const registeredFields = new Set();
  for (const c of (adj.conflicts || [])) {
    for (const p of (c.pair || [])) {
      const m = String(p).match(/^([^=]+)=/);
      if (m) registeredFields.add(m[1].trim());
    }
  }
  const auth = adj.authoritative || {};
  const whitelist = adjudicationWhitelist();
  if (semanticBound && Object.keys(auth).length > 0) {
    errors.push({ rule: 'ADJ-6-PROJECTION', severity: 'BLOCKING',
      message: 'semantic-bound projection_repair 禁止 authoritative 写入 DATA；只能在已绑定表示之间做不改变 semantic truth 的修复' });
  }
  for (const k of Object.keys(auth)) {
    if (!whitelist.includes(k)) errors.push({ rule: 'ADJ-6', severity: 'BLOCKING', message: 'authoritative 越权字段: ' + k + '（仅可裁决键域 S7/S8/S9/S11/S15/C7 前缀 ∪ DERIVED_KEYS 注册键可写；展示/派生项请用 right/left 裁决）' });
    else if (!registeredFields.has(k)) errors.push({ rule: 'ADJ-6b', severity: 'BLOCKING', message: 'authoritative 字段未在 conflicts 登记: ' + k });
  }
  const smo = adj.structure_meta_override;
  if (semanticBound && smo) {
    errors.push({
      rule: 'ADJ-7-PROJECTION',
      severity: 'BLOCKING',
      message: 'semantic-bound projection_repair 禁止 structure_meta_override；R4.5 不得凭空改 effective type'
    });
  } else if (smo) {
    if (!['2b', '2c', '0'].includes(smo.type_override)) errors.push({ rule: 'ADJ-7', severity: 'BLOCKING', message: 'structure_meta_override.type_override 非法: ' + smo.type_override });
    if (!smo.override_reason || !String(smo.override_reason).trim()) errors.push({ rule: 'ADJ-8', severity: 'BLOCKING', message: 'structure_meta_override.override_reason 缺失' });
    else if (String(smo.override_reason).length < 10) warnings.push({ rule: 'ADJ-8', severity: 'WARNING', message: 'structure_meta_override.override_reason <10 字（长度仅作质量提示）' });
  }
  const aud = adj.audit || {};
  if (aud.merged_validate && aud.merged_validate.passed === false) errors.push({ rule: 'ADJ-9', severity: 'BLOCKING', message: 'audit.merged_validate 未通过' });
  if (typeof aud.post_diff_conflicts === 'number' && aud.post_diff_conflicts > 0) errors.push({ rule: 'ADJ-10', severity: 'BLOCKING', message: 'audit.post_diff_conflicts > 0（复核后仍有冲突）' });
  if (aud.structure_check && aud.structure_check.passed === false) errors.push({ rule: 'ADJ-11', severity: 'BLOCKING', message: 'audit.structure_check 未通过' });
  return { passed: errors.length === 0, errors, warnings };
}

// R4.5：authoritative 合并进 transition-final 数据视图（返回合并后文本，供 R5/渲染/校验统一消费）。
// legacy 调用保持旧 ABI；semantic-bound 调用必须显式携带有效 projection_repair authorityPlan。
function mergeAdjudicationData(tfContent, adjudication, opts) {
  opts = opts || {};
  const authorityState = adjudicationAuthorityState(opts);
  if (authorityState.mode === 'semantic-bound' && !authorityState.allowed) {
    const e = new Error('[contract] semantic-bound adjudication merge 被拒绝: ' + (authorityState.blockingReason || 'authority plan invalid'));
    e.code = 'ERR_ADJUDICATION_AUTHORITY';
    throw e;
  }
  const data = extractDataMarkers(tfContent);
  if (authorityState.mode === 'semantic-bound') {
    const conflicts = (adjudication && adjudication.conflicts) || [];
    const illegalS11 = conflicts.find(c => c && c.dimension === 'S11↔structure类型' && c.adjudicated !== 'left');
    const authoritative = Object.keys((adjudication && adjudication.authoritative) || {});
    if (illegalS11) {
      const e = new Error('[contract] semantic-bound S11↔structure projection repair must choose left; structure cannot rewrite bound S11');
      e.code = 'ERR_ADJUDICATION_AUTHORITY';
      throw e;
    }
    if (authoritative.length) {
      const e = new Error('[contract] semantic-bound projection_repair cannot write authoritative DATA values');
      e.code = 'ERR_ADJUDICATION_AUTHORITY';
      throw e;
    }
  } else {
    for (const [k, v] of Object.entries((adjudication && adjudication.authoritative) || {})) {
      data[k] = /^\d+$/.test(String(v)) ? parseInt(String(v), 10) : String(v);
    }
  }
  const lines = tfContent.replace(/\r\n/g, '\n').split('\n').filter(l => !/^<!--DATA:/.test(l.trim()));
  const appended = Object.entries(data).map(([k, v]) => '<!--DATA: ' + k + '=' + v + ' -->');
  // 3B：DATA 行必须插在 [FILE_END] 之前，否则 F1（末尾 FILE_END）校验失败
  const endIdx = lines.findIndex(l => l.includes('[FILE_END]'));
  if (endIdx >= 0) lines.splice(endIdx, 0, ...appended);
  else lines.push(...appended);
  return lines.join('\n');
}

// 2) aggregateData：DATA 机械聚合 → model-snapshot.json（单一权威快照）
function aggregateData(transitionFile) {
  const content = fs.readFileSync(transitionFile, 'utf-8');
  return {
    values: extractDataMarkers(content),
    source_files: [transitionFile],
    generated_at: new Date().toISOString(),
    schema_version: '0.1.0'
  };
}

// INSERT 注册表读取（卡 9，260815——自 pipeline-controller 移入，解析器单一源延续；getEnums 留 PC）
function parseInsertRegistry(skillPath) {
  const content = fs.readFileSync(skillPath, 'utf-8');
  const match = content.match(/<!--REGISTRY_START-->\r?\n```json\r?\n([\s\S]*?)\r?\n```\r?\n<!--REGISTRY_END-->/);
  if (!match) throw new Error('INSERT注册表 JSON 未找到');
  let registry;
  try { registry = JSON.parse(match[1].trim()); } catch (e) {
    throw new Error('注册表 JSON 解析失败: ' + e.message);
  }
  if (!registry.inserts || !Array.isArray(registry.inserts))
    throw new Error('注册表缺少 inserts 数组');
  if (!registry.enums) registry.enums = {};
  for (const r of registry.inserts) {
    if (!r.name || !r.ch || !r.type || !r.producer || !r.consumer)
      throw new Error('注册表条目缺少必须字段: ' + JSON.stringify(r));
  }
  return registry;
}

// ==================== C-R final adjudicative reconciliation contract ====================
// Mechanical contract only: provenance, dependency identity/dedup, local-vs-motion separation,
// upstream-reopen binding, and final reason references. It never derives a winner from SC formation,
// relation type, abstraction level, unit count, or reviewed global direction.
const FINAL_ADJUDICATION_SCHEMA = 'judge-final-adjudication-v1';
const FINAL_ADJUDICATION_RECEIPT_SCHEMA = 'judge-final-adjudication-receipt-v1';

function stableContractJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableContractJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableContractJson(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function cleanStringList(value, label) {
  if (!Array.isArray(value) || !value.length) throw new Error(label + ' must be a non-empty array');
  const out = [...new Set(value.map(v => String(v || '').trim()).filter(Boolean))].sort();
  if (!out.length) throw new Error(label + ' must contain a non-empty string');
  return out;
}

function projectionViewList(value) {
  const order = { S7: 10, S9: 20, S11: 30, S15: 40 };
  return [...new Set((Array.isArray(value) ? value : []).map(v => String(v || '').trim()).filter(Boolean))]
    .sort((a, b) => (order[a] || 1000) - (order[b] || 1000) || a.localeCompare(b));
}

function adjudicativeDependencyIdentity(unit) {
  unit = unit || {};
  const sourceRefs = cleanStringList(unit.source_refs, 'source_refs');
  const targetRef = String(unit.target_ref || '').trim();
  const causalDependency = String(unit.causal_dependency || '').trim();
  if (!targetRef) throw new Error('target_ref required');
  if (!causalDependency) throw new Error('causal_dependency required');
  const canonical = stableContractJson({
    source_refs: sourceRefs,
    target_ref: targetRef,
    causal_dependency: causalDependency
  });
  return 'DEP-' + crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 24);
}

function dedupeAdjudicativeUnits(units) {
  if (!Array.isArray(units)) throw new Error('adjudicative_units must be an array');
  const byDependency = new Map();
  const ordered = [];
  for (const raw of units) {
    const unit = raw || {};
    const unitId = String(unit.unit_id || '').trim();
    if (!unitId) throw new Error('unit_id required');
    const dependencyId = adjudicativeDependencyIdentity(unit);
    const sourceRefs = cleanStringList(unit.source_refs, 'source_refs');
    const projectionViews = projectionViewList(unit.projection_views);
    const localClash = unit.local_clash && typeof unit.local_clash === 'object' ? JSON.parse(JSON.stringify(unit.local_clash)) : null;
    const motionConsequence = unit.motion_consequence && typeof unit.motion_consequence === 'object' ? JSON.parse(JSON.stringify(unit.motion_consequence)) : null;
    if (!localClash || !String(localClash.status || '').trim() || !String(localClash.owner_ref || '').trim() || !String(localClash.reason || '').trim()) {
      throw new Error('local_clash requires status/owner_ref/reason for ' + unitId);
    }
    if (!motionConsequence || !String(motionConsequence.status || '').trim() || !String(motionConsequence.reason || '').trim()) {
      throw new Error('motion_consequence requires status/reason for ' + unitId);
    }
    const normalized = Object.assign({}, JSON.parse(JSON.stringify(unit)), {
      unit_id: unitId,
      dependency_id: dependencyId,
      source_refs: sourceRefs,
      target_ref: String(unit.target_ref).trim(),
      causal_dependency: String(unit.causal_dependency).trim(),
      local_clash: localClash,
      motion_consequence: motionConsequence,
      independence_basis: String(unit.independence_basis || '').trim() || null,
      projection_views: projectionViews,
      source_unit_ids: [unitId]
    });
    const prior = byDependency.get(dependencyId);
    if (!prior) {
      byDependency.set(dependencyId, normalized);
      ordered.push(normalized);
      continue;
    }
    const semanticFields = x => ({
      source_refs: x.source_refs,
      target_ref: x.target_ref,
      causal_dependency: x.causal_dependency,
      local_clash: x.local_clash,
      motion_consequence: x.motion_consequence,
      independence_basis: x.independence_basis
    });
    if (stableContractJson(semanticFields(prior)) !== stableContractJson(semanticFields(normalized))) {
      throw new Error('same dependency_id has conflicting semantic payload: ' + dependencyId);
    }
    prior.projection_views = projectionViewList([...(prior.projection_views || []), ...projectionViews]);
    prior.source_unit_ids = [...new Set([...(prior.source_unit_ids || []), unitId])];
  }

  // The same source set may support more than one genuinely independent effect, but that
  // multiplicity must be explicit. This prevents one source from being split into artificial votes.
  const bySourceSet = new Map();
  for (const unit of ordered) {
    const key = stableContractJson(unit.source_refs);
    const list = bySourceSet.get(key) || [];
    list.push(unit);
    bySourceSet.set(key, list);
  }
  for (const list of bySourceSet.values()) {
    if (list.length <= 1) continue;
    const explicitIndependenceCount = list.filter(unit => !!unit.independence_basis).length;
    if (explicitIndependenceCount < list.length - 1) {
      throw new Error('same source_refs create multiple dependencies without enough explicit independence_basis');
    }
  }
  return ordered;
}

function finalContractError(errors, rule, message) {
  errors.push({ rule, severity: 'BLOCKING', message });
}

function isSha256(value) { return /^[a-f0-9]{64}$/.test(String(value || '')); }

function validateFinalAdjudication(doc, expectedBindings) {
  const errors = [];
  if (!doc || typeof doc !== 'object') {
    finalContractError(errors, 'FINAL-0', 'final adjudication must be an object');
    return { passed: false, errors };
  }
  if (doc.schema !== FINAL_ADJUDICATION_SCHEMA) finalContractError(errors, 'FINAL-SCHEMA', 'schema must be ' + FINAL_ADJUDICATION_SCHEMA);
  if (!Number.isInteger(doc.revision) || doc.revision < 1) finalContractError(errors, 'FINAL-REVISION', 'revision must be a positive integer');

  const bindings = doc.bindings;
  if (!bindings || typeof bindings !== 'object') {
    finalContractError(errors, 'FINAL-BINDING', 'bindings missing');
  } else {
    if (!isSha256(bindings.source_sha256)) finalContractError(errors, 'FINAL-BINDING', 'source_sha256 invalid');
    if (expectedBindings && stableContractJson(bindings) !== stableContractJson(expectedBindings)) {
      finalContractError(errors, 'FINAL-BINDING', 'final adjudication bindings do not exactly match current source/global/SC/upstream authority');
    }
  }

  const baseline = doc.global_baseline || {};
  if (!['affirmative', 'negative', 'balanced', 'unresolved'].includes(String(baseline.review_direction || ''))) {
    finalContractError(errors, 'FINAL-GLOBAL-BASELINE', 'global_baseline.review_direction invalid');
  }
  if (!['maintain', 'revise'].includes(String(baseline.disposition || ''))) {
    finalContractError(errors, 'FINAL-GLOBAL-BASELINE', 'global_baseline.disposition must be maintain|revise');
  }
  if (!String(baseline.reason || '').trim()) finalContractError(errors, 'FINAL-GLOBAL-BASELINE', 'global_baseline.reason required');

  let canonical = [];
  try {
    canonical = dedupeAdjudicativeUnits(doc.adjudicative_units || []);
    if (canonical.length !== (doc.adjudicative_units || []).length) {
      finalContractError(errors, 'FINAL-DEDUP', 'adjudicative_units contain duplicate projections of the same dependency; publish canonical units only');
    }
    const seenUnitIds = new Set();
    for (let i = 0; i < canonical.length; i++) {
      const unit = canonical[i];
      if (seenUnitIds.has(unit.unit_id)) finalContractError(errors, 'FINAL-UNIT-ID', 'duplicate unit_id: ' + unit.unit_id);
      seenUnitIds.add(unit.unit_id);
      if (doc.adjudicative_units[i] && doc.adjudicative_units[i].dependency_id !== unit.dependency_id) {
        finalContractError(errors, 'FINAL-DEPENDENCY-ID', 'dependency_id must equal deterministic provenance identity for ' + unit.unit_id);
      }
      if (!['maintain', 'reopen_required'].includes(String(unit.local_clash && unit.local_clash.status || ''))) {
        finalContractError(errors, 'FINAL-LOCAL-TRUTH', 'local_clash.status must be maintain|reopen_required for ' + unit.unit_id);
      }
    }
  } catch (e) {
    finalContractError(errors, 'FINAL-DEDUP', e.message);
  }

  const reopen = doc.upstream_reopen || {};
  const requiresReopen = canonical.some(u => u.local_clash && u.local_clash.status === 'reopen_required');
  if (requiresReopen) {
    if (reopen.required !== true || !String(reopen.target_owner || '').trim() ||
        !String(reopen.target_ref || '').trim() || !String(reopen.reason || '').trim()) {
      finalContractError(errors, 'FINAL-UPSTREAM-REOPEN', 'local truth challenge requires explicit upstream reopen owner/ref/reason');
    }
  } else if (reopen.required !== false) {
    finalContractError(errors, 'FINAL-UPSTREAM-REOPEN', 'upstream_reopen.required must be false when no local truth is challenged');
  }

  const final = doc.final || {};
  if (!String(final.criterion || '').trim()) finalContractError(errors, 'FINAL-CRITERION', 'final.criterion required');
  if (!['正方', '反方', '平', '未决'].includes(String(final.winner || ''))) finalContractError(errors, 'FINAL-WINNER', 'final.winner invalid');
  const score = final.score;
  if (!score || typeof score !== 'object' || !Number.isFinite(Number(score.affirmative)) || !Number.isFinite(Number(score.negative))) {
    finalContractError(errors, 'FINAL-SCORE', 'final.score requires numeric affirmative/negative');
  }
  if (!String(final.reason || '').trim()) finalContractError(errors, 'FINAL-REASON', 'final.reason required');
  const refs = Array.isArray(final.reason_unit_refs) ? final.reason_unit_refs.map(String) : [];
  const unitIds = new Set(canonical.map(u => u.unit_id));
  if (!refs.length || refs.some(ref => !unitIds.has(ref))) {
    finalContractError(errors, 'FINAL-REASON-REF', 'final.reason_unit_refs must reference canonical adjudicative unit_id values');
  }
  return { passed: errors.length === 0, errors, canonical_units: canonical };
}

function sha256Utf8(value) {
  return crypto.createHash('sha256').update(Buffer.from(String(value == null ? '' : value), 'utf8')).digest('hex');
}

function extractFinalAdjudicationControl(text) {
  const body = String(text || '');
  const re = /<!--FINAL_ADJUDICATION\s*([\s\S]*?)-->/g;
  const hits = [];
  let m;
  while ((m = re.exec(body)) !== null) hits.push({ raw: m[0], json: String(m[1] || '').trim() });
  if (hits.length !== 1) {
    return { passed: false, doc: null, raw: null, errors: [{
      rule: 'FINAL-CONTROL', severity: 'BLOCKING',
      message: hits.length === 0 ? 'missing FINAL_ADJUDICATION control block' : 'multiple FINAL_ADJUDICATION control blocks'
    }] };
  }
  try {
    const doc = JSON.parse(hits[0].json);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('control must contain one JSON object');
    return { passed: true, doc, raw: hits[0].raw, errors: [] };
  } catch (e) {
    return { passed: false, doc: null, raw: hits[0].raw, errors: [{
      rule: 'FINAL-CONTROL', severity: 'BLOCKING', message: 'FINAL_ADJUDICATION JSON invalid: ' + e.message
    }] };
  }
}

function finalAdjudicationRevision(doc) {
  return 'FINAL-' + sha256Utf8(stableContractJson(doc)).slice(0, 32);
}

function canonicalizeFinalAdjudication(doc) {
  const next = JSON.parse(JSON.stringify(doc || {}));
  const rawUnits = Array.isArray(next.adjudicative_units) ? next.adjudicative_units : [];
  const canonical = dedupeAdjudicativeUnits(rawUnits);
  const refMap = new Map();
  for (const unit of canonical) {
    for (const rawId of unit.source_unit_ids || [unit.unit_id]) refMap.set(String(rawId), unit.unit_id);
  }
  next.adjudicative_units = canonical;
  if (next.final && Array.isArray(next.final.reason_unit_refs)) {
    next.final.reason_unit_refs = [...new Set(next.final.reason_unit_refs.map(x => refMap.get(String(x)) || String(x)))];
  }
  return next;
}

function buildFinalAdjudicationReceipt(doc, p3Text) {
  doc = canonicalizeFinalAdjudication(doc);
  const validation = validateFinalAdjudication(doc);
  if (!validation.passed) {
    const e = new Error('cannot build final adjudication receipt: ' +
      validation.errors.map(x => x.rule + ': ' + x.message).join('; '));
    e.code = 'ERR_FINAL_ADJUDICATION_INVALID';
    e.validation = validation;
    throw e;
  }
  return {
    schema: FINAL_ADJUDICATION_RECEIPT_SCHEMA,
    final_revision: finalAdjudicationRevision(doc),
    adjudication_sha256: sha256Utf8(stableContractJson(doc)),
    p3_sha256: sha256Utf8(String(p3Text || '')),
    bindings: JSON.parse(JSON.stringify(doc.bindings)),
    final: JSON.parse(JSON.stringify(doc.final))
  };
}

function validateFinalAdjudicationReceipt(receipt, doc, p3Text, expectedBindings) {
  doc = canonicalizeFinalAdjudication(doc);
  const errors = [];
  const validation = validateFinalAdjudication(doc, expectedBindings);
  errors.push(...validation.errors);
  if (!receipt || typeof receipt !== 'object') {
    finalContractError(errors, 'FINAL-RECEIPT', 'final adjudication receipt missing');
    return { passed: false, errors };
  }
  if (receipt.schema !== FINAL_ADJUDICATION_RECEIPT_SCHEMA)
    finalContractError(errors, 'FINAL-RECEIPT-SCHEMA', 'receipt schema mismatch');
  const expectedRevision = finalAdjudicationRevision(doc);
  if (String(receipt.final_revision || '') !== expectedRevision)
    finalContractError(errors, 'FINAL-RECEIPT-REVISION', 'receipt final_revision does not match canonical adjudication');
  if (String(receipt.adjudication_sha256 || '') !== sha256Utf8(stableContractJson(doc)))
    finalContractError(errors, 'FINAL-RECEIPT-ADJUDICATION', 'receipt adjudication hash does not match canonical adjudication');
  if (String(receipt.p3_sha256 || '') !== sha256Utf8(String(p3Text || '')))
    finalContractError(errors, 'FINAL-RECEIPT-P3', 'receipt P3 hash does not match exact current P3 bytes');
  if (stableContractJson(receipt.bindings) !== stableContractJson(doc && doc.bindings))
    finalContractError(errors, 'FINAL-RECEIPT-BINDING', 'receipt bindings do not match adjudication bindings');
  if (stableContractJson(receipt.final) !== stableContractJson(doc && doc.final))
    finalContractError(errors, 'FINAL-RECEIPT-FINAL', 'receipt final does not match adjudication final result');
  return { passed: errors.length === 0, errors, final_revision: expectedRevision };
}

// ==================== schema 校验（最小字段级校验——项目零依赖，不引 ajv） ====================
const PRESENTATION_TEMPLATE_TYPES = ['0', '1a', '1b', '1c', '1d', '2a', '2b', '2c'];

function validateContract(contractObj, schemaName) {
  if (!contractObj || typeof contractObj !== 'object') return { ok: false, errors: ['契约对象缺失'] };
  const errors = [];
  if (schemaName === 'presentation' && contractObj.presentation && typeof contractObj.presentation === 'object') {
    const t = contractObj.presentation['模板族'];
    if (t !== undefined && !PRESENTATION_TEMPLATE_TYPES.includes(String(t)))
      errors.push('presentation.模板族 非法: ' + t + '（须 ∈ ' + PRESENTATION_TEMPLATE_TYPES.join('/') + '）');
    const charts = contractObj.presentation['图表清单'];
    if (charts !== undefined && !Array.isArray(charts)) errors.push('presentation.图表清单 必须是数组');
  } else if (schemaName === 'presentation') {
    errors.push('presentation 缺失或非对象');
  }
  if (schemaName === 'structure' && contractObj.structure && typeof contractObj.structure === 'object') {
    if (!contractObj.structure.meta || typeof contractObj.structure.meta !== 'object') errors.push('structure.meta 缺失');
  } else if (schemaName === 'structure') {
    errors.push('structure 缺失或非对象');
  }
  if (schemaName === 'adjudication' && contractObj.adjudication) {
    const v = validateAdjudication(contractObj.adjudication, {});
    if (!v.passed) errors.push('adjudication 校验失败: ' + v.errors.map(e => e.rule).join(','));
  }
  if (schemaName === 'model-snapshot' && contractObj.modelSnapshot) {
    if (!contractObj.modelSnapshot.values || typeof contractObj.modelSnapshot.values !== 'object') errors.push('modelSnapshot.values 缺失');
    if (contractObj.modelSnapshot.schema_version !== '0.1.0') errors.push('modelSnapshot.schema_version 非法');
  }
  return { ok: errors.length === 0, errors };
}

// ==================== parseInputs：统一契约输入 ====================
// files = { transition, structure, adjudication, presentation }（路径或 null）
// options.readFile 注入（默认 fs 读——浏览器端 VFS 接线登记 web 会话）
function parseInputs(files, options) {
  options = options || {};
  const read = options.readFile || ((p) => fs.readFileSync(p, 'utf-8'));
  files = files || {};
  const data = files.transition ? extractDataMarkers(read(files.transition)) : {};
  let structure = null;
  if (files.structure) structure = parseStructureJson(read(files.structure));
  let adjudication = null;
  if (files.adjudication) {
    adjudication = JSON.parse(read(files.adjudication));
    // 业务校验结果附注到契约对象（不抛错——parseInputs 职责 = 构建契约对象；
    // 门禁语义由调用方经 validateContract/validateAdjudication 独立行使；历史场次旧维度名等差异不阻断构建）
    const v = validateAdjudication(adjudication, {});
    if (!v.passed) adjudication = Object.assign(adjudication, { validation: { passed: false, errors: v.errors } });
  }
  let presentation = null;
  if (files.presentation) presentation = JSON.parse(read(files.presentation));
  const modelSnapshot = files.transition
    ? { values: data, source_files: [files.transition], generated_at: new Date().toISOString(), schema_version: '0.1.0' }
    : null;
  const contract = { data, structure, adjudication, presentation, modelSnapshot };
  if (presentation) {
    const presCheck = validateContract(contract, 'presentation');
    if (!presCheck.ok) throw new Error('presentation 校验失败: ' + presCheck.errors.join('; '));
  }
  return contract;
}

module.exports = {
  MID_SPEC, CP_SPEC,
  normalizeMId, normalizeMIdText, normalizeStructureIds,
  isMid, isCpId, isRef, sideOfMid,
  extractDataMarkers, parseStructureJson, aggregateData,
  validateAdjudication, mergeAdjudicationData,
  adjudicableKeys, adjudicationWhitelist, loadInputContract,
  parseInsertRegistry,
  DIMENSION_S7_SC, DIMENSIONS, DERIVED_KEYS, ADJUDICABLE_PREFIXES, ADJUDICATION_WHITELIST,
  FINAL_ADJUDICATION_SCHEMA, FINAL_ADJUDICATION_RECEIPT_SCHEMA,
  stableContractJson, adjudicativeDependencyIdentity, dedupeAdjudicativeUnits, validateFinalAdjudication,
  sha256Utf8, extractFinalAdjudicationControl, canonicalizeFinalAdjudication, finalAdjudicationRevision, buildFinalAdjudicationReceipt, validateFinalAdjudicationReceipt,
  validateContract, parseInputs
};
