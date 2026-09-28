// ============================================================
// judge-context.js — Web facade for canonical shared run settings.
// Single source of truth: scripts/judge-run-settings.js
// ============================================================
'use strict';

const shared = require('../../scripts/judge-run-settings.js');

module.exports = {
  KIND: shared.KIND,
  VERSION: shared.VERSION,
  DEFAULT_CONTEXT: shared.DEFAULT_CONTEXT,
  USE_MODES: shared.USE_MODES,
  BACKGROUND_MODES: shared.BACKGROUND_MODES,
  BACKGROUND_DOMAINS: shared.BACKGROUND_DOMAINS,
  FAMILIARITY: shared.FAMILIARITY,
  VALUE_CONCERNS: shared.VALUE_CONCERNS,
  PERSPECTIVES: shared.PERSPECTIVES,
  normalizeJudgeContext: shared.normalizeJudgeContext,
  projectJudgeContext: shared.projectJudgeContext,
  contextSummary: shared.contextSummary
};
