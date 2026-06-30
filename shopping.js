// State
let planId = null;
let planInfo = null;
let allStores = [];
let shoppingItems = []; // flat list, grouped on render

// =====================
// Init
// =====================
async function init() {
  if (!localStorage.getItem('authToken')) {
    window.location.href = 'login.html';
    return;
  }

  const params = new URLSearchParams(window.location.search);
  planId = params.get('planId');
  if (!planId) {
    window.location.href = 'planner.html';
    return;
  }

  const env = window.APP_CONFIG?.ENVIRONMENT || 'LOCAL';
  const badge = document.getElementById('envBadge');
  badge.textContent = env;
  if (env === 'STAGING') badge.classList.add('staging');
  if (env === 'PRODUCTION') badge.classList.add('production');

  const stores = await apiGet('/stores', 'mock-stores.json').catch(() => []);
  allStores = stores || [];
  populateStoreDropdown();

  await seedMockDayMealsIfNeeded();
  await loadShoppingList();
}

async function seedMockDayMealsIfNeeded() {
  if (!window.APP_CONFIG?.USE_MOCK) return;
  const key = `mock-daymeals-${planId}`;
  try {
    const dayMeals = await apiGet(`/mealplans/${planId}/daymeals`, 'mock-daymeals.json');
    if (!Array.isArray(dayMeals)) return;
    const stored = JSON.parse(localStorage.getItem(key) || '{}');
    let changed = false;
    for (const dm of dayMeals) {
      if (!dm.date || !dm.mealTime) continue;
      if (dm.mealPlanId && dm.mealPlanId !== planId) continue; // skip meals from other plans
      const sk = `DAYMEAL#${dm.date}#${dm.mealTime}`;
      if (!(sk in stored)) { // only seed if slot has never been seen (null = tombstone = user deleted)
        stored[sk] = { date: dm.date, mealTime: dm.mealTime, dishes: dm.dishes || [] };
        changed = true;
      }
    }
    if (changed) localStorage.setItem(key, JSON.stringify(stored));
  } catch (_) { /* non-fatal */ }
}

function populateStoreDropdown() {
  const sel = document.getElementById('addStore');
  allStores.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.name;
    opt.textContent = s.name;
    sel.appendChild(opt);
  });
}

// =====================
// Load shopping list
// =====================
async function loadShoppingList() {
  try {
    if (window.APP_CONFIG?.USE_MOCK) {
      const fmt = d => new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
      const planInfo = JSON.parse(localStorage.getItem(`plan-info-${planId}`) || 'null');
      if (planInfo) {
        document.getElementById('planTitle').textContent = planInfo.name;
        document.getElementById('planInfo').textContent = planInfo.startDate
          ? `${fmt(planInfo.startDate)} – ${fmt(planInfo.endDate)}`
          : '';
      }
      shoppingItems = aggregateMockDayMeals();
      renderList();
      return;
    }

    const data = await apiGet(`/shoppinglists/${planId}`);
    if (!data) return;

    const plan = data.mealPlan || data;
    const items = Array.isArray(data) ? data : (data.items || []);

    if (plan && plan.name) {
      document.getElementById('planTitle').textContent = plan.name;
      const fmt = d => new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
      document.getElementById('planInfo').textContent = plan.startDate
        ? `${fmt(plan.startDate)} – ${fmt(plan.endDate)}`
        : '';
    }

    shoppingItems = items;
    renderList();
  } catch (err) {
    showToast(err.message);
  }
}

// =====================
// Render list (grouped by store)
// =====================
function renderList() {
  const container = document.getElementById('shoppingList');
  if (!shoppingItems.length) {
    container.innerHTML = '<div class="empty-state">No items yet. Refresh from your meal plan or add items manually.</div>';
    return;
  }

  // Group by store (items with no store go to an "Other" group)
  const groups = new Map();
  shoppingItems.forEach(item => {
    const store = item.store || 'Other';
    if (!groups.has(store)) groups.set(store, []);
    groups.get(store).push(item);
  });

  // Sort groups: known stores first (in display order), then others
  const storeOrder = allStores.map(s => s.name);
  const sortedGroups = [...groups.entries()].sort(([a], [b]) => {
    const ia = storeOrder.indexOf(a);
    const ib = storeOrder.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  container.innerHTML = '';
  sortedGroups.forEach(([store, items]) => {
    const section = buildStoreSection(store, items);
    container.appendChild(section);
  });
}

function buildStoreSection(store, items) {
  const purchased = items.filter(i => i.purchased).length;
  const section = document.createElement('div');
  section.className = 'store-section';
  section.dataset.store = store;

  const header = document.createElement('div');
  header.className = 'store-header';
  header.innerHTML = `
    <h2>${escHtml(store)}</h2>
    <span class="count">${purchased}/${items.length} done</span>
    <span class="chevron">▾</span>
  `;
  header.addEventListener('click', () => section.classList.toggle('collapsed'));

  const itemList = document.createElement('div');
  itemList.className = 'store-items';
  itemList.id = `store-${slugify(store)}`;

  items.forEach(item => {
    itemList.appendChild(buildItemRow(item));
  });

  section.appendChild(header);
  section.appendChild(itemList);
  return section;
}

function buildItemRow(item) {
  const row = document.createElement('div');
  row.className = `shop-item${item.purchased ? ' purchased' : ''}`;
  row.dataset.itemId = item.itemId;

  const qtyDisplay = item.totalQuantity
    ? (/^\d/.test(item.unit || '') ? `${item.totalQuantity} × ${item.unit}` : `${item.totalQuantity}${item.unit || ''}`)
    : '';

  const storeOptions = ['', ...allStores.map(s => s.name)]
    .map(s => `<option value="${escHtml(s)}" ${(item.store || '') === s ? 'selected' : ''}>${escHtml(s || '— none —')}</option>`)
    .join('');

  row.innerHTML = `
    <input type="checkbox" class="item-check" ${item.purchased ? 'checked' : ''} />
    <span class="item-label">${escHtml(item.name)}</span>
    <span class="item-qty">${escHtml(qtyDisplay)}</span>
    <select class="item-store-select">${storeOptions}</select>
    <button class="item-del" title="Remove item">×</button>
  `;

  const checkbox = row.querySelector('.item-check');
  const storeSelect = row.querySelector('.item-store-select');
  const delBtn = row.querySelector('.item-del');

  // Optimistic purchased toggle — no scroll reset
  checkbox.addEventListener('change', () => togglePurchased(item, row, checkbox));
  storeSelect.addEventListener('change', () => changeStore(item, row, storeSelect.value));
  delBtn.addEventListener('click', () => deleteItem(item, row));

  return row;
}

// =====================
// Optimistic checkbox toggle (no redraw, no scroll jump)
// =====================
async function togglePurchased(item, rowEl, checkboxEl) {
  const newValue = checkboxEl.checked;
  rowEl.classList.toggle('purchased', newValue);
  checkboxEl.disabled = true;

  // Update count in section header
  updateSectionCount(item.store || 'Other');

  try {
    await apiPut(`/shoppinglists/${planId}/items/${item.itemId}`, { purchased: newValue });
    item.purchased = newValue;
  } catch (err) {
    // Revert on failure
    rowEl.classList.toggle('purchased', !newValue);
    checkboxEl.checked = !newValue;
    item.purchased = !newValue;
    updateSectionCount(item.store || 'Other');
    showToast('Failed to update — please try again');
  } finally {
    checkboxEl.disabled = false;
  }
}

function updateSectionCount(store) {
  const section = document.querySelector(`.store-section[data-store="${CSS.escape(store)}"]`);
  if (!section) return;
  const items = shoppingItems.filter(i => (i.store || 'Other') === store);
  const purchased = items.filter(i => i.purchased).length;
  const countEl = section.querySelector('.count');
  if (countEl) countEl.textContent = `${purchased}/${items.length} done`;
}

// =====================
// Change store (no redraw — moves item to new section)
// =====================
async function changeStore(item, rowEl, newStore) {
  const oldStore = item.store || 'Other';
  if (oldStore === newStore) return;

  try {
    await apiPut(`/shoppinglists/${planId}/items/${item.itemId}`, { store: newStore });
    item.store = newStore;

    // Move DOM element to new store section (no full redraw, no scroll jump)
    rowEl.remove();
    updateSectionCount(oldStore);

    let targetSection = document.querySelector(`.store-section[data-store="${CSS.escape(newStore || 'Other')}"]`);
    if (!targetSection) {
      // Create new section for this store
      const newStoreGroup = [item];
      targetSection = buildStoreSection(newStore || 'Other', newStoreGroup);
      document.getElementById('shoppingList').appendChild(targetSection);
    } else {
      const targetList = targetSection.querySelector('.store-items');
      targetList.appendChild(buildItemRow(item));
      updateSectionCount(newStore || 'Other');
    }

    // Clean up empty section
    const oldSection = document.querySelector(`.store-section[data-store="${CSS.escape(oldStore)}"]`);
    if (oldSection) {
      const remaining = oldSection.querySelectorAll('.shop-item');
      if (remaining.length === 0) oldSection.remove();
    }
  } catch (err) {
    showToast(err.message);
  }
}

// =====================
// Excluded meal ingredient keys (mock mode — survives refresh)
// =====================
function excludedMealKeysStorageKey() {
  return `excluded-meal-ings-${planId}`;
}
function getExcludedMealKeys() {
  return new Set(JSON.parse(localStorage.getItem(excludedMealKeysStorageKey()) || '[]'));
}
function excludeMealKey(key) {
  const keys = getExcludedMealKeys();
  keys.add(key);
  localStorage.setItem(excludedMealKeysStorageKey(), JSON.stringify([...keys]));
}
function ingredientKey(item) {
  return `${(item.name || '').toLowerCase().trim()}||${(item.unit || '').toLowerCase().trim()}`;
}

function setNeedToBuyInDayMeals(name, unit, value) {
  const storageKey = `mock-daymeals-${planId}`;
  const stored = JSON.parse(localStorage.getItem(storageKey) || '{}');
  const target = `${name.toLowerCase().trim()}||${(unit || '').toLowerCase().trim()}`;
  let changed = false;
  for (const dm of Object.values(stored)) {
    if (!dm) continue;
    for (const dish of (dm.dishes || [])) {
      for (const ing of (dish.ingredients || [])) {
        const key = `${(ing.name || '').toLowerCase().trim()}||${(ing.unit || '').toLowerCase().trim()}`;
        if (key === target && ing.needToBuy !== value) {
          ing.needToBuy = value;
          changed = true;
        }
      }
    }
  }
  if (changed) localStorage.setItem(storageKey, JSON.stringify(stored));
}

// =====================
// Delete item (remove from DOM, no full redraw)
// =====================
async function deleteItem(item, rowEl) {
  rowEl.style.opacity = '0.4';
  try {
    await apiDelete(`/shoppinglists/${planId}/items/${item.itemId}`);
    if (item.source === 'meal') {
      excludeMealKey(ingredientKey(item));
      if (window.APP_CONFIG?.USE_MOCK) setNeedToBuyInDayMeals(item.name, item.unit, false);
    }
    shoppingItems = shoppingItems.filter(i => i.itemId !== item.itemId);
    const store = item.store || 'Other';
    rowEl.remove();
    updateSectionCount(store);

    // Remove section if empty
    const section = document.querySelector(`.store-section[data-store="${CSS.escape(store)}"]`);
    if (section && section.querySelectorAll('.shop-item').length === 0) section.remove();

    if (!shoppingItems.length) {
      document.getElementById('shoppingList').innerHTML = '<div class="empty-state">No items yet. Refresh from your meal plan or add items manually.</div>';
    }
  } catch (err) {
    rowEl.style.opacity = '1';
    showToast(err.message);
  }
}

// =====================
// Add manual item (append, no full redraw)
// =====================
function toggleAddForm() {
  document.getElementById('addForm').classList.toggle('open');
}

async function addManualItem() {
  const name = document.getElementById('addName').value.trim();
  const qty = document.getElementById('addQty').value;
  const unit = document.getElementById('addUnit').value.trim();
  const store = document.getElementById('addStore').value;

  if (!name) { showToast('Item name is required'); return; }

  try {
    const item = await apiPost(`/shoppinglists/${planId}/items`, {
      name,
      totalQuantity: Number(qty) || 1,
      unit,
      store,
    });

    if (item) {
      const newItem = item._mock
        ? { itemId: item.id || crypto.randomUUID(), name, totalQuantity: Number(qty) || 1, unit, store: store || 'Other', purchased: false, source: 'manual' }
        : item;

      shoppingItems.push(newItem);

      // Append to existing store section or create new one (no full re-render)
      const storeKey = newItem.store || 'Other';
      let section = document.querySelector(`.store-section[data-store="${CSS.escape(storeKey)}"]`);
      if (!section) {
        section = buildStoreSection(storeKey, [newItem]);
        document.getElementById('shoppingList').appendChild(section);
      } else {
        const itemList = section.querySelector('.store-items');
        itemList.appendChild(buildItemRow(newItem));
        updateSectionCount(storeKey);
      }

      // Clear form
      document.getElementById('addName').value = '';
      document.getElementById('addQty').value = '';
      document.getElementById('addUnit').value = '';
      document.getElementById('addStore').value = '';
      toggleAddForm();
      showToast('Item added');
    }
  } catch (err) {
    showToast(err.message);
  }
}

// =====================
// Refresh from meal plan
// =====================
async function refreshFromPlan() {
  try {
    const data = await apiPost(`/shoppinglists/${planId}/refresh`, {});
    if (data) {
      if (data.items) {
        shoppingItems = data.items;
      } else {
        // Mock mode: replace meal-sourced items, keep manual items
        const manualItems = shoppingItems.filter(i => i.source === 'manual');
        shoppingItems = [...manualItems, ...aggregateMockDayMeals()];
      }
      renderList();
      showToast('Shopping list refreshed from meal plan');
    }
  } catch (err) {
    showToast(err.message);
  }
}

function aggregateMockDayMeals() {
  const stored = JSON.parse(localStorage.getItem(`mock-daymeals-${planId}`) || '{}');
  const excluded = getExcludedMealKeys();
  const grouped = new Map();
  for (const dm of Object.values(stored)) {
    if (!dm) continue; // null = tombstone (user deleted this slot)
    for (const dish of (dm.dishes || [])) {
      for (const ing of (dish.ingredients || [])) {
        if (!ing.needToBuy || !ing.name.trim()) continue;
        const key = `${ing.name.toLowerCase().trim()}||${(ing.unit || '').toLowerCase().trim()}`;
        if (excluded.has(key)) continue;
        if (!grouped.has(key)) {
          grouped.set(key, {
            itemId: crypto.randomUUID(),
            name: ing.name.trim(),
            totalQuantity: 0,
            unit: ing.unit || '',
            store: ing.defaultStore || '',
            purchased: false,
            source: 'meal',
          });
        }
        grouped.get(key).totalQuantity += Number(ing.quantity) || 0;
      }
    }
  }
  return [...grouped.values()];
}

// =====================
// Stores modal
// =====================
function openStoresModal() {
  renderStoresList();
  document.getElementById('newStoreName').value = '';
  document.getElementById('storesModal').classList.add('open');
}
function closeStoresModal() {
  document.getElementById('storesModal').classList.remove('open');
}
function renderStoresList() {
  const list = document.getElementById('storesList');
  list.innerHTML = allStores.length
    ? allStores.map(s => `<div class="stores-list-item">${escHtml(s.name)}</div>`).join('')
    : '<div class="stores-list-empty">No stores added yet</div>';
}
async function addStoreFromModal() {
  const input = document.getElementById('newStoreName');
  const name = input.value.trim();
  if (!name) return;
  if (allStores.some(s => s.name.toLowerCase() === name.toLowerCase())) {
    showToast('That store already exists');
    return;
  }
  try {
    const result = await apiPost('/stores', { name, displayOrder: allStores.length + 1 });
    const newStore = result.storeId
      ? result
      : { storeId: result.id || crypto.randomUUID(), name, displayOrder: allStores.length + 1 };
    allStores.push(newStore);
    // Inject into all rendered store selects and the add-item form select
    [document.getElementById('addStore'), ...document.querySelectorAll('.item-store-select')].forEach(sel => {
      if (!sel) return;
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    });
    input.value = '';
    renderStoresList();
    showToast(`"${name}" added`);
  } catch (err) {
    showToast(err.message);
  }
}

// =====================
// Utility
// =====================
function slugify(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// =====================
// Start
// =====================
init();
