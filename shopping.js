// State
let planId = null;
let planInfo = null;
let allStores = [];
let shoppingItems = []; // flat list, grouped on render
let currentPlanMeta = null; // { mealPlanId, name, startDate, endDate }
let itemHistory = []; // suggestion list built from previous shopping lists: [{name, unit, store, totalQuantity}]
let previousPlan = null; // the plan found for the "Previous List" modal
let previousPlanItems = []; // items belonging to previousPlan, for the modal

// =====================
// Init
// =====================
async function init() {
  if (!getAuthToken()) {
    window.location.href = 'login.html';
    return;
  }

  const params = new URLSearchParams(window.location.search);
  planId = params.get('planId');

  const env = window.APP_CONFIG?.ENVIRONMENT || 'LOCAL';
  const badge = document.getElementById('envBadge');
  badge.textContent = env;
  if (env === 'STAGING') badge.classList.add('staging');
  if (env === 'PRODUCTION') badge.classList.add('production');

  if (getUserRole() === 'ADMIN') {
    document.getElementById('adminBtn').style.display = '';
  }

  if (!planId) {
    showPlanPicker();
    return;
  }

  const stores = await apiGet('/stores', 'mock-stores.json').catch(() => []);
  allStores = stores || [];
  populateStoreDropdown();

  await seedMockDayMealsIfNeeded();
  await loadShoppingList();
  wireAddNameAutocomplete();
  buildItemHistory(); // fire-and-forget — autocomplete just stays empty until this resolves
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
      const known = await getKnownPlans();
      const planInfo = known.find(p => p.mealPlanId === planId) || null;
      currentPlanMeta = planInfo ? { mealPlanId: planId, ...planInfo } : null;
      if (planInfo) {
        document.getElementById('planTitle').textContent = planInfo.name;
        document.getElementById('planInfo').textContent = planInfo.startDate
          ? `${fmt(planInfo.startDate)} – ${fmt(planInfo.endDate)}`
          : '';
      }
      shoppingItems = [...getMockManualItems(planId), ...aggregateMockDayMeals()];
      renderList();
      return;
    }

    const data = await apiGet(`/shoppinglists/${planId}`);
    if (!data) return;

    const plan = data.mealPlan || data;
    const items = Array.isArray(data) ? data : (data.items || []);

    if (plan && plan.name) {
      document.getElementById('planTitle').textContent = plan.name;
      currentPlanMeta = plan;
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

function formatMealSource(source) {
  const day = new Date(source.date + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short' });
  const meal = source.mealTime ? source.mealTime.charAt(0) + source.mealTime.slice(1).toLowerCase() : '';
  return `${day}-${meal}`;
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

  const sourcesHtml = (item.mealSources && item.mealSources.length)
    ? `<span class="meal-sources">${[...item.mealSources].sort((a, b) => a.date.localeCompare(b.date)).map(s => escHtml(formatMealSource(s))).join(', ')}</span>`
    : '';

  row.innerHTML = `
    <input type="checkbox" class="item-check" ${item.purchased ? 'checked' : ''} />
    <span class="item-info">
      <span class="item-label">${escHtml(item.name)}</span>${sourcesHtml}
    </span>
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
    if (window.APP_CONFIG?.USE_MOCK && item.source === 'manual') {
      updateMockManualItem(item.itemId, { purchased: newValue });
    }
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
    if (window.APP_CONFIG?.USE_MOCK && item.source === 'manual') {
      updateMockManualItem(item.itemId, { store: newStore });
    }

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
function excludedMealKeysStorageKey(targetPlanId) {
  return `excluded-meal-ings-${targetPlanId}`;
}
function getExcludedMealKeysFor(targetPlanId) {
  return new Set(JSON.parse(localStorage.getItem(excludedMealKeysStorageKey(targetPlanId)) || '[]'));
}
function getExcludedMealKeys() {
  return getExcludedMealKeysFor(planId);
}
function excludeMealKey(key) {
  const keys = getExcludedMealKeys();
  keys.add(key);
  localStorage.setItem(excludedMealKeysStorageKey(planId), JSON.stringify([...keys]));
}
function ingredientKey(item) {
  return `${(item.name || '').toLowerCase().trim()}||${(item.unit || '').toLowerCase().trim()}`;
}

// =====================
// Manually-added items (mock mode — persisted per plan so they survive
// reloads and can be surfaced as suggestions / copied from a previous list)
// =====================
function mockManualItemsKey(targetPlanId) {
  return `mock-manualitems-${targetPlanId}`;
}
function getMockManualItems(targetPlanId) {
  return JSON.parse(localStorage.getItem(mockManualItemsKey(targetPlanId)) || '[]');
}
function saveMockManualItems(targetPlanId, items) {
  localStorage.setItem(mockManualItemsKey(targetPlanId), JSON.stringify(items));
}
function updateMockManualItem(itemId, patch) {
  const stored = getMockManualItems(planId);
  const idx = stored.findIndex(i => i.itemId === itemId);
  if (idx === -1) return;
  Object.assign(stored[idx], patch);
  saveMockManualItems(planId, stored);
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
    } else if (window.APP_CONFIG?.USE_MOCK && item.source === 'manual') {
      saveMockManualItems(planId, getMockManualItems(planId).filter(i => i.itemId !== item.itemId));
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
    const newItem = await createShoppingItem({ name, totalQuantity: Number(qty) || 1, unit, store });
    if (newItem) {
      addItemToUI(newItem);

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

// Creates a manual item via the API (or mock echo) and, in mock mode,
// persists it so it survives reloads and feeds future suggestions.
async function createShoppingItem({ name, totalQuantity, unit, store }) {
  const item = await apiPost(`/shoppinglists/${planId}/items`, { name, totalQuantity, unit, store });
  if (!item) return null;

  const newItem = item._mock
    ? { itemId: item.id || crypto.randomUUID(), name, totalQuantity, unit, store: store || 'Other', purchased: false, source: 'manual' }
    : item;

  if (window.APP_CONFIG?.USE_MOCK) {
    const stored = getMockManualItems(planId);
    stored.push(newItem);
    saveMockManualItems(planId, stored);
  }

  return newItem;
}

// Appends a newly-created item to the in-memory list and the DOM (no full re-render)
function addItemToUI(newItem) {
  shoppingItems.push(newItem);

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

  const emptyState = document.querySelector('#shoppingList .empty-state');
  if (emptyState) emptyState.remove();
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
  return aggregateMockDayMealsFor(planId);
}

function aggregateMockDayMealsFor(targetPlanId) {
  const stored = JSON.parse(localStorage.getItem(`mock-daymeals-${targetPlanId}`) || '{}');
  const excluded = getExcludedMealKeysFor(targetPlanId);
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
            mealSources: [],
          });
        }
        const entry = grouped.get(key);
        entry.totalQuantity += Number(ing.quantity) || 0;
        entry.mealSources.push({ date: dm.date, mealTime: dm.mealTime });
      }
    }
  }
  return [...grouped.values()];
}

// =====================
// Known plans (used to find "the previous list" and to build item-name
// suggestions from earlier shopping lists)
// =====================
async function getKnownPlans() {
  if (window.APP_CONFIG?.USE_MOCK) {
    const staticPlans = await apiGet('/mealplans', 'mock-mealplans.json').catch(() => []);
    const map = new Map((Array.isArray(staticPlans) ? staticPlans : []).map(p => [p.mealPlanId, p]));
    // Plans the user has actually opened the shopping list for are recorded here (see planner.js),
    // even though mock mode doesn't otherwise persist created plans across reloads.
    for (const key of Object.keys(localStorage)) {
      const m = key.match(/^plan-info-(.+)$/);
      if (!m) continue;
      try {
        const info = JSON.parse(localStorage.getItem(key));
        if (info) map.set(m[1], { mealPlanId: m[1], name: info.name, startDate: info.startDate, endDate: info.endDate });
      } catch (_) { /* ignore malformed entry */ }
    }
    return [...map.values()];
  }
  const plans = await apiGet('/mealplans').catch(() => []);
  return Array.isArray(plans) ? plans : [];
}

function findPreviousPlan(plans, current) {
  if (!current || !current.startDate) return null;
  const earlier = plans.filter(p => p.mealPlanId !== current.mealPlanId && p.startDate && p.startDate < current.startDate);
  if (!earlier.length) return null;
  earlier.sort((a, b) => b.startDate.localeCompare(a.startDate));
  return earlier[0];
}

async function getPlanItems(targetPlanId) {
  if (window.APP_CONFIG?.USE_MOCK) {
    return [...getMockManualItems(targetPlanId), ...aggregateMockDayMealsFor(targetPlanId)];
  }
  const data = await apiGet(`/shoppinglists/${targetPlanId}`).catch(() => null);
  if (!data) return [];
  return Array.isArray(data) ? data : (data.items || []);
}

// =====================
// Item-name suggestions, built from items on previous shopping lists
// =====================
async function buildItemHistory() {
  try {
    const known = await getKnownPlans();
    const previousPlans = known
      .filter(p => p.mealPlanId !== planId && p.startDate)
      .sort((a, b) => b.startDate.localeCompare(a.startDate))
      .slice(0, 5); // cap how many previous lists we pull in (esp. relevant in live mode — one API call per plan)

    const seen = new Map();
    const completeness = it => (it.totalQuantity ? 1 : 0) + (it.unit ? 1 : 0) + (it.store ? 1 : 0);
    for (const p of previousPlans) {
      const items = await getPlanItems(p.mealPlanId);
      for (const it of items) {
        const key = (it.name || '').toLowerCase().trim();
        if (!key) continue;
        const candidate = { name: it.name, totalQuantity: it.totalQuantity, unit: it.unit, store: it.store };
        const existing = seen.get(key);
        if (!existing || completeness(candidate) > completeness(existing)) seen.set(key, candidate);
      }
    }
    itemHistory = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  } catch (_) { /* non-fatal — autocomplete just stays empty */ }
}

function getItemMatches(query) {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const starts = [];
  const contains = [];
  for (const s of itemHistory) {
    const name = s.name.toLowerCase();
    if (name.startsWith(q)) starts.push(s);
    else if (name.includes(q)) contains.push(s);
  }
  return [...starts, ...contains].slice(0, 8);
}

function wireAddNameAutocomplete() {
  const nameInput = document.getElementById('addName');
  const dropdown = document.getElementById('addNameSuggest');
  if (!nameInput || !dropdown) return;

  function showSuggestions() {
    const matches = getItemMatches(nameInput.value);
    if (!matches.length) { dropdown.classList.remove('open'); return; }

    dropdown.innerHTML = matches.map(s => {
      const qtyUnit = s.totalQuantity
        ? (/^\d/.test(s.unit || '') ? `${s.totalQuantity} × ${s.unit}` : `${s.totalQuantity}${s.unit || ''}`)
        : s.unit;
      const sub = [qtyUnit, s.store].filter(Boolean).join(' · ');
      return `<div class="ing-suggest-option" data-name="${escHtml(s.name)}">
        ${escHtml(s.name)}${sub ? `<span class="ing-suggest-sub">${escHtml(sub)}</span>` : ''}
      </div>`;
    }).join('');

    dropdown.querySelectorAll('.ing-suggest-option').forEach(opt => {
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const selected = itemHistory.find(s => s.name === opt.dataset.name);
        if (!selected) return;
        nameInput.value = selected.name;

        const qtyInput = document.getElementById('addQty');
        const unitInput = document.getElementById('addUnit');
        const storeSelect = document.getElementById('addStore');
        if (qtyInput && !qtyInput.value && selected.totalQuantity) qtyInput.value = selected.totalQuantity;
        if (unitInput && !unitInput.value && selected.unit) unitInput.value = selected.unit;
        if (storeSelect && !storeSelect.value && selected.store) storeSelect.value = selected.store;

        dropdown.classList.remove('open');
      });
    });

    dropdown.classList.add('open');
  }

  nameInput.addEventListener('input', showSuggestions);
  nameInput.addEventListener('focus', showSuggestions);
  nameInput.addEventListener('blur', () => setTimeout(() => dropdown.classList.remove('open'), 150));
}

// =====================
// Previous list modal — copy items from the previous week's list
// =====================
function openPreviousListModal() {
  document.getElementById('previousListModal').classList.add('open');
  document.getElementById('previousListSubtitle').textContent = 'Loading…';
  document.getElementById('previousListItems').innerHTML = '';
  document.getElementById('copyPreviousBtn').disabled = true;
  loadPreviousListModalData();
}

function closePreviousListModal() {
  document.getElementById('previousListModal').classList.remove('open');
}

async function loadPreviousListModalData() {
  const subtitleEl = document.getElementById('previousListSubtitle');
  const listEl = document.getElementById('previousListItems');
  try {
    const known = await getKnownPlans();
    previousPlan = findPreviousPlan(known, currentPlanMeta);

    if (!previousPlan) {
      subtitleEl.textContent = 'No previous shopping list found.';
      return;
    }

    const fmt = d => new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
    subtitleEl.textContent = `${previousPlan.name} (${fmt(previousPlan.startDate)} – ${fmt(previousPlan.endDate)})`;

    previousPlanItems = await getPlanItems(previousPlan.mealPlanId);
    if (!previousPlanItems.length) {
      listEl.innerHTML = '<div class="stores-list-empty">That list has no items.</div>';
      return;
    }

    listEl.innerHTML = previousPlanItems.map((item, idx) => {
      const qtyUnit = item.totalQuantity
        ? (/^\d/.test(item.unit || '') ? `${item.totalQuantity} × ${item.unit}` : `${item.totalQuantity}${item.unit || ''}`)
        : item.unit;
      const sub = [qtyUnit, item.store].filter(Boolean).join(' · ');
      return `
        <label class="prev-list-item">
          <input type="checkbox" class="prev-list-check" data-idx="${idx}" />
          <span class="prev-list-name">${escHtml(item.name)}</span>
          ${sub ? `<span class="prev-list-sub">${escHtml(sub)}</span>` : ''}
        </label>
      `;
    }).join('');
    document.getElementById('copyPreviousBtn').disabled = false;
  } catch (err) {
    subtitleEl.textContent = 'Could not load previous list.';
    showToast(err.message);
  }
}

async function copySelectedPreviousItems() {
  const checked = [...document.querySelectorAll('.prev-list-check:checked')].map(cb => Number(cb.dataset.idx));
  if (!checked.length) { showToast('Select at least one item'); return; }

  let count = 0;
  for (const idx of checked) {
    const src = previousPlanItems[idx];
    if (!src) continue;
    try {
      const newItem = await createShoppingItem({
        name: src.name,
        totalQuantity: src.totalQuantity || 1,
        unit: src.unit || '',
        store: src.store || '',
      });
      if (newItem) { addItemToUI(newItem); count++; }
    } catch (err) {
      showToast(err.message);
    }
  }

  closePreviousListModal();
  if (count) showToast(`Copied ${count} item${count === 1 ? '' : 's'}`);
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
// Plan picker (no planId in URL)
// =====================
async function showPlanPicker() {
  document.getElementById('mainContent').style.display = 'none';
  document.getElementById('planPicker').style.display = '';
  const list = document.getElementById('planPickerList');
  try {
    const plans = await apiGet('/mealplans', 'mock-mealplans.json');
    const arr = Array.isArray(plans) ? plans : [];
    if (!arr.length) {
      list.innerHTML = '<div style="color:#94a3b8;font-size:0.9rem">No meal plans found. <a href="planner.html" style="color:#3b82f6">Go to Planner</a> to create one.</div>';
      return;
    }
    const fmt = d => new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
    list.innerHTML = arr.map(p => `
      <div class="plan-picker-card" onclick="window.location.href='shopping.html?planId=${escHtml(p.mealPlanId)}'">
        <h3>${escHtml(p.name)}</h3>
        <p class="plan-picker-dates">${fmt(p.startDate)} – ${fmt(p.endDate)}</p>
      </div>
    `).join('');
  } catch (err) {
    list.innerHTML = `<div style="color:#ef4444;font-size:0.9rem">Could not load plans: ${escHtml(err.message)}</div>`;
  }
}

// =====================
// Start
// =====================
init();
