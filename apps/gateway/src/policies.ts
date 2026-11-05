import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ConfigValidationError, loadYamlContract } from "@adlc/pack-sdk";
import { rolePolicySchema, type RolePolicy } from "@adlc/schemas";

/** Loads `agents/<role>/policy.yaml` for every role directory; the role must match its directory. */
export async function loadRolePolicies(agentsDir: string): Promise<Map<string, RolePolicy>> {
  const policies = new Map<string, RolePolicy>();
  for (const entry of await readdir(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(agentsDir, entry.name, "policy.yaml");
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue; // roles without a policy get no tools at all
    }
    const source = `agents/${entry.name}/policy.yaml`;
    const policy = loadYamlContract(rolePolicySchema, text, source);
    if (policy.role !== entry.name) {
      throw new ConfigValidationError(source, [{ path: "role", message: `role "${policy.role}" does not match directory "${entry.name}"` }]);
    }
    policies.set(policy.role, policy);
  }
  return policies;
}
