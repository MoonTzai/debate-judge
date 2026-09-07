// R8 ReaderGuide：独立读者导览的深 module。
// 输入/输出 JSON 是唯一公开 seam；调用方不处理章节、来源、事实 token、提示或缓存细节。
'use strict';
const crypto = require('crypto');
const readerGuideSchema = require('../schemas/reader-guide.schema.json');

const SCHEMA_VERSION = 'r8-reader-guide-v2';
const PROMPT_VERSION = 'r8-reader-guide-prompt-v2';
const PLAIN_SCHEMA_VERSION = 'r8-reader-guide-plain-v1';
const PLAIN_PROMPT_VERSION = 'r8-reader-guide-plain-prompt-v3';
const SECTION_IDS = Array.from({ length: 12 }, (_, i) => 'C' + (i + 1));
const GUIDE_OUTPUT_SCHEMA = readerGuideSchema.definitions.readerGuide;

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
  return JSON.stringify(value);
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function hashGuideInput(input) {
  return hashText(stableJson(input));
}

function hashPlainGuideSource(guide) {
  return hashText(stableJson(guide));
}

const DATA_PREFIXES = {
  C1: ['S1.', 'S15.'], C2: ['S2.', 'S11.'], C3: ['S3.', 'S7.'], C4: ['S4.'],
  C5: ['S5.'], C6: ['S6.'], C7: ['S7.', 'S8.'], C8: ['R2.5.', 'C8.'],
  C9: ['S9.'], C10: ['S10.'], C11: ['S11.', 'S12.'], C12: ['S13.', 'S14.', 'S15.']
};
// C11 的逐人点评可直接引用双方人数，但只开放四项人数见证，不把 S1/S13 其它事实扩入该章。
const DATA_EXACT_KEYS = {
  C11: ['S1.正方人数', 'S1.反方人数', 'S13.正方人数', 'S13.反方人数']
};

function moduleText(module) {
  const parts = [module && module.xp, module && module.pre, module && module.prose]
    .concat(module && module.slots ? Object.keys(module.slots).sort().map(k => module.slots[k]) : [])
    .map(x => String(x || '').trim()).filter(Boolean);
  return Array.from(new Set(parts)).join('\n\n');
}

function tableCells(line) {
  return String(line || '').trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
}

// R8 只能使用已裁决数据中「关键CP逐回合轨迹」的辩词引用；这里不读取模型自由生成的文字。
function parseSpeechAnchors(adjudicatedData) {
  const lines = String(adjudicatedData || '').split(/\r?\n/);
  const cpContexts = new Map();
  const criticalHeader = lines.findIndex(line => {
    const cells = tableCells(line);
    return cells.length >= 9 && cells[1] === 'CP-ID' && cells[2] === '交锋点' && cells.includes('裁决理由(≤100字)');
  });
  if (criticalHeader >= 0) {
    for (let i = criticalHeader + 2; i < lines.length; i++) {
      const line = lines[i];
      if (!/^\s*\|/.test(line)) break;
      const cells = tableCells(line);
      if (!/^CP-\d+$/.test(cells[1] || '')) continue;
      // 交锋点、架构层、裁决理由和 SC 角色均来自同一已裁决表，只供确定性章节映射排序。
      cpContexts.set(cells[1], [cells[2], cells[3], cells[8], cells[9]].filter(Boolean).join('；'));
    }
  }
  const header = lines.findIndex(line => {
    const cells = tableCells(line);
    return cells.length >= 6 && cells[0] === 'CP-ID' && cells[1] === '回合' && cells[2] === '发言方' && cells[5] === '辩词引用';
  });
  if (header < 0) return [];
  const anchors = [];
  for (let i = header + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*\|/.test(line)) break;
    const cells = tableCells(line);
    const cpId = cells[0];
    const round = cells[1];
    const speaker = cells[2];
    const action = cells[3];
    const quote = String(cells[5] || '').replace(/^[“"']|[”"']$/g, '').trim();
    if (!/^CP-\d+$/.test(cpId) || !round || !speaker || !action || !quote) continue;
    const stage = (/^\d+$/.test(round) ? '第' + round + '回合' : round) + '·' + action;
    anchors.push({
      id: 'SPEECH:' + cpId + ':' + round,
      text: (cpContexts.has(cpId) ? '交锋标签：' + cpContexts.get(cpId) + '\n' : '') + speaker + '（' + stage + '）：“' + quote + '”',
      anchor: { speaker, stage, quote }
    });
  }
  return anchors;
}

// 各章节只可见与其裁决功能相关的关键 CP。优先从相应的已裁决 DATA
// 中读取 CP 引用；没有显式引用时才按关键 CP 轨迹的稳定顺序回退。C6
// （关键交锋总览）与 C11（辩手逐人点评）天然需要横览全部关键 CP。
const SPEECH_REFERENCE_PREFIXES = {
  C1: ['S8.', 'S7.'], C2: ['S8.', 'S7.'], C3: ['S7.'], C4: ['S7.'],
  C5: ['S8.', 'S7.'], C6: ['S7.'], C7: ['S8.', 'S7.'], C8: ['S8.', 'S7.'],
  C9: ['S7.'], C10: ['S8.', 'S7.'], C11: ['S7.'], C12: ['S8.', 'S7.']
};
const SPEECH_FALLBACK_INDEX = {
  C1: 1, C2: 1, C3: 0, C4: 0, C5: 1, C6: 0,
  C7: 1, C8: 1, C9: 0, C10: 1, C11: 0, C12: 1
};
const SPEECH_OVERVIEW_SECTIONS = new Set(['C6', 'C11']);
const SPEECH_RESPONSE_PAIR_SECTIONS = new Set(['C3', 'C7']);

function cpIdOf(source) {
  const match = String(source && source.id || '').match(/^SPEECH:(CP-\d+):/);
  return match && match[1];
}

function cpIdsIn(text) {
  return Array.from(new Set(String(text || '').match(/CP-\d+/g) || []));
}

function orderedSpeechGroups(speechSources) {
  const groups = new Map();
  for (const source of speechSources || []) {
    const cpId = cpIdOf(source);
    if (!cpId) continue;
    if (!groups.has(cpId)) groups.set(cpId, []);
    groups.get(cpId).push(source);
  }
  return groups;
}

function preferredCpIds(sectionId, normalized) {
  const data = normalized && normalized.data || {};
  const module = normalized && normalized.modules && normalized.modules[sectionId];
  const preferred = cpIdsIn(moduleText(module));
  for (const prefix of SPEECH_REFERENCE_PREFIXES[sectionId] || []) {
    for (const key of Object.keys(data).sort()) {
      // S7.CP入选列表是全场目录，而不是某章的引用；用它会让所有章节都错误偏向首项。
      if (key.startsWith(prefix) && key !== 'S7.CP入选列表') preferred.push.apply(preferred, cpIdsIn(data[key]));
    }
  }
  return Array.from(new Set(preferred));
}

const BIGRAM_STOP_WORDS = new Set(['正方', '反方', '双方', '本场', '交锋', '关键', '是否', '有关', '可以', '不能', '什么', '如何', '以及', '一个', '没有']);

function chineseBigrams(text) {
  const chars = String(text || '').match(/[\u3400-\u9fff]/g) || [];
  const result = new Set();
  for (let i = 0; i + 1 < chars.length; i++) {
    const pair = chars[i] + chars[i + 1];
    if (!BIGRAM_STOP_WORDS.has(pair)) result.add(pair);
  }
  return result;
}

function chapterSpeechContext(sectionId, normalized) {
  const module = normalized && normalized.modules && normalized.modules[sectionId];
  const data = normalized && normalized.data || {};
  const values = [];
  for (const key of Object.keys(data).sort()) {
    if ((DATA_PREFIXES[sectionId] || []).some(prefix => key.startsWith(prefix))) values.push(String(data[key]));
  }
  return moduleText(module) + '\n' + values.join('\n');
}

function strongestLexicalCp(sectionId, normalized, groups, availableCpIds) {
  const target = chineseBigrams(chapterSpeechContext(sectionId, normalized));
  const scores = availableCpIds.map((cpId, index) => {
    const sourceTokens = chineseBigrams((groups.get(cpId) || []).map(source => source.text).join('\n'));
    let score = 0;
    for (const token of sourceTokens) if (target.has(token)) score++;
    return { cpId, index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  return scores.length && scores[0].score > 0 ? scores[0].cpId : null;
}

function hasAttackAndResponse(sources) {
  const stages = (sources || []).map(source => String(source.anchor && source.anchor.stage || ''));
  return stages.some(stage => /·攻击$/.test(stage)) && stages.some(stage => /·回应$/.test(stage));
}

function speechSourcesForSection(sectionId, normalized, speechSources) {
  const groups = orderedSpeechGroups(speechSources);
  const availableCpIds = Array.from(groups.keys());
  if (SPEECH_OVERVIEW_SECTIONS.has(sectionId)) {
    return speechSources.map(source => Object.assign({}, source, { anchor: Object.assign({}, source.anchor, { sectionId }) }));
  }
  const preferred = preferredCpIds(sectionId, normalized).filter(cpId => groups.has(cpId));
  const fallback = SPEECH_FALLBACK_INDEX[sectionId] || 0;
  const referencedCp = preferred.find(cpId => hasAttackAndResponse(groups.get(cpId)));
  const fallbackCp = availableCpIds[fallback];
  const pairedCp = availableCpIds.find(cpId => hasAttackAndResponse(groups.get(cpId)));
  const lexicalCp = strongestLexicalCp(sectionId, normalized, groups, availableCpIds);
  const preferredGroup = referencedCp || lexicalCp || (hasAttackAndResponse(groups.get(fallbackCp)) && fallbackCp)
    || pairedCp || availableCpIds[0];
  const sources = groups.get(preferredGroup) || [];
  // C3/C7 的输入必须是一组同 CP 的攻—回应证据，模型不能从其它章节挪用单句。
  if (SPEECH_RESPONSE_PAIR_SECTIONS.has(sectionId) && !hasAttackAndResponse(sources)) {
    throw new Error('R8 guide-input 缺少 ' + sectionId + ' 的同 CP 攻击/回应辩词锚点');
  }
  // 在输入契约中显式写入章节归属；同一条源文本进入不同章节时须生成各自的受限见证。
  return sources.map(source => Object.assign({}, source, { anchor: Object.assign({}, source.anchor, { sectionId }) }));
}

function sourcesForSection(sectionId, normalized, structure, adjudication, speechSources) {
  const sources = [];
  const module = normalized.modules && normalized.modules[sectionId];
  const text = moduleText(module);
  if (!text) throw new Error('R8 guide-input 缺少 ' + sectionId + ' 的 R6 章节内容');
  sources.push({ id: 'R6:' + sectionId, text });
  const prefixes = DATA_PREFIXES[sectionId] || [];
  const exactKeys = new Set(DATA_EXACT_KEYS[sectionId] || []);
  for (const key of Object.keys(normalized.data || {}).sort()) {
    if (prefixes.some(prefix => key.startsWith(prefix)) || exactKeys.has(key)) sources.push({ id: 'DATA:' + key, text: key + '=' + normalized.data[key] });
  }
  if ((sectionId === 'C3' || sectionId === 'C7') && structure) {
    sources.push({ id: 'STRUCTURE:R4', text: stableJson(structure) });
  }
  if ((sectionId === 'C1' || sectionId === 'C12') && adjudication && typeof adjudication === 'object') {
    sources.push({ id: 'ADJUDICATION:R4.5', text: stableJson(adjudication) });
  }
  return sources.concat(speechSourcesForSection(sectionId, normalized, speechSources));
}

// 外部 interface：只接已构造的 R6 normalized content model 与结构化裁决视图。
function buildGuideInput(normalized, structure, adjudication, adjudicatedData) {
  if (!normalized || typeof normalized !== 'object' || !normalized.modules || !normalized.data) {
    throw new Error('R8 guide-input 需要 R6 normalized content model');
  }
  const speechSources = parseSpeechAnchors(adjudicatedData);
  if (!speechSources.length) throw new Error('R8 guide-input 缺少已裁决的辩词锚点来源');
  return {
    schemaVersion: SCHEMA_VERSION,
    sections: SECTION_IDS.map(sectionId => ({ sectionId, sources: sourcesForSection(sectionId, normalized, structure, adjudication, speechSources) }))
  };
}

function cacheKey(input, modelSnapshot) {
  return hashText(stableJson({ inputHash: hashGuideInput(input), promptVersion: PROMPT_VERSION, modelSnapshot: modelSnapshot || {}, schemaVersion: SCHEMA_VERSION }));
}

function evidenceIds(section) {
  return new Set((section.sources || []).map(s => s.id));
}

function guardTokens(text) {
  const src = String(text || '');
  // token 层只保护原子数字/ID/主体/胜负词；比分的有序关系由 scorePairClaims +
  // factRelationshipErrors 独立硬门负责。这样结构化“正方4/反方6”可以合法见证 4:6，
  // 又不会因要求来源文本逐字出现“4:6”而产生假阴性。
  const matches = src.match(/\d+|(?:N\d+|M-[A-Z0-9-]+|CP-\d+)|(?:正方|反方|获胜|胜方|胜出|胜利|落败|败北)/g) || [];
  return Array.from(new Set(matches.map(x => x.replace(/\s+/g, ''))));
}

const CHINESE_DIGITS = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
const CHINESE_UNITS = { '十': 10, '百': 100, '千': 1000, '万': 10000 };
const SCORE_NUMBER = '(?:\\d+|[零〇一二两三四五六七八九十百千万]+)';
const COUNT_CATEGORY = { '位': 'person', '人': 'person', '名': 'person', '次': 'occurrence', '轮': 'round', '分': 'score', '票': 'vote', '项': 'item', '条': 'item' };

function numericValue(raw) {
  const value = String(raw || '').trim();
  if (/^\d+$/.test(value)) return Number(value);
  let total = 0;
  let current = 0;
  for (const char of value) {
    if (Object.prototype.hasOwnProperty.call(CHINESE_DIGITS, char)) {
      current = CHINESE_DIGITS[char];
      continue;
    }
    const unit = CHINESE_UNITS[char];
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

function scorePairClaims(text) {
  const pairs = [];
  const pattern = new RegExp('(' + SCORE_NUMBER + ')\\s*(?:比|:|：)\\s*(' + SCORE_NUMBER + ')', 'g');
  let match;
  while ((match = pattern.exec(String(text || '')))) {
    const first = numericValue(match[1]);
    const second = numericValue(match[2]);
    if (first != null && second != null) pairs.push({ first, second, start: match.index, end: pattern.lastIndex });
  }
  return pairs;
}

function scorePairs(text) {
  return scorePairClaims(text).map(pair => [pair.first, pair.second]);
}

function subjectScoreClaims(text) {
  const claims = [];
  // 只识别句法上明确声明“某方拥有 X 分”的谓词；
  // “反方以 4:6 获胜”中的 4:6 仍是全局正方:反方比分，不在这里做主体绑定。
  const pattern = new RegExp('(正方|反方)\\s*(?:的\\s*)?(?:得分\\s*(?:为|是|=|:|：)?|得到|拿到|获得)\\s*(' + SCORE_NUMBER + ')\\s*分', 'g');
  let match;
  while ((match = pattern.exec(String(text || '')))) {
    const value = numericValue(match[2]);
    if (value != null) claims.push({ side: match[1], value });
  }
  return claims;
}

function explicitCountClaims(text) {
  const claims = [];
  const pattern = new RegExp('(?:(正方|反方)\\s*|(双方)\\s*各\\s*(?:有\\s*)?)?(第\\s*)?(' + SCORE_NUMBER + ')\\s*(位|人|名|次|轮|分|票|项|条)', 'g');
  let match;
  while ((match = pattern.exec(String(text || '')))) {
    const rawNumber = String(match[4] || '').trim();
    const value = numericValue(rawNumber);
    if (value == null) continue;
    const claim = { value, category: COUNT_CATEGORY[match[5]], ordinal: !!match[3] };
    // 项/条是中文里常见的自然量词；裸中文量词（如“同一条证据链”）不自动升级为
    // 结构化数量事实。阿拉伯数字仍进入此门，并同时继续受 guardTokens 保护。
    if (claim.category === 'item' && !/^\\d+$/.test(rawNumber)) continue;
    if (match[2] && claim.category === 'person') {
      claims.push(Object.assign({ side: '正方' }, claim), Object.assign({ side: '反方' }, claim));
    } else {
      claims.push(Object.assign({ side: claim.category === 'person' ? (match[1] || null) : null }, claim));
    }
  }
  return claims;
}

function sourceCountWitnesses(section, evidence) {
  const selected = new Set(evidence || []);
  const witnesses = [];
  for (const source of section.sources || []) {
    if (!selected.has(source.id)) continue;
    witnesses.push.apply(witnesses, explicitCountClaims(source.text));
    const data = String(source.id).match(/^DATA:(.+)$/);
    if (!data) continue;
    const raw = String(source.text || '').split('=').slice(1).join('=').trim();
    const value = numericValue(raw);
    const field = data[1];
    if (value == null) continue;
    const sideMatch = field.match(/(正方|反方)(?:人数|人员|评委|辩手)/);
    if (/人数|人员|评委|辩手/.test(field)) witnesses.push({ value, category: 'person', ordinal: false, side: sideMatch ? sideMatch[1] : null });
    if (/次数/.test(field)) witnesses.push({ value, category: 'occurrence', ordinal: false });
    if (/轮次/.test(field)) witnesses.push({ value, category: 'round', ordinal: false });
    if (/得分|评分|分数/.test(field)) witnesses.push({ value, category: 'score', ordinal: false });
    if (/票数/.test(field)) witnesses.push({ value, category: 'vote', ordinal: false });
    if (/数量|项目|条目/.test(field)) witnesses.push({ value, category: 'item', ordinal: false });
  }
  return witnesses;
}

function countClaimErrors(sectionId, section, evidence, cardText) {
  const witnesses = sourceCountWitnesses(section, evidence);
  return explicitCountClaims(cardText)
    .filter(claim => !witnesses.some(w => w.value === claim.value && w.category === claim.category && w.ordinal === claim.ordinal && (!claim.side || claim.side === w.side)))
    .map(claim => sectionId + ' 事实声明无来源计数见证: ' + (claim.ordinal ? '第' : '') + claim.value + '/' + claim.category);
}

function outcomeClaims(text) {
  const claims = [];
  const pattern = /([^。！？；\n]{0,32}?)(获胜(?!方)|胜出|胜利|落败|败北)/g;
  let match;
  while ((match = pattern.exec(String(text || '')))) {
    const sides = match[1].match(/正方|反方/g) || [];
    const side = sides[sides.length - 1];
    if (!side) continue;
    const winner = /落败|败北/.test(match[2]) ? (side === '正方' ? '反方' : '正方') : side;
    claims.push({ side, winner });
  }
  const predicate = /(?:获胜方|胜方)\s*(?:为|是|[:：])?\s*(正方|反方)/g;
  while ((match = predicate.exec(String(text || '')))) claims.push({ side: null, winner: match[1] });
  return claims;
}

function factRelationshipErrors(sectionId, section, evidence, cardText) {
  const selected = new Set(evidence || []);
  const facts = { scores: {}, winners: new Set(), pairs: [], subjectScores: [] };
  for (const source of section.sources || []) {
    if (!selected.has(source.id)) continue;
    facts.pairs.push.apply(facts.pairs, scorePairs(source.text));
    facts.subjectScores.push.apply(facts.subjectScores, subjectScoreClaims(source.text));
    for (const claim of outcomeClaims(source.text)) facts.winners.add(claim.winner);
    const match = String(source.id).match(/^DATA:S15\.(正方得分|反方得分|获胜方)$/);
    if (!match) continue;
    const raw = String(source.text || '').split('=').slice(1).join('=').trim();
    if (match[1] === '获胜方') facts.winners.add(raw);
    else facts.scores[match[1].slice(0, 2)] = numericValue(raw);
  }
  const errors = [];
  const pairs = scorePairClaims(cardText);
  const outcomes = outcomeClaims(cardText);
  const subjectScores = subjectScoreClaims(cardText);
  const hasScoreWitness = facts.scores.正方 != null && facts.scores.反方 != null;
  for (const pair of pairs) {
    const structuredPair = hasScoreWitness && pair.first === facts.scores.正方 && pair.second === facts.scores.反方;
    const textPair = facts.pairs.some(witness => witness[0] === pair.first && witness[1] === pair.second);
    if (!structuredPair && !textPair) {
      errors.push(sectionId + ' 事实关系无来源比分见证: ' + pair.first + ':' + pair.second);
    }
  }
  for (const claim of outcomes) {
    if (facts.winners.size !== 1 || !facts.winners.has(claim.winner)) errors.push(sectionId + ' 事实关系与来源胜负不一致');
  }
  for (const claim of subjectScores) {
    const structuredScore = facts.scores[claim.side] != null && claim.value === facts.scores[claim.side];
    const textScore = facts.subjectScores.some(witness => witness.side === claim.side && witness.value === claim.value);
    if (!structuredScore && !textScore) {
      errors.push(sectionId + ' 事实关系与来源主体得分不一致');
    }
  }
  return errors;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// 零依赖执行 reader-guide.schema.json 的本 module 所需子集：对象封闭性、
// required/type/const/min|max|pattern/array-items；章节集合等跨对象约束留给下层校验。
function validateSchemaShape(value, schema, label, errors) {
  if (schema.type === 'object') {
    if (!isPlainObject(value)) { errors.push(label + ' 必须为对象'); return; }
    const properties = schema.properties || {};
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(label + ' 缺少必填字段: ' + key);
    }
    if (schema.additionalProperties === false) {
      const extras = Object.keys(value).filter(key => !Object.prototype.hasOwnProperty.call(properties, key));
      if (extras.length) errors.push(label + ' 存在非契约字段: ' + extras.join(','));
    }
    for (const [key, definition] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) validateSchemaShape(value[key], definition, label + ' ' + key, errors);
    }
    return;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) { errors.push(label + ' 必须为数组'); return; }
    if (schema.minItems != null && value.length < schema.minItems) errors.push(label + ' 少于最小项数');
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(label + ' 超过最大项数');
    for (let i = 0; i < value.length; i++) validateSchemaShape(value[i], schema.items || {}, label + '[' + i + ']', errors);
    return;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') { errors.push(label + ' 必须为字符串'); return; }
    if (schema.minLength != null && value.length < schema.minLength) errors.push(label + ' 长度不足');
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(label + ' 长度超限');
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) errors.push(label + ' 不符合契约模式');
  }
  if (schema.const != null && value !== schema.const) errors.push(label + ' 不符合契约常量');
}

function speechAnchorErrors(sectionId, section, card, evidence) {
  const errors = [];
  const sources = new Map((section.sources || []).map(source => [source.id, source]));
  const anchors = card && Array.isArray(card.anchors) ? card.anchors : [];
  if (!anchors.length) {
    errors.push(sectionId + ' 缺少辩词锚点');
    return errors;
  }
  const used = new Set();
  for (const anchor of anchors) {
    const sourceId = anchor && anchor.sourceId;
    const source = sources.get(sourceId);
    if (!sourceId || !/^SPEECH:/.test(sourceId) || !source || !source.anchor || !evidence.includes(sourceId)) {
      errors.push(sectionId + ' 辩词锚点不存在于该卡已选来源');
      continue;
    }
    if (source.anchor.sectionId !== sectionId) errors.push(sectionId + ' 辩词锚点章节归属不一致: ' + sourceId);
    if (used.has(sourceId)) errors.push(sectionId + ' 辩词锚点重复: ' + sourceId);
    used.add(sourceId);
    for (const field of ['speaker', 'stage', 'quote']) {
      if (!anchor || anchor[field] !== source.anchor[field]) errors.push(sectionId + ' 辩词锚点' + field + '与来源不一致: ' + sourceId);
    }
  }
  if (SPEECH_RESPONSE_PAIR_SECTIONS.has(sectionId)) {
    const pairedSources = anchors.map(anchor => sources.get(anchor && anchor.sourceId)).filter(source => source && source.anchor);
    const cpIds = Array.from(new Set(pairedSources.map(cpIdOf).filter(Boolean)));
    if (anchors.length !== 2 || pairedSources.length !== 2 || cpIds.length !== 1 || !hasAttackAndResponse(pairedSources)) {
      errors.push(sectionId + ' 必须锚定同一 CP 的攻击与回应各一条');
    }
  }
  return errors;
}

function validateGuide(input, guide) {
  const errors = [];
  if (!input || input.schemaVersion !== SCHEMA_VERSION) errors.push('guide-input 契约版本不匹配');
  validateSchemaShape(input, readerGuideSchema.definitions.guideInput, 'guide-input', errors);
  validateSchemaShape(guide, GUIDE_OUTPUT_SCHEMA, 'reader-guide', errors);
  if (!guide || guide.schemaVersion !== SCHEMA_VERSION) errors.push('reader-guide 契约版本不匹配');
  if (!guide || guide.inputHash !== hashGuideInput(input)) errors.push('reader-guide inputHash 不匹配');
  const cards = guide && Array.isArray(guide.cards) ? guide.cards : [];
  const cardIds = cards.map(c => c && c.sectionId);
  if (cardIds.length !== SECTION_IDS.length || new Set(cardIds).size !== SECTION_IDS.length || SECTION_IDS.some(id => !cardIds.includes(id))) {
    errors.push('章节集合必须恰为 C1—C12 且不得重复');
  }
  const sections = new Map((input && input.sections || []).map(s => [s.sectionId, s]));
  for (const card of cards) {
    const section = sections.get(card && card.sectionId);
    if (!section) { errors.push('未知章节: ' + String(card && card.sectionId)); continue; }
    for (const field of ['what', 'why', 'conclusion']) {
      const text = String(card && card[field] || '').trim();
      if (!text || text.length > 240) errors.push(card.sectionId + ' 的 ' + field + ' 必须为 1—240 字');
    }
    const evidence = card && Array.isArray(card.evidence) ? card.evidence : [];
    const allowed = evidenceIds(section);
    if (!evidence.length || evidence.some(id => !allowed.has(id))) errors.push(card.sectionId + ' 存在非输入来源回指');
    errors.push.apply(errors, speechAnchorErrors(card.sectionId, section, card, evidence));
    const corpus = (section.sources || []).filter(s => evidence.includes(s.id)).map(s => String(s.text || '')).join('\n');
    const cardText = ['what', 'why', 'conclusion'].map(k => card && card[k]).join('\n');
    const missingTokens = guardTokens(cardText).filter(token => !corpus.replace(/\s+/g, '').includes(token));
    if (missingTokens.length) errors.push(card.sectionId + ' 含来源外事实 token: ' + missingTokens.join(','));
    // 计数事实门逐字段执行：严格度与整卡扫描相同，但错误必须指出 what/why/conclusion，
    // 这样 R8 白话定点修复能冻结同卡其余已合格字段，而不是把整张卡交给模型重写。
    for (const field of ['what', 'why', 'conclusion']) {
      errors.push.apply(errors, countClaimErrors(card.sectionId + ' ' + field, section, evidence, String(card && card[field] || '')));
    }
    errors.push.apply(errors, factRelationshipErrors(card.sectionId, section, evidence, cardText));
  }
  return { ok: errors.length === 0, errors };
}

function validateReview(input, guide, review) {
  const errors = [];
  if (!review || review.approved !== true) errors.push('R8 独立复核未批准');
  const checks = new Map(((review && review.cardChecks) || []).map(c => [c && c.sectionId, c]));
  for (const id of SECTION_IDS) {
    const c = checks.get(id);
    if (!c || c.noNewJudgment !== true || c.factsConsistent !== true || c.anchorsConsistent !== true) errors.push(id + ' 未通过无新增裁决/事实/锚点一致复核');
  }
  const guideCheck = validateGuide(input, guide);
  if (!guideCheck.ok) errors.push.apply(errors, guideCheck.errors);
  return { ok: errors.length === 0, errors };
}

function validatePlainGuide(input, guide, plainGuide) {
  const errors = [];
  if (!plainGuide || plainGuide.schemaVersion !== PLAIN_SCHEMA_VERSION) errors.push('reader-guide-plain 契约版本不匹配');
  if (!plainGuide || plainGuide.sourceGuideHash !== hashPlainGuideSource(guide)) errors.push('reader-guide-plain sourceGuideHash 不匹配');
  if (!plainGuide || plainGuide.promptVersion !== PLAIN_PROMPT_VERSION) errors.push('reader-guide-plain promptVersion 不匹配');
  if (!plainGuide || !isPlainObject(plainGuide.modelSnapshot)) errors.push('reader-guide-plain modelSnapshot 缺失');
  const cards = plainGuide && Array.isArray(plainGuide.cards) ? plainGuide.cards : [];
  const ids = cards.map(card => card && card.sectionId);
  if (ids.length !== SECTION_IDS.length || new Set(ids).size !== SECTION_IDS.length || SECTION_IDS.some(id => !ids.includes(id))) {
    errors.push('reader-guide-plain 章节集合必须恰为 C1—C12 且不得重复');
  }
  const plainById = new Map(cards.map(card => [card && card.sectionId, card]));
  for (const id of SECTION_IDS) {
    const card = plainById.get(id);
    if (!card) continue;
    const extras = Object.keys(card).filter(key => !['sectionId', 'what', 'why', 'conclusion'].includes(key));
    if (extras.length) errors.push(id + ' 白话卡存在非契约字段: ' + extras.join(','));
    for (const field of ['what', 'why', 'conclusion']) {
      const text = String(card[field] || '').trim();
      if (!text || text.length > 240) errors.push(id + ' 白话 ' + field + ' 必须为 1—240 字');
      if (/[<>]/.test(text)) errors.push(id + ' 白话 ' + field + ' 不得包含 HTML 标记');
    }
  }
  if (guide && Array.isArray(guide.cards) && cards.length === SECTION_IDS.length) {
    const PV2 = require('./plain-comprehension.js');
    const originalById = new Map(guide.cards.map(card => [card && card.sectionId, card]));
    for (const card of cards) {
      const original = originalById.get(card.sectionId);
      if (!original) continue;
      const comprehension = PV2.inspectGuideCard(original, card, { profile: PV2.PROFILE_GUIDE });
      if (!comprehension.ok) {
        errors.push(card.sectionId + ' PLAIN 硬不变量失败: ' + JSON.stringify(comprehension.issues));
      }
    }
    const candidate = JSON.parse(JSON.stringify(guide));
    const byId = new Map(cards.map(card => [card.sectionId, card]));
    for (const card of candidate.cards || []) {
      const plain = byId.get(card.sectionId);
      if (!plain) continue;
      card.what = plain.what;
      card.why = plain.why;
      card.conclusion = plain.conclusion;
    }
    const candidateCheck = validateGuide(input, candidate);
    if (!candidateCheck.ok) errors.push.apply(errors, candidateCheck.errors.map(error => 'reader-guide-plain 事实门: ' + error));
  }
  return { ok: errors.length === 0, errors };
}

function validatePlainGuideReview(input, guide, plainGuide) {
  const errors = [];
  const base = validatePlainGuide(input, guide, plainGuide);
  if (!base.ok) errors.push.apply(errors, base.errors);
  const review = plainGuide && plainGuide.review;
  if (!review || review.approved !== true) errors.push('reader-guide-plain 独立语义复核未批准');
  const checks = new Map(((review && review.cardChecks) || []).map(check => [check && check.sectionId, check]));
  for (const id of SECTION_IDS) {
    const c = checks.get(id);
    if (!c || c.semanticEquivalent !== true || c.noJudgmentChange !== true || c.factsConsistent !== true ||
        c.zeroBackgroundReadable !== true || c.naturalReadable !== true || c.noLocatorDependency !== true) {
      errors.push(id + ' 未通过白话语义等价/裁决不变/事实一致/零背景可读/自然表达/编号非依赖复核');
    }
  }
  return { ok: errors.length === 0, errors };
}

function parseJson(raw, label) {
  const clean = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(clean); }
  catch (e) { throw new Error('R8 ' + label + ' 不是合法 JSON: ' + e.message); }
}

function buildGuidePrompt(input, snapshot) {
  return '你是辩论裁判报告的读者导览助手。仅依据下面不可变的 guide-input 生成 C1—C12 各一张导览卡，不得添加任何事实、数字、主体、胜负、评分、ID 或裁决。每卡只写 what（本章说什么）、why（为什么重要）、conclusion（一句话结论）、evidence（本章 sources 中的 ID 数组）和 anchors（1—2 个具体辩词锚点）。每张卡必须从本章 `SPEECH:` 来源挑选锚点，逐字复制其 sourceId、speaker、stage、quote，且 evidence 必须含相同 sourceId；优先选择最能说明本章具体交锋的引文。数字只能逐字采用已选 evidence 的直接数值，禁止从姓名表计数、禁止把两个数相加；主体和胜负词也须沿用 evidence 原词，禁止同义改写。C3 与 C7 必须恰好选择同一 CP 的一条“攻击”和一条“回应”锚点。每项文本 1—240 个字符；不得输出额外文字。输出 JSON：' +
    '{"schemaVersion":"' + SCHEMA_VERSION + '","inputHash":"' + hashGuideInput(input) + '","promptVersion":"' + PROMPT_VERSION + '","modelSnapshot":' + JSON.stringify(snapshot || {}) + ',"cards":[{"sectionId":"C1","what":"","why":"","conclusion":"","evidence":["R6:C1","SPEECH:CP-1:1"],"anchors":[{"sourceId":"SPEECH:CP-1:1","speaker":"","stage":"","quote":""}]}]}' +
    '\n\nguide-input:\n' + JSON.stringify(input);
}

function guideRepairSectionIds(errors, guide) {
  const out = [];
  const cards = guide && Array.isArray(guide.cards) ? guide.cards : [];
  const add = sectionId => {
    if (SECTION_IDS.includes(sectionId) && !out.includes(sectionId)) out.push(sectionId);
  };
  for (const error of errors || []) {
    const text = String(error || '');
    const direct = text.match(/^(C(?:1[0-2]|[1-9]))\b/);
    if (direct) {
      add(direct[1]);
      continue;
    }
    // JSON-schema 形状门以 cards[n] 报错；必须映射到当前候选该位置真实 sectionId，
    // 不能假定数组永久保持 C1—C12 顺序，否则会修错卡或退化成整包重生。
    const indexed = text.match(/^reader-guide cards\[(\d+)\](?=\s|$)/);
    if (indexed) {
      const card = cards[Number(indexed[1])];
      add(card && card.sectionId);
    }
  }
  return out;
}

function buildGuideRepairPrompt(input, guide, errors, sectionIds) {
  const wanted = Array.isArray(sectionIds) && sectionIds.length ? sectionIds : guideRepairSectionIds(errors, guide);
  const selected = new Set(wanted);
  const sections = (input && input.sections || []).filter(section => selected.has(section.sectionId));
  const currentCards = (guide && guide.cards || []).filter(card => selected.has(card.sectionId));
  return '你是 R8 章节导览定点修复器。上一版 reader-guide 已通过其余章节，只允许重写下面点名的失败卡；未点名章节由执行器冻结并机械保留，你不得输出它们。仍须只依据对应 guide-input sections 的 sources，不得新增事实、数字、主体、胜负、评分、ID 或裁决；数字只能逐字采用本卡 evidence 的直接数值。每卡 anchors 必须严格为 1—2 项，且每项都必须逐字来自该章 SPEECH 来源并同时进入 evidence；C3/C7 必须恰好 2 项，且为同一 CP 的攻击与回应各一条。输出且只输出 JSON：{"cards":[{"sectionId":"C5","what":"","why":"","conclusion":"","evidence":[],"anchors":[]}]}。cards 集合必须恰好等于待修章节，不得多也不得少。' +
    '\n\n机械门错误：\n- ' + (errors || []).join('\n- ') +
    '\n\n待修章节：\n' + JSON.stringify(sections) +
    '\n\n上一版待修卡：\n' + JSON.stringify(currentCards);
}

function buildReviewPrompt(input, guide) {
  return '你是 R8 独立事实复核器。只依据 guide-input 检查 reader-guide：每卡是否没有新增裁决/事实，所有数字、主体、胜负、评分、ID 与结论都可由该卡 evidence 回指；数字必须是已选 evidence 的直接数值（不得数姓名表或相加），主体/胜负词不得同义改写；且 anchors 项逐字等于已选 `SPEECH:` 来源的 sourceId、speaker、stage、quote；C3 与 C7 是否各有同一 CP 的攻击和回应一对锚点。输出且只输出 JSON：' +
    '{"approved":true,"cardChecks":[{"sectionId":"C1","noNewJudgment":true,"factsConsistent":true,"anchorsConsistent":true}]}' +
    '\n\nguide-input:\n' + JSON.stringify(input) + '\n\nreader-guide:\n' + JSON.stringify(guide);
}

function buildPlainGuideReviewPrompt(guide, plainGuide) {
  return '你是 R8 章节导览白话层的独立语义复核器。按 C1—C12 每张卡的完整 what/why/conclusion 上下文比较原 guide 与 plain guide；不要把三个字段拆成彼此无关的孤句。白话只能降低表达门槛，绝不能改变或省略原文中的主体、胜负、因果方向、否定/保留条件、责任归属、程度、数字、评分、ID、判决或任何限定。N/M/CP/B0/Q/Phase/Lv/路径号等内部 ID 必须原样、原次数保留，但它们可以只是 locator：如果同卡或邻句已经把事件/判断说明白，不要求逐个解释 ID；关键是忽略定位码后仍能理解判断，不得把自然文本改造成机器说明书。逐章检查 semanticEquivalent、noJudgmentChange、factsConsistent、zeroBackgroundReadable、naturalReadable、noLocatorDependency 六项。任一实质性压缩、因果替换、否定丢失、判断强化/弱化、黑箱表达或编号依赖都必须 false。输出且只输出 JSON：' +
    '{"approved":true,"cardChecks":[{"sectionId":"C1","semanticEquivalent":true,"noJudgmentChange":true,"factsConsistent":true,"zeroBackgroundReadable":true,"naturalReadable":true,"noLocatorDependency":true}]}' +
    '\n\nreader-guide:\n' + JSON.stringify(guide) + '\n\nreader-guide-plain:\n' + JSON.stringify(plainGuide);
}

function plainGuideReviewFailedSections(review) {
  const checks = new Map(((review && review.cardChecks) || []).map(check => [check && check.sectionId, check]));
  return SECTION_IDS.filter(id => {
    const c = checks.get(id);
    return !c || c.semanticEquivalent !== true || c.noJudgmentChange !== true || c.factsConsistent !== true ||
      c.zeroBackgroundReadable !== true || c.naturalReadable !== true || c.noLocatorDependency !== true;
  });
}

function buildPlainGuideRepairPrompt(guide, plainGuide, review, sectionIds) {
  const wanted = Array.isArray(sectionIds) && sectionIds.length ? sectionIds : plainGuideReviewFailedSections(review);
  const selected = new Set(wanted);
  const originals = (guide && guide.cards || []).filter(card => selected.has(card.sectionId));
  const candidates = (plainGuide && plainGuide.cards || []).filter(card => selected.has(card.sectionId));
  const targetIds = wanted.flatMap(sectionId => ['what','why','conclusion'].map(field => 'R8P:' + sectionId + ':' + field));
  return '你是 R8 白话导览定点语义修复器。只允许修改失败卡；同卡 what/why/conclusion 全部作为语义 context halo 提供，未点名卡被冻结。术语表不是固定括号模板；内部编号可以只是 locator，不要求逐个解释，但忽略编号后仍应能理解事件和判断。必须保持原卡全部事实、主体、胜负、数字、因果、否定、限定、责任、程度与结论强度，且不新增任何事实 token。输出必须且只能是 {"units":[{"id":"R8P:C1:what","text":"..."}]}，并恰好覆盖 targetIds。' +
    '\n\ntargetIds=' + JSON.stringify(targetIds) +
    '\n\nreview=' + JSON.stringify(review) +
    '\n\noriginalCards=' + JSON.stringify(originals) +
    '\n\ncurrentPlainCards=' + JSON.stringify(candidates);
}

module.exports = { SCHEMA_VERSION, PROMPT_VERSION, PLAIN_SCHEMA_VERSION, PLAIN_PROMPT_VERSION, SECTION_IDS, stableJson, hashGuideInput, hashPlainGuideSource, parseSpeechAnchors, buildGuideInput, cacheKey, validateGuide, validateReview, validatePlainGuide, validatePlainGuideReview, parseJson, buildGuidePrompt, guideRepairSectionIds, buildGuideRepairPrompt, buildReviewPrompt, buildPlainGuideReviewPrompt, plainGuideReviewFailedSections, buildPlainGuideRepairPrompt };
