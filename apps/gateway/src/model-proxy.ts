import { redactSecrets, type SecretProvider } from "@adlc/adapters";
import { stateHash } from "@adlc/domain";
import type { GatewaySessionContext, ModelCallRepository } from "@adlc/db";
import type { Logger } from "@adlc/telemetry";
import { z } from "zod";
import { InvalidArgumentsError, type Clock } from "./gateway.js";

export interface ModelProxyConfig {
  /** Claude API base URL (e.g. https://api.anthropic.com); a fake in dev and tests. */
  upstreamUrl: string;
  /** Name of the API key in the SecretProvider; the key never leaves the gateway (hard rule 9). */
  apiKeySecret: string;
  /** Upper bound on max_tokens per request (cost guard). */
  maxTokensCap: number;
}

export interface ProxiedResponse {
  status: number;
  body: unknown;
}

const messagesRequest = z.looseObject({
  model: z.string().min(1).max(200),
  max_tokens: z.number().int().positive(),
  messages: z.array(z.unknown()).min(1),
  stream: z.literal(false).optional(),
});

const messagesResponse = z.looseObject({
  id: z.string().min(1).max(200),
  model: z.string().optional(),
  usage: z.looseObject({ input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0) }).optional(),
});

/**
 * Model proxy (C4): agents call the Claude Messages API only through the gateway. The gateway
 * injects the API key and logs every call against the run (`model_call`), which is the record the
 * signer checks reviewer verdicts against (FR-EVD-002 condition c). Non-streaming only for now;
 * streaming arrives with the Agent SDK roles in Phase 1. Model output is untrusted data.
 */
export class ModelProxy {
  constructor(
    private readonly config: ModelProxyConfig,
    private readonly secrets: SecretProvider,
    private readonly modelCalls: ModelCallRepository,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async messages(run: GatewaySessionContext, body: unknown, anthropicVersion: string | undefined): Promise<ProxiedResponse> {
    if (typeof body === "object" && body !== null && (body as { stream?: unknown }).stream === true) {
      throw new InvalidArgumentsError("streaming is not supported by the gateway yet (Phase 1)");
    }
    const parsed = messagesRequest.safeParse(body);
    if (!parsed.success) throw new InvalidArgumentsError(`invalid Messages request: ${parsed.error.issues.map((i) => i.path.join(".") || "(body)").join(", ")}`);
    if (parsed.data.max_tokens > this.config.maxTokensCap) throw new InvalidArgumentsError(`max_tokens exceeds the cap of ${this.config.maxTokensCap}`);

    const apiKey = await this.secrets.get(this.config.apiKeySecret);
    const upstream = await fetch(`${this.config.upstreamUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": anthropicVersion ?? "2023-06-01" },
      body: JSON.stringify(parsed.data),
    });
    let json: unknown;
    try {
      json = await upstream.json();
    } catch {
      return { status: 502, body: { type: "error", error: { type: "bad_gateway", message: "upstream returned no JSON" } } };
    }
    const reply = messagesResponse.safeParse(json);
    if (upstream.ok && reply.success) {
      await this.modelCalls.record(
        {
          id: reply.data.id,
          runId: run.runId,
          model: reply.data.model ?? parsed.data.model,
          inputTokens: reply.data.usage?.input_tokens ?? 0,
          outputTokens: reply.data.usage?.output_tokens ?? 0,
          requestHash: stateHash(parsed.data),
          responseHash: stateHash(json),
        },
        this.clock.now(),
      );
      this.logger.info({ runId: run.runId, modelCallId: reply.data.id, model: reply.data.model }, "model call proxied");
    }
    return { status: upstream.status, body: redactSecrets(json, this.secrets.knownValues()) };
  }
}
