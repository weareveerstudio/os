import { Badge, Banner, Button, Input, InputArea, LayerCard, Loader, Switch, Text } from "@cloudflare/kumo";
import { useMutation, usePolled, type StudioAppHost } from "@veer/studio-kit/app";
import { useEffect, useState, type FormEvent } from "react";
import type { AuditEntry } from "@veer/studio-kit/audit-types";
import { MAX_NOTE_LENGTH, type ProbeNoteView, type ProbeUi, type ProbeViewer } from "../src/ui-types";

type Host = StudioAppHost<ProbeUi>;

/** Live workspace titles: a string, null for one the viewer can't open, absent while unknown. */
type Titles = ReadonlyMap<string, string | null>;

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** The host resolves at most this many workspace ids per call. */
const MAX_TITLES_PER_LOOKUP = 100;

/** "3 minutes ago", for times within a week; a date beyond that. */
export function formatWhen(at: number, now = Date.now()): string {
  const seconds = Math.round((at - now) / 1000);
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["second", 60], ["minute", 60], ["hour", 24], ["day", 7],
  ];
  let value = seconds;
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) return relative.format(value, unit);
    value = Math.round(value / size);
  }
  return new Date(at).toLocaleDateString();
}

/** The first line of a note, shortened for labels and the audit log. */
export function snippet(body: string, max = 60): string {
  const line = body.split("\n", 1)[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A failure message screen readers announce. */
function ErrorText({ children }: { children: string | null }) {
  if (!children) return null;
  return <div role="alert"><Text size="sm" variant="error">{children}</Text></div>;
}

/**
 * Resolves the workspace titles for `ids`, looking up only the ones not known yet, in batches the
 * host accepts. A failed lookup leaves its ids unknown, to be tried again when the ids change.
 */
function useWorkspaceTitles(host: Host, ids: readonly string[]): Titles {
  const [titles, setTitles] = useState<Map<string, string | null>>(() => new Map());
  // Keyed by content, so a new array of the same ids on every render looks nothing up.
  const key = [...new Set(ids)].toSorted().join(",");

  useEffect(() => {
    const missing = key ? key.split(",").filter((id) => !titles.has(id)) : [];
    if (!missing.length) return;
    let current = true;
    for (let start = 0; start < missing.length; start += MAX_TITLES_PER_LOOKUP) {
      const batch = missing.slice(start, start + MAX_TITLES_PER_LOOKUP);
      host.resolveWorkspaceTitles(batch).then(
        (resolved) => {
          if (!current) return;
          setTitles((known) => {
            const next = new Map(known);
            batch.forEach((id, index) => next.set(id, resolved[index] ?? null));
            return next;
          });
        },
        () => {},
      );
    }
    return () => {
      current = false;
    };
    // `key` stands for `ids`; `titles` is read only to skip known ids.
  }, [host, key]);

  return titles;
}

/** Names an agent's workspace: a link to it, or a note that the viewer can't open it. */
function AgentWorkspace({ host, workspaceId, titles }: {
  host: Host;
  workspaceId: string;
  titles: Titles;
}) {
  const title = titles.get(workspaceId);
  if (title === null) return <Text size="sm" variant="secondary">a workspace you can't open</Text>;
  return (
    <button
      type="button"
      className="text-sm text-kumo-link hover:underline"
      onClick={() => void host.openWorkspace(workspaceId)}
    >
      {title ?? "Open workspace"}
    </button>
  );
}

function ViewerCard({ host, viewer, onChange }: {
  host: Host;
  viewer: ProbeViewer;
  onChange(viewer: ProbeViewer): void;
}) {
  const [name, setName] = useState(viewer.displayName ?? "");
  const save = useMutation();
  const editing = !viewer.displayName || name !== viewer.displayName;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await save.run(() => host.ui.setDisplayName(name));
    if (result.ok) {
      onChange(result.value);
      setName(result.value.displayName ?? "");
    }
  }

  return (
    <LayerCard className="flex flex-col gap-3 bg-kumo-control p-4">
      <div className="flex items-center justify-between gap-3">
        <Text bold>You</Text>
        <Badge variant={viewer.isAdmin ? "primary" : "secondary"}>
          {viewer.isAdmin ? "Admin" : "Member"}
        </Badge>
      </div>
      <form className="flex items-end gap-2" onSubmit={submit}>
        <div className="min-w-0 flex-1">
          <Input
            label="Display name"
            placeholder="How your notes are signed"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <Button type="submit" variant="secondary" loading={save.pending} disabled={!editing || !name.trim()}>
          Save
        </Button>
      </form>
      {!viewer.displayName && (
        <Text size="sm" variant="secondary">
          Set a display name to add or archive notes. It is how your changes are signed; it is not
          checked against your sign-in.
        </Text>
      )}
      <ErrorText>{save.error}</ErrorText>
    </LayerCard>
  );
}

function AddNote({ host, canWrite, onAdded }: { host: Host; canWrite: boolean; onAdded(): void }) {
  const [body, setBody] = useState("");
  const add = useMutation();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if ((await add.run(() => host.ui.addNote(body))).ok) {
      setBody("");
      onAdded();
    }
  }

  return (
    <LayerCard className="bg-kumo-control p-4">
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <InputArea
          label="New note"
          placeholder="Write a note for the studio"
          value={body}
          onValueChange={setBody}
          disabled={!canWrite}
          rows={3}
          maxLength={MAX_NOTE_LENGTH}
        />
        <div className="flex items-center justify-between gap-3">
          <Text size="sm" variant="secondary">{body.length} / {MAX_NOTE_LENGTH}</Text>
          <Button type="submit" variant="primary" loading={add.pending} disabled={!canWrite || !body.trim()}>
            Add note
          </Button>
        </div>
        <ErrorText>{add.error}</ErrorText>
      </form>
    </LayerCard>
  );
}

function NoteRow({ host, note, canWrite, titles, onChanged }: {
  host: Host;
  note: ProbeNoteView;
  canWrite: boolean;
  titles: Titles;
  onChanged(): void;
}) {
  const archive = useMutation();
  const author = note.author;

  return (
    <li className="flex flex-col gap-2 p-4">
      <Text DANGEROUS_className="whitespace-pre-wrap break-words">{note.body}</Text>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {author.kind === "person"
          ? <Text size="sm" variant="secondary">{author.name}</Text>
          : (
            <span className="flex items-center gap-1">
              <Badge variant="info">Agent</Badge>
              <AgentWorkspace host={host} workspaceId={author.workspaceId} titles={titles} />
            </span>
          )}
        <Text size="sm" variant="secondary">
          <time dateTime={new Date(note.createdAt).toISOString()} title={new Date(note.createdAt).toLocaleString()}>
            {formatWhen(note.createdAt)}
          </time>
        </Text>
        {note.archivedAt !== null && (
          <Badge variant="secondary">Archived{note.archivedBy ? ` by ${note.archivedBy}` : ""}</Badge>
        )}
        {note.archivedAt === null && (
          <div className="ml-auto">
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Archive note: ${snippet(note.body)}`}
              loading={archive.pending}
              disabled={!canWrite}
              onClick={async () => {
                if ((await archive.run(() => host.ui.archiveNote(note.id))).ok) onChanged();
              }}
            >
              Archive
            </Button>
          </div>
        )}
      </div>
      <ErrorText>{archive.error}</ErrorText>
    </li>
  );
}

function Notes({ host, canWrite, refreshToken, onChanged }: {
  host: Host;
  canWrite: boolean;
  refreshToken: number;
  onChanged(): void;
}) {
  const [includeArchived, setIncludeArchived] = useState(false);
  const notes = usePolled(() => host.ui.listNotes({ includeArchived }), {
    deps: [includeArchived, refreshToken],
  });
  const titles = useWorkspaceTitles(host, (notes.data ?? []).flatMap((note) =>
    note.author.kind === "agent" ? [note.author.workspaceId] : []));

  return (
    <LayerCard className="overflow-hidden bg-kumo-control p-0">
      <div className="flex items-center justify-between gap-3 border-b border-kumo-line p-4">
        <Text bold>Notes</Text>
        <Switch label="Show archived" checked={includeArchived} onCheckedChange={setIncludeArchived} />
      </div>
      {notes.error && <div className="p-4"><Banner variant="error">{notes.error}</Banner></div>}
      {notes.loading && !notes.data && <div className="flex justify-center p-6"><Loader /></div>}
      {notes.data && notes.data.length === 0 && (
        <Text variant="secondary" DANGEROUS_className="block p-4">No notes yet.</Text>
      )}
      {notes.data && notes.data.length > 0 && (
        <ul className="m-0 list-none divide-y divide-kumo-line p-0">
          {notes.data.map((note) => (
            <NoteRow
              key={note.id}
              host={host}
              note={note}
              canWrite={canWrite}
              titles={titles}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </LayerCard>
  );
}

function AuditRow({ host, entry, titles }: { host: Host; entry: AuditEntry; titles: Titles }) {
  const body = typeof entry.detail?.body === "string" ? entry.detail.body : null;
  const verb = entry.action === "note.add" ? "added a note"
    : entry.action === "note.archive" ? "archived a note"
    : entry.action === "profile.set-name" ? "set their display name"
    : entry.action;
  return (
    <li className="flex flex-col gap-1 px-4 py-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3">
        <span className="flex flex-wrap items-center gap-1">
          {entry.actor.kind === "person"
            ? <Text size="sm">{entry.actor.name} {verb}</Text>
            : (
              <>
                <Text size="sm">An agent in</Text>
                <AgentWorkspace host={host} workspaceId={entry.actor.workspaceId} titles={titles} />
                <Text size="sm">{verb}</Text>
              </>
            )}
        </span>
        <Text size="sm" variant="secondary">{formatWhen(entry.at)}</Text>
      </div>
      {body !== null && <Text size="sm" variant="secondary">“{snippet(body, 80)}”</Text>}
    </li>
  );
}

/** Merges pages of the log by `seq`, newest first, so a poll of the head never drops older pages. */
export function mergeAudit(...pages: readonly (readonly AuditEntry[])[]): AuditEntry[] {
  const bySeq = new Map<number, AuditEntry>();
  for (const page of pages) for (const entry of page) bySeq.set(entry.seq, entry);
  return [...bySeq.values()].toSorted((a, b) => b.seq - a.seq);
}

function AuditLog({ host, refreshToken }: { host: Host; refreshToken: number }) {
  const head = usePolled(() => host.ui.listAuditLog({ limit: 25 }), { deps: [refreshToken] });
  // Pages loaded with "Load older", and where the next one starts. Kept across polls of the head.
  const [older, setOlder] = useState<AuditEntry[]>([]);
  const [olderCursor, setOlderCursor] = useState<number | undefined>(undefined);
  const more = useMutation();

  const cursor = older.length ? olderCursor : head.data?.nextBefore;
  const entries = mergeAudit(head.data?.entries ?? [], older);
  const titles = useWorkspaceTitles(host, entries.flatMap((entry) =>
    entry.actor.kind === "agent" ? [entry.actor.workspaceId] : []));

  async function loadOlder() {
    const result = await more.run(() => host.ui.listAuditLog({ limit: 25, before: cursor }));
    if (result.ok) {
      setOlder((loaded) => mergeAudit(loaded, result.value.entries));
      setOlderCursor(result.value.nextBefore);
    }
  }

  return (
    <LayerCard className="overflow-hidden bg-kumo-control p-0">
      <div className="border-b border-kumo-line p-4">
        <Text bold>Audit log</Text>
        <Text size="sm" variant="secondary" DANGEROUS_className="block">
          Every change to the notes, by people in this app and by approved agent actions. Admins only.
        </Text>
      </div>
      {head.error && <div className="p-4"><Banner variant="error">{head.error}</Banner></div>}
      <ul className="m-0 list-none divide-y divide-kumo-line p-0">
        {entries.map((entry) => <AuditRow key={entry.seq} host={host} entry={entry} titles={titles} />)}
      </ul>
      {cursor !== undefined && (
        <div className="p-3">
          <Button variant="secondary" size="sm" loading={more.pending} onClick={() => void loadOlder()}>
            Load older
          </Button>
        </div>
      )}
      <div className="px-3 pb-3"><ErrorText>{more.error}</ErrorText></div>
    </LayerCard>
  );
}

/** The Probe app: who you are, a shared notes board, and (for admins) the audit log. */
export default function ProbePage({ host }: { host: Host }) {
  const viewer = usePolled(() => host.ui.getViewer(), { intervalMs: 0 });
  const [current, setCurrent] = useState<ProbeViewer | undefined>(undefined);
  // Bumped by every change made here, so the notes and the audit log reload at once rather than
  // at their next poll.
  const [refreshToken, setRefreshToken] = useState(0);
  const changed = () => setRefreshToken((n) => n + 1);
  const me = current ?? viewer.data;

  if (!me) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-6">
        {viewer.error
          ? (
            <>
              <Banner variant="error">{viewer.error}</Banner>
              <Button variant="secondary" onClick={() => void viewer.refresh()}>Try again</Button>
            </>
          )
          : <Loader />}
      </main>
    );
  }

  const canWrite = Boolean(me.displayName);
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <header className="flex flex-col gap-1">
        <Text as="h1" variant="heading" size="lg">Probe</Text>
        <Text variant="secondary">
          Shared notes for the studio and its agents. Foundation's proving gate.
        </Text>
      </header>
      <ViewerCard host={host} viewer={me} onChange={(next) => { setCurrent(next); changed(); }} />
      <AddNote host={host} canWrite={canWrite} onAdded={changed} />
      <Notes host={host} canWrite={canWrite} refreshToken={refreshToken} onChanged={changed} />
      {me.isAdmin && <AuditLog host={host} refreshToken={refreshToken} />}
    </main>
  );
}
