import { z } from "zod";

/**
 * `agents/reviewer-sets.yaml`: the reviewer roles whose approving verdicts the signer requires,
 * per author role (SDD §8.5 S6, FR-EVD-002 condition a). The tier rule (FR-AGT-002) is added with
 * the real reviewer agents (P3-WP2).
 */
const role = z.string().regex(/^[a-z][a-z0-9-]*$/);

export const reviewerSetsSchema = z
  .strictObject({ sets: z.record(role, z.array(role).min(1, "an author role needs at least one reviewer")) })
  .superRefine((r, ctx) => {
    for (const [author, reviewers] of Object.entries(r.sets)) {
      if (reviewers.includes(author)) ctx.addIssue({ code: "custom", path: ["sets", author], message: `${author} may not review its own work` });
      if (new Set(reviewers).size !== reviewers.length) ctx.addIssue({ code: "custom", path: ["sets", author], message: "duplicate reviewer role" });
    }
  });
export type ReviewerSets = z.infer<typeof reviewerSetsSchema>;
