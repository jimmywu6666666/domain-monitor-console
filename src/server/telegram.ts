import { getSettings, prisma, type AppSettings } from "./db.js";

type TelegramUpdate = {
  update_id: number;
  message?: {
    text?: string;
    chat?: {
      id: number;
      title?: string;
      username?: string;
      first_name?: string;
      type?: string;
    };
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: {
      chat?: {
        id: number;
      };
    };
  };
};

let commandsConfiguredForToken = "";
const monitorKeyboard = {
  keyboard: [
    [{ text: "📲 菜单" }]
  ],
  resize_keyboard: true,
  is_persistent: true
};
const monitorInlineMenu = {
  inline_keyboard: [
    [
      { text: "📊 监控概览", callback_data: "status" },
      { text: "🔴 异常 URL", callback_data: "down" }
    ],
    [
      { text: "🟠 到期域名", callback_data: "expiring" },
      { text: "🟡 备案异常", callback_data: "icp" }
    ],
    [
      { text: "🔔 最近告警", callback_data: "alerts" },
      { text: "🆔 获取 Chat ID", callback_data: "chatid" }
    ]
  ]
};

export async function sendTelegram(settings: AppSettings, message: string) {
  const chatIds = parseTelegramChatIds(settings.telegramChatId);
  if (!settings.telegramBotToken || !chatIds.length) {
    return { ok: false, error: "Telegram 未配置" };
  }

  const results = await Promise.all(
    chatIds.map(async (chatId) => {
      try {
        const response = await fetch(`https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: monitorKeyboard
          })
        });
        const text = await response.text();
        return { chatId, ok: response.ok, result: text, error: response.ok ? undefined : text };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { chatId, ok: false, result: "", error: message };
      }
    })
  );
  const failed = results.filter((result) => !result.ok);
  return {
    ok: failed.length === 0,
    result: JSON.stringify(results),
    error: failed.length ? failed.map((result) => `${result.chatId}: ${result.error}`).join("\n") : undefined
  };
}

export async function pollTelegramCommands(settings: AppSettings) {
  if (!settings.telegramBotToken) return { ok: false, error: "Telegram Bot Token 未配置" };

  await ensureTelegramCommands(settings.telegramBotToken);

  const offsetRow = await prisma.setting.findUnique({ where: { key: "telegramUpdateOffset" } });
  const offset = Number(offsetRow?.value || "0");
  const url = new URL(`https://api.telegram.org/bot${settings.telegramBotToken}/getUpdates`);
  if (offset > 0) url.searchParams.set("offset", String(offset));
  url.searchParams.set("timeout", "0");
  url.searchParams.set("allowed_updates", JSON.stringify(["message", "callback_query"]));

  const response = await fetch(url);
  if (!response.ok) return { ok: false, error: await response.text() };

  const payload = (await response.json()) as { ok: boolean; result?: TelegramUpdate[]; description?: string };
  if (!payload.ok) return { ok: false, error: payload.description ?? "Telegram getUpdates failed" };

  const updates = payload.result ?? [];
  let nextOffset = offset;
  for (const update of updates) {
    nextOffset = Math.max(nextOffset, update.update_id + 1);
    if (update.callback_query) {
      await handleTelegramCallback(settings, update.callback_query);
      continue;
    }

    const text = update.message?.text?.trim().toLowerCase();
    const chat = update.message?.chat;
    if (!chat || !text) continue;

    if (text === "/start" || text === "/chatid" || text === "chatid" || text === "🆔 获取 chat id") {
      await sendTelegramToChat(settings.telegramBotToken, String(chat.id), buildChatIdMessage(chat), monitorKeyboard);
      continue;
    }

    if (text === "📲 菜单" || text === "菜单") {
      await sendTelegramToChat(settings.telegramBotToken, String(chat.id), "我的选项：", monitorInlineMenu);
      continue;
    }

    const command = normalizeMonitorCommand(text);
    if (!command) continue;

    if (!isAllowedTelegramChat(settings, String(chat.id))) {
      await sendTelegramToChat(settings.telegramBotToken, String(chat.id), "请先把 Chat ID 发给管理员配置到系统里。", monitorKeyboard);
      continue;
    }

    await sendTelegramToChat(settings.telegramBotToken, String(chat.id), await buildMonitorCommandMessage(command), monitorKeyboard);
  }

  if (nextOffset !== offset) {
    await prisma.setting.upsert({
      where: { key: "telegramUpdateOffset" },
      update: { value: String(nextOffset) },
      create: { key: "telegramUpdateOffset", value: String(nextOffset) }
    });
  }

  return { ok: true, processed: updates.length };
}

export function parseTelegramChatIds(value: string) {
  return value
    .split(",")
    .map((chatId) => chatId.trim())
    .filter(Boolean);
}

async function sendTelegramToChat(botToken: string, chatId: string, message: string, replyMarkup?: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: replyMarkup
    })
  });
  return { ok: response.ok, result: await response.text() };
}

async function ensureTelegramCommands(botToken: string) {
  if (commandsConfiguredForToken === botToken) return;
  const response = await fetch(`https://api.telegram.org/bot${botToken}/deleteMyCommands`, {
    method: "POST",
    headers: { "content-type": "application/json" }
  });
  if (response.ok) commandsConfiguredForToken = botToken;
}

async function handleTelegramCallback(settings: AppSettings, callback: NonNullable<TelegramUpdate["callback_query"]>) {
  const chatId = callback.message?.chat?.id;
  if (!chatId || !callback.data) return;
  await answerCallback(settings.telegramBotToken, callback.id);

  if (callback.data === "chatid") {
    await sendTelegramToChat(
      settings.telegramBotToken,
      String(chatId),
      [`Chat ID：<code>${chatId}</code>`, "", "请把这个 ID 发给管理员配置到系统里。"].join("\n"),
      monitorKeyboard
    );
    return;
  }

  const command = normalizeMonitorCommand(`/${callback.data}`);
  if (!command) return;
  if (!isAllowedTelegramChat(settings, String(chatId))) {
    await sendTelegramToChat(settings.telegramBotToken, String(chatId), "请先把 Chat ID 发给管理员配置到系统里。", monitorKeyboard);
    return;
  }

  await sendTelegramToChat(settings.telegramBotToken, String(chatId), await buildMonitorCommandMessage(command), monitorKeyboard);
}

async function answerCallback(botToken: string, callbackQueryId: string) {
  await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId })
  });
}

function isAllowedTelegramChat(settings: AppSettings, chatId: string) {
  return parseTelegramChatIds(settings.telegramChatId).includes(chatId);
}

function buildChatIdMessage(chat: NonNullable<TelegramUpdate["message"]>["chat"]) {
  return [
    `Chat ID：<code>${chat?.id}</code>`,
    "",
    "请把这个 ID 发给管理员配置到系统里。"
  ].join("\n");
}

async function buildMonitorCommandMessage(command: string) {
  if (command === "/status") return buildStatusMessage();
  if (command === "/down") return buildDownUrlsMessage();
  if (command === "/expiring") return buildExpiringDomainsMessage();
  if (command === "/icp") return buildIcpIssuesMessage();
  if (command === "/alerts") return buildRecentAlertsMessage();
  return "未知命令";
}

function normalizeMonitorCommand(text: string) {
  const command = text.split(/\s+/)[0].split("@")[0];
  const map: Record<string, string> = {
    "/status": "/status",
    "/down": "/down",
    "/expiring": "/expiring",
    "/icp": "/icp",
    "/alerts": "/alerts",
    "📊 监控概览": "/status",
    "🔴 异常 url": "/down",
    "🟠 到期域名": "/expiring",
    "🟡 备案异常": "/icp",
    "🔔 最近告警": "/alerts"
  };
  return map[text] ?? map[command];
}

async function buildStatusMessage() {
  const settings = await getSettings();
  const [domains, urls, downUrls, expiringDomains, sslIssues, rawIcpIssues, alertsToday] = await Promise.all([
    prisma.domain.count(),
    prisma.urlCheck.count(),
    prisma.urlCheck.count({ where: { lastStatus: "DOWN" } }),
    prisma.domain.count({ where: { expiresAt: { lte: new Date(Date.now() + 30 * 86_400_000), gte: new Date() } } }),
    prisma.urlCheck.count({ where: { sslStatus: { in: ["WARNING", "ERROR", "FAIL"] } } }),
    prisma.domain.count({ where: { icpCheckEnabled: true, icpStatus: { in: ["MISSING", "DROPPED", "ERROR"] } } }),
    prisma.alertEvent.count({ where: { createdAt: { gte: new Date(Date.now() - 86_400_000) }, status: { in: ["SENT", "FAILED"] } } })
  ]);
  const icpIssues = settings.icpGlobalEnabled ? rawIcpIssues : 0;

  return [
    "📊 监控概览",
    `域名：${domains}`,
    `URL：${urls}`,
    `异常 URL：${downUrls}`,
    `30 天内到期：${expiringDomains}`,
    `SSL 异常/即将到期：${sslIssues}`,
    `备案异常：${settings.icpGlobalEnabled ? icpIssues : "已关闭"}`,
    `24 小时告警：${alertsToday}`
  ].join("\n");
}

async function buildDownUrlsMessage() {
  const rows = await prisma.urlCheck.findMany({
    where: { lastStatus: "DOWN" },
    include: { domain: true },
    orderBy: { lastFailureAt: "desc" },
    take: 10
  });
  if (!rows.length) return "✅ 当前没有异常 URL";
  return ["🔴 异常 URL", ...rows.map((row) => `${row.domain.name}\n${row.url}\n失败次数：${row.consecutiveFailures}`)].join("\n\n");
}

async function buildExpiringDomainsMessage() {
  const rows = await prisma.domain.findMany({
    where: { expiresAt: { lte: new Date(Date.now() + 30 * 86_400_000), gte: new Date() } },
    orderBy: { expiresAt: "asc" },
    take: 10
  });
  if (!rows.length) return "✅ 30 天内没有即将到期域名";
  return [
    "🟠 即将到期域名",
    ...rows.map((row) => {
      const days = row.expiresAt ? Math.ceil((row.expiresAt.getTime() - Date.now()) / 86_400_000) : "?";
      return `${row.name}：${formatDate(row.expiresAt)}（剩余 ${days} 天）`;
    })
  ].join("\n");
}

async function buildIcpIssuesMessage() {
  const settings = await getSettings();
  if (!settings.icpGlobalEnabled) return "备案检测已关闭";
  const rows = await prisma.domain.findMany({
    where: { icpCheckEnabled: true, icpStatus: { in: ["MISSING", "DROPPED", "ERROR"] } },
    orderBy: { updatedAt: "desc" },
    take: 10
  });
  if (!rows.length) return "✅ 当前没有备案异常";
  return ["🟡 备案异常", ...rows.map((row) => `${row.name}：${icpStatusText(row.icpStatus)}`)].join("\n");
}

async function buildRecentAlertsMessage() {
  const rows = await prisma.alertEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: 10
  });
  if (!rows.length) return "✅ 暂无告警记录";
  return ["🔔 最近告警", ...rows.map((row) => `${formatDateTime(row.createdAt)} ${row.type} ${row.status}\n${row.target ?? ""}`)].join("\n\n");
}

function formatDate(value: Date | null) {
  return value ? value.toISOString().slice(0, 10) : "未知";
}

function formatDateTime(value: Date) {
  return value.toISOString().replace("T", " ").slice(0, 16);
}

function icpStatusText(status: string) {
  return ({ MISSING: "未备案", DROPPED: "备案掉了", ERROR: "查询错误" } as Record<string, string>)[status] ?? status;
}

export async function createAlert(params: {
  type:
    | "URL_DOWN"
    | "URL_RECOVERED"
    | "DOMAIN_EXPIRING"
    | "ICP_DROPPED"
    | "ICP_MISSING"
    | "CHECK_ERROR"
    | "SSL_EXPIRING"
    | "SSL_INVALID"
    | "SSL_RECOVERED";
  dedupeKey: string;
  message: string;
  target?: string;
  cooldownMinutes: number;
  settings: AppSettings;
}) {
  const now = new Date();
  const backoffEnabled = shouldUseBackoff(params.type);
  const existing = await prisma.alertEvent.findFirst({
    where: {
      dedupeKey: params.dedupeKey,
      cooldownUntil: { gt: now },
      status: { in: ["SENT", "SUPPRESSED", "PENDING"] }
    },
    orderBy: { createdAt: "desc" }
  });

  if (existing) {
    return prisma.alertEvent.create({
      data: {
        type: params.type,
        dedupeKey: params.dedupeKey,
        message: params.message,
        target: params.target,
        status: "SUPPRESSED",
        cooldownUntil: existing.cooldownUntil,
        cooldownMinutes: existing.cooldownMinutes,
        repeatCount: existing.repeatCount
      }
    });
  }

  const previous = backoffEnabled
    ? await prisma.alertEvent.findFirst({
        where: {
          dedupeKey: params.dedupeKey,
          status: { in: ["SENT", "SUPPRESSED", "PENDING"] }
        },
        orderBy: { createdAt: "desc" }
      })
    : null;
  const repeatCount = backoffEnabled && previous ? previous.repeatCount + 1 : 0;
  const cooldownMinutes = calculateAlertCooldownMinutes(
    params.cooldownMinutes,
    repeatCount,
    backoffEnabled ? params.settings.alertMaxCooldownMinutes : params.cooldownMinutes
  );
  const cooldownUntil = new Date(now.getTime() + cooldownMinutes * 60_000);
  const event = await prisma.alertEvent.create({
    data: {
      type: params.type,
      dedupeKey: params.dedupeKey,
      message: params.message,
      target: params.target,
      cooldownUntil,
      cooldownMinutes,
      repeatCount
    }
  });

  const sent = await sendTelegram(params.settings, params.message);
  return prisma.alertEvent.update({
    where: { id: event.id },
    data: {
      status: sent.ok ? "SENT" : "FAILED",
      telegramResult: sent.result,
      error: sent.error,
      sentAt: sent.ok ? new Date() : null
    }
  });
}

export async function resetAlertBackoff(dedupeKey: string) {
  return prisma.alertEvent.updateMany({
    where: { dedupeKey },
    data: {
      repeatCount: 0,
      cooldownMinutes: 0,
      cooldownUntil: new Date()
    }
  });
}

export function calculateAlertCooldownMinutes(baseMinutes: number, repeatCount: number, maxMinutes: number) {
  if (baseMinutes <= 0) return 0;
  const multiplier = 2 ** Math.max(0, repeatCount);
  return Math.min(baseMinutes * multiplier, maxMinutes);
}

export async function cleanupAlertEvents() {
  const cutoff = new Date(Date.now() - 86_400_000);
  return prisma.alertEvent.deleteMany({
    where: { createdAt: { lt: cutoff } }
  });
}

function shouldUseBackoff(type: string) {
  return ["URL_DOWN", "SSL_INVALID", "ICP_DROPPED", "ICP_MISSING"].includes(type);
}
