/**
 * Narrow structural types for the parts of OpenCode's HTTP API that SlackOC
 * depends on. Deliberately decoupled from @opencode-ai/sdk's generated types
 * so SDK upgrades don't silently break event handling.
 */

export interface OcSession {
  id: string;
  directory: string;
  title: string;
  /** Set on subagent (child) sessions. */
  parentID?: string | null;
  /** Set on forks (\fork); a fork is a sibling, not a subagent. */
  fork?: { sessionID: string };
  /** Staged (uncommitted) \undo boundary; its file edits are already applied. */
  revert?: { messageID: string; files?: OcFileDiff[] };
  summary?: { additions: number; deletions: number; files: number };
  time: { created: number; updated: number };
}

export interface OcFileDiff {
  file: string;
  additions: number;
  deletions: number;
  patch: string;
}

export interface OcToolState {
  status?: string;
  input?: Record<string, unknown>;
  title?: string;
  output?: unknown;
  error?: unknown;
  metadata?: Record<string, unknown>;
  time?: { start?: number; end?: number };
}

export interface OcPart {
  id: string;
  sessionID?: string;
  messageID?: string;
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: OcToolState;
  /** File parts (model-produced images etc.): data: URI or OpenCode-server URL. */
  mime?: string;
  filename?: string;
  url?: string;
  time?: { start?: number; end?: number };
}

export interface OcMessageInfo {
  id: string;
  sessionID: string;
  role: string;
  /** Assistant's originating user message; useful when reconciling queued turns. */
  parentID?: string;
  /** Provider finish reason, e.g. stop or tool-calls; completed time alone is insufficient. */
  finish?: string;
  summary?: boolean;
  modelID?: string;
  providerID?: string;
  error?: { name?: string; data?: Record<string, unknown> } | null;
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number };
  time?: { created: number; completed?: number };
}

export interface OcPermission {
  id: string;
  sessionID: string;
  messageID?: string;
  callID?: string;
  type: string;
  pattern?: string | string[];
  title: string;
  metadata?: Record<string, unknown>;
  time?: { created: number };
}

/** Maps a V2 PermissionRequest (`action`/`resources`/`source`) onto the OcPermission the renderer consumes. */
export function normalizePermission(props: Record<string, unknown>): OcPermission {
  const source = props.source as { messageID?: string; id?: string } | undefined;
  return { id: String(props.id), sessionID: String(props.sessionID), type: String(props.action),
    title: String(props.message ?? props.action), pattern: props.resources as string[],
    metadata: props.metadata as Record<string, unknown> | undefined,
    messageID: source?.messageID, callID: source?.id };
}

/** One selectable choice in a question (label is what gets sent back). */
export interface OcQuestionOption {
  label: string;
  description: string;
  value?: string;
}

/** A single question in a QuestionRequest. */
export interface OcQuestionInfo {
  question: string;
  header: string;
  options: OcQuestionOption[];
  /** Multi-select (V2 `multiselect`): options toggle, then "Submit selection" sends them. */
  multiple?: boolean;
  /** Accepts a typed answer (free text or a number) via the "Type your own answer" modal. */
  custom?: boolean;
  field?: import("@opencode/client").FormField;
}

/**
 * A parked, blocking question. The server holds the tool call open until a
 * client replies or rejects; the announcement arrives as SSE `question.asked`.
 * Normalized from a V2 form (`form.created` / `GET /api/form`) by normalizeForm.
 */
export interface OcQuestionRequest {
  id: string;
  sessionID: string;
  questions: OcQuestionInfo[];
  tool?: { messageID: string; callID: string };
  form?: import("@opencode/client").FormInfo;
}

/** The V2 adapter reports running sessions as busy; absent means idle. */
export type OcSessionStatus = { type: "idle" } | { type: "busy" };

export interface OcSessionStatusPayload {
  sessionID?: string;
  status?: { type: string; message?: string; attempt?: number };
}

export interface OcEvent {
  type: string;
  directory?: string;
  properties?: OcSessionStatusPayload & {
    part?: OcPart;
    info?: OcMessageInfo;
    file?: string;
    [k: string]: unknown;
  };
}

/** Stable bridge-facing port. Wire contracts are implemented by the V2 adapter. */
type Call = (input?: any) => Promise<any>;
export interface OCClient {
  v2?: import("@opencode/client").OpenCodeClient;
  directory?: string;
  session: { status: Call; create: Call; get: Call; messages: Call; list: Call; diff: Call;
    abort: Call; delete: Call; promptAsync: Call; command: Call; fork: Call;
    revertStage: Call; revertCommit: Call; revertClear: Call; inboxUpdate: Call; inboxCancel: Call };
  config: { providers: Call; get: Call };
  app: { agents: Call };
  postSessionIdPermissionsPermissionId: Call;
  commands: Call; projectId: Call; stats: Call;
}
