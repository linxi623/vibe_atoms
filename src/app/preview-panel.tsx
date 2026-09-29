"use client";

import { diffWordsWithSpace } from "diff";
import { useEffect, useMemo, useRef, useState } from "react";

type Version = { id: string; sequence: number; summary: string; restoredFromId: string | null };
type Source = Version & { html: string };

const previewPolicy = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "connect-src 'none'",
  "font-src 'none'",
  "media-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "navigate-to 'none'",
].join("; ");

function previewDocument(html: string) {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${previewPolicy}">`;
  // The first token fixes standards mode; CSP is parsed before any generated markup.
  return `<!doctype html>${policy}${html}`;
}

export default function PreviewPanel({
  projectId, currentVersionId, versions, running, onRestored,
}: {
  projectId: string | null;
  currentVersionId: string | null;
  versions: Version[];
  running: boolean;
  onRestored: (projectId: string) => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(currentVersionId);
  const [source, setSource] = useState<Source | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [comparison, setComparison] = useState<Source | null>(null);
  const [mode, setMode] = useState<"preview" | "code" | "diff">("preview");
  const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const restoreAttempt = useRef<{ target: string; key: string } | null>(null);

  useEffect(() => { setSelectedId(currentVersionId); }, [currentVersionId]);
  useEffect(() => {
    if (!selectedId || versions.length < 2) { setCompareId(null); return; }
    setCompareId((id) => id && id !== selectedId && versions.some((version) => version.id === id)
      ? id : versions.find((version) => version.id !== selectedId)?.id ?? null);
  }, [selectedId, versions]);
  useEffect(() => {
    if (!selectedId || !projectId) return;
    let live = true;
    fetch(`/api/projects/${projectId}/versions/${selectedId}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("源码读取失败");
        return response.json() as Promise<{ version: Source }>;
      })
      .then(({ version }) => {
        if (live && version.id === selectedId) { setSource(version); setError(""); setCopied(false); }
      })
      .catch(() => { if (live) setError("源码读取失败，请重新选择版本。"); });
    return () => { live = false; };
  }, [projectId, selectedId]);
  useEffect(() => {
    if (!compareId || !projectId || mode !== "diff") return;
    let live = true;
    fetch(`/api/projects/${projectId}/versions/${compareId}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("比较版本读取失败");
        return response.json() as Promise<{ version: Source }>;
      })
      .then(({ version }) => { if (live) { setComparison(version); setError(""); } })
      .catch(() => { if (live) setError("比较版本读取失败。"); });
    return () => { live = false; };
  }, [projectId, compareId, mode]);

  const displayed = source?.id === selectedId ? source : null;
  const compared = comparison?.id === compareId ? comparison : null;
  const changes = useMemo(() => displayed && compared
    ? diffWordsWithSpace(compared.html, displayed.html, { timeout: 1000 }) : null, [displayed, compared]);

  async function copy() {
    if (!displayed) return;
    try {
      await navigator.clipboard.writeText(displayed.html);
      setCopied(true);
    } catch {
      setError("复制失败，请在代码视图中手动选择源码。");
    }
  }

  function download() {
    if (!displayed) return;
    const url = URL.createObjectURL(new Blob([displayed.html], { type: "text/html;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `vibe-atoms-v${displayed.sequence}.html`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function restore() {
    if (!projectId || !displayed || displayed.id === currentVersionId || running || restoring) return;
    const target = displayed;
    if (!window.confirm(`将 v${target.sequence} 恢复为新的当前版本？现有版本和后续历史将保留。`)) return;
    const attempt = restoreAttempt.current?.target === target.id
      ? restoreAttempt.current : { target: target.id, key: crypto.randomUUID() };
    restoreAttempt.current = attempt;
    setRestoring(true);
    setError("");
    try {
      const response = await fetch(`/api/projects/${projectId}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.key },
        body: JSON.stringify({ versionId: target.id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "恢复失败");
      setSelectedId(data.versionId);
      await onRestored(projectId);
      restoreAttempt.current = null;
      setMode("preview");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "恢复失败，请重试。");
    } finally {
      setRestoring(false);
    }
  }

  return (
    <section className="preview" aria-label="结果">
      <div className="preview-toolbar">
        <div className="preview-tabs" role="tablist" aria-label="结果视图">
          <button role="tab" aria-selected={mode === "preview"} onClick={() => setMode("preview")}>预览</button>
          <button role="tab" aria-selected={mode === "code"} onClick={() => setMode("code")}>代码</button>
          <button role="tab" aria-selected={mode === "diff"} onClick={() => setMode("diff")} disabled={versions.length < 2}>差异</button>
        </div>
        <div className="preview-actions">
          {versions.length > 0 && <select aria-label="选择版本" value={selectedId ?? ""} onChange={(event) => setSelectedId(event.target.value)}>
            {versions.map((version) => <option key={version.id} value={version.id}>v{version.sequence}{version.id === currentVersionId ? " · 当前" : " · 历史"}{version.restoredFromId ? " · 恢复" : ""}</option>)}
          </select>}
          <button aria-label="桌面视口" title="桌面视口" aria-pressed={viewport === "desktop"} onClick={() => setViewport("desktop")} disabled={!displayed}>▣</button>
          <button aria-label="移动视口" title="移动视口" aria-pressed={viewport === "mobile"} onClick={() => setViewport("mobile")} disabled={!displayed}>▯</button>
          <button aria-label="刷新预览" title="刷新预览" onClick={() => setRefresh((value) => value + 1)} disabled={!displayed || mode !== "preview"}>↻</button>
          <button aria-label="复制源码" title="复制源码" onClick={() => void copy()} disabled={!displayed}>⧉</button>
          <button aria-label="下载 HTML" title="下载 HTML" onClick={download} disabled={!displayed}>↓</button>
        </div>
      </div>
      {displayed ? <>
        <div className="preview-info">
          <strong>{displayed.id === currentVersionId ? "当前版本" : "预览版本"} v{displayed.sequence}{displayed.id !== currentVersionId && " · 历史"}</strong>
          <span>{displayed.summary}</span>
          {displayed.restoredFromId && <span>来源 v{versions.find((item) => item.id === displayed.restoredFromId)?.sequence ?? "?"}</span>}
          {running && <span>新版本生成中，当前展示已保存版本</span>}
          {copied && <span role="status">已复制 v{displayed.sequence} 源码</span>}
          {displayed.id !== currentVersionId && <button className="restore-action" onClick={() => void restore()}
            disabled={running || restoring}>{restoring ? "恢复中..." : `恢复 v${displayed.sequence}`}</button>}
          {error && <span role="alert">{error}</span>}
        </div>
        {mode === "preview" ? <div className={`preview-stage ${viewport}`}>
          <iframe key={`${projectId}:${displayed.id}:${refresh}`} title={`预览版本 v${displayed.sequence}`}
            sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={previewDocument(displayed.html)} />
        </div> : mode === "code" ? <div className="source-stage">
          <pre aria-label={`版本 v${displayed.sequence} 源码`}><code>{displayed.html}</code></pre>
        </div> : <div className="diff-stage">
          <div className="diff-heading">
            <span>比较</span>
            <select aria-label="比较版本" value={compareId ?? ""} onChange={(event) => setCompareId(event.target.value)}>
              {versions.filter((version) => version.id !== displayed.id).map((version) =>
                <option key={version.id} value={version.id}>v{version.sequence}</option>)}
            </select>
            <span>→ v{displayed.sequence}</span>
            {changes && !changes.some((part) => part.added || part.removed) && <span>源码相同</span>}
          </div>
          {compared && changes ? <pre aria-label={`v${compared.sequence} 与 v${displayed.sequence} 源码差异`}><code>
            {changes.map((part, index) => <span key={index} className={part.added ? "diff-added" : part.removed ? "diff-removed" : undefined}>{part.value}</span>)}
          </code></pre> : <p>{error || (changes === undefined ? "差异计算超时" : "正在读取比较版本...")}</p>}
        </div>}
      </> : <div className="preview-empty">
        <div className="preview-empty-icon" aria-hidden="true">▧</div>
        <strong>{error || (selectedId ? "正在读取版本..." : "尚无生成结果")}</strong>
        <p>{selectedId ? "请稍候。" : "提交需求后，生成状态会显示在对话中。"}</p>
      </div>}
    </section>
  );
}
