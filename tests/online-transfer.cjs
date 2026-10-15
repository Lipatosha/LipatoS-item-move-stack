const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const code = fs.readFileSync("main.js", "utf8");

const own = {id:"self", uuid:"Actor.self", type:"character", name:"Я"};
const online = {id:"on", uuid:"Actor.on", type:"character", name:"Онлайн", system:{currency:{cp:1,sp:0,gp:0}}, async update(data) {
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith("system.currency.")) this.system.currency[key.split(".").pop()] = value;
  }
}};
const offline = {id:"off", uuid:"Actor.off", type:"character", name:"Офлайн"};
const group = {id:"gr",type:"group",name:"Моя группа",system:{members:{ids:new Set(["self"])}}};
const otherGroup = {id:"gr2",type:"group",name:"Чужая группа",system:{members:{ids:new Set(["off"])}}};
const gm = {id:"gm",isGM:true,active:true,name:"ГМ"};
const me = {id:"me",isGM:false,active:true,character:own};
const player = {id:"p2",isGM:false,active:true,character:online};
const sleeping = {id:"p3",isGM:false,active:false,character:offline};
const users = [gm,me,player,sleeping];
users.get = id => users.find(u => u.id === id);
const actors=[own,online,offline,group,otherGroup];
actors.get = id => actors.find(a => a.id === id);
const emitted = [];
const sandbox = {
  Hooks:{once(){},callAll(){}},console,
  game:{system:{id:"dnd5e"},user:gm,users,actors,i18n:{lang:"ru"},socket:{emit(...args){emitted.push(args)}}},
  foundry:{utils:{getProperty(obj,path){return path.split(".").reduce((a,k)=>a?.[k],obj)}}},
  fromUuid:async id => id==="Actor.self"?own:null
};
vm.runInNewContext(code+`
globalThis.testApi={recipients:imsTransferRecipients,handle:imsGMHandleTransfer,coin:imsCoinCode};
`,sandbox,{filename:"main.js"});
const ids=()=>Array.from(sandbox.testApi.recipients(own),x=>x.id);
assert.deepEqual(ids(),["__GM__","gr","on"],"only connected characters and own group");
player.active=false;
assert.deepEqual(ids(),["__GM__","gr"],"disconnect removes recipient");
player.active=true;
gm.active=false;
assert.deepEqual(ids(),["gr","on"],"offline GM is not listed");
gm.active=true;
assert.equal(sandbox.testApi.coin({getFlag:()=> "sp"}),"sp","physical silver coin detected");

const item={id:"coin",name:"Серебро",img:"silver.webp",system:{quantity:5},getFlag:()=> "sp",
  async update(data){this.system.quantity=data["system.quantity"]},
  async delete(){throw Error("delete should not be called for a partial stack")}};
own.items = new Map([["coin",item]]);
own.testUserPermission=()=>true;
const payload={requestId:"r",requesterId:"me",sourceActorUuid:"Actor.self",sourceItemId:"coin",target:"actor",targetActorId:"on",qty:3};
(async()=>{
  player.active=false;
  await sandbox.testApi.handle(payload);
  assert.equal(emitted.at(-1)[1].ok,false,"server rejects offline recipient");
  assert.equal(item.system.quantity,5,"rejected transfer does not remove coins");
  player.active=true;
  await sandbox.testApi.handle(payload);
  assert.equal(emitted.at(-1)[1].ok,true,"server accepts online recipient");
  assert.equal(online.system.currency.sp,3,"recipient wallet credited");
  assert.equal(item.system.quantity,2,"sender coin stack decremented");
  assert.equal(emitted.at(-1)[1].coinCode,"sp","coin kind reaches audit");
  console.log("LipatoS online transfer and coin wallet tests passed.");
})().catch(e=>{console.error(e);process.exitCode=1});
