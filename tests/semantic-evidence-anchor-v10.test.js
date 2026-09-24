'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const Workflow = require(path.join(ROOT, 'executor', 'semantic-workflow.js'));
const ScAuthority = require(path.join(ROOT, 'executor', 'sc-semantic-authority.js'));

test('V10 global evidence protocol accepts exact contiguous source substrings across lines and rejects normalization', () => {
  const source = '第一行原文\n我们都不应该用结果来衡断这个行为\n第三行原文';
  for (const badQuote of [
    '第一行原文第三行原文',
    '第一行原文 我们都不应该用结果来衡断这个行为',
    '我们都不应该用结果来横断这个行为'
  ]) {
    assert.throws(
      () => Workflow.parseFidelityDecision(JSON.stringify({
        decision: 'reject',
        reason: 'test',
        issues: ['test'],
        evidence: [{ quote: badQuote, reason: 'must fail exact source contract' }]
      }), source),
      err => err && err.code === 'SOURCE_EVIDENCE_MISMATCH'
    );
  }

  const parsed = Workflow.parseFidelityDecision(JSON.stringify({
    decision: 'reject',
    reason: 'test',
    issues: ['test'],
    evidence: [
      { quote: '用结果来衡断这个行为', reason: 'exact in-line substring' },
      { quote: '第一行原文\n我们都不应该用结果来衡断这个行为', reason: 'exact cross-line substring preserving newline' }
    ]
  }), source);
  assert.equal(parsed.evidence.length, 2);
  assert.equal(parsed.evidence[0].quote, '用结果来衡断这个行为');
  assert.equal(parsed.evidence[0].lineStart, 2);
  assert.equal(parsed.evidence[0].lineEnd, 2);
  assert.equal(parsed.evidence[1].lineStart, 1);
  assert.equal(parsed.evidence[1].lineEnd, 2);

  const crlfSource = '第一行原文\r\n第二行原文';
  const crlfParsed = Workflow.parseFidelityDecision(JSON.stringify({
    decision: 'reject',
    reason: 'transport newline audit',
    issues: ['transport newline audit'],
    evidence: [{ quote: '第一行原文\n第二行原文', reason: 'LF transport must map back to exact CRLF source bytes' }]
  }), crlfSource);
  assert.equal(crlfParsed.evidence[0].quote, '第一行原文\r\n第二行原文');
  assert.equal(crlfParsed.evidence[0].lineStart, 1);
  assert.equal(crlfParsed.evidence[0].lineEnd, 2);
});

test('V10 global review/fidelity keeps exact evidence without duplicating the full source as a line index', () => {
  const text = fs.readFileSync(path.join(ROOT, 'executor', 'semantic-workflow.js'), 'utf8');
  assert.match(Workflow.EVIDENCE_QUOTE_PROTOCOL, /逐字符连续 exact substring/);
  assert.match(Workflow.EVIDENCE_QUOTE_PROTOCOL, /允许跨物理行/);
  assert.match(Workflow.EVIDENCE_QUOTE_PROTOCOL, /保留原文真实换行/);
  assert.match(Workflow.EVIDENCE_QUOTE_PROTOCOL, /严禁把多行用空格、标点或其他规范化方式拼成新字符串/);
  assert.match(Workflow.EVIDENCE_QUOTE_PROTOCOL, /严禁修正原文中的错别字、口语噪声、标点或空白/);
  const index = Workflow.buildEvidenceLineIndex('第一行\n原字衡断\n第三行');
  assert.match(index, /证据逐字行索引/);
  assert.ok(index.includes(JSON.stringify('原字衡断')),
    'legacy helper may remain available for diagnostics/tests without being injected into every review');
  assert.match(text, /role === 'review' \|\| role === 'fidelity'/);
  assert.doesNotMatch(text, /\[EVIDENCE_QUOTE_PROTOCOL,\s*buildEvidenceLineIndex\(/,
    'the source is already present in buildMessages; review/fidelity must not receive a duplicate full-source index');
  assert.doesNotMatch(text, /sourceLines\.some\(line => line\.includes\(quote\)\)/);
});

test('V10 SC exact-source gate accepts exact cross-line substrings but rejects normalized line joins', () => {
  const source = '第一段证据\n第二段证据包含关键短语\n第三段证据';
  assert.throws(
    () => ScAuthority.locateQuote(source, '第一段证据 第二段证据包含关键短语'),
    /exact contiguous substring/
  );
  const crossLine = ScAuthority.locateQuote(source, '第一段证据\n第二段证据包含关键短语');
  assert.equal(crossLine.lineStart, 1);
  assert.equal(crossLine.lineEnd, 2);
  assert.equal(crossLine.quote, '第一段证据\n第二段证据包含关键短语');
  const exact = ScAuthority.locateQuote(source, '关键短语');
  assert.equal(exact.lineStart, 2);
  assert.equal(exact.lineEnd, 2);
  assert.equal(exact.quote, '关键短语');

  const crlf = ScAuthority.locateQuote('第一段证据\r\n第二段证据', '第一段证据\n第二段证据');
  assert.equal(crlf.quote, '第一段证据\r\n第二段证据');
  assert.equal(crlf.lineStart, 1);
  assert.equal(crlf.lineEnd, 2);
});

test('semantic reopen treats quote provenance as a review hint while final authority evidence remains exact', () => {
  const source = '第一段真实原文\n第二段真实原文';
  const hinted = Workflow.softAnchorEvidence(source, [
    { quote:'第一段真实原文 第二段真实原文', reason:'用户指出跨段语义问题，但表示把换行写成空格' }
  ], { label:'reopen evidence', required:true });
  assert.equal(hinted.length, 1);
  assert.match(hinted[0].provenance_error, /not an exact substring/);
  assert.equal(hinted[0].quote, '第一段真实原文 第二段真实原文');

  const exact = Workflow.softAnchorEvidence(source, [
    { quote:'第一段真实原文\n第二段真实原文', reason:'exact hint' }
  ], { label:'reopen evidence', required:true });
  assert.equal(exact[0].lineStart, 1);
  assert.equal(exact[0].lineEnd, 2);
  assert.equal(exact[0].provenance_error, undefined);

  const sc = ScAuthority.extractReopenRequest(
    '正文\n<!--SC_REOPEN_REQUEST\n' +
    JSON.stringify({ expectedRevision:1, issue:'复核跨段依赖', evidence:[{ quote:'第一段真实原文 第二段真实原文' }] }) +
    '\n-->',
    source
  );
  assert(sc.request);
  assert.match(sc.request.evidence[0].provenance_error, /not an exact substring/);

  const scOmission = ScAuthority.extractReopenRequest(
    '正文\n<!--SC_REOPEN_REQUEST\n' +
    JSON.stringify({ expectedRevision:1, issue:'完整原文可能漏掉一条形成链；这是 omission claim，没有可引用的“缺失文本”', evidence:[] }) +
    '\n-->',
    source
  );
  assert(scOmission.request);
  assert.deepEqual(scOmission.request.evidence, [],
    'SC omission challenges must be allowed to reach independent review without fabricating a quote');

  assert.throws(
    () => Workflow.anchorEvidence(source, [{ quote:'第一段真实原文 第二段真实原文' }], { label:'final authority evidence', required:true }),
    err => err && err.code === 'SOURCE_EVIDENCE_MISMATCH',
    'final publication evidence must remain exact even though reopen hints are soft'
  );

  const host = fs.readFileSync(path.join(ROOT, 'executor', 'host-node.js'), 'utf8');
  assert.match(host, /SW\.softAnchorEvidence\(String\(sourceText \|\| ''\), doc\.evidence/);
  assert.match(host, /Source-grounded hints \(unlocated quotes are claims, not evidence\)/);
  assert.doesNotMatch(host, /SW\.anchorEvidence\(String\(sourceText \|\| ''\), doc\.evidence/);
  for (const label of ['R3 immutable reopen evidence', 'recovered R3 semantic reopen evidence', 'R3 semantic reopen evidence']) {
    const at = host.indexOf("label: '" + label + "'");
    assert.ok(at >= 0, 'missing reopen evidence seam: ' + label);
    assert.match(host.slice(at, at + 120), /required:\s*false/);
  }
});

test('V10 SC semantic stages stay semantic while project/final evidence remains exact-source', () => {
  assert.match(ScAuthority.EVIDENCE_QUOTE_PROTOCOL, /逐字符连续 exact substring/);
  assert.match(ScAuthority.EVIDENCE_QUOTE_PROTOCOL, /允许跨物理行/);
  assert.match(ScAuthority.EVIDENCE_QUOTE_PROTOCOL, /保留原文真实换行/);
  assert.match(ScAuthority.EVIDENCE_QUOTE_PROTOCOL, /严禁把多行用空格、标点或任何规范化方式拼成新字符串/);
  assert.match(ScAuthority.EVIDENCE_QUOTE_PROTOCOL, /不得做标点\/空白规范化、错别字修正或同义改写/);

  const analyze = ScAuthority.buildAnalyzePrompt('第一行\n第二行', 'global');
  const review = ScAuthority.buildReviewPrompt('第一行\n第二行', 'global', {
    schema: ScAuthority.AUTHORITY_SCHEMA,
    sides: {
      affirmative:{ phase_iii:'not_formed', candidates:[] },
      negative:{ phase_iii:'not_formed', candidates:[] }
    },
    relation:{ type:'none', dominant_side:'none', reason:'语义复核 fixture' },
    notes:'fixture'
  }, 'review', null);
  for (const prompt of [analyze, review]) {
    assert.doesNotMatch(prompt, /证据逐字行索引/);
    assert.doesNotMatch(prompt, /"composition_chain"/);
    assert.doesNotMatch(prompt, /"exact_source_evidence"/);
  }

  const project = ScAuthority.buildProjectPrompt('第一行\n第二行', 'global', {
    schema: ScAuthority.AUTHORITY_SCHEMA,
    sides: {
      affirmative:{ phase_iii:'not_formed', candidates:[] },
      negative:{ phase_iii:'not_formed', candidates:[] }
    },
    relation:{ type:'none', dominant_side:'none', reason:'语义复核 fixture' },
    notes:'fixture'
  }, null);
  assert.match(project, /完整原文/);
  assert.match(project, /source span locator metadata/);
  assert.match(project, /source_span/);
  assert.match(project, /host 会从当前 source 机械复制 exact bytes/);
  assert.doesNotMatch(project, /证据逐字行索引/);

  const exact = ScAuthority.locateQuote('第一行\n第二行', '第一行\n第二行');
  assert.equal(exact.lineStart, 1);
  assert.equal(exact.lineEnd, 2);
});
