const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("main.js", "utf8");

async function scenario({senderGM, recipientOwned, gmOnline = true, coins = false}) {
  const gm = {id: "gm", isGM: true, active: gmOnline};
  const user = {id: "player", isGM: false, active: true};
  const friend = {id: "friend", isGM: false, active: true};
  const users = [gm, user, friend];
  users.get = id => users.find(entry => entry.id === id);

  const sender = {
    id: "sender", uuid: "Actor.sender", documentName: "Actor",
    type: "character", name: "Отправитель",
    testUserPermission: () => true
  };
  const recipient = {
    id: "recipient", type: "character", name: "Получатель",
    isOwner: recipientOwned, items: [], system: {currency: {cp: 0, sp: 0, gp: 0}},
    async createEmbeddedDocuments(type, documents, options) {
      this.received = documents;
      this.createOptions = options;
      return [{id: "received"}];
    },
    async update(changes, options) {
      this.updateOptions = options;
      for (const [path, value] of Object.entries(changes)) {
        if (path.startsWith("system.currency.")) this.system.currency[path.split(".").pop()] = value;
      }
    }
  };
  user.character = sender;
  friend.character = recipient;
  const actors = [sender, recipient];
  actors.get = id => actors.find(entry => entry.id === id);

  const item = {
    id: "item1", parent: sender, name: coins ? "Серебро" : "Лечебная трава",
    img: "icons/item.webp", type: "loot", isOwner: true, system: {quantity: 3},
    getFlag() {return coins ? "sp" : null;},
    toObject() {
      return {_id: "item1", name: this.name, type: "loot",
        system: {quantity: this.system.quantity, container: "old"}};
    },
    async update(changes, options) {
      this.system.quantity = changes["system.quantity"];
      this.updateOptions = options;
    },
    async delete(options) {this.deleted = true; this.deleteOptions = options;}
  };
  sender.items = new Map([["item1", item]]);

  const handlers = new Map();
  const emissions = [];
  const socket = {
    on(channel, handler) {
      const list = handlers.get(channel) ?? [];
      list.push(handler);
      handlers.set(channel, list);
    },
    off(channel, handler) {
      handlers.set(channel, (handlers.get(channel) ?? []).filter(fn => fn !== handler));
    },
    emit(channel, message) {
      emissions.push(message.type);
      for (const handler of [...(handlers.get(channel) ?? [])]) handler(message);
    }
  };
  const foundry = {utils: {
    randomID: () => "unique-request",
    getProperty: (object, path) => path.split(".").reduce((v, k) => v?.[k], object),
    hasProperty: (object, path) => path.split(".").reduce((v, k) => v?.[k], object) !== undefined,
    setProperty(object, path, value) {
      const keys = path.split(".");
      let target = object;
      while (keys.length > 1) target = target[keys.shift()];
      target[keys[0]] = value;
    }
  }};

  const makeAPI = currentUser => {
    const sandbox = {
      game: {system: {id: "dnd5e"}, user: currentUser, users, actors, socket, i18n: {lang: "ru"}},
      Hooks: {once() {}, callAll() {}},
      foundry, fromUuid: async uuid => uuid === sender.uuid ? sender : null,
      ui: {notifications: {info() {}, warn() {}, error() {}}},
      console, setTimeout: () => 1, clearTimeout: () => {}
    };
    vm.runInNewContext(source + `
      globalThis.transferItemFromMenu = imsRequestGMTransfer;
      globalThis.processItemTransfer = imsGMHandleTransfer;
    `, sandbox, {filename: "main.js"});
    return sandbox;
  };

  const master = makeAPI(gm);
  const player = makeAPI(user);
  socket.on("module.lipatos-item-move-stack", request => {
    if (request.type === "ims-transfer-request") void master.processItemTransfer(request);
  });

  const active = senderGM ? master : player;
  const result = await active.transferItemFromMenu(item, {id: recipient.id}, 2);
  return {result, emissions, item, recipient};
}

(async () => {
  const directGM = await scenario({senderGM: true, recipientOwned: false});
  assert.equal(directGM.result.ok, true, "GM transfers directly to another character");
  assert.equal(directGM.item.system.quantity, 1);
  assert.equal(directGM.recipient.received[0].system.quantity, 2);
  assert.deepEqual(directGM.emissions, [], "the GM never sends a request to itself");

  const directPlayer = await scenario({senderGM: false, recipientOwned: true, gmOnline: false});
  assert.equal(directPlayer.result.ok, true, "shared owned inventory transfers directly without GM");
  assert.deepEqual(directPlayer.emissions, [], "an owned-to-owned transfer uses no socket");
  assert.equal(directPlayer.item.updateOptions.lipatosItemTransfer, true,
    "direct transfer must not be misreported as manual deletion");
  assert.equal(directPlayer.recipient.createOptions.lipatosItemTransfer, true);

  const delegated = await scenario({senderGM: false, recipientOwned: false});
  assert.equal(delegated.result.ok, true, "GM executes other-owner transfer automatically");
  assert.deepEqual(delegated.emissions,
    ["ims-transfer-request", "ims-transfer-result"], "no separate approval handshake");
  assert.equal(delegated.recipient.received[0].system.quantity, 2);

  const noGM = await scenario({senderGM: false, recipientOwned: false, gmOnline: false});
  assert.equal(noGM.result.ok, false, "no unauthorized cross-owner edits without GM");
  assert.deepEqual(noGM.emissions, [], "no futile socket request without online GM");
  assert.doesNotMatch(noGM.result.error, /не ответил на запрос/i);
  assert.equal(noGM.item.system.quantity, 3, "failed transfer leaves original item untouched");

  const wallet = await scenario({senderGM: true, recipientOwned: false, coins: true});
  assert.equal(wallet.result.ok, true);
  assert.equal(wallet.recipient.system.currency.sp, 2, "physical coins enter the wallet");
  assert.equal(wallet.item.system.quantity, 1);

  console.log("Direct GM, owned, delegated, offline and coin transfer tests passed.");
})().catch(error => {console.error(error); process.exitCode = 1;});
