// ===== Utilities =====
function detectDelimiter(line) {
  const candidates = [',', ';', '\t', '|'];
  const scores = candidates.map((delim) => {
    let count = 0;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === delim) count++;
    }
    return count;
  });
  console.log('Delimiter scores:', candidates.map((c, i) => `${c}: ${scores[i]}`));
  const maxIdx = scores.indexOf(Math.max(...scores));
  return candidates[maxIdx] || ',';
}

function parseCsv(text, delimiter) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        row.push(field.trim());
        field = '';
      } else if (ch === '\n') {
        row.push(field.trim());
        if (row.some(cell => cell)) rows.push(row);
        row = [];
        field = '';
      } else if (ch !== '\r') {
        field += ch;
      }
    }
  }

  if (field || row.length) {
    row.push(field.trim());
    if (row.some(cell => cell)) rows.push(row);
  }

  return rows;
}

function extractHeaders(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim()).filter(Boolean);
  console.log('Raw first row:', rows[0]);
  console.log('Extracted headers:', headers);
  return headers;
}

function rowsToObjects(rows) {
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = r[idx] || '';
    });
    return obj;
  });
}

function extractLdifAttributes(text) {
  const set = new Set();
  text.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .forEach((line) => {
      const [left] = line.split(':');
      if (!left) return;
      const key = left.trim().toLowerCase();
      if (key === 'dn' || key === 'objectclass') return;
      if (/^[a-z0-9_-]+$/i.test(key)) set.add(key);
    });
  return Array.from(set).sort();
}

function escapeLdif(val) {
  let out = val.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
  if (/^\s/.test(out) || /^#/.test(out)) {
    out = ':' + ' ' + btoa(unescape(encodeURIComponent(out)));
  }
  return out;
}

function normalizeMapping(mapping) {
  if (!mapping) return { sourceParts: [], separator: ' ', trim: true, skipEmptyParts: true, attrType: 'text', dnTemplate: '', useCustomSeparator: false, customSeparator: ',' };
  if (!mapping.sourceParts && mapping.sourceFields) {
    mapping.sourceParts = mapping.sourceFields.map((v) => ({ type: 'csv', value: v }));
    delete mapping.sourceFields;
  }
  if (!mapping.sourceParts) mapping.sourceParts = [];
  if (mapping.separator === undefined) mapping.separator = ' ';
  if (mapping.trim === undefined) mapping.trim = true;
  if (mapping.skipEmptyParts === undefined) mapping.skipEmptyParts = true;
  if (mapping.attrType === undefined) mapping.attrType = 'text';
  if (mapping.dnTemplate === undefined) mapping.dnTemplate = '';
  if (mapping.useCustomSeparator === undefined) mapping.useCustomSeparator = false;
  if (mapping.customSeparator === undefined) mapping.customSeparator = ',';
  return mapping;
}

function buildAttributeValue(row, mapping) {
  const m = normalizeMapping(mapping);
  const parts = m.sourceParts
    .map((part) => {
      if (part.type === 'literal') return part.value ?? '';
      return row[part.value] ?? '';
    })
    .filter((v) => (m.skipEmptyParts ? String(v).trim() !== '' : true));
  if (!parts.length) return undefined;
  
  // Use custom separator if enabled (for column combining)
  const sep = m.useCustomSeparator ? (m.customSeparator ?? ',') : (m.separator ?? ' ');
  const raw = parts.join(sep);
  const val = m.trim ? raw.trim() : raw;
  
  // If attribute type is DN, wrap value in DN template
  if (m.attrType === 'dn' && m.dnTemplate) {
    return m.dnTemplate.replace(/\{value\}/gi, val);
  }
  return val;
}

function applyDnTemplate(template, row, mappings) {
  let dn = template;
  mappings.forEach((m) => {
    const key = `{${m.targetAttribute}}`;
    if (dn.includes(key)) {
      const val = buildAttributeValue(row, m) ?? '';
      dn = dn.replaceAll(key, val);
    }
  });
  return dn;
}

function buildLdif(rows, req) {
  const lines = [];
  const warnings = [];
  const entryMode = req.entryMode === 'modify' ? 'modify' : 'new';
  const repeatableAttrs = new Set(
    (req.repeatableAttributes && req.repeatableAttributes.length ? req.repeatableAttributes : ['objectclass', 'replace'])
      .map((attr) => String(attr || '').trim().toLowerCase())
      .filter(Boolean)
  );

  rows.forEach((row, idx) => {
    const attrLines = [];
    const usedAttrs = new Set();
    const repeatableBuckets = new Map();
    const modifyOperations = [];
    const dn = applyDnTemplate(req.dnTemplate, row, req.mappings);

    if (!dn || /\{.+\}/.test(dn)) {
      warnings.push(`Row ${idx + 1}: DN template not fully resolved.`);
      return;
    }

    req.mappings.forEach((m) => {
      const v = buildAttributeValue(row, m);
      if (v === undefined || v === '') return;
      const target = (m.targetAttribute || '').trim();
      if (!target) return;

      const lower = target.toLowerCase();
      if (repeatableAttrs.has(lower)) {
        // Allow multiple values for configured repeatable attributes.
        const parts = String(v).split(/[\s,;]+/).map((p) => p.trim()).filter(Boolean);
        if (!repeatableBuckets.has(lower)) {
          repeatableBuckets.set(lower, { attributeName: target, values: [] });
        }
        const bucket = repeatableBuckets.get(lower);
        if (parts.length) {
          parts.forEach((p) => bucket.values.push(p));
        } else {
          bucket.values.push(v.trim());
        }
        return;
      }

      if (usedAttrs.has(lower)) {
        warnings.push(`Row ${idx + 1}: Duplicate attribute "${target}" skipped.`);
        return;
      }

      usedAttrs.add(lower);
      if (entryMode === 'modify') {
        modifyOperations.push({ attributeName: target, values: [v] });
      } else {
        attrLines.push(`${target}: ${escapeLdif(v)}`);
      }
    });

    const entryLines = [`dn: ${dn}`];

    const repeatableEntries = Array.from(repeatableBuckets.entries()).sort((a, b) => {
      if (a[0] === 'objectclass') return -1;
      if (b[0] === 'objectclass') return 1;
      return 0;
    });

    if (entryMode === 'modify') {
      entryLines.push('changetype: modify');

      repeatableEntries.forEach(([, bucket]) => {
        const uniqueValues = Array.from(new Set(bucket.values.map((val) => val.trim()).filter(Boolean)));
        if (!uniqueValues.length) return;
        modifyOperations.push({ attributeName: bucket.attributeName, values: uniqueValues });
      });

      modifyOperations.forEach((op) => {
        entryLines.push(`replace: ${op.attributeName}`);
        op.values.forEach((val) => {
          entryLines.push(`${op.attributeName}: ${escapeLdif(val)}`);
        });
        entryLines.push('-');
      });
    } else {
      repeatableEntries.forEach(([, bucket]) => {
        const uniqueValues = Array.from(new Set(bucket.values.map((val) => val.trim()).filter(Boolean)));
        uniqueValues.forEach((val) => {
          entryLines.push(`${bucket.attributeName}: ${escapeLdif(val)}`);
        });
      });

      entryLines.push(...attrLines);
    }

    lines.push(entryLines.join('\n'));
    lines.push('');
  });

  return { ldif: lines.join('\n'), warnings };
}

// ===== DOM Elements =====
const csvInput = document.getElementById('csvInput');
const ldifInput = document.getElementById('ldifInput');
const csvDropZone = document.getElementById('csvDropZone');
const ldifDropZone = document.getElementById('ldifDropZone');
const csvStatus = document.getElementById('csvStatus');
const ldifStatus = document.getElementById('ldifStatus');
const ldifPasteArea = document.getElementById('ldifPasteArea');
const parseLdifPasteBtn = document.getElementById('parseLdifPasteBtn');
const clearLdifPasteBtn = document.getElementById('clearLdifPasteBtn');
const delimiterEl = document.getElementById('delimiter');
const dnTemplateEl = document.getElementById('dnTemplate');
const mappingHint = document.getElementById('mappingHint');
const mappingInterface = document.getElementById('mappingInterface');
const ldifAttributesList = document.getElementById('ldifAttributesList');
const csvColumnsList = document.getElementById('csvColumnsList');
const csvColumnCount = document.getElementById('csvColumnCount');
const mappingDetails = document.getElementById('mappingDetails');
const currentAttrName = document.getElementById('currentAttrName');
const selectedFieldsList = document.getElementById('selectedFieldsList');
const concatSeparator = document.getElementById('concatSeparator');
const concatTrim = document.getElementById('concatTrim');
const concatSkipEmpty = document.getElementById('concatSkipEmpty');
const useCustomSeparator = document.getElementById('useCustomSeparator');
const customSeparator = document.getElementById('customSeparator');
const customSeparatorGroup = document.getElementById('customSeparatorGroup');
const literalInput = document.getElementById('literalValue');
const attrTypeSelect = document.getElementById('attrType');
const attrDnTemplateInput = document.getElementById('attrDnTemplate');
const dnTemplateGroup = document.getElementById('dnTemplateGroup');
const clearMappingBtn = document.getElementById('clearMapping');
const addLdifAttrBtn = document.getElementById('addLdifAttr');
const convertBtn = document.getElementById('convertBtn');
const downloadBtn = document.getElementById('downloadBtn');
const resetBtn = document.getElementById('resetBtn');
const copyBtn = document.getElementById('copyBtn');
const previewEl = document.getElementById('preview');
const warningsEl = document.getElementById('warnings');
const userRecordModeEl = document.getElementById('userRecordMode');
const repeatablePresetEl = document.getElementById('repeatablePreset');
const addRepeatablePresetBtn = document.getElementById('addRepeatablePreset');
const customRepeatableAttrEl = document.getElementById('customRepeatableAttr');
const addCustomRepeatableBtn = document.getElementById('addCustomRepeatable');
const repeatableAttrsListEl = document.getElementById('repeatableAttrsList');

// Groups mode elements
const groupsInterface = document.getElementById('groupsInterface');
const groupsHint = document.getElementById('groupsHint');
const operationsList = document.getElementById('operationsList');
const addOperationBtn = document.getElementById('addOperationBtn');

// ===== State =====
let appMode = 'create'; // 'create' or 'groups'
let csvRows = [];
let csvHeaders = [];
let ldifAttrs = [];
let mappings = new Map(); // attribute -> {sourceFields: [], separator, trim, skipEmptyParts}
let selectedAttribute = null;
let lastResult = null;
let operations = []; // For groups mode: [{id, groupDn, operation, memberAttr, csvColumn, memberDnTemplate}]
let operationIdCounter = 0;
let repeatableAttrs = new Set(['objectclass', 'replace']);
let userRecordMode = 'new';

// Common LDIF attributes
// const commonLdifAttrs = [
//   'cn', 'sn', 'givenName', 'displayName', 'mail', 'uid', 'userPassword',
//   'telephoneNumber', 'mobile', 'title', 'description', 'employeeNumber',
//   'department', 'manager', 'street', 'l', 'st', 'postalCode', 'c'
// ];
const commonLdifAttrs = [];

function normalizeAttrName(attr) {
  return String(attr || '').trim().toLowerCase();
}

function formatAttrName(attr) {
  const lower = normalizeAttrName(attr);
  if (lower === 'objectclass') return 'objectClass';
  return lower;
}

function renderRepeatableAttrs() {
  if (!repeatableAttrsListEl) return;

  const attrs = Array.from(repeatableAttrs).sort((a, b) => a.localeCompare(b));
  repeatableAttrsListEl.innerHTML = attrs.length
    ? attrs.map((attr) => `
        <span class="selected-chip">
          ${formatAttrName(attr)}
          <button type="button" data-remove-repeatable="${attr}">×</button>
        </span>
      `).join('')
    : '<span style="color: var(--text-muted); font-size: 13px;">No repeatable attributes configured.</span>';
}

function addRepeatableAttr(attr) {
  const normalized = normalizeAttrName(attr);
  if (!normalized) return;
  repeatableAttrs.add(normalized);
  renderRepeatableAttrs();
}

function removeRepeatableAttr(attr) {
  const normalized = normalizeAttrName(attr);
  if (!normalized) return;
  repeatableAttrs.delete(normalized);
  renderRepeatableAttrs();
}

// ===== Render Functions =====
function renderLdifAttributes() {
  const allAttrs = [...new Set([...commonLdifAttrs, ...ldifAttrs])];
  ldifAttributesList.innerHTML = '';
  
  allAttrs.forEach(attr => {
    const isMapped = mappings.has(attr);
    const isSelected = selectedAttribute === attr;
    const count = isMapped ? normalizeMapping(mappings.get(attr)).sourceParts.length : 0;
    
    const div = document.createElement('div');
    div.className = `attribute-item ${isSelected ? 'selected' : ''} ${isMapped ? 'mapped' : ''}`;
    div.dataset.attr = attr;
    
    const span = document.createElement('span');
    span.textContent = attr;
    div.appendChild(span);
    
    if (count > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = count;
      div.appendChild(badge);
    }
    
    ldifAttributesList.appendChild(div);
  });
}

function renderCsvColumns() {
  csvColumnCount.textContent = `${csvHeaders.length} columns`;
  csvColumnsList.innerHTML = '';
  
  csvHeaders.forEach(col => {
    const isSelected = selectedAttribute && normalizeMapping(mappings.get(selectedAttribute))?.sourceParts.some((p) => p.type === 'csv' && p.value === col);
    const div = document.createElement('div');
    div.className = `attribute-item ${isSelected ? 'selected' : ''}`;
    div.dataset.col = col;
    div.innerHTML = `<span>${col}</span>`;
    csvColumnsList.appendChild(div);
  });
}

function renderMappingDetails() {
  if (!selectedAttribute) {
    mappingDetails.style.display = 'none';
    return;
  }

  mappingDetails.style.display = 'block';
  currentAttrName.textContent = selectedAttribute;

  const mapping = normalizeMapping(mappings.get(selectedAttribute));
  literalInput.value = '';

  concatSeparator.value = mapping.separator;
  concatTrim.checked = mapping.trim;
  concatSkipEmpty.checked = mapping.skipEmptyParts;
  useCustomSeparator.checked = mapping.useCustomSeparator;
  customSeparator.value = mapping.customSeparator;
  customSeparatorGroup.style.display = mapping.useCustomSeparator ? 'flex' : 'none';
  
  // Set attribute type and DN template
  attrTypeSelect.value = mapping.attrType;
  attrDnTemplateInput.value = mapping.dnTemplate || getDefaultAttrDnTemplate();
  dnTemplateGroup.style.display = mapping.attrType === 'dn' ? 'flex' : 'none';

  selectedFieldsList.innerHTML = mapping.sourceParts.length > 0
    ? mapping.sourceParts.map(part => `
        <span class="selected-chip">
          ${part.type === 'literal' ? `“${part.value}”` : part.value}
          <button type="button" data-remove-type="${part.type}" data-remove="${part.value}">×</button>
        </span>
      `).join('')
    : '<span style="color: var(--text-muted); font-size: 13px;">No inputs selected. Click CSV columns or add a literal.</span>';
}

function getDefaultAttrDnTemplate() {
  // Extract DN pattern from main DN template (remove "dn: " prefix)
  const mainDn = dnTemplateEl.value.replace(/^dn:\s*/i, '');
  // Replace the first placeholder with {value}
  return mainDn.replace(/\{[^}]+\}/, '{value}');
}

function updateMapping() {
  if (!selectedAttribute) return;

  const current = normalizeMapping(mappings.get(selectedAttribute));
  mappings.set(selectedAttribute, {
    ...current,
    separator: concatSeparator.value,
    trim: concatTrim.checked,
    skipEmptyParts: concatSkipEmpty.checked,
    attrType: attrTypeSelect.value,
    dnTemplate: attrDnTemplateInput.value,
    useCustomSeparator: useCustomSeparator.checked,
    customSeparator: customSeparator.value
  });

  renderLdifAttributes();
}

// ===== File Handling =====
function setupDropZone(zone, input, onFile) {
  zone.addEventListener('click', () => input.click());

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dragover');
  });

  zone.addEventListener('dragleave', () => {
    zone.classList.remove('dragover');
  });

  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  });

  input.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) onFile(file);
  });
}

async function handleCsvFile(file) {
  const text = await file.text();
  const firstLine = text.split(/\r?\n/)[0] || '';
  const guess = detectDelimiter(firstLine);
  delimiterEl.value = guess;

  const rows = parseCsv(text, guess);
  csvHeaders = extractHeaders(rows);
  csvRows = rowsToObjects(rows);

  console.log('Detected delimiter:', guess);
  console.log('First line:', firstLine);
  console.log('Parsed rows[0]:', rows[0]);
  console.log('CSV Headers:', csvHeaders);
  console.log('CSV Headers length:', csvHeaders.length);

  csvStatus.textContent = `${file.name} • ${csvRows.length} rows, ${csvHeaders.length} columns`;
  csvDropZone.classList.add('has-file');

  if (appMode === 'create') {
    const isModify = window.confirm(
      'Is this for OLD users you want to modify?\n\nClick OK for old users (modify mode).\nClick Cancel for new users (create mode).'
    );
    userRecordMode = isModify ? 'modify' : 'new';
    if (userRecordModeEl) {
      userRecordModeEl.value = userRecordMode;
    }
  }

  mappingHint.style.display = 'none';
  
  // Show appropriate interface based on mode
  if (appMode === 'create') {
    mappingInterface.style.display = 'block';
    groupsInterface.style.display = 'none';
    renderLdifAttributes();
    renderCsvColumns();
  } else {
    mappingInterface.style.display = 'none';
    groupsInterface.style.display = 'block';
    groupsHint.style.display = operations.length === 0 ? 'flex' : 'none';
  }
}

async function handleLdifFile(file) {
  const text = await file.text();
  processLdifText(text, file.name);
}

function processLdifText(text, sourceName) {
  ldifAttrs = extractLdifAttributes(text);
  ldifStatus.textContent = ldifAttrs.length
    ? `${sourceName} • ${ldifAttrs.length} attributes found`
    : `${sourceName} • No attributes detected`;
  ldifDropZone.classList.add('has-file');
  
  if (csvHeaders.length) {
    renderLdifAttributes();
  }
}

function handleLdifPaste() {
  const text = ldifPasteArea.value.trim();
  
  if (!text) {
    alert('Please paste LDIF content first.');
    return;
  }
  
  processLdifText(text, 'Pasted Content');
}

function clearLdifPaste() {
  ldifPasteArea.value = '';
}

setupDropZone(csvDropZone, csvInput, handleCsvFile);
setupDropZone(ldifDropZone, ldifInput, handleLdifFile);

// Paste functionality
parseLdifPasteBtn.addEventListener('click', handleLdifPaste);
clearLdifPasteBtn.addEventListener('click', clearLdifPaste);

// ===== Event Handlers =====
ldifAttributesList.addEventListener('click', (e) => {
  const item = e.target.closest('.attribute-item');
  if (!item) return;
  
  selectedAttribute = item.dataset.attr;
  renderLdifAttributes();
  renderCsvColumns();
  renderMappingDetails();
});

csvColumnsList.addEventListener('click', (e) => {
  const item = e.target.closest('.attribute-item');
  if (!item || !selectedAttribute) return;
  
  const col = item.dataset.col;
  const mapping = normalizeMapping(mappings.get(selectedAttribute));
  
  const idx = mapping.sourceParts.findIndex((p) => p.type === 'csv' && p.value === col);
  if (idx > -1) {
    mapping.sourceParts.splice(idx, 1);
  } else {
    mapping.sourceParts.push({ type: 'csv', value: col });
  }
  
  if (mapping.sourceParts.length > 0) {
    mappings.set(selectedAttribute, mapping);
  } else {
    mappings.delete(selectedAttribute);
  }
  
  renderLdifAttributes();
  renderCsvColumns();
  renderMappingDetails();
});

selectedFieldsList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-remove]');
  if (!btn || !selectedAttribute) return;
  
  const field = btn.dataset.remove;
  const type = btn.dataset.removeType;
  const mapping = normalizeMapping(mappings.get(selectedAttribute));
  if (!mapping) return;
  
  mapping.sourceParts = mapping.sourceParts.filter((p) => !(p.value === field && p.type === type));
  
  if (mapping.sourceParts.length === 0) {
    mappings.delete(selectedAttribute);
  }
  
  renderLdifAttributes();
  renderCsvColumns();
  renderMappingDetails();
});

if (repeatableAttrsListEl) {
  repeatableAttrsListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-repeatable]');
    if (!btn) return;
    removeRepeatableAttr(btn.dataset.removeRepeatable);
  });
}

if (addRepeatablePresetBtn) {
  addRepeatablePresetBtn.addEventListener('click', () => {
    addRepeatableAttr(repeatablePresetEl.value);
  });
}

if (addCustomRepeatableBtn) {
  addCustomRepeatableBtn.addEventListener('click', () => {
    addRepeatableAttr(customRepeatableAttrEl.value);
    customRepeatableAttrEl.value = '';
  });
}

if (customRepeatableAttrEl) {
  customRepeatableAttrEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addRepeatableAttr(customRepeatableAttrEl.value);
      customRepeatableAttrEl.value = '';
    }
  });
}

if (userRecordModeEl) {
  userRecordModeEl.addEventListener('change', (e) => {
    userRecordMode = e.target.value === 'modify' ? 'modify' : 'new';
  });
}

concatSeparator.addEventListener('input', updateMapping);
concatTrim.addEventListener('change', updateMapping);
concatSkipEmpty.addEventListener('change', updateMapping);
useCustomSeparator.addEventListener('change', () => {
  customSeparatorGroup.style.display = useCustomSeparator.checked ? 'flex' : 'none';
  updateMapping();
});
customSeparator.addEventListener('input', updateMapping);

attrTypeSelect.addEventListener('change', () => {
  const isDn = attrTypeSelect.value === 'dn';
  dnTemplateGroup.style.display = isDn ? 'flex' : 'none';
  if (isDn && !attrDnTemplateInput.value) {
    attrDnTemplateInput.value = getDefaultAttrDnTemplate();
  }
  updateMapping();
});

attrDnTemplateInput.addEventListener('input', updateMapping);

clearMappingBtn.addEventListener('click', () => {
  if (!selectedAttribute) return;
  mappings.delete(selectedAttribute);
  renderLdifAttributes();
  renderCsvColumns();
  renderMappingDetails();
});

addLdifAttrBtn.addEventListener('click', () => {
  const attr = prompt('Enter custom LDIF attribute name:');
  if (!attr || !attr.trim()) return;
  
  const cleaned = attr.trim().toLowerCase().replace(/\s+/g, '');
  if (!/^[a-z0-9_-]+$/i.test(cleaned)) {
    alert('Invalid attribute name. Use only letters, numbers, hyphens, and underscores.');
    return;
  }
  
  ldifAttrs.push(cleaned);
  selectedAttribute = cleaned;
  renderLdifAttributes();
  renderMappingDetails();
});

const addLiteralBtn = document.getElementById('addLiteral');
addLiteralBtn.addEventListener('click', () => {
  if (!selectedAttribute) return;
  const val = literalInput.value;
  const trimmed = val.trim();
  if (!trimmed) return;

  const mapping = normalizeMapping(mappings.get(selectedAttribute));
  mapping.sourceParts.push({ type: 'literal', value: trimmed });
  mappings.set(selectedAttribute, mapping);
  literalInput.value = '';
  renderLdifAttributes();
  renderCsvColumns();
  renderMappingDetails();
});

convertBtn.addEventListener('click', () => {
  if (!csvRows.length) {
    previewEl.textContent = '⚠️ Please upload a CSV file first.';
    return;
  }

  let result;

  if (appMode === 'groups') {
    // Groups mode: build group operations LDIF
    if (operations.length === 0) {
      previewEl.textContent = '⚠️ Please add at least one operation.';
      return;
    }

    result = buildGroupOperationsLdif(csvRows, operations);
  } else {
    // Create mode: build entries LDIF
    const mappingsArray = Array.from(mappings.entries()).map(([targetAttribute, config]) => ({
      targetAttribute,
      ...config
    }));

    result = buildLdif(csvRows, {
      dnTemplate: dnTemplateEl.value,
      mappings: mappingsArray,
      repeatableAttributes: Array.from(repeatableAttrs),
      entryMode: userRecordMode,
    });
  }

  lastResult = result;
  previewEl.textContent = result.ldif || '⚠️ No output generated. Check your configuration.';
  downloadBtn.disabled = !result.ldif;

  if (result.warnings.length) {
    warningsEl.hidden = false;
    warningsEl.textContent = '⚠️ ' + result.warnings.slice(0, 5).join(' | ');
    if (result.warnings.length > 5) {
      warningsEl.textContent += ` (+${result.warnings.length - 5} more)`;
    }
  } else {
    warningsEl.hidden = true;
  }
});

downloadBtn.addEventListener('click', () => {
  if (!lastResult?.ldif) return;
  const blob = new Blob([lastResult.ldif], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'output.ldif';
  a.click();
  URL.revokeObjectURL(url);
});

copyBtn.addEventListener('click', () => {
  if (lastResult?.ldif) {
    navigator.clipboard.writeText(lastResult.ldif);
    copyBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>`;
    setTimeout(() => {
      copyBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z"/><path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z"/></svg>`;
    }, 2000);
  }
});

resetBtn.addEventListener('click', () => {
  csvRows = [];
  csvHeaders = [];
  ldifAttrs = [];
  mappings = new Map();
  selectedAttribute = null;
  lastResult = null;

  csvInput.value = '';
  ldifInput.value = '';
  ldifPasteArea.value = '';
  csvStatus.textContent = 'No file selected';
  ldifStatus.textContent = 'No file selected';
  csvDropZone.classList.remove('has-file');
  ldifDropZone.classList.remove('has-file');
  delimiterEl.value = ',';
  dnTemplateEl.value = 'dn: cn={cn},ou=People,dc=example,dc=com';
  previewEl.textContent = 'Upload a CSV and configure mappings to see preview...';
  warningsEl.hidden = true;
  downloadBtn.disabled = true;

  mappingHint.style.display = 'block';
  mappingInterface.style.display = 'none';
  mappingDetails.style.display = 'none';
  
  // Reset groups mode state
  operations = [];
  operationIdCounter = 0;
  repeatableAttrs = new Set(['objectclass', 'replace']);
  userRecordMode = 'new';
  if (userRecordModeEl) userRecordModeEl.value = 'new';
  renderRepeatableAttrs();
  renderOperations();
});

// ===== Mode Switching =====
document.querySelectorAll('input[name="appMode"]').forEach((radio) => {
  radio.addEventListener('change', (e) => {
    appMode = e.target.value;
    updateModeUI();
  });
});

function updateModeUI() {
  // Toggle visibility of mode-specific elements
  document.querySelectorAll('.create-mode-only').forEach((el) => {
    el.style.display = appMode === 'create' ? '' : 'none';
  });
  document.querySelectorAll('.groups-mode-only').forEach((el) => {
    el.style.display = appMode === 'groups' ? '' : 'none';
  });
  
  // Show/hide interfaces in Step 2
  if (csvHeaders.length > 0) {
    if (appMode === 'create') {
      mappingHint.style.display = 'none';
      mappingInterface.style.display = 'block';
      groupsInterface.style.display = 'none';
    } else {
      mappingInterface.style.display = 'none';
      groupsInterface.style.display = 'block';
      groupsHint.style.display = operations.length === 0 ? 'flex' : 'none';
    }
  }
}

renderRepeatableAttrs();

// ===== Groups Mode Functions =====
function buildGroupOperationsLdif(rows, operations) {
  const lines = [];
  const warnings = [];

  operations.forEach((op) => {
    if ((op.targetType || 'group') === 'user') {
      const attrName = (op.userAttrName || '').trim();
      if (!attrName) {
        warnings.push(`Operation #${op.id}: Target attribute is required for single-user modify.`);
        return;
      }

      if (!op.userCnColumn) {
        warnings.push(`Operation #${op.id}: CN column is required for single-user modify.`);
        return;
      }

      rows.forEach((row, idx) => {
        const cnValue = String(row[op.userCnColumn] ?? '').trim();
        if (!cnValue) {
          warnings.push(`Row ${idx + 1}: Empty CN value for column "${op.userCnColumn}"`);
          return;
        }

        const userDn = (op.userDnTemplate || 'cn={cn},cn=users,dc=example,dc=com')
          .replace(/\{cn\}/gi, cnValue)
          .replace(/\{value\}/gi, cnValue);

        const value = String(row[op.userValueColumn] ?? '').trim();
        if ((op.operation === 'add' || op.operation === 'replace') && !value) {
          warnings.push(`Row ${idx + 1}: Empty value for column "${op.userValueColumn}"`);
          return;
        }

        lines.push(`dn: ${userDn}`);
        lines.push('changetype: modify');
        lines.push(`${op.operation}: ${attrName}`);

        if (op.operation !== 'delete' || value) {
          lines.push(`${attrName}: ${escapeLdif(value)}`);
        }

        lines.push('');
      });

      return;
    }

    if (op.useGroupColumn) {
      // Dynamic groups from CSV column
      const groupMap = new Map(); // Map of groupDn => members
      
      rows.forEach((row, idx) => {
        const memberValue = row[op.csvColumn] ?? '';
        if (!memberValue || !memberValue.trim()) {
          warnings.push(`Row ${idx + 1}: Empty value for member column "${op.csvColumn}"`);
          return;
        }
        
        const groupValue = row[op.groupColumn] ?? '';
        if (!groupValue || !groupValue.trim()) {
          warnings.push(`Row ${idx + 1}: Empty value for group column "${op.groupColumn}"`);
          return;
        }
        
        // Split groups by delimiter
        const groups = groupValue.split(op.groupDelimiter || ';').map(g => g.trim()).filter(g => g);
        const memberDn = op.memberDnTemplate.replace(/\{value\}/gi, memberValue.trim());
        
        groups.forEach((group) => {
          // Apply group DN template if specified
          const groupDn = op.groupDnTemplate ? op.groupDnTemplate.replace(/\{value\}/gi, group) : group;
          if (!groupMap.has(groupDn)) {
            groupMap.set(groupDn, []);
          }
          groupMap.get(groupDn).push(memberDn);
        });
      });

      if (groupMap.size === 0) {
        warnings.push(`Operation (dynamic groups): No valid group/member combinations found`);
        return;
      }

      // Generate LDIF for each group
      groupMap.forEach((members, groupDn) => {
        lines.push(`dn: ${groupDn}`);
        lines.push('changetype: modify');
        lines.push(`${op.operation}: ${op.memberAttr}`);
        members.forEach((dn) => {
          lines.push(`${op.memberAttr}: ${dn}`);
        });
        lines.push('');
      });
    } else {
      // Static group - original behavior
      const members = [];
      
      rows.forEach((row, idx) => {
        const value = row[op.csvColumn] ?? '';
        if (!value || !value.trim()) {
          warnings.push(`Row ${idx + 1}: Empty value for column "${op.csvColumn}"`);
          return;
        }
        
        const memberDn = op.memberDnTemplate.replace(/\{value\}/gi, value.trim());
        members.push(memberDn);
      });

      if (members.length === 0) {
        warnings.push(`Operation "${op.groupDn}": No valid members found`);
        return;
      }

      lines.push(`dn: ${op.groupDn}`);
      lines.push('changetype: modify');
      lines.push(`${op.operation}: ${op.memberAttr}`);
      members.forEach((dn) => {
        lines.push(`${op.memberAttr}: ${dn}`);
      });
      lines.push('');
    }
  });

  return { ldif: lines.join('\n'), warnings };
}

function renderOperations() {
  if (operations.length === 0) {
    groupsHint.style.display = 'flex';
    operationsList.innerHTML = '';
    return;
  }

  groupsHint.style.display = 'none';
  operationsList.innerHTML = operations.map((op) => {
    const targetType = op.targetType || 'group';
    return `
    <div class="operation-card" data-op-id="${op.id}">
      <div class="operation-header">
        <h4>Operation #${op.id}</h4>
        <button class="btn btn-secondary btn-sm" onclick="removeOperation(${op.id})">Remove</button>
      </div>
      <div class="operation-body">
        <div class="form-group">
          <label>Operation Target</label>
          <select class="input" onchange="updateOperation(${op.id}, 'targetType', this.value)">
            <option value="group" ${targetType === 'group' ? 'selected' : ''}>Group Membership</option>
            <option value="user" ${targetType === 'user' ? 'selected' : ''}>Single User Attribute</option>
          </select>
          <span class="hint">Choose whether this operation updates group members or modifies each user entry directly.</span>
        </div>

        ${targetType === 'group' ? `
        <div class="form-group toggle-item">
          <label>
            <input type="checkbox" ${op.useGroupColumn ? 'checked' : ''} onchange="updateOperation(${op.id}, 'useGroupColumn', this.checked)" />
            <span>Use Group Names from CSV?</span>
          </label>
          <span class="hint">Enable to map group names from a CSV column (supports multiple groups per row)</span>
        </div>

        ${!op.useGroupColumn ? `
          <div class="form-group">
            <label>Group DN</label>
            <input type="text" class="input" value="${op.groupDn}" onchange="updateOperation(${op.id}, 'groupDn', this.value)" />
            <span class="hint">Static group DN for all members</span>
          </div>
        ` : ''}

        ${op.useGroupColumn ? `
          <div class="form-group">
            <label>Group Column</label>
            <select class="input" onchange="updateOperation(${op.id}, 'groupColumn', this.value)">
              <option value="">-- Select column --</option>
              ${csvHeaders.map((col) => `<option value="${col}" ${op.groupColumn === col ? 'selected' : ''}>${col}</option>`).join('')}
            </select>
            <span class="hint">CSV column containing group names or DNs</span>
          </div>
          <div class="form-group">
            <label>Group DN Template</label>
            <input type="text" class="input" value="${op.groupDnTemplate}" onchange="updateOperation(${op.id}, 'groupDnTemplate', this.value)" placeholder="cn={value},ou=groups,dc=example,dc=com" />
            <span class="hint">Optional: Use {value} as placeholder to build full DNs from group names. Leave empty if CSV contains full DNs.</span>
          </div>
          <div class="form-group">
            <label>Group Delimiter</label>
            <input type="text" class="input" value="${op.groupDelimiter || ';'}" onchange="updateOperation(${op.id}, 'groupDelimiter', this.value)" placeholder=";" />
            <span class="hint">Character(s) to split multiple groups (e.g., ; or |)</span>
          </div>
        ` : ''}

        <div class="operation-row">
          <div class="form-group">
            <label>Operation</label>
            <select class="input" onchange="updateOperation(${op.id}, 'operation', this.value)">
              <option value="add" ${op.operation === 'add' ? 'selected' : ''}>Add Members</option>
              <option value="delete" ${op.operation === 'delete' ? 'selected' : ''}>Delete Members</option>
              <option value="replace" ${op.operation === 'replace' ? 'selected' : ''}>Replace Members</option>
            </select>
          </div>
          <div class="form-group">
            <label>Member Attribute</label>
            <select class="input" onchange="updateOperation(${op.id}, 'memberAttr', this.value)">
              <option value="member" ${op.memberAttr === 'member' ? 'selected' : ''}>member</option>
              <option value="uniqueMember" ${op.memberAttr === 'uniqueMember' ? 'selected' : ''}>uniqueMember</option>
            </select>
          </div>
          <div class="form-group">
            <label>Member Column</label>
            <select class="input" onchange="updateOperation(${op.id}, 'csvColumn', this.value)">
              ${csvHeaders.map((col) => `<option value="${col}" ${op.csvColumn === col ? 'selected' : ''}>${col}</option>`).join('')}
            </select>
            <span class="hint">CSV column with member identifiers</span>
          </div>
        </div>
        <div class="form-group">
          <label>Member DN Template</label>
          <input type="text" class="input" value="${op.memberDnTemplate}" onchange="updateOperation(${op.id}, 'memberDnTemplate', this.value)" placeholder="cn={value},cn=users,dc=example,dc=com" />
          <span class="hint">Use {value} as placeholder for the member column value</span>
        </div>
        ` : ''}

        ${targetType === 'user' ? `
        <div class="operation-row">
          <div class="form-group">
            <label>Operation</label>
            <select class="input" onchange="updateOperation(${op.id}, 'operation', this.value)">
              <option value="add" ${op.operation === 'add' ? 'selected' : ''}>Add Value</option>
              <option value="delete" ${op.operation === 'delete' ? 'selected' : ''}>Delete Value</option>
              <option value="replace" ${op.operation === 'replace' ? 'selected' : ''}>Replace Value</option>
            </select>
          </div>
          <div class="form-group">
            <label>CN Column</label>
            <select class="input" onchange="updateOperation(${op.id}, 'userCnColumn', this.value)">
              ${csvHeaders.map((col) => `<option value="${col}" ${op.userCnColumn === col ? 'selected' : ''}>${col}</option>`).join('')}
            </select>
            <span class="hint">CSV column that contains the user CN.</span>
          </div>
          <div class="form-group">
            <label>Value Column</label>
            <select class="input" onchange="updateOperation(${op.id}, 'userValueColumn', this.value)">
              ${csvHeaders.map((col) => `<option value="${col}" ${op.userValueColumn === col ? 'selected' : ''}>${col}</option>`).join('')}
            </select>
            <span class="hint">CSV column containing the value to write on the target attribute.</span>
          </div>
        </div>
        <div class="form-group">
          <label>Target Attribute</label>
          <input type="text" class="input" value="${op.userAttrName}" onchange="updateOperation(${op.id}, 'userAttrName', this.value)" placeholder="mail, title, departmentNumber..." />
          <span class="hint">LDAP attribute to modify for each user DN.</span>
        </div>
        <div class="form-group">
          <label>User DN Template</label>
          <input type="text" class="input" value="${op.userDnTemplate}" onchange="updateOperation(${op.id}, 'userDnTemplate', this.value)" placeholder="cn={cn},cn=users,dc=example,dc=com" />
          <span class="hint">Use {cn} as placeholder for the CN column value.</span>
        </div>
        ` : ''}
      </div>
    </div>
  `;
  }).join('');
}

function addOperation() {
  if (csvHeaders.length === 0) {
    alert('Please upload a CSV file first');
    return;
  }

  const newOp = {
    id: ++operationIdCounter,
    targetType: 'group',
    groupDn: 'cn=GroupName,cn=groups,dc=example,dc=com',
    operation: 'add',
    memberAttr: 'member',
    csvColumn: csvHeaders[0],
    memberDnTemplate: 'cn={value},cn=users,dc=example,dc=com',
    useGroupColumn: false,
    groupColumn: '',
    groupDnTemplate: 'cn={value},cn=groups,dc=example,dc=com',
    groupDelimiter: ';',
    userCnColumn: csvHeaders[0],
    userValueColumn: csvHeaders[Math.min(1, csvHeaders.length - 1)] || csvHeaders[0],
    userAttrName: 'mail',
    userDnTemplate: 'cn={cn},cn=users,dc=example,dc=com'
  };
  
  operations.push(newOp);
  renderOperations();
}

function removeOperation(id) {
  operations = operations.filter((op) => op.id !== id);
  renderOperations();
}

function updateOperation(id, field, value) {
  const op = operations.find((o) => o.id === id);
  if (op) {
    op[field] = value;
    renderOperations(); // Re-render to show/hide fields based on useGroupColumn
  }
}

// Wire up groups mode button
addOperationBtn.addEventListener('click', addOperation);

