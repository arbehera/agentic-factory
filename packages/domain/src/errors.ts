/** Base class for rule violations detected by pure domain logic. */
export class DomainError extends Error {
  override name = "DomainError";
}

export class InvalidTransitionError extends DomainError {
  override name = "InvalidTransitionError";
  constructor(
    readonly machine: string,
    readonly from: string,
    readonly to: string,
    reason?: string,
  ) {
    super(`${machine}: transition ${from} -> ${to} not allowed${reason ? ` (${reason})` : ""}`);
  }
}

export class InvalidIdError extends DomainError {
  override name = "InvalidIdError";
}

export class DecisionInvariantError extends DomainError {
  override name = "DecisionInvariantError";
}
