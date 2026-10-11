import type { App } from "@slack/bolt";
import type { StateStore } from "../state.js";
import type { ServerPool } from "../opencode/server.js";
import type { OcFileDiff } from "../opencode/api.js";
import { sessionDiff } from "../opencode/client.js";
import { VIEW_DIFF_ACTION } from "./blocks.js";
import { enqueue } from "./queue.js";
import { SLACK_UPLOAD_TIMEOUT_MS } from "./transport.js";
import { sourceThreadTs } from "./source-thread.js";
import { logErr } from "../log.js";
import { esc, shortPath, truncate } from "../util.js";

export const DIFF_FILE_ACTION = "diff_file";
export const DIFF_DOWNLOAD_ACTION = "diff_download";
/** Per code section (Slack caps section text at 3,000) and per modal (Slack caps views at 100 blocks). */
const SECTION_CHARS = 2_900;
const MAX_SECTIONS = 40;
/** "Download full diff" uploads the whole patch or refuses; it never sends a partial file. */
export const DIFF_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;

export function formatDiffSummary(diffs: OcFileDiff[]): string {
  const totals = diffs.reduce(
    (a, d) => ({ add: a.add + d.additions, del: a.del + d.deletions }),
    { add: 0, del: 0 },
  );
  const lines = diffs.map((d) => `  \`+${d.additions}/−${d.deletions}\` ${shortPath(d.file)}`);
  return [`*Diff:* +${totals.add}/−${totals.del} across ${diffs.length} file(s)`, ...lines].join("\n");
}

/** Unified diff across files with real changes — `\diff full`. Empty when nothing changed. */
export function buildUnifiedDiff(diffs: OcFileDiff[]): string {
  return diffs
    .filter((d) => d.patch)
    .map((d) => d.patch)
    .join("\n")
    .trim();
}

/** One file's patch as ```diff sections under the section limit; `truncated` past MAX_SECTIONS. */
export function patchSections(patch: string): { sections: string[]; truncated: boolean } {
  const budget = SECTION_CHARS - 12; // fences + newlines
  const sections: string[] = [];
  let cur = "";
  for (const raw of esc(patch).split("\n")) {
    const line = raw.length > budget ? `${raw.slice(0, budget - 1)}…` : raw;
    if (cur && cur.length + line.length + 1 > budget) {
      sections.push(cur);
      cur = "";
      if (sections.length === MAX_SECTIONS) return { sections, truncated: true };
    }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) sections.push(cur);
  return { sections, truncated: false };
}

/** Where the "Download full diff" snippet lands: the button's thread root (session, channel, thread ts). */
export interface DiffMeta { s: string; c: string; t: string }

/** D1: the file-by-file diff modal — a file dropdown and one file's diff at a time. */
export function diffModal(diffs: OcFileDiff[], selected: number, meta: DiffMeta): Record<string, unknown> {
  const totals = diffs.reduce((a, d) => ({ add: a.add + d.additions, del: a.del + d.deletions }), { add: 0, del: 0 });
  const file = diffs[selected] ?? diffs[0]!;
  const option = (d: OcFileDiff, i: number) => ({
    text: { type: "plain_text", text: truncate(`+${d.additions}/−${d.deletions} ${shortPath(d.file)}`, 75) }, value: String(i) });
  const options = diffs.slice(0, 100).map(option);
  const { sections, truncated } = patchSections(file.patch ?? "");
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: `*+${totals.add}/−${totals.del}* across ${diffs.length} file(s) in this session` } },
    { type: "actions", elements: [{ type: "static_select", action_id: DIFF_FILE_ACTION, options,
      initial_option: options[Math.min(selected, options.length - 1)] }] },
    { type: "section", text: { type: "mrkdwn", text: `*${esc(shortPath(file.file))}*  \`+${file.additions}/−${file.deletions}\`` } },
    ...(sections.length ? sections.map(s => ({ type: "section", text: { type: "mrkdwn", text: `\`\`\`${s}\`\`\`` } }))
      : [{ type: "context", elements: [{ type: "mrkdwn", text: "No text diff for this file (binary or rename only)." }] }]),
  ];
  if (truncated) blocks.push(
    { type: "context", elements: [{ type: "mrkdwn", text: "This file's diff is too long to show here." }] },
    { type: "actions", elements: [{ type: "button", action_id: DIFF_DOWNLOAD_ACTION, value: String(selected),
      text: { type: "plain_text", text: "Download full diff" } }] },
  );
  return { type: "modal", callback_id: "diff_view", title: { type: "plain_text", text: "Changes" },
    close: { type: "plain_text", text: "Close" }, private_metadata: JSON.stringify(meta), blocks };
}

function loadingModal(): Record<string, unknown> {
  return { type: "modal", title: { type: "plain_text", text: "Changes" }, close: { type: "plain_text", text: "Close" },
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "Loading the diff…" } }] };
}

export function registerDiffActions(app: App, deps: {
  ownerSlackUserId: string;
  state: StateStore;
  pool: ServerPool;
  isStopping: () => boolean;
}): void {
  const { state, pool, isStopping } = deps;
  const diffsFor = async (sessionId: string): Promise<OcFileDiff[] | null> => {
    const bound = state.findThreadBySession(sessionId);
    if (!bound) return null;
    const entry = await pool.ensure(bound.thread.projectDir);
    return sessionDiff(entry.client!, sessionId);
  };
  const metaOf = (view: { private_metadata?: string } | undefined): DiffMeta | null => {
    try { return JSON.parse(view?.private_metadata ?? "") as DiffMeta; } catch { return null; }
  };

  // "📄 View changes" (finalize line, \diff, completion DMs) → modal. The
  // trigger expires in 3s, so open a loading view first and fill it after the fetch.
  app.action(VIEW_DIFF_ACTION, async ({ ack, body, action, respond }) => {
    await ack();
    if (isStopping()) return;
    if (body.user.id !== deps.ownerSlackUserId) {
      await respond({ text: "Only the paired owner can view diffs here.", response_type: "ephemeral", replace_original: false }).catch(() => {});
      return;
    }
    const sessionId = (action as { value?: string }).value;
    const container = (body as { container?: { channel_id?: string } }).container;
    const trigger = (body as { trigger_id?: string }).trigger_id;
    const thread = sourceThreadTs(body);
    if (!sessionId || !trigger || !container?.channel_id || !thread) return;
    try {
      const opened = await app.client.views.open({ trigger_id: trigger, view: loadingModal() as never });
      const diffs = await diffsFor(sessionId);
      const view = !diffs ? noticeModal("That session is no longer tracked here.")
        : !diffs.length ? noticeModal("No tracked edits in this session yet.")
          : diffModal(diffs, 0, { s: sessionId, c: container.channel_id, t: thread });
      await app.client.views.update({ view_id: opened.view!.id!, view: view as never });
    } catch (err) {
      logErr(`view_diff action failed (${sessionId}): ${String((err as Error)?.message ?? err)}`);
      await respond({ text: `Couldn't open the diff: ${String((err as Error)?.message ?? err).slice(0, 200)}`, response_type: "ephemeral", replace_original: false }).catch(() => {});
    }
  });

  // File dropdown inside the modal → re-render that file.
  app.action(DIFF_FILE_ACTION, async ({ ack, body, action }) => {
    await ack();
    const view = (body as { view?: { id: string; hash?: string; private_metadata?: string } }).view;
    const meta = metaOf(view);
    if (isStopping() || body.user.id !== deps.ownerSlackUserId || !view || !meta) return;
    try {
      const diffs = await diffsFor(meta.s);
      if (!diffs?.length) return;
      const index = Number((action as { selected_option?: { value?: string } }).selected_option?.value ?? 0);
      await app.client.views.update({ view_id: view.id, hash: view.hash, view: diffModal(diffs, index, meta) as never });
    } catch (err) {
      logErr(`diff file switch failed (${meta.s}): ${String((err as Error)?.message ?? err)}`);
    }
  });

  // Oversized file → upload its patch as a snippet where the button was tapped.
  app.action(DIFF_DOWNLOAD_ACTION, async ({ ack, body, action }) => {
    await ack();
    const meta = metaOf((body as { view?: { private_metadata?: string } }).view);
    if (isStopping() || body.user.id !== deps.ownerSlackUserId || !meta) return;
    try {
      const file = (await diffsFor(meta.s))?.[Number((action as { value?: string }).value ?? 0)];
      if (!file?.patch) return;
      const bytes = Buffer.byteLength(file.patch, "utf8");
      if (bytes > DIFF_DOWNLOAD_MAX_BYTES) {
        const text = `${shortPath(file.file)}'s diff is ${(bytes / 1024 / 1024).toFixed(1)} MB, over the ${DIFF_DOWNLOAD_MAX_BYTES / 1024 / 1024} MB download limit — nothing was uploaded.`;
        await enqueue(() => app.client.chat.postEphemeral({ channel: meta.c, user: body.user.id, thread_ts: meta.t, text }),
          { channel: meta.c, method: "chat.postEphemeral", lane: "interactive", thread: meta.t ?? "" });
        return;
      }
      const filename = `${shortPath(file.file).split("/").pop() || "file"}.diff`;
      await enqueue(() => app.client.filesUploadV2({ channel_id: meta.c, thread_ts: meta.t, filename, title: shortPath(file.file),
        content: file.patch }),
      { channel: meta.c, method: "files.upload", lane: "interactive", thread: meta.t ?? "", timeoutMs: SLACK_UPLOAD_TIMEOUT_MS, retryRateLimits: false });
    } catch (err) {
      logErr(`diff download failed (${meta.s}): ${String((err as Error)?.message ?? err)}`);
    }
  });
}

function noticeModal(text: string): Record<string, unknown> {
  return { ...loadingModal(), blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}
