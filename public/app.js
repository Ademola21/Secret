const socket = io();

const state = {
    connected: false,
    status: {},
    activeTasks: [],
    logs: [],
    nanoLogs: [],
    wallets: [],
    selectedWallet: null,
    walletData: null,
    currentSection: 'automation',
    syncIntervalId: null,
    autoSyncEnabled: true,
    autoSyncInterval: 1000,
    contacts: JSON.parse(localStorage.getItem('nanoContacts') || '[]'),
    pendingTransaction: null,
    previousPendingCount: 0,
    networkConnected: false
};

const elements = {
    connectionStatus: document.getElementById('connectionStatus'),
    taskGrid: document.getElementById('taskGrid'),
    activeTasks: document.getElementById('activeTasks'),
    activeCount: document.getElementById('activeCount'),
    screenshotContainer: document.getElementById('screenshotContainer'),
    logsContainer: document.getElementById('logsContainer'),
    stopAllBtn: document.getElementById('stopAllBtn'),
    clearLogs: document.getElementById('clearLogs'),
    customUrl: document.getElementById('customUrl'),
    customNavBtn: document.getElementById('customNavBtn'),
    walletList: document.getElementById('walletList'),
    walletDetails: document.getElementById('walletDetails'),
    nanoLogsContainer: document.getElementById('nanoLogsContainer'),
    createWalletBtn: document.getElementById('createWalletBtn'),
    syncWalletBtn: document.getElementById('syncWalletBtn'),
    sendNanoBtn: document.getElementById('sendNanoBtn'),
    receiveAllBtn: document.getElementById('receiveAllBtn'),
    pendingBlocks: document.getElementById('pendingBlocks'),
    gpuWorkerUrl: document.getElementById('gpuWorkerUrl'),
    setGpuWorkerBtn: document.getElementById('setGpuWorkerBtn'),
    clearGpuWorkerBtn: document.getElementById('clearGpuWorkerBtn'),
    gpuWorkerStatus: document.getElementById('gpuWorkerStatus')
};

const taskTypes = {
    'bot-detection-test': { name: 'Bot Detection Test', icon: '🤖', description: 'Test if browser passes bot detection' },
    'cloudflare-turnstile': { name: 'Cloudflare Turnstile', icon: '☁️', description: 'Test automatic Turnstile solving' },
    'fingerprint-test': { name: 'Fingerprint Test', icon: '🔍', description: 'Check fingerprint detection status' },
    'captcha-solver': { name: 'CAPTCHA Solver', icon: '🔓', description: 'Solve image CAPTCHAs using OCR' },
    'recaptcha-v3-test': { name: 'reCAPTCHA v3 Test', icon: '🛡️', description: 'Test reCAPTCHA v3 bypass score' },
    'behavior-simulation': { name: 'Human Behavior Sim', icon: '🧠', description: 'Simulate human browsing patterns' },
    'web-scraper': { name: 'Web Scraper', icon: '🕷️', description: 'Extract data from protected websites' },
    'form-automation': { name: 'Form Automation', icon: '📝', description: 'Auto-fill forms with human-like behavior' },
    'session-recorder': { name: 'Session Recorder', icon: '🎥', description: 'Record network activity and console' },
    'multi-page-crawler': { name: 'Multi-Page Crawler', icon: '🔗', description: 'Crawl multiple pages and extract data' },
    'screenshot-batch': { name: 'Batch Screenshots', icon: '📸', description: 'Screenshot multiple URLs in sequence' },
    'performance-audit': { name: 'Performance Audit', icon: '⚡', description: 'Analyze page load performance' }
};

function init() {
    setupSocketListeners();
    setupNavigation();
    renderTaskGrid();
    setupEventListeners();
    setupNanoListeners();
    loadWallets();
    loadGpuWorkerStatus();
    checkNetworkStatus();
    setInterval(checkNetworkStatus, 30000);
}

function setupNavigation() {
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const section = tab.dataset.section;
            switchSection(section);
        });
    });
}

function switchSection(section) {
    state.currentSection = section;
    
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.nav-tab[data-section="${section}"]`).classList.add('active');
    
    document.querySelectorAll('.section-content').forEach(s => s.classList.remove('active'));
    document.getElementById(`${section}-section`).classList.add('active');
    
    if (section === 'cryptovault' && state.selectedWallet) {
        startAutoSync();
    } else {
        stopAutoSync();
    }
}

function setupSocketListeners() {
    socket.on('connect', () => {
        state.connected = true;
        updateConnectionStatus();
    });

    socket.on('disconnect', () => {
        state.connected = false;
        updateConnectionStatus();
    });

    socket.on('status', (data) => {
        state.status = data.status;
        state.activeTasks = data.activeTasks || [];
        if (data.logs) {
            state.logs = data.logs;
            renderLogs();
        }
        renderActiveTasks();
        updateStopAllButton();
    });

    socket.on('log', (entry) => {
        state.logs.unshift(entry);
        if (state.logs.length > 200) state.logs.pop();
        addLogEntry(entry);
    });

    socket.on('screenshot', (data) => {
        renderScreenshot(data);
    });

    socket.on('nano-log', (entry) => {
        state.nanoLogs.unshift(entry);
        if (state.nanoLogs.length > 200) state.nanoLogs.pop();
        addNanoLogEntry(entry);
    });

    socket.on('nano-wallets', (data) => {
        state.wallets = data.wallets || [];
        renderWalletList();
    });
}

function setupEventListeners() {
    elements.stopAllBtn.addEventListener('click', stopAllTasks);
    elements.clearLogs.addEventListener('click', clearLogs);
    elements.customNavBtn.addEventListener('click', startCustomNavigation);
    elements.customUrl.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') startCustomNavigation();
    });
}

function setupNanoListeners() {
    elements.createWalletBtn.addEventListener('click', openCreateWalletModal);
    elements.syncWalletBtn.addEventListener('click', syncSelectedWallet);
    elements.sendNanoBtn.addEventListener('click', sendNano);
    elements.receiveAllBtn.addEventListener('click', receiveAllNano);
    elements.setGpuWorkerBtn.addEventListener('click', setGpuWorker);
    elements.clearGpuWorkerBtn.addEventListener('click', clearGpuWorker);
    
    document.getElementById('sendAllBtn').addEventListener('click', () => {
        if (state.walletData && state.walletData.balance) {
            document.getElementById('sendAmount').value = state.walletData.balance;
        }
    });
    
    document.getElementById('clearNanoLogs').addEventListener('click', () => {
        state.nanoLogs = [];
        elements.nanoLogsContainer.innerHTML = '';
    });

    document.querySelectorAll('.tx-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const txType = tab.dataset.tx;
            document.querySelectorAll('.tx-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            document.querySelectorAll('.tx-panel').forEach(p => p.classList.remove('active'));
            document.getElementById(`${txType}Panel`).classList.add('active');
        });
    });

    document.getElementById('closeCreateModal').addEventListener('click', closeCreateWalletModal);
    document.getElementById('cancelCreateWallet').addEventListener('click', closeCreateWalletModal);
    document.getElementById('confirmCreateWallet').addEventListener('click', createWallet);
    
    document.getElementById('closeCreatedModal').addEventListener('click', closeWalletCreatedModal);
    document.getElementById('confirmSavedMnemonic').addEventListener('click', closeWalletCreatedModal);
    
    document.getElementById('closeDeleteModal').addEventListener('click', closeDeleteWalletModal);
    document.getElementById('cancelDeleteWallet').addEventListener('click', closeDeleteWalletModal);
    document.getElementById('confirmDeleteWallet').addEventListener('click', confirmDeleteWallet);

    document.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.dataset.copy;
            const target = document.getElementById(targetId);
            copyToClipboardSilent(target.value, btn);
            btn.textContent = 'Copied!';
            setTimeout(() => btn.textContent = 'Copy', 2000);
        });
    });

    document.getElementById('closeSendConfirmModal').addEventListener('click', closeSendConfirmModal);
    document.getElementById('cancelSendConfirm').addEventListener('click', closeSendConfirmModal);
    document.getElementById('confirmSendBtn').addEventListener('click', confirmSendNano);

    document.getElementById('openAddressBookBtn').addEventListener('click', openAddressBookModal);
    document.getElementById('closeAddressBookModal').addEventListener('click', closeAddressBookModal);
    document.getElementById('closeAddressBook').addEventListener('click', closeAddressBookModal);
    document.getElementById('addContactBtn').addEventListener('click', addContact);

    document.getElementById('backupSeedBtn').addEventListener('click', openBackupSeedModal);
    document.getElementById('closeBackupSeedModal').addEventListener('click', closeBackupSeedModal);
    document.getElementById('cancelBackupSeed').addEventListener('click', closeBackupSeedModal);
    document.getElementById('showSeedBtn').addEventListener('click', showSeedPhrase);
}

function updateConnectionStatus() {
    const dot = elements.connectionStatus.querySelector('.status-dot');
    const text = elements.connectionStatus.querySelector('.status-text');
    
    if (state.connected) {
        dot.className = 'status-dot connected';
        text.textContent = 'Connected';
    } else {
        dot.className = 'status-dot disconnected';
        text.textContent = 'Disconnected';
    }
}

function renderTaskGrid() {
    elements.taskGrid.innerHTML = Object.entries(taskTypes).map(([type, info]) => `
        <div class="task-card" data-task="${type}">
            <div class="icon">${info.icon}</div>
            <h3>${info.name}</h3>
            <p>${info.description}</p>
        </div>
    `).join('');

    elements.taskGrid.querySelectorAll('.task-card').forEach(card => {
        card.addEventListener('click', () => {
            const taskType = card.dataset.task;
            startTask(taskType);
        });
    });
}

function renderActiveTasks() {
    if (state.activeTasks.length === 0) {
        elements.activeTasks.innerHTML = '<p class="empty-state">No active tasks</p>';
        elements.activeCount.textContent = '0';
        return;
    }

    elements.activeCount.textContent = state.activeTasks.length;
    elements.activeTasks.innerHTML = state.activeTasks.map(task => {
        const info = taskTypes[task.type] || { name: 'Custom Task', icon: '🌐' };
        return `
            <div class="active-task-item">
                <div class="task-info">
                    <div class="task-name">${info.icon} ${info.name}</div>
                    <div class="task-status">Started: ${formatTime(task.startTime)}</div>
                    ${task.url ? `<div class="task-url">${task.url}</div>` : ''}
                </div>
                <span class="status-badge ${task.status}">${task.status}</span>
                <button class="btn btn-secondary" onclick="stopTask('${task.id}')" style="margin-left: 0.5rem; padding: 0.5rem 0.75rem;">Stop</button>
            </div>
        `;
    }).join('');
}

function renderScreenshot(data) {
    const format = data.format || 'png';
    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const isLive = data.isLive ? '<span class="live-indicator">LIVE</span>' : '';
    
    elements.screenshotContainer.innerHTML = `
        <div>
            <img src="data:${mimeType};base64,${data.image}" alt="Screenshot" />
            <div class="screenshot-label">${isLive} ${data.site}</div>
        </div>
    `;
}

function renderLogs() {
    elements.logsContainer.innerHTML = '';
    state.logs.forEach(entry => addLogEntry(entry, false));
}

function addLogEntry(entry, prepend = true) {
    const levelIcons = {
        info: 'i',
        success: '+',
        warning: '!',
        error: 'x',
        action: '*'
    };

    const div = document.createElement('div');
    div.className = `log-entry ${entry.level}`;
    div.innerHTML = `
        <span class="log-time">${formatTime(entry.timestamp)}</span>
        <span class="log-level">${levelIcons[entry.level] || '.'}</span>
        <span class="log-message">${escapeHtml(entry.message)}</span>
    `;

    if (prepend) {
        elements.logsContainer.insertBefore(div, elements.logsContainer.firstChild);
    } else {
        elements.logsContainer.appendChild(div);
    }

    while (elements.logsContainer.children.length > 200) {
        elements.logsContainer.removeChild(elements.logsContainer.lastChild);
    }
}

function addNanoLogEntry(entry, prepend = true) {
    const levelIcons = {
        info: 'i',
        success: '+',
        warning: '!',
        error: 'x'
    };

    const div = document.createElement('div');
    div.className = `log-entry ${entry.level}`;
    div.innerHTML = `
        <span class="log-time">${formatTime(entry.timestamp)}</span>
        <span class="log-level">${levelIcons[entry.level] || '.'}</span>
        <span class="log-message">${escapeHtml(entry.message)}</span>
    `;

    if (prepend) {
        elements.nanoLogsContainer.insertBefore(div, elements.nanoLogsContainer.firstChild);
    } else {
        elements.nanoLogsContainer.appendChild(div);
    }

    while (elements.nanoLogsContainer.children.length > 200) {
        elements.nanoLogsContainer.removeChild(elements.nanoLogsContainer.lastChild);
    }
}

function updateStopAllButton() {
    elements.stopAllBtn.disabled = state.activeTasks.length === 0;
}

async function startTask(taskType, options = {}) {
    try {
        const response = await fetch('/api/task/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskType, options })
        });
        const data = await response.json();
        if (!data.success) {
            showError(`Failed to start task: ${data.error}`);
        }
    } catch (error) {
        showError(`Error starting task: ${error.message}`);
    }
}

function showError(message) {
    const entry = {
        timestamp: new Date().toISOString(),
        level: 'error',
        message: message
    };
    state.logs.unshift(entry);
    addLogEntry(entry);
    
    const alertDiv = document.createElement('div');
    alertDiv.className = 'error-alert';
    alertDiv.innerHTML = `<span>${escapeHtml(message)}</span><button onclick="this.parentElement.remove()">x</button>`;
    document.body.appendChild(alertDiv);
    setTimeout(() => alertDiv.remove(), 8000);
}

function showSuccess(message) {
    const alertDiv = document.createElement('div');
    alertDiv.className = 'success-alert';
    alertDiv.innerHTML = `<span>${escapeHtml(message)}</span><button onclick="this.parentElement.remove()">x</button>`;
    document.body.appendChild(alertDiv);
    setTimeout(() => alertDiv.remove(), 5000);
}

async function stopTask(taskId) {
    try {
        await fetch('/api/task/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskId })
        });
    } catch (error) {
        console.error('Error stopping task:', error);
    }
}

async function stopAllTasks() {
    try {
        await fetch('/api/task/stopall', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('Error stopping all tasks:', error);
    }
}

function startCustomNavigation() {
    const url = elements.customUrl.value.trim();
    if (!url) return;
    
    let validUrl = url;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        validUrl = 'https://' + url;
    }
    
    startTask('custom-navigate', { url: validUrl });
    elements.customUrl.value = '';
}

function clearLogs() {
    state.logs = [];
    elements.logsContainer.innerHTML = '';
}

async function loadWallets() {
    try {
        const response = await fetch('/api/nano/wallets');
        const data = await response.json();
        if (data.success) {
            state.wallets = data.wallets;
            renderWalletList();
        }
    } catch (error) {
        console.error('Failed to load wallets:', error);
    }
}

function renderWalletList() {
    if (state.wallets.length === 0) {
        elements.walletList.innerHTML = '<p class="empty-state">No wallets created yet</p>';
        return;
    }

    elements.walletList.innerHTML = state.wallets.map(w => `
        <div class="wallet-item ${state.selectedWallet === w.name ? 'selected' : ''}" data-wallet="${w.name}">
            <div class="wallet-icon">💎</div>
            <div class="wallet-info">
                <div class="wallet-name">${escapeHtml(w.name)}</div>
                <div class="wallet-address">${w.address.substring(0, 20)}...${w.address.substring(w.address.length - 8)}</div>
            </div>
            <button class="delete-wallet-btn" data-wallet="${w.name}" title="Delete wallet">x</button>
        </div>
    `).join('');

    elements.walletList.querySelectorAll('.wallet-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (!e.target.classList.contains('delete-wallet-btn')) {
                selectWallet(item.dataset.wallet);
            }
        });
    });

    elements.walletList.querySelectorAll('.delete-wallet-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openDeleteWalletModal(btn.dataset.wallet);
        });
    });
}

async function selectWallet(name) {
    state.selectedWallet = name;
    renderWalletList();
    elements.syncWalletBtn.disabled = false;
    elements.sendNanoBtn.disabled = false;
    document.getElementById('backupSeedBtn').disabled = false;
    
    await syncSelectedWallet();
    startAutoSync();
}

function startAutoSync() {
    stopAutoSync();
    if (!state.autoSyncEnabled || !state.selectedWallet) return;
    
    state.syncIntervalId = setInterval(async () => {
        if (state.selectedWallet && state.currentSection === 'cryptovault') {
            await syncSelectedWallet();
        }
    }, state.autoSyncInterval);
}

function stopAutoSync() {
    if (state.syncIntervalId) {
        clearInterval(state.syncIntervalId);
        state.syncIntervalId = null;
    }
}

async function syncSelectedWallet() {
    if (!state.selectedWallet) return;

    elements.syncWalletBtn.disabled = true;
    elements.syncWalletBtn.textContent = 'Syncing...';

    try {
        const response = await fetch(`/api/nano/wallet/${encodeURIComponent(state.selectedWallet)}/sync`);
        const data = await response.json();

        if (data.success) {
            state.walletData = data;
            renderWalletDetails(data);
            renderPendingBlocks(data.pendingBlocks || []);
        } else {
            showError(`Sync failed: ${data.error}`);
        }
    } catch (error) {
        showError(`Sync error: ${error.message}`);
    }

    elements.syncWalletBtn.disabled = false;
    elements.syncWalletBtn.textContent = 'Sync';
}

function renderWalletDetails(data) {
    const validationClass = isValidNanoAddress(data.address) ? 'valid' : 'invalid';
    
    elements.walletDetails.innerHTML = `
        <div class="detail-row">
            <span class="detail-label">Address</span>
            <button class="copy-address-btn" data-address="${data.address}" title="Copy address">Copy Address</button>
        </div>
        <div class="detail-row">
            <span class="detail-label">Balance</span>
            <span class="detail-value balance">${parseFloat(data.balance).toFixed(6)} NANO</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Pending</span>
            <span class="detail-value pending">${parseFloat(data.pending).toFixed(6)} NANO</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Status</span>
            <span class="detail-value status ${data.opened ? 'opened' : 'unopened'}">${data.opened ? 'Opened' : 'Unopened'}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Blocks</span>
            <span class="detail-value">${data.blockCount || 0}</span>
        </div>
    `;
    
    elements.walletDetails.querySelector('.copy-address-btn').addEventListener('click', (e) => {
        copyToClipboard(e.target.dataset.address);
    });
}

function copyToClipboard(text) {
    // Try modern clipboard API first
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
            showSuccess('Address copied to clipboard!');
        }).catch(() => {
            // Fallback to legacy method
            fallbackCopyToClipboard(text);
        });
    } else {
        // Fallback for environments without clipboard API
        fallbackCopyToClipboard(text);
    }
}

function fallbackCopyToClipboard(text) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    textArea.style.top = '-9999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    
    try {
        const successful = document.execCommand('copy');
        if (successful) {
            showSuccess('Address copied to clipboard!');
        } else {
            // Show address in prompt as last resort
            showAddressPrompt(text);
        }
    } catch (err) {
        showAddressPrompt(text);
    }
    
    document.body.removeChild(textArea);
}

function showAddressPrompt(text) {
    prompt('Copy this address manually (Ctrl+C):', text);
}

function copyToClipboardSilent(text, btn) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {
            fallbackCopyToClipboardSilent(text);
        });
    } else {
        fallbackCopyToClipboardSilent(text);
    }
}

function fallbackCopyToClipboardSilent(text) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    textArea.style.top = '-9999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
        document.execCommand('copy');
    } catch (err) {}
    document.body.removeChild(textArea);
}

function isValidNanoAddress(address) {
    if (!address) return false;
    const nanoRegex = /^nano_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/;
    return nanoRegex.test(address);
}

function renderPendingBlocks(blocks) {
    if (blocks.length === 0) {
        elements.pendingBlocks.innerHTML = '<p class="empty-state">No pending transactions</p>';
        elements.receiveAllBtn.disabled = true;
        return;
    }

    elements.receiveAllBtn.disabled = false;
    elements.pendingBlocks.innerHTML = blocks.map(b => `
        <div class="pending-block">
            <div class="pending-amount">+${parseFloat(b.amountNano).toFixed(6)} NANO</div>
            <div class="pending-hash">${b.hash.substring(0, 16)}...</div>
        </div>
    `).join('');
}

function openCreateWalletModal() {
    document.getElementById('createWalletModal').classList.add('open');
    document.getElementById('newWalletName').value = '';
    document.getElementById('newWalletName').focus();
}

function closeCreateWalletModal() {
    document.getElementById('createWalletModal').classList.remove('open');
}

async function createWallet() {
    const name = document.getElementById('newWalletName').value.trim();
    const type = document.getElementById('newWalletType').value;

    if (!name) {
        showError('Please enter a wallet name');
        return;
    }

    try {
        const response = await fetch('/api/nano/wallet/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, type })
        });

        const data = await response.json();

        if (data.success) {
            closeCreateWalletModal();
            
            document.getElementById('createdAddress').value = data.address;
            
            if (data.mnemonic) {
                document.getElementById('createdMnemonic').value = data.mnemonic;
                document.getElementById('mnemonicGroup').style.display = 'block';
            } else {
                document.getElementById('mnemonicGroup').style.display = 'none';
            }
            
            document.getElementById('walletCreatedModal').classList.add('open');
            
            loadWallets();
            showSuccess(`Wallet "${name}" created successfully!`);
        } else {
            showError(`Failed to create wallet: ${data.error}`);
        }
    } catch (error) {
        showError(`Error creating wallet: ${error.message}`);
    }
}

function closeWalletCreatedModal() {
    document.getElementById('walletCreatedModal').classList.remove('open');
}

function openDeleteWalletModal(name) {
    state.walletToDelete = name;
    document.getElementById('deleteWalletName').textContent = name;
    document.getElementById('deleteWalletModal').classList.add('open');
}

function closeDeleteWalletModal() {
    document.getElementById('deleteWalletModal').classList.remove('open');
    state.walletToDelete = null;
}

async function confirmDeleteWallet() {
    if (!state.walletToDelete) return;

    try {
        const response = await fetch(`/api/nano/wallet/${encodeURIComponent(state.walletToDelete)}`, {
            method: 'DELETE'
        });

        const data = await response.json();

        if (data.success) {
            closeDeleteWalletModal();
            
            if (state.selectedWallet === state.walletToDelete) {
                state.selectedWallet = null;
                state.walletData = null;
                elements.walletDetails.innerHTML = '<p class="empty-state">Select a wallet to view details</p>';
                elements.syncWalletBtn.disabled = true;
                elements.sendNanoBtn.disabled = true;
            }
            
            loadWallets();
            showSuccess(`Wallet deleted successfully`);
        } else {
            showError(`Failed to delete wallet: ${data.error}`);
        }
    } catch (error) {
        showError(`Error deleting wallet: ${error.message}`);
    }
}

async function sendNano() {
    const to = document.getElementById('sendToAddress').value.trim();
    const amount = document.getElementById('sendAmount').value;

    if (!state.selectedWallet) {
        showError('Please select a wallet first');
        return;
    }

    if (!to || !amount) {
        showError('Please enter recipient address and amount');
        return;
    }

    if (!isValidNanoAddress(to)) {
        showError('Invalid Nano address format');
        return;
    }

    state.pendingTransaction = { to, amount };
    document.getElementById('confirmToAddress').textContent = to;
    document.getElementById('confirmAmount').textContent = `${amount} NANO`;
    document.getElementById('sendConfirmModal').classList.add('open');
}

function closeSendConfirmModal() {
    document.getElementById('sendConfirmModal').classList.remove('open');
    state.pendingTransaction = null;
}

async function confirmSendNano() {
    if (!state.pendingTransaction) return;

    const { to, amount } = state.pendingTransaction;
    closeSendConfirmModal();

    elements.sendNanoBtn.disabled = true;
    elements.sendNanoBtn.textContent = 'Sending...';

    try {
        const response = await fetch(`/api/nano/wallet/${encodeURIComponent(state.selectedWallet)}/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to, amount })
        });

        const data = await response.json();

        if (data.success) {
            showSuccess(`Sent ${amount} NANO successfully!`);
            document.getElementById('sendToAddress').value = '';
            document.getElementById('sendAmount').value = '';
            await syncSelectedWallet();
        } else {
            showError(`Send failed: ${data.error}`);
        }
    } catch (error) {
        showError(`Send error: ${error.message}`);
    }

    elements.sendNanoBtn.disabled = false;
    elements.sendNanoBtn.textContent = 'Send NANO';
}

async function receiveAllNano() {
    if (!state.selectedWallet) {
        showError('Please select a wallet first');
        return;
    }

    elements.receiveAllBtn.disabled = true;
    elements.receiveAllBtn.textContent = 'Receiving...';

    try {
        const response = await fetch(`/api/nano/wallet/${encodeURIComponent(state.selectedWallet)}/receive`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        const data = await response.json();

        if (data.success) {
            if (data.received > 0) {
                showSuccess(`Received ${data.received} transaction(s) successfully!`);
            } else {
                showSuccess('No pending transactions to receive');
            }
            await syncSelectedWallet();
        } else {
            showError(`Receive failed: ${data.error}`);
        }
    } catch (error) {
        showError(`Receive error: ${error.message}`);
    }

    elements.receiveAllBtn.disabled = false;
    elements.receiveAllBtn.textContent = 'Receive All';
}

async function setGpuWorker() {
    const url = elements.gpuWorkerUrl.value.trim();

    if (!url) {
        showError('Please enter GPU worker URL');
        return;
    }

    elements.setGpuWorkerBtn.disabled = true;
    elements.setGpuWorkerBtn.textContent = 'Testing...';

    try {
        const response = await fetch('/api/nano/gpu-worker', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });

        const data = await response.json();

        if (data.success) {
            elements.gpuWorkerStatus.innerHTML = `
                <span class="status-indicator-small active"></span>
                <span>GPU Worker Active: ${escapeHtml(url)}</span>
            `;
            showSuccess('GPU worker configured and tested successfully');
        } else {
            showError(`Failed to set GPU worker: ${data.error}`);
        }
    } catch (error) {
        showError(`Error setting GPU worker: ${error.message}`);
    }

    elements.setGpuWorkerBtn.disabled = false;
    elements.setGpuWorkerBtn.textContent = 'Set Worker';
}

async function clearGpuWorker() {
    try {
        const response = await fetch('/api/nano/gpu-worker', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: null })
        });

        const data = await response.json();

        if (data.success) {
            elements.gpuWorkerUrl.value = '';
            elements.gpuWorkerStatus.innerHTML = `
                <span class="status-indicator-small inactive"></span>
                <span>Using public RPC for PoW</span>
            `;
            showSuccess('GPU worker disabled, using public RPC');
        }
    } catch (error) {
        showError(`Error clearing GPU worker: ${error.message}`);
    }
}

async function loadGpuWorkerStatus() {
    try {
        const response = await fetch('/api/nano/gpu-worker');
        const data = await response.json();

        if (data.active && data.url) {
            elements.gpuWorkerUrl.value = data.url;
            elements.gpuWorkerStatus.innerHTML = `
                <span class="status-indicator-small active"></span>
                <span>GPU Worker Active: ${escapeHtml(data.url)}</span>
            `;
        }
    } catch (error) {
        console.error('Failed to load GPU worker status:', error);
    }
}

async function testAllRpcs() {
    const resultsDiv = document.getElementById('rpcTestResults');
    resultsDiv.innerHTML = '<p class="helper-text">Testing RPCs...</p>';
    
    try {
        const response = await fetch('/api/rpc/test');
        const data = await response.json();
        
        if (data.success) {
            const { nanoNode, powRpcs } = data.results;
            let html = '<div class="rpc-result-list">';
            
            html += `<div class="rpc-item ${nanoNode.status === 'ok' ? 'success' : 'error'}">
                <span class="rpc-label">Nano Node (Sync)</span>
                <span class="rpc-url">${escapeHtml(nanoNode.url)}</span>
                <span class="rpc-status">${nanoNode.status === 'ok' ? '✅ OK' : '❌ ' + (nanoNode.error || 'Failed')}</span>
                <span class="rpc-latency">${nanoNode.latency}ms</span>
                ${nanoNode.blockCount ? `<span class="rpc-info">Blocks: ${nanoNode.blockCount}</span>` : ''}
            </div>`;
            
            html += '<div class="rpc-divider">PoW Generation RPCs:</div>';
            
            for (const rpc of powRpcs) {
                html += `<div class="rpc-item ${rpc.status === 'ok' && rpc.hasWork ? 'success' : 'error'}">
                    <span class="rpc-url">${escapeHtml(rpc.url)}</span>
                    <span class="rpc-status">${rpc.status === 'ok' && rpc.hasWork ? '✅ OK' : '❌ ' + (rpc.error || 'No work')}</span>
                    <span class="rpc-latency">${rpc.latency}ms</span>
                </div>`;
            }
            
            html += '</div>';
            resultsDiv.innerHTML = html;
        } else {
            resultsDiv.innerHTML = '<p class="error-text">Failed to test RPCs</p>';
        }
    } catch (error) {
        resultsDiv.innerHTML = `<p class="error-text">Error: ${escapeHtml(error.message)}</p>`;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const testRpcBtn = document.getElementById('testRpcBtn');
    if (testRpcBtn) {
        testRpcBtn.addEventListener('click', testAllRpcs);
    }
});

function formatTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { 
        hour12: false, 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit' 
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

window.stopTask = stopTask;

async function checkNetworkStatus() {
    const networkStatus = document.getElementById('networkStatus');
    if (!networkStatus) return;
    
    try {
        const response = await fetch('/api/nano/network-status');
        const data = await response.json();
        
        if (data.connected) {
            state.networkConnected = true;
            networkStatus.className = 'network-status connected';
            networkStatus.querySelector('.network-text').textContent = 'Nano Network Connected';
        } else {
            throw new Error('Network error');
        }
    } catch (error) {
        state.networkConnected = false;
        networkStatus.className = 'network-status disconnected';
        networkStatus.querySelector('.network-text').textContent = 'Network Unavailable';
    }
}

function playNotificationSound() {
    const audio = document.getElementById('notificationSound');
    if (audio) {
        audio.currentTime = 0;
        audio.play().catch(() => {});
    }
}

function openAddressBookModal() {
    renderContactsList();
    document.getElementById('addressBookModal').classList.add('open');
}

function closeAddressBookModal() {
    document.getElementById('addressBookModal').classList.remove('open');
    document.getElementById('contactName').value = '';
    document.getElementById('contactAddress').value = '';
}

function addContact() {
    const name = document.getElementById('contactName').value.trim();
    const address = document.getElementById('contactAddress').value.trim();
    
    if (!name || !address) {
        showError('Please enter both name and address');
        return;
    }
    
    if (!isValidNanoAddress(address)) {
        showError('Invalid Nano address format');
        return;
    }
    
    state.contacts.push({ name, address });
    localStorage.setItem('nanoContacts', JSON.stringify(state.contacts));
    
    document.getElementById('contactName').value = '';
    document.getElementById('contactAddress').value = '';
    
    renderContactsList();
    showSuccess('Contact added successfully');
}

function deleteContact(index) {
    state.contacts.splice(index, 1);
    localStorage.setItem('nanoContacts', JSON.stringify(state.contacts));
    renderContactsList();
}

function selectContact(address) {
    document.getElementById('sendToAddress').value = address;
    closeAddressBookModal();
}

function renderContactsList() {
    const container = document.getElementById('contactsList');
    
    if (state.contacts.length === 0) {
        container.innerHTML = '<p class="empty-state">No saved contacts</p>';
        return;
    }
    
    container.innerHTML = state.contacts.map((c, i) => `
        <div class="contact-item" data-address="${c.address}">
            <div class="contact-info">
                <div class="contact-name">${escapeHtml(c.name)}</div>
                <div class="contact-addr">${c.address.substring(0, 20)}...${c.address.substring(c.address.length - 8)}</div>
            </div>
            <button class="delete-contact-btn" data-index="${i}">x</button>
        </div>
    `).join('');
    
    container.querySelectorAll('.contact-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (!e.target.classList.contains('delete-contact-btn')) {
                selectContact(item.dataset.address);
            }
        });
    });
    
    container.querySelectorAll('.delete-contact-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteContact(parseInt(btn.dataset.index));
        });
    });
}

function openBackupSeedModal() {
    if (!state.selectedWallet) {
        showError('Please select a wallet first');
        return;
    }
    document.getElementById('backupPassword').value = '';
    document.getElementById('backupSeedPhrase').value = '';
    document.getElementById('seedPhraseDisplay').classList.add('hidden');
    document.getElementById('backupSeedModal').classList.add('open');
}

function closeBackupSeedModal() {
    document.getElementById('backupSeedModal').classList.remove('open');
    document.getElementById('backupPassword').value = '';
    document.getElementById('backupSeedPhrase').value = '';
    document.getElementById('seedPhraseDisplay').classList.add('hidden');
}

async function showSeedPhrase() {
    const password = document.getElementById('backupPassword').value;
    
    if (!password) {
        showError('Please enter a password');
        return;
    }
    
    try {
        const response = await fetch(`/api/nano/wallet/${encodeURIComponent(state.selectedWallet)}/backup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        
        const data = await response.json();
        
        if (data.success) {
            document.getElementById('backupSeedPhrase').value = data.mnemonic || data.seed || 'No seed available for this wallet type';
            document.getElementById('seedPhraseDisplay').classList.remove('hidden');
        } else {
            showError(data.error || 'Failed to retrieve seed phrase');
        }
    } catch (error) {
        showError(`Error: ${error.message}`);
    }
}

const originalRenderPendingBlocks = renderPendingBlocks;
renderPendingBlocks = function(blocks) {
    const currentCount = blocks.length;
    if (currentCount > state.previousPendingCount && state.previousPendingCount >= 0) {
        playNotificationSound();
    }
    state.previousPendingCount = currentCount;
    originalRenderPendingBlocks(blocks);
};

const faucetState = {
    isRunning: false,
    isPaused: false,
    config: {},
    sessionStats: {},
    logs: [],
    gpuWorkerUrl: null
};

const faucetElements = {
    bankWallet: document.getElementById('faucetBankWallet'),
    bankBalanceRow: document.getElementById('bankBalanceRow'),
    bankWalletBalance: document.getElementById('bankWalletBalance'),
    bankBalanceStatus: document.getElementById('bankBalanceStatus'),
    proxyUrlRow: document.getElementById('proxyUrlRow'),
    proxyUrl: document.getElementById('proxyUrl'),
    gpuStatus: document.getElementById('faucetGpuStatus'),
    startBtn: document.getElementById('startClaimBtn'),
    pauseBtn: document.getElementById('pauseClaimBtn'),
    stopBtn: document.getElementById('stopClaimBtn'),
    sessionStatus: document.getElementById('faucetSessionStatus'),
    tempWallet: document.getElementById('faucetTempWallet'),
    lastDonation: document.getElementById('faucetLastDonation'),
    lastReward: document.getElementById('faucetLastReward'),
    totalClaims: document.getElementById('faucetTotalClaims'),
    totalRewards: document.getElementById('faucetTotalRewards'),
    screenshotContainer: document.getElementById('faucetScreenshotContainer'),
    logsContainer: document.getElementById('faucetLogsContainer'),
    clearLogsBtn: document.getElementById('clearFaucetLogs')
};

function setupFaucetListeners() {
    socket.on('faucet-status', (data) => {
        faucetState.isRunning = data.isRunning;
        faucetState.isPaused = data.isPaused;
        faucetState.config = data.config || {};
        faucetState.sessionStats = data.sessionStats || {};
        faucetState.gpuWorkerUrl = data.gpuWorkerUrl;
        updateFaucetUI();
    });

    socket.on('faucet-log', (entry) => {
        faucetState.logs.unshift(entry);
        if (faucetState.logs.length > 200) faucetState.logs.pop();
        addFaucetLogEntry(entry);
    });
    
    socket.on('faucet-logs', (data) => {
        if (data.logs && data.logs.length > 0) {
            faucetState.logs = data.logs;
            renderFaucetLogs();
        }
    });

    socket.on('faucet-screenshot', (data) => {
        renderFaucetScreenshot(data);
    });
}

function setupFaucetEventListeners() {
    faucetElements.bankWallet.addEventListener('change', async () => {
        const walletName = faucetElements.bankWallet.value;
        await setBankWallet(walletName);
    });

    document.querySelectorAll('input[name="connectionType"]').forEach(radio => {
        radio.addEventListener('change', () => {
            const type = document.querySelector('input[name="connectionType"]:checked').value;
            faucetElements.proxyUrlRow.style.display = type === 'proxy' ? 'block' : 'none';
            if (type === 'proxy') {
                const proxyUrl = buildProxyUrl();
                setConnectionType(type, proxyUrl);
            } else {
                setConnectionType(type);
            }
        });
    });

    const proxyInputs = ['proxyHost', 'proxyPort', 'proxyUser', 'proxyPass'];
    proxyInputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', () => {
                buildProxyUrl();
            });
            el.addEventListener('blur', () => {
                const type = document.querySelector('input[name="connectionType"]:checked').value;
                if (type === 'proxy') {
                    const proxyUrl = buildProxyUrl();
                    setConnectionType(type, proxyUrl);
                }
            });
            el.addEventListener('change', () => {
                const type = document.querySelector('input[name="connectionType"]:checked').value;
                if (type === 'proxy') {
                    const proxyUrl = buildProxyUrl();
                    setConnectionType(type, proxyUrl);
                }
            });
        }
    });

    faucetElements.startBtn.addEventListener('click', () => {
        const type = document.querySelector('input[name="connectionType"]:checked').value;
        if (type === 'proxy') {
            buildProxyUrl();
        }
        startFaucetClaim();
    });
    faucetElements.pauseBtn.addEventListener('click', pauseFaucetClaim);
    faucetElements.stopBtn.addEventListener('click', stopFaucetClaim);
    faucetElements.clearLogsBtn.addEventListener('click', () => {
        faucetState.logs = [];
        faucetElements.logsContainer.innerHTML = '';
    });
}

function loadFaucetStatus() {
    fetch('/api/faucet/status')
        .then(res => res.json())
        .then(data => {
            faucetState.isRunning = data.isRunning;
            faucetState.isPaused = data.isPaused;
            faucetState.config = data.config || {};
            faucetState.sessionStats = data.sessionStats || {};
            faucetState.gpuWorkerUrl = data.gpuWorkerUrl;
            updateFaucetUI();
            populateBankWalletDropdown();
        })
        .catch(err => console.error('Failed to load faucet status:', err));
}

function populateBankWalletDropdown() {
    const currentValue = faucetElements.bankWallet.value;
    faucetElements.bankWallet.innerHTML = '<option value="">-- Select Bank Wallet --</option>';
    
    state.wallets.forEach(w => {
        const option = document.createElement('option');
        option.value = w.name;
        option.textContent = `${w.name} (${w.address.substring(0, 15)}...)`;
        if (w.name === faucetState.config.bankWalletName) {
            option.selected = true;
        }
        faucetElements.bankWallet.appendChild(option);
    });

    if (faucetState.config.bankWalletName) {
        loadBankBalance();
    }
}

async function loadBankBalance() {
    try {
        const response = await fetch('/api/faucet/bank-balance');
        const data = await response.json();
        
        if (data.success) {
            faucetElements.bankBalanceRow.style.display = 'flex';
            faucetElements.bankWalletBalance.textContent = parseFloat(data.balance).toFixed(6);
            
            const isOk = parseFloat(data.balance) >= 0.001;
            faucetElements.bankBalanceStatus.textContent = isOk ? 'Ready' : 'Min 0.001 required';
            faucetElements.bankBalanceStatus.className = `balance-status ${isOk ? 'ok' : 'low'}`;
        } else {
            faucetElements.bankBalanceRow.style.display = 'none';
        }
    } catch (error) {
        console.error('Failed to load bank balance:', error);
    }
}

async function setBankWallet(walletName) {
    try {
        const response = await fetch('/api/faucet/bank-wallet', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ walletName: walletName || null })
        });
        
        const data = await response.json();
        if (data.success) {
            if (walletName) {
                loadBankBalance();
            } else {
                faucetElements.bankBalanceRow.style.display = 'none';
            }
        }
    } catch (error) {
        showError(`Failed to set bank wallet: ${error.message}`);
    }
}

function buildProxyUrl() {
    const host = document.getElementById('proxyHost')?.value?.trim() || '';
    const port = document.getElementById('proxyPort')?.value?.trim() || '';
    const user = document.getElementById('proxyUser')?.value?.trim() || '';
    const pass = document.getElementById('proxyPass')?.value?.trim() || '';
    
    if (!host) return '';
    
    let url = 'http://';
    if (user && pass) {
        url += `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`;
    }
    url += host;
    if (port) {
        url += `:${port}`;
    }
    
    document.getElementById('proxyUrl').value = url;
    return url;
}

function parseProxyUrl(url) {
    if (!url) return { host: '', port: '', user: '', pass: '' };
    
    try {
        const match = url.match(/^(?:https?:\/\/)?(?:([^:@]+):([^@]+)@)?([^:\/]+)(?::(\d+))?/);
        if (match) {
            return {
                user: match[1] ? decodeURIComponent(match[1]) : '',
                pass: match[2] ? decodeURIComponent(match[2]) : '',
                host: match[3] || '',
                port: match[4] || ''
            };
        }
    } catch (e) {
        console.error('Error parsing proxy URL:', e);
    }
    return { host: '', port: '', user: '', pass: '' };
}

async function setConnectionType(type, proxyUrl = null) {
    try {
        await fetch('/api/faucet/connection', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, proxyUrl })
        });
    } catch (error) {
        console.error('Failed to set connection type:', error);
    }
}

async function startFaucetClaim() {
    try {
        faucetElements.startBtn.disabled = true;
        faucetElements.startBtn.textContent = 'Starting...';
        
        const response = await fetch('/api/faucet/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        const data = await response.json();
        if (!data.success) {
            showError(data.error || 'Failed to start claim session');
            faucetElements.startBtn.disabled = false;
            faucetElements.startBtn.textContent = '▶️ Start Claim';
        }
    } catch (error) {
        showError(`Error: ${error.message}`);
        faucetElements.startBtn.disabled = false;
        faucetElements.startBtn.textContent = '▶️ Start Claim';
    }
}

async function pauseFaucetClaim() {
    try {
        await fetch('/api/faucet/pause', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        showError(`Error: ${error.message}`);
    }
}

async function stopFaucetClaim() {
    try {
        await fetch('/api/faucet/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        showError(`Error: ${error.message}`);
    }
}

function updateFaucetUI() {
    faucetElements.startBtn.disabled = faucetState.isRunning;
    faucetElements.pauseBtn.disabled = !faucetState.isRunning;
    faucetElements.stopBtn.disabled = !faucetState.isRunning;
    
    faucetElements.startBtn.textContent = faucetState.isRunning ? 'Running...' : '▶️ Start Claim';
    faucetElements.pauseBtn.textContent = faucetState.isPaused ? '▶️ Resume' : '⏸️ Pause';

    const stats = faucetState.sessionStats;
    const statusText = stats.status || 'idle';
    faucetElements.sessionStatus.textContent = formatStatusText(statusText);
    faucetElements.sessionStatus.className = `session-value status-${getStatusClass(statusText)}`;
    
    faucetElements.tempWallet.textContent = stats.tempClaimWallet ? 
        `${stats.tempClaimWallet.substring(0, 20)}...` : '--';
    faucetElements.lastDonation.textContent = stats.lastDonationSent ? 
        new Date(stats.lastDonationSent).toLocaleTimeString() : '--';
    faucetElements.lastReward.textContent = stats.lastRewardReceived ? 
        new Date(stats.lastRewardReceived).toLocaleTimeString() : '--';
    faucetElements.totalClaims.textContent = stats.totalClaims || 0;
    faucetElements.totalRewards.textContent = `${stats.totalRewards || '0.000000'} NANO`;

    if (faucetState.gpuWorkerUrl) {
        faucetElements.gpuStatus.textContent = `GPU: ${faucetState.gpuWorkerUrl.substring(0, 30)}...`;
        faucetElements.gpuStatus.className = 'gpu-status active';
    } else {
        faucetElements.gpuStatus.textContent = 'Using public RPC';
        faucetElements.gpuStatus.className = 'gpu-status';
    }

    if (faucetState.config.connectionType) {
        const radio = document.querySelector(`input[name="connectionType"][value="${faucetState.config.connectionType}"]`);
        if (radio) radio.checked = true;
        faucetElements.proxyUrlRow.style.display = faucetState.config.connectionType === 'proxy' ? 'block' : 'none';
        if (faucetState.config.proxyUrl) {
            faucetElements.proxyUrl.value = faucetState.config.proxyUrl;
            const parsed = parseProxyUrl(faucetState.config.proxyUrl);
            document.getElementById('proxyHost').value = parsed.host;
            document.getElementById('proxyPort').value = parsed.port;
            document.getElementById('proxyUser').value = parsed.user;
            document.getElementById('proxyPass').value = parsed.pass;
        }
    }
}

function formatStatusText(status) {
    const statusMap = {
        'idle': 'Idle',
        'starting': 'Starting...',
        'creating_temp_wallet': 'Creating temp wallet',
        'launching_browser': 'Launching browser',
        'navigating': 'Navigating to faucet',
        'entering_address': 'Entering address',
        'clicking_claim': 'Clicking claim',
        'extracting_donation': 'Getting donation amount',
        'funding_claim_wallet': 'Funding claim wallet',
        'receiving_to_claim': 'Receiving to claim wallet',
        'sending_donation': 'Sending donation',
        'waiting_reward': 'Waiting for reward',
        'receiving_reward': 'Receiving reward',
        'sending_to_bank': 'Sending to bank',
        'receiving_to_bank': 'Receiving to bank wallet',
        'completed': 'Completed!',
        'failed': 'Failed',
        'stopped': 'Stopped',
        'paused': 'Paused'
    };
    return statusMap[status] || status;
}

function getStatusClass(status) {
    if (['completed'].includes(status)) return 'running';
    if (['failed', 'stopped'].includes(status)) return 'failed';
    if (status === 'paused') return 'paused';
    if (status === 'idle') return 'idle';
    return 'running';
}

function addFaucetLogEntry(entry, prepend = true) {
    const levelIcons = {
        info: 'i',
        success: '+',
        warning: '!',
        error: 'x',
        action: '*'
    };

    const div = document.createElement('div');
    div.className = `log-entry ${entry.level}`;
    div.innerHTML = `
        <span class="log-time">${formatTime(entry.timestamp)}</span>
        <span class="log-level">${levelIcons[entry.level] || '.'}</span>
        <span class="log-message">${escapeHtml(entry.message)}</span>
    `;

    if (prepend) {
        faucetElements.logsContainer.insertBefore(div, faucetElements.logsContainer.firstChild);
    } else {
        faucetElements.logsContainer.appendChild(div);
    }

    while (faucetElements.logsContainer.children.length > 200) {
        faucetElements.logsContainer.removeChild(faucetElements.logsContainer.lastChild);
    }
}

function renderFaucetLogs() {
    faucetElements.logsContainer.innerHTML = '';
    faucetState.logs.slice(0, 200).forEach(entry => {
        addFaucetLogEntry(entry, false);
    });
}

function renderFaucetScreenshot(data) {
    const mimeType = 'image/jpeg';
    const isLive = data.isLive ? '<span class="live-indicator">LIVE</span>' : '';
    
    faucetElements.screenshotContainer.innerHTML = `
        <div>
            <img src="data:${mimeType};base64,${data.image}" alt="Screenshot" />
            <div class="screenshot-label">${isLive} ${data.label || 'Faucet'}</div>
        </div>
    `;
}

const originalLoadWallets = loadWallets;
loadWallets = async function() {
    await originalLoadWallets();
    if (state.currentSection === 'faucetsentry') {
        populateBankWalletDropdown();
    }
};

const originalSwitchSection = switchSection;
switchSection = function(section) {
    originalSwitchSection(section);
    if (section === 'faucetsentry') {
        loadFaucetStatus();
        populateBankWalletDropdown();
    }
};

setupFaucetListeners();
setupFaucetEventListeners();

init();

// Multi-Instance Mode
const multiInstanceState = {
    activeCount: 0,
    instances: [],
    isRunning: false
};

const multiElements = {
    instanceCount: document.getElementById('instanceCount'),
    instanceCountDisplay: document.getElementById('instanceCountDisplay'),
    startMultiBtn: document.getElementById('startMultiBtn'),
    stopMultiBtn: document.getElementById('stopMultiBtn'),
    instanceGrid: document.getElementById('instanceGrid'),
    multiStats: document.getElementById('multiStats'),
    multiActiveCount: document.getElementById('multiActiveCount'),
    multiTotalClaims: document.getElementById('multiTotalClaims'),
    multiTotalRewards: document.getElementById('multiTotalRewards')
};

function setupMultiInstanceListeners() {
    if (multiElements.instanceCount) {
        multiElements.instanceCount.addEventListener('input', () => {
            multiElements.instanceCountDisplay.textContent = multiElements.instanceCount.value;
        });
    }

    if (multiElements.startMultiBtn) {
        multiElements.startMultiBtn.addEventListener('click', startMultiInstance);
    }

    if (multiElements.stopMultiBtn) {
        multiElements.stopMultiBtn.addEventListener('click', stopMultiInstance);
    }

    socket.on('multi-instance-status', (data) => {
        multiInstanceState.activeCount = data.activeCount;
        multiInstanceState.instances = data.instances || [];
        multiInstanceState.isRunning = data.activeCount > 0;
        updateMultiInstanceUI(data);
    });

    socket.on('multi-instance-update', (data) => {
        const idx = multiInstanceState.instances.findIndex(i => i.id === data.instanceId);
        if (idx >= 0) {
            multiInstanceState.instances[idx] = { ...multiInstanceState.instances[idx], ...data };
        }
        renderInstanceGrid();
    });
}

async function startMultiInstance() {
    const count = parseInt(multiElements.instanceCount.value) || 1;
    
    multiElements.startMultiBtn.disabled = true;
    multiElements.startMultiBtn.textContent = 'Starting...';

    try {
        const response = await fetch('/api/faucet/multi/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instanceCount: count })
        });

        const data = await response.json();
        if (!data.success) {
            showError(data.error || 'Failed to start multi-instance');
            multiElements.startMultiBtn.disabled = false;
            multiElements.startMultiBtn.textContent = 'Start Multi';
        }
    } catch (error) {
        showError(`Error: ${error.message}`);
        multiElements.startMultiBtn.disabled = false;
        multiElements.startMultiBtn.textContent = 'Start Multi';
    }
}

async function stopMultiInstance() {
    multiElements.stopMultiBtn.disabled = true;
    multiElements.stopMultiBtn.textContent = 'Stopping...';

    try {
        await fetch('/api/faucet/multi/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        showError(`Error: ${error.message}`);
    }

    multiElements.stopMultiBtn.textContent = 'Stop All';
}

function updateMultiInstanceUI(data) {
    const isActive = data.activeCount > 0;
    
    multiElements.startMultiBtn.disabled = isActive;
    multiElements.startMultiBtn.textContent = isActive ? 'Running...' : 'Start Multi';
    multiElements.stopMultiBtn.disabled = !isActive;
    
    multiElements.multiStats.style.display = isActive ? 'flex' : 'none';
    
    if (data.aggregated) {
        multiElements.multiActiveCount.textContent = data.activeCount;
        multiElements.multiTotalClaims.textContent = data.aggregated.totalClaims || 0;
        multiElements.multiTotalRewards.textContent = data.aggregated.totalRewards || '0.000000';
    }
    
    renderInstanceGrid();
}

function renderInstanceGrid() {
    if (!multiElements.instanceGrid) return;
    
    if (multiInstanceState.instances.length === 0) {
        multiElements.instanceGrid.innerHTML = '';
        return;
    }

    multiElements.instanceGrid.innerHTML = multiInstanceState.instances.map(inst => {
        const statusClass = inst.isRunning ? 'running' : (inst.status === 'failed' ? 'failed' : '');
        return `
            <div class="instance-card ${statusClass}">
                <div class="instance-header">
                    <span class="instance-id">Instance ${inst.instanceIndex}</span>
                    <span class="instance-status">${formatStatusText(inst.status)}</span>
                </div>
                <div class="instance-stats">
                    <span>Port: ${inst.torPort}</span>
                    <span>Claims: ${inst.totalClaims || 0}</span>
                    <span>Rewards: ${inst.totalRewards || '0'} NANO</span>
                </div>
            </div>
        `;
    }).join('');
}

function loadMultiInstanceStatus() {
    fetch('/api/faucet/multi/status')
        .then(res => res.json())
        .then(data => {
            multiInstanceState.activeCount = data.activeCount;
            multiInstanceState.instances = data.instances || [];
            multiInstanceState.isRunning = data.activeCount > 0;
            updateMultiInstanceUI(data);
        })
        .catch(err => console.error('Failed to load multi-instance status:', err));
}

setupMultiInstanceListeners();
loadMultiInstanceStatus();
