import { expect, test, type Page } from "@playwright/test";

const taskKey = process.env.E2E_TASK_KEY ?? "";
const password = process.env.PORTAL_PASSWORD ?? "";
const shot = (page: Page, name: string) => page.screenshot({ path: `results/${name}.png`, fullPage: true });

async function signIn(page: Page, username: string): Promise<void> {
  await page.goto("/");
  // Keycloak login page (dev realm, infra/compose/keycloak/realm-adlc.json).
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
}

test.describe("FR-POR-001 the portal shows the AT-P0-01 run live", () => {
  test.skip(!taskKey || !password, "run through scripts/dev/e2e.sh (needs E2E_TASK_KEY and PORTAL_PASSWORD)");

  test("AT-P0-01 an operator sees the task's runs in the fleet and the run's audited timeline", async ({ page }) => {
    await signIn(page, "dummy-owner-onduty");
    const fleet = page.getByRole("table", { name: "Agent fleet" });
    await expect(fleet.getByRole("row", { name: new RegExp(taskKey) }).first()).toBeVisible();
    await shot(page, "fleet");

    await page.getByRole("button", { name: taskKey }).last().click(); // the oldest row: the author's run
    await expect(page.getByText(/run\.create by service:adlc-orchestrator/)).toBeVisible();
    await expect(page.getByText(/tool\.github\.open_pull_request by agent-run:/)).toBeVisible();
    await shot(page, "run-detail");

    await page.getByRole("button", { name: "Inbox" }).click();
    await expect(page.getByRole("list", { name: "Inbox" }).or(page.getByText("Nothing needs you right now."))).toBeVisible();
    await shot(page, "inbox");
  });

  test("FR-POR-002 the kill switch page asks for a reason before it can be engaged", async ({ page }) => {
    await signIn(page, "platform-admin");
    await page.getByRole("button", { name: "Kill switch" }).click();
    await expect(page.getByRole("button", { name: "Engage kill switch…" })).toBeDisabled();
    await shot(page, "kill-switch");
  });
});
