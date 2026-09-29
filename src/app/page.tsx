"use client";

import { useCallback, useEffect, useState } from "react";

type Project = {
  id: string;
  name: string;
  currentVersionId: string | null;
  updatedAt: string;
};

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "请求失败");
  return data as T;
}

export default function Home() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<"chat" | "preview">("chat");

  const initialize = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      await api("/api/session", { method: "POST" });
      const { projects: items } = await api<{ projects: Project[] }>("/api/projects");
      setProjects(items);
      setSelected((current) => (current && items.some((item) => item.id === current) ? current : items[0]?.id ?? null));
    } catch {
      setError("无法连接数据库。请检查服务配置后重试。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void initialize(); }, [initialize]);

  async function createProject() {
    const name = window.prompt("项目名称", "未命名项目")?.trim();
    if (!name) return;
    setBusy(true);
    setError("");
    try {
      const { project } = await api<{ project: Project }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setProjects((items) => [project, ...items]);
      setSelected(project.id);
      setView("chat");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建失败");
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
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
      setProjects((items) => items.map((item) => item.id === project.id ? project : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "重命名失败");
    } finally {
      setBusy(false);
    }
  }

  const active = projects.find((project) => project.id === selected);

  return (
    <main className="workspace">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">✳</span><span>vibe atoms</span></div>
        <button className="new-project" onClick={createProject} disabled={loading || busy}>
          <span aria-hidden="true">＋</span> 新建项目
        </button>
        <div className="sidebar-label">项目</div>
        <nav aria-label="项目列表" className="project-list">
          {projects.map((project) => (
            <button key={project.id} className={`project-item ${selected === project.id ? "active" : ""}`}
              onClick={() => { setSelected(project.id); setView("chat"); }}>
              <span className="project-glyph" aria-hidden="true">▦</span>
              <span className="project-name">{project.name}</span>
            </button>
          ))}
          {!loading && projects.length === 0 && <p className="sidebar-empty">还没有项目</p>}
        </nav>
        <div className="sidebar-bottom">访客工作空间</div>
      </aside>

      <section className="main-area">
        <header className="topbar">
          <div className="project-heading">
            <span className="breadcrumb">工作空间 <span>/</span></span>
            <strong>{active?.name ?? "开始创建"}</strong>
            {active && <button className="icon-button" aria-label="重命名项目" title="重命名项目"
              onClick={renameProject} disabled={busy}>✎</button>}
          </div>
          <span className="status"><span className="status-dot" />{loading ? "连接中" : error ? "连接失败" : "就绪"}</span>
        </header>

        {error && <div className="error-banner" role="alert">{error}<button onClick={initialize}>重试</button></div>}
        <div className="mobile-tabs" role="tablist" aria-label="工作区视图">
          <button role="tab" aria-selected={view === "chat"} onClick={() => setView("chat")}>对话</button>
          <button role="tab" aria-selected={view === "preview"} onClick={() => setView("preview")}>预览</button>
        </div>

        <div className="panes">
          <section className={`conversation ${view === "preview" ? "mobile-hidden" : ""}`} aria-label="对话">
            <div className="conversation-body">
              <div className="welcome-mark">✳</div>
              <h1>{active ? active.name : "把想法变成可用的界面"}</h1>
              <p>{active ? "项目已创建。生成能力将在下一阶段接入。" : "创建项目，开始整理你的应用想法。"}</p>
              {!active && <button className="primary-action" disabled={loading || busy} onClick={createProject}>创建项目 <span aria-hidden="true">→</span></button>}
            </div>
            <div className="composer">
              <textarea aria-label="应用需求" placeholder="描述你想创建的应用..." disabled />
              <div className="composer-footer">
                <span>生成服务尚未接入</span>
                <button aria-label="发送需求" title="生成服务尚未接入" disabled>↑</button>
              </div>
            </div>
          </section>

          <section className={`preview ${view === "chat" ? "mobile-hidden" : ""}`} aria-label="预览">
            <div className="preview-toolbar">
              <div className="preview-tabs"><span className="selected-tab">预览</span><span className="muted-tab">代码</span></div>
              <span className="version-label">暂无版本</span>
            </div>
            <div className="preview-empty">
              <div className="preview-empty-icon" aria-hidden="true">▧</div>
              <strong>预览区域</strong>
              <p>生成完成后，应用将在这里显示。</p>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
