'use strict';
const assert = require('assert');
const path = require('path');
const rs = require(path.join(__dirname, '..', 'scripts', 'judge-run-settings.js'));

const neutral = rs.normalizeRunSettings({});
assert.deepStrictEqual(neutral.analysis.dimWeights, { 说服:0, 证明:0, 第三方:0 });
assert.deepStrictEqual(neutral.analysis.tendencyWeights, { 证伪:50, 证成:50, 理性:50, 感性:50, 场面感:50, 意义感:50 });
assert.strictEqual(neutral.postprocess.plain, false);
assert.strictEqual(neutral.postprocess.readerGuide, false);
assert.strictEqual(rs.tendencyText(neutral.analysis.dimWeights, neutral.analysis.tendencyWeights), '');

const custom = rs.normalizeRunSettings({
  analysis: {
    dimWeights: { 说服:70, 证明:20, 第三方:10 },
    tendencyWeights: { 证伪:80, 证成:30, 理性:65, 感性:35, 场面感:20, 意义感:90 },
    depth: { verdict:'详细', mainline:'逐环节追踪', clash:'逐回合全部' },
    judgeContext: {
      kind:'debate-judge-context-v1', version:1, enabled:true, useMode:'registered_conflicts_plus_presentation',
      background:{ mode:'academic', domains:['law_public_policy'], familiarity:'deep' },
      valueConcerns:['procedural_fairness'], perspective:'academic_observer', note:''
    }
  },
  postprocess:{ plain:true, readerGuide:true },
  provider:'mock', apiKey:'SECRET'
});
assert.match(rs.tendencyText(custom.analysis.dimWeights, custom.analysis.tendencyWeights), /本场裁判倾向/);
assert.match(rs.depthBlockText(custom.analysis.depth), /输出深度要求/);
assert.match(rs.projectJudgeContext(custom.analysis.judgeContext, 'R4.5'), /R4\.5 受限冲突解释上下文/);
assert.match(rs.projectJudgeContext(custom.analysis.judgeContext, 'R5A'), /R5 受限表达上下文/);
assert.strictEqual(rs.projectJudgeContext(custom.analysis.judgeContext, 'R4'), '');

const h1 = rs.analysisProfileHash(custom);
const h2 = rs.analysisProfileHash(Object.assign({}, custom, { postprocess:{ plain:false, readerGuide:false }, provider:'openai-compatible', apiKey:'OTHER' }));
assert.strictEqual(h1, h2, 'analysis profile hash must ignore postprocess/transport');
const changed = JSON.parse(JSON.stringify(custom));
changed.analysis.dimWeights.说服 = 69;
assert.notStrictEqual(rs.analysisProfileHash(changed), h1, 'analysis profile hash must change with prompt-affecting settings');
assert.match(h1, /^[0-9a-f]{64}$/);

// Web compatibility facades must consume the same shared implementation instead of maintaining duplicate rule tables.
const webTendency = require(path.join(__dirname, '..', 'web', 'src', 'tendency.js'));
const webContext = require(path.join(__dirname, '..', 'web', 'src', 'judge-context.js'));
assert.strictEqual(webTendency.normalizeDimWeights, rs.normalizeDimWeights, 'Web tendency normalization must re-export shared implementation');
assert.strictEqual(webTendency.tendencyText, rs.tendencyText, 'Web tendency text must re-export shared implementation');
assert.strictEqual(webTendency.depthBlockText, rs.depthBlockText, 'Web depth must re-export shared implementation');
assert.strictEqual(webContext.normalizeJudgeContext, rs.normalizeJudgeContext, 'Web Judge Context normalization must re-export shared implementation');
assert.strictEqual(webContext.projectJudgeContext, rs.projectJudgeContext, 'Web Judge Context projector must re-export shared implementation');
assert.strictEqual(webContext.contextSummary, rs.contextSummary, 'Web Judge Context summary must re-export shared implementation');

console.log('run settings: PASS');
