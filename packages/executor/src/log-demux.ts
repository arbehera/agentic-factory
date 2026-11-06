import type { LogLine } from "./backend.js";

/**
 * Splits Docker's multiplexed log stream (containers without a TTY) into lines. Each frame is an
 * 8-byte header — stream type (1 = stdout, 2 = stderr), 3 zero bytes, big-endian length — and a
 * payload. Frames and lines may be split across chunks.
 */
export async function* demuxDockerLogs(chunks: AsyncIterable<Buffer | Uint8Array>): AsyncGenerator<LogLine> {
  let buf = Buffer.alloc(0);
  const partial: Record<LogLine["stream"], string> = { stdout: "", stderr: "" };

  function* emit(stream: LogLine["stream"], text: string): Generator<LogLine> {
    const parts = (partial[stream] + text).split("\n");
    partial[stream] = parts.pop() ?? "";
    for (const line of parts) yield { stream, line: line.replace(/\r$/, "") };
  }

  for await (const chunk of chunks) {
    buf = Buffer.concat([buf, Buffer.from(chunk)]);
    while (buf.length >= 8) {
      const size = buf.readUInt32BE(4);
      if (buf.length < 8 + size) break;
      const stream = buf[0] === 2 ? "stderr" : "stdout";
      yield* emit(stream, buf.subarray(8, 8 + size).toString("utf8"));
      buf = buf.subarray(8 + size);
    }
  }
  for (const stream of ["stdout", "stderr"] as const) {
    if (partial[stream] !== "") yield { stream, line: partial[stream] };
  }
}
