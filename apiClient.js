const API_BASE_URL = window.APP_CONFIG?.API_BASE_URL || 'http://localhost:3000';
const USE_MOCK = window.APP_CONFIG?.USE_MOCK === true;

// Staging and production are both served from the same GitHub Pages origin
// (different paths only), so localStorage is shared between them. Namespace
// auth keys by environment to stop one instance from clobbering the other's session.
const AUTH_ENV = window.APP_CONFIG?.ENVIRONMENT || 'LOCAL';

function authStorageKey(name) {
  return `${name}_${AUTH_ENV}`;
}

function getAuthToken() {
  return localStorage.getItem(authStorageKey('authToken'));
}

function setAuthToken(token) {
  localStorage.setItem(authStorageKey('authToken'), token);
}

function getUserRole() {
  return localStorage.getItem(authStorageKey('userRole'));
}

function setUserRole(role) {
  localStorage.setItem(authStorageKey('userRole'), role);
}

function setUserLoginID(loginID) {
  localStorage.setItem(authStorageKey('userLoginID'), loginID);
}

function clearAuthStorage() {
  localStorage.removeItem(authStorageKey('authToken'));
  localStorage.removeItem(authStorageKey('userRole'));
  localStorage.removeItem(authStorageKey('userLoginID'));
}

function authHeaders() {
  const token = getAuthToken();
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };
}

function handleAuthError(res) {
  if (res.status === 401 || res.status === 403) {
    clearAuthStorage();
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

// A hung request (cold Lambda/authorizer, flaky mobile network) would otherwise leave
// _showLoading() active forever with no way to recover short of reloading the page.
const REQUEST_TIMEOUT_MS = 15000;

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request timed out — check your connection and try again');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function apiGet(endpoint, mockFile) {
  if (USE_MOCK && mockFile) {
    const res = await fetch(`./mockdata/${mockFile}`, { cache: 'no-cache' });
    return res.json();
  }
  _showLoading();
  try {
    const res = await fetchWithTimeout(`${API_BASE_URL}${endpoint}`, { headers: authHeaders() });
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
    const res = await fetchWithTimeout(`${API_BASE_URL}${endpoint}`, {
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
    const res = await fetchWithTimeout(`${API_BASE_URL}${endpoint}`, {
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
    const res = await fetchWithTimeout(`${API_BASE_URL}${endpoint}`, {
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

async function apiExtractRecipeIngredients(dishId) {
  if (USE_MOCK) throw new Error('Ingredient scanning is not available in local mode — please add ingredients manually');
  return apiGet(`/dishes/${dishId}/recipe-extract-ingredients`, null);
}

async function apiUploadToS3(uploadUrl, file) {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
}
