const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const src = fs.readFileSync("group-capacity.js", "utf8");

function verify(isGM) {
  const callbacks = new Map();
  const actor = {id: "g2", type: "group", name: "Группа 2", apps: {}, sheet: null,
    items: [{system: {quantity: 2, weight: 3}}, {system: {quantity: 1, weight: {value: 4}}}],
    getFlag(namespace, name) {return namespace === "lipatos-item-move-stack" && name === "groupCapacity" ? 280 : undefined;}
  };
  let ready;
  let observer;
  const inventory = {
    bar: null,
    querySelector(q) {
      if (q === ".ims-group-capacity") return this.bar;
      if (q === ":scope > .currency") return currency;
      return null;
    },
    prepend(el) {this.bar = el;}
  };
  const currency = {insertAdjacentElement(where, el) {
    assert.equal(where, "afterend");
    inventory.bar = el;
  }};
  const root = {
    isConnected: true, dataset: {},
    querySelector(q) {
      if (q.includes("inventory-element")) return inventory;
      if (q === ".window-title") return null;
      if (q === ".sheet-header .document-name") return {textContent: "Группа 2"};
      return null;
    }
  };
  const document = {
    activeElement: null, body: {},
    querySelectorAll() {return [root]},
    createElement() {
      const b = {
        dataset: {}, innerHTML: "", className: "",
        remove() {if (inventory.bar === b) inventory.bar = null;},
        contains() {return false;},
        querySelector(q) {
          if (q !== ".ims-capacity-max" || !this.innerHTML.includes("ims-capacity-max")) return null;
          return {addEventListener() {}};
        }
      };
      return b;
    }
  };
  const sandbox = {
    document,
    game: {user: {isGM}, system: {id:"dnd5e"}, actors: [actor]},
    ui: {windows: {}, notifications: {error() {throw Error("unexpected error")}}},
    foundry: {applications: {}},
    Hooks: {
      on(name,fn) {callbacks.set(name,fn);},
      once(name,fn) {if(name === "ready") ready = fn;}
    },
    MutationObserver: class {
      constructor(fn) {this.notify = fn; observer = this;}
      observe() {}
    },
    requestAnimationFrame(fn) {fn()},
    console
  };
  vm.runInNewContext(src, sandbox, {filename:"group-capacity.js"});
  assert.equal(typeof ready, "function");
  assert.ok(callbacks.has("renderApplicationV2"));

  // The actor sheet is NOT present in ui.windows or actor.apps.
  // Its .window-title is blank, as with D&D5e 6.0.6.
  ready();
  assert.ok(inventory.bar, "hidden-title group window must get a weight bar");
  assert.ok(inventory.bar.innerHTML.includes("<span>10</span>"), "weight must equal 10");
  assert.equal(inventory.bar.innerHTML.includes("ims-capacity-max"), isGM, "only GM can edit maximum");
  assert.ok(inventory.bar.innerHTML.includes(isGM ? 'value="280"' : '>280</span>'));

  inventory.bar = null;
  observer.notify([{addedNodes: []}]);
  assert.ok(inventory.bar, "bar must recover after another module replaces inventory DOM");

  // Native render hook should work independently of fallback discovery.
  inventory.bar = null;
  callbacks.get("renderApplicationV2")({actor, element: root});
  assert.ok(inventory.bar);
}
verify(true);
verify(false);
console.log("Group capacity: hidden window title, GM-only edit, restoration passed");
