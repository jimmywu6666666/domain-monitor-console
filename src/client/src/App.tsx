import { AlertTriangle, Bell, CheckCircle2, Globe2, History, LogOut, Pencil, Play, Plus, RefreshCw, Save, Search, Settings, ShieldCheck, Trash2, XCircle } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Domain = {
  id: string;
  name: string;
  note?: string | null;
  icpNumber?: string | null;
  icpStatus: string;
  expiresAt?: string | null;
  expirationCheckEnabled: boolean;
  icpCheckEnabled: boolean;
  expiryReminderDays?: string | null;
  urls: UrlCheck[];
};

type UrlCheck = {
  id: string;
  domainId: string;
  url: string;
  method: "GET" | "HEAD";
  expectedStatuses: string;
  checkLevel: "LEVEL1" | "LEVEL2";
  timeoutMs: number;
  intervalSeconds: number;
  failureThreshold: number;
  enabled: boolean;
  consecutiveFailures: number;
  lastStatus: string;
  sslCheckEnabled: boolean;
  sslStatus: string;
  sslExpiresAt?: string | null;
  sslIssuer?: string | null;
  sslSubject?: string | null;
  lastSslCheckAt?: string | null;
  lastCheckedAt?: string | null;
};

type SettingsState = {
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

type Page = "dashboard" | "domains" | "results" | "alerts" | "settings";

const apiBase = window.location.pathname.startsWith("/jk") ? "/jk" : "";
const pageStorageKey = "monitor-console-page";
const pages: Page[] = ["dashboard", "domains", "results", "alerts", "settings"];

function readSavedPage(): Page {
  const saved = window.localStorage.getItem(pageStorageKey);
  return pages.includes(saved as Page) ? (saved as Page) : "dashboard";
}

const api = async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    credentials: "include"
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
};

function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [page, setPageState] = useState<Page>(readSavedPage);

  function setPage(page: Page) {
    window.localStorage.setItem(pageStorageKey, page);
    setPageState(page);
  }

  useEffect(() => {
    api<{ authenticated: boolean }>("/api/auth/me")
      .then((result) => setAuthed(result.authenticated))
      .catch(() => setAuthed(false));
  }, []);

  if (authed === null) return <div className="boot">加载控制台...</div>;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return <Console page={page} setPage={setPage} onLogout={() => setAuthed(false)} />;
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) });
      onDone();
    } catch {
      setError("登录失败，请检查密码");
    }
  }

  return (
    <main className="login-shell">
      <form className="login-panel" onSubmit={submit}>
        <div className="brand-mark"><ShieldCheck size={26} /></div>
        <h1>网址检测控制台</h1>
        <p>登录后管理域名、网址可用性、到期和备案告警。</p>
        <label>
          管理员密码
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus />
        </label>
        {error && <div className="form-error">{error}</div>}
        <button className="primary" type="submit">登录</button>
      </form>
    </main>
  );
}

function Console({ page, setPage, onLogout }: { page: Page; setPage: (page: Page) => void; onLogout: () => void }) {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [results, setResults] = useState<any[]>([]);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [query, setQuery] = useState("");

  const refresh = async () => {
    const [domainRows, summaryData, resultRows, alertRows, settingsData] = await Promise.all([
      api<Domain[]>("/api/domains"),
      api("/api/summary"),
      api<any[]>("/api/results"),
      api<any[]>("/api/alerts"),
      api<SettingsState>("/api/settings")
    ]);
    setDomains(domainRows);
    setSummary(summaryData);
    setResults(resultRows);
    setAlerts(alertRows);
    setSettings(settingsData);
  };

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 30000);
    return () => clearInterval(timer);
  }, []);

  const filteredDomains = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return domains;
    return domains.filter((domain) => domain.name.includes(needle) || domain.urls.some((url) => url.url.toLowerCase().includes(needle)));
  }, [domains, query]);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    onLogout();
  }

  return (
    <main className="app-shell">
      <aside>
        <div className="side-title"><Globe2 size={22} /> 监控控制台</div>
        <NavButton active={page === "dashboard"} icon={<ShieldCheck />} label="概览" onClick={() => setPage("dashboard")} />
        <NavButton active={page === "domains"} icon={<Globe2 />} label="域名与网址" onClick={() => setPage("domains")} />
        <NavButton active={page === "results"} icon={<History />} label="检测历史" onClick={() => setPage("results")} />
        <NavButton active={page === "alerts"} icon={<Bell />} label="告警历史" onClick={() => setPage("alerts")} />
        <NavButton active={page === "settings"} icon={<Settings />} label="系统设置" onClick={() => setPage("settings")} />
        <button className="side-logout" onClick={logout}><LogOut size={18} />退出</button>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <h1>{pageTitle(page)}</h1>
            <p>网址可用性、域名到期、ICP备案状态统一巡检。</p>
          </div>
          <div className="top-actions">
            <label className="search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索域名或 URL" /></label>
            <button className="ghost" onClick={refresh}><RefreshCw size={16} />刷新</button>
          </div>
        </header>

        {page === "dashboard" && <Dashboard summary={summary} domains={domains} />}
        {page === "domains" && <DomainManager domains={filteredDomains} settings={settings} onRefresh={refresh} />}
        {page === "results" && <ResultTable rows={results} />}
        {page === "alerts" && <AlertTable rows={alerts} />}
        {page === "settings" && settings && <SettingsPanel settings={settings} onRefresh={refresh} />}
      </section>
    </main>
  );
}

function Dashboard({ summary, domains }: { summary: any; domains: Domain[] }) {
  const flatUrls = domains.flatMap((domain) => domain.urls.map((url) => ({ ...url, domainName: domain.name })));
  return (
    <div className="stack">
      <div className="metric-grid">
        <Metric label="域名" value={summary?.domains ?? 0} tone="blue" />
        <Metric label="网址" value={summary?.urls ?? 0} tone="green" />
        <Metric label="不可用 URL" value={summary?.downUrls ?? 0} tone="red" />
        <Metric label="30 天内到期" value={summary?.expiringDomains ?? 0} tone="orange" />
        <Metric label="SSL 异常/即将到期" value={summary?.sslIssues ?? 0} tone="orange" />
        <Metric label="备案异常" value={summary?.icpIssues ?? 0} tone="yellow" />
      </div>
      <section className="panel">
        <h2>重点状态</h2>
        <div className="status-list">
          {flatUrls.slice(0, 8).map((url) => (
            <div className="status-row" key={url.id}>
              <StatusPill value={url.enabled ? url.lastStatus : "PAUSED"} />
              <div><strong>{url.domainName}</strong><span>{url.url}</span></div>
              <span>{url.lastCheckedAt ? formatDate(url.lastCheckedAt) : "未检测"}</span>
            </div>
          ))}
          {!flatUrls.length && <Empty text="还没有添加监控网址" />}
        </div>
      </section>
    </div>
  );
}

function DomainManager({ domains, settings, onRefresh }: { domains: Domain[]; settings: SettingsState | null; onRefresh: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [editingDomain, setEditingDomain] = useState<Domain | null>(null);
  const [editingUrl, setEditingUrl] = useState<UrlCheck | null>(null);
  const [addingUrlDomain, setAddingUrlDomain] = useState<Domain | null>(null);

  async function addDomain(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const domain = await api<Domain>("/api/domains", {
      method: "POST",
      body: JSON.stringify({
        name: form.get("name"),
        note: form.get("note"),
        icpCheckEnabled: form.get("icpCheckEnabled") === "on",
        expiryReminderDays: form.get("expiryReminderDays")
      })
    });
    const url = String(form.get("url") ?? "");
    if (url) {
      await api(`/api/domains/${domain.id}/urls`, {
        method: "POST",
        body: JSON.stringify({
          url,
          checkLevel: form.get("checkLevel"),
          intervalSeconds: Number(form.get("intervalSeconds") || settings?.defaultUrlIntervalSeconds || 10),
          failureThreshold: Number(form.get("failureThreshold") || settings?.defaultFailureThreshold || 1),
          expectedStatuses: form.get("expectedStatuses") || settings?.defaultExpectedStatuses || "200-399",
          sslCheckEnabled: form.get("sslCheckEnabled") === "on"
        })
      });
    }
    setOpen(false);
    await onRefresh();
  }

  async function deleteDomain(id: string) {
    if (!confirm("确认删除这个域名及其所有 URL？")) return;
    await api(`/api/domains/${id}`, { method: "DELETE" });
    await onRefresh();
  }

  async function toggleDomainIcp(domain: Domain) {
    await api(`/api/domains/${domain.id}`, {
      method: "PATCH",
      body: JSON.stringify({ icpCheckEnabled: !domain.icpCheckEnabled })
    });
    await onRefresh();
  }

  async function saveDomain(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingDomain) return;
    const form = new FormData(event.currentTarget);
    await api(`/api/domains/${editingDomain.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: form.get("name"),
        note: form.get("note"),
        expirationCheckEnabled: form.get("expirationCheckEnabled") === "on",
        icpCheckEnabled: form.get("icpCheckEnabled") === "on",
        expiryReminderDays: form.get("expiryReminderDays")
      })
    });
    setEditingDomain(null);
    await onRefresh();
  }

  async function addUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!addingUrlDomain) return;
    const form = new FormData(event.currentTarget);
    await api(`/api/domains/${addingUrlDomain.id}/urls`, {
      method: "POST",
      body: JSON.stringify({
        url: form.get("url"),
        method: form.get("method"),
        expectedStatuses: form.get("expectedStatuses"),
        checkLevel: form.get("checkLevel"),
        intervalSeconds: Number(form.get("intervalSeconds")),
        failureThreshold: Number(form.get("failureThreshold")),
        enabled: form.get("enabled") === "on",
        sslCheckEnabled: form.get("sslCheckEnabled") === "on"
      })
    });
    setAddingUrlDomain(null);
    await onRefresh();
  }

  async function saveUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingUrl) return;
    const form = new FormData(event.currentTarget);
    await api(`/api/urls/${editingUrl.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        url: form.get("url"),
        method: form.get("method"),
        expectedStatuses: form.get("expectedStatuses"),
        checkLevel: form.get("checkLevel"),
        intervalSeconds: Number(form.get("intervalSeconds")),
        failureThreshold: Number(form.get("failureThreshold")),
        enabled: form.get("enabled") === "on",
        sslCheckEnabled: form.get("sslCheckEnabled") === "on"
      })
    });
    setEditingUrl(null);
    await onRefresh();
  }

  async function deleteUrl(id: string) {
    if (!confirm("确认删除这个 URL？")) return;
    await api(`/api/urls/${id}`, { method: "DELETE" });
    await onRefresh();
  }

  async function run(type: "url" | "ssl" | "expiration" | "icp", id: string) {
    await api("/api/checks/run", { method: "POST", body: JSON.stringify(type === "url" || type === "ssl" ? { urlCheckId: id, type } : { domainId: id, type }) });
    await onRefresh();
  }

  return (
    <div className="stack">
      <div className="section-actions"><button className="primary" onClick={() => setOpen(true)}><Plus size={16} />添加域名</button></div>
      <section className="panel table-panel">
        <table className="domain-table">
          <thead><tr><th>监控对象</th><th>域名状态</th><th>操作</th></tr></thead>
          <tbody>
            {domains.map((domain) => (
              <tr key={domain.id}>
                <td className="domain-cell">
                  <div className="domain-heading">
                    <div>
                      <strong>{domain.name}</strong>
                      <span>{domain.note || "无备注"}</span>
                    </div>
                    <div className="domain-count">URL {domain.urls.length}</div>
                  </div>
                  <div className="url-list">
                    {domain.urls.map((url) => (
                      <div className="url-item" key={url.id}>
                        <div className="url-main">
                          <div className="url-main-head">
                            <code>{url.url}</code>
                            <div className="url-inline-actions">
                              <button title="编辑 URL" onClick={() => setEditingUrl(url)}><Pencil size={14} /></button>
                              <button title="删除 URL" onClick={() => deleteUrl(url.id)}><Trash2 size={14} /></button>
                            </div>
                          </div>
                          <span>{checkLevelText(url.checkLevel)} · {url.lastCheckedAt ? `最近检测：${formatDate(url.lastCheckedAt)}` : "尚未检测"}</span>
                        </div>
                        <div className="url-health">
                          <div>
                            <span>URL</span>
                            <StatusPill value={url.enabled ? url.lastStatus : "PAUSED"} />
                          </div>
                          <button title="立即检测 URL" onClick={() => run("url", url.id)}><Play size={14} /></button>
                        </div>
                        <div className="url-ssl">
                          <div>
                            <span>SSL</span>
                            <StatusPill value={url.sslCheckEnabled ? url.sslStatus : "PAUSED"} />
                          </div>
                          <span className="ssl-date">{url.sslExpiresAt ? `到期：${formatDate(url.sslExpiresAt)}` : "未检测"}</span>
                          <button title="检测 SSL" onClick={() => run("ssl", url.id)}><ShieldCheck size={14} /></button>
                        </div>
                      </div>
                    ))}
                    {!domain.urls.length && (
                      <div className="url-empty">还没有添加 URL</div>
                    )}
                    <button className="url-add-button" onClick={() => setAddingUrlDomain(domain)}><Plus size={14} />添加 URL</button>
                  </div>
                </td>
                <td className="domain-status-cell">
                  <div className="status-stack">
                    <div><span>URL</span><strong>异常 {domain.urls.filter((url) => url.lastStatus === "DOWN").length} / 共 {domain.urls.length}</strong></div>
                    <div><span>域名到期</span><strong>{domain.expiresAt ? formatDate(domain.expiresAt) : "未知"}</strong></div>
                    <div>
                      <span>备案</span>
                      <div className="status-inline">
                        <StatusPill value={settings?.icpGlobalEnabled === false || !domain.icpCheckEnabled ? "PAUSED" : domain.icpStatus} />
                        <label className="mini-switch">
                          <input type="checkbox" checked={domain.icpCheckEnabled} onChange={() => toggleDomainIcp(domain)} disabled={settings?.icpGlobalEnabled === false} />
                          <span>{domain.icpCheckEnabled ? "检测" : "不检测"}</span>
                        </label>
                      </div>
                    </div>
                  </div>
                </td>
                <td className="row-actions domain-actions">
                  <button title="添加 URL" onClick={() => setAddingUrlDomain(domain)}><Plus size={15} /></button>
                  <button title="编辑域名" onClick={() => setEditingDomain(domain)}><Pencil size={15} /></button>
                  <button title="检测到期" onClick={() => run("expiration", domain.id)}><RefreshCw size={15} /></button>
                  <button title="检测备案" onClick={() => run("icp", domain.id)} disabled={settings?.icpGlobalEnabled === false || !domain.icpCheckEnabled}><ShieldCheck size={15} /></button>
                  <button title="删除域名" onClick={() => deleteDomain(domain.id)}><Trash2 size={15} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!domains.length && <Empty text="还没有域名，先添加一个监控对象" />}
      </section>
      {open && (
        <div className="drawer">
          <form onSubmit={addDomain}>
            <h2>添加域名</h2>
            <label>域名<input name="name" placeholder="example.com" required /></label>
            <label>首个检测 URL<input name="url" placeholder="https://example.com" /></label>
            <label>备注<input name="note" placeholder="业务系统、负责人等" /></label>
            <div className="form-grid">
              <label>检测间隔（秒）<input name="intervalSeconds" type="number" min={10} defaultValue={settings?.defaultUrlIntervalSeconds ?? 10} /></label>
              <label>失败阈值<input name="failureThreshold" type="number" min={1} defaultValue={settings?.defaultFailureThreshold ?? 1} /></label>
              <label>期望状态码<input name="expectedStatuses" defaultValue={settings?.defaultExpectedStatuses ?? "200-399"} /></label>
              <label>检测方案
                <select name="checkLevel" defaultValue="LEVEL1">
                  <option value="LEVEL1">一级检测（10 秒 × 3）</option>
                  <option value="LEVEL2">二级检测（30 秒 × 3）</option>
                </select>
              </label>
              <label className="check-setting"><input type="checkbox" name="sslCheckEnabled" defaultChecked />开启 SSL 检测</label>
              <label className="check-setting"><input type="checkbox" name="icpCheckEnabled" defaultChecked />开启备案检测</label>
            </div>
            <label>到期提醒天数<input name="expiryReminderDays" placeholder="30,7,1" /></label>
            <div className="drawer-actions">
              <button type="button" className="ghost" onClick={() => setOpen(false)}>取消</button>
              <button className="primary" type="submit"><Save size={16} />保存</button>
            </div>
          </form>
        </div>
      )}
      {editingDomain && (
        <div className="drawer">
          <form onSubmit={saveDomain}>
            <h2>编辑域名</h2>
            <label>域名<input name="name" defaultValue={editingDomain.name} required /></label>
            <label>备注<input name="note" defaultValue={editingDomain.note ?? ""} /></label>
            <div className="form-grid">
              <label className="check-setting"><input type="checkbox" name="expirationCheckEnabled" defaultChecked={editingDomain.expirationCheckEnabled} />开启域名到期检测</label>
              <label className="check-setting"><input type="checkbox" name="icpCheckEnabled" defaultChecked={editingDomain.icpCheckEnabled} />开启备案检测</label>
            </div>
            <label>到期提醒天数<input name="expiryReminderDays" defaultValue={editingDomain.expiryReminderDays ?? ""} placeholder="留空使用全局设置" /></label>
            <div className="drawer-actions">
              <button type="button" className="ghost" onClick={() => setEditingDomain(null)}>取消</button>
              <button className="primary" type="submit"><Save size={16} />保存</button>
            </div>
          </form>
        </div>
      )}
      {addingUrlDomain && (
        <div className="drawer">
          <form onSubmit={addUrl}>
            <h2>添加 URL</h2>
            <p>{addingUrlDomain.name}</p>
            <label>URL<input name="url" placeholder="https://example.com" required /></label>
            <div className="form-grid">
              <label>请求方法
                <select name="method" defaultValue="GET">
                  <option value="GET">GET</option>
                  <option value="HEAD">HEAD</option>
                </select>
              </label>
              <label>期望状态码<input name="expectedStatuses" defaultValue={settings?.defaultExpectedStatuses ?? "200-399"} /></label>
              <label>检测方案
                <select name="checkLevel" defaultValue="LEVEL1">
                  <option value="LEVEL1">一级检测（10 秒 × 3）</option>
                  <option value="LEVEL2">二级检测（30 秒 × 3）</option>
                </select>
              </label>
              <label>检测间隔（秒）<input name="intervalSeconds" type="number" min={10} defaultValue={settings?.defaultUrlIntervalSeconds ?? 10} /></label>
              <label>失败阈值<input name="failureThreshold" type="number" min={1} max={10} defaultValue={settings?.defaultFailureThreshold ?? 1} /></label>
              <label className="check-setting"><input type="checkbox" name="enabled" defaultChecked />开启 URL 检测</label>
              <label className="check-setting"><input type="checkbox" name="sslCheckEnabled" defaultChecked />开启 SSL 检测</label>
            </div>
            <div className="drawer-actions">
              <button type="button" className="ghost" onClick={() => setAddingUrlDomain(null)}>取消</button>
              <button className="primary" type="submit"><Save size={16} />保存</button>
            </div>
          </form>
        </div>
      )}
      {editingUrl && (
        <div className="drawer">
          <form onSubmit={saveUrl}>
            <h2>编辑 URL</h2>
            <label>URL<input name="url" defaultValue={editingUrl.url} required /></label>
            <div className="form-grid">
              <label>请求方法
                <select name="method" defaultValue={editingUrl.method}>
                  <option value="GET">GET</option>
                  <option value="HEAD">HEAD</option>
                </select>
              </label>
              <label>期望状态码<input name="expectedStatuses" defaultValue={editingUrl.expectedStatuses} /></label>
              <label>检测方案
                <select name="checkLevel" defaultValue={editingUrl.checkLevel ?? "LEVEL1"}>
                  <option value="LEVEL1">一级检测（10 秒 × 3）</option>
                  <option value="LEVEL2">二级检测（30 秒 × 3）</option>
                </select>
              </label>
              <label>检测间隔（秒）<input name="intervalSeconds" type="number" min={10} defaultValue={editingUrl.intervalSeconds} /></label>
              <label>失败阈值<input name="failureThreshold" type="number" min={1} max={10} defaultValue={editingUrl.failureThreshold} /></label>
              <label className="check-setting"><input type="checkbox" name="enabled" defaultChecked={editingUrl.enabled} />开启 URL 检测</label>
              <label className="check-setting"><input type="checkbox" name="sslCheckEnabled" defaultChecked={editingUrl.sslCheckEnabled} />开启 SSL 检测</label>
            </div>
            <div className="drawer-actions">
              <button type="button" className="ghost" onClick={() => setEditingUrl(null)}>取消</button>
              <button className="primary" type="submit"><Save size={16} />保存</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function SettingsPanel({ settings, onRefresh }: { settings: SettingsState; onRefresh: () => Promise<void> }) {
  const [icpTestDomain, setIcpTestDomain] = useState("");
  const [icpTestResult, setIcpTestResult] = useState<any>(null);
  const [icpTesting, setIcpTesting] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({
        telegramBotToken: form.get("telegramBotToken"),
        telegramChatId: form.get("telegramChatId"),
        defaultUrlIntervalSeconds: Number(form.get("defaultUrlIntervalSeconds")),
        defaultFailureThreshold: Number(form.get("defaultFailureThreshold")),
        defaultExpectedStatuses: form.get("defaultExpectedStatuses"),
        expiryReminderDays: String(form.get("expiryReminderDays")).split(",").map(Number).filter(Boolean),
        alertCooldownMinutes: Number(form.get("alertCooldownMinutes")),
        alertMaxCooldownMinutes: Number(form.get("alertMaxCooldownMinutes")),
        icpGlobalEnabled: form.get("icpGlobalEnabled") === "on",
        icpQueryBaseUrl: form.get("icpQueryBaseUrl")
      })
    });
    await onRefresh();
    alert("设置已保存");
  }

  async function testIcp() {
    const domain = icpTestDomain.trim();
    if (!domain) return alert("请输入要测试的域名");
    setIcpTesting(true);
    setIcpTestResult(null);
    try {
      const result = await api("/api/settings/test-icp", { method: "POST", body: JSON.stringify({ domain }) });
      setIcpTestResult(result);
    } catch (error) {
      setIcpTestResult({ active: false, summary: "测试失败", error: error instanceof Error ? error.message : String(error) });
    } finally {
      setIcpTesting(false);
    }
  }

  return (
    <form className="panel settings-form" onSubmit={save}>
      <h2>系统设置</h2>
      <div className="form-grid">
        <label>Telegram Bot Token<input name="telegramBotToken" defaultValue={settings.telegramBotToken} /></label>
        <label>Telegram Chat ID（多个用逗号分隔）<input name="telegramChatId" defaultValue={settings.telegramChatId} placeholder="123456789,-100xxxxxxxxxx" /></label>
        <label>URL 默认检测间隔（秒）<input type="number" name="defaultUrlIntervalSeconds" defaultValue={settings.defaultUrlIntervalSeconds} /></label>
        <label>默认失败阈值<input type="number" name="defaultFailureThreshold" defaultValue={settings.defaultFailureThreshold} /></label>
        <label>默认期望状态码<input name="defaultExpectedStatuses" defaultValue={settings.defaultExpectedStatuses} /></label>
        <label>域名到期提醒天数<input name="expiryReminderDays" defaultValue={settings.expiryReminderDays.join(",")} /></label>
        <label>基础告警间隔（分钟）<input type="number" name="alertCooldownMinutes" defaultValue={settings.alertCooldownMinutes} /></label>
        <label>最大告警间隔（分钟）<input type="number" name="alertMaxCooldownMinutes" defaultValue={settings.alertMaxCooldownMinutes} /></label>
        <label className="check-setting"><input type="checkbox" name="icpGlobalEnabled" defaultChecked={settings.icpGlobalEnabled} />开启备案检测</label>
        <label>本地 ICP_Query 地址<input name="icpQueryBaseUrl" defaultValue={settings.icpQueryBaseUrl} placeholder="http://127.0.0.1:16181" /></label>
        <div className="setting-note">备案检测优先使用本地 ICP_Query 服务，每天北京时间 12:00、15:00、18:00 自动执行。</div>
      </div>
      <section className="settings-subpanel">
        <h2>测试备案查询</h2>
        <div className="form-grid">
          <label>测试域名<input value={icpTestDomain} onChange={(event) => setIcpTestDomain(event.target.value)} placeholder="example.com" /></label>
          <div className="setting-note">测试不会开启全局备案检测，不会更新域名状态，也不会发送告警。</div>
        </div>
        <div className="section-actions">
          <button type="button" className="ghost" onClick={testIcp} disabled={icpTesting}>{icpTesting ? "查询中..." : "测试备案查询"}</button>
        </div>
        {icpTestResult && (
          <div className="test-result">
            <strong>{icpTestResult.active ? "查询到备案" : icpTestResult.error ? "查询失败" : "未查询到备案"}</strong>
            <span>{icpTestResult.summary}</span>
            {icpTestResult.icpNumber && <span>备案号：{icpTestResult.icpNumber}</span>}
            {icpTestResult.attempts && <span>尝试次数：{icpTestResult.attempts}</span>}
            {icpTestResult.error && <span>错误：{icpTestResult.error}</span>}
          </div>
        )}
      </section>
      <div className="section-actions">
        <button type="button" className="ghost" onClick={() => api("/api/settings/test-telegram", { method: "POST" }).then(() => alert("测试消息已发送或已记录失败"))}>测试 Telegram</button>
        <button className="primary" type="submit"><Save size={16} />保存设置</button>
      </div>
    </form>
  );
}

function ResultTable({ rows }: { rows: any[] }) {
  const withTargets = rows.map((row) => ({
    ...row,
    target: row.urlCheck?.url ?? row.domain?.name ?? ""
  }));
  return <DataTable rows={withTargets} columns={["type", "status", "target", "summary", "error", "checkedAt"]} />;
}

function AlertTable({ rows }: { rows: any[] }) {
  return <DataTable rows={rows} columns={["type", "status", "target", "message", "createdAt"]} />;
}

function DataTable({ rows, columns }: { rows: any[]; columns: string[] }) {
  return (
    <section className="panel table-panel">
      <table>
        <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>{columns.map((column) => <td key={column}>{String(column.endsWith("At") && row[column] ? formatDate(row[column]) : row[column] ?? "")}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <Empty text="暂无记录" />}
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <section className={`metric ${tone}`}><span>{label}</span><strong>{value}</strong></section>;
}

function NavButton({ active, icon, label, onClick }: { active: boolean; icon: JSX.Element; label: string; onClick: () => void }) {
  return <button className={active ? "active" : ""} onClick={onClick}>{icon}{label}</button>;
}

function StatusPill({ value }: { value: string }) {
  const normalized = value === "UP" || value === "ACTIVE" || value === "OK" ? "ok" : value === "UNKNOWN" ? "unknown" : value === "PAUSED" ? "paused" : "bad";
  const Icon = normalized === "ok" ? CheckCircle2 : normalized === "bad" ? XCircle : AlertTriangle;
  return <span className={`pill ${normalized}`}><Icon size={13} />{statusText(value)}</span>;
}

function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

function pageTitle(page: Page) {
  return ({ dashboard: "概览", domains: "域名与网址", results: "检测历史", alerts: "告警历史", settings: "系统设置" } as Record<Page, string>)[page];
}

function statusText(value: string) {
  return ({ UP: "正常", DOWN: "异常", UNKNOWN: "未知", PAUSED: "暂停", ACTIVE: "已备案", MISSING: "未备案", DROPPED: "掉备", ERROR: "错误", OK: "正常", WARNING: "即将到期", FAIL: "失败" } as Record<string, string>)[value] ?? value;
}

function checkLevelText(value?: string) {
  return value === "LEVEL2" ? "二级检测（30 秒 × 3）" : "一级检测（10 秒 × 3）";
}

function formatDate(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

createRoot(document.getElementById("root")!).render(<App />);
