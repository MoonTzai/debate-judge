'use strict';

// P0-7｜Flight evidence export
// Pure read-model serializer + store-only ZIP builder. This module owns no IndexedDB/Judge/Recorder mutation authority.

function clonePlain(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function utf8Bytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  var text = String(value == null ? '' : value);
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
  var encoded = unescape(encodeURIComponent(text));
  var out = new Uint8Array(encoded.length);
  for (var i = 0; i < encoded.length; i++) out[i] = encoded.charCodeAt(i) & 0xff;
  return out;
}

var CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    CRC_TABLE[n] = c >>> 0;
  }
  return CRC_TABLE;
}
function crc32(bytes) {
  var table = crcTable();
  var c = 0xffffffff;
  for (var i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function put16(view, off, value) { view.setUint16(off, value & 0xffff, true); }
function put32(view, off, value) { view.setUint32(off, value >>> 0, true); }
function concatBytes(parts) {
  var total = 0;
  parts.forEach(function (p) { total += p.length; });
  var out = new Uint8Array(total), offset = 0;
  parts.forEach(function (p) { out.set(p, offset); offset += p.length; });
  return out;
}
function asciiPath(path) {
  path = String(path || '');
  if (!/^[A-Za-z0-9._\/-]+$/.test(path) || path.indexOf('..') >= 0 || path.charAt(0) === '/') {
    throw new Error('unsafe ZIP entry path: ' + path);
  }
  return path;
}

function makeZip(entries) {
  entries = (entries || []).map(function (entry) {
    var path = asciiPath(entry.path);
    return { path: path, name: utf8Bytes(path), data: utf8Bytes(entry.data), crc: 0 };
  });
  var localParts = [], centralParts = [], offset = 0;
  // DOS 1980-01-01 00:00:00 keeps archive metadata deterministic.
  var dosTime = 0, dosDate = 33;
  entries.forEach(function (entry) {
    entry.crc = crc32(entry.data);
    var local = new Uint8Array(30 + entry.name.length);
    var lv = new DataView(local.buffer);
    put32(lv, 0, 0x04034b50); put16(lv, 4, 20); put16(lv, 6, 0x0800); put16(lv, 8, 0);
    put16(lv, 10, dosTime); put16(lv, 12, dosDate); put32(lv, 14, entry.crc);
    put32(lv, 18, entry.data.length); put32(lv, 22, entry.data.length); put16(lv, 26, entry.name.length); put16(lv, 28, 0);
    local.set(entry.name, 30);
    localParts.push(local, entry.data);

    var central = new Uint8Array(46 + entry.name.length);
    var cv = new DataView(central.buffer);
    put32(cv, 0, 0x02014b50); put16(cv, 4, 20); put16(cv, 6, 20); put16(cv, 8, 0x0800); put16(cv, 10, 0);
    put16(cv, 12, dosTime); put16(cv, 14, dosDate); put32(cv, 16, entry.crc);
    put32(cv, 20, entry.data.length); put32(cv, 24, entry.data.length); put16(cv, 28, entry.name.length);
    put16(cv, 30, 0); put16(cv, 32, 0); put16(cv, 34, 0); put16(cv, 36, 0); put32(cv, 38, 0); put32(cv, 42, offset);
    central.set(entry.name, 46);
    centralParts.push(central);
    offset += local.length + entry.data.length;
  });
  var centralBytes = concatBytes(centralParts);
  var eocd = new Uint8Array(22), ev = new DataView(eocd.buffer);
  put32(ev, 0, 0x06054b50); put16(ev, 4, 0); put16(ev, 6, 0); put16(ev, 8, entries.length); put16(ev, 10, entries.length);
  put32(ev, 12, centralBytes.length); put32(ev, 16, offset); put16(ev, 20, 0);
  return concatBytes(localParts.concat([centralBytes, eocd]));
}

function jsonEntry(path, value) {
  return { path: path, data: JSON.stringify(value, null, 2) + '\n' };
}
function sessionMeta(record) {
  record = record || {};
  return {
    id: record.id == null ? null : String(record.id),
    workDir: record.dir == null ? (record.id == null ? null : String(record.id)) : String(record.dir),
    title: record.title == null ? '' : String(record.title),
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null,
    status: record.status || null,
    reportReady: !!record.reportReady
  };
}
function requestSummary(record) {
  var out = clonePlain(record || {});
  if (out && typeof out === 'object') delete out.requestBodyText;
  return out;
}
function positiveInt(value) {
  var n = Number(value);
  return isFinite(n) && n > 0 && Math.floor(n) === n ? n : null;
}

function buildFlightExportArchive(input) {
  input = input || {};
  var sourceSessions = Array.isArray(input.sessions) ? input.sessions : [];
  var exportedAt = input.exportedAt || new Date().toISOString();
  var entries = [];
  var manifest = {
    kind: 'judge-web-flight-evidence-v1',
    version: 1,
    exportedAt: exportedAt,
    authority: 'evidence-only-readonly',
    notes: [
      'Flight Recorder is evidence-only and is not Judge state authority.',
      'Missing/truncated/mismatched evidence is recorded as observed and is never reconstructed.'
    ],
    sessions: [],
    missing: []
  };

  sourceSessions.forEach(function (source, sessionIndex) {
    source = source || {};
    var sessionNo = String(sessionIndex + 1).padStart(3, '0');
    var sessionPath = 'sessions/session-' + sessionNo;
    var record = clonePlain(source.sessionRecord || {});
    var meta = sessionMeta(record);
    var sessionManifest = Object.assign({}, meta, { path: sessionPath, missing: [], flightRuns: [] });
    manifest.sessions.push(sessionManifest);
    entries.push(jsonEntry(sessionPath + '/session-record.json', record));
    if (source.runModel != null) entries.push(jsonEntry(sessionPath + '/run-model.json', clonePlain(source.runModel)));
    else sessionManifest.missing.push('runModel');

    var runs = Array.isArray(source.flightRuns) ? source.flightRuns : [];
    if (!runs.length) {
      sessionManifest.missing.push('flight_runs');
      manifest.missing.push({ session: meta.workDir, item: 'flight_runs' });
    }
    runs.forEach(function (runSource, runIndex) {
      runSource = runSource || {};
      var runRecord = clonePlain(runSource.run || {});
      var runNo = String(runIndex + 1).padStart(3, '0');
      var runPath = sessionPath + '/flight/run-' + runNo;
      entries.push(jsonEntry(runPath + '/run.json', runRecord));
      var requestSources = Array.isArray(runSource.requests) ? runSource.requests.slice() : [];
      requestSources.sort(function (a, b) {
        return Number(a && a.record && a.record.index || 0) - Number(b && b.record && b.record.index || 0);
      });
      var runManifest = {
        path: runPath,
        runId: runRecord.id || null,
        provider: runRecord.provider || null,
        model: runRecord.model || null,
        startedAt: runRecord.startedAt || null,
        endedAt: runRecord.endedAt || null,
        status: runRecord.status || null,
        requestCount: Number(runRecord.requestCount || 0),
        capture_truncated: !!runRecord.captureTruncated,
        missing: [],
        requests: []
      };
      sessionManifest.flightRuns.push(runManifest);

      var actualIndexes = Object.create(null);
      requestSources.forEach(function (reqSource, requestOrdinal) {
        reqSource = reqSource || {};
        var recordReq = clonePlain(reqSource.record || null);
        var reqNo = String(requestOrdinal + 1).padStart(3, '0');
        var reqPath = runPath + '/request-' + reqNo;
        var actualIndex = recordReq ? positiveInt(recordReq.index) : null;
        if (actualIndex) actualIndexes[actualIndex] = (actualIndexes[actualIndex] || 0) + 1;
        var raw = utf8Bytes(reqSource.rawBytes || new Uint8Array(0));
        var expectedBytes = recordReq ? Number(recordReq.rawBytes || 0) : null;
        var expectedChunks = recordReq ? Number(recordReq.chunkCount || 0) : null;
        var actualBytes = reqSource.actualRawBytes == null ? raw.length : Number(reqSource.actualRawBytes || 0);
        var actualChunks = reqSource.actualChunkCount == null ? null : Number(reqSource.actualChunkCount || 0);
        var mismatch = [];
        var missing = [];
        if (!recordReq) missing.push('request_record');
        if (reqSource.readError) missing.push('artifact_read_error');
        if (recordReq && actualBytes !== expectedBytes) mismatch.push('raw_bytes');
        if (recordReq && actualChunks != null && actualChunks !== expectedChunks) mismatch.push('chunk_count');
        var reqManifest = {
          path: reqPath,
          requestId: recordReq && recordReq.id || null,
          index: actualIndex,
          startedAt: recordReq && recordReq.startedAt || null,
          endedAt: recordReq && recordReq.endedAt || null,
          status: recordReq && recordReq.status || null,
          httpStatus: !recordReq || recordReq.httpStatus == null ? null : Number(recordReq.httpStatus),
          expectedRawBytes: expectedBytes,
          expectedChunkCount: expectedChunks,
          actualRawBytes: actualBytes,
          actualChunkCount: actualChunks,
          capture_truncated: !!(recordReq && recordReq.captureTruncated),
          capture_truncated_reason: recordReq && recordReq.captureTruncatedReason || null,
          artifact_read_error: reqSource.readError || null,
          missing: missing,
          mismatch: mismatch
        };
        runManifest.requests.push(reqManifest);
        if (!recordReq) {
          runManifest.missing.push('request_record:' + reqNo);
          manifest.missing.push({ session: meta.workDir, runId: runRecord.id || null, item: 'request_record', ordinal: requestOrdinal + 1 });
          return;
        }
        entries.push({ path: reqPath + '/request.json', data: String(reqSource.requestText == null ? '' : reqSource.requestText) });
        entries.push({ path: reqPath + '/response.sse.raw', data: raw });
        entries.push(jsonEntry(reqPath + '/summary.json', requestSummary(recordReq)));
      });

      var claimed = positiveInt(runRecord.requestCount) || 0;
      for (var expectedIndex = 1; expectedIndex <= claimed; expectedIndex++) {
        if (!actualIndexes[expectedIndex]) {
          var gap = 'request_index:' + expectedIndex;
          runManifest.missing.push(gap);
          manifest.missing.push({ session: meta.workDir, runId: runRecord.id || null, item: 'request_index', index: expectedIndex });
        } else if (actualIndexes[expectedIndex] > 1) {
          runManifest.missing.push('duplicate_request_index:' + expectedIndex);
        }
      }
      if (runRecord.captureTruncated && !requestSources.some(function (r) { return !!(r && r.record && r.record.captureTruncated); })) {
        runManifest.missing.push('run_capture_truncated_without_request_marker');
      }
    });
  });

  entries.unshift(jsonEntry('manifest.json', manifest));
  return { bytes: makeZip(entries), manifest: manifest, entries: entries.map(function (e) { return e.path; }) };
}

function summarizeFlightManifest(manifest) {
  var s = { sessions: 0, requests: 0, missingItems: 0, affectedRequests: 0, truncatedRequests: 0, truncatedRuns: 0, complete: true };
  // Top-level missing repeats nested details; count the nested evidence once.
  (manifest.sessions || []).forEach(function (session) {
    s.sessions++;
    s.missingItems += (session.missing || []).length;
    (session.flightRuns || []).forEach(function (run) {
      s.missingItems += (run.missing || []).length;
      if (run.capture_truncated) s.truncatedRuns++;
      (run.requests || []).forEach(function (req) {
        s.requests++;
        if (req.capture_truncated) s.truncatedRequests++;
        if ((req.missing || []).length || (req.mismatch || []).length || req.capture_truncated || req.artifact_read_error) s.affectedRequests++;
      });
    });
  });
  s.complete = !(s.missingItems || s.affectedRequests || s.truncatedRuns);
  return s;
}

// Current-session diagnostics only. Inputs are snapshots; this function cannot
// mutate Judge, storage, or the recorder, and does not infer semantic approval.
function buildDebugExportArchive(input) {
  input = input || {};
  var redactions = [], seenRedactions = Object.create(null);
  var secrets = (input.secrets || []).filter(function (s) { return typeof s === 'string' && s.length > 0; });
  var replacement = utf8Bytes('[REDACTED_CREDENTIAL]');
  function noteRedaction(where) {
    if (!seenRedactions[where]) { seenRedactions[where] = true; redactions.push(where); }
  }
  function scrub(value, where) {
    if (typeof value === 'string') {
      secrets.forEach(function (secret) {
        if (value.indexOf(secret) >= 0) { value = value.split(secret).join('[REDACTED_CREDENTIAL]'); noteRedaction(where); }
      });
      return value;
    }
    if (value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      var out = utf8Bytes(value);
      secrets.forEach(function (secret) {
        var needle = utf8Bytes(secret), parts = [], start = 0;
        for (var i = 0; i <= out.length - needle.length; i++) {
          var match = true;
          for (var j = 0; j < needle.length; j++) if (out[i + j] !== needle[j]) { match = false; break; }
          if (!match) continue;
          parts.push(out.subarray(start, i), replacement);
          i += needle.length - 1; start = i + 1;
        }
        if (parts.length) { parts.push(out.subarray(start)); out = concatBytes(parts); noteRedaction(where); }
      });
      return out;
    }
    if (Array.isArray(value)) return value.map(function (v, i) { return scrub(v, where + '[' + i + ']'); });
    if (!value || typeof value !== 'object') return value;
    var copy = {};
    Object.keys(value).forEach(function (key) {
      if (/^(?:api[-_]?key|x-api-key|authorization|access[-_]?token|password|client[-_]?secret)$/i.test(key)) {
        copy[key] = '[REDACTED_CREDENTIAL]'; noteRedaction(where + '/' + key);
      } else if (/(?:^|\/)(?:\.?api-config|credentials|secrets)\.json$/i.test(key)) {
        noteRedaction(where + '/' + key); // Credential files are not diagnostic artifacts.
      } else copy[key] = scrub(value[key], where + '/' + key);
    });
    return copy;
  }
  var data = {};
  Object.keys(input).forEach(function (key) { if (key !== 'secrets') data[key] = scrub(input[key], key); });
  var workDir = String(data.workDir || ''), exportedAt = data.exportedAt || new Date().toISOString();
  var files = data.files || {}, errors = data.readErrors || [];
  var flightSource = data.flightSource || { sessionRecord: { id: workDir, dir: workDir }, flightRuns: [] };
  var flight = buildFlightExportArchive({ sessions: [flightSource], exportedAt: exportedAt });
  var summary = summarizeFlightManifest(flight.manifest);
  var entries = [];
  function addJson(name, value) { entries.push(jsonEntry(name, value)); }
  var sessionPayload = {
    kind: 'judge-web-session-v1', exportedAt: exportedAt, workDir: workDir,
    files: files, settings: data.settings || {}, captureState: data.captureState,
    sessionRecord: data.sessionRecord || null, runModel: data.runModel || null
  };
  if (workDir && Object.keys(files).length) addJson('session/session-export.json', sessionPayload);
  addJson('session/files.json', files);
  addJson('session/session-record.json', data.sessionRecord || null);
  addJson('session/run-model.json', data.runModel || null);
  addJson('session/settings.json', data.settings || {});
  addJson('session/persisted-checkpoint.json', data.persistedSnapshot || null);
  addJson('session/previous-versions.json', data.versions || []);
  addJson('debug/environment.json', data.environment || {});
  addJson('debug/telemetry.json', data.telemetry || {});
  entries.push({ path: 'logs/Judge-run-log.txt', data: '\ufeff' + String(data.logText || '') });
  entries.push({ path: 'flight/flight-evidence.zip', data: flight.bytes });
  entries.push(jsonEntry('flight/manifest.json', flight.manifest));
  var artifacts = {};
  [['.tmp-debate.txt', 'source/transcript.txt'], ['report.html', 'reports/report.html'],
    ['report-plain.html', 'reports/report-plain.html']].forEach(function (pair) {
    var content = files[workDir + '/' + pair[0]];
    artifacts[pair[0]] = typeof content === 'string';
    if (typeof content === 'string') entries.push({ path: pair[1], data: content });
  });
  var manifest = {
    kind: 'judge-web-debug-bundle-v1', version: 1, exportedAt: exportedAt,
    captureFinishedAt: data.captureFinishedAt || exportedAt, workDir: workDir,
    captureState: data.captureState || 'unknown', authority: 'evidence-only-readonly',
    fileCount: Object.keys(files).length, artifacts: artifacts,
    liveFilesUsed: !!data.liveFilesUsed, persistedSnapshotPresent: !!data.persistedSnapshot,
    flightSummary: summary, pendingFlightBytesAtStart: data.pendingFlightBytes || 0,
    readErrors: errors, redactedLocations: redactions,
    missing: flight.manifest.missing.slice(),
    notes: [
      'Only this session is included. Missing or partial evidence is not reconstructed.',
      'Current memory files and durable checkpoints are saved separately; export never changes either.',
      'Live capture is not an atomic checkpoint across the UI, Judge, and Flight stores. Requests may continue during export.',
      'Detailed missing/truncated/mismatched request evidence is in flight/manifest.json.',
      'Credential fields and known local API key values are redacted in exported copies. Transcripts and model output remain sensitive.',
      'This bundle does not certify a judgment or that an interrupted stage can be resumed without repeating its request.'
    ],
    entries: ['manifest.json', 'README.txt'].concat(entries.map(function (e) { return e.path; }))
  };
  if (!workDir || !Object.keys(files).length) manifest.missing.push({ item: 'session_files' });
  if (!data.logText) manifest.missing.push({ item: 'ui_run_log' });
  entries.unshift(jsonEntry('manifest.json', manifest), { path: 'README.txt', data:
    'Debate-Judge Semantic Edition - Debug bundle\n' +
    'logs/: complete captured UI log. session/: current export, durable checkpoints, settings, run model and prior versions.\n' +
    'source/ and reports/: available transcript and HTML reports. Other round outputs, prompts and review artifacts remain in session/files.json.\n' +
    'flight/flight-evidence.zip: recorded requests and raw responses for all runs associated with this session.\n' +
    'Read both manifests for missing, partial or redacted evidence. Contains private transcript/model content; share deliberately.\n' });
  return { bytes: makeZip(entries), manifest: manifest };
}

module.exports = {
  buildDebugExportArchive: buildDebugExportArchive,
  summarizeFlightManifest: summarizeFlightManifest,
  buildFlightExportArchive: buildFlightExportArchive,
  makeZip: makeZip,
  crc32: crc32,
  utf8Bytes: utf8Bytes
};
