import type { DispatchEnvironment } from "@adlc/domain";
import { eq } from "drizzle-orm";
import type { DbExecutor } from "./client.js";
import { project } from "./schema.js";

export type ProjectRow = typeof project.$inferSelect;

export class ProjectNotFoundError extends Error {
  override name = "ProjectNotFoundError";
}

/** Projects (spec.md §5). Only platform-owned fields; product content lives in Jira and Git. */
export class ProjectRepository {
  constructor(private readonly db: DbExecutor) {}

  async get(id: string): Promise<ProjectRow> {
    const [row] = await this.db.select().from(project).where(eq(project.id, id));
    if (!row) throw new ProjectNotFoundError(`project ${id} not found`);
    return row;
  }

  async environment(id: string): Promise<DispatchEnvironment> {
    return (await this.get(id)).environment as DispatchEnvironment;
  }
}
