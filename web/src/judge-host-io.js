'use strict';

// JudgeHostIO — UI 只表达“导出什么”，环境策略由 Host / standalone adapter 承担。
function defaultFallbackExport(blob, filename) {
  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    return Promise.reject(new Error('JudgeHostIO standalone export is unavailable outside a browser'));
  }
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  (document.body || document.documentElement).appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 2000);
  return Promise.resolve({ ok: true, via: 'download' });
}

function resolveBridge(explicitBridge) {
  if (explicitBridge) return explicitBridge;
  try {
    if (typeof window !== 'undefined' && window.DCJudgeHostBridge) return window.DCJudgeHostBridge;
  } catch (e) {}
  return null;
}

function createJudgeHostIO(options) {
  options = options || {};
  var fallbackExport = options.fallbackExport || defaultFallbackExport;

  function environment() {
    var bridge = resolveBridge(options.bridge);
    if (bridge && typeof bridge.capabilities === 'function') {
      try { return { hosted: true, capabilities: bridge.capabilities() || {} }; } catch (e) {}
    }
    return { hosted: !!bridge, capabilities: {} };
  }

  function saveBlob(blob, filename, meta) {
    var bridge = resolveBridge(options.bridge);
    if (bridge) {
      // Host presence, not method presence, defines ownership. A hosted page must never bypass
      // host policy by silently degrading to the standalone browser path.
      if (typeof bridge.exportFile !== 'function') {
        return Promise.reject(new Error('Judge Host bridge does not expose exportFile'));
      }
      // Hosted policy (Native / browser / share fallback) belongs to DCJudgeHost.
      // If that host path fails, surface the failure; do not start a second local export that may duplicate a completed write/share.
      return Promise.resolve().then(function () {
        return bridge.exportFile(blob, filename, meta || {});
      });
    }
    return Promise.resolve(fallbackExport(blob, filename, meta || {}));
  }

  function saveText(content, filename, type, meta) {
    var blob = new Blob([content], { type: type || 'text/plain;charset=utf-8' });
    return saveBlob(blob, filename, meta || {});
  }

  return {
    saveBlob: saveBlob,
    saveText: saveText,
    environment: environment
  };
}

module.exports = {
  createJudgeHostIO: createJudgeHostIO,
  defaultFallbackExport: defaultFallbackExport
};
