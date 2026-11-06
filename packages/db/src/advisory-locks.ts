/**
 * Registry of PostgreSQL advisory-lock keys (hard rule 8: locks live in PostgreSQL). Every key
 * used anywhere in the platform is declared here so two features can never collide.
 */
export const ADVISORY_LOCKS = {
  /** Dispatcher leader election (FR-ORC-015, P0-WP3). */
  dispatcherLeader: 7_100_001,
  /** Serialises appends to the audit hash chain. */
  auditChain: 7_100_002,
} as const;

/**
 * Per-task lease acquisition uses transaction locks keyed by
 * `hashtextextended('lease:' || taskKey, 0)` (LeaseRepository.acquire). That 64-bit hashed
 * keyspace is reserved for leases; fixed keys above are small integers.
 */
export const LEASE_LOCK_NAMESPACE = "lease:";
