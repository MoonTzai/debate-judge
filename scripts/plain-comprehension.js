'use strict';

// PLAIN-V3 semantic review boundary
// -------------------------------
// This module intentionally keeps only machine-provable invariants as hard gates.
// Readability, naturalness, semantic equivalence and locator independence are reviewed
// by an independent LLM over ordered reading context. The glossary is a generator /
// reviewer hint, never a reader-visible fixed-template requirement.

const CORE_GLOSSARY = require('../assets/plain-dict.json');

const PROFILE_BODY = 'professional_explanation';
const PROFILE_GUIDE = 'zero_background_summary';
const READABILITY_REVIEW_PROMPT_VERSION = 'plain-readability-review-v1';
const READABILITY_REPAIR_PROMPT_VERSION = 'plain-readability-repair-v1';

// Compatibility export: CONCEPTS is now derived from the single glossary source.
const CONCEPTS = Object.entries(CORE_GLOSSARY)
  .map(([term, explanation]) => ({ term, explanation: String(explanation || '') }))
  .sort((a, b) => b.term.length - a.term.length || a.term.localeCompare(b.term, 'zh-CN'));

const INTERNAL_MARKER_RES = [
  /\bN\d+\b/g,
  /\bM-[A-Z]+-\d+\b/g,
  /\bCP-(?:[A-Z]+-)?\d+\b/g,
  /\bB0\b/g,
  /\bQ[1-4]\b/g,
  /\bPhase\s*(?:I{1,3}|[1-3])\b/gi,
  /路径[①②③1-3]/g,
  /\bLv[0-6]\b/gi,
  /场[ABC](?=[·：:\s])/g
];

function normalizeText(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

function conceptMatches(text) {
  const s = normalizeText(text);
  const hits = [];
  let masked = s;
  for (const concept of CONCEPTS) {
    if (!masked.includes(concept.term)) continue;
    hits.push(concept);
    masked = masked.split(concept.term).join(' '.repeat(concept.term.length));
  }
  return hits;
}

function internalMarkers(text) {
  const s = normalizeText(text);
  const out = [];
  for (const source of INTERNAL_MARKER_RES) {
    const re = new RegExp(source.source, source.flags);
    let match;
    while ((match = re.exec(s))) {
      out.push(match[0]);
      if (!match[0]) re.lastIndex++;
    }
  }
  return [...new Set(out)];
}

// Hard invariant: these tokens must have the same multiset in source and candidate.
function protectedTokens(text) {
  const s = normalizeText(text);
  const re = /\bM-[A-Za-z]+-\d+\b|\bCP-(?:[A-Za-z]+-)?\d+\b|\bN\d+\b|\bS\d+(?:\.\d+)?\b|\bB0\b|\bQ[1-4]\b|\bLv[0-6]\b|\bPhase\s*(?:I{1,3}|[1-3])\b|\d+\s*[:：]\s*\d+|\d+(?:\.\d+)?\s*[%％]?/gi;
  return (s.match(re) || []).map(token => token.replace(/\s+/g, '').toLowerCase()).sort();
}

function pushIssue(issues, code, message, detail) {
  if (issues.some(issue => issue.code === code && issue.message === message)) return;
  issues.push({ code, message, ...(detail === undefined ? {} : { detail }) });
}

// Mechanical-only gate. Do not add contextual semantic heuristics here.
function inspectPlainText(original, plain, options) {
  options = options || {};
  const profile = options.profile || PROFILE_BODY;
  if (![PROFILE_BODY, PROFILE_GUIDE].includes(profile)) throw new Error('未知 PLAIN profile: ' + profile);
  const src = normalizeText(original);
  const out = normalizeText(plain);
  const issues = [];
  if (!out && src) pushIssue(issues, 'empty', '白话文本为空');
  const sourceTokens = protectedTokens(src);
  const outputTokens = protectedTokens(out);
  if (JSON.stringify(sourceTokens) !== JSON.stringify(outputTokens)) {
    pushIssue(issues, 'protected-token-drift', '数字、比分、轮次或内部 ID 与原文不一致', {
      source: sourceTokens,
      output: outputTokens
    });
  }
  return {
    ok: issues.length === 0,
    issues,
    metrics: {
      concepts: conceptMatches(out).length,
      internalMarkers: internalMarkers(out).length,
      hardIssueCount: issues.length
    }
  };
}

function inspectGuideCard(originalCard, plainCard, options) {
  const issues = [];
  const metrics = {};
  for (const field of ['what', 'why', 'conclusion']) {
    const result = inspectPlainText(originalCard && originalCard[field], plainCard && plainCard[field], {
      ...(options || {}),
      profile: PROFILE_GUIDE
    });
    metrics[field] = result.metrics;
    for (const issue of result.issues) issues.push({ field, ...issue });
  }
  return { ok: issues.length === 0, issues, metrics };
}

// Generator/reviewer cognition hints only. They are not fixed output obligations.
function requirementsForUnits(units, options) {
  const profile = options && options.profile || PROFILE_BODY;
  const rows = [];
  for (const unit of units || []) {
    const requirements = conceptMatches(unit && unit.text).map(concept => ({
      term: concept.term,
      explanation: concept.explanation,
      mode: 'glossary-hint'
    }));
    if (requirements.length) rows.push({
      unitId: unit.id,
      module: unit.module || null,
      profile,
      requirements
    });
  }
  return rows;
}

// Compatibility seam for legacy callers. Live PLAIN must never mechanically inject
// reader-visible glossary parentheses; the glossary is advisory context only.
function applyControlledConceptGlosses(_original, plain) {
  return { text: String(plain == null ? '' : plain), changed: [] };
}

function glossaryObject(glossary) {
  if (!glossary || typeof glossary !== 'object') return CORE_GLOSSARY;
  return glossary;
}

function glossaryHintsForText(text, glossary) {
  const source = glossaryObject(glossary);
  return Object.keys(source)
    .filter(term => term && String(text || '').includes(term))
    .sort((a, b) => b.length - a.length)
    .map(term => ({ term, explanation: String(source[term] || '') }));
}

function valueForId(textForId, id) {
  if (typeof textForId === 'function') return String(textForId(id) == null ? '' : textForId(id));
  if (textForId instanceof Map) return String(textForId.get(id) == null ? '' : textForId.get(id));
  if (textForId && typeof textForId === 'object') return String(textForId[id] == null ? '' : textForId[id]);
  return '';
}

function unitContainerKey(unit) {
  const path = Array.isArray(unit && unit.path) ? unit.path : [];
  const parentPath = path.length > 1 ? path.slice(0, -1) : path;
  return [unit && unit.module || '', unit && unit.containerTag || '', JSON.stringify(parentPath)].join('|');
}

function orderedContextRows(units, textForId, glossary, targetIds, haloSize) {
  const list = Array.isArray(units) ? units : [];
  const target = new Set(targetIds && targetIds.length ? targetIds : list.map(unit => unit.id));
  const indices = new Set();
  const halo = Number.isInteger(haloSize) ? Math.max(0, haloSize) : 2;
  for (let i = 0; i < list.length; i++) {
    if (!target.has(list[i].id)) continue;
    for (let j = Math.max(0, i - halo); j <= Math.min(list.length - 1, i + halo); j++) indices.add(j);
    const key = unitContainerKey(list[i]);
    for (let j = 0; j < list.length; j++) if (unitContainerKey(list[j]) === key) indices.add(j);
  }
  // Full-document review is intentionally the complete ordered sequence.
  if (target.size === list.length && list.every(unit => target.has(unit.id))) {
    for (let i = 0; i < list.length; i++) indices.add(i);
  }
  return [...indices].sort((a, b) => a - b).map(index => {
    const unit = list[index];
    return {
      order: index,
      id: unit.id,
      writable: target.has(unit.id),
      module: unit.module || '',
      blockType: unit.blockType || '',
      containerTag: unit.containerTag || '',
      path: unit.path || [],
      originalText: String(unit.text == null ? '' : unit.text),
      plainText: valueForId(textForId, unit.id),
      glossaryHints: glossaryHintsForText(unit.text, glossary)
    };
  });
}

function targetIdsFromOptions(units, options) {
  const all = (units || []).map(unit => String(unit.id));
  const requested = options && Array.isArray(options.targetIds) ? options.targetIds.map(String) : all;
  const known = new Set(all);
  const unique = [];
  for (const id of requested) if (known.has(id) && !unique.includes(id)) unique.push(id);
  return unique;
}

function buildReadabilityReviewPrompt(units, textForId, glossary, options) {
  options = options || {};
  const targetIds = targetIdsFromOptions(units, options);
  const rows = orderedContextRows(units, textForId, glossary, targetIds, options.haloSize);
  return [
    'PLAIN 独立可理解性复核 · ' + READABILITY_REVIEW_PROMPT_VERSION,
    '你不是生成器，也不是机械正则。请按下面的有序阅读上下文独立判断候选白话。',
    '只审 writable=true 的 ID；其它行是只读 context halo，用来理解邻句、同卡、同表格或同容器语义。',
    '必须逐个判断四件事：semanticEquivalent（语义等价）、zeroBackgroundReadable（零背景读者可理解）、naturalReadable（自然人话，不像机器说明书）、noLocatorDependency（忽略内部编号/定位码后仍能理解正文判断）。',
    'N/M/CP/B0/Q/Phase/Lv 等编号可以合法保留为 locator；如果邻文已经解释事件或判断，不要求把每个定位码逐个解释，也不要为了“解释编号”制造重复编号。',
    '不得新增、删除或改变主体、事实、胜负、比分、因果方向、否定、限定、责任、程度与结论强度。',
    'checkedIds 必须恰好覆盖 targetIds，每个 ID 一次；漏审、额外 ID、重复 ID 都视为失败。',
    '若存在问题，approved=false，并在 issues 中逐项给出 {id,codes,message}；codes 只能从 semanticEquivalent/zeroBackgroundReadable/naturalReadable/noLocatorDependency 中选择。',
    '若全部通过，approved=true 且 issues=[]。只输出严格 JSON。',
    'targetIds=' + JSON.stringify(targetIds),
    'orderedReadingSequence=' + JSON.stringify(rows, null, 2),
    '输出格式={"approved":true,"checkedIds":["..."],"issues":[]}'
  ].join('\n\n');
}

function validateReadabilityReview(review, expectedIds) {
  const errors = [];
  const expected = (expectedIds || []).map(String);
  if (!review || typeof review !== 'object' || Array.isArray(review)) {
    return { ok: false, errors: ['review 必须为对象'] };
  }
  const checked = Array.isArray(review.checkedIds) ? review.checkedIds.map(String) : [];
  if (checked.length !== new Set(checked).size) errors.push('checkedIds 含重复 ID');
  const expectedSet = new Set(expected);
  const checkedSet = new Set(checked);
  const missing = expected.filter(id => !checkedSet.has(id));
  const extra = checked.filter(id => !expectedSet.has(id));
  if (missing.length) errors.push('checkedIds 缺失: ' + missing.join(','));
  if (extra.length) errors.push('checkedIds 含额外 ID: ' + extra.join(','));
  if (checked.length !== expected.length) errors.push('checkedIds 数量必须与预期完全一致');
  const issues = Array.isArray(review.issues) ? review.issues : null;
  if (!issues) errors.push('issues 必须为数组');
  const validCodes = new Set(['semanticEquivalent', 'zeroBackgroundReadable', 'naturalReadable', 'noLocatorDependency']);
  if (issues) {
    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i];
      if (!issue || !expectedSet.has(String(issue.id || ''))) errors.push('issues[' + i + '].id 不在本次审查范围');
      if (!Array.isArray(issue && issue.codes) || !issue.codes.length || issue.codes.some(code => !validCodes.has(String(code)))) {
        errors.push('issues[' + i + '].codes 非法');
      }
      if (typeof (issue && issue.message) !== 'string' || !issue.message.trim()) errors.push('issues[' + i + '].message 不能为空');
    }
  }
  if (review.approved !== true && review.approved !== false) errors.push('approved 必须为布尔值');
  if (review.approved === true && issues && issues.length) errors.push('approved=true 时 issues 必须为空');
  if (review.approved === false && issues && !issues.length) errors.push('approved=false 时必须给出可定位 issue');
  return { ok: errors.length === 0 && review.approved === true, valid: errors.length === 0, errors };
}

function failedReviewIds(review, expectedIds) {
  const allowed = new Set((expectedIds || []).map(String));
  const out = [];
  for (const issue of review && Array.isArray(review.issues) ? review.issues : []) {
    const id = String(issue && issue.id || '');
    if (allowed.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

function buildReadabilityRepairPrompt(units, textForId, review, glossary, options) {
  options = options || {};
  const allIds = (units || []).map(unit => String(unit.id));
  const targetIds = options.targetIds && options.targetIds.length
    ? options.targetIds.map(String)
    : failedReviewIds(review, allIds);
  const rows = orderedContextRows(units, textForId, glossary, targetIds, options.haloSize);
  const issueRows = (review && Array.isArray(review.issues) ? review.issues : []).filter(issue => targetIds.includes(String(issue && issue.id || '')));
  return [
    'PLAIN 定点语义修复 · ' + READABILITY_REPAIR_PROMPT_VERSION,
    '只允许改 writable=true 的失败 ID；read-only context halo 仅供理解邻句、同卡、同表格或同容器上下文，禁止输出或改写它们。',
    '已通过的其它单元会由执行器 byte-identical 冻结。不要把语义搬到邻句，也不要把 locator 改写成机器说明书。',
    '保留所有主体、事实、胜负、数字、比分、ID、因果方向、否定、限定、责任、程度与结论强度。',
    'glossaryHints 只帮助理解概念；可以用自然等价解释，不要求逐字括号模板。',
    '输出必须且只能是 {"units":[{"id":"...","text":"..."}]}，ID 集合必须恰好等于 targetIds。',
    'targetIds=' + JSON.stringify(targetIds),
    'reviewIssues=' + JSON.stringify(issueRows, null, 2),
    'orderedContextHalo=' + JSON.stringify(rows, null, 2)
  ].join('\n\n');
}

function buildPromptContract(options) {
  const profile = options && options.profile || PROFILE_BODY;
  const audience = profile === PROFILE_GUIDE ? '零背景章节导览' : '专业正文白话';
  return [
    'PLAIN 生成合同（' + audience + '）：不是同义词替换，也不是删减。',
    '术语表只是认知提示：可以保留术语并用自然语言解释，也可以在语义不变时直接改成自然等价表达；禁止为了满足模板机械塞“术语（固定释义）”。',
    '内部 ID/编号按原文逐字、逐次数保留；它们可以只是 locator。不要为了说明 locator 再复述同一个编号，也不要要求每个编号都单独解释。',
    '目标是让零背景读者从上下文直接理解事件、比较和推理；可以补出原文已经蕴含的理解台阶，但不得新增理由或事实。',
    '任何主体、事实、胜负、数字、比分、因果方向、否定、条件、责任、程度与结论强度必须保持不变。',
    '输出只负责候选 draft；最终 zeroBackgroundReadable/naturalReadable/noLocatorDependency/semanticEquivalent 由独立 reviewer 判定。'
  ].join('\n');
}

module.exports = {
  PROFILE_BODY,
  PROFILE_GUIDE,
  READABILITY_REVIEW_PROMPT_VERSION,
  READABILITY_REPAIR_PROMPT_VERSION,
  CONCEPTS,
  conceptMatches,
  internalMarkers,
  protectedTokens,
  inspectPlainText,
  inspectGuideCard,
  requirementsForUnits,
  applyControlledConceptGlosses,
  buildPromptContract,
  buildReadabilityReviewPrompt,
  validateReadabilityReview,
  failedReviewIds,
  buildReadabilityRepairPrompt
};
