/**
 * Delivery markers ride in Slack message metadata, which people never see
 * (not in the post, not in push notifications); see web/slack-message-metadata.md.
 * `marker` is the exact string older builds appended to the visible text, so one
 * predicate matches new posts (payload) and old ones still in Slack (text).
 */
export const MARKER_EVENT = "slackoc_marker";

export type MarkerKind = "question" | "permission" | "schedule_context" | "schedule_report";
export interface MarkerMetadata {
  event_type: typeof MARKER_EVENT;
  event_payload: { kind: MarkerKind; id: string; marker: string };
}

export function markerMetadata(kind: MarkerKind, id: string, marker: string): MarkerMetadata {
  return { event_type: MARKER_EVENT, event_payload: { kind, id, marker } };
}

/** History message shape we read; requests must pass `include_all_metadata: true` or Slack omits the payload. */
interface MarkedMessage { text?: string; metadata?: { event_type?: string; event_payload?: unknown } }

/** Payload marker first; the text fallback covers posts made before markers moved to metadata. */
export function hasMarker(message: MarkedMessage, match: (text: string) => boolean): boolean {
  const meta = message.metadata;
  const marker = meta?.event_type === MARKER_EVENT ? (meta.event_payload as { marker?: unknown } | undefined)?.marker : undefined;
  return (typeof marker === "string" && match(marker)) || (!!message.text && match(message.text));
}
