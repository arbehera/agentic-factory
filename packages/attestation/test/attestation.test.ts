import { describe, expect, it } from "vitest";
import {
  EnvelopeVerificationError,
  evidenceStatement,
  pae,
  ProductionKeyError,
  PublicKeyVerifier,
  signEnvelope,
  signEvidence,
  SoftwareEd25519Signer,
  verifyEnvelope,
  verifyEvidence,
  type EvidencePredicate,
} from "../src/index.js";

const predicate: EvidencePredicate = {
  repo: "org/product",
  prNumber: 7,
  headSha: "a".repeat(40),
  authorRole: "dummy",
  verdicts: [{ reviewerRole: "dummy-reviewer", reviewerRunId: "r1", verdict: "approve", modelCallId: "msg_1", verdictHash: "f".repeat(64) }],
  checks: [{ context: "adlc/verify", state: "success" }],
  signedAt: "2026-11-05T08:00:00.000Z",
};

describe("FR-EVD-002 DSSE / in-toto evidence", () => {
  it("PAE matches the DSSE v1 definition (byte lengths)", () => {
    expect(pae("http://example.com/HelloWorld", Buffer.from("hello world")).toString()).toBe("DSSEv1 29 http://example.com/HelloWorld 11 hello world");
    expect(pae("t", Buffer.from("é")).toString()).toBe("DSSEv1 1 t 2 é");
  });

  it("FR-EVD-002 signs a review-evidence statement whose subject is the PR head commit, and verifies it", async () => {
    const signer = SoftwareEd25519Signer.generate("test");
    const env = await signEvidence(evidenceStatement(predicate), signer);
    expect(env.payloadType).toBe("application/vnd.in-toto+json");
    expect(env.signatures[0]?.keyid).toBe(signer.keyId);
    const st = await verifyEvidence(env, new PublicKeyVerifier([signer.publicKeyPem]));
    expect(st.subject).toEqual([{ name: "git+org/product#pr-7", digest: { gitCommit: "a".repeat(40) } }]);
    expect(st.predicate.verdicts[0]?.modelCallId).toBe("msg_1");
  });

  it("FR-EVD-002 rejects tampered payloads, swapped payload types, unknown keys and other signers", async () => {
    const signer = SoftwareEd25519Signer.generate("dev");
    const verifier = new PublicKeyVerifier([signer.publicKeyPem]);
    const env = await signEvidence(evidenceStatement(predicate), signer);

    const tampered = { ...env, payload: Buffer.from(Buffer.from(env.payload, "base64").toString().replace('"approve"', '"approve "')).toString("base64") };
    await expect(verifyEvidence(tampered, verifier)).rejects.toBeInstanceOf(EnvelopeVerificationError);
    await expect(verifyEnvelope({ ...env, payloadType: "text/plain" }, "text/plain", verifier)).rejects.toThrow(/no valid signature/);
    await expect(verifyEvidence({ ...env, payloadType: "text/plain" }, verifier)).rejects.toThrow(/unexpected payload type/);

    const other = SoftwareEd25519Signer.generate("dev");
    await expect(verifyEvidence(await signEvidence(evidenceStatement(predicate), other), verifier)).rejects.toThrow(/no valid signature/);
    const notEvidence = await signEnvelope("application/vnd.in-toto+json", Buffer.from('{"_type":"x"}'), signer);
    await expect(verifyEvidence(notEvidence, verifier)).rejects.toThrow(/not an ADLC review-evidence statement/);
  });

  it("OPEN-07 a software key refuses to exist in production, and only Ed25519 keys are accepted", () => {
    expect(() => SoftwareEd25519Signer.generate("production")).toThrow(ProductionKeyError);
    const pem = (SoftwareEd25519Signer.generate("dev") as unknown as { privateKey: { export(o: object): string } }).privateKey.export({ type: "pkcs8", format: "pem" });
    expect(() => SoftwareEd25519Signer.fromPem(pem, "production")).toThrow(ProductionKeyError);
    expect(SoftwareEd25519Signer.fromPem(pem, "dev").keyId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("signing is deterministic for the same statement (canonical JSON payload)", async () => {
    const signer = SoftwareEd25519Signer.generate("test");
    const [a, b] = await Promise.all([signEvidence(evidenceStatement(predicate), signer), signEvidence(evidenceStatement({ ...predicate }), signer)]);
    expect(a.payload).toBe(b.payload);
  });
});
