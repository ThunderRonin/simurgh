import React, { useEffect, useMemo, useRef, useState } from 'react';
import brandLogoUrl from '../../../assets/brand/clean/simurgh-mark.svg';
import {
  Activity, AlertTriangle, ArrowDownToLine, AudioLines, Check, ChevronDown, CircleHelp, Clock3,
  FilePlus2, FileText, History, Layers3, LoaderCircle, LogOut, Mic, Pause, Play, Plus, RefreshCw,
  Search, Send, Share2, ShieldCheck, Square, Trash2, X,
} from 'lucide-react';

import { apiDownload, apiJson, apiWav, jsonBody, WorkspaceApiError, WorkspaceSessionExpiredError } from './api';
import {
  createInvestigationSubmission, MAX_INVESTIGATION_QUESTION_CHARS, MAX_VOICE_BYTES, MAX_VOICE_SECONDS,
  presentFinding, previewImportedSnapshot,
  type Evidence, type Finding, type ImportedSnapshotPreview, type InvestigationRecord,
  type WorkspaceConfig, type WorkspaceReference, type WorkspaceUser,
} from '../../shared/src/investigation';
import type { ConfirmedCapture } from '../../shared/src/index';
import type { SourceSnapshot } from '../../shared/src/source';

type SessionPhase = 'checking' | 'signed-out' | 'signed-in' | 'error';

interface SessionPayload {
  user: WorkspaceUser;
}

interface ReferenceListPayload {
  references: WorkspaceReference[];
}

interface InvestigationListPayload {
  investigations: InvestigationRecord[];
}

interface ApiReferencePayload {
  reference: WorkspaceReference;
}

interface ApiInvestigationPayload {
  investigation: InvestigationRecord;
}

interface TranscriptPayload {
  text: string;
  referenceIds?: string[];
}

interface FrozenQuestion {
  text: string;
  referenceIds: readonly string[];
}

export function WorkspaceApp() {
  const [phase, setPhase] = useState<SessionPhase>('checking');
  const [user, setUser] = useState<WorkspaceUser | null>(null);
  const [authMessage, setAuthMessage] = useState('');

  useEffect(() => {
    let alive = true;
    apiJson<SessionPayload>('/api/session')
      .then((payload) => {
        if (!alive) return;
        setUser(payload.user);
        setPhase('signed-in');
      })
      .catch((error: unknown) => {
        if (!alive) return;
        if (error instanceof WorkspaceSessionExpiredError) {
          setPhase('signed-out');
          return;
        }
        setAuthMessage('The local workspace could not be reached. Start the Simurgh companion and retry.');
        setPhase('error');
      });
    return () => { alive = false; };
  }, []);

  if (phase === 'checking') return <div className="boot-state" role="status"><LoaderCircle className="spin" size={18} /> Checking local session</div>;
  if (phase === 'signed-in' && user) {
    return <Workspace user={user} onSessionExpired={() => { setUser(null); setPhase('signed-out'); }} />;
  }
  return <LoginScreen
    message={authMessage}
    onRetry={() => { setPhase('checking'); window.location.reload(); }}
    onAuthenticated={(nextUser) => { setUser(nextUser); setAuthMessage(''); setPhase('signed-in'); }}
  />;
}

function LoginScreen({
  message,
  onRetry,
  onAuthenticated,
}: {
  message: string;
  onRetry: () => void;
  onAuthenticated: (user: WorkspaceUser) => void;
}) {
  const tokenRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const token = tokenRef.current?.value ?? '';
    if (tokenRef.current) tokenRef.current.value = '';
    setError('');
    if (!token.trim()) {
      setError('Enter the local access token.');
      return;
    }
    setBusy(true);
    try {
      const payload = await apiJson<SessionPayload>('/api/session', { method: 'POST', body: jsonBody({ token }) });
      onAuthenticated(payload.user);
    } catch (reason) {
      setError(messageForError(reason));
    } finally {
      setBusy(false);
    }
  };

  return <main className="login-page">
    <header className="login-heading">
      <BrandMark />
      <div><strong>Simurgh</strong><span>Local investigation workspace</span></div>
    </header>
    <form className="login-form" onSubmit={submit} aria-labelledby="login-title">
      <h1 id="login-title">Sign in</h1>
      <p>Use the access token issued for this local workspace.</p>
      <label htmlFor="local-token">Access token</label>
      <input id="local-token" name="token" type="password" autoComplete="current-password" ref={tokenRef} autoFocus />
      {(error || message) && <p className="notice error-notice" role="alert">{error || message}</p>}
      <div className="login-actions">
        <button className="button primary" type="submit" disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />} Continue
        </button>
        {message && <button className="button subtle" type="button" onClick={onRetry}><RefreshCw size={15} /> Retry</button>}
      </div>
    </form>
  </main>;
}

function Workspace({ user, onSessionExpired }: { user: WorkspaceUser; onSessionExpired: () => void }) {
  const [config, setConfig] = useState<WorkspaceConfig | null>(null);
  const [references, setReferences] = useState<WorkspaceReference[]>([]);
  const [investigations, setInvestigations] = useState<InvestigationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState('');
  const [loadError, setLoadError] = useState('');
  const [selectedReferenceIds, setSelectedReferenceIds] = useState<string[]>([]);
  const [inspectedReferenceId, setInspectedReferenceId] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [questionReferences, setQuestionReferences] = useState<readonly string[] | null>(null);
  const [pendingVoiceQuestion, setPendingVoiceQuestion] = useState<FrozenQuestion | null>(null);
  const [submittingQuestion, setSubmittingQuestion] = useState(false);
  const [selectedInvestigationId, setSelectedInvestigationId] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState<InvestigationRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ kind: 'reference' | 'investigation'; id: string } | null>(null);
  const [importPreview, setImportPreview] = useState<ImportedSnapshotPreview | null>(null);
  const [importError, setImportError] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const clearSensitiveState = () => {
    setConfig(null);
    setReferences([]);
    setInvestigations([]);
    setSelectedReferenceIds([]);
    setInspectedReferenceId(null);
    setSelectedInvestigationId(null);
    setShareTarget(null);
    setDeleteTarget(null);
    setImportPreview(null);
    setPendingVoiceQuestion(null);
    setQuestionReferences(null);
    setQuestion('');
    onSessionExpired();
  };

  const handleError = (error: unknown) => {
    if (error instanceof WorkspaceSessionExpiredError) {
      clearSensitiveState();
      return;
    }
    setNotice(messageForError(error));
  };

  const loadWorkspace = async (quiet = false) => {
    if (quiet) setRefreshing(true);
    else setLoading(true);
    setLoadError('');
    try {
      const [nextConfig, referencePayload, investigationPayload] = await Promise.all([
        apiJson<WorkspaceConfig>('/api/config'),
        apiJson<ReferenceListPayload>('/api/references'),
        apiJson<InvestigationListPayload>('/api/investigations'),
      ]);
      if (!Array.isArray(referencePayload.references) || !Array.isArray(investigationPayload.investigations)) {
        throw new Error('The local workspace returned an invalid list response.');
      }
      setConfig(nextConfig);
      setReferences(referencePayload.references);
      setInvestigations(sortInvestigations(investigationPayload.investigations));
      setSelectedReferenceIds((current) => current.filter((id) => referencePayload.references.some((reference) => reference.id === id)));
      setSelectedInvestigationId((current) => current && investigationPayload.investigations.some((item) => item.id === current)
        ? current : investigationPayload.investigations[0]?.id ?? null);
      setNotice('');
    } catch (error) {
      if (error instanceof WorkspaceSessionExpiredError) clearSensitiveState();
      else setLoadError(messageForError(error));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { void loadWorkspace(); }, []);

  const activeInvestigation = investigations.find((item) => item.id === selectedInvestigationId) ?? null;
  useEffect(() => {
    if (!activeInvestigation || !isActive(activeInvestigation.status)) return;
    let closed = false;
    const url = `/api/investigations/${encodeURIComponent(activeInvestigation.id)}/events`;
    const source = new EventSource(url);
    const onInvestigation = (event: Event) => {
      try {
        const update = JSON.parse((event as MessageEvent<string>).data) as { investigation?: InvestigationRecord };
        if (update.investigation?.id === activeInvestigation.id) {
          setInvestigations((items) => replaceInvestigation(items, update.investigation!));
        }
      } catch {
        setNotice('The live update could not be read. Current state will be refreshed.');
      }
    };
    source.addEventListener('investigation', onInvestigation);
    source.onerror = () => setNotice('Live updates are reconnecting; the current investigation is still available.');
    const poll = window.setInterval(async () => {
      try {
        const payload = await apiJson<ApiInvestigationPayload>(`/api/investigations/${encodeURIComponent(activeInvestigation.id)}`);
        if (!closed && payload.investigation?.id === activeInvestigation.id) {
          setInvestigations((items) => replaceInvestigation(items, payload.investigation));
        }
      } catch (error) {
        if (error instanceof WorkspaceSessionExpiredError) clearSensitiveState();
        else if (!closed) setNotice('Could not refresh investigation status.');
      }
    }, 4_000);
    return () => {
      closed = true;
      source.close();
      window.clearInterval(poll);
    };
  }, [activeInvestigation?.id, activeInvestigation?.status]);

  const toggleReference = (id: string) => {
    setSelectedReferenceIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= 4) {
        setNotice('An investigation can include up to four references.');
        return current;
      }
      setNotice('');
      return [...current, id];
    });
  };

  const importFile = async (file?: File) => {
    setImportError('');
    setImportPreview(null);
    if (!file) return;
    if (file.size > 5_000_000) {
      setImportError('The selected export exceeds the 5 MB import limit.');
      return;
    }
    setImportBusy(true);
    try {
      const input = JSON.parse(await file.text()) as unknown;
      const result = await previewImportedSnapshot(input);
      if (!result.ok) {
        setImportError(result.reason);
        return;
      }
      setImportPreview(result.value);
    } catch {
      setImportError('Choose a valid Simurgh JSON export.');
    } finally {
      setImportBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const saveImport = async () => {
    if (!importPreview) return;
    setImportBusy(true);
    setImportError('');
    try {
      const payload = await apiJson<ApiReferencePayload>('/api/references', {
        method: 'POST',
        body: jsonBody({ snapshot: importPreview.snapshot }),
      });
      setReferences((items) => [payload.reference, ...items]);
      setSelectedReferenceIds((items) => items.length < 4 ? [...items, payload.reference.id] : items);
      setInspectedReferenceId(payload.reference.id);
      setImportPreview(null);
      setNotice('Reference imported. Server policy checks are complete for this saved reference.');
    } catch (error) {
      if (error instanceof WorkspaceSessionExpiredError) clearSensitiveState();
      else setImportError(messageForError(error));
    } finally {
      setImportBusy(false);
    }
  };

  const submitQuestion = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!config?.capabilities.agent) {
      setNotice('Investigations unavailable: no agent host configured.');
      return;
    }
    const requestedIds = questionReferences ?? pendingVoiceQuestion?.referenceIds ?? selectedReferenceIds;
    let request;
    try {
      request = createInvestigationSubmission(question, requestedIds, references.map((item) => item.id));
    } catch (error) {
      setNotice(messageForError(error));
      return;
    }
    setSubmittingQuestion(true);
    setNotice('');
    try {
      const payload = await apiJson<ApiInvestigationPayload>('/api/investigations', {
        method: 'POST',
        body: jsonBody(request),
      });
      setInvestigations((items) => replaceInvestigation(items, payload.investigation));
      setSelectedInvestigationId(payload.investigation.id);
      setQuestionReferences(request.referenceIds);
      setPendingVoiceQuestion(null);
    } catch (error) {
      if (error instanceof WorkspaceSessionExpiredError) clearSensitiveState();
      else setNotice(messageForError(error));
    } finally {
      setSubmittingQuestion(false);
    }
  };

  const useVoiceQuestion = (next: FrozenQuestion) => {
    setQuestion(next.text);
    setQuestionReferences(Object.freeze([...next.referenceIds]));
    setPendingVoiceQuestion(next);
  };

  const cancelInvestigation = async (investigation: InvestigationRecord) => {
    try {
      const payload = await apiJson<ApiInvestigationPayload>(`/api/investigations/${encodeURIComponent(investigation.id)}/cancel`, {
        method: 'POST', body: jsonBody({}),
      });
      setInvestigations((items) => replaceInvestigation(items, payload.investigation));
    } catch (error) { handleError(error); }
  };

  const deleteReference = async (id: string) => {
    try {
      await apiJson<void>(`/api/references/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setReferences((items) => items.filter((item) => item.id !== id));
      setSelectedReferenceIds((items) => items.filter((item) => item !== id));
      setInspectedReferenceId((current) => current === id ? null : current);
      setDeleteTarget(null);
      setNotice('Reference deleted.');
    } catch (error) { handleError(error); }
  };

  const deleteInvestigation = async (id: string) => {
    try {
      await apiJson<void>(`/api/investigations/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setInvestigations((items) => items.filter((item) => item.id !== id));
      setSelectedInvestigationId((current) => current === id ? null : current);
      setDeleteTarget(null);
      setNotice('Investigation deleted.');
    } catch (error) { handleError(error); }
  };

  const downloadInvestigation = async (record: InvestigationRecord) => {
    try {
      const { blob, filename } = await apiDownload(`/api/investigations/${encodeURIComponent(record.id)}/export`);
      downloadBlob(blob, filename);
    } catch (error) { handleError(error); }
  };

  const logout = async () => {
    try { await apiJson<void>('/api/session', { method: 'DELETE' }); }
    catch (error) { if (!(error instanceof WorkspaceSessionExpiredError)) setNotice(messageForError(error)); }
    clearSensitiveState();
  };

  const selectedIdsForQuestion = questionReferences ?? pendingVoiceQuestion?.referenceIds ?? selectedReferenceIds;
  const referenceNames = new Map(references.map((reference) => [reference.id, reference.title]));
  const selectedInvestigation = activeInvestigation;

  if (loading) return <div className="boot-state" role="status"><LoaderCircle className="spin" size={18} /> Opening local workspace</div>;
  if (loadError && !config) return <main className="login-page"><div className="service-error" role="alert"><AlertTriangle size={20} /><strong>Workspace unavailable</strong><p>{loadError}</p><button className="button secondary" onClick={() => void loadWorkspace()}><RefreshCw size={15} /> Retry</button></div></main>;

  return <div className="workspace-shell">
    <header className="topbar">
      <a className="brand-link" href="/" aria-label="Simurgh workspace home"><BrandMark /><strong>Simurgh</strong><span>Workspace</span></a>
      <div className="topbar-right">
        <span className="current-user"><ShieldCheck size={14} /> {user.name}</span>
        <button className="icon-command" type="button" onClick={() => void loadWorkspace(true)} disabled={refreshing} title="Refresh workspace" aria-label="Refresh workspace">
          <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
        </button>
        <button className="button subtle logout-button" type="button" onClick={() => void logout()}><LogOut size={15} /> Sign out</button>
      </div>
    </header>

    <div className="scope-bar" aria-label="Workspace limits">
      <span><Activity size={14} /> {config?.capabilities.agent ? 'Agent available' : 'Agent unavailable'}</span>
      <span><Clock3 size={14} /> {formatDuration(config?.limits.wallMs ?? 0)} per investigation</span>
      <span>{config?.limits.queries ?? 0} queries</span>
      <span>{formatBytes(config?.limits.bytes ?? 0)} evidence</span>
      <span>{config?.capabilities.voice ? 'Voice available' : 'Voice unavailable'}</span>
      <span>{config?.capabilities.speech ? 'Speech available' : 'Speech unavailable'}</span>
    </div>
    <nav className="workspace-nav" aria-label="Workspace sections">
      <a href="#references-heading">Context</a>
      <a href="#ask-heading">Investigation</a>
      <a href="#history-heading">History</a>
    </nav>

    {(notice || loadError) && <div className={`global-notice ${loadError ? 'notice-error' : ''}`} role={loadError ? 'alert' : 'status'}>
      <span>{loadError || notice}</span>
      <button type="button" className="icon-command" aria-label="Dismiss notice" onClick={() => { setNotice(''); setLoadError(''); }}><X size={15} /></button>
    </div>}

    <main className="workspace-grid">
      <section className="references-column" aria-labelledby="references-heading">
        <div className="section-heading">
          <div><span className="section-kicker">Context</span><h1 id="references-heading">References <span className="count">{references.length}</span></h1></div>
          <button className="button secondary import-button" type="button" onClick={() => fileInput.current?.click()} disabled={importBusy}>
            {importBusy ? <LoaderCircle className="spin" size={15} /> : <FilePlus2 size={15} />} Import
          </button>
          <input
            ref={fileInput}
            className="visually-hidden"
            type="file"
            accept="application/json,.json"
            aria-label="Import a Simurgh JSON reference"
            onChange={(event) => void importFile(event.currentTarget.files?.[0])}
          />
        </div>
        <p className="section-summary">{references.length} saved · {selectedReferenceIds.length} attached to next question</p>
        <div className="reference-selection-line">
          <span>{selectedReferenceIds.length} of 4 selected</span>
          <button type="button" className="text-button" disabled={!selectedReferenceIds.length} onClick={() => setSelectedReferenceIds([])}>Clear</button>
        </div>
        {references.length ? <ul className="reference-list">
          {references.map((reference) => <ReferenceRow
            key={reference.id}
            reference={reference}
            selected={selectedReferenceIds.includes(reference.id)}
            selectionDisabled={selectedReferenceIds.length >= 4 && !selectedReferenceIds.includes(reference.id)}
            inspected={inspectedReferenceId === reference.id}
            onToggle={() => toggleReference(reference.id)}
            onInspect={() => setInspectedReferenceId((current) => current === reference.id ? null : reference.id)}
            onDelete={() => setDeleteTarget({ kind: 'reference', id: reference.id })}
          />)}
        </ul> : <EmptyState icon={<Layers3 size={18} />} title="No references saved" text="" />}
        {inspectedReferenceId && references.find((item) => item.id === inspectedReferenceId) && <ReferenceInspector reference={references.find((item) => item.id === inspectedReferenceId)!} />}
        {importError && <p className="inline-error" role="alert">{importError}</p>}
        {importPreview && <ImportPreview
          preview={importPreview}
          busy={importBusy}
          onAdd={() => void saveImport()}
          onCancel={() => setImportPreview(null)}
        />}
        {config?.limitations.map((limitation) => <p className="limitation" key={limitation}><CircleHelp size={13} /> {limitation}</p>)}
      </section>

      <section className="investigation-column" aria-labelledby="ask-heading">
        <div className="section-heading main-heading">
          <div><span className="section-kicker">Ask</span><h1 id="ask-heading">Investigate</h1></div>
          {selectedInvestigation && <StatusBadge status={selectedInvestigation.status} />}
        </div>
        <form className="question-form" onSubmit={(event) => void submitQuestion(event)}>
          <label htmlFor="question">Question</label>
          <textarea
            id="question"
            data-testid="question-input"
            value={question}
            maxLength={MAX_INVESTIGATION_QUESTION_CHARS}
            onChange={(event) => setQuestion(event.currentTarget.value)}
            placeholder="Ask about the evidence in your selected references"
            rows={3}
          />
          <div className="question-meta">
            <span>{question.length}/{MAX_INVESTIGATION_QUESTION_CHARS}</span>
            <span>{selectedIdsForQuestion.length} attached</span>
          </div>
          {questionReferences && <div className="frozen-reference-note" data-testid="question-reference-snapshot">
            <ShieldCheck size={14} /> Transcript references locked.
            <button type="button" className="text-button" onClick={() => { setQuestionReferences(null); setPendingVoiceQuestion(null); }}>Use selected references</button>
          </div>}
          {selectedIdsForQuestion.length > 0 && <div className="attached-references" aria-label="References attached to this question">
            {selectedIdsForQuestion.map((id) => <span className="attached-reference" key={id}>{referenceNames.get(id) ?? 'Unavailable reference'}</span>)}
          </div>}
          <div className="question-actions">
            <button
              className="button primary"
              type="submit"
              data-testid="start-investigation"
              disabled={submittingQuestion || !config?.capabilities.agent || !question.trim() || selectedIdsForQuestion.length < 1}
              title={!config?.capabilities.agent ? 'No agent host is configured' : 'Start a bounded investigation'}
            >
              {submittingQuestion ? <LoaderCircle className="spin" size={16} /> : <Send size={15} />} Start investigation
            </button>
            {selectedInvestigation && isActive(selectedInvestigation.status) && <button className="button danger-outline" type="button" onClick={() => void cancelInvestigation(selectedInvestigation)}>
              <Square size={13} fill="currentColor" /> Cancel investigation
            </button>}
          </div>
        </form>

        <VoiceQuestion
          enabled={Boolean(config?.capabilities.voice)}
          selectedReferenceIds={selectedReferenceIds}
          referenceNames={referenceNames}
          onUseQuestion={useVoiceQuestion}
          onSessionExpired={clearSensitiveState}
        />

        {!config?.capabilities.agent && <div className="capability-note"><AlertTriangle size={16} /><span>Investigations unavailable: no agent host configured.</span></div>}
        {selectedInvestigation ? <InvestigationView
          key={selectedInvestigation.id}
          investigation={selectedInvestigation}
          user={user}
          config={config}
          speechEnabled={Boolean(config?.capabilities.speech)}
          onSessionExpired={clearSensitiveState}
          onShare={() => setShareTarget(selectedInvestigation)}
          onDownload={() => void downloadInvestigation(selectedInvestigation)}
          onDelete={() => setDeleteTarget({ kind: 'investigation', id: selectedInvestigation.id })}
          onCitation={(id) => document.getElementById(`evidence-${CSS.escape(id)}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
        /> : <EmptyState icon={<Search size={18} />} title="No investigation selected" text="" />}
      </section>

      <aside className="history-column" aria-labelledby="history-heading">
        <div className="section-heading"><div><span className="section-kicker">Recent</span><h1 id="history-heading">History <span className="count">{investigations.length}</span></h1></div></div>
        {investigations.length ? <ul className="history-list">
          {investigations.map((record) => <li key={record.id}>
            <button
              type="button"
              className={`history-item ${record.id === selectedInvestigationId ? 'active' : ''}`}
              onClick={() => setSelectedInvestigationId(record.id)}
              aria-current={record.id === selectedInvestigationId ? 'page' : undefined}
            >
              <span className="history-item-top"><StatusBadge status={record.status} /><time dateTime={record.createdAt}>{formatTime(record.createdAt)}</time></span>
              <span className="history-question">{record.question}</span>
              <span className="history-reference-count">{record.referenceIds.length} reference{record.referenceIds.length === 1 ? '' : 's'}</span>
            </button>
          </li>)}
        </ul> : <EmptyState icon={<History size={17} />} title="No investigations saved" text="" />}
      </aside>
    </main>

    {shareTarget && <ShareDialog
      investigation={investigations.find((item) => item.id === shareTarget.id) ?? shareTarget}
      currentUser={user}
      users={config?.users ?? []}
      onClose={() => setShareTarget(null)}
      onError={handleError}
      onUpdate={(next) => setInvestigations((items) => replaceInvestigation(items, next))}
    />}
    {deleteTarget && <ConfirmDialog
      title={deleteTarget.kind === 'reference' ? 'Delete reference?' : 'Delete investigation?'}
      message={deleteTarget.kind === 'reference'
        ? 'This removes the saved reference. The server may block deletion while an active investigation uses it.'
        : 'This removes the investigation and its saved history. Export any information you need first.'}
      actionLabel="Delete"
      onClose={() => setDeleteTarget(null)}
      onConfirm={() => void (deleteTarget.kind === 'reference'
        ? deleteReference(deleteTarget.id)
        : deleteInvestigation(deleteTarget.id))}
    />}
  </div>;
}

function ReferenceRow({
  reference,
  selected,
  selectionDisabled,
  inspected,
  onToggle,
  onInspect,
  onDelete,
}: {
  reference: WorkspaceReference;
  selected: boolean;
  selectionDisabled: boolean;
  inspected: boolean;
  onToggle: () => void;
  onInspect: () => void;
  onDelete: () => void;
}) {
  return <li className={`reference-row ${selected ? 'selected' : ''}`}>
    <label className="reference-select">
      <input type="checkbox" checked={selected} disabled={selectionDisabled} onChange={onToggle} aria-label={`Attach ${reference.title}`} />
    </label>
    <div className="reference-copy">
      <span className={`kind-label kind-${reference.kind}`}>{reference.kind === 'telemetry' ? <Activity size={12} /> : <FileText size={12} />}{reference.kind}</span>
      <strong>{reference.title}</strong>
      <span className="reference-created">Added {formatTime(reference.createdAt)}</span>
    </div>
    <button className="icon-command" type="button" title={inspected ? 'Close reference details' : 'Inspect reference'} aria-label={`${inspected ? 'Close' : 'Inspect'} ${reference.title}`} onClick={onInspect}>
      {inspected ? <ChevronDown size={15} /> : <Search size={15} />}
    </button>
    <button className="icon-command destructive" type="button" title="Delete reference" aria-label={`Delete ${reference.title}`} onClick={onDelete}><Trash2 size={15} /></button>
  </li>;
}

function ReferenceInspector({ reference }: { reference: WorkspaceReference }) {
  const snapshot = reference.snapshot as ConfirmedCapture | SourceSnapshot;
  const details = reference.kind === 'telemetry' && 'confirmation' in snapshot
    ? [
        `Series: ${snapshot.selected.name} · ${Object.entries(snapshot.selected.labels).map(([key, value]) => `${key}=${value}`).join(', ')}`,
        `Dashboard: ${snapshot.panel.dashboardTitle} (${snapshot.panel.dashboardUid})`,
        `Panel: ${snapshot.panel.panelTitle} (${snapshot.panel.panelId})`,
        `Datasource: ${snapshot.panel.datasourceType} · ${snapshot.panel.datasourceUid}`,
        `Confirmed range: ${formatAbsoluteTime(snapshot.confirmation.range.from)} – ${formatAbsoluteTime(snapshot.confirmation.range.to)}`,
      ]
    : sourceDetails(snapshot as SourceSnapshot);
  return <div className="reference-detail" data-testid="reference-detail">
    <div className="detail-heading"><strong>Reference details</strong><span>User-supplied</span></div>
    <ul>{details.map((detail) => <li key={detail}>{detail}</li>)}</ul>
    <Limitations items={reference.limitations} />
  </div>;
}

function sourceDetails(snapshot: SourceSnapshot): string[] {
  return [
    `File: ${snapshot.workspace?.relativePath ?? snapshot.document.uri}`,
    `Language: ${snapshot.document.languageId} · version ${snapshot.document.version}`,
    `Selected lines: ${snapshot.selection.start.line + 1}–${snapshot.selection.end.line + 1}`,
    `Git revision: ${snapshot.workspace?.gitRevision ?? 'not available'}`,
  ];
}

function ImportPreview({ preview, busy, onAdd, onCancel }: {
  preview: ImportedSnapshotPreview;
  busy: boolean;
  onAdd: () => void;
  onCancel: () => void;
}) {
  return <div className="import-preview" data-testid="import-preview">
    <div className="detail-heading"><strong>Review import</strong><span>User-supplied</span></div>
    <h2>{preview.title}</h2>
    <ul className="preview-details">{preview.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>
    <Limitations items={preview.limitations} />
    <p className="caution-line"><ShieldCheck size={13} /> The local server will validate this reference before saving it.</p>
    <div className="dialog-actions">
      <button className="button secondary" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      <button className="button primary" type="button" onClick={onAdd} disabled={busy}>
        {busy ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} Add reference
      </button>
    </div>
  </div>;
}

function InvestigationView({
  investigation,
  user,
  config,
  speechEnabled,
  onSessionExpired,
  onShare,
  onDownload,
  onDelete,
  onCitation,
}: {
  investigation: InvestigationRecord;
  user: WorkspaceUser;
  config: WorkspaceConfig | null;
  speechEnabled: boolean;
  onSessionExpired: () => void;
  onShare: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onCitation: (id: string) => void;
}) {
  const finding = presentFinding(investigation.finding, investigation.evidence);
  const isOwner = investigation.ownerId === user.id;
  return <article className="investigation-result" data-testid="investigation-result">
    <div className="result-toolbar">
      <div><StatusBadge status={investigation.status} /><time dateTime={investigation.createdAt}>{new Date(investigation.createdAt).toLocaleString()}</time></div>
      <div className="toolbar-actions">
        {isOwner && <button className="icon-command" type="button" onClick={onShare} title="Review sharing" aria-label="Review sharing"><Share2 size={15} /></button>}
        <button className="icon-command" type="button" onClick={onDownload} title="Export investigation" aria-label="Export investigation"><ArrowDownToLine size={15} /></button>
        {isOwner && <button className="icon-command destructive" type="button" onClick={onDelete} title="Delete investigation" aria-label="Delete investigation"><Trash2 size={15} /></button>}
      </div>
    </div>
    <h2>{investigation.question}</h2>
    <div className="frozen-context">
      <strong>Frozen references</strong>
      <ul>{investigation.references.map((reference) => <li key={reference.id}><span className={`kind-label kind-${reference.kind}`}>{reference.kind}</span>{reference.title}</li>)}</ul>
    </div>
    <UsageLine investigation={investigation} />
    {investigation.stopReason && <p className="stop-reason"><AlertTriangle size={14} /> {investigation.stopReason}</p>}
    {finding.status === 'valid' ? <section className={`finding finding-${finding.finding.strength}`} aria-labelledby="finding-heading">
      <div className="finding-heading"><span className="section-kicker">Finding · {finding.finding.strength}</span><h3 id="finding-heading">{finding.finding.summary}</h3></div>
      {finding.finding.citations.length > 0 && <div className="citation-list" aria-label="Finding citations">
        {finding.evidence.map((item) => <button className="citation-chip" type="button" key={item.id} onClick={() => onCitation(item.id)} title={`View evidence ${item.id}`}>
          <span className="citation-marker">{finding.finding.citations.indexOf(item.id) + 1}</span>{item.title}
        </button>)}
      </div>}
      {finding.finding.limitations.length > 0 && <Limitations items={finding.finding.limitations} />}
      {finding.finding.nextCheck && <p className="next-check"><strong>Next check:</strong> {finding.finding.nextCheck}</p>}
      {speechEnabled
        ? <FindingAudio key={investigation.id} investigationId={investigation.id} onSessionExpired={onSessionExpired} />
        : <p className="voice-hint">Finding speech unavailable for this workspace.</p>}
    </section> : finding.status === 'invalid' ? <div className="finding-invalid" role="alert"><AlertTriangle size={15} /> Finding hidden: {finding.reason}</div>
      : <div className="finding-empty">{isActive(investigation.status) ? 'Finding pending.' : 'No final finding.'}</div>}
    <section className="evidence-section" aria-labelledby="evidence-heading">
      <div className="evidence-heading"><h3 id="evidence-heading">Evidence</h3><span>{investigation.evidence.length} item{investigation.evidence.length === 1 ? '' : 's'}</span></div>
      {investigation.evidence.length ? <ul className="evidence-list">
        {investigation.evidence.map((item) => <EvidenceItem key={item.id} item={item} />)}
      </ul> : <p className="quiet-empty">No evidence collected.</p>}
    </section>
    <Limitations items={investigation.limitations} />
    {investigation.grants.length > 0 && <p className="sharing-state"><Share2 size={13} /> Shared with {investigation.grants.map((id) => config?.users.find((item) => item.id === id)?.name ?? 'another configured user').join(', ')}</p>}
  </article>;
}

function EvidenceItem({ item }: { item: Evidence }) {
  let data = '';
  try { data = JSON.stringify(item.data, null, 2); } catch { data = '[Evidence data is unavailable]'; }
  const truncated = data.length > 4_000;
  return <li className="evidence-item" id={`evidence-${item.id}`} data-testid="evidence-item">
    <div className="evidence-rail" aria-hidden="true"><span /></div>
    <div className="evidence-content">
      <div className="evidence-meta"><span className="evidence-kind">{item.kind}</span><span className={item.origin === 'user-supplied' ? 'origin-user' : 'origin-queried'}>{item.origin === 'user-supplied' ? 'User-supplied' : 'Queried'}</span><time dateTime={item.capturedAt}>{formatTime(item.capturedAt)}</time></div>
      <h4>{item.title}</h4>
      <p className="evidence-scope">{item.scope}</p>
      <details>
        <summary>Inspect data</summary>
        <pre>{truncated ? `${data.slice(0, 4_000)}\n… data truncated for display` : data}</pre>
      </details>
      <Limitations items={item.limitations} />
    </div>
  </li>;
}

function UsageLine({ investigation }: { investigation: InvestigationRecord }) {
  const { limits, usage } = investigation;
  return <div className="usage-line" aria-label="Investigation usage">
    <span><Clock3 size={13} /> {formatDuration(usage.elapsedMs)} / {formatDuration(limits.wallMs)}</span>
    <span>{usage.queries} / {limits.queries} queries</span>
    <span>{formatBytes(usage.bytes)} / {formatBytes(limits.bytes)}</span>
    <span>{usage.inputTokens === null || usage.outputTokens === null ? 'Token usage not reported' : `${formatCount(usage.inputTokens)} in · ${formatCount(usage.outputTokens)} out`}</span>
    {usage.modelUsageEnforcement && <span className="usage-note">{usage.modelUsageEnforcement}</span>}
  </div>;
}

function FindingAudio({ investigationId, onSessionExpired }: { investigationId: string; onSessionExpired: () => void }) {
  const [state, setState] = useState<'idle' | 'loading' | 'playing' | 'ready'>('idle');
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  const audioRef = useRef<HTMLAudioElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const release = (update = true) => {
    requestRef.current?.abort();
    requestRef.current = null;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
      audio.removeAttribute('src');
      audio.load();
    }
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
    if (update) {
      setState('idle');
      setTruncated(false);
      setError('');
    }
  };

  useEffect(() => () => release(false), [investigationId]);

  const play = async () => {
    setError('');
    const audio = audioRef.current;
    if (!audio) return;
    if (objectUrlRef.current) {
      audio.currentTime = 0;
      try {
        await audio.play();
        setState('playing');
      } catch {
        setError('The browser could not play this audio. Check audio output and retry.');
        setState('ready');
      }
      return;
    }

    const controller = new AbortController();
    requestRef.current = controller;
    setState('loading');
    try {
      const result = await apiWav(`/api/investigations/${encodeURIComponent(investigationId)}/speech`, controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(result.blob);
      objectUrlRef.current = url;
      audio.src = url;
      setTruncated(result.truncated);
      await audio.play();
      if (!controller.signal.aborted) setState('playing');
    } catch (reason) {
      if (controller.signal.aborted || (reason instanceof DOMException && reason.name === 'AbortError')) return;
      if (reason instanceof WorkspaceSessionExpiredError) {
        onSessionExpired();
        return;
      }
      setError(messageForError(reason));
      setState('idle');
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  };

  return <div className="finding-audio" aria-label="Finding speech controls">
    <audio
      ref={audioRef}
      data-testid="finding-audio"
      aria-hidden="true"
      preload="none"
      onEnded={() => setState('ready')}
      onError={() => {
        if (objectUrlRef.current) setError('The returned speech audio could not be decoded.');
      }}
    />
    <div className="voice-actions">
      <button className="button secondary" type="button" data-testid="play-finding-audio" onClick={() => void play()} disabled={state === 'loading' || state === 'playing'}>
        {state === 'loading' ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}
        {state === 'loading' ? 'Preparing speech' : state === 'playing' ? 'Playing finding' : 'Play finding audio'}
      </button>
      <button className="button secondary" type="button" data-testid="stop-finding-audio" onClick={() => release()} disabled={state === 'idle'}>
        <Square size={13} fill="currentColor" /> Stop playback
      </button>
      {truncated && <span className="unavailable-label" role="status">Audio is an excerpt (finding shortened)</span>}
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}

function VoiceQuestion({
  enabled,
  selectedReferenceIds,
  referenceNames,
  onUseQuestion,
  onSessionExpired,
}: {
  enabled: boolean;
  selectedReferenceIds: readonly string[];
  referenceNames: ReadonlyMap<string, string>;
  onUseQuestion: (question: FrozenQuestion) => void;
  onSessionExpired: () => void;
}) {
  const [state, setState] = useState<'idle' | 'requesting' | 'recording' | 'transcribing' | 'review'>('idle');
  const [transcript, setTranscript] = useState('');
  const [frozenIds, setFrozenIds] = useState<readonly string[]>([]);
  const [error, setError] = useState('');
  const [playback, setPlayback] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const limitTimer = useRef<number | null>(null);
  const permissionGeneration = useRef(0);
  const transcriptionController = useRef<AbortController | null>(null);

  const releaseMedia = () => {
    if (limitTimer.current !== null) window.clearTimeout(limitTimer.current);
    limitTimer.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    chunks.current = [];
    recorder.current = null;
  };

  const cancelUtterance = () => {
    permissionGeneration.current += 1;
    transcriptionController.current?.abort();
    transcriptionController.current = null;
    const activeRecorder = recorder.current;
    if (activeRecorder) {
      activeRecorder.onstop = null;
      activeRecorder.onerror = null;
      if (activeRecorder.state !== 'inactive') activeRecorder.stop();
    }
    releaseMedia();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    setState('idle');
    setTranscript('');
    setFrozenIds([]);
    setPlayback(false);
    setError('');
  };

  useEffect(() => () => {
    permissionGeneration.current += 1;
    transcriptionController.current?.abort();
    const activeRecorder = recorder.current;
    if (activeRecorder) {
      activeRecorder.onstop = null;
      activeRecorder.onerror = null;
      if (activeRecorder.state !== 'inactive') activeRecorder.stop();
    }
    releaseMedia();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }, []);

  const begin = async () => {
    setError('');
    if (!enabled) return;
    if (selectedReferenceIds.length < 1 || selectedReferenceIds.length > 4) {
      setError('Select one to four references before recording a question.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Voice recording is unavailable in this browser. Use the typed question field.');
      return;
    }
    const generation = ++permissionGeneration.current;
    const frozen = Object.freeze([...selectedReferenceIds]);
    setFrozenIds(frozen);
    setState('requesting');
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (generation !== permissionGeneration.current) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = media;
      const preferred = 'audio/webm;codecs=opus';
      const options = MediaRecorder.isTypeSupported(preferred) ? { mimeType: preferred } : undefined;
      const nextRecorder = new MediaRecorder(media, options);
      recorder.current = nextRecorder;
      chunks.current = [];
      nextRecorder.ondataavailable = (event) => { if (event.data.size) chunks.current.push(event.data); };
      nextRecorder.onerror = () => {
        if (generation !== permissionGeneration.current) return;
        releaseMedia();
        setState('idle');
        setError('The browser could not record audio. Retry or type the question.');
      };
      nextRecorder.onstop = () => {
        if (generation !== permissionGeneration.current) return;
        const duration = Date.now() - startedAt.current;
        const audio = new Blob(chunks.current, { type: nextRecorder.mimeType || 'application/octet-stream' });
        releaseMedia();
        if (duration > MAX_VOICE_SECONDS * 1_000 || audio.size > MAX_VOICE_BYTES || audio.size === 0) {
          setState('idle');
          setError(audio.size > MAX_VOICE_BYTES
            ? 'Recording exceeded the 2 MiB limit and was discarded.'
            : 'Recording was empty or exceeded 30 seconds and was discarded.');
          return;
        }
        setState('transcribing');
        void transcribe(audio, frozen);
      };
      startedAt.current = Date.now();
      nextRecorder.start(250);
      setState('recording');
      limitTimer.current = window.setTimeout(() => {
        if (recorder.current?.state === 'recording') recorder.current.stop();
      }, MAX_VOICE_SECONDS * 1_000);
    } catch {
      if (generation !== permissionGeneration.current) return;
      releaseMedia();
      setState('idle');
      setError('Microphone access was denied or no input device is available. Allow access and retry, or type the question.');
    }
  };

  const transcribe = async (audio: Blob, frozen: readonly string[]) => {
    const controller = new AbortController();
    transcriptionController.current = controller;
    try {
      const payload = await apiJson<TranscriptPayload>('/api/transcriptions', {
        method: 'POST',
        headers: {
          'Content-Type': audio.type || 'application/octet-stream',
          'X-Simurgh-Reference-Ids': JSON.stringify(frozen),
        },
        body: audio,
        signal: controller.signal,
      });
      if (typeof payload.text !== 'string' || !payload.text.trim()) {
        setState('idle');
        setError('Transcription returned no text. Record again or type the question.');
        return;
      }
      setTranscript(payload.text);
      setState('review');
    } catch (reason) {
      if (controller.signal.aborted || (reason instanceof DOMException && reason.name === 'AbortError')) return;
      if (reason instanceof WorkspaceSessionExpiredError) onSessionExpired();
      else {
        setState('idle');
        setError(messageForError(reason));
      }
    } finally {
      if (transcriptionController.current === controller) transcriptionController.current = null;
    }
  };

  const stopRecording = () => {
    if (recorder.current?.state === 'recording') recorder.current.stop();
  };

  const speak = () => {
    if (!('speechSynthesis' in window) || !transcript.trim()) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(transcript);
    utterance.onend = () => setPlayback(false);
    utterance.onerror = () => setPlayback(false);
    setPlayback(true);
    window.speechSynthesis.speak(utterance);
  };

  const stopPlayback = () => {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    setPlayback(false);
  };

  return <section className="voice-section" aria-labelledby="voice-heading">
    <div className="voice-head"><h2 id="voice-heading"><AudioLines size={16} /> Voice</h2>
      {!enabled && <span className="unavailable-label">Unavailable</span>}
    </div>
    {!enabled ? <p className="voice-hint">Voice input unavailable for this workspace.</p> : <>
      <div className="voice-actions">
        {(state === 'idle' || state === 'review') && <button className="button secondary" type="button" onClick={() => void begin()}>
          <Mic size={15} /> Record question
        </button>}
        {state === 'requesting' && <><span role="status">Requesting microphone</span><button className="button subtle" type="button" data-testid="discard-recording" onClick={cancelUtterance}><X size={14} /> Cancel</button></>}
        {state === 'recording' && <>
          <button className="button danger-outline" type="button" onClick={stopRecording}><Square size={13} fill="currentColor" /> Stop recording</button>
          <button className="button subtle" type="button" data-testid="discard-recording" onClick={cancelUtterance}><X size={14} /> Discard recording</button>
          <span className="recording-indicator"><span /> Recording · max 30 sec</span>
        </>}
        {state === 'transcribing' && <>
          <span role="status"><LoaderCircle className="spin" size={15} /> Transcribing</span>
          <button className="button danger-outline" type="button" data-testid="cancel-transcription" onClick={cancelUtterance}><X size={14} /> Cancel transcription</button>
        </>}
      </div>
      {state === 'review' && <div className="transcript-review" data-testid="transcript-review">
        <label htmlFor="transcript">Review transcript</label>
        <textarea id="transcript" value={transcript} onChange={(event) => setTranscript(event.currentTarget.value)} rows={2} />
        <div className="transcript-context"><ShieldCheck size={14} /> Attached references captured at record start:
          <span>{frozenIds.map((id) => referenceNames.get(id) ?? 'Unavailable reference').join(', ')}</span>
        </div>
        <div className="voice-actions">
          <button className="button secondary" type="button" onClick={speak} disabled={!('speechSynthesis' in window) || playback}><Play size={14} /> Play transcript</button>
          <button className="button secondary" type="button" onClick={stopPlayback} disabled={!playback}><Pause size={14} /> Stop playback</button>
          <button className="button primary" type="button" onClick={() => {
            if (transcript.trim()) onUseQuestion({ text: transcript.trim(), referenceIds: Object.freeze([...frozenIds]) });
            setState('idle');
            setTranscript('');
          }} disabled={!transcript.trim()}><Check size={14} /> Use this question</button>
          <button className="text-button" type="button" onClick={cancelUtterance}>Discard</button>
        </div>
      </div>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {!error && state === 'idle' && selectedReferenceIds.length === 0 && <p className="voice-hint">No references attached to a voice question.</p>}
    </>}
  </section>;
}

function ShareDialog({
  investigation,
  currentUser,
  users,
  onClose,
  onError,
  onUpdate,
}: {
  investigation: InvestigationRecord;
  currentUser: WorkspaceUser;
  users: WorkspaceUser[];
  onClose: () => void;
  onError: (error: unknown) => void;
  onUpdate: (investigation: InvestigationRecord) => void;
}) {
  const [selected, setSelected] = useState<string[]>(investigation.grants);
  const [busy, setBusy] = useState(false);
  const recipients = users.filter((candidate) => candidate.id !== currentUser.id);
  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const save = async (grantIds = selected) => {
    setBusy(true);
    try {
      const payload = await apiJson<ApiInvestigationPayload>(`/api/investigations/${encodeURIComponent(investigation.id)}/grants`, {
        method: 'PUT', body: jsonBody({ userIds: grantIds }),
      });
      onUpdate(payload.investigation);
      onClose();
    } catch (error) { onError(error); }
    finally { setBusy(false); }
  };
  return <Dialog title="Review sharing" onClose={onClose}>
    <p className="dialog-intro">Sharing grants access to this investigation's frozen references, evidence, and finding. It does not share separate private references.</p>
    <div className="share-preview">
      <span className="section-kicker">This investigation</span>
      <strong>{investigation.question}</strong>
      <span>{investigation.references.length} frozen references · {investigation.evidence.length} evidence items</span>
      {investigation.finding && <p>{investigation.finding.summary}</p>}
    </div>
    <fieldset className="recipient-list"><legend>People with access</legend>
      {recipients.length ? recipients.map((candidate) => <label key={candidate.id} className="recipient-row">
        <input type="checkbox" checked={selected.includes(candidate.id)} onChange={() => toggle(candidate.id)} />
        <span>{candidate.name}</span><small>{candidate.id}</small>
      </label>) : <p>No other shareable users are configured.</p>}
    </fieldset>
    <div className="dialog-actions">
      <button className="button secondary" type="button" onClick={onClose} disabled={busy}>Cancel</button>
      {investigation.grants.length > 0 && <button className="button danger-outline" type="button" disabled={busy} onClick={() => { setSelected([]); void save([]); }}><X size={14} /> Revoke all</button>}
      <button className="button primary" type="button" disabled={busy || recipients.length === 0} onClick={() => void save()}>
        {busy ? <LoaderCircle className="spin" size={15} /> : <Share2 size={14} />} Save access
      </button>
    </div>
  </Dialog>;
}

function ConfirmDialog({ title, message, actionLabel, onClose, onConfirm }: {
  title: string;
  message: string;
  actionLabel: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return <Dialog title={title} onClose={onClose}>
    <p className="dialog-intro">{message}</p>
    <div className="dialog-actions">
      <button className="button secondary" type="button" onClick={onClose}>Keep</button>
      <button className="button danger" type="button" onClick={onConfirm}><Trash2 size={14} /> {actionLabel}</button>
    </div>
  </Dialog>;
}

function Dialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
      <header className="dialog-header"><h2 id="dialog-title">{title}</h2><button type="button" className="icon-command" aria-label="Close dialog" onClick={onClose}><X size={17} /></button></header>
      <div className="dialog-body">{children}</div>
    </section>
  </div>;
}

function StatusBadge({ status }: { status: InvestigationRecord['status'] }) {
  return <span className={`status-badge status-${status}`}><span aria-hidden="true" />{capitalize(status)}</span>;
}

function Limitations({ items }: { items: readonly string[] }) {
  if (!items.length) return null;
  return <ul className="limitations">{items.map((item, index) => <li key={`${index}-${item}`}><AlertTriangle size={13} /> <span>{item}</span></li>)}</ul>;
}

function EmptyState({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return <div className="empty-state"><span>{icon}</span><strong>{title}</strong><p>{text}</p></div>;
}

function BrandMark() {
  return <span className="brand-mark" aria-hidden="true"><img src={brandLogoUrl} alt="" /></span>;
}

function sortInvestigations(items: InvestigationRecord[]): InvestigationRecord[] {
  return [...items].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function replaceInvestigation(items: InvestigationRecord[], next: InvestigationRecord): InvestigationRecord[] {
  return sortInvestigations(items.some((item) => item.id === next.id)
    ? items.map((item) => item.id === next.id ? next : item)
    : [next, ...items]);
}

function isActive(status: InvestigationRecord['status']): boolean {
  return status === 'queued' || status === 'running';
}

function messageForError(error: unknown): string {
  if (error instanceof WorkspaceApiError) return error.message;
  if (error instanceof Error && error.message.includes('references')) return error.message;
  return 'The request could not be completed. Check the local workspace and try again.';
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '0 sec';
  if (milliseconds < 60_000) return `${Math.ceil(milliseconds / 1_000)} sec`;
  return `${Math.ceil(milliseconds / 60_000)} min`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatCount(count: number): string {
  return new Intl.NumberFormat().format(count);
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Time unavailable';
}

function formatAbsoluteTime(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(date)
    : 'Time unavailable';
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
