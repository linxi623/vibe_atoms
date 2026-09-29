"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PreviewPanel from "./preview-panel";

type Project = { id: string; name: string; currentVersionId: string | null; updatedAt: string };
type Message = { id: string; role: "user" | "assistant"; content: string; taskId: string | null; createdAt: string };
type Task = {
  id: string; status: "running" | "succeeded" | "failed";
  stage: "planning" | "generating" | "checking" | "saving" | "done";
  plan: { summary: string; requirements: string[]; interactions: string[] } | null;
  errorCode: string | null; errorDetail: string | null; retryOfId: string | null;
  createdAt: string; updatedAt: string;
};
type Version = { id: string; sequence: number; summary: string; restoredFromId: string | null };
type Snapshot = { messages: Message[]; tasks: Task[]; versions: Version[]; project: Project };

class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store", ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error ?? "请求失败", response.status);
  return data as T;
}

const stageNames: Record<Task["stage"], string> = {
  planning: "规划需求", generating: "生成代码", checking: "基础检查",
  saving: "保存版本", done: "已结束",
};
const errorNames: Record<string, string> = {
  MODEL: "模型服务", FORMAT: "生成格式", STORAGE: "保存结果",
  NETWORK: "网络连接", TIMEOUT: "执行超时", CONFLICT: "任务冲突",
};
const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : "请求失败";
const duration = (task: Task, now: number) => {
  const ms = (task.status === "running" ? now : Date.parse(task.updatedAt)) - Date.parse(task.createdAt);
  return `${Math.max(0, ms / 1000).toFixed(1)} 秒`;
};

export default function Home() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const creatingRef = useRef(false);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const pendingRef = useRef<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [submitErrors, setSubmitErrors] = useState<Record<string, string>>({});
  const [refreshKey, setRefreshKey] = useState(0);
  const [view, setView] = useState<"chat" | "preview">("chat");
  const [account, setAccount] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "register" | null>(null);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const endRef = useRef<HTMLDivElement>(null);

  const initialize = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      await api("/api/session", { method: "POST" });
      const [{ projects: items }, identity] = await Promise.all([
        api<{ projects: Project[] }>("/api/projects"),
        api<{ email: string | null }>("/api/auth"),
      ]);
      setAccount(identity.email);
      setProjects(items);
      setSelected((current) => {
        const requested = new URLSearchParams(window.location.search).get("project");
        return [current, requested, items[0]?.id].find((id) => items.some((item) => item.id === id)) ?? null;
      });
    } catch {
      setError("无法连接服务。请检查服务配置后重试。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void initialize(); }, [initialize]);

  const loadProject = useCallback(async (id: string) => {
    const path = `/api/projects/${id}`;
    const [project, messages, tasks, versions] = await Promise.all([
      api<{ project: Project }>(path),
      api<{ messages: Message[] }>(`${path}/messages`),
      api<{ tasks: Task[] }>(`${path}/tasks`),
      api<{ versions: Version[] }>(`${path}/versions`),
    ]);
    return { project: project.project, messages: messages.messages, tasks: tasks.tasks, versions: versions.versions };
  }, []);

  useEffect(() => {
    if (!selected) { setSnapshot(null); return; }
    let live = true;
    const id = selected;
    setSnapshot(null);
    setDetailLoading(true);
    setError("");
    const url = new URL(window.location.href);
    url.searchParams.set("project", id);
    window.history.replaceState(null, "", url);
    const refresh = async () => {
      try {
        const data = await loadProject(id);
        if (!live) return;
        setSnapshot(data);
        setProjects((items) => items.map((item) => item.id === id ? data.project : item));
        setError("");
      } catch (cause) {
        if (live) setError(`读取项目失败：${messageOf(cause)}`);
      } finally {
        if (live) setDetailLoading(false);
      }
    };
    void refresh();
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 1500);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [selected, loadProject, refreshKey]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [snapshot?.messages.length, snapshot?.tasks.length, selected]);

  const active = projects.find((project) => project.id === selected);
  const current = snapshot?.project.id === selected ? snapshot : null;
  const running = current?.tasks.some((task) => task.status === "running") ?? false;
  const locked = !!(selected && (pending[selected] || running));
  const draft = drafts[selected ?? "new"] ?? "";
  const warning = error || submitErrors[selected ?? "new"];

  async function submitAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!authMode || authBusy) return;
    setAuthBusy(true);
    setAuthError("");
    try {
      await api(`/api/auth/${authMode}`, {
        method: "POST", body: JSON.stringify({ email: authEmail, password: authPassword }),
      });
      setAuthMode(null);
      setAuthPassword("");
      setSelected(null);
      setSnapshot(null);
      setProjects([]);
      await initialize();
    } catch (cause) {
      setAuthError(messageOf(cause));
    } finally {
      setAuthBusy(false);
    }
  }

  async function logout() {
    if (busy || authBusy) return;
    setAuthBusy(true);
    setError("");
    try {
      await api("/api/auth", { method: "DELETE" });
      setAccount(null);
      setSelected(null);
      setSnapshot(null);
      setProjects([]);
      await initialize();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setAuthBusy(false);
    }
  }

  async function createProject() {
    const name = window.prompt("项目名称", "未命名项目")?.trim();
    if (!name) return;
    setBusy(true);
    setError("");
    try {
      const { project } = await api<{ project: Project }>("/api/projects", {
        method: "POST", body: JSON.stringify({ name }),
      });
      setProjects((items) => [project, ...items]);
      setSelected(project.id);
      setView("chat");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function renameProject() {
    if (!active) return;
    const name = window.prompt("修改项目名称", active.name)?.trim();
    if (!name || name === active.name) return;
    setBusy(true);
    setError("");
    try {
      const { project } = await api<{ project: Project }>(`/api/projects/${active.id}`, {
        method: "PATCH", body: JSON.stringify({ name }),
      });
      setProjects((items) => items.map((item) => item.id === project.id ? project : item));
      setSnapshot((data) => data?.project.id === project.id ? { ...data, project } : data);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function submit(prompt: string, retryOfId?: string) {
    const text = prompt.trim();
    if (!text || text.length > 8000 || locked || loading || detailLoading ||
        (selected && !current) || (!selected && creatingRef.current)) return;
    let id = selected;
    if (id && pendingRef.current[id]) return;
    setError("");
    setSubmitErrors((items) => ({ ...items, [selected ?? "new"]: "" }));
    try {
      if (!id) {
        creatingRef.current = true;
        setBusy(true);
        const { project } = await api<{ project: Project }>("/api/projects", {
          method: "POST", body: JSON.stringify({ name: text.slice(0, 60) }),
        });
        id = project.id;
        setProjects((items) => [project, ...items]);
        setSelected(id);
      }
      if (pendingRef.current[id]) return;
      const projectId = id;
      pendingRef.current[projectId] = true;
      setPending((items) => ({ ...items, [projectId]: true }));
      if (!retryOfId) setDrafts((items) => ({ ...items, [selected ?? "new"]: "" }));
      await api(`/api/projects/${id}/generate`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ prompt: text, ...(retryOfId ? { retryOfId } : {}) }),
      });
    } catch (cause) {
      // A failed HTTP request may still have committed a task. The next poll is authoritative.
      setSubmitErrors((items) => ({ ...items, [id ?? "new"]: `提交结果：${messageOf(cause)}。请查看任务状态后重试。` }));
    } finally {
      if (id) {
        const projectId = id;
        pendingRef.current[projectId] = false;
        setPending((items) => ({ ...items, [projectId]: false }));
        try {
          const data = await loadProject(projectId);
          setSnapshot((current) => current?.project.id === projectId ? data : current);
          setProjects((items) => items.map((item) => item.id === projectId ? data.project : item));
        } catch { /* Polling will retry; keep the submission warning visible. */ }
      }
      creatingRef.current = false;
      setBusy(false);
    }
  }

  function retry(task: Task) {
    const prompt = snapshot?.messages.find((message) => message.taskId === task.id && message.role === "user")?.content;
    if (prompt) void submit(prompt, task.id);
  }

  return (
    <main className="workspace">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">✳</span><span>vibe atoms</span></div>
        <button className="new-project" onClick={createProject} disabled={loading || busy} aria-label="新建项目">
          <span aria-hidden="true">＋</span> 新建项目
        </button>
        <div className="sidebar-label">项目</div>
        <nav aria-label="项目列表" className="project-list">
          {projects.map((project) => (
            <button key={project.id} className={`project-item ${selected === project.id ? "active" : ""}`}
              aria-label={project.name} aria-current={selected === project.id ? "page" : undefined}
              onClick={() => { setSelected(project.id); setView("chat"); }}>
              <span className="project-glyph" aria-hidden="true">▦</span>
              <span className="project-name">{project.name}</span>
            </button>
          ))}
          {!loading && projects.length === 0 && <p className="sidebar-empty">还没有项目</p>}
        </nav>
        <div className="sidebar-bottom">
          <span className="account-name" title={account ?? "访客工作空间"}>{account ?? "访客工作空间"}</span>
          {account ? <button onClick={() => void logout()} disabled={authBusy} aria-label="退出登录" title="退出登录">退出</button>
            : <button onClick={() => { setAuthMode("login"); setAuthError(""); }} aria-label="登录或注册" title="登录或注册">登录 / 注册</button>}
        </div>
      </aside>

      <section className="main-area">
        <header className="topbar">
          <div className="project-heading">
            <span className="breadcrumb">工作空间 <span>/</span></span>
            <strong>{active?.name ?? "开始创建"}</strong>
            {active && <button className="icon-button" aria-label="重命名项目" title="重命名项目"
              onClick={renameProject} disabled={busy}>✎</button>}
          </div>
          <span className={`status ${running || locked ? "status-running" : ""}`}>
            <span className="status-dot" />{loading || detailLoading ? "读取中" : running || locked ? "生成中" : error ? "需要处理" : "就绪"}
          </span>
        </header>

        {warning && <div className="error-banner" role="alert">{warning}<button onClick={() => {
          setSubmitErrors((items) => ({ ...items, [selected ?? "new"]: "" }));
          if (selected) setRefreshKey((value) => value + 1);
          else void initialize();
        }}>刷新状态</button></div>}
        <div className="mobile-tabs" role="tablist" aria-label="工作区视图">
          <button role="tab" aria-selected={view === "chat"} onClick={() => setView("chat")}>对话</button>
          <button role="tab" aria-selected={view === "preview"} onClick={() => setView("preview")}>结果</button>
        </div>

        <div className="panes">
          <section className={`conversation ${view === "preview" ? "mobile-hidden" : ""}`} aria-label="对话">
            <div className="conversation-stream" aria-live="polite">
              {(!current || (!current.messages.length && !current.tasks.length)) && (
                <div className="conversation-body">
                  <div className="welcome-mark">✳</div>
                  <h1>{active ? active.name : "把想法变成可用的界面"}</h1>
                  <p>{detailLoading ? "正在读取项目..." : "描述你的应用需求，开始生成。"}</p>
                </div>
              )}
              {current?.messages.map((message) => {
                const task = message.role === "user" ? current.tasks.find((item) => item.id === message.taskId) : null;
                return <div className={`turn ${message.role}`} key={message.id}>
                  <div className="turn-meta">{message.role === "user" ? "你" : "规划摘要"} · {new Date(message.createdAt).toLocaleString("zh-CN")}</div>
                  <div className="turn-content">{message.content}</div>
                  {task && <div className={`task-status ${task.status}`} aria-label={`任务状态 ${task.status}`}>
                    <div className="task-heading">
                      <strong>{task.status === "running" ? stageNames[task.stage] : task.status === "succeeded" ? "生成完成" : "生成失败"}</strong>
                      <span>{duration(task, now)}</span>
                    </div>
                    {task.plan && <p>{task.plan.summary}</p>}
                    {task.status === "running" && <span className="task-hint">阶段来自服务端，完成后会自动更新</span>}
                    {task.status === "failed" && <>
                      <p role="alert">{errorNames[task.errorCode ?? ""] ?? "执行"}：{task.errorDetail ?? "任务未完成"}</p>
                      {task.retryOfId && <span className="task-hint">重试自上一失败任务</span>}
                      <button className="retry-action" onClick={() => retry(task)} disabled={locked || busy}>重试此需求</button>
                    </>}
                    {task.retryOfId && task.status !== "failed" && <span className="task-hint">关联重试</span>}
                  </div>}
                </div>;
              })}
              <div ref={endRef} />
            </div>
            <form className="composer" onSubmit={(event) => { event.preventDefault(); void submit(draft); }}>
              <textarea aria-label="应用需求" placeholder={active?.currentVersionId ? "描述下一轮修改..." : "描述你想创建的应用..."}
                value={draft} maxLength={8000} disabled={loading || detailLoading || (!!selected && !current) || locked || busy}
                onChange={(event) => setDrafts((items) => ({ ...items, [selected ?? "new"]: event.target.value }))}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void submit(draft);
                  }
                }} />
              <div className="composer-footer">
                <span>{locked ? "正在生成，请等待当前任务结束" : `${draft.length}/8000`}</span>
                <button aria-label="发送需求" title="发送需求" type="submit"
                  disabled={loading || detailLoading || (!!selected && !current) || locked || busy || !draft.trim()}>↑</button>
              </div>
            </form>
          </section>

          <div className={`result-pane ${view === "chat" ? "mobile-hidden" : ""}`}>
            <PreviewPanel key={selected ?? "new"} projectId={selected}
              currentVersionId={current?.project.currentVersionId ?? null}
              versions={current?.versions ?? []} running={running}
              onRestored={async (id) => {
                const data = await loadProject(id);
                setSnapshot((previous) => previous?.project.id === id ? data : previous);
                setProjects((items) => items.map((item) => item.id === id ? data.project : item));
              }} />
          </div>
        </div>
      </section>
      {authMode && <div className="auth-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget && !authBusy) setAuthMode(null);
      }}>
        <section className="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-title">
          <div className="auth-heading">
            <h2 id="auth-title">{authMode === "login" ? "登录账户" : "注册账户"}</h2>
            <button type="button" aria-label="关闭" title="关闭" onClick={() => setAuthMode(null)} disabled={authBusy}>×</button>
          </div>
          <p>登录后可在其他设备继续访问项目。当前访客项目将保留在账户中。</p>
          <form onSubmit={(event) => void submitAuth(event)}>
            <label htmlFor="auth-email">邮箱</label>
            <input id="auth-email" type="email" autoComplete="email" required maxLength={254}
              value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} autoFocus />
            <label htmlFor="auth-password">密码</label>
            <input id="auth-password" type="password" minLength={12} maxLength={128} required
              autoComplete={authMode === "login" ? "current-password" : "new-password"}
              value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} />
            {authMode === "register" && <span className="auth-hint">至少 12 位字符</span>}
            {authError && <p className="auth-error" role="alert">{authError}</p>}
            <button className="auth-submit" type="submit" disabled={authBusy}>{authBusy ? "处理中..." : authMode === "login" ? "登录" : "创建账户"}</button>
          </form>
          <button className="auth-switch" type="button" disabled={authBusy} onClick={() => {
            setAuthMode(authMode === "login" ? "register" : "login");
            setAuthError("");
          }}>{authMode === "login" ? "没有账户？注册" : "已有账户？登录"}</button>
        </section>
      </div>}
    </main>
  );
}
