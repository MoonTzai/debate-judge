'use strict';

const assert = require('assert');
const W = require('../executor/wayfinder-runtime.js');

let passed = 0;
function ok(name, fn) {
  try { fn(); console.log('PASS ' + name); passed++; }
  catch (e) { console.error('FAIL ' + name + ' :: ' + (e.stack || e)); process.exitCode = 1; }
}
function expectCode(name, code, fn) {
  ok(name, () => {
    let got = null;
    try { fn(); } catch (e) { got = e; }
    assert.ok(got, 'expected error');
    assert.strictEqual(got.code, code);
  });
}
function h(seed) { return W.sha256Utf8(seed); }

ok('P0 SHA-256 known vector: abc', () => assert.strictEqual(
  W.sha256Utf8('abc'),
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
));

const LEGACY_TYPE = 'LEGACY_GENERIC_SEMANTIC_RESULT';
const exactTypes = Array.from(new Set(Object.values(W.DESIGN_EXACT_19).flat()));
const allTypes = exactTypes.concat([LEGACY_TYPE]).sort();

const typeSet = W.buildTypeDeclarationSet(allTypes.map((type, i) => ({
  artifact_type_id: type,
  artifact_schema_id: 'schema_' + i,
  artifact_schema_hash: h('schema:' + type),
  self_discriminant_field_name: 'schema_id',
  self_discriminant_value: 'schema_' + i,
  declaration_version: 'fixture-v1'
})), 'fixture-v1');

const legacyRows = W.LEGACY_48_NODE_IDS.map(nodeId => {
  const row = { node_id: nodeId, production_output_artifact_type_ids: [LEGACY_TYPE] };
  row.row_hash = W.hashRecord(row, 'row_hash');
  return row;
});
const legacyBinding = {
  binding_schema_id: 'LEGACY_SEMANTIC_OUTPUT_REALIZATION_BINDING_SCHEMA_V1',
  a59_materialization_inventory_hash: W.ABI.a59MaterializationInventoryHash,
  design_main_authority_hash: W.ABI.mainDesignHash,
  design_matrix_authority_hash: W.ABI.matrixDesignHash,
  active_node_design_manifest_hash: W.ABI.activeNodeDesignManifestHash,
  production_semantic_result_type_declaration_set_hash: typeSet.declaration_set_hash,
  rows: legacyRows,
  binding_version: 'fixture-v1'
};
legacyBinding.legacy_semantic_output_realization_binding_hash = W.hashRecord(legacyBinding, 'legacy_semantic_output_realization_binding_hash');

const approval = {
  approval_schema_id: 'LEGACY_SEMANTIC_OUTPUT_REALIZATION_APPROVAL_SCHEMA_V1',
  legacy_semantic_output_realization_binding_hash: legacyBinding.legacy_semantic_output_realization_binding_hash,
  independent_interface_audit_artifact_hash: h('independent-audit-fixture'),
  audit_disposition: 'PASS',
  approval_version: 'fixture-v1'
};
approval.legacy_semantic_output_realization_approval_hash = W.hashRecord(approval, 'legacy_semantic_output_realization_approval_hash');

const built = W.buildRuntimeOutputManifest(legacyBinding, approval, typeSet);
const manifest = built.manifest;
const resolverBinding = W.buildResolverImplementationBinding({
  production_semantic_result_type_declaration_set_hash: typeSet.declaration_set_hash,
  node_resolver_implementation_hash: h('node-resolver'),
  web_resolver_implementation_hash: h('web-resolver'),
  parity_fixture_root_hash: h('parity-fixtures')
});

function artifactForType(typeId, extra) {
  const decl = typeSet.rows.find(r => r.artifact_type_id === typeId);
  const obj = Object.assign({ schema_id: decl.artifact_schema_id, payload: 'fixture' }, extra || {});
  const text = JSON.stringify(obj);
  return { text, hash: W.sha256Utf8(text) };
}

ok('1 production semantic-node output declaration rows = 67', () => assert.strictEqual(built.outputDeclarationSet.rows.length, 67));
ok('2 design-exact partition rows = 19', () => assert.strictEqual(W.EXACT_19_NODE_IDS.length, 19));
ok('3 legacy realization partition rows = 48', () => assert.strictEqual(W.LEGACY_48_NODE_IDS.length, 48));
ok('4 19 intersection 48 is empty', () => assert.strictEqual(W.EXACT_19_NODE_IDS.filter(x => W.LEGACY_48_NODE_IDS.includes(x)).length, 0));
ok('5 19 union 48 equals exact 67', () => assert.deepStrictEqual(W.ALL_67_SEMANTIC_NODE_IDS, built.outputDeclarationSet.rows.map(r => r.node_id)));

ok('6 all 19 output sets equal frozen binding', () => {
  for (const id of W.EXACT_19_NODE_IDS) assert.deepStrictEqual(built.outputDeclarationSet.rows.find(r => r.node_id === id).output_artifact_type_ids, W.DESIGN_EXACT_19[id]);
});
ok('7 all 48 output sets equal approved legacy binding', () => {
  for (const id of W.LEGACY_48_NODE_IDS) assert.deepStrictEqual(built.outputDeclarationSet.rows.find(r => r.node_id === id).output_artifact_type_ids, [LEGACY_TYPE]);
});
expectCode('8 no third output-set source accepted', 'legacy_unknown_node', () => {
  const bad = JSON.parse(JSON.stringify(legacyBinding));
  bad.rows[0].node_id = 'THIRD_SOURCE';
  bad.rows[0].row_hash = W.hashRecord(bad.rows[0], 'row_hash');
  bad.legacy_semantic_output_realization_binding_hash = W.hashRecord(bad, 'legacy_semantic_output_realization_binding_hash');
  W.validateLegacyBinding(bad, typeSet);
});
ok('9 semantic-result type declaration covers all output types', () => assert.strictEqual(W.assertTypeSetCoversOutputSet(built.outputDeclarationSet, typeSet), true));
ok('10 pure-node artifact types are not required by A59', () => assert.ok(!typeSet.rows.some(r => /PURE_NODE/.test(r.artifact_type_id))));

ok('11 Node/Web output manifest parity is byte-addressable', () => assert.strictEqual(W.hashRecord(manifest, 'runtime_semantic_node_output_type_set_manifest_hash'), manifest.runtime_semantic_node_output_type_set_manifest_hash));
ok('12 Node/Web resolver parity binding is explicit', () => assert.strictEqual(resolverBinding.resolver_contract_hash, W.ABI.typeResolutionAbiHash));

const sample = artifactForType(LEGACY_TYPE);
expectCode('13 exact artifact hash mismatch fail-close', 'artifact_bytes_hash_mismatch', () => W.resolveArtifactType({
  artifact_hash: h('wrong'), artifact_bytes: sample.text, type_declaration_set: typeSet, validate_typed_abi: () => true
}));
expectCode('14 invalid UTF-8 bytes fail-close after exact byte-hash verification', 'artifact_utf8_invalid', () => {
  const invalid = new Uint8Array([0xc3, 0x28]);
  W.resolveArtifactType({ artifact_hash: W.sha256Bytes(invalid), artifact_bytes: invalid, type_declaration_set: typeSet, validate_typed_abi: () => true });
});
expectCode('15 invalid JSON fail-close', 'artifact_json_invalid', () => {
  const t = '{"schema_id":';
  W.resolveArtifactType({ artifact_hash: h(t), artifact_bytes: t, type_declaration_set: typeSet, validate_typed_abi: () => true });
});
expectCode('16 duplicate JSON key fail-close', 'artifact_duplicate_key', () => {
  const decl = typeSet.rows.find(r => r.artifact_type_id === LEGACY_TYPE);
  const t = '{"schema_id":"' + decl.artifact_schema_id + '","schema_id":"' + decl.artifact_schema_id + '"}';
  W.resolveArtifactType({ artifact_hash: h(t), artifact_bytes: t, type_declaration_set: typeSet, validate_typed_abi: () => true });
});
expectCode('17 missing discriminant fail-close', 'type_discriminant_missing', () => {
  const t = '{"payload":"x"}';
  W.resolveArtifactType({ artifact_hash: h(t), artifact_bytes: t, type_declaration_set: typeSet, validate_typed_abi: () => true });
});
expectCode('18 unknown discriminant fail-close', 'type_discriminant_unknown', () => {
  const t = '{"schema_id":"unknown"}';
  W.resolveArtifactType({ artifact_hash: h(t), artifact_bytes: t, type_declaration_set: typeSet, validate_typed_abi: () => true });
});
expectCode('19 multiple matching discriminants fail-close', 'type_discriminant_ambiguous', () => {
  const a = typeSet.rows[0], b = typeSet.rows[1];
  const t = JSON.stringify({ schema_id: a.artifact_schema_id, other_schema_id: b.artifact_schema_id });
  const alt = W.buildTypeDeclarationSet([
    Object.assign({}, typeSet.rows[0], { self_discriminant_field_name: 'schema_id' }),
    Object.assign({}, typeSet.rows[1], { self_discriminant_field_name: 'other_schema_id' })
  ].map(r => ({
    artifact_type_id:r.artifact_type_id, artifact_schema_id:r.artifact_schema_id, artifact_schema_hash:r.artifact_schema_hash,
    self_discriminant_field_name:r.self_discriminant_field_name, self_discriminant_value:r.artifact_schema_id
  })), 'amb');
  W.resolveArtifactType({ artifact_hash: h(t), artifact_bytes: t, type_declaration_set: alt, validate_typed_abi: () => true });
});
expectCode('20 caller type claim cannot override resolved type', 'semantic_output_claim_mismatch', () => W.nodeCommitSemanticResult({
  node_id: W.LEGACY_48_NODE_IDS[0], runtime_manifest: manifest, resolver_binding: resolverBinding, type_declaration_set: typeSet,
  final_semantic_result_artifact_hash: sample.hash, final_semantic_result_artifact_bytes: sample.text,
  validate_typed_abi: () => true, claimed_semantic_result_artifact_type_id: 'WRONG'
}));

ok('21 allowed actual type passes membership', () => {
  const r = W.nodeCommitSemanticResult({
    node_id: W.LEGACY_48_NODE_IDS[0], runtime_manifest: manifest, resolver_binding: resolverBinding, type_declaration_set: typeSet,
    final_semantic_result_artifact_hash: sample.hash, final_semantic_result_artifact_bytes: sample.text, validate_typed_abi: () => true
  });
  assert.strictEqual(r.node_commit_granted, true);
});
expectCode('22 disallowed actual type blocks NODE_COMMIT', 'semantic_output_type_not_allowed', () => {
  const node = W.EXACT_19_NODE_IDS[0];
  W.nodeCommitSemanticResult({
    node_id: node, runtime_manifest: manifest, resolver_binding: resolverBinding, type_declaration_set: typeSet,
    final_semantic_result_artifact_hash: sample.hash, final_semantic_result_artifact_bytes: sample.text, validate_typed_abi: () => true
  });
});
ok('23 publication error explicitly preserves semantic artifact', () => {
  let e;
  try {
    W.nodeCommitSemanticResult({
      node_id: W.EXACT_19_NODE_IDS[0], runtime_manifest: manifest, resolver_binding: resolverBinding, type_declaration_set: typeSet,
      final_semantic_result_artifact_hash: sample.hash, final_semantic_result_artifact_bytes: sample.text, validate_typed_abi: () => true
    });
  } catch (x) { e = x; }
  assert.strictEqual(e.semantic_result_invalid, false);
  assert.strictEqual(e.semantic_artifact_preserved, true);
  assert.strictEqual(e.node_commit_blocked, true);
});
ok('24 exact typed-ABI validator is still required', () => {
  let e;
  try { W.resolveArtifactType({ artifact_hash: sample.hash, artifact_bytes: sample.text, type_declaration_set: typeSet }); } catch (x) { e = x; }
  assert.strictEqual(e.code, 'typed_abi_validator_required');
});
expectCode('25 valid discriminant plus invalid typed ABI fail-close', 'artifact_typed_abi_invalid', () => W.resolveArtifactType({
  artifact_hash: sample.hash, artifact_bytes: sample.text, type_declaration_set: typeSet, validate_typed_abi: () => false
}));
ok('26 resolver does not implement schema validation itself', () => {
  assert.ok(!Object.prototype.hasOwnProperty.call(W, 'validateJsonSchema'));
});

ok('27 same semantic artifact can recommit after mechanical repair', () => {
  const badManifest = JSON.parse(JSON.stringify(manifest));
  badManifest.runtime_semantic_node_output_type_set_manifest_hash = h('broken');
  let e;
  try {
    W.nodeCommitSemanticResult({
      node_id: W.LEGACY_48_NODE_IDS[0], runtime_manifest: badManifest, resolver_binding: resolverBinding, type_declaration_set: typeSet,
      final_semantic_result_artifact_hash: sample.hash, final_semantic_result_artifact_bytes: sample.text, validate_typed_abi: () => true
    });
  } catch (x) { e = x; }
  assert.strictEqual(e.semantic_artifact_preserved, true);
  const r = W.nodeCommitSemanticResult({
    node_id: W.LEGACY_48_NODE_IDS[0], runtime_manifest: manifest, resolver_binding: resolverBinding, type_declaration_set: typeSet,
    final_semantic_result_artifact_hash: sample.hash, final_semantic_result_artifact_bytes: sample.text, validate_typed_abi: () => true
  });
  assert.strictEqual(r.final_semantic_result_artifact_hash, sample.hash);
});
expectCode('28 resolver/output-manifest identity drift invalidates commit', 'resolver_type_set_manifest_mismatch', () => {
  const drift = Object.assign({}, resolverBinding, { production_semantic_result_type_declaration_set_hash: h('drift') });
  drift.resolver_implementation_binding_hash = W.hashRecord(drift, 'resolver_implementation_binding_hash');
  W.nodeCommitSemanticResult({
    node_id: W.LEGACY_48_NODE_IDS[0], runtime_manifest: manifest, resolver_binding: drift, type_declaration_set: typeSet,
    final_semantic_result_artifact_hash: sample.hash, final_semantic_result_artifact_bytes: sample.text, validate_typed_abi: () => true
  });
});
ok('29 legitimate multi-output design node stays multi-output', () => assert.strictEqual(W.DESIGN_EXACT_19.DECISION_POLICY_FREE_TEXT_ADMISSIBILITY_REVIEW.length, 2));
expectCode('30 claimed sharded-final type must equal resolved actual type', 'semantic_output_claim_mismatch', () => W.nodeCommitSemanticResult({
  node_id: W.LEGACY_48_NODE_IDS[0], runtime_manifest: manifest, resolver_binding: resolverBinding, type_declaration_set: typeSet,
  final_semantic_result_artifact_hash: sample.hash, final_semantic_result_artifact_bytes: sample.text,
  validate_typed_abi: () => true, claimed_semantic_result_artifact_type_id: 'PRIVATE_SHARD_PROOF'
}));
ok('31 private shard proof type is absent from 67 final output declaration', () => assert.ok(!allTypes.includes('PRIVATE_SHARD_PROOF')));

expectCode('32 runtime materializer cannot self-approve missing approval', 'legacy_approval_invalid', () => W.buildRuntimeOutputManifest(legacyBinding, null, typeSet));
ok('33 approval points to exact binding and independent PASS audit', () => {
  assert.strictEqual(W.validateLegacyApproval(approval, legacyBinding), approval);
  assert.strictEqual(approval.audit_disposition, 'PASS');
});
ok('34 runtime manifest has no self-byte-hash inside hash preimage', () => {
  const recomputed = W.hashRecord(manifest, 'runtime_semantic_node_output_type_set_manifest_hash');
  assert.strictEqual(recomputed, manifest.runtime_semantic_node_output_type_set_manifest_hash);
});
ok('35 materializer exposes only semantic-output plane, not deps/input/resume/pure rows', () => {
  for (const row of manifest.rows) {
    assert.deepStrictEqual(Object.keys(row).sort(), ['node_id','output_artifact_type_ids','row_hash','source_binding_hash','source_class'].sort());
  }
  assert.strictEqual(W.productionReadiness().production_semantic_execution_authorized, false);
});

if (!process.exitCode) console.log('=== WAYFINDER A59 TYPE-RESOLUTION PASS: 35/35 ABI fixtures + 1/1 SHA primitive ===');
