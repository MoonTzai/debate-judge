// R8 ReaderGuide：独立读者导览的深 module。
// 输入/输出 JSON 是唯一公开 seam；调用方不处理章节、来源、事实 token、提示或缓存细节。
'use strict';
const crypto = require('crypto');
const readerGuideSchema = require('../schemas/reader-guide.schema.json');

const SCHEMA_VERSION = 'r8-reader-guide-v3';
const PROMPT_VERSION = 'r8-reader-guide-prompt-v4';
const PLAIN_SCHEMA_VERSION = 'r8-reader-guide-plain-v1';
const PLAIN_PROMPT_VERSION = 'r8-reader-guide-plain-prompt-v4';
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

// Evidence IDs locate source material; they are not semantic eligibility gates.
// Preserve the entire available evidence pool. Original transcript is shared once
// in guide-input; legacy S7 excerpts remain available only when source is absent.
function speechSourcesForSection(sectionId, normalized, speechSources) {
  return (speechSources || []).map(source => Object.assign({}, source, {
    anchor: Object.assign({}, source.anchor, { sectionId })
  }));
}

function originalSpeechSources(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let start = 0;
  const flush = end => {
    const body = lines.slice(start, end).join('\n');
    if (body.trim()) out.push({
      id: 'SPEECH:RAW:L' + (start + 1) + '-L' + end,
      text: body,
      anchor: { speaker: '原文署名', stage: '原文第' + (start + 1) + '—' + end + '行' }
    });
    start = end + 1;
  };
  for (let i = 0; i < lines.length; i++) if (!lines[i].trim()) flush(i);
  flush(lines.length);
  return out;
}

function sectionSources(input, section) {
  const pool = (input && input.sections || []).flatMap(s => s.sources || [])
    .concat(section && section.sources || [], input && input.sharedSources || []);
  const unique = new Map();
  for (const source of pool) {
    if (unique.has(source.id) && unique.get(source.id).text !== source.text)
      throw new Error('R8 同一来源编号对应不同内容: ' + source.id);
    unique.set(source.id, source);
  }
  return [...unique.values()];
}

// Read the product projection, including tables, SVG labels and qualifiers.
// Use the existing HTML parser; paragraph-only extraction loses rendered evidence.
function reportChapters(html) {
  const PL = require('./plain-language.js');
  const RR = require('../render-report.js');
  const root = PL.parseHtml(RR.stripEmbeddedReaderGuide(html).html);
  const found = {};
  function clean(node) {
    if (node.type !== 'element') return node.type === 'comment' ? null : node;
    const cls = PL.attrValue(node, 'class') || '';
    if (['script','style','button'].includes(node.tag) || /\breader-guide\b/.test(cls)) return null;
    // Translation cache attributes are UI state, not chapter evidence. Strip
    // only those two attributes and canonicalize the parser's tag encoding so
    // toggling plain mode does not invalidate unchanged professional content.
    const attrs = (node.attrs || []).filter(a => !['data-orig','data-plain'].includes(a.name));
    const rawOpen = '<' + node.tag + attrs.map(a => ' ' + a.name + (a.value == null ? '' : '="' + String(a.value).replace(/"/g,'&quot;') + '"')).join('') + (/\/\s*>$/.test(node.rawOpen) ? '/>' : '>');
    return Object.assign({}, node, { rawOpen, attrs, children: (node.children || []).map(clean).filter(Boolean) });
  }
  function walk(node) {
    if (node.type === 'element') {
      const id = (PL.attrValue(node,'id') || '').toUpperCase();
      if (SECTION_IDS.includes(id)) {
        if (found[id]) throw new Error('R8 报告章节重复: ' + id);
        found[id] = PL.serializeHtml({ children: [clean(node)] });
      }
    }
    for (const child of node.children || []) walk(child);
  }
  walk(root);
  for (const id of SECTION_IDS) if (!found[id]) throw new Error('R8 最终报告缺少章节: ' + id);
  return found;
}

function buildGuideInput(normalized, structure, adjudication, adjudicatedData, sourceText, reportHtml) {
  if (!normalized || !normalized.modules || !normalized.data) throw new Error('R8 guide-input 需要报告及裁决数据');
  const original = originalSpeechSources(sourceText);
  const speech = original.length ? [] : parseSpeechAnchors(adjudicatedData);
  // Legacy callers may supply a content model. The actual pipeline supplies HTML.
  const chapters = reportHtml == null ? null : reportChapters(reportHtml);
  const shared = original.concat(speech);
  for (const key of Object.keys(normalized.data).sort()) shared.push({id:'DATA:'+key,text:key+'='+normalized.data[key]});
  if (structure) shared.push({id:'STRUCTURE:R4',text:stableJson(structure)});
  if (adjudication) shared.push({id:'ADJUDICATION:R4.5',text:stableJson(adjudication)});
  return {schemaVersion:SCHEMA_VERSION,
    sourceMode:original.length?'original':(speech.length?'analysis-excerpts':'unavailable'),
    reportMode:chapters?'rendered-report':'legacy-content-model', sharedSources:shared,
    sections:SECTION_IDS.map(sectionId => {
      const text = chapters ? chapters[sectionId] : moduleText(normalized.modules[sectionId]);
      if (!text) throw new Error('R8 缺少 '+sectionId+' 章节');
      return {sectionId,sources:[{id:'R6:'+sectionId,text}]};
    })};
}

function cacheKey(input, modelSnapshot) {
  return hashText(stableJson({ inputHash: hashGuideInput(input), promptVersion: PROMPT_VERSION, modelSnapshot: modelSnapshot || {}, schemaVersion: SCHEMA_VERSION }));
}

function evidenceIds(section, input) {
  return new Set(sectionSources(input, section).map(s => s.id));
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
  if (schema.$ref) { const key = schema.$ref.split('/').pop(); return validateSchemaShape(value, readerGuideSchema.definitions[key] || {}, label, errors); }
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

function speechAnchorErrors(sectionId, section, card, evidence, input) {
  const errors = [];
  const sources = new Map(sectionSources(input, section).map(source => [source.id, source]));
  const anchors = card && Array.isArray(card.anchors) ? card.anchors : [];
  if (!anchors.length && !String(card && card.anchorNote || '').trim())
    errors.push(sectionId + ' 未选直接引文时须说明引用范围或缺口');
  const used = new Set();
  for (const anchor of anchors) {
    const source = sources.get(anchor && anchor.sourceId);
    if (!source || !source.anchor || !/^SPEECH:/.test(source.id) || !evidence.includes(source.id)) {
      errors.push(sectionId + ' 辩词锚点不存在于该卡已选来源'); continue;
    }
    if (source.anchor.sectionId && source.anchor.sectionId !== sectionId)
      errors.push(sectionId + ' 辩词锚点章节归属不一致: ' + source.id);
    const identity = source.id + '\n' + anchor.quote;
    if (used.has(identity)) errors.push(sectionId + ' 重复引文: ' + source.id);
    used.add(identity);
    if (anchor.stage !== source.anchor.stage) errors.push(sectionId + ' 辩词位置与来源不一致: ' + source.id);
    if (/^SPEECH:RAW:/.test(source.id)) {
      if (!String(anchor.quote || '').trim() || !String(source.text).includes(anchor.quote))
        errors.push(sectionId + ' 引文不在所指原文片段中: ' + source.id);
      // Speaker attribution is checked against original context by the reviewer.
    } else {
      for (const field of ['speaker', 'quote']) if (anchor[field] !== source.anchor[field])
        errors.push(sectionId + ' 转录锚点' + field + '与来源不一致: ' + source.id);
    }
  }
  return errors;
}

function validateGuide(input, guide) {
  const errors = [];
  const warnings = [];
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
    const allowed = evidenceIds(section, input);
    if (!evidence.length || evidence.some(id => !allowed.has(id))) errors.push(card.sectionId + ' 存在非输入来源回指');
    errors.push.apply(errors, speechAnchorErrors(card.sectionId, section, card, evidence, input));
    const corpus = sectionSources(input, section).filter(s => evidence.includes(s.id)).map(s => String(s.text || '')).join('\n');
    const cardText = ['what', 'why', 'conclusion'].map(k => card && card[k]).join('\n');
    const missingTokens = guardTokens(cardText).filter(token => !corpus.replace(/\s+/g, '').includes(token));
    if (missingTokens.length) warnings.push(card.sectionId + ' 待语义复核的来源词项差异: ' + missingTokens.join(','));
    // 计数事实门逐字段执行：严格度与整卡扫描相同，但错误必须指出 what/why/conclusion，
    // 这样 R8 白话定点修复能冻结同卡其余已合格字段，而不是把整张卡交给模型重写。
    for (const field of ['what', 'why', 'conclusion']) {
      warnings.push.apply(warnings, countClaimErrors(card.sectionId + ' ' + field, { sources: sectionSources(input, section) }, evidence, String(card && card[field] || '')));
    }
    warnings.push.apply(warnings, factRelationshipErrors(card.sectionId, { sources: sectionSources(input, section) }, evidence, cardText));
  }
  return { ok: errors.length === 0, errors, warnings, requiresSemanticReview: true };
}

function validateReview(input, guide, review) {
  const errors = [];
  if (!review || review.approved !== true) errors.push('R8 独立复核未批准');
  // Meaning and materiality belong to the reviewer. The executor only routes its
  // explicit decision; issue wording and issue count cannot choose a repair stage.
  const notes = [], upstreamIssues = [], classificationErrors = [];
  const reviewStages = ['R1','R2','R2.5','R3','R4','R4.5','R5A','R5B','R6'];
  const issues = review && review.semanticIssues;
  if (issues !== undefined && !Array.isArray(issues)) classificationErrors.push('semanticIssues 必须为数组');
  for (const issue of Array.isArray(issues) ? issues : []) {
    const detail = issue && (issue.issue || issue.reason || issue.message);
    if (typeof detail !== 'string' || !detail.trim()) { classificationErrors.push('异议须有自由文字说明'); continue; }
    if (issue.action === 'note') notes.push(issue);
    else if (issue.action === 'upstream_review' && reviewStages.includes(issue.targetRound)) upstreamIssues.push(issue);
    else classificationErrors.push('请对已有异议说明处置：action=note（不影响导览成立的备注），或 upstream_review 并给出 targetRound；由语义判断影响及责任轮，不能仅因有异议自动回到R3');
  }
  errors.push(...classificationErrors);
  if (upstreamIssues.length) errors.push('R8 发现上游语义问题，模型要求回查 '+[...new Set(upstreamIssues.map(i=>i.targetRound))].join('、')+'；保留异议，不在导览改判');
  const checks = new Map(((review && review.cardChecks) || []).map(c => [c && c.sectionId, c]));
  for (const id of SECTION_IDS) {
    const c = checks.get(id);
    if (!c || c.noNewJudgment !== true || c.factsConsistent !== true || c.anchorsConsistent !== true) errors.push(id + ' 未通过无新增裁决/事实/锚点一致复核');
  }
  const guideCheck = validateGuide(input, guide);
  if (!guideCheck.ok) errors.push.apply(errors, guideCheck.errors);
  const reopenNodes = reviewStages.filter(stage=>upstreamIssues.some(issue=>issue.targetRound===stage));
  return { ok: errors.length === 0, errors, notes, upstreamIssues, reopenNodes, needsClarification: classificationErrors.length > 0 };
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

const GUIDE_SEMANTIC_RULES = '解释对象是 R6 当前真实报告章节，包括表格、图示标签和限定；原始辩词是事实真源，DATA/structure/adjudication 是上游判断依据。发现两者冲突提交语义问题，不在导览暗改裁决。每卡 what/why/conclusion 用自然语言说明本章，不必复刻措辞；保留主体、否定、条件、模态、结论范围与数字意义。优先依据 sharedSources 中完整原文，按实质相关性选择来源，可跨 CP 或多段，不要求攻击/回应配对。evidence 可填任意章节 sources 或 sharedSources 的真实 ID；编号只定位，按语义相关性引用。anchors 可按需要选取原文短引，sourceId 和 stage 照录，quote 必须为该 source.text 中连续逐字片段，speaker 按原文署名填写；无法确认时如实写未标注，不猜姓名。无必要直接引文可 anchors=[]，以 anchorNote 说明依据或缺口。sourceMode=analysis-excerpts 时仅有上游转录，须说明未核对原文。所有引文及发言归属由独立复核结合上下文检查。正文数字或胜负同义表达须语义等价，不能机械沿用 token 代替理解。';

function buildGuidePrompt(input, snapshot) {
  return '你是辩论裁判报告的读者导览助手。输出 C1—C12 各一张卡。' + GUIDE_SEMANTIC_RULES +
    '每项正文 1—240 字，长论证仍保留在主报告；只输出 JSON：' +
    '{"schemaVersion":"' + SCHEMA_VERSION + '","inputHash":"' + hashGuideInput(input) + '","promptVersion":"' + PROMPT_VERSION +
    '","modelSnapshot":' + JSON.stringify(snapshot || {}) + ',"cards":[{"sectionId":"C1","what":"","why":"","conclusion":"","evidence":[],"anchors":[],"anchorNote":""}]}' +
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
  return '你是 R8 章节导览定点修复器。只重写点名失败卡，其余卡由执行器冻结。' + GUIDE_SEMANTIC_RULES +
    '只输出 {"cards":[...]}，集合必须恰好等于待修章节；字段保持完整。' +
    '\n\n机械门错误：\n- ' + (errors || []).join('\n- ') +
    '\n\n待修章节：\n' + JSON.stringify((input.sections || []).filter(s => selected.has(s.sectionId))) +
    '\n\n完整只读来源（只重写待修卡）：\n' + JSON.stringify(input) +
    '\n\nsourceMode=' + input.sourceMode +
    '\n\n失败候选：\n' + JSON.stringify((guide.cards || []).filter(c => selected.has(c.sectionId)));
}

function buildReviewPrompt(input, guide) {
  const hints = validateGuide(input, guide).warnings || [];
  return '你是 R8 独立语义与事实复核器，不能以词面差异或机械门通过代替判断。' + GUIDE_SEMANTIC_RULES +
    '结合原文及全章上下文检查三项：noNewJudgment（没有新造/改判/遗漏实质限定），factsConsistent（含比分方向、主体、轮次、否定、条件和引用语境），anchorsConsistent（引文位置、说话者与代表性）。识别反语、假设、转述和否定；同义表述可接受。词项差异列表只帮助定位，可能是假警报。来源不全时不能把待定伪装已证实；发现上游实质问题写入 semanticIssues，指出应回查的原文和阶段，不在导览改判。只输出 JSON，必须逐章覆盖：' +
    '{"approved":true,"cardChecks":[{"sectionId":"C1","noNewJudgment":true,"factsConsistent":true,"anchorsConsistent":true}],"semanticIssues":[]}' +
    '\n异议的影响与责任由你按完整语境判断，不由词项或数量决定。导览自身失真，在对应 cardChecks 标 false 并说明；执行器只修该导览卡。semanticIssues 也可保留不影响当前导览成立的提示，但每项须有 action：note 表示旁列备注，upstream_review 表示实质影响事实、论证、裁决或报告准确性且须修订上游；后者给出最早相关 targetRound（R1/R2/R2.5/R3/R4/R4.5/R5A/R5B/R6），解释影响及来源。不要默认回R3，也不要为继续运行把实质问题降成备注。生成分工、编辑标注或局部工件范围不当然是整份报告的裁决矛盾：理解其实际所指与影响。无法判明时说明具体不确定性及需核对的责任轮，不反复改投赞成票。approved 与 cardChecks 判断导览是否可用，note 可以并存；upstream_review 仍需处理，不能靠 approved=true 消除。自由解释无字数、关键词或固定例句要求。' +
    '\n\n待核线索：' + JSON.stringify(hints) +
    '\n\nguide-input:\n' + JSON.stringify(input) + '\n\nreader-guide:\n' + JSON.stringify(guide);
}

function buildPlainGuideReviewPrompt(guide, plainGuide) {
  return '你是 R8 章节导览白话层的独立语义复核器。按 C1—C12 每张卡的完整 what/why/conclusion 上下文比较原 guide 与 plain guide；不要把三个字段拆成彼此无关的孤句。白话只能降低表达门槛，绝不能改变或省略原文中的主体、胜负、因果方向、否定/保留条件、责任归属、程度、数字、评分、ID、判决或任何限定。内部定位码的对象身份必须保留，允许去掉不承担语义的重复次数，不能换成其他对象；数字允许等价写法，但它们可以只是 locator：如果同卡或邻句已经把事件/判断说明白，不要求逐个解释 ID；关键是忽略定位码后仍能理解判断，不得把自然文本改造成机器说明书。逐章检查 semanticEquivalent、noJudgmentChange、factsConsistent、zeroBackgroundReadable、naturalReadable、noLocatorDependency 六项。任一实质性压缩、因果替换、否定丢失、判断强化/弱化、黑箱表达或编号依赖都必须 false。输出且只输出 JSON：' +
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
  return '你是 R8 白话导览定点语义修复器。只允许修改失败卡；同卡 what/why/conclusion 全部作为语义 context halo 提供，未点名卡被冻结。术语表不是固定括号模板；内部编号可以只是 locator，不要求逐个解释，但忽略编号后仍应能理解事件和判断。必须保持原卡全部事实、主体、胜负、数字、因果、否定、限定、责任、程度与结论强度，且不新增或改变事实含义。输出必须且只能是 {"units":[{"id":"R8P:C1:what","text":"..."}]}，并恰好覆盖 targetIds。' +
    '\n\ntargetIds=' + JSON.stringify(targetIds) +
    '\n\nreview=' + JSON.stringify(review) +
    '\n\noriginalCards=' + JSON.stringify(originals) +
    '\n\ncurrentPlainCards=' + JSON.stringify(candidates);
}

module.exports = { SCHEMA_VERSION, PROMPT_VERSION, PLAIN_SCHEMA_VERSION, PLAIN_PROMPT_VERSION, SECTION_IDS, stableJson, hashGuideInput, hashPlainGuideSource, parseSpeechAnchors, buildGuideInput, cacheKey, validateGuide, validateReview, validatePlainGuide, validatePlainGuideReview, parseJson, buildGuidePrompt, guideRepairSectionIds, buildGuideRepairPrompt, buildReviewPrompt, buildPlainGuideReviewPrompt, plainGuideReviewFailedSections, buildPlainGuideRepairPrompt };
