'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const skill = fs.readFileSync(path.join(root, 'Skill-Judge.md'), 'utf8');
const installer = fs.readFileSync(path.join(root, 'install-skill.js'), 'utf8');

function between(src, a, b) {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  assert.ok(i >= 0 && j > i, 'missing marker: ' + a + ' / ' + b);
  return src.slice(i + a.length, j);
}

const protocol = between(skill, '<!-- AGENT_RUNTIME_PROTOCOL_START -->', '<!-- AGENT_RUNTIME_PROTOCOL_END -->');
assert.ok(protocol.includes('pipeline run'), 'canonical runtime must use pipeline run');
assert.ok(protocol.includes('--plain') && protocol.includes('--reader-guide'), 'product runtime must explicitly request R7/R8 by default');
assert.ok(protocol.includes('R7') && protocol.includes('PLAIN') && protocol.includes('独立后处理'), 'R7 postprocess contract missing');
assert.ok(protocol.includes('R8') && protocol.includes('semanticOk=true') && protocol.includes('postprocessFailed'), 'R8 semantic/postprocess split missing');
assert.ok(protocol.includes('RESUME-NODE-PROTOCOL') && protocol.includes('pipeline resume-plan') && protocol.includes('--resume-from'), 'targeted resume protocol missing');
assert.ok(!/C:\/Claude\/Project|C:\\Claude\\Project/.test(protocol), 'runtime protocol must not hardcode local project path');
assert.ok(!protocol.includes('八轮管道') && !protocol.includes('7 个 prompt') && !protocol.includes('28 块'), 'runtime protocol still contains obsolete topology/count');
assert.ok(!protocol.includes('Debate-Coach-Backup/SKILL.md'), 'external Coach file must not be runtime dependency');

const shellAt = installer.indexOf('function shellTemplate(');
const shellEnd = installer.indexOf('function main()', shellAt);
assert.ok(shellAt >= 0 && shellEnd > shellAt, 'shellTemplate seam missing');
const shell = installer.slice(shellAt, shellEnd);
assert.ok(shell.includes('AGENT_RUNTIME_PROTOCOL_START') && shell.includes('Skill-Judge.md'), 'installed shell must point to canonical runtime protocol');
assert.ok(!shell.includes('R1 → R2') && !shell.includes('每轮 prompt 机械内嵌完整辩词'), 'installed shell must not maintain a second round topology');
assert.ok(!shell.includes('项目根 AGENTS.md + Upload/代码修改审批协议.md'), 'installed shell must not require development-only files');

console.log('single-file parity: PASS');
