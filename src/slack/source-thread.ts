/**
 * Thread root of the message a block action/suggestion came from. Slack names
 * the parent on `message.thread_ts`; `container.message_ts` is the card itself,
 * so a message is its own root only when it is top-level. Undefined when the
 * payload omits the source message: callers must not guess a thread.
 */
export function sourceThreadTs(body: unknown): string | undefined {
  const b = body as { container?: { thread_ts?: string }; message?: { ts?: string; thread_ts?: string } };
  return b.message?.thread_ts ?? b.container?.thread_ts ?? b.message?.ts;
}
