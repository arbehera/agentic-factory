import { InvalidTransitionError } from "./errors.js";

export interface StateMachine<S extends string> {
  readonly name: string;
  readonly states: readonly S[];
  readonly terminal: readonly S[];
  next(from: S): readonly S[];
  canTransition(from: S, to: S): boolean;
  /** Throws InvalidTransitionError when the transition is not in the table. */
  assertTransition(from: S, to: S): void;
}

/** Builds a machine from an explicit transition table; states with no exits are terminal. */
export function defineMachine<S extends string>(
  name: string,
  table: { readonly [K in S]: readonly S[] },
): StateMachine<S> {
  const states = Object.keys(table) as S[];
  const terminal = states.filter((s) => table[s].length === 0);
  return {
    name,
    states,
    terminal,
    next: (from) => table[from],
    canTransition: (from, to) => table[from].includes(to),
    assertTransition(from, to) {
      if (!table[from].includes(to)) throw new InvalidTransitionError(name, from, to);
    },
  };
}
