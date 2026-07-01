const API_BASE_URL = window.APP_CONFIG?.API_BASE_URL || 'http://localhost:3000';
const USE_MOCK = window.APP_CONFIG?.USE_MOCK === true;

function authHeaders() {
  const token = localStorage.getItem('authToken');
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };
}

function handleAuthError(res) {
  if (res.status === 401 || res.status === 403) {
    localStorage.clear();
    window.location.href = 'login.html';
    return true;
  }
  return false;
}

let _loadingCount = 0;
function _showLoading() {
  _loadingCount++;
  document.getElementById('loadingOverlay')?.classList.add('active');
}
function _hideLoading() {
  if (--_loadingCount <= 0) {
    _loadingCount = 0;
    document.getElementById('loadingOverlay')?.classList.remove('active');
  }
}

async function apiGet(endpoint, mockFile) {
  if (USE_MOCK && mockFile) {
    const res = await fetch(`./mockdata/${mockFile}`);
    return res.json();
  }
  _showLoading();
  try {
    const res = await fetch(`${API_BASE_URL}${endpoint}`, { headers: authHeaders() });
    if (handleAuthError(res)) return null;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Request failed: ${res.status}`);
    }
    return res.json();
  } finally {
    _hideLoading();
  }
}

async function apiPost(endpoint, body) {
  if (USE_MOCK) return { success: true, _mock: true, ...body, id: crypto.randomUUID() };
  _showLoading();
  try {
    const res = await fetch(`${API_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    if (handleAuthError(res)) return null;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Request failed: ${res.status}`);
    }
    return res.json();
  } finally {
    _hideLoading();
  }
}

async function apiPut(endpoint, body) {
  if (USE_MOCK) return { success: true, _mock: true, ...body };
  _showLoading();
  try {
    const res = await fetch(`${API_BASE_URL}${endpoint}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    if (handleAuthError(res)) return null;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Request failed: ${res.status}`);
    }
    return res.json();
  } finally {
    _hideLoading();
  }
}

async function apiDelete(endpoint) {
  if (USE_MOCK) return { success: true, _mock: true };
  _showLoading();
  try {
    const res = await fetch(`${API_BASE_URL}${endpoint}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (handleAuthError(res)) return null;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Request failed: ${res.status}`);
    }
    return res.json();
  } finally {
    _hideLoading();
  }
}

async function apiGetRecipeUploadUrl(dishId, fileName, fileType) {
  if (USE_MOCK) {
    const ext = fileName.split('.').pop().toLowerCase();
    return { uploadUrl: null, s3Key: `recipes/${dishId}/recipe.${ext}`, fileName, fileType, _mock: true };
  }
  const params = new URLSearchParams({ fileName, fileType });
  return apiGet(`/dishes/${dishId}/recipe-upload-url?${params}`);
}

async function apiGetRecipeDownloadUrl(dishId) {
  if (USE_MOCK) return null;
  return apiGet(`/dishes/${dishId}/recipe-download-url`);
}

async function apiScrapeRecipe(url) {
  if (USE_MOCK) throw new Error('Ingredient scraping is not available in local mode — please add ingredients manually');
  const params = new URLSearchParams({ url });
  return apiGet(`/dishes/scrape-recipe?${params}`, null);
}

async function apiUploadToS3(uploadUrl, file) {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
}
