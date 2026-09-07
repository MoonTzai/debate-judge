'use strict';

// ReportHost — canonical Judge report 与 Web presentation 的唯一生命周期 / trust seam。
function createReportDocument(input) {
  input = input || {};
  if (input.trust !== 'internal' && input.trust !== 'external') {
    throw new Error('ReportDocument trust must be internal or external');
  }
  return Object.freeze({
    canonicalHtml: String(input.canonicalHtml == null ? '' : input.canonicalHtml),
    workDir: input.workDir == null ? null : String(input.workDir),
    trust: input.trust,
    sourceName: input.sourceName == null ? '' : String(input.sourceName),
    capabilities: Object.freeze(Object.assign({}, input.capabilities || {}))
  });
}

function stripActiveElement(html, tag) {
  var pair = new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?<\\/' + tag + '\\s*>', 'gi');
  var single = new RegExp('<' + tag + '\\b[^>]*\\/?\\s*>', 'gi');
  return html.replace(pair, '').replace(single, '');
}

function stripNavigationAttributes(html) {
  return String(html).replace(/<(a|area)\b([^>]*)>/gi, function (_all, tag, attrs) {
    var safeAttrs = String(attrs || '').replace(/\s+(?:href|xlink:href|target|ping|download)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    return '<' + tag + safeAttrs + '>';
  });
}

function createExternalPreview(canonicalHtml) {
  // external display derivative: script / form / object / iframe 等主动内容全部失活；
  // meta refresh / base / link navigation 也移除，避免被动或用户触发的网络导航。canonical 原文从不写回。
  var html = String(canonicalHtml || '');
  html = stripActiveElement(html, 'script');
  html = stripActiveElement(html, 'iframe');
  html = stripActiveElement(html, 'object');
  html = stripActiveElement(html, 'embed');
  html = html.replace(/<meta\b(?=[^>]*http-equiv\s*=\s*(['"]?)refresh\1)[^>]*>/gi, '');
  html = html.replace(/<base\b[^>]*>/gi, '');
  html = html.replace(/<form\b[^>]*>/gi, '<div data-isolated-form="true">').replace(/<\/form\s*>/gi, '</div>');
  html = stripNavigationAttributes(html);
  html = html.replace(/\s+on[a-z0-9_-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  html = html.replace(/\s+(?:action|formaction)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  html = html.replace(/<link\b[^>]*>/gi, '');
  var csp = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'\">";
  if (/<head\b[^>]*>/i.test(html)) html = html.replace(/<head\b[^>]*>/i, function (m) { return m + csp; });
  else if (/<html\b[^>]*>/i.test(html)) html = html.replace(/<html\b[^>]*>/i, function (m) { return m + '<head>' + csp + '</head>'; });
  else html = '<!doctype html><html><head>' + csp + '</head><body>' + html + '</body></html>';
  return html;
}

function createReportHost(options) {
  options = options || {};
  var frame = options.frame || null;
  var current = null;
  var loadGeneration = 0;
  var resizeObserver = null;
  var downloadDocument = null;
  var downloadHandler = null;

  function disconnectResize() {
    if (resizeObserver) { try { resizeObserver.disconnect(); } catch (e) {} }
    resizeObserver = null;
  }

  function disconnectDownloadBridge() {
    if (downloadDocument && downloadHandler && typeof downloadDocument.removeEventListener === 'function') {
      try { downloadDocument.removeEventListener('click', downloadHandler, true); } catch (e) {}
    }
    downloadDocument = null;
    downloadHandler = null;
  }

  function isBridgeableDownloadHref(href) {
    var value = String(href || '').trim().toLowerCase();
    return value.indexOf('blob:') === 0 || value.indexOf('data:') === 0;
  }

  function bridgeDownload(anchor) {
    if (!current || current.trust !== 'internal' || !anchor || !anchor.download || !anchor.href || !isBridgeableDownloadHref(anchor.href) || typeof options.exportFile !== 'function') {
      return Promise.resolve(false);
    }
    var fetchFn = null;
    try {
      if (frame && frame.contentWindow && typeof frame.contentWindow.fetch === 'function') fetchFn = frame.contentWindow.fetch.bind(frame.contentWindow);
      else if (typeof fetch === 'function') fetchFn = fetch;
    } catch (e) {}
    if (!fetchFn) return Promise.reject(new Error('Hosted Report download bridge cannot read the generated file'));
    return Promise.resolve(fetchFn(anchor.href)).then(function (res) {
      if (!res || typeof res.blob !== 'function') throw new Error('Hosted Report download bridge received an invalid file response');
      return res.blob();
    }).then(function (blob) {
      return options.exportFile(blob, String(anchor.download), { kind: 'hosted-report-download', trust: 'internal' });
    }).then(function () { return true; });
  }

  function installDownloadBridge() {
    disconnectDownloadBridge();
    if (!current || current.trust !== 'internal' || typeof options.exportFile !== 'function') return;
    try {
      var doc = frame.contentDocument;
      if (!doc || typeof doc.addEventListener !== 'function') return;
      downloadDocument = doc;
      downloadHandler = function (event) {
        var target = event && event.target;
        var anchor = target && typeof target.closest === 'function' ? target.closest('a[download]') : null;
        if (!anchor || !isBridgeableDownloadHref(anchor.href)) return;
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (event && typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
        bridgeDownload(anchor).catch(function (e) {
          if (typeof options.onExportError === 'function') options.onExportError(e);
        });
      };
      doc.addEventListener('click', downloadHandler, true);
    } catch (e) {}
  }

  function applyHostedPresentation() {
    if (!current || current.trust !== 'internal' || !frame) return;
    try {
      var doc = frame.contentDocument;
      if (!doc) return;
      var plainBtn = doc.getElementById('plainBtn');
      var themeBtn = doc.getElementById('themeBtn');
      if (plainBtn) { plainBtn.hidden = true; plainBtn.setAttribute('aria-hidden', 'true'); }
      if (themeBtn) { themeBtn.hidden = true; themeBtn.setAttribute('aria-hidden', 'true'); }
      Array.prototype.forEach.call(doc.querySelectorAll('table.tb'), function (table) {
        var parent = table.parentElement;
        if (parent && parent.classList && parent.classList.contains('judge-host-table-scroll')) return;
        var wrap = doc.createElement('div');
        wrap.className = 'judge-host-table-scroll';
        wrap.style.maxWidth = '100%';
        wrap.style.overflowX = 'auto';
        wrap.style.WebkitOverflowScrolling = 'touch';
        table.parentNode.insertBefore(wrap, table);
        wrap.appendChild(table);
      });
    } catch (e) {}
  }

  function syncInternalHeight() {
    if (!frame || !current || current.trust !== 'internal') return;
    try {
      var doc = frame.contentDocument;
      if (!doc || !doc.documentElement) return;
      var h = Math.max(600, doc.documentElement.scrollHeight || 0, doc.body ? doc.body.scrollHeight : 0);
      frame.style.height = (h + 8) + 'px';
    } catch (e) {}
  }

  function installInternalRuntime() {
    disconnectResize();
    installDownloadBridge();
    applyHostedPresentation();
    syncInternalHeight();
    try {
      var doc = frame.contentDocument;
      var WinResizeObserver = frame.contentWindow && frame.contentWindow.ResizeObserver;
      if (doc && doc.documentElement && WinResizeObserver) {
        resizeObserver = new WinResizeObserver(function () { syncInternalHeight(); });
        resizeObserver.observe(doc.documentElement);
      }
    } catch (e) {}
    if (typeof options.onReady === 'function') {
      try { options.onReady(current); } catch (e) {}
    }
  }

  function load(documentModel) {
    if (!frame) throw new Error('ReportHost frame is required');
    if (!documentModel || (documentModel.trust !== 'internal' && documentModel.trust !== 'external')) {
      throw new Error('ReportHost requires a trusted ReportDocument');
    }
    var loadTicket = ++loadGeneration;
    disconnectResize();
    disconnectDownloadBridge();
    current = documentModel;
    frame.onload = null;
    if (current.trust === 'external') {
      // Empty sandbox token list yields an opaque, scriptless isolated document. Security wins over auto-height.
      frame.setAttribute('sandbox', '');
      frame.style.height = options.externalHeight || '76vh';
      frame.onload = function () {
        if (loadTicket !== loadGeneration || current !== documentModel) return;
        // external stays isolated; parent never inspects its DOM.
        if (typeof options.onReady === 'function') { try { options.onReady(documentModel); } catch (e) {} }
      };
      frame.srcdoc = createExternalPreview(documentModel.canonicalHtml);
    } else {
      frame.removeAttribute('sandbox');
      frame.onload = function () {
        if (loadTicket !== loadGeneration || current !== documentModel) return;
        installInternalRuntime();
      };
      frame.srcdoc = documentModel.canonicalHtml;
    }
    return current;
  }

  function destroy() {
    ++loadGeneration;
    disconnectResize();
    disconnectDownloadBridge();
    current = null;
    if (frame) { frame.onload = null; frame.srcdoc = ''; }
  }

  function setTheme(theme) {
    if (!current || current.trust !== 'internal' || !frame) return false;
    try {
      var w = frame.contentWindow;
      if (w && typeof w.setTheme === 'function') { w.setTheme(theme); return true; }
      var b = frame.contentDocument && frame.contentDocument.body;
      if (b) { b.classList.toggle('dark', theme === 'dark'); return true; }
    } catch (e) {}
    return false;
  }

  function setPlain(mode) {
    if (!current || current.trust !== 'internal' || !frame) return false;
    try {
      var w = frame.contentWindow;
      if (w && typeof w.setPlainMode === 'function') { w.setPlainMode(mode); syncInternalHeight(); return true; }
    } catch (e) {}
    return false;
  }

  function normalizeSectionId(sectionId) {
    var match = /^C([1-9]|1[0-2])$/i.exec(String(sectionId == null ? '' : sectionId).trim());
    return match ? 'C' + Number(match[1]) : null;
  }

  function resolveSectionElement(doc, sectionId) {
    var semanticId = normalizeSectionId(sectionId);
    if (!doc || !semanticId) return null;
    var domId = semanticId.toLowerCase();
    return doc.getElementById(domId)
      || doc.getElementById(semanticId)
      || (doc.querySelector ? doc.querySelector('[data-section="' + semanticId + '"]') : null)
      || (doc.querySelector ? doc.querySelector('[data-section="' + domId + '"]') : null);
  }

  function guideConclusion(doc, sectionId) {
    try {
      var guide = doc.getElementById('reader-guide-' + sectionId);
      if (!guide) return '';
      var terms = guide.querySelectorAll ? guide.querySelectorAll('dt') : [];
      for (var i = 0; i < terms.length; i++) {
        if (String(terms[i].textContent || '').trim() === '一句话结论') {
          var dd = terms[i].nextElementSibling;
          return dd ? String(dd.textContent || '').trim() : '';
        }
      }
    } catch (e) {}
    return '';
  }

  function getOutline() {
    // R8 / reader-guide 只作为现有报告 DOM 的只读 outline，不生成新裁决语义。
    if (!current || current.trust !== 'internal' || !frame) return [];
    try {
      var doc = frame.contentDocument;
      if (!doc) return [];
      var seen = Object.create(null), out = [];
      for (var i = 1; i <= 12; i++) {
        var id = 'C' + i;
        var el = resolveSectionElement(doc, id);
        if (!el) continue;
        var heading = el.querySelector ? el.querySelector('h1,h2,h3,.ct,.module-title') : null;
        out.push({ id: id, title: String(heading ? heading.textContent : id).trim(), r8: guideConclusion(doc, id) || null });
        seen[id] = true;
      }
      return out;
    } catch (e) { return []; }
  }

  function getReadingState() {
    if (!current || current.trust !== 'internal' || !frame) return null;
    try {
      var doc = frame.contentDocument;
      if (!doc) return null;
      var outline = getOutline();
      if (!outline.length) return { activeSection: null, progress: 0 };
      var frameRect = frame.getBoundingClientRect();
      var anchor = 150;
      var active = outline[0].id;
      for (var i = 0; i < outline.length; i++) {
        var el = resolveSectionElement(doc, outline[i].id);
        if (!el) continue;
        var top = frameRect.top + el.getBoundingClientRect().top;
        if (top <= anchor) active = outline[i].id;
        else break;
      }
      var viewportAnchor = Math.max(0, -frameRect.top + anchor);
      var total = Math.max(1, frame.offsetHeight || frameRect.height || 1);
      var progress = Math.max(0, Math.min(100, Math.round((viewportAnchor / total) * 100)));
      return { activeSection: active, progress: progress };
    } catch (e) { return null; }
  }

  function getSummary() {
    // Verdict Cover 只允许读取既有 C1 / R8 / report header；任何缺失都返回空值而不是推理补全。
    if (!current || current.trust !== 'internal' || !frame) return null;
    try {
      var doc = frame.contentDocument;
      if (!doc) return null;
      var c1 = resolveSectionElement(doc, 'C1');
      var winnerNode = c1 && c1.querySelector ? c1.querySelector('.wn') : doc.querySelector('.wn');
      var why = guideConclusion(doc, 'C1');
      if (!why && c1 && c1.querySelectorAll) {
        var ps = c1.querySelectorAll('p');
        for (var i = 0; i < ps.length; i++) {
          if (ps[i].classList && ps[i].classList.contains('wn')) continue;
          var t = String(ps[i].textContent || '').trim();
          if (t) { why = t; break; }
        }
      }
      var keyClash = guideConclusion(doc, 'C6');
      var titleNode = doc.querySelector('.report-title,h1.title,header h1,h1');
      return {
        winner: winnerNode ? String(winnerNode.textContent || '').trim() : '',
        why: why || '',
        keyClash: keyClash || '',
        reportTitle: titleNode ? String(titleNode.textContent || '').trim() : '',
        c1Available: !!c1
      };
    } catch (e) { return null; }
  }

  function navigate(sectionId) {
    if (!current || current.trust !== 'internal' || !frame) return false;
    try {
      var doc = frame.contentDocument;
      var el = resolveSectionElement(doc, sectionId);
      if (!el) return false;
      // internal Report 已 auto-height，由父页面持有唯一主纵向滚动；不能只滚 iframe viewport。
      var frameRect = frame.getBoundingClientRect();
      var elRect = el.getBoundingClientRect();
      var top = (window.pageYOffset || document.documentElement.scrollTop || 0) + frameRect.top + elRect.top;
      var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      window.scrollTo({ top: Math.max(0, top - 132), behavior: reduceMotion ? 'auto' : 'smooth' });
      return true;
    } catch (e) { return false; }
  }

  function getDocument() { return current; }

  return {
    load: load,
    destroy: destroy,
    setTheme: setTheme,
    setPlain: setPlain,
    navigate: navigate,
    getOutline: getOutline,
    getReadingState: getReadingState,
    getSummary: getSummary,
    getDocument: getDocument,
    bridgeDownload: bridgeDownload,
    syncInternalHeight: syncInternalHeight
  };
}

module.exports = {
  createReportDocument: createReportDocument,
  createExternalPreview: createExternalPreview,
  createReportHost: createReportHost
};
