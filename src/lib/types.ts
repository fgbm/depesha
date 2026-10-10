// The types the backend sends are generated from the Rust structs (`generated/types.ts`, #143, by
// `scripts/gen-types.sh`) and passed on from here. What is written below is the interface's own, or
// a generated type loosened where Rust takes fields missing.
import type {
  Account,
  AttachmentSourceWire,
  CachedDraftWire,
  ComposeDraftWire,
  FollowupPlanWire,
  ListQueryWire,
  Settings,
} from "./generated/types";

export type * from "./generated/types";

/** One action the folder card shows, with its rights outcome. */
export interface ActionRight {
  action: FolderAction;
  allowed: boolean;
  /** The action is unknown until the folder is checked: shown neither on nor off. */
  unknown: boolean;
}

export type FolderAction = "read" | "mark_seen" | "write" | "insert" | "delete" | "create_child" | "delete_folder" | "administer";

/** Fields Rust takes missing (they have a default), sent by the interface without them. */
type Loose<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/** The query is whole-struct `#[serde(default)]` in Rust: any field may be left out. */
export type ListQuery = Partial<ListQueryWire>;

/** Most of the plan is `#[serde(default)]` in Rust; the choice of the wait is always given. */
export type FollowupPlan = Loose<FollowupPlanWire, "due_at" | "deadline_at" | "park" | "archive">;

/** What the compose window attaches: Rust reads the source, the interface also keeps the shown name and size. */
export type AttachmentSource = AttachmentSourceWire & { name: string; size: number };

/** The letter as the window holds it; Rust takes the fields with a default missing. */
export type ComposeDraft = Loose<
  Omit<ComposeDraftWire, "attachments"> & { attachments: AttachmentSource[] },
  "html" | "signature" | "format" | "send_at" | "acts_on" | "importance"
>;

/** A draft kept locally; Rust takes the server copy's ids missing. */
export type CachedDraft = Loose<Omit<CachedDraftWire, "draft"> & { draft: ComposeDraft }, "draft_id" | "draft_message_id">;

export type Theme = Settings["theme"];
export type LetterViewPref = Settings["letter_view"];
export type ViewRule = NonNullable<Account["letter_view"]>;
