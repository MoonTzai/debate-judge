'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ReportHost = require(path.join(__dirname, '..', 'web', 'src', 'report-host.js'));

test('ReportHost internal auto-height is idempotent and can shrink after content becomes shorter', () => {
  let contentHeight = 2400;
  const style = { height: '600px' };
  function frameHeight() { return parseInt(style.height, 10) || 0; }

  // Simulate browser scrollHeight feedback: once the iframe viewport becomes taller
  // than content, documentElement/body scrollHeight can report the viewport height.
  // A correct auto-height implementation must break that feedback before measuring.
  const contentNode = {
    getBoundingClientRect() { return { bottom: contentHeight, top: 0, height: contentHeight }; }
  };
  const body = {
    // All traditional viewport-derived metrics are deliberately contaminated.
    get scrollHeight() { return contentHeight + 335; },
    get offsetHeight() { return contentHeight + 335; },
    getBoundingClientRect() { return { top: 0, height: contentHeight + 335 }; },
    children: [contentNode],
    querySelectorAll() { return []; }
  };
  const documentElement = {
    // Real Chromium can report html.scrollHeight slightly above the true body content
    // because the iframe viewport itself participates in the root scroll box.
    // ReportHost must not use this contaminated root value as content authority.
    get scrollHeight() { return contentHeight + 335; }
  };
  const doc = {
    body,
    documentElement,
    getElementById() { return null; },
    querySelectorAll() { return []; }
  };
  const frame = {
    style,
    contentDocument: doc,
    contentWindow: {},
    setAttribute() {},
    removeAttribute() {},
    getBoundingClientRect() { return { top: 0, height: frameHeight() }; }
  };

  const host = ReportHost.createReportHost({ frame });
  host.load({ trust: 'internal', canonicalHtml: '<!doctype html><html><body></body></html>' });

  for (let i = 0; i < 20; i++) host.syncInternalHeight();
  assert.equal(style.height, '2400px',
    'same content must not grow the iframe on repeated ResizeObserver/sync callbacks');

  contentHeight = 1200;
  host.syncInternalHeight();
  assert.equal(style.height, '1200px',
    'shorter content must shrink the iframe instead of preserving a blank tail');
});
