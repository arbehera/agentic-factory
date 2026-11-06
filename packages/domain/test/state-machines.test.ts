import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  agentRunMachine,
  assertGateResolution,
  assertTaskTransition,
  decisionMachine,
  DONE_ACTOR_ID,
  gateMachine,
  InvalidTransitionError,
  requiredApprovals,
  TASK_STATUSES,
  taskStatusMachine,
  type Actor,
  type StateMachine,
  type TaskStatus,
} from "../src/index.js";

const machines: StateMachine<string>[] = [taskStatusMachine, agentRunMachine, gateMachine, decisionMachine];
const orchestrator: Actor = { kind: "service", id: DONE_ACTOR_ID };

/** Random walk: at each step pick any target state; apply it only if the machine allows it. */
function walk<S extends string>(m: StateMachine<S>, start: S, picks: number[]): S[] {
  const path = [start];
  let cur = start;
  for (const p of picks) {
    const to = m.states[p % m.states.length] as S;
    if (m.canTransition(cur, to)) {
      m.assertTransition(cur, to);
      cur = to;
      path.push(cur);
    } else {
      expect(() => { m.assertTransition(cur, to); }).toThrow(InvalidTransitionError);
    }
  }
  return path;
}

describe.each(machines.map((m) => [m.name, m] as const))("P0-WP2 state machine %s", (_name, m) => {
  it("every transition target is a declared state", () => {
    for (const s of m.states) for (const t of m.next(s)) expect(m.states).toContain(t);
  });

  it("property: random walks only follow table edges, and terminal states have no exit", () => {
    fc.assert(
      fc.property(fc.nat({ max: m.states.length - 1 }), fc.array(fc.nat(), { maxLength: 40 }), (start, picks) => {
        const path = walk(m, m.states[start] as string, picks);
        path.slice(1).forEach((s, i) => { expect(m.canTransition(path[i] as string, s)).toBe(true); });
        const last = path[path.length - 1] as string;
        if (m.terminal.includes(last)) expect(m.next(last)).toEqual([]);
      }),
    );
  });
});

describe("P0-WP2 task status (SDD §8.2)", () => {
  it("happy path Draft → Done is allowed for the orchestrator identity", () => {
    const path: TaskStatus[] = ["Draft", "To Do", "In Progress", "In Review", "Awaiting Approval", "Done"];
    path.slice(1).forEach((to, i) => { assertTaskTransition(path[i] as TaskStatus, to, orchestrator); });
  });

  it("FR-JIRA-001 property: Done is reachable only via Awaiting Approval and only by adlc-orchestrator", () => {
    const actorArb = fc.record({
      kind: fc.constantFrom("agent-run", "human", "service"),
      id: fc.oneof(fc.constant(DONE_ACTOR_ID), fc.string()),
    });
    fc.assert(
      fc.property(fc.constantFrom(...TASK_STATUSES), actorArb, (from, actor) => {
        const allowed = (() => {
          try { assertTaskTransition(from, "Done", actor); return true; } catch { return false; }
        })();
        expect(allowed).toBe(from === "Awaiting Approval" && actor.kind === "service" && actor.id === DONE_ACTOR_ID);
      }),
    );
  });

  it("Done is terminal", () => {
    expect(taskStatusMachine.terminal).toEqual(["Done"]);
  });
});

describe("P0-WP2 gates never auto-resolve (hard rule 2)", () => {
  const h = (id: string): Actor => ({ kind: "human", id });

  it("a gate is resolved only from Ready for Approval", () => {
    expect(() => { assertGateResolution("G5", "Open", "Approved", [h("a")]); }).toThrow(InvalidTransitionError);
  });

  it("property: any non-human approver, or no approver, is rejected", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("G0", "G5", "G6"),
        fc.constantFrom("Approved", "Rejected"),
        fc.constantFrom("agent-run", "service") as fc.Arbitrary<Actor["kind"]>,
        (gate, to, kind) => {
          expect(() => { assertGateResolution(gate, "Ready for Approval", to, [{ kind, id: "x" }]); }).toThrow(/only humans/);
          expect(() => { assertGateResolution(gate, "Ready for Approval", to, []); }).toThrow(/only humans/);
        },
      ),
    );
  });

  it("G1–G4 are two-key: one approver, or the same approver twice, is not enough", () => {
    expect(requiredApprovals("G2")).toBe(2);
    expect(requiredApprovals("G5")).toBe(1);
    expect(() => { assertGateResolution("G2", "Ready for Approval", "Approved", [h("a"), h("a")]); }).toThrow(/2 distinct/);
    expect(() => { assertGateResolution("G2", "Ready for Approval", "Approved", [h("a"), h("b")]); }).not.toThrow();
    expect(() => { assertGateResolution("G2", "Ready for Approval", "Rejected", [h("a")]); }).not.toThrow();
    expect(() => { assertGateResolution("G5", "Ready for Approval", "Approved", [h("a")]); }).not.toThrow();
  });

  it("moving a gate to Ready for Approval needs no approvers", () => {
    expect(() => { assertGateResolution("G0", "Open", "Ready for Approval", []); }).not.toThrow();
  });
});
