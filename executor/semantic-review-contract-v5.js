'use strict';

function resolveBaseParser(baseParser) {
  if (baseParser && typeof baseParser.parseStrictJsonObject === 'function' && typeof baseParser.parseReviewDecision === 'function') {
    return baseParser;
  }
  try {
    return require('./semantic-workflow.js');
  } catch (_) {
    return require('../SemanticFirst-E2E-SemanticQuality-WebParity-V4-20260916/executor/semantic-workflow.js');
  }
}

const TOP_KEYS = Object.freeze(['decision', 'evidence', 'reason', 'net', 'replacement', 'semantic']);
const NET_KEYS = Object.freeze(['candidate_state', 'candidate_quote', 'candidate_direction', 'review_direction', 'basis']);
const REPLACEMENT_KEYS = Object.freeze(['mode', 'standalone', 'depends_on_prior_semantic', 'authority_quote', 'net_quote']);
const FINITE_DIRECTIONS = Object.freeze(['affirmative', 'negative']);

function fail(code, message) {
  const error = new Error('[semantic-v5-contract] ' + message);
  error.code = code;
  throw error;
}

function sameExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  if (actual.length !== expected.length) return false;
  const allowed = new Set(expected);
  return actual.every(key => allowed.has(key));
}

function requireExactKeys(value, expected, label) {
  if (!sameExactKeys(value, expected)) {
    fail('SEMANTIC_REVIEW_V5_SCHEMA_INVALID', label + ' fields must be exactly: ' + expected.join(','));
  }
}

function exactSubstring(haystack, needle) {
  const source = String(haystack == null ? '' : haystack);
  const quote = String(needle == null ? '' : needle);
  return quote.length > 0 && source.includes(quote);
}

function assertStandaloneReplacementSemantic(semantic) {
  const body = String(semantic == null ? '' : semantic);
  if (!body.trim()) fail('SEMANTIC_REVIEW_REVISION_NOT_STANDALONE', 'revision semantic is empty');
  // Standalone-ness is a semantic property established by the independent review.
  // Lexical edit words such as “调整/补充/modify” are not semantic truth gates.
  return Object.freeze({ ok: true, length_gate_used: false });
}

function validateNet(doc, candidateSemantic, decision) {
  requireExactKeys(doc, NET_KEYS, 'net');
  const candidateState = String(doc.candidate_state || '');
  const candidateQuote = String(doc.candidate_quote || '');
  const candidateDirection = String(doc.candidate_direction || '');
  const reviewDirection = String(doc.review_direction || '');
  const basis = String(doc.basis || '');

  if (!['finite', 'unresolved', 'absent'].includes(candidateState)) {
    fail('SEMANTIC_REVIEW_V5_SCHEMA_INVALID', 'net.candidate_state invalid: ' + candidateState);
  }
  if (!['affirmative', 'negative', 'none'].includes(candidateDirection)) {
    fail('SEMANTIC_REVIEW_V5_SCHEMA_INVALID', 'net.candidate_direction invalid: ' + candidateDirection);
  }
  if (!['affirmative', 'negative', 'balanced', 'unresolved'].includes(reviewDirection)) {
    fail('SEMANTIC_REVIEW_V5_SCHEMA_INVALID', 'net.review_direction invalid: ' + reviewDirection);
  }
  if (!basis.trim()) fail('SEMANTIC_REVIEW_V5_SCHEMA_INVALID', 'net.basis is required');

  if (candidateState === 'finite') {
    if (!FINITE_DIRECTIONS.includes(candidateDirection)) {
      fail('SEMANTIC_REVIEW_FINITE_NET_EVIDENCE', 'finite candidate_state requires affirmative/negative candidate_direction');
    }
    if (!candidateQuote || !exactSubstring(candidateSemantic, candidateQuote)) {
      fail('SEMANTIC_REVIEW_FINITE_NET_EVIDENCE', 'finite candidate_state requires candidate_quote to be an exact contiguous substring of reviewed candidate semantic');
    }
  } else {
    if (candidateQuote !== '' || candidateDirection !== 'none') {
      fail('SEMANTIC_REVIEW_FINITE_NET_EVIDENCE', 'unresolved/absent candidate_state requires empty candidate_quote and candidate_direction=none');
    }
  }

  if (decision === 'maintain') {
    if (FINITE_DIRECTIONS.includes(reviewDirection)) {
      if (candidateState !== 'finite' || candidateDirection !== reviewDirection || !candidateQuote) {
        fail('SEMANTIC_REVIEW_FINITE_NET_EVIDENCE', 'maintain with finite review_direction requires matching exact finite-net evidence from candidate semantic');
      }
    } else if (candidateState === 'finite') {
      fail('SEMANTIC_REVIEW_FINITE_NET_EVIDENCE', 'maintain cannot preserve a finite candidate while declaring balanced/unresolved review_direction');
    }
  }

  return Object.freeze({
    candidate_state: candidateState,
    candidate_quote: candidateQuote,
    candidate_direction: candidateDirection,
    review_direction: reviewDirection,
    basis
  });
}

function validateReplacement(doc, semantic, decision, reviewDirection) {
  requireExactKeys(doc, REPLACEMENT_KEYS, 'replacement');
  const mode = String(doc.mode || '');
  const standalone = doc.standalone;
  const depends = doc.depends_on_prior_semantic;
  const authorityQuote = String(doc.authority_quote || '');
  const netQuote = String(doc.net_quote || '');
  const body = String(semantic == null ? '' : semantic);

  if (decision === 'revise') {
    if (mode !== 'standalone_replacement' || standalone !== true || depends !== false) {
      fail('SEMANTIC_REVIEW_REVISION_NOT_STANDALONE', 'revise requires standalone_replacement, standalone=true, depends_on_prior_semantic=false');
    }
    assertStandaloneReplacementSemantic(body);
    if (!authorityQuote || !exactSubstring(body, authorityQuote)) {
      fail('SEMANTIC_REVIEW_REVISION_EVIDENCE', 'revise requires replacement.authority_quote to be an exact contiguous substring of replacement semantic');
    }
    if (FINITE_DIRECTIONS.includes(reviewDirection)) {
      if (!netQuote || !exactSubstring(body, netQuote)) {
        fail('SEMANTIC_REVIEW_REVISION_EVIDENCE', 'finite-direction revise requires replacement.net_quote to be an exact contiguous substring of replacement semantic');
      }
    } else if (netQuote !== '') {
      fail('SEMANTIC_REVIEW_REVISION_EVIDENCE', 'balanced/unresolved revise requires empty replacement.net_quote');
    }
  } else {
    if (mode !== 'none' || standalone !== false || depends !== false || authorityQuote !== '' || netQuote !== '' || body !== '') {
      fail('SEMANTIC_REVIEW_V5_SCHEMA_INVALID', 'non-revise decisions require inert replacement fields and empty semantic');
    }
  }

  return Object.freeze({
    mode,
    standalone,
    depends_on_prior_semantic: depends,
    authority_quote: authorityQuote,
    net_quote: netQuote
  });
}

function parseV5ReviewDecision(text, sourceText, candidateSemantic, baseParser) {
  const sw = resolveBaseParser(baseParser);
  const doc = sw.parseStrictJsonObject(text, 'review decision');
  requireExactKeys(doc, TOP_KEYS, 'top-level review');

  // Reuse the shared V4 parser for decision enum, exact-source evidence anchoring,
  // strict JSON closure, and revise-semantic non-emptiness. V5 layers new semantics
  // on top instead of weakening or forking those invariants. The parser can be
  // injected by an isolated V5 workflow so Web/Node use the exact same base seam.
  const base = sw.parseReviewDecision(text, sourceText);
  const net = validateNet(doc.net, candidateSemantic, base.decision);
  const replacement = validateReplacement(doc.replacement, base.semantic, base.decision, net.review_direction);

  return Object.freeze({
    decision: base.decision,
    evidence: base.evidence,
    reason: base.reason,
    net,
    replacement,
    semantic: base.semantic
  });
}

module.exports = {
  TOP_KEYS,
  NET_KEYS,
  REPLACEMENT_KEYS,
  assertStandaloneReplacementSemantic,
  parseV5ReviewDecision
};
