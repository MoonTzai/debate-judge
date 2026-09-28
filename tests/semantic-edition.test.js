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
const embedder = require('../scripts/embed-assets');
const skillText = read('Skill-Judge.md');
for (const block of embedder.blocks) {
  const matches = skillText.match(new RegExp('^<!-- EMBED_ASSET:' + block.name + '_START -->$', 'gm')) || [];
  assert.equal(matches.length, 1, 'Exactly one embedded copy: ' + block.name);
}
assert.equal(embedder.renderSkillContent(skillText), skillText, 'Asset regeneration must be idempotent');
// Legacy files had assets after PC_END. Rebuilding must replace those copies,
// preserve unrelated tail prose and leave exactly one fresh copy per asset.
const pcEnd = '<!-- PIPELINE_CONTROLLER_END -->';
const migrated = embedder.embed(skillText.replace(pcEnd, pcEnd + '\n' + embedder.buildBlock(embedder.blocks[0]) + '\nTAIL_PRESERVATION_FIXTURE\n'));
assert.equal((migrated.match(new RegExp('^<!-- EMBED_ASSET:' + embedder.blocks[0].name + '_START -->$', 'gm')) || []).length, 1);
assert(migrated.includes('TAIL_PRESERVATION_FIXTURE'));
assert(!fs.existsSync(path.join(root, '.claude/skills/debate-judge/pipeline-controller.js')), 'Do not publish the unused stale nested controller');
assert(!/__JUDGE_ASSET_(?:DARK|LIGHT)__/.test(read('web/judge.html')));
for (const theme of ['dark', 'light']) {
  const asset=fs.readFileSync(path.join(root,'web/assets/sanctum-'+theme+'.webp'));
  assert(read('web/judge.html').includes('data:image/webp;base64,'+asset.toString('base64')));
}
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
console.log('Semantic Edition packaging: PASS (rebuild, mirrors, module load, round topology, Node/Web prompts, SC policy, embedded project backgrounds, no private cutover)');
