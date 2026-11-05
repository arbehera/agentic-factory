import { describe, expect, it } from "vitest";
import { EnvSecretProvider, REDACTED, redactSecrets, SecretNotFoundError } from "../src/index.js";

describe("NFR-001 secrets", () => {
  it("NFR-001 reads named secrets from the environment and remembers what it handed out", async () => {
    const p = new EnvSecretProvider({ ADLC_SECRET_JIRA_AGENT_TOKEN: "s3cr3t-token-value" });
    expect(await p.get("jira-agent-token")).toBe("s3cr3t-token-value");
    expect(p.knownValues()).toEqual(["s3cr3t-token-value"]);
    await expect(p.get("missing")).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it("NFR-001 redacts known secret values anywhere in a nested result", () => {
    const out = redactSecrets({ a: "x s3cr3t-token-value y", b: ["s3cr3t-token-value"], c: { d: 1, e: null } }, ["s3cr3t-token-value", "abc"]);
    expect(out).toEqual({ a: `x ${REDACTED} y`, b: [REDACTED], c: { d: 1, e: null } });
    expect(redactSecrets("abc", ["abc"])).toBe("abc"); // too short to redact safely
  });
});
