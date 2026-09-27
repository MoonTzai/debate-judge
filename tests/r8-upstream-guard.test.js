'use strict';

const fs = require('fs');
const path = require('path');

let failed = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' :: ' + detail : ''));
  if (!cond) failed++;
}

const host = fs.readFileSync(path.join(__dirname, '..', 'executor', 'host-node.js'), 'utf8');
const rg = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'reader-guide.js'), 'utf8');

check('R8-UH1 reviewer contract supports note/upstream_review without forcing semanticIssues on normal runs',
  rg.includes("issue.action === 'note'") &&
  rg.includes("issue.action === 'upstream_review'") &&
  rg.includes("若没有异议，semanticIssues 可省略或为空数组"));

check('R8-UH2 approved=true cannot erase upstream_review',
  rg.includes("if (upstreamIssues.length)") &&
  rg.includes("R8 发现上游语义问题") &&
  rg.includes("reopenNodes"));

check('R8-UH3 unclassified issue requests clarification instead of guessing a round',
  rg.includes("needsClarification") &&
  rg.includes("程序不自动猜责任轮"));

check('R8-UH4 live review persists upstream evidence and fail-closes before guide/plain publication',
  host.includes("disposition: 'upstream_review'") &&
  host.includes("phase: 'r8-upstream-review'") &&
  host.includes("upstreamError.code = 'R8_UPSTREAM_REVIEW'") &&
  host.indexOf("disposition: 'upstream_review'") < host.indexOf("fs.writeFileSync(files.guide"));

check('R8-UH5 cache with unresolved upstream issue cannot be re-voted away',
  host.includes("R8 缓存中存在未处理的上游语义异议") &&
  host.includes("不重新求批准，不在导览层改判") &&
  host.includes("if (e && e.code === 'R8_UPSTREAM_REVIEW') throw e"));

check('R8-UH6 ordinary note is accepted and journaled without blocking',
  host.includes("? 'accepted_with_notes' : 'accepted'") &&
  rg.includes("notes.push(issue)"));

check('R8-UH7 PRODUCTION_ACTIVE convergence candidate deliberately does not enable generic auto-rewind',
  !host.includes("applyReaderGuideWithRecovery") &&
  !host.includes("prepareReaderGuideRecovery") &&
  !host.includes("buildResumePlanForDir(workDir, checked.targetRound"));


check('R8-UH8 original-guide semantic rejection triggers targeted repair instead of unchanged re-vote',
  host.includes("const failedCards = (review.cardChecks || [])") &&
  host.includes("RG.buildGuideRepairPrompt(") &&
  host.includes("'导览语义定点修复响应'") &&
  host.includes("导览语义修复必须恰好覆盖失败卡") &&
  host.includes("导览语义修复越权改写冻结卡"));

check('R8-UH9 targeted guide repair is mechanically revalidated and privately checkpointed before another review',
  host.includes("guideCheck = checkReaderGuideContract(RG, input, guide, snapshot)") &&
  host.includes("fs.writeFileSync(files.draft, JSON.stringify({ v: 1, key, inputHash, guide") &&
  host.includes("导览语义修复后机械门失败"));

check('R8-UH10 accepted review is journaled; previous rejected journal is preserved for audit',
  host.includes("const acceptedJournal = JSON.stringify") &&
  host.includes(".tmp-reader-guide-review.json") &&
  host.includes("'.previous-' + Date.now()"));

console.log(failed === 0 ? '=== ALL PASS ===' : '=== FAILED: ' + failed + ' ===');
process.exit(failed === 0 ? 0 : 1);
