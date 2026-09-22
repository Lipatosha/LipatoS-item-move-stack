const MODULE_ID = "lipatos-item-move-stack";
const LEGACY_MODULE_ID = "item-move-stack";

function getDragData(event) {
  try {
    const TE = foundry?.applications?.ux?.TextEditor?.implementation;
    if (TE?.getDragEventData) return TE.getDragEventData(event);
  } catch (_) {}
  try {
    const raw = event?.dataTransfer?.getData("text/plain");
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function getActor(sheet) {
  return sheet?.actor ?? sheet?.document ?? sheet?.object ?? null;
}

function getQuantity(item) {
  const q = Number(item?.system?.quantity ?? 1);
  return Number.isFinite(q) ? q : 1;
}

function getIdentifier(item) {
  return String(item?.system?.identifier ?? "").trim().toLowerCase();
}

function isStackable(item) {
  return item && typeof item?.system?.quantity !== "undefined";
}

function sameItem(a, b) {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (String(a.name ?? "").trim().toLowerCase() !== String(b.name ?? "").trim().toLowerCase()) return false;

  const ai = getIdentifier(a);
  const bi = getIdentifier(b);

  // If D&D5e provides identifiers, require them to match.
  // If there are no identifiers, same type + same name is treated as the same item.
  if (ai || bi) return ai === bi;
  return true;
}


async function askTransferQuantity(item, targetActor) {
  const max = Math.max(1, Math.floor(getQuantity(item)));
  const DialogV2 = foundry.applications?.api?.DialogV2;

  if (!DialogV2?.wait) {
    const raw = window.prompt(
      `Сколько "${item.name}" передать в "${targetActor?.name ?? "получатель"}"? (1–${max})`,
      String(max)
    );
    if (raw === null) return null;

    const value = Math.floor(Number(raw));
    if (!Number.isFinite(value)) return null;
    return Math.max(1, Math.min(max, value));
  }

  const uid = foundry.utils.randomID();
  const wrapClass = `ims-transfer-${uid}`;

  const normalize = value => {
    value = Math.floor(Number(value));
    if (!Number.isFinite(value)) value = 1;
    return Math.max(1, Math.min(max, value));
  };

  // Sync BOTH directions:
  // slider -> number
  // number -> slider
  const onInput = event => {
    const el = event.target;
    const root = el?.closest?.(`.${wrapClass}`);
    if (!root) return;

    const range = root.querySelector('input[name="quantity"]');
    const number = root.querySelector('input[name="quantityNumber"]');
    if (!range || !number) return;

    if (el === range) {
      const value = normalize(range.value);
      number.value = String(value);
    } else if (el === number) {
      // While typing, allow the user to momentarily clear the field.
      if (number.value === "") return;
      const value = normalize(number.value);
      number.value = String(value);
      range.value = String(value);
    }
  };

  const onChange = event => {
    const el = event.target;
    const root = el?.closest?.(`.${wrapClass}`);
    if (!root) return;

    const range = root.querySelector('input[name="quantity"]');
    const number = root.querySelector('input[name="quantityNumber"]');
    if (!range || !number) return;

    const value = normalize(el.value);
    range.value = String(value);
    number.value = String(value);
  };

  document.addEventListener("input", onInput, true);
  document.addEventListener("change", onChange, true);

  try {
    return await DialogV2.wait({
      window: {
        title: "Передать предмет"
      },
      modal: true,
      content: `
        <div class="standard-form ims-transfer-quantity ${wrapClass}">
          <div class="ims-transfer-header">
            <div class="ims-transfer-item">
              <strong class="ims-transfer-item-name">${foundry.utils.escapeHTML(item.name)}</strong>
              <img
                class="ims-transfer-icon"
                src="${foundry.utils.escapeHTML(item.img ?? "icons/svg/item-bag.svg")}"
                alt="${foundry.utils.escapeHTML(item.name)}"
              >
            </div>
            <div class="ims-transfer-target">→ ${foundry.utils.escapeHTML(targetActor?.name ?? "")}</div>
          </div>

          <div class="form-group ims-transfer-amount-group">
            <label>Количество</label>
            <div class="form-fields ims-quantity-fields">
              <input
                type="range"
                name="quantity"
                min="1"
                max="${max}"
                step="1"
                value="${max}"
              >
              <input
                class="ims-current-value"
                type="number"
                name="quantityNumber"
                min="1"
                max="${max}"
                step="1"
                value="${max}"
                inputmode="numeric"
                autocomplete="off"
              >
            </div>
          </div>

          <div class="ims-transfer-hint">Доступно: ${max}</div>
        </div>`,
      buttons: [
        {
          action: "confirm",
          label: "Подтвердить",
          default: true,
          callback: async (event, button, dialog) => {
            const form = dialog.element.querySelector(`.${wrapClass}`);
            if (!form) return null;

            const number = form.querySelector('input[name="quantityNumber"]');
            const range = form.querySelector('input[name="quantity"]');

            const value = normalize(number?.value ?? range?.value ?? max);
            if (number) number.value = String(value);
            if (range) range.value = String(value);

            return value;
          }
        },
        {
          action: "cancel",
          label: "Отмена",
          callback: async () => null
        }
      ],
      close: () => null
    });
  } finally {
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("change", onChange, true);
  }
}


function getDropTargetItem(targetActor, event) {
  const row = event?.target?.closest?.("[data-item-id], [data-document-id]");
  if (!row) return null;

  const itemId = row.dataset.itemId ?? row.dataset.documentId;
  if (!itemId) return null;

  return targetActor?.items?.get(itemId) ?? null;
}

async function mergeSameActorStacks(sourceItem, targetItem) {
  if (!sourceItem || !targetItem) return false;
  if (sourceItem.id === targetItem.id) return false;
  if (!isStackable(sourceItem) || !isStackable(targetItem)) return false;
  if (!sameItem(sourceItem, targetItem)) return false;

  const sourceQty = Math.max(0, Math.floor(getQuantity(sourceItem)));
  const targetQty = Math.max(0, Math.floor(getQuantity(targetItem)));
  if (sourceQty <= 0) return false;

  try {
    await targetItem.update({"system.quantity": targetQty + sourceQty});
    await sourceItem.delete({itemMoveStackMerge: true});

    ui.notifications.info(`${sourceItem.name}: стопки объединены ×${targetQty + sourceQty}`);
    return true;
  } catch (err) {
    console.error(`${MODULE_ID} | Same-actor stack merge failed`, err);
    ui.notifications.error("Не удалось объединить стопки. Смотри консоль F12.");
    return true;
  }
}

async function transferItem(sheet, event, data) {
  if (game.system.id !== "dnd5e") return null;
  if (data?.type !== "Item") return null;

  const ItemClass = CONFIG.Item?.documentClass ?? Item;
  const sourceItem = await ItemClass.fromDropData(data);
  const targetActor = getActor(sheet);
  const sourceActor = sourceItem?.parent;

  // Only intercept owned embedded Items being moved Actor -> different Actor.
  if (!sourceItem || !targetActor || sourceActor?.documentName !== "Actor") return null;
  if (targetActor.documentName !== "Actor") return null;

  // Same Actor: if one identical stack is dropped directly onto another,
  // merge them into a single stack. Otherwise leave normal D&D5e behavior alone.
  if (sourceActor.uuid === targetActor.uuid) {
    const targetItem = getDropTargetItem(targetActor, event);
    if (!targetItem) return null;

    if (sourceItem.id !== targetItem.id && isStackable(sourceItem) && isStackable(targetItem) && sameItem(sourceItem, targetItem)) {
      return await mergeSameActorStacks(sourceItem, targetItem);
    }

    return null;
  }

  if (!sourceItem.isOwner || !targetActor.isOwner) {
    ui.notifications.warn("Нет прав для перемещения этого предмета.");
    return false;
  }

  const sourceQty = Math.max(1, Math.floor(getQuantity(sourceItem)));
  let qty = await askTransferQuantity(sourceItem, targetActor);

  // Cancel = do absolutely nothing.
  if (qty == null) return false;

  qty = Math.floor(Number(qty));
  if (!Number.isFinite(qty)) return false;
  qty = Math.max(1, Math.min(sourceQty, qty));

  const targetItem = isStackable(sourceItem)
    ? targetActor.items.find(i => isStackable(i) && sameItem(i, sourceItem))
    : null;

  let created = [];
  let oldTargetQty = null;
  const oldSourceQty = sourceQty;

  try {
    // 1. Add the selected quantity to destination.
    if (targetItem) {
      oldTargetQty = getQuantity(targetItem);
      await targetItem.update({"system.quantity": oldTargetQty + qty});
    } else {
      const itemData = sourceItem.toObject();
      delete itemData._id;

      if (foundry.utils.hasProperty(itemData, "system.quantity")) {
        foundry.utils.setProperty(itemData, "system.quantity", qty);
      }

      // A container ID belongs to the source actor, so don't carry it across actors.
      if (foundry.utils.hasProperty(itemData, "system.container")) {
        foundry.utils.setProperty(itemData, "system.container", null);
      }

      created = await targetActor.createEmbeddedDocuments("Item", [itemData], {keepId: false});
    }

    // 2. Remove only the selected quantity from the source.
    if (qty >= oldSourceQty) {
      await sourceItem.delete();
    } else {
      await sourceItem.update({"system.quantity": oldSourceQty - qty});
    }

    ui.notifications.info(
      targetItem
        ? `${sourceItem.name}: передано и объединено ×${qty}`
        : `${sourceItem.name}: передано ×${qty}`
    );

    return true;
  } catch (err) {
    console.error(`${MODULE_ID} | Transfer failed`, err);

    // Best-effort rollback.
    try {
      if (targetItem && oldTargetQty !== null) {
        await targetItem.update({"system.quantity": oldTargetQty});
      } else if (created?.length) {
        await targetActor.deleteEmbeddedDocuments("Item", created.map(i => i.id));
      }

      // Restore source only if it still exists and quantity changed.
      const currentSource = sourceActor.items.get(sourceItem.id);
      if (currentSource && getQuantity(currentSource) !== oldSourceQty) {
        await currentSource.update({"system.quantity": oldSourceQty});
      }
    } catch (rollbackErr) {
      console.error(`${MODULE_ID} | Rollback failed`, rollbackErr);
    }

    ui.notifications.error("Не удалось передать предмет. Смотри консоль F12.");
    return false;
  }
}


/* ============================================================
 * v17: Reliable DOM-based right-click "Передать предмет"
 * D&D5e 6 uses its own context-menu pipeline, so we inject into
 * the actual rendered Foundry context menu instead of patching
 * a sheet method that may never be called.
 * ============================================================ */

let imsLastContextItem = null;

function imsResolveContextItem(row) {
  if (!row) return null;

  const itemId = row.dataset.itemId ?? row.dataset.documentId;
  const uuid = row.dataset.uuid;

  if (uuid) {
    try {
      const doc = foundry.utils.fromUuidSync(uuid);
      if (doc?.documentName === "Item" && doc.parent?.documentName === "Actor") return doc;
    } catch (_) {}
  }

  if (!itemId) return null;

  // First try to identify the actor from the surrounding sheet element.
  for (const actor of game.actors) {
    const item = actor.items?.get(itemId);
    if (!item) continue;

    try {
      const sheetEl = actor.sheet?.element;
      if (sheetEl?.contains?.(row)) return item;
    } catch (_) {}
  }

  // Embedded item IDs are normally unique enough for this fallback.
  for (const actor of game.actors) {
    const item = actor.items?.get(itemId);
    if (item) return item;
  }

  return null;
}

function imsTransferRecipients(sourceActor) {
  const result = [{id: "__GM__", name: "ГМ", type: "gm"}];

  // If we are transferring FROM Group, show GM first and then players.
  if (sourceActor?.type === "group") {
    for (const actor of game.actors) {
      if (actor.id === sourceActor.id) continue;
      if (actor.type !== "character") continue;

      result.push({
        id: actor.id,
        name: actor.name,
        type: "character"
      });
    }

    return result;
  }

  // From a normal character: GM, Group(s), then other players.
  for (const actor of game.actors) {
    if (actor.id === sourceActor.id) continue;
    if (!["group", "character"].includes(actor.type)) continue;

    result.push({
      id: actor.id,
      name: actor.name,
      type: actor.type
    });
  }

  return result.sort((a, b) => {
    if (a.type === "gm") return -1;
    if (b.type === "gm") return 1;
    if (a.type === "group" && b.type !== "group") return -1;
    if (b.type === "group" && a.type !== "group") return 1;
    return a.name.localeCompare(b.name, game.i18n.lang);
  });
}

function imsPrimaryActiveGM() {
  return game.users
    .filter(u => u.isGM && u.active)
    .sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
}

async function imsGMHandleTransfer(payload) {
  if (!game.user.isGM) return;
  const primary = imsPrimaryActiveGM();
  if (primary && primary.id !== game.user.id) return;

  const sourceActor = await fromUuid(payload?.sourceActorUuid).catch(() => null);
  if (!sourceActor?.items) return;

  const sourceItem = sourceActor.items.get(payload?.sourceItemId);
  if (!sourceItem) return;

  if (payload?.target === "__GM__") {
    // "Передать ГМу" = remove the item/quantity from the sender.
    const sourceQty = Math.max(1, Math.floor(getQuantity(sourceItem)));
    const qty = Math.max(1, Math.min(sourceQty, Math.floor(Number(payload.qty) || 1)));

    if (qty >= sourceQty) await sourceItem.delete();
    else await sourceItem.update({"system.quantity": sourceQty - qty});

    game.socket.emit(`module.${MODULE_ID}`, {
      type: "ims-transfer-result",
      requestId: payload.requestId,
      ok: true,
      targetName: "ГМ",
      targetType: "gm",
      sourceActorName: sourceActor.name,
      sourceActorType: sourceActor.type,
      itemName: sourceItem.name,
      itemImg: sourceItem.img,
      qty
    });
    return;
  }

  const targetActor = game.actors.get(payload?.targetActorId);
  if (!targetActor) {
    game.socket.emit(`module.${MODULE_ID}`, {
      type: "ims-transfer-result",
      requestId: payload.requestId,
      ok: false,
      error: "Получатель больше недоступен."
    });
    return;
  }

  const sourceQty = Math.max(1, Math.floor(getQuantity(sourceItem)));
  const qty = Math.max(1, Math.min(sourceQty, Math.floor(Number(payload.qty) || 1)));

  const targetItem = isStackable(sourceItem)
    ? targetActor.items.find(i => isStackable(i) && sameItem(i, sourceItem))
    : null;

  if (targetItem) {
    await targetItem.update({"system.quantity": getQuantity(targetItem) + qty});
  } else {
    const itemData = sourceItem.toObject();
    delete itemData._id;
    if (foundry.utils.hasProperty(itemData, "system.quantity")) {
      foundry.utils.setProperty(itemData, "system.quantity", qty);
    }
    if (foundry.utils.hasProperty(itemData, "system.container")) {
      foundry.utils.setProperty(itemData, "system.container", null);
    }
    await targetActor.createEmbeddedDocuments("Item", [itemData], {keepId: false});
  }

  if (qty >= sourceQty) await sourceItem.delete();
  else await sourceItem.update({"system.quantity": sourceQty - qty});

  game.socket.emit(`module.${MODULE_ID}`, {
    type: "ims-transfer-result",
    requestId: payload.requestId,
    ok: true,
    targetName: targetActor.name,
    targetType: targetActor.type,
    sourceActorName: sourceActor.name,
    sourceActorType: sourceActor.type,
    itemName: sourceItem.name,
    itemImg: sourceItem.img,
    qty
  });
}


async function imsPlayerTransferChat(result) {
  if (game.user.isGM || !result?.ok) return;

  const target = foundry.utils.escapeHTML(result.targetName ?? "Получатель");
  const itemName = foundry.utils.escapeHTML(result.itemName ?? "Предмет");
  const img = foundry.utils.escapeHTML(result.itemImg ?? "icons/svg/item-bag.svg");
  const qty = Math.max(1, Number(result.qty ?? 1) || 1);

  const content = `
    <div class="pcga-item-audit">
      📦 <strong>Передача предмета</strong><br>
      Вы передали → [ <strong>${target}</strong> ]<br>
      <div class="pcga-item-line">
        <img src="${img}" alt="${itemName}">
        <span>${itemName}${qty > 1 ? ` × <strong>${qty}</strong>` : ""}</span>
      </div>
      <strong>Успешно передано ✓</strong>
    </div>`;

  await ChatMessage.create({
    content,
    whisper: [game.user.id],
    speaker: ChatMessage.getSpeaker()
  });
}

function imsSendAuditToCurrencyModule(result) {
  if (game.user.isGM || !result?.ok) return;

  game.socket.emit("module.player-currency-gm-audit", {
    type: "item-audit",
    action: "transfer",
    sourceActorName: result.sourceActorName,
    sourceActorType: result.sourceActorType,
    targetActorName: result.targetName,
    targetActorType: result.targetType,
    itemName: result.itemName,
    itemImg: result.itemImg,
    quantity: result.qty
  });
}

function imsRequestGMTransfer(sourceItem, recipient, qty) {
  return new Promise(resolve => {
    const requestId = foundry.utils.randomID();
    const socket = `module.${MODULE_ID}`;

    const handler = payload => {
      if (payload?.type !== "ims-transfer-result" || payload?.requestId !== requestId) return;
      game.socket.off(socket, handler);
      resolve(payload);
    };

    game.socket.on(socket, handler);

    game.socket.emit(socket, {
      type: "ims-transfer-request",
      requestId,
      sourceActorUuid: sourceItem.parent.uuid,
      sourceItemId: sourceItem.id,
      target: recipient.id === "__GM__" ? "__GM__" : "actor",
      targetActorId: recipient.id === "__GM__" ? null : recipient.id,
      qty
    });

    setTimeout(() => {
      game.socket.off(socket, handler);
      resolve({ok: false, error: "ГМ не ответил на запрос передачи."});
    }, 8000);
  });
}

async function imsTransferFromMenu(sourceItem, targetActor, qty) {
  const sourceActor = sourceItem?.parent;
  if (!sourceItem || sourceActor?.documentName !== "Actor" || !targetActor) return false;

  if (!sourceItem.isOwner) {
    ui.notifications.warn("Нет прав для передачи этого предмета.");
    return false;
  }

  if (!targetActor.isOwner) {
    const result = await imsRequestGMTransfer(sourceItem, {id: targetActor.id, name: targetActor.name}, qty);
    if (!result?.ok) {
      ui.notifications.warn(result?.error ?? "Не удалось передать предмет.");
      return false;
    }
    ui.notifications.info(`${sourceItem.name}: передано ×${result.qty}`);
    return true;
  }

  const sourceQty = Math.max(1, Math.floor(getQuantity(sourceItem)));
  qty = Math.floor(Number(qty));
  if (!Number.isFinite(qty)) return false;
  qty = Math.max(1, Math.min(sourceQty, qty));

  const targetItem = isStackable(sourceItem)
    ? targetActor.items.find(i => isStackable(i) && sameItem(i, sourceItem))
    : null;

  let created = [];
  let oldTargetQty = null;

  try {
    if (targetItem) {
      oldTargetQty = getQuantity(targetItem);
      await targetItem.update({"system.quantity": oldTargetQty + qty});
    } else {
      const itemData = sourceItem.toObject();
      delete itemData._id;

      if (foundry.utils.hasProperty(itemData, "system.quantity")) {
        foundry.utils.setProperty(itemData, "system.quantity", qty);
      }

      if (foundry.utils.hasProperty(itemData, "system.container")) {
        foundry.utils.setProperty(itemData, "system.container", null);
      }

      created = await targetActor.createEmbeddedDocuments("Item", [itemData], {keepId: false});
    }

    if (qty >= sourceQty) {
      await sourceItem.delete();
    } else {
      await sourceItem.update({"system.quantity": sourceQty - qty});
    }

    ui.notifications.info(`${sourceItem.name}: передано ×${qty}`);
    return true;
  } catch (err) {
    console.error(`${MODULE_ID} | Context transfer failed`, err);

    try {
      if (targetItem && oldTargetQty !== null) {
        await targetItem.update({"system.quantity": oldTargetQty});
      } else if (created?.length) {
        await targetActor.deleteEmbeddedDocuments("Item", created.map(i => i.id));
      }

      const currentSource = sourceActor.items.get(sourceItem.id);
      if (currentSource && getQuantity(currentSource) !== sourceQty) {
        await currentSource.update({"system.quantity": sourceQty});
      }
    } catch (rollbackErr) {
      console.error(`${MODULE_ID} | Context transfer rollback failed`, rollbackErr);
    }

    ui.notifications.error("Не удалось передать предмет.");
    return false;
  }
}

async function imsOpenTransferMenuDialog(item) {
  const sourceActor = item?.parent;
  if (!item || sourceActor?.documentName !== "Actor") return;

  const recipients = imsTransferRecipients(sourceActor);
  if (!recipients.length) {
    ui.notifications.warn("Нет доступных персонажей или Групп для передачи.");
    return;
  }

  const max = Math.max(1, Math.floor(getQuantity(item)));
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (!DialogV2?.wait) return;

  const uid = foundry.utils.randomID();
  const wrapClass = `ims-menu-transfer-${uid}`;

  const clamp = value => {
    value = Math.floor(Number(value));
    if (!Number.isFinite(value)) value = 1;
    return Math.max(1, Math.min(max, value));
  };

  // EXACTLY the same two-way sync pattern as the working drag-and-drop dialog.
  const onInput = event => {
    const el = event.target;
    const root = el?.closest?.(`.${wrapClass}`);
    if (!root) return;

    const range = root.querySelector('input[name="quantity"]');
    const number = root.querySelector('input[name="quantityNumber"]');
    if (!range || !number) return;

    if (el === range) {
      number.value = String(clamp(range.value));
    } else if (el === number) {
      if (number.value === "") return;
      const value = clamp(number.value);
      number.value = String(value);
      range.value = String(value);
    }
  };

  const onChange = event => {
    const el = event.target;
    const root = el?.closest?.(`.${wrapClass}`);
    if (!root) return;
    if (!el.matches('input[name="quantity"], input[name="quantityNumber"]')) return;

    const range = root.querySelector('input[name="quantity"]');
    const number = root.querySelector('input[name="quantityNumber"]');
    if (!range || !number) return;

    const value = clamp(el.value);
    range.value = String(value);
    number.value = String(value);
  };

  document.addEventListener("input", onInput, true);
  document.addEventListener("change", onChange, true);

  // Use indexes instead of Actor IDs. This avoids the "recipient unavailable"
  // bug caused by reading the wrong/empty select value from DialogV2.
  const options = recipients.map((recipient, index) =>
    `<option value="${index}">${foundry.utils.escapeHTML(recipient.name)}</option>`
  ).join("");

  try {
    const result = await DialogV2.wait({
      window: {title: "Передать предмет"},
      modal: true,
      content: `
        <div class="standard-form ims-menu-transfer ${wrapClass}">
          <div class="ims-menu-transfer-header">
            <img src="${foundry.utils.escapeHTML(item.img ?? "icons/svg/item-bag.svg")}"
                 alt="${foundry.utils.escapeHTML(item.name)}">
            <div class="ims-menu-transfer-info">
              <strong>${foundry.utils.escapeHTML(item.name)}</strong>
              <span>Доступно: ${max}</span>
            </div>
          </div>

          <div class="form-group">
            <label>Кому передать</label>
            <div class="form-fields">
              <select name="recipient">${options}</select>
            </div>
          </div>

          <div class="form-group">
            <label>Количество</label>
            <div class="form-fields ims-quantity-fields">
              <input
                type="range"
                name="quantity"
                min="1"
                max="${max}"
                step="1"
                value="${max}"
              >
              <input
                class="ims-current-value"
                type="number"
                name="quantityNumber"
                min="1"
                max="${max}"
                step="1"
                value="${max}"
                inputmode="numeric"
                autocomplete="off"
              >
            </div>
          </div>
        </div>`,
      buttons: [
        {
          action: "confirm",
          label: "Подтвердить",
          default: true,
          callback: async (event, button, dialog) => {
            // DialogV2 owns the real form. Read through button.form, not a nested <form>.
            const recipientRaw = button.form?.elements?.recipient?.value;
            const quantityRaw = button.form?.elements?.quantityNumber?.value
              ?? button.form?.elements?.quantity?.value;

            const recipientIndex = Number(recipientRaw);
            if (!Number.isInteger(recipientIndex) || !recipients[recipientIndex]) {
              ui.notifications.warn("Не удалось определить получателя.");
              return null;
            }

            return {
              recipientIndex,
              qty: clamp(quantityRaw ?? max)
            };
          }
        },
        {
          action: "cancel",
          label: "Отмена",
          callback: async () => null
        }
      ],
      close: () => null
    });

    if (!result) return;

    const selected = recipients[result.recipientIndex];
    if (!selected) {
      ui.notifications.warn("Получатель больше недоступен.");
      return;
    }

    const result2 = await imsRequestGMTransfer(item, selected, result.qty);
    if (!result2?.ok) {
      ui.notifications.warn(result2?.error ?? "Не удалось передать предмет.");
      return;
    }

    await imsPlayerTransferChat(result2);
    imsSendAuditToCurrencyModule(result2);
    ui.notifications.info(`${item.name}: передано ×${result2.qty}`);
    return;
  } finally {
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("change", onChange, true);
  }
}

function imsInjectContextTransfer(menu) {
  if (!menu) return;

  // Always remove player-only forbidden entries before adding transfer.
  imsCleanContextMenu(menu);

  if (menu.querySelector(".ims-context-transfer-entry")) return;
  const item = imsLastContextItem;

  if (!item || !item.isOwner || !imsTransferRecipients(item.parent).length) return;

  const entry = document.createElement("li");
  entry.className = "context-item ims-context-transfer-entry";
  entry.innerHTML = `<i class="fa-solid fa-arrow-right-arrow-left"></i> Передать предмет`;

  entry.addEventListener("click", async event => {
    event.preventDefault();
    event.stopPropagation();

    const selected = imsLastContextItem;
    menu.remove();

    if (selected) await imsOpenTransferMenuDialog(selected);
  });

  // Put "Передать предмет" immediately after "Просмотр предмета" when possible.
  const rows = Array.from(menu.querySelectorAll(".context-item, li"));
  const view = rows.find(el =>
    String(el.textContent ?? "").trim().toLowerCase().includes("просмотр предмета")
  );

  if (view) view.insertAdjacentElement("afterend", entry);
  else menu.appendChild(entry);

  imsReorderPlayerContextMenu(menu);
}

function imsInstallContextTransfer() {
  // Capture the exact item that was right-clicked.
  document.addEventListener("contextmenu", event => {
    const row = event.target?.closest?.("[data-item-id], [data-document-id], [data-uuid]");
    if (!row) {
      imsLastContextItem = null;
      return;
    }

    imsLastContextItem = imsResolveContextItem(row);

    // Foundry normally creates the context menu after the contextmenu event.
    setTimeout(() => {
      const menu = document.querySelector("#context-menu, .context-menu");
      if (menu) imsInjectContextTransfer(menu);
    }, 0);
  }, true);

  // Also observe newly-created menus, which covers delayed ApplicationV2 rendering.
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;

        if (node.matches?.("#context-menu, .context-menu")) {
          imsInjectContextTransfer(node);
        }

        const nested = node.querySelector?.("#context-menu, .context-menu");
        if (nested) imsInjectContextTransfer(nested);
      }
    }
  });

  observer.observe(document.body, {childList: true, subtree: true});
  console.log(`${MODULE_ID} | DOM context-menu transfer installed.`);
}

function patchSheetClass(cls, label) {
  if (!cls?.prototype) return false;

  const method = typeof cls.prototype._onDrop === "function"
    ? "_onDrop"
    : (typeof cls.prototype._onDropItem === "function" ? "_onDropItem" : null);

  if (!method) return false;

  const marker = `__${MODULE_ID.replaceAll("-", "_")}_${method}`;
  if (cls.prototype[marker]) return true;

  const original = cls.prototype[method];
  Object.defineProperty(cls.prototype, marker, {value: true, configurable: true});

  cls.prototype[method] = async function(event, ...args) {
    const data = args[0] && typeof args[0] === "object" && args[0].type
      ? args[0]
      : getDragData(event);

    if (data?.type === "Item") {
      const handled = await transferItem(this, event, data);
      if (handled !== null) return handled;
    }

    return original.call(this, event, ...args);
  };

  console.log(`${MODULE_ID} | Patched ${label}.${method}`);
  return true;
}



/* ============================================================
 * v2: Group inventory improvements
 * - "Разделить стопку" in the Group context menu
 * - Group carrying-capacity bar; only GM can change maximum
 * ============================================================ */

function getGroupInventoryItem(sheet, target) {
  const row = target?.closest?.("[data-item-id], [data-document-id], [data-uuid]");
  if (!row) return null;

  const source = sheet.inventorySource ?? sheet.actor;
  if (!source || source.documentName !== "Actor") return null;

  const itemId = row.dataset.itemId ?? row.dataset.documentId;
  if (itemId && source.items?.get(itemId)) return source.items.get(itemId);

  const uuid = row.dataset.uuid;
  if (uuid) {
    const doc = foundry.utils.fromUuidSync(uuid);
    if (doc?.documentName === "Item" && doc.parent?.uuid === source.uuid) return doc;
  }
  return null;
}

async function askSplitQuantity(item) {
  const max = Math.max(1, Math.floor(getQuantity(item)) - 1);
  if (max < 1) return null;

  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (DialogV2?.wait) {
    return DialogV2.wait({
      window: { title: `Разделить стопку: ${item.name}` },
      content: `
        <form class="standard-form">
          <div class="form-group">
            <label>Количество в новой стопке</label>
            <div class="form-fields">
              <input type="number" name="quantity" value="1" min="1" max="${max}" step="1" autofocus>
            </div>
            <p class="hint">Можно отделить от 1 до ${max}.</p>
          </div>
        </form>`,
      buttons: [
        {
          action: "split",
          label: "Разделить",
          icon: "fa-solid fa-code-branch",
          default: true,
          callback: (event, button, dialog) => {
            const input = dialog.element.querySelector('input[name="quantity"]');
            return Number(input?.value ?? 0);
          }
        },
        {
          action: "cancel",
          label: "Отмена",          icon: "fa-solid fa-xmark",
          callback: () => null
        }
      ],
      close: () => null
    });
  }

  const raw = window.prompt(`Сколько отделить от "${item.name}"? (1–${max})`, "1");
  return raw === null ? null : Number(raw);
}

async function splitGroupStack(sheet, target) {
  const item = getGroupInventoryItem(sheet, target);
  if (!item) return;

  const originalQty = Math.floor(getQuantity(item));
  if (originalQty <= 1) {
    ui.notifications.warn("Эту стопку нельзя разделить.");
    return;
  }

  let splitQty = await askSplitQuantity(item);
  if (splitQty == null) return;
  splitQty = Math.floor(Number(splitQty));

  if (!Number.isFinite(splitQty) || splitQty < 1 || splitQty >= originalQty) {
    ui.notifications.warn(`Введите количество от 1 до ${originalQty - 1}.`);
    return;
  }

  const clone = item.toObject();
  delete clone._id;
  foundry.utils.setProperty(clone, "system.quantity", splitQty);

  try {
    await item.update({"system.quantity": originalQty - splitQty});
    await item.parent.createEmbeddedDocuments("Item", [clone], {keepId: false});
  } catch (err) {
    console.error(`${MODULE_ID} | Stack split failed`, err);
    try { await item.update({"system.quantity": originalQty}); } catch (_) {}
    ui.notifications.error("Не удалось разделить стопку. Смотри консоль F12.");
  }
}

function groupWeight(actor) {
  let total = 0;

  for (const item of actor.items ?? []) {
    const qty = Math.max(0, Number(item.system?.quantity ?? 1) || 0);

    // D&D5e normally exposes weight as a numeric value on physical items.
    // A few item types can expose an object, so accept .value as a fallback.
    let weight = item.system?.weight;
    if (weight && typeof weight === "object") weight = weight.value ?? weight.total ?? 0;
    weight = Number(weight ?? 0) || 0;

    total += weight * qty;
  }

  return Math.round(total * 100) / 100;
}

function renderGroupCapacity(sheet) {
  if (sheet.actor?.type !== "group") return;
  if ((sheet.inventorySource ?? sheet.actor) !== sheet.actor) return;

  const inventory = sheet.element?.querySelector?.(".inventory-element");
  if (!inventory) return;

  inventory.querySelector(".ims-group-capacity")?.remove();

  const current = groupWeight(sheet.actor);
  let max = Number(sheet.actor.getFlag(MODULE_ID, "groupCapacity") ?? sheet.actor.getFlag(LEGACY_MODULE_ID, "groupCapacity"));
  if (!Number.isFinite(max) || max <= 0) max = 150;

  const pct = Math.max(0, Math.min(100, (current / max) * 100));
  const over = current > max;

  const bar = document.createElement("div");
  bar.className = `ims-group-capacity${over ? " over" : ""}`;
  bar.innerHTML = `
    <div class="ims-capacity-track" title="Вес инвентаря группы">
      <div class="ims-capacity-fill" style="width:${pct}%"></div>
      <div class="ims-capacity-label">
        <i class="fa-solid fa-weight-hanging"></i>
        <span>${current}</span>
        <span>/</span>
        ${
          game.user.isGM
            ? `<input class="ims-capacity-max" type="number" min="1" step="1" value="${max}" title="Максимальный вес группы — изменяет только ГМ">`
            : `<span>${max}</span>`
        }
      </div>
    </div>`;

  const currency = inventory.querySelector(".currency");
  const search = inventory.querySelector(".filter-list, .inventory-header, search");
  if (currency?.parentElement) currency.insertAdjacentElement("afterend", bar);
  else if (search?.parentElement) search.insertAdjacentElement("afterend", bar);
  else inventory.prepend(bar);

  const input = bar.querySelector(".ims-capacity-max");
  input?.addEventListener("change", async event => {
    if (!game.user.isGM) return;
    const value = Math.max(1, Math.floor(Number(event.currentTarget.value) || 1));
    await sheet.actor.setFlag(MODULE_ID, "groupCapacity", value);
    if (sheet.actor.getFlag?.(LEGACY_MODULE_ID, "groupCapacity") !== undefined) {
      await sheet.actor.unsetFlag(LEGACY_MODULE_ID, "groupCapacity");
    }
    sheet.render({force: true});
  });
}

function patchGroupFeatures(GroupSheet) {
  if (!GroupSheet?.prototype || GroupSheet.prototype.__imsGroupFeatures) return;
  Object.defineProperty(GroupSheet.prototype, "__imsGroupFeatures", {value: true});

  // Add native-looking context-menu command to Group inventory items.
  if (typeof GroupSheet.prototype._getEntryContextOptions === "function") {
    const originalContext = GroupSheet.prototype._getEntryContextOptions;
    GroupSheet.prototype._getEntryContextOptions = function(...args) {
      const options = originalContext.apply(this, args) ?? [];
      options.push({
        label: "Разделить стопку",
        icon: "fa-solid fa-code-branch",
        group: "ownership",
        visible: target => {
          const item = getGroupInventoryItem(this, target);
          return Boolean(item && isStackable(item) && getQuantity(item) > 1);
        },
        onClick: (_, target) => splitGroupStack(this, target)
      });
      return options;
    };
  }

  // Draw the capacity bar whenever the Group sheet renders.
  if (typeof GroupSheet.prototype._onRender === "function") {
    const originalRender = GroupSheet.prototype._onRender;
    GroupSheet.prototype._onRender = async function(context, options) {
      await originalRender.call(this, context, options);
      renderGroupCapacity(this);
    };
  }

  console.log(`${MODULE_ID} | Group stack splitting and capacity bar enabled.`);
}



/* ============================================================
 * Player inventory restrictions
 * The old custom "Использовать" action and its consumption/chat
 * handler were removed completely.
 * ============================================================ */

function imsRestrictInventoryUI(root) {
  if (game.user.isGM || !root?.querySelectorAll) return;

  // Hide + / - quantity controls only inside inventory item rows.
  const rows = root.querySelectorAll("[data-item-id], [data-document-id]");
  for (const row of rows) {
    for (const el of row.querySelectorAll("button, a, [data-action]")) {
      const text = String(el.textContent ?? "").trim();
      const action = String(el.dataset?.action ?? "").toLowerCase();
      const title = String(el.getAttribute?.("title") ?? "").toLowerCase();

      const isQuantityControl =
        text === "+" ||
        text === "-" ||
        text === "−" ||
        action.includes("increase") ||
        action.includes("decrease") ||
        action.includes("increment") ||
        action.includes("decrement") ||
        action.includes("quantity") ||
        title.includes("увелич") ||
        title.includes("уменьш");

      if (isQuantityControl) {
        el.style.display = "none";
        el.classList.add("ims-player-hidden-control");
      }
    }
  }
}

function imsCleanContextMenu(menu) {
  if (game.user.isGM || !menu) return;

  const rows = Array.from(menu.querySelectorAll(".context-item, li"));

  for (const row of rows) {
    const text = String(row.textContent ?? "").trim().toLowerCase();

    // Remove player-only forbidden entries.
    if (
      text.includes("изменить") ||
      text.includes("редакт") ||
      text.includes("создать копию") ||
      text === "edit" ||
      text.includes("duplicate") ||
      text.includes("использовать") ||
      text === "use"
    ) {
      row.remove();
    }
  }
}


function imsReorderPlayerContextMenu(menu) {
  if (game.user.isGM || !menu) return;
  if (menu.dataset.imsOrdered === "1") return;

  const firstRow = menu.querySelector(".context-item, li");
  if (!firstRow) return;

  const list = firstRow.parentElement;
  if (!list) return;

  const rows = Array.from(list.children).filter(el =>
    el instanceof HTMLElement &&
    (el.matches(".context-item") || el.tagName === "LI")
  );
  if (!rows.length) return;

  const byText = needle => rows.find(row =>
    String(row.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
      .includes(needle)
  );

  const view = byText("просмотр предмета");
  const transfer = byText("передать предмет");

  // Wait until our custom transfer entry exists.
  if (!transfer) return;

  const give = byText("give to character");
  const split = byText("разделить стопку");
  const chat = byText("показать в чате");
  const favorite = byText("избранное");
  const expand = byText("развернуть");
  const del = byText("удалить");

  // Guard BEFORE moving nodes so MutationObserver cannot recurse.
  menu.dataset.imsOrdered = "1";

  const wanted = [
    view,
    transfer,
    split,
    give,
    chat,
    favorite,
    expand,
    del
  ].filter(Boolean);

  // "Показать в чате" + "Избранное" should visually be one section.
  // "Передать предмет" + "Разделить стопку" are one visual section.
  if (transfer && split) {
    transfer.classList.add("ims-transfer-split-group");
    split.classList.add("ims-transfer-split-group");
    split.classList.add("ims-no-separator-before");
  }

  // "Показать в чате" + "Избранное" are one visual section.
  if (chat && favorite) {
    chat.classList.add("ims-chat-favorite-group");
    favorite.classList.add("ims-chat-favorite-group");
    favorite.classList.add("ims-no-separator-before");
  }

  // Keep any unknown third-party rows too, but put them before Delete.
  const known = new Set(wanted);
  const unknown = rows.filter(row => !known.has(row));

  for (const row of wanted.slice(0, -1)) list.appendChild(row);
  for (const row of unknown) list.appendChild(row);
  if (del) list.appendChild(del);
}
function imsInstallPlayerRestrictions() {
  if (game.user.isGM) return;

  // Keep inventory quantity +/- hidden after re-renders.
  const process = node => {
    if (!(node instanceof HTMLElement)) return;
    imsRestrictInventoryUI(node);

    // If the added node is inside an already-open menu, reorder that menu too.
    const parentMenu = node.closest?.("#context-menu, .context-menu");
    if (parentMenu && parentMenu.dataset.imsOrdered !== "1") {
      imsCleanContextMenu(parentMenu);
    }

    if (node.matches?.("#context-menu, .context-menu") && node.dataset.imsOrdered !== "1") {
      imsCleanContextMenu(node);
    }

    for (const menu of node.querySelectorAll?.("#context-menu, .context-menu") ?? []) {
      if (menu.dataset.imsOrdered === "1") continue;
      imsCleanContextMenu(menu);
    }
  };

  // Initial pass.
  for (const app of document.querySelectorAll(".application, .window-app, .actor.sheet")) {
    imsRestrictInventoryUI(app);
  }

  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) process(node);
    }
  });

  observer.observe(document.body, {childList: true, subtree: true});

  // Hard-block any late-added "Использовать" context-menu action for players.
  document.addEventListener("click", event => {
    const contextRow = event.target?.closest?.("#context-menu .context-item, #context-menu li, .context-menu .context-item, .context-menu li");
    if (!contextRow) return;

    const text = String(contextRow.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    if (text.includes("использовать") || text === "use") {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      contextRow.remove();
    }
  }, true);

  // Defensive blocker in case hidden +/- controls are triggered by keyboard or another module.
  document.addEventListener("click", event => {
    const el = event.target?.closest?.("[data-item-id] button, [data-item-id] a, [data-item-id] [data-action], [data-document-id] button, [data-document-id] a, [data-document-id] [data-action]");
    if (!el) return;

    const text = String(el.textContent ?? "").trim();
    const action = String(el.dataset?.action ?? "").toLowerCase();

    const isQuantityControl =
      text === "+" ||
      text === "-" ||
      text === "−" ||
      action.includes("increase") ||
      action.includes("decrease") ||
      action.includes("increment") ||
      action.includes("decrement") ||
      action.includes("quantity");

    if (isQuantityControl) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
}



/* ============================================================
 * v32: D&D5e 6.0.x native item view / read-only patch
 * ============================================================ */

function imsPatchDndItemSheetReadOnly() {
  if (game.system.id !== "dnd5e") return;

  const ItemSheet5e =
    game.dnd5e?.applications?.item?.ItemSheet5e ??
    globalThis.dnd5e?.applications?.item?.ItemSheet5e;

  if (!ItemSheet5e?.prototype) {
    console.warn(`${MODULE_ID} | D&D5e ItemSheet5e not found.`);
    return;
  }

  if (ItemSheet5e.prototype.__imsReadOnlyPatched) return;
  Object.defineProperty(ItemSheet5e.prototype, "__imsReadOnlyPatched", {
    value: true,
    configurable: true
  });

  // D&D5e's own ItemSheet5e checks isEditable everywhere:
  // - edit/play mode
  // - identified toggle
  // - editable form context
  // - edit controls
  // Force it to false for players, while leaving GM behavior untouched.
  let proto = ItemSheet5e.prototype;
  let descriptor = null;
  let ownerProto = null;

  while (proto && !descriptor) {
    descriptor = Object.getOwnPropertyDescriptor(proto, "isEditable");
    if (descriptor) ownerProto = proto;
    proto = Object.getPrototypeOf(proto);
  }

  if (descriptor?.get) {
    const originalGet = descriptor.get;

    Object.defineProperty(ItemSheet5e.prototype, "isEditable", {
      configurable: true,
      get() {
        if (!game.user?.isGM) return false;
        return originalGet.call(this);
      }
    });
  }

  // Prevent players from switching into EDIT mode even if another module
  // manually exposes the mode button.
  const originalChangeMode = ItemSheet5e.prototype.changeMode;
  if (typeof originalChangeMode === "function") {
    ItemSheet5e.prototype.changeMode = async function(mode) {
      if (!game.user?.isGM) {
        const PLAY = this.constructor?.MODES?.PLAY ?? 1;
        if (this._mode !== PLAY) {
          this._mode = PLAY;
          this.render?.({force: true, mode: PLAY});
        }
        return;
      }
      return originalChangeMode.call(this, mode);
    };
  }

  console.log(`${MODULE_ID} | D&D5e ItemSheet5e read-only patch enabled.`);
}

function imsResolveInventoryItem(row) {
  if (!row) return null;

  const uuid = row.dataset.uuid;
  if (uuid) {
    try {
      const doc = foundry.utils.fromUuidSync(uuid);
      if (doc?.documentName === "Item") return doc;
    } catch (_) {}
  }

  const itemId = row.dataset.itemId ?? row.dataset.documentId;
  if (!itemId) return null;

  // Prefer the Actor sheet containing this row.
  for (const actor of game.actors) {
    const item = actor.items?.get(itemId);
    if (!item) continue;

    try {
      if (actor.sheet?.element?.contains?.(row)) return item;
    } catch (_) {}
  }

  for (const actor of game.actors) {
    const item = actor.items?.get(itemId);
    if (item) return item;
  }

  return null;
}

function imsInstallNativeLeftClickView() {
  if (game.user.isGM) return;

  // D&D5e 6 inventory template:
  // .item-name.item-action[data-action="<clickAction>"]
  // Capture before D&D5e handles its clickAction (which currently posts to chat).
  document.addEventListener("click", event => {
    if (event.button !== 0) return;

    const name = event.target?.closest?.(
      ".inventory-element .item[data-item-id] .item-name.item-action"
    );
    if (!name) return;

    const row = name.closest(".item[data-item-id], [data-item-id]");
    const item = imsResolveInventoryItem(row);
    if (!item) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const PLAY = item.sheet?.constructor?.MODES?.PLAY ?? 1;

    try {
      // Render explicitly in PLAY mode.
      item.sheet?.render?.({
        force: true,
        mode: PLAY
      });
    } catch (err) {
      console.error(`${MODULE_ID} | Could not open Item in PLAY mode`, err);
    }
  }, true);
}

function imsHidePlayerItemSheetControls(root) {
  if (game.user.isGM || !root?.matches?.(".dnd5e2.sheet.item, .dnd5e.sheet.item")) return;

  // Belt-and-suspenders UI cleanup. The native isEditable patch above is the
  // actual permission gate; these simply ensure controls are not visible.
  const selectors = [
    '[data-action="changeMode"]',
    '.toggle-identified',
    '[data-property="system.identified"]',
    '[data-action="editDocument"]',
    '[data-action="editDescription"]',
    '[data-action="showConfiguration"]'
  ];

  for (const selector of selectors) {
    root.querySelectorAll(selector).forEach(el => el.remove());
  }
}

function imsInstallItemSheetUiGuard() {
  if (game.user.isGM) return;

  const process = node => {
    if (!(node instanceof HTMLElement)) return;

    if (node.matches?.(".dnd5e2.sheet.item, .dnd5e.sheet.item")) {
      imsHidePlayerItemSheetControls(node);
    }

    for (const app of node.querySelectorAll?.(".dnd5e2.sheet.item, .dnd5e.sheet.item") ?? []) {
      imsHidePlayerItemSheetControls(app);
    }
  };

  document.querySelectorAll(".dnd5e2.sheet.item, .dnd5e.sheet.item")
    .forEach(imsHidePlayerItemSheetControls);

  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) process(node);
    }
  });

  observer.observe(document.body, {childList: true, subtree: true});
}



/* ============================================================
 * v33: lock direct inventory quantity editing for players
 * ============================================================ */

function imsInstallPlayerQuantityLock() {
  if (game.user.isGM) return;

  const isQuantityInput = el => {
    if (!(el instanceof HTMLInputElement)) return false;

    const row = el.closest?.(".item[data-item-id], [data-item-id]");
    if (!row) return false;

    const name = String(el.name ?? "").toLowerCase();
    const action = String(el.dataset?.action ?? "").toLowerCase();
    const property = String(el.dataset?.property ?? "").toLowerCase();
    const tooltip = String(el.getAttribute("data-tooltip") ?? "").toLowerCase();
    const aria = String(el.getAttribute("aria-label") ?? "").toLowerCase();

    return (
      name.includes("quantity") ||
      action.includes("quantity") ||
      property.includes("quantity") ||
      tooltip.includes("quantity") ||
      tooltip.includes("колич") ||
      aria.includes("quantity") ||
      aria.includes("колич") ||
      el.closest?.(".item-quantity, .quantity")
    );
  };

  const lock = root => {
    if (!root?.querySelectorAll) return;
    const inputs = root.matches?.("input") ? [root] : root.querySelectorAll("input");

    for (const input of inputs) {
      if (!isQuantityInput(input)) continue;
      input.readOnly = true;
      input.setAttribute("readonly", "");
      input.classList.add("ims-quantity-locked");
      input.setAttribute("title", "Количество изменяет только ГМ");
    }
  };

  // Existing UI.
  lock(document);

  // New/re-rendered inventory rows.
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLElement) lock(node);
      }
    }
  });
  observer.observe(document.body, {childList: true, subtree: true});

  // Hard-block manual changes even if D&D5e removes readonly during a rerender.
  for (const type of ["beforeinput", "input", "change", "paste", "drop", "wheel"]) {
    document.addEventListener(type, event => {
      if (!isQuantityInput(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      event.target.blur?.();
    }, true);
  }

  // Block focus/click editing, but don't interfere with row LMB view.
  document.addEventListener("pointerdown", event => {
    if (!isQuantityInput(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    event.target.blur?.();
  }, true);

  console.log(`${MODULE_ID} | Player inventory quantity editing locked.`);
}



async function imsMigrateLegacyGroupCapacity() {
  if (!game.user?.isGM) return;

  for (const actor of game.actors ?? []) {
    if (actor.type !== "group") continue;

    const current = actor.getFlag?.(MODULE_ID, "groupCapacity");
    const legacy = actor.getFlag?.(LEGACY_MODULE_ID, "groupCapacity");

    if (current === undefined && legacy !== undefined) {
      await actor.setFlag(MODULE_ID, "groupCapacity", legacy);
    }

    if (legacy !== undefined) {
      await actor.unsetFlag(LEGACY_MODULE_ID, "groupCapacity");
    }
  }
}

Hooks.once("ready", async () => {
  if (game.system.id !== "dnd5e") return;

  await imsMigrateLegacyGroupCapacity();

  imsPatchDndItemSheetReadOnly();
  imsInstallNativeLeftClickView();
  imsInstallItemSheetUiGuard();
  imsInstallPlayerQuantityLock();

  imsInstallContextTransfer();
  imsInstallPlayerRestrictions();

  game.socket.on(`module.${MODULE_ID}`, async payload => {
    if (payload?.type === "ims-transfer-request") {
      try {
        await imsGMHandleTransfer(payload);
      } catch (err) {
        console.error(`${MODULE_ID} | GM transfer request failed`, err);
      }
    }
  });

  const actorApps = game.dnd5e?.applications?.actor ?? globalThis.dnd5e?.applications?.actor ?? {};
  patchGroupFeatures(actorApps.GroupActorSheet);
  const names = [
    "CharacterActorSheet",
    "GroupActorSheet",
    "NPCActorSheet",
    "VehicleActorSheet",
    "EncounterActorSheet"
  ];

  let patched = 0;
  for (const name of names) {
    if (patchSheetClass(actorApps[name], name)) patched++;
  }

  if (!patched) {
    console.warn(`${MODULE_ID} | Could not find D&D5e actor sheet drop handlers.`);
    ui.notifications.warn("LipatoS - Перемещение и стопки предметов: не удалось подключиться к листам D&D5e.");
  } else {
    console.log(`${MODULE_ID} | Ready. Patched ${patched} actor sheet classes.`);
  }
});