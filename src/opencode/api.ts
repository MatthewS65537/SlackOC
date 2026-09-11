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
