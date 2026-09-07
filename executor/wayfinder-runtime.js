'use strict';

const SHA256_K = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
];

const ABI = Object.freeze({
  typeResolutionAbiId: 'WAYFINDER_NODE_COMMIT_TYPE_RESOLUTION_ABI_V1',
  typeResolutionAbiHash: 'b803efa1d71a10d9a769573ec1a3e3320a40590e76376db66f379cfc4629dd7f',
  activeNodeDesignManifestId: 'ACTIVE_NODE_CONTRACT_MANIFEST_V21_A59',
  activeNodeDesignManifestHash: 'aec546b2aed0a1a0b22b59c29d7b76d284b51950c8f0069cb0ca75269d673b62',
  activeGraphContractId: 'ACTIVE_GRAPH_CONTRACT_V19_A59',
  activeGraphContractHash: '7d8cff43836e46d4f1b46420ca44914a977703820dfbae5d5310ba8c07ce4ede',
  activeRegistryContractId: 'ACTIVE_REGISTRY_CONTRACT_MANIFEST_V21_A59',
  activeRegistryContractHash: 'feafb30842228b5d7692a076c2720e6d1696d3a8347430db24c763d858d3b22f',
  a59MaterializationInventoryHash: '6677fdbcb46a938f2d1983c7e49ab3ebb8c653e63427b05f298eaaf506059a52',
  designExact19BindingHash: '683ee58e90ecad739c6f2ce4f3c5224da457b86a25027a1fe28a19ff27b0db5f',
  designExact19ValidationHash: '725c8f8482d1a642b54af3856a40d89f6065a8a825a448910f9b131f4082f34c',
  mainDesignHash: '888ba92821037222c23ff2bccc4a563c72895609430f136e24e5f0c0a03974f1',
  matrixDesignHash: 'e48200300b482f1181b5ce36a29e6e26bc9a6996cba4b37e7c84acd73a8eb499'
});

const DESIGN_EXACT_19 = Object.freeze({
  CHAIN_SEMANTIC_PLAN: ['CHAIN_SEMANTIC_PLAN_WORK_TERMINAL'],
  DECISION_POLICY_ASSESS: ['DECISION_POLICY_LEAF_TERMINAL_LEDGER'],
  DECISION_POLICY_FREE_TEXT_ADMISSIBILITY_REVIEW: ['DECISION_POLICY_ADMITTED_CONFIG', 'DECISION_POLICY_FREE_TEXT_ADMISSIBILITY_TERMINAL'],
  DECISION_POLICY_REDUCE: ['DECISION_POLICY_REDUCTION_TERMINAL_LEDGER'],
  DECISION_POLICY_SEMANTIC_PLAN: ['DECISION_POLICY_SEMANTIC_PLAN_WORK_TERMINAL'],
  DECISION_REVIEW_SEMANTIC_PLAN: ['DECISION_REVIEW_SEMANTIC_PLAN_WORK_TERMINAL'],
  DECISION_SEMANTIC_PLAN: ['DECISION_SEMANTIC_PLAN_WORK_TERMINAL'],
  FORMAT_RESOLUTION_REDUCE: ['FORMAT_RESOLUTION_ROOT'],
  FORMAT_RESOLUTION_SCAN_BATCH: ['FORMAT_EVIDENCE_TERMINAL_LEDGER'],
  JUDGE_CONTEXT_ADMISSIBILITY_REVIEW: ['JUDGE_CONTEXT_ADMISSIBILITY_TERMINAL'],
  LISTENER: ['LISTENER_LEAF_TERMINAL'],
  LISTENER_REDUCE: ['LISTENER_REDUCTION_TERMINAL_LEDGER'],
  LISTENER_SEMANTIC_PLAN: ['LISTENER_SEMANTIC_PLAN_WORK_TERMINAL'],
  R3_HOLISTIC_ADJUDICATE: ['R3_HOLISTIC_DECISION_TERMINAL'],
  REPORT_EDITORIAL_PLAN: ['REPORT_EDITORIAL_PLAN_WORK_TERMINAL'],
  REPORT_EDITORIAL_SEMANTIC_PLAN: ['REPORT_EDITORIAL_SEMANTIC_PLAN_WORK_TERMINAL'],
  RHETORIC_OBSERVE: ['RHETORIC_OBSERVATION_TERMINAL'],
  RHETORIC_SEMANTIC_PLAN: ['RHETORIC_SEMANTIC_PLAN_WORK_TERMINAL'],
  RHETORIC_SYNTHESIZE: ['RHETORIC_SYNTHESIS_TERMINAL']
});

const LEGACY_48_NODE_IDS = Object.freeze([
  'R1_UNIT_EVENT_DRAFT',
  'ORDINARY_UNIT_EVENT_COVERAGE_AUDIT',
  'R1_UNIT_EVENT_RECONCILE',
  'ORDINARY_GRAPH_ADJUDICATE',
  'ORDINARY_CLASH_ADJUDICATE',
  'SC-P',
  'SC-B',
  'SC_RELATION_COVERAGE_AUDIT',
  'SC_JOINT_TARGET_SCAN_BATCH',
  'SC_JOINT_TARGET_COMPONENT_ADJUDICATE',
  'SC_JOINT_RELATION_COVERAGE_AUDIT',
  'SC_RESPONSE_COMPOSITION_SCAN_BATCH',
  'SC_RESPONSE_COMPOSITION_COMPONENT_ADJUDICATE',
  'F_RESIDUAL_DISCOVERY',
  'RESPONSE_ALIGN',
  'F_EVENT_ADJUDICATE_FULL',
  'F_VARIANT_ADJUDICATE',
  'F_ATOMICITY_RELATION_ADJUDICATE',
  'F_ATOMICITY_COMPONENT_ADJUDICATE',
  'F_ATOMICITY_RECONCILE',
  'ARGUMENT_ALIGN',
  'CHAIN_COMPONENT_ADJUDICATE',
  'CHAIN_RULE_ALIGN',
  'SCOPE',
  'REL',
  'REL_RECONCILE',
  'SC-X',
  'R3_EVIDENCE_ASSESS',
  'R3_DIMENSION_SYNTHESIZE',
  'R3_GLOBAL_CONTEXT_SYNTHESIZE',
  'R3_GLOBAL_CONTEXT_REDUCE',
  'R3_FINAL_WORK_ADJUDICATE',
  'R3_FINAL_REDUCE',
  'DECISION_COHERENCE_REVIEW_LOCAL',
  'DECISION_REVIEW_GLOBAL_COHERENCE',
  'R3_SCENARIO_ADMISSIBILITY_ADJUDICATE',
  'DECISION_SENSITIVITY_REVIEW',
  'R5A',
  'R5B',
  'NARRATIVE_FACT_GUARD',
  'R5_FACT_REWRITE',
  'R7_EXISTING_SEMANTIC_REVIEW',
  'R7_TARGETED_REPAIR',
  'R7_REVIEW2',
  'R8_EXISTING_SEMANTIC_REVIEW',
  'R8_TARGETED_REPAIR',
  'R8_FACT_REVIEW2',
  'REPORT_PRODUCT_SURFACE_SATISFACTION_ADJUDICATE'
].sort());

const EXACT_19_NODE_IDS = Object.freeze(Object.keys(DESIGN_EXACT_19).sort());
const ALL_67_SEMANTIC_NODE_IDS = Object.freeze(EXACT_19_NODE_IDS.concat(LEGACY_48_NODE_IDS).sort());

function lexicalCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

class WayfinderContractError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'WayfinderContractError';
    this.code = code;
  }
}

class WayfinderPublicationError extends WayfinderContractError {
  constructor(code, message, artifactHash) {
    super(code, message);
    this.name = 'WayfinderPublicationError';
    this.semantic_result_invalid = false;
    this.semantic_conclusion_negated = false;
    this.semantic_owner_changed = false;
    this.semantic_artifact_preserved = true;
    this.final_semantic_result_artifact_hash = artifactHash || null;
    this.node_commit_blocked = true;
    this.descendants_locked = true;
    this.terminal_completion_granted = false;
  }
}

function assert(condition, code, message) {
  if (!condition) throw new WayfinderContractError(code, message);
}

function isHex64(s) {
  return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
}

function sortUniqueStrings(values, label) {
  assert(Array.isArray(values), 'array_required', label + ' must be array');
  const out = values.map(v => {
    assert(typeof v === 'string' && v.length > 0, 'string_required', label + ' entries must be non-empty strings');
    return v;
  }).slice().sort();
  for (let i = 1; i < out.length; i++) {
    assert(out[i] !== out[i - 1], 'duplicate_value', label + ' contains duplicate: ' + out[i]);
  }
  return out;
}

function assertLexicalUnique(values, label) {
  const sorted = sortUniqueStrings(values, label);
  assert(JSON.stringify(sorted) === JSON.stringify(values), 'noncanonical_order', label + ' must be lexical unique');
  return values;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).sort().forEach(k => { out[k] = canonicalValue(value[k]); });
    return out;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256Bytes(bytes) {
  assert(bytes instanceof Uint8Array, 'byte_array_required', 'SHA256 input must be Uint8Array');
  const data = Array.from(bytes);
  const bitLen = data.length * 8;
  data.push(0x80);
  while ((data.length % 64) !== 56) data.push(0);
  for (let b = 7; b >= 0; b--) data.push((Math.floor(bitLen / Math.pow(2, 8 * b)) & 0xff));
  const words = [];
  for (let i = 0; i < data.length; i += 4) {
    words.push(((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) | 0);
  }
  const rr = (x, n) => (x >>> n) | (x << (32 - n));
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  for (let blk = 0; blk < words.length; blk += 16) {
    const w = words.slice(blk, blk + 16);
    for (let t = 16; t < 64; t++) {
      const s0 = rr(w[t - 15], 7) ^ rr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rr(w[t - 2], 17) ^ rr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[t] + w[t]) | 0;
      const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  const hex = x => ('00000000' + (x >>> 0).toString(16)).slice(-8);
  return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4) + hex(h5) + hex(h6) + hex(h7);
}

function utf8Bytes(text) {
  return new TextEncoder().encode(String(text));
}

function sha256Utf8(text) {
  return sha256Bytes(utf8Bytes(text));
}

function hashRecord(record, hashField) {
  const copy = {};
  Object.keys(record).forEach(k => {
    if (k !== hashField) copy[k] = record[k];
  });
  return sha256Utf8(canonicalJson(copy));
}

function strictJsonParse(text) {
  text = String(text);
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const fail = (msg) => { throw new WayfinderContractError('artifact_json_invalid', msg + ' at ' + i); };
  const stringToken = () => {
    if (text[i] !== '"') fail('expected string');
    const start = i++;
    let escaped = false;
    while (i < text.length) {
      const ch = text[i++];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') {
        const raw = text.slice(start, i);
        try { return JSON.parse(raw); } catch (e) { fail('invalid string'); }
      }
      if (ch.charCodeAt(0) < 0x20) fail('control character in string');
    }
    fail('unterminated string');
  };
  const numberToken = () => {
    const m = text.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!m) fail('invalid number');
    i += m[0].length;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) fail('non-finite number');
    return n;
  };
  const value = () => {
    ws();
    const ch = text[i];
    if (ch === '"') return stringToken();
    if (ch === '{') return objectToken();
    if (ch === '[') return arrayToken();
    if (text.slice(i, i + 4) === 'true') { i += 4; return true; }
    if (text.slice(i, i + 5) === 'false') { i += 5; return false; }
    if (text.slice(i, i + 4) === 'null') { i += 4; return null; }
    if (ch === '-' || /\d/.test(ch || '')) return numberToken();
    fail('unexpected token');
  };
  const arrayToken = () => {
    const out = [];
    i++; ws();
    if (text[i] === ']') { i++; return out; }
    for (;;) {
      out.push(value()); ws();
      if (text[i] === ']') { i++; return out; }
      if (text[i] !== ',') fail('expected comma in array');
      i++; ws();
    }
  };
  const objectToken = () => {
    const out = {};
    const seen = new Set();
    i++; ws();
    if (text[i] === '}') { i++; return out; }
    for (;;) {
      ws();
      const key = stringToken();
      if (seen.has(key)) throw new WayfinderContractError('artifact_duplicate_key', 'duplicate JSON object key: ' + key);
      seen.add(key);
      ws();
      if (text[i] !== ':') fail('expected colon');
      i++;
      out[key] = value();
      ws();
      if (text[i] === '}') { i++; return out; }
      if (text[i] !== ',') fail('expected comma in object');
      i++; ws();
    }
  };
  const result = value();
  ws();
  if (i !== text.length) fail('trailing data');
  return result;
}

function validateStaticPartition() {
  assert(EXACT_19_NODE_IDS.length === 19, 'design_exact_count', 'design-exact node count must be 19');
  assert(LEGACY_48_NODE_IDS.length === 48, 'legacy_count', 'legacy node count must be 48');
  const intersection = EXACT_19_NODE_IDS.filter(x => LEGACY_48_NODE_IDS.includes(x));
  assert(intersection.length === 0, 'partition_overlap', '19/48 partition overlap: ' + intersection.join(','));
  assert(ALL_67_SEMANTIC_NODE_IDS.length === 67, 'semantic_count', 'semantic node union must be 67');
  Object.entries(DESIGN_EXACT_19).forEach(([nodeId, ids]) => {
    assertLexicalUnique(ids, 'DESIGN_EXACT_19.' + nodeId);
    assert(ids.length > 0, 'empty_output_set', nodeId + ' output set cannot be empty');
  });
  return true;
}

function validateTypeDeclarationSet(set) {
  assert(set && typeof set === 'object' && !Array.isArray(set), 'type_declaration_set_invalid');
  assert(Array.isArray(set.rows), 'type_declaration_rows_invalid');
  const ids = [];
  const schemaKeys = new Set();
  const discrKeys = new Set();
  let previous = null;
  for (const row of set.rows) {
    assert(row && typeof row === 'object' && !Array.isArray(row), 'type_declaration_row_invalid');
    assert(typeof row.artifact_type_id === 'string' && row.artifact_type_id, 'artifact_type_id_invalid');
    assert(typeof row.artifact_schema_id === 'string' && row.artifact_schema_id, 'artifact_schema_id_invalid');
    assert(isHex64(row.artifact_schema_hash), 'artifact_schema_hash_invalid');
    assert(row.encoding_kind === 'UTF8_JSON_OBJECT_V1', 'encoding_kind_invalid');
    assert(row.self_discriminant_field_name === 'schema_id' || /^[a-z][a-z0-9_]*_schema_id$/.test(row.self_discriminant_field_name || ''), 'discriminant_field_invalid');
    assert(row.self_discriminant_value === row.artifact_schema_id, 'discriminant_value_invalid');
    assert(typeof row.declaration_version === 'string' && row.declaration_version, 'declaration_version_invalid');
    assert(row.row_hash === hashRecord(row, 'row_hash'), 'type_declaration_row_hash_mismatch');
    if (previous !== null) assert(previous < row.artifact_type_id, 'type_declaration_order_invalid');
    previous = row.artifact_type_id;
    ids.push(row.artifact_type_id);
    const sk = row.artifact_schema_id + '@' + row.artifact_schema_hash;
    assert(!schemaKeys.has(sk), 'duplicate_schema_identity');
    schemaKeys.add(sk);
    const dk = row.self_discriminant_field_name + '=' + row.self_discriminant_value;
    assert(!discrKeys.has(dk), 'duplicate_discriminant_identity');
    discrKeys.add(dk);
  }
  sortUniqueStrings(ids, 'type declaration ids');
  assert(set.declaration_set_hash === hashRecord(set, 'declaration_set_hash'), 'type_declaration_set_hash_mismatch');
  return set;
}

function buildTypeDeclarationSet(rows, version) {
  const normalized = rows.map(row => {
    const r = {
      artifact_type_id: row.artifact_type_id,
      artifact_schema_id: row.artifact_schema_id,
      artifact_schema_hash: row.artifact_schema_hash,
      encoding_kind: 'UTF8_JSON_OBJECT_V1',
      self_discriminant_field_name: row.self_discriminant_field_name || 'schema_id',
      self_discriminant_value: row.self_discriminant_value || row.artifact_schema_id,
      declaration_version: row.declaration_version || version || 'V1'
    };
    r.row_hash = hashRecord(r, 'row_hash');
    return r;
  }).sort((a, b) => lexicalCompare(a.artifact_type_id, b.artifact_type_id));
  const set = {
    declaration_schema_id: 'SEMANTIC_RESULT_TYPE_DECLARATION_SET_SCHEMA_V1',
    rows: normalized,
    declaration_set_version: version || 'V1-A59'
  };
  set.declaration_set_hash = hashRecord(set, 'declaration_set_hash');
  return validateTypeDeclarationSet(set);
}

function validateLegacyBinding(binding, typeDeclarationSet) {
  validateTypeDeclarationSet(typeDeclarationSet);
  assert(binding && typeof binding === 'object', 'legacy_binding_invalid');
  assert(binding.binding_schema_id === 'LEGACY_SEMANTIC_OUTPUT_REALIZATION_BINDING_SCHEMA_V1', 'legacy_binding_schema_invalid');
  assert(binding.a59_materialization_inventory_hash === ABI.a59MaterializationInventoryHash, 'legacy_inventory_hash_mismatch');
  assert(binding.design_main_authority_hash === ABI.mainDesignHash, 'legacy_main_hash_mismatch');
  assert(binding.design_matrix_authority_hash === ABI.matrixDesignHash, 'legacy_matrix_hash_mismatch');
  assert(binding.active_node_design_manifest_hash === ABI.activeNodeDesignManifestHash, 'legacy_node_manifest_hash_mismatch');
  assert(binding.production_semantic_result_type_declaration_set_hash === typeDeclarationSet.declaration_set_hash, 'legacy_type_set_hash_mismatch');
  assert(Array.isArray(binding.rows) && binding.rows.length === 48, 'legacy_binding_count');
  const ids = [];
  for (const row of binding.rows) {
    assert(LEGACY_48_NODE_IDS.includes(row.node_id), 'legacy_unknown_node', row.node_id);
    assertLexicalUnique(row.production_output_artifact_type_ids, 'legacy outputs ' + row.node_id);
    assert(row.production_output_artifact_type_ids.length > 0, 'legacy_empty_output_set');
    row.production_output_artifact_type_ids.forEach(id => {
      assert(typeDeclarationSet.rows.some(r => r.artifact_type_id === id), 'legacy_unknown_artifact_type', id);
    });
    assert(row.row_hash === hashRecord(row, 'row_hash'), 'legacy_row_hash_mismatch', row.node_id);
    ids.push(row.node_id);
  }
  assert(JSON.stringify(ids) === JSON.stringify(LEGACY_48_NODE_IDS), 'legacy_binding_node_order_or_set_mismatch');
  assert(binding.legacy_semantic_output_realization_binding_hash === hashRecord(binding, 'legacy_semantic_output_realization_binding_hash'), 'legacy_binding_hash_mismatch');
  return binding;
}

function validateLegacyApproval(approval, binding) {
  assert(approval && typeof approval === 'object', 'legacy_approval_invalid');
  assert(approval.approval_schema_id === 'LEGACY_SEMANTIC_OUTPUT_REALIZATION_APPROVAL_SCHEMA_V1', 'legacy_approval_schema_invalid');
  assert(approval.legacy_semantic_output_realization_binding_hash === binding.legacy_semantic_output_realization_binding_hash, 'legacy_approval_binding_mismatch');
  assert(isHex64(approval.independent_interface_audit_artifact_hash), 'legacy_audit_hash_invalid');
  assert(approval.audit_disposition === 'PASS', 'legacy_audit_not_pass');
  assert(approval.legacy_semantic_output_realization_approval_hash === hashRecord(approval, 'legacy_semantic_output_realization_approval_hash'), 'legacy_approval_hash_mismatch');
  return approval;
}

function buildProductionOutputDeclarationSet(binding, approval, typeDeclarationSet) {
  validateLegacyBinding(binding, typeDeclarationSet);
  validateLegacyApproval(approval, binding);
  const rows = [];
  for (const nodeId of EXACT_19_NODE_IDS) {
    rows.push({ node_id: nodeId, output_artifact_type_ids: DESIGN_EXACT_19[nodeId].slice() });
  }
  for (const row of binding.rows) {
    rows.push({ node_id: row.node_id, output_artifact_type_ids: row.production_output_artifact_type_ids.slice() });
  }
  rows.sort((a, b) => lexicalCompare(a.node_id, b.node_id));
  assert(rows.length === 67, 'production_output_row_count');
  assert(JSON.stringify(rows.map(r => r.node_id)) === JSON.stringify(ALL_67_SEMANTIC_NODE_IDS), 'production_output_node_set_mismatch');
  const set = {
    declaration_schema_id: 'PRODUCTION_SEMANTIC_NODE_OUTPUT_DECLARATION_SET_SCHEMA_V1',
    rows,
    declaration_set_version: 'V1-A59'
  };
  set.declaration_set_hash = hashRecord(set, 'declaration_set_hash');
  return set;
}

function assertTypeSetCoversOutputSet(outputSet, typeSet) {
  validateTypeDeclarationSet(typeSet);
  const declared = new Set(typeSet.rows.map(r => r.artifact_type_id));
  const required = new Set();
  outputSet.rows.forEach(row => row.output_artifact_type_ids.forEach(id => required.add(id)));
  const missing = Array.from(required).filter(id => !declared.has(id)).sort();
  const extra = Array.from(declared).filter(id => !required.has(id)).sort();
  assert(missing.length === 0, 'type_declaration_missing', missing.join(','));
  assert(extra.length === 0, 'type_declaration_extra', extra.join(','));
  return true;
}

function buildRuntimeOutputManifest(binding, approval, typeDeclarationSet) {
  const outputSet = buildProductionOutputDeclarationSet(binding, approval, typeDeclarationSet);
  assertTypeSetCoversOutputSet(outputSet, typeDeclarationSet);
  const rows = outputSet.rows.map(row => {
    const sourceClass = EXACT_19_NODE_IDS.includes(row.node_id) ? 'DESIGN_EXACT_19' : 'APPROVED_LEGACY_REALIZATION_48';
    const r = {
      node_id: row.node_id,
      output_artifact_type_ids: row.output_artifact_type_ids.slice(),
      source_class: sourceClass,
      source_binding_hash: sourceClass === 'DESIGN_EXACT_19'
        ? ABI.designExact19BindingHash
        : binding.legacy_semantic_output_realization_binding_hash
    };
    r.row_hash = hashRecord(r, 'row_hash');
    return r;
  });
  const manifest = {
    manifest_schema_id: 'RUNTIME_SEMANTIC_NODE_OUTPUT_TYPE_SET_MANIFEST_SCHEMA_V1',
    materializer_id: 'SEMANTIC_NODE_OUTPUT_TYPE_SET_MATERIALIZER_V1',
    materializer_contract_hash: ABI.typeResolutionAbiHash,
    active_node_design_manifest_hash: ABI.activeNodeDesignManifestHash,
    a59_materialization_inventory_hash: ABI.a59MaterializationInventoryHash,
    design_exact_19_binding_hash: ABI.designExact19BindingHash,
    design_exact_19_validation_hash: ABI.designExact19ValidationHash,
    approved_legacy_semantic_output_realization_binding_hash: binding.legacy_semantic_output_realization_binding_hash,
    approved_legacy_semantic_output_realization_approval_hash: approval.legacy_semantic_output_realization_approval_hash,
    production_semantic_node_output_declaration_set_hash: outputSet.declaration_set_hash,
    production_semantic_result_type_declaration_set_hash: typeDeclarationSet.declaration_set_hash,
    semantic_node_count: 67,
    rows,
    design_exact_node_ids: EXACT_19_NODE_IDS.slice(),
    legacy_realization_node_ids: LEGACY_48_NODE_IDS.slice(),
    manifest_version: 'V1-A59'
  };
  manifest.runtime_semantic_node_output_type_set_manifest_hash = hashRecord(manifest, 'runtime_semantic_node_output_type_set_manifest_hash');
  return { manifest, outputDeclarationSet: outputSet };
}

function buildResolverImplementationBinding(args) {
  assert(args && typeof args === 'object', 'resolver_binding_args_invalid');
  assert(isHex64(args.production_semantic_result_type_declaration_set_hash), 'resolver_type_set_hash_invalid');
  assert(isHex64(args.node_resolver_implementation_hash), 'node_resolver_hash_invalid');
  assert(isHex64(args.web_resolver_implementation_hash), 'web_resolver_hash_invalid');
  assert(isHex64(args.parity_fixture_root_hash), 'resolver_parity_root_invalid');
  const b = {
    resolver_id: 'CANONICAL_ARTIFACT_TYPE_RESOLVER_V1',
    resolver_contract_hash: ABI.typeResolutionAbiHash,
    production_semantic_result_type_declaration_set_hash: args.production_semantic_result_type_declaration_set_hash,
    node_resolver_implementation_hash: args.node_resolver_implementation_hash,
    web_resolver_implementation_hash: args.web_resolver_implementation_hash,
    parity_fixture_root_hash: args.parity_fixture_root_hash,
    binding_version: 'V1-A59'
  };
  b.resolver_implementation_binding_hash = hashRecord(b, 'resolver_implementation_binding_hash');
  return b;
}

function validateResolverBinding(binding, manifest, typeSet) {
  assert(binding && typeof binding === 'object', 'resolver_binding_invalid');
  assert(binding.resolver_id === 'CANONICAL_ARTIFACT_TYPE_RESOLVER_V1', 'resolver_id_invalid');
  assert(binding.resolver_contract_hash === manifest.materializer_contract_hash, 'resolver_contract_hash_mismatch');
  assert(binding.production_semantic_result_type_declaration_set_hash === manifest.production_semantic_result_type_declaration_set_hash, 'resolver_type_set_manifest_mismatch');
  assert(binding.production_semantic_result_type_declaration_set_hash === typeSet.declaration_set_hash, 'resolver_type_set_actual_mismatch');
  assert(binding.resolver_implementation_binding_hash === hashRecord(binding, 'resolver_implementation_binding_hash'), 'resolver_binding_hash_mismatch');
  return binding;
}

function resolveArtifactType(args) {
  assert(args && typeof args === 'object', 'resolver_args_invalid');
  const artifactHash = args.artifact_hash;
  if (!isHex64(artifactHash)) throw new WayfinderContractError('artifact_hash_unresolved', 'artifact hash invalid');
  let bytes;
  if (typeof args.artifact_bytes === 'string') bytes = utf8Bytes(args.artifact_bytes);
  else if (args.artifact_bytes instanceof Uint8Array) bytes = args.artifact_bytes;
  else throw new WayfinderContractError('artifact_utf8_invalid', 'artifact bytes must be UTF-8 string/Uint8Array');
  if (sha256Bytes(bytes) !== artifactHash) throw new WayfinderContractError('artifact_bytes_hash_mismatch');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (e) { throw new WayfinderContractError('artifact_utf8_invalid', 'artifact bytes are not strict UTF-8'); }
  let parsed;
  try { parsed = strictJsonParse(text); }
  catch (e) {
    if (e && e.code) throw e;
    throw new WayfinderContractError('artifact_json_invalid', e.message);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new WayfinderContractError('artifact_top_level_not_object');
  const typeSet = validateTypeDeclarationSet(args.type_declaration_set);
  const candidates = Object.keys(parsed)
    .filter(k => k === 'schema_id' || /^[a-z][a-z0-9_]*_schema_id$/.test(k))
    .filter(k => typeof parsed[k] === 'string');
  if (!candidates.length) throw new WayfinderContractError('type_discriminant_missing');
  const matches = [];
  for (const key of candidates) {
    for (const row of typeSet.rows) {
      if (row.self_discriminant_field_name === key && row.self_discriminant_value === parsed[key]) matches.push(row);
    }
  }
  if (!matches.length) throw new WayfinderContractError('type_discriminant_unknown');
  const unique = Array.from(new Map(matches.map(r => [r.artifact_type_id, r])).values());
  if (unique.length !== 1) throw new WayfinderContractError('type_discriminant_ambiguous');
  const decl = unique[0];
  assert(typeof args.validate_typed_abi === 'function', 'typed_abi_validator_required');
  const typedOk = args.validate_typed_abi(parsed, decl);
  if (typedOk !== true) throw new WayfinderContractError('artifact_typed_abi_invalid');
  return decl.artifact_type_id;
}

function nodeCommitSemanticResult(args) {
  const artifactHash = args && args.final_semantic_result_artifact_hash;
  try {
    assert(args && typeof args === 'object', 'node_commit_args_invalid');
    const manifest = args.runtime_manifest;
    assert(manifest && typeof manifest === 'object', 'runtime_manifest_missing');
    assert(manifest.runtime_semantic_node_output_type_set_manifest_hash === hashRecord(manifest, 'runtime_semantic_node_output_type_set_manifest_hash'), 'runtime_manifest_hash_mismatch');
    assert(manifest.materializer_contract_hash === ABI.typeResolutionAbiHash, 'runtime_manifest_contract_mismatch');
    assert(manifest.a59_materialization_inventory_hash === ABI.a59MaterializationInventoryHash, 'runtime_manifest_inventory_mismatch');
    assert(manifest.design_exact_19_binding_hash === ABI.designExact19BindingHash, 'runtime_manifest_design19_mismatch');
    assert(manifest.design_exact_19_validation_hash === ABI.designExact19ValidationHash, 'runtime_manifest_design19_validation_mismatch');
    const row = manifest.rows.find(r => r.node_id === args.node_id);
    assert(row && manifest.rows.filter(r => r.node_id === args.node_id).length === 1, 'runtime_manifest_node_row_missing_or_ambiguous');
    validateResolverBinding(args.resolver_binding, manifest, args.type_declaration_set);
    const typeId = resolveArtifactType({
      artifact_hash: artifactHash,
      artifact_bytes: args.final_semantic_result_artifact_bytes,
      type_declaration_set: args.type_declaration_set,
      validate_typed_abi: args.validate_typed_abi
    });
    assert(row.output_artifact_type_ids.includes(typeId), 'semantic_output_type_not_allowed', typeId + ' not allowed for ' + args.node_id);
    if (args.claimed_semantic_result_artifact_type_id != null) {
      assert(args.claimed_semantic_result_artifact_type_id === typeId, 'semantic_output_claim_mismatch');
    }
    return {
      ok: true,
      node_id: args.node_id,
      artifact_type_id: typeId,
      final_semantic_result_artifact_hash: artifactHash,
      node_commit_granted: true,
      semantic_result_invalid: false
    };
  } catch (e) {
    const code = e && e.code ? e.code : 'node_commit_publication_failure';
    throw new WayfinderPublicationError(code, e && e.message ? e.message : String(e), artifactHash);
  }
}

function productionReadiness() {
  return Object.freeze({
    type_resolution_runtime_implemented: true,
    design_exact_19_embedded: true,
    legacy_48_realization_binding_present: false,
    legacy_48_independent_audit_pass: false,
    legacy_48_approval_present: false,
    production_67_output_declaration_set_materialized: false,
    production_semantic_result_type_declaration_set_materialized: false,
    runtime_output_manifest_materialized: false,
    resolver_node_web_parity_binding_materialized: false,
    production_semantic_execution_authorized: false
  });
}

validateStaticPartition();

module.exports = {
  ABI,
  DESIGN_EXACT_19,
  EXACT_19_NODE_IDS,
  LEGACY_48_NODE_IDS,
  ALL_67_SEMANTIC_NODE_IDS,
  WayfinderContractError,
  WayfinderPublicationError,
  canonicalJson,
  sha256Bytes,
  sha256Utf8,
  hashRecord,
  strictJsonParse,
  validateStaticPartition,
  buildTypeDeclarationSet,
  validateTypeDeclarationSet,
  validateLegacyBinding,
  validateLegacyApproval,
  buildProductionOutputDeclarationSet,
  assertTypeSetCoversOutputSet,
  buildRuntimeOutputManifest,
  buildResolverImplementationBinding,
  validateResolverBinding,
  resolveArtifactType,
  nodeCommitSemanticResult,
  productionReadiness
};
