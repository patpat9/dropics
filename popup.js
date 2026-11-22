const CUSTOM_VALUE = '__custom__';

function t(key, subs, fallback = '') {
  return chrome?.i18n?.getMessage(key, subs) || fallback || key;
}

function applyI18n() {
  if (chrome?.i18n?.getUILanguage) {
    document.documentElement.lang = chrome.i18n.getUILanguage();
  }
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const msg = chrome?.i18n?.getMessage(el.dataset.i18n);
    if (msg) el.textContent = msg;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const msg = chrome?.i18n?.getMessage(el.dataset.i18nPlaceholder);
    if (msg) el.placeholder = msg;
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const msg = chrome?.i18n?.getMessage(el.dataset.i18nTitle);
    if (msg) {
      el.title = msg;
      el.setAttribute('aria-label', msg);
    }
  });
}

applyI18n();

const defaultCalendarSelect = document.getElementById('defaultCalendarSelect');
const defaultCalendarInput = document.getElementById('defaultCalendarName');
const syncCalendarsBtn = document.getElementById('syncCalendarsBtn');
const saveStatusEl = document.getElementById('saveStatus');

let statusTimer = null;
let inputDebounceTimer = null;

function flashStatus(text) {
  saveStatusEl.textContent = text;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    saveStatusEl.textContent = '';
  }, 1800);
}

function flashSaved() {
  flashStatus(t('statusSaved', null, 'Saved'));
}

function getEffectiveCalendarName() {
  if (defaultCalendarSelect.value === CUSTOM_VALUE) {
    return defaultCalendarInput.value.trim();
  }
  return defaultCalendarSelect.value.trim();
}

function syncCustomInputVisibility() {
  const isCustom = defaultCalendarSelect.value === CUSTOM_VALUE;
  defaultCalendarInput.classList.toggle('hidden', !isCustom);
}

function saveSettings() {
  chrome.storage.sync.set(
    {
      defaultCalendarName: getEffectiveCalendarName()
    },
    flashSaved
  );
}

function populateCalendarDropdown(detectedCalendars, savedName) {
  defaultCalendarSelect.innerHTML = '';

  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = t('defaultCalendarFallback', null, 'Google default calendar');
  defaultCalendarSelect.appendChild(defaultOpt);

  for (const name of detectedCalendars) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    defaultCalendarSelect.appendChild(opt);
  }

  const customOpt = document.createElement('option');
  customOpt.value = CUSTOM_VALUE;
  customOpt.textContent = t('optionCustomCalendar', null, 'Custom calendar name...');
  defaultCalendarSelect.appendChild(customOpt);

  if (!savedName) {
    defaultCalendarSelect.value = '';
    defaultCalendarInput.value = '';
  } else if (detectedCalendars.includes(savedName)) {
    defaultCalendarSelect.value = savedName;
    defaultCalendarInput.value = savedName;
  } else {
    defaultCalendarSelect.value = CUSTOM_VALUE;
    defaultCalendarInput.value = savedName;
  }

  syncCustomInputVisibility();
}

async function initPopup() {
  const [settingsRes, calRes] = await Promise.all([
    chrome.storage.sync.get({ defaultCalendarName: '' }),
    chrome.runtime.sendMessage({ type: 'GET_CALENDAR_LIST' }).catch(() => ({ calendars: [] }))
  ]);

  const detectedCalendars = Array.isArray(calRes?.calendars) ? calRes.calendars : [];
  populateCalendarDropdown(detectedCalendars, (settingsRes.defaultCalendarName || '').trim());
}

defaultCalendarSelect.addEventListener('change', () => {
  syncCustomInputVisibility();
  if (defaultCalendarSelect.value === CUSTOM_VALUE) {
    defaultCalendarInput.focus();
  }
  saveSettings();
});

defaultCalendarInput.addEventListener('input', () => {
  if (inputDebounceTimer) clearTimeout(inputDebounceTimer);
  inputDebounceTimer = setTimeout(saveSettings, 300);
});

defaultCalendarInput.addEventListener('change', saveSettings);

syncCalendarsBtn.addEventListener('click', async () => {
  if (syncCalendarsBtn.disabled) return;
  syncCalendarsBtn.disabled = true;
  syncCalendarsBtn.classList.add('spinning');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'SYNC_CALENDARS_FROM_EXPORT' });
    if (res?.ok && Array.isArray(res.calendars) && res.calendars.length > 0) {
      const current = getEffectiveCalendarName();
      populateCalendarDropdown(res.calendars, current);
      flashStatus(t('statusSynced', null, 'Synced'));
    }
  } catch {
    // ignore
  } finally {
    syncCalendarsBtn.disabled = false;
    syncCalendarsBtn.classList.remove('spinning');
  }
});

initPopup();
