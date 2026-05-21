// --- State ---
const state = {
    targetCodes: new Set(),
    foundCodes: new Set(),
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
    const total = state.targetCodes.size + state.foundCodes.size;
    const found = state.foundCodes.size;
    const remaining = state.targetCodes.size;

    $('#stat-total b').textContent = total;
    $('#stat-found b').textContent = found;
    $('#stat-remaining b').textContent = remaining;

    $('#scanner-found').textContent = found;
    $('#scanner-remaining').textContent = remaining;
    $('#scanner-total').textContent = total;
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

    if (type === 'found') {
        $('#result-icon').textContent = '✅';
        $('#result-status').textContent = 'FOUND';
        $('#result-code').textContent = code;
    } else if (type === 'not-found') {
        $('#result-icon').textContent = '❌';
        $('#result-status').textContent = 'NOT IN TARGET LIST';
        $('#result-code').textContent = code;
    } else if (type === 'duplicate') {
        $('#result-icon').textContent = '⚠️';
        $('#result-status').textContent = 'ALREADY FOUND';
        $('#result-code').textContent = code;
    }

    clearTimeout(resultTimeout);
    resultTimeout = setTimeout(() => {
        el.className = 'scan-result hidden';
    }, 3000);
}

// --- File import ---
function parseCSV(text) {
    const codes = [];
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
        const cols = line.split(/[,;\t]/);
        const val = cols[0]?.trim();
        if (val && val.length > 0) codes.push(val);
    }
    return codes;
}

function handleFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();

    if (ext === 'csv' || ext === 'tsv') {
        const reader = new FileReader();
        reader.onload = (e) => {
            const codes = parseCSV(e.target.result);
            if (codes.length > 0 && /[a-zA-Z]/.test(codes[0]) === false || codes[0].toLowerCase().includes('code') || codes[0].toLowerCase().includes('product') || codes[0].toLowerCase().includes('артикул')) {
                codes.shift();
            }
            loadCodes(codes);
        };
        reader.readAsText(file);
    } else {
        const reader = new FileReader();
        reader.onload = (e) => {
            const wb = XLSX.read(e.target.result, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
            const codes = [];
            for (let i = 0; i < data.length; i++) {
                const val = data[i]?.[0];
                if (val !== undefined && val !== null && String(val).trim().length > 0) {
                    codes.push(String(val).trim());
                }
            }
            if (codes.length > 0) {
                const first = codes[0].toLowerCase();
                if (first.includes('code') || first.includes('product') || first.includes('артикул') || first.includes('код') || first === '#') {
                    codes.shift();
                }
            }
            loadCodes(codes);
        };
        reader.readAsArrayBuffer(file);
    }
}

function loadCodes(codes) {
    const unique = [...new Set(codes.filter((c) => c.length > 0))];
    state.targetCodes = new Set(unique);
    state.foundCodes = new Set();
    state.history = [];

    $('#import-status').classList.remove('hidden');
    $('#import-count').textContent = `${unique.length} product codes loaded`;
    $('#btn-start-scan').classList.remove('hidden');
    $('#btn-start-scan').disabled = false;

    updateStats();
}

// --- Demo mode ---
function loadDemo() {
    const demoCodes = [];
    for (let i = 1; i <= 20; i++) {
        demoCodes.push(`W25-GZ${String(2000 + i).padStart(4, '0')}`);
    }
    loadCodes(demoCodes);
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

    if (state.foundCodes.has(code)) {
        // Duplicate
        flash('yellow');
        soundDuplicate();
        vibrate([50, 30, 50]);
        showScanResult('duplicate', code);
        state.history.unshift({ code, type: 'duplicate', time });
    } else if (state.targetCodes.has(code)) {
        // Found
        state.targetCodes.delete(code);
        state.foundCodes.add(code);
        flash('green');
        soundFound();
        vibrate([100]);
        showScanResult('found', code);
        state.history.unshift({ code, type: 'found', time });
        updateStats();
    } else {
        // Not in list
        flash('red');
        soundNotFound();
        vibrate([50, 50, 50]);
        showScanResult('not-found', code);
        state.history.unshift({ code, type: 'not-found', time });
    }
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
            (h) => `
        <div class="history-item type-${h.type}">
            <div class="history-dot"></div>
            <div class="history-code">${escapeHtml(h.code)}</div>
            <div class="history-time">${h.time}</div>
        </div>`
        )
        .join('');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// --- Results ---
function showResults() {
    showScreen('results');

    const found = [...state.foundCodes];
    const remaining = [...state.targetCodes];
    const notFoundCount = state.history.filter((h) => h.type === 'not-found').length;

    $('#final-found').textContent = found.length;
    $('#final-not-found').textContent = notFoundCount;
    $('#final-remaining').textContent = remaining.length;

    const foundList = $('#found-list');
    if (found.length > 0) {
        $('#found-list-section').classList.remove('hidden');
        foundList.innerHTML = found.map((c) => `<div class="list-item">${escapeHtml(c)}</div>`).join('');
    } else {
        $('#found-list-section').classList.add('hidden');
    }

    const remainingList = $('#remaining-list');
    if (remaining.length > 0) {
        $('#remaining-list-section').classList.remove('hidden');
        remainingList.innerHTML = remaining.map((c) => `<div class="list-item">${escapeHtml(c)}</div>`).join('');
    } else {
        $('#remaining-list-section').classList.add('hidden');
    }
}

// --- Export ---
function exportCSV(data, filename) {
    const bom = '﻿';
    const csv = bom + 'Product Code\n' + data.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

// --- Event listeners ---
$('#file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleFile(file);
});

$('#btn-demo').addEventListener('click', () => loadDemo());

$('#btn-start-scan').addEventListener('click', () => startScanner());

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
    exportCSV([...state.foundCodes], 'found_products.csv');
});

$('#btn-export-remaining').addEventListener('click', () => {
    exportCSV([...state.targetCodes], 'remaining_products.csv');
});

$('#btn-new-session').addEventListener('click', () => {
    state.targetCodes.clear();
    state.foundCodes.clear();
    state.history = [];
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
