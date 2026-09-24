'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const SW = require('../executor/semantic-workflow.js');
const V5 = require('../executor/semantic-review-contract-v5.js');

const SOURCE = '正方：过程具有学习价值。\n反方：机会成本仍然存在。';
const CANDIDATE = '候选语义保持未决。';
const SEMANTIC = '复核后形成完整替代语义。有限净方向偏向反方。';

function validDoc(semantic = SEMANTIC) {
  return {
    decision: 'revise',
    evidence: [{ quote: '反方：机会成本仍然存在。', reason: 'source-grounded' }],
    reason: '需要完整替代语义',
    net: {
      candidate_state: 'unresolved',
      candidate_quote: '',
      candidate_direction: 'none',
      review_direction: 'negative',
      basis: '复核后存在有限不对称'
    },
    replacement: {
      mode: 'standalone_replacement',
      standalone: true,
      depends_on_prior_semantic: false,
      authority_quote: semantic.includes('完整替代语义') ? '完整替代语义' : '机会成本仍是决定性比较项',
      net_quote: '有限净方向偏向反方'
    },
    semantic
  };
}

const BASE = { parseStrictJsonObject: SW.parseStrictJsonObject, parseReviewDecision: SW.parseReviewDecision };

function memoryWorkflow(callModel, onStage) {
  let seq = 0;
  let current = { revision:0, semanticRef:null, semanticReviewPending:false, projectionRef:null, projectionState:'stale', sourceSha256:null, contextSha256:null };
  const objects = new Map();
  const refFor = (kind, content) => ({
    objectId: 'O' + (++seq),
    kind,
    sha256: SW.sha256Text(String(content == null ? '' : content))
  });
  const appendObject = async obj => {
    const ref = refFor(obj.kind, obj.content);
    objects.set(ref.objectId, { content:String(obj.content == null ? '' : obj.content), metadata:obj.metadata || {}, ref });
    return ref;
  };
  return SW.createWorkflow({
    callModel,
    onStage,
    readSource: async () => ({ sourceText:SOURCE, contextText:'', sourceSha256:SW.sha256Text(SOURCE), contextSha256:null }),
    appendObject,
    readObject: async ref => objects.get(ref.objectId),
    readCurrent: async () => current,
    compareAndSetCurrent: async ({nextCurrent}) => {
      current = Object.assign({}, nextCurrent, { commitId:'C' + (seq + 1) });
      const commitRef = await appendObject({ kind:'commit', content:JSON.stringify(current), metadata:{} });
      return { applied:true, current, commitRef };
    },
    listObjects: async () => []
  });
}

test('global semantic review never reports complete before V5 deterministic validation passes', async () => {
  const events = [];
  const workflow = memoryWorkflow(async request => {
    if (request.role === 'analyze') return { text:CANDIDATE, completion_status:'verified_complete', completion_evidence:{finish_reason:'stop'} };
    if (request.role === 'review') return { text:'{"decision":"maintain"}', completion_status:'verified_complete', completion_evidence:{finish_reason:'stop'} };
    throw new Error('unexpected role ' + request.role);
  }, e => events.push({ stage:e.stage, state:e.state }));
  const analyzed = await workflow.analyze({
    sessionId:'s1', sourceRef:'source', requestId:'a1', requireVerifiedCompletion:true
  });
  await assert.rejects(
    () => workflow.publishReviewedAuthority({
      sessionId:'s1',
      semanticRef:analyzed.refs.semanticCandidateRef,
      sourceRef:'source',
      expectedCurrent:{ revision:0, semanticRef:null, semanticReviewPending:false, projectionRef:null, projectionState:'stale', sourceSha256:null, contextSha256:null },
      reviewPrompt:'review',
      projectPrompt:'project',
      fidelityPrompt:'fidelity',
      requestId:'pub1',
      requireVerifiedCompletion:true
    }),
    /fields must be exactly|review decision/
  );
  const reviewStates = events.filter(e => e.stage === 'semantic-review').map(e => e.state);
  assert.deepEqual(reviewStates, ['active','response_received','validating','failed']);
  assert.equal(reviewStates.includes('complete'), false);
});

test('V5 schema remains exact-set strict but does not treat JSON key order as semantic truth', () => {
  const d = validDoc();
  const reordered = {
    semantic: d.semantic,
    replacement: {
      net_quote: d.replacement.net_quote,
      authority_quote: d.replacement.authority_quote,
      depends_on_prior_semantic: d.replacement.depends_on_prior_semantic,
      standalone: d.replacement.standalone,
      mode: d.replacement.mode
    },
    net: {
      basis: d.net.basis,
      review_direction: d.net.review_direction,
      candidate_direction: d.net.candidate_direction,
      candidate_quote: d.net.candidate_quote,
      candidate_state: d.net.candidate_state
    },
    reason: d.reason,
    evidence: d.evidence,
    decision: d.decision
  };
  const parsed = V5.parseV5ReviewDecision(JSON.stringify(reordered), SOURCE, CANDIDATE, BASE);
  assert.equal(parsed.decision, 'revise');
  assert.equal(parsed.semantic, SEMANTIC);
});

test('V5 validator rejects missing or extra schema fields without a model repair stage', () => {
  const extra = validDoc();
  extra.replacement.semantic = extra.semantic;
  assert.throws(
    () => V5.parseV5ReviewDecision(JSON.stringify(extra), SOURCE, CANDIDATE, BASE),
    err => err && err.code === 'SEMANTIC_REVIEW_V5_SCHEMA_INVALID'
  );

  const missing = validDoc();
  delete missing.net.basis;
  assert.throws(
    () => V5.parseV5ReviewDecision(JSON.stringify(missing), SOURCE, CANDIDATE, BASE),
    err => err && err.code === 'SEMANTIC_REVIEW_V5_SCHEMA_INVALID'
  );

  assert.equal(Object.prototype.hasOwnProperty.call(SW, 'buildV5ReviewFormatRepairPrompt'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(SW, 'assertV5FormatRepairIdentity'), false);
});

test('lexical edit words do not mechanically reject a self-contained revised semantic', () => {
  const semantic = '调整并补充后的独立结论是：机会成本仍是决定性比较项。有限净方向偏向反方。';
  const parsed = V5.parseV5ReviewDecision(JSON.stringify(validDoc(semantic)), SOURCE, CANDIDATE, BASE);
  assert.equal(parsed.semantic, semantic);
  assert.equal(parsed.replacement.net_quote, '有限净方向偏向反方');
});

test('V5 protocol keeps exact field-set and representation boundary explicit', () => {
  assert.match(SW.V5_REVIEW_FORMAT_PROTOCOL, /字段顺序不影响语义或合法性/);
  assert.match(SW.V5_REVIEW_FORMAT_PROTOCOL, /绝对禁止在 replacement 内再放 semantic/);
  assert.match(SW.V5_REVIEW_FORMAT_PROTOCOL, /必须先完整写完最外层 semantic/);
  assert.match(SW.V5_REVIEW_FORMAT_PROTOCOL, /semantic\.includes\(replacement\.authority_quote\)===true/);
  assert.match(SW.V5_REVIEW_FORMAT_PROTOCOL, /authority_quote 与 net_quote 允许是同一段逐字片段/);
  assert.equal(SW.V5_REVIEW_FORMAT_PROTOCOL.includes('模糊匹配'), false,
    'representation reminder must not weaken exact-substring validation into fuzzy repair');
});
