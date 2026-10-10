// Правило eslint «no-silent-catch» (issue #147): ошибку нельзя глотать молча.
// Молчаливым считается `catch {}` без привязки и пустой `catch (e) {}`, а также `.catch(fn)`, где fn
// не принимает ошибку или тело её пусто. Исключение — комментарий о том, почему можно молчать: внутри
// обработчика, на той же строке или строкой выше.
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
    const explained = (node, line) =>
      source.getAllComments().some((c) => {
        const inside = c.range[0] >= node.range[0] && c.range[1] <= node.range[1];
        return inside || c.loc.start.line === line || c.loc.end.line === line - 1;
      });
    const isFn = (n) => n && (n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression");
    return {
      CatchClause(node) {
        const silent = !node.param || node.body.body.length === 0;
        if (silent && !explained(node, node.loc.start.line)) context.report({ node, messageId: "silent" });
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.property.name !== "catch") return;
        const handler = node.arguments[0];
        if (!isFn(handler)) return;
        const emptyBody = handler.body.type === "BlockStatement" && handler.body.body.length === 0;
        if (handler.params.length > 0 && !emptyBody) return;
        if (!explained(handler, callee.property.loc.start.line)) context.report({ node: handler, messageId: "silent" });
      },
    };
  },
};

export default { rules: { "no-silent-catch": rule } };
