/** Who wrote a Probe note. */
export type ProbeAuthor =
  /** A person, by the display name they set in the Probe app. Self-declared, not verified. */
  | { kind: "person"; name: string }
  /** An agent, writing from the workspace with this id. */
  | { kind: "agent"; workspaceId: string };

/** A note in the studio's shared Probe notes. */
export interface ProbeNote {
  id: string;
  body: string;
  /**
   * ISO 8601. For a pending note, when it was queued; once approved, when it was added to the
   * shared notes, so the value changes at approval.
   */
  createdAt: string;
  author: ProbeAuthor;
  /** Archived notes are hidden unless asked for. Only people archive notes, in the Probe app. */
  archived: boolean;
  /**
   * True for a note this workspace added that is not approved yet. It is visible here at once, as if
   * already added; other workspaces and the Probe app see it once it is approved.
   */
  pending: boolean;
}

/**
 * The studio's shared Probe notes: a small proving ground for VEER Studio OS gates. Every person in
 * the studio and every studio workspace sees the same notes.
 */
export interface ProbeSession {
  /**
   * Lists notes, newest first, including this workspace's pending ones. Returns at most the 500
   * newest stored notes, plus pending ones.
   * @param options `includeArchived` also returns archived notes.
   */
  listNotes(options?: { includeArchived?: boolean }): Promise<ProbeNote[]>;

  /**
   * Reads one note.
   * @param id A note id from `listNotes()` or `addNote()`.
   * @returns The note, or null if there is none with that id.
   */
  getNote(id: string): Promise<ProbeNote | null>;

  /**
   * Adds a note. It is queued for approval and visible to this workspace at once, with
   * `pending: true`; keep working without waiting for it. Fails while this workspace already has 50
   * notes awaiting a decision.
   * @param body The note, 1 to 2000 characters after trimming. Line breaks and tabs are kept; other
   *   control characters and invisible formatting characters (such as bidirectional overrides) are
   *   refused, except the zero-width joiner and non-joiner.
   * @returns The pending note, with its final id.
   */
  addNote(body: string): Promise<ProbeNote>;
}
