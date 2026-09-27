'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const SW = require('../executor/semantic-workflow.js');

function repair(input) {
  return SW.repairStrictJsonSyntax(input, 'mechanical-vs-llm-boundary');
}

// Mechanical layer: only uniquely semantics-preserving syntax/envelope edits.
assert.strictEqual(repair('{"a":1}').repaired, false);
assert.strictEqual(repair('{"a":1,}').repair.algorithm, 'remove-trailing-comma-v1');
assert.strictEqual(repair('{"a":1}\n}').repair.algorithm, 'remove-single-trailing-unmatched-closer-v1');
assert.strictEqual(repair('```json\n{"a":1}\n```').repair.algorithm, 'unwrap-json-fence-v1');

// Anything requiring interpretation remains invalid for the mechanical layer.
for (const text of [
  '{"a":1}\nexplanation',
  '{"a":1}\n{"b":2}',
  '{"a":1}}}',
  '{"a":1'
]) {
  const got = repair(text);
  assert.strictEqual(got.repaired, false);
  assert.throws(() => JSON.parse(got.text));
}

// Exact-source location is mechanical only when the quote has one unique source span.
// Repeated verbatim text is a semantic-location ambiguity: code must not silently bind "the first one".
{
  const source = '正方：我们接受这个标准。\n反方：转述：我们接受这个标准。';
  const unique = SW.anchorEvidence(source, [{ quote: '正方：我们接受这个标准。', reason: 'unique' }], {
    label: 'boundary unique evidence',
    required: true
  });
  assert.strictEqual(unique.length, 1);
  assert.strictEqual(unique[0].charStart, 0);

  let ambiguousError = null;
  try {
    SW.anchorEvidence(source, [{ quote: '我们接受这个标准。', reason: 'ambiguous' }], {
      label: 'boundary ambiguous evidence',
      required: true
    });
  } catch (error) {
    ambiguousError = error;
  }
  assert.ok(ambiguousError);
  assert.strictEqual(ambiguousError.code, 'SOURCE_EVIDENCE_AMBIGUOUS');
  assert.strictEqual(ambiguousError.matchCount, 2);

  const soft = SW.softAnchorEvidence(source, [{ quote: '我们接受这个标准。', reason: 'hint only' }], {
    label: 'boundary soft evidence',
    required: false
  });
  assert.strictEqual(soft.length, 1);
  assert.ok(/multiple source spans/.test(String(soft[0].provenance_error || '')));
  assert.strictEqual(Object.prototype.hasOwnProperty.call(soft[0], 'charStart'), false);
}

const workflowSource = fs.readFileSync(path.join(__dirname, '..', 'executor', 'semantic-workflow.js'), 'utf8');
const hostSource = fs.readFileSync(path.join(__dirname, '..', 'executor', 'host-node.js'), 'utf8');

// Semantic contract failures get one bounded LLM re-review/re-fidelity, never a loop.
assert.strictEqual((workflowSource.match(/-review-semantic-retry-1/g) || []).length, 1);
assert.strictEqual((workflowSource.match(/-fidelity-semantic-retry-1/g) || []).length, 1);
assert.ok(workflowSource.includes('这不是让你机械修补上一份文本'));
assert.ok(workflowSource.includes('原结论可以保持，也可以在重新理解后改变'));
assert.ok(workflowSource.includes('A valid fidelity reject is a real semantic/representation verdict'));

// Multiple valid semantic candidates/reviews must not be mechanically ranked.
assert.ok(!hostSource.includes('multiple source-bound pre-current analyze candidates; explicit audit required'));
assert.ok(!hostSource.includes('multiple replayable pre-current review raws; explicit audit required'));
assert.ok(hostSource.includes("repairTarget: 'semantic_reanalysis'"));
assert.ok(hostSource.includes('不机械择一'));
assert.ok(hostSource.includes('重新交由 LLM 语义'));

console.log('PASS semantic mechanical/LLM boundary');
