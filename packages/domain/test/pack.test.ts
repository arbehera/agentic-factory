import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  assertPackTransition,
  DISPATCH_ENVIRONMENTS,
  InvalidTransitionError,
  PACK_STATUSES,
  packAllowsNewDispatch,
  packStatusMachine,
  type Actor,
} from "../src/index.js";

const digest = `sha256:${"a".repeat(64)}`;
const owner: Actor = { kind: "human", id: "pack-owner" };
const qms: Actor = { kind: "human", id: "qms-owner" };

describe("FR-PCK-003 pack lifecycle", () => {
  it("FR-PCK-003 property: production dispatch only on Qualified; sandbox also on Draft; never Restricted/Retired", () => {
    fc.assert(
      fc.property(fc.constantFrom(...PACK_STATUSES), fc.constantFrom(...DISPATCH_ENVIRONMENTS), (status, env) => {
        const expected = status === "Qualified" || (status === "Draft" && env === "sandbox");
        expect(packAllowsNewDispatch(status, env)).toBe(expected);
      }),
    );
  });

  it("FR-PCK-003 follows Draft → Qualified → Restricted → Qualified → Retired, and Retired is terminal", () => {
    assertPackTransition("Draft", "Qualified", { actors: [owner, qms], imageDigest: digest });
    assertPackTransition("Qualified", "Restricted", { actors: [{ kind: "service", id: "canary-runner" }], imageDigest: digest });
    assertPackTransition("Restricted", "Qualified", { actors: [owner, qms], imageDigest: digest });
    assertPackTransition("Qualified", "Retired", { actors: [owner], imageDigest: digest });
    expect(packStatusMachine.terminal).toEqual(["Retired"]);
    expect(() => { assertPackTransition("Retired", "Qualified", { actors: [owner, qms], imageDigest: digest }); }).toThrow(InvalidTransitionError);
    expect(() => { assertPackTransition("Draft", "Restricted", { actors: [owner], imageDigest: digest }); }).toThrow(InvalidTransitionError);
  });

  it("FR-PCK-003 qualification needs a digest-pinned image and two distinct human approvers", () => {
    const q = (actors: Actor[], imageDigest: string | null) => () => {
      assertPackTransition("Draft", "Qualified", { actors, imageDigest });
    };
    expect(q([owner, qms], null)).toThrow(/digest/);
    expect(q([owner, qms], "sha256:short")).toThrow(/digest/);
    expect(q([owner], digest)).toThrow(/2 distinct human/);
    expect(q([owner, owner], digest)).toThrow(/2 distinct human/);
    expect(q([owner, qms, { kind: "agent-run", id: "r1" }], digest)).toThrow(/no automated actor/);
    expect(q([owner, qms], digest)).not.toThrow();
  });

  it("every transition needs an actor", () => {
    expect(() => { assertPackTransition("Qualified", "Restricted", { actors: [], imageDigest: digest }); }).toThrow(/actor is required/);
  });
});
