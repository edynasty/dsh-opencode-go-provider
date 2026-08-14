/**
 * One-line stdin decoding for the standalone CLI.
 *
 * `decodeLine` removes exactly ONE line terminator (LF, or CRLF) and NEVER
 * trims: padded or control-carrying keys stay byte-identical so the control
 * seam's canonical validation rejects them unchanged. An empty line maps to
 * undefined (no key); a line of spaces is DATA and reaches validation, never
 * a silent valid key.
 */
export function decodeLine(text: string): string | undefined {
  let line = text;
  if (line.endsWith("\n")) {
    line = line.slice(0, -1);
  }
  if (line.endsWith("\r")) {
    line = line.slice(0, -1);
  }
  if (line === "") return undefined;
  return line;
}
