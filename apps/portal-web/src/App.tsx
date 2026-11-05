import { useState } from "react";
import type { PortalApi } from "./api.js";
import { Fleet } from "./pages/Fleet.js";
import { Inbox } from "./pages/Inbox.js";
import { KillSwitch } from "./pages/KillSwitch.js";
import { RunDetail } from "./pages/RunDetail.js";

type View = { name: "fleet" } | { name: "run"; runId: string } | { name: "inbox" } | { name: "kill-switch" };

/**
 * Agent Operations Portal skeleton (P0-WP10): fleet, run detail with live logs, inbox and the kill
 * switch. Gate and merge approvals are not here; they stay in Jira and GitHub (FR-POR-004).
 */
export function App({ api }: { api: PortalApi }) {
  const [view, setView] = useState<View>({ name: "fleet" });
  const openLink = (link: string) => {
    const m = /^\/runs\/([0-9a-f-]+)$/.exec(link);
    if (m?.[1]) setView({ name: "run", runId: m[1] });
  };
  return (
    <div>
      <header>
        <h1>ADLC Agent Operations</h1>
        <nav aria-label="Portal">
          <button type="button" onClick={() => { setView({ name: "fleet" }); }}>Fleet</button>{" "}
          <button type="button" onClick={() => { setView({ name: "inbox" }); }}>Inbox</button>{" "}
          <button type="button" onClick={() => { setView({ name: "kill-switch" }); }}>Kill switch</button>
        </nav>
      </header>
      <main>
        {view.name === "fleet" && <Fleet api={api} onOpen={(runId) => { setView({ name: "run", runId }); }} />}
        {view.name === "run" && <RunDetail api={api} runId={view.runId} onBack={() => { setView({ name: "fleet" }); }} />}
        {view.name === "inbox" && <Inbox api={api} onOpenLink={openLink} />}
        {view.name === "kill-switch" && <KillSwitch api={api} />}
      </main>
    </div>
  );
}
