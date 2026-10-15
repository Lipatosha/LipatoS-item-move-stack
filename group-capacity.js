/* LipatoS: group inventory capacity — independent D&D5e 6.x integration.
 * Runs even if another inventory feature fails to initialize.
 */
(() => {
  const MODULE = "lipatos-item-move-stack";
  const LEGACY = "item-move-stack";
  const tracked = new Set();
  let queued = false;

  const actorOf = app => app?.actor ?? app?.document ?? app?.object;
  const rootOf = app => app?.element?.[0] ?? app?.element;
  const isGroup = app => actorOf(app)?.type === "group" && actorOf(app)?.documentName === "Actor";

  function inventoryOf(root) {
    return root?.querySelector?.("dnd5e-inventory.inventory-element, .inventory-element")
      ?? root?.querySelector?.('[data-tab="inventory"] .body');
  }

  function inventoryWeight(actor) {
    let weight = 0;
    for (const item of actor.items ?? []) {
      const qty = Math.max(0, Number(item.system?.quantity ?? 1) || 0);
      const raw = item.system?.weight;
      const each = Number(typeof raw === "object" && raw !== null
        ? (raw.value ?? raw.total ?? 0) : (raw ?? 0)) || 0;
      weight += Math.max(0, each) * qty;
    }
    return Math.round(weight * 100) / 100;
  }

  function installBar(app) {
    if (!isGroup(app)) return false;
    const actor = actorOf(app);
    const root = rootOf(app);
    if (!root?.querySelector || !root.isConnected) return false;
    const inventory = inventoryOf(root);
    if (!inventory) return false;

    // Always display this group's limit, even while a vehicle inventory is selected.
    // This prevents the vehicle selection from hiding the group configuration.
    const current = inventoryWeight(actor);
    let max = Number(actor.getFlag?.(MODULE, "groupCapacity")
      ?? actor.getFlag?.(LEGACY, "groupCapacity"));
    if (!Number.isFinite(max) || max <= 0) max = 150;
    const gm = !!game.user?.isGM;
    const state = [current, max, gm].join(":");

    let bar = inventory.querySelector(".ims-group-capacity");
    if (bar?.dataset.imsCapacityState === state) return true;
    if (bar?.contains(document.activeElement)) return true;
    bar?.remove();

    bar = document.createElement("div");
    bar.className = "ims-group-capacity" + (current > max ? " over" : "");
    bar.dataset.imsCapacityState = state;
    const pct = Math.max(0, Math.min(100, 100 * current / max));
    bar.innerHTML = `
      <div class="ims-capacity-track" title="Вес инвентаря группы">
        <div class="ims-capacity-fill" style="width:${pct}%"></div>
        <div class="ims-capacity-label">
          <i class="fa-solid fa-weight-hanging" aria-hidden="true"></i>
          <span>${current}</span><span>/</span>
          ${gm
            ? `<input class="ims-capacity-max" type="number" min="1" step="1"
                     value="${max}" title="Максимальный вес группы (только ГМ)"
                     aria-label="Максимальный вес группы">`
            : `<span title="Максимальный вес группы">${max}</span>`}
        </div>
      </div>`;

    // Foundry D&D5e v6: currency, then the .middle search/filter toolbar.
    const currency = inventory.querySelector(":scope > .currency");
    const toolbar = inventory.querySelector(":scope > .middle, :scope > .items-list");
    if (currency) currency.insertAdjacentElement("afterend", bar);
    else if (toolbar) toolbar.insertAdjacentElement("beforebegin", bar);
    else inventory.prepend(bar);

    const input = bar.querySelector(".ims-capacity-max");
    input?.addEventListener("change", async event => {
      if (!game.user?.isGM) return;
      const proposed = Math.floor(Number(event.currentTarget.value));
      const value = Number.isFinite(proposed) ? Math.max(1, proposed) : max;
      try {
        await actor.setFlag(MODULE, "groupCapacity", value);
        if (actor.getFlag(LEGACY, "groupCapacity") !== undefined) {
          await actor.unsetFlag(LEGACY, "groupCapacity");
        }
        event.currentTarget.blur();
        bar.dataset.imsCapacityState = "";
        installBar(app);
      } catch (error) {
        console.error("LipatoS | Failed to save group capacity", error);
        ui.notifications?.error?.("Не удалось сохранить максимальный вес группы.");
        event.currentTarget.value = String(max);
      }
    });
    return true;
  }

  function track(app) {
    if (!isGroup(app)) return;
    tracked.add(app);
    try { installBar(app); }
    catch (err) { console.error("LipatoS | Group capacity render failed", err); }
  }

  function scan() {
    queued = false;
    const apps = new Set(tracked);
    for (const app of Object.values(ui?.windows ?? {})) apps.add(app);
    const instances = foundry?.applications?.instances;
    if (instances?.values) for (const app of instances.values()) apps.add(app);
    for (const actor of game.actors ?? []) {
      if (actor.type !== "group") continue;
      for (const app of Object.values(actor.apps ?? {})) apps.add(app);
      const sheet = actor.sheet;
      if (sheet?.rendered) apps.add(sheet);
    }
    for (const app of apps) {
      const root = rootOf(app);
      if (!root?.isConnected) { tracked.delete(app); continue; }
      if (isGroup(app)) track(app);
    }
  }

  function scheduleScan() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(scan);
  }

  // Hook before ready and independently of the main inventory script.
  Hooks.on("renderApplicationV2", track);
  Hooks.on("renderActorSheet", track);
  Hooks.on("renderGroupActorSheet", track);
  Hooks.once("ready", () => {
    if (game.system.id !== "dnd5e") return;
    const observer = new MutationObserver(() => scheduleScan());
    observer.observe(document.body, {childList: true, subtree: true});
    scheduleScan();
    console.info("LipatoS | Independent group capacity integration active.");
  });
})();
