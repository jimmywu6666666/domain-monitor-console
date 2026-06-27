import net from "node:net";
import tls from "node:tls";
import { prisma, getSettings, parseDays } from "./db.js";
import { historyCutoff } from "./retention.js";
import { createAlert, resetAlertBackoff } from "./telegram.js";

export function statusMatches(statusCode: number, rule: string) {
  return rule.split(",").some((part) => {
    const trimmed = part.trim();
    if (!trimmed) return false;
    if (trimmed.includes("-")) {
      const [start, end] = trimmed.split("-").map(Number);
      return statusCode >= start && statusCode <= end;
    }
    return statusCode === Number(trimmed);
  });
}

type UrlAttemptResult =
  | { ok: true; responseTimeMs: number; statusCode: number; statusText: string; attempt: number }
  | { ok: false; responseTimeMs?: number; statusCode?: number; statusText?: string; error?: string; attempt: number };

type IcpQueryResult = {
  active: boolean;
  explicitMissing?: boolean;
  icpNumber?: string | null;
  summary: string;
  error?: string;
  attempts?: number;
};

function getUrlCheckPlan(checkLevel: string) {
  if (checkLevel === "LEVEL2") {
    return { label: "二级检测", timeoutMs: 30000, retryDelayMs: 30000 };
  }
  if (checkLevel === "LEVEL3") {
    return { label: "三级检测", timeoutMs: 600000, retryDelayMs: 600000 };
  }
  return { label: "一级检测", timeoutMs: 10000, retryDelayMs: 10000 };
}

export function parseSslTarget(rawUrl: string) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:") return null;
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 443
  };
}

export function classifySslStatus(expiresAt: Date | null, reminderDays: number[]) {
  if (!expiresAt) return { status: "ERROR", daysLeft: null as number | null, matchedDay: null as number | null };
  const daysLeft = Math.ceil((expiresAt.getTime() - Date.now()) / 86_400_000);
  if (daysLeft < 0) return { status: "ERROR", daysLeft, matchedDay: 0 };
  const matchedDay = reminderDays.find((day) => daysLeft <= day) ?? null;
  return { status: matchedDay ? "WARNING" : "OK", daysLeft, matchedDay };
}

export async function runUrlCheck(id: string) {
  const settings = await getSettings();
  const check = await prisma.urlCheck.findUnique({ where: { id }, include: { domain: true } });
  if (!check || !check.enabled) return null;

  const plan = getUrlCheckPlan(check.checkLevel);
  const attempts: UrlAttemptResult[] = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await probeUrl(check.url, check.method, plan.timeoutMs, check.expectedStatuses, attempt);
    attempts.push(result);
    if (result.ok) break;
    if (attempt < 3) await delay(plan.retryDelayMs);
  }

  const finalResult = attempts[attempts.length - 1];
  const ok = finalResult.ok;
  const wasDown = check.lastStatus === "DOWN";
  const failures = ok ? 0 : check.consecutiveFailures + 1;

  await prisma.urlCheck.update({
    where: { id: check.id },
    data: {
      consecutiveFailures: failures,
      lastStatus: ok ? "UP" : failures >= check.failureThreshold ? "DOWN" : check.lastStatus,
      lastCheckedAt: new Date(),
      lastSuccessAt: ok ? new Date() : check.lastSuccessAt,
      lastFailureAt: ok ? check.lastFailureAt : new Date(),
      nextCheckAt: new Date(Date.now() + check.intervalSeconds * 1000)
    }
  });

  if (!ok) {
    await prisma.monitorResult.create({
      data: {
        type: "URL",
        status: finalResult.statusCode ? "FAIL" : "ERROR",
        responseTimeMs: finalResult.responseTimeMs,
        statusCode: finalResult.statusCode,
        error: finalResult.error,
        summary: `${plan.label}连续 ${attempts.length} 次探测失败${finalResult.statusCode ? `，最后状态码 ${finalResult.statusCode}` : ""}`,
        domainId: check.domainId,
        urlCheckId: check.id
      }
    });
  } else if (wasDown) {
    await prisma.monitorResult.create({
      data: {
        type: "URL",
        status: "OK",
        responseTimeMs: finalResult.responseTimeMs,
        statusCode: finalResult.statusCode,
        summary: `URL 已恢复：${finalResult.statusCode} ${finalResult.statusText}`,
        domainId: check.domainId,
        urlCheckId: check.id
      }
    });
  }

  if (!ok && failures >= check.failureThreshold) {
    await createAlert({
      type: "URL_DOWN",
      dedupeKey: `url-down:${check.id}`,
      target: check.url,
      cooldownMinutes: settings.alertCooldownMinutes,
      settings,
      message: `🔴 URL 不可用\n域名：${check.domain.name}\n地址：${check.url}\n方案：${plan.label}\n结果：连续 ${attempts.length} 次探测失败（间隔 ${plan.retryDelayMs / 1000} 秒）\n最后错误：${finalResult.error ?? finalResult.statusCode ?? "未知"}`
    });
  } else if (ok && wasDown) {
    await resetAlertBackoff(`url-down:${check.id}`);
    await createAlert({
      type: "URL_RECOVERED",
      dedupeKey: `url-recovered:${check.id}:${Date.now()}`,
      target: check.url,
      cooldownMinutes: 0,
      settings,
      message: `🟢 URL 已恢复\n域名：${check.domain.name}\n地址：${check.url}\n响应：${finalResult.statusCode}，${finalResult.responseTimeMs}ms`
    });
  }

  return ok
    ? { ok, responseTimeMs: finalResult.responseTimeMs, statusCode: finalResult.statusCode, attempts: attempts.length }
    : { ok, error: finalResult.error, statusCode: finalResult.statusCode, attempts: attempts.length };
}

export async function runSslCheck(id: string) {
  const settings = await getSettings();
  const check = await prisma.urlCheck.findUnique({ where: { id }, include: { domain: true } });
  if (!check || !check.enabled || !check.sslCheckEnabled) return null;

  const target = parseSslTarget(check.url);
  if (!target) {
    await prisma.urlCheck.update({
      where: { id: check.id },
      data: { sslStatus: "PAUSED", lastSslCheckAt: new Date() }
    });
    return { skipped: true, reason: "非 HTTPS URL" };
  }

  const previousStatus = check.sslStatus;
  try {
    const certificate = await fetchSslCertificate(target.host, target.port);
    const expiresAt = certificate.valid_to ? new Date(certificate.valid_to) : null;
    const reminderDays = parseDays(check.domain.expiryReminderDays, settings.expiryReminderDays);
    const { status, daysLeft, matchedDay } = classifySslStatus(expiresAt, reminderDays);
    const issuer = normalizeCertificateName(certificate.issuer?.O ?? certificate.issuer?.CN);
    const subject = normalizeCertificateName(certificate.subject?.CN);

    await prisma.urlCheck.update({
      where: { id: check.id },
      data: {
        sslStatus: status,
        sslExpiresAt: expiresAt,
        sslIssuer: issuer,
        sslSubject: subject,
        lastSslCheckAt: new Date()
      }
    });

    await prisma.monitorResult.create({
      data: {
        type: "SSL",
        status,
        summary: expiresAt ? `证书剩余 ${daysLeft} 天` : "无法读取证书到期时间",
        error: status === "ERROR" && expiresAt ? "证书已过期" : null,
        domainId: check.domainId,
        urlCheckId: check.id
      }
    });

    if (status === "WARNING" && matchedDay) {
      await createAlert({
        type: "SSL_EXPIRING",
        dedupeKey: `ssl-expiring:${check.id}:${matchedDay}`,
        target: check.url,
        cooldownMinutes: 60 * 24,
        settings,
        message: `🟠 SSL 证书即将到期\n域名：${check.domain.name}\n地址：${check.url}\n到期时间：${expiresAt?.toISOString().slice(0, 10)}\n剩余：${daysLeft} 天`
      });
    } else if (status === "ERROR") {
      await createAlert({
        type: "SSL_INVALID",
        dedupeKey: `ssl-invalid:${check.id}`,
        target: check.url,
        cooldownMinutes: settings.alertCooldownMinutes,
        settings,
        message: `🔴 SSL 证书异常\n域名：${check.domain.name}\n地址：${check.url}\n状态：${expiresAt ? "证书已过期" : "无法读取证书"}`
      });
    } else if (status === "OK" && previousStatus === "ERROR") {
      await resetAlertBackoff(`ssl-invalid:${check.id}`);
      await createAlert({
        type: "SSL_RECOVERED",
        dedupeKey: `ssl-recovered:${check.id}:${Date.now()}`,
        target: check.url,
        cooldownMinutes: 0,
        settings,
        message: `🟢 SSL 证书已恢复\n域名：${check.domain.name}\n地址：${check.url}\n到期时间：${expiresAt?.toISOString().slice(0, 10)}`
      });
    }

    return { status, expiresAt, daysLeft, issuer, subject };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.urlCheck.update({
      where: { id: check.id },
      data: { sslStatus: "ERROR", lastSslCheckAt: new Date() }
    });
    await prisma.monitorResult.create({
      data: {
        type: "SSL",
        status: "ERROR",
        summary: "SSL 检测失败",
        error: message,
        domainId: check.domainId,
        urlCheckId: check.id
      }
    });
    await createAlert({
      type: "SSL_INVALID",
      dedupeKey: `ssl-invalid:${check.id}`,
      target: check.url,
      cooldownMinutes: settings.alertCooldownMinutes,
      settings,
      message: `🔴 SSL 证书异常\n域名：${check.domain.name}\n地址：${check.url}\n错误：${message}`
    });
    return { status: "ERROR", error: message };
  }
}

export async function runExpirationCheck(domainId: string) {
  const settings = await getSettings();
  const domain = await prisma.domain.findUnique({ where: { id: domainId } });
  if (!domain || !domain.expirationCheckEnabled) return null;

  const expiresAt = await fetchDomainExpiration(domain.name);
  const reminderDays = parseDays(domain.expiryReminderDays, settings.expiryReminderDays);
  const daysLeft = expiresAt ? Math.ceil((expiresAt.getTime() - Date.now()) / 86_400_000) : null;
  const status = daysLeft !== null && reminderDays.some((day) => daysLeft <= day) ? "WARNING" : "OK";

  await prisma.domain.update({
    where: { id: domain.id },
    data: { expiresAt, lastExpirationCheckAt: new Date() }
  });
  await prisma.monitorResult.create({
    data: {
      type: "EXPIRATION",
      status: expiresAt ? status : "ERROR",
      summary: expiresAt ? `剩余 ${daysLeft} 天` : "无法获取到期时间",
      domainId: domain.id
    }
  });

  if (expiresAt && daysLeft !== null) {
    const matchedDay = reminderDays.find((day) => daysLeft <= day);
    if (matchedDay) {
      await createAlert({
        type: "DOMAIN_EXPIRING",
        dedupeKey: `domain-expiring:${domain.id}:${matchedDay}`,
        target: domain.name,
        cooldownMinutes: 60 * 24,
        settings,
        message: `🟠 域名即将到期\n域名：${domain.name}\n到期时间：${expiresAt.toISOString().slice(0, 10)}\n剩余：${daysLeft} 天`
      });
    }
  }

  return { expiresAt, daysLeft };
}

export async function runIcpCheck(domainId: string) {
  const settings = await getSettings();
  if (!settings.icpGlobalEnabled) return { skipped: true, reason: "备案检测已全局关闭" };
  const domain = await prisma.domain.findUnique({ where: { id: domainId } });
  if (!domain || !domain.icpCheckEnabled) return null;

  const result = await queryIcpWithRetry(domain.name);
  const previous = domain.icpStatus;
  const nextStatus = classifyIcpStatus(previous, result);

  await prisma.domain.update({
    where: { id: domain.id },
    data: {
      icpStatus: nextStatus,
      icpNumber: result.icpNumber ?? domain.icpNumber,
      lastIcpCheckAt: new Date()
    }
  });
  await prisma.monitorResult.create({
    data: {
      type: "ICP",
      status: nextStatus === "ACTIVE" ? "OK" : nextStatus === "ERROR" ? "ERROR" : "FAIL",
      summary: result.summary,
      error: result.error,
      domainId: domain.id
    }
  });

  if (nextStatus === "DROPPED" || nextStatus === "MISSING") {
    await createAlert({
      type: nextStatus === "DROPPED" ? "ICP_DROPPED" : "ICP_MISSING",
      dedupeKey: `icp:${domain.id}:${nextStatus}`,
      target: domain.name,
      cooldownMinutes: settings.alertCooldownMinutes,
      settings,
      message: `🟡 域名备案异常\n域名：${domain.name}\n状态：${nextStatus === "DROPPED" ? "备案掉了" : "未查询到备案"}`
    });
  } else if (nextStatus === "ACTIVE") {
    if (previous === "DROPPED") await resetAlertBackoff(`icp:${domain.id}:DROPPED`);
    if (previous === "MISSING") await resetAlertBackoff(`icp:${domain.id}:MISSING`);
  }

  return result;
}

export async function runDueChecks() {
  const settings = await getSettings();
  const now = new Date();
  const urls = await prisma.urlCheck.findMany({
    where: { enabled: true, OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }] },
    take: 20
  });
  await Promise.allSettled(urls.map((url) => runUrlCheck(url.id)));

  const domains = await prisma.domain.findMany({ take: 50 });
  const sslUrls = await prisma.urlCheck.findMany({
    where: { enabled: true, sslCheckEnabled: true, url: { startsWith: "https://" } },
    take: 50
  });
  const staleDaily = (date: Date | null) => !date || Date.now() - date.getTime() > 86_400_000;
  await Promise.allSettled(sslUrls.filter((url) => staleDaily(url.lastSslCheckAt)).map((url) => runSslCheck(url.id)));
  for (const domain of domains) {
    if (domain.expirationCheckEnabled && staleDaily(domain.lastExpirationCheckAt)) await runExpirationCheck(domain.id);
  }
}

export async function runScheduledIcpChecks() {
  const settings = await getSettings();
  if (!settings.icpGlobalEnabled) return { skipped: true, reason: "备案检测已全局关闭" };
  const domains = await prisma.domain.findMany({ where: { icpCheckEnabled: true }, take: 50 });
  return Promise.allSettled(domains.map((domain) => runIcpCheck(domain.id)));
}

function normalizeCertificateName(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value.join(", ");
  return value ?? null;
}

function fetchSslCertificate(host: string, port: number) {
  return new Promise<tls.PeerCertificate>((resolve, reject) => {
    const socket = tls.connect(
      {
        host,
        port,
        servername: host,
        rejectUnauthorized: false,
        timeout: 10000
      },
      () => {
        const certificate = socket.getPeerCertificate();
        socket.end();
        if (!certificate || Object.keys(certificate).length === 0) {
          reject(new Error("未获取到证书"));
          return;
        }
        resolve(certificate);
      }
    );
    socket.on("timeout", () => {
      socket.destroy(new Error("SSL 连接超时"));
    });
    socket.on("error", reject);
  });
}

export async function cleanupMonitorResults() {
  return prisma.monitorResult.deleteMany({
    where: { checkedAt: { lt: historyCutoff() } }
  });
}

export function parseWhoisExpiration(text: string) {
  const patterns = [
    /Expiration Time:\s*([^\r\n]+)/i,
    /Registry Expiry Date:\s*([^\r\n]+)/i,
    /Registrar Registration Expiration Date:\s*([^\r\n]+)/i,
    /Expiration Date:\s*([^\r\n]+)/i,
    /paid-till:\s*([^\r\n]+)/i,
    /expires:\s*([^\r\n]+)/i
  ];
  for (const pattern of patterns) {
    const value = text.match(pattern)?.[1]?.trim();
    const parsed = value ? parseWhoisDate(value) : null;
    if (parsed && !Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function parseWhoisDate(value: string) {
  const normalized = value.trim().replace(" ", "T");
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  return new Date(hasTimezone ? normalized : `${normalized}Z`);
}

async function fetchDomainExpiration(domain: string) {
  return (await fetchRdapExpiration(domain)) ?? (await fetchWhoisExpiration(domain));
}

async function fetchRdapExpiration(domain: string) {
  try {
    const response = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`);
    if (!response.ok) return null;
    const data = (await response.json()) as { events?: Array<{ eventAction?: string; eventDate?: string }> };
    const expiry = data.events?.find((event) => event.eventAction === "expiration")?.eventDate;
    return expiry ? new Date(expiry) : null;
  } catch {
    return null;
  }
}

async function fetchWhoisExpiration(domain: string) {
  try {
    const server = domain.toLowerCase().endsWith(".cn") ? "whois.cnnic.cn" : await lookupWhoisServer(domain);
    if (!server) return null;
    return parseWhoisExpiration(await queryWhois(server, domain));
  } catch {
    return null;
  }
}

async function lookupWhoisServer(domain: string) {
  const tld = domain.split(".").pop();
  if (!tld) return null;
  const response = await queryWhois("whois.iana.org", tld);
  return response.match(/^whois:\s*(\S+)/im)?.[1] ?? null;
}

function queryWhois(server: string, query: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ host: server, port: 43, timeout: 10000 }, () => {
      socket.write(`${query}\r\n`);
    });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.on("end", () => resolve(data));
    socket.on("timeout", () => {
      socket.destroy(new Error("WHOIS 查询超时"));
    });
    socket.on("error", reject);
  });
}

async function probeUrl(url: string, method: string, timeoutMs: number, expectedStatuses: string, attempt: number): Promise<UrlAttemptResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method, signal: controller.signal, redirect: "manual" });
    const responseTimeMs = Date.now() - started;
    const ok = statusMatches(response.status, expectedStatuses);
    return { ok, responseTimeMs, statusCode: response.status, statusText: response.statusText, attempt };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), attempt };
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function classifyIcpStatus(previousStatus: string, result: IcpQueryResult) {
  if (result.active) return "ACTIVE";
  if (result.error) return "ERROR";
  if (result.explicitMissing) return previousStatus === "ACTIVE" ? "DROPPED" : "MISSING";
  return "ERROR";
}

export async function queryIcpWithRetry(
  domain: string,
  query = queryIcpProvider,
  wait: (ms: number) => Promise<void> = delay,
  retryDelays = [30_000, 120_000]
): Promise<IcpQueryResult> {
  let lastError = "";
  for (let attempt = 1; attempt <= retryDelays.length + 1; attempt += 1) {
    const result = await query(domain);
    if (!result.error) return { ...result, attempts: attempt };
    lastError = result.error;
    if (attempt <= retryDelays.length) await wait(retryDelays[attempt - 1]);
  }
  return {
    active: false,
    summary: "本地 ICP_Query 查询失败，已重试 3 次",
    error: lastError || "本地 ICP_Query 查询失败",
    attempts: retryDelays.length + 1
  };
}

async function queryIcpProvider(domain: string): Promise<IcpQueryResult> {
  const settings = await getSettings();
  return queryLocalIcpQueryService(settings.icpQueryBaseUrl, domain);
}

export async function queryLocalIcpQueryService(baseUrl: string, domain: string): Promise<IcpQueryResult> {
  if (!baseUrl) return { active: false, summary: "本地 ICP_Query 未配置", error: "本地 ICP_Query 未配置" };
  try {
    const url = new URL("/query/web", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    url.searchParams.set("search", domain);
    const response = await fetch(url, { headers: { accept: "application/json" } });
    const data = await response.json() as unknown;
    return mapIcpQueryServiceResponse(data, domain);
  } catch (error) {
    return { active: false, summary: "本地 ICP_Query 查询失败", error: error instanceof Error ? error.message : String(error) };
  }
}

export function mapIcpQueryServiceResponse(data: unknown, domain: string): IcpQueryResult {
  const object = data as Record<string, unknown>;
  if (object?.code !== 200) {
    const message = extractIcpQueryMessage(data) ?? "本地 ICP_Query 查询失败";
    return { active: false, summary: message, error: message };
  }
  const records = findIcpQueryRecords(data);
  const matched = records.find((record) => {
    const value = normalizeUnknownString((record as Record<string, unknown>).domain);
    return value?.toLowerCase() === domain.toLowerCase();
  }) ?? records[0];
  if (matched) {
    const item = matched as Record<string, unknown>;
    const icpNumber = normalizeUnknownString(item.serviceLicence) ?? normalizeUnknownString(item.mainLicence);
    const unitName = normalizeUnknownString(item.unitName);
    return {
      active: true,
      explicitMissing: false,
      icpNumber,
      summary: icpNumber ? `已备案：${icpNumber}${unitName ? `（${unitName}）` : ""}` : "本地 ICP_Query 查询到备案信息"
    };
  }
  return { active: false, explicitMissing: true, summary: "本地 ICP_Query 明确未查询到备案信息" };
}

function findIcpQueryRecords(data: unknown): unknown[] {
  const candidates = [
    data,
    getNestedValue(data, ["params", "list"]),
    getNestedValue(data, ["params", "data"]),
    getNestedValue(data, ["data", "list"]),
    getNestedValue(data, ["data", "records"]),
    getNestedValue(data, ["result", "list"])
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) return candidate;
  }
  return [];
}

function extractIcpQueryMessage(data: unknown) {
  return findStringByKey(data, ["msg", "message", "error", "errorMessage"]);
}

function findStringByKey(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  for (const key of keys) {
    const found = normalizeUnknownString(object[key]);
    if (found) return found;
  }
  for (const nested of Object.values(object)) {
    const found = findStringByKey(nested, keys);
    if (found) return found;
  }
  return null;
}

function getNestedValue(value: unknown, path: string[]) {
  return path.reduce<unknown>((current, key) => (current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined), value);
}

function normalizeUnknownString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
