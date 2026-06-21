import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

export type AppSettings = {
  telegramBotToken: string;
  telegramChatId: string;
  defaultUrlIntervalSeconds: number;
  defaultFailureThreshold: number;
  defaultTimeoutMs: number;
  defaultExpectedStatuses: string;
  expiryReminderDays: number[];
  alertCooldownMinutes: number;
  alertMaxCooldownMinutes: number;
  icpGlobalEnabled: boolean;
  icpQueryBaseUrl: string;
};

export const defaultSettings: AppSettings = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? "",
  defaultUrlIntervalSeconds: 10,
  defaultFailureThreshold: 1,
  defaultTimeoutMs: 10000,
  defaultExpectedStatuses: "200-399",
  expiryReminderDays: [30, 7, 1],
  alertCooldownMinutes: 1,
  alertMaxCooldownMinutes: 720,
  icpGlobalEnabled: true,
  icpQueryBaseUrl: process.env.ICP_QUERY_BASE_URL ?? "http://127.0.0.1:16181"
};

const numericKeys = new Set([
  "defaultUrlIntervalSeconds",
  "defaultFailureThreshold",
  "defaultTimeoutMs",
  "alertCooldownMinutes",
  "alertMaxCooldownMinutes"
]);
const booleanKeys = new Set(["icpGlobalEnabled"]);

export async function getSettings(): Promise<AppSettings> {
  const rows = await prisma.setting.findMany();
  const values = { ...defaultSettings } as Record<string, unknown>;

  for (const row of rows) {
    if (row.key === "expiryReminderDays") {
      values[row.key] = parseDays(row.value, defaultSettings.expiryReminderDays);
    } else if (numericKeys.has(row.key)) {
      values[row.key] = Number(row.value);
    } else if (booleanKeys.has(row.key)) {
      values[row.key] = row.value === "true";
    } else {
      values[row.key] = row.value;
    }
  }

  return values as AppSettings;
}

export async function updateSettings(input: Partial<AppSettings>) {
  const entries = Object.entries(input).filter(([, value]) => value !== undefined);
  await prisma.$transaction(
    entries.map(([key, value]) =>
      prisma.setting.upsert({
        where: { key },
        update: { value: serializeSetting(value) },
        create: { key, value: serializeSetting(value) }
      })
    )
  );
  return getSettings();
}

export function parseDays(value: string | null | undefined, fallback = defaultSettings.expiryReminderDays) {
  if (!value) return fallback;
  const days = value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((day) => Number.isInteger(day) && day > 0)
    .sort((a, b) => b - a);
  return days.length ? days : fallback;
}

function serializeSetting(value: unknown) {
  return Array.isArray(value) ? value.join(",") : String(value ?? "");
}
