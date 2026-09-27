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
const READABILITY_REVIEW_PROMPT_VERSION = 'plain-readability-review-v2';
const READABILITY_REPAIR_PROMPT_VERSION = 'plain-readability-repair-v2';
const READABILITY_HARD_REPAIR_PROMPT_VERSION = 'plain-readability-hard-repair-v1';

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

// Mechanical hard invariant: protect machine-provable fact/reference identities,
// not the incidental spelling of a digit. Equivalent representations such as
// 第2轮/第二轮 or 4:6/4比6 normalize to one identity. Framework labels such as
// Lv4/Q1/Phase II remain semantic concepts and are deliberately masked from the
// generic-number channel.
const FACT_CN_DIGITS = { '零':0, '〇':0, '一':1, '二':2, '两':2, '三':3, '四':4, '五':5, '六':6, '七':7, '八':8, '九':9 };
const FACT_CN_UNITS = { '十':10, '百':100, '千':1000, '万':10000 };

function parseFactNumber(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (/^[+-]?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (!value || !/^[零〇一二两三四五六七八九十百千万]+$/.test(value)) return null;
  let total = 0, current = 0;
  for (const ch of value) {
    if (Object.prototype.hasOwnProperty.call(FACT_CN_DIGITS, ch)) {
      current = FACT_CN_DIGITS[ch];
      continue;
    }
    const unit = FACT_CN_UNITS[ch];
    if (!unit) return null;
    if (unit === 10000) {
      total = (total + current || 1) * unit;
      current = 0;
    } else {
      total += (current || 1) * unit;
      current = 0;
    }
  }
  return total + current;
}

function factIdentities(text) {
  const source = normalizeText(text);
  const occupied = new Array(source.length).fill(false);
  const atoms = [];
  const mark = (start, end, atom) => {
    for (let i = start; i < end; i++) if (occupied[i]) return false;
    for (let i = start; i < end; i++) occupied[i] = true;
    if (atom) atoms.push(atom);
    return true;
  };
  const scan = (re, makeAtom) => {
    let m;
    while ((m = re.exec(source)) !== null) {
      mark(m.index, re.lastIndex, makeAtom ? makeAtom(m) : null);
      if (!m[0]) re.lastIndex++;
    }
  };
  const NUM = '[+-]?(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百千万]+)';

  scan(/\bM-[A-Za-z]+-\d+\b|\bCP-(?:[A-Za-z]+-)?\d+\b|\bN\d+\b|\bS\d+(?:\.\d+)?\b/gi,
    m => 'locator:' + m[0].replace(/\s+/g, '').toLowerCase());
  scan(new RegExp('(' + NUM + ')\\s*(?:比|:|：)\\s*(' + NUM + ')', 'g'), m => {
    const a = parseFactNumber(m[1]), b = parseFactNumber(m[2]);
    return a == null || b == null ? null : 'score:' + a + ':' + b;
  });
  scan(new RegExp('(' + NUM + ')\\s*[%％]', 'g'), m => {
    const n = parseFactNumber(m[1]);
    return n == null ? null : 'percent:' + n;
  });
  scan(new RegExp('第\\s*(' + NUM + ')\\s*轮', 'g'), m => {
    const n = parseFactNumber(m[1]);
    return n == null ? null : 'round:' + n;
  });
  scan(new RegExp('(' + NUM + ')\\s*(位|人|名|次|轮|分|票)', 'g'), m => {
    const n = parseFactNumber(m[1]);
    if (n == null) return null;
    const cat = ({位:'person',人:'person',名:'person',次:'occurrence',轮:'round',分:'score_value',票:'vote'})[m[2]];
    return 'count:' + cat + ':' + n;
  });
  scan(new RegExp('(?:第\\s*)?(' + NUM + ')\\s*类', 'g'), m => {
    const n = parseFactNumber(m[1]);
    return n == null ? null : 'class:' + n;
  });

  // Semantic framework labels are intentionally excluded from the hard fact channel.
  scan(/\bLv[0-6]\b/gi, null);
  scan(new RegExp('第\\s*(' + NUM + ')\\s*级', 'g'), null);
  scan(/\bQ[1-4]\b/gi, null);
  scan(new RegExp('第\\s*(' + NUM + ')\\s*象限', 'g'), null);
  scan(/\bPhase\s*(?:I{1,3}|[1-3])\b/gi, null);
  scan(new RegExp('第\\s*(' + NUM + ')\\s*阶段', 'g'), null);

  let residual = '';
  for (let i = 0; i < source.length; i++) residual += occupied[i] ? ' ' : source[i];
  const generic = /(?<![A-Za-z0-9])[+-]?\d+(?:\.\d+)?(?![A-Za-z0-9])/g;
  let gm;
  while ((gm = generic.exec(residual)) !== null) atoms.push('number:' + Number(gm[0]));

  return [...new Set(atoms.filter(Boolean))].sort();
}

function protectedTokens(text) {
  return factIdentities(text);
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
    pushIssue(issues, 'protected-token-drift', '数字、比分或证据定位 ID 的身份集合与原文不一致', {
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
      mode: 'semantic-context-hint'
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
  let masked = String(text || '');
  const hints = [];
  const terms = Object.keys(source)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length || a.localeCompare(b, 'zh-CN'));
  for (const term of terms) {
    if (!masked.includes(term)) continue;
    hints.push({ term, explanation: String(source[term] || '') });
    masked = masked.split(term).join(' '.repeat(term.length));
  }
  return hints;
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
    '这里的“零背景读者”指具备普通中文阅读能力，但没有 Debate-Judge、辩论理论或本报告内部方法背景的人。不得假设读者查过术语表、看过前一章或理解任何内部框架名。',
    'glossaryHints 只是帮助你理解原文中某些内部概念的候选语义，不是答案键、标准译文或字符串匹配规则。必须先结合 originalText、上下文和本场具体论证判断该词此处究竟在做什么。',
    '不得因为候选没有复现词典措辞、没有使用固定括号模板、或把术语自然改写成等价表达就判失败；真正要判断的是忽略术语标签后，读者是否仍能理解这个概念在本场具体指什么、如何参与比较或推理。',
    'zeroBackgroundReadable=true 只有在当前有序上下文中，读者能够直接说清：①具体发生了什么、哪项主张/比较正在被讨论；②这件事为什么会影响论证或裁决；③当前结论怎样由前述事实、比较或回应推出。三项可由同一 context halo 分担，不要求每个单元机械重复。',
    '以下任一情况都必须把 zeroBackgroundReadable 判为 false：只做同义词换词；用一个内部概念解释另一个内部概念；只说“重要/有影响/收束/完成”却不说明具体关系；多个陌生概念高密度堆叠而没有阅读顺序；必须先懂前章、术语表或编号体系才能理解。',
    'N/M/CP/S 等证据定位编号可以合法保留为 locator；如果邻文已经解释事件或判断，不要求逐个解释。B0/B\'/B\'\'/SC/Phase/Q/Lv/场C 等框架标签属于语义概念，不是必须逐字逐次数保留的证据 ID：可以自然解释、复述、改写或在不影响理解时省略标签本身。标签是否变化不是独立失败理由，只有其所指概念、阶段关系、论证作用或事实发生实质变化才应判 semanticEquivalent=false。',
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
    '若 reviewIssues 含 zeroBackgroundReadable / naturalReadable / noLocatorDependency，修复目标不是简单换词：要在当前 writable 单元及只读 halo 的既有语义边界内，把“发生/主张/比较了什么 → 为什么产生影响 → 当前判断怎样得出”补成普通读者可顺读的自然语言；不要依赖前章定义，不要用另一个内部术语解释术语。',
    '如果一句同时堆叠多个陌生概念，可在同一 writable 单元拆成 2—3 句，先说具体事实/比较，再说影响，最后说结论；不得把语义搬到只读邻句。',
    'glossaryHints 只提供该概念可能的语义方向，不是标准答案。先结合 originalText 与当前 halo 判断它在本场的实际作用；需要解释时用自然、上下文化的说法即可，也可以在语义不变时不用原术语。禁止为了过门机械复刻词典措辞或固定括号模板。',
    '输出必须且只能是 {"units":[{"id":"...","text":"..."}]}，ID 集合必须恰好等于 targetIds。',
    'targetIds=' + JSON.stringify(targetIds),
    'reviewIssues=' + JSON.stringify(issueRows, null, 2),
    'orderedContextHalo=' + JSON.stringify(rows, null, 2)
  ].join('\n\n');
}

function buildReadabilityHardRepairPrompt(units, textForId, glossary, options) {
  options = options || {};
  const allIds = (units || []).map(unit => String(unit.id));
  const targetIds = (options.targetIds || []).map(String).filter(id => allIds.includes(id));
  const rows = orderedContextRows(units, textForId, glossary, targetIds, options.haloSize);
  const mechanicalIssues = Array.isArray(options.mechanicalIssues) ? options.mechanicalIssues : [];
  return [
    'PLAIN 机械硬不变量定点纠错 · ' + READABILITY_HARD_REPAIR_PROMPT_VERSION,
    '上一轮语义修复已经完成，但候选文本被机械硬门拒绝。你不是重新做语义判断，只修复下面列出的机器可证明违规；其余措辞尽量保持。',
    '只允许改 writable=true 的 targetIds；read-only context halo 禁止输出或改写。',
    '所有机械受保护 identity（明确数字、比分，以及 N/M/CP/S 等证据定位 ID）必须与 originalText 的身份集合一致：不得引入新值、删除原值或替换成别的值；为自然解释重复同一个已存在值本身不构成机械错误。B0/B\'/B\'\'/SC/Phase/Q/Lv/场C 等语义框架标签不属于本机械 identity 范围。',
    '对 N/M/CP/S 等证据定位 ID 或数字事实，可以自然复述同一个已存在 identity，但不得改号、改值或新造 identity；如果重复会显得啰嗦，可用“该编号”“这一证据点”“这个数值”等自然指代。对 B0/B\'/Phase 等语义概念标签，则按上下文选择最自然且语义准确的表达。',
    '不得为了通过机械门而删掉事实、主体、结论、否定、限定、因果、责任、程度，也不得撤销上一轮为零背景可读性补出的已有语义台阶。',
    '输出必须且只能是 {"units":[{"id":"...","text":"..."}]}，ID 集合必须恰好等于 targetIds。',
    'targetIds=' + JSON.stringify(targetIds),
    'mechanicalIssues=' + JSON.stringify(mechanicalIssues, null, 2),
    'orderedContextHalo=' + JSON.stringify(rows, null, 2)
  ].join('\n\n');
}

function buildPromptContract(options) {
  const profile = options && options.profile || PROFILE_BODY;
  const audience = profile === PROFILE_GUIDE ? '零背景章节导览' : '正文白话（零背景可读，允许保留必要专业术语）';
  return [
    'PLAIN 生成合同（' + audience + '）：不是同义词替换，也不是删减。',
    '目标读者具备普通中文阅读能力，但没有 Debate-Judge、辩论理论或本报告内部方法背景；不得假设读者会查术语表、记得前一章定义或理解内部框架名。',
    '术语表只是认知提示，不是翻译表或答案键。必须先根据原文、邻接上下文和本场论证理解术语此处的实际语义，再决定保留术语、自然解释、改写成等价表达，或在上下文已足够清楚时不额外解释。禁止逐条照抄词典，也禁止为了满足模板机械塞“术语（固定释义）”。',
    '当某个专业术语在当前阅读上下文中承担关键理解作用、且零背景读者仅凭现有上下文仍无法理解时，应自然说明“它在本场具体指什么、做了什么或比较了什么”；不以“首次出现”或是否复现词典措辞作为机械判据。',
    'N/M/CP/S 等证据定位 ID 按原文逐字、逐次数保留，它们可以只是 locator，不要求逐个解释。B0/B\'/B\'\'/SC/Phase/Q/Lv/场C 等框架标签是需要理解的语义概念，不要求逐字或逐次数保留；可在语义不变时自然解释、复述、改写或省略标签本身。',
    '目标是让零背景读者从上下文直接理解“发生/主张/比较了什么 → 为什么影响论证或裁决 → 为什么能推出当前结论”；可以补出原文已经蕴含的理解台阶，但不得新增理由或事实。',
    '若原句同时堆叠多个陌生概念或跨越多个推理台阶，允许在同一文本单元内拆成 2—3 句短句，按事实/比较 → 影响 → 结论的顺序展开；不得跨单元搬运语义或改变 DOM 归属。',
    '任何主体、事实、胜负、数字、比分、因果方向、否定、条件、责任、程度与结论强度必须保持不变。',
    '输出只负责候选 draft；最终 zeroBackgroundReadable/naturalReadable/noLocatorDependency/semanticEquivalent 由独立 reviewer 判定。'
  ].join('\n');
}

module.exports = {
  PROFILE_BODY,
  PROFILE_GUIDE,
  READABILITY_REVIEW_PROMPT_VERSION,
  READABILITY_REPAIR_PROMPT_VERSION,
  READABILITY_HARD_REPAIR_PROMPT_VERSION,
  CONCEPTS,
  conceptMatches,
  internalMarkers,
  parseFactNumber,
  factIdentities,
  protectedTokens,
  inspectPlainText,
  inspectGuideCard,
  requirementsForUnits,
  applyControlledConceptGlosses,
  buildPromptContract,
  buildReadabilityReviewPrompt,
  validateReadabilityReview,
  failedReviewIds,
  buildReadabilityRepairPrompt,
  buildReadabilityHardRepairPrompt
};
