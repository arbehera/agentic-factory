/** Typed client for the portal API (apps/portal-api). Every request carries the user's token. */

export type TokenSource = () => Promise<string>;

export interface FleetRun {
  id: string;
  taskKey: string | null;
  role: string;
  agentVersion: string;
  modelTier: string;
  state: string;
  step: string | null;
  startedAt: string | null;
  heartbeatAgeSeconds: number | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: string;
}

export interface RunDetail {
  run: { id: string; taskKey: string | null; state: string; exitReason: string | null };
  steps: { id: number; step: string; status: string; startedAt: string; endedAt: string | null }[];
  lease: { expiresAt: string; deadlineAt: string } | null;
  timeline: { seq: number; ts: string; actor: { kind: string; id: string }; action: string; reason: string }[];
}

export interface InboxItem {
  id: string;
  event: string;
  severity: string;
  title: string;
  body: string;
  link: string;
  dueAt: string | null;
  escalationLevel: number;
}

export interface LogLine {
  stream: "stdout" | "stderr";
  line: string;
}

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class PortalApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: TokenSource,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${await this.token()}` },
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
    return body as T;
  }

  fleet(): Promise<FleetRun[]> {
    return this.request("/api/runs");
  }

  run(id: string): Promise<RunDetail> {
    return this.request(`/api/runs/${encodeURIComponent(id)}`);
  }

  inbox(): Promise<InboxItem[]> {
    return this.request("/api/inbox");
  }

  acknowledge(id: string): Promise<unknown> {
    return this.request(`/api/inbox/${encodeURIComponent(id)}/ack`, { method: "POST" });
  }

  killSwitch(): Promise<{ engaged: boolean }> {
    return this.request("/api/kill-switch");
  }

  setKillSwitch(engage: boolean, reason: string): Promise<{ engaged: boolean }> {
    return this.request(`/api/kill-switch/${engage ? "engage" : "release"}`, { method: "POST", body: JSON.stringify({ reason }) });
  }

  /**
   * Live logs as newline-delimited JSON. fetch is used instead of EventSource because EventSource
   * cannot send the Authorization header, and tokens must not go into URLs.
   */
  async streamLogs(id: string, onLine: (l: LogLine) => void, signal: AbortSignal): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/runs/${encodeURIComponent(id)}/logs`, { headers: { authorization: `Bearer ${await this.token()}` }, signal });
    if (!res.ok || !res.body) throw new ApiError(res.status, `log stream unavailable (HTTP ${res.status})`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) onLine(JSON.parse(l) as LogLine);
    }
  }
}
