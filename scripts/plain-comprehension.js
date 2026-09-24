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
const READABILITY_REVIEW_PROMPT_VERSION = 'plain-readability-review-v3';
const READABILITY_REPAIR_PROMPT_VERSION = 'plain-readability-repair-v3';

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

// Normalize explicit numeral spellings as review hints, not semantic truth.
function numeralValue(text) {
  const digit = { 零:0, 〇:0, 一:1, 二:2, 两:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9 };
  const unit = { 十:10, 百:100, 千:1000, 万:10000 };
  if (!/[十百千万]/.test(text)) return Number([...text].map(ch => digit[ch]).join(''));
  let value=0, section=0, current=0;
  for (const ch of text) {
    if (digit[ch] !== undefined) current=digit[ch];
    else if (ch === '万') { value += (section + current || 1) * 10000; section=0; current=0; }
    else if (unit[ch]) { section += (current || 1)*unit[ch]; current=0; }
  }
  return value+section+current;
}
function locatorTokens(text) {
  return [...new Set((String(text || '').match(/\bM-[A-Za-z]+-\d+\b|\bCP-(?:[A-Za-z]+-)?\d+\b|\bN\d+\b|\bS\d+(?:\.\d+)?\b|\bB0\b|\bQ[1-4]\b|\bLv[0-6]\b|\bPhase\s*(?:I{1,3}|[1-3])\b/gi) || []).map(x=>x.replace(/\s+/g,'').toLowerCase()))].sort();
}
function protectedTokens(text) {
  const s = normalizeText(text).replace(/[零〇一二两三四五六七八九十百千万]+(?=轮|次|分|票|人|名|个|条|比)/g, numeralValue);
  const numeric = (s.match(/\d+\s*[:：]\s*\d+|\d+(?:\.\d+)?\s*[%％]?/g) || []).map(x=>x.replace(/\s+/g,''));
  return [...new Set(locatorTokens(s).concat(numeric))].sort();
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
  const warnings = [];
  if (!out && src) pushIssue(issues, 'empty', '白话文本为空');
  const sourceTokens = protectedTokens(src);
  const outputTokens = protectedTokens(out);
  const newLocators = locatorTokens(out).filter(id => !locatorTokens(src).includes(id));
  if (newLocators.length) pushIssue(issues, 'protected-token-drift', '白话新增了本单元未引用的对象 ID', newLocators);
  if (JSON.stringify(sourceTokens) !== JSON.stringify(outputTokens)) {
    warnings.push({ code: 'semantic-fact-review', message: '数字或定位表达变化，独立复核其实际含义、主体、否定和范围；词项差异不自动等于事实错误',
      source: sourceTokens, output: outputTokens });
  }
  return {
    ok: issues.length === 0,
    issues,
    warnings,
    requiresSemanticReview: true,
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
  // Same tag/class paths can belong to unrelated paragraphs. No guessed grouping.
  return unit && unit.semanticBlockId || 'unit:' + String(unit && unit.id);
}

function expandSemanticBlockIds(units, ids) {
  const requested = new Set(ids || []);
  const keys = new Set((units || []).filter(u => requested.has(u.id)).map(unitContainerKey));
  return (units || []).filter(u => keys.has(unitContainerKey(u))).map(u => u.id);
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
  const emittedContext = new Set();
  const emittedTables = new Set(), emittedRows = new Set();
  const visibleIds = new Set([...indices].map(index => list[index].id));
  return [...indices].sort((a, b) => a - b).map(index => {
    const unit = list[index];
    const sourceContext = emittedContext.has(unitContainerKey(unit)) ? undefined : unit.readingContext;
    // The ordered sequence already contains original and candidate prose. Refer to
    // it by block/row identity instead of copying full paragraphs several times.
    let readingContext;
    if (sourceContext) {
      readingContext = {
        heading: sourceContext.heading,
        tableId: sourceContext.tableId, rowId: sourceContext.rowId,
        fixedSlots: (sourceContext.slots || []).filter(slot => !visibleIds.has(slot.id)),
        tableHeaders: emittedTables.has(sourceContext.tableId) ? undefined : sourceContext.tableHeaders,
        tableRow: emittedRows.has(sourceContext.rowId) ? undefined : sourceContext.tableRow
      };
      if (sourceContext.tableId) emittedTables.add(sourceContext.tableId);
      if (sourceContext.rowId) emittedRows.add(sourceContext.rowId);
    }
    emittedContext.add(unitContainerKey(unit));
    return {
      order: index,
      id: unit.id,
      writable: target.has(unit.id),
      module: unit.module || '',
      blockType: unit.blockType || '',
      containerTag: unit.containerTag || '',
      path: unit.path || [],
      semanticBlockId: unit.semanticBlockId,
      inlineTags: unit.inlineTags || [],
      readingContext,
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
    '数字、比分顺序、主体、否定、条件、模态和结论范围必须等价；重复 locator 可省略，不能省略实际推理。机械检查通过不证明事实无变化。',
    '同一 semanticBlockId 的片段要先按顺序连读成完整解释，再判断其中各 ID。ID 是回填坐标，不是独立论断。空片段若其含义已自然保留在同段其它片段，不算丢失；不要要求每片段各自解释全部术语。',
    '设想一位从未学过辩论的读者：他能否从这段及已给出的邻文，理解双方实际在争什么、回应改变了什么、为什么得到这个判断，以及判断还受什么条件限制？只在该段涉及这些内容时检查，不强求每段完成整场复述。仅把术语换成另一术语、贴固定括号或说“完成/有效/有影响”而省略原文已有关系，都不代表可理解。允许原本清楚的文字保持不变；若原文本就不确定或欠解释，须如实保留，不能补造理由。',
    '必须逐个判断四件事：semanticEquivalent（语义等价）、zeroBackgroundReadable（零背景读者可理解）、naturalReadable（自然人话，不像机器说明书）、noLocatorDependency（忽略内部编号/定位码后仍能理解正文判断）。',
    'N/M/CP/B0/Q/Phase/Lv 等编号可以合法保留为 locator；如果邻文已经解释事件或判断，不要求把每个定位码逐个解释，也不要为了“解释编号”制造重复编号。',
    '不得新增、删除或改变主体、事实、胜负、比分、因果方向、否定、限定、责任、程度与结论强度。',
    'checkedIds 必须恰好覆盖 targetIds，每个 ID 一次；漏审、额外 ID、重复 ID 都视为失败。',
    '若存在问题，approved=false，并在 issues 中逐项给出 {id,codes,message}；codes 只能从 semanticEquivalent/zeroBackgroundReadable/naturalReadable/noLocatorDependency 中选择。',
    '若全部通过，approved=true 且 issues=[]。只输出严格 JSON。',
    'targetIds=' + JSON.stringify(targetIds),
    'orderedReadingSequence=' + JSON.stringify(rows),
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
    '只允许改 writable=true 的 ID；它们包含被点名问题的完整真实段落片段。read-only context halo 仅供理解，禁止输出或改写它们。',
    '其它段落由执行器 byte-identical 冻结。同一 semanticBlockId 内可以联合重写、拆句，并在槽位之间自然调整措辞；不能把必要解释搬到只读邻段。text 可为空字符串，但整段意义必须完整，空槽只由程序保留为排版空白；不要输出 HTML。保持加粗/链接等局部片段的自然衔接。',
    '保留所有主体、事实、胜负、数字意义、比分顺序、对象身份、因果方向、否定、限定、责任、程度与结论强度；重复定位码可省，数字允许等价写法。',
    'glossaryHints 只帮助理解概念；可以用自然等价解释，不要求逐字括号模板。',
    '输出必须且只能是 {"units":[{"id":"...","text":"..."}]}，ID 集合必须恰好等于 targetIds。',
    'targetIds=' + JSON.stringify(targetIds),
    'reviewIssues=' + JSON.stringify(issueRows, null, 2),
    'orderedContextHalo=' + JSON.stringify(rows)
  ].join('\n\n');
}

function buildPromptContract(options) {
  const profile = options && options.profile || PROFILE_BODY;
  const audience = profile === PROFILE_GUIDE ? '零背景章节导览' : '面向从未学过辩论的读者的正文解释';
  return [
    'PLAIN 生成合同（' + audience + '）：不是同义词替换，也不是删减。',
    '术语表只是认知提示：可以保留术语并用自然语言解释，也可以在语义不变时直接改成自然等价表达；禁止为了满足模板机械塞“术语（固定释义）”。',
    '内部 ID 保持对象身份，不新增或改号；不承担语义的重复可自然合并，不能把不同对象合并。数字允许等价写法，实际数值、主体和关系不得改变。',
    '目标是让零背景读者从上下文直接理解事件、比较和推理；可以补出原文已经蕴含的理解台阶，但不得新增理由或事实。',
    'semanticBlockId 相同的 units 是一段话因 HTML 排版拆出的回填槽：先理解 readingContext.originalText，再连贯改写并分配到这些槽；不要把每个槽当独立句子。允许拆句、扩写原文已蕴含的理解台阶、在同段槽位间调整措辞，个别 text 可为空，但整段不得丢失信息。不输出 HTML，保留加粗/链接所指对象。没有 semanticBlockId 时按原独立字段处理。',
    'inlineTags 告诉你槽位是否加粗、斜体或链接；保留这些强调/链接所指的内容，不要为省事把整个段落塞进一个强调词或链接槽。它们是排版上下文，不能迫使你保留难懂词序。',
    'readingContext 的 heading/tableHeaders/tableRow/previous/next 仅帮助消解指代和比较对象。不得拿邻段新理由替代本段理由；遇到含糊或证据不足，保留这个限度。先让读者明白实际主张和回应怎样影响结论，而非只解释术语定义；无需生硬套固定问答、表格、长度或句式。',
    '任何主体、事实、胜负、数字、比分、因果方向、否定、条件、责任、程度与结论强度必须保持不变。',
    '输出只负责候选 draft；最终 zeroBackgroundReadable/naturalReadable/noLocatorDependency/semanticEquivalent 由独立 reviewer 判定。'
  ].join('\n');
}

module.exports = {
  unitContainerKey,
  expandSemanticBlockIds,
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
