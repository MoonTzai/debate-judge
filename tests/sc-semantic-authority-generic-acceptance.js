'use strict';

const fs = require('fs');
const path = require('path');
const SCA = require('../executor/sc-semantic-authority.js');

function fail(message) { throw new Error(message); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function resolveRef(workDir, ref) {
  if (!ref || !ref.path) fail('missing authority ref path');
  const stateRoot = path.resolve(workDir, '.semantic-first-production-v1');
  const file = path.resolve(stateRoot, ref.path);
  const relative = path.relative(stateRoot, file);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    fail('authority ref escaped semantic state root: ' + ref.path);
  }
  return file;
}

function main() {
  const argv = process.argv.slice(2);
  const scOnly = argv.includes('--sc-only');
  const workDirArg = argv.find(arg => arg !== '--sc-only');
  if (!workDirArg) fail('usage: node tests/sc-semantic-authority-generic-acceptance.js [--sc-only] <workDir>');
  const workDir = path.resolve(workDirArg);

  const required = ['.tmp-debate.txt', 'sc-semantic-provenance.json'];
  if (!scOnly) required.push('P2.md');
  for (const name of required) {
    if (!fs.existsSync(path.join(workDir, name))) fail('generic SC acceptance missing ' + name);
  }

  const source = fs.readFileSync(path.join(workDir, '.tmp-debate.txt'), 'utf8');
  if (!source.trim()) fail('generic SC acceptance requires non-empty source');

  const provenance = readJson(path.join(workDir, 'sc-semantic-provenance.json'));
  if (provenance.schema !== 'judge-sc-semantic-provenance-v1') fail('SC provenance schema mismatch');
  if (provenance.scope !== 'SC_ONLY_NOT_FINAL_VERDICT') fail('SC provenance illegally claims final verdict scope');
  if (!Number.isInteger(Number(provenance.revision)) || Number(provenance.revision) < 1) fail('SC provenance revision invalid');

  const semanticRef = provenance.authority && provenance.authority.semanticRef;
  const semanticFile = resolveRef(workDir, semanticRef);
  if (!fs.existsSync(semanticFile)) fail('SC authority semantic ref missing');
  const authority = SCA.parseAuthority(fs.readFileSync(semanticFile, 'utf8'), source);

  for (const side of ['affirmative', 'negative']) {
    const row = authority.sides && authority.sides[side];
    if (!row || !SCA.PHASE_STATES.has(row.phase_iii) || !Array.isArray(row.candidates)) {
      fail('SC authority side shape invalid: ' + side);
    }
  }
  if (!authority.relation || !SCA.RELATION_TYPES.has(authority.relation.type)) fail('SC authority relation invalid');

  if (!scOnly) {
    const p2 = fs.readFileSync(path.join(workDir, 'P2.md'), 'utf8');
    const alignment = SCA.checkR2Alignment(p2, { revision: Number(provenance.revision), authority });
    if (!alignment.ok) fail('R2/S8 SC authority binding mismatch: ' + alignment.errors.join('; '));
  }

  const result = {
    ok: true,
    status: scOnly ? 'GENERIC_SC_AUTHORITY_PRECHECK_PASS' : 'GENERIC_SC_AUTHORITY_ACCEPTANCE_PASS',
    sc_revision: Number(provenance.revision),
    affirmative_phase_iii: authority.sides.affirmative.phase_iii,
    negative_phase_iii: authority.sides.negative.phase_iii,
    relation: authority.relation.type,
    dominant_sc_side: authority.relation.dominant_side,
    report_exists: fs.existsSync(path.join(workDir, 'report.html')),
    semantic_oracle_asserted_by_gate: false,
    winner_asserted_by_gate: false
  };
  process.stdout.write('V10_GENERIC_SC_ACCEPTANCE_RESULT:' + JSON.stringify(result) + '\n');
}

if (require.main === module) {
  try { main(); }
  catch (e) {
    process.stderr.write('V10_GENERIC_SC_ACCEPTANCE_FAIL:' + (e && e.stack ? e.stack : String(e)) + '\n');
    process.exitCode = 1;
  }
}

module.exports = { resolveRef };
