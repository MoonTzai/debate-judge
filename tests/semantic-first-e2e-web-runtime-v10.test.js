'use strict';

const assert = require('assert');
const vm = require('vm');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const builder = require('../web/build-judge-web.js');

(async () => {
  const built = builder.buildBundle();
  assert(built && built.js && built.js.length > 1000, 'buildBundle must return real bundle bytes');
  assert(built.sourceOf['/executor/host-node.js'], 'host must be bundled');
  assert(built.sourceOf['/executor/semantic-workflow.js'], 'semantic workflow must be bundled');
  assert(built.sourceOf['/executor/semantic-production-profile-v9.js'], 'shared production V9 profile must be bundled');
  assert.strictEqual(built.sourceOf['/executor/host-node.js'], fs.readFileSync(path.join(ROOT, 'executor', 'host-node.js'), 'utf8'),
    'Web host source must equal TEST Node host source byte-for-byte (no host build patch)');
  assert.strictEqual(built.sourceOf['/executor/semantic-workflow.js'], fs.readFileSync(path.join(ROOT, 'executor', 'semantic-workflow.js'), 'utf8'),
    'Web semantic workflow must equal TEST Node source byte-for-byte');
  assert.strictEqual(built.sourceOf['/executor/semantic-production-profile-v9.js'], fs.readFileSync(path.join(ROOT, 'executor', 'semantic-production-profile-v9.js'), 'utf8'),
    'Web production V9 profile must equal Node source byte-for-byte');

  const sandbox = {
    console,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    setTimeout,
    clearTimeout,
    AbortController: typeof AbortController !== 'undefined' ? AbortController : undefined
  };
  vm.runInNewContext(built.js, sandbox, { timeout: 15000 });
  const bundle = sandbox.JUDGE_BUNDLE;
  assert(bundle, 'JUDGE_BUNDLE missing');
  assert(bundle.testSemantic && bundle.testSemantic.mode === 'active', 'generic Web runtime must carry an active semantic attestation');
  const profile = bundle.modules.semanticTestProfile();
  const validatedAttestation = profile.validateAttestation(bundle.testSemantic);
  assert.strictEqual(validatedAttestation.profile_id, bundle.testSemantic.profile_id,
    'generic Web runtime must validate the bundled profile identity rather than pin a historical profile literal');
  assert.strictEqual(validatedAttestation.prompt_bundle_sha256, bundle.testSemantic.prompt_bundle_sha256,
    'generic Web runtime must validate the bundled prompt bundle rather than pin a historical hash');
  assert.strictEqual(typeof bundle.testSemantic.test_identity, 'string');
  assert(bundle.testSemantic.test_identity.length > 0, 'semantic attestation identity must be present without becoming a historical oracle');

  const engine = bundle.modules.engine().createEngine(bundle, {});
  const importDir = '/Output/judge-260913.000001-imported-session';
  const skillBefore = bundle.vfs.readFileSync('/Skill-Judge.md', 'utf8');
  const dictBefore = bundle.vfs.readFileSync('/assets/plain-dict.json', 'utf8');
  assert.throws(() => engine.restoreSessionScoped({ '/Skill-Judge.md': 'PWNED' }, importDir), /越出 workDir/,
    'external session restore must not overwrite bundle seed assets');
  assert.throws(() => engine.restoreSessionScoped({ [importDir + '/../Skill-Judge.md']: 'PWNED' }, importDir), /越出 workDir/,
    'external session restore must reject traversal keys');
  assert.throws(() => engine.restoreSessionScoped({ '/assets/plain-dict.json': '{"PWNED":true}' }, '/assets'), /会话命名空间/,
    'forged broad workDir must not turn scoped restore into a runtime-seed overwrite');
  assert.strictEqual(bundle.vfs.readFileSync('/Skill-Judge.md', 'utf8'), skillBefore, 'rejected session restore changed Skill-Judge seed');
  assert.strictEqual(bundle.vfs.readFileSync('/assets/plain-dict.json', 'utf8'), dictBefore, 'forged workDir changed runtime dictionary seed');

  const unverifiedDir = '/Output/judge-260913.000003-unverified-report';
  assert.throws(() => engine.restoreVerifiedTestSession({
    [unverifiedDir + '/report.html']: '<html><body>legacy/unproven report</body></html>',
    [unverifiedDir + '/.tmp-debate.txt']: '正方一辩：仅有辩词，没有 TEST semantic authority。'
  }, unverifiedDir), /session authority verification failed/,
  'report existence alone must never grant internal TEST session authority');
  assert.strictEqual(bundle.vfs.existsSync(unverifiedDir + '/report.html'), false,
    'failed verified restore must roll back the unproven session VFS');

  const speech = [
    '正方一辩：夜间公共交通属于基本可达性服务，不能只按单班客流衡量。',
    '反方一辩：低客流线路会持续占用有限补贴，应优先保障高需求线路。',
    '正方二辩：我们接受财政约束，但最低服务频次可以同时控制成本与维持基本可达性。',
    '反方二辩：最低频次仍会产生机会成本，资源配置应比较替代方案。',
    '正方四辩：因此争点不是无限加班次，而是财政约束下是否保留最低公共服务底线。',
    '反方四辩：即便承认基本服务目标，具体底线仍需与其他公共服务需求比较。'
  ].join('\n');
  const logs = [];
  const result = await engine.runSession({
    speech,
    settings: {
      provider: 'mock',
      model: 'mock',
      maxTokens: 32000,
      temperature: 0.3,
      plain: false,
      readerGuide: false,
      skipRosterConfirm: true,
      semanticFirstMode: 'off'
    },
    force: true,
    onLog: line => logs.push(String(line))
  });

  assert.strictEqual(result.semanticFirstMode, 'active', 'imported off must not downgrade TEST route; result=' + JSON.stringify({ ok:result.ok, error:result.error, semanticOk:result.semanticOk, route:result.semanticRoute }));
  assert.strictEqual(result.semanticRoute, 'PRODUCTION_ACTIVE');
  assert.strictEqual(result.ok, true, 'mock TEST active Web run must complete: ' + String(result.error || ''));
  assert(result.semanticProvenance, 'final semantic provenance missing');
  assert.strictEqual(result.semanticProvenance.route, 'PRODUCTION_ACTIVE');
  assert.strictEqual(result.semanticProvenance.authority.revision, 1);
  assert(result.semanticProvenance.authority.reviewRef && result.semanticProvenance.authority.fidelityRef,
    'review/fidelity receipts missing');
  assert.strictEqual(result.semanticProvenance.consumerBinding.mode, 'semantic-bound');
  assert(result.semanticProvenance.consumerBinding.views && result.semanticProvenance.consumerBinding.views.sourceAnchor,
    'A71 normal TEST run must bind fresh source-anchor.json as a same-version control view');
  assert.strictEqual(result.semanticProvenance.consumerBinding.views.sourceAnchor.path, 'source-anchor.json');
  assert.strictEqual(result.semanticProvenance.presentation.semanticIdentityPreserved, true);
  assert(logs.some(x => x.includes('ONE-CAS authority')), 'active publication log missing');

  const files = engine.snapshotSession(result.workDir);
  const provenancePath = result.workDir + '/semantic-first-provenance.json';
  assert(files[provenancePath], 'exportable VFS provenance missing');
  const exported = JSON.parse(files[provenancePath]);
  assert.strictEqual(exported.route, 'PRODUCTION_ACTIVE');
  assert.strictEqual(exported.authority.revision, 1);
  assert(files[result.workDir + '/report.html'], 'report.html missing from TEST Web VFS');
  const boundReportBytes = files[result.workDir + '/report.html'];
  assert(!Object.keys(files).some(k => k.includes('/.semantic-first-v1/')), 'active TEST must not silently route through shadow sidecar');
  const activeStoreKeys = Object.keys(files).filter(k => k.includes('/.semantic-first-production-v1/'));
  assert(activeStoreKeys.length > 0, 'exported TEST session must contain the active immutable semantic store');

  // Export self-proof must not depend on the original in-memory VFS. Load only the exported workDir files
  // into a fresh bundle/VFS and prove current + review/fidelity/commit + consumer binding from that copy.
  const exportSandbox = {
    console: { log() {}, warn() {}, error() {} },
    TextEncoder,
    TextDecoder,
    Uint8Array,
    setTimeout,
    clearTimeout,
    AbortController: typeof AbortController !== 'undefined' ? AbortController : undefined
  };
  vm.runInNewContext(built.js, exportSandbox, { timeout: 15000 });
  const exportBundle = exportSandbox.JUDGE_BUNDLE;
  const exportEngine = exportBundle.modules.engine().createEngine(exportBundle, {});
  exportEngine.restoreSessionScoped(files, result.workDir);
  const exportHost = exportBundle.modules.hostNode();
  const exportCurrent = exportHost.readTestSemanticCurrent(result.workDir);
  const exportProvenance = JSON.parse(exportBundle.vfs.readFileSync(provenancePath, 'utf8'));
  exportHost.validateTestProvenance(result.workDir, { attestation: exportBundle.testSemantic }, exportCurrent, exportProvenance);
  assert.strictEqual(exportProvenance.route, 'PRODUCTION_ACTIVE');
  assert.strictEqual(exportProvenance.authority.revision, 1);

  // A74: this fixture intentionally has no team declaration lines, so source-anchor classifies it as severe Type B.
  // Once the local/mock confirmation policy permits continuation, the host must mechanically persist disclaimer=true,
  // bind those exact source-anchor bytes, and deterministic report rendering must include the canonical disclaimer.
  const severeAnchor = JSON.parse(files[result.workDir + '/source-anchor.json']);
  assert(severeAnchor.typeA || severeAnchor.typeB, 'A74 fixture must exercise a severe source-anchor condition');
  assert.strictEqual(severeAnchor.disclaimer, true,
    'A74 confirmed/authorized severe source-anchor must persist disclaimer=true before same-version binding');
  const disclaimerSandbox = {
    console: { log() {}, warn() {}, error() {} }, TextEncoder, TextDecoder, Uint8Array, setTimeout, clearTimeout,
    AbortController: typeof AbortController !== 'undefined' ? AbortController : undefined
  };
  vm.runInNewContext(built.js, disclaimerSandbox, { timeout: 15000 });
  const disclaimerBundle = disclaimerSandbox.JUDGE_BUNDLE;
  const disclaimerEngine = disclaimerBundle.modules.engine().createEngine(disclaimerBundle, {});
  disclaimerEngine.restoreSessionScoped(files, result.workDir);
  const disclaimerHost = disclaimerBundle.modules.hostNode();
  disclaimerHost.renderReport(result.workDir, { consumerBinding: exported.consumerBinding });
  const disclaimerHtml = disclaimerBundle.vfs.readFileSync(result.workDir + '/report.html', 'utf8');
  const htmlContract = disclaimerBundle.loadModule('/scripts/html-contract.js');
  assert(disclaimerHtml.includes(htmlContract.DISCLAIMER_TEXT),
    'A74 deterministic report render must include canonical DISCLAIMER_TEXT for the bound severe anchor');

  // C-R crash-window regression: a persisted SC provenance identity that diverges from the immutable store head
  // must not be sufficient to re-render an old final/report. Reject either at exact-bound report-view verification
  // or at the immutable store-head freshness check; both are fail-closed manifestations of the same stale authority.
  const scProvenancePath = result.workDir + '/sc-semantic-provenance.json';
  const scProvenanceOriginal = disclaimerBundle.vfs.readFileSync(scProvenancePath, 'utf8');
  const staleScProvenance = JSON.parse(scProvenanceOriginal);
  staleScProvenance.revision = Number(staleScProvenance.revision) + 1;
  disclaimerBundle.vfs.writeFileSync(scProvenancePath, JSON.stringify(staleScProvenance, null, 2), 'utf8');
  assert.throws(
    () => disclaimerHost.renderReport(result.workDir, { consumerBinding: exported.consumerBinding }),
    /SC provenance identity is stale against current store head|consumer view hash 漂移: report/
  );
  disclaimerBundle.vfs.writeFileSync(scProvenancePath, scProvenanceOriginal, 'utf8');

  // A73: R3 final warnings are a complete snapshot, not an exists-first accumulation. Seed a stale earlier-round
  // warning into an otherwise self-proving exported session, rebuild transition-final in the independent VFS with
  // no formal final validation, and require the stale warning registry to be retired before R4.5 can consume it.
  const staleWarningsPath = result.workDir + '/.tmp-validate-warnings.json';
  exportBundle.vfs.writeFileSync(staleWarningsPath, JSON.stringify([
    { rule: 'A73-STALE-R1-WARNING', message: 'must not survive into current R4.5 input' }
  ], null, 2), 'utf8');
  assert.strictEqual(exportBundle.vfs.existsSync(staleWarningsPath), true, 'A73 stale-warning probe was not seeded');
  exportHost.buildTransitionFinal(result.workDir, function () {}, false, { consumerBinding: exportProvenance.consumerBinding });
  assert.strictEqual(exportBundle.vfs.existsSync(staleWarningsPath), false,
    'A73 R3 final snapshot with no formal warnings must delete stale earlier-round warning bytes');

  const bundledHost = bundle.modules.hostNode();
  const webCurrent = bundledHost.readTestSemanticCurrent(result.workDir);
  bundledHost.validateTestProvenance(result.workDir, { attestation: bundle.testSemantic }, webCurrent, exported);
  const verifiedFiles = engine.verifyTestSessionFiles(files, result.workDir);
  assert.strictEqual(verifiedFiles.current.revision, webCurrent.revision, 'history/session verifier must prove the exported current');

  // A51/A52: a durable/history session map must be confined to workDir. Even a fully valid TEST session
  // becomes untrusted if a transient /input staging key is mixed into the export; failure must restore live VFS exactly.
  const canonicalSnapshot = obj => JSON.stringify(Object.keys(obj || {}).sort().map(k => [k, obj[k]]));
  const beforePollutedRestore = canonicalSnapshot(engine.snapshotSession(result.workDir));
  const pollutedFiles = Object.assign({}, files, { '/input/speech-history-poison.txt': 'must never become durable TEST history authority' });
  assert.throws(() => engine.restoreVerifiedTestSession(pollutedFiles, result.workDir), /越出 workDir/,
    'durable TEST history must reject transient /input staging keys');
  assert.strictEqual(canonicalSnapshot(engine.snapshotSession(result.workDir)), beforePollutedRestore,
    'failed polluted history restore must restore the exact pre-attempt live session VFS');

  // A59: semantic session authority and trust in a concrete report are distinct. A provenance receipt can remain
  // semantically self-proving after its report view is intentionally removed; an extra rogue report.html must then
  // be rejected whenever the consumer asks for internal report trust.
  const unboundReportFiles = Object.assign({}, files);
  const unboundReportProvenance = JSON.parse(unboundReportFiles[provenancePath]);
  delete unboundReportProvenance.consumerBinding.views.report;
  unboundReportProvenance.presentation = Object.assign({}, unboundReportProvenance.presentation, {
    plain: false, readerGuide: false, semanticIdentityPreserved: true
  });
  unboundReportFiles[provenancePath] = JSON.stringify(unboundReportProvenance, null, 2);
  unboundReportFiles[result.workDir + '/report.html'] = '<html><body>A59 ROGUE UNBOUND REPORT</body></html>';
  const semanticOnlyProof = engine.verifyTestSessionFiles(unboundReportFiles, result.workDir);
  assert.strictEqual(semanticOnlyProof.current.revision, webCurrent.revision,
    'probe must remain a valid semantic session after removing only the report binding');
  assert.throws(() => engine.verifyTestSessionFiles(unboundReportFiles, result.workDir, ['report']), /consumer|view|binding/i,
    'internal report trust must reject an existing but unbound report.html');

  // A64: source-anchor-exemptions.json is a human authorization checkpoint, not inert session data.
  // A valid semantic session must not be able to acquire that authority by carrying an extra unbound file.
  const forgedExemptionFiles = Object.assign({}, files, {
    [result.workDir + '/source-anchor-exemptions.json']: JSON.stringify({
      version: 1, forged: true, note: 'A64 archive data must never become human exemption authority'
    })
  });
  assert.throws(() => engine.verifyTestSessionFiles(forgedExemptionFiles, result.workDir),
    /unbound source-anchor-exemptions|human authority|sourceAnchorExemptions/i,
    'generic TEST session verification must reject an unbound human-exemption checkpoint');
  const beforeForgedExemptionRestore = canonicalSnapshot(engine.snapshotSession(result.workDir));
  assert.throws(() => engine.restoreVerifiedTestSession(forgedExemptionFiles, result.workDir),
    /session authority verification failed.*unbound source-anchor-exemptions|human authority|sourceAnchorExemptions/i,
    'verified restore must not promote archive exemption bytes into live human authorization');
  assert.strictEqual(canonicalSnapshot(engine.snapshotSession(result.workDir)), beforeForgedExemptionRestore,
    'rejected forged exemption restore must preserve the exact live VFS');

  // A71: source-anchor.json is not inert archive metadata. It affects anchor semantics and report disclaimer rendering.
  // A valid semantic session must therefore bind the exact source-anchor bytes before history/import/reissue may trust them.
  const sourceAnchorPath = result.workDir + '/source-anchor.json';
  assert(files[sourceAnchorPath], 'A71 probe requires the normal run to persist source-anchor.json');
  const tamperedSourceAnchorFiles = Object.assign({}, files);
  const tamperedSourceAnchor = JSON.parse(tamperedSourceAnchorFiles[sourceAnchorPath]);
  tamperedSourceAnchor.disclaimer = !tamperedSourceAnchor.disclaimer;
  tamperedSourceAnchorFiles[sourceAnchorPath] = JSON.stringify(tamperedSourceAnchor, null, 2);
  assert.throws(() => engine.verifyTestSessionFiles(tamperedSourceAnchorFiles, result.workDir),
    /sourceAnchor|consumer|view|binding|drift/i,
    'changing source-anchor bytes without rebinding must invalidate external/history TEST authority');

  const unboundSourceAnchorFiles = Object.assign({}, files);
  const unboundSourceAnchorProvenance = JSON.parse(unboundSourceAnchorFiles[provenancePath]);
  delete unboundSourceAnchorProvenance.consumerBinding.views.sourceAnchor;
  unboundSourceAnchorFiles[provenancePath] = JSON.stringify(unboundSourceAnchorProvenance, null, 2);
  assert.throws(() => engine.verifyTestSessionFiles(unboundSourceAnchorFiles, result.workDir),
    /unbound source-anchor\.json|sourceAnchor|report\/anchor authority/i,
    'archive source-anchor bytes must not be promoted when provenance lacks the exact control-view binding');
  const beforeUnboundAnchorRestore = canonicalSnapshot(engine.snapshotSession(result.workDir));
  assert.throws(() => engine.restoreVerifiedTestSession(unboundSourceAnchorFiles, result.workDir),
    /session authority verification failed.*source-anchor|sourceAnchor|report\/anchor authority/i,
    'verified restore must reject an old/forged session that carries source-anchor without same-version binding');
  assert.strictEqual(canonicalSnapshot(engine.snapshotSession(result.workDir)), beforeUnboundAnchorRestore,
    'rejected unbound source-anchor restore must preserve exact live VFS');

  // A66: external session JSON keys must already be canonical. The VFS normalizes duplicate slashes/dot segments;
  // accepting those aliases at the restore boundary would let archive policy inspect one raw key while authority
  // verification consumes a different canonical file. Reject aliases before VFS restore and reject slash/backslash
  // aliases that collapse onto the same canonical key.
  const nonCanonicalReportFiles = Object.assign({}, unboundReportFiles);
  delete nonCanonicalReportFiles[result.workDir + '/report.html'];
  nonCanonicalReportFiles[result.workDir + '//report.html'] = '<html><body>A66 NONCANONICAL REPORT ALIAS</body></html>';
  const beforeNonCanonicalProbe = canonicalSnapshot(engine.snapshotSession(result.workDir));
  assert.throws(() => engine.verifyTestSessionFiles(nonCanonicalReportFiles, result.workDir), /路径非规范|non.?canonical/i,
    'duplicate-slash report alias must be rejected before VFS normalization can create canonical report.html');
  assert.strictEqual(canonicalSnapshot(engine.snapshotSession(result.workDir)), beforeNonCanonicalProbe,
    'noncanonical alias verification must restore the exact live VFS');

  const dotAliasFiles = Object.assign({}, unboundReportFiles);
  delete dotAliasFiles[result.workDir + '/report.html'];
  dotAliasFiles[result.workDir + '/./report.html'] = '<html><body>A66 DOT REPORT ALIAS</body></html>';
  assert.throws(() => engine.verifyTestSessionFiles(dotAliasFiles, result.workDir), /路径非规范|non.?canonical/i,
    'dot-segment report alias must be rejected before VFS normalization');

  const collisionFiles = Object.assign({}, files);
  collisionFiles[result.workDir + '\\report.html'] = '<html><body>A66 BACKSLASH COLLISION</body></html>';
  assert.throws(() => engine.verifyTestSessionFiles(collisionFiles, result.workDir), /路径别名冲突|alias/i,
    'slash/backslash JSON keys that collapse to the same VFS file must fail closed');

  // Historical reissue is a same-version presentation transaction, not a legacy exists-first render.
  const immutableBeforeReissue = canonicalSnapshot(Object.fromEntries(Object.entries(engine.snapshotSession(result.workDir))
    .filter(([k]) => k.includes('/.semantic-first-production-v1/'))));
  const reissued = await engine.rebuildVerifiedHistoricalReport(files, result.workDir, {
    provider: 'mock', model: 'mock', maxTokens: 32000, temperature: 0.3,
    plain: false, readerGuide: false, skipRosterConfirm: true, semanticFirstMode: 'off'
  });
  assert(reissued && reissued.html && reissued.semanticProvenance, 'verified historical reissue must return a proven presentation');
  const reissueCurrent = bundledHost.readTestSemanticCurrent(result.workDir);
  assert.strictEqual(reissueCurrent.revision, webCurrent.revision, 'historical reissue must preserve semantic revision');
  bundledHost.validateTestProvenance(result.workDir, { attestation: bundle.testSemantic }, reissueCurrent, reissued.semanticProvenance);
  const immutableAfterReissue = canonicalSnapshot(Object.fromEntries(Object.entries(engine.snapshotSession(result.workDir))
    .filter(([k]) => k.includes('/.semantic-first-production-v1/'))));
  assert.strictEqual(immutableAfterReissue, immutableBeforeReissue,
    'same-version reissue must not append/replace semantic request/review/fidelity/commit evidence');

  // A56 failure rollback: force a late reader-guide requirement on a session that never produced R8.
  // renderReport may already have rewritten presentation bytes when this fails; the engine must restore the full entry snapshot.
  const beforeFailedReissue = canonicalSnapshot(engine.snapshotSession(result.workDir));
  await assert.rejects(() => engine.rebuildHistoricalReport(result.workDir, {
    provider: 'mock', model: 'mock', maxTokens: 32000, temperature: 0.3,
    plain: false, readerGuide: true, skipRosterConfirm: true, semanticFirstMode: 'off'
  }), /consumer|readerGuide|binding|view/i,
  'historical reissue with missing approved R8 evidence must fail closed');
  assert.strictEqual(canonicalSnapshot(engine.snapshotSession(result.workDir)), beforeFailedReissue,
    'failed historical reissue must restore report/provenance and every other session byte to entry state');
  const afterFailedReissueCurrent = bundledHost.readTestSemanticCurrent(result.workDir);
  assert.strictEqual(afterFailedReissueCurrent.revision, webCurrent.revision,
    'failed historical reissue must not advance semantic revision');

  // A58: external plain-dictionary staging is shared outside workDir. Reissue must restore it exactly even when
  // the requested historical presentation fails after plainDictPath has overwritten the staging file.
  bundle.vfs.writeFileSync('/input/plain-dict-ext.json', 'A58-PREEXISTING-STAGING', 'utf8');
  const beforePlainStageFailure = canonicalSnapshot(engine.snapshotSession(result.workDir));
  await assert.rejects(() => engine.rebuildHistoricalReport(result.workDir, {
    provider: 'mock', model: 'mock', maxTokens: 32000, temperature: 0.3,
    plain: true, readerGuide: false, skipRosterConfirm: true, semanticFirstMode: 'off',
    plainDictExt: JSON.stringify({ 'A58测试词': '只用于历史重建事务探针' })
  }), /plain|PLAIN|consumer|binding|view/i,
  'historical reissue without approved PLAIN evidence must fail closed after staging probe');
  assert.strictEqual(bundle.vfs.readFileSync('/input/plain-dict-ext.json', 'utf8'), 'A58-PREEXISTING-STAGING',
    'failed historical reissue leaked/overwrote shared external-dictionary staging');
  assert.strictEqual(canonicalSnapshot(engine.snapshotSession(result.workDir)), beforePlainStageFailure,
    'plain-dictionary staging failure path must also restore exact workDir entry bytes');
  bundle.vfs.unlinkSync('/input/plain-dict-ext.json');

  // A60: the real UI path is verified history install + rebuild. A late rebuild failure must restore the live VFS
  // from before history installation, not merely the history snapshot that the inner rebuild saw on entry.
  const liveOnlyPath = result.workDir + '/.tmp-a60-live-only.txt';
  bundle.vfs.writeFileSync(liveOnlyPath, 'A60 LIVE STATE MUST SURVIVE FAILED REISSUE', 'utf8');
  const beforeOuterReissueFailure = canonicalSnapshot(engine.snapshotSession(result.workDir));
  await assert.rejects(() => engine.rebuildVerifiedHistoricalReport(files, result.workDir, {
    provider: 'mock', model: 'mock', maxTokens: 32000, temperature: 0.3,
    plain: false, readerGuide: true, skipRosterConfirm: true, semanticFirstMode: 'off'
  }), /consumer|readerGuide|binding|view/i,
  'verified-install + reissue outer transaction must fail closed on missing R8 evidence');
  assert.strictEqual(canonicalSnapshot(engine.snapshotSession(result.workDir)), beforeOuterReissueFailure,
    'failed outer reissue transaction must restore the exact pre-click live VFS');
  assert.strictEqual(bundle.vfs.readFileSync(liveOnlyPath, 'utf8'), 'A60 LIVE STATE MUST SURVIVE FAILED REISSUE',
    'failed outer reissue transaction lost pre-existing same-workDir live state');
  bundle.vfs.unlinkSync(liveOnlyPath);

  // PRODUCTION_ACTIVE targeted resume must prune planner-invalidated views from the same-revision provenance
  // instead of weakening validation or falling back to legacy exists-first. Re-run from R5 and require
  // the exact same semantic authority revision to remain self-proving at terminal state.
  const resumeLogs = [];
  const resumed = await engine.runSession({
    speech,
    resumeDir: result.workDir,
    resumeStartNode: 'R5',
    settings: {
      provider: 'mock', model: 'mock', maxTokens: 32000, temperature: 0.3,
      plain: false, readerGuide: false, skipRosterConfirm: false, semanticFirstMode: 'off'
    },
    force: false,
    onRoster: async function (ctx) {
      // A72: a legitimate local roster edit must be able to refresh the already-bound sourceAnchor control view
      // without weakening external/history verification. Add one harmless local alias to force a new anchor hash.
      const edited = JSON.parse(JSON.stringify(ctx.anchor));
      assert(edited.roster && edited.roster.length, 'A72 roster-edit probe requires at least one roster row');
      edited.roster[0].aliases = Array.from(new Set((edited.roster[0].aliases || []).concat(['A72-LOCAL-CONFIRMED-ALIAS'])));
      return { action: 'edit', editedAnchor: edited };
    },
    onLog: line => resumeLogs.push(String(line))
  });
  assert.strictEqual(resumed.ok, true, 'PRODUCTION_ACTIVE targeted resume from R5 must complete: ' + String(resumed.error || '') + '\nRESUME LOG TAIL:\n' + resumeLogs.slice(-80).join('\n'));
  assert.strictEqual(resumed.semanticFirstMode, 'active');
  assert(resumed.semanticProvenance, 'targeted resume final semantic provenance missing');
  assert.strictEqual(resumed.semanticProvenance.authority.revision, webCurrent.revision,
    'targeted resume must reuse the same semantic authority revision');
  assert(resumeLogs.some(x => x.includes('targeted resume 已同步裁剪 semantic consumer binding')),
    'targeted resume semantic binding prune audit log missing');
  assert(resumeLogs.some(x => x.includes('source-anchor fresh state 已同步 same-version control view')),
    'A72 fresh source-anchor rebind audit log missing');
  const resumedAnchor = JSON.parse(bundle.vfs.readFileSync(result.workDir + '/source-anchor.json', 'utf8'));
  assert((resumedAnchor.roster[0].aliases || []).includes('A72-LOCAL-CONFIRMED-ALIAS'),
    'A72 local roster edit was not preserved into the fresh source-anchor');
  assert(resumed.semanticProvenance.consumerBinding.views.sourceAnchor,
    'A72 resumed provenance must retain a rebound sourceAnchor control view');
  assert.strictEqual(resumed.semanticProvenance.consumerBinding.views.sourceAnchor.sha256,
    bundle.sha256Hex(bundle.vfs.readFileSync(result.workDir + '/source-anchor.json', 'utf8')),
    'A72 rebound sourceAnchor hash must match the exact fresh local anchor bytes');
  const resumedCurrent = bundledHost.readTestSemanticCurrent(result.workDir);
  bundledHost.validateTestProvenance(result.workDir, { attestation: bundle.testSemantic }, resumedCurrent, resumed.semanticProvenance);

  const binding = resumed.semanticProvenance.consumerBinding;
  const semanticId = binding.semanticRef.objectId;
  const projectionId = binding.projectionRef.objectId;
  Object.entries(binding.views || {}).forEach(([name, view]) => {
    assert.strictEqual(view.semanticObjectId, semanticId, 'view semantic mismatch: ' + name);
    assert.strictEqual(view.projectionObjectId, projectionId, 'view projection mismatch: ' + name);
  });

  // A75: a later resume that simply confirms the freshly extracted roster must preserve aliases from the prior
  // exact-bound sourceAnchor. Without the bound-anchor carry-forward seam, Web overwrites source-anchor.json with
  // extractor aliases=[] before host can merge the old manual aliases, changing anchor-3 identity semantics.
  const aliasResumeLogs = [];
  const aliasResumed = await engine.runSession({
    speech,
    resumeDir: result.workDir,
    resumeStartNode: 'R5',
    settings: {
      provider: 'mock', model: 'mock', maxTokens: 32000, temperature: 0.3,
      plain: false, readerGuide: false, skipRosterConfirm: false, semanticFirstMode: 'off'
    },
    force: false,
    onRoster: async function () { return { action: 'confirm' }; },
    onLog: line => aliasResumeLogs.push(String(line))
  });
  assert.strictEqual(aliasResumed.ok, true,
    'A75 second targeted resume with confirm-only roster must complete: ' + String(aliasResumed.error || ''));
  const aliasResumedAnchor = JSON.parse(bundle.vfs.readFileSync(result.workDir + '/source-anchor.json', 'utf8'));
  assert((aliasResumedAnchor.roster[0].aliases || []).includes('A72-LOCAL-CONFIRMED-ALIAS'),
    'A75 exact-bound manual alias was lost during fresh resume extraction/confirmation');
  assert(aliasResumeLogs.some(x => x.includes('source-anchor fresh state 已同步 same-version control view')),
    'A75 confirm-only resume must still re-prove/rebind the preserved fresh sourceAnchor');
  bundledHost.validateTestProvenance(result.workDir, { attestation: bundle.testSemantic },
    bundledHost.readTestSemanticCurrent(result.workDir), aliasResumed.semanticProvenance);

  // Failure-path runtime proof: if the semantic epoch cannot become durable, no later semantic/FINAL
  // checkpoint may contaminate the previous durable epoch with the newly published in-memory authority.
  const failDir = '/Output/judge-260913.000002-semantic-epoch-fail';
  const imported = {};
  imported[failDir + '/.tmp-debate.txt'] = speech;
  imported[failDir + '/P1.md'] = 'LEGACY P1 MUST BE INVALIDATED';
  imported[failDir + '/report.html'] = '<html><body>LEGACY REPORT</body></html>';
  engine.restoreSessionScoped(imported, failDir);
  const persistSteps = [];
  const failedEpoch = await engine.runSession({
    speech,
    resumeDir: failDir,
    settings: {
      provider: 'mock', model: 'mock', maxTokens: 32000, temperature: 0.3,
      plain: false, readerGuide: false, skipRosterConfirm: true, semanticFirstMode: 'off'
    },
    force: false,
    persist: async function (step) {
      persistSteps.push(step);
      if (step === 'semantic-epoch-checkpoint') return false;
      return true;
    }
  });
  assert.strictEqual(failedEpoch.ok, false, 'semantic epoch persistence failure must fail the run');
  assert.strictEqual(failedEpoch.persistenceFailed, true, 'semantic epoch persistence failure must be reported');
  const epochIndex = persistSteps.indexOf('semantic-epoch-checkpoint');
  assert(epochIndex >= 0, 'imported legacy session must exercise semantic epoch checkpoint');
  const afterEpochFailure = persistSteps.slice(epochIndex + 1);
  assert(!afterEpochFailure.includes('semantic-checkpoint'), 'failed epoch must not persist new semantic checkpoint into old epoch');
  assert(!afterEpochFailure.includes('pipeline-error'), 'failed epoch must not persist FINAL/error into old epoch');
  assert(!afterEpochFailure.includes('pipeline-done'), 'failed epoch must not persist FINAL/done into old epoch');

  console.log('PASS SemanticFirst-E2E TEST in-memory Web active mock run');
  console.log('PASS route=' + exported.route + ' revision=' + exported.authority.revision + ' views=' + Object.keys(binding.views || {}).length);
  console.log('=== WEB RUNTIME TEST PASS ===');
})().catch(e => {
  console.error(e && e.stack || e);
  process.exitCode = 1;
});
