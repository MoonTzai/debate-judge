'use strict';

const assert = require('assert');
const { createEngine } = require('../web/src/engine.js');

const workDir = '/Output/judge-regression-published-precore';
function makeVfs() {
  const data = {};
  return {
    existsSync: p => Object.prototype.hasOwnProperty.call(data, p),
    readFileSync: p => { if (!(p in data)) throw new Error('ENOENT ' + p); return data[p]; },
    writeFileSync: (p, v) => { data[p] = String(v); },
    unlinkSync: p => { delete data[p]; },
    removeTree: p => { Object.keys(data).forEach(k => { if (k === p || k.indexOf(p + '/') === 0) delete data[k]; }); },
    restore: files => { Object.keys(files || {}).forEach(k => { data[k] = String(files[k]); }); },
    snapshot: prefix => {
      const out = {};
      Object.keys(data).forEach(k => { if (k.indexOf(prefix) === 0) out[k] = data[k]; });
      return out;
    }
  };
}
const vfs = makeVfs();
const current = { revision: 1, semanticRef: { objectId: 'semantic-1' }, projectionRef: { objectId: 'projection-1' } };
const provenance = { consumerBinding: { views: {} } };
const host = {
  readTestSemanticCurrent: () => current,
  readTestProvenance: () => provenance,
  validateTestProvenance: () => provenance,
  resolveConsumerBinding: (base, binding, required) => {
    const views = binding && binding.views || {};
    (required || []).forEach(name => { if (!views[name]) throw new Error('missing required consumer view: ' + name); });
    return { mode: 'semantic-bound', views };
  }
};
const api = { requestCompletion: async () => { throw new Error('paid call forbidden in test'); }, resolveConfig: () => ({}) };
const bundle = {
  vfs,
  testSemantic: { schema: 'judge-production-semantic-profile-v2', mode: 'active' },
  modules: {
    pipelineController: () => ({
      canonicalResumeNode: x => x || 'auto',
      planResumeStart: () => ({}),
      resumeInvalidationNames: () => [],
      resumeNodeOrder: []
    }),
    hostNode: () => host,
    semanticWorkflow: () => ({ createWorkflow() {}, parseReviewDecision() {}, parseFidelityDecision() {} }),
    apiProvider: () => api,
    tendency: () => ({ depthBlockText: () => '' }),
    judgeContext: () => ({ normalizeJudgeContext: x => x || { enabled: false }, projectJudgeContext: () => '' }),
    core: () => ({ ROUNDS: [] })
  }
};
const engine = createEngine(bundle, {});

const files = {};
files[workDir + '/.tmp-debate.txt'] = 'debate source';
files[workDir + '/semantic-first-provenance.json'] = JSON.stringify(provenance);
files[workDir + '/.semantic-first-production-v1/test-active-current/current.json'] = JSON.stringify(current);
files[workDir + '/source-anchor.json'] = JSON.stringify({ stale: 'unbound-pre-core-control-cache' });

const classified = engine.classifySessionFilesForExport(files, workDir);
assert.strictEqual(classified.authorityState, 'published-pre-core');
assert.strictEqual(classified.resumeClass, 'published-pre-core-semantic');
assert.strictEqual(classified.canResume, true);
assert.strictEqual(classified.published, true);
assert.deepStrictEqual(classified.coreArtifacts, []);
assert.deepStrictEqual(classified.unboundControlCandidates, ['source-anchor.json']);

const restored = engine.restoreRecoverableTestSession(files, workDir);
assert.strictEqual(restored.authorityState, 'published-pre-core');
assert.strictEqual(restored.canResume, true);
assert.deepStrictEqual(restored.discardedUnboundControls, ['source-anchor.json']);
assert.strictEqual(vfs.existsSync(workDir + '/source-anchor.json'), false);
assert.strictEqual(vfs.existsSync(workDir + '/.tmp-debate.txt'), true);
assert.strictEqual(vfs.existsSync(workDir + '/semantic-first-provenance.json'), true);

// Once a core artifact exists, an unbound source-anchor is no longer a disposable pre-core cache.
const withCore = Object.assign({}, files);
withCore[workDir + '/P1.md'] = 'core output';
const blocked = engine.classifySessionFilesForExport(withCore, workDir);
assert.strictEqual(blocked.canResume, false);
assert.strictEqual(blocked.resumeClass, 'evidence-only');

console.log('PASS published semantic pre-core recovery boundary');
