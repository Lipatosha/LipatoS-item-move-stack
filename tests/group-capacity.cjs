const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const source = fs.readFileSync("group-capacity.js", "utf8");
for (const isGM of [true, false]) {
  const handlers = new Map();
  let ready, observer, bar = null, insertedAfter = null;
  const actor = {
    id: "group-a", uuid: "Actor.group-a", type: "group", name: "Группа", apps:{},
    items: [{system:{quantity:2,weight:4}},{system:{quantity:1,weight:{value:2}}}],
    saved:300,
    getFlag(namespace,key) {
      if(namespace==="lipatos-item-move-stack" && key==="groupCapacity") return this.saved;
      if(namespace==="item-move-stack") throw Error("Inactive legacy scope");
      return undefined;
    },
    async setFlag(namespace,key,value){this.saved=value;}
  };
  const search = {
    get nextElementSibling(){return bar;},
    insertAdjacentElement(pos,node){assert.equal(pos,"afterend");bar=node;insertedAfter="search";}
  };
  const currency = {
    insertAdjacentElement(){throw Error("Should not insert after currency when search exists");}
  };
  const inventory = {
    parentElement:null,
    querySelector(selector) {
      if (selector === ":scope > .middle") return search;
      if (selector === ":scope > .currency") return currency;
      return null;
    }
  };
  const host = {
    isConnected:true,
    querySelector(selector){
      if(selector==="dnd5e-inventory, .inventory-element")return inventory;
      if(selector===".ims-group-capacity")return bar;
      return null;
    },
    prepend(){throw Error("Fallback prepend is not expected");}
  };
  inventory.parentElement=host;
  const root={
    dataset:{},querySelector(selector){
      if(selector===".sheet-header .document-name")return {textContent:"Группа"};
      if(selector==="dnd5e-inventory, .inventory-element")return inventory;
      return null;
    },querySelectorAll(){return[]}
  };
  const document={
    body:{},activeElement:null,
    querySelectorAll(selector){
      if(selector.includes("placeMembers"))return [{parentElement:root}];
      if(selector===".ims-group-capacity")return bar?[bar]:[];
      return [];
    },
    createElement(){
      const el={
        className:"",dataset:{},style:{setProperty(){}},innerHTML:"",
        remove(){if(bar===el)bar=null;},contains(){return false;},
        querySelector(sel){if(sel===".ims-capacity-max")return {addEventListener(){}};return null;}
      };
      return el;
    }
  };
  const globals={
    Hooks:{on(name,fn){handlers.set(name,fn)},once(name,fn){if(name==="ready")ready=fn}},
    game:{system:{id:"dnd5e"},user:{isGM},actors:[actor],modules:{get(){return{active:true,version:"34.2.14"}}}},
    ui:{windows:{},notifications:{}},document,console,
    MutationObserver:class {constructor(fn){observer=fn;}observe(){}},
    requestAnimationFrame:fn=>fn()
  };
  vm.runInNewContext(source,globals,{filename:"group-capacity.js"});
  ready();
  assert.ok(bar,"bar should render");
  assert.equal(insertedAfter,"search","bar should follow search");
  assert.ok(bar.innerHTML.includes("<span>10</span>"),"weight correct");
  assert.ok(!bar.innerHTML.includes("Вес группы:"),"no text caption");
  assert.equal(bar.innerHTML.includes('class="ims-capacity-max"'),isGM,"only GM edits");
  const firstBar=bar;
  observer([]);
  assert.equal(bar,firstBar,"repeat render does not duplicate bar");
  bar=null;
  observer([]);
  assert.ok(bar,"bar restores after inventory re-render");
}
console.log("Group capacity: below search, compact label, GM-only, rerender passed.");
