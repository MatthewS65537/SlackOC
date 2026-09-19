import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync, truncateSync } from "node:fs";
import { dirname } from "node:path";

export const SERVICE_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Single writer: the supervisor owns this file; children write only to pipes.
 * Splitting oversized writes keeps every generation <= maxBytes, even mid-run.
 */
export function rotatingLog(path: string, maxBytes = SERVICE_LOG_MAX_BYTES): (data: Buffer | string) => void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("invalid log size limit");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  for (const file of [path, `${path}.1`, `${path}.2`]) {
    if (!existsSync(file)) continue;
    chmodSync(file, 0o600);
    if (statSync(file).size > maxBytes) truncateSync(file, maxBytes);
  }
  appendFileSync(path, "", { mode: 0o600 });
  let size = statSync(path).size;
  return (data) => {
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    for (let offset = 0; offset < bytes.length;) {
      if (size >= maxBytes) {
        if (existsSync(`${path}.1`)) renameSync(`${path}.1`, `${path}.2`);
        renameSync(path, `${path}.1`);
        size = 0;
      }
      const end = Math.min(bytes.length, offset + maxBytes - size);
      appendFileSync(path, bytes.subarray(offset, end), { mode: 0o600 });
      size += end - offset;
      offset = end;
    }
  };
}
