/* LipatoS: Group carry capacity, Foundry v14 / D&D5e 6.0.6. */
(() => {
  "use strict";
  const MODULE = "lipatos-item-move-stack";
  const LEGACY = "item-move-stack";
  let queued = false;

  function weightOf(actor) {
    let result = 0;
    for (const item of actor.items ?? []) {
      const qty = Math.max(0, Number(item.system?.quantity ?? 1) || 0);
      const raw = item.system?.weight;
      const each = Number(raw && typeof raw === "object" ? (raw.value ?? raw.total ?? 0) : raw ?? 0) || 0;
      result += qty * Math.max(0, each);
    }
    return Math.round(result * 100) / 100;
  }

  function limitOf(actor) {
    const n = Number(actor.getFlag?.(MODULE, "groupCapacity") ??
      actor.getFlag?.(LEGACY, "groupCapacity"));
    return Number.isFinite(n) && n > 0 ? n : 150;
  }

  function getRoot(app) {
    const root = app?.element?.[0] ?? app?.element;
    return root?.querySelector ? root : null;
  }

  function getHost(root) {
    if (!root) return null;
    for (const tab of root.querySelectorAll?.('[data-tab="inventory"]') ?? []) {
      const body = tab.querySelector?.(":scope > .body") ?? tab.querySelector?.("section.body");
      if (body?.querySelector?.("dnd5e-inventory, .inventory-element")) return body;
    }
    // The host is a SIBLING of the inventory component, not inside it.
    const inventory = root.querySelector("dnd5e-inventory, .inventory-element");
    return inventory?.parentElement ?? null;
  }

  function render(actor, root) {
    if (actor?.type !== "group") return false;
    const host = getHost(root);
    if (!host || host.isConnected === false) return false;
    const current = weightOf(actor);
    const limit = limitOf(actor);
    const gm = game.user?.isGM === true;
    const signature = [actor.uuid ?? actor.id, current, limit, gm].join(":");
    let bar = host.querySelector(":scope > .ims-group-capacity");
    if (bar?.dataset?.capacitySignature === signature) {
      bar.hidden = false;
      return true;
    }
    if (bar?.contains?.(document.activeElement)) return true;
    bar?.remove();
    bar = document.createElement("div");
    bar.className = "ims-group-capacity" + (current > limit ? " over" : "");
    bar.dataset.capacitySignature = signature;
    bar.hidden = false;
    for (const [prop, value] of [
      ["display", "block"], ["visibility", "visible"], ["opacity", "1"],
      ["position", "relative"], ["width", "100%"], ["min-height", "28px"],
      ["z-index", "5"], ["flex", "0 0 auto"], ["order", "-1"]
    ]) bar.style.setProperty(prop, value, "important");
    const percent = Math.max(0, Math.min(100, 100 * current / limit));
    bar.innerHTML = [
      '<div class="ims-capacity-track" title="Вес инвентаря группы">',
      '<div class="ims-capacity-fill" style="width:' + percent + '%"></div>',
      '<div class="ims-capacity-label">',
      '<i class="fa-solid fa-weight-hanging" aria-hidden="true"></i>',
      '<span>Вес группы:</span><span>' + current + '</span><span>/</span>',
      gm
        ? '<input class="ims-capacity-max" type="number" min="1" step="1" value="' +
          limit + '" title="Максимальный вес группы — изменяет только ГМ" aria-label="Максимальный вес группы">'
        : '<span>' + limit + '</span>',
      '</div></div>'
    ].join("");
    host.prepend(bar);

    bar.querySelector(".ims-capacity-max")?.addEventListener("change", async event => {
      if (!game.user?.isGM) return;
      const parsed = Number(event.currentTarget.value);
      if (!Number.isFinite(parsed) || parsed < 1) {
        event.currentTarget.value = String(limit);
        return;
      }
      try {
        await actor.setFlag(MODULE, "groupCapacity", Math.max(1, Math.floor(parsed)));
        if (actor.getFlag?.(LEGACY, "groupCapacity") !== undefined)
          await actor.unsetFlag(LEGACY, "groupCapacity");
        bar.dataset.capacitySignature = "";
        scheduleScan();
      } catch (error) {
        console.error(MODULE, "Ошибка сохранения грузоподъёмности группы", error);
        ui.notifications?.error?.("Не удалось сохранить максимальный вес группы");
        event.currentTarget.value = String(limit);
      }
    });
    return true;
  }

  function groupRootFromButton(button) {
    let root = button?.parentElement;
    while (root && root !== document.body) {
      if (root.querySelector?.(".sheet-header .document-name") && getHost(root)) return root;
      root = root.parentElement;
    }
    return null;
  }

  function actorFromRoot(root) {
    const id = root.dataset?.documentId ?? root.dataset?.actorId;
    const byId = id ? game.actors?.get?.(id) : null;
    if (byId?.type === "group") return byId;
    const title = root.querySelector(".sheet-header .document-name");
    const name = String(title?.value || title?.textContent || "").trim();
    if (!name) return null;
    const matches = [...(game.actors ?? [])].filter(a => a.type === "group" && a.name === name);
    return matches.length === 1 ? matches[0] : null;
  }

  function scan() {
    queued = false;
    if (game.system?.id !== "dnd5e") return;
    try {
      const apps = new Set(Object.values(ui.windows ?? {}));
      for (const actor of game.actors ?? []) {
        if (actor.type !== "group") continue;
        for (const app of Object.values(actor.apps ?? {})) apps.add(app);
      }
      for (const app of apps) {
        const actor = app?.actor ?? app?.document ?? app?.object;
        if (actor?.type === "group") render(actor, getRoot(app));
      }
    } catch (err) {
      console.warn(MODULE, "Поиск приложений группы:", err);
    }
    // This identifies the ACTUAL group sheet from its unique D&D5e 6.x
    // placeMembers button, without window classes or window registration.
    try {
      for (const button of document.querySelectorAll('.sheet-header [data-action="placeMembers"]')) {
        const root = groupRootFromButton(button);
        const actor = root && actorFromRoot(root);
        if (actor) render(actor, root);
      }
    } catch (err) {
      console.error(MODULE, "Отрисовка веса группы:", err);
    }
  }

  function scheduleScan() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(scan);
  }

  Hooks.on("renderApplicationV2", app => {
    const actor = app?.actor ?? app?.document ?? app?.object;
    if (actor?.type === "group") render(actor, getRoot(app));
    scheduleScan();
  });
  Hooks.on("renderActorSheetV2", scheduleScan);
  Hooks.on("renderActorSheet", scheduleScan);
  Hooks.once("ready", () => {
    if (game.system?.id !== "dnd5e") return;
    new MutationObserver(scheduleScan).observe(document.body, {childList: true, subtree: true});
    scheduleScan();
    console.info(MODULE, "Настройка веса группы включена (v34.2.12)");
  });

  globalThis.LipatoSGroupCapacity = {
    refresh: scheduleScan,
    diagnostics: () => ({
      moduleActive: game.modules?.get?.(MODULE)?.active,
      version: game.modules?.get?.(MODULE)?.version,
      groupHeaderButtons: document.querySelectorAll('.sheet-header [data-action="placeMembers"]').length,
      bars: document.querySelectorAll(".ims-group-capacity").length,
      actors: [...(game.actors ?? [])].filter(a => a.type === "group").map(a => a.name)
    })
  };
})();