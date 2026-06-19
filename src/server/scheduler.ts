import cron from "node-cron";
import { cleanupMonitorResults, runDueChecks, runScheduledIcpChecks } from "./checks.js";
import { getSettings } from "./db.js";
import { cleanupAlertEvents, pollTelegramCommands } from "./telegram.js";

let running = false;
let telegramPolling = false;
let icpRunning = false;
const scheduleWithOptions = cron.schedule as unknown as (
  expression: string,
  task: () => Promise<void>,
  options?: { timezone?: string }
) => void;

export function startScheduler() {
  void Promise.all([cleanupMonitorResults(), cleanupAlertEvents()]);

  cron.schedule("*/5 * * * * *", async () => {
    if (running) return;
    running = true;
    try {
      await runDueChecks();
    } finally {
      running = false;
    }
  });

  cron.schedule("*/10 * * * * *", async () => {
    if (telegramPolling) return;
    telegramPolling = true;
    try {
      await pollTelegramCommands(await getSettings());
    } finally {
      telegramPolling = false;
    }
  });

  cron.schedule("17 3 * * *", async () => {
    await Promise.all([cleanupMonitorResults(), cleanupAlertEvents()]);
  });

  scheduleWithOptions("0 12,15,18 * * *", async () => {
    if (icpRunning) return;
    icpRunning = true;
    try {
      await runScheduledIcpChecks();
    } finally {
      icpRunning = false;
    }
  }, { timezone: "Asia/Shanghai" });
}
