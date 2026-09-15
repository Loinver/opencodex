import { isPlainObject } from "./internal";

/**
 * OpenAI hosted web_search config fields that a capability-classified Responses
 * upstream may reject wholesale. xAI's /v1/responses 400s the entire request on
 * `external_web_access` and `search_context_size` ("Argument not supported"),
 * which killed every routed Grok turn whose client (Codex) attaches its
 * default web_search tool config (probe 2026-08-21: both fields 400
 * individually; `user_location` and `filters` are accepted and kept).
 * The caller decides whether to apply this compatibility transform from explicit
 * provider capability metadata; an unclassified upstream keeps the fields.
 */
const OPENAI_ONLY_WEB_SEARCH_FIELDS = ["external_web_access", "search_context_size"] as const;

function stripOpenAiOnlyWebSearchFieldsFromTools(tools: unknown[]): {
  tools: unknown[];
  changed: boolean;
} {
  let changed = false;
  const stripped = tools.map(tool => {
    if (!isPlainObject(tool) || (tool.type !== "web_search" && tool.type !== "web_search_preview")) {
      return tool;
    }
    if (!OPENAI_ONLY_WEB_SEARCH_FIELDS.some(field => Object.hasOwn(tool, field))) return tool;
    const { external_web_access: _access, search_context_size: _size, ...rest } = tool;
    changed = true;
    return rest;
  });
  return { tools: changed ? stripped : tools, changed };
}

export function stripOpenAiOnlyWebSearchFields(body: unknown): unknown {
  if (!isPlainObject(body)) return body;

  let next: Record<string, unknown> = body;
  let changed = false;
  if (Array.isArray(body.tools)) {
    const stripped = stripOpenAiOnlyWebSearchFieldsFromTools(body.tools);
    if (stripped.changed) {
      next = { ...next, tools: stripped.tools };
      changed = true;
    }
  }

  if (Array.isArray(body.input)) {
    let inputChanged = false;
    const input = body.input.map(item => {
      if (!isPlainObject(item) || item.type !== "additional_tools" || !Array.isArray(item.tools)) {
        return item;
      }
      const stripped = stripOpenAiOnlyWebSearchFieldsFromTools(item.tools);
      if (!stripped.changed) return item;
      inputChanged = true;
      return { ...item, tools: stripped.tools };
    });
    if (inputChanged) {
      next = { ...next, input };
      changed = true;
    }
  }

  return changed ? next : body;
}

/**
 * Muse Spark ids whose Responses gateway refuses provider-specific fields on a plain
 * `web_search` tool. Membership, not equality: 1.3 shipped 2026-09-02 as the
 * same-shaped successor to 1.2 on the same Zen wire, and an equality check would
 * have let a Codex-emitted `web_search` body reach the
 * gateway and come back 400 for every request the moment 1.3 was selected.
 *
 * Keyed on the id alone, never on the send URL: the rejection travels with the model.
 * These ids exist only on the Zen/Go and direct-Meta gateways, every one of which refuses
 * the fields, so a relay of the same gateway needs the same sanitized body. The exact-URL
 * allowlist that used to sit beside this set did the opposite — a Console Go reseller host
 * (2026-09-14) served this model, kept `search_content_types`, and 400ed every turn that
 * attached Codex's default `web_search` declaration.
 */
const MUSE_SPARK_WEB_SEARCH_STRICT_MODELS = new Set([
  "muse-spark-1.3-contributor",
  "muse-spark-1.3-contributor-free",
  "muse-spark-1.2-contributor",
  "muse-spark-1.2-contributor-free",
]);

const MUSE_SPARK_UNSUPPORTED_WEB_SEARCH_FIELDS = [
  "search_content_types",
  "indexed_web_access",
] as const;

/**
 * OpenCode Zen / Go and the direct Meta Muse Spark Responses gateways refuse a
 * short list of Codex `web_search` fields. `web_search_preview` keeps its accepted
 * shape, and Luna remains untouched. Only the model id decides: the ids above name one
 * gateway family wherever it is reached from, and the canonical OpenAI forward path — the
 * one destination that documents the field — never calls this transform. Keep the rejected
 * names together so a newly identified field is a one-line compatibility update rather than
 * another bespoke rewrite.
 */
export function stripMuseSparkUnsupportedWebSearchFields(
  body: unknown,
  modelId: unknown,
): unknown {
  if (!isPlainObject(body)) return body;
  if (typeof modelId !== "string") return body;
  if (!MUSE_SPARK_WEB_SEARCH_STRICT_MODELS.has(modelId.trim().toLowerCase())) return body;

  const rewriteTools = (tools: unknown[]): { tools: unknown[]; changed: boolean } => {
    let changed = false;
    const rewritten = tools.map(tool => {
      if (!isPlainObject(tool) || tool.type !== "web_search") return tool;
      if (!MUSE_SPARK_UNSUPPORTED_WEB_SEARCH_FIELDS.some(field => Object.hasOwn(tool, field))) {
        return tool;
      }
      const rest = { ...tool };
      for (const field of MUSE_SPARK_UNSUPPORTED_WEB_SEARCH_FIELDS) delete rest[field];
      changed = true;
      return rest;
    });
    return { tools: changed ? rewritten : tools, changed };
  };

  let next: Record<string, unknown> = body;
  let changed = false;
  if (Array.isArray(body.tools)) {
    const rewritten = rewriteTools(body.tools);
    if (rewritten.changed) {
      next = { ...next, tools: rewritten.tools };
      changed = true;
    }
  }
  if (Array.isArray(next.input)) {
    let inputChanged = false;
    const input = next.input.map(item => {
      if (!isPlainObject(item) || item.type !== "additional_tools" || !Array.isArray(item.tools)) return item;
      const rewritten = rewriteTools(item.tools);
      if (!rewritten.changed) return item;
      inputChanged = true;
      return { ...item, tools: rewritten.tools };
    });
    if (inputChanged) {
      next = { ...next, input };
      changed = true;
    }
  }
  return changed ? next : body;
}
