import { describe, expect, it } from "vitest";
import { BranchMovedError, IssueConflictError, IssueNotFoundError, SecretNotFoundError } from "../src/index.js";

describe("adapter error classes", () => {
  it("carry stable names, which the gateway reports to agents instead of internal details", () => {
    const errors = [new IssueNotFoundError("x"), new IssueConflictError("x"), new BranchMovedError("x"), new SecretNotFoundError("x")];
    expect(errors.map((e) => [e instanceof Error, e.name])).toEqual([
      [true, "IssueNotFoundError"],
      [true, "IssueConflictError"],
      [true, "BranchMovedError"],
      [true, "SecretNotFoundError"],
    ]);
  });
});
