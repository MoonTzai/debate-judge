'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const RG = require('../scripts/reader-guide.js');

assert.strictEqual(RG.REVIEW_PROMPT_VERSION, 'r8-reader-guide-review-prompt-v3');

// Guide generation and semantic review have independent version ownership:
// reviewer changes must not invalidate a mechanically valid 12-card guide draft.
const hostSource = fs.readFileSync(path.join(__dirname, '..', 'executor', 'host-node.js'), 'utf8');
assert.ok(hostSource.includes("saved.reviewPromptVersion === RG.REVIEW_PROMPT_VERSION"));
assert.ok(hostSource.includes("pendingJournal.reviewPromptVersion === RG.REVIEW_PROMPT_VERSION"));
assert.ok(hostSource.includes("R8 cache reviewPromptVersion 不匹配"));
assert.ok(hostSource.includes("reviewPromptVersion: RG.REVIEW_PROMPT_VERSION"));
assert.ok(hostSource.includes("R8 检测到私有导览 draft"));
assert.ok(hostSource.includes("不重生已保存候选"));

// Exact structural shape observed in Judge-Debug-Bundle-20260926-211542.
const realShapeIssue = {
  action: 'upstream_review',
  targetRound: 'R4.5',
  sectionId: 'C1',
  summary: 'R6:C1 的组合判准比例与 R4.5 tendency 数字不同。',
  detail: '旧 reviewer 用 summary/detail 写了完整自由文字说明；字段名本身不得触发 classification_pending。'
};

assert.ok(RG.semanticIssueText(realShapeIssue).includes(realShapeIssue.summary));
assert.ok(RG.semanticIssueText(realShapeIssue).includes(realShapeIssue.detail));

const review = {
  approved: true,
  cardChecks: RG.SECTION_IDS.map(sectionId => ({
    sectionId,
    noNewJudgment: true,
    factsConsistent: true,
    anchorsConsistent: true
  })),
  semanticIssues: [realShapeIssue]
};

// This unit focuses on issue classification; guide validity is intentionally not used as
// evidence that an upstream issue is true. Even with a dummy guide, classification must
// recognize explicit prose + explicit action/target without guessing.
const result = RG.validateReview(null, null, review);
assert.strictEqual(result.needsClarification, false);
assert.strictEqual(result.upstreamIssues.length, 1);
assert.deepStrictEqual(result.reopenNodes, ['R4.5']);
assert.ok(result.errors.some(x => x.includes('R8 发现上游语义问题')));

// Missing prose still fails classification.
const missingText = RG.validateReview(null, null, {
  approved: true,
  cardChecks: review.cardChecks,
  semanticIssues: [{ action: 'upstream_review', targetRound: 'R4.5' }]
});
assert.strictEqual(missingText.needsClarification, true);
assert.ok(missingText.errors.some(x => x.includes('异议须有自由文字说明')));

// The v3 reviewer contract must distinguish configuration-auto weights from a
// content-derived judging framework; numeric difference alone is not an upstream conflict.
const prompt = RG.buildReviewPrompt({}, {});
assert.ok(prompt.includes('三维权重=0/0/0（中立·自动）'));
assert.ok(prompt.includes('并不表示最终裁决的三维权重必须为零'));
assert.ok(prompt.includes('同一 authority 层'));
assert.ok(prompt.includes('不得仅因数字不同就互判冲突'));

// Error wrapping must preserve semantic reopen metadata instead of collapsing it into
// an ordinary presentation failure.
assert.ok(hostSource.includes("if (e && e.code === 'R8_UPSTREAM_REVIEW')"));
assert.ok(hostSource.includes("wrapped.code = e.code"));
assert.ok(hostSource.includes("wrapped.reopenNodes"));

console.log('PASS R8 review contract v3 real-shape / authority-layer boundary');
