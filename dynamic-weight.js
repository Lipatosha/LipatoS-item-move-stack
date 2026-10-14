/**
 * LipatoS — dynamic weight from charges, Foundry v14 / dnd5e 6.0.6
 * Persistent uses fields: system.uses.spent, system.uses.max.
 * system.uses.value is derived, so it must NOT be written.
 */
(() => {
  const ID = "lipatos-item-move-stack";
  const FLAG = "dynamicWeight";
  const fu = foundry.utils;

  // Foundry UI can use a Russian decimal comma. Normalize text explicitly
  // because <input type="number"> often returns an empty value for "0,5".
  function numeric(value) {
    if (value === "" || value === undefined || value === null) return NaN;
    if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
    const normalized = String(value).trim().replace(/[\u00a0\u202f\s]/g, "").replace(",", ".");
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) return NaN;
    const n = Number(normalized);
    return Number.isFinite(n) ? n : NaN;
  }
  function updated(changes, path, fallback) {
    if (Object.prototype.hasOwnProperty.call(changes, path)) return changes[path];
    const nested = fu.getProperty(changes, path);
    return nested === undefined ? fallback : nested;
  }
  function changed(changes, path) {
    return Object.prototype.hasOwnProperty.call(changes, path) || fu.hasProperty(changes, path);
  }
  function eligible(item) {
    return item?.documentName === "Item" &&
      item.system?.weight?.value !== undefined &&
      item.system?.uses?.spent !== undefined &&
      item.system?.uses?.max !== undefined;
  }
  function settings(item, changes={}) {
    return updated(changes, "flags." + ID + "." + FLAG, item.getFlag?.(ID, FLAG)) ?? null;
  }
  // Upgrade v34.1.0's full/empty configuration without losing the old rate.
  // Use the OLD max for conversion, so changing max later does not change
  // how much each charge weighs.
  function rate(item, cfg) {
    const explicit = numeric(cfg?.perCharge);
    if (Number.isFinite(explicit)) return explicit;
    const oldFull = numeric(cfg?.full);
    const oldEmpty = numeric(cfg?.empty);
    const oldMax = numeric(item?.system?.uses?.max);
    if (Number.isFinite(oldFull) && Number.isFinite(oldEmpty) &&
        oldFull >= oldEmpty && Number.isFinite(oldMax) && oldMax > 0) {
      return (oldFull - oldEmpty) / oldMax;
    }
    return NaN;
  }
  function calculate(item, changes={}) {
    if (!eligible(item)) return null;
    const cfg = settings(item, changes);
    if (!cfg?.enabled) return null;
    const empty = numeric(cfg.empty);
    const perCharge = rate(item, cfg);
    const max = numeric(updated(changes, "system.uses.max", item.system.uses.max));
    const spent = numeric(updated(changes, "system.uses.spent", item.system.uses.spent));
    if (![perCharge, empty, max, spent].every(Number.isFinite) ||
        empty < 0 || perCharge < 0 || max <= 0) return null;
    const remaining = Math.max(0, Math.min(max, max - spent));
    return Math.round((empty + perCharge * remaining) * 10000) / 10000;
  }
  function relevant(changes) {
    return changed(changes, "system.uses.spent") ||
      changed(changes, "system.uses.max") ||
      changed(changes, "system.weight.value") ||
      changed(changes, "flags." + ID + "." + FLAG);
  }

  Hooks.on("preUpdateItem", (item, changes) => {
    if (!relevant(changes)) return;
    const weight = calculate(item, changes);
    if (weight === null) return;
    const proposed = numeric(updated(changes, "system.weight.value", item.system.weight.value));
    if (Math.abs(proposed - weight) < 0.00005) return;
    changes["system.weight.value"] = weight;
  });

  const processing = new Set();
  async function reconcile(item) {
    if (!item?.isOwner || !item?.parent || processing.has(item.uuid)) return;
    const weight = calculate(item);
    if (weight === null || Math.abs(numeric(item.system.weight.value) - weight) < 0.00005) return;
    processing.add(item.uuid);
    try {
      await item.update({ "system.weight.value": weight });
    } catch (error) {
      console.error(ID + " | Cannot recalculate weight", error);
    } finally {
      processing.delete(item.uuid);
    }
  }
  Hooks.on("updateItem", (item, changes, options, userId) => {
    if (userId === game.user.id && relevant(changes)) void reconcile(item);
  });
  Hooks.on("createItem", (item, options, userId) => {
    if (userId !== game.user.id) return;
    if (settings(item)?.enabled) void reconcile(item);
    if (game.user?.isGM) void migrate(item);
  });

  function getRoot(app, html) {
    if (html instanceof HTMLElement) return html;
    if (html?.[0] instanceof HTMLElement) return html[0];
    if (app?.element instanceof HTMLElement) return app.element;
    if (app?.element?.[0] instanceof HTMLElement) return app.element[0];
    return null;
  }
  function getItem(app) {
    const doc = app?.document ?? app?.item ?? app?.object;
    return doc?.documentName === "Item" ? doc : null;
  }
  function printNum(v) {
    const n = numeric(v);
    return Number.isFinite(n) ? String(n) : "0";
  }

  async function configure(item) {
    if (!game.user.isGM || !eligible(item)) return;
    const max = numeric(item.system.uses.max);
    if (!(max > 0)) {
      ui.notifications.warn("Сначала укажи положительное максимальное количество зарядов.");
      return;
    }
    const current = settings(item) ?? {};
    const empty = Number.isFinite(numeric(current.empty)) ? current.empty : 0;
    const previousRate = rate(item, current);
    // For an unconfigured item, default to zero charge weight. The GM
    // explicitly chooses how much each portion contributes.
    const perCharge = Number.isFinite(previousRate) ? previousRate : 0;
    const checked = current.enabled ? "checked" : "";
    const units = fu.escapeHTML(String(item.system.weight.units ?? "lb"));

    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (!DialogV2?.wait) {
      ui.notifications.error("Требуется DialogV2 (Foundry VTT v14).");
      return;
    }
    const formHtml =
      '<form class="standard-form ims-dw-dialog">' +
      '<div class="form-group"><label>Динамический вес</label><div class="form-fields">' +
      '<input type="checkbox" name="enabled" ' + checked + '></div></div>' +
      '<div class="form-group"><label>Вес пустого предмета (' + units + ')</label><div class="form-fields">' +
      '<input type="text" inputmode="decimal" autocomplete="off" name="empty" value="' + printNum(empty) + '"></div></div>' +
      '<div class="form-group"><label>Вес одного заряда (' + units + ')</label><div class="form-fields">' +
      '<input type="text" inputmode="decimal" autocomplete="off" name="perCharge" value="' + printNum(perCharge) + '"></div></div>' +
      '<p class="hint">Текущие заряды: ' + printNum(item.system.uses.value) +
      ' / ' + printNum(max) + '. Вес = вес пустого предмета + вес одного заряда × оставшиеся заряды. ' +
      'При изменении максимума зарядов вес одной порции не меняется. ' +
      'При отключении сохраняется текущий вес.</p></form>';

    const result = await DialogV2.wait({
      window: { title: "Динамический вес — " + item.name },
      classes: ["ims-dw-window"],
      position: { width: 700 },
      modal: true,
      content: formHtml,
      buttons: [
        {
          action: "save", label: "Сохранить", default: true,
          callback: (event, button, dialog) => {
            const form = dialog.element.querySelector(".ims-dw-dialog");
            if (!form) return null;
            return {
              enabled: Boolean(form.querySelector('[name="enabled"]')?.checked),
              empty: numeric(form.querySelector('[name="empty"]')?.value),
              perCharge: numeric(form.querySelector('[name="perCharge"]')?.value)
            };
          }
        },
        { action: "cancel", label: "Отмена", callback: () => null }
      ],
      close: () => null
    });
    if (!result) return;
    if (![result.empty, result.perCharge].every(Number.isFinite) ||
        result.empty < 0 || result.perCharge < 0) {
      ui.notifications.warn("Вес пустого предмета и вес одного заряда должны быть неотрицательными числами.");
      return;
    }
    const change = {};
    change["flags." + ID + "." + FLAG] = result;
    if (result.enabled) {
      const weight = calculate(item, change);
      if (weight === null) {
        ui.notifications.warn("Не удалось рассчитать вес. Проверь значение зарядов.");
        return;
      }
      change["system.weight.value"] = weight;
    }
    await item.update(change);
    ui.notifications.info(result.enabled ? "Динамический вес включён." : "Динамический вес выключен.");
  }

  function renderButton(app, html) {
    if (!game.user?.isGM) return;
    const item = getItem(app);
    if (!eligible(item)) return;
    const root = getRoot(app, html);
    if (!root?.querySelector || root.querySelector(".ims-dw-toolbar")) return;
    const target = root.querySelector('.tab[data-tab="details"]') ??
      root.querySelector(".window-content");
    if (!target) return;

    const div = document.createElement("div");
    div.className = "ims-dw-toolbar";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ims-dw-button";
    button.innerHTML = '<i class="fa-solid fa-weight-hanging"></i> Динамический вес: ' +
      (settings(item)?.enabled ? "включён" : "настроить");
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      void configure(item).catch(error => {
        console.error(ID + " | Dynamic weight settings failed", error);
        ui.notifications.error("Не удалось сохранить настройки веса.");
      });
    });
    div.append(button);
    target.prepend(div);
  }

  // One-time migration for items configured in v34.1.0.
  // Keep reading old data in rate() as a fallback, e.g. on unlinked tokens
  // or compendium items that are not owned by a world actor.
  const migrating = new Set();
  async function migrate(item) {
    if (!game.user?.isGM || !item?.isOwner || !eligible(item)) return;
    const cfg = settings(item);
    if (!cfg || Object.prototype.hasOwnProperty.call(cfg, "perCharge") ||
        !Number.isFinite(numeric(cfg.full)) || !Number.isFinite(numeric(cfg.empty))) return;
    const perCharge = rate(item, cfg);
    if (!Number.isFinite(perCharge) || perCharge < 0 || migrating.has(item.uuid)) return;
    migrating.add(item.uuid);
    try {
      // Preserve the original full/empty values in the flag for older setups,
      // while perCharge becomes authoritative in the new formula.
      await item.update({
        ["flags." + ID + "." + FLAG]: {
          ...cfg, perCharge: Math.round(perCharge * 100000000) / 100000000
        }
      });
    } catch (error) {
      console.error(ID + " | Could not migrate dynamic weight for " + item.name, error);
    } finally {
      migrating.delete(item.uuid);
    }
  }

  Hooks.on("renderItemSheet", renderButton);
  Hooks.on("renderItemSheetV2", renderButton);
  Hooks.on("renderApplicationV2", renderButton);
  Hooks.once("ready", () => {
    if (game.system.id !== "dnd5e") return;
    console.log(ID + " | Charge-based weight active (empty + perCharge * remaining).");
    if (!game.user?.isGM) return;

    // Do not block world loading. Update only previously configured items.
    void (async () => {
      const seen = new Set();
      const candidates = [
        ...Array.from(game.items ?? []),
        ...Array.from(game.actors ?? []).flatMap(actor => Array.from(actor.items ?? []))
      ];
      for (const item of candidates) {
        if (!item?.uuid || seen.has(item.uuid)) continue;
        seen.add(item.uuid);
        await migrate(item);
      }
    })();
  });
})();
