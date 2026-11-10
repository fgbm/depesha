import type { Replacement } from "@depesha/plugin-api";

export const TABLE: Replacement[] = [
  { from: "--", to: "\u2014" },
  { from: "...", to: "\u2026" },
];
