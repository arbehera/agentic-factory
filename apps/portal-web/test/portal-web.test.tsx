import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, PortalApi } from "../src/api.js";
import { App } from "../src/App.js";
import { formatAge, formatTime } from "../src/time.js";

const RUN = "11111111-2222-3333-4444-555555555555";

type Route = (init: RequestInit | undefined) => Response;

/** A fetch stand-in: routes by method + path; records calls. */
function fakeFetch(routes: Record<string, Route>) {
  const calls: { key: string; init: RequestInit | undefined }[] = [];
  const impl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://portal");
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    calls.push({ key, init });
    const route = routes[key];
    return Promise.resolve(route ? route(init) : new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function renderApp(routes: Record<string, Route>): { calls: ReturnType<typeof fakeFetch>["calls"] } {
  const { impl, calls } = fakeFetch(routes);
  const api = new PortalApi("", () => Promise.resolve("test-token"), impl);
  const wrap = (ui: ReactNode) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>;
  render(wrap(<App api={api} />));
  return { calls };
}

const fleetRow = { id: RUN, taskKey: "PILOT-1", role: "dummy", agentVersion: "0.0.1", modelTier: "B", state: "running", step: "S4", startedAt: "2026-11-05T08:00:00.000Z", heartbeatAgeSeconds: 95, tokensIn: 10, tokensOut: 5, costUsd: "0.0100" };

afterEach(() => {
  cleanup();
});

describe("FR-POR-001 portal web", () => {
  it("FR-POR-001 the fleet view lists runs with IST times and heartbeat age, sending the bearer token", async () => {
    const { calls } = renderApp({ "GET /api/runs": json([fleetRow]) });
    const table = await screen.findByRole("table", { name: "Agent fleet" });
    const row = within(table).getByRole("row", { name: /PILOT-1/ });
    expect(row.textContent).toContain("dummy");
    expect(row.textContent).toContain("5 Nov 2026, 13:30:00"); // 08:00Z shown in Asia/Kolkata
    expect(row.textContent).toContain("1m 35s");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer test-token");
  });

  it("FR-POR-001 run detail shows steps, timeline and the live log stream", async () => {
    const stream = () =>
      new Response(
        new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            c.enqueue(enc.encode('{"stream":"stdout","line":"first line"}\n{"stream":"std'));
            c.enqueue(enc.encode('err","line":"second line"}\n'));
            c.close();
          },
        }),
        { headers: { "content-type": "application/x-ndjson" } },
      );
    renderApp({
      "GET /api/runs": json([fleetRow]),
      [`GET /api/runs/${RUN}`]: json({
        run: { id: RUN, taskKey: "PILOT-1", state: "running", exitReason: null },
        steps: [{ id: 1, step: "S4", status: "running", startedAt: "2026-11-05T08:00:00.000Z", endedAt: null }],
        lease: { expiresAt: "2026-11-05T08:15:00.000Z", deadlineAt: "2026-11-05T09:00:00.000Z" },
        timeline: [{ seq: 1, ts: "2026-11-05T08:00:00.000Z", actor: { kind: "service", id: "adlc-orchestrator" }, action: "run.create", reason: "queued" }],
      }),
      [`GET /api/runs/${RUN}/logs`]: stream,
    });
    fireEvent.click(await screen.findByRole("button", { name: "PILOT-1" }));
    expect(await screen.findByText(/S4: running/)).toBeTruthy();
    expect(screen.getByText(/run.create by service:adlc-orchestrator/)).toBeTruthy();
    const log = screen.getByLabelText("Live log");
    await waitFor(() => { expect(log.textContent).toBe("first linesecond line"); });
  });

  it("FR-NOT-003 the inbox lists items and acknowledges one", async () => {
    let acked = false;
    const { calls } = renderApp({
      "GET /api/runs": json([]),
      "GET /api/inbox": () => json(acked ? [] : [{ id: "n1", event: "run.needs-human", severity: "high", title: "PILOT-1 needs a human", body: "Run failed.", link: `/runs/${RUN}`, dueAt: "2026-11-05T08:30:00.000Z", escalationLevel: 1 }])(),
      "POST /api/inbox/n1/ack": () => {
        acked = true;
        return json({ ackBy: "human:me" })();
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Inbox" }));
    const list = await screen.findByRole("list", { name: "Inbox" });
    expect(list.textContent).toContain("[HIGH] PILOT-1 needs a human");
    expect(list.textContent).toContain("escalated, level 1");
    fireEvent.click(within(list).getByRole("button", { name: "Acknowledge" }));
    expect(await screen.findByText("Nothing needs you right now.")).toBeTruthy();
    expect(calls.map((c) => c.key)).toContain("POST /api/inbox/n1/ack");
  });

  it("FR-POR-002 the kill switch needs a reason and an explicit confirmation before calling the API", async () => {
    let engaged = false;
    const { calls } = renderApp({
      "GET /api/runs": json([]),
      "GET /api/kill-switch": () => json({ engaged })(),
      "POST /api/kill-switch/engage": (init) => {
        engaged = true;
        return json({ engaged: true, received: JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown })();
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Kill switch" }));
    const start = await screen.findByRole("button", { name: "Engage kill switch…" });
    expect((start as HTMLButtonElement).disabled).toBe(true); // no reason yet
    fireEvent.change(screen.getByLabelText("Reason (required)"), { target: { value: "incident drill" } });
    fireEvent.click(start);
    expect(calls.some((c) => c.key === "POST /api/kill-switch/engage")).toBe(false); // not before confirming
    fireEvent.click(screen.getByRole("button", { name: "Yes, engage" }));
    expect(await screen.findByText(/ENGAGED/)).toBeTruthy();
    const post = calls.find((c) => c.key === "POST /api/kill-switch/engage");
    expect(JSON.parse(typeof post?.init?.body === "string" ? post.init.body : "null")).toEqual({ reason: "incident drill" });
  });

  it("shows API errors (e.g. a forbidden kill switch) instead of failing silently", async () => {
    renderApp({ "GET /api/runs": json({ error: "requires one of: viewer" }, 403) });
    expect((await screen.findByRole("alert")).textContent).toContain("requires one of: viewer");
  });
});

describe("display helpers", () => {
  it("formats times in Asia/Kolkata and ages compactly", () => {
    expect(formatTime("2026-11-05T18:45:00.000Z")).toBe("6 Nov 2026, 00:15:00");
    expect(formatTime(null)).toBe("—");
    expect([formatAge(null), formatAge(42), formatAge(3725)]).toEqual(["—", "42s", "1h 2m"]);
    expect(new ApiError(403, "x").status).toBe(403);
  });
});
