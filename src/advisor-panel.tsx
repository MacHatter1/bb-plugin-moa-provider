// The `::moa-advisors{id="…"}` embed: one advisor round, live. The MoA
// bridge writes the directive into the thread when a round starts; this card
// loads the round over RPC and refreshes on the server's realtime signal.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Markdown,
  experimental_Icon as Icon,
  experimental_ProviderIcon as ProviderIcon,
  experimental_useProviders as useProviders,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginMessageDirectiveProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { AdvisorEntry, AdvisorRound, AdvisorStatus } from "./rounds";
import { ADVISOR_ROUND_CHANNEL, MOA_PROVIDER_ID, ROUND_ID_PATTERN } from "./constants";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type RoundState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "ready"; round: AdvisorRound };

/** While a round runs, poll too, in case a realtime signal is missed. */
const RUNNING_POLL_MS = 4_000;
const LONG_ANSWER_CHARS = 700;
const LONG_ANSWER_LINES = 10;

function useRound(id: string, threadId: string): { state: RoundState; reload: () => void } {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<RoundState>({ kind: "loading" });
  const reload = useCallback(() => {
    rpc.call("advisor_round_get", { id, threadId }).then(
      ({ round }) => setState(round === null ? { kind: "missing" } : { kind: "ready", round }),
      (cause: unknown) =>
        setState((current) =>
          // Keep showing a loaded round through a transient failure.
          current.kind === "ready"
            ? current
            : { kind: "error", message: cause instanceof Error ? cause.message : String(cause) },
        ),
    );
  }, [rpc, id, threadId]);
  useEffect(reload, [reload]);
  useRealtime(ADVISOR_ROUND_CHANNEL, (payload) => {
    if (typeof payload === "object" && payload !== null && (payload as { id?: unknown }).id === id) {
      reload();
    }
  });
  const running = state.kind === "ready" && state.round.finishedAt === null;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(reload, RUNNING_POLL_MS);
    return () => clearInterval(timer);
  }, [running, reload]);
  return { state, reload };
}

/** The current time, ticking once a second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

const STATUS_TEXT: Record<Exclude<AdvisorStatus, "running">, string> = {
  answered: "Answered",
  failed: "Failed",
  "timed-out": "Cut off",
  stopped: "Stopped",
};

/** A working advisor's status word, from what it is doing right now. */
function runningText(entry: AdvisorEntry): string {
  if (entry.answer !== null && entry.answer.trim() !== "") return "Writing";
  const activity = entry.activity ?? null;
  if (activity === null) return "Starting";
  return activity.startsWith("Thinking") ? "Thinking" : "Working";
}

/** The detail line under a working advisor: its reasoning or tool activity. */
function activityDetail(entry: AdvisorEntry): string | null {
  const activity = entry.activity ?? null;
  if (activity === null || activity === "Thinking" || activity === "Writing") return null;
  return activity.startsWith("Thinking: ") ? activity.slice("Thinking: ".length) : activity;
}

function StatusMark({ status }: { status: AdvisorStatus }) {
  if (status === "running") {
    return (
      <span
        aria-hidden
        className="size-3 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground"
      />
    );
  }
  if (status === "answered") {
    return <Icon name="Check" aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
  }
  return (
    <Icon
      name={status === "stopped" ? "Square" : "X"}
      fallback="X"
      aria-hidden
      className={cn("size-3.5 shrink-0", status === "stopped" ? "text-muted-foreground" : "text-destructive")}
    />
  );
}

/** A provider's record for its icon; an id-only record draws the fallback. */
function useProviderRecord(providerId: string) {
  const { providers } = useProviders();
  return providers.find((candidate) => candidate.id === providerId) ?? { id: providerId };
}

/** The aggregator's check-in question, three lines until clicked. */
function Question({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setExpanded(!expanded)}
      aria-expanded={expanded}
      className={cn(
        "block w-full border-b border-border px-3 py-2 text-left text-xs text-muted-foreground",
        !expanded && "line-clamp-3",
      )}
    >
      <span className="font-medium text-foreground">Asked: </span>
      {text}
    </button>
  );
}

function AdvisorRow({ entry, now }: { entry: AdvisorEntry; now: number }) {
  const navigate = useBbNavigate();
  const provider = useProviderRecord(entry.providerId);
  const [expanded, setExpanded] = useState(false);
  const answer = entry.answer?.trim() ?? "";
  const long =
    answer.length > LONG_ANSWER_CHARS || answer.split("\n").length > LONG_ANSWER_LINES;
  const elapsed = (entry.finishedAt ?? now) - entry.startedAt;
  const failed = entry.status === "failed" || entry.status === "timed-out";
  const running = entry.status === "running";
  const detail = running && answer === "" ? activityDetail(entry) : null;
  return (
    <li className="px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <ProviderIcon providerKind="agent" provider={provider} aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 truncate font-medium">{entry.label}</span>
        <span className="hidden shrink-0 text-xs capitalize text-muted-foreground sm:inline">
          {entry.reasoningLevel}
        </span>
        <span className="flex-1" />
        <StatusMark status={entry.status} />
        <span
          className={cn(
            "shrink-0 text-xs tabular-nums",
            failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {entry.status === "running" ? runningText(entry) : STATUS_TEXT[entry.status]} ·{" "}
          {formatDuration(elapsed)}
        </span>
        {entry.workerThreadId === null ? null : (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground"
            aria-label={`Open ${entry.label}'s thread`}
            onClick={() => navigate.toThread(entry.workerThreadId!)}
          >
            Open
            <Icon name="ArrowUpRight" fallback="ExternalLink" aria-hidden className="size-3" />
          </Button>
        )}
      </div>
      {detail === null ? null : (
        <p className="mt-1 truncate text-xs italic text-muted-foreground" title={detail}>
          {detail}
        </p>
      )}
      {answer !== "" ? (
        <>
          <div
            className={cn(
              "relative mt-1.5 min-w-0 text-sm",
              long && !expanded && "max-h-48 overflow-hidden",
            )}
          >
            <Markdown content={answer} />
            {long && !expanded ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-card to-transparent" />
            ) : null}
          </div>
          {long ? (
            <button
              type="button"
              className="mt-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Show less" : "Show all"}
            </button>
          ) : null}
        </>
      ) : null}
      {!running && entry.status !== "answered" && entry.error !== null ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {answer === "" ? entry.error : `Cut off here. ${entry.error}`}
        </p>
      ) : null}
    </li>
  );
}

function PanelShell({ children, dashed = false }: { children: ReactNode; dashed?: boolean }) {
  return (
    <div
      className={cn(
        "my-3 overflow-hidden rounded-lg border bg-card text-card-foreground",
        dashed ? "border-dashed border-border" : "border-border",
      )}
    >
      {children}
    </div>
  );
}

function RoundPanel({ id, threadId }: { id: string; threadId: string }) {
  const { state, reload } = useRound(id, threadId);
  const moa = useProviderRecord(MOA_PROVIDER_ID);
  const running = state.kind === "ready" && state.round.finishedAt === null;
  const now = useNow(running);

  if (state.kind === "loading") {
    return (
      <PanelShell>
        <div role="status" className="flex items-center gap-2 px-3 py-2.5 text-sm text-muted-foreground">
          <StatusMark status="running" />
          Loading advisors…
        </div>
      </PanelShell>
    );
  }
  if (state.kind === "missing") {
    return (
      <PanelShell dashed>
        <p className="px-3 py-2.5 text-sm text-muted-foreground">
          These advisor notes are no longer available.
        </p>
      </PanelShell>
    );
  }
  if (state.kind === "error") {
    return (
      <PanelShell dashed>
        <div className="flex items-center gap-2 px-3 py-2.5 text-sm text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">Could not load the advisors: {state.message}</span>
          <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={reload}>
            Retry
          </Button>
        </div>
      </PanelShell>
    );
  }

  const { round } = state;
  const settled = round.advisors.filter((entry) => entry.status !== "running").length;
  const answered = round.advisors.filter((entry) => entry.status === "answered").length;
  const total = round.advisors.length;
  return (
    <PanelShell>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <ProviderIcon providerKind="agent" provider={moa} aria-hidden className="size-4 shrink-0" />
        <span className="text-sm font-medium">
          {round.round === 0 ? "Advisors" : `Advisor check-in ${round.round}`}
        </span>
        <span className="flex-1" />
        <span className="text-xs tabular-nums text-muted-foreground">
          {running
            ? `${settled} of ${total} done · ${formatDuration(now - round.startedAt)}`
            : `${answered} of ${total} answered · ${formatDuration((round.finishedAt ?? now) - round.startedAt)}`}
        </span>
      </div>
      {round.question === null ? null : <Question text={round.question} />}
      <ul className="divide-y divide-border">
        {round.advisors.map((entry, index) => (
          <AdvisorRow key={index} entry={entry} now={now} />
        ))}
      </ul>
    </PanelShell>
  );
}

export function AdvisorPanel({ attributes, message }: PluginMessageDirectiveProps) {
  const id = attributes.id?.trim() ?? "";
  if (!ROUND_ID_PATTERN.test(id)) {
    return (
      <div className="my-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
        Invalid advisor panel.
      </div>
    );
  }
  return <RoundPanel id={id} threadId={message.threadId} />;
}
