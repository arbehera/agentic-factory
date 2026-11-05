/**
 * DSSE envelopes (Dead Simple Signing Envelope, v1). The signature covers the pre-authentication
 * encoding PAE(payloadType, payload), so neither the type nor the bytes can be swapped.
 */

export interface DsseSignature {
  keyid: string;
  sig: string; // base64
}

export interface DsseEnvelope {
  payloadType: string;
  payload: string; // base64
  signatures: DsseSignature[];
}

export interface EnvelopeSigner {
  readonly keyId: string;
  sign(data: Buffer): Promise<Buffer>;
}

export interface EnvelopeVerifier {
  verify(keyId: string, data: Buffer, signature: Buffer): Promise<boolean>;
}

export class EnvelopeVerificationError extends Error {
  override name = "EnvelopeVerificationError";
}

/** PAE(type, body) = "DSSEv1" SP LEN(type) SP type SP LEN(body) SP body (lengths in bytes). */
export function pae(payloadType: string, payload: Buffer): Buffer {
  const type = Buffer.from(payloadType, "utf8");
  return Buffer.concat([Buffer.from(`DSSEv1 ${type.length} `, "utf8"), type, Buffer.from(` ${payload.length} `, "utf8"), payload]);
}

export async function signEnvelope(payloadType: string, payload: Buffer, signer: EnvelopeSigner): Promise<DsseEnvelope> {
  const sig = await signer.sign(pae(payloadType, payload));
  return { payloadType, payload: payload.toString("base64"), signatures: [{ keyid: signer.keyId, sig: sig.toString("base64") }] };
}

/** Returns the payload if at least one signature verifies for an expected type; throws otherwise. */
export async function verifyEnvelope(env: DsseEnvelope, expectedType: string, verifier: EnvelopeVerifier): Promise<Buffer> {
  if (env.payloadType !== expectedType) throw new EnvelopeVerificationError(`unexpected payload type ${env.payloadType}`);
  const payload = Buffer.from(env.payload, "base64");
  const data = pae(env.payloadType, payload);
  for (const s of env.signatures) {
    if (await verifier.verify(s.keyid, data, Buffer.from(s.sig, "base64"))) return payload;
  }
  throw new EnvelopeVerificationError("no valid signature");
}
