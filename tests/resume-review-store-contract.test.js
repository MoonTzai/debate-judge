'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const workflowSource = fs.readFileSync(path.join(__dirname, '..', 'executor', 'semantic-workflow.js'), 'utf8');

// Canonical semantic-production-store.readObject(ref) returns only { content, metadata }.
// Object identity/kind remains on the immutable ref supplied to readObject.
assert.ok(!workflowSource.includes("recoveredRaw.kind !== 'raw'"));
assert.ok(workflowSource.includes("input.resumeReviewRawRef.kind !== 'raw'"));
assert.ok(workflowSource.includes("rm.role !== 'review'"));
assert.ok(workflowSource.includes("rm.sourceSha256 !== source.sourceSha256"));
assert.ok(workflowSource.includes("(rm.contextSha256 || null) !== (source.contextSha256 || null)"));

console.log('PASS resume review raw/store contract alignment');
