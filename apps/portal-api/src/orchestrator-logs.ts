import type { LogLine } from "@adlc/executor/contract";
import { NotFoundError, type RunLogSource } from "./portal-service.js";

const isLogLine = (v: unknown): v is LogLine =>
  typeof v === "object" && v !== null && ((v as LogLine).stream === "stdout" || (v as LogLine).stream === "stderr") && typeof (v as LogLine).line === "string";

/**
 * Live logs from the executor host (ADR-0014). The portal API holds no Docker access: it asks the
 * orchestrator replicas' internal route in turn, with the internal service token, and passes the
 * NDJSON lines through. Lines are validated; anything else in the stream is dropped.
 */
export class OrchestratorLogSource implements RunLogSource {
  constructor(
    private readonly urls: readonly string[],
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async follow(runId: string): Promise<AsyncIterable<LogLine>> {
    for (const url of this.urls) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${url.replace(/\/$/, "")}/internal/runs/${encodeURIComponent(runId)}/logs`, { headers: { authorization: `Bearer ${this.token}` } });
      } catch {
        continue; // replica down: try the next one
      }
      if (res.ok && res.body) return lines(res.body);
      await res.body?.cancel();
    }
    throw new NotFoundError(`no executor host has a log for run ${runId}`);
  }
}

async function* lines(body: ReadableStream<Uint8Array>): AsyncIterable<LogLine> {
  const decoder = new TextDecoder();
  let buffered = "";
  const parse = (text: string): LogLine | null => {
    try {
      const v: unknown = JSON.parse(text);
      return isLogLine(v) ? v : null;
    } catch {
      return null;
    }
  };
  for await (const chunk of body) {
    buffered += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffered.indexOf("\n")) >= 0) {
      const line = parse(buffered.slice(0, nl));
      buffered = buffered.slice(nl + 1);
      if (line) yield line;
    }
  }
  const last = buffered.trim() ? parse(buffered) : null;
  if (last) yield last;
}
