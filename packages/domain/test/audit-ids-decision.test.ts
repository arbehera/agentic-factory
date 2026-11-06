import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  assertDecisionInvariants,
  canonicalJson,
  CanonicalJsonError,
  chainAuditEvent,
  DECISION_CLASSES,
  DecisionInvariantError,
  externalTaskId,
  formatDecisionId,
  GENESIS_HASH,
  InvalidIdError,
  isDecisionId,
  ON_TIMEOUT,
  stateHash,
  verifyAuditChain,
  type AuditEventContent,
  type ChainedAuditEvent,
} from "../src/index.js";

const hex64 = fc.string({ unit: fc.constantFrom(..."0123456789abcdef".split("")), minLength: 64, maxLength: 64 });

const contentArb: fc.Arbitrary<AuditEventContent> = fc.record({
  actor: fc.record({ kind: fc.constantFrom("agent-run", "human", "service"), id: fc.string({ minLength: 1 }) }),
  action: fc.string({ minLength: 1 }),
  target: fc.string({ minLength: 1 }),
  reason: fc.string(),
  beforeHash: fc.option(hex64, { nil: null }),
  afterHash: fc.option(hex64, { nil: null }),
  correlation: fc.record({ runId: fc.uuid(), taskKey: fc.string() }, { requiredKeys: [] }),
});

function buildChain(contents: AuditEventContent[]): ChainedAuditEvent[] {
  const out: ChainedAuditEvent[] = [];
  let prev = GENESIS_HASH;
  contents.forEach((c, i) => {
    const e = chainAuditEvent(c, i + 1, new Date(Date.UTC(2026, 10, 4, 0, 0, i)), prev);
    out.push(e);
    prev = e.hash;
  });
  return out;
}

describe("NFR-006 audit hash chain", () => {
  it("NFR-006 a freshly built chain verifies", () => {
    fc.assert(
      fc.property(fc.array(contentArb, { maxLength: 20 }), (cs) => {
        const r = verifyAuditChain(buildChain(cs));
        expect(r).toMatchObject({ ok: true, count: cs.length });
      }),
    );
  });

  it("NFR-006 property: editing any field of any event is detected at that event", () => {
    fc.assert(
      fc.property(
        fc.array(contentArb, { minLength: 1, maxLength: 15 }),
        fc.nat(),
        fc.constantFrom("action", "target", "reason", "ts"),
        (cs, pick, field) => {
          const chain = buildChain(cs);
          const i = pick % chain.length;
          const victim = chain[i] as ChainedAuditEvent;
          chain[i] = { ...victim, [field]: `${victim[field]}~tampered` };
          expect(verifyAuditChain(chain)).toEqual({ ok: false, brokenAtSeq: victim.seq, reason: "hash-mismatch" });
        },
      ),
    );
  });

  it("NFR-006 property: deleting an inner event breaks the next link", () => {
    fc.assert(
      fc.property(fc.array(contentArb, { minLength: 3, maxLength: 15 }), fc.nat(), (cs, pick) => {
        const chain = buildChain(cs);
        const i = 1 + (pick % (chain.length - 2));
        const next = chain[i + 1] as ChainedAuditEvent;
        chain.splice(i, 1);
        expect(verifyAuditChain(chain)).toEqual({ ok: false, brokenAtSeq: next.seq, reason: "link-mismatch" });
      }),
    );
  });

  it("NFR-006 rejects out-of-order sequences and verifies from a non-genesis anchor", () => {
    const chain = buildChain([{ actor: { kind: "human", id: "u" }, action: "a", target: "t", reason: "r", beforeHash: null, afterHash: null, correlation: {} }]);
    const first = chain[0] as ChainedAuditEvent;
    expect(verifyAuditChain([first, first])).toMatchObject({ ok: false, reason: "seq-order" });
    const tail = chainAuditEvent(first, 2, new Date(), first.hash);
    expect(verifyAuditChain([tail], first.hash)).toMatchObject({ ok: true, lastHash: tail.hash });
    expect(verifyAuditChain([tail])).toMatchObject({ ok: false, reason: "link-mismatch" });
  });

  it("canonical JSON sorts keys, drops undefined and rejects unsupported values", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], c: undefined })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(stateHash({ a: 1, b: 2 })).toBe(stateHash({ b: 2, a: 1 }));
    expect(() => canonicalJson(Number.NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Date())).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(1n)).toThrow(CanonicalJsonError);
  });
});

describe("P0-WP2 identifiers", () => {
  it("formats and recognises Decision IDs", () => {
    expect(formatDecisionId(7)).toBe("DEC-0007");
    expect(formatDecisionId(12345)).toBe("DEC-12345");
    expect(isDecisionId("DEC-0007")).toBe(true);
    expect(isDecisionId("DEC-7")).toBe(false);
    expect(() => formatDecisionId(0)).toThrow(InvalidIdError);
    expect(() => formatDecisionId(1.5)).toThrow(InvalidIdError);
  });

  it("FR-IMP-003 builds the External ID <feature>/<T###> and rejects malformed parts", () => {
    expect(externalTaskId("002-login", "T014")).toBe("002-login/T014");
    expect(() => externalTaskId("login", "T014")).toThrow(InvalidIdError);
    expect(() => externalTaskId("002-login", "14")).toThrow(InvalidIdError);
  });
});

describe("FR-DEC-002 Decision invariants (spec.md §5)", () => {
  it("FR-DEC-002 timeout behaviour is the constant 'escalate'", () => {
    expect(ON_TIMEOUT).toBe("escalate");
  });

  it("FR-DEC-001 property: autoResolve is accepted only for consults; gate Decisions are irreversible", () => {
    fc.assert(
      fc.property(fc.constantFrom(...DECISION_CLASSES), fc.boolean(), fc.boolean(), (cls, reversible, autoResolve) => {
        const valid = !(autoResolve && cls !== "consult") && !(cls === "gate" && reversible);
        const check = (): void => { assertDecisionInvariants({ class: cls, reversible, autoResolve }); };
        if (valid) expect(check).not.toThrow();
        else expect(check).toThrow(DecisionInvariantError);
      }),
    );
  });
});
