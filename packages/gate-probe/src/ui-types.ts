/**
 * The Probe app's flat `ui` capability, shared by the Worker (`ProbeAppApi`) and the app: the types,
 * and the one limit both enforce. The app imports nothing else from the Worker.
 */

import type { AuditPage } from "@veer/studio-kit/audit-types";

/** The person the app is open for. */
export type ProbeViewer = {
  /** `AppUiContext.isAdmin` from this mount. */
  isAdmin: boolean;
  /** The self-declared name their edits are signed with; null until they set one. */
  displayName: string | null;
};

/** A note as the app shows it. */
export type ProbeNoteView = {
  id: string;
  body: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
  author:
    | { kind: "person"; name: string }
    | { kind: "agent"; workspaceId: string };
  archivedAt: number | null;
  /** The display name of whoever archived it. */
  archivedBy: string | null;
};

/** Every method is top-level: the host's rate limiter forwards top-level method names only. */
export interface ProbeUi {
  getViewer(): Promise<ProbeViewer>;
  setDisplayName(name: string): Promise<ProbeViewer>;
  listNotes(options?: { includeArchived?: boolean }): Promise<ProbeNoteView[]>;
  addNote(body: string): Promise<ProbeNoteView>;
  archiveNote(noteId: string): Promise<ProbeNoteView>;
  /** Admins only. */
  listAuditLog(options?: { limit?: number; before?: number }): Promise<AuditPage>;
}

/** The longest note, in characters. */
export const MAX_NOTE_LENGTH = 2000;
