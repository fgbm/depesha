// Проброски AppStore на ui и selection, которые остаются только ради хостов контроллеров,
// типизированных через AppStore (#140). Компоненты берут `app.ui.*` и `app.selection.*`.
export const appProxies = [
  "choose", "confirm", "confirmation", "dismiss", "fail", "listed", "openSettings", "reload", "retext",
  "select", "setView", "settingsOpen", "showing", "takeOut", "tasks", "tasksOpen", "toast", "track", "wizard",
];

export const restrictedAppProxy = [
  "error",
  {
    selector: `MemberExpression[object.name='app'][property.name=/^(${appProxies.join("|")})$/]`,
    message: "Проброс AppStore только для хостов контроллеров: компонент берёт app.ui.* или app.selection.* напрямую (#140).",
  },
];
