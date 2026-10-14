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
  const COINS = new Set(["cp", "sp", "gp"]);

  // Optional dynamic value: price for one portion in the selected coin.
  // Empty containers have zero charge value; disable the option to keep
  // a manually configured price. Existing items are opt-in, never modified.
  function calculatePrice(item, changes={}) {
    if (!eligible(item) || item.system?.price?.value === undefined) return null;
    const cfg = settings(item, changes);
    if (!cfg?.enabled || !cfg.priceEnabled) return null;
    const each = numeric(cfg.perChargePrice);
    const currency = cfg.currency;
    const max = numeric(updated(changes, "system.uses.max", item.system.uses.max));
    const spent = numeric(updated(changes, "system.uses.spent", item.system.uses.spent));
    if (!Number.isFinite(each) || each < 0 || !COINS.has(currency) ||
        !Number.isFinite(max) || max <= 0 || !Number.isFinite(spent)) return null;
    const remaining = Math.max(0, Math.min(max, max - spent));
    return {
      value: Math.round(each * remaining * 10000) / 10000,
      denomination: currency
    };
  }

  function relevant(changes) {
    return changed(changes, "system.uses.spent") ||
      changed(changes, "system.uses.max") ||
      changed(changes, "system.weight.value") ||
      changed(changes, "system.price.value") ||
      changed(changes, "system.price.denomination") ||
      changed(changes, "flags." + ID + "." + FLAG);
  }

  Hooks.on("preUpdateItem", (item, changes) => {
    if (!relevant(changes)) return;
    const weight = calculate(item, changes);
    if (weight !== null) {
      const proposed = numeric(updated(changes, "system.weight.value", item.system.weight.value));
      if (!Number.isFinite(proposed) || Math.abs(proposed - weight) >= 0.00005) {
        changes["system.weight.value"] = weight;
      }
    }
    const price = calculatePrice(item, changes);
    if (price !== null) {
      const proposed = numeric(updated(changes, "system.price.value", item.system.price.value));
      const denomination = updated(changes, "system.price.denomination", item.system.price.denomination);
      if (!Number.isFinite(proposed) || Math.abs(proposed - price.value) >= 0.00005) {
        changes["system.price.value"] = price.value;
      }
      if (denomination !== price.denomination) {
        changes["system.price.denomination"] = price.denomination;
      }
    }
  });

  const processing = new Set();
  async function reconcile(item) {
    if (!item?.isOwner || !item?.parent || processing.has(item.uuid)) return;
    const changes = {};
    const weight = calculate(item);
    if (weight !== null && Math.abs(numeric(item.system.weight.value) - weight) >= 0.00005) {
      changes["system.weight.value"] = weight;
    }
    const price = calculatePrice(item);
    if (price !== null) {
      if (Math.abs(numeric(item.system.price.value) - price.value) >= 0.00005) {
        changes["system.price.value"] = price.value;
      }
      if (item.system.price.denomination !== price.denomination) {
        changes["system.price.denomination"] = price.denomination;
      }
    }
    if (!Object.keys(changes).length) return;
    processing.add(item.uuid);
    try {
      await item.update(changes);
    } catch (error) {
      console.error(ID + " | Cannot recalculate charge weight or price", error);
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
    const priceEnabled = current.priceEnabled ? "checked" : "";
    const priceEach = Number.isFinite(numeric(current.perChargePrice)) ? current.perChargePrice : 0;
    const currency = COINS.has(current.currency) ? current.currency :
      (COINS.has(item.system?.price?.denomination) ? item.system.price.denomination : "cp");
    const units = fu.escapeHTML(String(item.system.weight.units ?? "lb"));

    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (!DialogV2?.wait) {
      ui.notifications.error("Требуется DialogV2 (Foundry VTT v14).");
      return;
    }
    const formHtml =
      // DialogV2 already creates a parent <form>. Nesting another form breaks
      // form association, so use a plain <div> for the dialog content.
      '<div class="standard-form ims-dw-dialog">' +
      '<div class="form-group"><label>Динамический вес</label><div class="form-fields">' +
      '<input type="checkbox" name="enabled" ' + checked + '></div></div>' +
      '<div class="form-group"><label>Вес пустого предмета (' + units + ')</label><div class="form-fields">' +
      '<input type="text" inputmode="decimal" autocomplete="off" name="empty" value="' + printNum(empty) + '"></div></div>' +
      '<div class="form-group"><label>Вес одного заряда (' + units + ')</label><div class="form-fields">' +
      '<input type="text" inputmode="decimal" autocomplete="off" name="perCharge" value="' + printNum(perCharge) + '"></div></div>' +
      '<div class="form-group"><label>Пересчитывать цену от зарядов</label><div class="form-fields">' +
      '<input type="checkbox" name="priceEnabled" ' + priceEnabled + '></div></div>' +
      '<div class="form-group"><label>Цена одного заряда</label><div class="form-fields">' +
      '<input type="text" inputmode="decimal" autocomplete="off" name="perChargePrice" value="' +
      printNum(priceEach) + '">' +
      '<select name="currency" aria-label="Валюта одного заряда">' +
      '<option value="cp"' + (currency === "cp" ? " selected" : "") + '>Медь (мм)</option>' +
      '<option value="sp"' + (currency === "sp" ? " selected" : "") + '>Серебро (см)</option>' +
      '<option value="gp"' + (currency === "gp" ? " selected" : "") + '>Золото (зм)</option>' +
      '</select></div></div>' +
      '<p class="hint">Текущие заряды: ' + printNum(item.system.uses.value) +
      ' / ' + printNum(max) + '. Вес = вес пустого предмета + вес одного заряда × оставшиеся заряды. ' +
      'При включённом пересчёте цены стоимость = цена одного заряда × оставшиеся заряды, ' +
      'без стоимости пустой тары. При выключенном пересчёте цена не изменяется автоматически.</p></div>';

    const result = await DialogV2.wait({
      window: { title: "Динамический вес — " + item.name },
      classes: ["ims-dw-window"],
      position: { width: 700 },
      modal: true,
      content: formHtml,
      buttons: [
        {
          action: "save", label: "Сохранить", default: true,
          callback: (event, button) => {
            // Foundry VTT 14: button.form is the dialog's FORM element.
            // The third callback argument is not guaranteed to be an
            // ApplicationV2 instance and must not be used as dialog.element.
            const elements = button?.form?.elements;
            if (!elements) return { invalid: true };
            const field = name => elements.namedItem?.(name) ?? elements[name];
            return {
              enabled: Boolean(field("enabled")?.checked),
              empty: numeric(field("empty")?.value),
              perCharge: numeric(field("perCharge")?.value),
              priceEnabled: Boolean(field("priceEnabled")?.checked),
              perChargePrice: numeric(field("perChargePrice")?.value),
              currency: field("currency")?.value
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
    if (result.priceEnabled && (!Number.isFinite(result.perChargePrice) ||
        result.perChargePrice < 0 || !COINS.has(result.currency))) {
      ui.notifications.warn("Укажи корректную неотрицательную цену одного заряда и выбери валюту.");
      return;
    }
    // An unused price field must never block saving just the weight.
    if (!result.priceEnabled) {
      result.perChargePrice = 0;
      result.currency = COINS.has(result.currency) ? result.currency : "cp";
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
      const price = calculatePrice(item, change);
      if (price !== null) {
        change["system.price.value"] = price.value;
        change["system.price.denomination"] = price.denomination;
      }
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
