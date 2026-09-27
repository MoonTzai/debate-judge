// A1（260819）：原文/白话正式切换控件——以 render-report 公开 seam 验证交付 HTML/CSS contract。
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const RR = require('../render-report.js');

let failed = 0;
function check(name, condition, detail) {
  console.log((condition ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' :: ' + detail : ''));
  if (!condition) failed++;
}

const plainSource = '<!doctype html><html><body><div class="theme-bar"><button id="themeBtn" type="button">深色模式</button></div><p data-orig="原文" data-plain="白话">原文</p></body></html>';
const noPlainSource = '<!doctype html><html><body><p>只有原文</p></body></html>';
const injected = RR.injectPlainToggle(plainSource);

check('PT-0 就绪性：公开渲染 seam 可用', typeof RR.injectPlainToggle === 'function' && typeof RR.frontendJs === 'function');
check('PT-1 无双版本单元时不注入控件', RR.injectPlainToggle(noPlainSource) === noPlainSource);
check('PT-2 正式控件只注入一次', injected === RR.injectPlainToggle(injected));
check('PT-3 正式控件含 Alt+T、状态与可访问属性',
  /id="plainBtn"/.test(injected) &&
  /class="plain-toggle"/.test(injected) &&
  /aria-keyshortcuts="Alt\+T"/.test(injected) &&
  /aria-pressed="false"/.test(injected) &&
  /title="切换原文\/白话（Alt\+T）"/.test(injected),
  injected.match(/<button[^>]*id="plainBtn"[^>]*>/)?.[0] || 'plainBtn 缺失'
);
check('PT-3A 有主题栏时标记控件宿主以避免后续面板遮挡',
  /class="theme-bar plain-toggle-host"/.test(injected));

const css = fs.readFileSync(path.join(__dirname, '..', 'assets', 'report.css'), 'utf-8');
check('PT-4 悬浮控件 CSS：桌面右上、移动右下、安全区与焦点可见',
  /#plainBtn\s*\{(?=[^}]*position\s*:\s*fixed)(?=[^}]*top\s*:)(?=[^}]*right\s*:)(?=[^}]*safe-area-inset-top)(?=[^}]*safe-area-inset-right)/.test(css) &&
  /@media\s*\(max-width\s*:\s*700px\)\s*\{[\s\S]*?#plainBtn\s*\{[\s\S]*?top\s*:\s*auto[\s\S]*?bottom\s*:[\s\S]*?safe-area-inset-bottom/.test(css) &&
  /#plainBtn:focus-visible\s*\{/.test(css),
  '需固定定位、移动安全区与键盘焦点样式'
);
check('PT-5 悬浮控件为主题按钮预留水平空间',
  /#plainBtn\s*\+\s*#themeBtn\s*\{[^}]*margin-right\s*:\s*7rem/.test(css),
  '主题按钮需避开固定 plainBtn'
);
check('PT-5A 桌面主题栏为 API 配置栏预留垂直空间',
  /@media\(min-width:701px\)\{\.theme-bar\.plain-toggle-host\s*\+\s*\.api-config-wrap\s*\{[^}]*margin-top\s*:/.test(css),
  'API 配置栏需避开固定 plainBtn'
);

function makeClassList() {
  const values = new Set();
  return {
    add(name) { values.add(name); },
    remove(name) { values.delete(name); },
    toggle(name, force) {
      if (force === true) { values.add(name); return true; }
      if (force === false) { values.delete(name); return false; }
      if (values.has(name)) { values.delete(name); return false; }
      values.add(name); return true;
    },
    contains(name) { return values.has(name); }
  };
}

function makeElement(attrs, innerHTML) {
  const values = Object.assign({}, attrs);
  return {
    textContent: '',
    innerHTML: innerHTML || '',
    value: '',
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : null; },
    setAttribute(name, value) { values[name] = String(value); },
    querySelector() { return null; }
  };
}

function makeGuideModule() {
  const values = {
    'data-orig': '<h2 class="st">C9 辩论的三维度六向度</h2><p>原文 C9</p>',
    'data-plain': '<h2 class="st">C9 辩论的三维度六向度</h2><p>白话 C9</p>'
  };
  let html = '<h2 class="st">C9 辩论的三维度六向度</h2><details class="reader-guide-card reader-guide-card-embedded" id="reader-guide-C9"><summary>章节导览</summary><dl style="margin-top:12px"><dt>本章说什么</dt><dd data-orig="测试导览" data-plain="测试白话导览">测试导览</dd></dl></details><p>原文 C9</p>';
  return {
    get innerHTML() { return html; },
    set innerHTML(value) { html = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : null; },
    setAttribute(name, value) { values[name] = String(value); },
    querySelector(selector) {
      if (selector === '.reader-guide-card-embedded') {
        const m = html.match(/<details class="reader-guide-card reader-guide-card-embedded"[^>]*>[\s\S]*?<\/details>/);
        if (!m) return null;
        return {
          outerHTML: m[0],
          querySelectorAll(innerSelector) {
            if (innerSelector !== '[data-plain]') return [];
            const dm = html.match(/<dd data-orig="([^"]*)" data-plain="([^"]*)">([\s\S]*?)<\/dd>/);
            if (!dm) return [];
            return [{
              getAttribute(name) { return name === 'data-orig' ? dm[1] : name === 'data-plain' ? dm[2] : null; },
              get innerHTML() { const cur = html.match(/<dd data-orig="[^"]*" data-plain="[^"]*">([\s\S]*?)<\/dd>/); return cur ? cur[1] : ''; },
              set innerHTML(value) { html = html.replace(/(<dd data-orig="[^"]*" data-plain="[^"]*">)[\s\S]*?(<\/dd>)/, '$1' + value + '$2'); }
            }];
          }
        };
      }
      if (selector === 'h2.st') {
        return {
          insertAdjacentHTML(position, value) {
            if (position !== 'afterend') throw new Error('unexpected insert position');
            html = html.replace(/(<h2 class="st">[\s\S]*?<\/h2>)/, '$1' + value);
          }
        };
      }
      return null;
    }
  };
}

function makeRuntime(savedPlain, script) {
  const listeners = Object.create(null);
  const button = makeElement({ 'aria-pressed': 'false' });
  const unit = makeElement({ 'data-orig': '原文', 'data-plain': '白话' }, '原文');
  const guideModule = makeGuideModule();
  const elements = {
    plainBtn: button,
    themeBtn: makeElement(),
    'cfg-api-url': makeElement(),
    'cfg-model': makeElement(),
    'cfg-api-key': makeElement()
  };
  const store = Object.create(null);
  if (savedPlain) store.judge_plain = savedPlain;
  const document = {
    body: { classList: makeClassList() },
    getElementById(id) { return elements[id] || null; },
    querySelectorAll(selector) { return selector === '[data-plain]' ? [unit, guideModule] : []; },
    addEventListener(name, handler) { listeners[name] = handler; }
  };
  const context = {
    document,
    localStorage: {
      getItem(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
      setItem(key, value) { store[key] = String(value); },
      removeItem(key) { delete store[key]; }
    },
    confirm() { return true; },
    setTimeout() { return 0; },
    URL: { createObjectURL() { return ''; }, revokeObjectURL() {} }
  };
  vm.runInNewContext(script || RR.frontendJs(), context, { filename: 'frontendJs-runtime.js' });
  return { listeners, button, unit, guideModule, document, store };
}

function keyEvent(target, overrides) {
  return Object.assign({
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    key: 't',
    target,
    cancelable: true,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }
  }, overrides || {});
}

function target(tagName, editable) {
  return {
    tagName,
    isContentEditable: !!editable,
    getAttribute() { return null; },
    closest() { return editable ? this : null; }
  };
}

const runtime = makeRuntime();
check('PT-6 运行时就绪：DOM 初始化与 Alt+T 监听均已注册',
  typeof runtime.listeners.DOMContentLoaded === 'function' && typeof runtime.listeners.keydown === 'function');
if (typeof runtime.listeners.DOMContentLoaded === 'function') runtime.listeners.DOMContentLoaded();
const normalKey = keyEvent(target('DIV', false));
if (typeof runtime.listeners.keydown === 'function') runtime.listeners.keydown(normalKey);
check('PT-7 非输入区 Alt+T 切换、持久化并同步按钮状态',
  runtime.document.body.classList.contains('plain') &&
  runtime.unit.innerHTML === '白话' &&
  runtime.store.judge_plain === '1' &&
  runtime.button.textContent === '原文' &&
  runtime.button.getAttribute('aria-pressed') === 'true' &&
  normalKey.defaultPrevented === true);
check('PT-7A 整章 data-orig/data-plain 重写不得吞掉 R8 分章导览，且导览同步切白话',
  runtime.guideModule.innerHTML.includes('<details class="reader-guide-card reader-guide-card-embedded"') &&
  runtime.guideModule.innerHTML.includes('>测试白话导览</dd>') &&
  runtime.guideModule.innerHTML.includes('<p>白话 C9</p>') &&
  runtime.guideModule.innerHTML.indexOf('reader-guide-card-embedded') < runtime.guideModule.innerHTML.indexOf('<p>白话 C9</p>'),
  runtime.guideModule.innerHTML);
const backKey = keyEvent(target('DIV', false));
if (typeof runtime.listeners.keydown === 'function') runtime.listeners.keydown(backKey);
check('PT-7B C9 从白话切回原文时导览与正文同步恢复原文',
  !runtime.document.body.classList.contains('plain') &&
  runtime.guideModule.innerHTML.includes('>测试导览</dd>') && !runtime.guideModule.innerHTML.includes('>测试白话导览</dd>') &&
  runtime.guideModule.innerHTML.includes('<p>原文 C9</p>'), runtime.guideModule.innerHTML);
const forwardAgain = keyEvent(target('DIV', false));
if (typeof runtime.listeners.keydown === 'function') runtime.listeners.keydown(forwardAgain);

const editableKeys = [
  keyEvent(target('INPUT', true)),
  keyEvent(target('TEXTAREA', true)),
  keyEvent(target('SELECT', true)),
  keyEvent(target('DIV', true))
];
for (const event of editableKeys) if (typeof runtime.listeners.keydown === 'function') runtime.listeners.keydown(event);
check('PT-8 所有编辑区 Alt+T 均不切换且不阻止默认行为',
  runtime.document.body.classList.contains('plain') && editableKeys.every(event => event.defaultPrevented === false));

const nonCancelableRuntime = makeRuntime();
if (typeof nonCancelableRuntime.listeners.DOMContentLoaded === 'function') nonCancelableRuntime.listeners.DOMContentLoaded();
const nonCancelableKey = keyEvent(target('DIV', false), { cancelable: false });
if (typeof nonCancelableRuntime.listeners.keydown === 'function') nonCancelableRuntime.listeners.keydown(nonCancelableKey);
check('PT-9 不可取消事件不切换也不阻止默认行为',
  !nonCancelableRuntime.document.body.classList.contains('plain') && nonCancelableKey.defaultPrevented === false);

const modifiedRuntime = makeRuntime();
if (typeof modifiedRuntime.listeners.DOMContentLoaded === 'function') modifiedRuntime.listeners.DOMContentLoaded();
const modifiedKey = keyEvent(target('DIV', false), { ctrlKey: true });
if (typeof modifiedRuntime.listeners.keydown === 'function') modifiedRuntime.listeners.keydown(modifiedKey);
check('PT-10 Ctrl/Meta 组合不冒充 Alt+T',
  !modifiedRuntime.document.body.classList.contains('plain') && modifiedKey.defaultPrevented === false);

const restored = makeRuntime('1');
if (typeof restored.listeners.DOMContentLoaded === 'function') restored.listeners.DOMContentLoaded();
check('PT-11 刷新后从 judge_plain 恢复文本、ARIA 与白话内容',
  restored.document.body.classList.contains('plain') &&
  restored.unit.innerHTML === '白话' &&
  restored.button.textContent === '原文' &&
  restored.button.getAttribute('aria-pressed') === 'true');

const fallbackHtml = RR.injectPlainToggle('<!doctype html><html><body><p data-orig="原文" data-plain="白话">原文</p></body></html>');
const fallbackScript = fallbackHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1] || '';
const fallbackRuntime = makeRuntime('1', fallbackScript);
if (typeof fallbackRuntime.listeners.DOMContentLoaded === 'function') fallbackRuntime.listeners.DOMContentLoaded();
check('PT-12 兜底注入也恢复 judge_plain 状态',
  fallbackRuntime.document.body.classList.contains('plain') &&
  fallbackRuntime.unit.innerHTML === '白话' &&
  fallbackRuntime.button.getAttribute('aria-pressed') === 'true');

const LEGACY_SET_PLAIN_MODE = 'function setPlainMode(on,persist){var b=document.getElementById("plainBtn");if(!b)return false;if(on)document.body.classList.add("plain");else document.body.classList.remove("plain");if(persist)try{localStorage.setItem("judge_plain",on?"1":"0");}catch(e){}b.textContent=on?"原文":"白话";b.setAttribute("aria-pressed",on?"true":"false");var els=document.querySelectorAll("[data-plain]");for(var i=0;i<els.length;i++){var v=on?els[i].getAttribute("data-plain"):els[i].getAttribute("data-orig");if(v!==null)els[i].innerHTML=v;}return true;}';
const GUIDE_PRESERVE_V1_SET_PLAIN_MODE = 'function setPlainMode(on,persist){var b=document.getElementById("plainBtn");if(!b)return false;if(on)document.body.classList.add("plain");else document.body.classList.remove("plain");if(persist)try{localStorage.setItem("judge_plain",on?"1":"0");}catch(e){}b.textContent=on?"原文":"白话";b.setAttribute("aria-pressed",on?"true":"false");var els=document.querySelectorAll("[data-plain]");for(var i=0;i<els.length;i++){var g=els[i].querySelector?els[i].querySelector(".reader-guide-card-embedded"):null,gh=g?g.outerHTML:"",v=on?els[i].getAttribute("data-plain"):els[i].getAttribute("data-orig");if(v!==null){els[i].innerHTML=v;if(gh&&els[i].querySelector&&!els[i].querySelector(".reader-guide-card-embedded")){var h=els[i].querySelector("h2.st");if(h)h.insertAdjacentHTML("afterend",gh);}}}return true;}';
check('PT-13 R8 生产迁移 seam 已导出', typeof RR.migratePlainToggleRuntime === 'function');
if (typeof RR.migratePlainToggleRuntime === 'function') {
  const legacyHtml = '<script>' + LEGACY_SET_PLAIN_MODE + '</script><main>正文保持</main>';
  const migratedHtml = RR.migratePlainToggleRuntime(legacyHtml);
  check('PT-14 已知旧版 runtime 只迁移 setPlainMode 且正文不变',
    migratedHtml.includes('reader-guide-card-embedded') &&
    migratedHtml.includes('<main>正文保持</main>') &&
    !migratedHtml.includes(LEGACY_SET_PLAIN_MODE));
  const v1Html = '<script>' + GUIDE_PRESERVE_V1_SET_PLAIN_MODE + '</script><main>正文保持</main>';
  const migratedV1 = RR.migratePlainToggleRuntime(v1Html);
  check('PT-14A 上一版 C9 导览保护 runtime 可精确迁移到白话导览版',
    migratedV1.includes('querySelectorAll("[data-plain]")') && migratedV1.includes('<main>正文保持</main>') &&
    !migratedV1.includes(GUIDE_PRESERVE_V1_SET_PLAIN_MODE));
  check('PT-15 当前 runtime 迁移幂等', RR.migratePlainToggleRuntime(migratedHtml) === migratedHtml && RR.migratePlainToggleRuntime(migratedV1) === migratedV1);
  let unknownBlocked = false;
  try { RR.migratePlainToggleRuntime('<script>function setPlainMode(){return 1;}</script>'); }
  catch (e) { unknownBlocked = /plain-toggle runtime/.test(String(e.message)); }
  check('PT-16 未知 plain-toggle runtime 必须阻断而非模糊改写', unknownBlocked);
}

console.log(failed === 0 ? '=== plain-toggle ALL PASS ===' : '=== plain-toggle FAILED: ' + failed + ' ===');
process.exit(failed === 0 ? 0 : 1);
