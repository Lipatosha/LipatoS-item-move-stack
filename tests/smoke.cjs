const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("main.js", "utf8");
const events = new Map();
const notices = [];
const sandbox = {
  Hooks: { once() {} },
  game: { user: { isGM: false } },
  document: {
    addEventListener(type, cb) {
      const list = events.get(type) ?? [];
      list.push(cb);
      events.set(type, list);
    }
  },
  ui: { notifications: { warn: message => notices.push(message) } },
  console
};

vm.runInNewContext(source + `
  globalThis.testApi = {
    imsRunOldLeftClick,
    imsInstallNativeLeftClickView,
    imsCleanContextMenu,
    imsInjectContextTransfer,
    setContextItem: item => { imsLastContextItem = item; }
  };
`, sandbox, { filename: "main.js" });

const api = sandbox.testApi;
const used = { native: 0, sheet: 0, stopped: 0 };

const item = {
  id: "test-item",
  isOwner: true,
  parent: {},
  sheet: { render() { used.sheet++; } }
};

const nativeAction = {
  isConnected: true,
  click() {
    const event = {
      button: 0,
      target: {
        closest() {
          return { closest: () => ({}) };
        }
      },
      preventDefault() { used.stopped++; },
      stopPropagation() { used.stopped++; },
      stopImmediatePropagation() { used.stopped++; }
    };
    for (const fn of events.get("click") ?? []) fn(event);
    used.native++;
  }
};
const row = { querySelector() { return nativeAction; } };

api.imsInstallNativeLeftClickView();
api.imsRunOldLeftClick(item, row);
assert.equal(used.native, 1, "right-click use should replay original click");
assert.equal(used.sheet, 0, "replayed click must not open player item sheet");
assert.equal(used.stopped, 0, "replayed click must bypass our left-click interceptor");
assert.equal(notices.length, 0, "valid native action must not show warning");

function mockRow(label, own = false) {
  return {
    textContent: label,
    removed: false,
    classList: { contains: key => own && key === "ims-context-use-entry" },
    remove() { this.removed = true; }
  };
}
for (const isGM of [true, false]) {
  sandbox.game.user.isGM = isGM;
  api.setContextItem(item);
  const give = mockRow("Give To Character");
  const nativeUse = mockRow("Использовать");
  const customUse = mockRow("Использовать", true);
  const view = mockRow("Просмотр предмета");
  const edit = mockRow("Редактировать");
  const menu = { querySelectorAll: () => [give, nativeUse, customUse, view, edit] };
  api.imsCleanContextMenu(menu);
  assert.equal(give.removed, true, "Give To Character must be removed for everyone");
  assert.equal(nativeUse.removed, !isGM, "GM native use must be preserved; player duplicate removed");
  assert.equal(customUse.removed, false, "new use must remain for everyone");
  assert.equal(view.removed, false, "item view must remain");
  assert.equal(edit.removed, !isGM, "GM editing must remain available");
}

assert.ok(source.includes("(first?.parentElement ?? menu).prepend(entry)"),
  "Use command must be inserted at top");
assert.ok(source.includes("event.button !== 0 || imsNativeContextClick"),
  "Player left-click interception must skip replay");

// Verify GM left-click opens the same PLAY-mode view as a player.
sandbox.game.user.isGM = true;
sandbox.game.actors = [{
  items: new Map([["test-item", item]]),
  sheet: { element: { contains: () => true } }
}];
const gmRow = { dataset: { itemId: "test-item" } };
const gmName = { closest: () => gmRow };
const gmEvent = {
  button: 0,
  target: { closest: () => gmName },
  preventDefault() { used.stopped++; },
  stopPropagation() {},
  stopImmediatePropagation() {}
};
for (const listener of events.get("click") ?? []) listener(gmEvent);
assert.equal(used.sheet, 1, "GM LMB must open the item sheet");
assert.ok(source.includes('if (!game.user.isGM && !menu.querySelector(".ims-context-use-entry"))'),
  "GM must not receive a duplicate use command");
console.log("LipatoS item-move-stack v34.0.2: smoke tests passed.");
