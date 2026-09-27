'use strict';

const crypto = require('crypto');
const { findExactSourceSpans, softAnchorEvidence } = require('./semantic-workflow.js');

const AUTHORITY_SCHEMA = 'judge-sc-semantic-authority-v1';
const INVENTORY_SCHEMA = 'judge-sc-candidate-inventory-v1';
const PROFILE_ID = 'semantic-first-sc-whole-debate-authority-v10-r2.1-reviewed-inventory-20260920';
const RELATION_TYPES = new Set([
  'none',
  'single_side',
  'parallel_independent',
  'higher_order_cover',
  'apparent_double_actual_single',
  'mutual_partial',
  'other_evidenced_relation'
]);
const PHASE_STATES = new Set(['formed', 'not_formed', 'uncertain']);
const ELEMENT_MODES = new Set(['explicit', 'semantic_inference', 'absent', 'uncertain']);
const ACCEPT_MODES = new Set(['explicit', 'semantic_inference', 'restate_only', 'rebuttal_only', 'uncertain']);
const DOMINANT_SIDES = new Set(['affirmative', 'negative', 'none', 'both', 'uncertain']);
const COMPOSITION_FUNCTIONS = new Set(['accept', 'b_prime', 'unify', 'role_state', 'coverage', 'bridge']);
const INVENTORY_FUNCTIONS = new Set(['accept', 'b_prime', 'unify', 'role_state', 'bridge']);
const FORBIDDEN_RESULT_KEYS = /^(winner|verdict|final_winner|overall_result|match_result|胜负|胜方|获胜方)$/i;
const EVIDENCE_QUOTE_PROTOCOL = '【representation/provenance only】只有被声明为 exact quote 的最终可审计表示，才必须直接复制自完整原文中的逐字符连续 exact substring。允许跨物理行，但必须原样保留原文真实换行；严禁把多行用空格、标点或任何规范化方式拼成新字符串，不得做标点/空白规范化、错别字修正或同义改写。不连续的多处证据必须拆成多条 evidence。occurrence 只是重复文本的可选来源坐标，不能决定 candidate 是否 formed，也不能代替时序语义判断。语义发现/复核可以先指出来源含义而不因 quote 表示瑕疵被否定；最终 projection 若无法给出忠实 exact evidence，应 fail-close 表示发布，而不得反向改写已经 review 的 semantic truth。';
const CANDIDATE_SET_COMPLETENESS_PROTOCOL = '【whole-debate semantic completeness】完整阅读整场材料，不得在发现某方第一条可成立链后停止，也不得把“后出现”“总结性发言”“同一主题”预设为独立 candidate 的充分条件。候选边界只由自然语言语义依赖决定：它实际接受/承接了什么 pressure，该 pressure 的 role-state 如何变化，使用了什么实质评价/重构原则（B\'），哪些理由真正参与 dependency，以及材料是否形成了自己的收束。不同表述若是同一 dependency 不拆分；同主题但 dependency 不同不得合并；早段、晚段、跨发言、跨说话者、后文重调都一视同仁。不得规定固定扫描遍数或固定推理顺序。';
const HIERARCHICAL_COMPOSITION_PROTOCOL = '【semantic dependency relations】允许材料形成平行链、后段重新结晶、上位重构，也允许始终只有一条持续链；关系名称不能预先规定语义形状。genuine parent 只能来自原文中真实的新依赖：后段确实重新组织先前 pressure/role-state/理由并形成一个不能被任何单一 child 等价解释的评价操作或结论。false parent 包括仅同主题、同辩手、同结论、相邻段落、修辞总结、字段拼接或为了覆盖多个 child 而人为造出的综合。不得使用 child 数量、固定 branch 数量、固定元规则词或固定出现位置作为 parent 的必要/充分条件。';
const RELATION_INDEPENDENCE_PROTOCOL = '【SC relation independence】reviewed global semantic 只提供整场语义背景，不直接给出 SC relation 或 dominant_side 的答案。整体净比较、最终倾向或其他非 SC 优势不得被复制成 SC 关系。relation 必须由当前双方 SC candidates 之间的结构性吸收、覆盖、并行或部分互容关系独立推出并由原文证据支持；若双方各自 formed 但不存在 source-grounded 的 SC 层级不对称，就不得仅凭 global semantic 的整体优势指定 dominant_side。判 higher_order_cover 前必须做双向覆盖测试：分别问 A 的 B\' 是否只是在 B 的判准内部增加局部价值，还是直接挑战 B 的评价规则之合法性、优先级、适用范围或权重；再对 B 对 A 做同样测试。若某方的 B\' 本身是对对方评价规则的元层挑战，就不能仅因对方谈成本、条件或总体比较而把该方自动降格为“局部价值”；必须用 source-grounded dependency 解释该元层挑战为何仍未覆盖、被反覆盖或只能部分成立。';
const INVENTORY_FREEZE_PROTOCOL = '【semantic discovery freeze】候选发现与 authority 写作分层。先做一次完整 whole-debate discovery 形成未冻结草案，再由独立 inventory reviewer 重新阅读完整原文，把草案仅作为待审提案：reviewer 可以 source-grounded 地补入遗漏的 formed dependency、删除未闭合项、合并同义项或拆开实质不同的 dependency，并输出一份完整 replacement inventory。只有这份 reviewed inventory 才冻结本 run candidate id 集合。不得用固定扫描遍数、固定方向、固定 branch 数量或固定 candidate 数量定义完整性。后续 authority review 若又发现 inventory 外新的 formed dependency，只能 inventory_gap=true 并 fail-close；不得在冻结后 chase-add。freeze 是运行边界，不是“冻结清单天然正确”的语义宣告。';
const TEMPORAL_ROLE_STATE_PROTOCOL = '【temporal role-state semantics】按完整原文理解 pressure 在对话中的真实状态：持续、收窄、撤回、重新激活、被后文重新调用或被新条件改写。后出现的 pressure 不能被虚构为早先已经接受；但 B\' 可以早于某个具体 pressure 出现，只要后文确实重新调用该原则并形成语义闭合。source order、line、occurrence 只提供 provenance 线索，不是 formed/not_formed 的公式。时序成立与否由 whole-debate semantic discovery 与 independent review 判断。';
const SEMANTIC_REPRESENTATION_SEPARATION_PROTOCOL = '【semantic / representation separation】candidate 是否 formed、accepted pressure/role-state/B\'/dependency/unified conclusion 属于语义层，只能由完整原文上的 semantic discovery / independent inventory review / independent authority review 改变。evidence.function、exact quote、occurrence、source_ref 与 JSON 包装属于表示/审计层；它们不能反向决定 semantic truth。语义 review 完成后，每次运行统一进入标准 sc-project，把已生效语义忠实投影为 exact auditable representation；projection 不得新增、删除、合并、拆分 candidate，也不得修改 semantic fields。投影失败即本 run fail-close，不触发 error-class repair。';
const REVIEW_WRAPPER_PROTOCOL = '【review wrapper 硬约束】最外层 JSON 必须且只能表达 review 决策：decision 必须逐字是 maintain、revise、reject、unresolved 四者之一；evidence 为数组；reason 为字符串；inventory_gap 为布尔值；authority 在 revise 时放完整 authority 对象，其余 decision 必须为 null。若发现 frozen reviewed inventory 漏掉新的 formed chain，必须 inventory_gap=true 且 decision=reject/unresolved、authority=null；不得在 review 中偷偷新增 candidate。严禁把 authority 对象直接作为最外层输出，严禁自造 revise_and_expand 等近义 decision。authority shape 指令只描述 revise 时嵌套在 authority 字段中的对象，不改变最外层 review wrapper。';
const INVENTORY_SYSTEM = [
  '你是独立 SC candidate inventory 发现器，不写最终 authority，不裁整场胜负。',
  '完整逐段阅读原文，枚举本次 whole-debate discovery 能发现的所有已经闭合、且 accepted pressure / role-state / B\' / dependency path / unified conclusion 至少一项实质不同的 formed SC 链。',
  '同义例子、重复措辞或同一依赖链的展开不能拆成新候选；真正不同的依赖链不能因为支持同一立场而合并。',
  CANDIDATE_SET_COMPLETENESS_PROTOCOL,
  HIERARCHICAL_COMPOSITION_PROTOCOL,
  TEMPORAL_ROLE_STATE_PROTOCOL,
  SEMANTIC_REPRESENTATION_SEPARATION_PROTOCOL,
  EVIDENCE_QUOTE_PROTOCOL,
  '只输出严格 JSON inventory，不要 Markdown、代码围栏、authority、winner 或 verdict。'
].join('\n');
const INVENTORY_REVIEW_SYSTEM = [
  '你是独立 SC candidate inventory reviewer，不写最终 authority，不裁整场胜负。',
  '重新阅读完整原文。输入的 discovery inventory 只是未冻结提案，不是答案，也不拥有语义权威。',
  '输出一份完整 replacement inventory：可以补入 discovery 漏掉的 formed dependency，删除其实未闭合的候选，合并真正同义项，或拆开 accepted pressure / role-state / B\' / dependency / unified conclusion 实质不同却被误并的候选。',
  '不得为了保持 discovery 的 candidate 数量、id、顺序或结构而牺牲全文语义；也不得为了追求更多候选而把同义例子、普通反驳或修辞总结拆成 SC。',
  CANDIDATE_SET_COMPLETENESS_PROTOCOL,
  HIERARCHICAL_COMPOSITION_PROTOCOL,
  TEMPORAL_ROLE_STATE_PROTOCOL,
  SEMANTIC_REPRESENTATION_SEPARATION_PROTOCOL,
  EVIDENCE_QUOTE_PROTOCOL,
  '只输出严格 JSON inventory，pass 必须为 reviewed；不要 Markdown、authority、winner 或 verdict。'
].join('\n');

const ANALYZE_SYSTEM = [
  '你是专职 SC（结构性交锋）authority 写作者，不是候选发现器，也不是整场胜负裁判。',
  '候选集合已经由 whole-debate discovery + independent inventory review 冻结；你只能把冻结候选写成完整 authority，不得新增、删除、合并、拆分或改名 candidate。',
  '只依据完整原文、当前 reviewed global semantic 与 frozen inventory 完成 composition；不得读取旧 P2/S8/S17 作为真值。',
  '跨段/跨发言合并必须有可解释的语义依赖：继续、应用、回应、细化、回扣、完成或重新调用同一接收→B\'→统一结论关系。共同主题、关键词、同一辩手或同在结辩都不足以证明同一链。',
  '必须追踪 accepted content 的 role-state：被击中的强版本、已收窄/撤回的机制不得被后文复活。',
  '必须允许自然语义等价：显性承认、含义承认、B不重要式、反转式、隐性容纳都可成立；不得要求固定关键词、模板句或“那又怎样”。',
  'SC authority 只裁 SC/Phase III 事实及双方 SC 关系，不输出或暗示整场赢家。',
  INVENTORY_FREEZE_PROTOCOL,
  TEMPORAL_ROLE_STATE_PROTOCOL,
  SEMANTIC_REPRESENTATION_SEPARATION_PROTOCOL,
  HIERARCHICAL_COMPOSITION_PROTOCOL,
  RELATION_INDEPENDENCE_PROTOCOL,
  EVIDENCE_QUOTE_PROTOCOL,
  '只输出严格 JSON authority 对象，不要 Markdown、代码围栏或额外文字。'
].join('\n');

const REVIEW_SYSTEM = [
  '你是独立 source-grounded SC semantic reviewer。',
  '重新阅读完整原文、reviewed global semantic、frozen reviewed inventory 与候选 SC authority；不得相信候选本身，也不得读取旧 P2/S8/S17。',
  '重点检查：authority 是否忠实实现 frozen candidate、同主题碎片是否伪拼、已收窄强版本是否复活、B\' 是否只是标签、统一结论是否只是抒情/重复、时序/role-state 是否倒灌、以及双方关系是否误判。',
  '不得因句子在结辩、措辞更抽象、价值更宏大或结构字段更完整就自动判上位覆盖。',
  '只能审 SC；不得输出整场 winner/verdict。',
  '候选集合已经由 discovery + independent inventory review 冻结。review 不得把新发现直接写入 authority；若独立重扫发现 inventory 漏掉新的 formed chain，只能 inventory_gap=true 并 fail-close。',
  INVENTORY_FREEZE_PROTOCOL,
  TEMPORAL_ROLE_STATE_PROTOCOL,
  SEMANTIC_REPRESENTATION_SEPARATION_PROTOCOL,
  HIERARCHICAL_COMPOSITION_PROTOCOL,
  RELATION_INDEPENDENCE_PROTOCOL,
  EVIDENCE_QUOTE_PROTOCOL,
  'maintain/revise 的 evidence 只作为 source-grounded locator，可软锚；不得因 quote/occurrence 的表示瑕疵推翻语义判断。revise 的 authority 必须可独立消费且 candidate id 集合保持冻结。',
  REVIEW_WRAPPER_PROTOCOL
].join('\n');

const FIDELITY_SYSTEM = [
  '你是 SC authority fidelity reviewer。',
  '独立比较完整原文、reviewed global semantic、frozen reviewed inventory 与已经 review 生效的 SC authority。',
  '检查主体、否定、限定、role-state、接收对象、B\'、统一结论、composition dependency、coverage 与双方关系是否忠实；特别防止伪拼接和时序倒灌。',
  '你不裁整场胜负，也不因字段完整度奖励任何一方。',
  '候选集合已经由 discovery + independent inventory review 冻结。除了核对 authority 内部忠实度，还要独立做 inventory-gap audit；若发现 inventory 外的新 formed chain，必须 reject 且 inventory_gap=true，本轮禁止 repair 追加入表。',
  INVENTORY_FREEZE_PROTOCOL,
  TEMPORAL_ROLE_STATE_PROTOCOL,
  SEMANTIC_REPRESENTATION_SEPARATION_PROTOCOL,
  HIERARCHICAL_COMPOSITION_PROTOCOL,
  RELATION_INDEPENDENCE_PROTOCOL,
  EVIDENCE_QUOTE_PROTOCOL,
  '只输出严格 JSON：{"decision":"approve|reject","inventory_gap":false,"reason":"...","issues":["..."],"evidence":[{"quote":"可选原文逐字片段","reason":"..."}]}。发现 inventory 外新 formed chain 时 inventory_gap 必须为 true。'
].join('\n');

const PROJECT_SYSTEM = [
  '你是 SC authority 的标准表示投影器，不是 semantic reviewer，也不是错误修复器。',
  '输入 semantic authority 已经过 independent review；你必须冻结其 candidate 数量/顺序/id、phase_iii、accepted content/mode/role-state、B\'、unified conclusion、dependency、element_modes、coverage、relation type/dominant/reason 与 notes。',
  '只负责把这些已生效语义投影为可审计 representation：composition_chain、exact_source_evidence、relation.evidence、quote、occurrence、function/inference/role。',
  '条件表示合同：当某 candidate.accepted_content_mode === "semantic_inference" 时，该 candidate 的 composition_chain 中 function === "accept" 的行必须同时提供非空 inference，明确说明这条 exact quote 如何桥接到已经 review 生效的 accepted_opponent_content；inference 只解释既有语义，不得新增、扩大或改写接受内容。accepted_content_mode 不是 semantic_inference 时不得为了凑字段机械制造 inference。',
  '结构表示完整性合同：每个 candidate 的 composition_chain 中 function 为 accept、b_prime、unify 或 role_state 且带 quote 的结构行，都必须在同一 candidate.exact_source_evidence 中存在对应的 exact quote；允许 evidence quote 与结构 quote 逐字相同或形成 validator 允许的包含对应，但不得只写进 composition_chain 而漏出 exact_source_evidence。exact_source_evidence 可以补充额外支持证据，但不得省略任何结构性 composition quote。',
  '所有 exact quote 必须是完整原文中的逐字连续 substring；允许跨物理行，但必须保留原文真实换行。非连续的多处证据拆成多条 evidence。occurrence 仅在需要消歧来源时使用。',
  '不得为了满足 schema 改 semantic truth；若无法忠实表示，仍应尽最大努力保持语义不变，最终 deterministic validator 会 fail-close。',
  EVIDENCE_QUOTE_PROTOCOL,
  SEMANTIC_REPRESENTATION_SEPARATION_PROTOCOL,
  '只输出一个完整严格 JSON authority，不要 Markdown、解释或第二个对象。'
].join('\n');

function stableStructuralJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStructuralJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + stableStructuralJson(value[key])).join(',') + '}';
  }
  const scalar = JSON.stringify(value);
  return scalar === undefined ? String(value) : scalar;
}
function structuralJsonEqual(a, b) {
  return stableStructuralJson(a) === stableStructuralJson(b);
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(Buffer.from(String(value == null ? '' : value), 'utf8')).digest('hex');
}

function profileBundleSha256() {
  // Only active semantic/projection stages define the profile identity. Legacy
  // compatibility helpers are deliberately excluded from the active bundle.
  return sha256Text([PROFILE_ID, INVENTORY_SYSTEM, INVENTORY_REVIEW_SYSTEM, ANALYZE_SYSTEM, REVIEW_SYSTEM, PROJECT_SYSTEM, FIDELITY_SYSTEM].join('\u0000'));
}

function parseStrictJsonObject(raw, label) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text || text[0] !== '{' || text[text.length - 1] !== '}') {
    throw new Error((label || 'JSON') + ' must be exactly one JSON object');
  }
  let value;
  try { value = JSON.parse(text); }
  catch (e) { throw new Error((label || 'JSON') + ' invalid JSON: ' + e.message); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error((label || 'JSON') + ' must be an object');
  return value;
}

function assertNoWinnerKeys(value, path) {
  path = path || '$';
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoWinnerKeys(item, path + '[' + index + ']'));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_RESULT_KEYS.test(key)) throw new Error('SC authority forbids winner/verdict field at ' + path + '.' + key);
    assertNoWinnerKeys(item, path + '.' + key);
  }
}

function quoteOccurrences(sourceText, quote) {
  const q = String(quote == null ? '' : quote);
  if (!q) throw new Error('exact-source quote is empty');
  const spans = findExactSourceSpans(sourceText, q);
  if (!spans.length) throw new Error('exact-source quote must be an exact contiguous substring of current source: ' + q.slice(0, 80));
  return spans;
}

function locateQuote(sourceText, quote, occurrence) {
  const q = String(quote == null ? '' : quote);
  const spans = quoteOccurrences(sourceText, q);
  let occurrenceIndex = 0;
  if (occurrence !== undefined && occurrence !== null) {
    if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > spans.length) {
      throw new Error('exact-source quote occurrence invalid: quote=' + q.slice(0, 80) + ' occurrence=' + String(occurrence) + ' count=' + spans.length);
    }
    occurrenceIndex = occurrence - 1;
  }
  return Object.assign({}, spans[occurrenceIndex], {
    occurrence: occurrenceIndex + 1,
    occurrenceCount: spans.length
  });
}

function validateEvidenceList(list, sourceText, label, required) {
  if (!Array.isArray(list)) throw new Error(label + ' must be an array');
  if (required && list.length === 0) throw new Error(label + ' requires exact-source evidence');
  return list.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(label + '[' + index + '] invalid');
    const located = locateQuote(sourceText, row.quote, row.occurrence);
    return Object.assign({}, row, located);
  });
}

function softLocateEvidenceList(list, sourceText, label) {
  if (!Array.isArray(list)) return [];
  return list.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return { quote: '', provenance_error: label + '[' + index + '] invalid evidence row' };
    }
    const out = Object.assign({}, row);
    const fn = String(out.function || '');
    if (fn && !INVENTORY_FUNCTIONS.has(fn)) out.provenance_error = 'unknown inventory evidence function: ' + fn;
    try {
      if (typeof out.quote !== 'string' || !out.quote) throw new Error('missing quote');
      Object.assign(out, locateQuote(sourceText, out.quote, out.occurrence));
    } catch (error) {
      out.provenance_error = String(error && error.message ? error.message : error);
    }
    return out;
  });
}

function validateInventoryEntry(entry, sourceText, label) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(label + ' invalid');
  for (const key of ['id', 'accepted_pressure', 'role_state', 'b_prime', 'unified_conclusion', 'dependency_summary']) {
    if (typeof entry[key] !== 'string' || !entry[key].trim()) throw new Error(label + '.' + key + ' required');
  }
  entry.evidence = softLocateEvidenceList(entry.evidence, sourceText, label + '.evidence');
  return entry;
}

function parseInventory(raw, sourceText, expectedPass) {
  const doc = parseStrictJsonObject(raw, 'SC inventory');
  assertNoWinnerKeys(doc);
  if (doc.schema !== INVENTORY_SCHEMA) throw new Error('SC inventory schema mismatch');
  if (String(doc.pass || '') !== String(expectedPass || '')) throw new Error('SC inventory pass mismatch');
  if (!doc.sides || typeof doc.sides !== 'object' || Array.isArray(doc.sides)) throw new Error('SC inventory sides invalid');
  if (typeof doc.notes !== 'string') throw new Error('SC inventory notes must be string');
  for (const side of ['affirmative', 'negative']) {
    if (!Array.isArray(doc.sides[side])) throw new Error('SC inventory side must be array: ' + side);
    const ids = new Set();
    doc.sides[side] = doc.sides[side].map((entry, index) => {
      const out = validateInventoryEntry(entry, sourceText, 'inventory.' + side + '[' + index + ']');
      if (ids.has(out.id)) throw new Error('SC inventory duplicate id: ' + side + ':' + out.id);
      ids.add(out.id);
      return out;
    });
  }
  return doc;
}

function assertAuthorityInventoryCoverage(authority, inventory) {
  for (const side of ['affirmative', 'negative']) {
    const invIds = (inventory.sides[side] || []).map(x => x.id).sort();
    const authIds = (authority.sides[side].candidates || []).map(x => x.id).sort();
    if (JSON.stringify(invIds) !== JSON.stringify(authIds)) {
      throw new Error('SC authority candidate ids must exactly match frozen inventory for ' + side + ': inventory=' + JSON.stringify(invIds) + ' authority=' + JSON.stringify(authIds));
    }
    if (invIds.length > 0 && authority.sides[side].phase_iii !== 'formed') throw new Error('SC authority inventory has formed candidates but side is not formed: ' + side);
    if (invIds.length === 0 && authority.sides[side].phase_iii === 'formed') throw new Error('SC authority side formed without frozen inventory candidate: ' + side);
  }
  return authority;
}

function validateCandidate(candidate, sourceText, side, index, sidePhase) {
  const label = 'sides.' + side + '.candidates[' + index + ']';
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error(label + ' invalid');
  const requiredStrings = [
    'id', 'accepted_opponent_content', 'accepted_content_mode', 'accepted_content_role_state',
    'b_prime', 'unified_conclusion', 'dependency_explanation'
  ];
  for (const key of requiredStrings) {
    if (typeof candidate[key] !== 'string') throw new Error(label + '.' + key + ' must be string');
  }
  if (!candidate.id.trim()) throw new Error(label + '.id empty');
  if (!ACCEPT_MODES.has(candidate.accepted_content_mode)) throw new Error(label + '.accepted_content_mode invalid');
  if (sidePhase === 'formed') {
    for (const key of ['accepted_opponent_content', 'accepted_content_role_state', 'b_prime', 'unified_conclusion', 'dependency_explanation']) {
      if (!candidate[key].trim()) throw new Error(label + ' formed candidate requires non-empty ' + key);
    }
  }
  if (!Array.isArray(candidate.composition_chain)) throw new Error(label + '.composition_chain must be array');
  const functions = new Set();
  const locatedComposition = [];
  for (let i = 0; i < candidate.composition_chain.length; i++) {
    const row = candidate.composition_chain[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(label + '.composition_chain[' + i + '] invalid');
    if (!COMPOSITION_FUNCTIONS.has(String(row.function || ''))) throw new Error(label + '.composition_chain[' + i + '].function invalid');
    functions.add(row.function);
    if (row.quote) {
      const locatedRow = Object.assign({}, row, locateQuote(sourceText, row.quote, row.occurrence));
      locatedComposition.push(locatedRow);
    }
    if (row.function === 'accept' && candidate.accepted_content_mode === 'semantic_inference' && !String(row.inference || '').trim()) {
      throw new Error(label + ' semantic_inference accept requires inference bridge');
    }
  }
  if (sidePhase === 'formed') {
    for (const fn of ['accept', 'b_prime', 'unify']) {
      if (!functions.has(fn)) throw new Error(label + ' formed composition missing ' + fn);
    }
    for (const fn of ['accept', 'b_prime', 'unify']) {
      if (!locatedComposition.some(row => row.function === fn)) throw new Error(label + ' formed composition ' + fn + ' requires exact quote anchor');
    }
  }
  candidate.exact_source_evidence = validateEvidenceList(candidate.exact_source_evidence, sourceText, label + '.exact_source_evidence', sidePhase === 'formed');
  if (sidePhase === 'formed') {
    const structuralRows = locatedComposition.filter(row => ['accept', 'b_prime', 'unify', 'role_state'].includes(row.function));
    for (const row of structuralRows) {
      const matched = candidate.exact_source_evidence.some(ev => {
        const a = String(row.quote || '');
        const b = String(ev.quote || '');
        return a === b || a.includes(b) || b.includes(a);
      });
      if (!matched) throw new Error(label + ' structural composition quote missing corresponding exact_source_evidence: ' + row.function);
    }
  }
  if (!candidate.element_modes || typeof candidate.element_modes !== 'object' || Array.isArray(candidate.element_modes)) {
    throw new Error(label + '.element_modes invalid');
  }
  for (const key of ['accepted', 'b_prime', 'unified_conclusion']) {
    if (!ELEMENT_MODES.has(String(candidate.element_modes[key] || ''))) throw new Error(label + '.element_modes.' + key + ' invalid');
  }
  if (!candidate.coverage || typeof candidate.coverage !== 'object' || Array.isArray(candidate.coverage)) throw new Error(label + '.coverage invalid');
  for (const key of ['absorbed_pressures', 'surviving_pressures']) {
    if (!Array.isArray(candidate.coverage[key])) throw new Error(label + '.coverage.' + key + ' must be array');
  }
  return candidate;
}

function validateSide(sideDoc, sourceText, side) {
  if (!sideDoc || typeof sideDoc !== 'object' || Array.isArray(sideDoc)) throw new Error('sides.' + side + ' invalid');
  if (!PHASE_STATES.has(String(sideDoc.phase_iii || ''))) throw new Error('sides.' + side + '.phase_iii invalid');
  if (!Array.isArray(sideDoc.candidates)) throw new Error('sides.' + side + '.candidates must be array');
  if (sideDoc.phase_iii === 'formed' && sideDoc.candidates.length === 0) throw new Error('sides.' + side + ' formed Phase III requires candidate');
  sideDoc.candidates = sideDoc.candidates.map((c, i) => validateCandidate(c, sourceText, side, i, sideDoc.phase_iii));
  return sideDoc;
}

function parseSemanticAuthority(raw) {
  const doc = typeof raw === 'string' ? parseStrictJsonObject(raw, 'SC semantic authority') : JSON.parse(JSON.stringify(raw));
  assertNoWinnerKeys(doc);
  if (doc.schema !== AUTHORITY_SCHEMA) throw new Error('SC semantic authority schema mismatch');
  if (!doc.sides || typeof doc.sides !== 'object' || Array.isArray(doc.sides)) throw new Error('SC semantic authority sides invalid');
  for (const side of ['affirmative', 'negative']) {
    const sideDoc = doc.sides[side];
    if (!sideDoc || typeof sideDoc !== 'object' || Array.isArray(sideDoc)) throw new Error('SC semantic authority side invalid: ' + side);
    if (!PHASE_STATES.has(String(sideDoc.phase_iii || ''))) throw new Error('SC semantic authority phase invalid: ' + side);
    if (!Array.isArray(sideDoc.candidates)) throw new Error('SC semantic authority candidates must be array: ' + side);
    sideDoc.candidates.forEach((candidate, index) => {
      const label = 'semantic.' + side + '.candidates[' + index + ']';
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error(label + ' invalid');
      for (const key of ['id','accepted_opponent_content','accepted_content_mode','accepted_content_role_state','b_prime','unified_conclusion','dependency_explanation']) {
        if (typeof candidate[key] !== 'string') throw new Error(label + '.' + key + ' must be string');
      }
      if (!candidate.id.trim()) throw new Error(label + '.id empty');
      if (!ACCEPT_MODES.has(candidate.accepted_content_mode)) throw new Error(label + '.accepted_content_mode invalid');
      if (!candidate.element_modes || typeof candidate.element_modes !== 'object' || Array.isArray(candidate.element_modes)) throw new Error(label + '.element_modes invalid');
      for (const key of ['accepted','b_prime','unified_conclusion']) {
        if (!ELEMENT_MODES.has(String(candidate.element_modes[key] || ''))) throw new Error(label + '.element_modes.' + key + ' invalid');
      }
      if (!candidate.coverage || typeof candidate.coverage !== 'object' || Array.isArray(candidate.coverage)) throw new Error(label + '.coverage invalid');
      for (const key of ['absorbed_pressures','surviving_pressures']) if (!Array.isArray(candidate.coverage[key])) throw new Error(label + '.coverage.' + key + ' must be array');
      if (!Array.isArray(candidate.composition_chain)) candidate.composition_chain = [];
      if (!Array.isArray(candidate.exact_source_evidence)) candidate.exact_source_evidence = [];
    });
  }
  if (!doc.relation || typeof doc.relation !== 'object' || Array.isArray(doc.relation)) throw new Error('SC semantic authority relation invalid');
  if (!RELATION_TYPES.has(String(doc.relation.type || ''))) throw new Error('SC semantic authority relation.type invalid');
  if (!DOMINANT_SIDES.has(String(doc.relation.dominant_side || ''))) throw new Error('SC semantic authority relation.dominant_side invalid');
  if (typeof doc.relation.reason !== 'string' || !doc.relation.reason.trim()) throw new Error('SC semantic authority relation.reason required');
  if (!Array.isArray(doc.relation.evidence)) doc.relation.evidence = [];
  if (typeof doc.notes !== 'string') throw new Error('SC semantic authority notes must be string');
  return doc;
}

function parseAuthority(raw, sourceText) {
  const doc = typeof raw === 'string' ? parseStrictJsonObject(raw, 'SC authority') : JSON.parse(JSON.stringify(raw));
  assertNoWinnerKeys(doc);
  const keys = Object.keys(doc).sort();
  const required = ['notes', 'relation', 'schema', 'sides'].sort();
  if (JSON.stringify(keys) !== JSON.stringify(required)) throw new Error('SC authority top-level fields must be exactly schema,sides,relation,notes');
  if (doc.schema !== AUTHORITY_SCHEMA) throw new Error('SC authority schema mismatch');
  if (!doc.sides || typeof doc.sides !== 'object' || Array.isArray(doc.sides)) throw new Error('SC authority sides invalid');
  const sideKeys = Object.keys(doc.sides).sort();
  if (JSON.stringify(sideKeys) !== JSON.stringify(['affirmative', 'negative'])) throw new Error('SC authority sides must be affirmative/negative');
  doc.sides.affirmative = validateSide(doc.sides.affirmative, sourceText, 'affirmative');
  doc.sides.negative = validateSide(doc.sides.negative, sourceText, 'negative');
  if (!doc.relation || typeof doc.relation !== 'object' || Array.isArray(doc.relation)) throw new Error('SC authority relation invalid');
  if (!RELATION_TYPES.has(String(doc.relation.type || ''))) throw new Error('SC authority relation.type invalid');
  if (!DOMINANT_SIDES.has(String(doc.relation.dominant_side || ''))) throw new Error('SC authority relation.dominant_side invalid');
  if (typeof doc.relation.reason !== 'string' || !doc.relation.reason.trim()) throw new Error('SC authority relation.reason required');
  doc.relation.evidence = validateEvidenceList(doc.relation.evidence || [], sourceText, 'relation.evidence', doc.relation.type !== 'none');
  if (typeof doc.notes !== 'string') throw new Error('SC authority notes must be string');
  const affFormed = doc.sides.affirmative.phase_iii === 'formed';
  const negFormed = doc.sides.negative.phase_iii === 'formed';
  if ((affFormed || negFormed) && doc.relation.type === 'none') {
    throw new Error('SC authority formed candidate requires non-none relation');
  }
  if (doc.relation.type === 'single_side') {
    if (affFormed === negFormed) throw new Error('SC authority single_side requires exactly one formed side');
    const expectedDominant = affFormed ? 'affirmative' : 'negative';
    if (doc.relation.dominant_side !== expectedDominant) throw new Error('SC authority single_side dominant side mismatch');
  }
  if (doc.relation.type === 'parallel_independent') {
    if (!affFormed || !negFormed) throw new Error('SC authority parallel_independent requires both sides formed');
    if (doc.relation.dominant_side !== 'none') throw new Error('SC authority parallel_independent cannot declare a dominant side');
  }
  if (doc.relation.type === 'higher_order_cover') {
    if (!affFormed || !negFormed) throw new Error('SC authority higher_order_cover requires both sides formed before relation comparison');
    if (!['affirmative', 'negative'].includes(doc.relation.dominant_side)) throw new Error('SC authority higher_order_cover requires the covering SC side');
  }
  if (doc.relation.type === 'apparent_double_actual_single') {
    if (affFormed === negFormed) throw new Error('SC authority apparent_double_actual_single requires exactly one actually formed side');
    const expectedDominant = affFormed ? 'affirmative' : 'negative';
    if (doc.relation.dominant_side !== expectedDominant) throw new Error('SC authority apparent_double_actual_single dominant side mismatch');
  }
  if (doc.relation.type === 'mutual_partial' && (!affFormed || !negFormed)) {
    throw new Error('SC authority mutual_partial requires both sides formed');
  }
  return doc;
}

function buildSemanticAuthorityShapeInstruction() {
  return [
    'semantic authority JSON 形状（只含语义真值；不承担 exact-copy / source-span 表示工作）：',
    '{',
    '  "schema":"' + AUTHORITY_SCHEMA + '",',
    '  "sides":{',
    '    "affirmative":{"phase_iii":"formed|not_formed|uncertain","candidates":[{',
    '      "id":"...",',
    '      "accepted_opponent_content":"...",',
    '      "accepted_content_mode":"explicit|semantic_inference|restate_only|rebuttal_only|uncertain",',
    '      "accepted_content_role_state":"...",',
    '      "b_prime":"...",',
    '      "unified_conclusion":"...",',
    '      "dependency_explanation":"为什么这些跨段/跨发言材料属于同一语义依赖链，而非仅共同主题",',
    '      "element_modes":{"accepted":"explicit|semantic_inference|absent|uncertain","b_prime":"...","unified_conclusion":"..."},',
    '      "coverage":{"absorbed_pressures":["..."],"surviving_pressures":["..."]}',
    '    }]},',
    '    "negative":{"phase_iii":"formed|not_formed|uncertain","candidates":[{',
    '      "id":"...",',
    '      "accepted_opponent_content":"...",',
    '      "accepted_content_mode":"explicit|semantic_inference|restate_only|rebuttal_only|uncertain",',
    '      "accepted_content_role_state":"...",',
    '      "b_prime":"...",',
    '      "unified_conclusion":"...",',
    '      "dependency_explanation":"为什么这些跨段/跨发言材料属于同一语义依赖链，而非仅共同主题",',
    '      "element_modes":{"accepted":"explicit|semantic_inference|absent|uncertain","b_prime":"...","unified_conclusion":"..."},',
    '      "coverage":{"absorbed_pressures":["..."],"surviving_pressures":["..."]}',
    '    }]}',
    '  },',
    '  "relation":{"type":"none|single_side|parallel_independent|higher_order_cover|apparent_double_actual_single|mutual_partial|other_evidenced_relation","dominant_side":"affirmative|negative|none|both|uncertain","reason":"..."},',
    '  "notes":"只说明 SC 边界，不得写整场赢家"',
    '}',
    '本阶段只判断语义；不要输出 composition_chain、exact_source_evidence、relation.evidence、quote、occurrence 或 source_span。'
  ].join('\n');
}

function buildAuthorityShapeInstruction() {
  return [
    'authority JSON 形状（字段名逐字）：',
    '{',
    '  "schema":"' + AUTHORITY_SCHEMA + '",',
    '  "sides":{',
    '    "affirmative":{"phase_iii":"formed|not_formed|uncertain","candidates":[{',
    '      "id":"...",',
    '      "accepted_opponent_content":"...",',
    '      "accepted_content_mode":"explicit|semantic_inference|restate_only|rebuttal_only|uncertain",',
    '      "accepted_content_role_state":"...",',
    '      "b_prime":"...",',
    '      "unified_conclusion":"...",',
    '      "dependency_explanation":"为什么这些跨段/跨发言 evidence 属于同一结构链，而非仅共同主题",',
    '      "composition_chain":[{"function":"accept|b_prime|unify|role_state|coverage|bridge","quote":"原文逐字片段","occurrence":"重复 quote 承担 accept/role_state/unify 时填 1-based 整数；唯一 quote 可省略","inference":"语义承接时说明桥梁"}],',
    '      "exact_source_evidence":[{"quote":"原文逐字连续片段","role":"..."}],',
    '      "element_modes":{"accepted":"explicit|semantic_inference|absent|uncertain","b_prime":"...","unified_conclusion":"..."},',
    '      "coverage":{"absorbed_pressures":["..."],"surviving_pressures":["..."]}',
    '    }]},',
    '    "negative":{"phase_iii":"formed|not_formed|uncertain","candidates":[{',
    '      "id":"...",',
    '      "accepted_opponent_content":"...",',
    '      "accepted_content_mode":"explicit|semantic_inference|restate_only|rebuttal_only|uncertain",',
    '      "accepted_content_role_state":"...",',
    '      "b_prime":"...",',
    '      "unified_conclusion":"...",',
    '      "dependency_explanation":"为什么这些跨段/跨发言 evidence 属于同一结构链，而非仅共同主题",',
    '      "composition_chain":[{"function":"accept|b_prime|unify|role_state|coverage|bridge","quote":"原文逐字片段","occurrence":"重复 quote 承担 accept/role_state/unify 时填 1-based 整数；唯一 quote 可省略","inference":"语义承接时说明桥梁"}],',
    '      "exact_source_evidence":[{"quote":"原文逐字连续片段","role":"..."}],',
    '      "element_modes":{"accepted":"explicit|semantic_inference|absent|uncertain","b_prime":"...","unified_conclusion":"..."},',
    '      "coverage":{"absorbed_pressures":["..."],"surviving_pressures":["..."]}',
    '    }]}',
    '  },',
    '  "relation":{"type":"none|single_side|parallel_independent|higher_order_cover|apparent_double_actual_single|mutual_partial|other_evidenced_relation","dominant_side":"affirmative|negative|none|both|uncertain","reason":"...","evidence":[{"quote":"原文逐字连续片段"}]},',
    '  "notes":"只说明 SC 边界，不得写整场赢家"',
    '}',
    'formed 候选必须有 accept + b_prime + unify 三种 composition function，并解释 dependency；not_formed/uncertain 可以列出未完成候选，但不得伪造缺失要素。'
  ].join('\n');
}

function sourceLineRanges(sourceText) {
  const source = String(sourceText || '');
  const lines = [];
  let start = 0;
  let line = 1;
  for (let i = 0; i <= source.length; i++) {
    if (i !== source.length && source[i] !== '\n') continue;
    let end = i;
    if (end > start && source[end - 1] === '\r') end--;
    lines.push({ line, charStart: start, charEnd: end, text: source.slice(start, end) });
    start = i + 1;
    line++;
  }
  return lines;
}

function buildEvidenceLineIndex(sourceText) {
  const lines = sourceLineRanges(sourceText).filter(row => row.text.length > 0).map(row => row.text);
  return [
    '【证据逐字行索引｜legacy representation helper；semantic stages 不应重复注入】',
    JSON.stringify(lines)
  ].join('\n');
}

function buildSourceSpanCatalog(sourceText) {
  const rows = sourceLineRanges(sourceText).map(row => ({
    line: row.line,
    char_start: row.charStart,
    char_end: row.charEnd
  }));
  return [
    '【source span locator metadata｜上方完整原文从第1个物理行开始计数；这里只给位置边界，不复制第二份正文】',
    JSON.stringify({ total_lines: rows.length, lines: rows })
  ].join('\n');
}

function materializeSourceSpan(sourceText, span, label) {
  const source = String(sourceText || '');
  const rows = sourceLineRanges(source);
  const startLine = Number(span && span.start_line);
  const endLine = Number(span && span.end_line);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > rows.length) {
    throw new Error((label || 'source_span') + ' invalid source_span: ' + JSON.stringify(span || null));
  }
  const start = rows[startLine - 1];
  const end = rows[endLine - 1];
  const quote = source.slice(start.charStart, end.charEnd);
  if (!quote) throw new Error((label || 'source_span') + ' resolves to empty source text');
  const spans = findExactSourceSpans(source, quote);
  const occurrenceIndex = spans.findIndex(item =>
    Number(item.charStart) === start.charStart && Number(item.charEnd) === end.charEnd);
  if (occurrenceIndex < 0) throw new Error((label || 'source_span') + ' cannot bind exact current source bytes');
  return {
    quote,
    occurrence: occurrenceIndex + 1,
    occurrenceCount: spans.length,
    charStart: start.charStart,
    charEnd: end.charEnd,
    lineStart: startLine,
    lineEnd: endLine
  };
}

function materializeProjectionEvidence(raw, sourceText) {
  const doc = typeof raw === 'string'
    ? parseStrictJsonObject(raw, 'SC projection')
    : JSON.parse(JSON.stringify(raw));
  const applyRow = (row, label) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || !row.source_span) return row;
    const located = materializeSourceSpan(sourceText, row.source_span, label);
    row.quote = located.quote;
    row.occurrence = located.occurrence;
    return row;
  };
  for (const side of ['affirmative', 'negative']) {
    const sideDoc = doc.sides && doc.sides[side];
    for (const [ci, candidate] of ((sideDoc && sideDoc.candidates) || []).entries()) {
      if (Array.isArray(candidate.composition_chain)) {
        candidate.composition_chain = candidate.composition_chain.map((row, ri) =>
          applyRow(row, 'sides.' + side + '.candidates[' + ci + '].composition_chain[' + ri + ']'));
      }
      if (Array.isArray(candidate.exact_source_evidence)) {
        candidate.exact_source_evidence = candidate.exact_source_evidence.map((row, ri) =>
          applyRow(row, 'sides.' + side + '.candidates[' + ci + '].exact_source_evidence[' + ri + ']'));
      }
    }
  }
  if (doc.relation && Array.isArray(doc.relation.evidence)) {
    doc.relation.evidence = doc.relation.evidence.map((row, ri) =>
      applyRow(row, 'relation.evidence[' + ri + ']'));
  }
  return doc;
}

function buildInventoryPrompt(sourceText, globalSemantic) {
  return [
    '【whole-debate semantic discovery｜未冻结草案】', '',
    '【完整原文】', String(sourceText || ''), '',
    '【当前 reviewed global semantic｜仅作背景，不给 candidate 答案】', String(globalSemantic || ''), '',
    '【任务】独立完整理解整场辩论，枚举你认为已经形成、且 semantic dependency 实质不同的 SC candidates。不要按固定遍数、时间方向、parent 模板、branch 数量或 candidate 数量搜索。',
    '对每个 candidate 说明：实际接受/承接的 pressure、该 pressure 的 role-state、实质 B\' 或重新评价、dependency 如何闭合、最终收束。显性承认、隐性语义承认、先有原则后被后文重新调用、收窄/撤回/再激活都允许，只看全文语义。',
    '这是 discovery 草案，后续 independent inventory reviewer 会重新阅读全文并有权增删并拆候选；不要把当前 id/数量当作冻结合同。',
    'evidence 只是发现阶段的 provenance hint，可以给原文片段与 function；quote/occurrence/function 的表示瑕疵不能决定 candidate 是否 formed，最终 exact-source projection 在 semantic review 之后处理。',
    'JSON 形状：',
    '{"schema":"' + INVENTORY_SCHEMA + '","pass":"discovery","sides":{"affirmative":[{"id":"...","accepted_pressure":"...","role_state":"...","b_prime":"...","unified_conclusion":"...","dependency_summary":"...","evidence":[{"function":"accept|b_prime|unify|role_state|bridge","quote":"source hint","occurrence":1,"inference":"可选"}]}],"negative":[]},"notes":"..."}'
  ].join('\n');
}

function buildInventoryReviewPrompt(sourceText, globalSemantic, discoveryInventory) {
  return [
    '【完整原文】', String(sourceText || ''), '',
    '【reviewed global semantic｜仅作背景，不给 candidate 答案】', String(globalSemantic || ''), '',
    '【未冻结 discovery inventory｜只是一份待审提案】', JSON.stringify(discoveryInventory || null, null, 2), '',
    '【任务】重新独立阅读完整原文，然后输出完整 replacement inventory。不要只对草案逐条挑错。',
    '重新阅读全文后，补入 discovery 漏掉的 formed dependency；若 discovery 项其实未闭合，删除；若同义重复则合并；若一个 discovery 项混合了实质不同的 accepted pressure / role-state / B\' / dependency / unified conclusion，则拆开。',
    '本阶段结束前 candidate id/数量/顺序都不是语义真值。只有你的 reviewed replacement inventory 输出之后才冻结。不得按固定扫描遍数、时间方向、branch 数量或预期候选数决定完整性。',
    'JSON 形状与 discovery 相同，但 pass 必须逐字为 reviewed：',
    '{"schema":"' + INVENTORY_SCHEMA + '","pass":"reviewed","sides":{"affirmative":[{"id":"...","accepted_pressure":"...","role_state":"...","b_prime":"...","unified_conclusion":"...","dependency_summary":"...","evidence":[{"function":"accept|b_prime|unify|role_state|bridge","quote":"source hint","occurrence":1,"inference":"可选"}]}],"negative":[]},"notes":"..."}'
  ].join('\n');
}

function buildAnalyzePrompt(sourceText, globalSemantic, inventory) {
  return [
    '【完整原文｜必须 whole-debate 扫描】',
    String(sourceText || ''),
    '',
    '【当前 reviewed global semantic｜仅作整场语义背景，不是 SC taxonomy 答案】',
    String(globalSemantic || ''),
    '',
    '【冻结 reviewed candidate inventory｜candidate id/数量不可改】',
    JSON.stringify(inventory || null, null, 2),
    '',
    '【任务】',
    '把冻结 inventory 写成双方 SC semantic authority。不要读取、猜测或复刻旧 P2/S8/S17。不要裁整场胜负。',
    'authority 的每方 candidate id 集合必须与 inventory 完全相同；不得再新增、删除、合并、拆分或改名 candidate。只允许补足 accepted_content_mode、role-state、coverage、relation 等语义字段，并保持 source-grounded；不要承担逐字 quote/occurrence/source_span 的表示工作。',
    INVENTORY_FREEZE_PROTOCOL,
    TEMPORAL_ROLE_STATE_PROTOCOL,
    buildSemanticAuthorityShapeInstruction()
  ].join('\n');
}

function buildReviewPrompt(sourceText, globalSemantic, candidate, issueText, inventory) {
  return [
    '【完整原文】', String(sourceText || ''), '',
    '【reviewed global semantic】', String(globalSemantic || ''), '',
    '【冻结 reviewed inventory】', JSON.stringify(inventory || null, null, 2), '',
    '【被审 SC semantic authority 候选】', JSON.stringify(candidate, null, 2), '',
    '【具体复核问题】', String(issueText || '复核 frozen inventory 对应的 accepted content、role-state、B\'、统一结论、coverage、dependency 与双方关系。'), '',
    '先核对 authority 是否逐 candidate 忠实实现 frozen inventory。若独立重扫发现 inventory 本身漏掉新的 formed chain，必须 inventory_gap=true 并 reject/unresolved；不得通过 revise 偷偷新增候选。',
    '本阶段只复核语义真值；quote/occurrence/source_span 等表示瑕疵只可作为 locator 问题，不得反向否定已经 source-grounded 成立的语义。',
    INVENTORY_FREEZE_PROTOCOL,
    TEMPORAL_ROLE_STATE_PROTOCOL,
    'revise 时 authority 必须完整且 candidate id 集合保持不变；这里只修订语义字段，表示字段留给后续 projection：',
    buildSemanticAuthorityShapeInstruction(), '',
    REVIEW_WRAPPER_PROTOCOL
  ].join('\n');
}

function buildFidelityPrompt(sourceText, globalSemantic, authority, inventory) {
  return [
    '【完整原文】', String(sourceText || ''), '',
    '【reviewed global semantic】', String(globalSemantic || ''), '',
    '【冻结 reviewed inventory】', JSON.stringify(inventory || null, null, 2), '',
    '【已 review 生效并完成标准表示的 SC authority】', JSON.stringify(authority, null, 2), '',
    '先检查 authority 是否忠实实现 frozen inventory、是否存在漏拼/伪拼/时序倒灌/role-state 复活。然后独立重扫完整原文做一次 inventory-gap audit：如果发现一个 frozen inventory 完全没有登记、且确实已闭合并具有实质不同 dependency 的 formed chain，必须 decision=reject 且 inventory_gap=true；本轮不得建议把它直接补入 authority。',
    '表示层 quote/source_span 的工作只用于 provenance；fidelity 的语义判断不得按字段数量、quote 长短或 source position 推导 formed/not_formed。',
    INVENTORY_FREEZE_PROTOCOL,
    TEMPORAL_ROLE_STATE_PROTOCOL
  ].join('\n');
}

function buildProjectPrompt(sourceText, globalSemantic, semanticAuthority, inventory) {
  return [
    '【完整原文｜source_span 的 start_line/end_line 以此处第1个物理行为 1】', String(sourceText || ''), '',
    buildSourceSpanCatalog(sourceText), '',
    '【reviewed global semantic｜仅作背景】', String(globalSemantic || ''), '',
    '【frozen reviewed inventory｜candidate identity 不可改】', JSON.stringify(inventory || null, null, 2), '',
    '【independent review 后已生效的 semantic authority｜语义字段不可改】', JSON.stringify(semanticAuthority || null, null, 2), '',
    '【任务】只做标准 auditable projection。补齐/校正 composition_chain、exact_source_evidence、relation.evidence 与 source_span/function/inference/role；每条结构/evidence 优先使用 source_span={start_line,end_line} 指向上面的不可变 catalog，quote 可留空，host 会从当前 source 机械复制 exact bytes；不得改变任何 semantic field 或 candidate identity。',
    'source_span 只负责 provenance 定位，不能决定 candidate 是否 formed、不能改变 relation，也不能用行号/位置替代语义判断。',
    SEMANTIC_REPRESENTATION_SEPARATION_PROTOCOL,
    buildAuthorityShapeInstruction()
  ].join('\n');
}

function parseReview(raw, sourceText, candidate, inventory) {
  const doc = parseStrictJsonObject(raw, 'SC review');
  assertNoWinnerKeys(doc);
  if (!['maintain', 'revise', 'reject', 'unresolved'].includes(doc.decision)) throw new Error('SC review decision invalid');
  const inventoryGap = doc.inventory_gap === true;
  if (doc.inventory_gap !== undefined && typeof doc.inventory_gap !== 'boolean') throw new Error('SC review inventory_gap must be boolean');
  if (inventoryGap && !['reject', 'unresolved'].includes(doc.decision)) throw new Error('SC review inventory_gap must fail closed');
  doc.evidence = softLocateEvidenceList(doc.evidence || [], sourceText, 'SC review evidence');
  if (typeof doc.reason !== 'string' || !doc.reason.trim()) throw new Error('SC review reason required');
  if (doc.decision === 'maintain') {
    if (doc.authority !== null) throw new Error('SC review maintain authority must be null');
    if (inventory) assertAuthorityInventoryCoverage(candidate, inventory);
    return { decision: doc.decision, inventory_gap: false, evidence: doc.evidence, reason: doc.reason, authority: candidate };
  }
  if (doc.decision === 'revise') {
    if (!doc.authority || typeof doc.authority !== 'object') throw new Error('SC review revise requires full authority');
    const revised = parseSemanticAuthority(doc.authority);
    if (inventory) assertAuthorityInventoryCoverage(revised, inventory);
    return { decision: doc.decision, inventory_gap: false, evidence: doc.evidence, reason: doc.reason, authority: revised };
  }
  if (doc.authority !== null) throw new Error('SC review reject/unresolved authority must be null');
  return { decision: doc.decision, inventory_gap: inventoryGap, evidence: doc.evidence, reason: doc.reason, authority: null };
}

function parseFidelity(raw, sourceText) {
  const doc = parseStrictJsonObject(raw, 'SC fidelity');
  assertNoWinnerKeys(doc);
  if (!['approve', 'reject'].includes(doc.decision)) throw new Error('SC fidelity decision invalid');
  if (doc.inventory_gap !== undefined && typeof doc.inventory_gap !== 'boolean') throw new Error('SC fidelity inventory_gap must be boolean');
  doc.inventory_gap = doc.inventory_gap === true;
  if (doc.decision === 'approve' && doc.inventory_gap) throw new Error('SC fidelity approve cannot carry inventory_gap');
  if (typeof doc.reason !== 'string' || !doc.reason.trim()) throw new Error('SC fidelity reason required');
  if (!Array.isArray(doc.issues)) throw new Error('SC fidelity issues must be array');
  doc.evidence = softLocateEvidenceList(doc.evidence || [], sourceText, 'SC fidelity evidence');
  return doc;
}

async function emitStage(onStage, stage, state, extra) {
  if (typeof onStage !== 'function') return;
  await Promise.resolve(onStage(Object.assign({ stage, state, semanticFirst: true, authorityScope: 'sc' }, extra || {})));
}

async function callText(callModel, role, system, prompt, onStage) {
  if (typeof callModel !== 'function') throw new Error('SC authority callModel required');
  await emitStage(onStage, role, 'active');
  try {
    const value = await callModel({ role, system, messages: [{ role: 'user', content: prompt }] });
    const text = value && typeof value === 'object' && typeof value.text === 'string' ? value.text : String(value == null ? '' : value);
    await emitStage(onStage, role, 'response_received');
    return text;
  } catch (e) {
    await emitStage(onStage, role, 'failed', { error: e && e.message ? e.message : String(e) });
    throw e;
  }
}

async function validateStage(onStage, role, validate) {
  await emitStage(onStage, role, 'validating');
  try {
    const value = await Promise.resolve(validate());
    await emitStage(onStage, role, 'complete');
    return value;
  } catch (e) {
    await emitStage(onStage, role, 'failed', { error: e && e.message ? e.message : String(e) });
    throw e;
  }
}

function semanticProjectionSnapshot(authority) {
  const doc = parseSemanticAuthority(authority);
  const out = { sides: { affirmative: null, negative: null }, relation: null, notes: doc.notes };
  for (const side of ['affirmative', 'negative']) {
    out.sides[side] = {
      phase_iii: doc.sides[side].phase_iii,
      candidates: doc.sides[side].candidates.map(c => ({
        id: c.id,
        accepted_opponent_content: c.accepted_opponent_content,
        accepted_content_mode: c.accepted_content_mode,
        accepted_content_role_state: c.accepted_content_role_state,
        b_prime: c.b_prime,
        unified_conclusion: c.unified_conclusion,
        dependency_explanation: c.dependency_explanation,
        element_modes: c.element_modes,
        coverage: c.coverage
      }))
    };
  }
  out.relation = {
    type: doc.relation.type,
    dominant_side: doc.relation.dominant_side,
    reason: doc.relation.reason
  };
  return out;
}

function assertProjectionSemanticIdentity(beforeAuthority, projectedAuthority) {
  const before = semanticProjectionSnapshot(beforeAuthority);
  const after = semanticProjectionSnapshot(projectedAuthority);
  if (!structuralJsonEqual(before, after)) {
    throw new Error('SC standard projection changed reviewed semantic truth');
  }
  return true;
}

// Projection is representation-only. The reviewed semantic authority owns every semantic
// field; sc-project may supply only auditable representation/provenance fields.
// This avoids treating explanatory projection notes as semantic mutation and, more
// importantly, makes it impossible for projection output to overwrite reviewed truth.
function mergeProjectionRepresentation(semanticAuthority, projectionRaw) {
  const truth = parseSemanticAuthority(semanticAuthority);
  const projected = typeof projectionRaw === 'string'
    ? parseStrictJsonObject(projectionRaw, 'SC projection')
    : JSON.parse(JSON.stringify(projectionRaw));
  assertNoWinnerKeys(projected);
  if (projected.schema !== AUTHORITY_SCHEMA) throw new Error('SC projection schema mismatch');
  if (!projected.sides || typeof projected.sides !== 'object' || Array.isArray(projected.sides)) {
    throw new Error('SC projection sides invalid');
  }

  const merged = JSON.parse(JSON.stringify(truth));
  for (const side of ['affirmative', 'negative']) {
    const projectedSide = projected.sides[side];
    if (!projectedSide || typeof projectedSide !== 'object' || !Array.isArray(projectedSide.candidates)) {
      throw new Error('SC projection side/candidates invalid: ' + side);
    }
    const byId = new Map();
    for (const candidate of projectedSide.candidates) {
      const id = String(candidate && candidate.id || '');
      if (!id || byId.has(id)) throw new Error('SC projection candidate identity invalid/duplicate: ' + side + ':' + id);
      byId.set(id, candidate);
    }
    const truthCandidates = merged.sides[side].candidates || [];
    const truthIds = truthCandidates.map(candidate => String(candidate.id));
    if (byId.size !== truthIds.length || truthIds.some(id => !byId.has(id))) {
      throw new Error('SC projection candidate identity set changed: ' + side);
    }
    merged.sides[side].candidates = truthCandidates.map(candidate => {
      const representation = byId.get(String(candidate.id));
      return Object.assign({}, candidate, {
        composition_chain: Array.isArray(representation.composition_chain)
          ? JSON.parse(JSON.stringify(representation.composition_chain)) : [],
        exact_source_evidence: Array.isArray(representation.exact_source_evidence)
          ? JSON.parse(JSON.stringify(representation.exact_source_evidence)) : []
      });
    });
  }

  if (!projected.relation || typeof projected.relation !== 'object' || Array.isArray(projected.relation)) {
    throw new Error('SC projection relation invalid');
  }
  merged.relation = Object.assign({}, merged.relation, {
    evidence: Array.isArray(projected.relation.evidence)
      ? JSON.parse(JSON.stringify(projected.relation.evidence)) : []
  });

  // Semantic identity is now guaranteed by construction; keep the assertion as a
  // defensive invariant against future edits to the merge seam.
  assertProjectionSemanticIdentity(truth, merged);
  return merged;
}

function buildProjectionRetryPrompt(basePrompt, error, retryIndex, maxRetries) {
  const message = String(error && error.message ? error.message : error || '').slice(0, 2400);
  return basePrompt + '\n\n【deterministic representation re-projection ' + retryIndex + '/' + maxRetries + '】\n' +
    '上一版只是在标准表示校验中失败；reviewed semantic authority、frozen inventory、candidate identity 与全部 semantic fields 继续冻结，禁止重新判断或改写。\n' +
    '只重新执行 representation/provenance 投影。若错误涉及 quote/source_span，不得猜测、拼接、规范化或同义改写原文；优先返回 source_span={start_line,end_line}，让 host 从当前 source 机械复制 exact bytes。\n' +
    '仍须返回一个完整严格 JSON authority；不得只返回 patch、解释或第二个对象。\n' +
    'deterministic gate error: ' + message;
}

async function runFidelityClosure(input) {
  const semanticAuthority = parseSemanticAuthority(input.authority);
  if (input.inventory) assertAuthorityInventoryCoverage(semanticAuthority, input.inventory);

  const baseProjectPrompt = buildProjectPrompt(
    input.sourceText, input.globalSemantic, semanticAuthority, input.inventory
  );
  const maxProjectionRetries = 3;
  let projectionRaw = '';
  let authority = null;
  let lastProjectionError = null;

  for (let attempt = 0; attempt <= maxProjectionRetries; attempt++) {
    const projectPrompt = attempt === 0
      ? baseProjectPrompt
      : buildProjectionRetryPrompt(baseProjectPrompt, lastProjectionError, attempt, maxProjectionRetries);
    projectionRaw = await callText(
      input.callModel,
      'sc-project',
      PROJECT_SYSTEM,
      projectPrompt,
      input.onStage
    );
    await emitStage(input.onStage, 'sc-project', 'validating', {
      attempt: attempt + 1,
      maxAttempts: maxProjectionRetries + 1
    });
    try {
      const representationOnly = mergeProjectionRepresentation(semanticAuthority, projectionRaw);
      const materialized = materializeProjectionEvidence(representationOnly, input.sourceText);
      const parsed = parseAuthority(materialized, input.sourceText);
      if (input.inventory) assertAuthorityInventoryCoverage(parsed, input.inventory);
      authority = parsed;
      lastProjectionError = null;
      await emitStage(input.onStage, 'sc-project', 'complete', {
        attempt: attempt + 1,
        maxAttempts: maxProjectionRetries + 1
      });
      break;
    } catch (e) {
      lastProjectionError = e;
      if (attempt >= maxProjectionRetries) {
        await emitStage(input.onStage, 'sc-project', 'failed', {
          attempt: attempt + 1,
          maxAttempts: maxProjectionRetries + 1,
          error: e && e.message ? e.message : String(e)
        });
        throw e;
      }
      await emitStage(input.onStage, 'sc-project', 'retrying', {
        attempt: attempt + 1,
        nextAttempt: attempt + 2,
        maxAttempts: maxProjectionRetries + 1,
        error: e && e.message ? e.message : String(e)
      });
    }
  }

  if (!authority) throw lastProjectionError || new Error('SC standard projection failed without authority');
  const projection = JSON.stringify(authority, null, 2);

  const fidelityRaw = await callText(input.callModel, 'sc-fidelity', FIDELITY_SYSTEM,
    buildFidelityPrompt(input.sourceText, input.globalSemantic, authority, input.inventory), input.onStage);
  const fidelity = await validateStage(input.onStage, 'sc-fidelity',
    () => parseFidelity(fidelityRaw, input.sourceText));
  const base = {
    authority,
    projection,
    projectionRaw,
    review: input.review,
    reviewRaw: input.reviewRaw,
    fidelity,
    fidelityRaw
  };
  if (fidelity.inventory_gap === true) return Object.assign({ status: 'inventory_gap' }, base);
  if (fidelity.decision === 'approve') return Object.assign({ status: 'approved' }, base);
  return Object.assign({ status: 'fidelity_rejected' }, base);
}

async function callAndParseReview(input) {
  const reviewRaw = await callText(input.callModel, 'sc-review', REVIEW_SYSTEM,
    buildReviewPrompt(input.sourceText, input.globalSemantic, input.candidate, input.issueText, input.inventory), input.onStage);
  // Review decides semantics once. A malformed wrapper is a representation failure and
  // fails closed; it must never trigger a second model call that re-interprets intent.
  const review = await validateStage(input.onStage, 'sc-review',
    () => parseReview(reviewRaw, input.sourceText, input.candidate, input.inventory));
  return { review, reviewRaw };
}

function parseInventoryOutput(input) {
  const raw = String(input.raw || '');
  return {
    inventory: parseInventory(raw, input.sourceText, input.pass),
    raw
  };
}

async function generateFrozenInventory(input) {
  const discoveryRaw = await callText(input.callModel, 'sc-inventory-discover', INVENTORY_SYSTEM,
    buildInventoryPrompt(input.sourceText, input.globalSemantic), input.onStage);
  const discoveryParsed = await validateStage(input.onStage, 'sc-inventory-discover', () => parseInventoryOutput({
    raw: discoveryRaw, pass: 'discovery', sourceText: input.sourceText
  }));
  const discoveryInventory = discoveryParsed.inventory;

  const reviewRaw = await callText(input.callModel, 'sc-inventory-review', INVENTORY_REVIEW_SYSTEM,
    buildInventoryReviewPrompt(input.sourceText, input.globalSemantic, discoveryInventory), input.onStage);
  const reviewedParsed = await validateStage(input.onStage, 'sc-inventory-review', () => parseInventoryOutput({
    raw: reviewRaw, pass: 'reviewed', sourceText: input.sourceText
  }));
  const reviewedInventory = reviewedParsed.inventory;

  return {
    inventoryA: discoveryInventory,
    inventoryB: reviewedInventory,
    inventory: reviewedInventory,
    inventoryRawA: discoveryParsed.raw,
    inventoryRawB: reviewedParsed.raw
  };
}

async function callAndParseAnalyze(input) {
  const raw = await callText(input.callModel, 'sc-analyze', ANALYZE_SYSTEM,
    buildAnalyzePrompt(input.sourceText, input.globalSemantic, input.inventory), input.onStage);
  const candidate = await validateStage(input.onStage, 'sc-analyze', () => {
    const parsed = parseSemanticAuthority(raw);
    if (input.inventory) assertAuthorityInventoryCoverage(parsed, input.inventory);
    return parsed;
  });
  return { candidate, analyzeRaw: raw };
}

async function generateReviewedSemantic(input) {
  input = input || {};
  const sourceText = String(input.sourceText || '');
  const globalSemantic = String(input.globalSemantic || '');
  if (!sourceText) throw new Error('SC authority requires full source text');
  if (!globalSemantic) throw new Error('SC authority requires reviewed global semantic');
  const frozen = await generateFrozenInventory({
    sourceText, globalSemantic, callModel: input.callModel, onStage: input.onStage
  });
  const analyzed = await callAndParseAnalyze({
    sourceText, globalSemantic, inventory: frozen.inventory, callModel: input.callModel, onStage: input.onStage
  });
  const analyzeRaw = analyzed.analyzeRaw;
  const candidate = analyzed.candidate;
  assertAuthorityInventoryCoverage(candidate, frozen.inventory);
  const initialReview = await callAndParseReview({
    sourceText, globalSemantic, candidate, inventory: frozen.inventory, issueText: input.issueText,
    callModel: input.callModel, onStage: input.onStage
  });
  const review = initialReview.review;
  const reviewRaw = initialReview.reviewRaw;
  const base = {
    candidate, review, analyzeRaw, reviewRaw,
    inventoryA: frozen.inventoryA, inventoryB: frozen.inventoryB, inventory: frozen.inventory,
    inventoryRawA: frozen.inventoryRawA, inventoryRawB: frozen.inventoryRawB
  };
  if (!review.authority) {
    return Object.assign({
      status: review.inventory_gap ? 'review_inventory_gap' : ('review_' + review.decision)
    }, base);
  }
  assertAuthorityInventoryCoverage(review.authority, frozen.inventory);
  return Object.assign({ status: 'reviewed', authority: parseSemanticAuthority(review.authority) }, base);
}

async function projectReviewedAuthority(input) {
  input = input || {};
  const sourceText = String(input.sourceText || '');
  const globalSemantic = String(input.globalSemantic || '');
  if (!sourceText) throw new Error('SC projection requires full source text');
  if (!globalSemantic) throw new Error('SC projection requires reviewed global semantic');
  const semanticAuthority = parseSemanticAuthority(input.authority);
  if (input.inventory) assertAuthorityInventoryCoverage(semanticAuthority, input.inventory);
  return runFidelityClosure({
    sourceText,
    globalSemantic,
    inventory: input.inventory || null,
    authority: semanticAuthority,
    review: input.review || null,
    reviewRaw: input.reviewRaw || '',
    callModel: input.callModel,
    onStage: input.onStage
  });
}

async function generateReviewedAuthority(input) {
  const semantic = await generateReviewedSemantic(input);
  if (semantic.status !== 'reviewed') return semantic;
  const closure = await projectReviewedAuthority({
    sourceText: input && input.sourceText,
    globalSemantic: input && input.globalSemantic,
    inventory: semantic.inventory,
    authority: semantic.authority,
    review: semantic.review,
    reviewRaw: semantic.reviewRaw,
    callModel: input && input.callModel,
    onStage: input && input.onStage
  });
  const base = Object.assign({}, semantic);
  delete base.status;
  delete base.authority;
  return Object.assign(base, closure);
}

async function reviewExistingAuthority(input) {
  input = input || {};
  const sourceText = String(input.sourceText || '');
  const globalSemantic = String(input.globalSemantic || '');
  if (!sourceText) throw new Error('SC reopen review requires full source text');
  if (!globalSemantic) throw new Error('SC reopen review requires reviewed global semantic');
  const candidate = parseAuthority(input.authority, sourceText);
  const inventory = input.inventory || null;
  if (inventory) assertAuthorityInventoryCoverage(candidate, inventory);
  const reviewResult = await callAndParseReview({
    sourceText, globalSemantic, candidate, inventory, issueText: input.issueText,
    callModel: input.callModel, onStage: input.onStage
  });
  const review = reviewResult.review;
  const reviewRaw = reviewResult.reviewRaw;
  if (review.decision !== 'revise' || !review.authority) {
    return {
      status: review.inventory_gap ? 'review_inventory_gap' : ('review_' + review.decision), candidate, review, reviewRaw
    };
  }
  const semanticAuthority = parseSemanticAuthority(review.authority);
  if (inventory) assertAuthorityInventoryCoverage(semanticAuthority, inventory);
  const closure = await runFidelityClosure({
    sourceText, globalSemantic, inventory, authority: semanticAuthority, review, reviewRaw,
    callModel: input.callModel, onStage: input.onStage
  });
  return Object.assign({ candidate }, closure);
}

function projectMainlineCompatibility(authority) {
  if (!authority || !authority.sides || !authority.sides.affirmative || !authority.sides.negative || !authority.relation) {
    throw new Error('SC mainline compatibility projection requires complete authority');
  }
  const formedSides = [];
  if (authority.sides.affirmative.phase_iii === 'formed') formedSides.push('正方');
  if (authority.sides.negative.phase_iii === 'formed') formedSides.push('反方');
  const completionParty = formedSides.length === 2 ? '双方' : (formedSides[0] || '无');
  const relationMap = {
    higher_order_cover: '上位覆盖',
    parallel_independent: '独立平行',
    apparent_double_actual_single: '假二真一',
    mutual_partial: '相互部分容纳',
    single_side: '不适用',
    none: '不适用',
    other_evidenced_relation: '其它有证据关系'
  };
  const legacyRelation = relationMap[authority.relation.type];
  if (!legacyRelation) throw new Error('SC mainline compatibility relation unsupported: ' + String(authority.relation.type || ''));
  return {
    formedSides,
    phaseIIIStatus: formedSides.length ? '已结晶' : '未结晶',
    completionParty,
    completion: formedSides.length ? '完成' : null,
    mainlineFamily: formedSides.length ? '1型' : null,
    legacyRelation,
    relationType: authority.relation.type,
    dominantSide: authority.relation.dominant_side
  };
}

function authorityMarkerValue(value) {
  return String(value == null ? '' : value).trim();
}

function parseBindingMarker(text) {
  const body = String(text || '');
  const re = /<!--SC_AUTHORITY_BINDING\s+revision=(\d+)\s+affirmative=(formed|not_formed|uncertain)\s+negative=(formed|not_formed|uncertain)\s+relation=(none|single_side|parallel_independent|higher_order_cover|apparent_double_actual_single|mutual_partial|other_evidenced_relation)\s+dominant=(affirmative|negative|none|both|uncertain)\s*-->/g;
  const matches = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    matches.push({
      revision: Number(m[1]),
      affirmative: m[2],
      negative: m[3],
      relation: m[4],
      dominant: m[5]
    });
  }
  if (matches.length !== 1) return { ok: false, error: 'SC_AUTHORITY_BINDING must appear exactly once', value: null };
  return { ok: true, error: null, value: matches[0] };
}

function checkR2Alignment(p2Text, current) {
  const errors = [];
  const authority = current && current.authority;
  const revision = Number(current && current.revision);
  if (!authority || !Number.isInteger(revision) || revision < 1) {
    return { ok: false, errors: ['SC authority current invalid'] };
  }

  // This boundary verifies only machine-authored binding metadata. It must not
  // infer SC semantic agreement from prose keywords, negation patterns, speaker
  // labels, or phrases such as “未形成/未结晶”. Source-grounded semantic
  // disagreement belongs to the SC_REOPEN_REQUEST -> independent review path.
  const parsed = parseBindingMarker(p2Text);
  if (!parsed.ok) return { ok: false, errors: [parsed.error] };
  const actual = parsed.value;
  const expected = {
    revision,
    affirmative: authority.sides.affirmative.phase_iii,
    negative: authority.sides.negative.phase_iii,
    relation: authority.relation.type,
    dominant: authority.relation.dominant_side
  };
  for (const [key, value] of Object.entries(expected)) {
    if (authorityMarkerValue(actual[key]) !== authorityMarkerValue(value)) {
      errors.push('SC_AUTHORITY_BINDING ' + key + ' mismatch: expected=' + value + ' actual=' + String(actual[key]));
    }
  }
  return { ok: errors.length === 0, errors };
}

function canonicalBindingMarker(current) {
  const authority = current && current.authority;
  const revision = Number(current && current.revision);
  if (!authority || !Number.isInteger(revision) || revision < 1) {
    throw new Error('SC canonical binding requires current authority');
  }
  return '<!--SC_AUTHORITY_BINDING revision=' + revision +
    ' affirmative=' + authority.sides.affirmative.phase_iii +
    ' negative=' + authority.sides.negative.phase_iii +
    ' relation=' + authority.relation.type +
    ' dominant=' + authority.relation.dominant_side + ' -->';
}

function stripBindingMarkers(text) {
  return String(text || '')
    .replace(/<!--SC_AUTHORITY_BINDING\s+revision=\d+\s+affirmative=(?:formed|not_formed|uncertain)\s+negative=(?:formed|not_formed|uncertain)\s+relation=(?:none|single_side|parallel_independent|higher_order_cover|apparent_double_actual_single|mutual_partial|other_evidenced_relation)\s+dominant=(?:affirmative|negative|none|both|uncertain)\s*-->/g, '')
    .replace(/^\s+/, '');
}

function injectCanonicalBinding(text, current) {
  const body = stripBindingMarkers(text);
  return canonicalBindingMarker(current) + (body ? '\n\n' + body : '\n');
}

function extractProjectionData(text) {
  const out = {};
  const re = /<!--DATA:\s*([^=\n]+)=([\s\S]*?)-->/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) out[String(m[1] || '').trim()] = String(m[2] || '').trim();
  return out;
}

function checkR2Projection(p2Text, current) {
  const authority = current && current.authority;
  if (!authority || !authority.sides || !authority.sides.affirmative || !authority.sides.negative || !authority.relation) {
    const issue = {
      rule: 'V10-SC-PROJECTION',
      severity: 'BLOCKING',
      authorityClass: 'authority_integrity',
      failureClass: 'authority_integrity',
      owner: 'host',
      repairMode: 'fail_closed',
      repairScope: 'authority',
      retryable: false,
      message: 'SC current authority invalid for R2 projection validation'
    };
    return { ok: false, errors: [issue.message], issues: [issue], expected: null, actual: null };
  }
  const compatibility = projectMainlineCompatibility(authority);
  const expected = {
    'S8.PhaseII.正方.有效数': String(Array.isArray(authority.sides.affirmative.candidates) ? authority.sides.affirmative.candidates.length : 0),
    'S8.PhaseII.反方.有效数': String(Array.isArray(authority.sides.negative.candidates) ? authority.sides.negative.candidates.length : 0),
    'S8.PhaseIII.状态': compatibility.phaseIIIStatus,
    'S8.PhaseIII.完成方': compatibility.completionParty,
    'S8.PhaseIII.⑥双方SC关系': compatibility.legacyRelation
  };
  if (compatibility.completion) expected['S8.SC完成度'] = compatibility.completion;
  if (compatibility.mainlineFamily) expected['S8.S11类型方向'] = compatibility.mainlineFamily;
  const actual = extractProjectionData(p2Text);
  const issues = [];
  for (const [key, value] of Object.entries(expected)) {
    if (String(actual[key] == null ? '' : actual[key]).trim() === String(value).trim()) continue;
    issues.push({
      rule: 'V10-SC-PROJECTION',
      severity: 'BLOCKING',
      authorityClass: 'consumer_contract',
      failureClass: 'consumer_contract',
      owner: 'model',
      repairMode: 'bounded_repair',
      repairScope: 'S8_DATA',
      retryable: true,
      field: key,
      expected: value,
      actual: actual[key] == null ? null : actual[key],
      message: 'R2 SC projection mismatch: ' + key + ' expected=' + value + ' actual=' + String(actual[key])
    });
  }
  return { ok: issues.length === 0, errors: issues.map(x => x.message), issues, expected, actual };
}

function buildAuthorityBlock(current) {
  const authority = current && current.authority;
  const revision = Number(current && current.revision);
  if (!authority || !Number.isInteger(revision) || revision < 1) throw new Error('SC authority block requires current authority');
  const compatibility = projectMainlineCompatibility(authority);
  return [
    '---',
    '## SC SEMANTIC AUTHORITY',
    '',
    'scope: SC_ONLY_NOT_FINAL_VERDICT',
    'revision: ' + revision,
    'source_sha256: ' + String(current.sourceSha256 || ''),
    'global_semantic_revision: ' + String(current.globalSemanticRevision || ''),
    'global_semantic_object_id: ' + String(current.globalSemanticObjectId || ''),
    'profile_id: ' + PROFILE_ID,
    'profile_bundle_sha256: ' + profileBundleSha256(),
    '',
    '本 authority 是当前 SC/Phase III 事实真源，只裁结构性交锋，不裁整场胜负。',
    'R2/S8 必须忠实映射；若发现 source-grounded 缺陷，只能输出一个 SC_REOPEN_REQUEST 交由独立 reviewer，不能静默另建 SC 真值。',
    'V10 分层纪律：sides.*.phase_iii 是“该方自己的 SC 是否 formed”的事实，relation 是“双方已形成/未形成的 SC 之间如何相互作用”的另一层事实。按《辩论筑基》C208，任何一方 phase_iii=formed 就表示场上已经存在完成的结构性交锋，因此主线必须进入 1 型族；relation 只能描述已形成 SC 之间的覆盖/并行/部分互容关系，不能把已形成 SC 降成 2 型。旧版⑥-b 不得再以“缺少额外比赛层统一决胜层”为由强制半完成/2b。若双方都 formed，S8.PhaseIII.完成方 必须表达为“双方”；mutual_partial 必须投影为“相互部分容纳”，不得压成“独立平行”。parallel_independent 仅表示两条已形成 SC 没有层级覆盖，也不得否定 1 型族。1d 仅在 relation=higher_order_cover 时成立；其它 relation 继续按 1a/1b/1c 的既有子型规则判断。',
    '兼容投影（机器生成，只用于把 current authority 映射到旧 S8/S11 表面；不得覆盖 authority）： ' + JSON.stringify(compatibility),
    '',
    JSON.stringify(authority, null, 2),
    '',
    'SC_AUTHORITY_BINDING 是 host 控制元数据，不是 Judge DATA。R2 模型不得输出或复制该注释；host 会在模型产物通过语义/表示处理后，根据 current authority 写入唯一 canonical binding。',
    '---'
  ].join('\n');
}

// C-R: bounded rich SC view for final adjudicative reconciliation.
// This is still SC_ONLY_NOT_FINAL_VERDICT: it exposes reviewed SC dependency semantics,
// not a winner, score, or motion-level final verdict.
function buildAdjudicativeConsumerView(current) {
  const authority = current && current.authority;
  const revision = Number(current && current.revision);
  if (!authority || !Number.isInteger(revision) || revision < 1 ||
      !authority.sides || !authority.sides.affirmative || !authority.sides.negative || !authority.relation) {
    throw new Error('SC adjudicative consumer view requires complete current authority');
  }
  const pickCandidate = candidate => {
    const c = candidate || {};
    const out = {
      id: String(c.id || ''),
      accepted_opponent_content: c.accepted_opponent_content,
      accepted_content_mode: c.accepted_content_mode,
      accepted_content_role_state: c.accepted_content_role_state,
      b_prime: c.b_prime,
      unified_conclusion: c.unified_conclusion,
      dependency_explanation: c.dependency_explanation,
      coverage: c.coverage || null
    };
    if (Array.isArray(c.exact_source_evidence)) out.exact_source_evidence = c.exact_source_evidence;
    if (Array.isArray(c.composition_chain)) out.composition_chain = c.composition_chain;
    return out;
  };
  const pickSide = side => ({
    phase_iii: side.phase_iii,
    candidates: Array.isArray(side.candidates) ? side.candidates.map(pickCandidate) : []
  });
  return {
    schema: 'judge-sc-adjudicative-consumer-v1',
    scope: 'SC_ONLY_NOT_FINAL_VERDICT',
    revision,
    sourceSha256: String(current.sourceSha256 || ''),
    contextSha256: current.contextSha256 || null,
    semanticObjectId: current.semanticObjectId || null,
    projectionObjectId: current.projectionObjectId || null,
    globalSemanticRevision: Number(current.globalSemanticRevision || 0) || null,
    globalSemanticObjectId: current.globalSemanticObjectId || null,
    sides: {
      affirmative: pickSide(authority.sides.affirmative),
      negative: pickSide(authority.sides.negative)
    },
    relation: {
      type: authority.relation.type,
      dominant_side: authority.relation.dominant_side,
      reason: authority.relation.reason,
      evidence: Array.isArray(authority.relation.evidence) ? authority.relation.evidence : []
    }
  };
}

function extractReopenRequest(text, sourceText) {
  const body = String(text || '');
  const re = /<!--SC_REOPEN_REQUEST\s*([\s\S]*?)-->/g;
  const matches = [];
  let m;
  while ((m = re.exec(body)) !== null) matches.push({ raw: m[0], json: m[1] });
  if (matches.length > 1) throw new Error('SC reopen request allows at most one control block');
  if (!matches.length) return { text: body, request: null };
  const doc = parseStrictJsonObject(matches[0].json, 'SC reopen request');
  const expectedRevision = Number(doc.expectedRevision);
  const issue = String(doc.issue || '').trim();
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('SC reopen expectedRevision must be positive integer');
  if (!issue) throw new Error('SC reopen issue required');
  const evidence = softAnchorEvidence(sourceText, doc.evidence || [], { label: 'SC reopen evidence', required: false });
  return {
    text: body.replace(matches[0].raw, '').trimEnd(),
    request: { expectedRevision, issue, evidence }
  };
}

module.exports = {
  AUTHORITY_SCHEMA,
  INVENTORY_SCHEMA,
  PROFILE_ID,
  INVENTORY_SYSTEM,
  INVENTORY_REVIEW_SYSTEM,
  ANALYZE_SYSTEM,
  REVIEW_SYSTEM,
  PROJECT_SYSTEM,
  FIDELITY_SYSTEM,
  EVIDENCE_QUOTE_PROTOCOL,
  CANDIDATE_SET_COMPLETENESS_PROTOCOL,
  HIERARCHICAL_COMPOSITION_PROTOCOL,
  RELATION_INDEPENDENCE_PROTOCOL,
  INVENTORY_FREEZE_PROTOCOL,
  TEMPORAL_ROLE_STATE_PROTOCOL,
  SEMANTIC_REPRESENTATION_SEPARATION_PROTOCOL,
  RELATION_TYPES,
  PHASE_STATES,
  stableStructuralJson,
  structuralJsonEqual,
  sha256Text,
  profileBundleSha256,
  parseStrictJsonObject,
  locateQuote,
  parseInventory,
  assertAuthorityInventoryCoverage,
  parseSemanticAuthority,
  parseAuthority,
  buildEvidenceLineIndex,
  buildSourceSpanCatalog,
  materializeProjectionEvidence,
  buildInventoryPrompt,
  buildInventoryReviewPrompt,
  buildAnalyzePrompt,
  buildReviewPrompt,
  buildProjectPrompt,
  buildFidelityPrompt,
  parseReview,
  parseFidelity,
  semanticProjectionSnapshot,
  assertProjectionSemanticIdentity,
  mergeProjectionRepresentation,
  parseInventoryOutput,
  generateFrozenInventory,
  callAndParseAnalyze,
  generateReviewedSemantic,
  projectReviewedAuthority,
  generateReviewedAuthority,
  reviewExistingAuthority,
  parseBindingMarker,
  checkR2Alignment,
  canonicalBindingMarker,
  stripBindingMarkers,
  injectCanonicalBinding,
  extractProjectionData,
  checkR2Projection,
  buildAuthorityBlock,
  buildAdjudicativeConsumerView,
  projectMainlineCompatibility,
  extractReopenRequest
};
