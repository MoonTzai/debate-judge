'use strict';

const KIND = 'debate-judge-context-v1';
const VERSION = 1;
const USE_MODES = ['presentation_only', 'registered_conflicts_plus_presentation'];
const BACKGROUND_MODES = ['none', 'academic', 'practitioner', 'mixed'];
const BACKGROUND_DOMAINS = [
  'law_public_policy','economics_business','philosophy_ethics','social_science','natural_science','engineering_technology',
  'medicine_public_health','education','history_humanities','media_communication','arts_culture','public_administration'
];
const FAMILIARITY = ['general', 'working', 'deep'];
const VALUE_CONCERNS = [
  'procedural_fairness','substantive_fairness','individual_autonomy','rights_dignity','welfare_harm','responsibility_accountability',
  'equality_inclusion','order_predictability','long_term_sustainability','truth_accuracy','social_trust','feasibility_execution'
];
const PERSPECTIVES = [
  'neutral_observer','general_public','directly_affected','domain_practitioner','institutional_operator','policy_decision_maker',
  'academic_observer','community_observer'
];

const DEFAULT_CONTEXT = Object.freeze({
  kind: KIND,
  version: VERSION,
  enabled: false,
  useMode: 'presentation_only',
  background: Object.freeze({ mode: 'none', domains: Object.freeze([]), familiarity: 'general' }),
  valueConcerns: Object.freeze([]),
  perspective: 'neutral_observer',
  note: ''
});

function cloneDefault() {
  return {
    kind: KIND,
    version: VERSION,
    enabled: false,
    useMode: 'presentation_only',
    background: { mode: 'none', domains: [], familiarity: 'general' },
    valueConcerns: [],
    perspective: 'neutral_observer',
    note: ''
  };
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' 必须是对象');
}
function assertKeys(obj, allowed, label) {
  Object.keys(obj).forEach(function (k) {
    if (allowed.indexOf(k) < 0) throw new Error(label + ' 含未知字段: ' + k);
  });
}
function assertEnum(value, allowed, label) {
  if (allowed.indexOf(value) < 0) throw new Error(label + ' 非法: ' + String(value));
}
function normalizeStringArray(value, allowed, max, label) {
  if (!Array.isArray(value)) throw new Error(label + ' 必须是数组');
  if (value.length > max) throw new Error(label + ' 最多 ' + max + ' 项');
  var seen = {};
  return value.map(function (v) {
    if (typeof v !== 'string') throw new Error(label + ' 只能包含字符串');
    assertEnum(v, allowed, label);
    if (seen[v]) throw new Error(label + ' 不允许重复项: ' + v);
    seen[v] = true;
    return v;
  });
}
function hasStructuredSelection(c) {
  return c.background.mode !== 'none' || c.background.domains.length > 0 || c.valueConcerns.length > 0 || c.perspective !== 'neutral_observer';
}
function validateNote(note, context) {
  if (typeof note !== 'string') throw new Error('补充说明 note 必须是字符串');
  if (/\r|\n/.test(note)) throw new Error('补充说明必须是单行文本');
  if (note.length > 120) throw new Error('补充说明最多 120 字符');
  if (/```|~~~/.test(note)) throw new Error('补充说明不得包含代码围栏');
  if (note && !hasStructuredSelection(context)) throw new Error('补充说明不能独立存在，必须先选择至少一个结构化背景、价值关注或裁判视角');
  var forbidden = [
    /(?:忽略|无视|覆盖|替代|绕过).{0,16}(?:以上|上述|前述|规则|指令|要求|合同|prompt|system|系统)/i,
    /(?:system|assistant|developer|prompt)\s*[:：]/i,
    /判.{0,8}(正方|反方).{0,8}(赢|胜|获胜)/i,
    /(支持|偏向|倾向).{0,6}(正方|反方)/i,
    /指定.{0,8}(胜负|赢家|获胜方)/i,
    /比分.{0,8}(改|设|定)/i,
    /(改写|修改|篡改).{0,8}事实/i,
    /(改写|修改|篡改).{0,12}(实际发生的)?交锋/i,
    /(改变|修改|重置).{0,8}举证责任/i,
    /(增加|新增|补充|凭空).{0,8}(材料|证据)/i,
    /(背景知识|外部知识).{0,8}(作为|当作|冒充).{0,8}(本场)?证据/i,
    /(作为|当作).{0,8}本场证据/i,
    /(绕过|忽略|推翻).{0,8}(Judge|裁决|合同|规则|门禁)/i
  ];
  for (var i = 0; i < forbidden.length; i++) {
    if (forbidden[i].test(note)) throw new Error('补充说明包含被禁止的 Prompt 控制、胜负/队伍偏向、事实、举证责任、材料证据或裁决合同指令');
  }
}

function normalizeJudgeContext(raw) {
  if (raw == null) return cloneDefault();
  assertObject(raw, 'Judge Persona Context');
  assertKeys(raw, ['kind','version','enabled','useMode','background','valueConcerns','perspective','note'], 'Judge Persona Context');
  if (raw.kind !== KIND) throw new Error('Judge Persona Context kind 无效');
  if (raw.version !== VERSION) throw new Error('Judge Persona Context 版本/version 无效');
  if (typeof raw.enabled !== 'boolean') throw new Error('enabled 必须是 boolean');
  assertEnum(raw.useMode, USE_MODES, 'useMode');
  assertObject(raw.background, 'background');
  assertKeys(raw.background, ['mode','domains','familiarity'], 'background');
  assertEnum(raw.background.mode, BACKGROUND_MODES, 'background.mode');
  assertEnum(raw.background.familiarity, FAMILIARITY, 'background.familiarity');
  var out = {
    kind: KIND,
    version: VERSION,
    enabled: raw.enabled,
    useMode: raw.useMode,
    background: {
      mode: raw.background.mode,
      domains: normalizeStringArray(raw.background.domains, BACKGROUND_DOMAINS, 3, 'background.domains'),
      familiarity: raw.background.familiarity
    },
    valueConcerns: normalizeStringArray(raw.valueConcerns, VALUE_CONCERNS, 4, 'valueConcerns'),
    perspective: raw.perspective,
    note: raw.note == null ? '' : raw.note
  };
  assertEnum(out.perspective, PERSPECTIVES, 'perspective/裁判视角');
  validateNote(out.note, out);
  return out;
}

function r45Block(c) {
  return '\n\n<!-- JUDGE_PERSONA_CONTEXT_V1:R4.5 -->\n' +
    '## Judge Persona Context｜R4.5 受限冲突解释上下文\n' +
    '- background.mode: ' + c.background.mode + '\n' +
    '- background.domains: ' + (c.background.domains.join(', ') || 'none') + '\n' +
    '- valueConcerns: ' + (c.valueConcerns.join(', ') || 'none') + '\n' +
    '- perspective: ' + c.perspective + '\n\n' +
    '硬边界：该上下文只能在机械登记、且双方候选均未被更高权威直接排除的冲突中作为次级解释视角。不得创造冲突，不得改变 conflict id / pair，不得绕过现有 left/right/reject 合同，不得新增材料，不得改变事实、举证责任、交锋记录、Judge 判准权重，也不得把背景知识作为本场证据。\n';
}

function r5Block(c) {
  return '\n\n<!-- JUDGE_PERSONA_CONTEXT_V1:R5 -->\n' +
    '## Judge Persona Context｜R5 受限表达上下文\n' +
    '- background.mode: ' + c.background.mode + '\n' +
    '- background.domains: ' + (c.background.domains.join(', ') || 'none') + '\n' +
    '- background.familiarity: ' + c.background.familiarity + '\n' +
    '- valueConcerns: ' + (c.valueConcerns.join(', ') || 'none') + '\n' +
    '- perspective: ' + c.perspective + '\n' +
    (c.note ? '- bounded_note: ' + c.note + '\n' : '') + '\n' +
    '硬边界：只允许影响第一人称解释角度、术语密度、价值关注的呈现，以及对既有裁决理由的组织。不得改变 authoritative DATA、S15、胜负、比分、事实、举证责任、实际交锋或证据状态；不得引入外部材料；背景知识只能作为理解视角，不能写成本场证据。不得把本 Context 转换成三维/六向度权重、人格代码、randomness/temperature 或 provider/model 设置。\n';
}

function projectJudgeContext(context, round) {
  var c = normalizeJudgeContext(context);
  if (!c.enabled) return '';
  if (!hasStructuredSelection(c) && !c.note) return '';
  if (round === 'R4.5' && c.useMode === 'registered_conflicts_plus_presentation') return r45Block(c);
  if (round === 'R5A' || round === 'R5B') return r5Block(c);
  return '';
}

function contextSummary(context) {
  var c;
  try { c = normalizeJudgeContext(context); }
  catch (e) { return '未启用（配置无效）'; }
  if (!c.enabled) return '未启用';
  if (!hasStructuredSelection(c) && !c.note) return '已启用 · 未设定（不注入）';
  var parts = [c.useMode === 'registered_conflicts_plus_presentation' ? '已登记冲突 + 报告表达' : '仅报告表达'];
  if (c.background.mode !== 'none') parts.push('背景 ' + c.background.mode);
  if (c.background.domains.length) parts.push('领域 ' + c.background.domains.join(' / '));
  if (c.valueConcerns.length) parts.push('价值 ' + c.valueConcerns.join(' / '));
  if (c.perspective !== 'neutral_observer') parts.push('视角 ' + c.perspective);
  if (c.note) parts.push('含短补充');
  return parts.join(' · ');
}

module.exports = {
  KIND: KIND,
  VERSION: VERSION,
  DEFAULT_CONTEXT: DEFAULT_CONTEXT,
  USE_MODES: USE_MODES,
  BACKGROUND_MODES: BACKGROUND_MODES,
  BACKGROUND_DOMAINS: BACKGROUND_DOMAINS,
  FAMILIARITY: FAMILIARITY,
  VALUE_CONCERNS: VALUE_CONCERNS,
  PERSPECTIVES: PERSPECTIVES,
  normalizeJudgeContext: normalizeJudgeContext,
  projectJudgeContext: projectJudgeContext,
  contextSummary: contextSummary
};
