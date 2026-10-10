// Правило eslint «no-silent-catch» (issue #147): ошибку нельзя глотать молча.
// Молчаливым считается:
//   - `catch {}` без привязки, пустой `catch (e) {}` и `catch (e) {…}`, где `e` не используется;
//   - `.catch(fn)` и второй аргумент `.then(ok, fn)` (также `p["catch"]`), если `fn` не использует
//     ошибку, имеет пустое тело или это `noop`.
// `.catch(console.error)` не молчит: ошибка видна в консоли разработчика.
// Исключение — непустой комментарий о том, почему можно молчать: внутри обработчика либо отдельной
// строкой выше (вплотную). Хвостовой комментарий предыдущей инструкции или конца строки не считается.
const isFn = (n) => n && (n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression");
const nameOf = (m) => (m.computed ? (m.property.type === "Literal" ? m.property.value : null) : m.property.name);

const rule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      silent: "Заглушённая ошибка: покажите её (app.fail), запишите в журнал или объясните комментарием, почему можно молчать.",
    },
  },
  create(context) {
    const source = context.sourceCode;
    const filled = (c) => c.value.trim().length > 0;
    const insideOf = (node) => source.getAllComments().some((c) => filled(c) && c.range[0] >= node.range[0] && c.range[1] <= node.range[1]);
    // Комментарий на своей строке, заканчивающийся строкой выше первого токена этой строки.
    const ownLineAbove = (token) => {
      let first = token;
      for (let prev = source.getTokenBefore(first); prev && prev.loc.end.line === token.loc.start.line; prev = source.getTokenBefore(first)) first = prev;
      const above = source.getCommentsBefore(first).at(-1);
      if (!above || !filled(above) || above.loc.end.line !== first.loc.start.line - 1) return false;
      const before = source.getTokenBefore(above, { includeComments: true });
      return !before || before.loc.end.line < above.loc.start.line;
    };
    const used = (fn, param) => {
      if (param.type !== "Identifier") return true;
      const variable = source.getDeclaredVariables(fn).find((v) => v.name === param.name);
      return !variable || variable.references.length > 0;
    };
    // Обработчик не использует ошибку: нет параметра, он не читается или тело пусто.
    const ignores = (h) => {
      if (isFn(h)) return h.params.length === 0 || !used(h, h.params[0]) || (h.body.type === "BlockStatement" && h.body.body.length === 0);
      return h.type === "Identifier" && /^noop$/i.test(h.name);
    };
    const check = (handler, anchor) => {
      if (!ignores(handler)) return;
      if (isFn(handler) && insideOf(handler)) return;
      if (ownLineAbove(anchor) || ownLineAbove(source.getFirstToken(handler))) return;
      context.report({ node: handler, messageId: "silent" });
    };
    return {
      CatchClause(node) {
        const silent = !node.param || node.body.body.length === 0 || !used(node, node.param);
        if (!silent || insideOf(node)) return;
        const keyword = source.getFirstToken(node);
        if (!ownLineAbove(keyword)) context.report({ node, messageId: "silent" });
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        const name = nameOf(callee);
        const handler = name === "catch" ? node.arguments[0] : name === "then" ? node.arguments[1] : null;
        if (handler) check(handler, source.getTokenBefore(callee.property, { filter: (t) => t.value === "." || t.value === "?." || t.value === "[" }) ?? callee.property);
      },
    };
  },
};

export default { rules: { "no-silent-catch": rule } };
