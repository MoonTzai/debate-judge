'use strict';
const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { createFlightRecorder } = require(path.join(ROOT, 'web', 'src', 'flight-recorder.js'));
const { buildFlightExportArchive } = require(path.join(ROOT, 'web', 'src', 'flight-export.js'));

async function proveRecorderPersistsIncarnation() {
  const runs = [];
  const storage = {
    putRun: async rec => { runs.push(JSON.parse(JSON.stringify(rec))); }
  };
  const recorder = createFlightRecorder({ storage });
  recorder.bindRun({
    workDir: '/Output/judge-a94',
    historyInstanceId: 'h1:A94-CURRENT',
    provider: 'mock',
    baseUrl: 'http://example.invalid',
    model: 'a94-model'
  });
  await recorder.flush();
  assert(runs.length >= 1, 'A94 Recorder fixture did not persist a run snapshot');
  assert.strictEqual(runs[runs.length - 1].historyInstanceId, 'h1:A94-CURRENT',
    'A94 Recorder dropped historyInstanceId from the durable run record');
}

function runRecord(id, historyInstanceId, requestCount) {
  return {
    id,
    workDir: '/Output/judge-a94',
    historyInstanceId,
    provider: 'mock',
    model: 'a94-model',
    startedAt: '2026-09-13T00:00:00.000Z',
    endedAt: '2026-09-13T00:00:01.000Z',
    status: 'done',
    requestCount: Number(requestCount || 0),
    captureTruncated: false
  };
}

function requestSource(id, runId, index) {
  return {
    record: {
      id,
      runId,
      index,
      startedAt: '2026-09-13T00:00:00.100Z',
      endedAt: '2026-09-13T00:00:00.900Z',
      status: 'complete',
      httpStatus: 200,
      rawBytes: 0,
      chunkCount: 0,
      captureTruncated: false
    },
    requestText: '{}',
    rawBytes: new Uint8Array(0),
    actualRawBytes: 0,
    actualChunkCount: 0,
    readError: null
  };
}

function proveH1ManifestMismatchIsVisible() {
  const archive = buildFlightExportArchive({
    exportedAt: '2026-09-13T00:00:02.000Z',
    sessions: [{
      sessionRecord: {
        id: '/Output/judge-a94',
        dir: '/Output/judge-a94',
        title: 'A94',
        status: 'done',
        historyRevision: 7,
        historyInstanceId: 'h1:A94-CURRENT'
      },
      runModel: { summary: { derivedStatus: 'done' } },
      flightRuns: [
        { run: runRecord('wfr-current', 'h1:A94-CURRENT'), requests: [] },
        { run: runRecord('wfr-old', 'h1:A94-OLD'), requests: [] }
      ]
    }]
  });
  const session = archive.manifest.sessions[0];
  assert.strictEqual(session.historyRevision, 7, 'A94 manifest dropped session historyRevision');
  assert.strictEqual(session.historyInstanceId, 'h1:A94-CURRENT', 'A94 manifest dropped session historyInstanceId');
  assert.strictEqual(session.flightRuns[0].historyInstanceId, 'h1:A94-CURRENT', 'A94 current run token missing');
  assert.deepStrictEqual(session.flightRuns[0].mismatch, [], 'A94 matching h1 run was falsely marked mismatched');
  assert.deepStrictEqual(session.flightRuns[1].mismatch, ['history_instance'],
    'A94 cross-incarnation h1 run was silently accepted by the pure exporter');
}

function proveRequestRunAttributionIsAudited() {
  const archive = buildFlightExportArchive({
    sessions: [{
      sessionRecord: {
        id: '/Output/judge-a94',
        dir: '/Output/judge-a94',
        historyRevision: 9,
        historyInstanceId: 'h1:A94-CURRENT'
      },
      flightRuns: [{
        run: runRecord('wfr-current', 'h1:A94-CURRENT', 2),
        requests: [
          requestSource('wfr-current#request-001', 'wfr-current', 1),
          requestSource('wfr-other#request-001', 'wfr-other', 2)
        ]
      }]
    }]
  });
  const run = archive.manifest.sessions[0].flightRuns[0];
  assert.deepStrictEqual(run.requests[0].mismatch, [],
    'A95 correctly-owned request was falsely marked as cross-run evidence');
  assert.strictEqual(run.requests[0].runId, 'wfr-current', 'A95 request manifest omitted owning runId');
  assert.deepStrictEqual(run.requests[1].mismatch, ['request_run'],
    'A95 cross-run request was silently accepted by the pure exporter');
  assert.strictEqual(run.requests[1].runId, 'wfr-other', 'A95 mismatched request runId must remain visible for audit');
  assert(run.mismatch.includes('request_run'),
    'A95 run manifest must surface that at least one nested request belongs to a different run');
}

function proveLegacyCompatibilityIsOneWay() {
  const legacy = 'legacy-v0:/Output/judge-a94';
  const archive = buildFlightExportArchive({
    exportedAt: '2026-09-13T00:00:03.000Z',
    sessions: [{
      sessionRecord: {
        id: '/Output/judge-a94',
        dir: '/Output/judge-a94',
        status: 'done',
        historyRevision: 0,
        historyInstanceId: legacy
      },
      flightRuns: [
        { run: runRecord('wfr-pre-a89', ''), requests: [] },
        { run: runRecord('wfr-legacy-tagged', legacy), requests: [] },
        { run: runRecord('wfr-new-h1', 'h1:A94-NEW'), requests: [] }
      ]
    }]
  });
  const runs = archive.manifest.sessions[0].flightRuns;
  assert.deepStrictEqual(runs[0].mismatch, [], 'A94 legacy incarnation must accept a pre-A89 untagged run');
  assert.deepStrictEqual(runs[1].mismatch, [], 'A94 legacy incarnation must accept its exact tagged run');
  assert.deepStrictEqual(runs[2].mismatch, ['history_instance'],
    'A94 legacy compatibility must not absorb a different h1 incarnation');

  const newArchive = buildFlightExportArchive({
    sessions: [{
      sessionRecord: {
        id: '/Output/judge-a94',
        dir: '/Output/judge-a94',
        historyRevision: 1,
        historyInstanceId: 'h1:A94-NEW'
      },
      flightRuns: [{ run: runRecord('wfr-old-untagged', ''), requests: [] }]
    }]
  });
  assert.deepStrictEqual(newArchive.manifest.sessions[0].flightRuns[0].mismatch, ['history_instance'],
    'A94 new h1 incarnation must never absorb an untagged legacy Flight run');
}

(async () => {
  await proveRecorderPersistsIncarnation();
  proveH1ManifestMismatchIsVisible();
  proveRequestRunAttributionIsAudited();
  proveLegacyCompatibilityIsOneWay();
  console.log('=== FLIGHT INCARNATION REGRESSION PASS ===');
})().catch(err => {
  console.error(err && err.stack || err);
  process.exitCode = 1;
});
