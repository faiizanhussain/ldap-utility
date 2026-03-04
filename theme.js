(() => {
  const PRESETS = [
    { hex: '66FF00', label: 'Lime' },
    { hex: '6366F1', label: 'Indigo' },
    { hex: '3B82F6', label: 'Blue' },
    { hex: 'F97316', label: 'Orange' },
    { hex: 'EC4899', label: 'Pink' },
    { hex: 'EAB308', label: 'Amber' },
  ];

  const STORAGE_KEY = 'ldif-builder-accent';
  const THEME_MODE_KEY = 'ldif-builder-theme-mode';
  const root = document.documentElement;
  const storage = window.sessionStorage;

  const savedMode = storage.getItem(THEME_MODE_KEY);
  if (savedMode === 'light' || savedMode === 'dark') {
    root.setAttribute('data-theme', savedMode);
  } else {
    root.setAttribute('data-theme', 'dark');
  }

  function hexToRgb(hex) {
    const normalized = (hex || '').replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return null;
    const n = parseInt(normalized, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function contrastColor(r, g, b) {
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.55 ? '#080808' : '#f0f0f0';
  }

  function applyAccent(hex, persist = true) {
    const cleaned = (hex || '').replace(/^#/, '').toUpperCase();
    const rgb = hexToRgb(cleaned);
    if (!rgb) return false;

    const rgbString = `${rgb.r}, ${rgb.g}, ${rgb.b}`;
    root.style.setProperty('--accent', `#${cleaned}`);
    root.style.setProperty('--accent-rgb', rgbString);
    root.style.setProperty('--primary', `#${cleaned}`);
    root.style.setProperty('--primary-light', `rgba(${rgbString}, 0.12)`);

    const textColor = contrastColor(rgb.r, rgb.g, rgb.b);
    document.querySelectorAll('.btn-primary, .tp-apply').forEach((el) => {
      el.style.color = textColor;
    });

    const swatch = document.getElementById('theme-swatch');
    const liveDot = document.getElementById('tp-live-dot');
    const liveLabel = document.getElementById('tp-live-label');
    const hexInput = document.getElementById('tp-hex');

    if (swatch) swatch.style.background = `#${cleaned}`;
    if (liveDot) liveDot.style.background = `#${cleaned}`;
    if (liveLabel) liveLabel.textContent = `Current: #${cleaned}`;
    if (hexInput) hexInput.value = cleaned;

    document.querySelectorAll('.tp-preset').forEach((el) => {
      el.classList.toggle('selected', el.dataset.hex === cleaned);
    });

    if (persist) storage.setItem(STORAGE_KEY, cleaned);
    return true;
  }

  function applyThemeMode(mode, persist = true) {
    const normalized = mode === 'light' ? 'light' : 'dark';
    root.setAttribute('data-theme', normalized);

    const modeSwitch = document.getElementById('tp-mode-switch');
    if (modeSwitch) {
      modeSwitch.classList.toggle('light', normalized === 'light');
      modeSwitch.setAttribute('aria-checked', String(normalized === 'light'));
      modeSwitch.setAttribute('title', normalized === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
    }

    const quickSwitch = document.getElementById('quick-mode-switch');
    if (quickSwitch) {
      quickSwitch.classList.toggle('light', normalized === 'light');
      quickSwitch.setAttribute('aria-checked', String(normalized === 'light'));
      quickSwitch.setAttribute('title', normalized === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
    }

      if (persist) {
          storage.setItem(THEME_MODE_KEY, normalized);
          const current = document.getElementById('tp-hex').value || '66FF00';
          applyAccent(current, persist);
      }
  }

  function mountThemeUi() {
    if (document.getElementById('theme-panel') || document.getElementById('theme-btn')) {
      return;
    }

    const themeBtn = document.createElement('button');
    themeBtn.className = 'theme-btn';
    themeBtn.id = 'theme-btn';
    themeBtn.title = 'Customize accent color';
    themeBtn.innerHTML = '<span class="theme-swatch" id="theme-swatch"></span>';

    const panel = document.createElement('div');
    panel.className = 'theme-panel';
    panel.id = 'theme-panel';
    panel.innerHTML = `
      <div class="tp-mode-row">
        <span class="tp-mode-icon" aria-hidden="true">☀</span>
        <button class="tp-mode-switch" id="tp-mode-switch" type="button" role="switch" aria-checked="false" title="Switch theme mode">
          <span class="tp-mode-knob"></span>
        </button>
        <span class="tp-mode-icon" aria-hidden="true">☾</span>
      </div>
      <div class="tp-title">Accent Color</div>
      <div class="tp-presets" id="tp-presets"></div>
      <div class="tp-input-row">
        <span class="tp-hash">#</span>
        <input class="tp-hex" id="tp-hex" maxlength="6" placeholder="66FF00" spellcheck="false" />
        <button class="tp-apply" id="tp-apply" type="button">Apply</button>
      </div>
      <div class="tp-error" id="tp-error"></div>
      <div class="tp-live-row">
        <span class="tp-live-dot" id="tp-live-dot"></span>
        <span class="tp-live-label" id="tp-live-label">Current: #66FF00</span>
      </div>
    `;

    document.body.appendChild(themeBtn);
    document.body.appendChild(panel);

    const quickToggle = document.createElement('div');
    quickToggle.className = 'quick-mode-toggle nav-mode-toggle';
    quickToggle.innerHTML = `
      <span class="qm-icon" aria-hidden="true">☀</span>
      <button class="tp-mode-switch" id="quick-mode-switch" type="button" role="switch" aria-checked="false" title="Switch theme mode">
        <span class="tp-mode-knob"></span>
      </button>
      <span class="qm-icon" aria-hidden="true">☾</span>
    `;
    const sidebarNav = document.querySelector('.sidebar .nav');
    if (sidebarNav && sidebarNav.parentElement) {
      sidebarNav.parentElement.insertBefore(quickToggle, sidebarNav);
    } else {
      document.body.appendChild(quickToggle);
    }

    const presetsEl = document.getElementById('tp-presets');
    PRESETS.forEach((preset) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tp-preset';
      button.dataset.hex = preset.hex;
      button.title = preset.label;
      button.style.background = `#${preset.hex}`;
      button.addEventListener('click', () => applyAccent(preset.hex));
      presetsEl.appendChild(button);
    });

    const hexInput = document.getElementById('tp-hex');
    const applyButton = document.getElementById('tp-apply');
    const error = document.getElementById('tp-error');
    const modeSwitch = document.getElementById('tp-mode-switch');
    const quickSwitch = document.getElementById('quick-mode-switch');

    modeSwitch.addEventListener('click', () => {
      const nextMode = (root.getAttribute('data-theme') || 'dark') === 'light' ? 'dark' : 'light';
      applyThemeMode(nextMode);
    });

    quickSwitch.addEventListener('click', () => {
      const nextMode = (root.getAttribute('data-theme') || 'dark') === 'light' ? 'dark' : 'light';
      applyThemeMode(nextMode);
    });

    applyButton.addEventListener('click', () => {
      const value = hexInput.value.trim().toUpperCase();
      if (!applyAccent(value)) {
        error.textContent = 'Invalid hex — e.g. 3B82F6';
      } else {
        error.textContent = '';
      }
    });

    hexInput.addEventListener('input', (event) => {
      event.target.value = event.target.value.toUpperCase();
      error.textContent = '';
    });

    hexInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        applyButton.click();
      }
    });

    themeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      panel.classList.toggle('open');
    });

    document.addEventListener('click', (event) => {
      if (!panel.contains(event.target)) panel.classList.remove('open');
    });

    applyThemeMode(root.getAttribute('data-theme') || 'dark', false);
    const saved = storage.getItem(STORAGE_KEY) || '66FF00';
    applyAccent(saved, false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountThemeUi);
  } else {
    mountThemeUi();
  }
})();
