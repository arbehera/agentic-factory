import { z } from "zod";

/**
 * `config/rota.yaml`: who is notified for each audience, in escalation order (SDD §16.3): the first
 * member is on duty, the next is the backup, then the Program Lead. Real people and groups come from
 * Pioneer (OPEN-06, OPEN-21); dev uses placeholder addresses.
 */
const email = z.email();
const name = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const group = z.array(email).min(1);

export const rotaSchema = z.strictObject({
  programLead: email,
  /** Owner group per agent role (audience `role:<role>`). */
  roleOwners: z.record(name, group),
  /** Approver group per gate (audience `gate:<gate>`). */
  gateApprovers: z.record(z.string().regex(/^G[0-6]$|^G-CR$|^G[2-4]Δ$/), group).default({}),
});
export type Rota = z.infer<typeof rotaSchema>;

/** Members of an audience in escalation order, or null if the rota does not know it. */
export function rotaGroup(rota: Rota, audience: string): string[] | null {
  const [kind, key = ""] = audience.split(":", 2);
  if (kind === "role") return rota.roleOwners[key] ?? null;
  if (kind === "gate") return rota.gateApprovers[key] ?? null;
  return null;
}
