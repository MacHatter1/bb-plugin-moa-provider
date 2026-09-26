// bb-plugin-moa — frontend: the settings page, which edits the presets that
// appear as models of the "Mixture of Agents" provider, and the advisor panel
// embed (src/advisor-panel.tsx). Each slot uses BB's own provider/model
// picker, so any installed provider — Claude Code, Codex, Pi, ACP agents,
// plugin providers — can be an advisor or the aggregator.
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_ProviderModelPicker as ProviderModelPicker,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { Fanout, Preset, PresetStore, Slot } from "./src/presets";
import {
  ADVISOR_PANEL_DIRECTIVE,
  MAX_ADVISORS,
  MAX_FANOUT_EVERY,
  MOA_PROVIDER_ID,
  PRESET_ID_PATTERN,
} from "./src/constants";
import { AdvisorPanel } from "./src/advisor-panel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

function describeError(cause: unknown): string {
  if (typeof cause !== "object" || cause === null) return String(cause);
  const { message, issues } = cause as {
    message?: unknown;
    issues?: { message: string; path?: (string | number)[] }[];
  };
  if (Array.isArray(issues) && issues.length > 0) {
    return issues
      .map((issue) => {
        const path = issue.path ?? [];
        const where =
          path[0] === "store" && path[1] === "presets" && typeof path[2] === "number"
            ? `Preset ${path[2] + 1}: `
            : "";
        return `${where}${issue.message}`;
      })
      .join("\n");
  }
  return typeof message === "string" ? message : String(cause);
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  const slug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 40) || "preset";
  let candidate = slug;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${slug}-${n}`;
  return candidate;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-sm font-medium">{label}</div>
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
    </div>
  );
}

function SlotPicker({
  value,
  onChange,
  onRemove,
  removeLabel,
}: {
  value: Slot;
  onChange: (slot: Slot) => void;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  const recursive = value.providerId === MOA_PROVIDER_ID;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <ProviderModelPicker value={value} onChange={onChange} />
        </div>
        {onRemove === undefined ? null : (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={removeLabel}
            onClick={onRemove}
          >
            <Icon name="X" className="size-4" />
          </Button>
        )}
      </div>
      {recursive ? (
        <p className="text-xs text-destructive">
          Pick another provider: a preset cannot contain Mixture of Agents.
        </p>
      ) : null}
    </div>
  );
}

const FANOUT_OPTIONS: { value: Fanout; label: string }[] = [
  { value: "message", label: "No, once per message is enough" },
  { value: "on-request", label: "When the aggregator asks" },
  { value: "every-n", label: "Every few tool calls" },
];

/** Hermes' `fanout`: whether and how often advisors are asked mid-task. */
function FanoutField({
  preset,
  onChange,
}: {
  preset: Preset;
  onChange: (patch: Partial<Preset>) => void;
}) {
  return (
    <div className="space-y-1.5 pt-1">
      <div className="text-sm font-medium">Consult them again mid-task</div>
      <p className="text-xs text-muted-foreground">
        {preset.fanout === "message"
          ? "Advisors are asked once, before the aggregator starts."
          : preset.fanout === "on-request"
            ? "The aggregator gets a moa_consult tool and decides when to ask again, for example before risky changes."
            : "The aggregator is also told to call moa_consult after every N tool calls. It waits for the answers, like Hermes' every_n fanout."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={preset.fanout}
          onChange={(event) => onChange({ fanout: event.target.value as Fanout })}
          aria-label="Consult advisors again mid-task"
          className="h-9 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {FANOUT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {preset.fanout === "every-n" ? (
          <label className="flex items-center gap-2 text-sm">
            every
            <Input
              type="number"
              min={1}
              max={MAX_FANOUT_EVERY}
              value={preset.fanoutEvery}
              onChange={(event) => {
                const value = Math.round(Number(event.target.value));
                if (Number.isFinite(value)) {
                  onChange({ fanoutEvery: Math.min(Math.max(value, 1), MAX_FANOUT_EVERY) });
                }
              }}
              aria-label="Tool calls between check-ins"
              className="h-9 w-20"
            />
            tool calls
          </label>
        ) : null}
      </div>
    </div>
  );
}

function PresetCard({
  preset,
  idEditable,
  isDefault,
  onChange,
  onRemove,
  onMakeDefault,
}: {
  preset: Preset;
  idEditable: boolean;
  isDefault: boolean;
  onChange: (preset: Preset) => void;
  onRemove: () => void;
  onMakeDefault: () => void;
}) {
  const set = (patch: Partial<Preset>) => onChange({ ...preset, ...patch });
  const idValid = PRESET_ID_PATTERN.test(preset.id);
  return (
    <section className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={preset.name}
          onChange={(event) => set({ name: event.target.value })}
          placeholder="Preset name"
          aria-label="Preset name"
          className="min-w-40 flex-1 font-medium"
        />
        {isDefault ? (
          <span className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
            Default
          </span>
        ) : (
          <Button variant="outline" size="sm" onClick={onMakeDefault}>
            Make default
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-destructive"
          aria-label={`Delete ${preset.name || "preset"}`}
          onClick={onRemove}
        >
          <Icon name="Trash2" className="size-4" />
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <Field label="Model id" hint={idEditable ? "Used with --model; fixed once saved." : undefined}>
          <Input
            value={preset.id}
            disabled={!idEditable}
            onChange={(event) => set({ id: event.target.value.trim() })}
            aria-label="Model id"
            aria-invalid={!idValid}
            className={cn("font-mono text-xs", !idValid && "border-destructive")}
          />
        </Field>
        <Field label="Description">
          <Input
            value={preset.description}
            onChange={(event) => set({ description: event.target.value })}
            placeholder="Shown in the model picker (optional)"
            aria-label="Description"
          />
        </Field>
      </div>

      <Field
        label="Aggregator"
        hint="Does the work: it reads the advisors' notes, runs tools, edits files, and writes the reply. Most of a preset's cost lands here."
      >
        <SlotPicker value={preset.aggregator} onChange={(aggregator) => set({ aggregator })} />
      </Field>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm font-medium">
          <Checkbox
            checked={preset.advisorsEnabled}
            onCheckedChange={(checked) => set({ advisorsEnabled: checked === true })}
          />
          Consult advisors first
        </label>
        <p className="text-xs text-muted-foreground">
          Advisors read the request (and may read the workspace) once per message, in parallel,
          without editing anything. Their answers reach the aggregator as private notes.
        </p>
        {preset.advisorsEnabled ? (
          <div className="space-y-2">
            {preset.advisors.map((advisor, index) => (
              <SlotPicker
                key={index}
                value={advisor}
                onChange={(slot) =>
                  set({
                    advisors: preset.advisors.map((current, i) => (i === index ? slot : current)),
                  })
                }
                onRemove={() =>
                  set({ advisors: preset.advisors.filter((_, i) => i !== index) })
                }
                removeLabel={`Remove advisor ${index + 1}`}
              />
            ))}
            <Button
              variant="outline"
              size="sm"
              disabled={preset.advisors.length >= MAX_ADVISORS}
              onClick={() =>
                set({
                  advisors: [
                    ...preset.advisors,
                    { ...(preset.advisors.at(-1) ?? preset.aggregator) },
                  ],
                })
              }
            >
              <Icon name="Plus" className="size-4" />
              Add advisor
            </Button>
            {preset.advisors.length > 0 ? <FanoutField preset={preset} onChange={set} /> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function usePresets(rpc: Rpc) {
  const [saved, setSaved] = useState<PresetStore | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("presets_get").then(
      (result) => {
        setSaved(result.store);
        setError(null);
      },
      (cause: unknown) => setError(describeError(cause)),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  return { saved, setSaved, error, setError, refetch };
}

/** A draft preset plus the id it was saved under (null until first save). */
interface Row {
  key: number;
  savedId: string | null;
  preset: Preset;
}

let nextRowKey = 0;
function toRows(store: PresetStore): Row[] {
  return store.presets.map((preset) => ({
    key: (nextRowKey += 1),
    savedId: preset.id,
    preset,
  }));
}

function PresetsSection() {
  const rpc = useRpc<typeof rpcContract>();
  const { saved, setSaved, error, setError, refetch } = usePresets(rpc);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const draft: PresetStore | null =
    rows === null
      ? null
      : {
          version: 1,
          defaultPresetId: rows.some((row) => row.preset.id === defaultId)
            ? defaultId
            : (rows[0]?.preset.id ?? null),
          presets: rows.map((row) => row.preset),
        };
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);

  const reset = useCallback((store: PresetStore) => {
    setRows(toRows(store));
    setDefaultId(store.defaultPresetId);
  }, []);
  useEffect(() => {
    if (saved !== null && (rows === null || !dirty)) reset(saved);
    // Only a new saved store resets the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);
  // Another window or `bb moa` changed the presets: pick them up unless
  // there are unsaved edits here.
  useRealtime("presets-changed", () => {
    if (!dirty) refetch();
  });

  if (rows === null || draft === null || saved === null) {
    return <p className="text-sm text-muted-foreground">{error ?? "Loading presets…"}</p>;
  }

  const setRow = (key: number, preset: Preset) => {
    const previous = rows.find((row) => row.key === key);
    if (previous !== undefined && defaultId === previous.preset.id) setDefaultId(preset.id);
    setRows(rows.map((row) => (row.key === key ? { ...row, preset } : row)));
  };
  const addPreset = () => {
    const template =
      rows.find((row) => row.preset.id === draft.defaultPresetId)?.preset ?? rows[0]?.preset;
    const fallback: Slot = { providerId: "claude-code", model: "", reasoningLevel: "medium" };
    nextRowKey += 1;
    setRows([
      ...rows,
      {
        key: nextRowKey,
        savedId: null,
        preset: {
          id: uniqueId("preset", new Set(rows.map((row) => row.preset.id))),
          name: "New preset",
          description: "",
          aggregator: template?.aggregator ?? fallback,
          advisors: template?.advisors ?? [],
          advisorsEnabled: true,
          fanout: template?.fanout ?? "message",
          fanoutEvery: template?.fanoutEvery ?? 5,
        },
      },
    ]);
  };
  const save = async () => {
    setSaving(true);
    try {
      const result = await rpc.call("presets_save", { store: draft });
      setSaved(result.store);
      reset(result.store);
      setError(null);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Each preset is a model of the <strong>Mixture of Agents</strong> provider. Advisors answer
        first; the aggregator reads their notes and does the work. Workers run as hidden threads
        in the same workspace, so every provider uses its own sign-in.
      </p>
      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No presets yet. Add one to make Mixture of Agents appear in the model picker.
        </div>
      ) : (
        rows.map((row) => (
          <PresetCard
            key={row.key}
            preset={row.preset}
            idEditable={row.savedId === null}
            isDefault={row.preset.id === draft.defaultPresetId}
            onChange={(preset) => setRow(row.key, preset)}
            onRemove={() => setRows(rows.filter((candidate) => candidate.key !== row.key))}
            onMakeDefault={() => setDefaultId(row.preset.id)}
          />
        ))
      )}
      {error === null ? null : (
        <p role="alert" className="whitespace-pre-line text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={addPreset}>
          <Icon name="Plus" className="size-4" />
          New preset
        </Button>
        <div className="flex-1" />
        <Button variant="ghost" disabled={!dirty || saving} onClick={() => reset(saved)}>
          Discard
        </Button>
        <Button disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save presets"}
        </Button>
      </div>
    </div>
  );
}

const ASK_PREFIX = "/moa ";

export default definePluginApp((app) => {
  app.slots.messageDirective({ id: ADVISOR_PANEL_DIRECTIVE, component: AdvisorPanel });
  // A shortcut to `/moa <question>`: the thread's agent asks the advisors.
  app.composer.customize({
    id: "moa-ask",
    scopes: ["thread"],
    plusMenu: [
      {
        id: "ask",
        label: "Ask MoA",
        description: "Get your advisors' take on a question with /moa",
        icon: "Lightbulb",
        run: ({ composer }) => {
          composer.updateText((current) =>
            current.startsWith(ASK_PREFIX.trim()) ? current : `${ASK_PREFIX}${current}`,
          );
          composer.focus();
        },
      },
    ],
  });
  app.slots.settingsSection({
    id: "presets",
    title: "Presets",
    component: PresetsSection,
  });
});
