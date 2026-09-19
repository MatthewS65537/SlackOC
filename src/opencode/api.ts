/**
 * Narrow structural types for the parts of OpenCode's HTTP API that SlackOC
 * depends on. Deliberately decoupled from @opencode-ai/sdk's generated types
 * so SDK upgrades don't silently break event handling.
 */

export interface OcSession {
  id: string;
  directory: string;
  title: string;
  summary?: { additions: number; deletions: number; files: number };
  time: { created: number; updated: number };
}

export interface OcFileDiff {
  file: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
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

/**
 * opencode auto-updates and renamed the permission-ask event: ≤1.18.25 emits
 * `permission.updated` with the legacy shape below; ≥1.18.2x emits
 * `permission.asked` with `{permission, patterns, metadata, always, tool?}`.
 * The bridge must accept BOTH — otherwise a routine auto-update silently drops
 * every permission ask (verified: the 1.18.30 binary has 0 `permission.updated`
 * strings). Maps the new shape onto the legacy OcPermission the renderer
 * already consumes; legacy payloads pass through untouched.
 */
export function normalizePermission(props: Record<string, unknown>): OcPermission {
  // New shape discriminator: a string `permission` field (legacy uses `type`).
  if (typeof props.permission === "string") {
    const permission = props.permission;
    const metadata = (props.metadata ?? {}) as Record<string, unknown>;
    const tool = props.tool as { messageID?: string; callID?: string } | undefined;
    return {
      id: String(props.id ?? ""),
      sessionID: String(props.sessionID ?? ""),
      messageID: tool?.messageID,
      callID: tool?.callID,
      type: permission,
      pattern: Array.isArray(props.patterns) ? (props.patterns as string[]) : undefined,
      title: typeof metadata.title === "string" ? metadata.title : permission,
      metadata,
    };
  }
  return props as unknown as OcPermission;
}

/** One selectable choice in a question (label is what gets sent back). */
export interface OcQuestionOption {
  label: string;
  description: string;
}

/** A single question in a QuestionRequest. */
export interface OcQuestionInfo {
  question: string;
  header: string;
  options: OcQuestionOption[];
  /** Multi-select — deferred this round; only single-select is rendered. */
  multiple?: boolean;
  /** Free-text answer — deferred this round. */
  custom?: boolean;
}

/**
 * A parked, blocking question. The server holds the tool call open until a
 * client replies or rejects; the announcement arrives as SSE `question.asked`.
 * Mirrors QuestionRequest from the opencode API (v1 endpoints, no /api prefix).
 */
export interface OcQuestionRequest {
  id: string;
  sessionID: string;
  questions: OcQuestionInfo[];
  tool?: { messageID: string; callID: string };
}

export type OcSessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number };

export interface OcSessionStatusPayload {
  sessionID?: string;
  status?: { type: string; message?: string; attempt?: number };
}

export interface OcEvent {
  type: string;
  properties?: OcSessionStatusPayload & {
    part?: OcPart;
    info?: OcMessageInfo;
    file?: string;
    [k: string]: unknown;
  };
}

/** The v1 SDK client instance (createOpencodeClient), typed loosely. */
export type OCClient = ReturnType<
  typeof import("@opencode-ai/sdk").createOpencodeClient
>;
