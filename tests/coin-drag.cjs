const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync("main.js", "utf8");

const sourceActor = {documentName: "Actor", uuid: "Actor.source"};
const targetActor = {
  documentName: "Actor", type: "character", uuid: "Actor.target",
  items: new Map([["bag", {type: "container", id: "bag"}]])
};
let deleted = 0;
const coin = {
  parent: sourceActor, name: "Серебро", type: "loot", isOwner: true,
  getFlag(module, field) {
    return module === "lipatos-three-currencies-global" && field === "coin" ? "sp" : undefined;
  },
  async delete() {deleted++;}
};
const sandbox = {
  Hooks: {once() {}}, game: {system: {id: "dnd5e"}},
  CONFIG: {Item: {documentClass: {async fromDropData() {return coin;}}}},
  foundry: {utils: {getProperty(obj, path) {
    return path.split(".").reduce((value, key) => value?.[key], obj);
  }}},
  console
};
vm.runInNewContext(source + "\nglobalThis.__transfer = transferItem;", sandbox, {filename: "main.js"});

const sheet = {actor: targetActor};
const data = {type: "Item"};
function drop(rowId) {
  return {
    target: {
      closest(selector) {
        if (selector === "[data-item-id], [data-document-id]") {
          return rowId ? {dataset: {itemId: rowId}} : null;
        }
        return null;
      }
    }
  };
}
(async () => {
  assert.equal(await sandbox.__transfer(sheet, drop(null), data), false,
    "physical silver may not be transferred into a character inventory root");
  assert.equal(await sandbox.__transfer(sheet, drop("bag"), data), null,
    "physical silver dropped onto a real container is handled by native D&D5e");
  assert.equal(deleted, 0, "blocked drops must not delete the source stack");
  assert.match(source, /if \(!Array\.isArray\(created\) \|\| created\.length === 0\) return false;/,
    "rejected preCreateItem must not delete the source item");
  console.log("LipatoS item-move-stack coin protection tests passed.");
})().catch(error => {console.error(error); process.exitCode = 1;});
