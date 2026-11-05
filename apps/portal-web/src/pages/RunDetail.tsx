import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { LogLine, PortalApi } from "../api.js";
import { formatTime } from "../time.js";

/** Run detail (FR-POR-001): steps, lease, audited timeline and the live log stream. */
export function RunDetail({ api, runId, onBack }: { api: PortalApi; runId: string; onBack: () => void }) {
  const q = useQuery({ queryKey: ["run", runId], queryFn: () => api.run(runId), refetchInterval: 5_000 });
  const [lines, setLines] = useState<LogLine[]>([]);
  const [logError, setLogError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setLines([]);
    api
      .streamLogs(runId, (l) => { setLines((prev) => [...prev.slice(-999), l]); }, ctrl.signal)
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted) setLogError((err as Error).message);
      });
    return () => { ctrl.abort(); };
  }, [api, runId]);

  return (
    <section aria-label="Run detail">
      <button type="button" onClick={onBack}>← Fleet</button>
      {q.isPending && <p>Loading run…</p>}
      {q.isError && <p role="alert">Could not load the run: {q.error.message}</p>}
      {q.data && (
        <>
          <h2>
            {q.data.run.taskKey ?? q.data.run.id} — {q.data.run.state}
          </h2>
          {q.data.run.exitReason && <p>Exit reason: {q.data.run.exitReason}</p>}
          {q.data.lease && <p>Lease expires {formatTime(q.data.lease.expiresAt)}, deadline {formatTime(q.data.lease.deadlineAt)}</p>}
          <h3>Steps</h3>
          <ol>
            {q.data.steps.map((s) => (
              <li key={s.id}>
                {s.step}: {s.status} (from {formatTime(s.startedAt)})
              </li>
            ))}
          </ol>
          <h3>Timeline</h3>
          <ol>
            {q.data.timeline.map((e) => (
              <li key={e.seq}>
                {formatTime(e.ts)} — {e.action} by {e.actor.kind}:{e.actor.id} — {e.reason}
              </li>
            ))}
          </ol>
        </>
      )}
      <h3>Live log</h3>
      {logError && <p role="status">{logError}</p>}
      <pre aria-label="Live log" style={{ maxHeight: "24rem", overflow: "auto" }}>
        {lines.map((l, i) => (
          <div key={i} className={l.stream}>
            {l.line}
          </div>
        ))}
      </pre>
    </section>
  );
}
