const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const main = fs.readFileSync("main.js", "utf8");
const cap = fs.readFileSync("group-capacity.js", "utf8");
assert.ok(!main.includes('getFlag?.(LEGACY_MODULE_ID,'));
assert.ok(!main.includes('unsetFlag(LEGACY_MODULE_ID,'));
assert.ok(!cap.includes('getFlag?.(LEGACY,'));
assert.ok(!cap.includes('unsetFlag(LEGACY,'));
const begin = main.indexOf("async function imsMigrateLegacyGroupCapacity()");
const end = main.indexOf('Hooks.once("ready"', begin);
assert.ok(begin !== -1 && end > begin);
let count = 0;
const build = (current, legacy) => ({
  type:"group", name:"Группа 2",
  flags: legacy === undefined ? {} : {"item-move-stack": {groupCapacity:legacy}},
  getFlag(scope,key) {
    if (scope === "item-move-stack") throw Error("Flag scope is not valid");
    assert.equal(scope,"lipatos-item-move-stack");
    return current;
  },
  async setFlag(scope,key,n) {
    assert.equal(scope,"lipatos-item-move-stack");
    current=n;count++;
  },
  async unsetFlag(){throw Error("No legacy cleanup allowed");},
  get migrated(){return current;}
});
const groups = [build(undefined,275),build(undefined,undefined),build(310,100)];
const ctx = {
  MODULE_ID:"lipatos-item-move-stack",
  LEGACY_MODULE_ID:"item-move-stack",
  game:{user:{isGM:true},actors:groups},
  console
};
vm.runInNewContext(main.slice(begin,end)+"\nglobalThis.migrate=imsMigrateLegacyGroupCapacity;",ctx);
ctx.migrate().then(() => {
  assert.equal(groups[0].migrated,275);
  assert.equal(groups[1].migrated,undefined);
  assert.equal(groups[2].migrated,310);
  assert.equal(count,1);
  console.log("Inactive legacy flag migration passed");
}).catch(err=>{console.error(err);process.exitCode=1;});
