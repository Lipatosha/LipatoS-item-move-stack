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
    imsCanUseInventoryItem,
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
  type: "consumable",
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
  assert.equal(nativeUse.removed, true, "duplicate native use removed for all roles");
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
assert.ok(source.includes('} else if (!menu.querySelector(".ims-context-use-entry"))'),
  "The Use entry is created only for eligible item types");

// Simulate the GM context menu and ensure the actual "Использовать" action
// is inserted FIRST even when D&D5e does not supply one by itself.
const originalOwner = item.isOwner;
item.isOwner = false; // Avoid requiring transfer dialog in this menu test.
const menuRows = [];
const menuList = {
  prepend(entry) { menuRows.unshift(entry); },
  appendChild(entry) { menuRows.push(entry); }
};
const viewRow = {
  textContent: "Просмотр предмета",
  parentElement: menuList,
  classList: { contains: () => false },
  remove() { menuRows.splice(menuRows.indexOf(this), 1); }
};
menuRows.push(viewRow);
sandbox.document.createElement = tagName => ({
  tagName: tagName.toUpperCase(),
  className: "",
  textContent: "Использовать",
  classList: { contains(key) { return key === "ims-context-use-entry"; } },
  addEventListener(name, fn) { this[name] = fn; },
  remove() {}
});
const gmMenu = {
  querySelectorAll: () => [...menuRows],
  querySelector(selector) {
    if (selector.includes("ims-context-use-entry")) {
      return menuRows.find(row => row.className?.includes("ims-context-use-entry"));
    }
    return menuRows[0] ?? null;
  },
  remove() {}
};
sandbox.game.user.isGM = true;
api.setContextItem(item);
api.imsInjectContextTransfer(gmMenu);
assert.equal(menuRows[0]?.className, "context-item ims-context-use-entry",
  "GM Use must be the first entry");
assert.equal(menuRows.length, 2, "GM must have one Use entry, not duplicates");
api.imsInjectContextTransfer(gmMenu);
assert.equal(menuRows.length, 2, "re-render must not add another GM Use entry");
item.isOwner = originalOwner;

// The explicit Use menu forwards eligible items to instant-consumables rather
// than triggering native D&D5e (which may not support loot/tool activities).
let consumed=0;
sandbox.game.modules=new Map([["lipatos-instant-consumables",{
  api:{canUse: () => true, useItem: () => {consumed++;return true;}}
}]]);
api.imsRunOldLeftClick(item,row);
assert.equal(consumed,1,"Use forwarded to instant consumption API");
assert.equal(used.native,1,"native click not duplicated when instant handling succeeds");

// Equipment and containers never expose/use instant consumption.
for (const excludedType of ["equipment","container","backpack"]) {
  item.type=excludedType;
  api.imsRunOldLeftClick(item,row);
  assert.equal(consumed,1,excludedType+" is excluded from consumption");
  api.setContextItem(item);
  const before=menuRows.length;
  api.imsInjectContextTransfer(gmMenu);
  assert.equal(menuRows.length,before,"no new entry created for "+excludedType);
}
item.type="consumable";
for (const eligibleType of ["loot","tool","weapon","consumable"]) {
  item.type=eligibleType;
  assert.equal(api.imsCanUseInventoryItem(item),true,eligibleType+" accepts use");
}
console.log("LipatoS item-move-stack v34.2.3: integrated Use action, menu exclusions and GM/player cases passed.");
