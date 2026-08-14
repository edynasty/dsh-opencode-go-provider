/**
 * Structural parsing for the legacy-config migration.
 *
 * The document is parsed with the comment-preserving `yaml` library. The
 * exact target block span is computed from the CST node ranges in the RAW
 * text — never from a re-serialization — so removal is a byte-exact splice:
 * `before.slice(0, start) + before.slice(end)` reproduces every non-target
 * byte (comments, quoting, blank lines, CRLF, scalar formatting, key order).
 * A sibling comment above the block sits outside the span and survives; a
 * comment inside the block is target-owned and goes with it.
 */
import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument } from "yaml";
import type { Document, YAMLMap } from "yaml";
import { MIGRATION_NAMESPACE, MIGRATION_PROVIDER } from "./migration.ts";

export type ParseOutcome =
  | { readonly kind: "malformed"; readonly message: string }
  | { readonly kind: "absent"; readonly doc: Document.Parsed }
  | { readonly kind: "wrong-type"; readonly doc: Document.Parsed }
  | { readonly kind: "unsupported"; readonly doc: Document.Parsed; readonly message: string }
  | {
      readonly kind: "map";
      readonly doc: Document.Parsed;
      readonly providers: YAMLMap.Parsed;
      readonly targetNode: YAMLMap.Parsed;
    };

/** Narrow a parsed map node to its parsed (range-carrying) form. */
function isParsedMap(value: unknown): value is YAMLMap.Parsed {
  return isMap(value);
}

/** A flow-style collection cannot be spliced byte-exactly as a block pair. */
function isFlowMap(node: YAMLMap.Parsed): boolean {
  return node.flow === true;
}

/**
 * Cycle-safe recursive scan of the node graph under `root`: any anchor or
 * alias at ANY depth — on maps, sequences, scalars, aliases, or the root
 * itself — reports `true`. The visited set stops shared-node graphs (an
 * anchored node reachable through several paths, or an alias resolving back
 * into an ancestor) from looping. The migration splices the target block out
 * of the raw text, so any anchor/alias relationship inside the namespace
 * subtree could be left dangling; every such shape fails closed instead.
 */
function containsAnchorOrAlias(root: unknown): boolean {
  const visited = new Set<object>();
  const visit = (node: unknown): boolean => {
    if (node === null || node === undefined || typeof node !== "object") return false;
    if (visited.has(node)) return false;
    visited.add(node);
    if (isAlias(node)) return true;
    if (isNode(node) && node.anchor !== undefined) return true;
    if (isMap(node)) {
      for (const item of node.items) {
        if (visit(item.key)) return true;
        if (visit(item.value)) return true;
      }
      return false;
    }
    if (isSeq(node)) {
      for (const item of node.items) {
        if (visit(item)) return true;
      }
      return false;
    }
    return false;
  };
  return visit(root);
}

/**
 * Refuse shapes whose removal would corrupt non-target semantics: flow-style
 * namespace/providers/target maps (no block ranges to splice), any anchor or
 * alias anywhere in the namespace subtree (including anchors on the namespace
 * and providers nodes themselves and nested aliases referenced by siblings —
 * removal could break the reference or leave unresolved YAML), and a target
 * that is the ONLY provider (removing it would leave `providers:` with a null
 * value).
 */
function unsupportedShapeOf(
  doc: Document.Parsed,
  providers: YAMLMap.Parsed,
  targetNode: YAMLMap.Parsed,
): string | undefined {
  const namespace = doc.getIn([MIGRATION_NAMESPACE]);
  if (isParsedMap(namespace) && isFlowMap(namespace)) {
    return "the legacy namespace is a flow mapping, which cannot be migrated safely";
  }
  if (isFlowMap(providers)) {
    return "the legacy providers mapping is a flow mapping, which cannot be migrated safely";
  }
  if (isFlowMap(targetNode)) {
    return "the legacy opencode-go node is a flow mapping, which cannot be migrated safely";
  }
  if (containsAnchorOrAlias(namespace)) {
    return "the legacy settings subtree contains anchors or aliases, which removal could break";
  }
  if (providers.items.length === 1) {
    return "the legacy opencode-go node is the only provider; removing it would corrupt the providers mapping";
  }
  return undefined;
}

/** The raw value node for `key` inside `map` — an Alias is returned as-is, never resolved. */
function valueOf(map: YAMLMap.Parsed, key: string): unknown {
  for (const item of map.items) {
    const itemKey = item.key;
    if (itemKey !== null && itemKey !== undefined && isScalar(itemKey) && itemKey.value === key) {
      return item.value;
    }
  }
  return undefined;
}

/**
 * Parse structurally; the map branch carries the nodes the splice needs.
 * The namespace/providers/target are inspected ONE LEVEL AT A TIME on the raw
 * AST, classifying each node BEFORE narrowing it to a map: an alias at any of
 * the three levels is refused (the migration can never splice through a
 * reference), a missing node is `absent`, and a present non-map is
 * `wrong-type`. Deep `getIn` must not be used for the path — it silently
 * returns undefined past an Alias, which would misclassify a hostile alias as
 * `no-target` and let it through.
 */
export function parseSettings(text: string): ParseOutcome {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    return { kind: "malformed", message: "the settings document is not valid YAML" };
  }
  const root = doc.contents;
  if (!isParsedMap(root)) {
    return { kind: "absent", doc };
  }
  const namespace = valueOf(root, MIGRATION_NAMESPACE);
  if (namespace === undefined || namespace === null) {
    return { kind: "absent", doc };
  }
  if (isAlias(namespace)) {
    return { kind: "unsupported", doc, message: "the legacy namespace value is an alias, which cannot be migrated safely" };
  }
  if (!isParsedMap(namespace)) {
    return { kind: "wrong-type", doc };
  }
  const providers = valueOf(namespace, "providers");
  if (providers === undefined || providers === null) {
    return { kind: "absent", doc };
  }
  if (isAlias(providers)) {
    return { kind: "unsupported", doc, message: "the legacy providers value is an alias, which cannot be migrated safely" };
  }
  if (!isParsedMap(providers)) {
    return { kind: "wrong-type", doc };
  }
  const targetNode = valueOf(providers, MIGRATION_PROVIDER);
  if (targetNode === undefined || targetNode === null) {
    return { kind: "absent", doc };
  }
  if (isAlias(targetNode)) {
    return { kind: "unsupported", doc, message: "the legacy opencode-go node is an alias, which cannot be migrated safely" };
  }
  if (!isParsedMap(targetNode)) {
    return { kind: "wrong-type", doc };
  }
  const unsupported = unsupportedShapeOf(doc, providers, targetNode);
  if (unsupported !== undefined) {
    return { kind: "unsupported", doc, message: unsupported };
  }
  return { kind: "map", doc, providers, targetNode };
}

/** Offset just past the end of the line containing `offset` (newline included). */
function lineEnd(text: string, offset: number): number {
  let index = offset;
  while (index < text.length && text[index] !== "\n") index += 1;
  return index < text.length ? index + 1 : index;
}

/** Offset of the first byte of the line containing `offset`. */
function lineStart(text: string, offset: number): number {
  let index = offset;
  while (index > 0 && text[index - 1] !== "\n") index -= 1;
  return index;
}

/** A validated splice span, or the impossible-state refusal. */
export type SpliceResult =
  | { readonly kind: "ok"; readonly start: number; readonly end: number }
  | { readonly kind: "invalid" };

/**
 * Narrow pure helper: compute the splice span from the CST byte offsets of the
 * target pair's key start and value end. Impossible offsets (negative, past
 * the document end, or inverted) return `undefined` — never a zero-based
 * splice that would corrupt the document.
 */
export function spliceSpanFromOffsets(
  text: string,
  keyStartOffset: number,
  valueEndOffset: number,
): { readonly start: number; readonly end: number } | undefined {
  if (keyStartOffset < 0 || keyStartOffset >= text.length) return undefined;
  if (valueEndOffset < 0 || valueEndOffset > text.length) return undefined;
  if (keyStartOffset >= valueEndOffset) return undefined;
  const start = lineStart(text, keyStartOffset);
  const rawEnd = valueEndOffset;
  const end = rawEnd < text.length && text[rawEnd - 1] !== "\n" ? lineEnd(text, rawEnd) : rawEnd;
  if (end <= start) return undefined;
  return { start, end };
}

/**
 * The exact raw-text span covering the target pair: the line holding the
 * `opencode-go` key through the block's last content line, trailing newline
 * included. The pair is located through its parent map (the key's line
 * start); the value's CST end is the start of the following line when a
 * sibling follows and the end of the content otherwise, and both are
 * normalized so `text.slice(start, end)` is precisely the block to remove.
 * A missing pair or missing CST ranges is an impossible-state refusal —
 * never a zero-based splice.
 */
export function targetSplice(
  text: string,
  providers: YAMLMap.Parsed,
  targetNode: YAMLMap.Parsed,
): SpliceResult {
  const pair = providers.items.find((item) => item.value === targetNode);
  const keyRange = pair?.key.range;
  const valueRange = pair?.value?.range;
  if (keyRange === undefined || valueRange === undefined) return { kind: "invalid" };
  const span = spliceSpanFromOffsets(text, keyRange[0], valueRange[1]);
  return span === undefined ? { kind: "invalid" } : { kind: "ok", start: span.start, end: span.end };
}

/** Deterministic sorted key names of the removed mapping (never values). */
export function mappingKeys(node: YAMLMap.Parsed): readonly string[] {
  const value = node.toJSON();
  const keys = typeof value === "object" && value !== null ? Object.keys(value) : [];
  return keys.sort();
}

const KEY_LIKE_PATTERNS = [
  /\bsk-[A-Za-z0-9_=-]{8,}\b/gu,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
  /\bBearer\s+\S+/giu,
] as const;

/**
 * Scrub key-shaped tokens from a rendered line so a hostile fixture can never
 * smuggle a secret through a migration receipt or evidence.
 */
export function redactSensitiveTokens(text: string): string {
  let out = text;
  for (const pattern of KEY_LIKE_PATTERNS) {
    const replacement = pattern === KEY_LIKE_PATTERNS[2] ? "Bearer [redacted]" : "[redacted]";
    out = out.replace(pattern, replacement);
  }
  return out;
}
