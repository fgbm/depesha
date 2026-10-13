#!/usr/bin/env bash
# Flags code comments that restate the code, refer to review history, or narrate steps.
# The rules are in AGENTS.md, section Code rules.
#
#   scripts/check-comments.sh                    scan the repository
#   COMMENT_CHECK_DIRS=dir1 dir2 scripts/...     scan these directories instead
#
# Scans *.rs in crates/ and src-tauri/src/, and *.ts/*.svelte/*.js/*.mjs in src/, plugins/,
# e2e/ and scripts/. Generated files, node_modules, vendor, dist* and target are skipped.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if ! command -v rg >/dev/null 2>&1; then
  echo "check-comments: ripgrep (rg) is not installed" >&2
  exit 2
fi

# The files to scan. The self-test points COMMENT_CHECK_DIRS at the fixture directory.
if [[ -n "${COMMENT_CHECK_DIRS:-}" ]]; then
  read -r -a dirs <<<"$COMMENT_CHECK_DIRS"
  mapfile -t files < <(
    rg --files "${dirs[@]}" -g '*.rs' -g '*.ts' -g '*.svelte' -g '*.js' -g '*.mjs' 2>/dev/null | sort -u
  )
else
  mapfile -t files < <(
    {
      rg --files crates src-tauri/src -g '*.rs'
      rg --files src plugins e2e scripts -g '*.ts' -g '*.svelte' -g '*.js' -g '*.mjs'
    } 2>/dev/null |
      grep -vE '(^|/)(node_modules|vendor|target|dist|dist-demo|dist-demo\.zip)/' |
      grep -vE '^src/lib/generated/|^src/lib/bindings|^docs/plugin-api\.snapshot\.d\.ts$|^scripts/testdata/' |
      sort -u
  )
fi

violations=0
allowed=0

for file in "${files[@]}"; do
  [[ -f $file ]] || continue
  case "$file" in
    *.rs) ext=rs ;;
    *.svelte) ext=svelte ;;
    *) ext=ts ;;
  esac
  # Every line the checker reads is emitted as "V file:line: rule: text" (a violation) or
  # "A file:line: allow: text" (a line skipped by its `comment-check: allow` marker).
  while IFS= read -r out; do
    [[ -n $out ]] || continue
    case "$out" in
      A\ *) allowed=$((allowed + 1)) ;;
      *) violations=$((violations + 1)) ;;
    esac
    printf '%s\n' "${out#? }"
  done < <(awk -v ext="$ext" -v f="$file" '
    function ltrim(s) { sub(/^[ \t]+/, "", s); return s }
    function rtrim(s) { sub(/[ \t]+$/, "", s); return s }
    function trim(s) { return rtrim(ltrim(s)) }
    function clean(w) { gsub(/[^A-Za-z0-9_]/, "", w); return w }
    function stem(w,   n) {
      w = tolower(w); n = length(w)
      if (n > 4 && w ~ /ing$/) return substr(w, 1, n - 3)
      if (n > 3 && w ~ /ed$/)  return substr(w, 1, n - 2)
      if (n > 3 && w ~ /es$/)  return substr(w, 1, n - 2)
      if (n > 2 && w ~ /s$/)   return substr(w, 1, n - 1)
      return w
    }
    # True when the '.' at i ends a sentence: a '.' between non-spaces is inside a token
    # (a.b, query.rs, Intl.PluralRules, 7.2.2, E.2); an abbreviation does not end one.
    function is_end(t, i,   j, tok, after) {
      after = substr(t, i + 1, 1)
      if (after != "" && after != " ") return 0
      j = i - 1
      while (j >= 1 && substr(t, j, 1) != " ") j--
      tok = substr(t, j + 1, i - j - 1)
      if (tok ~ /^(e\.g|i\.e|etc|vs)$/) return 0
      if (length(tok) == 1) return 0
      return 1
    }
    # Sentences of a block, split on the periods that end one (see is_end). Fills out, returns the count.
    function split_sentences(text, out,   n, i, len, start, s) {
      n = 0; start = 1; len = length(text)
      for (i = 1; i <= len; i++) {
        if (substr(text, i, 1) == "." && is_end(text, i)) {
          n++; out[n] = trim(substr(text, start, i - start + 1)); start = i + 1
        }
      }
      if (start <= len) { s = trim(substr(text, start)); if (s != "") { n++; out[n] = s } }
      return n
    }
    # The subject of a sentence: its first word after an article or a determiner.
    function subject_of(sent,   n, w, k) {
      n = split(trim(sent), w, /[ \t]+/)
      k = 1
      while (k <= n && tolower(clean(w[k])) ~ /^(the|a|an|this|that|these|its|their)$/) k++
      if (k <= n) return tolower(clean(w[k]))
      return ""
    }
    # The name of the item a comment block documents, empty when the next line is not an item.
    function is_item(line,   rest) {
      if (ext == "rs") {
        if (line ~ /^[ \t]*(pub(\([^)]*\))?[ \t]+)?(async[ \t]+)?(unsafe[ \t]+)?(fn|struct|enum|const|type|trait|mod|union)[ \t]+[A-Za-z_]/) {
          rest = line
          sub(/^[ \t]*(pub(\([^)]*\))?[ \t]+)?(async[ \t]+)?(unsafe[ \t]+)?(fn|struct|enum|const|type|trait|mod|union)[ \t]+/, "", rest)
          sub(/[^A-Za-z0-9_].*$/, "", rest); return rest
        }
        if (line ~ /^[ \t]*(pub(\([^)]*\))?[ \t]+)?[A-Za-z_][A-Za-z0-9_]*[ \t]*:/) {
          rest = line; sub(/^[ \t]*(pub(\([^)]*\))?[ \t]+)?/, "", rest); sub(/[ \t]*:.*$/, "", rest); return rest
        }
        return ""
      }
      if (line ~ /^[ \t]*(export[ \t]+)?(default[ \t]+)?(async[ \t]+)?(function|class|interface|type|enum|const|let|var)[ \t]+[A-Za-z_$]/) {
        rest = line
        sub(/^[ \t]*(export[ \t]+)?(default[ \t]+)?(async[ \t]+)?(function|class|interface|type|enum|const|let|var)[ \t]+/, "", rest)
        sub(/[^A-Za-z0-9_$].*$/, "", rest); return rest
      }
      return ""
    }
    function emit(n, rule, text) { printf "V %s:%d: %s: %s\n", f, n, rule, text }
    function allow(n, text) { printf "A %s:%d: allow: %s\n", f, n, text }
    function linerules(n, text,   nw, _w) {
      if (text ~ /\.$/) {
        nw = split(text, _w, /[ \t]+/)
        if (nw <= 5 && (text ~ /^(The|A|An)([ \t][^.]{0,40})\.$/ || text ~ /^(Returns?|Creates?|Gets?|Sets?|Checks?|Handles?)([ \t][^.]{0,40})\.$/)) emit(n, "restatement", text)
      }
      if (text ~ /^The function (returns|takes|checks|selects|handles)([ \t]|$)/ || text ~ /^This (function|method|component) /) emit(n, "boilerplate", text)
      if (text ~ /^(Now|Then)([ ,]|$)/ || text ~ /^(First|Next|Finally)(,|:)([ \t]|$)/ || text ~ /^Step [0-9]+([ \t]|$)/) emit(n, "narration", text)
      if ((text ~ /(^|[^A-Za-z0-9_])[NHMLD][0-9]+([^A-Za-z0-9_]|$)/ && text !~ /[NHMLD][0-9]+[-–]/) || text ~ /(per (the )?review|review finding|after review|issue #[0-9]+)/) emit(n, "review-ref", text)
    }
    # A doc block (/// | //! run, or /** ... */) checked against the item it documents.
    function docblock(n, text, nxt,   item, s, p, nw, k, m, sw, np, cnt, nm, w, hit, all, run, prev, subj, q, c, prevc, ns, sq, SEN) {
      if (text == "") return
      linerules(n, text)
      ns = split_sentences(text, SEN)
      item = (nxt <= NR) ? is_item(L[nxt]) : ""
      if (item != "" && ns > 0) {
        s = SEN[1]; sub(/\.$/, "", s); s = trim(s)
        if (s != "") {
          nw = split(s, sw, /[ \t]+/)
          if (nw <= 6) {
            for (k = 1; k <= nw; k++) sw[k] = stem(clean(sw[k]))
            nm = ""; prevc = ""
            for (q = 1; q <= length(item); q++) {
              c = substr(item, q, 1)
              if (q > 1 && c ~ /[A-Z]/ && prevc ~ /[a-z0-9]/) nm = nm "_"
              nm = nm c; prevc = c
            }
            cnt = split(nm, np, "_"); all = (cnt > 0)
            for (k = 1; k <= cnt; k++) {
              w = stem(clean(np[k])); if (w == "") continue
              hit = 0
              for (m = 1; m <= nw; m++) if (sw[m] == w) { hit = 1; break }
              if (!hit) { all = 0; break }
            }
            if (all) emit(n, "name-echo", text)
          }
        }
      }
      # Three or more sentences in a row with one subject; the article or determiner is not the subject.
      run = 0; prev = ""
      for (sq = 1; sq <= ns; sq++) {
        subj = subject_of(SEN[sq])
        if (subj != "" && subj == prev) run++; else { run = 1; prev = subj }
        if (run >= 3) { emit(n, "same-subject", text); break }
      }
    }
    { L[NR] = $0 }
    END {
      i = 1
      while (i <= NR) {
        s = trim(L[i])
        if (s == "") { i++; continue }
        if (s ~ /comment-check: allow/) { allow(i, s); i++; continue }
        if (s ~ /^\/\*\*/ || s ~ /^\/\*/) {
          doc = (s ~ /^\/\*\*/) ? 1 : 0
          start = i; text = ""; first = 1; skip = 0
          while (i <= NR) {
            cur = L[i]; t = cur
            if (first) { sub(/^[ \t]*\/\*+[ \t]?/, "", t); first = 0 } else { sub(/^[ \t]*\*[ \t]?/, "", t) }
            last = (cur ~ /\*\//)
            if (last) sub(/\*\/.*$/, "", t)
            if (cur ~ /comment-check: allow/) skip = 1
            t = trim(t); if (t != "") text = (text == "" ? t : text " " t)
            i++
            if (last) break
          }
          if (skip) { allow(start, text); continue }
          if (doc) docblock(start, text, i); else linerules(start, text)
          continue
        }
        if (ext == "svelte" && s ~ /^<!--/) {
          start = i; text = s; sub(/^<!--[ \t]?/, "", text); skip = 0
          if (text ~ /-->/) { sub(/-->.*$/, "", text) }
          else {
            while (i < NR) {
              i++; cur = trim(L[i])
              if (cur ~ /comment-check: allow/) skip = 1
              if (cur ~ /-->/) { sub(/-->.*$/, "", cur); text = (text == "" ? cur : text " " cur); break }
              text = (text == "" ? cur : text " " cur)
            }
          }
          if (s ~ /comment-check: allow/) skip = 1
          i++
          if (skip) { allow(start, text); continue }
          linerules(start, trim(text))
          continue
        }
        if (s ~ /^\/\/\// || s ~ /^\/\/!/) {
          start = i; text = ""; skip = 0
          while (i <= NR) {
            cur = trim(L[i])
            if (cur !~ /^\/\/\// && cur !~ /^\/\/!/) break
            if (cur ~ /comment-check: allow/) skip = 1
            t = cur; sub(/^\/\/[\/!][ \t]?/, "", t); t = trim(t)
            if (t != "") text = (text == "" ? t : text " " t)
            i++
          }
          if (skip) { allow(start, text); continue }
          docblock(start, text, i)
          continue
        }
        if (s ~ /^\/\//) {
          start = i; t = s; sub(/^\/\/[ \t]?/, "", t)
          if (s ~ /comment-check: allow/) { allow(start, t); i++; continue }
          linerules(start, trim(t))
          i++
          continue
        }
        i++
      }
    }
  ' "$file")
done

echo "check-comments: files ${#files[@]}, violations $violations, allowed $allowed"
if [[ $violations -gt 0 ]]; then
  exit 1
fi
exit 0
