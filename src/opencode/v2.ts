/** V2 wire-to-view adapter. Keep Slack rendering independent of the generated API. */
import type { FormInfo, FormAnswer, SessionMessageInfo, SessionMessageAssistantTool, V2Event } from "@opencode/client";
import { normalizePermission, type OcEvent, type OcMessageInfo, type OcPart, type OcQuestionRequest } from "./api.js";

export function normalizeForm(form: FormInfo): OcQuestionRequest {
  return { id: form.id, sessionID: form.sessionID, form,
    tool: typeof form.metadata?.messageID === "string" ? {
      messageID: form.metadata.messageID, callID: String(form.metadata.callID ?? form.metadata.id ?? ""),
    } : undefined,
    questions: form.fields.map(field => ({
      header: field.title || form.title || "Question", question: field.description || field.title || field.key,
      options: "options" in field ? (field.options ?? []).map(o => ({ ...o, description: o.description ?? "" }))
        : field.type === "boolean" ? [{ label: "Yes", value: "true", description: "" }, { label: "No", value: "false", description: "" }] : [],
      multiple: field.type === "multiselect",
      custom: field.type === "string" || field.type === "multiselect"
        ? field.custom === true || !field.options?.length : field.type === "number" || field.type === "integer",
      field,
    })) };
}

export function formAnswer(req: OcQuestionRequest, answers: string[][]): FormAnswer {
  if (!req.form) throw new Error("Question is missing its V2 form contract");
  const result: FormAnswer = {};
  for (const [i, field] of req.form.fields.entries()) {
    if (field.type === "external" || ("hidden" in field && field.hidden)) continue;
    const values = answers[i] ?? [];
    if (!values.length) {
      if (field.default !== undefined) result[field.key] = field.default;
      else if (field.type === "multiselect") result[field.key] = [];
      continue;
    }
    const value = values[0]!;
    switch (field.type) {
      case "boolean":
        if (value !== "true" && value !== "false") throw new Error("Choose Yes or No");
        result[field.key] = value === "true"; break;
      case "integer": case "number": {
        const n = Number(value);
        if (!value.trim() || !Number.isFinite(n) || (field.type === "integer" && !Number.isInteger(n))) throw new Error("Enter a valid number");
        result[field.key] = n; break;
      }
      case "multiselect": result[field.key] = values; break;
      default: result[field.key] = value;
    }
  }
  for (const field of req.form.fields) {
    if (field.type !== "external" && field.when?.some(c => c.op === "eq" ? result[c.key] !== c.value : result[c.key] === c.value)) delete result[field.key];
  }
  return result;
}

export function visibleQuestions(req: OcQuestionRequest, answers: string[][]): boolean[] {
  const values = req.form ? formAnswer(req, answers) : {};
  return req.questions.map(q => {
    const f = q.field;
    if (!f || f.type === "external") return true;
    if (f.hidden) return false;
    return !f.when?.some(condition => condition.op === "eq"
      ? values[condition.key] !== condition.value : values[condition.key] === condition.value);
  });
}

export function toolPart(tool: SessionMessageAssistantTool, sessionID: string, messageID: string): OcPart {
  const state = tool.state;
  return { id: tool.id, callID: tool.id, sessionID, messageID, type: "tool", tool: tool.name,
    state: { status: state.status, input: "input" in state && typeof state.input === "object" ? state.input : {},
      metadata: "metadata" in state ? state.metadata : undefined,
      output: "content" in state ? state.content?.filter(c => c.type === "text").map(c => c.text).join("\n") : undefined,
      error: "error" in state ? state.error.message : undefined,
      time: { start: tool.time.ran ?? tool.time.created, end: tool.time.completed } } };
}

function toolFiles(content: Array<{ type: string; uri?: string; mime?: string; name?: string | null }> | undefined, id: string, sessionID: string, messageID: string): OcPart[] {
  return (content ?? []).flatMap((c, i) => c.type === "file" ? [{ id: `${id}:file:${i}`, type: "file", sessionID, messageID,
    url: c.uri, mime: c.mime, filename: c.name ?? undefined }] : []);
}

export function normalizeMessages(messages: SessionMessageInfo[], sessionID: string): Array<{ info: OcMessageInfo; parts: OcPart[] }> {
  let parentID: string | undefined;
  const rows: Array<{ info: OcMessageInfo; parts: OcPart[] }> = [];
  for (const m of messages) {
    if (m.type !== "user" && m.type !== "assistant") continue;
    if (m.type === "user") parentID = m.id;
    const info: OcMessageInfo = { id: m.id, sessionID, role: m.type, time: m.time,
      ...(m.type === "assistant" ? { parentID, finish: m.finish, modelID: m.model.id, providerID: m.model.providerID,
        cost: m.cost, tokens: m.tokens, error: m.error ? { name: m.error.type, data: { message: m.error.message } } : undefined } : {}) };
    const parts: OcPart[] = m.type === "user" ? [{ id: `${m.id}:text`, messageID: m.id, sessionID, type: "text", text: m.text }]
      : m.content.flatMap((p, ordinal): OcPart[] => {
        if (p.type === "tool") return [toolPart(p, sessionID, m.id), ...toolFiles("content" in p.state ? p.state.content : undefined, p.id, sessionID, m.id)];
        return [{ id: `${m.id}:${ordinal}`, messageID: m.id, sessionID, type: p.type, text: p.text,
          time: { end: m.time.completed } }];
      });
    rows.push({ info, parts });
  }
  return rows;
}

/** Synchronous translation; never block the live event reader on Slack I/O. */
export class V2Events {
  private tools = new Map<string, OcPart>();
  private messages = new Map<string, OcMessageInfo>();
  private parents = new Map<string, string>();
  private idle = new Set<string>();
  private text = new Map<string, { text: string; emitted: number }>();
  translate(event: V2Event): OcEvent[] {
    const d = event.data;
    const emit = (type: string, properties: object): OcEvent[] => [{ type, properties: { ...properties } }];
    switch (event.type) {
      case "server.connected": return emit(event.type, {});
      case "permission.asked": return emit(event.type, normalizePermission(d as Record<string, unknown>));
      case "permission.replied": return emit(event.type, d);
      case "form.created": return emit("question.asked", normalizeForm(event.data.form));
      case "form.replied": return emit("question.replied", event.data);
      case "form.cancelled": return emit("question.rejected", event.data);
      case "session.inbox.enqueued": {
        if (event.data.item.type !== "user") return [];
        const { sessionID, inboxID } = event.data;
        // Admission is not delivery; later queued inputs must not become parents early.
        return emit("message.updated", { info: { id: inboxID, sessionID, role: "user", time: { created: event.created } } });
      }
      case "session.inbox.delivered": this.parents.set(event.data.sessionID, event.data.inboxID); return [];
      case "session.step.started": {
        const p = event.data;
        const info: OcMessageInfo = { id: p.assistantMessageID, sessionID: p.sessionID, role: "assistant",
          parentID: this.parents.get(p.sessionID), modelID: p.model.id, providerID: p.model.providerID, time: { created: p.started } };
        this.messages.set(info.id, info);
        return emit("message.updated", { info });
      }
      case "session.step.ended": case "session.step.failed": {
        const p = event.data;
        const prior = this.messages.get(p.assistantMessageID);
        const info: OcMessageInfo = { ...prior, id: p.assistantMessageID, sessionID: p.sessionID, role: "assistant",
          finish: p.finish, cost: p.cost, tokens: p.tokens, time: { created: prior?.time?.created ?? event.created, completed: event.created },
          error: "error" in p ? { name: p.error.type, data: { message: p.error.message } } : undefined };
        this.messages.delete(info.id);
        return emit("message.updated", { info });
      }
      case "session.text.ended": {
        const p = event.data;
        this.text.delete(`${p.assistantMessageID}:${p.ordinal}`);
        return emit("message.part.updated", { part: { id: `${p.assistantMessageID}:${p.ordinal}`, sessionID: p.sessionID,
          messageID: p.assistantMessageID, type: "text", text: p.text, time: { end: event.created } } });
      }
      case "session.text.delta": case "session.reasoning.delta": {
        const p = event.data;
        const id = `${p.assistantMessageID}:${p.ordinal}`;
        const prior = this.text.get(id) ?? { text: "", emitted: 0 };
        prior.text += p.delta;
        this.text.set(id, prior);
        if (event.created - prior.emitted < 500) return [];
        prior.emitted = event.created;
        return emit("message.part.updated", { part: { id, sessionID: p.sessionID, messageID: p.assistantMessageID,
          type: event.type === "session.text.delta" ? "text" : "reasoning", text: prior.text } });
      }
      case "session.reasoning.ended":
        this.text.delete(`${event.data.assistantMessageID}:${event.data.ordinal}`); return [];
      case "session.tool.input.started": {
        const p = event.data;
        this.tools.set(p.id, { id: p.id, callID: p.id, sessionID: p.sessionID, messageID: p.assistantMessageID,
          type: "tool", tool: p.name, state: { status: "pending" } });
        return [];
      }
      case "session.tool.called": case "session.tool.progress": case "session.tool.success": case "session.tool.failed": {
        const p = event.data;
        const prior = this.tools.get(p.id);
        const part: OcPart = { ...prior, id: p.id, callID: p.id, sessionID: p.sessionID, messageID: p.assistantMessageID,
          type: "tool", tool: prior?.tool ?? "tool", state: { ...prior?.state,
            status: event.type === "session.tool.success" ? "completed" : event.type === "session.tool.failed" ? "error" : "running",
            ...("input" in p ? { input: p.input } : {}), ...("metadata" in p ? { metadata: p.metadata } : {}),
            ...("content" in p ? { output: p.content?.filter(c => c.type === "text").map(c => c.text).join("\n") } : {}),
            ...("error" in p ? { error: p.error.message } : {}) } };
        if (part.state?.status === "completed" || part.state?.status === "error") this.tools.delete(p.id);
        else this.tools.set(p.id, part);
        return [...emit("message.part.updated", { part }), ...("content" in p && event.type === "session.tool.success"
          ? toolFiles(p.content, p.id, p.sessionID, p.assistantMessageID).flatMap(file => emit("message.part.updated", { part: file })) : [])];
      }
      case "session.execution.started":
        this.idle.delete(event.data.sessionID);
        return emit("session.status", { sessionID: event.data.sessionID, status: { type: "busy" } });
      case "session.status":
        if (event.data.status.type !== "idle") { this.idle.delete(event.data.sessionID); return emit(event.type, d); }
        if (this.idle.has(event.data.sessionID)) return [];
        this.idle.add(event.data.sessionID); return emit(event.type, d);
      case "session.execution.succeeded": case "session.idle":
        if (this.idle.has(event.data.sessionID)) return [];
        this.idle.add(event.data.sessionID);
        return emit("session.idle", { sessionID: event.data.sessionID });
      case "session.execution.failed": return emit("session.error", { sessionID: event.data.sessionID, error: event.data.error.message });
      case "session.execution.interrupted": return emit("session.error", { sessionID: event.data.sessionID, error: "Run interrupted" });
      default: return [];
    }
  }
}
