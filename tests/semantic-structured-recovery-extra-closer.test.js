'use strict';

const assert = require('assert');
const SW = require('../executor/semantic-workflow.js');

function mustRepair(input, algorithm) {
  const r = SW.repairStrictJsonSyntax(input, 'zero-model structural recovery regression');
  assert.strictEqual(r.repaired, true);
  assert.strictEqual(r.repair && r.repair.algorithm, algorithm);
  const doc = JSON.parse(r.text);
  assert.ok(doc && typeof doc === 'object' && !Array.isArray(doc));
  return r;
}

function mustFailClosed(input) {
  const r = SW.repairStrictJsonSyntax(input, 'zero-model structural recovery regression');
  assert.strictEqual(r.repaired, false);
  assert.throws(() => JSON.parse(r.text));
  return r;
}

// Real-bundle failure class: one complete top-level JSON object plus one isolated unmatched closer.
mustRepair('{"decision":"revise","semantic":"完整语义"}\n}', 'remove-single-trailing-unmatched-closer-v1');
mustRepair('{"a":"} ] {","b":[1,2]}\n}', 'remove-single-trailing-unmatched-closer-v1');

// Existing valid JSON must remain byte-semantically unchanged by recovery.
{
  const r = SW.repairStrictJsonSyntax('{"a":1}', 'valid');
  assert.strictEqual(r.repaired, false);
  assert.deepStrictEqual(JSON.parse(r.text), { a: 1 });
}

// Never swallow model prose, a second JSON value, repeated closers, or truncation.
mustFailClosed('{"a":1}\nexplanation');
mustFailClosed('{"a":1}\n{"b":2}');
mustFailClosed('{"a":1}}}');
mustFailClosed('{"a":1');

console.log('PASS semantic structured recovery: single trailing unmatched closer / anti-overkill');
