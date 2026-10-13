import { Badge, Banner, Button, Input, InputArea, LayerCard, Loader, Switch, Text } from "@cloudflare/kumo";
import { useMutation, usePolled, type StudioAppHost } from "@veer/studio-kit/app";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { AuditEntry, AuditPage } from "@veer/studio-kit/audit-types";
import { MAX_NOTE_LENGTH, type ProbeNoteView, type ProbeUi, type ProbeViewer } from "../src/ui-types";

type Host = StudioAppHost<ProbeUi>;

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

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
    const next = await save.run(() => host.ui.setDisplayName(name));
    if (next) {
      onChange(next);
      setName(next.displayName ?? "");
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
      {save.error && <Text size="sm" variant="error">{save.error}</Text>}
    </LayerCard>
  );
}

function AddNote({ host, canWrite, onAdded }: { host: Host; canWrite: boolean; onAdded(): void }) {
  const [body, setBody] = useState("");
  const add = useMutation();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await add.run(() => host.ui.addNote(body))) {
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
        {add.error && <Text size="sm" variant="error">{add.error}</Text>}
      </form>
    </LayerCard>
  );
}

function NoteRow({ host, note, canWrite, workspaceTitle, onChanged }: {
  host: Host;
  note: ProbeNoteView;
  canWrite: boolean;
  workspaceTitle: string | null | undefined;
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
              {workspaceTitle
                ? (
                  <button
                    type="button"
                    className="text-sm text-kumo-link hover:underline"
                    onClick={() => void host.openWorkspace(author.workspaceId)}
                  >
                    {workspaceTitle}
                  </button>
                )
                : <Text size="sm" variant="secondary">a workspace you can't open</Text>}
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
              loading={archive.pending}
              disabled={!canWrite}
              onClick={async () => {
                if (await archive.run(() => host.ui.archiveNote(note.id))) onChanged();
              }}
            >
              Archive
            </Button>
          </div>
        )}
      </div>
      {archive.error && <Text size="sm" variant="error">{archive.error}</Text>}
    </li>
  );
}

function useWorkspaceTitles(host: Host, notes: ProbeNoteView[] | undefined) {
  const ids = useMemo(() => {
    const unique = new Set<string>();
    for (const note of notes ?? []) {
      if (note.author.kind === "agent") unique.add(note.author.workspaceId);
    }
    // The host resolves at most 100 per call.
    return [...unique].toSorted().slice(0, 100);
  }, [notes]);
  const key = ids.join(",");
  const [titles, setTitles] = useState<Map<string, string | null>>(new Map());

  useEffect(() => {
    if (!ids.length) return;
    let current = true;
    host.resolveWorkspaceTitles(ids).then(
      (resolved) => {
        if (current) setTitles(new Map(ids.map((id, index) => [id, resolved[index] ?? null])));
      },
      () => {},
    );
    return () => {
      current = false;
    };
    // `key` stands for `ids`, whose identity changes on every poll.
  }, [host, key]);

  return titles;
}

function Notes({ host, canWrite, refreshToken }: { host: Host; canWrite: boolean; refreshToken: number }) {
  const [includeArchived, setIncludeArchived] = useState(false);
  const notes = usePolled(() => host.ui.listNotes({ includeArchived }), {
    deps: [includeArchived, refreshToken],
  });
  const titles = useWorkspaceTitles(host, notes.data);

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
              workspaceTitle={note.author.kind === "agent" ? titles.get(note.author.workspaceId) : undefined}
              onChanged={() => void notes.refresh()}
            />
          ))}
        </ul>
      )}
    </LayerCard>
  );
}

function describeAudit(entry: AuditEntry): string {
  const who = entry.actor.kind === "person" ? entry.actor.name : "An agent";
  switch (entry.action) {
    case "note.add": return `${who} added a note`;
    case "note.archive": return `${who} archived a note`;
    case "profile.set-name": return `${who} set their display name`;
    default: return `${who}: ${entry.action}`;
  }
}

function AuditLog({ host, refreshToken }: { host: Host; refreshToken: number }) {
  const [older, setOlder] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const first = usePolled(() => host.ui.listAuditLog({ limit: 25 }), { deps: [refreshToken] });
  const more = useMutation();

  useEffect(() => {
    setOlder([]);
    setCursor(first.data?.nextBefore);
  }, [first.data]);

  async function loadOlder() {
    const page: AuditPage | undefined = await more.run(() => host.ui.listAuditLog({ limit: 25, before: cursor }));
    if (page) {
      setOlder((entries) => [...entries, ...page.entries]);
      setCursor(page.nextBefore);
    }
  }

  const entries = [...(first.data?.entries ?? []), ...older];
  return (
    <LayerCard className="overflow-hidden bg-kumo-control p-0">
      <div className="border-b border-kumo-line p-4">
        <Text bold>Audit log</Text>
        <Text size="sm" variant="secondary" DANGEROUS_className="block">
          Every change to the notes, by people in this app and by approved agent actions. Admins only.
        </Text>
      </div>
      {first.error && <div className="p-4"><Banner variant="error">{first.error}</Banner></div>}
      <ul className="m-0 list-none divide-y divide-kumo-line p-0">
        {entries.map((entry) => (
          <li key={entry.seq} className="flex items-center justify-between gap-3 px-4 py-2">
            <Text size="sm">{describeAudit(entry)}</Text>
            <Text size="sm" variant="secondary">{formatWhen(entry.at)}</Text>
          </li>
        ))}
      </ul>
      {cursor !== undefined && (
        <div className="p-3">
          <Button variant="secondary" size="sm" loading={more.pending} onClick={() => void loadOlder()}>
            Load older
          </Button>
        </div>
      )}
      {more.error && <Text size="sm" variant="error" DANGEROUS_className="block p-3">{more.error}</Text>}
    </LayerCard>
  );
}

/** The Probe app: who you are, a shared notes board, and (for admins) the audit log. */
export default function ProbePage({ host }: { host: Host }) {
  const viewer = usePolled(() => host.ui.getViewer(), { intervalMs: 0 });
  const [current, setCurrent] = useState<ProbeViewer | undefined>(undefined);
  const [refreshToken, setRefreshToken] = useState(0);
  const me = current ?? viewer.data;

  if (!me) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        {viewer.error ? <Banner variant="error">{viewer.error}</Banner> : <Loader />}
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
      <ViewerCard host={host} viewer={me} onChange={setCurrent} />
      <AddNote host={host} canWrite={canWrite} onAdded={() => setRefreshToken((n) => n + 1)} />
      <Notes host={host} canWrite={canWrite} refreshToken={refreshToken} />
      {me.isAdmin && <AuditLog host={host} refreshToken={refreshToken} />}
    </main>
  );
}
