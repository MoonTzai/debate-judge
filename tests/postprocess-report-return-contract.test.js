'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const engineSource = fs.readFileSync(path.join(root, 'web', 'src', 'engine.js'), 'utf8');
const uiSource = fs.readFileSync(path.join(root, 'web', 'src', 'ui.js'), 'utf8');
const standalone = fs.readFileSync(path.join(root, 'web', 'judge.html'), 'utf8');

// Regression from real Debug Bundle 20260926-232620:
// postprocess-only R8 completed and report.html existed in the durable session,
// but the early-success return omitted reportHtml, leaving the UI on the run scene.
assert.ok(engineSource.includes("var ppReportHtml = readReportHtml(workDir);"));
assert.ok(engineSource.includes("if (!ppReportHtml) throw new Error('[judge-web TEST] postprocess-only success missing report.html');"));
assert.ok(engineSource.includes("reportHtml: ppReportHtml"));
assert.ok(engineSource.includes("reportFile: settings.plain && ppReportPlain ? 'report-plain.html' : 'report.html'"));

// UI must be resilient even if a future early-success engine branch accidentally omits
// the convenience return field: canonical VFS report.html is deterministic output,
// so reading it does not invent semantics or trigger any model/API work.
assert.ok(uiSource.includes("var terminalReportHtml = res.reportHtml || (engine && res.workDir ? engine.readReportHtml(res.workDir) : null);"));
assert.ok(uiSource.includes("PRODUCTION_ACTIVE canonical VFS report.html fallback"));
assert.ok(uiSource.includes("showReport(terminalReportHtml, res.workDir, 'internal'"));

// Standalone HTML owns two UI copies (module factory + active direct runtime) and both
// must carry the same fallback, while the embedded engine must carry the early-return fix.
const fallbackCount = (standalone.match(/canonical VFS report\.html fallback/g) || []).length;
assert.strictEqual(fallbackCount, 2);
assert.ok(standalone.includes("postprocess-only success missing report.html"));
assert.ok(standalone.includes("reportHtml: ppReportHtml"));

console.log('PASS postprocess-only report return / canonical VFS UI fallback contract');
