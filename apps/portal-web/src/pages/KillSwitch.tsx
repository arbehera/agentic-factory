import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { PortalApi } from "../api.js";

/**
 * Global kill switch (FR-ORC-012, FR-POR-002). A reason is required, and the action needs an
 * explicit second confirmation step on the page. The API enforces roles and audits the change.
 */
export function KillSwitch({ api }: { api: PortalApi }) {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ["kill-switch"], queryFn: () => api.killSwitch() });
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const change = useMutation({
    mutationFn: (engage: boolean) => api.setKillSwitch(engage, reason.trim()),
    onSuccess: async () => {
      setReason("");
      setConfirming(false);
      await client.invalidateQueries({ queryKey: ["kill-switch"] });
    },
  });
  if (q.isPending) return <p>Loading…</p>;
  if (q.isError) return <p role="alert">Could not load the kill switch: {q.error.message}</p>;
  const engaged = q.data.engaged;
  const verb = engaged ? "Release" : "Engage";
  const reasonOk = reason.trim().length >= 3;
  return (
    <section aria-label="Kill switch">
      <h2>Kill switch: {engaged ? "ENGAGED — no new claims; running steps stop after they finish" : "off"}</h2>
      <label>
        Reason (required)
        <input value={reason} onChange={(e) => { setReason(e.target.value); setConfirming(false); }} />
      </label>
      {!confirming ? (
        <button type="button" disabled={!reasonOk} onClick={() => { setConfirming(true); }}>
          {verb} kill switch…
        </button>
      ) : (
        <p>
          {verb} the kill switch for every project?{" "}
          <button type="button" disabled={change.isPending} onClick={() => { change.mutate(!engaged); }}>
            Yes, {verb.toLowerCase()}
          </button>{" "}
          <button type="button" onClick={() => { setConfirming(false); }}>Cancel</button>
        </p>
      )}
      {change.isError && <p role="alert">{change.error.message}</p>}
    </section>
  );
}
