// ============================================================
// tendency.js — Web facade for canonical shared run settings.
// Single source of truth: scripts/judge-run-settings.js
// ============================================================
'use strict';

const shared = require('../../scripts/judge-run-settings.js');

module.exports = {
  DIM_KEYS: shared.DIM_KEYS,
  DIM_DEFAULT: shared.DIM_DEFAULT,
  DIMENSIONS: shared.DIMENSIONS,
  VECTOR_DEFAULT: shared.VECTOR_DEFAULT,
  PROFILE_KIND: shared.PROFILE_KIND,
  PROFILE_VERSION: shared.PROFILE_VERSION,
  PROFILE_V2_KIND: shared.PROFILE_V2_KIND,
  PROFILE_V2_VERSION: shared.PROFILE_V2_VERSION,
  AXES: shared.AXES,
  DEPTH_DEFAULTS: shared.DEPTH_DEFAULTS,
  normalizeDimWeights: shared.normalizeDimWeights,
  normalizeVectorWeights: shared.normalizeVectorWeights,
  normalizeTendencyProfile: shared.normalizeTendencyProfile,
  valueLabel: shared.valueLabel,
  dimValueLabel: shared.dimValueLabel,
  isAuto: shared.isAuto,
  deriveAxis: shared.deriveAxis,
  deriveAllAxes: shared.deriveAllAxes,
  dimLineText: shared.dimLineText,
  tendencyText: shared.tendencyText,
  isDefaultDepth: shared.isDefaultDepth,
  depthBlockText: shared.depthBlockText
};
