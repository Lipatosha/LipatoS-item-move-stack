/**
 * LipatoS — dynamic weight from charges, Foundry v14 / dnd5e 6.0.6
 * Persistent uses fields: system.uses.spent, system.uses.max.
 * system.uses.value is derived, so it must NOT be written.
 */
(() => {
  const ID = "lipatos-item-move-stack";
  const FLAG = "dynamicWeight";
  const fu = foundry.utils;

  function numeric(value) {
    if (value === "" || value === undefined || value === null) return NaN;
    const n = Number(value);
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
  function calculate(item, changes={}) {
    if (!eligible(item)) return null;
    const cfg = settings(item, changes);
    if (!cfg?.enabled) return null;
    const full = numeric(cfg.full), empty = numeric(cfg.empty);
    const max = numeric(updated(changes, "system.uses.max", item.system.uses.max));
    const spent = numeric(updated(changes, "system.uses.spent", item.system.uses.spent));
    if (![full, empty, max, spent].every(Number.isFinite) ||
        empty < 0 || full < empty || max <= 0) return null;
    const remaining = Math.max(0, Math.min(max, max - spent));
    return Math.round((empty + (full - empty) * remaining / max) * 10000) / 10000;
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
    if (userId === game.user.id && settings(item)?.enabled) void reconcile(item);
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
    const full = Number.isFinite(numeric(current.full)) ? current.full : item.system.weight.value;
    const empty = Number.isFinite(numeric(current.empty)) ? current.empty : 0;
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
      '<div class="form-group"><label>Вес полной ёмкости (' + units + ')</label><div class="form-fields">' +
      '<input type="number" name="full" min="0" step="any" value="' + printNum(full) + '"></div></div>' +
      '<div class="form-group"><label>Вес пустой ёмкости (' + units + ')</label><div class="form-fields">' +
      '<input type="number" name="empty" min="0" step="any" value="' + printNum(empty) + '"></div></div>' +
      '<p class="hint">Текущие заряды: ' + printNum(item.system.uses.value) +
      ' / ' + printNum(max) + '. Вес единицы предмета меняется с остатком зарядов. ' +
      'При отключении сохраняется текущий вес.</p></form>';

    const result = await DialogV2.wait({
      window: { title: "Динамический вес — " + item.name },
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
              full: numeric(form.querySelector('[name="full"]')?.value),
              empty: numeric(form.querySelector('[name="empty"]')?.value)
            };
          }
        },
        { action: "cancel", label: "Отмена", callback: () => null }
      ],
      close: () => null
    });
    if (!result) return;
    if (![result.full, result.empty].every(Number.isFinite) ||
        result.empty < 0 || result.full < result.empty) {
      ui.notifications.warn("Вес полной ёмкости должен быть не меньше веса пустой. Оба значения должны быть положительными или нулём.");
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

  Hooks.on("renderItemSheet", renderButton);
  Hooks.on("renderItemSheetV2", renderButton);
  Hooks.on("renderApplicationV2", renderButton);
  Hooks.once("ready", () => {
    if (game.system.id === "dnd5e") console.log(ID + " | Charge-based weight active.");
  });
})();
