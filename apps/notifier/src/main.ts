import { readFile } from "node:fs/promises";
import { createDb, createPool, NotificationRepository } from "@adlc/db";
import { loadYamlContract } from "@adlc/pack-sdk";
import { rotaSchema, workingCalendarSchema } from "@adlc/schemas";
import { createLogger } from "@adlc/telemetry";
import { z } from "zod";
import { SmtpEmailChannel } from "./email.js";
import { NotifierService } from "./notifier-service.js";

const env = z
  .object({
    DATABASE_URL: z.url(),
    SMTP_URL: z.string().min(1),
    MAIL_FROM: z.email(),
    PORTAL_URL: z.url(),
    ROTA_FILE: z.string().default("config/rota.yaml"),
    CALENDAR_FILE: z.string().default("config/working-calendar.yaml"),
    TICK_MS: z.coerce.number().int().positive().default(15_000),
    LOG_LEVEL: z.string().default("info"),
  })
  .parse(process.env);

const logger = createLogger("notifier", { level: env.LOG_LEVEL });
const rota = loadYamlContract(rotaSchema, await readFile(env.ROTA_FILE, "utf8"), env.ROTA_FILE);
const calendar = loadYamlContract(workingCalendarSchema, await readFile(env.CALENDAR_FILE, "utf8"), env.CALENDAR_FILE);
const pool = createPool(env.DATABASE_URL, { onIdleError: (err) => {
    logger.warn({ err: err.message }, "idle database connection closed");
  } });
const email = new SmtpEmailChannel(env.SMTP_URL, env.MAIL_FROM);
const notifier = new NotifierService(new NotificationRepository(createDb(pool)), email, rota, calendar, env.PORTAL_URL.replace(/\/$/, ""), { now: () => new Date() }, logger);

let busy = false;
const timer = setInterval(() => {
  if (busy) return;
  busy = true;
  notifier
    .tick()
    .then((r) => {
      if (r.routed + r.escalated + r.delivered + r.failed > 0) logger.info(r, "notifier tick");
    })
    .catch((err: unknown) => {
      logger.error({ err: (err as Error).message }, "notifier tick failed");
    })
    .finally(() => {
      busy = false;
    });
}, env.TICK_MS);

process.on("SIGTERM", () => {
  clearInterval(timer);
  email.close();
  void pool.end();
});
logger.info({ tickMs: env.TICK_MS }, "notifier running");
