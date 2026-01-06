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

  rows.forEach((row, idx) => {
    const attrLines = [];
    const usedAttrs = new Set();
    const objectClasses = [];
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
      if (lower === 'objectclass') {
        // Allow multiple objectClass values; split literals/CSV content on whitespace, comma, or semicolon.
        const parts = String(v).split(/[\s,;]+/).map((p) => p.trim()).filter(Boolean);
        if (parts.length) {
          parts.forEach((p) => objectClasses.push(p));
        } else {
          objectClasses.push(v.trim());
        }
        return;
      }

      if (usedAttrs.has(lower)) {
        warnings.push(`Row ${idx + 1}: Duplicate attribute "${target}" skipped.`);
        return;
      }

      usedAttrs.add(lower);
      attrLines.push(`${target}: ${escapeLdif(v)}`);
    });

    const ocUnique = Array.from(new Set(objectClasses.map((oc) => oc.trim()).filter(Boolean)));
    const entryLines = [`dn: ${dn}`];
    ocUnique.forEach((oc) => entryLines.push(`objectClass: ${escapeLdif(oc)}`));
    entryLines.push(...attrLines);

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

// Common LDIF attributes
// const commonLdifAttrs = [
//   'cn', 'sn', 'givenName', 'displayName', 'mail', 'uid', 'userPassword',
//   'telephoneNumber', 'mobile', 'title', 'description', 'employeeNumber',
//   'department', 'manager', 'street', 'l', 'st', 'postalCode', 'c'
// ];
const commonLdifAttrs = [];

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

// ===== Groups Mode Functions =====
function buildGroupOperationsLdif(rows, operations) {
  const lines = [];
  const warnings = [];

  operations.forEach((op) => {
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
  operationsList.innerHTML = operations.map((op) => `
    <div class="operation-card" data-op-id="${op.id}">
      <div class="operation-header">
        <h4>Operation #${op.id}</h4>
        <button class="btn btn-secondary btn-sm" onclick="removeOperation(${op.id})">Remove</button>
      </div>
      <div class="operation-body">
        <div class="form-group">
          <label>Group DN</label>
          <input type="text" class="input" value="${op.groupDn}" onchange="updateOperation(${op.id}, 'groupDn', this.value)" />
        </div>
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
            <label>CSV Column</label>
            <select class="input" onchange="updateOperation(${op.id}, 'csvColumn', this.value)">
              ${csvHeaders.map((col) => `<option value="${col}" ${op.csvColumn === col ? 'selected' : ''}>${col}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>Member DN Template</label>
          <input type="text" class="input" value="${op.memberDnTemplate}" onchange="updateOperation(${op.id}, 'memberDnTemplate', this.value)" placeholder="cn={value},cn=users,dc=example,dc=com" />
          <span class="hint">Use {value} as placeholder for the CSV column value</span>
        </div>
      </div>
    </div>
  `).join('');
}

function addOperation() {
  if (csvHeaders.length === 0) {
    alert('Please upload a CSV file first');
    return;
  }

  const newOp = {
    id: ++operationIdCounter,
    groupDn: 'cn=GroupName,cn=groups,dc=example,dc=com',
    operation: 'add',
    memberAttr: 'member',
    csvColumn: csvHeaders[0],
    memberDnTemplate: 'cn={value},cn=users,dc=example,dc=com'
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
  }
}

// Wire up groups mode button
addOperationBtn.addEventListener('click', addOperation);

