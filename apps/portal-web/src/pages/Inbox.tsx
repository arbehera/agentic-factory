import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PortalApi } from "../api.js";
import { formatTime } from "../time.js";

/** Portal inbox (FR-NOT-003): items needing the user, with one-click acknowledge. */
export function Inbox({ api, onOpenLink }: { api: PortalApi; onOpenLink: (link: string) => void }) {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ["inbox"], queryFn: () => api.inbox(), refetchInterval: 15_000 });
  const ack = useMutation({
    mutationFn: (id: string) => api.acknowledge(id),
    onSuccess: () => client.invalidateQueries({ queryKey: ["inbox"] }),
  });
  if (q.isPending) return <p>Loading inbox…</p>;
  if (q.isError) return <p role="alert">Could not load the inbox: {q.error.message}</p>;
  if (q.data.length === 0) return <p>Nothing needs you right now.</p>;
  return (
    <ul aria-label="Inbox">
      {q.data.map((n) => (
        <li key={n.id}>
          <strong>[{n.severity.toUpperCase()}] {n.title}</strong>
          {n.escalationLevel > 0 && <span> (escalated, level {n.escalationLevel})</span>}
          <p>{n.body}</p>
          <p>Acknowledge by {formatTime(n.dueAt)}</p>
          <button type="button" onClick={() => { onOpenLink(n.link); }}>Open</button>{" "}
          <button type="button" disabled={ack.isPending} onClick={() => { ack.mutate(n.id); }}>
            Acknowledge
          </button>
        </li>
      ))}
      {ack.isError && <li role="alert">Could not acknowledge: {ack.error.message}</li>}
    </ul>
  );
}
