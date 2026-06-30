// ─── State ───────────────────────────────────────────────────────────────────
let allDishes = [];
let allStores = [];
let allIngredientSuggestions = [];
let editingDishId = null;   // null = new dish
let editingRecipeDish = null; // dish being given a recipe
let recipeType = 'url';     // 'url' or 'file'
let confirmCallback = null;

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const token = localStorage.getItem('authToken');
  if (!token) { window.location.href = 'login.html'; return; }

  const env = window.APP_CONFIG?.ENV || 'LOCAL';
  const badge = document.getElementById('envBadge');
  badge.textContent = env;
  badge.className = `badge ${env.toLowerCase()}`;

  document.getElementById('logoutBtn').addEventListener('click', () => {
    localStorage.clear();
    window.location.href = 'login.html';
  });

  loadData();
});

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
  return apiGet('/dishes', null).catch(() => []);
}

async function loadData() {
  try {
    const [dishes, stores] = await Promise.all([
      loadDishes(),
      apiGet('/stores', 'mock-stores.json'),
    ]);
    allDishes = dishes || [];
    allStores = (stores || []).map(s => s.name || s);
    buildIngredientSuggestions();
    renderDishes();
  } catch (err) {
    showToast('Failed to load data: ' + err.message);
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────
function renderDishes() {
  const grid = document.getElementById('dishesGrid');
  if (!allDishes.length) {
    grid.innerHTML = '<div class="empty-state">No recipes yet. Add your first recipe to get started.</div>';
    return;
  }

  const query = (document.getElementById('recipeSearch')?.value || '').toLowerCase().trim();
  const sorted = [...allDishes]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter(d => !query || d.name.toLowerCase().includes(query));
  if (!sorted.length) {
    grid.innerHTML = `<div class="empty-state">No recipes match "${esc(query)}".</div>`;
    return;
  }
  grid.innerHTML = sorted.map(d => {
    const hasUrl = !!d.recipeUrl;
    const hasFile = !!d.recipeAttachment?.s3Key;
    const ingCount = (d.ingredients || []).length;

    const viewBtn = `<button class="btn btn-success btn-xs" onclick="viewRecipe('${d.dishId}')">View</button>`;
    const badges = [];
    if (hasUrl) badges.push(`<span class="recipe-badge url">🔗 URL</span>${viewBtn}`);
    else if (hasFile) badges.push(`<span class="recipe-badge file">📎 ${d.recipeAttachment.fileType === 'application/pdf' ? 'PDF' : 'Image'}</span>${viewBtn}`);
    else badges.push(`<span class="recipe-badge none">No recipe</span>`);

    return `
      <div class="dish-card">
        <div class="dish-name">${esc(d.name)}</div>
        <div class="dish-meta">${ingCount} ing</div>
        <div class="recipe-badges">${badges.join('')}</div>
        <div class="dish-card-actions">
          <button class="btn btn-primary btn-sm" onclick="openRecipeModal('${d.dishId}')">Recipe Link</button>
          <button class="btn btn-secondary btn-sm" onclick="openDishModal('${d.dishId}')">Ingredients</button>
          <button class="btn btn-danger btn-sm" onclick="confirmDeleteDish('${d.dishId}')">Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

// ─── View recipe ──────────────────────────────────────────────────────────────
async function viewRecipe(dishId) {
  const dish = allDishes.find(d => d.dishId === dishId);
  if (!dish) return;

  if (dish.recipeUrl) {
    window.open(dish.recipeUrl, '_blank', 'noopener');
    return;
  }

  if (dish.recipeAttachment?.s3Key) {
    try {
      const result = await apiGetRecipeDownloadUrl(dishId);
      if (result?._mock) {
        showToast('File viewing not available in local mode');
        return;
      }
      window.open(result.downloadUrl, '_blank', 'noopener');
    } catch (err) {
      showToast('Could not get download link: ' + err.message);
    }
  }
}

// ─── Recipe modal ─────────────────────────────────────────────────────────────
function openRecipeModal(dishId) {
  const dish = allDishes.find(d => d.dishId === dishId);
  if (!dish) return;
  editingRecipeDish = dish;

  document.getElementById('recipeModalTitle').textContent = `Recipe — ${dish.name}`;
  document.getElementById('recipeNameInput').value = dish.name;
  document.getElementById('recipeUrlInput').value = dish.recipeUrl || '';
  document.getElementById('recipeFileInput').value = '';
  document.getElementById('uploadProgress').style.display = 'none';
  document.getElementById('progressBar').style.width = '0';

  const hasUrl = !!dish.recipeUrl;
  const hasFile = !!dish.recipeAttachment?.s3Key;
  const hasRecipe = hasUrl || hasFile;

  document.getElementById('removeRecipeBtn').style.display = hasRecipe ? 'inline-flex' : 'none';

  if (hasFile) {
    const att = dish.recipeAttachment;
    const isImage = att.fileType?.startsWith('image/');
    document.getElementById('currentFileIcon').textContent = isImage ? '🖼️' : '📄';
    document.getElementById('currentFileName').textContent = att.fileName || att.s3Key.split('/').pop();
    document.getElementById('currentFileDate').textContent = att.uploadedDate
      ? new Date(att.uploadedDate).toLocaleDateString()
      : '';
    document.getElementById('currentFileInfo').style.display = 'flex';
    document.getElementById('fileInputLabel').textContent = 'Replace file';
    setRecipeType('file');
  } else {
    document.getElementById('currentFileInfo').style.display = 'none';
    document.getElementById('fileInputLabel').textContent = 'Upload file';
    setRecipeType(hasUrl ? 'url' : 'url');
  }

  document.getElementById('recipeModal').classList.add('open');
}

function closeRecipeModal() {
  document.getElementById('recipeModal').classList.remove('open');
  editingRecipeDish = null;
}

function setRecipeType(type) {
  recipeType = type;
  document.getElementById('btnTypeUrl').classList.toggle('active', type === 'url');
  document.getElementById('btnTypeFile').classList.toggle('active', type === 'file');
  document.getElementById('panelUrl').classList.toggle('active', type === 'url');
  document.getElementById('panelFile').classList.toggle('active', type === 'file');
}

async function saveRecipe() {
  if (!editingRecipeDish) return;
  const dishId = editingRecipeDish.dishId;
  const newName = document.getElementById('recipeNameInput').value.trim();
  if (!newName) { showToast('Recipe name is required'); return; }

  try {
    if (recipeType === 'url') {
      const url = document.getElementById('recipeUrlInput').value.trim();
      if (!url) {
        showToast('Please enter a URL');
        return;
      }
      await apiPut(`/dishes/${dishId}`, { name: newName, recipeUrl: url, recipeAttachment: null });
      const dish = allDishes.find(d => d.dishId === dishId);
      if (dish) { dish.name = newName; dish.recipeUrl = url; delete dish.recipeAttachment; }

    } else {
      let file = document.getElementById('recipeFileInput').files[0];
      if (!file && !editingRecipeDish.recipeAttachment?.s3Key) {
        showToast('Please select a file');
        return;
      }

      if (file) {
        showUploadProgress(0, 'Preparing…');

        if (file.type.startsWith('image/')) {
          showUploadProgress(10, 'Compressing image…');
          file = await compressImage(file);
        }

        showUploadProgress(20, 'Getting upload URL…');

        const urlResult = await apiGetRecipeUploadUrl(dishId, file.name, file.type);

        if (!urlResult._mock) {
          showUploadProgress(40, 'Uploading…');
          await apiUploadToS3(urlResult.uploadUrl, file);
          showUploadProgress(80, 'Saving…');
        }

        const attachment = {
          s3Key: urlResult.s3Key,
          fileName: file.name,
          fileType: file.type,
        };

        await apiPut(`/dishes/${dishId}`, { name: newName, recipeAttachment: attachment, recipeUrl: null });
        const dish = allDishes.find(d => d.dishId === dishId);
        if (dish) {
          dish.name = newName;
          dish.recipeAttachment = { ...attachment, uploadedDate: new Date().toISOString() };
          delete dish.recipeUrl;
        }

        showUploadProgress(100, 'Done');
      } else {
        // No new file — only the name changed
        await apiPut(`/dishes/${dishId}`, { name: newName });
        const dish = allDishes.find(d => d.dishId === dishId);
        if (dish) dish.name = newName;
      }
    }

    mockPersistDishes();
    closeRecipeModal();
    renderDishes();
    showToast('Recipe saved');
  } catch (err) {
    document.getElementById('uploadProgress').style.display = 'none';
    showToast('Error: ' + err.message);
  }
}

function showUploadProgress(pct, label) {
  document.getElementById('uploadProgress').style.display = 'block';
  document.getElementById('progressBar').style.width = `${pct}%`;
  document.getElementById('progressLabel').textContent = label;
}

async function removeRecipe() {
  if (!editingRecipeDish) return;
  const dishId = editingRecipeDish.dishId;
  try {
    await apiPut(`/dishes/${dishId}`, { recipeUrl: null, recipeAttachment: null });
    const dish = allDishes.find(d => d.dishId === dishId);
    if (dish) { delete dish.recipeUrl; delete dish.recipeAttachment; }
    closeRecipeModal();
    renderDishes();
    showToast('Recipe removed');
  } catch (err) {
    showToast('Error: ' + err.message);
  }
}

// ─── Dish modal ───────────────────────────────────────────────────────────────
function openDishModal(dishId) {
  editingDishId = dishId;
  const dish = dishId ? allDishes.find(d => d.dishId === dishId) : null;

  document.getElementById('dishModalTitle').textContent = dish ? `Edit — ${dish.name}` : 'New Recipe';
  document.getElementById('dishName').value = dish?.name || '';

  renderIngTable(dish?.ingredients || []);
  document.getElementById('dishModal').classList.add('open');
}

function closeDishModal() {
  document.getElementById('dishModal').classList.remove('open');
  editingDishId = null;
}

// ─── Ingredient autocomplete ──────────────────────────────────────────────────
function buildIngredientSuggestions() {
  const seen = new Map();
  const completeness = ing => (ing.quantity ? 1 : 0) + (ing.unit ? 1 : 0) + (ing.defaultStore ? 1 : 0);
  for (const d of allDishes) {
    for (const ing of (d.ingredients || [])) {
      const key = (ing.name || '').toLowerCase().trim();
      if (!key) continue;
      const candidate = { name: ing.name, quantity: ing.quantity, unit: ing.unit, defaultStore: ing.defaultStore };
      const existing = seen.get(key);
      if (!existing || completeness(candidate) > completeness(existing)) seen.set(key, candidate);
    }
  }
  allIngredientSuggestions = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function getIngredientMatches(query) {
  const q = query.toLowerCase().trim();
  if (!q) return allIngredientSuggestions.slice(0, 8);
  const starts = [], contains = [];
  for (const s of allIngredientSuggestions) {
    const n = s.name.toLowerCase();
    if (n.startsWith(q)) starts.push(s);
    else if (n.includes(q)) contains.push(s);
  }
  return [...starts, ...contains].slice(0, 8);
}

function wireIngredientAutocomplete(tr, nameInput, dropdown) {
  function showSuggestions() {
    const matches = getIngredientMatches(nameInput.value);
    if (!matches.length) { dropdown.classList.remove('open'); return; }
    dropdown.innerHTML = matches.map(s => {
      const qtyUnit = s.quantity
        ? (/^\d/.test(s.unit || '') ? `${s.quantity} × ${s.unit}` : `${s.quantity}${s.unit || ''}`)
        : s.unit;
      const sub = [qtyUnit, s.defaultStore].filter(Boolean).join(' · ');
      return `<div class="ing-suggest-option" data-name="${esc(s.name)}">${esc(s.name)}${sub ? `<span class="ing-suggest-sub">${esc(sub)}</span>` : ''}</div>`;
    }).join('');
    dropdown.querySelectorAll('.ing-suggest-option').forEach(opt => {
      opt.addEventListener('mousedown', e => {
        e.preventDefault();
        const selected = allIngredientSuggestions.find(s => s.name === opt.dataset.name);
        if (!selected) return;
        nameInput.value = selected.name;
        const qtyInput = tr.querySelector('.ing-qty');
        const unitInput = tr.querySelector('.ing-unit');
        const storeSelect = tr.querySelector('.ing-store');
        if (!qtyInput.value && selected.quantity) qtyInput.value = selected.quantity;
        if (!unitInput.value && selected.unit) unitInput.value = selected.unit;
        if (storeSelect && !storeSelect.value && selected.defaultStore) storeSelect.value = selected.defaultStore;
        dropdown.classList.remove('open');
      });
    });
    dropdown.classList.add('open');
  }
  nameInput.addEventListener('input', showSuggestions);
  nameInput.addEventListener('focus', showSuggestions);
  nameInput.addEventListener('blur', () => setTimeout(() => dropdown.classList.remove('open'), 150));
}

function renderIngTable(ingredients) {
  const tbody = document.getElementById('ingTableBody');
  tbody.innerHTML = '';
  ingredients.forEach((ing, i) => addIngredientRow(ing));
  if (!ingredients.length) addIngredientRow();
}

function addIngredientRow(ing) {
  const tbody = document.getElementById('ingTableBody');
  const tr = document.createElement('tr');
  const storeOptions = allStores.map(s => `<option ${ing?.defaultStore === s ? 'selected' : ''}>${s}</option>`).join('');
  tr.innerHTML = `
    <td><div class="ing-name-wrap">
      <input class="ing-input" placeholder="Name" value="${esc(ing?.name || '')}" autocomplete="off" />
      <div class="ing-suggest-dropdown"></div>
    </div></td>
    <td><input class="ing-input ing-qty" type="number" placeholder="0" value="${ing?.quantity ?? ''}" min="0" step="any" /></td>
    <td><input class="ing-input ing-unit" placeholder="g" value="${esc(ing?.unit || '')}" /></td>
    <td><select class="ing-store"><option value="">— Store —</option>${storeOptions}</select></td>
    <td><button class="ing-del" onclick="this.closest('tr').remove()">✕</button></td>
  `;
  tbody.appendChild(tr);
  const nameInput = tr.querySelector('.ing-input');
  const dropdown = tr.querySelector('.ing-suggest-dropdown');
  wireIngredientAutocomplete(tr, nameInput, dropdown);
}

async function saveDish() {
  const name = document.getElementById('dishName').value.trim();
  if (!name) { showToast('Dish name is required'); return; }

  const rows = document.querySelectorAll('#ingTableBody tr');
  const ingredients = Array.from(rows).map(tr => {
    const inputs = tr.querySelectorAll('input');
    const store = tr.querySelector('select').value;
    return {
      name: inputs[0].value.trim(),
      quantity: parseFloat(inputs[1].value) || 0,
      unit: inputs[2].value.trim(),
      defaultStore: store,
    };
  }).filter(i => i.name);

  try {
    if (editingDishId) {
      await apiPut(`/dishes/${editingDishId}`, { name, ingredients });
      const dish = allDishes.find(d => d.dishId === editingDishId);
      if (dish) { dish.name = name; dish.ingredients = ingredients; }
    } else {
      const created = await apiPost('/dishes', { name, ingredients });
      if (created) {
        allDishes.push({ dishId: created.dishId || created.id || crypto.randomUUID(), name, ingredients });
      }
    }
    mockPersistDishes();
    buildIngredientSuggestions();
    closeDishModal();
    renderDishes();
    showToast(editingDishId ? 'Dish updated' : 'Dish created');
  } catch (err) {
    showToast('Error: ' + err.message);
  }
}

// ─── Delete dish ──────────────────────────────────────────────────────────────
function confirmDeleteDish(dishId) {
  const dish = allDishes.find(d => d.dishId === dishId);
  showConfirm(`Delete "${dish?.name}"? This cannot be undone.`, async () => {
    try {
      await apiDelete(`/dishes/${dishId}`);
      allDishes = allDishes.filter(d => d.dishId !== dishId);
      mockPersistDishes();
      renderDishes();
      showToast('Dish deleted');
    } catch (err) {
      showToast('Error: ' + err.message);
    }
  });
}

// ─── Confirm dialog ───────────────────────────────────────────────────────────
function showConfirm(msg, onOk) {
  document.getElementById('confirmMsg').textContent = msg;
  confirmCallback = onOk;
  document.getElementById('confirmOkBtn').onclick = () => { closeConfirm(); onOk(); };
  document.getElementById('confirmOverlay').classList.add('open');
}

function closeConfirm() {
  document.getElementById('confirmOverlay').classList.remove('open');
  confirmCallback = null;
}

// ─── Toast ────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// ─── Find by Ingredient ───────────────────────────────────────────────────────
function openFindByIngredient() {
  document.getElementById('fbiSearch').value = '';
  renderFbiIngredients();
  renderFbiResults();
  document.getElementById('fbiModal').classList.add('open');
}

function closeFbiModal() {
  document.getElementById('fbiModal').classList.remove('open');
}

function getAllIngredientNames() {
  const names = new Set();
  allDishes.forEach(d => (d.ingredients || []).forEach(i => { if (i.name) names.add(i.name.trim()); }));
  return [...names].sort((a, b) => a.localeCompare(b));
}

function getSelectedIngredients() {
  return [...document.querySelectorAll('#fbiIngList input[type="checkbox"]:checked')]
    .map(cb => cb.value);
}

function renderFbiIngredients() {
  const list = document.getElementById('fbiIngList');
  const names = getAllIngredientNames();
  list.innerHTML = names.map(name => `
    <label class="fbi-ing-item">
      <input type="checkbox" value="${esc(name)}" onchange="renderFbiResults()" />
      ${esc(name)}
    </label>
  `).join('');
}

function filterFbiIngredients() {
  const q = document.getElementById('fbiSearch').value.toLowerCase();
  document.querySelectorAll('#fbiIngList .fbi-ing-item').forEach(el => {
    el.classList.toggle('hidden', q && !el.textContent.toLowerCase().includes(q));
  });
}

function renderFbiResults() {
  const selected = getSelectedIngredients();
  const resultsEl = document.getElementById('fbiResults');
  const headerEl  = document.getElementById('fbiResultsHeader');

  if (!selected.length) {
    headerEl.textContent = 'Matching recipes';
    resultsEl.innerHTML = '<div class="fbi-select-prompt">Select ingredients above to find recipes.</div>';
    return;
  }

  const mode = document.querySelector('input[name="fbiMode"]:checked').value; // 'any' | 'all'
  const selectedLower = selected.map(s => s.toLowerCase());

  const matches = allDishes.filter(d => {
    const dishIngNames = (d.ingredients || []).map(i => (i.name || '').toLowerCase().trim());
    return mode === 'all'
      ? selectedLower.every(s => dishIngNames.includes(s))
      : selectedLower.some(s => dishIngNames.includes(s));
  });

  headerEl.textContent = `${matches.length} recipe${matches.length !== 1 ? 's' : ''} found`;

  if (!matches.length) {
    resultsEl.innerHTML = '<div class="fbi-empty">No recipes match the selected ingredients.</div>';
    return;
  }

  resultsEl.innerHTML = matches.map(d => {
    const dishIngNames = (d.ingredients || []).map(i => (i.name || '').trim());
    const tags = dishIngNames.map(name => {
      const matched = selectedLower.includes(name.toLowerCase());
      return `<span class="fbi-ing-tag ${matched ? 'matched' : ''}">${esc(name)}</span>`;
    }).join('');
    const hasRecipe = d.recipeUrl || d.recipeAttachment?.s3Key;
    const viewBtn = hasRecipe
      ? `<button class="btn btn-success btn-sm" onclick="viewRecipe('${d.dishId}')">View Recipe</button>`
      : '';
    return `
      <div class="fbi-result">
        <div class="fbi-result-name">${esc(d.name)} ${viewBtn}</div>
        <div class="fbi-result-ings">${tags}</div>
      </div>
    `;
  }).join('');
}

function clearFbiSelection() {
  document.querySelectorAll('#fbiIngList input[type="checkbox"]').forEach(cb => cb.checked = false);
  document.getElementById('fbiSearch').value = '';
  filterFbiIngredients();
  renderFbiResults();
}

// ─── Image compression ────────────────────────────────────────────────────────
const MAX_DIMENSION = 1920;
const JPEG_QUALITY  = 0.82;

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);

      let { width, height } = img;
      if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        const ratio = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
        width  = Math.round(width  * ratio);
        height = Math.round(height * ratio);
      }

      const canvas = document.createElement('canvas');
      canvas.width  = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);

      canvas.toBlob(blob => {
        if (!blob) { reject(new Error('Image compression failed')); return; }
        // Keep the original filename but force .jpg extension for the compressed output
        const name = file.name.replace(/\.[^.]+$/, '.jpg');
        resolve(new File([blob], name, { type: 'image/jpeg' }));
      }, 'image/jpeg', JPEG_QUALITY);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
    img.src = url;
  });
}

// ─── Util ─────────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
