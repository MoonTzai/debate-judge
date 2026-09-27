'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FROZEN_HTML_SHA256 = 'd6bed878193682bc4a8142af7b72f17cdb197d52fda07d5af4562eb3baef9e1a';
const HTML = path.join(ROOT, 'web', 'judge.html');

function shaBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
function run(args) {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error('command failed: node ' + args.join(' ') + ' exit=' + r.status);
}

const frozenBytes = fs.readFileSync(HTML);
if (shaBytes(frozenBytes) !== FROZEN_HTML_SHA256) {
  throw new Error('frozen web/judge.html drift before verification');
}
for (const rel of ['web/assets/sanctum-dark.webp', 'web/assets/sanctum-light.webp']) {
  if (fs.existsSync(path.join(ROOT, ...rel.split('/')))) {
    throw new Error('quarantined UI artwork must not be present in the public branch: ' + rel);
  }
}

run(['--test', ...["tests/consumer-claims.test.js","tests/flight-incarnation-regression.test.js","tests/global-semantic-review-v5-format-v10.test.js","tests/plain-comprehension.test.js","tests/plain-semantic.test.js","tests/plain-toggle.test.js","tests/postprocess-report-return-contract.test.js","tests/published-precore-recovery.test.js","tests/r8-c8-fact-semantic.test.js","tests/r8-review-contract-v3-real-shape.test.js","tests/r8-upstream-guard.test.js","tests/reader-guide.test.js","tests/report-host-auto-height-v10.test.js","tests/resume-review-store-contract.test.js","tests/retry-hardening-boundary.test.js","tests/run-settings.test.js","tests/sc-projection-representation-separation.test.js","tests/sc-semantic-authority-host-v10.test.js","tests/semantic-evidence-anchor-v10.test.js","tests/semantic-first-e2e-web-runtime-v10.test.js","tests/semantic-mechanical-llm-boundary.test.js","tests/semantic-structured-recovery-extra-closer.test.js","tests/single-file-parity.test.js","tests/structural-json-gate-audit.test.js","tests/tenth-auto-fix-boundary.test.js","tests/tenth-control-plane.test.js","tests/tenth-recovery.test.js"]]);
// Manual generic acceptance needs a caller-supplied completed workDir and is not a zero-argument CI test.
// Example: node tests/sc-semantic-authority-generic-acceptance.js <workDir>
console.log('DELIBERATIVE_PUBLIC_VERIFY_PASS');
