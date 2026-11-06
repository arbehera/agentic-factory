import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadYamlContract } from "@adlc/pack-sdk";
import { githubRepoConfigSchema, jiraProjectConfigSchema } from "@adlc/schemas";
import { GithubConfigClient } from "./github/client.js";
import { planGithub, renderGithubPlan, type GithubActualState } from "./github/plan.js";
import { desiredJira, renderJiraPlan } from "./jira/desired.js";

// Configuration-as-code for the sandbox and pilot tools (C15; FR-JIRA-001, FR-GH-001). Run by a
// human operator, never by an agent (hard rule 3). Exit 0 = ok, 1 = blocked/failed, 2 = usage.
//
//   config-sync github plan  <manifest> [--offline --owner-type User|Organization [--existing]]
//   config-sync github apply <manifest> --confirm <owner/repo>
//   config-sync jira   plan  <manifest>
//
// Live GitHub calls read GITHUB_ADMIN_TOKEN; ADLC_CI_APP_ID pins the required checks to the CI App.
const usage = "usage: config-sync github plan <manifest> [--offline --owner-type User|Organization [--existing]] | github apply <manifest> --confirm <owner/repo> | jira plan <manifest>";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { offline: { type: "boolean" }, "owner-type": { type: "string" }, existing: { type: "boolean" }, confirm: { type: "string" }, json: { type: "boolean" } },
});
const [tool, command, file] = positionals;
if (!tool || !command || !file || positionals.length > 3) {
  console.error(usage);
  process.exit(2);
}
const text = await readFile(file, "utf8");

if (tool === "jira" && command === "plan") {
  process.stdout.write(renderJiraPlan(desiredJira(loadYamlContract(jiraProjectConfigSchema, text, file))));
  console.log("Live drift check and apply arrive with sandbox access (Q-04, ADR-0016).");
} else if (tool === "github" && (command === "plan" || command === "apply")) {
  const config = loadYamlContract(githubRepoConfigSchema, text, file);
  const ciAppId = process.env.ADLC_CI_APP_ID ? Number(process.env.ADLC_CI_APP_ID) : null;
  let actual: GithubActualState;
  let client: GithubConfigClient | null = null;
  if (values.offline) {
    if (command === "apply") throw new Error("apply needs the live repository state; drop --offline");
    const ownerType = values["owner-type"];
    if (ownerType !== "User" && ownerType !== "Organization") {
      console.error("--offline needs --owner-type User|Organization");
      process.exit(2);
    }
    actual = { ownerType, empty: !values.existing, rulesets: [], codeowners: null };
  } else {
    const token = process.env.GITHUB_ADMIN_TOKEN;
    if (!token) {
      console.error("GITHUB_ADMIN_TOKEN is not set (see infra/compose/.env.example); use --offline for a dry run");
      process.exit(2);
    }
    client = new GithubConfigClient(config.repo, token);
    actual = await client.readState();
  }
  const plan = planGithub(config, actual, { ci: ciAppId });
  process.stdout.write(values.json ? `${JSON.stringify(plan, null, 2)}\n` : renderGithubPlan(plan));
  if (command === "apply") {
    if (values.confirm !== config.repo) {
      console.error(`apply changes ${config.repo}: repeat the repository with --confirm ${config.repo}`);
      process.exit(2);
    }
    for (const line of await (client as GithubConfigClient).apply(plan)) console.log(`applied: ${line}`);
  } else if (plan.blockers.length > 0) {
    process.exitCode = 1;
  }
} else {
  console.error(usage);
  process.exit(2);
}
