document.addEventListener('DOMContentLoaded', () => {
  const intervalInput = document.getElementById('interval');
  const startBtn = document.getElementById('start');
  const stopBtn = document.getElementById('stop');
  const statusEl = document.getElementById('status');
  const autoStartCheckbox = document.getElementById('autoStart');
  const useCustomListCheckbox = document.getElementById('useCustomList');
  const openCustomTabsCheckbox = document.getElementById('openCustomTabs');
  const useDedicatedWindowCheckbox = document.getElementById('useDedicatedWindow');
  const badgeCountdownCheckbox = document.getElementById('badgeCountdown');
  const orderModeSelect = document.getElementById('orderMode');
  const excludeDomainsInput = document.getElementById('excludeDomains');
  const excludeToggle = document.getElementById('excludeToggle');
  const profileSelect = document.getElementById('profileSelect');
  const applyProfileBtn = document.getElementById('applyProfile');
  const saveProfileBtn = document.getElementById('saveProfile');
  const saveAsProfileBtn = document.getElementById('saveAsProfile');
  const editProfileBtn = document.getElementById('editProfile');
  const deleteProfileBtn = document.getElementById('deleteProfile');
  const exportProfileBtn = document.getElementById('exportProfile');
  const importProfileInput = document.getElementById('importProfile');
  const entriesContainer = document.getElementById('entries');
  const addEntryBtn = document.getElementById('addEntry');
  const storageArea = chrome.storage.local;
  let profiles = [];
  let uiRunning = false;

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

  function createEntryRow(entry = {}) {
    const row = document.createElement('div');
    row.className = 'entry';

    const order = document.createElement('div');
    order.className = 'order-controls';
    const orderLabel = document.createElement('span');
    orderLabel.className = 'order-label';
    const upBtn = document.createElement('button');
    upBtn.className = 'secondary small';
    upBtn.textContent = '▲';
    const downBtn = document.createElement('button');
    downBtn.className = 'secondary small';
    downBtn.textContent = '▼';
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
    orderModeSelect.value = cfg.shuffle ? 'shuffle' : 'sequential';
    badgeCountdownCheckbox.checked = cfg.badgeCountdown !== undefined ? !!cfg.badgeCountdown : true;
    excludeDomainsInput.value = cfg.excludeDomains || '';
    excludeToggle.checked = (cfg.excludeDomains || '').length > 0;
    toggleExcludeControls();
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
      'badgeCountdown',
      'profiles'
    ],
    (data) => {
      if (data.intervalSec) {
        intervalInput.value = data.intervalSec;
      }

      autoStartCheckbox.checked = Boolean(data.autoStart);
      useCustomListCheckbox.checked = Boolean(data.useCustomList);
      openCustomTabsCheckbox.checked =
        data.openCustomTabs !== undefined ? Boolean(data.openCustomTabs) : true;
      useDedicatedWindowCheckbox.checked = Boolean(data.useDedicatedWindow);
      orderModeSelect.value = data.shuffle ? 'shuffle' : 'sequential';
      badgeCountdownCheckbox.checked =
        data.badgeCountdown !== undefined ? Boolean(data.badgeCountdown) : true;

      const excludeValue = data.excludeDomains || '';
      excludeDomainsInput.value = excludeValue;
      excludeToggle.checked = excludeValue.length > 0;
      toggleExcludeControls();

      profiles = Array.isArray(data.profiles) ? data.profiles : [];
      renderProfiles();

      const entries = Array.isArray(data.customEntries) && data.customEntries.length
        ? data.customEntries
        : data.customUrls || [];

      fillEntries(entries);
      toggleCustomControls();

      if (data.isRunning) {
        setStatus(t('status_rotation_running'), 'ok');
      } else {
        setStatus(t('status_rotation_stopped'), 'error');
      }
      setRunningUi(Boolean(data.isRunning));
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
      badgeCountdown: badgeCountdownCheckbox.checked
    };
  }

  // Save: update selected profile without asking for name
  saveProfileBtn.addEventListener('click', async () => {
    const idx = Number(profileSelect.value);
    if (!Number.isInteger(idx) || idx < 0 || idx >= profiles.length) {
      setStatus(t('status_profile_select_first'), 'error');
      return;
    }
    profiles[idx].config = getCurrentConfig();
    await storageArea.set({ profiles });
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
    profileSelect.value = String(existingIdx >= 0 ? existingIdx : profiles.length - 1);
    await storageArea.set({ profiles });
    setStatus(t('status_profile_saved', [trimmed]), 'ok');
    flashButton(saveAsProfileBtn);
  });

  deleteProfileBtn.addEventListener('click', async () => {
    const idx = Number(profileSelect.value);
    if (!Number.isInteger(idx) || idx < 0 || idx >= profiles.length) return;
    profiles.splice(idx, 1);
    renderProfiles();
    await storageArea.set({ profiles });
    setStatus(t('status_profile_deleted'), 'ok');
  });

  editProfileBtn.addEventListener('click', async () => {
    const idx = Number(profileSelect.value);
    if (!Number.isInteger(idx) || idx < 0 || idx >= profiles.length) {
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
    await storageArea.set({ profiles });
    setStatus(t('status_profile_renamed', [trimmed]), 'ok');
    flashButton(editProfileBtn);
  });

  profileSelect.addEventListener('change', () => {
    const idx = Number(profileSelect.value);
    if (!Number.isInteger(idx) || idx < 0 || idx >= profiles.length) return;
    applyConfig(profiles[idx].config, true);
  });

  applyProfileBtn.addEventListener('click', () => {
    const selectedValue = profileSelect.value;
    const idx = Number(selectedValue);
    if (selectedValue === '' || !Number.isInteger(idx) || idx < 0 || idx >= profiles.length) {
      // if no profile selected, keep current form values
      flashButton(applyProfileBtn);
      setStatus(t('status_profile_default'), 'error');
      return;
    }
    const profileName = profiles[idx].name || `${t('prompt_profile_name_placeholder')} ${idx + 1}`;
    const cfg = profiles[idx].config;
    applyConfig(cfg);
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
    const idx = Number(profileSelect.value);
    let payload;
    let name = 'current';
    if (Number.isInteger(idx) && idx >= 0 && idx < profiles.length) {
      payload = {
        profiles: [profiles[idx]]
      };
      name = profiles[idx].name || `profile-${idx + 1}`;
    } else {
      payload = { current: getCurrentConfig() };
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

  importProfileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    try {
      const json = JSON.parse(text);
      const importedName =
        (file.name && file.name.replace(/\.[^/.]+$/, '')) || t('imported_profile_name');

      const ensureArray = (arr) => (Array.isArray(arr) ? arr : []);
      const incomingProfiles = ensureArray(json.profiles);
      profiles = Array.isArray(profiles) ? profiles : [];
      let appliedConfig = null;
      let selectedIndex = 0;

      if (incomingProfiles.length) {
        profiles = incomingProfiles;
        appliedConfig = profiles[0]?.config || null;
        selectedIndex = 0;
      } else {
        // support for { name, ...config } without profiles array
        if (!incomingProfiles.length && json.name && json.intervalSec !== undefined) {
          const simpleCfg = { ...json };
          profiles.push({ name: json.name, config: simpleCfg });
          appliedConfig = simpleCfg;
          selectedIndex = profiles.length - 1;
        }

        const currentCfg = json.current ? { ...json.current } : null;
        if (!appliedConfig && currentCfg) {
          if (currentCfg.openCustomTabs === undefined) currentCfg.openCustomTabs = true;
          if (currentCfg.useCustomList === undefined && Array.isArray(currentCfg.customEntries) && currentCfg.customEntries.length) {
            currentCfg.useCustomList = true;
          }
          const name = currentCfg.name || json.name || importedName;
          profiles.push({ name, config: currentCfg });
          appliedConfig = currentCfg;
          selectedIndex = profiles.length - 1;
        }
      }

      if (appliedConfig) {
        applyConfig(appliedConfig);
        await storageArea.set({ ...appliedConfig, customEntries: appliedConfig.customEntries, isRunning: false });
      }

      await storageArea.set({ profiles });
      renderProfiles();
      if (profiles.length) {
        profileSelect.value = String(selectedIndex);
      }
      setStatus(t('status_import_ok'), 'ok');
    } catch (err) {
      setStatus(t('status_import_fail'), 'error');
    }
    importProfileInput.value = '';
  });

  startBtn.addEventListener('click', () => {
    const cfg = getCurrentConfig();
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

    storageArea.set({ ...payload, isRunning: true }).catch(() => {});

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
          setStatus(t('status_rotation_started', [listInfo]), 'ok');
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
