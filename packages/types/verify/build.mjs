// G1 evidence: the package built AND the built artefact exports what downstream
// packages and the driver's branch gate require.
//
// `tsc -b` exiting zero only proves the compiler was happy. It does not prove
// dist/index.js loads, and it does not prove the two names the driver's
// node-1.1:N2 gate imports by path are actually exported. Those are the failures
// that would otherwise surface three leaves later.

import { check, checkEqual, finish, abort } from "./_common.mjs";

const REQUIRED = [
  // Named by scripts/verify-production-encoders.mjs. Do not rename without the driver.
  "canonicalize",
  "contentHash",
  // The rest of the public surface this package promises its consumers.
  "asciiBytes",
  "assertAllocations",
  "assertAscendingSigners",
  "assertBpPair",
  "assertBytes32",
  "assertSettlementMessage",
  "assertTransition",
  "assertVerdictMatchesRelease",
  "canEditMission",
  "canTransition",
  "contentHashWithCanonical",
  "fromBytes32",
  "hashCanonicalText",
  "idPattern",
  "idSchema",
  "idTime",
  "isCanonicalizable",
  "isId",
  "isTerminal",
  "isWrkError",
  "newId",
  "parseAtomic",
  "parseDecisionPayload",
  "parseDeliverablePayload",
  "parseId",
  "parseMandatePayload",
  "parseMissionPayload",
  "parseProposalPayload",
  "settlementDigest",
  "settlementDomain",
  "settlementId",
  "splitRelease",
  "structHash",
  "toBytes32",
  "validate",
  "verdictForRelease",
  "verdictMatchesRelease",
  "WrkError",
  // Constants consumers pin against.
  "BP_DENOMINATOR",
  "CANONICAL_JSON_VERSION",
  "ID_PREFIXES",
  "MANDATE_STATES",
  "MISSION_STATES",
  "SETTLEMENT_STATES",
  "SETTLEMENT_TYPES",
  "SETTLEMENT_TYPE_STRING",
];

try {
  const module = await import("../dist/index.js");

  for (const name of REQUIRED) {
    check(name in module, `dist/index.js must export ${name}`);
  }

  // A build that emits something unusable is not a build.
  checkEqual(typeof module.canonicalize, "function", "canonicalize must be callable");
  checkEqual(typeof module.contentHash, "function", "contentHash must be callable");
  checkEqual(module.canonicalize({}), "{}", "the built encoder must work, not merely load");
  checkEqual(module.CANONICAL_JSON_VERSION, "wrk/canonical-json/v1", "canonical version must be v1");
  checkEqual(module.BP_DENOMINATOR, 10000, "BP_DENOMINATOR must be 10000");

  finish("TYPES-BUILD OK");
} catch (error) {
  abort(error);
}
