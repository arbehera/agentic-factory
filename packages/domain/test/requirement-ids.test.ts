import { describe, expect, it } from "vitest";
import { REQUIREMENT_ID_RE } from "../src/index.js";

describe("FR-IMP-001 requirement IDs referenced by tasks", () => {
  it("accepts requirement-level global IDs", () => {
    for (const id of ["STK-1", "SYS-12", "HWR-3", "CSR-40", "SWR-233"]) expect(REQUIREMENT_ID_RE.test(id)).toBe(true);
  });

  it("rejects Spec Kit's per-feature FR-### IDs, unit IDs and malformed numbers", () => {
    for (const id of ["FR-001", "SWU-5", "SWR-", "SWR-ddd", "swr-1", "SWR-1a"]) expect(REQUIREMENT_ID_RE.test(id)).toBe(false);
  });
});
