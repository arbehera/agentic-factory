import { useQuery } from "@tanstack/react-query";
import type { PortalApi } from "../api.js";
import { formatAge, formatTime } from "../time.js";

/** Agent fleet (FR-POR-001): every run with its state, task, step, version and heartbeat age. */
export function Fleet({ api, onOpen }: { api: PortalApi; onOpen: (runId: string) => void }) {
  const q = useQuery({ queryKey: ["fleet"], queryFn: () => api.fleet(), refetchInterval: 5_000 });
  if (q.isPending) return <p>Loading runs…</p>;
  if (q.isError) return <p role="alert">Could not load runs: {q.error.message}</p>;
  if (q.data.length === 0) return <p>No active or recent runs.</p>;
  return (
    <table>
      <caption>Agent fleet</caption>
      <thead>
        <tr>
          <th scope="col">Task</th>
          <th scope="col">Role</th>
          <th scope="col">Version</th>
          <th scope="col">State</th>
          <th scope="col">Step</th>
          <th scope="col">Started (IST)</th>
          <th scope="col">Heartbeat age</th>
          <th scope="col">Tokens</th>
        </tr>
      </thead>
      <tbody>
        {q.data.map((r) => (
          <tr key={r.id}>
            <td>
              <button type="button" onClick={() => { onOpen(r.id); }}>
                {r.taskKey ?? r.id.slice(0, 8)}
              </button>
            </td>
            <td>{r.role}</td>
            <td>{r.agentVersion}</td>
            <td>{r.state}</td>
            <td>{r.step ?? "—"}</td>
            <td>{formatTime(r.startedAt)}</td>
            <td>{formatAge(r.heartbeatAgeSeconds)}</td>
            <td>{r.tokensIn + r.tokensOut}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
