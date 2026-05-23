// --- State ---
const state = {
    mode: 'match',            // 'match' or 'collect'
    targetCodes: new Map(),   // code → [col1, col2, col3]
    foundCodes: new Map(),    // code → [col1, col2, col3]
    rowData: new Map(),       // all imported rows: code → [col1, col2, col3]
    collectedCodes: new Map(),// collect mode: code → count
    history: [],
    scanning: false,
    paused: false,
    lastScanTime: 0,
};

const SCAN_COOLDOWN_MS = 1500;

// --- DOM refs ---
const $ = (sel) => document.querySelector(sel);
const screens = {
    import: $('#screen-import'),
    scanner: $('#screen-scanner'),
    history: $('#screen-history'),
    results: $('#screen-results'),
};

// --- Audio ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playTone(freq, duration, type = 'square') {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.value = 0.3;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.stop(audioCtx.currentTime + duration);
}

function soundFound() {
    playTone(880, 0.12, 'sine');
    setTimeout(() => playTone(1320, 0.15, 'sine'), 120);
}

function soundNotFound() {
    playTone(220, 0.25, 'sawtooth');
}

function soundDuplicate() {
    playTone(440, 0.1, 'triangle');
    setTimeout(() => playTone(440, 0.1, 'triangle'), 150);
}

// --- Vibration ---
function vibrate(pattern) {
    if (navigator.vibrate) navigator.vibrate(pattern);
}

// --- Screen navigation ---
function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.remove('active'));
    screens[name].classList.add('active');
}

// --- Stats update ---
function updateStats() {
    if (state.mode === 'collect') {
        const collected = state.collectedCodes.size;
        const totalScans = state.history.length;

        $('#stat-total b').textContent = collected;
        $('#stat-found b').textContent = collected;
        $('#stat-remaining b').textContent = totalScans;

        $('#scanner-found').textContent = collected;
        $('#scanner-found-label').textContent = 'Collected';
        $('#scanner-remaining').textContent = totalScans;
        $('#scanner-total').textContent = collected;

        // Hide remaining card, repurpose total as "scans"
        $('#stat-remaining-card').style.display = 'none';
        $('#stat-total-card').querySelector('.stat-label').textContent = 'Unique';
    } else {
        const total = state.targetCodes.size + state.foundCodes.size;
        const found = state.foundCodes.size;
        const remaining = state.targetCodes.size;

        $('#stat-total b').textContent = total;
        $('#stat-found b').textContent = found;
        $('#stat-remaining b').textContent = remaining;

        $('#scanner-found').textContent = found;
        $('#scanner-found-label').textContent = 'Found';
        $('#scanner-remaining').textContent = remaining;
        $('#scanner-total').textContent = total;

        $('#stat-remaining-card').style.display = '';
        $('#stat-total-card').querySelector('.stat-label').textContent = 'Total';
    }
}

// --- Flash overlay ---
function flash(color) {
    const el = $('#flash-overlay');
    el.className = `flash-${color}`;
    el.style.opacity = '1';
    setTimeout(() => {
        el.style.opacity = '0';
        setTimeout(() => el.className = 'hidden', 300);
    }, 400);
}

// --- Scan result display ---
let resultTimeout = null;

function showScanResult(type, code) {
    const el = $('#scan-result');
    el.className = `scan-result result-${type}`;

    // Get row info for found/duplicate items
    const rowInfo = state.rowData.get(code);
    const detailHtml = rowInfo
        ? rowInfo.map((c) => `<div class="result-detail">${escapeHtml(String(c))}</div>`).join('')
        : '';

    if (type === 'found') {
        $('#result-icon').textContent = '✅';
        $('#result-status').textContent = 'FOUND';
        $('#result-code').textContent = code;
        $('#result-details').innerHTML = detailHtml;
    } else if (type === 'not-found') {
        $('#result-icon').textContent = '❌';
        $('#result-status').textContent = 'NOT IN TARGET LIST';
        $('#result-code').textContent = code;
        $('#result-details').innerHTML = '';
    } else if (type === 'duplicate') {
        $('#result-icon').textContent = '⚠️';
        $('#result-status').textContent = 'ALREADY FOUND';
        $('#result-code').textContent = code;
        $('#result-details').innerHTML = detailHtml;
    } else if (type === 'collected') {
        $('#result-icon').textContent = '📦';
        $('#result-status').textContent = 'COLLECTED';
        $('#result-code').textContent = code;
        $('#result-details').innerHTML = '';
    } else if (type === 'collected-duplicate') {
        $('#result-icon').textContent = '⚠️';
        $('#result-status').textContent = 'ALREADY SCANNED';
        $('#result-code').textContent = code;
        $('#result-details').innerHTML = '';
    }

    clearTimeout(resultTimeout);
    resultTimeout = setTimeout(() => {
        el.className = 'scan-result hidden';
    }, 3000);
}

// --- File import ---
// rows: array of arrays, each row = [col1, col2, col3, ...]
function parseCSVRows(text) {
    const rows = [];
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
        const cols = line.split(/[,;\t]/).map((c) => c.trim());
        if (cols[0] && cols[0].length > 0) rows.push(cols);
    }
    return rows;
}

function isHeaderRow(row) {
    const first = String(row[0]).toLowerCase();
    return first.includes('code') || first.includes('product') || first.includes('артикул') || first.includes('код') || first === '#' || first === 'name' || first === 'sku';
}

function handleFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();

    if (ext === 'csv' || ext === 'tsv') {
        const reader = new FileReader();
        reader.onload = (e) => {
            const rows = parseCSVRows(e.target.result);
            if (rows.length > 0 && isHeaderRow(rows[0])) {
                rows.shift();
            }
            loadRows(rows);
        };
        reader.readAsText(file);
    } else {
        const reader = new FileReader();
        reader.onload = (e) => {
            const wb = XLSX.read(e.target.result, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
            const rows = [];
            for (let i = 0; i < data.length; i++) {
                const row = data[i];
                const val = row?.[0];
                if (val !== undefined && val !== null && String(val).trim().length > 0) {
                    rows.push(row.map((c) => (c !== undefined && c !== null) ? String(c).trim() : ''));
                }
            }
            if (rows.length > 0 && isHeaderRow(rows[0])) {
                rows.shift();
            }
            loadRows(rows);
        };
        reader.readAsArrayBuffer(file);
    }
}

function loadRows(rows) {
    state.targetCodes = new Map();
    state.foundCodes = new Map();
    state.rowData = new Map();
    state.history = [];

    for (const row of rows) {
        const code = String(row[0]).trim();
        if (code.length === 0) continue;
        if (state.targetCodes.has(code)) continue; // skip duplicates
        // Store first 3 columns (skip col 0 which is the code itself)
        const details = row.slice(1, 3).filter((c) => c && c.length > 0);
        state.targetCodes.set(code, details);
        state.rowData.set(code, details);
    }

    $('#import-status').classList.remove('hidden');
    $('#import-count').textContent = `${state.targetCodes.size} product codes loaded`;
    $('#btn-start-scan').classList.remove('hidden');
    $('#btn-start-scan').disabled = false;

    updateStats();
}

// --- Demo mode ---
function loadDemo() {
    const names = ['Bearing 6205', 'Seal Kit', 'Filter Element', 'O-Ring Set', 'Shaft Collar',
        'Pump Gear', 'Valve Spring', 'Gasket Pack', 'Bolt M12x40', 'Nut M10',
        'Washer 16mm', 'Piston Ring', 'Drive Belt', 'Coupling Hub', 'Bushing 25mm',
        'Pin Dowel', 'Retainer Clip', 'Spacer 8mm', 'Bracket L', 'Cap End'];
    const locations = ['A1-01', 'A1-02', 'A2-03', 'B1-01', 'B1-05',
        'B2-02', 'C1-01', 'C1-04', 'C2-03', 'D1-01',
        'D1-02', 'D2-05', 'E1-01', 'E1-03', 'E2-02',
        'F1-01', 'F1-04', 'F2-01', 'G1-02', 'G1-05'];
    const rows = [];
    for (let i = 0; i < 20; i++) {
        rows.push([`W25-GZ${String(2001 + i).padStart(4, '0')}`, names[i], locations[i]]);
    }
    loadRows(rows);
}

// --- Scanner ---
let html5QrCode = null;
let scannerStarted = false;

async function startScanner() {
    showScreen('scanner');
    state.scanning = true;
    state.paused = false;
    scannerStarted = false;
    $('#btn-pause').textContent = 'PAUSE';
    updateStats();

    if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
    }

    html5QrCode = new Html5Qrcode('reader');

    const config = {
        fps: 15,
        qrbox: (w, h) => {
            const size = Math.min(w, h) * 0.75;
            return { width: size, height: size * 0.5 };
        },
        formatsToSupport: [
            Html5QrcodeSupportedFormats.QR_CODE,
            Html5QrcodeSupportedFormats.CODE_128,
            Html5QrcodeSupportedFormats.CODE_39,
            Html5QrcodeSupportedFormats.EAN_13,
            Html5QrcodeSupportedFormats.EAN_8,
            Html5QrcodeSupportedFormats.UPC_A,
            Html5QrcodeSupportedFormats.UPC_E,
            Html5QrcodeSupportedFormats.ITF,
            Html5QrcodeSupportedFormats.CODE_93,
            Html5QrcodeSupportedFormats.CODABAR,
            Html5QrcodeSupportedFormats.DATA_MATRIX,
        ],
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        rememberLastUsedCamera: true,
    };

    try {
        await html5QrCode.start(
            { facingMode: 'environment' },
            config,
            onScanSuccess,
            () => {}
        );
        scannerStarted = true;
    } catch (err) {
        console.warn('Camera error:', err);
        html5QrCode = null;
        scannerStarted = false;
    }
}

async function stopScanner() {
    state.scanning = false;
    const scanner = html5QrCode;
    const wasStarted = scannerStarted;
    html5QrCode = null;
    scannerStarted = false;
    if (scanner) {
        try {
            if (wasStarted) await scanner.stop();
            scanner.clear();
        } catch (_) {
            try { scanner.clear(); } catch (_2) {}
        }
    }
}

function onScanSuccess(decodedText) {
    const now = Date.now();
    if (now - state.lastScanTime < SCAN_COOLDOWN_MS) return;
    if (state.paused) return;
    state.lastScanTime = now;

    const code = decodedText.trim();
    $('#last-code').textContent = code;

    const time = new Date().toLocaleTimeString();

    if (state.mode === 'collect') {
        onScanCollect(code, time);
    } else {
        onScanMatch(code, time);
    }
}

function onScanMatch(code, time) {
    if (state.foundCodes.has(code)) {
        flash('yellow');
        soundDuplicate();
        vibrate([50, 30, 50]);
        showScanResult('duplicate', code);
        const dupDetails = state.rowData.get(code) || [];
        state.history.unshift({ code, type: 'duplicate', time, details: dupDetails });
    } else if (state.targetCodes.has(code)) {
        const details = state.targetCodes.get(code);
        state.targetCodes.delete(code);
        state.foundCodes.set(code, details);
        flash('green');
        soundFound();
        vibrate([100]);
        showScanResult('found', code);
        state.history.unshift({ code, type: 'found', time, details: details || [] });
        updateStats();
    } else {
        flash('red');
        soundNotFound();
        vibrate([50, 50, 50]);
        showScanResult('not-found', code);
        state.history.unshift({ code, type: 'not-found', time, details: [] });
    }
}

function onScanCollect(code, time) {
    if (state.collectedCodes.has(code)) {
        // Already scanned — warn but still count
        const count = state.collectedCodes.get(code) + 1;
        state.collectedCodes.set(code, count);
        flash('yellow');
        soundDuplicate();
        vibrate([50, 30, 50]);
        showScanResult('collected-duplicate', code);
        state.history.unshift({ code, type: 'collected-duplicate', time, details: [`Scan #${count}`] });
    } else {
        // New code collected
        state.collectedCodes.set(code, 1);
        flash('green');
        soundFound();
        vibrate([100]);
        showScanResult('collected', code);
        state.history.unshift({ code, type: 'collected', time, details: [] });
    }
    updateStats();
}

// --- History ---
function renderHistory(filter = 'all') {
    const list = $('#history-list');
    const items = filter === 'all'
        ? state.history
        : state.history.filter((h) => h.type === filter);

    if (items.length === 0) {
        list.innerHTML = '<div class="history-empty">No scans yet</div>';
        return;
    }

    list.innerHTML = items
        .map(
            (h) => {
                const detailStr = (h.details && h.details.length > 0)
                    ? `<div class="history-details">${h.details.map((d) => escapeHtml(d)).join(' · ')}</div>`
                    : '';
                return `
        <div class="history-item type-${h.type}">
            <div class="history-dot"></div>
            <div class="history-info">
                <div class="history-code">${escapeHtml(h.code)}</div>
                ${detailStr}
            </div>
            <div class="history-time">${h.time}</div>
        </div>`;
            }
        )
        .join('');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// --- Results ---
function formatRowHtml(code, details) {
    const parts = [escapeHtml(code)];
    if (details && details.length > 0) {
        parts.push(`<span class="list-detail">${details.map((d) => escapeHtml(d)).join(' · ')}</span>`);
    }
    return parts.join(' ');
}

function showResults() {
    showScreen('results');

    if (state.mode === 'collect') {
        showResultsCollect();
    } else {
        showResultsMatch();
    }
}

function showResultsMatch() {
    const found = [...state.foundCodes];
    const remaining = [...state.targetCodes];
    const notFoundCount = state.history.filter((h) => h.type === 'not-found').length;

    $('#final-found').textContent = found.length;
    $('#final-not-found').textContent = notFoundCount;
    $('#final-remaining').textContent = remaining.length;

    // Show all 3 stat cards
    document.querySelectorAll('.result-stat').forEach((el) => el.style.display = '');

    const foundList = $('#found-list');
    if (found.length > 0) {
        $('#found-list-section').classList.remove('hidden');
        $('#found-list-section').querySelector('h3').textContent = 'Found Items';
        foundList.innerHTML = found.map(([code, details]) =>
            `<div class="list-item">${formatRowHtml(code, details)}</div>`
        ).join('');
    } else {
        $('#found-list-section').classList.add('hidden');
    }

    const remainingList = $('#remaining-list');
    if (remaining.length > 0) {
        $('#remaining-list-section').classList.remove('hidden');
        remainingList.innerHTML = remaining.map(([code, details]) =>
            `<div class="list-item">${formatRowHtml(code, details)}</div>`
        ).join('');
    } else {
        $('#remaining-list-section').classList.add('hidden');
    }

    $('#btn-export-found').textContent = 'EXPORT FOUND (CSV)';
    $('#btn-export-remaining').classList.remove('hidden');
}

function showResultsCollect() {
    const collected = [...state.collectedCodes];
    const dupes = state.history.filter((h) => h.type === 'collected-duplicate').length;

    $('#final-found').textContent = collected.length;
    $('#final-not-found').textContent = dupes;
    $('#final-remaining').textContent = state.history.length;

    // Relabel stats
    const statLabels = document.querySelectorAll('.result-stat-label');
    statLabels[0].textContent = 'Unique';
    statLabels[1].textContent = 'Duplicates';
    statLabels[2].textContent = 'Total Scans';

    const foundList = $('#found-list');
    $('#found-list-section').classList.remove('hidden');
    $('#found-list-section').querySelector('h3').textContent = 'Collected Items';
    foundList.innerHTML = collected.map(([code, count]) =>
        `<div class="list-item">${escapeHtml(code)}${count > 1 ? ` <span class="list-detail">×${count}</span>` : ''}</div>`
    ).join('');

    $('#remaining-list-section').classList.add('hidden');

    $('#btn-export-found').textContent = 'EXPORT COLLECTED (CSV)';
    $('#btn-export-remaining').classList.add('hidden');
}

// --- Export ---
function exportCSV(dataMap, filename) {
    const bom = '﻿';
    const lines = ['Code,Column 2,Column 3'];
    for (const [code, details] of dataMap) {
        const cols = [code, ...(details || [])];
        lines.push(cols.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','));
    }
    const csv = bom + lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function exportCollectedCSV() {
    const bom = '﻿';
    const lines = ['Code,Count'];
    for (const [code, count] of state.collectedCodes) {
        lines.push(`"${code.replace(/"/g, '""')}",${count}`);
    }
    const csv = bom + lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'collected_products.csv';
    a.click();
    URL.revokeObjectURL(url);
}

// --- Event listeners ---
$('#file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleFile(file);
});

$('#btn-demo').addEventListener('click', () => loadDemo());

$('#btn-start-scan').addEventListener('click', () => {
    state.mode = 'match';
    startScanner();
});

$('#btn-collect').addEventListener('click', () => {
    state.mode = 'collect';
    state.collectedCodes = new Map();
    state.history = [];
    startScanner();
});

$('#btn-pause').addEventListener('click', () => {
    state.paused = !state.paused;
    $('#btn-pause').textContent = state.paused ? 'RESUME' : 'PAUSE';
    $('#btn-pause').classList.toggle('btn-warning', !state.paused);
    $('#btn-pause').classList.toggle('btn-success', state.paused);
});

$('#btn-history').addEventListener('click', () => {
    showScreen('history');
    renderHistory('all');
    document.querySelectorAll('.tab-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.tab === 'all');
    });
});

$('#btn-back-from-history').addEventListener('click', () => {
    showScreen('scanner');
});

document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        renderHistory(btn.dataset.tab);
    });
});

$('#btn-finish').addEventListener('click', async () => {
    await stopScanner();
    showResults();
});

$('#btn-export-found').addEventListener('click', () => {
    if (state.mode === 'collect') {
        exportCollectedCSV();
    } else {
        exportCSV(state.foundCodes, 'found_products.csv');
    }
});

$('#btn-export-remaining').addEventListener('click', () => {
    exportCSV(state.targetCodes, 'remaining_products.csv');
});

$('#btn-new-session').addEventListener('click', () => {
    state.targetCodes.clear();
    state.foundCodes.clear();
    state.rowData.clear();
    state.collectedCodes.clear();
    state.history = [];
    state.mode = 'match';
    state.lastScanTime = 0;

    $('#import-status').classList.add('hidden');
    $('#btn-start-scan').classList.add('hidden');
    $('#btn-start-scan').disabled = true;
    $('#file-input').value = '';
    $('#last-code').textContent = '—';
    $('#scan-result').className = 'scan-result hidden';

    updateStats();
    showScreen('import');
});

// --- Service Worker ---
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
}
