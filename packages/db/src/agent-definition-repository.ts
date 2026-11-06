import { desc, eq } from "drizzle-orm";
import type { DbExecutor } from "./client.js";
import { agentDefinition } from "./schema.js";

export type AgentDefinitionRow = typeof agentDefinition.$inferSelect;

export class AgentDefinitionNotFoundError extends Error {
  override name = "AgentDefinitionNotFoundError";
}

/** Registered agent definitions (spec.md §5); the YAML itself lives in Git. */
export class AgentDefinitionRepository {
  constructor(private readonly db: DbExecutor) {}

  async get(id: string): Promise<AgentDefinitionRow> {
    const [row] = await this.db.select().from(agentDefinition).where(eq(agentDefinition.id, id));
    if (!row) throw new AgentDefinitionNotFoundError(`agent definition ${id} not found`);
    return row;
  }

  /** The most recently registered definition for a role, or null. */
  async latestForRole(role: string): Promise<AgentDefinitionRow | null> {
    const [row] = await this.db.select().from(agentDefinition).where(eq(agentDefinition.role, role)).orderBy(desc(agentDefinition.createdAt)).limit(1);
    return row ?? null;
  }
}
