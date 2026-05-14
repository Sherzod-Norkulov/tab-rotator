let timerId = null;
let intervalMs = 5000;
let isRunning = false;
let rotationTargets = [];
let restoring = false;
let explicitCommandInProgress = false;
let suppressAutoStartOnce = false;
let popupOpen = false;
let pendingStartOptions = null;
let wasRunningBeforePopup = false;
let pausedSettingsSnapshot = null;
let ensuredWindowId = null;
let badgeTimer = null;
let pauseReason = null;
const refreshTaskTimers = new Map();
const iconOn = {
  "16": "assets/icons/icon-on-icon16.png",
  "48": "assets/icons/icon-on-icon48.png",
  "128": "assets/icons/icon-on-icon128.png"
};
const iconOff = {
  "16": "assets/icons/icon-off-icon16.png",
  "48": "assets/icons/icon-off-icon48.png",
  "128": "assets/icons/icon-off-icon128.png"
};
const storageArea = chrome.storage.local;
const IDLE_DETECTION_THRESHOLD_SEC = 60;
const PAUSE_CHECK_INTERVAL_MS = 1000;
const PAUSE_BADGE_TEXT = '⏸';
const MANAGEABLE_PROTOCOLS = new Set(['http:', 'https:', 'file:']);
// In MV3 service workers, chrome.runtime.getManifest() is available synchronously.
// Keep a defensive fallback ('0.0.0') only for unexpected early execution; we no
// longer hard-code a second copy of the release version here — that was a source
// of drift between manifest.json and background.js during releases.
const manifestVersion = (typeof chrome !== 'undefined' &&
  chrome.runtime &&
  typeof chrome.runtime.getManifest === 'function' &&
  chrome.runtime.getManifest().version) || '0.0.0';
let lastCandidates = [];

async function ensureDedicatedWindow(entries) {
  if (!currentSettings.useDedicatedWindow || !currentSettings.useCustomList) {
    return { id: null, created: false };
  }

  if (ensuredWindowId) {
    try {
      const win = await chrome.windows.get(ensuredWindowId, { populate: false });
      if (win && win.id) {
        return { id: win.id, created: false };
      }
    } catch (e) {
      ensuredWindowId = null;
    }
  }

  const normalized = normalizeEntries(entries).filter((entry) => entry.rotate !== false && isManageableUrl(entry.url));
  // Guard: never create an empty `about:blank` dedicated window when the list is empty.
  // Without this, enabling "Open list in a dedicated window" with no URLs would spawn a
  // blank monitoring window the user never asked for.
  if (!normalized.length || !normalized[0]?.url) {
    return { id: null, created: false };
  }
  const firstUrl = normalizedMatchUrl(normalized[0].url);

  const createdWindow = await chrome.windows.create({
    url: firstUrl,
    focused: false,
    state: 'normal',
    type: 'normal'
  });

  ensuredWindowId = createdWindow.id;

  if (normalized.length > 1) {
    for (const entry of normalized.slice(1)) {
      const url = normalizedMatchUrl(entry.url);
      await chrome.tabs.create({ windowId: ensuredWindowId, url, active: false });
    }
  }

  return { id: ensuredWindowId, created: true };
}

async function closeDedicatedWindow() {
  if (!ensuredWindowId) {
    return;
  }

  try {
    await chrome.windows.remove(ensuredWindowId);
  } catch (e) {
    // window may already be closed; ignore
  } finally {
    ensuredWindowId = null;
  }
}

const defaultSettings = {
  intervalSec: 5,
  autoStart: false,
  useCustomList: false,
  customEntries: [],
  openCustomTabs: true,
  enableRefreshFlags: true,
  customRawText: '',
  useDedicatedWindow: false,
  shuffle: false,
  excludeDomains: '',
  noRefreshDomains: '',
  badgeCountdown: true,
  allowRotationWhilePopupOpen: false,
  pausePolicy: 'never',
  refreshTasks: []
};

let currentSettings = { ...defaultSettings };

function normalizeEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }

  const seen = new Set();
  const result = [];

  for (const entry of entries) {
    let normalizedEntry;
    if (typeof entry === 'string') {
      normalizedEntry = { url: entry.trim(), name: '', rotate: true, refresh: false, intervalSec: null, refreshDelaySec: 0 };
    } else {
      const url = typeof entry?.url === 'string' ? entry.url.trim() : '';
      const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
      const rotate = entry?.rotate !== false;
      const refresh = Boolean(entry?.refresh);
      const intervalRaw = Number(entry?.intervalSec);
      const intervalSec = Number.isFinite(intervalRaw) && intervalRaw >= 1 ? intervalRaw : null;
      const refreshDelayRaw = Number(entry?.refreshDelaySec);
      const refreshDelaySec = Number.isFinite(refreshDelayRaw) && refreshDelayRaw >= 0 ? refreshDelayRaw : 0;
      normalizedEntry = { url, name, rotate, refresh, intervalSec, refreshDelaySec };
    }

    if (!normalizedEntry.url.length) continue;
    const key = normalizedMatchUrl(normalizedEntry.url);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalizedEntry);
  }

  return result;
}

function normalizedMatchUrl(candidate) {
  if (!candidate) {
    return '';
  }

  const url = candidate.trim();
  if (!url) {
    return '';
  }

  try {
    return new URL(url).href;
  } catch (e) {
    // fall through
  }

  try {
    return new URL(`https://${url}`).href;
  } catch (e) {
    return `https://${url}`;
  }
}

function isManageableUrl(candidate) {
  if (!candidate) {
    return false;
  }
  try {
    return MANAGEABLE_PROTOCOLS.has(new URL(normalizedMatchUrl(candidate)).protocol);
  } catch (error) {
    return false;
  }
}

function tabMatches(tabUrl, targetUrl) {
  if (!tabUrl || !targetUrl) {
    return false;
  }

  const normalizedTab = normalizedMatchUrl(tabUrl);
  const normalizedTarget = normalizedMatchUrl(targetUrl);

  try {
    const tabParsed = new URL(normalizedTab);
    const targetParsed = new URL(normalizedTarget);

    const tabHost = (tabParsed.hostname || '').toLowerCase();
    const targetHost = (targetParsed.hostname || '').toLowerCase();

    const hostsMatch =
      tabHost === targetHost ||
      (tabHost && targetHost && tabHost.endsWith(`.${targetHost}`)) ||
      (tabHost && targetHost && targetHost.endsWith(`.${tabHost}`));

    if (!hostsMatch) {
      return normalizedTab.startsWith(normalizedTarget);
    }

    const normalizePath = (pathname) => {
      if (!pathname) return '';
      return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
    };

    const targetPath = normalizePath(targetParsed.pathname);
    if (targetPath && targetPath !== '/') {
      const tabPath = normalizePath(tabParsed.pathname);
      if (tabPath === targetPath || tabPath.startsWith(`${targetPath}/`)) {
        return true;
      }
      return normalizedTab.startsWith(normalizedTarget);
    }

    return true;
  } catch (error) {
    // Both URLs failed to parse — compare normalized strings by prefix only.
    // Avoid a loose `String.includes(targetUrl)` fallback here: with short/common
    // target fragments it produced false positives (e.g. target "a.com" matching
    // "https://other.example.com/a.com-thing").
    return normalizedTab.startsWith(normalizedTarget);
  }
}

function parseExcludedDomains(text) {
  if (!text) return [];
  return text
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isExcluded(tabUrl, excludeList) {
  if (!excludeList.length || !tabUrl) return false;
  try {
    const host = new URL(tabUrl).hostname.toLowerCase();
    return excludeList.some((d) => host === d || host.endsWith(`.${d}`));
  } catch (e) {
    return false;
  }
}

function isRefreshExcluded(tabUrl) {
  return isExcluded(tabUrl, parseExcludedDomains(currentSettings.noRefreshDomains));
}

function normalizePausePolicy(value) {
  return ['never', 'active', 'idle'].includes(value) ? value : 'never';
}

function generateRefreshTaskId() {
  if (globalThis.crypto?.randomUUID) {
    return `refresh-${globalThis.crypto.randomUUID()}`;
  }
  return `refresh-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeRefreshTasks(tasks) {
  if (!Array.isArray(tasks)) {
    return [];
  }

  const seen = new Set();
  return tasks
    .map((task) => {
      const url = normalizedMatchUrl(typeof task?.url === 'string' ? task.url : '');
      const intervalRaw = Number(task?.intervalSec);
      const intervalSec = Number.isFinite(intervalRaw) && intervalRaw >= 1 ? intervalRaw : null;
      if (!url || !intervalSec) {
        return null;
      }
      const key = `${url}|${intervalSec}`;
      if (seen.has(key)) {
        return null;
      }
      seen.add(key);
      return {
        id: typeof task?.id === 'string' && task.id ? task.id : generateRefreshTaskId(),
        url,
        name: typeof task?.name === 'string' ? task.name.trim() : '',
        intervalSec,
        enabled: task?.enabled !== false
      };
    })
    .filter(Boolean);
}

function clearRefreshTaskTimers() {
  for (const timer of refreshTaskTimers.values()) {
    clearTimeout(timer);
  }
  refreshTaskTimers.clear();
}

async function runRefreshTask(taskId) {
  const task = currentSettings.refreshTasks.find((item) => item.id === taskId && item.enabled);
  if (!task) {
    refreshTaskTimers.delete(taskId);
    return;
  }

  try {
    if (isManageableUrl(task.url) && !isRefreshExcluded(task.url)) {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((candidate) => {
        const candidateUrls = [];
        if (typeof candidate.pendingUrl === 'string') candidateUrls.push(candidate.pendingUrl);
        if (typeof candidate.url === 'string') candidateUrls.push(candidate.url);
        return candidateUrls.some((url) => isManageableUrl(url) && tabMatches(url, task.url));
      });
      if (tab?.id) {
        await chrome.tabs.reload(tab.id);
      }
    }
  } catch (error) {
    console.error('Auto-refresh task failed:', error);
  } finally {
    scheduleRefreshTask(task);
  }
}

function scheduleRefreshTask(task) {
  if (!task?.id || task.enabled === false) {
    return;
  }
  if (refreshTaskTimers.has(task.id)) {
    clearTimeout(refreshTaskTimers.get(task.id));
  }
  const timer = setTimeout(() => {
    runRefreshTask(task.id).catch((err) => console.error('runRefreshTask error', err));
  }, task.intervalSec * 1000);
  refreshTaskTimers.set(task.id, timer);
}

function scheduleRefreshTasks() {
  clearRefreshTaskTimers();
  currentSettings.refreshTasks = normalizeRefreshTasks(currentSettings.refreshTasks);
  for (const task of currentSettings.refreshTasks) {
    scheduleRefreshTask(task);
  }
}

async function getRotationPauseReason() {
  const policy = normalizePausePolicy(currentSettings.pausePolicy);
  if (policy === 'never' || !chrome.idle?.queryState) {
    return null;
  }

  try {
    const state = await chrome.idle.queryState(IDLE_DETECTION_THRESHOLD_SEC);
    if (policy === 'active' && state === 'active') {
      return 'active';
    }
    if (policy === 'idle' && (state === 'idle' || state === 'locked')) {
      return 'idle';
    }
  } catch (error) {
    console.error('Could not read idle state:', error);
  }
  return null;
}

async function prepareCustomTargets(entries, openMissing) {
  const normalized = normalizeEntries(entries).filter((entry) => entry.rotate !== false && isManageableUrl(entry.url));

  if (!normalized.length) {
    return [];
  }

  const existingTabs = await chrome.tabs.query(
    currentSettings.useDedicatedWindow && ensuredWindowId
      ? { windowId: ensuredWindowId }
      : {}
  );
  const targets = [];
  const usedIds = new Set();

  for (const entry of normalized) {
    const { url, refresh } = entry;
    const normalizedUrl = normalizedMatchUrl(url);

    let tab = existingTabs.find((t) => {
      const candidateUrls = [];
      if (typeof t.pendingUrl === 'string') candidateUrls.push(t.pendingUrl);
      if (typeof t.url === 'string') candidateUrls.push(t.url);
      return (
        candidateUrls.some((u) => isManageableUrl(u) && tabMatches(u, normalizedUrl)) &&
        !usedIds.has(t.id)
      );
    });

    if (!tab && openMissing && isManageableUrl(normalizedUrl)) {
      const createOptions = { url: normalizedUrl, active: false };
      if (currentSettings.useDedicatedWindow && ensuredWindowId) {
        createOptions.windowId = ensuredWindowId;
      }
      tab = await chrome.tabs.create(createOptions);
    }

    if (tab && !usedIds.has(tab.id)) {
      usedIds.add(tab.id);
      targets.push({
        tabId: tab.id,
        refresh,
        intervalSec: entry.intervalSec || null,
        refreshDelaySec: entry.refreshDelaySec || 0,
        name: entry.name || ''
      });
    }
  }

  return targets;
}

function persistState(extra = {}) {
  const payload = {
    ...currentSettings,
    isRunning,
    ensuredWindowId,
    ...extra
  };

  const backup = {
    version: manifestVersion,
    savedAt: Date.now(),
    settings: {
      ...payload,
      rotationTargets: undefined
    }
  };

  return storageArea.set({
    ...payload,
    configBackup: backup
  });
}

function buildCandidatesFromCustomEntries(tabs) {
  if (!currentSettings.useCustomList || !currentSettings.customEntries.length) {
    return [];
  }

  const excluded = parseExcludedDomains(currentSettings.excludeDomains);
  const usedIds = new Set();
  const candidates = [];

  for (const entry of currentSettings.customEntries) {
    if (entry.rotate === false) {
      continue;
    }

    const targetUrl = normalizedMatchUrl(entry.url);
    if (!isManageableUrl(targetUrl)) {
      continue;
    }
    const found = tabs.find((t) => {
      const candidateUrls = [];
      if (typeof t.pendingUrl === 'string') candidateUrls.push(t.pendingUrl);
      if (typeof t.url === 'string') candidateUrls.push(t.url);
      return candidateUrls.some(
        (u) => u && isManageableUrl(u) && !isExcluded(u, excluded) && tabMatches(u, targetUrl)
      );
    });

    if (found && !usedIds.has(found.id)) {
      usedIds.add(found.id);
      candidates.push({
        tab: found,
        refresh: Boolean(entry.refresh),
        intervalSec: entry.intervalSec || null,
        refreshDelaySec: entry.refreshDelaySec || 0
      });
    }
  }

  if (candidates.length < 2 && rotationTargets.length) {
    const tabMap = new Map(tabs.map((t) => [t.id, t]));

    for (const rt of rotationTargets) {
      const tab = tabMap.get(rt.tabId);
      if (
          tab &&
          !usedIds.has(tab.id) &&
          isManageableUrl(typeof tab.pendingUrl === 'string' ? tab.pendingUrl : tab.url) &&
          !isExcluded(
          typeof tab.pendingUrl === 'string' ? tab.pendingUrl : tab.url,
          excluded
        )
      ) {
        usedIds.add(tab.id);
        candidates.push({
          tab,
          refresh: Boolean(rt.refresh),
          intervalSec: rt.intervalSec || null,
          refreshDelaySec: rt.refreshDelaySec || 0,
          name: rt.name || ''
        });
      }
    }
  }

  return candidates;
}

function findEntryForTab(tab) {
  if (!tab || !currentSettings.customEntries.length) {
    return null;
  }
  const tabUrl =
    typeof tab.pendingUrl === 'string'
      ? tab.pendingUrl
      : typeof tab.url === 'string'
        ? tab.url
        : '';
  for (const entry of currentSettings.customEntries) {
    if (entry.rotate === false || !isManageableUrl(entry.url)) {
      continue;
    }
    const targetUrl = normalizedMatchUrl(entry.url);
    if (tabMatches(tabUrl, targetUrl)) {
      return entry;
    }
  }
  return null;
}

async function rotateTabs() {
  let nextDelayMs = intervalMs;

  try {
    pauseReason = await getRotationPauseReason();
    if (pauseReason) {
      nextDelayMs = PAUSE_CHECK_INTERVAL_MS;
      return;
    }

    if (currentSettings.useDedicatedWindow && currentSettings.useCustomList) {
      const { id, created } = await ensureDedicatedWindow(currentSettings.customEntries);
      ensuredWindowId = id;
      // если окно только что создано, пропускаем цикл пересоздания вкладок ниже
      if (created) {
        rotationTargets = await prepareCustomTargets(currentSettings.customEntries, false);
      }
    }

    let tabs = await chrome.tabs.query(
      currentSettings.useDedicatedWindow && ensuredWindowId
        ? { windowId: ensuredWindowId }
        : { currentWindow: true }
    );

    if (!isRunning || !tabs || tabs.length < 2) {
      return;
    }

    const activeTab = tabs.find((t) => t.active);

    if (!activeTab) {
      return;
    }

    let candidates = buildCandidatesFromCustomEntries(tabs);

      if (currentSettings.useCustomList && candidates.length < 2) {
        // Попробуем пересоздать список и недостающие вкладки (только если это разрешено настройками)
        rotationTargets = await prepareCustomTargets(
          currentSettings.customEntries,
          Boolean(currentSettings.openCustomTabs)
        );
      if (rotationTargets.length) {
        tabs = await chrome.tabs.query(
          currentSettings.useDedicatedWindow && ensuredWindowId
            ? { windowId: ensuredWindowId }
            : { currentWindow: true }
        );
        candidates = buildCandidatesFromCustomEntries(tabs);
      }
    }

    const excluded = parseExcludedDomains(currentSettings.excludeDomains);

    if (candidates.length < 2) {
      if (currentSettings.useCustomList) {
        // Respect per-entry rotation toggles: do not fall back to all tabs when
        // the custom list has fewer than two enabled rotation candidates. This
        // intentionally leaves rotation idle until the user enables more entries.
        return;
      }
      candidates = tabs
        .filter((t) => {
          const url = typeof t.pendingUrl === 'string' ? t.pendingUrl : t.url;
          return isManageableUrl(url) && !isExcluded(url, excluded);
        })
        .map((t) => ({ tab: t, refresh: false, intervalSec: null }));
      if (candidates.length < 2) {
        return;
      }
    }

    lastCandidates = candidates;

    const activeIndex = candidates.findIndex((t) => t.tab.id === activeTab.id);
    let nextIndex;

    if (currentSettings.shuffle) {
      // Build a pool excluding the currently active tab. If for any reason the pool ends
      // up empty (e.g. defensive guard — the earlier `candidates.length < 2` check should
      // already prevent this, but keep behavior safe against future refactors), fall back
      // to sequential selection instead of dereferencing `undefined`.
      const pool = candidates.filter((_, idx) => idx !== activeIndex);
      if (pool.length === 0) {
        const startIndex = activeIndex === -1 ? 0 : activeIndex;
        nextIndex = (startIndex + 1) % candidates.length;
      } else {
        const picked = pool[Math.floor(Math.random() * pool.length)];
        nextIndex = candidates.indexOf(picked);
      }
    } else {
      const startIndex = activeIndex === -1 ? 0 : activeIndex;
      nextIndex = (startIndex + 1) % candidates.length;
    }

    const next = candidates[nextIndex];
    if (!next || !next.tab) {
      // Nothing to switch to — skip this tick safely.
      return;
    }

    await chrome.tabs.update(next.tab.id, { active: true });

    const nextTabUrl = typeof next.tab.pendingUrl === 'string' ? next.tab.pendingUrl : next.tab.url;
    if (currentSettings.enableRefreshFlags && next.refresh && !isRefreshExcluded(nextTabUrl)) {
      const delay = Number(next.refreshDelaySec) || 0;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay * 1000));
      }
      await chrome.tabs.reload(next.tab.id);
    }

    const matchedEntry = findEntryForTab(next.tab);
    if (matchedEntry && Number.isFinite(matchedEntry.intervalSec) && matchedEntry.intervalSec >= 1) {
      nextDelayMs = matchedEntry.intervalSec * 1000;
    } else {
      nextDelayMs = intervalMs;
    }
  } catch (error) {
    console.error('Ошибка переключения вкладок:', error);
  } finally {
    if (isRunning) {
      scheduleNextTick(nextDelayMs);
    }
  }
}

async function stopRotator(saveState = true) {
  if (timerId !== null) {
    clearTimeout(timerId);
    timerId = null;
  }
  if (badgeTimer !== null) {
    clearInterval(badgeTimer);
    badgeTimer = null;
  }

  isRunning = false;
  rotationTargets = [];
  pauseReason = null;
  chrome.action.setBadgeText({ text: '' }).catch(() => {});
  chrome.action.setIcon({ path: iconOff }).catch(() => {});

  if (saveState) {
    try {
      await persistState({ isRunning: false });
    } catch (error) {
      console.error('Не удалось сохранить состояние при остановке:', error);
    }
  }
}

async function startRotator(options = {}) {
  await stopRotator(false);

  const normalized = {
    ...currentSettings,
    ...options
  };

  normalized.intervalSec = Number(normalized.intervalSec) || defaultSettings.intervalSec;

  if (normalized.intervalSec < 1) {
    normalized.intervalSec = 1;
  }

  normalized.customEntries = normalizeEntries(normalized.customEntries);
  normalized.useCustomList = Boolean(normalized.useCustomList) && normalized.customEntries.length > 0;
  normalized.openCustomTabs = Boolean(
    normalized.useCustomList ? normalized.openCustomTabs ?? true : normalized.openCustomTabs
  );
  normalized.autoStart = Boolean(normalized.autoStart);
  normalized.enableRefreshFlags = Boolean(normalized.enableRefreshFlags);
  normalized.useDedicatedWindow = Boolean(normalized.useDedicatedWindow);
  normalized.shuffle = Boolean(normalized.shuffle);
  normalized.excludeDomains = typeof normalized.excludeDomains === 'string'
    ? normalized.excludeDomains
    : currentSettings.excludeDomains || '';
  normalized.noRefreshDomains = typeof normalized.noRefreshDomains === 'string'
    ? normalized.noRefreshDomains
    : currentSettings.noRefreshDomains || '';
  normalized.pausePolicy = normalizePausePolicy(normalized.pausePolicy);
  normalized.refreshTasks = normalizeRefreshTasks(normalized.refreshTasks || currentSettings.refreshTasks);
  normalized.badgeCountdown = Boolean(
    normalized.badgeCountdown === undefined ? currentSettings.badgeCountdown : normalized.badgeCountdown
  );
  normalized.customRawText = typeof normalized.customRawText === 'string'
    ? normalized.customRawText
    : currentSettings.customRawText || '';
  normalized.allowRotationWhilePopupOpen = Boolean(
    normalized.allowRotationWhilePopupOpen === undefined
      ? currentSettings.allowRotationWhilePopupOpen
      : normalized.allowRotationWhilePopupOpen
  );

  if (!normalized.useCustomList) {
    normalized.openCustomTabs = false;
    normalized.enableRefreshFlags = false;
    normalized.customRawText = '';
    normalized.useDedicatedWindow = false;
    normalized.shuffle = false;
  }

  currentSettings = normalized;
  intervalMs = normalized.intervalSec * 1000;
  pauseReason = null;
  scheduleRefreshTasks();

  if (currentSettings.useDedicatedWindow && currentSettings.useCustomList) {
    const { id } = await ensureDedicatedWindow(currentSettings.customEntries);
    ensuredWindowId = id;
  } else {
    await closeDedicatedWindow();
  }

  rotationTargets = normalized.useCustomList
    ? await prepareCustomTargets(normalized.customEntries, normalized.openCustomTabs)
    : [];

  if (normalized.useCustomList && rotationTargets.length < 2) {
    chrome.action.setIcon({ path: iconOff }).catch(() => {});
    await persistState({ isRunning: false });
    return { ok: false, error: 'NOT_ENOUGH_TARGETS' };
  }

  if (!normalized.useCustomList) {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const excluded = parseExcludedDomains(normalized.excludeDomains);
    const candidates = (tabs || []).filter((tab) => {
      const url = typeof tab.pendingUrl === 'string' ? tab.pendingUrl : tab.url;
      return isManageableUrl(url) && !isExcluded(url, excluded);
    });
    if (candidates.length < 2) {
      chrome.action.setIcon({ path: iconOff }).catch(() => {});
      await persistState({ isRunning: false });
      return { ok: false, error: 'NOT_ENOUGH_TARGETS' };
    }
  }

  isRunning = true;
  chrome.action.setIcon({ path: iconOn }).catch(() => {});
  scheduleNextTick(intervalMs);

  await persistState({ isRunning: true });
  return { ok: true };
}

function scheduleNextTick(delayMs) {
  if (!isRunning) {
    return;
  }
  if (timerId !== null) {
    clearTimeout(timerId);
  }
  const safeDelay = Math.max(50, delayMs);
  if (badgeTimer !== null) {
    clearInterval(badgeTimer);
    badgeTimer = null;
  }
  if (currentSettings.badgeCountdown) {
    if (pauseReason) {
      chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' }).catch(() => {});
      chrome.action.setBadgeText({ text: PAUSE_BADGE_TEXT }).catch(() => {});
    } else {
      const endTime = Date.now() + safeDelay;
      chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' }).catch(() => {});
      const tick = () => {
        const remaining = Math.max(0, endTime - Date.now());
        const sec = Math.max(0, Math.ceil(remaining / 1000));
        chrome.action.setBadgeText({ text: sec === 0 ? '' : `${sec}` }).catch(() => {});
        if (sec === 0 && badgeTimer !== null) {
          clearInterval(badgeTimer);
          badgeTimer = null;
        }
      };
      tick();
      badgeTimer = setInterval(tick, 500);
    }
  } else {
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
  }
  timerId = setTimeout(() => {
    rotateTabs().catch((err) => console.error('rotateTabs error', err));
  }, safeDelay);
}

async function restoreFromStorage() {
  if (restoring || isRunning || explicitCommandInProgress) {
    return;
  }

  restoring = true;

  try {
    const data = await storageArea.get([
      'intervalSec',
      'autoStart',
      'useCustomList',
      'customUrls',
      'customEntries',
      'openCustomTabs',
      'isRunning',
      'enableRefreshFlags',
      'customRawText',
      'useDedicatedWindow',
      'targetWindowId',
      'ensuredWindowId',
      'configBackup',
      'shuffle',
      'excludeDomains',
      'noRefreshDomains',
      'badgeCountdown',
      'allowRotationWhilePopupOpen',
      'pausePolicy',
      'refreshTasks',
      'activeConfig'
    ]);

    const source = data.activeConfig && typeof data.activeConfig === 'object'
      ? data.activeConfig
      : data;

    let entriesFromStorage = Array.isArray(source.customEntries) && source.customEntries.length
      ? source.customEntries
      : source.customUrls || [];

    if ((!entriesFromStorage || !entriesFromStorage.length) && source.configBackup?.settings?.customEntries) {
      entriesFromStorage = source.configBackup.settings.customEntries;
    }

    currentSettings = {
      ...defaultSettings,
      ...source,
      customEntries: entriesFromStorage,
      customRawText: typeof source.customRawText === 'string'
        ? source.customRawText
        : Array.isArray(entriesFromStorage)
          ? entriesFromStorage.map((item) => (typeof item === 'string' ? item : item.url || '')).join('\n')
          : '',
      useDedicatedWindow: Boolean(source.useDedicatedWindow),
      shuffle: Boolean(source.shuffle),
      excludeDomains: typeof source.excludeDomains === 'string' ? source.excludeDomains : '',
      noRefreshDomains: typeof source.noRefreshDomains === 'string'
        ? source.noRefreshDomains
        : typeof data.noRefreshDomains === 'string'
          ? data.noRefreshDomains
          : '',
      badgeCountdown: source.badgeCountdown !== undefined ? Boolean(source.badgeCountdown) : true,
      allowRotationWhilePopupOpen: source.allowRotationWhilePopupOpen !== undefined
        ? Boolean(source.allowRotationWhilePopupOpen)
        : false,
      pausePolicy: normalizePausePolicy(source.pausePolicy),
      refreshTasks: normalizeRefreshTasks(
        Array.isArray(source.refreshTasks) ? source.refreshTasks : data.refreshTasks
      )
    };

    ensuredWindowId = source.ensuredWindowId || source.targetWindowId || null;
    scheduleRefreshTasks();

    if (
      (!popupOpen || currentSettings.allowRotationWhilePopupOpen) &&
      !suppressAutoStartOnce &&
      (data.isRunning || source.autoStart)
    ) {
      await startRotator(currentSettings);
    } else {
      chrome.action.setIcon({ path: iconOff }).catch(() => {});
    }
  } catch (error) {
    console.error('Не удалось восстановить состояние из storage:', error);
  } finally {
    restoring = false;
    suppressAutoStartOnce = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === 'START') {
      explicitCommandInProgress = true;
      suppressAutoStartOnce = true;
      try {
        const {
          intervalSec,
          useCustomList,
          customEntries,
          customUrls,
          openCustomTabs,
          autoStart,
          enableRefreshFlags,
          useDedicatedWindow,
          shuffle,
          excludeDomains,
          noRefreshDomains,
          badgeCountdown,
          allowRotationWhilePopupOpen,
          pausePolicy,
          refreshTasks
        } = message;

        if (!Number.isFinite(Number(intervalSec)) || Number(intervalSec) < 1) {
          sendResponse({ ok: false, error: 'INVALID_INTERVAL' });
          return;
        }

        const normalizedEntries = Array.isArray(customEntries) && customEntries.length
          ? customEntries
          : customUrls || [];

        const startOptions = {
          intervalSec,
          useCustomList,
          customEntries: normalizedEntries,
          openCustomTabs,
          autoStart,
          enableRefreshFlags,
          customRawText: message.customRawText || '',
          useDedicatedWindow,
          shuffle,
          excludeDomains,
          noRefreshDomains,
          badgeCountdown,
          allowRotationWhilePopupOpen,
          pausePolicy,
          refreshTasks
        };

        // explicit start overrides any paused snapshot
        wasRunningBeforePopup = false;
        pausedSettingsSnapshot = null;

        if (popupOpen && !startOptions.allowRotationWhilePopupOpen) {
          pendingStartOptions = startOptions;
          sendResponse({ ok: true, deferred: true });
          return;
        }

        const result = await startRotator(startOptions);
        sendResponse(result?.ok === false ? result : { ok: true });
      } finally {
        explicitCommandInProgress = false;
      }
    } else if (message.type === 'STOP') {
      explicitCommandInProgress = true;
      suppressAutoStartOnce = true;
      try {
        pendingStartOptions = null;
        wasRunningBeforePopup = false;
        pausedSettingsSnapshot = null;
        await stopRotator();
        sendResponse({ ok: true });
      } finally {
        explicitCommandInProgress = false;
      }
    } else if (message.type === 'REFRESH_TASKS_SET') {
      currentSettings.noRefreshDomains = typeof message.noRefreshDomains === 'string'
        ? message.noRefreshDomains
        : currentSettings.noRefreshDomains;
      currentSettings.refreshTasks = normalizeRefreshTasks(message.refreshTasks);
      await storageArea.set({
        noRefreshDomains: currentSettings.noRefreshDomains,
        refreshTasks: currentSettings.refreshTasks,
        configBackup: {
          version: manifestVersion,
          savedAt: Date.now(),
          settings: { ...currentSettings, isRunning, ensuredWindowId }
        }
      });
      scheduleRefreshTasks();
      sendResponse({ ok: true, refreshTasks: currentSettings.refreshTasks });
    } else if (message.type === 'REFRESH_TASKS_RESET') {
      currentSettings.refreshTasks = [];
      clearRefreshTaskTimers();
      await storageArea.set({ refreshTasks: [] });
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: 'UNKNOWN_COMMAND' });
    }
  })().catch((error) => {
    console.error('Ошибка обработки сообщения от popup:', error);
    sendResponse({ ok: false, error: 'INTERNAL_ERROR' });
  });

  return true;
});

chrome.runtime.onStartup.addListener(() => {
  restoreFromStorage();
});

setTimeout(() => restoreFromStorage(), 0);

chrome.commands?.onCommand?.addListener((command) => {
  if (command === 'stop-rotation') {
    stopRotator().catch((err) => console.error('Command stop failed:', err));
    return;
  }
  if (command === 'toggle-rotation') {
    const action = isRunning ? stopRotator() : startRotator(currentSettings);
    action.catch((err) => console.error('Command toggle failed:', err));
  }
});

chrome.runtime.onConnect.addListener((port) => {
  // Two port names are used by popup.js:
  //   - 'popup'  — regular toolbar popup; rotation is paused while it's open
  //                (unless `allowRotationWhilePopupOpen` is set).
  //   - 'panel'  — standalone window opened via "Open in a window" (popup.html?standalone=1).
  //                This is intentionally a persistent UI and must NOT pause rotation;
  //                we just ignore the connection here.
  if (port.name !== 'popup') {
    return;
  }
  popupOpen = true;
  if (isRunning && !currentSettings.allowRotationWhilePopupOpen) {
    wasRunningBeforePopup = true;
    try {
      pausedSettingsSnapshot = JSON.parse(JSON.stringify(currentSettings));
    } catch (e) {
      pausedSettingsSnapshot = { ...currentSettings };
    }
    stopRotator(false).catch((err) =>
      console.error('Failed to pause rotator for popup:', err)
    );
  } else {
    wasRunningBeforePopup = false;
    pausedSettingsSnapshot = null;
  }

  port.onDisconnect.addListener(() => {
    popupOpen = false;
    const options = pendingStartOptions;
    pendingStartOptions = null;
    if (options) {
      startRotator(options).catch((err) =>
        console.error('Failed to start deferred rotator:', err)
      );
    } else if (wasRunningBeforePopup && pausedSettingsSnapshot) {
      const resumeOptions = pausedSettingsSnapshot;
      wasRunningBeforePopup = false;
      pausedSettingsSnapshot = null;
      startRotator(resumeOptions).catch((err) =>
        console.error('Failed to resume rotator after popup:', err)
      );
      return;
    }

    wasRunningBeforePopup = false;
    pausedSettingsSnapshot = null;
  });
});
