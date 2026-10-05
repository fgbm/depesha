// The formats the core shows, registered in the same registry as plugins' renderers.
// Heavy libraries (pdf.js, docx-preview, SheetJS) load inside their renderers on first use.
import { registry } from "../plugin-host/registry.svelte";
import type { FileViewer } from "./viewer";
import CsvView from "../components/viewer/CsvView.svelte";
import DocView from "../components/viewer/DocView.svelte";
import ImageView from "../components/viewer/ImageView.svelte";
import LetterView from "../components/viewer/LetterView.svelte";
import MediaView from "../components/viewer/MediaView.svelte";
import PdfView from "../components/viewer/PdfView.svelte";
import TextView from "../components/viewer/TextView.svelte";

const TEXT = [
  "txt", "log", "text", "ini", "cfg", "conf", "json", "xml", "yaml", "yml", "toml", "sql", "py", "rs", "ts", "tsx", "jsx",
  "css", "java", "c", "h", "cpp", "cs", "go", "rb", "php", "bsl", "diff", "patch", "ics", "vcf", "srt", "properties", "env",
];

export const CORE_VIEWERS: FileViewer[] = [
  { id: "image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif"], mimes: ["image/*"], component: ImageView },
  { id: "pdf", extensions: ["pdf"], mimes: ["application/pdf"], component: PdfView },
  { id: "docx", extensions: ["docx"], mimes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"], component: DocView, props: { format: "docx" } },
  {
    id: "sheet",
    extensions: ["xlsx", "xlsm", "xls", "ods"],
    mimes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel", "application/vnd.oasis.opendocument.spreadsheet"],
    component: DocView,
    props: { format: "sheet" },
  },
  { id: "markdown", extensions: ["md", "markdown"], mimes: ["text/markdown"], component: DocView, props: { format: "markdown" } },
  { id: "html", extensions: ["html", "htm"], mimes: ["text/html"], component: DocView, props: { format: "html" } },
  { id: "csv", extensions: ["csv", "tsv"], mimes: ["text/csv", "text/tab-separated-values"], component: CsvView },
  { id: "letter", extensions: ["eml"], mimes: ["message/rfc822"], component: LetterView },
  { id: "audio", extensions: ["mp3", "wav", "ogg", "oga", "m4a", "opus", "flac"], mimes: ["audio/*"], component: MediaView, props: { kind: "audio" } },
  { id: "video", extensions: ["mp4", "webm", "ogv", "mov", "m4v"], mimes: ["video/*"], component: MediaView, props: { kind: "video" } },
  // The most general one: any text/* nobody else claimed.
  { id: "text", extensions: TEXT, mimes: ["text/*"], priority: -1, component: TextView },
];

export function registerCoreViewers() {
  for (const v of CORE_VIEWERS) registry.add("fileViewers", "core", v);
}
