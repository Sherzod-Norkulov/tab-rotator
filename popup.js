document.addEventListener('DOMContentLoaded', () => {
  const isStandalone = new URLSearchParams(window.location.search).get('standalone') === '1';
  // Keep service worker alive while popup is open
  const popupPort = chrome.runtime.connect({ name: isStandalone ? 'panel' : 'popup' });
  const intervalInput = document.getElementById('interval');
  const startBtn = document.getElementById('start');
  const stopBtn = document.getElementById('stop');
  const statusEl = document.getElementById('status');
  const openInWindowBtn = document.getElementById('openInWindow');
  const darkModeToggleBtn = document.getElementById('darkModeToggle');
  const autoStartCheckbox = document.getElementById('autoStart');
  const pausePolicySelect = document.getElementById('pausePolicy');
  const useCustomListCheckbox = document.getElementById('useCustomList');
  const openCustomTabsCheckbox = document.getElementById('openCustomTabs');
  const useDedicatedWindowCheckbox = document.getElementById('useDedicatedWindow');
  const badgeCountdownCheckbox = document.getElementById('badgeCountdown');
  const allowRotationWhilePopupOpenCheckbox = document.getElementById('allowRotationWhilePopupOpen');
  const orderModeSelect = document.getElementById('orderMode');
  const excludeDomainsInput = document.getElementById('excludeDomains');
  const noRefreshDomainsInput = document.getElementById('noRefreshDomains');
  const excludeToggle = document.getElementById('excludeToggle');
  const profileSelect = document.getElementById('profileSelect');
  const applyProfileBtn = document.getElementById('applyProfile');
  const saveProfileBtn = document.getElementById('saveProfile');
  const saveAsProfileBtn = document.getElementById('saveAsProfile');
  const editProfileBtn = document.getElementById('editProfile');
  const deleteProfileBtn = document.getElementById('deleteProfile');
  const exportProfileBtn = document.getElementById('exportProfile');
  const importProfileInput = document.getElementById('importProfile');
  const footerVersionEl = document.getElementById('footerVersion');
  const entriesContainer = document.getElementById('entries');
  const addEntryBtn = document.getElementById('addEntry');
  const refreshIntervalInput = document.getElementById('refreshInterval');
  const activeTabUrlEl = document.getElementById('activeTabUrl');
  const startRefreshCurrentBtn = document.getElementById('startRefreshCurrent');
  const resetRefreshTasksBtn = document.getElementById('resetRefreshTasks');
  const refreshTasksContainer = document.getElementById('refreshTasks');
  const storageArea = chrome.storage.local;
  let profiles = [];
  let refreshTasks = [];
  let activeTabInfo = null;
  let uiRunning = false;
  const NO_PROFILE_SELECTED = -1;
  let lastSelectedProfileIndex = NO_PROFILE_SELECTED;
  let autoPersistTimer = null;
  let defaultConfigCache = null;
  let isInitializing = true;

  const t = (key, args = []) => {
    const msg = chrome.i18n?.getMessage ? chrome.i18n.getMessage(key, args) : '';
    return msg || key;
  };

  function applyI18n() {
    const uiLang = (chrome.i18n?.getUILanguage?.() || navigator.language || 'en').split('-')[0];
    document.documentElement.lang = uiLang;
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.dataset.i18n;
      if (!key) return;
      const translated = t(key);
      if (!translated) return;
      const attr = el.dataset.i18nAttr;
      if (attr) {
        attr.split(',').forEach((attrName) => {
          const name = attrName.trim();
          if (!name) return;
          if (name === 'textContent') {
            el.textContent = translated;
          } else {
            el.setAttribute(name, translated);
          }
        });
      } else {
        el.textContent = translated;
      }
    });
  }

  function setStatus(text, type) {
    statusEl.textContent = text;
    statusEl.className = type === 'ok' ? 'ok' : 'error';
  }

  function flashButton(btn) {
    if (!btn) return;
    btn.classList.remove('flash');
    // force reflow to restart animation
    void btn.offsetWidth;
    btn.classList.add('flash');
  }

  function setRunningUi(isRunning) {
    uiRunning = isRunning;
    startBtn.disabled = isRunning;
    stopBtn.disabled = !isRunning;
    startBtn.classList.toggle('primary', !isRunning);
    startBtn.classList.toggle('secondary', isRunning);
    stopBtn.classList.toggle('danger', isRunning);
    stopBtn.classList.toggle('secondary', !isRunning);
  }

  // initial visual state
  setRunningUi(false);
  applyI18n();
  if (footerVersionEl && chrome.runtime?.getManifest) {
    const version = chrome.runtime.getManifest().version;
    if (version) {
      footerVersionEl.textContent = t('footer_version', [version]);
    }
  }
  function applyDarkMode(enabled) {
    document.body.classList.toggle('dark', Boolean(enabled));
    if (darkModeToggleBtn) {
      darkModeToggleBtn.textContent = enabled ? '☀' : '☾';
    }
  }

  storageArea.get(['darkMode'], (data) => {
    applyDarkMode(Boolean(data.darkMode));
  });

  darkModeToggleBtn?.addEventListener('click', async () => {
    const enabled = !document.body.classList.contains('dark');
    applyDarkMode(enabled);
    await storageArea.set({ darkMode: enabled });
  });

  if (openInWindowBtn) {
    if (isStandalone) {
      openInWindowBtn.style.display = 'none';
    } else {
      openInWindowBtn.addEventListener('click', () => {
        chrome.windows
          .create({
            url: chrome.runtime.getURL('popup.html?standalone=1'),
            type: 'popup',
            width: 420,
            height: 720
          })
          .catch(() => {});
      });
    }
  }

  const parseProfileIndex = (value) => {
    if (value === '' || value === null || value === undefined) {
      return NO_PROFILE_SELECTED;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? NO_PROFILE_SELECTED : parsed;
  };

  const configFromData = (src = {}) => {
    const entries = Array.isArray(src.customEntries) && src.customEntries.length
      ? src.customEntries
      : src.customUrls || [];
    return {
      intervalSec: Number.isFinite(src.intervalSec) ? src.intervalSec : 5,
      autoStart: Boolean(src.autoStart),
      useCustomList: Boolean(src.useCustomList) || entries.length > 0,
      customEntries: entries,
      openCustomTabs: src.openCustomTabs !== undefined ? Boolean(src.openCustomTabs) : true,
      enableRefreshFlags: src.enableRefreshFlags !== undefined ? Boolean(src.enableRefreshFlags) : true,
      customRawText: typeof src.customRawText === 'string' ? src.customRawText : '',
      useDedicatedWindow: Boolean(src.useDedicatedWindow),
      shuffle: Boolean(src.shuffle),
      excludeDomains: typeof src.excludeDomains === 'string' ? src.excludeDomains : '',
      noRefreshDomains: typeof src.noRefreshDomains === 'string' ? src.noRefreshDomains : '',
      badgeCountdown: src.badgeCountdown !== undefined ? Boolean(src.badgeCountdown) : true,
      allowRotationWhilePopupOpen: Boolean(src.allowRotationWhilePopupOpen),
      pausePolicy: ['never', 'active', 'idle'].includes(src.pausePolicy) ? src.pausePolicy : 'never',
      refreshTasks: Array.isArray(src.refreshTasks) ? src.refreshTasks : []
    };
  };

  const ICONS = {
    chevronUp: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9l-5 5M12 9l5 5"/></svg>',
    chevronDown: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15l-5 -5M12 15l5 -5"/></svg>'
  };

  function createEntryRow(entry = {}) {
    const row = document.createElement('div');
    row.className = 'entry';

    const order = document.createElement('div');
    order.className = 'order-controls';
    const orderLabel = document.createElement('span');
    orderLabel.className = 'order-label';
    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'secondary small order-btn';
    upBtn.innerHTML = ICONS.chevronUp;
    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'secondary small order-btn';
    downBtn.innerHTML = ICONS.chevronDown;
    const btnWrap = document.createElement('div');
    btnWrap.className = 'order-buttons';
    btnWrap.append(upBtn, downBtn);
    order.append(orderLabel, btnWrap);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = t('entry_name_placeholder');
    nameInput.value = entry.name || '';
    nameInput.className = 'entry-name';

    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.placeholder = t('entry_url_placeholder');
    urlInput.value = entry.url || '';
    urlInput.className = 'entry-url';

    const controls = document.createElement('div');
    controls.className = 'entry-controls';

    const refreshCheckbox = document.createElement('input');
    refreshCheckbox.type = 'checkbox';
    refreshCheckbox.dataset.role = 'refresh';
    refreshCheckbox.checked = Boolean(entry.refresh);
    refreshCheckbox.style.gridArea = 'rcheck';
    refreshCheckbox.style.justifySelf = 'end';
    const refreshLabel = document.createElement('span');
    refreshLabel.className = 'control-label';
    refreshLabel.style.gridArea = 'rlabel';
    refreshLabel.textContent = t('entry_refresh');
    const refreshDelayInput = document.createElement('input');
    refreshDelayInput.type = 'number';
    refreshDelayInput.min = '0';
    refreshDelayInput.step = '1';
    refreshDelayInput.style.width = '80px';
    refreshDelayInput.value = Number.isFinite(entry.refreshDelaySec) ? entry.refreshDelaySec : 1;
    refreshDelayInput.disabled = !refreshCheckbox.checked;
    refreshDelayInput.classList.add(refreshDelayInput.disabled ? 'field-disabled' : 'field-enabled');
    const refreshDelayWrap = document.createElement('div');
    refreshDelayWrap.className = 'suffix-input';
    refreshDelayWrap.style.gridArea = 'rinput';
    const refreshSuffix = document.createElement('span');
    refreshSuffix.className = 'suffix-label';
    refreshSuffix.textContent = t('suffix_seconds');
    refreshDelayWrap.append(refreshDelayInput, refreshSuffix);

    refreshCheckbox.addEventListener('change', () => {
      refreshDelayInput.disabled = !refreshCheckbox.checked;
      refreshDelayInput.classList.remove('field-enabled', 'field-disabled');
      refreshDelayInput.classList.add(refreshDelayInput.disabled ? 'field-disabled' : 'field-enabled');
    });

    const timerCheckbox = document.createElement('input');
    timerCheckbox.type = 'checkbox';
    timerCheckbox.dataset.role = 'timer-toggle';
    timerCheckbox.checked = Number.isFinite(entry.intervalSec) && entry.intervalSec >= 1;
    timerCheckbox.style.gridArea = 'tcheck';
    timerCheckbox.style.justifySelf = 'end';
    const timerLabel = document.createElement('span');
    timerLabel.className = 'control-label';
    timerLabel.style.gridArea = 'tlabel';
    timerLabel.textContent = t('entry_custom_delay');
    const timerInput = document.createElement('input');
    timerInput.type = 'number';
    timerInput.min = '1';
    timerInput.step = '1';
    timerInput.style.width = '80px';
    timerInput.value =
      Number.isFinite(entry.intervalSec) && entry.intervalSec >= 1
        ? entry.intervalSec
        : intervalInput.value || 5;
    timerInput.disabled = !timerCheckbox.checked;
    timerInput.classList.add(timerInput.disabled ? 'field-disabled' : 'field-enabled');
    const timerWrap = document.createElement('div');
    timerWrap.className = 'suffix-input';
    timerWrap.style.gridArea = 'tinput';
    const timerSuffix = document.createElement('span');
    timerSuffix.className = 'suffix-label';
    timerSuffix.textContent = t('suffix_seconds');
    timerWrap.append(timerInput, timerSuffix);

    timerCheckbox.addEventListener('change', () => {
      timerInput.disabled = !timerCheckbox.checked;
      timerInput.classList.remove('field-enabled', 'field-disabled');
      timerInput.classList.add(timerInput.disabled ? 'field-disabled' : 'field-enabled');
    });

    const removeBtn = document.createElement('button');
    removeBtn.textContent = t('entry_delete');
    removeBtn.className = 'secondary small remove';
    removeBtn.title = t('entry_delete');
    removeBtn.style.gridArea = 'remove';
    removeBtn.style.justifySelf = 'center';
    removeBtn.style.minWidth = '90px';
    removeBtn.addEventListener('click', () => {
      row.remove();
      ensureAtLeastOneRow();
      refreshOrder();
      schedulePersist(parseProfileIndex(profileSelect.value));
    });

    controls.append(refreshCheckbox, refreshLabel, refreshDelayWrap, timerCheckbox, timerLabel, timerWrap, removeBtn);
    row.append(order, nameInput, urlInput, controls);

    upBtn.addEventListener('click', () => moveRow(row, -1));
    downBtn.addEventListener('click', () => moveRow(row, 1));
    return row;
  }

  function ensureAtLeastOneRow() {
    const rows = entriesContainer.querySelectorAll('.entry');
    if (rows.length === 0) {
      entriesContainer.appendChild(createEntryRow());
    }
    refreshOrder();
  }

  function refreshOrder() {
    const rows = Array.from(entriesContainer.querySelectorAll('.entry'));
    rows.forEach((r, i) => {
      const label = r.querySelector('.order-label');
      if (label) label.textContent = i + 1;
    });
  }

  function moveRow(row, delta) {
    const rows = Array.from(entriesContainer.querySelectorAll('.entry'));
    const idx = rows.indexOf(row);
    if (idx === -1) return;
    const target = idx + delta;
    if (target < 0 || target >= rows.length) return;
    if (delta < 0) {
      entriesContainer.insertBefore(row, rows[target]);
    } else {
      entriesContainer.insertBefore(rows[target], row);
    }
    refreshOrder();
    schedulePersist(parseProfileIndex(profileSelect.value));
  }

  function fillEntries(entries) {
    entriesContainer.innerHTML = '';
    if (!entries || !entries.length) {
      ensureAtLeastOneRow();
      return;
    }
    entries.forEach((entry) => {
      entriesContainer.appendChild(
        createEntryRow({
          url: typeof entry === 'string' ? entry : entry.url,
          name: typeof entry === 'object' && entry.name ? entry.name : '',
          refresh: typeof entry === 'object' && entry.refresh,
          refreshDelaySec:
            typeof entry === 'object' && Number.isFinite(entry.refreshDelaySec) && entry.refreshDelaySec >= 0
              ? entry.refreshDelaySec
              : 1,
          intervalSec:
            typeof entry === 'object' && Number.isFinite(entry.intervalSec) && entry.intervalSec >= 1
              ? entry.intervalSec
              : null
        })
      );
    });
    refreshOrder();
    schedulePersist(parseProfileIndex(profileSelect.value));
  }

  function collectEntries() {
    const rows = Array.from(entriesContainer.querySelectorAll('.entry'));
    return rows
      .map((row) => {
        const url = row.querySelector('.entry-url').value.trim();
        let name = row.querySelector('.entry-name').value.trim();
        const refresh = row.querySelector('input[data-role="refresh"]').checked;
        const numberInputs = row.querySelectorAll('input[type="number"]');
        const refreshDelayInput = numberInputs[0];
        const timerInput = numberInputs[1];
        const timerCheckbox = row.querySelector('input[data-role="timer-toggle"]');
        const refreshDelaySec =
          refresh && refreshDelayInput ? Math.max(0, Number(refreshDelayInput.value) || 0) : 0;
        const intervalSec =
          timerCheckbox && timerCheckbox.checked && timerInput
            ? Math.max(1, Number(timerInput.value) || 1)
            : null;

        if (!name) {
          name = url;
        }

        return { url, name, refresh, refreshDelaySec, intervalSec };
      })
      .filter((item) => item.url);
  }

  function renderRefreshTasks() {
    refreshTasksContainer.innerHTML = '';
    if (!refreshTasks.length) {
      const empty = document.createElement('div');
      empty.className = 'task-item';
      empty.textContent = t('status_refresh_empty');
      refreshTasksContainer.appendChild(empty);
      return;
    }

    refreshTasks.forEach((task) => {
      const row = document.createElement('div');
      row.className = 'task-item';
      const text = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = task.name || task.url;
      const url = document.createElement('div');
      url.className = 'task-url';
      url.textContent = t('task_details', [task.url, task.intervalSec]);
      text.append(title, url);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'secondary small';
      remove.textContent = t('entry_delete');
      remove.addEventListener('click', async () => {
        refreshTasks = refreshTasks.filter((item) => item.id !== task.id);
        await persistRefreshTasks();
      });
      row.append(text, remove);
      refreshTasksContainer.appendChild(row);
    });
  }

  function sendRefreshTasksToBackground() {
    chrome.runtime.sendMessage(
      {
        type: 'REFRESH_TASKS_SET',
        refreshTasks,
        noRefreshDomains: noRefreshDomainsInput.value
      },
      () => {}
    );
  }

  async function persistRefreshTasks() {
    await storageArea.set({ refreshTasks });
    renderRefreshTasks();
    sendRefreshTasksToBackground();
  }

  function loadActiveTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs?.[0];
      activeTabInfo = tab?.url ? { url: tab.url, title: tab.title || tab.url } : null;
      activeTabUrlEl.textContent = activeTabInfo?.url || t('status_refresh_no_tab');
    });
  }

  startRefreshCurrentBtn.addEventListener('click', async () => {
    const rawIntervalSec = Number(refreshIntervalInput.value);
    if (!Number.isFinite(rawIntervalSec) || rawIntervalSec < 1) {
      setStatus(t('status_interval_invalid'), 'error');
      return;
    }
    const intervalSec = rawIntervalSec;
    if (!activeTabInfo?.url) {
      setStatus(t('status_refresh_no_tab'), 'error');
      return;
    }
    const id = globalThis.crypto?.randomUUID
      ? `refresh-${globalThis.crypto.randomUUID()}`
      : `refresh-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const existing = refreshTasks.findIndex((task) => task.url === activeTabInfo.url);
    const task = {
      id: existing >= 0 ? refreshTasks[existing].id : id,
      url: activeTabInfo.url,
      name: activeTabInfo.title,
      intervalSec,
      enabled: true
    };
    if (existing >= 0) {
      refreshTasks[existing] = task;
    } else {
      refreshTasks.push(task);
    }
    await persistRefreshTasks();
    setStatus(t('status_refresh_saved'), 'ok');
  });

  resetRefreshTasksBtn.addEventListener('click', async () => {
    refreshTasks = [];
    await storageArea.set({ refreshTasks });
    renderRefreshTasks();
    chrome.runtime.sendMessage({ type: 'REFRESH_TASKS_RESET' }, () => {});
    setStatus(t('status_refresh_reset'), 'ok');
  });

  loadActiveTab();

  entriesContainer.addEventListener('input', () => schedulePersist(parseProfileIndex(profileSelect.value)));
  entriesContainer.addEventListener('change', () => schedulePersist(parseProfileIndex(profileSelect.value)));

  function setEntriesDisabled(disabled) {
    entriesContainer.querySelectorAll('input, button').forEach((el) => {
      el.disabled = disabled;
    });
    addEntryBtn.disabled = disabled;
    openCustomTabsCheckbox.disabled = disabled;
    useDedicatedWindowCheckbox.disabled = disabled;
  }

  function toggleCustomControls() {
    const enabled = useCustomListCheckbox.checked;
    setEntriesDisabled(!enabled);
  }

  const persistableFields = [
    intervalInput,
    autoStartCheckbox,
    useCustomListCheckbox,
    openCustomTabsCheckbox,
    useDedicatedWindowCheckbox,
    pausePolicySelect,
    orderModeSelect,
    badgeCountdownCheckbox,
    allowRotationWhilePopupOpenCheckbox,
    excludeDomainsInput,
    noRefreshDomainsInput,
    excludeToggle
  ];

  persistableFields.forEach((el) => {
    const eventName = el.tagName === 'INPUT' && el.type === 'number' ? 'input' : 'change';
    el.addEventListener(eventName, () => schedulePersist(parseProfileIndex(profileSelect.value)));
  });

  function toggleExcludeControls() {
    const enabled = excludeToggle.checked;
    excludeDomainsInput.disabled = !enabled;
    if (!enabled) {
      excludeDomainsInput.value = '';
    }
  }

  addEntryBtn.addEventListener('click', () => {
    entriesContainer.appendChild(createEntryRow());
    refreshOrder();
    schedulePersist(parseProfileIndex(profileSelect.value));
  });

  excludeToggle.addEventListener('change', toggleExcludeControls);

  function renderProfiles() {
    profileSelect.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = t('order_placeholder');
    profileSelect.appendChild(placeholder);
    profiles.forEach((p, idx) => {
      const opt = document.createElement('option');
      opt.value = idx;
      opt.textContent = p.name || `${t('prompt_profile_name_placeholder')} ${idx + 1}`;
      profileSelect.appendChild(opt);
    });
  }

  function applyConfig(cfg, silent = false) {
    if (!cfg) return;
    intervalInput.value = cfg.intervalSec || 5;
    autoStartCheckbox.checked = !!cfg.autoStart;

    const entriesExist = Array.isArray(cfg.customEntries) && cfg.customEntries.length > 0;
    const listEnabled = cfg.useCustomList !== undefined ? !!cfg.useCustomList : entriesExist;
    useCustomListCheckbox.checked = listEnabled;

    const openTabs = cfg.openCustomTabs !== undefined ? !!cfg.openCustomTabs : true;
    openCustomTabsCheckbox.checked = openTabs;

    useDedicatedWindowCheckbox.checked = !!cfg.useDedicatedWindow;
    pausePolicySelect.value = ['never', 'active', 'idle'].includes(cfg.pausePolicy)
      ? cfg.pausePolicy
      : 'never';
    orderModeSelect.value = cfg.shuffle ? 'shuffle' : 'sequential';
    badgeCountdownCheckbox.checked = cfg.badgeCountdown !== undefined ? !!cfg.badgeCountdown : true;
    if (allowRotationWhilePopupOpenCheckbox) {
      allowRotationWhilePopupOpenCheckbox.checked = !!cfg.allowRotationWhilePopupOpen;
    }
    excludeDomainsInput.value = cfg.excludeDomains || '';
    noRefreshDomainsInput.value = cfg.noRefreshDomains || '';
    excludeToggle.checked = (cfg.excludeDomains || '').length > 0;
    toggleExcludeControls();
    refreshTasks = Array.isArray(cfg.refreshTasks) ? cfg.refreshTasks : refreshTasks;
    renderRefreshTasks();
    fillEntries(cfg.customEntries || []);
    toggleCustomControls();
    if (!silent) {
      setStatus(t('status_profile_applied'), 'ok');
    }
  }

  storageArea.get(
    [
      'intervalSec',
      'isRunning',
      'autoStart',
      'useCustomList',
      'customEntries',
      'customUrls',
      'openCustomTabs',
      'enableRefreshFlags',
      'useDedicatedWindow',
      'shuffle',
      'excludeDomains',
      'noRefreshDomains',
      'allowRotationWhilePopupOpen',
      'pausePolicy',
      'badgeCountdown',
      'refreshTasks',
      'profiles',
      'selectedProfileIndex',
      'defaultConfig'
    ],
    (data) => {
      profiles = Array.isArray(data.profiles) ? data.profiles : [];
      refreshTasks = Array.isArray(data.refreshTasks) ? data.refreshTasks : [];
      renderRefreshTasks();
      renderProfiles();

      const storedProfileIndex = Number.isInteger(data.selectedProfileIndex)
        ? data.selectedProfileIndex
        : NO_PROFILE_SELECTED;

      const baseConfig = data.defaultConfig
        ? configFromData(data.defaultConfig)
        : configFromData(data);
      defaultConfigCache = baseConfig;

      if (storedProfileIndex >= 0 && storedProfileIndex < profiles.length) {
        profileSelect.value = String(storedProfileIndex);
        lastSelectedProfileIndex = storedProfileIndex;
        applyConfig(profiles[storedProfileIndex].config, true);
      } else {
        profileSelect.value = '';
        lastSelectedProfileIndex = NO_PROFILE_SELECTED;
        applyConfig(baseConfig, true);
      }

      if (data.isRunning) {
        setStatus(t('status_rotation_running'), 'ok');
      } else {
        setStatus(t('status_rotation_stopped'), 'error');
      }
      setRunningUi(Boolean(data.isRunning));
      isInitializing = false;
    }
  );

  useCustomListCheckbox.addEventListener('change', toggleCustomControls);

  function getCurrentConfig() {
    const excludeEnabled = excludeToggle.checked;
    return {
      intervalSec: Number(intervalInput.value) || 5,
      autoStart: autoStartCheckbox.checked,
      useCustomList: useCustomListCheckbox.checked,
      customEntries: collectEntries(),
      openCustomTabs: openCustomTabsCheckbox.checked,
      enableRefreshFlags: true,
      customRawText: '',
      useDedicatedWindow: useDedicatedWindowCheckbox.checked,
      shuffle: orderModeSelect.value === 'shuffle',
      excludeDomains: excludeEnabled ? excludeDomainsInput.value : '',
      noRefreshDomains: noRefreshDomainsInput.value,
      badgeCountdown: badgeCountdownCheckbox.checked,
      allowRotationWhilePopupOpen: allowRotationWhilePopupOpenCheckbox?.checked || false,
      pausePolicy: pausePolicySelect.value,
      refreshTasks
    };
  }

  function schedulePersist(selectedIdx = parseProfileIndex(profileSelect.value)) {
    if (isInitializing) {
      return;
    }
    if (autoPersistTimer) {
      clearTimeout(autoPersistTimer);
    }
    autoPersistTimer = setTimeout(() => {
      if (selectedIdx === NO_PROFILE_SELECTED) {
        persistCurrentFormState(NO_PROFILE_SELECTED).catch(() => {});
      } else if (selectedIdx >= 0 && selectedIdx < profiles.length) {
        storageArea.set({ selectedProfileIndex: selectedIdx }).catch(() => {});
        lastSelectedProfileIndex = selectedIdx;
      }
      if (refreshTasks.length) {
        sendRefreshTasksToBackground();
      }
    }, 150);
  }

  async function persistCurrentFormState(selectedIdx = parseProfileIndex(profileSelect.value)) {
    const config = getCurrentConfig();
    const safeIndex =
      Number.isInteger(selectedIdx) && selectedIdx >= 0 && selectedIdx < profiles.length
        ? selectedIdx
        : NO_PROFILE_SELECTED;
    lastSelectedProfileIndex = safeIndex;

    if (safeIndex === NO_PROFILE_SELECTED) {
      defaultConfigCache = { ...config };
      await storageArea.set({
        ...config,
        customEntries: config.customEntries,
        activeConfig: null,
        selectedProfileIndex: null,
        isRunning: uiRunning,
        defaultConfig: { ...config }
      });
    } else {
      await storageArea.set({ selectedProfileIndex: safeIndex });
    }
  }

  // Save: update selected profile without asking for name
  saveProfileBtn.addEventListener('click', async () => {
    const rawValue = profileSelect.value;
    const idx = parseProfileIndex(rawValue);
    if (rawValue === '' || idx < 0 || idx >= profiles.length) {
      setStatus(t('status_profile_select_first'), 'error');
      return;
    }
    profiles[idx].config = getCurrentConfig();
    await storageArea.set({ profiles, selectedProfileIndex: idx });
    lastSelectedProfileIndex = idx;
    const displayName = profiles[idx].name || `${t('prompt_profile_name_placeholder')} ${idx + 1}`;
    setStatus(t('status_profile_updated', [displayName]), 'ok');
    flashButton(saveProfileBtn);
  });

  // Save as: creates a new profile with provided name
  saveAsProfileBtn.addEventListener('click', async () => {
    const name = prompt(t('prompt_profile_name'), '');
    if (name === null) {
      setStatus(t('status_profile_save_cancel'), 'error');
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      setStatus(t('status_profile_name_required'), 'error');
      return;
    }
    const config = getCurrentConfig();
    const existingIdx = profiles.findIndex((p) => p.name === trimmed);
    if (existingIdx >= 0) {
      profiles[existingIdx].config = config;
    } else {
      profiles.push({ name: trimmed, config });
    }
    renderProfiles();
    const selectedIdx = existingIdx >= 0 ? existingIdx : profiles.length - 1;
    profileSelect.value = String(selectedIdx);
    lastSelectedProfileIndex = selectedIdx;
    await storageArea.set({ profiles, selectedProfileIndex: selectedIdx });
    setStatus(t('status_profile_saved', [trimmed]), 'ok');
    flashButton(saveAsProfileBtn);
  });

  deleteProfileBtn.addEventListener('click', async () => {
    const rawValue = profileSelect.value;
    const idx = parseProfileIndex(rawValue);
    if (rawValue === '' || idx < 0 || idx >= profiles.length) return;
    profiles.splice(idx, 1);
    renderProfiles();
    profileSelect.value = '';
    lastSelectedProfileIndex = NO_PROFILE_SELECTED;
    await storageArea.set({ profiles, selectedProfileIndex: null });
    if (defaultConfigCache) {
      applyConfig(defaultConfigCache, true);
    }
    await persistCurrentFormState(NO_PROFILE_SELECTED);
    setStatus(t('status_profile_deleted'), 'ok');
  });

  editProfileBtn.addEventListener('click', async () => {
    const rawValue = profileSelect.value;
    const idx = parseProfileIndex(rawValue);
    if (rawValue === '' || idx < 0 || idx >= profiles.length) {
      setStatus(t('status_profile_choose'), 'error');
      return;
    }
    const current = profiles[idx];
    const nameInput = prompt(
      t('prompt_profile_name'),
      current.name || `${t('prompt_profile_name_placeholder')} ${idx + 1}`
    );
    if (nameInput === null) {
      setStatus(t('prompt_profile_rename_cancel'), 'error');
      return;
    }
    const trimmed = nameInput.trim();
    if (!trimmed) {
      setStatus(t('status_profile_name_required'), 'error');
      return;
    }
    const cfg = getCurrentConfig();
    profiles[idx] = { ...current, name: trimmed, config: cfg };
    renderProfiles();
    profileSelect.value = String(idx);
    lastSelectedProfileIndex = idx;
    await storageArea.set({ profiles, selectedProfileIndex: idx });
    setStatus(t('status_profile_renamed', [trimmed]), 'ok');
    flashButton(editProfileBtn);
  });

  profileSelect.addEventListener('change', async () => {
    const rawValue = profileSelect.value;
    const idx = parseProfileIndex(rawValue);
    if (rawValue === '' || idx < 0 || idx >= profiles.length) {
      profileSelect.value = '';
      lastSelectedProfileIndex = NO_PROFILE_SELECTED;
      if (defaultConfigCache) {
        applyConfig(defaultConfigCache, true);
      }
      await persistCurrentFormState(NO_PROFILE_SELECTED);
      return;
    }
    applyConfig(profiles[idx].config, true);
    lastSelectedProfileIndex = idx;
    await storageArea.set({ selectedProfileIndex: idx });
  });

  applyProfileBtn.addEventListener('click', async () => {
    const selectedValue = profileSelect.value;
    const idx = parseProfileIndex(selectedValue);
    if (selectedValue === '' || idx < 0 || idx >= profiles.length) {
      // if no profile selected, keep current form values
      flashButton(applyProfileBtn);
      setStatus(t('status_profile_default'), 'error');
      return;
    }
    const profileName = profiles[idx].name || `${t('prompt_profile_name_placeholder')} ${idx + 1}`;
    const cfg = profiles[idx].config;
    applyConfig(cfg);
    lastSelectedProfileIndex = idx;
    await storageArea.set({ selectedProfileIndex: idx });
    flashButton(applyProfileBtn);
    setStatus(
      t(
        'status_profile_applied_named',
        [profileName]
      ),
      'ok'
    );
  });

  exportProfileBtn.addEventListener('click', () => {
    const rawValue = profileSelect.value;
    const idx = parseProfileIndex(rawValue);
    let payload;
    let name = 'current';
    if (rawValue !== '' && idx >= 0 && idx < profiles.length) {
      payload = {
        profiles: [profiles[idx]]
      };
      name = profiles[idx].name || `profile-${idx + 1}`;
    } else {
      setStatus(t('status_profile_select_first'), 'error');
      return;
    }

    const data = JSON.stringify(payload, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tab-rotator-${name}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(t('status_export_ready'), 'ok');
  });

  // --- Imported profile JSON validation ---------------------------------
  // Reasonable ceilings for user-imported JSON. Chrome's storage.local quota is
  // ~10 MB; we still want to refuse suspicious/runaway inputs early to keep the
  // UI responsive and protect the storage area from accidental/malicious bloat.
  const IMPORT_MAX_BYTES = 512 * 1024;            // 512 KB raw JSON text
  const IMPORT_MAX_PROFILES = 100;
  const IMPORT_MAX_ENTRIES_PER_PROFILE = 500;
  const IMPORT_MAX_STRING_LEN = 4096;              // per single string field
  const IMPORT_MAX_NAME_LEN = 200;

  function safeStr(value, maxLen = IMPORT_MAX_STRING_LEN) {
    if (typeof value !== 'string') return '';
    return value.length > maxLen ? value.slice(0, maxLen) : value;
  }

  function sanitizeEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const url = safeStr(raw.url).trim();
    if (!url) return null;
    const entry = {
      url,
      name: safeStr(raw.name, IMPORT_MAX_NAME_LEN).trim(),
      refresh: Boolean(raw.refresh)
    };
    const intervalRaw = Number(raw.intervalSec);
    entry.intervalSec = Number.isFinite(intervalRaw) && intervalRaw >= 1 ? intervalRaw : null;
    const delayRaw = Number(raw.refreshDelaySec);
    entry.refreshDelaySec = Number.isFinite(delayRaw) && delayRaw >= 0 ? delayRaw : 0;
    return entry;
  }

  function sanitizeConfig(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const intervalRaw = Number(raw.intervalSec);
    const cfg = {
      intervalSec: Number.isFinite(intervalRaw) && intervalRaw >= 1 ? intervalRaw : 5,
      autoStart: Boolean(raw.autoStart),
      useCustomList: Boolean(raw.useCustomList),
      openCustomTabs: raw.openCustomTabs !== undefined ? Boolean(raw.openCustomTabs) : true,
      enableRefreshFlags: raw.enableRefreshFlags !== undefined ? Boolean(raw.enableRefreshFlags) : true,
      useDedicatedWindow: Boolean(raw.useDedicatedWindow),
      shuffle: Boolean(raw.shuffle),
      excludeDomains: safeStr(raw.excludeDomains),
      noRefreshDomains: safeStr(raw.noRefreshDomains),
      badgeCountdown: raw.badgeCountdown !== undefined ? Boolean(raw.badgeCountdown) : true,
      allowRotationWhilePopupOpen: Boolean(raw.allowRotationWhilePopupOpen),
      customRawText: safeStr(raw.customRawText),
      pausePolicy: ['never', 'active', 'idle'].includes(raw.pausePolicy) ? raw.pausePolicy : 'never'
    };
    const rawEntries = Array.isArray(raw.customEntries) ? raw.customEntries : [];
    const capped = rawEntries.slice(0, IMPORT_MAX_ENTRIES_PER_PROFILE);
    cfg.customEntries = capped.map(sanitizeEntry).filter(Boolean);
    const rawTasks = Array.isArray(raw.refreshTasks) ? raw.refreshTasks : [];
    cfg.refreshTasks = rawTasks
      .slice(0, IMPORT_MAX_ENTRIES_PER_PROFILE)
      .map((task) => {
        if (!task || typeof task !== 'object') return null;
        const interval = Number(task.intervalSec);
        const url = safeStr(task.url).trim();
        if (!url || !Number.isFinite(interval) || interval < 1) return null;
        return {
          id: safeStr(task.id, IMPORT_MAX_NAME_LEN).trim() || `imported-${Date.now()}`,
          url,
          name: safeStr(task.name, IMPORT_MAX_NAME_LEN).trim(),
          intervalSec: interval,
          enabled: task.enabled !== false
        };
      })
      .filter(Boolean);
    return cfg;
  }

  function validateImportedProfilesJson(text) {
    if (typeof text !== 'string' || text.length === 0) {
      return { ok: false, reason: 'empty' };
    }
    if (text.length > IMPORT_MAX_BYTES) {
      return { ok: false, reason: 'too-large' };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { ok: false, reason: 'invalid-json' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'not-object' };
    }

    const result = { profiles: [], currentConfig: null };

    if (Array.isArray(parsed.profiles)) {
      const capped = parsed.profiles.slice(0, IMPORT_MAX_PROFILES);
      for (const p of capped) {
        if (!p || typeof p !== 'object') continue;
        const cfg = sanitizeConfig(p.config);
        if (!cfg) continue;
        const name = safeStr(p.name, IMPORT_MAX_NAME_LEN).trim();
        if (!name) continue;
        result.profiles.push({ name, config: cfg });
      }
    }

    if (parsed.current && typeof parsed.current === 'object') {
      result.currentConfig = sanitizeConfig(parsed.current);
    } else if (
      !result.profiles.length &&
      typeof parsed.name === 'string' &&
      parsed.intervalSec !== undefined
    ) {
      const cfg = sanitizeConfig(parsed);
      if (cfg) {
        result.currentConfig = cfg;
        result.singleProfileName = safeStr(parsed.name, IMPORT_MAX_NAME_LEN).trim();
      }
    }

    if (!result.profiles.length && !result.currentConfig) {
      return { ok: false, reason: 'no-usable-data' };
    }
    return { ok: true, value: result };
  }

  importProfileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      if (typeof file.size === 'number' && file.size > IMPORT_MAX_BYTES) {
        setStatus(t('status_import_fail'), 'error');
        return;
      }
      const text = await file.text();
      const validation = validateImportedProfilesJson(text);
      if (!validation.ok) {
        setStatus(t('status_import_fail'), 'error');
        return;
      }

      const { profiles: validatedProfiles, currentConfig, singleProfileName } = validation.value;
      const importedName =
        (file.name && file.name.replace(/\.[^/.]+$/, '')) || t('imported_profile_name');

      profiles = Array.isArray(profiles) ? profiles : [];
      let appliedConfig = null;
      let selectedIndex = 0;

      if (validatedProfiles.length) {
        profiles = validatedProfiles;
        appliedConfig = profiles[0]?.config || null;
        selectedIndex = 0;
      } else if (currentConfig) {
        const name = singleProfileName || importedName;
        profiles.push({ name, config: currentConfig });
        appliedConfig = currentConfig;
        selectedIndex = profiles.length - 1;
      }

      if (appliedConfig) {
        applyConfig(appliedConfig);
        lastSelectedProfileIndex = profiles.length ? selectedIndex : NO_PROFILE_SELECTED;
        if (selectedIndex >= 0) {
          await storageArea.set({
            activeConfig: { ...appliedConfig },
            isRunning: false,
            selectedProfileIndex: selectedIndex
          });
        } else {
          defaultConfigCache = appliedConfig;
          await storageArea.set({
            ...appliedConfig,
            customEntries: appliedConfig.customEntries,
            isRunning: false,
            defaultConfig: appliedConfig,
            selectedProfileIndex: null
          });
        }
      }

      await storageArea.set({
        profiles,
        selectedProfileIndex: profiles.length ? selectedIndex : null
      });
      lastSelectedProfileIndex = profiles.length ? selectedIndex : NO_PROFILE_SELECTED;
      renderProfiles();
      if (profiles.length) {
        profileSelect.value = String(selectedIndex);
        if (appliedConfig) {
          await persistCurrentFormState(selectedIndex);
        }
      } else {
        profileSelect.value = '';
      }
      setStatus(t('status_import_ok'), 'ok');
    } catch (err) {
      setStatus(t('status_import_fail'), 'error');
    } finally {
      importProfileInput.value = '';
    }
  });

  startBtn.addEventListener('click', () => {
    const cfg = getCurrentConfig();
    const selectedIdx = parseProfileIndex(profileSelect.value);
    lastSelectedProfileIndex =
      selectedIdx >= 0 && selectedIdx < profiles.length ? selectedIdx : NO_PROFILE_SELECTED;
    startBtn.disabled = true;
    stopBtn.disabled = true;

    if (!Number.isFinite(cfg.intervalSec) || cfg.intervalSec < 1) {
      setStatus(t('status_interval_invalid'), 'error');
      setRunningUi(false);
      return;
    }

    if (cfg.useCustomList && (!cfg.customEntries.length || cfg.customEntries.length < 2)) {
      setStatus(t('status_list_too_short'), 'error');
      setRunningUi(false);
      return;
    }

    const payload = { ...cfg };

    if (lastSelectedProfileIndex === NO_PROFILE_SELECTED) {
      defaultConfigCache = payload;
      storageArea
        .set({
          ...payload,
          activeConfig: null,
          isRunning: true,
          selectedProfileIndex: null,
          defaultConfig: payload
        })
        .catch(() => {});
    } else {
      storageArea
        .set({
          activeConfig: payload,
          isRunning: true,
          selectedProfileIndex: lastSelectedProfileIndex
        })
        .catch(() => {});
    }

    chrome.runtime.sendMessage(
      { type: 'START', ...payload },
      (response) => {
        if (chrome.runtime.lastError) {
          setStatus(
            t('status_error_prefix', [chrome.runtime.lastError.message]),
            'error'
          );
          setRunningUi(false);
          return;
        }

        if (response && response.ok) {
          const listInfo = cfg.useCustomList
            ? t('list_info_custom', [cfg.customEntries.length])
            : t('list_info_all_tabs');
          const statusKey = response.deferred
            ? 'status_rotation_started_deferred'
            : 'status_rotation_started';
          setStatus(t(statusKey, [listInfo]), 'ok');
          setRunningUi(true);
        } else if (response && response.error === 'INVALID_INTERVAL') {
          setStatus(t('status_interval_invalid'), 'error');
          setRunningUi(false);
        } else {
          setStatus(t('status_rotation_start_fail'), 'error');
          setRunningUi(false);
        }
      }
    );
  });

  stopBtn.addEventListener('click', () => {
    stopBtn.disabled = true;
    chrome.runtime.sendMessage({ type: 'STOP' }, (response) => {
      if (chrome.runtime.lastError) {
        setStatus(
          t('status_error_prefix', [chrome.runtime.lastError.message]),
          'error'
        );
        setRunningUi(true);
        return;
      }

      if (response && response.ok) {
        setStatus(t('status_rotation_stopped'), 'error');
        setRunningUi(false);
      } else {
        setStatus(t('status_rotation_stop_fail'), 'error');
        setRunningUi(true);
      }
    });
  });
});
