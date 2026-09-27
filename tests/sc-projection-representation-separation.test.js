'use strict';

const assert = require('assert');
const SC = require('../executor/sc-semantic-authority.js');

function candidate(id) {
  return {
    id,
    accepted_opponent_content: 'source-grounded pressure',
    accepted_content_mode: 'explicit',
    accepted_content_role_state: 'pressure remains active',
    b_prime: 'reviewed evaluation principle',
    unified_conclusion: 'reviewed unified conclusion',
    dependency_explanation: 'reviewed dependency explanation',
    element_modes: {
      accepted: 'explicit',
      b_prime: 'explicit',
      unified_conclusion: 'explicit'
    },
    coverage: {
      absorbed_pressures: ['pressure-a'],
      surviving_pressures: []
    },
    composition_chain: [],
    exact_source_evidence: []
  };
}

const truth = {
  schema: SC.AUTHORITY_SCHEMA,
  sides: {
    affirmative: { phase_iii: 'formed', candidates: [candidate('aff-1')] },
    negative: { phase_iii: 'formed', candidates: [candidate('neg-1')] }
  },
  relation: {
    type: 'mutual_partial',
    dominant_side: 'none',
    reason: 'reviewed relation truth',
    evidence: []
  },
  notes: 'reviewed semantic notes'
};

// Projection deliberately attempts to rewrite semantic truth while also supplying representation.
// The merge seam must ignore every semantic rewrite and import only representation/provenance fields.
const projection = JSON.parse(JSON.stringify(truth));
projection.notes = 'projection-only note that must never replace reviewed notes';
projection.sides.affirmative.phase_iii = 'not_formed';
projection.sides.affirmative.candidates[0].b_prime = 'projection attempted semantic rewrite';
projection.relation.type = 'higher_order_cover';
projection.relation.dominant_side = 'affirmative';
projection.relation.reason = 'projection attempted relation rewrite';
projection.sides.affirmative.candidates[0].composition_chain = [
  { function: 'accept', quote: 'q1', role: 'representation' }
];
projection.sides.affirmative.candidates[0].exact_source_evidence = [
  { function: 'accept', quote: 'q1' }
];
projection.sides.negative.candidates[0].composition_chain = [
  { function: 'b_prime', quote: 'q2', role: 'representation' }
];
projection.sides.negative.candidates[0].exact_source_evidence = [
  { function: 'b_prime', quote: 'q2' }
];
projection.relation.evidence = [{ quote: 'q3', reason: 'representation evidence' }];

const merged = SC.mergeProjectionRepresentation(truth, projection);

assert.deepStrictEqual(
  SC.semanticProjectionSnapshot(merged),
  SC.semanticProjectionSnapshot(truth),
  'projection must not change reviewed semantic truth'
);
assert.strictEqual(merged.notes, truth.notes);
assert.strictEqual(merged.sides.affirmative.candidates[0].b_prime, truth.sides.affirmative.candidates[0].b_prime);
assert.strictEqual(merged.relation.type, truth.relation.type);
assert.strictEqual(merged.relation.dominant_side, truth.relation.dominant_side);
assert.strictEqual(merged.sides.affirmative.candidates[0].composition_chain.length, 1);
assert.strictEqual(merged.sides.affirmative.candidates[0].exact_source_evidence.length, 1);
assert.strictEqual(merged.sides.negative.candidates[0].composition_chain.length, 1);
assert.strictEqual(merged.relation.evidence.length, 1);

const badIdentity = JSON.parse(JSON.stringify(projection));
badIdentity.sides.negative.candidates[0].id = 'neg-other';
assert.throws(
  () => SC.mergeProjectionRepresentation(truth, badIdentity),
  /candidate identity set changed/
);

console.log('PASS SC projection semantic/representation separation');
