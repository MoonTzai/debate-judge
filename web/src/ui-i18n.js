'use strict';

// Display-only localization. Canonical settings, API inputs, evidence and report
// documents remain owned by their existing modules. No network or model calls.
var catalog = require('./ui-locales.js');
var STORAGE_KEY = 'debate_judge_ui_language_v1';
var CONTENT = 'script,style,code,pre,textarea,iframe,[data-ui-content],[translate="no"],#logbox,.si-title,.archive-detail-title,.archive-flight-session-option b,.submission-file-row,.report-cover-title,#report-outline-list';
// Only these generated UI summaries may contain translated fragments. All other
// nodes require a whole-string dictionary match, never a substring replacement.
var COMPOUND = '#pn-live,#pn-rounds,#pn-retries,#run-current-round,#derived-axes,#docket-tendency-summary,#docket-context-summary,#upload-config-summary,#provider-default-hint,#model-list-title,#model-list-status,#plain-dict-status,#history-count,#history-limit-status,#history-storage-orphans,#fr-export-status,#fr-storage,#resume-target-plan,#file-info,.si-preview,.si-meta,.si-badge,.archive-detail-meta,.archive-version-row,.model-capabilities,.fr-run-meta,[data-ui-summary]';
var ATTRS = ['title', 'aria-label', 'placeholder'];
function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }
function flat(value, prefix, out) {
  Object.keys(value || {}).forEach(function (key) {
    var p = prefix ? prefix + '.' + key : key, v = value[key];
    if (typeof v === 'string') out[p] = v;
    else if (v && typeof v === 'object') flat(v, p, out);
  });
  return out;
}
function create(options) {
  var doc = options.document, win = doc.defaultView;
  var language = 'zh-CN', exact = new Map(), fragments = new Map();
  var textState = new WeakMap(), attrState = new WeakMap();
  var observer = null, fragmentRe = null, mounted = false;
  try { if (win.localStorage.getItem(STORAGE_KEY) === 'en') language = 'en'; } catch (e) {}
  function add(zh, en) {
    if (!norm(zh)) return;
    // English needs spaces around inline emphasis even when Chinese does not.
    exact.set(norm(zh), en);
    fragments.set(zh, en);
  }
  function textParts(html) {
    var t = doc.createElement('template'); t.innerHTML = html;
    var walker = doc.createTreeWalker(t.content, 4), n, parts = [];
    while ((n = walker.nextNode())) if (norm(n.nodeValue)) parts.push(n.nodeValue);
    return parts;
  }
  var source = flat(options.source, '', {});
  Object.keys(catalog.messages).forEach(function (key) {
    if (source[key] == null) return;
    var zh = source[key], en = Object.prototype.hasOwnProperty.call(catalog.variants, zh) ? catalog.variants[zh] : catalog.messages[key];
    if (/<[a-z][^>]*>/i.test(zh)) {
      var a = textParts(zh), b = textParts(en);
      if (a.length !== b.length) throw new Error('UI locale markup mismatch: ' + key);
      a.forEach(function (s, i) { add(s, b[i]); });
    } else add(zh.replace(/&#10;/g, '\n'), en.replace(/&#10;/g, '\n'));
  });
  Object.keys(catalog.extra).forEach(function (zh) { add(zh, catalog.extra[zh]); });
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  // One pass over the original prevents translated output from being retranslated.
  var fragmentKeys = Array.from(fragments.keys()).filter(function (s) { return /[\u3400-\u9fff]/.test(s); }).sort(function (a,b) { return b.length-a.length; });
  fragmentRe = new RegExp(fragmentKeys.map(escapeRe).join('|'), 'g');
  function translate(s, compound) {
    s = String(s == null ? '' : s);
    if (language !== 'en') return s;
    var direct = exact.get(norm(s));
    if (direct !== undefined) return (/^\s/.test(direct) ? '' : (s.match(/^\s*/) || [''])[0]) + direct + (/\s$/.test(direct) ? '' : (s.match(/\s*$/) || [''])[0]);
    return compound ? s.replace(fragmentRe, function (x) { return fragments.get(x); }) : s;
  }
  // Dialogs can contain user data. Only translate a complete known message or
  // known framing at its edges; never translate an interpolated name/error body.
  function message(s) {
    s = String(s == null ? '' : s);
    if (language !== 'en' || exact.has(norm(s))) return translate(s, false);
    var prefix = '', suffix = '', rest = s;
    for (var i = 0; i < fragmentKeys.length; i++) {
      var k = fragmentKeys[i];
      if (k.length >= 4 && rest.indexOf(k) === 0) { prefix = fragments.get(k); rest = rest.slice(k.length); break; }
    }
    for (var j = 0; j < fragmentKeys.length; j++) {
      var tail = fragmentKeys[j];
      if (tail.length >= 5 && rest.endsWith(tail)) { suffix = fragments.get(tail); rest = rest.slice(0, -tail.length); break; }
    }
    return prefix + rest + suffix;
  }
  function excluded(el) { return !el || !!el.closest(CONTENT); }
  function renderText(node) {
    var el = node.parentElement;
    if (excluded(el)) return;
    var current = node.nodeValue, saved = textState.get(node);
    if (!saved || current !== saved.rendered) saved = { original: current, rendered: current };
    var next = translate(saved.original, !!el.closest(COMPOUND));
    saved.rendered = next; textState.set(node, saved);
    if (current !== next) node.nodeValue = next;
  }
  function renderAttrs(el) {
    if (!el || el.nodeType !== 1 || el.closest('script,style,[data-ui-content],[translate="no"]')) return;
    var saved = attrState.get(el) || {};
    ATTRS.forEach(function (name) {
      if (!el.hasAttribute(name)) { delete saved[name]; return; }
      var current = el.getAttribute(name), state = saved[name];
      if (!state || current !== state.rendered) state = {original:current, rendered:current};
      state.rendered = translate(state.original, el.matches('.si-badge')); saved[name] = state;
      if (current !== state.rendered) el.setAttribute(name, state.rendered);
    });
    attrState.set(el, saved);
  }
  function renderTree(root) {
    if (!root) return;
    if (root.nodeType === 3) { renderText(root); return; }
    if (root.nodeType === 1) renderAttrs(root);
    if (root.nodeType !== 1 && root.nodeType !== 9) return;
    if (root.nodeType === 1 && excluded(root)) return;
    var walker = doc.createTreeWalker(root, 5, {acceptNode:function (n) {
      if (n.nodeType === 1) renderAttrs(n);
      return n.nodeType === 1 && excluded(n) ? 2 : 1;
    }}), node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === 3) renderText(node); else renderAttrs(node);
    }
  }
  function updateLanguageControl() {
    doc.documentElement.lang = language;
    var zh = doc.getElementById('ui-lang-zh'), en = doc.getElementById('ui-lang-en');
    if (zh) zh.setAttribute('aria-pressed', String(language === 'zh-CN'));
    if (en) en.setAttribute('aria-pressed', String(language === 'en'));
  }
  function setLanguage(value) {
    if (value !== 'en' && value !== 'zh-CN') return;
    // Process pending canonical mutations before changing display language.
    if (observer) observer.takeRecords().forEach(processMutation);
    language = value;
    try { win.localStorage.setItem(STORAGE_KEY, language); } catch (e) {}
    renderTree(doc.body); updateLanguageControl();
  }
  function processMutation(m) {
    if (m.type === 'characterData') renderText(m.target);
    else if (m.type === 'attributes') renderAttrs(m.target);
    else Array.prototype.forEach.call(m.addedNodes, renderTree);
  }
  function mount() {
    if (mounted) return; mounted = true;
    var zh = doc.getElementById('ui-lang-zh'), en = doc.getElementById('ui-lang-en');
    if (zh) zh.addEventListener('click', function () { setLanguage('zh-CN'); });
    if (en) en.addEventListener('click', function () { setLanguage('en'); });
    renderTree(doc.body); updateLanguageControl();
    observer = new win.MutationObserver(function (records) { records.forEach(processMutation); });
    observer.observe(doc.body, {childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:ATTRS});
  }
  function originalText(el) {
    if (!el) return '';
    var w = doc.createTreeWalker(el, 4), s = '', n;
    while ((n = w.nextNode())) { var record = textState.get(n); s += record && record.rendered === n.nodeValue ? record.original : n.nodeValue; }
    return s;
  }
  return {mount:mount,setLanguage:setLanguage,getLanguage:function(){return language;},translate:translate,message:message,originalText:originalText};
}
module.exports = {create:create, STORAGE_KEY:STORAGE_KEY};
