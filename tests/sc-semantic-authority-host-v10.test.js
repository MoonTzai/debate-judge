'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

// The V10 source tree is an overlay, not a second fork of the complete V9 runtime.
// During source-level preflight, resolve only missing executor dependencies from the
// frozen V9 base. After build-v10-runtime copies the base into runtime-generated,
// these local files exist and this fallback becomes a no-op.
const V10_ROOT = path.resolve(__dirname, '..');
const V10_EXECUTOR = path.join(V10_ROOT, 'executor');
const V9_ROOT = path.resolve(V10_ROOT, '..', 'SemanticFirst-E2E-V9-Production-Release-Candidate-20260917');
const V9_EXECUTOR = path.join(V9_ROOT, 'executor');
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function v10OverlayResolve(request, parent, isMain, options) {
  if (parent && parent.filename && /^\.\.?[\\/]/.test(request)) {
    const parentFile = path.resolve(parent.filename);
    const inV10Overlay = parentFile === V10_ROOT || parentFile.startsWith(V10_ROOT + path.sep);
    if (inV10Overlay) {
      const local = path.resolve(path.dirname(parentFile), request);
      if (!fs.existsSync(local)) {
        const rel = path.relative(V10_ROOT, local);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
          const fallback = path.join(V9_ROOT, rel);
          if (fs.existsSync(fallback)) return fallback;
        }
      }
    }
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};
function executorModule(name) {
  const local = path.join(V10_EXECUTOR, name);
  return require(fs.existsSync(local) ? local : path.join(V9_EXECUTOR, name));
}

const Host = executorModule('host-node.js');
const Store = executorModule('semantic-production-store.js');
const SCA = executorModule('sc-semantic-authority.js');

const SOURCE = [
  '正方：我承认夜间公交需要额外财政支出。',
  '反方：财政有限，夜间客流又少，所以不该建设。',
  '正方：公共服务不是只有满载时才有价值，它还保障夜间劳动者能够安全回家。',
  '正方：即使多花一些钱，只要它填补基本出行缺口，这笔成本也不能单独否定建设。',
  '反方：我仍认为应把有限财政优先给白天多数人。'
].join('\n');
const GLOBAL = '双方围绕财政约束与基本可达性展开真实比较；应同时保留额外成本压力与夜间劳动者出行价值。';

function sha(text) { return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'); }
function authority(note) {
  return {
    schema: 'judge-sc-semantic-authority-v1',
    sides: {
      affirmative: {
        phase_iii: 'formed',
        candidates: [{
          id: 'AFF-1',
          accepted_opponent_content: '财政有限且夜间公交会产生额外财政支出。',
          accepted_content_mode: 'explicit',
          accepted_content_role_state: '财政压力仍存活，但不是自动否决结论。',
          b_prime: '公共服务的基本可达性与夜间劳动者安全。',
          unified_conclusion: '即使存在额外财政成本，只要填补基本出行缺口，成本本身不足以否定建设。',
          dependency_explanation: '先显性接收额外成本，再以基本可达性重定位成本的决胜权重，随后形成统一结论。',
          composition_chain: [
            { function: 'accept', quote: '我承认夜间公交需要额外财政支出。' },
            { function: 'b_prime', quote: '公共服务不是只有满载时才有价值，它还保障夜间劳动者能够安全回家。' },
            { function: 'unify', quote: '即使多花一些钱，只要它填补基本出行缺口，这笔成本也不能单独否定建设。' }
          ],
          exact_source_evidence: [
            { quote: '我承认夜间公交需要额外财政支出。', role: 'accepted_opponent_content' },
            { quote: '公共服务不是只有满载时才有价值，它还保障夜间劳动者能够安全回家。', role: 'b_prime' },
            { quote: '即使多花一些钱，只要它填补基本出行缺口，这笔成本也不能单独否定建设。', role: 'unified_conclusion' }
          ],
          element_modes: { accepted: 'explicit', b_prime: 'explicit', unified_conclusion: 'explicit' },
          coverage: { absorbed_pressures: ['额外财政支出'], surviving_pressures: ['财政优先级仍需后续裁判衡量'] }
        }]
      },
      negative: { phase_iii: 'not_formed', candidates: [] }
    },
    relation: {
      type: 'single_side', dominant_side: 'affirmative',
      reason: '仅正方形成完整 SC；此关系不是整场胜负。',
      evidence: [{ quote: '即使多花一些钱，只要它填补基本出行缺口，这笔成本也不能单独否定建设。' }]
    },
    notes: note || 'SC only.'
  };
}

function fakeGlobal(workDir, globalText) {
  const store = Store.createProductionSemanticStore(workDir);
  const semanticRef = store.appendObject({
    sessionId: 'global-fixture', kind: 'semantic', content: globalText,
    metadata: { state: 'reviewed', fixture: true }
  });
  return {
    active: {
      store,
      binding: { sourceText: SOURCE, sourceSha256: sha(SOURCE), contextSha256: null }
    },
    current: { revision: 1, semanticRef }
  };
}

function hostInventory(pass) {
  return {
    schema: 'judge-sc-candidate-inventory-v1', pass,
    sides: {
      affirmative: [{
        id: pass === 'reviewed' ? 'AFF-1' : 'AFF-DRAFT',
        accepted_pressure: '夜间公交需要额外财政支出。',
        role_state: '财政压力仍存在，但不是自动否决。',
        b_prime: '基本可达性与夜间劳动者安全。',
        unified_conclusion: '额外成本本身不足以否定建设。',
        dependency_summary: '接收成本压力后，以基本可达性重定位，并形成统一结论。',
        evidence: [
          { function: 'accept', quote: '我承认夜间公交需要额外财政支出。' },
          { function: 'b_prime', quote: '公共服务不是只有满载时才有价值，它还保障夜间劳动者能够安全回家。' },
          { function: 'unify', quote: '即使多花一些钱，只要它填补基本出行缺口，这笔成本也不能单独否定建设。' }
        ]
      }],
      negative: []
    },
    notes: 'host fixture inventory ' + pass
  };
}
function responder(initialAuthority, revisedAuthority, mode) {
  let calls = 0;
  const apiStub = async (_cfg, _messages, opts) => {
    calls++;
    const system = String(opts && opts.system || '');
    const prompt = String(_messages && _messages[0] && _messages[0].content || '');
    if (system.includes('candidate inventory 发现器')) {
      return { text: JSON.stringify(hostInventory('discovery')), completion_status: 'verified_complete' };
    }
    if (system.includes('candidate inventory reviewer')) {
      return { text: JSON.stringify(hostInventory('reviewed')), completion_status: 'verified_complete' };
    }
    if (system.includes('专职 SC')) return { text: JSON.stringify(initialAuthority), completion_status: 'verified_complete' };
    if (system.includes('independent source-grounded SC semantic reviewer') || system.includes('独立 source-grounded SC semantic reviewer')) {
      const doc = mode === 'reopen-maintain'
        ? { decision: 'maintain', evidence: [{ quote: '我承认夜间公交需要额外财政支出。', reason: '维持原 SC authority。' }], reason: '原 authority 可维持。', authority: null }
        : (mode === 'reopen-revise'
          ? { decision: 'revise', evidence: [{ quote: '即使多花一些钱，只要它填补基本出行缺口，这笔成本也不能单独否定建设。', reason: '修订说明但保持 source-grounded SC。' }], reason: '按具体异议形成完整替代 authority。', authority: revisedAuthority }
          : { decision: 'maintain', evidence: [{ quote: '我承认夜间公交需要额外财政支出。', reason: '候选有完整接收链。' }], reason: '候选可维持。', authority: null });
      return { text: JSON.stringify(doc), completion_status: 'verified_complete' };
    }
    if (system.includes('标准表示投影器')) {
      return { text: JSON.stringify(mode === 'reopen-revise' && revisedAuthority ? revisedAuthority : initialAuthority), completion_status: 'verified_complete' };
    }
    if (system.includes('SC authority fidelity reviewer')) {
      return { text: JSON.stringify({ decision: 'approve', reason: 'SC authority 忠实于原文且不裁整场胜负。', issues: [], evidence: [] }), completion_status: 'verified_complete' };
    }
    throw new Error('unexpected system prompt: ' + system.slice(0, 120));
  };
  return { apiStub, get calls() { return calls; } };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-v10-sc-host-'));
  fs.writeFileSync(path.join(dir, '.tmp-debate.txt'), SOURCE, 'utf8');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('fresh SC current self-proves and same-version resume spends zero model calls', async t => {
  const workDir = tempDir(t);
  const global = fakeGlobal(workDir, GLOBAL);
  const events = [];
  const mock = responder(authority(), null, 'initial');
  const first = await Host.prepareTestScAuthority(workDir, global, {
    cfg: { provider: 'mock', model: 'mock' }, apiStub: mock.apiStub,
    onStage: e => events.push(e.stage + ':' + e.state)
  });
  assert.equal(first.current.revision, 1);
  assert.equal(first.reused, false);
  assert.ok(first.refs.inventoryARef, 'fresh SC authority must persist discovery inventory');
  assert.ok(first.refs.inventoryBRef, 'fresh SC authority must persist reviewed inventory');
  assert.ok(first.refs.inventoryRef, 'fresh SC authority must persist reviewed frozen inventory');
  assert.deepEqual(first.inventory.sides.affirmative.map(x => x.id), ['AFF-1']);
  assert.ok(fs.existsSync(path.join(workDir, 'sc-semantic-provenance.json')));
  assert.equal(first.provenance.authority.inventoryRef.objectId, first.refs.inventoryRef.objectId);
  assert.equal(first.provenance.authority.inventoryARef.objectId, first.refs.inventoryARef.objectId);
  assert.equal(first.provenance.authority.inventoryBRef.objectId, first.refs.inventoryBRef.objectId);
  assert.deepEqual(events, [
    'sc-inventory-discover:active', 'sc-inventory-discover:response_received', 'sc-inventory-discover:validating', 'sc-inventory-discover:complete',
    'sc-inventory-review:active', 'sc-inventory-review:response_received', 'sc-inventory-review:validating', 'sc-inventory-review:complete',
    'sc-analyze:active', 'sc-analyze:response_received', 'sc-analyze:validating', 'sc-analyze:complete',
    'sc-review:active', 'sc-review:response_received', 'sc-review:validating', 'sc-review:complete',
    'sc-project:active', 'sc-project:response_received', 'sc-project:validating', 'sc-project:complete',
    'sc-fidelity:active', 'sc-fidelity:response_received', 'sc-fidelity:validating', 'sc-fidelity:complete'
  ]);
  const callsAfterFirst = mock.calls;
  const resumed = await Host.prepareTestScAuthority(workDir, global, {
    cfg: { provider: 'mock', model: 'mock' }, apiStub: mock.apiStub
  });
  assert.equal(resumed.reused, true);
  assert.equal(resumed.current.revision, 1);
  assert.equal(mock.calls, callsAfterFirst, 'same-version resume must self-prove without model calls');
  assert.equal(resumed.provenance.revision, 1);
});

test('SC projection-only representation failure re-projects in-place without repeating semantic stages', async t => {
  const workDir = tempDir(t);
  const global = fakeGlobal(workDir, GLOBAL);
  const base = responder(authority(), null, 'initial');
  const roles = [];
  const projectPrompts = [];
  let breakFirstProjection = true;
  const apiStub = async (cfg, messages, opts) => {
    const system = String(opts && opts.system || '');
    let role = 'unknown';
    if (system.includes('candidate inventory 发现器')) role = 'sc-inventory-discover';
    else if (system.includes('candidate inventory reviewer')) role = 'sc-inventory-review';
    else if (system.includes('专职 SC')) role = 'sc-analyze';
    else if (system.includes('source-grounded SC semantic reviewer')) role = 'sc-review';
    else if (system.includes('标准表示投影器')) role = 'sc-project';
    else if (system.includes('SC authority fidelity reviewer')) role = 'sc-fidelity';
    roles.push(role);
    if (role === 'sc-project') projectPrompts.push(String((messages && messages[0] && messages[0].content) || ''));
    if (role === 'sc-project' && breakFirstProjection) {
      breakFirstProjection = false;
      const broken = authority();
      broken.sides.affirmative.candidates[0].composition_chain[0].quote =
        '我承认夜间公交需要财政支出。';
      return { text: JSON.stringify(broken), completion_status: 'verified_complete' };
    }
    return base.apiStub(cfg, messages, opts);
  };

  const result = await Host.prepareTestScAuthority(workDir, global, {
    cfg: { provider: 'mock', model: 'mock' }, apiStub
  });
  assert.equal(result.current.revision, 1);
  assert.deepEqual(roles, [
    'sc-inventory-discover', 'sc-inventory-review', 'sc-analyze', 'sc-review',
    'sc-project', 'sc-project', 'sc-fidelity'
  ], 'representation retry must repeat only sc-project before fidelity');
  assert.equal(projectPrompts.length, 2);
  assert.match(projectPrompts[1], /deterministic representation re-projection 1\/3/);
  assert.match(projectPrompts[1], /exact-source quote must be an exact contiguous substring/);
  assert.match(projectPrompts[1], /优先返回 source_span/);
});

test('SC projection representation retry budget remains fail-closed and never republishes semantic as current', async t => {
  const workDir = tempDir(t);
  const global = fakeGlobal(workDir, GLOBAL);
  const base = responder(authority(), null, 'initial');
  const roles = [];
  const apiStub = async (cfg, messages, opts) => {
    const system = String(opts && opts.system || '');
    let role = 'unknown';
    if (system.includes('candidate inventory 发现器')) role = 'sc-inventory-discover';
    else if (system.includes('candidate inventory reviewer')) role = 'sc-inventory-review';
    else if (system.includes('专职 SC')) role = 'sc-analyze';
    else if (system.includes('source-grounded SC semantic reviewer')) role = 'sc-review';
    else if (system.includes('标准表示投影器')) role = 'sc-project';
    else if (system.includes('SC authority fidelity reviewer')) role = 'sc-fidelity';
    roles.push(role);
    if (role === 'sc-project') {
      const broken = authority();
      broken.sides.affirmative.candidates[0].composition_chain[0].quote =
        '我承认夜间公交需要财政支出。';
      return { text: JSON.stringify(broken), completion_status: 'verified_complete' };
    }
    return base.apiStub(cfg, messages, opts);
  };

  await assert.rejects(
    Host.prepareTestScAuthority(workDir, global, {
      cfg: { provider: 'mock', model: 'mock' }, apiStub
    }),
    /exact-source quote must be an exact contiguous substring/
  );
  assert.equal(roles.filter(role => role === 'sc-project').length, 4,
    'initial projection + three bounded representation retries only');
  assert.equal(roles.filter(role => role === 'sc-fidelity').length, 0,
    'fidelity must never run on an invalid projection');
  assert.equal(roles.filter(role => role === 'sc-analyze').length, 1);
  assert.equal(roles.filter(role => role === 'sc-review').length, 1);
  const afterFailure = Store.createProductionSemanticStore(workDir).readCurrent('sc-v10-authority');
  assert.equal(afterFailure.revision, 0, 'exhausted representation retries must not publish current authority');
});

test('same-revision tampered frozen inventory fails closed before reuse', async t => {
  const workDir = tempDir(t);
  const global = fakeGlobal(workDir, GLOBAL);
  const mock = responder(authority(), null, 'initial');
  const first = await Host.prepareTestScAuthority(workDir, global, { cfg: { provider: 'mock' }, apiStub: mock.apiStub });
  const inventoryFile = path.join(first.store.root, ...String(first.refs.inventoryRef.path).split('/'));
  fs.writeFileSync(inventoryFile, fs.readFileSync(inventoryFile, 'utf8') + '\nTAMPERED', 'utf8');
  await assert.rejects(
    Host.prepareTestScAuthority(workDir, global, { cfg: { provider: 'mock' }, apiStub: mock.apiStub }),
    e => e && e.code === 'ERR_TEST_SC_AUTHORITY_RECOVERY_REQUIRED'
  );
});

test('same-revision tampered SC provenance fails closed', async t => {
  const workDir = tempDir(t);
  const global = fakeGlobal(workDir, GLOBAL);
  const mock = responder(authority(), null, 'initial');
  await Host.prepareTestScAuthority(workDir, global, { cfg: { provider: 'mock' }, apiStub: mock.apiStub });
  const file = path.join(workDir, 'sc-semantic-provenance.json');
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  p.globalSemantic.objectId = 'tampered';
  fs.writeFileSync(file, JSON.stringify(p, null, 2), 'utf8');
  await assert.rejects(
    Host.prepareTestScAuthority(workDir, global, { cfg: { provider: 'mock' }, apiStub: mock.apiStub }),
    e => e && e.code === 'ERR_TEST_SC_PROVENANCE_INVALID'
  );
});

test('SC reopen can publish revision 2 without changing global semantic identity', async t => {
  const workDir = tempDir(t);
  const global = fakeGlobal(workDir, GLOBAL);
  const initialMock = responder(authority('initial'), null, 'initial');
  const first = await Host.prepareTestScAuthority(workDir, global, { cfg: { provider: 'mock' }, apiStub: initialMock.apiStub });
  const reopenedAuthority = authority('reopened after independent review');
  const reopenMock = responder(authority('unused'), reopenedAuthority, 'reopen-revise');
  const request = SCA.extractReopenRequest(
    'x\n<!--SC_REOPEN_REQUEST\n{"expectedRevision":1,"issue":"复核统一结论边界","evidence":[{"quote":"即使多花一些钱，只要它填补基本出行缺口，这笔成本也不能单独否定建设。"}]}\n-->',
    SOURCE
  ).request;
  const result = await Host.publishTestScReopen(workDir, global, first, request, {
    cfg: { provider: 'mock' }, apiStub: reopenMock.apiStub
  });
  assert.equal(result.published, true);
  assert.equal(result.current.revision, 2);
  assert.equal(result.currentView.globalSemanticRevision, 1);
  assert.equal(result.currentView.globalSemanticObjectId, global.current.semanticRef.objectId);
  assert.ok(result.refs.issueRef);
  assert.equal(result.provenance.revision, 2);

  const reopenedAgainAuthority = authority('second independent reopen after revision 2');
  const reopenAgainMock = responder(authority('unused-again'), reopenedAgainAuthority, 'reopen-revise');
  const request2 = SCA.extractReopenRequest(
    'x\n<!--SC_REOPEN_REQUEST\n{"expectedRevision":2,"issue":"复核成本限定与统一结论的第二个独立问题","evidence":[{"quote":"公共服务不是只有满载时才有价值，它还保障夜间劳动者能够安全回家。"}]}\n-->',
    SOURCE
  ).request;
  const result2 = await Host.publishTestScReopen(workDir, global, {
    store:first.store,
    current:result.current
  }, request2, {
    cfg: { provider: 'mock' }, apiStub: reopenAgainMock.apiStub
  });
  assert.equal(result2.published, true);
  assert.equal(result2.current.revision, 3,
    'a second distinct source-grounded issue must remain independently reviewable after revision 2');
  assert.equal(result2.currentView.globalSemanticRevision, 1);
  assert.equal(result2.currentView.globalSemanticObjectId, global.current.semanticRef.objectId);
  assert.equal(result2.provenance.revision, 3);
  const resumedThird = await Host.prepareTestScAuthority(workDir, global, {
    cfg: { provider: 'mock', model: 'mock' },
    apiStub: async () => { throw new Error('SC revision-three resume must spend zero model calls'); }
  });
  assert.equal(resumedThird.reused, true);
  assert.equal(resumedThird.current.revision, 3);
  assert.equal(resumedThird.provenance.globalSemantic.objectId, global.current.semanticRef.objectId);
});

test('revision 3 SC resume rejects a broken intermediate revision ancestry', async t => {
  const workDir = tempDir(t);
  const global = fakeGlobal(workDir, GLOBAL);
  const initialMock = responder(authority('initial'), null, 'initial');
  const first = await Host.prepareTestScAuthority(workDir, global, {
    cfg: { provider: 'mock' }, apiStub: initialMock.apiStub
  });

  const reopen1 = responder(authority('unused-1'), authority('revision-2'), 'reopen-revise');
  const request1 = SCA.extractReopenRequest(
    'x\n<!--SC_REOPEN_REQUEST\n{"expectedRevision":1,"issue":"first independent issue","evidence":[{"quote":"我承认夜间公交需要额外财政支出。"}]}\n-->',
    SOURCE
  ).request;
  const second = await Host.publishTestScReopen(workDir, global, first, request1, {
    cfg: { provider: 'mock' }, apiStub: reopen1.apiStub
  });
  assert.equal(second.current.revision, 2);

  const reopen2 = responder(authority('unused-2'), authority('revision-3'), 'reopen-revise');
  const request2 = SCA.extractReopenRequest(
    'x\n<!--SC_REOPEN_REQUEST\n{"expectedRevision":2,"issue":"second independent issue","evidence":[{"quote":"公共服务不是只有满载时才有价值，它还保障夜间劳动者能够安全回家。"}]}\n-->',
    SOURCE
  ).request;
  const third = await Host.publishTestScReopen(workDir, global, {
    store: first.store, current: second.current
  }, request2, {
    cfg: { provider: 'mock' }, apiStub: reopen2.apiStub
  });
  assert.equal(third.current.revision, 3);

  // Break only the intermediate revision-2 ancestry proof. Its semantic bytes and
  // frozen inventory binding remain readable, so a one-hop-only revision-3 verifier
  // would incorrectly accept the current head.
  const metaPath = path.join(first.store.root, ...String(second.current.semanticRef.metadataPath).split('/'));
  const metaDoc = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  delete metaDoc.metadata.reviewRef;
  delete metaDoc.metadata.parentSemanticRef;
  delete metaDoc.metadata.state;
  fs.writeFileSync(metaPath, JSON.stringify(metaDoc) + '\n', 'utf8');

  await assert.rejects(
    Host.prepareTestScAuthority(workDir, global, {
      cfg: { provider: 'mock', model: 'mock' },
      apiStub: async () => { throw new Error('broken ancestry must fail before any semantic call'); }
    }),
    e => e && e.code === 'ERR_TEST_SC_AUTHORITY_RECOVERY_REQUIRED'
  );
});

test('global semantic context change creates a new SC authority root without forcing old-context ancestry', async t => {
  const workDir = tempDir(t);
  const global1 = fakeGlobal(workDir, GLOBAL);
  const firstMock = responder(authority('global-context-1'), null, 'initial');
  const first = await Host.prepareTestScAuthority(workDir, global1, {
    cfg: { provider: 'mock' }, apiStub: firstMock.apiStub
  });
  assert.equal(first.current.revision, 1);

  const global2 = fakeGlobal(workDir, GLOBAL + ' 第二版独立 global semantic。');
  assert.notEqual(Host.scGlobalBinding(global1).contextSha256, Host.scGlobalBinding(global2).contextSha256);
  const secondMock = responder(authority('global-context-2'), null, 'initial');
  const second = await Host.prepareTestScAuthority(workDir, global2, {
    cfg: { provider: 'mock' }, apiStub: secondMock.apiStub
  });
  assert.equal(second.reused, false);
  assert.equal(second.current.revision, 2);
  assert.equal(second.current.lastCommitKind, 'v10-sc-authority');
  assert.equal(second.currentView.globalSemanticObjectId, global2.current.semanticRef.objectId);

  const resumed = await Host.prepareTestScAuthority(workDir, global2, {
    cfg: { provider: 'mock', model: 'mock' },
    apiStub: async () => { throw new Error('same new-context authority root must resume without model calls'); }
  });
  assert.equal(resumed.reused, true);
  assert.equal(resumed.current.revision, 2);
  assert.equal(resumed.currentView.globalSemanticObjectId, global2.current.semanticRef.objectId);
});

test('SC reopen invalidation starts at R2 and preserves P1', t => {
  const workDir = tempDir(t);
  for (const name of ['P1.md', 'P2.md', 'P2.5.md', 'P3.md', 'final-adjudication.json', 'final-adjudication-receipt.json', 'transition-final.md', 'report.html']) {
    fs.writeFileSync(path.join(workDir, name), name, 'utf8');
  }
  const removed = Host.invalidateAfterScReopen(workDir);
  assert.equal(fs.existsSync(path.join(workDir, 'P1.md')), true);
  assert.equal(removed.includes('P1.md'), false);
  assert.equal(fs.existsSync(path.join(workDir, 'P2.md')), false);
  assert.equal(removed.includes('P2.md'), true);
  assert.equal(fs.existsSync(path.join(workDir, 'final-adjudication.json')), false);
  assert.equal(fs.existsSync(path.join(workDir, 'final-adjudication-receipt.json')), false);
});

test('C-R SC current view exposes immutable SC semantic/projection object identities for final binding', async t => {
  const workDir = tempDir(t);
  const global = fakeGlobal(workDir, GLOBAL);
  const mock = responder(authority(), null, 'initial');
  const prepared = await Host.prepareTestScAuthority(workDir, global, {
    cfg: { provider: 'mock', model: 'mock' }, apiStub: mock.apiStub
  });
  assert.equal(prepared.currentView.semanticObjectId, prepared.current.semanticRef.objectId);
  assert.equal(prepared.currentView.projectionObjectId, prepared.current.projectionRef.objectId);
  assert.equal(prepared.currentView.sourceSha256, sha(SOURCE));
  assert.equal(prepared.currentView.globalSemanticObjectId, global.current.semanticRef.objectId);
});

test('R3 final-owned preview feeds source-reference errors back to R3 without importing unrelated final blockers', t => {
  const workDir = tempDir(t);
  fs.writeFileSync(path.join(workDir, 'P1.md'), 'P1 fixture', 'utf8');
  fs.writeFileSync(path.join(workDir, 'P2.md'), 'P2 fixture', 'utf8');
  fs.writeFileSync(path.join(workDir, 'P2.5.md'), 'P2.5 fixture', 'utf8');
  let validateOptions = null;
  const fakePC = {
    autoFixSMarkers: x => x,
    autoFixTables: x => x,
    extractDataMarkers: () => ({}),
    detectNewContractFromText: () => true,
    validate: (_text, round, options) => {
      assert.equal(round, 'R3');
      validateOptions = options;
      return {
        passed: false,
        blocking: [
          { rule: 'H5', severity: 'BLOCKING', message: 'upstream relation blocker owned elsewhere' },
          { rule: 'V-S14E', severity: 'BLOCKING', message: 'S14 source reference is not sourceable' }
        ]
      };
    }
  };
  const preview = Host.validateR3FinalOwnedPreview(workDir, 'R3 fixture', fakePC);
  assert.equal(validateOptions.final, true);
  assert.equal(preview.passed, false);
  assert.deepEqual(preview.errors, ['S14 source reference is not sourceable']);
  assert.equal(preview.blocking.length, 1);
  assert.equal(preview.blocking[0].rule, 'V-S14E');

  fakePC.validate = () => ({ passed: false, blocking: [{ rule: 'H5', severity: 'BLOCKING', message: 'not R3-owned' }] });
  const unrelated = Host.validateR3FinalOwnedPreview(workDir, 'R3 fixture', fakePC);
  assert.equal(unrelated.passed, true, 'unrelated final blockers must not be misreported as R3-repairable');
});
