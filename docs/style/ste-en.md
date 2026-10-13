# English style guide (STE)

English text in Depesha obeys ASD-STE100 Simplified Technical English. This guide is a project summary. It does not replace the standard. Get the full standard and the dictionary from the [ASD-STE100 website](https://www.asd-ste100.org).

STE applies to: documentation, README files, design documents, UI text, error messages, log messages, and commit messages written in English.

STE does not apply to code comments and doc comments. They use plain short technical English: one idea in each sentence, pronouns are allowed. STE in comments gives repetitive prose ("The caller ... The caller ... The function returns ..."). Russian text follows [ru-technical.md](ru-technical.md).

## 1. Words

<!-- vale off -->

1. Use words from the STE dictionary with their approved meaning only.
2. Use technical nouns and technical verbs from the [glossary](#5-glossary) and from the field.
3. Use one word for one concept. Do not use synonyms. For example, always "message", never "letter" or "e-mail" for the same thing.
4. Do not use phrasal verbs ("set up", "carry out"). Use one verb ("configure", "do").
5. Do not use contractions ("don't", "it's").
6. Do not use "please", "simply", "just", "easily", "obviously".
7. Use "must" for a requirement. Do not use "should" for a requirement.

<!-- vale on -->

## 2. Sentences

1. A sentence in a procedure has 20 words or fewer.
2. A sentence in a description has 25 words or fewer.
3. A paragraph has 6 sentences or fewer.
4. Use the active voice. Write "Depesha sends the message", not "The message is sent".
5. Use the simple tenses: present, past, future.
6. Write one topic in each sentence.
7. Write each paragraph as one line, however long it is. A line break is only between blocks: headings, paragraphs, list items, tables and code blocks. `scripts/md-onelines.mjs` checks this rule.

## 3. Procedures

1. Write one instruction in each step.
2. Use the imperative: "Open the file".
3. If a condition applies, write the condition first: "If the account is offline, do step 4".
4. Put a warning or a caution before the step that it applies to.
5. Number the steps.

## 4. Notes, warnings and cautions

| Type | Use for | Example |
|---|---|---|
| Warning | A risk of data loss or a security problem. | "Do not erase the folder. The messages are lost." |
| Caution | A risk of damage to the settings or the account. | "Do not close the window while the background task runs." |
| Note | Useful information. No risk. | "The plugin starts only when you open it." |

Write a warning or a caution as a short command, then the reason: "Do not erase the folder. The messages are lost."

## 5. Glossary

<!-- vale off -->

| Term | Meaning | Do not use |
|---|---|---|
| message | One email message. | letter (for a message), e-mail |
| conversation | The messages of one exchange, shown as one row. | thread (in prose; `thread` in code is allowed) |
| account | A mail account set up in Depesha. | mailbox (for an account), profile |
| folder | A place on the server or in Depesha that holds messages. | mailbox (IMAP sense), directory |
| label | A user mark on a message or folder. | tag |
| reader | The area of the window that shows the open message. | viewer, preview pane |
| message list | The messages of the open folder. | listing |
| toolbar | The row of buttons above the list and the reader. | action bar |
| Outbox | The folder with messages that wait to be sent. | outgoing queue |
| background task | Work that Depesha does in the background: sync, download, clean-up. | job |
| plugin | A part of Depesha that the user can switch off; outside receiving and sending mail. | extension, add-on, addon |
| list cursor | The message in the list that has keyboard focus. | current message, highlighted message |
| caret | The input position in a text field or editor. | text cursor |
| selection | The set of checked messages the toolbar acts on. | highlighted messages |
| attachment | A file sent with a message. | file (for an attachment) |
| erase | Delete permanently, without Trash. | purge, wipe |
| settings | The settings window and its values. | preferences, options |

<!-- vale on -->

## 6. Review checklist

Use this checklist for each review of English text:

- [ ] Each sentence has the correct maximum length.
- [ ] Each procedure step has one instruction in the imperative.
- [ ] The text uses the active voice.
- [ ] Each concept has the term from the glossary.
- [ ] There are no phrasal verbs, contractions or filler words.
- [ ] "must" is used for a requirement, not "should".
- [ ] Warnings and cautions come before the steps.
- [ ] `scripts/md-onelines.mjs` shows no violations.
