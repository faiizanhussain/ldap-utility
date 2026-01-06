/**
 * LDIF to CSV Converter Module
 * Parses LDIF files and converts them to CSV format
 */

class LdifToCsvConverter {
  constructor() {
    this.ldifData = [];
    this.selectedAttributes = [];
    this.csvOutput = '';
    this.allAttributes = [];
    this.splitRules = []; // Array of {sourceColumn, delimiter, columnNames}
  }

  /**
   * Parse LDIF content into structured data
   * Handles line folding, base64 encoded values, and multi-valued attributes
   */
  parseLdif(ldifText) {
    const entries = [];
    let currentEntry = null;
    let currentAttr = null;
    let currentValue = '';
    let isBase64 = false;

    // Normalize line endings
    const lines = ldifText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Handle line folding (continuation lines start with single space)
      if (line.startsWith(' ') && currentAttr) {
        currentValue += line.substring(1);
        continue;
      }

      // Process previous attribute if exists
      if (currentAttr && currentEntry) {
        let finalValue = currentValue;
        
        // Decode base64 if needed
        if (isBase64) {
          try {
            finalValue = atob(currentValue.trim());
          } catch (e) {
            // Keep original value if decoding fails
            finalValue = currentValue;
          }
        }

        if (!currentEntry[currentAttr]) {
          currentEntry[currentAttr] = [];
        }
        currentEntry[currentAttr].push(finalValue.trim());
      }

      // Reset for next attribute
      currentAttr = null;
      currentValue = '';
      isBase64 = false;

      // Skip comments
      if (line.startsWith('#')) {
        continue;
      }

      // Empty line marks end of entry
      if (line.trim() === '') {
        if (currentEntry && Object.keys(currentEntry).length > 0) {
          entries.push(currentEntry);
        }
        currentEntry = null;
        continue;
      }

      // Skip version line
      if (line.toLowerCase().startsWith('version:')) {
        continue;
      }

      // Parse attribute line
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        currentAttr = line.substring(0, colonIndex).trim();
        const afterColon = line.substring(colonIndex + 1);

        // Check for base64 encoding (double colon)
        if (afterColon.startsWith(':')) {
          isBase64 = true;
          currentValue = afterColon.substring(1).trim();
        } else if (afterColon.startsWith('<')) {
          // URL reference - skip for now
          currentValue = afterColon.substring(1).trim();
        } else {
          currentValue = afterColon.trim();
        }

        // Start new entry on 'dn' attribute
        if (currentAttr.toLowerCase() === 'dn') {
          currentEntry = {};
        }
      }
    }

    // Don't forget last attribute and entry
    if (currentAttr && currentEntry) {
      let finalValue = currentValue;
      if (isBase64) {
        try {
          finalValue = atob(currentValue.trim());
        } catch (e) {
          finalValue = currentValue;
        }
      }
      if (!currentEntry[currentAttr]) {
        currentEntry[currentAttr] = [];
      }
      currentEntry[currentAttr].push(finalValue.trim());
    }
    if (currentEntry && Object.keys(currentEntry).length > 0) {
      entries.push(currentEntry);
    }

    this.ldifData = entries;
    this.extractAllAttributes();
    return entries;
  }

  /**
   * Extract all unique attributes from LDIF data
   */
  extractAllAttributes() {
    const attributeSet = new Set();
    const attributeCounts = {};

    this.ldifData.forEach(entry => {
      Object.keys(entry).forEach(attr => {
        attributeSet.add(attr);
        attributeCounts[attr] = (attributeCounts[attr] || 0) + 1;
      });
    });

    // Sort attributes: dn first, then alphabetically
    this.allAttributes = Array.from(attributeSet).sort((a, b) => {
      if (a.toLowerCase() === 'dn') return -1;
      if (b.toLowerCase() === 'dn') return 1;
      return a.toLowerCase().localeCompare(b.toLowerCase());
    });

    return { attributes: this.allAttributes, counts: attributeCounts };
  }

  /**
   * Get available attributes with their occurrence counts
   */
  getAvailableAttributes() {
    const attributeCounts = {};
    this.ldifData.forEach(entry => {
      Object.keys(entry).forEach(attr => {
        attributeCounts[attr] = (attributeCounts[attr] || 0) + 1;
      });
    });

    return this.allAttributes.map(attr => ({
      name: attr,
      count: attributeCounts[attr] || 0,
      percentage: Math.round((attributeCounts[attr] / this.ldifData.length) * 100)
    }));
  }

  /**
   * Convert LDIF to CSV with selected attributes
   */
  convertToCsv(selectedAttributes, options = {}) {
    const {
      delimiter = ',',
      quoteChar = '"',
      multiValueSeparator = '; '
    } = options;

    if (!this.ldifData || this.ldifData.length === 0) {
      return '';
    }

    if (!selectedAttributes || selectedAttributes.length === 0) {
      return '';
    }

    const lines = [];
    
    // Build header row considering split rules
    const headerColumns = [];
    const attributeProcessing = []; // Track how to process each column
    
    selectedAttributes.forEach(attr => {
      const splitRule = this.splitRules.find(rule => rule.sourceColumn === attr);
      if (splitRule && splitRule.enabled) {
        // Add split column names
        splitRule.columnNames.forEach(name => headerColumns.push(name));
        attributeProcessing.push({ type: 'split', rule: splitRule });
      } else {
        // Add original column name
        headerColumns.push(attr);
        attributeProcessing.push({ type: 'normal', attribute: attr });
      }
    });
    
    const headerRow = headerColumns.map(col => 
      this.escapeCsvValue(col, delimiter, quoteChar)
    );
    lines.push(headerRow.join(delimiter));

    // Data rows
    this.ldifData.forEach(entry => {
      const row = [];
      
      selectedAttributes.forEach(attr => {
        const splitRule = this.splitRules.find(rule => rule.sourceColumn === attr);
        
        if (splitRule && splitRule.enabled) {
          // Split the value
          const values = entry[attr] || [];
          const combinedValue = values.join(multiValueSeparator);
          const parts = combinedValue.split(splitRule.delimiter);
          
          // Add each split part (or empty if not enough parts)
          for (let i = 0; i < splitRule.columnNames.length; i++) {
            const part = parts[i] || '';
            row.push(this.escapeCsvValue(part.trim(), delimiter, quoteChar));
          }
        } else {
          // Normal processing
          const values = entry[attr] || [];
          const combinedValue = values.join(multiValueSeparator);
          row.push(this.escapeCsvValue(combinedValue, delimiter, quoteChar));
        }
      });
      
      lines.push(row.join(delimiter));
    });

    this.csvOutput = lines.join('\n');
    return this.csvOutput;
  }

  /**
   * Escape CSV values with quotes if needed
   */
  escapeCsvValue(value, delimiter = ',', quoteChar = '"') {
    if (value === null || value === undefined) return '';
    
    const strValue = String(value);
    
    // Quote if contains delimiter, quotes, or newlines
    if (strValue.includes(delimiter) || 
        strValue.includes(quoteChar) || 
        strValue.includes('\n') ||
        strValue.includes('\r')) {
      // Escape quotes by doubling them
      const escaped = strValue.replace(new RegExp(quoteChar, 'g'), quoteChar + quoteChar);
      return quoteChar + escaped + quoteChar;
    }
    
    return strValue;
  }

  /**
   * Get CSV output
   */
  getCsvOutput() {
    return this.csvOutput;
  }

  /**
   * Get entry count
   */
  getEntryCount() {
    return this.ldifData.length;
  }

  /**
   * Reset converter state
   */
  reset() {
    this.ldifData = [];
    this.selectedAttributes = [];
    this.csvOutput = '';
    this.allAttributes = [];
    this.splitRules = [];
  }

  /**
   * Add a column split rule
   */
  addSplitRule(sourceColumn, delimiter, columnNames) {
    this.splitRules.push({
      id: Date.now(),
      sourceColumn,
      delimiter,
      columnNames,
      enabled: true
    });
    return this.splitRules[this.splitRules.length - 1];
  }

  /**
   * Remove a split rule
   */
  removeSplitRule(ruleId) {
    this.splitRules = this.splitRules.filter(rule => rule.id !== ruleId);
  }

  /**
   * Update a split rule
   */
  updateSplitRule(ruleId, updates) {
    const rule = this.splitRules.find(r => r.id === ruleId);
    if (rule) {
      Object.assign(rule, updates);
    }
  }

  /**
   * Get preview of split columns for an attribute
   */
  getSplitPreview(attribute, delimiter, limit = 5) {
    if (!this.ldifData || this.ldifData.length === 0) return [];
    
    const samples = [];
    for (let i = 0; i < Math.min(limit, this.ldifData.length); i++) {
      const entry = this.ldifData[i];
      const values = entry[attribute] || [];
      const combinedValue = values.join('; ');
      const parts = combinedValue.split(delimiter).map(p => p.trim());
      samples.push(parts);
    }
    return samples;
  }
}

// ==================== UI Controller ====================

class LdifToCsvUI {
  constructor() {
    this.converter = new LdifToCsvConverter();
    this.initElements();
    this.bindEvents();
  }

  initElements() {
    // File upload
    this.ldifDropZone = document.getElementById('ldifDropZone');
    this.ldifInput = document.getElementById('ldifInput');
    this.ldifStatus = document.getElementById('ldifStatus');
    this.ldifPasteArea = document.getElementById('ldifPasteArea');
    this.parseLdifPasteBtn = document.getElementById('parseLdifPasteBtn');
    this.clearLdifPasteBtn = document.getElementById('clearLdifPasteBtn');

    // Settings
    this.delimiterInput = document.getElementById('delimiter');
    this.quoteCharInput = document.getElementById('quoteChar');
    this.multiValueSeparator = document.getElementById('multiValueSeparator');

    // Attribute selection
    this.attributeHint = document.getElementById('attributeHint');
    this.attributeInterface = document.getElementById('attributeInterface');
    this.attributesSummary = document.getElementById('attributesSummary');
    this.attributeCheckboxes = document.getElementById('attributeCheckboxes');
    this.selectAllBtn = document.getElementById('selectAllBtn');
    this.deselectAllBtn = document.getElementById('deselectAllBtn');

    // Column splitting
    this.columnSplitCard = document.getElementById('columnSplitCard');
    this.addSplitRuleBtn = document.getElementById('addSplitRuleBtn');
    this.splitRulesContainer = document.getElementById('splitRulesContainer');

    // Preview & Actions
    this.conversionStats = document.getElementById('conversionStats');
    this.preview = document.getElementById('preview');
    this.convertBtn = document.getElementById('convertBtn');
    this.downloadBtn = document.getElementById('downloadBtn');
    this.copyBtn = document.getElementById('copyBtn');
    this.resetBtn = document.getElementById('resetBtn');
  }

  bindEvents() {
    // File upload events
    this.ldifDropZone.addEventListener('click', () => this.ldifInput.click());
    this.ldifDropZone.addEventListener('dragover', (e) => this.handleDragOver(e));
    this.ldifDropZone.addEventListener('dragleave', () => this.handleDragLeave());
    this.ldifDropZone.addEventListener('drop', (e) => this.handleDrop(e));
    this.ldifInput.addEventListener('change', (e) => this.handleFileSelect(e));

    // Paste functionality
    this.parseLdifPasteBtn.addEventListener('click', () => this.handlePaste());
    this.clearLdifPasteBtn.addEventListener('click', () => this.clearPaste());

    // Attribute selection
    this.selectAllBtn.addEventListener('click', () => this.selectAllAttributes());
    this.deselectAllBtn.addEventListener('click', () => this.deselectAllAttributes());

    // Column splitting
    this.addSplitRuleBtn.addEventListener('click', () => this.showAddSplitRuleDialog());

    // Actions
    this.convertBtn.addEventListener('click', () => this.convert());
    this.downloadBtn.addEventListener('click', () => this.download());
    this.copyBtn.addEventListener('click', () => this.copyToClipboard());
    this.resetBtn.addEventListener('click', () => this.reset());
  }

  handleDragOver(e) {
    e.preventDefault();
    this.ldifDropZone.classList.add('drag-over');
  }

  handleDragLeave() {
    this.ldifDropZone.classList.remove('drag-over');
  }

  handleDrop(e) {
    e.preventDefault();
    this.ldifDropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) {
      this.processFile(file);
    }
  }

  handleFileSelect(e) {
    const file = e.target.files[0];
    if (file) {
      this.processFile(file);
    }
  }

  processFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const ldifContent = e.target.result;
        this.processParsedLdif(ldifContent, file.name);
      } catch (error) {
        this.ldifStatus.innerHTML = `<span class="status-error">✗ Error parsing file: ${error.message}</span>`;
        this.ldifStatus.classList.add('error');
      }
    };
    reader.onerror = () => {
      this.ldifStatus.innerHTML = '<span class="status-error">✗ Error reading file</span>';
    };
    reader.readAsText(file);
  }

  handlePaste() {
    const ldifContent = this.ldifPasteArea.value.trim();
    
    if (!ldifContent) {
      alert('Please paste LDIF content first.');
      return;
    }

    try {
      this.processParsedLdif(ldifContent, 'Pasted Content');
    } catch (error) {
      this.ldifStatus.innerHTML = `<span class="status-error">✗ Error parsing LDIF: ${error.message}</span>`;
      this.ldifStatus.classList.add('error');
    }
  }

  clearPaste() {
    this.ldifPasteArea.value = '';
  }

  processParsedLdif(ldifContent, sourceName) {
    this.converter.parseLdif(ldifContent);
    
    const entryCount = this.converter.getEntryCount();
    this.ldifStatus.innerHTML = `<span class="status-success">✓ ${sourceName}</span> (${entryCount} entries)`;
    this.ldifStatus.classList.add('success');
    
    this.renderAttributeSelection();
    this.updateButtonStates();
    this.preview.textContent = 'Select attributes and click "Convert to CSV" to see preview...';
  }

  renderAttributeSelection() {
    const attributes = this.converter.getAvailableAttributes();
    
    if (attributes.length === 0) {
      this.attributeHint.style.display = 'flex';
      this.attributeInterface.style.display = 'none';
      return;
    }

    this.attributeHint.style.display = 'none';
    this.attributeInterface.style.display = 'block';

    // Summary
    this.attributesSummary.innerHTML = `
      <div class="summary-item">
        <span class="summary-label">Total Attributes:</span>
        <span class="summary-value">${attributes.length}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Total Entries:</span>
        <span class="summary-value">${this.converter.getEntryCount()}</span>
      </div>
    `;

    // Checkboxes
    this.attributeCheckboxes.innerHTML = '';
    attributes.forEach(attr => {
      const label = document.createElement('label');
      label.className = 'attribute-checkbox';
      label.innerHTML = `
        <input type="checkbox" value="${attr.name}" data-attr="${attr.name}" />
        <span class="checkbox-label">
          <span class="attr-name">${attr.name}</span>
          <span class="attr-stats">${attr.count}/${this.converter.getEntryCount()} (${attr.percentage}%)</span>
        </span>
      `;
      this.attributeCheckboxes.appendChild(label);
    });

    // Bind checkbox change events
    this.attributeCheckboxes.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => this.updateButtonStates());
    });

    // Enable select/deselect buttons
    this.selectAllBtn.disabled = false;
    this.deselectAllBtn.disabled = false;
  }

  selectAllAttributes() {
    this.attributeCheckboxes.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.checked = true;
    });
    this.updateButtonStates();
  }

  deselectAllAttributes() {
    this.attributeCheckboxes.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.checked = false;
    });
    this.updateButtonStates();
  }

  getSelectedAttributes() {
    const checkboxes = this.attributeCheckboxes.querySelectorAll('input[type="checkbox"]:checked');
    return Array.from(checkboxes).map(cb => cb.value);
  }

  updateButtonStates() {
    const hasData = this.converter.getEntryCount() > 0;
    const hasSelection = this.getSelectedAttributes().length > 0;
    
    this.convertBtn.disabled = !(hasData && hasSelection);
    
    // Show column split card only if data is loaded
    if (hasData) {
      this.columnSplitCard.style.display = 'block';
    }
  }

  showAddSplitRuleDialog() {
    const selectedAttrs = this.getSelectedAttributes();
    
    if (selectedAttrs.length === 0) {
      alert('Please select at least one attribute first.');
      return;
    }

    // Create dialog HTML
    const dialogHtml = `
      <div class="split-rule-form">
        <div class="form-group">
          <label for="splitSourceColumn">Column to Split</label>
          <select id="splitSourceColumn" class="input">
            ${selectedAttrs.map(attr => `<option value="${attr}">${attr}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label for="splitDelimiter">Split Delimiter</label>
          <input type="text" id="splitDelimiter" class="input" placeholder="e.g., , or | or -" value="," />
          <span class="hint">Character(s) used to split the value</span>
        </div>
        <div class="form-group">
          <label for="splitColumnCount">Number of Columns</label>
          <input type="number" id="splitColumnCount" class="input" value="2" min="2" max="10" />
          <span class="hint">How many columns to create from the split</span>
        </div>
        <div class="form-group">
          <label>Column Names</label>
          <div id="splitColumnNames"></div>
        </div>
        <div class="form-group">
          <label>Preview (first 3 rows)</label>
          <div id="splitPreview" class="split-preview"></div>
        </div>
        <div class="dialog-actions">
          <button class="btn btn-secondary" onclick="window.ldifToCsvUI.closeSplitDialog()">Cancel</button>
          <button class="btn btn-primary" onclick="window.ldifToCsvUI.confirmSplitRule()">Add Rule</button>
        </div>
      </div>
    `;

    // Insert after empty state or rules
    const emptyState = this.splitRulesContainer.querySelector('.empty-state-sm');
    if (emptyState) {
      emptyState.style.display = 'none';
    }

    const formDiv = document.createElement('div');
    formDiv.className = 'split-rule-dialog';
    formDiv.innerHTML = dialogHtml;
    this.splitRulesContainer.appendChild(formDiv);

    // Set up dynamic column name inputs
    const columnCountInput = document.getElementById('splitColumnCount');
    const updateColumnNameInputs = () => {
      const count = parseInt(columnCountInput.value) || 2;
      const container = document.getElementById('splitColumnNames');
      container.innerHTML = '';
      
      for (let i = 0; i < count; i++) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'input input-sm';
        input.placeholder = `Column ${i + 1}`;
        input.value = `Column ${i + 1}`;
        input.dataset.index = i;
        container.appendChild(input);
      }
      
      updatePreview();
    };

    const updatePreview = () => {
      const sourceColumn = document.getElementById('splitSourceColumn').value;
      const delimiter = document.getElementById('splitDelimiter').value;
      
      if (!delimiter) {
        document.getElementById('splitPreview').innerHTML = '<em>Enter a delimiter to see preview</em>';
        return;
      }

      const samples = this.converter.getSplitPreview(sourceColumn, delimiter, 3);
      
      if (samples.length === 0) {
        document.getElementById('splitPreview').innerHTML = '<em>No data available</em>';
        return;
      }

      let previewHtml = '<table class="preview-table"><thead><tr>';
      const columnNames = Array.from(document.querySelectorAll('#splitColumnNames input')).map(inp => inp.value);
      columnNames.forEach(name => {
        previewHtml += `<th>${name}</th>`;
      });
      previewHtml += '</tr></thead><tbody>';
      
      samples.forEach(parts => {
        previewHtml += '<tr>';
        for (let i = 0; i < columnNames.length; i++) {
          const value = parts[i] || '<em>empty</em>';
          previewHtml += `<td>${value}</td>`;
        }
        previewHtml += '</tr>';
      });
      
      previewHtml += '</tbody></table>';
      document.getElementById('splitPreview').innerHTML = previewHtml;
    };

    columnCountInput.addEventListener('input', updateColumnNameInputs);
    document.getElementById('splitSourceColumn').addEventListener('change', updatePreview);
    document.getElementById('splitDelimiter').addEventListener('input', updatePreview);

    updateColumnNameInputs();
  }

  closeSplitDialog() {
    const dialog = this.splitRulesContainer.querySelector('.split-rule-dialog');
    if (dialog) {
      dialog.remove();
    }
    
    // Show hidden rules again
    const existingRules = this.splitRulesContainer.querySelectorAll('.split-rule-item');
    existingRules.forEach(item => item.style.display = 'flex');
    
    // Show empty state if no rules
    if (this.converter.splitRules.length === 0) {
      const emptyState = this.splitRulesContainer.querySelector('.empty-state-sm');
      if (emptyState) {
        emptyState.style.display = 'flex';
      }
    }
  }

  confirmSplitRule() {
    const sourceColumn = document.getElementById('splitSourceColumn').value;
    const delimiter = document.getElementById('splitDelimiter').value;
    const columnNames = Array.from(document.querySelectorAll('#splitColumnNames input')).map(inp => inp.value);

    if (!delimiter) {
      alert('Please enter a delimiter.');
      return;
    }

    if (columnNames.some(name => !name.trim())) {
      alert('Please provide names for all columns.');
      return;
    }

    const rule = this.converter.addSplitRule(sourceColumn, delimiter, columnNames);
    this.closeSplitDialog();
    this.renderSplitRules();
  }

  renderSplitRules() {
    const emptyState = this.splitRulesContainer.querySelector('.empty-state-sm');
    const existingRules = this.splitRulesContainer.querySelectorAll('.split-rule-item');
    existingRules.forEach(item => item.remove());

    if (this.converter.splitRules.length === 0) {
      if (emptyState) emptyState.style.display = 'flex';
      return;
    }

    if (emptyState) emptyState.style.display = 'none';

    this.converter.splitRules.forEach(rule => {
      const ruleDiv = document.createElement('div');
      ruleDiv.className = 'split-rule-item';
      ruleDiv.innerHTML = `
        <div class="split-rule-content">
          <div class="split-rule-header">
            <strong>${rule.sourceColumn}</strong>
            <span class="rule-arrow">→</span>
            <span class="rule-columns">${rule.columnNames.join(', ')}</span>
          </div>
          <div class="split-rule-meta">
            Delimiter: <code>${rule.delimiter}</code>
          </div>
        </div>
        <div class="split-rule-actions">
          <button class="btn-icon" onclick="window.ldifToCsvUI.editSplitRule(${rule.id})" title="Edit rule">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/></svg>
          </button>
          <button class="btn-icon" onclick="window.ldifToCsvUI.removeSplitRule(${rule.id})" title="Remove rule">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
          </button>
        </div>
      `;
      this.splitRulesContainer.appendChild(ruleDiv);
    });
  }

  removeSplitRule(ruleId) {
    this.converter.removeSplitRule(ruleId);
    this.renderSplitRules();
  }

  editSplitRule(ruleId) {
    const rule = this.converter.splitRules.find(r => r.id === ruleId);
    if (!rule) return;

    const selectedAttrs = this.getSelectedAttributes();
    
    // Create edit dialog HTML
    const dialogHtml = `
      <div class="split-rule-form">
        <div class="form-group">
          <label for="splitSourceColumn">Column to Split</label>
          <select id="splitSourceColumn" class="input">
            ${selectedAttrs.map(attr => `<option value="${attr}" ${attr === rule.sourceColumn ? 'selected' : ''}>${attr}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label for="splitDelimiter">Split Delimiter</label>
          <input type="text" id="splitDelimiter" class="input" placeholder="e.g., , or | or -" value="${rule.delimiter}" />
          <span class="hint">Character(s) used to split the value</span>
        </div>
        <div class="form-group">
          <label for="splitColumnCount">Number of Columns</label>
          <input type="number" id="splitColumnCount" class="input" value="${rule.columnNames.length}" min="2" max="10" />
          <span class="hint">How many columns to create from the split</span>
        </div>
        <div class="form-group">
          <label>Column Names</label>
          <div id="splitColumnNames"></div>
        </div>
        <div class="form-group">
          <label>Preview (first 3 rows)</label>
          <div id="splitPreview" class="split-preview"></div>
        </div>
        <div class="dialog-actions">
          <button class="btn btn-secondary" onclick="window.ldifToCsvUI.closeSplitDialog()">Cancel</button>
          <button class="btn btn-primary" onclick="window.ldifToCsvUI.confirmEditSplitRule(${ruleId})">Save Changes</button>
        </div>
      </div>
    `;

    // Remove existing rule display temporarily
    const existingRules = this.splitRulesContainer.querySelectorAll('.split-rule-item');
    existingRules.forEach(item => item.style.display = 'none');

    const formDiv = document.createElement('div');
    formDiv.className = 'split-rule-dialog';
    formDiv.innerHTML = dialogHtml;
    this.splitRulesContainer.appendChild(formDiv);

    // Set up dynamic column name inputs with existing values
    const columnCountInput = document.getElementById('splitColumnCount');
    const updateColumnNameInputs = () => {
      const count = parseInt(columnCountInput.value) || 2;
      const container = document.getElementById('splitColumnNames');
      container.innerHTML = '';
      
      for (let i = 0; i < count; i++) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'input input-sm';
        input.placeholder = `Column ${i + 1}`;
        input.value = rule.columnNames[i] || `Column ${i + 1}`;
        input.dataset.index = i;
        container.appendChild(input);
      }
      
      updatePreview();
    };

    const updatePreview = () => {
      const sourceColumn = document.getElementById('splitSourceColumn').value;
      const delimiter = document.getElementById('splitDelimiter').value;
      
      if (!delimiter) {
        document.getElementById('splitPreview').innerHTML = '<em>Enter a delimiter to see preview</em>';
        return;
      }

      const samples = this.converter.getSplitPreview(sourceColumn, delimiter, 3);
      
      if (samples.length === 0) {
        document.getElementById('splitPreview').innerHTML = '<em>No data available</em>';
        return;
      }

      let previewHtml = '<table class="preview-table"><thead><tr>';
      const columnNames = Array.from(document.querySelectorAll('#splitColumnNames input')).map(inp => inp.value);
      columnNames.forEach(name => {
        previewHtml += `<th>${name}</th>`;
      });
      previewHtml += '</tr></thead><tbody>';
      
      samples.forEach(parts => {
        previewHtml += '<tr>';
        for (let i = 0; i < columnNames.length; i++) {
          const value = parts[i] || '<em>empty</em>';
          previewHtml += `<td>${value}</td>`;
        }
        previewHtml += '</tr>';
      });
      
      previewHtml += '</tbody></table>';
      document.getElementById('splitPreview').innerHTML = previewHtml;
    };

    columnCountInput.addEventListener('input', updateColumnNameInputs);
    document.getElementById('splitSourceColumn').addEventListener('change', updatePreview);
    document.getElementById('splitDelimiter').addEventListener('input', updatePreview);

    updateColumnNameInputs();
  }

  confirmEditSplitRule(ruleId) {
    const sourceColumn = document.getElementById('splitSourceColumn').value;
    const delimiter = document.getElementById('splitDelimiter').value;
    const columnNames = Array.from(document.querySelectorAll('#splitColumnNames input')).map(inp => inp.value);

    if (!delimiter) {
      alert('Please enter a delimiter.');
      return;
    }

    if (columnNames.some(name => !name.trim())) {
      alert('Please provide names for all columns.');
      return;
    }

    this.converter.updateSplitRule(ruleId, {
      sourceColumn,
      delimiter,
      columnNames
    });
    
    this.closeSplitDialog();
    this.renderSplitRules();
  }

  convert() {
    const selectedAttributes = this.getSelectedAttributes();
    
    if (selectedAttributes.length === 0) {
      this.preview.textContent = '⚠️ Please select at least one attribute to include in CSV';
      return;
    }

    const options = {
      delimiter: this.delimiterInput.value || ',',
      quoteChar: this.quoteCharInput.value || '"',
      multiValueSeparator: this.multiValueSeparator.value || '; '
    };

    const csvOutput = this.converter.convertToCsv(selectedAttributes, options);
    this.preview.textContent = csvOutput;
    
    // Calculate total columns (accounting for split rules)
    let totalColumns = selectedAttributes.length;
    this.converter.splitRules.forEach(rule => {
      if (rule.enabled && selectedAttributes.includes(rule.sourceColumn)) {
        totalColumns += (rule.columnNames.length - 1); // -1 because original column is replaced
      }
    });
    
    // Show stats
    this.conversionStats.hidden = false;
    const splitInfo = this.converter.splitRules.length > 0 
      ? ` (${this.converter.splitRules.length} split rule${this.converter.splitRules.length > 1 ? 's' : ''} applied)`
      : '';
    this.conversionStats.innerHTML = `
      <strong>✓ Conversion complete:</strong> 
      ${this.converter.getEntryCount()} entries × ${totalColumns} columns${splitInfo}
    `;

    this.downloadBtn.disabled = false;
  }

  download() {
    const csvContent = this.converter.getCsvOutput();
    if (!csvContent) return;

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const timestamp = new Date().toISOString().slice(0, 10);
    link.href = URL.createObjectURL(blob);
    link.download = `ldif-export-${timestamp}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }

  copyToClipboard() {
    const content = this.preview.textContent;
    navigator.clipboard.writeText(content).then(() => {
      // Visual feedback
      const originalTitle = this.copyBtn.title;
      this.copyBtn.title = 'Copied!';
      setTimeout(() => {
        this.copyBtn.title = originalTitle;
      }, 2000);
    }).catch(err => {
      console.error('Failed to copy:', err);
    });
  }

  reset() {
    this.converter.reset();
    
    // Reset file input
    this.ldifInput.value = '';
    this.ldifStatus.textContent = 'No file selected';
    this.ldifStatus.classList.remove('success', 'error');

    // Reset paste area
    this.ldifPasteArea.value = '';

    // Reset attribute selection
    this.attributeHint.style.display = 'flex';
    this.attributeInterface.style.display = 'none';
    this.attributeCheckboxes.innerHTML = '';
    this.selectAllBtn.disabled = true;
    this.deselectAllBtn.disabled = true;

    // Reset column splitting
    this.columnSplitCard.style.display = 'none';
    const emptyState = this.splitRulesContainer.querySelector('.empty-state-sm');
    if (emptyState) emptyState.style.display = 'flex';
    this.splitRulesContainer.querySelectorAll('.split-rule-item, .split-rule-dialog').forEach(el => el.remove());

    // Reset preview
    this.conversionStats.hidden = true;
    this.preview.textContent = 'Upload an LDIF file and select attributes to see preview...';
    
    // Reset buttons
    this.convertBtn.disabled = true;
    this.downloadBtn.disabled = true;
  }
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
  window.ldifToCsvUI = new LdifToCsvUI();
});
