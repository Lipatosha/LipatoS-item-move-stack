const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const source = fs.readFileSync("group-capacity.js", "utf8");

function testGroupVisibility(isGM) {
  const handlers = new Map();
  let ready;
  let observer;
  let bar = null;
  const actor = {
    id: "group-a", uuid: "Actor.group-a", type: "group", name: "Группа",
    apps: {}, items: [{system:{quantity:2,weight:4}}, {system:{quantity:1,weight:{value:2}}}],
    saved: 300, getFlag(namespace, key) {
      if(namespace==="lipatos-item-move-stack" && key==="groupCapacity") return this.saved;
      return undefined;
    },
    async setFlag(namespace,key,value){this.saved=value;},
    async unsetFlag(){}
  };
  const host = {
    isConnected:true,
    prepend(element){bar=element;},
    querySelector(sel) {
      if (sel === ":scope > .ims-group-capacity") return bar;
      if (sel === "dnd5e-inventory, .inventory-element") return inventory;
      return null;
    }
  };
  const inventory = {parentElement:host};
  const title = {textContent:"Группа"};
  const root = {
    dataset:{}, parentElement:null,
    querySelector(selector) {
      if (selector === ".sheet-header .document-name") return title;
      if (selector === "dnd5e-inventory, .inventory-element") return inventory;
      return null;
    },
    querySelectorAll(){return []}
  };
  const button = {parentElement:root};
  const document = {
    body:{},activeElement:null,
    querySelectorAll(selector) {
      if (selector.includes("placeMembers")) return [button];
      if (selector === ".ims-group-capacity") return bar ? [bar] : [];
      return [];
    },
    createElement() {
      const element = {
        dataset:{},innerHTML:"",className:"",
        style:{setProperty(){}},
        remove(){if(bar===element)bar=null;},
        contains(){return false;},
        querySelector(sel) {
          if(sel !== ".ims-capacity-max") return null;
          return {addEventListener(){}};
        }
      };
      return element;
    }
  };
  const globals = {
    Hooks:{
      on(name,fn){handlers.set(name,fn);},
      once(name,fn){if(name==="ready")ready=fn;}
    },
    game:{system:{id:"dnd5e"},user:{isGM},actors:[actor],modules:{get(){return {active:true,version:"34.2.12"};}}},
    ui:{windows:{},notifications:{error(){throw Error("Failed to save")}}},
    document,
    MutationObserver:class {constructor(fn){observer=fn;}observe(){}},
    requestAnimationFrame:fn=>fn(),
    console
  };
  vm.runInNewContext(source,globals,{filename:"group-capacity.js"});
  assert.equal(typeof ready,"function");
  ready();

  // The Group sheet is unregistered in ui.windows/actor.apps,
  // and its standard Foundry window title is hidden.
  assert.ok(bar,"Group must be discovered via its placeMembers button");
  assert.ok(bar.innerHTML.includes("Вес группы:"),"Visible Russian weight label");
  assert.ok(bar.innerHTML.includes("<span>10</span>"),"Weight is 2*4+2");
  assert.equal(bar.innerHTML.includes('class="ims-capacity-max"'),isGM,
    "Only GM sees editable maximum");
  assert.ok(bar.innerHTML.includes(isGM ? 'value="300"' : '<span>300</span>'));

  // Other module partially rerenders the inventory subtree.
  bar=null;
  observer([]);
  assert.ok(bar,"Capacity survives a re-render");
  assert.equal(globals.LipatoSGroupCapacity.diagnostics().bars,1);
}
testGroupVisibility(true);
testGroupVisibility(false);
console.log("Group capacity: independent placement, hidden window, rerender and GM-only input passed.");
