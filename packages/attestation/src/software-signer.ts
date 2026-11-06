import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import type { EnvelopeSigner, EnvelopeVerifier } from "./dsse.js";

/**
 * Software Ed25519 key for dev and tests only (OPEN-07: KMS/HSM not yet chosen). It refuses to
 * exist in production: there the signer uses the KMS/HSM implementation of EnvelopeSigner, whose
 * key neither the orchestrator nor build agents can reach (SDD §8.5 S9).
 */

export class ProductionKeyError extends Error {
  override name = "ProductionKeyError";
}

export type PlatformEnvironment = "dev" | "test" | "sandbox" | "production";

function keyIdOf(publicKey: KeyObject): string {
  return createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex").slice(0, 32);
}

export class SoftwareEd25519Signer implements EnvelopeSigner {
  readonly keyId: string;
  readonly publicKeyPem: string;

  private constructor(private readonly privateKey: KeyObject) {
    const pub = createPublicKey(privateKey);
    this.keyId = keyIdOf(pub);
    this.publicKeyPem = pub.export({ type: "spki", format: "pem" }).toString();
  }

  static fromPem(privateKeyPem: string, environment: PlatformEnvironment): SoftwareEd25519Signer {
    if (environment === "production") throw new ProductionKeyError("software signing keys are not allowed in production (OPEN-07)");
    const key = createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new ProductionKeyError("the evidence key must be Ed25519");
    return new SoftwareEd25519Signer(key);
  }

  static generate(environment: PlatformEnvironment): SoftwareEd25519Signer {
    if (environment === "production") throw new ProductionKeyError("software signing keys are not allowed in production (OPEN-07)");
    return new SoftwareEd25519Signer(generateKeyPairSync("ed25519").privateKey);
  }

  sign(data: Buffer): Promise<Buffer> {
    return Promise.resolve(sign(null, data, this.privateKey));
  }
}

/** Verifies against a fixed set of trusted public keys (key ID → PEM). */
export class PublicKeyVerifier implements EnvelopeVerifier {
  private readonly keys = new Map<string, KeyObject>();

  constructor(publicKeysPem: readonly string[]) {
    for (const pem of publicKeysPem) {
      const k = createPublicKey(pem);
      this.keys.set(keyIdOf(k), k);
    }
  }

  verify(keyId: string, data: Buffer, signature: Buffer): Promise<boolean> {
    const key = this.keys.get(keyId);
    return Promise.resolve(key !== undefined && verify(null, data, key, signature));
  }
}
