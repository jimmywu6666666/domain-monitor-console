import { describe, expect, it } from "vitest";
import { classifyIcpStatus, classifySslStatus, mapIcpQueryServiceResponse, parseSslTarget, parseWhoisExpiration, queryIcpWithRetry, statusMatches } from "../checks.js";
import { defaultSettings, parseDays } from "../db.js";
import { calculateAlertCooldownMinutes, parseTelegramChatIds } from "../telegram.js";

describe("monitoring rules", () => {
  it("matches status ranges and explicit status codes", () => {
    expect(statusMatches(200, "200-399")).toBe(true);
    expect(statusMatches(302, "200-399")).toBe(true);
    expect(statusMatches(404, "200-399,404")).toBe(true);
    expect(statusMatches(500, "200-399,404")).toBe(false);
  });

  it("parses expiration reminder days with fallback", () => {
    expect(parseDays("7,30,1")).toEqual([30, 7, 1]);
    expect(parseDays("bad", [14])).toEqual([14]);
    expect(parseDays(null, [30, 7])).toEqual([30, 7]);
  });

  it("parses comma-separated Telegram chat ids", () => {
    expect(parseTelegramChatIds("123, -100456, ,789 ")).toEqual(["123", "-100456", "789"]);
  });

  it("keeps ICP detection enabled by default", () => {
    expect(defaultSettings.icpGlobalEnabled).toBe(true);
  });

  it("parses .cn WHOIS expiration time", () => {
    const expiresAt = parseWhoisExpiration("Domain Name: example.cn\nExpiration Time: 2027-06-20 15:18:55\n");
    expect(expiresAt?.toISOString()).toBe("2027-06-20T15:18:55.000Z");
  });

  it("parses HTTPS SSL targets and skips HTTP URLs", () => {
    expect(parseSslTarget("https://example.com/path")).toEqual({ host: "example.com", port: 443 });
    expect(parseSslTarget("https://example.com:8443/path")).toEqual({ host: "example.com", port: 8443 });
    expect(parseSslTarget("http://example.com")).toBeNull();
  });

  it("classifies SSL certificates by remaining days", () => {
    expect(classifySslStatus(new Date(Date.now() + 60 * 86_400_000), [30, 7, 1]).status).toBe("OK");
    expect(classifySslStatus(new Date(Date.now() + 5 * 86_400_000), [30, 7, 1]).status).toBe("WARNING");
    expect(classifySslStatus(new Date(Date.now() - 86_400_000), [30, 7, 1]).status).toBe("ERROR");
  });

  it("doubles alert cooldown and caps at max interval", () => {
    expect(calculateAlertCooldownMinutes(120, 0, 720)).toBe(120);
    expect(calculateAlertCooldownMinutes(120, 1, 720)).toBe(240);
    expect(calculateAlertCooldownMinutes(120, 2, 720)).toBe(480);
    expect(calculateAlertCooldownMinutes(120, 3, 720)).toBe(720);
    expect(calculateAlertCooldownMinutes(0, 3, 720)).toBe(0);
  });

  it("maps local ICP_Query service responses", () => {
    expect(mapIcpQueryServiceResponse({
      code: 200,
      params: {
        list: [{ domain: "baidu.com", serviceLicence: "京ICP证030173号", unitName: "北京百度网讯科技有限公司" }]
      }
    }, "baidu.com")).toMatchObject({
      active: true,
      icpNumber: "京ICP证030173号"
    });
    expect(mapIcpQueryServiceResponse({ code: 200, params: { list: [] } }, "missing.example")).toMatchObject({
      active: false,
      explicitMissing: true
    });
    expect(mapIcpQueryServiceResponse({ code: 500, message: "当前访问已被创宇盾拦截" }, "baidu.com")).toMatchObject({
      active: false,
      error: "当前访问已被创宇盾拦截"
    });
  });

  it("classifies ICP failures without treating them as missing", () => {
    expect(classifyIcpStatus("ACTIVE", { active: false, explicitMissing: true, summary: "未查询到" })).toBe("DROPPED");
    expect(classifyIcpStatus("UNKNOWN", { active: false, explicitMissing: true, summary: "未查询到" })).toBe("MISSING");
    expect(classifyIcpStatus("ACTIVE", { active: false, summary: "失败", error: "本地 ICP_Query 失败" })).toBe("ERROR");
  });

  it("retries local ICP_Query three times before returning error", async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await queryIcpWithRetry(
      "example.com",
      async () => {
        calls += 1;
        return { active: false, summary: "失败", error: "网络错误" };
      },
      async (ms) => {
        waits.push(ms);
      }
    );
    expect(calls).toBe(3);
    expect(waits).toEqual([30_000, 120_000]);
    expect(result).toMatchObject({ active: false, attempts: 3, error: "网络错误" });
  });
});
