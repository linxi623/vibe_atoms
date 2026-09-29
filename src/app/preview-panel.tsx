"use client";

import { useEffect, useState } from "react";

type Version = { id: string; sequence: number; summary: string };
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
  projectId, currentVersionId, versions, running,
}: {
  projectId: string | null;
  currentVersionId: string | null;
  versions: Version[];
  running: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(currentVersionId);
  const [source, setSource] = useState<Source | null>(null);
  const [mode, setMode] = useState<"preview" | "code">("preview");
  const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => { setSelectedId(currentVersionId); }, [currentVersionId]);
  useEffect(() => {
    if (!selectedId) return;
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

  async function copy() {
    if (!source) return;
    try {
      await navigator.clipboard.writeText(source.html);
      setCopied(true);
    } catch {
      setError("复制失败，请在代码视图中手动选择源码。");
    }
  }

  function download() {
    if (!source) return;
    const url = URL.createObjectURL(new Blob([source.html], { type: "text/html;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `vibe-atoms-v${source.sequence}.html`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section className="preview" aria-label="结果">
      <div className="preview-toolbar">
        <div className="preview-tabs" role="tablist" aria-label="结果视图">
          <button role="tab" aria-selected={mode === "preview"} onClick={() => setMode("preview")}>预览</button>
          <button role="tab" aria-selected={mode === "code"} onClick={() => setMode("code")}>代码</button>
        </div>
        <div className="preview-actions">
          {versions.length > 0 && <select aria-label="选择版本" value={source?.id ?? selectedId ?? ""} onChange={(event) => setSelectedId(event.target.value)}>
            {versions.map((version) => <option key={version.id} value={version.id}>v{version.sequence}{version.id === currentVersionId ? " · 当前" : ""}</option>)}
          </select>}
          <button aria-label="桌面视口" title="桌面视口" aria-pressed={viewport === "desktop"} onClick={() => setViewport("desktop")} disabled={!source}>▣</button>
          <button aria-label="移动视口" title="移动视口" aria-pressed={viewport === "mobile"} onClick={() => setViewport("mobile")} disabled={!source}>▯</button>
          <button aria-label="刷新预览" title="刷新预览" onClick={() => setRefresh((value) => value + 1)} disabled={!source || mode !== "preview"}>↻</button>
          <button aria-label="复制源码" title="复制源码" onClick={() => void copy()} disabled={!source}>⧉</button>
          <button aria-label="下载 HTML" title="下载 HTML" onClick={download} disabled={!source}>↓</button>
        </div>
      </div>
      {source ? <>
        <div className="preview-info">
          <strong>{source.id === currentVersionId ? "当前版本" : "预览版本"} v{source.sequence}</strong>
          <span>{source.summary}</span>
          {running && <span>新版本生成中，当前展示已保存版本</span>}
          {selectedId !== source.id && <span>正在读取所选版本...</span>}
          {copied && <span role="status">已复制 v{source.sequence} 源码</span>}
          {error && <span role="alert">{error}</span>}
        </div>
        {mode === "preview" ? <div className={`preview-stage ${viewport}`}>
          <iframe key={`${projectId}:${source.id}:${refresh}`} title={`预览版本 v${source.sequence}`}
            sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={previewDocument(source.html)} />
        </div> : <div className="source-stage">
          <pre aria-label={`版本 v${source.sequence} 源码`}><code>{source.html}</code></pre>
        </div>}
      </> : <div className="preview-empty">
        <div className="preview-empty-icon" aria-hidden="true">▧</div>
        <strong>{error || (selectedId ? "正在读取版本..." : "尚无生成结果")}</strong>
        <p>{selectedId ? "请稍候。" : "提交需求后，生成状态会显示在对话中。"}</p>
      </div>}
    </section>
  );
}
