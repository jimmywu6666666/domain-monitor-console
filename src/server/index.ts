import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { z } from "zod";
import { registerAuth, requireAuth } from "./auth.js";
import { queryIcpWithRetry, runExpirationCheck, runIcpCheck, runSslCheck, runUrlCheck } from "./checks.js";
import { getSettings, prisma, updateSettings } from "./db.js";
import { startScheduler } from "./scheduler.js";
import { sendTelegram } from "./telegram.js";

const app = Fastify({ logger: true });
const __dirname = path.dirname(fileURLToPath(import.meta.url));

await app.register(fastifyCookie);
await app.register(fastifyCors, { origin: true, credentials: true });
registerAuth(app);

app.addHook("preHandler", async (request, reply) => {
  if (request.url.startsWith("/api/auth")) return;
  if (request.url.startsWith("/api")) return requireAuth(request, reply);
});

const domainSchema = z.object({
  name: z.string().min(1).transform((value) => value.trim().toLowerCase()),
  note: z.string().optional().nullable(),
  icpNumber: z.string().optional().nullable(),
  expirationCheckEnabled: z.boolean().optional(),
  icpCheckEnabled: z.boolean().optional(),
  expiryReminderDays: z.string().optional().nullable()
});

const urlSchema = z.object({
  url: z.string().url(),
  method: z.enum(["GET", "HEAD"]).default("GET"),
  expectedStatuses: z.string().default("200-399"),
  checkLevel: z.enum(["LEVEL1", "LEVEL2"]).default("LEVEL1"),
  timeoutMs: z.number().int().min(1000).max(60000).default(10000),
  intervalSeconds: z.number().int().min(10).default(10),
  failureThreshold: z.number().int().min(1).max(10).default(1),
  sslCheckEnabled: z.boolean().optional(),
  enabled: z.boolean().default(true)
});

const icpTestSchema = z.object({
  domain: z.string().min(1).transform((value) => value.trim().toLowerCase())
});

app.get("/api/summary", async () => {
  const settings = await getSettings();
  const [domains, urls, activeAlerts, recentResults] = await Promise.all([
    prisma.domain.count(),
    prisma.urlCheck.count(),
    prisma.alertEvent.count({ where: { status: { in: ["SENT", "FAILED"] }, createdAt: { gte: new Date(Date.now() - 86_400_000) } } }),
    prisma.monitorResult.findMany({
      where: settings.icpGlobalEnabled ? { OR: [{ type: { not: "ICP" } }, { domain: { icpCheckEnabled: true } }] } : { type: { not: "ICP" } },
      orderBy: { checkedAt: "desc" },
      take: 12,
      include: { domain: true, urlCheck: true }
    })
  ]);
  const downUrls = await prisma.urlCheck.count({ where: { lastStatus: "DOWN" } });
  const expiringDomains = await prisma.domain.count({
    where: { expiresAt: { lte: new Date(Date.now() + 30 * 86_400_000), gte: new Date() } }
  });
  const sslIssues = await prisma.urlCheck.count({ where: { sslStatus: { in: ["WARNING", "ERROR", "FAIL"] } } });
  const icpIssues = settings.icpGlobalEnabled
    ? await prisma.domain.count({ where: { icpCheckEnabled: true, icpStatus: { in: ["MISSING", "DROPPED", "ERROR"] } } })
    : 0;
  return { domains, urls, downUrls, expiringDomains, sslIssues, icpIssues, activeAlerts, recentResults };
});

app.get("/api/domains", async () => {
  return prisma.domain.findMany({
    orderBy: { createdAt: "desc" },
    include: { urls: { orderBy: { createdAt: "desc" } } }
  });
});

app.post("/api/domains", async (request, reply) => {
  const parsed = domainSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  return prisma.domain.create({ data: parsed.data });
});

app.patch("/api/domains/:id", async (request, reply) => {
  const params = request.params as { id: string };
  const parsed = domainSchema.partial().safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  const data =
    parsed.data.icpCheckEnabled === false
      ? { ...parsed.data, icpStatus: "UNKNOWN", icpNumber: null, lastIcpCheckAt: null }
      : parsed.data;
  return prisma.domain.update({ where: { id: params.id }, data });
});

app.delete("/api/domains/:id", async (request) => {
  const params = request.params as { id: string };
  await prisma.domain.delete({ where: { id: params.id } });
  return { ok: true };
});

app.post("/api/domains/:id/urls", async (request, reply) => {
  const params = request.params as { id: string };
  const parsed = urlSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  const sslCheckEnabled = parsed.data.sslCheckEnabled ?? parsed.data.url.startsWith("https://");
  return prisma.urlCheck.create({
    data: { ...parsed.data, sslCheckEnabled, domainId: params.id, nextCheckAt: new Date() }
  });
});

app.patch("/api/urls/:id", async (request, reply) => {
  const params = request.params as { id: string };
  const parsed = urlSchema.partial().safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  return prisma.urlCheck.update({ where: { id: params.id }, data: parsed.data });
});

app.delete("/api/urls/:id", async (request) => {
  const params = request.params as { id: string };
  await prisma.urlCheck.delete({ where: { id: params.id } });
  return { ok: true };
});

app.post("/api/checks/run", async (request) => {
  const body = request.body as { urlCheckId?: string; domainId?: string; type?: "url" | "ssl" | "expiration" | "icp" | "all" };
  if (body.urlCheckId && body.type === "ssl") return runSslCheck(body.urlCheckId);
  if (body.urlCheckId) return runUrlCheck(body.urlCheckId);
  if (body.domainId && body.type === "expiration") return runExpirationCheck(body.domainId);
  if (body.domainId && body.type === "icp") return runIcpCheck(body.domainId);
  if (body.domainId) return Promise.allSettled([runExpirationCheck(body.domainId), runIcpCheck(body.domainId)]);
  return { error: "缺少检测对象" };
});

app.get("/api/results", async () => {
  const settings = await getSettings();
  const cutoff = new Date(Date.now() - 86_400_000);
  return prisma.monitorResult.findMany({
    where: {
      checkedAt: { gte: cutoff },
      ...(settings.icpGlobalEnabled ? { OR: [{ type: { not: "ICP" } }, { domain: { icpCheckEnabled: true } }] } : { type: { not: "ICP" } })
    },
    orderBy: { checkedAt: "desc" },
    take: 200,
    include: { domain: true, urlCheck: true }
  });
});

app.get("/api/alerts", async () => {
  return prisma.alertEvent.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 86_400_000) } },
    orderBy: { createdAt: "desc" },
    take: 200
  });
});

app.get("/api/settings", async () => getSettings());

app.patch("/api/settings", async (request) => {
  return updateSettings(request.body as Record<string, unknown>);
});

app.post("/api/settings/test-telegram", async () => {
  const settings = await getSettings();
  return sendTelegram(settings, "✅ 监控控制台 Telegram 测试消息发送成功");
});

app.post("/api/settings/test-icp", async (request, reply) => {
  const parsed = icpTestSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  return queryIcpWithRetry(parsed.data.domain);
});

const clientDir = path.resolve(__dirname, "../client");
await app.register(fastifyStatic, { root: clientDir, prefix: "/" });
app.setNotFoundHandler(async (request, reply) => {
  if (request.url.startsWith("/api")) return reply.code(404).send({ error: "Not found" });
  return reply.sendFile("index.html");
});

const port = Number(process.env.PORT ?? 3000);
startScheduler();
await app.listen({ port, host: "0.0.0.0" });
