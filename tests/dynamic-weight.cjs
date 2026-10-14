const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const callbacks = new Map();
const messages = [];
const getProperty = (object, path) => path.split(".").reduce((v,k) => v?.[k], object);
const sandbox = {
  Hooks: {
    on(name, fn) { callbacks.set(name, fn); },
    once() {}
  },
  foundry: { utils: {
    getProperty,
    hasProperty(obj, path) { return getProperty(obj, path) !== undefined; },
    escapeHTML(value) { return value; }
  }, applications: { api: {} } },
  game: { user: { id: "tester", isGM: true }, system: { id: "dnd5e" } },
  ui: { notifications: {
    info(m) {messages.push(m);}, warn(m) {messages.push(m);},
    error(m) {messages.push(m);}
  } },
  HTMLElement: class {},
  console
};
const source = fs.readFileSync("dynamic-weight.js", "utf8");
const injected = source.replace(/\}\)\(\);\s*$/, 'globalThis.__dwTest = {calculate, renderButton, configure, eligible, relevant};})();');
assert.notEqual(source, injected, "test API injection succeeded");
vm.runInNewContext(injected, sandbox, {filename: "dynamic-weight.js"});
const api = sandbox.__dwTest;
const config = {enabled: true, perCharge: 0.45, empty: 5};
function item(overrides={}) {
  const settings = overrides.config === undefined ? config : overrides.config;
  return {
    documentName: "Item", uuid: "Item.123", name: "Бочка пива",
    parent: {name:"Character"}, isOwner: true,
    system: {
      weight:{value:29.75, units:"lb"},
      uses:{max:100,spent:45,value:55}
    },
    getFlag: () => settings,
    async update(change) { this.lastUpdate=change; this.system.weight.value=change["system.weight.value"]; },
  };
}

const barrel=item();
assert.equal(api.calculate(barrel),29.75,"55 of 100 -> 29.75 lb");
const onPreUpdate=callbacks.get("preUpdateItem");
assert.equal(typeof onPreUpdate,"function");

const drink={"system.uses.spent":46};
onPreUpdate(barrel,drink);
assert.equal(drink["system.weight.value"],29.3,"one charge lowers weight by 0.45 lb");

const recharge={"system.uses.spent":0};
onPreUpdate(barrel,recharge);
assert.equal(recharge["system.weight.value"],50,"refill restores full weight");

const empty={"system.uses.spent":100};
onPreUpdate(barrel,empty);
assert.equal(empty["system.weight.value"],5,"empty barrel keeps tare");

const changeMax={"system.uses.max":200};
onPreUpdate(barrel,changeMax);
assert.equal(changeMax["system.weight.value"],74.75,"max charges can increase without changing the weight of one charge");

const disabled=item({config:{enabled:false,perCharge:0.45,empty:5}});
const disabledChange={"system.uses.spent":46};
onPreUpdate(disabled,disabledChange);
assert.equal(disabledChange["system.weight.value"],undefined,"disabled leaves weight unchanged");

const bad=item({config:{enabled:true,perCharge:-0.1,empty:5}});
assert.equal(api.calculate(bad),null,"negative per-charge weight is rejected");

const flagChange={"flags.lipatos-item-move-stack.dynamicWeight":{enabled:true,perCharge:0.45,empty:5}};
const blank=item({config:undefined});
assert.equal(api.calculate(blank,flagChange),29.75,"enabling flag is recognized as flattened update");

const oldConfig={enabled:true,full:50,empty:5};
const legacy=item({config:oldConfig});
assert.equal(api.calculate(legacy),29.75,"old full/empty configuration remains readable");
const legacyMaxChanged={"system.uses.max":200};
onPreUpdate(legacy,legacyMaxChanged);
assert.equal(legacyMaxChanged["system.weight.value"],74.75,
  "legacy charge mass uses the original max before migration");

const noCharges=item({config:{enabled:true,perCharge:0.45,empty:5}});
noCharges.system.uses.spent=100;
assert.equal(api.calculate(noCharges),5,"zero charges leave tare weight");
const oneCharge=item({config:{enabled:true,perCharge:0.45,empty:5}});
oneCharge.system.uses.spent=99;
assert.equal(api.calculate(oneCharge),5.45,"single remaining charge weighs correctly");

const newData={enabled:true,empty:5,perCharge:0.75};
assert.equal(api.calculate(barrel,{"flags.lipatos-item-move-stack.dynamicWeight":newData}),46.25,
  "updating the new weight-per-charge field immediately recalculates weight");

const irrelevant={name:"New name"};
onPreUpdate(barrel,irrelevant);
assert.equal(Object.keys(irrelevant).length,1,"irrelevant updates are untouched");

assert.equal(callbacks.has("renderApplicationV2"),true,"Foundry v14 rendering hook exists");
assert.equal(callbacks.has("updateItem"),true,"post-update sync hook exists");
assert.equal(callbacks.has("createItem"),true,"transfer/copy sync hook exists");
assert.ok(source.includes('name="perCharge"'), "settings dialog must have per-charge field");
assert.ok(source.includes("Вес одного заряда"), "per-charge field should be localized");
assert.ok(!source.includes('name="full"'), "legacy full-weight input should be removed");
assert.ok(source.includes("void migrate(item)"), "created legacy items are migrated");
console.log("Dynamic weight v34.2.0: charge mass, legacy migration, refills, max changes and hooks passed.");
