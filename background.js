let timerId = null;
let intervalMs = 5000;
let isRunning = false;
let rotationTargets = [];
let restoring = false;
let ensuredWindowId = null;
let badgeTimer = null;
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
const manifestVersion = (typeof chrome !== 'undefined' &&
  chrome.runtime &&
  typeof chrome.runtime.getManifest === 'function' &&
  chrome.runtime.getManifest().version) || '1.0.0';
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

  const normalized = normalizeEntries(entries);
  const firstUrl = normalized[0]?.url ? normalizedMatchUrl(normalized[0].url) : 'about:blank';

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

const defaultSettings = {
  intervalSec: 5,
  autoStart: false,
  useCustomList: false,
  customEntries: [],
  openCustomTabs: true,
  enableRefreshFlags: false,
  customRawText: '',
  useDedicatedWindow: false,
  shuffle: false,
  excludeDomains: '',
  badgeCountdown: true
};

let currentSettings = { ...defaultSettings };

function normalizeEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries
    .map((entry) => {
      if (typeof entry === 'string') {
        return { url: entry.trim(), name: '', refresh: false, intervalSec: null, refreshDelaySec: 0 };
      }
      const url = typeof entry?.url === 'string' ? entry.url.trim() : '';
      const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
      const refresh = Boolean(entry?.refresh);
      const intervalRaw = Number(entry?.intervalSec);
      const intervalSec = Number.isFinite(intervalRaw) && intervalRaw >= 1 ? intervalRaw : null;
      const refreshDelayRaw = Number(entry?.refreshDelaySec);
      const refreshDelaySec = Number.isFinite(refreshDelayRaw) && refreshDelayRaw >= 0 ? refreshDelayRaw : 0;
      return { url, name, refresh, intervalSec, refreshDelaySec };
    })
    .filter((entry) => entry.url.length > 0);
}

function normalizedMatchUrl(candidate) {
  if (!candidate) {
    return '';
  }

  let url = candidate.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  return url;
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

    if (tabParsed.hostname === targetParsed.hostname) {
      return true;
    }

    // host contains match for cases like google.com vs www.google.com
    if (tabParsed.hostname.endsWith(`.${targetParsed.hostname}`)) {
      return true;
    }

    return normalizedTab.startsWith(normalizedTarget);
  } catch (error) {
    return normalizedTab.startsWith(normalizedTarget) || normalizedTab.includes(targetUrl);
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

async function prepareCustomTargets(entries, openMissing) {
  const normalized = normalizeEntries(entries);

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

    let tab = existingTabs.find(
      (t) =>
        typeof t.url === 'string' &&
        tabMatches(t.url, normalizedUrl) &&
        !usedIds.has(t.id)
    );

    if (!tab && openMissing) {
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
    const targetUrl = normalizedMatchUrl(entry.url);
    const found = tabs.find(
      (t) =>
        typeof t.url === 'string' &&
        !isExcluded(t.url, excluded) &&
        tabMatches(t.url, targetUrl)
    );

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
      if (tab && !usedIds.has(tab.id) && !isExcluded(tab.url, excluded)) {
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
  const tabUrl = typeof tab.url === 'string' ? tab.url : '';
  for (const entry of currentSettings.customEntries) {
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
      // Попробуем пересоздать список и недостающие вкладки
      rotationTargets = await prepareCustomTargets(currentSettings.customEntries, true);
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
      candidates = tabs
        .filter((t) => !isExcluded(t.url, excluded))
        .map((t) => ({ tab: t, refresh: false, intervalSec: null }));
      if (candidates.length < 2) {
        return;
      }
    }

    lastCandidates = candidates;

    const activeIndex = candidates.findIndex((t) => t.tab.id === activeTab.id);
    let nextIndex;

    if (currentSettings.shuffle) {
      const pool = candidates.filter((_, idx) => idx !== activeIndex);
      const next = pool[Math.floor(Math.random() * pool.length)];
      nextIndex = candidates.indexOf(next);
    } else {
      const startIndex = activeIndex === -1 ? 0 : activeIndex;
      nextIndex = (startIndex + 1) % candidates.length;
    }

    const next = candidates[nextIndex];

    await chrome.tabs.update(next.tab.id, { active: true });

    if (currentSettings.enableRefreshFlags && next.refresh) {
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
  normalized.badgeCountdown = Boolean(
    normalized.badgeCountdown === undefined ? currentSettings.badgeCountdown : normalized.badgeCountdown
  );
  normalized.customRawText = typeof normalized.customRawText === 'string'
    ? normalized.customRawText
    : currentSettings.customRawText || '';

  if (!normalized.useCustomList) {
    normalized.openCustomTabs = false;
    normalized.enableRefreshFlags = false;
    normalized.customRawText = '';
    normalized.useDedicatedWindow = false;
    normalized.shuffle = false;
  }

  currentSettings = normalized;
  intervalMs = normalized.intervalSec * 1000;

  if (currentSettings.useDedicatedWindow && currentSettings.useCustomList) {
    const { id } = await ensureDedicatedWindow(currentSettings.customEntries);
    ensuredWindowId = id;
  } else {
    ensuredWindowId = null;
  }

  rotationTargets = normalized.useCustomList
    ? await prepareCustomTargets(normalized.customEntries, normalized.openCustomTabs)
    : [];

  if (normalized.useCustomList && rotationTargets.length < 2) {
    // если вкладок нет или меньше двух, принудительно создаём недостающие
    rotationTargets = await prepareCustomTargets(normalized.customEntries, true);
    normalized.openCustomTabs = true;
  }

  isRunning = true;
  chrome.action.setIcon({ path: iconOn }).catch(() => {});
  scheduleNextTick(intervalMs);

  await persistState({ isRunning: true });
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
  } else {
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
  }
  timerId = setTimeout(() => {
    rotateTabs().catch((err) => console.error('rotateTabs error', err));
  }, safeDelay);
}

async function restoreFromStorage() {
  if (restoring || isRunning) {
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
      'badgeCountdown'
    ]);

    let entriesFromStorage = Array.isArray(data.customEntries) && data.customEntries.length
      ? data.customEntries
      : data.customUrls || [];

    if ((!entriesFromStorage || !entriesFromStorage.length) && data.configBackup?.settings?.customEntries) {
      entriesFromStorage = data.configBackup.settings.customEntries;
    }

    currentSettings = {
      ...defaultSettings,
      ...data,
      customEntries: entriesFromStorage,
      customRawText: typeof data.customRawText === 'string'
        ? data.customRawText
        : Array.isArray(entriesFromStorage)
          ? entriesFromStorage.map((item) => (typeof item === 'string' ? item : item.url || '')).join('\n')
          : '',
      useDedicatedWindow: Boolean(data.useDedicatedWindow),
      shuffle: Boolean(data.shuffle),
      excludeDomains: typeof data.excludeDomains === 'string' ? data.excludeDomains : '',
      badgeCountdown: data.badgeCountdown !== undefined ? Boolean(data.badgeCountdown) : true
    };

    ensuredWindowId = data.ensuredWindowId || data.targetWindowId || null;

    if (data.isRunning || data.autoStart) {
      await startRotator(currentSettings);
    } else {
      chrome.action.setIcon({ path: iconOff }).catch(() => {});
    }
  } catch (error) {
    console.error('Не удалось восстановить состояние из storage:', error);
  } finally {
    restoring = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === 'START') {
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
        badgeCountdown
      } = message;

      if (!Number.isFinite(Number(intervalSec)) || Number(intervalSec) < 1) {
        sendResponse({ ok: false, error: 'INVALID_INTERVAL' });
        return;
      }

    const normalizedEntries = Array.isArray(customEntries) && customEntries.length
      ? customEntries
      : customUrls || [];

      await startRotator({
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
        badgeCountdown
      });

      sendResponse({ ok: true });
    } else if (message.type === 'STOP') {
      await stopRotator();
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

restoreFromStorage();
