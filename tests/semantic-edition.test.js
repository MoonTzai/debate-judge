'use strict';
// Public packaging checks. They do not evaluate an LLM's debate judgments.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const builder = require('../web/build-judge-web');
const nodePipeline = require('../pipeline-controller');
const nodeCore = require('../executor/core');
const generated = path.join(root, 'web/judge.html');
const before = fs.readFileSync(generated);
cp.execFileSync(process.execPath, ['web/build-judge-web.js'], {cwd:root, stdio:'pipe'});
assert.deepEqual(fs.readFileSync(generated), before, 'Tracked HTML must reproduce from this checkout');
assert.equal(builder.buildBundle().js, builder.buildBundle().js, 'No wall-clock variation in the distributed bundle');
assert.equal(read('Skill-Judge.md'), read('Debate-Judge.md'));
assert.equal(read('Skill-Judge.md'), read('.claude/skills/debate-judge/SKILL.md'));
assert(!fs.existsSync(path.join(root, '.claude/skills/debate-judge/pipeline-controller.js')), 'Do not publish the unused stale nested controller');
assert(!/data:image\/webp;base64|__JUDGE_ASSET_(?:DARK|LIGHT)__/.test(read('web/judge.html')));
assert(read('web/judge.html').includes('<title>Debate-Judge Semantic Edition'));
(0, eval)(read('web/dist/judge-bundle.js'));
const bundle = globalThis.JUDGE_BUNDLE;
assert(bundle && bundle.vfs && bundle.loadModule);
assert.equal(bundle.productionSemantic.mode, 'off', 'No private production authorization in the public snapshot');
assert.deepEqual(bundle.loadModule('/executor/core.js').ROUNDS, nodeCore.ROUNDS);
const webPipeline = bundle.loadModule('/pipeline-controller.js');
for (const round of ['1', '2', '2.5', '3', '4', '4.5', '5']) {
  assert.equal(webPipeline.loadRoundPrompt(round), nodePipeline.loadRoundPrompt(round), 'Node/Web prompt parity R' + round);
}
assert.equal(bundle.loadModule('/executor/sc-original-integration.js').POLICY,
  require('../executor/sc-original-integration').POLICY);
for (const modulePath of ['/executor/host-node.js', '/scripts/plain-language.js', '/scripts/plain-comprehension.js', '/scripts/reader-guide.js', '/web/engine.js']) {
  assert(bundle.loadModule(modulePath), 'Load public runtime ' + modulePath);
}
console.log('Semantic Edition packaging: PASS (rebuild, mirrors, module load, round topology, Node/Web prompts, SC policy, no private cutover/artwork)');
