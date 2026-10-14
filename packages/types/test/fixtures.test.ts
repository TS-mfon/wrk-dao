import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonicalize,
  isId,
  contentHash,
  parseDecisionPayload,
  parseMissionPayload,
  isCanonicalizable,
} from "../src/index.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const load = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(REPO_ROOT, "fixtures", name), "utf8")) as Record<string, unknown>;

interface FrozenVector {
  name: string;
  canonical: string;
  keccak256: string;
}
interface InputVector {
  name: string;
  value: unknown;
  js_canonical?: string;
}

const frozen = load("canonical-vectors.json");
const inputs = load("canonical-inputs.json");
const vectors = frozen.vectors as FrozenVector[];
const accept = inputs.accept as InputVector[];
const reject = inputs.reject as InputVector[];
const pythonOnly = inputs.reject_python_only as InputVector[];
const byName = new Map(accept.map((entry) => [entry.name, entry]));

describe("frozen canonical fixtures", () => {
  it("declares the algorithm this package implements", () => {
    expect(frozen.algorithm).toEqual({ canonical_json: "wrk/canonical-json/v1", digest: "keccak256" });
  });

  it("has an input for every frozen vector and a vector for every input", () => {
    expect(vectors.length).toBe(accept.length);
    for (const vector of vectors) expect(byName.has(vector.name)).toBe(true);
  });

  it.each(vectors.map((v) => [v.name, v] as const))("reproduces %s byte for byte", (_name, vector) => {
    const input = byName.get(vector.name);
    expect(input).toBeDefined();
    expect(canonicalize(input!.value)).toBe(vector.canonical);
    expect(contentHash(input!.value)).toBe(vector.keccak256);
  });

  it("refuses every shared reject vector", () => {
    expect(reject.length).toBeGreaterThan(0);
    for (const vector of reject) {
      expect(isCanonicalizable(vector.value), vector.name).toBe(false);
    }
  });

  it("emits the documented text for each Python-only reject", () => {
    // docs/CANONICAL.md §1.2: JSON.parse turned 2.0 into 2 before the encoder ran, so
    // JavaScript cannot see the float spelling. Python rejects it. The asymmetry is
    // safe in this direction only, which is why the expected output is pinned.
    expect(pythonOnly.length).toBeGreaterThan(0);
    for (const vector of pythonOnly) {
      expect(vector.js_canonical, `${vector.name} must record its JS output`).toBeDefined();
      expect(canonicalize(vector.value), vector.name).toBe(vector.js_canonical);
    }
  });
});

describe("the frozen sample payloads", () => {
  const mission = byName.get("wrk_mission_payload")!.value as Record<string, unknown>;
  const decision = byName.get("wrk_decision_payload")!.value as Record<string, unknown>;

  it("canonicalises — the fixtures are a byte contract and they hold", () => {
    expect(canonicalize(mission)).toBe(vectors.find((v) => v.name === "wrk_mission_payload")!.canonical);
    expect(canonicalize(decision)).toBe(vectors.find((v) => v.name === "wrk_decision_payload")!.canonical);
  });

  it("validates the decision payload against the §7 schema", () => {
    expect(() => parseDecisionPayload(decision)).not.toThrow();
  });

  /**
   * This replaced a test that pinned a defect.
   *
   * `wrk_mission_payload.creator_agent_id` used to be
   * `agt_01JQ8Z0Q1R2S3T4U5V6W7X8Y9Z`, which contains `U` — excluded from Crockford
   * base32, so not a valid ULID. The schema correctly refused it. The old test asserted
   * the defect so it could not be forgotten, and said it would fail the moment the
   * fixture was corrected. It did, and this is the replacement.
   *
   * Correcting it re-derived exactly one of the 41 frozen digests. No canonical rule
   * changed, so no version bump: see docs/CANONICAL.md §3.
   */
  it("validates the mission payload against the §17 schema", () => {
    expect(mission.creator_agent_id).toBe("agt_01JQ8Z0Q1R2S3T4V5W6X7Y8Z9A");
    expect(String(mission.creator_agent_id)).not.toMatch(/[ILOU]/);
    expect(() => parseMissionPayload(mission)).not.toThrow();
  });

  /** Every id in both frozen payloads, not just the one that was wrong. */
  it("uses valid Crockford base32 for every id in both frozen payloads", () => {
    const ids: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string" && /^[a-z]{3}_/.test(value)) ids.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(mission);
    walk(decision);
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) {
      expect(id.slice(4), id).not.toMatch(/[ILOU]/);
      expect(isId(id), id).toBe(true);
    }
  });
});
