'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDebugExportArchive } = require('../web/src/flight-export');

function unzip(bytes) {
  const b = Buffer.from(bytes), files = {}; let i = 0;
  while (b.readUInt32LE(i) === 0x04034b50) {
    const size = b.readUInt32LE(i + 18), n = b.readUInt16LE(i + 26), extra = b.readUInt16LE(i + 28);
    const name = b.subarray(i + 30, i + 30 + n).toString('utf8'), start = i + 30 + n + extra;
    files[name] = b.subarray(start, start + size); i = start + size;
  }
  return files;
}
const wd = '/Output/judge-example';
test('Debug preserves current files and durable checkpoints separately, includes reports and full logs, without mutating inputs', () => {
  const input = { workDir: wd, captureState: 'live/intermediate', liveFilesUsed: true,
    files: { [wd + '/.tmp-debate.txt']: 'source', [wd + '/report.html']: 'current', [wd + '/report-plain.html']: 'plain', [wd + '/P1.md']: 'analysis' },
    persistedSnapshot: { files: { [wd + '/report.html']: 'earlier' } }, versions: [{ files: { [wd + '/report.html']: 'oldest' } }],
    settings: { provider: 'mock' }, logText: Array.from({length: 1000}, (_, i) => 'line ' + i).join('\n') };
  const before = JSON.stringify(input), out = buildDebugExportArchive(input), zip = unzip(out.bytes);
  assert.equal(JSON.stringify(input), before);
  assert.equal(zip['reports/report.html'].toString(), 'current');
  assert.equal(zip['reports/report-plain.html'].toString(), 'plain');
  assert.equal(JSON.parse(zip['session/session-export.json']).files[wd + '/P1.md'], 'analysis');
  assert.equal(JSON.parse(zip['session/persisted-checkpoint.json']).files[wd + '/report.html'], 'earlier');
  assert.equal(JSON.parse(zip['session/previous-versions.json'])[0].files[wd + '/report.html'], 'oldest');
  assert(zip['logs/Judge-run-log.txt'].includes('line 0\n') && zip['logs/Judge-run-log.txt'].includes('line 999'));
  assert.equal(out.manifest.captureState, 'live/intermediate');
  assert.equal(out.manifest.authority, 'evidence-only-readonly');
});
test('Flight raw bytes remain exact, and missing requests/truncation/read errors remain visible', () => {
  const raw = Uint8Array.from([0xff, 0, 13, 10, 65]);
  const out = buildDebugExportArchive({workDir: wd, pendingFlightBytes: 42, readErrors: [{scope:'judge-storage',error:'offline fixture'}],
    flightSource: {sessionRecord:{id:wd,dir:wd},flightRuns:[{run:{id:'run1',requestCount:2,captureTruncated:true},requests:[{
      record:{id:'req1',index:1,rawBytes:8,chunkCount:2,captureTruncated:true}, requestText:'{"fixture":true}', rawBytes:raw, actualRawBytes:5, actualChunkCount:1
    }]}]}});
  const zip = unzip(out.bytes), inner = unzip(zip['flight/flight-evidence.zip']);
  const rawName = Object.keys(inner).find(p => p.endsWith('/response.sse.raw'));
  assert.deepEqual(inner[rawName], Buffer.from(raw));
  assert.equal(out.manifest.pendingFlightBytesAtStart, 42);
  assert.equal(out.manifest.readErrors.length, 1);
  assert.equal(out.manifest.flightSummary.complete, false);
  assert.equal(out.manifest.flightSummary.truncatedRequests, 1);
  assert(out.manifest.missing.some(m => m.item === 'request_index' && m.index === 2));
});
test('Credential fields, credential files and known key values are redacted only in copies, including raw responses', () => {
  const secret = 'LOCAL-KEY-SENTINEL-7845';
  const input = {workDir:wd, secrets:[secret], settings:{apiKey:secret,model:'model'},
    files:{[wd+'/.api-config.json']:'{"apiKey":"other-secret"}',[wd+'/P1.md']:'analysis'},
    logText:'failure '+secret, flightSource:{sessionRecord:{id:wd,dir:wd,settings:{authorization:secret}},flightRuns:[{
      run:{id:'run1',requestCount:1},requests:[{record:{id:'req1',index:1},requestText:secret,rawBytes:Buffer.from('raw '+secret)}]
    }]}};
  const out = buildDebugExportArchive(input), zip = unzip(out.bytes);
  assert(!Buffer.from(out.bytes).includes(secret));
  assert(!Buffer.from(out.bytes).includes('other-secret'));
  assert.equal(input.settings.apiKey,secret);
  assert.equal(input.logText,'failure '+secret);
  assert(out.manifest.redactedLocations.length >= 4);
  assert.equal(JSON.parse(zip['session/settings.json']).model,'model');
});
test('Pre-session failure still exports logs and explains missing session/Flight evidence', () => {
  const out = buildDebugExportArchive({logText:'startup failed',readErrors:[{scope:'storage',error:'unavailable'}]});
  const zip = unzip(out.bytes);
  assert(zip['logs/Judge-run-log.txt'].includes('startup failed'));
  assert(!zip['session/session-export.json']);
  assert(out.manifest.missing.some(m => m.item === 'session_files'));
  assert(out.manifest.missing.some(m => m.item === 'flight_runs'));
});
