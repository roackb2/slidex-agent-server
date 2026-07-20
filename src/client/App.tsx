import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FileText,
  KeyRound,
  Loader2,
  LogOut,
  MessageSquare,
  Plus,
  Send,
  Trash2,
  UserRound
} from "lucide-react";
import { createApiClient } from "./trpc.js";
import { hasSupabaseConfig, supabase, type SupabaseSession } from "./supabase.js";
import { streamAgent } from "./stream.js";
import type { AgentStreamEvent, Session, SessionSummary } from "../shared/schema.js";

const INITIAL_MOTION_DOC = "# New SlideX Deck\n\n---\n\n## Outline\n\n";

type StreamLine = {
  id: string;
  event: AgentStreamEvent;
};

export function App() {
  const [authSession, setAuthSession] = useState<SupabaseSession | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [motionDoc, setMotionDoc] = useState(INITIAL_MOTION_DOC);
  const [message, setMessage] = useState("");
  const [llmApiKey, setLlmApiKey] = useState("");
  const [model, setModel] = useState("gpt-4.1");
  const [streamLines, setStreamLines] = useState<StreamLine[]>([]);
  const [liveAssistant, setLiveAssistant] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const accessToken = authSession?.access_token ?? null;
  const api = useMemo(() => createApiClient(() => accessToken), [accessToken]);

  useEffect(() => {
    if (!supabase) {
      setAuthLoading(false);
      return;
    }

    supabase.auth.getSession().then(({ data }) => {
      setAuthSession(data.session);
      setAuthLoading(false);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthSession(session);
    });

    return () => {
      data.subscription.unsubscribe();
    };
  }, []);

  const loadSessions = useCallback(async () => {
    if (!accessToken) {
      setSessions([]);
      return;
    }
    const nextSessions = await api.sessions.list.query();
    setSessions(nextSessions);
  }, [accessToken, api]);

  useEffect(() => {
    loadSessions().catch((nextError) => setError(publicError(nextError)));
  }, [loadSessions]);

  const selectSession = async (sessionId: string) => {
    setError(null);
    const session = await api.sessions.get.query({ sessionId });
    setActiveSession(session);
    setMotionDoc(session.latestMotionDoc || INITIAL_MOTION_DOC);
    setStreamLines([]);
    setLiveAssistant("");
  };

  const createSession = async () => {
    setError(null);
    const session = await api.sessions.create.mutate({
      title: "Untitled deck",
      motionDoc
    });
    setActiveSession(session);
    await loadSessions();
  };

  const deleteSession = async (sessionId: string) => {
    setError(null);
    await api.sessions.delete.mutate({ sessionId });
    if (activeSession?.id === sessionId) {
      setActiveSession(null);
      setMotionDoc(INITIAL_MOTION_DOC);
      setStreamLines([]);
      setLiveAssistant("");
    }
    await loadSessions();
  };

  const submitMessage = async () => {
    if (!accessToken || isStreaming || !message.trim() || !llmApiKey.trim()) {
      return;
    }

    setError(null);
    setIsStreaming(true);
    setLiveAssistant("");
    setStreamLines([]);
    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      let session = activeSession;
      if (!session) {
        session = await api.sessions.create.mutate({
          title: message.trim().slice(0, 80),
          motionDoc
        });
        setActiveSession(session);
      }

      const userMessage = message;
      setMessage("");

      await streamAgent(
        {
          sessionId: session.id,
          message: userMessage,
          motionDoc,
          modelCredential: {
            type: "api-key",
            provider: "openai",
            apiKey: llmApiKey
          },
          model
        },
        accessToken,
        (event) => {
          setStreamLines((lines) => [
            ...lines,
            {
              id: `${Date.now()}-${lines.length}`,
              event
            }
          ]);

          if (event.type === "token") {
            setLiveAssistant((text) => `${text}${event.text}`);
          }
          if (event.type === "motionDoc") {
            setMotionDoc(event.motionDoc);
          }
          if (event.type === "session" || event.type === "complete") {
            setActiveSession(event.session);
          }
          if (event.type === "error") {
            setError(event.message);
          }
        },
        abortController.signal
      );

      await loadSessions();
    } catch (nextError) {
      if (!(nextError instanceof DOMException && nextError.name === "AbortError")) {
        setError(publicError(nextError));
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  };

  const signOut = async () => {
    await supabase?.auth.signOut();
    setAuthSession(null);
    setSessions([]);
    setActiveSession(null);
    setMotionDoc(INITIAL_MOTION_DOC);
    setLlmApiKey("");
  };

  if (!hasSupabaseConfig) {
    return <MissingConfig />;
  }

  if (authLoading) {
    return (
      <main className="center-shell">
        <Loader2 className="spin" size={24} />
      </main>
    );
  }

  if (!authSession) {
    return <LoginScreen />;
  }

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Sessions">
        <div className="brand-row">
          <div>
            <p className="eyebrow">SlideX</p>
            <h1>Agent</h1>
          </div>
          <button className="icon-button" title="Sign out" type="button" onClick={signOut}>
            <LogOut size={18} />
          </button>
        </div>

        <button className="primary-action" type="button" onClick={createSession}>
          <Plus size={18} />
          New session
        </button>

        <div className="session-list">
          {sessions.map((item) => (
            <button
              className={`session-row ${activeSession?.id === item.id ? "is-active" : ""}`}
              key={item.id}
              type="button"
              onClick={() => selectSession(item.id).catch((nextError) => setError(publicError(nextError)))}
            >
              <FileText size={16} />
              <span>{item.title}</span>
              <small>{item.messageCount}</small>
            </button>
          ))}
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">MotionDoc</p>
            <h2>{activeSession?.title ?? "Untitled deck"}</h2>
          </div>
          <div className="user-pill">
            <UserRound size={16} />
            <span>{authSession.user.email ?? authSession.user.id}</span>
          </div>
        </header>

        <div className="main-grid">
          <section className="doc-pane" aria-label="MotionDoc editor">
            <textarea
              value={motionDoc}
              onChange={(event) => setMotionDoc(event.target.value)}
              spellCheck={false}
            />
          </section>

          <section className="chat-pane" aria-label="Agent chat">
            <div className="stream-log">
              {activeSession?.messages.map((item) => (
                <article className={`message-row role-${item.role}`} key={item.id}>
                  <strong>{item.role}</strong>
                  <p>{item.content}</p>
                </article>
              ))}

              {streamLines.map((line) => (
                <StreamLineView key={line.id} line={line.event} />
              ))}

              {liveAssistant && (
                <article className="message-row role-assistant">
                  <strong>assistant</strong>
                  <p>{liveAssistant}</p>
                </article>
              )}
            </div>

            {error && <div className="error-banner">{error}</div>}

            <div className="composer">
              <label className="field key-field">
                <span>
                  <KeyRound size={15} />
                  LLM API key
                </span>
                <input
                  value={llmApiKey}
                  onChange={(event) => setLlmApiKey(event.target.value)}
                  type="password"
                  autoComplete="off"
                  placeholder="sk-..."
                />
              </label>
              <label className="field model-field">
                <span>Model</span>
                <input value={model} onChange={(event) => setModel(event.target.value)} />
              </label>
              <textarea
                className="message-input"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    submitMessage();
                  }
                }}
                placeholder="Ask the agent to create or revise this deck"
              />
              <div className="composer-actions">
                <button
                  className="secondary-action"
                  type="button"
                  disabled={!activeSession}
                  onClick={() => activeSession && deleteSession(activeSession.id)}
                >
                  <Trash2 size={17} />
                  Delete
                </button>
                {isStreaming ? (
                  <button
                    className="secondary-action"
                    type="button"
                    onClick={() => abortRef.current?.abort()}
                  >
                    Stop
                  </button>
                ) : (
                  <button
                    className="send-button"
                    type="button"
                    disabled={!message.trim() || !llmApiKey.trim()}
                    onClick={submitMessage}
                  >
                    <Send size={17} />
                    Send
                  </button>
                )}
              </div>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}

function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!supabase || !email || !password) {
      return;
    }

    setBusy(true);
    setError(null);
    const result =
      mode === "sign-in"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });

    if (result.error) {
      setError(result.error.message);
    }
    setBusy(false);
  };

  return (
    <main className="center-shell">
      <section className="auth-panel">
        <div>
          <p className="eyebrow">SlideX</p>
          <h1>Agent login</h1>
        </div>
        <div className="segmented">
          <button
            className={mode === "sign-in" ? "is-active" : ""}
            type="button"
            onClick={() => setMode("sign-in")}
          >
            Sign in
          </button>
          <button
            className={mode === "sign-up" ? "is-active" : ""}
            type="button"
            onClick={() => setMode("sign-up")}
          >
            Sign up
          </button>
        </div>
        <label className="field">
          <span>Email</span>
          <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
          />
        </label>
        {error && <div className="error-banner">{error}</div>}
        <button className="send-button" type="button" disabled={busy} onClick={submit}>
          {busy ? <Loader2 className="spin" size={17} /> : <MessageSquare size={17} />}
          Continue
        </button>
      </section>
    </main>
  );
}

function MissingConfig() {
  return (
    <main className="center-shell">
      <section className="auth-panel">
        <p className="eyebrow">Environment</p>
        <h1>Supabase config missing</h1>
        <p className="muted">Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.</p>
      </section>
    </main>
  );
}

function StreamLineView({ line }: { line: AgentStreamEvent }) {
  if (line.type === "status") {
    return <div className="event-line">Status: {line.message}</div>;
  }
  if (line.type === "tool") {
    return (
      <div className={`event-line tool-${line.status}`}>
        Tool: {line.name} {line.status}
      </div>
    );
  }
  if (line.type === "error") {
    return <div className="event-line is-error">Error: {line.message}</div>;
  }
  if (line.type === "complete") {
    return <div className="event-line is-complete">Complete</div>;
  }
  return null;
}

function publicError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
