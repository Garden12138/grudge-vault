import { useCallback, useEffect, useRef, useState } from "react";
import type { Asset, Job, Workspace } from "@grudge-vault/domain";
import type { IpcResult } from "@grudge-vault/shared";

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1_024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1_024; index += 1) {
    value /= 1_024;
    unit = units[index]!;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function errorMessage<T>(result: IpcResult<T>): string | undefined {
  return result.ok ? undefined : result.error.message;
}

export function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [workspaceName, setWorkspaceName] = useState("My Grudge Vault");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const current = await window.grudgeVault.workspace.current();
    if (!current.ok) {
      setError(current.error.message);
      return;
    }
    setWorkspace(current.data);
    if (!current.data) {
      setAssets([]);
      setJobs([]);
      return;
    }
    const [assetResult, jobResult] = await Promise.all([
      window.grudgeVault.assets.list(),
      window.grudgeVault.jobs.list()
    ]);
    if (assetResult.ok) setAssets(assetResult.data);
    else setError(assetResult.error.message);
    if (jobResult.ok) setJobs(jobResult.data);
    else setError(jobResult.error.message);
  }, []);

  useEffect(() => {
    void refresh();
    return window.grudgeVault.jobs.onChanged(() => void refresh());
  }, [refresh]);

  const runWorkspaceAction = async (action: () => Promise<IpcResult<Workspace | null>>) => {
    setBusy(true);
    setError(undefined);
    const result = await action();
    setBusy(false);
    if (!result.ok) return setError(result.error.message);
    if (result.data) await refresh();
  };

  const importFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setBusy(true);
    setError(undefined);
    const result = await window.grudgeVault.assets.importDropped(files);
    setBusy(false);
    const message = errorMessage(result);
    if (message) setError(message);
    await refresh();
  };

  if (!workspace) {
    return (
      <main className="landing">
        <section className="landing-card">
          <p className="eyebrow">LOCAL-FIRST MEMORY</p>
          <h1>Grudge Vault</h1>
          <p className="lede">Create a private workspace for durable records and encrypted originals.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label className="field">
            <span>Workspace name</span>
            <input value={workspaceName} maxLength={120} onChange={(event) => setWorkspaceName(event.target.value)} />
          </label>
          <div className="landing-actions">
            <button
              className="primary"
              disabled={busy || !workspaceName.trim()}
              onClick={() => void runWorkspaceAction(() => window.grudgeVault.workspace.create(workspaceName))}
            >
              Create workspace
            </button>
            <button disabled={busy} onClick={() => void runWorkspaceAction(() => window.grudgeVault.workspace.open())}>
              Open existing
            </button>
          </div>
          <p className="security-note">Original files are encrypted before entering the workspace vault.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">ACTIVE WORKSPACE</p>
          <h1>{workspace.name}</h1>
          <p className="workspace-path">{workspace.rootPath}</p>
        </div>
        <span className="local-badge">Encrypted locally</span>
      </header>

      {error && <div className="error-banner" role="alert">{error}</div>}

      <section
        className={`drop-zone ${dragging ? "dragging" : ""}`}
        onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void importFiles(Array.from(event.dataTransfer.files));
        }}
      >
        <div>
          <strong>{busy ? "Securing files…" : "Drop files into the vault"}</strong>
          <span>Files are hashed, encrypted, and verified without leaving this device.</span>
        </div>
        <button className="primary" disabled={busy} onClick={() => void window.grudgeVault.assets.chooseAndImport().then(async (result) => {
          const message = errorMessage(result);
          if (message) setError(message);
          await refresh();
        })}>Choose files</button>
        <input
          id="asset-file-input"
          ref={fileInput}
          hidden
          multiple
          type="file"
          onChange={(event) => void importFiles(Array.from(event.target.files ?? []))}
        />
      </section>

      <div className="content-grid">
        <section className="panel assets-panel">
          <div className="panel-heading">
            <div><p className="eyebrow">OBJECT VAULT</p><h2>Assets</h2></div>
            <span>{assets.length} stored</span>
          </div>
          {assets.length === 0 ? (
            <div className="empty">No originals yet. Drop a file above to create the first encrypted Asset.</div>
          ) : (
            <div className="asset-list">
              {assets.map((asset) => (
                <article className="asset-row" key={asset.id}>
                  <div className="asset-title">
                    <strong>{asset.originalFileName}</strong>
                    <span>{formatBytes(asset.byteSize)} · {asset.mimeType}</span>
                  </div>
                  <code title={asset.sha256}>{asset.sha256}</code>
                  <div className="asset-actions">
                    <span className={`status ${asset.integrityStatus}`}>{asset.integrityStatus}</span>
                    <button className="text-button" onClick={() => void window.grudgeVault.assets.verify(asset.id).then(refresh)}>
                      Verify
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <aside className="panel jobs-panel">
          <div className="panel-heading">
            <div><p className="eyebrow">RECOVERABLE WORK</p><h2>Tasks</h2></div>
          </div>
          {jobs.length === 0 ? <div className="empty compact">No background tasks.</div> : jobs.slice(0, 12).map((job) => (
            <article className="job-row" key={job.id}>
              <div><strong>{job.type}</strong><span>Attempt {job.attempts}/{job.maxAttempts}</span></div>
              <span className={`status ${job.state}`}>{job.state}</span>
              <progress max={1} value={job.progress ?? 0} />
              {job.lastError && <p>{job.lastError}</p>}
              {job.state === "failed" && (
                <button className="text-button" onClick={() => void window.grudgeVault.jobs.retry(job.id).then(refresh)}>Retry</button>
              )}
            </article>
          ))}
        </aside>
      </div>
    </main>
  );
}
