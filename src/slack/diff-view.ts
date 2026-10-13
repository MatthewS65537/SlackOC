import { randomUUID } from "node:crypto";
import type { App } from "@slack/bolt";
import type { StateStore } from "../state.js";
import type { ServerPool } from "../opencode/server.js";
import type { OcFileDiff } from "../opencode/api.js";
import { sessionDiff, sessionGet } from "../opencode/client.js";
import { loadConfig } from "../config.js";
import { execFileAsync, formatArgv, gitBranch, loadShipInputs, MAIN_BRANCHES, planShip, runShip, shipResultText,
  type DirtyFile, type ExecFileFn, type ShipField, type ShipInput, type ShipInputs } from "../ship.js";
import { SHIP_OPEN_ACTION, shipButton, VIEW_DIFF_ACTION } from "./blocks.js";
import { getView } from "./render.js";
import { enqueue } from "./queue.js";
import { SLACK_UPLOAD_TIMEOUT_MS } from "./transport.js";
import { sourceThreadTs } from "./source-thread.js";
import { safeCodePayload } from "./tool-format.js";
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
      initial_option: options[Math.min(selected, options.length - 1)] }, shipButton(meta.s)] },
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

export const SHIP_SUBMIT = "ship_submit";
const FILE_BLOCKS = { s: "files_session", o: "files_other" } as const;
/** Slack caps checkboxes at 10 options and multi-selects at 100. */
const MAX_CHECKBOXES = 10;
const MAX_FILE_OPTIONS = 100;

/** One open Ship modal (C1), keyed by its private_metadata token. In-memory: a restart expires it. */
interface ShipPanel extends ShipInputs {
  sessionId: string;
  /** Where the result line goes: the session's bound thread, wherever the button was tapped. */
  channel: string;
  thread: string;
}

function shipNotice(text: string): Record<string, unknown> {
  return { type: "modal", title: { type: "plain_text", text: "🚀 Ship" }, close: { type: "plain_text", text: "Close" },
    blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}

/** `M src/a.ts`, `R old → new`: status code first, long paths keep their tail (Slack option text caps at 75). */
function fileLabel(f: DirtyFile): string {
  const name = f.orig !== undefined ? `${f.orig} → ${f.path}` : f.path;
  const room = 75 - f.code.length - 1;
  return `${f.code.trim()} ${name.length > room ? `…${name.slice(-(room - 1))}` : name}`;
}

function fileInput(kind: keyof typeof FILE_BLOCKS, files: DirtyFile[]): Record<string, unknown> {
  const options = files.slice(0, MAX_FILE_OPTIONS).map((f, i) => ({ text: { type: "plain_text", text: fileLabel(f) }, value: `${kind}${i}` }));
  const ticked = kind === "s" ? { initial_options: options } : {};
  const element = options.length <= MAX_CHECKBOXES ? { type: "checkboxes", action_id: "v", options, ...ticked }
    : { type: "multi_static_select", action_id: "v", options, placeholder: { type: "plain_text", text: "Pick files" }, ...ticked };
  const hidden = files.length - options.length;
  return { type: "input", block_id: FILE_BLOCKS[kind], optional: true, element,
    label: { type: "plain_text", text: kind === "s" ? "Files this session changed" : "Other uncommitted files" },
    ...(hidden > 0 ? { hint: { type: "plain_text", text: `${hidden} more not listed; commit those from a terminal.` } } : {}) };
}

/**
 * C1: branch, files (session ones pre-ticked), message, opt-in Push/PR. Slack
 * modals can't cheaply re-render a live preview, so the context line shows the
 * commands for the defaults; the real choices are planned and validated on submit.
 */
function shipModal(panel: ShipPanel, token: string): Record<string, unknown> {
  const { current, top, sessionFiles, otherFiles, newBranch, message } = panel;
  const onMain = MAIN_BRANCHES.includes(current ?? "");
  const radio = [{ text: { type: "plain_text", text: "New branch" }, value: "new" },
    { text: { type: "plain_text", text: truncate(`Current branch (${current})`, 75) }, value: "current" }];
  const preview = planShip({ current, branch: onMain ? "new" : "current", newBranch, message, push: true, pr: true, allowMainPush: true,
    files: sessionFiles.length ? sessionFiles : [{ path: "<ticked files>" }] });
  const line = (argv: string[]) => `\`${safeCodePayload(truncate(formatArgv(argv), 300))}\``;
  const steps = "steps" in preview ? preview.steps : [];
  const publish = steps.filter(s => s[1] === "push" || s[0] === "gh");
  const commands = [`*Will run* in \`${safeCodePayload(top)}\` (execFile, never a shell):`,
    ...steps.filter(s => !publish.includes(s)).map(line),
    ...publish.map(s => `${s[0] === "gh" ? "With Draft PR" : "With Push"}: ${line(s)}`),
    "Your final choices are checked again when you tap Ship."].join("\n");
  const blocks: unknown[] = [
    { type: "input", block_id: "branch", label: { type: "plain_text", text: "Branch" },
      element: { type: "radio_buttons", action_id: "v", options: radio, initial_option: radio[onMain ? 0 : 1] } },
    { type: "input", block_id: "branch_name", optional: true, label: { type: "plain_text", text: "New branch name" },
      element: { type: "plain_text_input", action_id: "v", initial_value: newBranch, max_length: 200 } },
    ...(sessionFiles.length ? [fileInput("s", sessionFiles)] : []),
    ...(otherFiles.length ? [fileInput("o", otherFiles)] : []),
    { type: "input", block_id: "message", label: { type: "plain_text", text: "Commit message" },
      element: { type: "plain_text_input", action_id: "v", multiline: true, initial_value: truncate(message, 3_000), max_length: 3_000 } },
    { type: "input", block_id: "publish", optional: true, label: { type: "plain_text", text: "Publish (off unless ticked)" },
      element: { type: "checkboxes", action_id: "v", options: [
        { text: { type: "plain_text", text: "Push to origin" }, value: "push" },
        { text: { type: "plain_text", text: "Open a draft PR (gh)" }, value: "pr" }] } },
    { type: "context", elements: [{ type: "mrkdwn", text: truncate(commands, 2_900) }] },
  ];
  return { type: "modal", callback_id: SHIP_SUBMIT, title: { type: "plain_text", text: "🚀 Ship changes" },
    submit: { type: "plain_text", text: "Ship" }, close: { type: "plain_text", text: "Cancel" }, private_metadata: token, blocks };
}

type ShipValues = Record<string, { v?: { selected_option?: { value?: string } | null; selected_options?: Array<{ value?: string }>;
  value?: string | null } }>;

/** The submitted modal state → planner input. File option values index the panel's lists (`s3`, `o0`). */
function shipChoices(panel: ShipPanel, values: ShipValues, allowMainPush: boolean): ShipInput {
  const picked = (block: string) => (values[block]?.v?.selected_options ?? []).map(o => o.value ?? "");
  const files = [...picked(FILE_BLOCKS.s), ...picked(FILE_BLOCKS.o)]
    .map(v => (v[0] === "s" ? panel.sessionFiles : panel.otherFiles)[Number(v.slice(1))])
    .filter((f): f is DirtyFile => f !== undefined);
  const publish = picked("publish");
  return { current: panel.current, branch: values.branch?.v?.selected_option?.value === "new" ? "new" : "current",
    newBranch: values.branch_name?.v?.value ?? "", files, message: values.message?.v?.value ?? "",
    push: publish.includes("push"), pr: publish.includes("pr"), allowMainPush };
}

export function registerDiffActions(app: App, deps: {
  ownerSlackUserId: string;
  state: StateStore;
  pool: ServerPool;
  isStopping: () => boolean;
  /** Read at submit time so a config edit applies without a restart. */
  allowMainPush?: () => boolean;
  /** Tests inject a fake; production runs git/gh through execFile. */
  shipExec?: ExecFileFn;
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

  registerShip(app, deps);
}

function registerShip(app: App, deps: Parameters<typeof registerDiffActions>[1]): void {
  const { state, pool, isStopping } = deps;
  const exec = deps.shipExec ?? execFileAsync;
  const allowMainPush = deps.allowMainPush ?? (() => loadConfig()?.ship?.allowMainPush === true);
  const panels = new Map<string, ShipPanel>();
  /** Repo roots with a ship in flight: a second one would trip over git's index lock. */
  const running = new Set<string>();

  const shipView = async (sessionId: string): Promise<Record<string, unknown>> => {
    const bound = state.findThreadBySession(sessionId);
    if (!bound) return shipNotice("That session is no longer tracked here.");
    if (getView(sessionId)) return shipNotice("A run is active in this thread. Ship after it finishes.");
    const { projectDir } = bound.thread;
    const client = (await pool.ensure(projectDir)).client!;
    const [diffs, session] = await Promise.all([sessionDiff(client, sessionId).catch(() => []),
      sessionGet(client, sessionId).catch(() => null)]);
    const inputs = await loadShipInputs(client, projectDir, sessionId, { title: session?.title ?? "", diffs }, exec);
    if (!inputs) return shipNotice(`\`${safeCodePayload(projectDir)}\` isn't inside a git repository.`);
    if (inputs.current === null) return shipNotice("HEAD is detached here. Check out a branch first.");
    if (!inputs.sessionFiles.length && !inputs.otherFiles.length) return shipNotice("Nothing to commit: the working tree is clean.");
    const [channel, thread] = bound.key.split(":") as [string, string];
    const token = randomUUID();
    if (panels.size >= 50) panels.delete(panels.keys().next().value!);
    const panel = { ...inputs, sessionId, channel, thread };
    panels.set(token, panel);
    return shipModal(panel, token);
  };

  // "🚀 Ship…" (finalize line, \diff, \ship card, diff modal) → the Ship panel.
  // Same 3s trigger budget as view_diff: open a placeholder, fill it after git.
  app.action(SHIP_OPEN_ACTION, async ({ ack, body, action, respond }) => {
    await ack();
    if (isStopping()) return;
    const tell = (text: string) => Promise.resolve()
      .then(() => respond({ text, response_type: "ephemeral", replace_original: false })).catch(() => {});
    if (body.user.id !== deps.ownerSlackUserId) {
      await tell("Only the paired owner can ship from here.");
      return;
    }
    const sessionId = (action as { value?: string }).value;
    const trigger = (body as { trigger_id?: string }).trigger_id;
    if (!sessionId || !trigger) return;
    // From inside the diff modal the panel stacks on top of it.
    const inModal = (body as { container?: { type?: string } }).container?.type === "view";
    try {
      const loading = shipNotice("Reading git status…") as never;
      const opened = inModal ? await app.client.views.push({ trigger_id: trigger, view: loading })
        : await app.client.views.open({ trigger_id: trigger, view: loading });
      await app.client.views.update({ view_id: opened.view!.id!, view: await shipView(sessionId) as never });
    } catch (err) {
      logErr(`ship_open failed (${sessionId}): ${String((err as Error)?.message ?? err)}`);
      await tell(`Couldn't open the Ship panel: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
    }
  });

  // Validate within Slack's 3s ack budget (no I/O), then run git after the modal closes.
  app.view(SHIP_SUBMIT, async ({ ack, body, view }) => {
    if (isStopping() || body.user.id !== deps.ownerSlackUserId) { await ack(); return; }
    const panel = panels.get(view.private_metadata);
    if (!panel) {
      await ack({ response_action: "errors", errors: { publish: "This panel expired (SlackOC restarted). Close it and tap 🚀 Ship… again." } });
      return;
    }
    const refuse = (field: ShipField, text: string) => ack({ response_action: "errors",
      errors: { [field === "files" ? (panel.sessionFiles.length ? FILE_BLOCKS.s : FILE_BLOCKS.o) : field]: text } });
    if (getView(panel.sessionId)) { await refuse("publish", "A run is active in this thread. Ship after it finishes."); return; }
    if (running.has(panel.top)) { await refuse("publish", "A ship is already running in this repo."); return; }
    const choices = shipChoices(panel, view.state.values as ShipValues, allowMainPush());
    const plan = planShip(choices);
    if ("refusal" in plan) { await refuse(plan.field, plan.refusal); return; }
    running.add(panel.top);
    panels.delete(view.private_metadata);
    await ack({ response_action: "clear" });
    const post = (text: string) => enqueue(() => app.client.chat.postMessage({ channel: panel.channel, thread_ts: panel.thread, text,
      unfurl_links: false, unfurl_media: false }), { channel: panel.channel, method: "chat.postMessage", lane: "interactive", thread: panel.thread });
    void (async () => {
      try {
        // The panel showed a branch; if HEAD moved since, the plan no longer means what the owner saw.
        const now = await gitBranch(panel.top, exec);
        if (now !== panel.current) {
          const shown = now ? `\`${safeCodePayload(now)}\`` : "a detached HEAD";
          await post(`:x: Ship didn't run: the branch changed to ${shown} since the panel opened. Tap 🚀 Ship… again.`);
          return;
        }
        if (getView(panel.sessionId)) {
          await post(":x: Ship didn't run: a run started in this thread. Ship after it finishes.");
          return;
        }
        await post(shipResultText(plan.branch, await runShip(plan.steps, { cwd: panel.top, message: choices.message, exec })));
      } catch (err) {
        logErr(`ship failed (${panel.sessionId}): ${String((err as Error)?.message ?? err)}`);
        await post(`:x: Ship failed: ${safeCodePayload(String((err as Error)?.message ?? err).slice(0, 300))}`).catch(() => {});
      } finally {
        running.delete(panel.top);
      }
    })();
  });
}

function noticeModal(text: string): Record<string, unknown> {
  return { ...loadingModal(), blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}
