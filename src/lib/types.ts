// The types the backend sends are generated from the Rust structs (`generated/types.ts`, #143, by
// `scripts/gen-types.sh`) and passed on from here. What is written below is the interface's own, or
// aliases of its fields.
import type {
  Account,
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

export type Theme = Settings["theme"];
export type LetterViewPref = Settings["letter_view"];
export type ViewRule = NonNullable<Account["letter_view"]>;
