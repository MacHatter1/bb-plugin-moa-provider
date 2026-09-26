// Follows one advisor's timeline while it works, for its row in the panel:
// what it is doing right now ("Thinking: …", "Reading src/app.ts") and the
// answer it is writing, as it streams. Items nested under the advisor's own
// sub-agents are ignored, like everywhere else.

type Rec = Record<string, unknown>;

const ACTIVITY_CHARS = 140;
const REASONING_TAIL_CHARS = 400;

function isRec(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function oneLine(text: string, max = ACTIVITY_CHARS): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** The last sentence or so of streamed reasoning, for a one-line preview. */
function reasoningPreview(tail: string): string {
  const flat = tail.replace(/\s+/gu, " ").trim();
  if (flat.length <= ACTIVITY_CHARS - 10) return flat;
  return `…${flat.slice(-(ACTIVITY_CHARS - 11))}`;
}

function describeItem(item: Rec): string | null {
  switch (item.type) {
    case "reasoning":
      return "Thinking";
    case "agentMessage":
      return "Writing";
    case "commandExecution":
      return oneLine(`Running ${str(item.command) ?? "a command"}`);
    case "fileRead":
      return oneLine(`Reading ${str(item.path) ?? "a file"}`);
    case "search":
      return oneLine(`Searching for "${str(item.query) ?? ""}"`);
    case "webSearch":
      return "Searching the web";
    case "webFetch":
      return oneLine(`Reading ${str(item.url) ?? "a web page"}`);
    case "toolCall":
      return oneLine(`Using ${str(item.tool) ?? "a tool"}`);
    default:
      return null;
  }
}

export class AdvisorStream {
  /** The top-level message being written, or the last one finished. */
  text: string | null = null;
  activity: string | null = null;
  private messageId: string | null = null;
  private reasoningTail = "";

  /** Apply a batch of timeline events; true when the panel should refresh. */
  apply(rows: readonly { type: string; data: unknown }[]): boolean {
    let changed = false;
    for (const { type, data } of rows) {
      if (!isRec(data)) continue;
      if (type === "item/started" || type === "item/completed") {
        const item = data.item;
        if (!isRec(item) || item.parentToolCallId !== undefined) continue;
        if (item.type === "agentMessage") {
          // A new message replaces the last one: the latest is the answer.
          this.messageId = str(item.id) ?? null;
          const text = str(item.text) ?? "";
          this.text = text === "" ? null : text;
        }
        if (type === "item/started") {
          if (item.type === "reasoning") this.reasoningTail = "";
          const activity = describeItem(item);
          if (activity !== null) this.activity = activity;
        }
        changed = true;
        continue;
      }
      const delta = str(data.delta);
      if (delta === undefined) continue;
      if (type === "item/agentMessage/delta" && str(data.itemId) === this.messageId) {
        this.text = `${this.text ?? ""}${delta}`;
        this.activity = "Writing";
        changed = true;
      } else if (
        type === "item/reasoning/textDelta" ||
        type === "item/reasoning/summaryTextDelta"
      ) {
        this.reasoningTail = `${this.reasoningTail}${delta}`.slice(-REASONING_TAIL_CHARS);
        const preview = reasoningPreview(this.reasoningTail);
        this.activity = preview === "" ? "Thinking" : `Thinking: ${preview}`;
        changed = true;
      }
    }
    return changed;
  }
}
