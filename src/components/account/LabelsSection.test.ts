import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../../lib/testing").then((m) => m.appModule));
vi.mock("../../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../../lib/testing")).api }));
vi.mock("../../lib/theme", () => ({ applyTheme: () => {} }));

import { render } from "svelte/server";
import LabelsSection from "./LabelsSection.svelte";
import { labels } from "../../lib/labels.svelte";
import { i18n } from "../../lib/i18n.svelte";
import type { AccountForm } from "../../lib/accountForm.svelte";
import type { AccountView } from "../../lib/types";

const account = { id: "a", email: "a@x", ews: false } as unknown as AccountView;
const form = {} as unknown as AccountForm;

beforeEach(() => {
  i18n.lang = "ru";
  labels.all = {};
  labels.counts = {};
  labels.props = {};
});

describe("the label section of a mailbox's page (#42, frame 2)", () => {
  it("lists the labels with their colour, approximate count and actions", () => {
    labels.all = { a: [{ name: "Счета", keyword: "depesha-scheta", color: "#d0573f" }] };
    labels.counts = { a: { "depesha-scheta": 47 } };
    const { body } = render(LabelsSection, { props: { account, form } });
    expect(body).toContain("Счета");
    expect(body).toContain("≈47");
    expect(body).toContain("#d0573f");
    expect(body).toContain("Действия");
    // The rename affordance (its hint) and the label's own colour chip are there.
    expect(body).toContain("письма сохранят метку");
  });

  it("says so when the mailbox has no labels yet", () => {
    const { body } = render(LabelsSection, { props: { account, form } });
    expect(body).toContain("Меток пока нет");
  });

  it("hides the «where it is kept» column on Exchange (#42, frame 7)", () => {
    labels.all = { a: [{ name: "Проект", keyword: "Проект", color: "#3f7fd0" }] };
    const { body } = render(LabelsSection, { props: { account: { ...account, ews: true } as unknown as AccountView, form } });
    expect(body).toContain("Проект");
    expect(body).not.toContain("Где хранится");
  });
});
