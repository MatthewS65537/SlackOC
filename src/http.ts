/** Deadlines cover response bodies too; abort always reaches the actual transport. */
export const HTTP_TIMEOUT_MS = 30_000;
export const HEALTH_TIMEOUT_MS = 5_000;
export const COMMAND_TIMEOUT_MS = 120_000;

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function withDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  { signal, timeoutMs = HTTP_TIMEOUT_MS }: RequestOptions = {},
  label = "request",
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be positive and finite");
  signal?.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out (${timeoutMs / 1000}s)`)), timeoutMs);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
  });
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([run(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", onAbort);
    // Cancel any sibling/late work after a multi-stage operation exits.
    controller.abort(new Error(`${label} finished`));
  }
}

/** For finite HTTP responses only. SSE has its own idle watchdog. */
export async function abortableFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  options: RequestOptions = {},
): Promise<Response> {
  const signals = [options.signal, init.signal, input instanceof Request ? input.signal : undefined]
    .filter((s): s is AbortSignal => !!s);
  return withDeadline(async (signal) => {
    const response = await fetch(input, { ...init, signal });
    const bytes = await response.arrayBuffer();
    const buffered = new Response(response.status === 204 || response.status === 205 || response.status === 304 ? null : bytes, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
    Object.defineProperty(buffered, "url", { value: response.url });
    return buffered;
  }, { ...options, signal: signals.length ? AbortSignal.any(signals) : undefined });
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); resolve(); };
    const cancel = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); reject(signal.reason); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
}
