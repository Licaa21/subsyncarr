const API_BASE = window.__BASE_PATH__ || '';

class SubsyncarrPlusClient {
  constructor() {
    this.ws = null;
    this.state = { currentRun: null, files: [], isRunning: false };
    this.reconnectInterval = 3000;
    this.historyCache = {}; // Cache run data for file lookups
    this.selectedPaths = [];
    this.lastMessageAt = Date.now();
    this.reconnectTimer = null;
    this.polling = false;
    this.engineStats = {}; // learned average duration (ms) per engine, from finished steps
    this.countedSteps = new Set();
    this.lastPercent = { runId: null, value: 0 };

    this.initWebSocket();
    this.setupEventHandlers();
    this.fetchInitialState();
    this.fetchConfigStatus();
    this.startLiveness();
  }

  initWebSocket() {
    // Drop any previous socket quietly so a late close event can't spawn a second one.
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
      try {
        this.ws.close();
      } catch (e) {
        /* already closed */
      }
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}${API_BASE}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      console.log('WebSocket connected');
      this.lastMessageAt = Date.now();
    };

    ws.onmessage = (event) => {
      this.lastMessageAt = Date.now();
      const msg = JSON.parse(event.data);
      if (msg.type === 'ping') return; // server heartbeat
      this.handleMessage(msg);
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected, reconnecting...');
      this.scheduleReconnect();
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.initWebSocket();
    }, this.reconnectInterval);
  }

  // Keeps the page live even when the WebSocket silently dies (proxy idle timeout,
  // sleeping device, flaky network): a watchdog restarts a socket that went quiet,
  // a light poll re-syncs state while a run is active or the socket is down, and a
  // 1s ticker updates the elapsed time of the engine currently working.
  startLiveness() {
    setInterval(() => {
      const open = this.ws && this.ws.readyState === WebSocket.OPEN;
      if (open && Date.now() - this.lastMessageAt > 45000) {
        console.warn('No data from server for 45s, reconnecting WebSocket');
        this.ws.close();
        this.scheduleReconnect();
      } else if (!open && !this.reconnectTimer && (!this.ws || this.ws.readyState === WebSocket.CLOSED)) {
        this.scheduleReconnect();
      }
    }, 5000);

    setInterval(() => this.pollStatus(), 5000);

    setInterval(() => this.tickElapsed(), 1000);
  }

  async pollStatus() {
    const open = this.ws && this.ws.readyState === WebSocket.OPEN;
    if (this.polling || (open && !this.state.isRunning)) return;
    this.polling = true;
    try {
      const response = await fetch(`${API_BASE}/api/status`);
      if (!response.ok) return;
      const wasRunning = this.state.isRunning;
      this.state = await response.json();
      this.render();
      if (wasRunning && !this.state.isRunning) this.fetchHistory();
    } catch (error) {
      /* offline for a moment; the next poll retries */
    } finally {
      this.polling = false;
    }
  }

  formatElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  tickElapsed() {
    document.querySelectorAll('.engine-elapsed[data-since]').forEach((el) => {
      el.textContent = this.formatElapsed(Date.now() - Number(el.dataset.since));
    });
    this.updateLiveProgress();
  }

  // Engines don't report progress, so estimate it: the longer the current engine has been
  // running compared with how long that engine usually takes, the further the bar moves
  // through that step. It approaches but never reaches the end of a step, so the bar
  // can't run ahead of reality, and the real completion event always moves it on.
  learnEngineDurations() {
    for (const file of this.state.files || []) {
      let engines;
      try {
        engines = JSON.parse(file.engines || '{}');
      } catch (e) {
        continue;
      }
      for (const [engine, result] of Object.entries(engines)) {
        const key = `${file.file_path}|${engine}`;
        if (!result || !result.success || result.skipped || !(result.duration > 1000)) continue;
        if (this.countedSteps.has(key)) continue;
        this.countedSteps.add(key);
        const stat = (this.engineStats[engine] = this.engineStats[engine] || { sum: 0, n: 0 });
        stat.sum += result.duration;
        stat.n += 1;
      }
    }
  }

  expectedEngineMs(engine) {
    const stat = this.engineStats[engine];
    if (stat && stat.n > 0) return stat.sum / stat.n;
    const defaults = { alass: 90000, ffsubsync: 200000, autosubsync: 180000 };
    return defaults[engine] || 120000;
  }

  stepFraction(file, now) {
    if (!file.current_engine || !file.updated_at) return 0;
    const ratio = Math.max(0, now - file.updated_at) / this.expectedEngineMs(file.current_engine);
    // Linear up to 90% of the step, then a slow approach to 99% if the engine runs long.
    return ratio <= 0.9 ? ratio : 0.9 + 0.09 * (1 - Math.exp(-(ratio - 0.9) * 3));
  }

  updateLiveProgress() {
    const { currentRun } = this.state;
    if (!currentRun || currentRun.status === 'completed' || !(currentRun.total_engines > 0)) return;

    this.learnEngineDurations();
    const now = Date.now();
    const partial = this.state.isRunning
      ? (this.state.files || [])
          .filter((f) => f.status === 'processing')
          .reduce((sum, f) => sum + this.stepFraction(f, now), 0)
      : 0;

    let percent = Math.min(((currentRun.completed_engines + partial) / currentRun.total_engines) * 100, 99.9);
    if (currentRun.completed_engines >= currentRun.total_engines) percent = 100;

    // Never move backwards within a run (e.g. when an estimate is replaced by the real result).
    if (this.lastPercent.runId !== currentRun.id) this.lastPercent = { runId: currentRun.id, value: 0 };
    percent = Math.max(percent, this.lastPercent.value);
    this.lastPercent.value = percent;

    const fill = document.getElementById('progressFill');
    fill.style.width = `${percent}%`;
    fill.classList.toggle('active', this.state.isRunning && percent < 100);
    document.getElementById('progressText').textContent =
      `${currentRun.completed} / ${currentRun.total_files} files (${percent.toFixed(1)}%)`;
    document.getElementById('progressText').title =
      `${currentRun.completed_engines} / ${currentRun.total_engines} engine steps done (current step is estimated)`;
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'state':
        this.state = msg.data;
        this.render();
        break;
      case 'run:started':
        this.state.currentRun = msg.data;
        this.state.isRunning = true;
        this.render();
        break;
      case 'run:completed':
        this.state.currentRun = msg.data;
        this.state.isRunning = false;
        this.render();
        this.fetchHistory();
        break;
      case 'run:cancelled':
        this.state.currentRun = msg.data;
        this.state.isRunning = false;
        this.render();
        this.fetchHistory();
        break;
      case 'file:updated':
        this.updateFile(msg.data.file);
        if (msg.data.run) {
          this.state.currentRun = msg.data.run;
        }
        this.render();
        break;
      case 'files:cleared':
        this.state.currentRun = msg.data.currentRun;
        this.state.files = msg.data.files;
        this.render();
        break;
    }
  }

  updateFile(fileData) {
    const index = this.state.files.findIndex((f) => f.file_path === fileData.file_path);
    if (index >= 0) {
      this.state.files[index] = fileData;
    } else {
      this.state.files.push(fileData);
    }
  }

  async fetchInitialState() {
    const response = await fetch(`${API_BASE}/api/status`);
    const data = await response.json();
    this.state = data;
    this.render();
    this.fetchHistory();
  }

  async fetchHistory() {
    const response = await fetch(`${API_BASE}/api/history`);
    const history = await response.json();

    // Fetch file results for each run to calculate engine stats
    const historyWithStats = await Promise.all(
      history.map(async (run) => {
        try {
          const filesResponse = await fetch(`${API_BASE}/api/runs/${run.id}`);
          const data = await filesResponse.json();
          const runWithFiles = { ...run, files: data.files || [] };
          // Cache for file list lookups
          this.historyCache[run.id] = runWithFiles;
          return runWithFiles;
        } catch (error) {
          console.error(`Failed to fetch files for run ${run.id}:`, error);
          return { ...run, files: [] };
        }
      }),
    );

    this.renderHistory(historyWithStats);
  }

  async fetchConfigStatus() {
    try {
      const response = await fetch(`${API_BASE}/api/config`);
      const config = await response.json();
      this.renderConfigStatus(config);
    } catch (error) {
      console.error('Failed to fetch config status:', error);
      this.renderConfigStatus({ isConfigured: false, paths: [], excludePaths: [] });
    }
  }

  renderConfigStatus(config) {
    // Render path status
    const light = document.getElementById('statusLight');
    const label = document.getElementById('statusLabel');
    const paths = document.getElementById('statusPaths');

    if (config.isConfigured) {
      light.className = 'status-light active';
      label.textContent = 'Watching Folders';
      const pathsList = config.paths.join(', ');
      paths.textContent = pathsList;
      paths.title = pathsList; // Show full path on hover
    } else {
      light.className = 'status-light inactive';
      label.textContent = 'No Paths Configured';
      paths.textContent = 'Using default: /scan_dir';
    }

    // Render schedule status
    this.renderScheduleStatus(config.schedule);
  }

  renderScheduleStatus(schedule) {
    const scheduleLabel = document.getElementById('scheduleLabel');
    const scheduleTime = document.getElementById('scheduleTime');

    if (schedule && schedule.enabled) {
      scheduleLabel.textContent = 'Next Scheduled Scan';

      if (schedule.nextRun) {
        const nextRunDate = new Date(schedule.nextRun);
        const now = new Date();
        const diff = nextRunDate - now;

        // Format time until next run
        const timeUntil = this.formatTimeUntil(diff);
        scheduleTime.textContent = `${nextRunDate.toLocaleString()} (${timeUntil})`;
        scheduleTime.title = `Schedule: ${schedule.description}`;

        // Update countdown every minute
        if (this.scheduleUpdateTimer) {
          clearInterval(this.scheduleUpdateTimer);
        }
        this.scheduleUpdateTimer = setInterval(() => {
          this.fetchConfigStatus();
        }, 60000); // Update every minute
      } else {
        scheduleTime.textContent = schedule.description || schedule.cron;
      }
    } else {
      scheduleLabel.textContent = 'Auto-Scan Disabled';
      scheduleTime.textContent = 'Manual runs only';
    }
  }

  formatTimeUntil(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `in ${days} day${days > 1 ? 's' : ''}`;
    } else if (hours > 0) {
      return `in ${hours} hour${hours > 1 ? 's' : ''}`;
    } else if (minutes > 0) {
      return `in ${minutes} minute${minutes > 1 ? 's' : ''}`;
    } else {
      return 'very soon';
    }
  }

  setupEventHandlers() {
    document.getElementById('startRun').addEventListener('click', () => {
      this.startRun();
    });

    document.getElementById('startCustom').addEventListener('click', () => {
      this.openPicker();
    });

    document.getElementById('stopRun').addEventListener('click', () => {
      this.stopRun();
    });

    document.getElementById('closeModal').addEventListener('click', () => {
      this.closePicker();
    });

    document.getElementById('cancelCustom').addEventListener('click', () => {
      this.closePicker();
    });

    document.getElementById('submitCustom').addEventListener('click', () => {
      if (this.selectedPaths.length === 0) {
        alert('Add at least one path before starting a scan.');
        return;
      }
      const paths = this.selectedPaths.slice();
      this.closePicker();
      this.startRun(paths);
    });

    // Close modal when clicking outside
    document.getElementById('customPathModal').addEventListener('click', (e) => {
      if (e.target.id === 'customPathModal') {
        this.closePicker();
      }
    });

    // Logs modal handlers
    document.getElementById('closeLogsModal').addEventListener('click', () => {
      document.getElementById('logsModal').classList.add('hidden');
    });

    document.getElementById('closeLogsButton').addEventListener('click', () => {
      document.getElementById('logsModal').classList.add('hidden');
    });

    document.getElementById('copyLogs').addEventListener('click', async () => {
      const logsContent = document.getElementById('logsContent').textContent;
      try {
        await navigator.clipboard.writeText(logsContent);
        const btn = document.getElementById('copyLogs');
        const originalText = btn.textContent;
        btn.textContent = '✓ Copied!';
        setTimeout(() => {
          btn.textContent = originalText;
        }, 2000);
      } catch (err) {
        console.error('Failed to copy logs:', err);
        // Fallback method for older browsers or permission issues
        const textArea = document.createElement('textarea');
        textArea.value = logsContent;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        document.body.appendChild(textArea);
        textArea.select();
        try {
          document.execCommand('copy');
          const btn = document.getElementById('copyLogs');
          const originalText = btn.textContent;
          btn.textContent = '✓ Copied!';
          setTimeout(() => {
            btn.textContent = originalText;
          }, 2000);
        } catch (execErr) {
          console.error('Fallback copy also failed:', execErr);
          alert('Failed to copy logs to clipboard');
        }
        document.body.removeChild(textArea);
      }
    });

    // Close logs modal when clicking outside
    document.getElementById('logsModal').addEventListener('click', (e) => {
      if (e.target.id === 'logsModal') {
        document.getElementById('logsModal').classList.add('hidden');
      }
    });

    // Clear completed files
    document.getElementById('clearCompleted').addEventListener('click', () => {
      this.clearCompleted();
    });

    // File list modal handlers
    document.getElementById('closeFileListModal').addEventListener('click', () => {
      document.getElementById('fileListModal').classList.add('hidden');
    });

    document.getElementById('closeFileListButton').addEventListener('click', () => {
      document.getElementById('fileListModal').classList.add('hidden');
    });

    // Close file list modal when clicking outside
    document.getElementById('fileListModal').addEventListener('click', (e) => {
      if (e.target.id === 'fileListModal') {
        document.getElementById('fileListModal').classList.add('hidden');
      }
    });
  }

  async openPicker() {
    this.selectedPaths = [];
    this.renderSelectedPaths();
    const tree = document.getElementById('folderTree');
    tree.innerHTML = '<div class="tree-loading">Loading…</div>';
    document.getElementById('customPathModal').classList.remove('hidden');
    try {
      const data = await this.fetchBrowse(null);
      tree.innerHTML = '';
      if (data.entries.length === 0) {
        tree.innerHTML = '<div class="tree-empty">No paths configured. Set SCAN_PATHS env var.</div>';
        return;
      }
      data.entries.forEach((entry) => tree.appendChild(this.makeTreeRow(entry, 0)));
    } catch (err) {
      tree.innerHTML = `<div class="tree-error">Failed to load: ${this.escapeHtml(err.message)}</div>`;
    }
  }

  closePicker() {
    document.getElementById('customPathModal').classList.add('hidden');
  }

  async fetchBrowse(path) {
    const url = path ? `${API_BASE}/api/browse?path=${encodeURIComponent(path)}` : `${API_BASE}/api/browse`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  makeTreeRow(entry, depth) {
    const wrapper = document.createElement('div');
    wrapper.className = 'tree-node';

    const isFile = entry.isDir === false;

    const row = document.createElement('div');
    row.className = isFile ? 'tree-row tree-row-file' : 'tree-row';
    row.style.paddingLeft = `${depth * 16}px`;

    const chevron = document.createElement('span');
    chevron.className = 'tree-chevron';
    chevron.textContent = isFile ? '' : '▶';

    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.textContent = isFile ? '📄' : '📁';

    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = entry.name;
    name.title = entry.path;

    row.appendChild(chevron);
    row.appendChild(icon);
    row.appendChild(name);

    if (isFile) {
      // Files are display-only — no expand, no add.
      wrapper.appendChild(row);
      return wrapper;
    }

    const addBtn = document.createElement('button');
    addBtn.className = 'tree-add';
    addBtn.textContent = '+';
    addBtn.title = 'Add this path';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.addSelectedPath(entry.path);
    });
    row.appendChild(addBtn);

    const children = document.createElement('div');
    children.className = 'tree-children hidden';
    let loaded = false;

    const toggle = async () => {
      if (!loaded) {
        loaded = true;
        children.innerHTML = '<div class="tree-loading" style="padding-left:' + (depth + 1) * 16 + 'px">Loading…</div>';
        children.classList.remove('hidden');
        chevron.textContent = '▼';
        try {
          const data = await this.fetchBrowse(entry.path);
          children.innerHTML = '';
          if (data.entries.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'tree-empty';
            empty.style.paddingLeft = `${(depth + 1) * 16}px`;
            empty.textContent = '(empty)';
            children.appendChild(empty);
          } else {
            data.entries.forEach((child) => children.appendChild(this.makeTreeRow(child, depth + 1)));
          }
        } catch (err) {
          children.innerHTML = '';
          const errEl = document.createElement('div');
          errEl.className = 'tree-error';
          errEl.style.paddingLeft = `${(depth + 1) * 16}px`;
          errEl.textContent = `Failed to load: ${err.message}`;
          children.appendChild(errEl);
        }
        return;
      }
      const willOpen = children.classList.contains('hidden');
      children.classList.toggle('hidden');
      chevron.textContent = willOpen ? '▼' : '▶';
    };

    chevron.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle();
    });
    name.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle();
    });

    wrapper.appendChild(row);
    wrapper.appendChild(children);
    return wrapper;
  }

  addSelectedPath(path) {
    if (this.selectedPaths.includes(path)) return;
    this.selectedPaths.push(path);
    this.renderSelectedPaths();
  }

  removeSelectedPath(path) {
    this.selectedPaths = this.selectedPaths.filter((p) => p !== path);
    this.renderSelectedPaths();
  }

  renderSelectedPaths() {
    const list = document.getElementById('selectedPaths');
    const empty = document.getElementById('selectedPathsEmpty');
    list.innerHTML = '';
    if (this.selectedPaths.length === 0) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    this.selectedPaths.forEach((path) => {
      const li = document.createElement('li');
      li.dataset.fullpath = path;
      li.title = path;
      const span = document.createElement('span');
      span.className = 'selected-path-text';
      span.textContent = path;
      const btn = document.createElement('button');
      btn.className = 'selected-path-remove';
      btn.textContent = '×';
      btn.title = 'Remove';
      btn.addEventListener('click', () => this.removeSelectedPath(path));
      li.appendChild(span);
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  async startRun(paths = null) {
    try {
      const response = await fetch(`${API_BASE}/api/run/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths }),
      });

      if (!response.ok) {
        const error = await response.json();
        alert(`Failed to start run: ${error.error}`);
      }
    } catch (error) {
      alert(`Failed to start run: ${error.message}`);
    }
  }

  async stopRun() {
    if (!confirm('Are you sure you want to stop the current run? All processing will be halted.')) {
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/api/run/stop`, {
        method: 'POST',
      });

      if (!response.ok) {
        const error = await response.json();
        alert(`Failed to stop run: ${error.error}`);
      }
    } catch (error) {
      alert(`Failed to stop run: ${error.message}`);
    }
  }

  async skipFile(filePath) {
    try {
      await fetch(`${API_BASE}/api/file/skip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath }),
      });
    } catch (error) {
      console.error('Failed to skip file:', error);
    }
  }

  async viewLogs(runId) {
    try {
      const response = await fetch(`${API_BASE}/api/runs/${runId}/logs`);
      const data = await response.json();

      document.getElementById('logsContent').textContent = data.logs || 'No logs available';
      document.getElementById('logsModal').classList.remove('hidden');
    } catch (error) {
      console.error('Failed to fetch logs:', error);
      alert('Failed to load logs');
    }
  }

  async clearCompleted() {
    if (!confirm('Are you sure you want to clear all completed and skipped files?')) {
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/api/files/clear`, {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error('Failed to clear files');
      }

      // State will be updated via WebSocket message
    } catch (error) {
      console.error('Failed to clear files:', error);
      alert('Failed to clear files');
    }
  }

  render() {
    this.renderProgress();
    this.renderFiles();
    this.updateButtonVisibility();
  }

  updateButtonVisibility() {
    const stopButton = document.getElementById('stopRun');
    const startButton = document.getElementById('startRun');
    const customButton = document.getElementById('startCustom');

    if (this.state.isRunning) {
      stopButton.classList.remove('hidden');
      startButton.classList.add('hidden');
      customButton.classList.add('hidden');
    } else {
      stopButton.classList.add('hidden');
      startButton.classList.remove('hidden');
      customButton.classList.remove('hidden');
    }
  }

  renderProgress() {
    const { currentRun } = this.state;
    const section = document.getElementById('currentRun');

    if (!currentRun || currentRun.status === 'completed') {
      section.classList.add('hidden');
      return;
    }

    section.classList.remove('hidden');

    this.updateLiveProgress();
  }

  renderFiles() {
    const processing = this.state.files.filter((f) => f.status === 'processing');
    const completed = this.state.files.filter((f) => ['completed', 'skipped', 'error'].includes(f.status));

    // Render processing files
    const progressHtml = processing
      .map((file) => {
        const engines = JSON.parse(file.engines);
        return `
        <div class="file-card processing">
          <div class="file-header">
            <div class="file-name">${this.basename(file.file_path)}</div>
            <button class="btn-skip" onclick="client.skipFile('${file.file_path.replace(/'/g, "\\'")}')">
              Skip
            </button>
          </div>
          <div class="engine-status">
            ${
              file.current_engine
                ? `⚙️ Working on ${file.current_engine} · <span class="engine-elapsed" data-since="${file.updated_at || Date.now()}">${this.formatElapsed(Date.now() - (file.updated_at || Date.now()))}</span>`
                : 'Starting...'
            }
          </div>
          ${this.renderEngineResults(engines)}
        </div>
      `;
      })
      .join('');

    document.getElementById('filesInProgress').innerHTML = progressHtml;

    // Render completed files
    const completedHtml = completed
      .map((file) => {
        const engines = JSON.parse(file.engines);
        return `
        <div class="file-card ${file.status}">
          <div class="file-name">${this.basename(file.file_path)}</div>
          ${this.renderEngineResults(engines)}
        </div>
      `;
      })
      .join('');

    document.getElementById('completedList').innerHTML =
      completedHtml || '<p class="no-data">No completed files yet</p>';
  }

  renderEngineResults(engines) {
    return Object.entries(engines)
      .map(([name, result]) => {
        const icon = result.success ? '✓' : '✗';
        const className = result.success ? 'success' : 'error';
        const duration = (result.duration / 1000).toFixed(1);
        const error =
          !result.success && result.message
            ? `<div class="engine-error-message">${this.escapeHtml(result.message)}</div>`
            : '';

        return `
        <div class="engine-result ${className}">
          <div class="engine-result-row">
            <span>${icon} ${name}</span>
            <span class="duration">${duration}s</span>
          </div>
          ${error}
        </div>
      `;
      })
      .join('');
  }

  calculateEngineStats(files) {
    const stats = {
      ffsubsync: { pass: 0, fail: 0 },
      autosubsync: { pass: 0, fail: 0 },
      alass: { pass: 0, fail: 0 },
    };

    files.forEach((file) => {
      try {
        const engines = JSON.parse(file.engines);
        Object.entries(engines).forEach(([engineName, result]) => {
          if (stats[engineName]) {
            if (result.success) {
              stats[engineName].pass++;
            } else {
              stats[engineName].fail++;
            }
          }
        });
      } catch (error) {
        console.error('Error parsing engine data:', error);
      }
    });

    return stats;
  }

  renderEngineCell(engineStats) {
    if (engineStats.pass === 0 && engineStats.fail === 0) {
      return '<td class="engine-cell">-</td>';
    }

    const parts = [];
    if (engineStats.pass > 0) {
      parts.push(`<span class="engine-pass">${engineStats.pass}</span>`);
    }
    if (engineStats.fail > 0) {
      parts.push(`<span class="engine-fail">${engineStats.fail}</span>`);
    }

    return `<td class="engine-cell">${parts.join('/')}</td>`;
  }

  renderHistory(runs) {
    const html = runs
      .map((run) => {
        const duration = run.end_time ? ((run.end_time - run.start_time) / 1000).toFixed(0) + 's' : 'Running...';
        const engineStats = this.calculateEngineStats(run.files || []);

        // Make stats clickable if there are files in that category
        const completedCell =
          run.completed > 0
            ? `<span class="stat-clickable stat-completed" onclick="client.showFileList('${run.id}', 'completed')">${run.completed}</span>`
            : run.completed;
        const skippedCell =
          run.skipped > 0
            ? `<span class="stat-clickable stat-skipped" onclick="client.showFileList('${run.id}', 'skipped')">${run.skipped}</span>`
            : run.skipped;
        const failedCell =
          run.failed > 0
            ? `<span class="stat-clickable stat-failed" onclick="client.showFileList('${run.id}', 'failed')">${run.failed}</span>`
            : run.failed;

        return `
        <tr>
          <td>${new Date(run.start_time).toLocaleString()}</td>
          <td><span class="status-badge ${run.status}">${run.status}</span></td>
          <td>${run.total_files}</td>
          <td>${completedCell}</td>
          <td>${skippedCell}</td>
          <td>${failedCell}</td>
          ${this.renderEngineCell(engineStats.ffsubsync)}
          ${this.renderEngineCell(engineStats.autosubsync)}
          ${this.renderEngineCell(engineStats.alass)}
          <td>${duration}</td>
          <td>
            <button class="btn-view-logs" onclick="client.viewLogs('${run.id}')">
              📄 View Logs
            </button>
          </td>
        </tr>
      `;
      })
      .join('');

    document.getElementById('historyBody').innerHTML =
      html || '<tr><td colspan="11" class="no-data">No runs yet</td></tr>';
  }

  basename(path) {
    return path.split('/').pop();
  }

  // Extract clean movie/show title from filename
  cleanFileName(filePath) {
    // Get just the filename from the path
    let name = filePath.split('/').pop();

    // Remove file extension (.srt, .eng.srt, .eng.sdh.srt, etc.)
    name = name.replace(/\.(eng|spa|fre|ger|ita|por|jpn|kor|chi|rus|ara|hin|pol|dut|swe|nor|dan|fin|tur|heb|tha|vie|ind|msa|hun|ces|slk|ron|bul|ukr|ell|srp|hrv|slv|lit|lav|est|cat|eus|glg|sdh)?\.(srt|sub|ass|ssa|vtt)$/i, '');
    name = name.replace(/\.(srt|sub|ass|ssa|vtt)$/i, '');

    // Try to extract just the title with year
    // Pattern: "Movie Title (Year)" followed by metadata in brackets
    const titleMatch = name.match(/^(.+?\s*\(\d{4}\))/);
    if (titleMatch) {
      return titleMatch[1].trim();
    }

    // Fallback: remove common metadata patterns
    // Remove [imdbid-...], [Bluray-...], [AAC ...], [x265], etc.
    name = name.replace(/\s*\[.*?\]/g, '');
    // Remove release group tags at the end like -DDR, -YTS.MX
    name = name.replace(/\s*-[A-Za-z0-9.]+$/, '');
    // Clean up extra whitespace
    name = name.replace(/\s+/g, ' ').trim();

    return name || filePath.split('/').pop();
  }

  // Show files in a category for a specific run
  showFileList(runId, category) {
    const run = this.historyCache[runId];
    if (!run || !run.files) {
      alert('File data not available for this run');
      return;
    }

    let files = [];
    let title = '';

    switch (category) {
      case 'completed':
        files = run.files.filter((f) => f.status === 'completed');
        title = `Completed Files (${files.length})`;
        break;
      case 'skipped':
        files = run.files.filter((f) => f.status === 'skipped');
        title = `Skipped Files (${files.length})`;
        break;
      case 'failed':
        files = run.files.filter((f) => f.status === 'error');
        title = `Failed Files (${files.length})`;
        break;
      default:
        return;
    }

    document.getElementById('fileListTitle').textContent = title;

    if (files.length === 0) {
      document.getElementById('fileListContent').innerHTML =
        '<div class="file-list-empty">No files in this category</div>';
    } else {
      const html = files
        .map((file) => {
          const name = this.cleanFileName(file.file_path);
          const errors = category === 'failed' ? this.renderFileErrors(file) : '';
          return `<div class="file-list-item">${this.escapeHtml(name)}${errors}</div>`;
        })
        .join('');
      document.getElementById('fileListContent').innerHTML = html;
    }

    document.getElementById('fileListModal').classList.remove('hidden');
  }

  // Render the error messages for each engine that failed on a file
  renderFileErrors(file) {
    let engines;
    try {
      engines = JSON.parse(file.engines || '{}');
    } catch {
      return '';
    }

    const failures = Object.entries(engines).filter(([, result]) => result && result.success === false);

    if (failures.length === 0) {
      return '';
    }

    return `<div class="file-list-errors">${failures
      .map(([name, result]) => {
        const message = result.message || 'Unknown error';
        const stderr = result.stderr ? `<pre class="file-error-detail">${this.escapeHtml(result.stderr)}</pre>` : '';
        return `<div class="file-error">
          <span class="file-error-engine">${this.escapeHtml(name)}</span>
          <span class="file-error-message">${this.escapeHtml(message)}</span>
          ${stderr}
        </div>`;
      })
      .join('')}</div>`;
  }
}

// Initialize client when DOM is ready
let client;
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    client = new SubsyncarrPlusClient();
  });
} else {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  client = new SubsyncarrClient();
}
