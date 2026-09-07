'use strict';

// Debate-Judge Web Flight Recorder
// 纯旁路 sidecar：只记录浏览器真实 API 请求/响应证据，不参与 Judge 的 prompt、retry、gate、round/output 或续跑权威。

const DB_NAME = 'judge-web-flight-recorder';
const DB_VERSION = 1;
const DEFAULT_BACKLOG_LIMIT = 64 * 1024 * 1024;

function nowIso() { return new Date().toISOString(); }
function clonePlain(v) {
  if (v == null) return v;
  try { return JSON.parse(JSON.stringify(v)); } catch (e) { return String(v); }
}
function randomId(prefix) {
  var tail = Math.random().toString(36).slice(2, 10);
  return prefix + '-' + Date.now().toString(36) + '-' + tail;
}
function toUint8Copy(value) {
  if (!value) return new Uint8Array(0);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  return new Uint8Array(0);
}
function combineChunks(chunks) {
  chunks = (chunks || []).slice().sort(function (a, b) { return Number(a.seq || 0) - Number(b.seq || 0); });
  var total = 0;
  for (var i = 0; i < chunks.length; i++) {
    var b = chunks[i].bytes;
    total += b instanceof ArrayBuffer ? b.byteLength : (b && b.byteLength) || 0;
  }
  var out = new Uint8Array(total);
  var off = 0;
  for (var j = 0; j < chunks.length; j++) {
    var u8 = toUint8Copy(chunks[j].bytes);
    out.set(u8, off);
    off += u8.byteLength;
  }
  return out;
}

function createIndexedDbStorage(options) {
  options = options || {};
  var dbPromise = null;
  function warn(msg) {
    try { if (typeof options.onWarning === 'function') options.onWarning(msg); } catch (e) {}
  }
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      try {
        if (typeof indexedDB === 'undefined') throw new Error('IndexedDB unavailable');
        var req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains('runs')) {
            var runs = db.createObjectStore('runs', { keyPath: 'id' });
            runs.createIndex('startedAt', 'startedAt', { unique: false });
            runs.createIndex('workDir', 'workDir', { unique: false });
          }
          if (!db.objectStoreNames.contains('requests')) {
            var requests = db.createObjectStore('requests', { keyPath: 'id' });
            requests.createIndex('runId', 'runId', { unique: false });
            requests.createIndex('attemptToken', 'attemptToken', { unique: false });
          }
          if (!db.objectStoreNames.contains('chunks')) {
            var chunks = db.createObjectStore('chunks', { keyPath: 'id' });
            chunks.createIndex('requestId', 'requestId', { unique: false });
            chunks.createIndex('runId', 'runId', { unique: false });
          }
        };
        req.onsuccess = function () {
          var db = req.result;
          db.onversionchange = function () { try { db.close(); } catch (e) {} dbPromise = null; };
          db.onclose = function () { dbPromise = null; };
          resolve(db);
        };
        req.onerror = function () { dbPromise = null; reject(req.error || new Error('IndexedDB open failed')); };
        req.onblocked = function () { warn('Flight Recorder 数据库升级被其它页面阻塞'); };
      } catch (e) {
        dbPromise = null;
        reject(e);
      }
    });
    return dbPromise;
  }
  function put(store, value) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        try {
          var tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).put(value);
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(tx.error || new Error('IndexedDB write failed')); };
          tx.onabort = function () { reject(tx.error || new Error('IndexedDB write aborted')); };
        } catch (e) { reject(e); }
      });
    });
  }
  function get(store, id) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        try {
          var tx = db.transaction(store, 'readonly');
          var req = tx.objectStore(store).get(id);
          req.onsuccess = function () { resolve(req.result || null); };
          req.onerror = function () { reject(req.error || new Error('IndexedDB read failed')); };
        } catch (e) { reject(e); }
      });
    });
  }
  function getAll(store) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        try {
          var tx = db.transaction(store, 'readonly');
          var req = tx.objectStore(store).getAll();
          req.onsuccess = function () { resolve(req.result || []); };
          req.onerror = function () { reject(req.error || new Error('IndexedDB read failed')); };
        } catch (e) { reject(e); }
      });
    });
  }
  function getAllByIndex(store, indexName, key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        try {
          var tx = db.transaction(store, 'readonly');
          var idx = tx.objectStore(store).index(indexName);
          var req = idx.getAll(key);
          req.onsuccess = function () { resolve(req.result || []); };
          req.onerror = function () { reject(req.error || new Error('IndexedDB indexed read failed')); };
        } catch (e) { reject(e); }
      });
    });
  }
  function deleteByIds(store, ids) {
    ids = ids || [];
    if (!ids.length) return Promise.resolve();
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        try {
          var tx = db.transaction(store, 'readwrite');
          var os = tx.objectStore(store);
          ids.forEach(function (id) { os.delete(id); });
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(tx.error || new Error('IndexedDB delete failed')); };
          tx.onabort = function () { reject(tx.error || new Error('IndexedDB delete aborted')); };
        } catch (e) { reject(e); }
      });
    });
  }
  function clearAll() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        try {
          var tx = db.transaction(['runs', 'requests', 'chunks'], 'readwrite');
          tx.objectStore('runs').clear();
          tx.objectStore('requests').clear();
          tx.objectStore('chunks').clear();
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(tx.error || new Error('IndexedDB clear failed')); };
          tx.onabort = function () { reject(tx.error || new Error('IndexedDB clear aborted')); };
        } catch (e) { reject(e); }
      });
    });
  }
  return {
    init: openDb,
    putRun: function (rec) { return put('runs', rec); },
    putRequest: function (rec) { return put('requests', rec); },
    putChunk: function (rec) { return put('chunks', rec); },
    getRequest: function (id) { return get('requests', id); },
    listRuns: function () { return getAll('runs').then(function (rows) { return rows.sort(function (a, b) { return String(b.startedAt || '').localeCompare(String(a.startedAt || '')); }); }); },
    listRequests: function (runId) { return getAllByIndex('requests', 'runId', runId).then(function (rows) { return rows.sort(function (a, b) { return Number(a.index || 0) - Number(b.index || 0); }); }); },
    readChunks: function (requestId) { return getAllByIndex('chunks', 'requestId', requestId).then(function (rows) { return rows.sort(function (a, b) { return Number(a.seq || 0) - Number(b.seq || 0); }); }); },
    deleteRun: function (runId) {
      return Promise.all([getAllByIndex('requests', 'runId', runId), getAllByIndex('chunks', 'runId', runId)]).then(function (parts) {
        var reqs = parts[0] || [], chunks = parts[1] || [];
        return deleteByIds('chunks', chunks.map(function (x) { return x.id; }))
          .then(function () { return deleteByIds('requests', reqs.map(function (x) { return x.id; })); })
          .then(function () { return deleteByIds('runs', [runId]); });
      });
    },
    clearAll: clearAll
  };
}

function createFlightRecorder(options) {
  options = options || {};
  var warnFn = typeof options.onWarning === 'function' ? options.onWarning : function (msg) {
    try { console.warn('[judge-web flight-recorder] ' + msg); } catch (e) {}
  };
  var storage = options.storage || createIndexedDbStorage({ onWarning: warnFn });
  var sha256 = typeof options.sha256 === 'function' ? options.sha256 : null;
  var backlogLimit = Number(options.backlogLimitBytes) > 0 ? Number(options.backlogLimitBytes) : DEFAULT_BACKLOG_LIMIT;
  var currentRun = null;
  var attempts = Object.create(null);
  var queue = Promise.resolve();
  var pendingBytes = 0;
  var disabled = false;

  function warn(msg) { try { warnFn(String(msg)); } catch (e) {} }
  function schedule(task, costBytes, onError) {
    if (disabled) return;
    costBytes = Number(costBytes || 0);
    pendingBytes += costBytes;
    queue = queue.then(function () { return Promise.resolve().then(task); })
      .catch(function (e) {
        warn('记录写入失败：' + (e && e.message ? e.message : e));
        try { if (typeof onError === 'function') onError(e); } catch (e2) {}
      }).then(function () {
        pendingBytes = Math.max(0, pendingBytes - costBytes);
      });
  }
  function putRunSnapshot(run) {
    if (!run || typeof storage.putRun !== 'function') return;
    var copy = clonePlain(run);
    schedule(function () { return storage.putRun(copy); }, 0);
  }
  function putRequestSnapshot(ctx) {
    if (!ctx || typeof storage.putRequest !== 'function') return;
    var copy = clonePlain(ctx.record);
    schedule(function () { return storage.putRequest(copy); }, 0);
  }
  function markTruncated(ctx, why) {
    if (!ctx || ctx.record.captureTruncated) return;
    ctx.record.captureTruncated = true;
    ctx.record.captureTruncatedReason = why || 'storage-backlog';
    if (currentRun && currentRun.id === ctx.record.runId) {
      currentRun.captureTruncated = true;
      putRunSnapshot(currentRun);
    }
    putRequestSnapshot(ctx);
    warn('Flight Recorder 原始流记录已截断（' + (why || 'storage-backlog') + '），Judge 继续运行。');
  }

  function bindRun(meta) {
    meta = meta || {};
    var id = randomId('wfr');
    currentRun = {
      id: id,
      workDir: String(meta.workDir || ''),
      provider: String(meta.provider || ''),
      baseUrl: String(meta.baseUrl || ''),
      model: String(meta.model || ''),
      startedAt: nowIso(),
      endedAt: null,
      status: 'running',
      requestCount: 0,
      captureTruncated: false
    };
    putRunSnapshot(currentRun);
    return id;
  }
  function finishRun(status) {
    if (!currentRun) return;
    currentRun.endedAt = nowIso();
    currentRun.status = String(status || 'finished');
    putRunSnapshot(currentRun);
  }

  var observer = {
    beginAttempt: function (attemptToken, meta, requestBodyText) {
      try {
        if (!currentRun || disabled) return;
        var index = ++currentRun.requestCount;
        var requestId = currentRun.id + '#request-' + String(index).padStart(3, '0');
        var requestText = String(requestBodyText == null ? '' : requestBodyText);
        var rec = {
          id: requestId,
          runId: currentRun.id,
          index: index,
          attemptToken: String(attemptToken || ''),
          endpoint: String(meta && meta.endpoint || ''),
          model: String(meta && meta.model || currentRun.model || ''),
          startedAt: nowIso(),
          endedAt: null,
          requestBodyText: requestText,
          requestSha256: sha256 ? String(sha256(requestText)) : null,
          httpStatus: null,
          status: 'streaming',
          rawBytes: 0,
          chunkCount: 0,
          done: false,
          finishReason: null,
          usage: null,
          contentChars: 0,
          reasoningChars: 0,
          captureTruncated: false,
          error: null
        };
        attempts[String(attemptToken || '')] = { record: rec, seq: 0 };
        putRunSnapshot(currentRun);
        putRequestSnapshot(attempts[String(attemptToken || '')]);
      } catch (e) { warn('beginAttempt 失败：' + (e && e.message ? e.message : e)); }
    },
    rawChunk: function (attemptToken, value) {
      try {
        var ctx = attempts[String(attemptToken || '')];
        if (!ctx || disabled || ctx.record.captureTruncated) return;
        var copy = toUint8Copy(value);
        if (!copy.byteLength) return;
        if (pendingBytes + copy.byteLength > backlogLimit) {
          markTruncated(ctx, 'backlog-limit');
          return;
        }
        var seq = ++ctx.seq;
        ctx.record.rawBytes += copy.byteLength;
        ctx.record.chunkCount = seq;
        var chunkRec = {
          id: ctx.record.id + '#chunk-' + String(seq).padStart(8, '0'),
          requestId: ctx.record.id,
          runId: ctx.record.runId,
          seq: seq,
          bytes: copy.buffer
        };
        schedule(function () {
          if (typeof storage.putChunk === 'function') return storage.putChunk(chunkRec);
        }, copy.byteLength, function () { markTruncated(ctx, 'storage-write-failed'); });
        if (seq % 16 === 0) putRequestSnapshot(ctx);
      } catch (e) { warn('rawChunk 失败：' + (e && e.message ? e.message : e)); }
    },
    httpErrorBody: function (attemptToken, status, bodyText) {
      try {
        var ctx = attempts[String(attemptToken || '')];
        if (!ctx || disabled) return;
        ctx.record.httpStatus = Number(status || 0) || null;
        ctx.record.httpErrorBody = String(bodyText == null ? '' : bodyText);
        putRequestSnapshot(ctx);
      } catch (e) { warn('httpErrorBody 失败：' + (e && e.message ? e.message : e)); }
    },
    finishAttempt: function (attemptToken, summary) {
      try {
        var key = String(attemptToken || '');
        var ctx = attempts[key];
        if (!ctx || disabled) return;
        summary = summary || {};
        ctx.record.endedAt = nowIso();
        ctx.record.httpStatus = Number(summary.httpStatus || ctx.record.httpStatus || 0) || null;
        ctx.record.status = String(summary.status || 'complete');
        ctx.record.done = !!summary.done;
        ctx.record.finishReason = summary.finishReason == null ? null : String(summary.finishReason);
        ctx.record.usage = clonePlain(summary.usage || null);
        ctx.record.contentChars = Number(summary.contentChars || 0);
        ctx.record.reasoningChars = Number(summary.reasoningChars || 0);
        putRequestSnapshot(ctx);
        delete attempts[key];
      } catch (e) { warn('finishAttempt 失败：' + (e && e.message ? e.message : e)); }
    },
    failAttempt: function (attemptToken, summary) {
      try {
        var key = String(attemptToken || '');
        var ctx = attempts[key];
        if (!ctx || disabled) return;
        summary = summary || {};
        ctx.record.endedAt = nowIso();
        ctx.record.httpStatus = Number(summary.httpStatus || ctx.record.httpStatus || 0) || null;
        ctx.record.status = String(summary.status || (ctx.record.rawBytes > 0 ? 'partial' : 'error'));
        ctx.record.done = !!summary.done;
        ctx.record.finishReason = summary.finishReason == null ? null : String(summary.finishReason);
        ctx.record.usage = clonePlain(summary.usage || null);
        ctx.record.contentChars = Number(summary.contentChars || 0);
        ctx.record.reasoningChars = Number(summary.reasoningChars || 0);
        ctx.record.error = String(summary.error || 'request failed');
        putRequestSnapshot(ctx);
        delete attempts[key];
      } catch (e) { warn('failAttempt 失败：' + (e && e.message ? e.message : e)); }
    }
  };

  function init() {
    if (typeof storage.init !== 'function') return;
    try {
      Promise.resolve(storage.init()).catch(function (e) { warn('Recorder DB 初始化失败：' + (e && e.message ? e.message : e)); });
    } catch (e) { warn('Recorder DB 初始化失败：' + (e && e.message ? e.message : e)); }
  }
  function listRuns() {
    if (typeof storage.listRuns !== 'function') return Promise.resolve([]);
    return Promise.resolve(storage.listRuns()).catch(function (e) { warn(e); return []; });
  }
  function listRequests(runId) {
    if (typeof storage.listRequests !== 'function') return Promise.resolve([]);
    return Promise.resolve(storage.listRequests(runId)).catch(function (e) { warn(e); return []; });
  }
  function getRequestArtifact(requestId) {
    var getReq = typeof storage.getRequest === 'function' ? storage.getRequest(requestId) : Promise.resolve(null);
    var getChunks = typeof storage.readChunks === 'function' ? storage.readChunks(requestId) : Promise.resolve([]);
    return Promise.all([getReq, getChunks]).then(function (parts) {
      var req = parts[0] || null;
      var chunks = parts[1] || [];
      var raw = combineChunks(chunks);
      return {
        request: req,
        requestText: req ? String(req.requestBodyText || '') : '',
        rawBytes: raw,
        actualRawBytes: raw.byteLength,
        actualChunkCount: chunks.length,
        summary: req ? clonePlain(req) : null,
        readError: null
      };
    }).catch(function (e) {
      warn(e);
      return { request: null, requestText: '', rawBytes: new Uint8Array(0), actualRawBytes: 0, actualChunkCount: 0, summary: null, readError: String(e && e.message ? e.message : e) };
    });
  }
  function deleteRun(runId) {
    if (typeof storage.deleteRun !== 'function') return Promise.resolve();
    return Promise.resolve(storage.deleteRun(runId)).catch(function (e) { warn(e); });
  }
  function clearAll() {
    if (typeof storage.clearAll !== 'function') return Promise.resolve();
    return Promise.resolve(storage.clearAll()).catch(function (e) { warn(e); });
  }
  function estimateStorage() {
    try {
      if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.estimate === 'function') {
        return navigator.storage.estimate().catch(function () { return null; });
      }
    } catch (e) {}
    return Promise.resolve(null);
  }
  function requestPersistence() {
    try {
      if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persist === 'function') {
        return navigator.storage.persist().catch(function () { return false; });
      }
    } catch (e) {}
    return Promise.resolve(false);
  }
  // 测试/导出读取用 drain：等待当前队列完成；若失败回调又排入元数据任务，则继续等待直到队列引用稳定。
  // 运行期 observer 从不调用/await 此函数，因此不会形成 Judge 请求背压。
  function flushQueue() {
    var seen = queue;
    return seen.catch(function () {}).then(function () {
      if (queue !== seen) return flushQueue();
    });
  }

  return {
    init: init,
    bindRun: bindRun,
    finishRun: finishRun,
    observer: observer,
    listRuns: listRuns,
    listRequests: listRequests,
    getRequestArtifact: getRequestArtifact,
    deleteRun: deleteRun,
    clearAll: clearAll,
    estimateStorage: estimateStorage,
    requestPersistence: requestPersistence,
    flush: flushQueue,
    getPendingBytes: function () { return pendingBytes; },
    disable: function () { disabled = true; },
    enable: function () { disabled = false; }
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createFlightRecorder: createFlightRecorder, createIndexedDbStorage: createIndexedDbStorage, combineChunks: combineChunks, DB_NAME: DB_NAME };
}
