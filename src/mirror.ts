// Turns the aggregator worker's stored timeline events back into the
// `thread/delta` grammar, so its work renders in the MoA thread as if the MoA
// provider had done it: the same commands, diffs, reasoning, and answer.
//
// Skipped on purpose: the aggregator's own user messages (they carry the
// advisor notes and check-ins), items nested under a sub-agent (their child
// turns belong to the worker), and background work, which settles after the
// turn ends and would leave the MoA thread holding open work it cannot close.
// `moa_consult` calls are mirrored ("Consulted advisors") but are neither
// counted as tool calls nor summarised for the advisors.
import { CONSULT_TOOL_NAME } from "./constants.js";
import type {
  DeltaItemShape,
  DeltaPresentation,
  ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";

export interface MirrorEvent {
  type: string;
  data: unknown;
}

type Rec = Record<string, unknown>;

const FALLBACK_GLYPH = "Toolbox";
const TEXT_FIELD_MAX = 256 * 1024;

function isRec(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
function bounded(value: string | undefined): string | undefined {
  if (value === undefined || value.length <= TEXT_FIELD_MAX) return value;
  return `${value.slice(0, TEXT_FIELD_MAX)}\n[… truncated by MoA]`;
}
function defined<T extends Rec>(record: T): T {
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) delete record[key];
  }
  return record;
}

export function itemKey(itemId: string): { providerItemId: string } {
  return { providerItemId: `agg-${itemId}` };
}

/** One look for `moa_consult` rows, whatever the aggregator's provider shows. */
const CONSULT_PRESENTATION: DeltaPresentation = {
  label: { pending: "Consulting advisors", completed: "Consulted advisors" },
  icon: { glyph: "Lightbulb" },
};

/**
 * A presentation survives only with a glyph this plugin may emit: host glyphs,
 * or another plugin's glyph on a `server: "bb"` tool row (checked against the
 * tool's own plugin). Other namespaced glyphs would be refused at ingest.
 */
function presentationOf(item: Rec): DeltaPresentation | undefined {
  if (isConsultCall(item)) return CONSULT_PRESENTATION;
  const presentation = item.presentation;
  if (!isRec(presentation) || !isRec(presentation.icon)) return undefined;
  const glyph = str(presentation.icon.glyph);
  if (glyph === undefined) return undefined;
  const bbTool = item.type === "toolCall" && item.server === "bb";
  const safeGlyph = glyph.includes("/") && !bbTool ? FALLBACK_GLYPH : glyph;
  return {
    ...(presentation as unknown as DeltaPresentation),
    icon: { glyph: safeGlyph },
  };
}

/** The delta shape for a canonical item, or null when it is not mirrored. */
export function itemShape(item: Rec): DeltaItemShape | null {
  switch (item.type) {
    case "agentMessage":
      return { type: "agentMessage", text: str(item.text) ?? "" };
    case "reasoning":
      return {
        type: "reasoning",
        summary: strings(item.summary),
        content: strings(item.content),
      };
    case "plan":
      return { type: "plan", text: str(item.text) ?? "" };
    case "commandExecution":
      return defined({
        type: "command" as const,
        command: str(item.command) ?? "",
        cwd: str(item.cwd) ?? "",
        aggregatedOutput: bounded(str(item.aggregatedOutput)),
        exitCode: num(item.exitCode),
        durationMs: num(item.durationMs),
      });
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      return {
        type: "fileChange",
        changes: changes.filter(isRec).map((change) => {
          const kind = str(change.kind);
          return defined({
            path: str(change.path) ?? "",
            kind:
              kind === "add" || kind === "delete" ? kind : ("update" as const),
            movePath: str(change.movePath),
            diff: bounded(str(change.diff)),
          });
        }),
      };
    }
    case "toolCall":
      return defined({
        type: "tool" as const,
        tool: str(item.tool) ?? "tool",
        server: str(item.server),
        args: item.arguments,
        // The advisors' own rows already show what `moa_consult` returned.
        result: isConsultCall(item) ? undefined : item.result,
        error: str(item.error),
        durationMs: num(item.durationMs),
      });
    case "webSearch": {
      const queries = strings(item.queries);
      return queries.length === 0 ? null : { type: "webSearch", queries };
    }
    case "webFetch":
      return {
        type: "webFetch",
        url: str(item.url) ?? "",
        prompt: str(item.prompt) ?? null,
        pattern: str(item.pattern) ?? null,
      };
    case "imageView":
      return { type: "imageView", path: str(item.path) ?? "" };
    case "imageGeneration":
      return defined({
        type: "imageGeneration" as const,
        prompt: str(item.prompt) ?? null,
        path: str(item.path) ?? null,
        result: str(item.result),
        error: str(item.error) ?? null,
        transparentBackground: item.transparentBackground === true,
      });
    case "fileRead":
      return defined({
        type: "fileRead" as const,
        path: str(item.path) ?? "",
        cmd: str(item.cmd),
      });
    case "search": {
      const raw = str(item.mode);
      const mode: "content" | "path" | "list" =
        raw === "path" || raw === "list" ? raw : "content";
      return defined({
        type: "search" as const,
        mode,
        query: str(item.query) ?? "",
        path: str(item.path),
        cmd: str(item.cmd),
      });
    }
    case "planSteps":
      return defined({
        type: "planSteps" as const,
        steps: (Array.isArray(item.steps) ? item.steps : []) as never,
        explanation: str(item.explanation),
      });
    case "delegation":
      if (item.background === true) return null;
      return defined({
        type: "delegation" as const,
        childRef: `agg-${str(item.childRef) ?? str(item.id) ?? "child"}`,
        label: str(item.label) ?? "Sub-agent",
        background: false,
        summary: str(item.summary),
      });
    case "contextCompaction":
      return { type: "compaction" };
    case "extension":
      // Another plugin's extension kind would be refused here; keep the row.
      return { type: "tool", tool: str(item.kind) ?? "extension", args: item.payload };
    default:
      return null;
  }
}

function closeStatus(item: Rec): "completed" | "failed" | "interrupted" {
  return item.status === "failed" || item.status === "interrupted"
    ? item.status
    : "completed";
}

/** The aggregator's own `moa_consult` call, under any MCP-style prefix. */
export function isConsultCall(item: Rec): boolean {
  const tool = str(item.tool);
  return (
    item.type === "toolCall" &&
    tool !== undefined &&
    (tool === CONSULT_TOOL_NAME || tool.endsWith(`__${CONSULT_TOOL_NAME}`))
  );
}

function mirrorableItem(data: unknown): Rec | null {
  if (!isRec(data) || !isRec(data.item)) return null;
  const item = data.item;
  if (str(item.id) === undefined) return null;
  if (item.parentToolCallId !== undefined) return null;
  if (item.type === "userMessage" || item.type === "backgroundTask") return null;
  return item;
}

/** Item types that count as one tool call for the "every N" cadence. */
const TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "toolCall",
  "fileRead",
  "search",
  "webSearch",
  "webFetch",
  "imageView",
  "imageGeneration",
]);

/** A completed top-level tool call of the aggregator's (not `moa_consult`). */
export function isToolCompletion(event: MirrorEvent): boolean {
  if (event.type !== "item/completed") return false;
  const item = mirrorableItem(event.data);
  return item !== null && TOOL_ITEM_TYPES.has(String(item.type)) && !isConsultCall(item);
}

function tail(text: string | undefined, max: number): string {
  if (text === undefined || text.trim() === "") return "";
  const trimmed = text.trimEnd();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}

function head(text: string | undefined, max: number): string {
  if (text === undefined) return "";
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** One line (plus detail) of the work summary advisors see mid-turn. */
function progressLine(item: Rec): string | null {
  switch (item.type) {
    case "commandExecution": {
      const output = tail(str(item.aggregatedOutput), 400);
      const exit = num(item.exitCode);
      return `- Ran \`${head(str(item.command), 300)}\`${exit === undefined ? "" : ` (exit ${exit})`}${output === "" ? "" : `\n  ${output.replaceAll("\n", "\n  ")}`}`;
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes.filter(isRec) : [];
      return changes
        .map((change) => {
          const diff = head(str(change.diff), 1_500);
          return `- ${str(change.kind) ?? "update"} ${str(change.path) ?? "file"}${diff === "" ? "" : `\n${diff}`}`;
        })
        .join("\n");
    }
    case "toolCall":
      return `- Called ${str(item.tool) ?? "a tool"} ${head(JSON.stringify(item.arguments ?? {}), 200)}${str(item.error) === undefined ? "" : ` (failed: ${head(str(item.error), 200)})`}`;
    case "fileRead":
      return `- Read ${str(item.path) ?? "a file"}`;
    case "search":
      return `- Searched for "${head(str(item.query), 200)}"${str(item.path) === undefined ? "" : ` in ${str(item.path)}`}`;
    case "webSearch":
      return `- Searched the web: ${strings(item.queries).join("; ")}`;
    case "webFetch":
      return `- Fetched ${str(item.url) ?? "a page"}`;
    case "agentMessage": {
      const text = head(str(item.text)?.trim(), 600);
      return text === "" ? null : `- Said: ${text}`;
    }
    default:
      return null;
  }
}

const TEXT_CHANNELS: Record<string, "agentMessage" | "reasoningText" | "reasoningSummary" | "plan"> = {
  "item/agentMessage/delta": "agentMessage",
  "item/reasoning/textDelta": "reasoningText",
  "item/reasoning/summaryTextDelta": "reasoningSummary",
  "item/plan/delta": "plan",
};

/**
 * Stateful: text and output deltas are forwarded only for items this mirror
 * opened, so a sub-agent's nested stream never leaks into the MoA turn.
 */
export class AggregatorMirror {
  /** Open items by aggregator item id, with the shape they opened as. */
  private readonly open = new Map<string, DeltaItemShape>();
  private readonly settled = new Set<string>();
  /** The aggregator's last complete top-level answer this turn. */
  lastAnswer: string | null = null;
  /** What the aggregator has done this turn, for advisors asked mid-turn. */
  private readonly progress: string[] = [];

  /** The latest steps that fit in `maxChars`, oldest first. */
  progressDigest(maxChars = 12_000): string {
    const kept: string[] = [];
    let size = 0;
    for (let index = this.progress.length - 1; index >= 0; index -= 1) {
      const line = this.progress[index]!;
      if (size + line.length > maxChars && kept.length > 0) {
        kept.unshift(`- (${index + 1} earlier step${index === 0 ? "" : "s"} omitted)`);
        break;
      }
      kept.unshift(line);
      size += line.length + 1;
    }
    return kept.join("\n");
  }

  translate(event: MirrorEvent): ThreadDelta[] {
    const { type, data } = event;
    if (type === "item/started") {
      const item = mirrorableItem(data);
      const shape = item === null ? null : itemShape(item);
      if (item === null || shape === null) return [];
      const id = String(item.id);
      if (this.open.has(id) || this.settled.has(id)) return [];
      this.open.set(id, shape);
      const presentation = presentationOf(item);
      return [
        {
          kind: "item.open",
          key: itemKey(id),
          item: shape,
          ...(presentation === undefined ? {} : { presentation }),
        },
      ];
    }
    if (type === "item/completed") {
      const item = mirrorableItem(data);
      const shape = item === null ? null : itemShape(item);
      if (item === null || shape === null) return [];
      const id = String(item.id);
      if (this.settled.has(id)) return [];
      this.open.delete(id);
      this.settled.add(id);
      const line = isConsultCall(item) ? null : progressLine(item);
      if (line !== null && line !== "") this.progress.push(line);
      if (shape.type === "agentMessage" && shape.text.trim() !== "") {
        this.lastAnswer = shape.text;
      }
      const presentation = presentationOf(item);
      const resultText =
        item.type === "webSearch" || item.type === "webFetch"
          ? bounded(str(item.resultText))
          : undefined;
      return [
        defined({
          kind: "item.close" as const,
          key: itemKey(id),
          status: closeStatus(item),
          item: shape,
          presentation,
          resultText,
          approvalStatus:
            item.approvalStatus === "denied" ? ("denied" as const) : undefined,
        }),
      ];
    }
    const channel = TEXT_CHANNELS[type];
    if (channel !== undefined) {
      if (!isRec(data)) return [];
      const itemId = str(data.itemId);
      const text = str(data.delta);
      if (itemId === undefined || text === undefined || !this.open.has(itemId)) {
        return [];
      }
      return [{ kind: "item.textDelta", key: itemKey(itemId), channel, text }];
    }
    if (
      type === "item/commandExecution/outputDelta" ||
      type === "item/fileChange/outputDelta"
    ) {
      if (!isRec(data) || data.reset === true) return [];
      const itemId = str(data.itemId);
      const text = str(data.delta);
      if (itemId === undefined || text === undefined || !this.open.has(itemId)) {
        return [];
      }
      return [
        {
          kind: "item.outputDelta",
          key: itemKey(itemId),
          channel: type === "item/fileChange/outputDelta" ? "fileChange" : "command",
          text,
        },
      ];
    }
    if (!isRec(data)) return [];
    switch (type) {
      case "thread/tokenUsage/updated": {
        const usage = data.tokenUsage;
        if (!isRec(usage) || !isRec(usage.total) || !isRec(usage.last)) return [];
        return [
          {
            kind: "usage",
            total: usage.total as never,
            last: usage.last as never,
            modelContextWindow: num(usage.modelContextWindow) ?? null,
          },
        ];
      }
      case "thread/contextWindowUsage/updated": {
        const usage = data.contextWindowUsage;
        if (!isRec(usage)) return [];
        return [
          {
            kind: "contextWindow",
            used: num(usage.usedTokens) ?? null,
            size: num(usage.modelContextWindow) ?? null,
            estimated: usage.estimated === true,
            attach: "open",
          },
        ];
      }
      case "turn/diff/updated": {
        const diff = str(data.diff);
        return diff === undefined ? [] : [{ kind: "turn.diff", diff }];
      }
      case "provider/error": {
        const message = str(data.message);
        if (message === undefined) return [];
        return [
          defined({
            kind: "provider.error" as const,
            message,
            detail: str(data.detail),
            willRetry: data.willRetry === true ? true : undefined,
          }),
        ];
      }
      case "provider/warning":
        return [
          defined({
            kind: "provider.warning" as const,
            summary: str(data.summary),
            details: str(data.details),
          }),
        ];
      default:
        return [];
    }
  }

  /** Items still open when the turn settles, so the bridge can close them. */
  closeOpenItems(status: "failed" | "interrupted"): ThreadDelta[] {
    const deltas: ThreadDelta[] = [];
    for (const [id, shape] of this.open) {
      deltas.push({ kind: "item.close", key: itemKey(id), status, item: shape });
      this.settled.add(id);
    }
    this.open.clear();
    return deltas;
  }
}
