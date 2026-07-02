// History-based navigation: views push state so the browser back button works
history.replaceState({ view: 'plans' }, '', location.href);
window.addEventListener('popstate', (e) => {
  const state = e.state || { view: 'plans' };
  if (state.view === 'planDetail' && currentPlan) {
    showView('planDetail');
    renderDateGrid();
  } else {
    showView('plans');
  }
});

// State
let currentView = 'plans';
let currentPlanId = null;
let currentPlan = null;
let currentDayMeals = {};  // SK -> dayMeal record
let currentDate = null;
let currentMealTime = null;
let currentSlotDishes = []; // dishes being edited
let currentSlotEatingOut = false;
let allDishes = [];
let allStores = [];
let allIngredientSuggestions = [];
let plansCache = []; // [{ name, quantity, unit, defaultStore }]
let _confirmCallback = null;

const MEAL_TIMES = ['BREAKFAST', 'LUNCH', 'DINNER'];
const userRole = getUserRole() || 'USER';

// =====================
// Dish helpers (mock persistence)
// =====================
function mockPersistDishes() {
  if (window.APP_CONFIG?.USE_MOCK) localStorage.setItem('mock-dishes', JSON.stringify(allDishes));
}

async function loadDishes() {
  if (window.APP_CONFIG?.USE_MOCK) {
    const stored = localStorage.getItem('mock-dishes');
    if (stored !== null) return JSON.parse(stored);
    const data = await apiGet('/dishes', 'mock-dishes.json').catch(() => []);
    localStorage.setItem('mock-dishes', JSON.stringify(data || []));
    return data || [];
  }
  try {
    return await apiGet('/dishes', null);
  } catch (err) {
    console.error('Failed to load dishes:', err);
    showToast('Could not load recipes — ' + err.message);
    return [];
  }
}

// =====================
// Init
// =====================
async function init() {
  if (!getAuthToken()) {
    window.location.href = 'login.html';
    return;
  }

  const env = window.APP_CONFIG?.ENVIRONMENT || 'LOCAL';
  const badge = document.getElementById('envBadge');
  badge.textContent = env;
  if (env === 'STAGING') badge.classList.add('staging');
  if (env === 'PRODUCTION') badge.classList.add('production');

  document.getElementById('logoutBtn').addEventListener('click', () => {
    clearAuthStorage();
    window.location.href = 'login.html';
  });

  if (userRole === 'ADMIN') {
    document.getElementById('adminBtn').style.display = '';
  }

  // Load supporting data and plans in parallel
  const [dishes, stores] = await Promise.all([
    loadDishes(),
    apiGet('/stores', 'mock-stores.json').catch(() => []),
  ]);
  allDishes = dishes || [];
  allStores = stores || [];
  buildIngredientSuggestions();

  await loadPlans();
}

// =====================
// View management
// =====================
function showView(view) {
  currentView = view;
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  const viewMap = { plans: 'viewPlans', planDetail: 'viewPlanDetail', slotEditor: 'viewSlotEditor' };
  document.getElementById(viewMap[view]).classList.add('active');
}

// =====================
// Toast
// =====================
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// =====================
// Confirm dialog
// =====================
function showConfirm(msg, cb) {
  document.getElementById('confirmMsg').textContent = msg;
  _confirmCallback = cb;
  document.getElementById('confirmOverlay').classList.add('open');
}
function closeConfirm() {
  document.getElementById('confirmOverlay').classList.remove('open');
  _confirmCallback = null;
}
document.getElementById('confirmOkBtn').addEventListener('click', () => {
  if (_confirmCallback) _confirmCallback();
  closeConfirm();
});

// =====================
// Plans list
// =====================
async function loadPlans() {
  const data = await apiGet('/mealplans', 'mock-mealplans.json');
  plansCache = Array.isArray(data) ? data : [];
  renderPlansGrid(plansCache);
}

function formatDateRange(start, end) {
  const fmt = d => new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  return `${fmt(start)} – ${fmt(end)}`;
}

function renderPlansGrid(plans) {
  const grid = document.getElementById('plansGrid');
  if (!plans.length) {
    grid.innerHTML = '<div class="empty-state">No meal plans yet. Create your first one!</div>';
    return;
  }
  grid.innerHTML = plans.map(p => `
    <div class="plan-card" onclick="openPlan('${p.mealPlanId}')">
      <h3>${escHtml(p.name)}</h3>
      <p class="plan-dates">${formatDateRange(p.startDate, p.endDate)}</p>
    </div>
  `).join('');
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
    // Inject into all currently-rendered store selects without a full re-render
    document.querySelectorAll('.store-select').forEach(sel => {
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
// Create plan modal
// =====================
function showCreatePlanModal() {
  document.getElementById('planModalTitle').textContent = 'New Meal Plan';
  document.getElementById('planName').value = '';
  // Default: start = next Monday, end = following Sunday
  const today = new Date();
  const dayOfWeek = today.getDay();
  const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
  const monday = new Date(today);
  monday.setDate(today.getDate() + daysUntilMonday);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  document.getElementById('planStartDate').value = dateToISO(monday);
  document.getElementById('planEndDate').value = dateToISO(sunday);
  // Show copy option only if there are existing plans
  document.getElementById('copyMealsCheck').checked = false;
  document.getElementById('copyMealsSelectRow').style.display = 'none';
  document.getElementById('copyMealsRow').style.display = plansCache.length > 0 ? '' : 'none';
  document.getElementById('planModal').classList.add('open');
}

function toggleCopyMealsSelect() {
  const checked = document.getElementById('copyMealsCheck').checked;
  const selectRow = document.getElementById('copyMealsSelectRow');
  selectRow.style.display = checked ? '' : 'none';
  if (checked) {
    const select = document.getElementById('copyMealsSelect');
    select.innerHTML = plansCache
      .map(p => `<option value="${escHtml(p.mealPlanId)}">${escHtml(p.name)} (${p.startDate} – ${p.endDate})</option>`)
      .join('');
  }
}
function closePlanModal() {
  document.getElementById('planModal').classList.remove('open');
}
async function submitPlanModal() {
  const name = document.getElementById('planName').value.trim();
  const startDate = document.getElementById('planStartDate').value;
  const endDate = document.getElementById('planEndDate').value;
  if (!name || !startDate || !endDate) { showToast('All fields are required'); return; }
  if (startDate > endDate) { showToast('Start date must be before end date'); return; }
  const copyEnabled = document.getElementById('copyMealsCheck').checked;
  const copySourceId = copyEnabled ? document.getElementById('copyMealsSelect').value : null;
  try {
    const plan = await apiPost('/mealplans', { name, startDate, endDate });
    if (plan) {
      closePlanModal();
      // Use server response if it has mealPlanId; otherwise construct locally (mock mode)
      const newPlan = plan.mealPlanId
        ? plan
        : { mealPlanId: plan.id || crypto.randomUUID(), name, startDate, endDate, createdDate: new Date().toISOString() };
      plansCache.unshift(newPlan);
      renderPlansGrid(plansCache);
      if (copySourceId) {
        // Copy completes before openPlan so meals are in DynamoDB when the grid loads
        await copyMealsToNewPlan(copySourceId, newPlan.mealPlanId, startDate, endDate);
        openPlan(newPlan.mealPlanId);
      } else {
        showToast('Meal plan created');
      }
    }
  } catch (err) {
    showToast(err.message);
  }
}

async function copyMealsToNewPlan(sourceId, targetId, targetStart, targetEnd) {
  try {
    const data = await apiGet(`/mealplans/${sourceId}/daymeals`, 'mock-daymeals.json');
    const meals = (Array.isArray(data) ? data : []).filter(dm => !dm.mealPlanId || dm.mealPlanId === sourceId);

    // Build day-of-week → ISO date map for the new plan's date range
    const dowToDate = {};
    const cursor = new Date(targetStart + 'T00:00:00');
    const endDate = new Date(targetEnd + 'T00:00:00');
    while (cursor <= endDate) {
      dowToDate[cursor.getDay()] = dateToISO(cursor);
      cursor.setDate(cursor.getDate() + 1);
    }

    const copyTasks = [];
    for (const meal of meals) {
      if (!meal.date || !meal.mealTime || !(meal.dishes || []).length) continue;
      const dow = new Date(meal.date + 'T00:00:00').getDay();
      if (dowToDate[dow] === undefined) continue;
      const newDate = dowToDate[dow];
      mockPersistDayMeal(targetId, newDate, meal.mealTime, meal.dishes, meal.eatingOut || false);
      copyTasks.push({ newDate, mealTime: meal.mealTime, dishes: meal.dishes });
    }

    // Run sequentially so a single failure doesn't abort the rest
    let succeeded = 0;
    let failed = 0;
    for (const task of copyTasks) {
      try {
        await apiPut(`/mealplans/${targetId}/daymeals/${task.newDate}/${task.mealTime}`, { dishes: task.dishes });
        succeeded++;
      } catch (err) {
        console.error(`Failed to copy ${task.mealTime} on ${task.newDate}:`, err.message);
        failed++;
      }
    }

    if (failed > 0) {
      showToast(`${succeeded} meal${succeeded !== 1 ? 's' : ''} copied, ${failed} failed`);
    } else {
      showToast(`Meal plan created — ${succeeded} meal${succeeded !== 1 ? 's' : ''} copied`);
    }
  } catch (err) {
    console.error('Copy meals error:', err);
    showToast('Plan created but meals could not be copied: ' + err.message);
  }
}

// =====================
// Delete plan
// =====================
function deletePlan(planId, name) {
  showConfirm(`Delete meal plan "${name}"? This will also delete all day meals and the shopping list.`, async () => {
    try {
      await apiDelete(`/mealplans/${planId}`);
      plansCache = plansCache.filter(p => p.mealPlanId !== planId);
      renderPlansGrid(plansCache);
      showToast('Meal plan deleted');
    } catch (err) {
      showToast(err.message);
    }
  });
}

// =====================
// Plan detail (date grid)
// =====================
async function fetchDayMealsForPlan(planId) {
  if (!window.APP_CONFIG?.USE_MOCK) {
    const data = await apiGet(`/mealplans/${planId}/daymeals`);
    return Array.isArray(data) ? data : [];
  }
  const storageKey = `mock-daymeals-${planId}`;
  const stored = localStorage.getItem(storageKey);
  if (stored !== null) {
    // localStorage is the source of truth — reflects all saves and deletes (nulls are tombstones)
    return Object.values(JSON.parse(stored)).filter(dm => dm !== null);
  }
  // First open: seed from static file, filtered to this plan only
  const data = await apiGet(`/mealplans/${planId}/daymeals`, 'mock-daymeals.json');
  const meals = (Array.isArray(data) ? data : []).filter(dm => !dm.mealPlanId || dm.mealPlanId === planId);
  const toStore = {};
  for (const dm of meals) {
    const sk = dm.SK || `DAYMEAL#${dm.date}#${dm.mealTime}`;
    toStore[sk] = { date: dm.date, mealTime: dm.mealTime, dishes: dm.dishes || [], eatingOut: dm.eatingOut || false };
  }
  localStorage.setItem(storageKey, JSON.stringify(toStore));
  return meals;
}

async function openPlan(planId) {
  currentPlanId = planId;
  currentDayMeals = {};
  try {
    const [plan, dayMeals] = await Promise.all([
      apiGet(`/mealplans/${planId}`, 'mock-mealplans.json'),
      fetchDayMealsForPlan(planId),
    ]);

    // For mock mode, plan comes as an array — find by id, then fall back to plansCache for newly created plans
    currentPlan = Array.isArray(plan)
      ? plan.find(p => p.mealPlanId === planId) || plansCache.find(p => p.mealPlanId === planId)
      : plan;
    if (!currentPlan) { showToast('Plan not found'); showView('plans'); return; }

    for (const dm of dayMeals) {
      currentDayMeals[dm.SK || `DAYMEAL#${dm.date}#${dm.mealTime}`] = dm;
    }

    document.getElementById('planDetailTitle').textContent = "Plan for " +currentPlan.name;
    document.getElementById('viewShopBtn').onclick = () => {
      localStorage.setItem(`plan-info-${planId}`, JSON.stringify({
        name: currentPlan.name,
        startDate: currentPlan.startDate,
        endDate: currentPlan.endDate,
      }));
      window.location.href = `shopping.html?planId=${planId}`;
    };
    document.getElementById('deletePlanBtn').onclick = () => deletePlanFromDetail();

    renderDateGrid();
    showView('planDetail');
    history.pushState({ view: 'planDetail', planId }, '', location.href);
  } catch (err) {
    showToast(err.message);
  }
}

function renderDateGrid() {
  const grid = document.getElementById('dateGrid');
  const dates = getDatesInRange(currentPlan.startDate, currentPlan.endDate);

  let html = '';
  // Header row
  html += '<div class="grid-header">Date</div>';
  MEAL_TIMES.forEach(mt => { html += `<div class="grid-header">${mt.charAt(0) + mt.slice(1).toLowerCase()}</div>`; });

  // Date rows
  dates.forEach(date => {
    const dateObj = new Date(date + 'T00:00:00');
    const weekday = dateObj.toLocaleDateString('en-AU', { weekday: 'short' });
    const label = `${weekday} ${dateObj.getDate()}/${dateObj.getMonth() + 1}`;
    html += `<div class="grid-date-label">${label}</div>`;
    MEAL_TIMES.forEach(mt => {
      const sk = `DAYMEAL#${date}#${mt}`;
      const dm = currentDayMeals[sk];
      const dishes = dm?.dishes || [];
      const dishHtml = dm?.eatingOut
        ? `<span class="slot-eating-out-tag">Eating out</span>`
        : dishes.length
          ? dishes.map(d => `<span class="slot-dish-tag">${escHtml(d.dishName)}</span>`).join('')
          : `<span class="slot-empty">Empty</span>`;
      html += `<div class="grid-slot" onclick="openSlot('${date}', '${mt}')">
        <div class="slot-dishes">${dishHtml}</div>
      </div>`;
    });
  });

  grid.innerHTML = html;
}

function deletePlanFromDetail() {
  showConfirm(`Delete meal plan "${currentPlan.name}"? This will also delete all day meals and the shopping list.`, async () => {
    try {
      await apiDelete(`/mealplans/${currentPlanId}`);
      await loadPlans();
      currentPlan = null;
      history.replaceState({ view: 'plans' }, '', location.href);
      showView('plans');
      showToast('Meal plan deleted');
    } catch (err) {
      showToast(err.message);
    }
  });
}

// =====================
// Slot editor
// =====================
function openSlot(date, mealTime) {
  currentDate = date;
  currentMealTime = mealTime;

  const dateLabel = new Date(date + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
  document.getElementById('slotTitle').textContent = dateLabel;
  const badge = document.getElementById('slotMealTimeBadge');
  badge.textContent = mealTime;
  badge.className = `meal-time-badge ${mealTime}`;
  document.getElementById('backToPlanBtn').onclick = () => history.back();
  document.getElementById('clearSlotBtn').onclick = () => clearSlot();

  // Load existing dishes for this slot or start empty
  const sk = `DAYMEAL#${date}#${mealTime}`;

  // Always pull the latest from localStorage in mock mode — handles bfcache and cross-page changes
  // (e.g. shopping list deletion updating needToBuy while the planner was cached in memory)
  if (window.APP_CONFIG?.USE_MOCK) {
    const stored = JSON.parse(localStorage.getItem(`mock-daymeals-${currentPlanId}`) || '{}');
    if (sk in stored) currentDayMeals[sk] = stored[sk] ?? undefined;
  }

  const existing = currentDayMeals[sk];
  currentSlotEatingOut = existing?.eatingOut === true;
  currentSlotDishes = existing ? JSON.parse(JSON.stringify(existing.dishes || [])) : [];

  const eatingOutCheck = document.getElementById('eatingOutCheck');
  eatingOutCheck.checked = currentSlotEatingOut;
  document.getElementById('dishBlocks').style.display = currentSlotEatingOut ? 'none' : '';
  document.getElementById('addDishBtn').style.display = currentSlotEatingOut ? 'none' : '';

  renderDishBlocks();
  showView('slotEditor');
  history.pushState({ view: 'slotEditor' }, '', location.href);
}

function toggleEatingOut() {
  currentSlotEatingOut = document.getElementById('eatingOutCheck').checked;
  document.getElementById('dishBlocks').style.display = currentSlotEatingOut ? 'none' : '';
  document.getElementById('addDishBtn').style.display = currentSlotEatingOut ? 'none' : '';
}

function renderDishBlocks() {
  const container = document.getElementById('dishBlocks');
  container.innerHTML = '';
  if (currentSlotDishes.length === 0) {
    addDishBlock(null);
  } else {
    currentSlotDishes.forEach((_, i) => renderDishBlock(i));
  }
}

function renderDishBlock(index) {
  const container = document.getElementById('dishBlocks');
  const dish = currentSlotDishes[index];
  const block = document.createElement('div');
  block.className = 'dish-block';
  block.dataset.index = index;

  const storeOptions = allStores.map(s => `<option value="${escHtml(s.name)}">${escHtml(s.name)}</option>`).join('');

  block.innerHTML = `
    <div class="dish-block-header">
      <div class="dish-search-wrap">
        <input type="text" class="dish-search-input" placeholder="Search by recipe name…" value="${escHtml(dish?.dishName || '')}" autocomplete="off" />
        <div class="dish-dropdown dish-name-dropdown"></div>
      </div>
      <div class="dish-search-wrap">
        <input type="text" class="dish-search-input dish-ing-search-input" placeholder="Search by ingredient…" autocomplete="off" />
        <div class="dish-dropdown dish-ing-dropdown"></div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="removeDishBlock(${index})">Remove</button>
    </div>
    <table class="ingredients-table">
      <colgroup>
        <col class="col-buy" />
        <col class="col-ing" />
        <col class="col-qty" />
        <col class="col-unit" />
        <col class="col-store" />
        <col class="col-del" />
      </colgroup>
      <thead>
        <tr>
          <th>Buy?</th>
          <th>Ingredient</th>
          <th>Qty</th>
          <th>Unit</th>
          <th>Store</th>
          <th></th>
        </tr>
      </thead>
      <tbody id="ingSBody_${index}">
      </tbody>
    </table>
    <button class="add-ing-btn" onclick="addIngredientRow(${index})">+ Add ingredient</button>
  `;

  container.appendChild(block);

  // Wire up recipe name search
  const searchInput = block.querySelector('.dish-search-input');
  const dropdown = block.querySelector('.dish-name-dropdown');
  searchInput.addEventListener('input', () => onDishSearch(searchInput, dropdown, index));
  searchInput.addEventListener('focus', () => onDishSearch(searchInput, dropdown, index));
  searchInput.addEventListener('blur', () => {
    setTimeout(() => dropdown.classList.remove('open'), 150);
    if (currentSlotDishes[index]) currentSlotDishes[index].dishName = searchInput.value.trim();
  });

  // Wire up ingredient search
  const ingInput = block.querySelector('.dish-ing-search-input');
  const ingDropdown = block.querySelector('.dish-ing-dropdown');
  ingInput.addEventListener('input', () => onIngredientSearch(ingInput, ingDropdown, index, searchInput));
  ingInput.addEventListener('focus', () => onIngredientSearch(ingInput, ingDropdown, index, searchInput));
  ingInput.addEventListener('blur', () => setTimeout(() => ingDropdown.classList.remove('open'), 150));

  // Render existing ingredients
  renderIngredientRows(index);
}

function addDishBlock(dish) {
  const newDish = dish
    ? { dishId: dish.dishId, dishName: dish.name, ingredients: dish.ingredients.map(ing => ({ ...ing, needToBuy: false })) }
    : { dishId: crypto.randomUUID(), dishName: '', ingredients: [] };
  currentSlotDishes.push(newDish);
  const index = currentSlotDishes.length - 1;
  renderDishBlock(index);
}

function removeDishBlock(index) {
  currentSlotDishes.splice(index, 1);
  renderDishBlocks();
}

// =====================
// Dish search
// =====================
function onDishSearch(input, dropdown, index) {
  const query = input.value.trim().toLowerCase();
  const matches = query.length === 0
    ? allDishes.slice(0, 8)
    : allDishes.filter(d => d.name.toLowerCase().includes(query)).slice(0, 8);

  let html = matches.map(d => `<div class="dish-option" data-dish-id="${d.dishId}">${escHtml(d.name)}</div>`).join('');
  if (query && !allDishes.some(d => d.name.toLowerCase() === query)) {
    html += `<div class="dish-option create-new" data-create="${escHtml(input.value.trim())}">+ Create "${escHtml(input.value.trim())}"</div>`;
  }

  dropdown.innerHTML = html;
  dropdown.classList.toggle('open', html.length > 0);

  dropdown.querySelectorAll('.dish-option').forEach(opt => {
    opt.addEventListener('mousedown', () => {
      if (opt.dataset.dishId) {
        const dish = allDishes.find(d => d.dishId === opt.dataset.dishId);
        if (dish) selectDish(index, dish);
      } else if (opt.dataset.create) {
        createAndSelectDish(index, opt.dataset.create);
      }
      dropdown.classList.remove('open');
    });
  });
}

function onIngredientSearch(input, dropdown, index, nameInput) {
  const query = input.value.trim().toLowerCase();
  if (!query) { dropdown.classList.remove('open'); return; }

  const seen = new Set();
  const matches = [];
  allDishes.forEach(d => {
    const ing = (d.ingredients || []).find(i => (i.name || '').toLowerCase().includes(query));
    if (ing && !seen.has(d.dishId)) {
      seen.add(d.dishId);
      matches.push({ dish: d, ingName: ing.name });
    }
  });

  if (!matches.length) {
    dropdown.innerHTML = '<div class="dish-option" style="color:#94a3b8;cursor:default;font-style:italic">No recipes contain that ingredient</div>';
    dropdown.classList.add('open');
    return;
  }

  dropdown.innerHTML = matches.slice(0, 8).map(({ dish: d, ingName }) =>
    `<div class="dish-option" data-dish-id="${d.dishId}">${escHtml(d.name)}<span class="ing-suggest-sub">· contains ${escHtml(ingName)}</span></div>`
  ).join('');
  dropdown.classList.add('open');

  dropdown.querySelectorAll('.dish-option[data-dish-id]').forEach(opt => {
    opt.addEventListener('mousedown', () => {
      const dish = allDishes.find(d => d.dishId === opt.dataset.dishId);
      if (dish) {
        selectDish(index, dish);
        nameInput.value = dish.name;
        input.value = '';
      }
      dropdown.classList.remove('open');
    });
  });
}

function selectDish(index, dish) {
  currentSlotDishes[index] = {
    dishId: dish.dishId,
    dishName: dish.name,
    ingredients: (dish.ingredients || []).map(ing => ({ ...ing, needToBuy: false })),
  };
  const block = document.querySelector(`.dish-block[data-index="${index}"]`);
  if (block) {
    block.querySelector('.dish-search-input').value = dish.name;
    renderIngredientRows(index);
  }
}

async function createAndSelectDish(index, name) {
  try {
    const newDish = await apiPost('/dishes', { name, ingredients: [] });
    const dishId = newDish?.dishId || newDish?.id || crypto.randomUUID();
    allDishes.push({ dishId, name, ingredients: [] });
    allDishes.sort((a, b) => a.name.localeCompare(b.name));
    mockPersistDishes();
    buildIngredientSuggestions();
    currentSlotDishes[index].dishName = name;
    currentSlotDishes[index].dishId = dishId;
    const block = document.querySelector(`.dish-block[data-index="${index}"]`);
    if (block) block.querySelector('.dish-search-input').value = name;
  } catch (err) {
    showToast(err.message);
  }
}

// =====================
// Ingredient suggestions (built from all known dishes)
// =====================
function buildIngredientSuggestions() {
  const seen = new Map();
  const sources = [
    ...allDishes.flatMap(d => d.ingredients || []),
    ...currentSlotDishes.flatMap(d => d.ingredients || []),
  ];
  const completeness = ing => (ing.quantity ? 1 : 0) + (ing.unit ? 1 : 0) + (ing.defaultStore ? 1 : 0);
  for (const ing of sources) {
    const key = (ing.name || '').toLowerCase().trim();
    if (!key) continue;
    const candidate = { name: ing.name, quantity: ing.quantity, unit: ing.unit, defaultStore: ing.defaultStore };
    const existing = seen.get(key);
    // Keep whichever copy has more filled-in fields, regardless of which source it came from
    if (!existing || completeness(candidate) > completeness(existing)) {
      seen.set(key, candidate);
    }
  }
  allIngredientSuggestions = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function getIngredientMatches(query) {
  const q = query.toLowerCase().trim();
  if (!q) return allIngredientSuggestions.slice(0, 8);
  const starts = [];
  const contains = [];
  for (const s of allIngredientSuggestions) {
    const name = s.name.toLowerCase();
    if (name.startsWith(q)) starts.push(s);
    else if (name.includes(q)) contains.push(s);
  }
  return [...starts, ...contains].slice(0, 8);
}

function wireIngredientAutocomplete(nameInput, dropdown, dishIndex, ingIndex) {
  function showSuggestions() {
    const matches = getIngredientMatches(nameInput.value);
    if (!matches.length) { dropdown.classList.remove('open'); return; }

    dropdown.innerHTML = matches.map(s => {
      const qtyUnit = s.quantity
        ? (/^\d/.test(s.unit || '') ? `${s.quantity} × ${s.unit}` : `${s.quantity}${s.unit || ''}`)
        : s.unit;
      const sub = [qtyUnit, s.defaultStore].filter(Boolean).join(' · ');
      return `<div class="ing-suggest-option" data-name="${escHtml(s.name)}">
        ${escHtml(s.name)}${sub ? `<span class="ing-suggest-sub">${escHtml(sub)}</span>` : ''}
      </div>`;
    }).join('');

    dropdown.querySelectorAll('.ing-suggest-option').forEach(opt => {
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const selected = allIngredientSuggestions.find(s => s.name === opt.dataset.name);
        if (!selected) return;
        nameInput.value = selected.name;
        currentSlotDishes[dishIndex].ingredients[ingIndex].name = selected.name;
        // Auto-fill quantity, unit, store if they are currently empty
        const ing = currentSlotDishes[dishIndex].ingredients[ingIndex];
        const tr = nameInput.closest('tr');
        if (!ing.quantity && selected.quantity) {
          ing.quantity = selected.quantity;
          const qtyInput = tr.querySelector('.ing-qty');
          if (qtyInput) qtyInput.value = selected.quantity;
        }
        if (!ing.unit && selected.unit) {
          ing.unit = selected.unit;
          const unitInput = tr.querySelector('.ing-unit');
          if (unitInput) unitInput.value = selected.unit;
        }
        if (!ing.defaultStore && selected.defaultStore) {
          ing.defaultStore = selected.defaultStore;
          const storeSelect = tr.querySelector('.store-select');
          if (storeSelect) storeSelect.value = selected.defaultStore;
        }
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
// Ingredient rows
// =====================
function renderIngredientRows(dishIndex) {
  const tbody = document.getElementById(`ingSBody_${dishIndex}`);
  if (!tbody) return;
  tbody.innerHTML = '';
  const dish = currentSlotDishes[dishIndex];
  (dish?.ingredients || []).forEach((ing, ingIndex) => {
    appendIngredientRow(tbody, dishIndex, ingIndex, ing);
  });
}

function appendIngredientRow(tbody, dishIndex, ingIndex, ing) {
  const storeOptions = ['', ...allStores.map(s => s.name)]
    .map(s => `<option value="${escHtml(s)}" ${ing.defaultStore === s ? 'selected' : ''}>${escHtml(s || '— none —')}</option>`)
    .join('');

  const tr = document.createElement('tr');
  tr.dataset.ingIndex = ingIndex;
  tr.innerHTML = `
    <td><input type="checkbox" class="needy-check" ${ing.needToBuy ? 'checked' : ''} /></td>
    <td><div class="ing-name-wrap">
      <input type="text" class="ing-input" value="${escHtml(ing.name || '')}" placeholder="Name" autocomplete="off" />
      <div class="ing-suggest-dropdown"></div>
    </div></td>
    <td><input type="number" class="ing-input ing-qty" value="${ing.quantity || ''}" min="0" placeholder="0" /></td>
    <td><input type="text" class="ing-input ing-unit" value="${escHtml(ing.unit || '')}" placeholder="g/kg…" /></td>
    <td><select class="store-select">${storeOptions}</select></td>
    <td><button class="ing-del-btn" title="Remove">×</button></td>
  `;

  const [needyCheck, nameInput, qtyInput, unitInput, storeSelect] = [
    tr.querySelector('.needy-check'),
    tr.querySelectorAll('.ing-input')[0],
    tr.querySelectorAll('.ing-input')[1],
    tr.querySelectorAll('.ing-input')[2],
    tr.querySelector('.store-select'),
  ];

  // Wire ingredient name autocomplete
  const suggestDropdown = tr.querySelector('.ing-suggest-dropdown');
  wireIngredientAutocomplete(nameInput, suggestDropdown, dishIndex, ingIndex);

  needyCheck.addEventListener('change', () => { currentSlotDishes[dishIndex].ingredients[ingIndex].needToBuy = needyCheck.checked; });
  nameInput.addEventListener('input', () => { currentSlotDishes[dishIndex].ingredients[ingIndex].name = nameInput.value; });
  nameInput.addEventListener('blur', () => { if (nameInput.value.trim()) buildIngredientSuggestions(); });
  qtyInput.addEventListener('input', () => { currentSlotDishes[dishIndex].ingredients[ingIndex].quantity = Number(qtyInput.value) || 0; });
  unitInput.addEventListener('input', () => { currentSlotDishes[dishIndex].ingredients[ingIndex].unit = unitInput.value; });
  storeSelect.addEventListener('change', () => { currentSlotDishes[dishIndex].ingredients[ingIndex].defaultStore = storeSelect.value; });
  tr.querySelector('.ing-del-btn').addEventListener('click', () => {
    currentSlotDishes[dishIndex].ingredients.splice(ingIndex, 1);
    renderIngredientRows(dishIndex);
  });

  tbody.appendChild(tr);
}

function addIngredientRow(dishIndex) {
  const ing = { id: crypto.randomUUID(), name: '', quantity: 0, unit: '', defaultStore: '', needToBuy: false };
  currentSlotDishes[dishIndex].ingredients.push(ing);
  const tbody = document.getElementById(`ingSBody_${dishIndex}`);
  if (tbody) {
    const newIndex = currentSlotDishes[dishIndex].ingredients.length - 1;
    appendIngredientRow(tbody, dishIndex, newIndex, ing);
  }
}

// =====================
// Mock persistence helpers (localStorage so shopping page can read after navigation)
// =====================
function mockPersistDayMeal(planId, date, mealTime, dishes, eatingOut = false) {
  if (!window.APP_CONFIG?.USE_MOCK) return;
  const key = `mock-daymeals-${planId}`;
  const stored = JSON.parse(localStorage.getItem(key) || '{}');
  stored[`DAYMEAL#${date}#${mealTime}`] = { date, mealTime, dishes, eatingOut };
  localStorage.setItem(key, JSON.stringify(stored));
}
function mockRemoveDayMeal(planId, date, mealTime) {
  if (!window.APP_CONFIG?.USE_MOCK) return;
  const key = `mock-daymeals-${planId}`;
  const stored = JSON.parse(localStorage.getItem(key) || '{}');
  stored[`DAYMEAL#${date}#${mealTime}`] = null; // null = tombstone: explicitly deleted, do not re-seed
  localStorage.setItem(key, JSON.stringify(stored));
}

// =====================
// Save / Clear slot
// =====================
async function saveSlot() {
  const dishes = currentSlotEatingOut ? [] : currentSlotDishes
    .filter(d => d.dishName.trim())
    .map(d => ({
      dishId: d.dishId,
      dishName: d.dishName.trim(),
      ingredients: d.ingredients.map(ing => ({
        id: ing.id,
        name: ing.name.trim(),
        quantity: Number(ing.quantity) || 0,
        unit: ing.unit.trim(),
        defaultStore: ing.defaultStore || '',
        needToBuy: Boolean(ing.needToBuy),
      })).filter(ing => ing.name),
    }));

  const payload = { dishes, eatingOut: currentSlotEatingOut };

  try {
    const result = await apiPut(`/mealplans/${currentPlanId}/daymeals/${currentDate}/${currentMealTime}`, payload);
    if (result) {
      const sk = `DAYMEAL#${currentDate}#${currentMealTime}`;
      currentDayMeals[sk] = result._mock
        ? { SK: sk, date: currentDate, mealTime: currentMealTime, dishes, eatingOut: currentSlotEatingOut }
        : { ...result, eatingOut: currentSlotEatingOut };
      mockPersistDayMeal(currentPlanId, currentDate, currentMealTime, dishes, currentSlotEatingOut);
      showToast('Slot saved');
      history.back();
    }
  } catch (err) {
    showToast(err.message);
  }
}

function clearSlot() {
  showConfirm('Clear all dishes from this slot?', async () => {
    try {
      await apiDelete(`/mealplans/${currentPlanId}/daymeals/${currentDate}/${currentMealTime}`);
      const sk = `DAYMEAL#${currentDate}#${currentMealTime}`;
      delete currentDayMeals[sk];
      mockRemoveDayMeal(currentPlanId, currentDate, currentMealTime);
      currentSlotDishes = [];
      showToast('Slot cleared');
      history.back();
    } catch (err) {
      // Slot may not exist yet — just clear locally
      const sk = `DAYMEAL#${currentDate}#${currentMealTime}`;
      delete currentDayMeals[sk];
      currentSlotDishes = [];
      history.back();
    }
  });
}

// =====================
// Utility
// =====================
function getDatesInRange(start, end) {
  const dates = [];
  const cur = new Date(start + 'T00:00:00');
  const endDate = new Date(end + 'T00:00:00');
  while (cur <= endDate) {
    dates.push(dateToISO(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function dateToISO(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// =====================
// Start
// =====================
init();
