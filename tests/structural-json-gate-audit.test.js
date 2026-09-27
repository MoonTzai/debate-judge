'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const host = require('../executor/host-node.js');
const SCA = require('../executor/sc-semantic-authority.js');

// JSON object key order is representation, not semantic/value identity.
// Arrays remain ordered; field presence and values remain exact.
const a = { z: 1, nested: { b: 2, a: 3 }, rows: [{ y: 2, x: 1 }, { id: 'b' }] };
const b = { rows: [{ x: 1, y: 2 }, { id: 'b' }], nested: { a: 3, b: 2 }, z: 1 };
assert.strictEqual(host.structuralJsonEqual(a, b), true);
assert.strictEqual(SCA.structuralJsonEqual(a, b), true);
assert.strictEqual(JSON.stringify(a) === JSON.stringify(b), false);
assert.strictEqual(host.structuralJsonEqual({ rows: [1, 2] }, { rows: [2, 1] }), false);
assert.strictEqual(host.structuralJsonEqual({ a: 1 }, { a: 1, b: null }), false);
assert.strictEqual(host.structuralJsonEqual({ a: 1 }, { a: 2 }), false);

// Exact real-shape regression from Judge-Debug-Bundle-20260927-003402.
// The old gate failed solely because validator-enriched evidence keys were inserted
// in a different object-key order from the published canonical authority.
const workspaceRoot = path.resolve(__dirname, '..', '..', '..');
const filesPath = path.join(workspaceRoot, 'Upload', '实测', 'V10',
  'Judge-Debug-Bundle-20260927-003402', 'session', 'files.json');

if (fs.existsSync(filesPath)) {
  const files = JSON.parse(fs.readFileSync(filesPath, 'utf8'));
  const keys = Object.keys(files);
  const currentKey = keys.find(k => /\/test-sc-current\/current\.json$/.test(k));
  const sourceKey = keys.find(k => /\.tmp-debate\.txt$/.test(k));
  assert.ok(currentKey && sourceKey, 'real bundle must expose SC current + source');

  const current = JSON.parse(files[currentKey]);
  const prefix = currentKey.slice(0, currentKey.length - 'current.json'.length);
  const semanticKey = prefix + 'objects/' + current.semanticRef.objectId + '.txt';
  const projectionMetaKey = prefix + 'objects/' + current.projectionRef.objectId + '.meta.json';
  const projectionMeta = JSON.parse(files[projectionMetaKey]);
  const rawRef = projectionMeta.metadata && projectionMeta.metadata.rawRef;
  assert.ok(rawRef && rawRef.objectId, 'projection must bind immutable sc-project raw');
  const rawKey = prefix + 'objects/' + rawRef.objectId + '.txt';

  const source = files[sourceKey];
  const authority = SCA.parseAuthority(files[semanticKey], source);
  const projectedFromRaw = SCA.parseAuthority(
    SCA.materializeProjectionEvidence(files[rawKey], source), source);

  assert.strictEqual(host.structuralJsonEqual(projectedFromRaw, authority), true,
    'real 003402 projection must be structurally identical to published authority');
  assert.strictEqual(JSON.stringify(projectedFromRaw) === JSON.stringify(authority), false,
    'real 003402 must reproduce the old key-order-only false positive');
  assert.deepStrictEqual(
    SCA.semanticProjectionSnapshot(projectedFromRaw),
    SCA.semanticProjectionSnapshot(authority),
    'real 003402 semantic truth must be identical'
  );
}

const hostSource = fs.readFileSync(path.join(__dirname, '..', 'executor', 'host-node.js'), 'utf8');
const scSource = fs.readFileSync(path.join(__dirname, '..', 'executor', 'sc-semantic-authority.js'), 'utf8');

assert.ok(hostSource.includes('!structuralJsonEqual(projectedFromRaw, authority)'));
assert.ok(!hostSource.includes('JSON.stringify(projectedFromRaw) !== JSON.stringify(authority)'));
assert.ok(!scSource.includes('JSON.stringify(before) !== JSON.stringify(after)'));
assert.ok(!hostSource.includes('JSON.stringify(normalizeReopenEvidenceForCompare(row.evidence)) !=='));
assert.ok(hostSource.includes('!structuralJsonEqual(normalizeReopenEvidenceForCompare(row.evidence),'));

// The only remaining direct host stringify inequalities are deliberate canonical-byte
// bindings, not parsed-object equality gates.
const remaining = hostSource.match(/!== JSON\.stringify\(/g) || [];
assert.strictEqual(remaining.length, 2);
assert.ok(hostSource.includes("String(projectionObj.content) !== JSON.stringify(authority, null, 2)"));
assert.ok(hostSource.includes("String(journalObj.content) !== JSON.stringify(expectedJournal, null, 2)"));

console.log('PASS structural JSON gate audit + real 003402 key-order regression');
