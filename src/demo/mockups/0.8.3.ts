// The questions of the 0.8.3 mockup, in one place: the panel reads them, and the components
// of the mockup branch read `variant("<id>")` for the option chosen.
//
// A question is a design decision that is not made yet. Its options are short ids (A, Б, В)
// shown in the panel and in the URL; the recommended one is starred but never chosen by
// default. The list is empty here: this step builds the mechanism, the questions of 0.8.3
// come next, and inventing them now would be exactly the failure the live mockup is meant
// to stop — an unanswered decision quietly filled in by whoever wrote the code.
//
// Shape, for the next step:
//
//   { id: "1.1", title: "Красная полоса курсора в списке",
//     options: [ { id: "A", title: "как сейчас: тонкая линия" },
//                { id: "Б", title: "толстая полоса", recommended: true },
//                { id: "В", title: "без полосы" } ] }

import type { Question } from "../variants.svelte";

export const QUESTIONS: Question[] = [];
