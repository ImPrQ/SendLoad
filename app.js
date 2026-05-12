/* ========================================
   SendLoad — Climbing Load Tracker
   Application Logic (Firebase Sync)
   ======================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import {
    initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
    collection, doc, setDoc, deleteDoc, onSnapshot, addDoc
} from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";

// -- Firebase Configuration --
const firebaseConfig = {
    apiKey: "AIzaSyBXmWXvaQppyQGXYdXeb7DBz2n4UZ2VyaE",
    authDomain: "sendload-b125f.firebaseapp.com",
    projectId: "sendload-b125f",
    storageBucket: "sendload-b125f.firebasestorage.app",
    messagingSenderId: "207908664368",
    appId: "1:207908664368:web:e712e40f2140e82160e9f5"
};

const app = initializeApp(firebaseConfig);
const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

// ---- State ----
let allSessions = [];
let currentSessionClimbs = [];
let editingSessionId = null; // null = new session, string = editing existing
let currentUser = null;
let unsubscribeSnapshot = null;
let unsubscribeSettings = null;
let deloadWeeks = [];
let chronicWindowDays = 28;
let restTimerDefaults = { rpe7: 3, rpe8: 5, rpe9: 8 };
let activeWeeklyChannels = { neuro: true, metabolic: true, structural: true };
let activeModifiers = { angle: true, rpe: true, power: true, hold: true };
let neuroDampener = 1.0, metaDampener = 1.0, structDampener = 1.0;
let widgetVisibility = {
    weekly: true, polarization: true, pyramids: true, modifiers: true,
    velocity: true, intensity: true, correlator: true
};
let customMultipliers = {
    angle: { slab: 0.8, vertical: 1.0, '20deg': 1.2, '30deg': 1.4, '40deg': 1.6, '50deg': 1.8 },
    rpe: { 5: 0.8, 6: 1.0, 7: 1.2, 8: 1.4, 9: 1.6 },
    hold: { jugs: 0.8, slopers: 1.0, edges: 1.2, small: 1.4, pockets: 1.6 }
};
let themeColor = 'orange';
let defaultLogPreset = 'boulder';
let weekStripOffset = 0; // 0 = current week, -1 = last week, etc.

let fatigueTuning = {
    meta: { partition: 0.9, fastHL: 6, slowHL: 48 },
    neuro: { partition: 0.7, fastHL: 24, slowHL: 192 },
    struct: { partition: 0.5, fastHL: 36, slowHL: 336 }
};

let engineConfig = {
    dynamicHalfLives: true,
    fatigueTax: true,
    metaFastScaling: true,
    neuroStructLink: true,
    chronicCompensation: true,
    hlMultRPE8: 1.2,
    hlMultRPE9: 1.5,
    taxThreshold50: 1.15,
    taxThreshold30: 1.30,
    chronicAbsorption: 0.20,
    metaFastThreshold: 15,
    metaFastMultiplier: 1.2,
    neuroStructThreshold: 40,
    neuroStructMultiplier: 1.2
};

// ---- Legacy Mapping (for retroactive multiplier support) ----
const LEGACY_MAPS = {
    angle: { '0.8': 'slab', '1': 'vertical', '1.0': 'vertical', '1.2': '20deg', '1.4': '30deg', '1.6': '40deg', '1.8': '50deg' },
    rpe: { '0.8': '5', '1': '6', '1.0': '6', '1.2': '7', '1.4': '8', '1.6': '9' },
    power: { '1': 'static', '1.0': 'static', '1.2': 'controlled', '1.4': 'less_controlled', '1.6': 'hands_only' },
    hold: { '0.8': 'jugs', '1': 'slopers', '1.0': 'slopers', '1.2': 'edges', '1.4': 'small', '1.6': 'pockets' }
};

function recalculateSession(sess) {
    if (!sess.climbs) return sess;
    let newTotalLoad = 0;

    sess.climbs = sess.climbs.map(c => {
        // Infer keys if missing (legacy data)
        const aKey = c.angleKey || LEGACY_MAPS.angle[String(c.angle)];
        const rKey = c.rpeKey || LEGACY_MAPS.rpe[String(c.rpe)];
        const pKey = c.powerKey || LEGACY_MAPS.power[String(c.power)];
        const hKey = c.holdKey || LEGACY_MAPS.hold[String(c.hold)];

        // Get current multiplier values from settings
        const aMult = customMultipliers.angle[aKey] ?? c.angle;
        const rMult = customMultipliers.rpe[rKey] ?? c.rpe;
        const pMult = pKey === 'static' ? 1.0 : (pKey === 'controlled' ? 1.2 : (pKey === 'less_controlled' ? 1.4 : 1.6));
        const hMult = customMultipliers.hold[hKey] ?? c.hold;

        // Recalculate load and channels
        const load = calculateLoad(c.type, c.moves, aMult, rMult, pMult, hMult);
        const ch = calculateChannels(c.type, c.moves, aMult, rMult, pMult, hMult);

        newTotalLoad += load;
        return {
            ...c,
            angleKey: aKey, rpeKey: rKey, powerKey: pKey, holdKey: hKey,
            angle: aMult, rpe: rMult, power: pMult, hold: hMult,
            load, neuro: ch.neuro, metabolic: ch.metabolic, structural: ch.structural
        };
    });

    sess.totalLoad = newTotalLoad;
    return sess;
}

let userTemplates = [];
let unsubscribeTemplates = null;

// ---- Authentication Observer ----
onAuthStateChanged(auth, (user) => {
    if (user) {
        currentUser = user;

        // Show App Navigation and switch to dashboard
        document.getElementById('main-nav').style.display = 'flex';
        switchToView('dashboard');

        // Connect to user's specific data silo
        if (unsubscribeSnapshot) unsubscribeSnapshot();

        unsubscribeSnapshot = onSnapshot(collection(db, `users/${user.uid}/sessions`), (snapshot) => {
            const rawSessions = [];
            snapshot.forEach((doc) => {
                rawSessions.push({ id: doc.id, ...doc.data() });
            });

            // Recalculate based on current multipliers (retroactive support)
            allSessions = rawSessions.map(s => recalculateSession(s));

            // Sort descending by creation date
            allSessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            refreshDashboard();
            if (document.getElementById('view-history').classList.contains('active')) renderHistory();
        });

        // Listen to User Settings
        if (unsubscribeSettings) unsubscribeSettings();
        unsubscribeSettings = onSnapshot(doc(db, `users/${user.uid}/settings`, 'preferences'), (docSnap) => {
            if (docSnap.exists()) {
                const data = docSnap.data();
                deloadWeeks = data.deloadWeeks || [];
                chronicWindowDays = data.chronicWindowDays || 28;
                restTimerDefaults = data.restTimerDefaults || { rpe7: 3, rpe8: 5, rpe9: 8 };
                neuroDampener = data.neuroDampener ?? 1.0;
                metaDampener = data.metaDampener ?? 1.0;
                structDampener = data.structDampener ?? 1.0;
                widgetVisibility = data.widgetVisibility || widgetVisibility;
                customMultipliers = data.customMultipliers || customMultipliers;
                themeColor = data.themeColor || 'orange';
                defaultLogPreset = data.defaultLogPreset || 'boulder';
                fatigueTuning = data.fatigueTuning || fatigueTuning;
                engineConfig = data.engineConfig || engineConfig;

                // Sync UI inputs
                const winInp = document.getElementById('setting-chronic-window');
                if (winInp) winInp.value = chronicWindowDays;

                // Sync Fatigue Tuning UI
                ['meta', 'neuro', 'struct'].forEach(ch => {
                    const part = document.getElementById(`tuning-${ch}-partition`);
                    const fast = document.getElementById(`tuning-${ch}-fastHL`);
                    const slow = document.getElementById(`tuning-${ch}-slowHL`);
                    if (part) part.value = fatigueTuning[ch].partition * 100;
                    if (fast) fast.value = fatigueTuning[ch].fastHL;
                    if (slow) slow.value = fatigueTuning[ch].slowHL;
                });

                // Sync Engine Config UI
                const engToggleHL = document.getElementById('eng-toggle-hl');
                if (engToggleHL) engToggleHL.checked = engineConfig.dynamicHalfLives;
                const engToggleTax = document.getElementById('eng-toggle-tax');
                if (engToggleTax) engToggleTax.checked = engineConfig.fatigueTax;
                const engMetaFast = document.getElementById('eng-meta-fast');
                if (engMetaFast) engMetaFast.checked = engineConfig.metaFastScaling;
                const engNeuroStruct = document.getElementById('eng-neuro-struct');
                if (engNeuroStruct) engNeuroStruct.checked = engineConfig.neuroStructLink;
                const engChronicComp = document.getElementById('eng-chronic-comp');
                if (engChronicComp) engChronicComp.checked = engineConfig.chronicCompensation;

                const engHl8 = document.getElementById('eng-hl-8');
                if (engHl8) engHl8.value = engineConfig.hlMultRPE8;
                const engHl9 = document.getElementById('eng-hl-9');
                if (engHl9) engHl9.value = engineConfig.hlMultRPE9;
                const engTax50 = document.getElementById('eng-tax-50');
                if (engTax50) engTax50.value = engineConfig.taxThreshold50;
                const engTax30 = document.getElementById('eng-tax-30');
                if (engTax30) engTax30.value = engineConfig.taxThreshold30;
                const engAbsorb = document.getElementById('eng-absorb');
                if (engAbsorb) engAbsorb.value = engineConfig.chronicAbsorption * 100;
                const engMetaThresh = document.getElementById('eng-meta-fast-thresh');
                if (engMetaThresh) engMetaThresh.value = engineConfig.metaFastThreshold;
                const engMetaMult = document.getElementById('eng-meta-fast-mult');
                if (engMetaMult) engMetaMult.value = engineConfig.metaFastMultiplier;
                const engNsThresh = document.getElementById('eng-ns-thresh');
                if (engNsThresh) engNsThresh.value = engineConfig.neuroStructThreshold;
                const engNsMult = document.getElementById('eng-ns-mult');
                if (engNsMult) engNsMult.value = engineConfig.neuroStructMultiplier;

                if (typeof syncEngineUI === 'function') syncEngineUI();

                // Sync Info tab documentation
                const infoDays = document.getElementById('info-chronic-days');
                if (infoDays) infoDays.textContent = chronicWindowDays;

                const r7 = document.getElementById('setting-rest-rpe7');
                const r8 = document.getElementById('setting-rest-rpe8');
                const r9 = document.getElementById('setting-rest-rpe9');
                if (r7) r7.value = restTimerDefaults.rpe7;
                if (r8) r8.value = restTimerDefaults.rpe8;
                if (r9) r9.value = restTimerDefaults.rpe9;

                const nd = document.getElementById('setting-neuro-dampener');
                const md = document.getElementById('setting-meta-dampener');
                const sd = document.getElementById('setting-struct-dampener');
                if (nd) nd.value = neuroDampener;
                if (md) md.value = metaDampener;
                if (sd) sd.value = structDampener;

                const dPre = document.getElementById('setting-default-preset');
                if (dPre) dPre.value = defaultLogPreset;

                // Multiplier Inputs
                syncMultiplierInputs();
                applyCustomMultipliers();

                // Widget Toggles
                syncWidgetToggles();
                applyWidgetVisibility();

                // Theme
                applyAccentColor(themeColor);

                // Recalculate sessions locally if multipliers changed (retroactive support)
                allSessions = allSessions.map(s => recalculateSession(s));
            } else {
                deloadWeeks = [];
                chronicWindowDays = 28;
                restTimerDefaults = { rpe7: 3, rpe8: 5, rpe9: 8 };
                neuroDampener = 1.0; metaDampener = 1.0; structDampener = 1.0;
                engineConfig = {
                    dynamicHalfLives: true, fatigueTax: true, metaFastScaling: true,
                    neuroStructLink: true, chronicCompensation: true,
                    hlMultRPE8: 1.2, hlMultRPE9: 1.5, taxThreshold50: 1.15, taxThreshold30: 1.30, chronicAbsorption: 0.20,
                    metaFastThreshold: 15, metaFastMultiplier: 1.2, neuroStructThreshold: 40, neuroStructMultiplier: 1.2
                };
            }
            refreshDashboard();
        });

        if (unsubscribeTemplates) unsubscribeTemplates();
        unsubscribeTemplates = onSnapshot(collection(db, `users/${user.uid}/templates`), (snapshot) => {
            userTemplates = [];
            snapshot.forEach((doc) => {
                userTemplates.push({ id: doc.id, ...doc.data() });
            });
            userTemplates.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
            renderTemplates();
        });


    } else {
        // User is signed out
        currentUser = null;
        allSessions = [];
        deloadWeeks = [];

        if (unsubscribeSnapshot) {
            unsubscribeSnapshot();
            unsubscribeSnapshot = null;
        }
        if (unsubscribeSettings) {
            unsubscribeSettings();
            unsubscribeSettings = null;
        }
        if (unsubscribeTemplates) {
            unsubscribeTemplates();
            unsubscribeTemplates = null;
        }

        // Hide Nav and show Login Screen
        document.getElementById('main-nav').style.display = 'none';
        switchToView('login');
    }
});

// ---- C4HP Climbing Load Calculator ----
let ANGLE_LABELS = {
    '0.8': 'Slab', '1': 'Vertical', '1.0': 'Vertical',
    '1.2': '20°', '1.4': '30°', '1.6': '40°', '1.8': '50°+'
};
let RPE_LABELS = {
    '0.8': 'RPE 5', '1': 'RPE 6', '1.0': 'RPE 6',
    '1.2': 'RPE 7', '1.4': 'RPE 8', '1.6': 'RPE 9+'
};
let POWER_LABELS = {
    '1': 'Static', '1.0': 'Static',
    '1.2': 'Controlled', '1.4': 'Less-Ctrl', '1.6': 'Hands Only'
};
let HOLD_LABELS = {
    '0.8': 'Jugs', '1': 'Slopers', '1.0': 'Slopers',
    '1.2': '20-25mm', '1.4': '<15mm', '1.6': 'Pockets'
};

// ---- Date Helpers (Local Time) ----
function formatLocalDate(date) {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function parseLocalDate(s) {
    if (!s) return new Date();
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
}

function calculateLoad(type, moves, angle, rpe, power, hold) {
    // Fingerboard uses boulder multiplier (×10) but no wall angle
    const baseMoves = type === 'lead' ? moves * 4 : moves * 10;
    const effectiveAngle = type === 'fingerboard' ? 1.0 : angle;
    const clu = baseMoves * effectiveAngle * rpe;
    const total = clu * power * hold;
    return Math.round(total * 10) / 10;
}

function calculateChannels(type, moves, angle, rpe, power, hold) {
    const baseMoves = type === 'lead' ? moves * 4 : moves * 10;
    const effectiveAngle = type === 'fingerboard' ? 1.0 : angle;

    // Neuromuscular: high RPE, steep angle, small holds amplify recruitment
    const neuro = (baseMoves * effectiveAngle * (rpe * rpe) * Math.sqrt(hold) * Math.sqrt(power)) * neuroDampener;

    // Metabolic: peaks at moderate RPE (~1.0-1.2), drops at extremes
    const metabolic = (baseMoves * rpe * (2.0 - rpe)) * metaDampener;

    // Structural: tendon/pulley stress from small holds + dynamic movement
    // Uses sqrt(angle) because tendon stress doesn't increase as aggressively as neuro recruitment on steep terrain.
    const structural = (baseMoves * Math.sqrt(effectiveAngle) * rpe * hold * power) * structDampener;

    return {
        neuro: Math.round(neuro * 10) / 10,
        metabolic: Math.round(metabolic * 10) / 10,
        structural: Math.round(structural * 10) / 10
    };
}

// Channel mini-bar HTML helper (reusable everywhere)
function renderChannelMini(n, m, s) {
    const maxVal = Math.max(n, m, s, 1);
    // minimum 10% height so 0 values are still slightly visible, max 100%
    const nH = Math.max(10, (n / maxVal) * 100).toFixed(0);
    const mH = Math.max(10, (m / maxVal) * 100).toFixed(0);
    const sH = Math.max(10, (s / maxVal) * 100).toFixed(0);
    return `<div class="channel-bar-inline"><div class="ws-bar ch-neuro" style="height:${nH}%"></div><div class="ws-bar ch-meta" style="height:${mH}%"></div><div class="ws-bar ch-struct" style="height:${sH}%"></div></div>`;
}

// Helper: extract channel totals from a session (handles legacy sessions without channel data)
function getSessionChannels(sess) {
    if (sess.totalNeuro !== undefined) {
        return { neuro: sess.totalNeuro, metabolic: sess.totalMetabolic, structural: sess.totalStructural };
    }
    // Legacy fallback: recompute from climb data
    let neuro = 0, metabolic = 0, structural = 0;
    (sess.climbs || []).forEach(c => {
        if (c.neuro !== undefined) {
            neuro += c.neuro;
            metabolic += c.metabolic;
            structural += c.structural;
        } else {
            const ch = calculateChannels(c.type, c.moves, c.angle || 1, c.rpe || 1, c.power || 1, c.hold || 1);
            neuro += ch.neuro;
            metabolic += ch.metabolic;
            structural += ch.structural;
        }
    });
    return { neuro, metabolic, structural };
}

// ---- DOM References ----
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// Views
const views = {
    login: $('#view-login'),
    dashboard: $('#view-dashboard'),
    log: $('#view-log'),
    history: $('#view-history'),
    analytics: $('#view-analytics'),
    info: $('#view-info'),
    settings: $('#view-settings')
};

// ---- Navigation ----
function switchToView(viewName) {
    $$('.nav-tab').forEach(t => t.classList.remove('active'));
    const btn = $(`[data-view="${viewName}"]`);
    if (btn) btn.classList.add('active');

    const alreadyInSettings = views.settings.classList.contains('active');
    Object.values(views).forEach(v => v.classList.remove('active'));
    if (views[viewName]) {
        views[viewName].classList.add('active');
    }

    if (viewName === 'dashboard') refreshDashboard();
    if (viewName === 'analytics') renderAnalytics();
    if (viewName === 'history') renderHistory();
    if (viewName === 'settings') {
        if (!alreadyInSettings) showSettingsSection('general');
    }
    if (viewName === 'log' && !editingSessionId) {
        // Reset to new session mode
        $('#log-header-title').textContent = 'Log Climbing Session';
        $('#log-header-subtitle').textContent = 'Add climbs to your session and calculate your total training load.';
        $('#btn-save-label').textContent = 'Save Session';
        setTimeout(checkInterference, 50);
        setTimeout(() => updateTargetUI(), 50);
    }
}

// ---- Info View Logic ----
function showInfoSection(sectionId) {
    // Update Tabs
    $$('#info-sidebar .info-tab').forEach(t => {
        t.classList.remove('active');
        if (t.dataset.section === sectionId) {
            t.classList.add('active');
        }
    });

    // Update Content
    $$('#view-info .info-section').forEach(s => s.classList.remove('active'));
    const section = $(`#info-${sectionId}`);
    if (section) section.classList.add('active');

    // Scroll to top or section
    if (window.innerWidth <= 800) {
        section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
}
window.showInfoSection = showInfoSection;

// Bind event listeners to info tabs
$$('#info-sidebar .info-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const sectionId = tab.dataset.section;
        if (sectionId) {
            showInfoSection(sectionId);
        }
    });
});

window.goToInfo = function (sectionId) {
    switchToView('info');
    showInfoSection(sectionId);
};

$$('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const viewName = tab.dataset.view;
        // If switching away from log while editing, cancel edit
        if (viewName !== 'log' && editingSessionId) {
            editingSessionId = null;
            currentSessionClimbs = [];
            resetLogForm();
            renderSessionClimbs();
        }
        switchToView(viewName);
    });
});

// ---- Climb Type Toggle ----
const climbTypeToggle = $('#climb-type-toggle');
let currentClimbType = 'boulder';

function onClimbTypeChange(type) {
    currentClimbType = type;
    const wallAngleWrapper = $('#wall-angle-wrapper');
    const gradeWrapper = $('#grade-wrapper');
    const previewAngle = $('#preview-angle');
    const previewAngleOp = $('#preview-angle-op');

    const movesWrapper = $('#moves-wrapper');
    const fbVolumeWrapper = $('#fingerboard-volume-wrapper');
    const powerWrapper = $('#power-wrapper');
    const fbModalityWrapper = $('#fb-modality-wrapper');

    if (type === 'fingerboard') {
        if (wallAngleWrapper) wallAngleWrapper.style.display = 'none';
        if (gradeWrapper) gradeWrapper.style.display = 'none';
        if (previewAngle) previewAngle.style.display = 'none';
        if (previewAngleOp) previewAngleOp.style.display = 'none';

        if (movesWrapper) movesWrapper.style.display = 'none';
        if (fbVolumeWrapper) fbVolumeWrapper.style.display = 'block';
        if (powerWrapper) powerWrapper.style.display = 'none';
        if (fbModalityWrapper) fbModalityWrapper.style.display = 'block';
    } else {
        if (wallAngleWrapper) wallAngleWrapper.style.display = 'block';
        if (gradeWrapper) gradeWrapper.style.display = 'block';
        if (previewAngle) previewAngle.style.display = 'inline';
        if (previewAngleOp) previewAngleOp.style.display = 'inline';

        if (movesWrapper) movesWrapper.style.display = 'block';
        if (fbVolumeWrapper) fbVolumeWrapper.style.display = 'none';
        if (powerWrapper) powerWrapper.style.display = 'block';
        if (fbModalityWrapper) fbModalityWrapper.style.display = 'none';
    }
    updatePreview();
}

climbTypeToggle.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        climbTypeToggle.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        onClimbTypeChange(btn.dataset.value);
    });
});

// ---- Pill Groups ----
function setupPillGroup(groupId) {
    const group = $(`#${groupId}`);
    if (!group) return;
    group.querySelectorAll('.pill-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            group.querySelectorAll('.pill-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            updatePreview();
        });
    });
}

setupPillGroup('wall-angle-group');
setupPillGroup('rpe-group');
setupPillGroup('power-group');
setupPillGroup('hold-group');
setupPillGroup('fb-modality-group');

// ---- Stepper ----
const movesInput = $('#num-moves');
const fbRepsInput = $('#fb-reps');
const fbTutInput = $('#fb-tut');

function bindStepper(minusId, plusId, inputEl, minVal) {
    const minBtn = $(`#${minusId}`);
    const plusBtn = $(`#${plusId}`);
    if (!minBtn || !plusBtn || !inputEl) return;

    minBtn.addEventListener('click', () => {
        const v = parseInt(inputEl.value) || 0;
        inputEl.value = Math.max(minVal, v - 1);
        updatePreview();
    });
    plusBtn.addEventListener('click', () => {
        const v = parseInt(inputEl.value) || 0;
        inputEl.value = v + 1;
        updatePreview();
    });
    inputEl.addEventListener('input', updatePreview);
}

bindStepper('moves-minus', 'moves-plus', movesInput, 1);
bindStepper('fb-reps-minus', 'fb-reps-plus', fbRepsInput, 0);
bindStepper('fb-tut-minus', 'fb-tut-plus', fbTutInput, 0);

function getEffectiveMoves() {
    if (currentClimbType === 'fingerboard') {
        const r = parseInt(fbRepsInput.value) || 0;
        const t = parseInt(fbTutInput.value) || 0;
        return Math.max(0.1, r + (t / 3)); // Avoid 0 moves
    }
    return parseInt(movesInput.value) || 0;
}

function getEffectivePower() {
    if (currentClimbType === 'fingerboard') {
        return getActivePillValue('fb-modality-group').value;
    }
    return getActivePillValue('power-group').value;
}

// ---- Live Preview ----
function getActivePillValue(groupId) {
    const active = $(`#${groupId} .pill-btn.active`);
    return {
        value: active ? parseFloat(active.dataset.value) : 1.0,
        key: active ? active.dataset.key : null
    };
}

function getActivePillKey(groupId) {
    const active = $(`#${groupId} .pill-btn.active`);
    return active ? active.dataset.key : null;
}

function updatePreview() {
    const moves = getEffectiveMoves();
    const angleData = getActivePillValue('wall-angle-group');
    const rpeData = getActivePillValue('rpe-group');
    const power = getEffectivePower();
    const holdData = getActivePillValue('hold-group');

    const angle = angleData.value;
    let rpe = rpeData.value;
    const hold = holdData.value;

    // Warm-up ramp: average RPE from baseline (0.8) to selected RPE
    const warmupToggle = $('#warmup-toggle');
    const isWarmup = warmupToggle && warmupToggle.checked;
    if (isWarmup) {
        rpe = (0.8 + rpe) / 2;
    }

    const baseMoves = currentClimbType === 'lead' ? moves * 4 : moves * 10;
    const total = calculateLoad(currentClimbType, moves, angle, rpe, power, hold);

    $('#preview-base').textContent = baseMoves.toFixed(0);
    if (currentClimbType !== 'fingerboard') {
        $('#preview-angle').textContent = angle.toFixed(1);
    }
    $('#preview-rpe').textContent = rpe.toFixed(1);
    $('#preview-power').textContent = power.toFixed(1);
    $('#preview-hold').textContent = hold.toFixed(1);
    $('#preview-total').textContent = total.toFixed(0);
}

// ---- Set Default Date ----
function setDefaultDate() {
    $('#session-date').value = formatLocalDate(new Date());
}
setDefaultDate();

// Wire warmup toggle to live preview
const warmupToggleEl = $('#warmup-toggle');
if (warmupToggleEl) warmupToggleEl.addEventListener('change', updatePreview);

// ---- Reset Log Form ----
function resetLogForm() {
    $('#session-name').value = '';
    $('#session-location').value = '';
    $('#session-notes').value = '';
    $('#climb-grade').value = '';
    $('#climb-notes').value = '';
    setDefaultDate();

    // Apply default preset
    if (defaultLogPreset === 'power') applyTemplateToForm('boulder', 6, '1.6', '1.6', '1.2', '1.0');
    else if (defaultLogPreset === 'project') applyTemplateToForm('boulder', 4, '1.6', '1.6', '1.6', '1.2');
    else if (defaultLogPreset === 'endurance') applyTemplateToForm('lead', 35, '1.0', '1.2', '1.0', '0.8');
    else if (defaultLogPreset === 'fingerboard') applyTemplateToForm('fingerboard', 0, '1.0', '1.4', '1.2', '1.6', 0, 30);
    else {
        // Default (Boulder)
        climbTypeToggle.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
        $('#toggle-boulder').classList.add('active');
        onClimbTypeChange('boulder');

        resetPillGroup('wall-angle-group', '1.0');
        resetPillGroup('rpe-group', '1.0');
        resetPillGroup('power-group', '1.0');
        resetPillGroup('hold-group', '1.0');
        movesInput.value = 8;
    }

    editingSessionId = null;
    $('#log-header-title').textContent = 'Log Climbing Session';
    $('#log-header-subtitle').textContent = 'Add climbs to your session and calculate your total training load.';
    $('#btn-save-label').textContent = 'Save Session';
    updatePreview();
}

function resetPillGroup(groupId, defaultValue) {
    const group = $(`#${groupId}`);
    if (!group) return;
    group.querySelectorAll('.pill-btn').forEach(b => b.classList.remove('active'));
    const defaultBtn = group.querySelector(`[data-value="${defaultValue}"]`);
    if (defaultBtn) defaultBtn.classList.add('active');
}

// ---- Add Climb ----
$('#btn-add-climb').addEventListener('click', () => {
    const moves = getEffectiveMoves();
    if (moves <= 0) {
        showToast('Please enter a valid volume (moves, reps, or tut).');
        return;
    }

    const angleData = getActivePillValue('wall-angle-group');
    const rpeData = getActivePillValue('rpe-group');
    const powerKey = getActivePillKey('power-group');
    const holdData = getActivePillValue('hold-group');

    let angle = angleData.value;
    let rpe = rpeData.value;
    const power = getEffectivePower();
    const hold = holdData.value;

    const grade = currentClimbType === 'fingerboard' ? '' : $('#climb-grade').value.trim();
    const notes = $('#climb-notes').value.trim();

    // Warm-up ramp: average RPE from baseline (0.8) to selected RPE
    const warmupToggle = $('#warmup-toggle');
    const isWarmup = warmupToggle && warmupToggle.checked;
    if (isWarmup) {
        rpe = (0.8 + rpe) / 2;
    }

    const load = calculateLoad(currentClimbType, moves, angle, rpe, power, hold);
    const channels = calculateChannels(currentClimbType, moves, angle, rpe, power, hold);

    const climb = {
        type: currentClimbType,
        moves,
        angle: currentClimbType === 'fingerboard' ? 1.0 : angle,
        angleKey: angleData.key,
        rpe,
        rpeKey: rpeData.key,
        power,
        powerKey: powerKey,
        hold,
        holdKey: holdData.key,
        grade,
        notes,
        load,
        neuro: channels.neuro,
        metabolic: channels.metabolic,
        structural: channels.structural
    };

    currentSessionClimbs.push(climb);
    renderSessionClimbs();
    $('#climb-grade').value = '';
    $('#climb-notes').value = '';
    showToast(`Climb added — ${load.toFixed(0)} CLU`);
});

// ---- Render Session Climbs ----
function renderSessionClimbs() {
    const card = $('#session-climbs-card');
    const list = $('#session-climbs-list');

    if (currentSessionClimbs.length === 0) {
        card.style.display = 'none';
        return;
    }

    card.style.display = 'block';
    const totalLoad = currentSessionClimbs.reduce((s, c) => s + c.load, 0);
    $('#session-total').textContent = totalLoad.toFixed(0);

    if (typeof updateTargetUI === 'function') updateTargetUI(totalLoad);
    if (typeof checkInterference === 'function') checkInterference();

    list.innerHTML = currentSessionClimbs.map((c, i) => {
        const anglePart = c.type === 'fingerboard' ? '' : `<span class="climb-row-detail-tag">${ANGLE_LABELS[String(c.angle)] || c.angle}</span>`;
        const notesHtml = c.notes ? `<span class="climb-row-note" title="${escapeHtml(c.notes)}">📝</span>` : '';
        const chBar = renderChannelMini(c.neuro || 0, c.metabolic || 0, c.structural || 0);
        return `
        <div class="climb-row">
            <span class="climb-row-num">${i + 1}</span>
            <span class="climb-row-type ${c.type}">${c.type}</span>
            <div class="climb-row-details">
                <span class="climb-row-detail-tag">${c.moves} moves</span>
                ${anglePart}
                <span class="climb-row-detail-tag">${RPE_LABELS[String(c.rpe)] || c.rpe}</span>
                <span class="climb-row-detail-tag">${POWER_LABELS[String(c.power)] || c.power}</span>
                <span class="climb-row-detail-tag">${HOLD_LABELS[String(c.hold)] || c.hold}</span>
            </div>
            ${c.grade ? `<span class="climb-row-grade">${escapeHtml(c.grade)}</span>` : ''}
            ${notesHtml}
            <span class="climb-row-load">${c.load.toFixed(0)} CLU</span>
            ${chBar}
            <button class="climb-row-remove" onclick="removeClimb(${i})" title="Remove">✕</button>
        </div>`;
    }).join('');
}

// ---- Session Helpers bound to Window for ES Module ----
window.removeClimb = removeClimb;
window.editSession = editSession;
window.deleteSession = deleteSession;
window.toggleHistorySession = toggleHistorySession;
window.goToHistory = goToHistory;
window.weekStripNav = (dir) => { weekStripOffset += dir; renderWeekStrip(); };

window.signIn = async () => {
    try { await signInWithPopup(auth, provider); }
    catch (e) { showToast('Login Error: ' + e.message); }
};

window.signOutUser = async () => {
    try { await signOut(auth); }
    catch (e) { console.error(e); }
};

function removeClimb(index) {
    currentSessionClimbs.splice(index, 1);
    renderSessionClimbs();
}

// ---- Save Session ----
$('#btn-save-session').addEventListener('click', async () => {
    if (currentSessionClimbs.length === 0) {
        showToast('Add at least one climb first.');
        return;
    }

    const sessionData = {
        date: $('#session-date').value,
        name: $('#session-name').value.trim() || 'Climbing Session',
        location: $('#session-location').value.trim(),
        notes: $('#session-notes').value.trim(),
        climbs: [...currentSessionClimbs],
        totalLoad: currentSessionClimbs.reduce((s, c) => s + c.load, 0),
        totalNeuro: currentSessionClimbs.reduce((s, c) => s + (c.neuro || 0), 0),
        totalMetabolic: currentSessionClimbs.reduce((s, c) => s + (c.metabolic || 0), 0),
        totalStructural: currentSessionClimbs.reduce((s, c) => s + (c.structural || 0), 0)
    };

    let existingDate = null;
    if (editingSessionId) {
        const existing = allSessions.find(s => s.id === editingSessionId);
        if (existing) existingDate = existing.createdAt;
    }

    const finalSession = {
        ...sessionData,
        createdAt: existingDate || new Date().toISOString()
    };

    const targetId = editingSessionId || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    editingSessionId = null;

    try {
        await setDoc(doc(db, `users/${currentUser.uid}/sessions`, targetId), finalSession);
        showToast('Session synced to cloud!');
    } catch (e) {
        // Will still trigger offline fallback due to Firestore persistence
        console.error(e);
        showToast('Saved locally (offline)');
    }

    // Reset
    currentSessionClimbs = [];
    renderSessionClimbs();
    resetLogForm();
});

// ---- Edit Session ----
function editSession(id) {
    const session = allSessions.find(s => s.id === id);
    if (!session) return;

    editingSessionId = id;
    currentSessionClimbs = [...session.climbs];

    // Populate meta fields
    $('#session-date').value = session.date;
    $('#session-name').value = session.name || '';
    $('#session-location').value = session.location || '';
    $('#session-notes').value = session.notes || '';

    // Update headers
    $('#log-header-title').textContent = 'Edit Session';
    $('#log-header-subtitle').textContent = `Editing "${session.name}" — modify climbs and save when done.`;
    $('#btn-save-label').textContent = 'Update Session';

    renderSessionClimbs();
    switchToView('log');

    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---- Deload Helpers ----
function getIsoWeekString(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${weekNo}`;
}

window.handleDeloadToggle = async (isChecked) => {
    if (!currentUser) return;
    const weekStr = getIsoWeekString(new Date());
    let newDeloads = [...deloadWeeks];
    if (isChecked && !newDeloads.includes(weekStr)) {
        newDeloads.push(weekStr);
    } else if (!isChecked && newDeloads.includes(weekStr)) {
        newDeloads = newDeloads.filter(w => w !== weekStr);
    }

    // Optimistic UI update
    deloadWeeks = newDeloads;
    refreshDashboard();

    try {
        await setDoc(doc(db, `users/${currentUser.uid}/settings`, 'preferences'), { deloadWeeks: newDeloads }, { merge: true });
    } catch (e) {
        showToast('Saved locally (offline)');
    }
};

// ---- Dashboard ----
function refreshDashboard() {
    evaluateEngine(allSessions);

    const now = new Date();
    // Rolling 7-day window: today + 6 previous days = 7 calendar days
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(now.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const fourteenDaysAgo = new Date(now);
    fourteenDaysAgo.setDate(now.getDate() - 13);
    fourteenDaysAgo.setHours(0, 0, 0, 0);

    const thisWeekSessions = allSessions.filter(s => parseLocalDate(s.date) >= sevenDaysAgo);
    const lastWeekSessions = allSessions.filter(s => {
        const d = parseLocalDate(s.date);
        return d >= fourteenDaysAgo && d < sevenDaysAgo;
    });

    const weeklyLoad = thisWeekSessions.reduce((s, sess) => s + sess.totalLoad, 0);
    const lastWeekLoad = lastWeekSessions.reduce((s, sess) => s + sess.totalLoad, 0);
    const avgLoad = getChronicLoadASL();

    // Compute weekly channel totals (with legacy session fallback)
    let weekNeuro = 0, weekMeta = 0, weekStruct = 0;
    thisWeekSessions.forEach(sess => {
        const ch = getSessionChannels(sess);
        weekNeuro += ch.neuro;
        weekMeta += ch.metabolic;
        weekStruct += ch.structural;
    });

    $('#weekly-load').textContent = weeklyLoad.toFixed(0);
    $('#weekly-sessions').textContent = thisWeekSessions.length;
    $('#avg-load').textContent = avgLoad.toFixed(0);

    // Render channel breakdown bar
    const channelBar = $('#channel-breakdown-bar');
    if (channelBar && weeklyLoad > 0) {
        const chTotal = weekNeuro + weekMeta + weekStruct;
        const nPct = (weekNeuro / chTotal * 100).toFixed(1);
        const mPct = (weekMeta / chTotal * 100).toFixed(1);
        const sPct = (weekStruct / chTotal * 100).toFixed(1);
        channelBar.innerHTML = `<div class="ch-seg ch-neuro" style="width:${nPct}%" title="Neuro ${Math.round(weekNeuro)}"></div><div class="ch-seg ch-meta" style="width:${mPct}%" title="Metabolic ${Math.round(weekMeta)}"></div><div class="ch-seg ch-struct" style="width:${sPct}%" title="Structural ${Math.round(weekStruct)}"></div>`;
        channelBar.style.display = 'flex';
    } else if (channelBar) {
        channelBar.style.display = 'none';
    }

    // -- ACWR, Deload, and Warnings --
    const isDeload = deloadWeeks.includes(getIsoWeekString(now));
    const toggleEl = $('#toggle-deload');
    if (toggleEl) toggleEl.checked = isDeload;

    // Acute: past 7 days
    const acuteLoad = thisWeekSessions.reduce((s, sess) => s + sess.totalLoad, 0);
    // Chronic: past N days (user-configurable)
    const pastChronicStart = new Date(now);
    pastChronicStart.setDate(now.getDate() - chronicWindowDays);
    pastChronicStart.setHours(0, 0, 0, 0);
    const sixHoursAgoACWR = new Date(now.getTime() - 6 * 3600 * 1000);
    const lastChronicSessions = allSessions.filter(s => {
        const d = parseLocalDate(s.date);
        if (d < pastChronicStart || d > now) return false;
        // 6-hour adaptation delay: exclude sessions logged within the last 6 hours
        const sessTime = s.createdAt ? new Date(s.createdAt) : d;
        return sessTime <= sixHoursAgoACWR;
    });
    const chronicTotal = lastChronicSessions.reduce((s, sess) => s + sess.totalLoad, 0);
    const chronicLoadAvg = chronicTotal / (chronicWindowDays / 7);

    const acwrCard = $('#stat-acwr');
    const acwrRatio = $('#acwr-ratio');
    const acwrZone = $('#acwr-zone');

    acwrCard.className = 'stat-card'; // reset classes

    // Handle Energy Budget UI
    const budgetContainer = $('#deload-budget-container');
    const budgetFill = $('#deload-budget-fill');
    const budgetText = $('#deload-budget-text');
    const deloadCard = $('#deload-container');

    // Toggle green glow on the deload card
    if (deloadCard) {
        deloadCard.classList.toggle('deload-active', isDeload);
    }

    if (isDeload && chronicLoadAvg > 0) {
        const targetBudget = chronicLoadAvg * 0.6;
        budgetContainer.style.display = 'block';
        budgetText.textContent = `${acuteLoad.toFixed(0)} / ${targetBudget.toFixed(0)} CLU`;
        const pct = Math.min(100, (acuteLoad / targetBudget) * 100);
        budgetFill.style.width = pct + '%';
        const over = pct >= 100;
        budgetFill.style.background = over ? 'var(--red-500)' : '';
        budgetText.style.color = over ? 'var(--red-400)' : '';
        budgetText.style.fontWeight = over ? 'bold' : '';
    } else if (isDeload) {
        budgetContainer.style.display = 'block';
        budgetText.textContent = 'Need data (log more weeks)';
        budgetText.style.color = 'var(--text-muted)';
        budgetFill.style.width = '0%';
    } else {
        budgetContainer.style.display = 'none';
    }

    if (chronicLoadAvg > 0) {
        const ratio = acuteLoad / chronicLoadAvg;
        acwrRatio.textContent = ratio.toFixed(2);

        if (isDeload) {
            // Flipped Logic for Deload (Aligned with 60% budget)
            if (ratio <= 0.6) {
                acwrCard.classList.add('glow-green');
                acwrZone.textContent = 'Perfect Deload';
                acwrZone.style.color = 'var(--green-400)';
            } else if (ratio <= 0.8) {
                acwrCard.classList.add('glow-yellow');
                acwrZone.textContent = 'Caution';
                acwrZone.style.color = 'var(--yellow-400)';
            } else {
                acwrCard.classList.add('glow-red');
                acwrZone.textContent = 'Danger Zone';
                acwrZone.style.color = 'var(--red-500)';
            }
        } else {
            // Standard Logic
            if (ratio < 0.8) {
                acwrCard.classList.add('glow-gray');
                acwrZone.textContent = 'Under-trained';
                acwrZone.style.color = 'var(--text-secondary)';
            } else if (ratio <= 1.3) {
                acwrCard.classList.add('glow-green');
                acwrZone.textContent = 'Sweet Spot';
                acwrZone.style.color = 'var(--green-400)';
            } else if (ratio <= 1.5) {
                acwrCard.classList.add('glow-yellow');
                acwrZone.textContent = 'Caution';
                acwrZone.style.color = 'var(--yellow-400)';
            } else {
                acwrCard.classList.add('glow-red');
                acwrZone.textContent = 'Danger Zone';
                acwrZone.style.color = 'var(--red-500)';
            }
        }
    } else {
        acwrRatio.textContent = '—';
        acwrZone.textContent = 'Need Data';
        acwrZone.style.color = 'var(--text-muted)';
    }

    // Handle Rest Warning Banner (4 weeks of Sweet Spot/Danger)
    const warningBanner = $('#rest-warning-banner');
    if (!isDeload && chronicTotal > 0) {
        // Simple heuristic: if we have 4 strong weeks without a deload
        // Check if last 4 weeks didn't contain a deload, and acute > 0.8 * chronic constantly...
        // For performance, we check if chronicLoad is significantly high and user hasn't rested.
        let hasNoRecentDeloads = true;
        for (let i = 0; i < 4; i++) {
            const checkD = new Date(now);
            checkD.setDate(now.getDate() - (i * 7));
            if (deloadWeeks.includes(getIsoWeekString(checkD))) {
                hasNoRecentDeloads = false;
                break;
            }
        }
        // If they did at least >800 avg CLU and haven't deloaded in 4 weeks
        if (hasNoRecentDeloads && chronicLoadAvg > 800) {
            warningBanner.style.display = 'flex';
        } else {
            warningBanner.style.display = 'none';
        }
    } else {
        warningBanner.style.display = 'none';
    }

    // Week-over-week
    if (lastWeekLoad > 0 && weeklyLoad > 0) {
        const change = ((weeklyLoad - lastWeekLoad) / lastWeekLoad * 100).toFixed(0);
        const sign = change >= 0 ? '+' : '';
        $('#wow-trend').textContent = `${sign}${change}%`;
        $('#wow-unit').textContent = change >= 0 ? '↑' : '↓';
        $('#wow-trend').style.color = change >= 0 ? 'var(--green-400)' : 'var(--red-500)';
    } else {
        $('#wow-trend').textContent = '—';
        $('#wow-unit').textContent = '';
        $('#wow-trend').style.color = '';
    }

    // Recent sessions
    renderRecentSessions();
    renderWeekStrip();

    // Charts & Pyramids
    drawWeeklyChart();
    renderGradePyramids();
    updateReadinessGauges();
}

// ---- Rolling 7-Day Calendar Strip ----
function renderWeekStrip() {
    const container = $('#week-strip-days');
    const header = $('#week-strip');
    if (!container || !header) return;

    const now = new Date();
    const todayStr = formatLocalDate(now);

    // Rolling 7-day window: starts 6 days ago, ends today (offset shifts by 7)
    const stripStart = new Date(now);
    stripStart.setDate(now.getDate() - 6 + (weekStripOffset * 7));
    stripStart.setHours(0, 0, 0, 0);

    const stripEnd = new Date(stripStart);
    stripEnd.setDate(stripEnd.getDate() + 6);

    // Update header with date range and nav arrows
    const headerEl = header.querySelector('.week-strip-header h3');
    if (headerEl) {
        const fmt = (d) => `${d.getDate()}/${d.getMonth() + 1}`;
        const label = weekStripOffset === 0 ? 'Last 7 Days' : `${fmt(stripStart)} – ${fmt(stripEnd)}`;
        const fwdBtn = weekStripOffset < 0 ? `<button class="ws-nav-btn" onclick="weekStripNav(1)">&#9654;</button>` : '';
        const todayBtn = weekStripOffset !== 0 ? ` <button class="ws-today-btn" onclick="weekStripOffset=0;renderWeekStrip();">Today</button>` : '';
        headerEl.innerHTML = `<button class="ws-nav-btn" onclick="weekStripNav(-1)">&#9664;</button> <span>${label}</span> ${fwdBtn}${todayBtn}`;
    }

    const shortDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const days = [];

    for (let i = 0; i < 7; i++) {
        const dayDate = new Date(stripStart);
        dayDate.setDate(stripStart.getDate() + i);
        const dateStr = formatLocalDate(dayDate);
        const dayName = shortDays[dayDate.getDay()];
        const dateLabel = `${dayName} ${dayDate.getDate()}/${dayDate.getMonth() + 1}`;

        const daySessions = allSessions.filter(s => s.date === dateStr);
        let neuro = 0, meta = 0, struct = 0, total = 0;
        daySessions.forEach(sess => {
            const ch = getSessionChannels(sess);
            neuro += ch.neuro;
            meta += ch.metabolic;
            struct += ch.structural;
            total += sess.totalLoad;
        });

        days.push({ label: dateLabel, dateStr, isToday: dateStr === todayStr, neuro, meta, struct, total, sessionCount: daySessions.length });
    }

    const allChannelVals = days.flatMap(d => [d.neuro, d.meta, d.struct]);
    const maxChannel = Math.max(1, ...allChannelVals);

    let html = '';
    days.forEach(d => {
        const todayClass = d.isToday ? ' today' : '';
        const barH = 36;

        if (d.sessionCount > 0) {
            const nH = Math.max(2, (d.neuro / maxChannel) * barH);
            const mH = Math.max(2, (d.meta / maxChannel) * barH);
            const sH = Math.max(2, (d.struct / maxChannel) * barH);
            html += `<div class="ws-day${todayClass}"><span class="ws-day-label">${d.label}</span><div class="ws-day-bars"><div class="ws-bar ch-neuro" style="height:${nH}px"></div><div class="ws-bar ch-meta" style="height:${mH}px"></div><div class="ws-bar ch-struct" style="height:${sH}px"></div></div><span class="ws-day-load">${Math.round(d.total)}</span></div>`;
        } else {
            html += `<div class="ws-day${todayClass}"><span class="ws-day-label">${d.label}</span><div class="ws-day-bars"><div class="ws-day-rest"></div></div><span class="ws-day-load" style="color:var(--text-muted)">—</span></div>`;
        }
    });

    container.innerHTML = html;
}
// ---- Grade Pyramids ----
function renderGradePyramids() {
    const now = new Date();
    const past30Start = new Date(now);
    past30Start.setDate(now.getDate() - 30);
    past30Start.setHours(0, 0, 0, 0);

    const recentSessions = allSessions.filter(s => parseLocalDate(s.date) >= past30Start);

    const boulderGrades = {};
    const leadGrades = {};

    // Group climbs by discipline and standardize font grade
    recentSessions.forEach(sess => {
        sess.climbs.forEach(c => {
            if (!c.grade || !c.grade.trim()) return; // skip empty grades

            // Standardize grade format: uppercase, strip spaces (e.g. " 7a + " -> "7A+")
            const gradeStr = c.grade.toUpperCase().replace(/\s/g, '');

            if (c.type === 'boulder') {
                boulderGrades[gradeStr] = (boulderGrades[gradeStr] || 0) + 1;
            } else if (c.type === 'lead') {
                leadGrades[gradeStr] = (leadGrades[gradeStr] || 0) + 1;
            }
        });
    });

    renderPyramidStack('#pyramid-boulder', boulderGrades, 'boulder-block');
    renderPyramidStack('#pyramid-lead', leadGrades, 'lead-block');
}

function renderPyramidStack(selector, gradeMap, blockClass) {
    const container = $(selector);
    const sortedGrades = Object.keys(gradeMap).sort().reverse(); // Sort descending (e.g. 7C+, 7C, 7B...)

    if (sortedGrades.length === 0) {
        container.innerHTML = '<div class="pyramid-empty">No grades logged<br>in the last 30 days.</div>';
        return;
    }

    let html = '';
    sortedGrades.forEach(grade => {
        const count = gradeMap[grade];
        html += '<div class="pyramid-tier">';

        // Instead of capping, scale down the blocks if there are too many
        let sizeClass = '';
        if (count > 24) sizeClass = 'size-tiny';
        else if (count > 14) sizeClass = 'size-xs';
        else if (count > 8) sizeClass = 'size-sm';

        for (let i = 0; i < count; i++) {
            html += `<div class="pyramid-block ${blockClass} ${sizeClass}">${grade}</div>`;
        }

        html += '</div>';
    });

    container.innerHTML = html;
}

function renderRecentSessions() {
    const list = $('#recent-sessions-list');
    const recent = allSessions.slice(0, 5);

    if (recent.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
                <p>No sessions recorded yet.</p>
                <p class="subtle">Start by logging your first climbing session!</p>
            </div>`;
        return;
    }

    list.innerHTML = recent.map(s => {
        const ch = getSessionChannels(s);
        return `
            <div class="session-row" onclick="goToHistory()">
                <span class="session-row-date">${formatDate(s.date)}</span>
                <span class="session-row-name">${escapeHtml(s.name)}</span>
                <span class="session-row-climbs">${s.climbs.length} climb${s.climbs.length !== 1 ? 's' : ''}</span>
                <div style="display:flex; align-items:center;">
                    <span class="session-row-load">${s.totalLoad.toFixed(0)} CLU</span>
                    ${s.trainingQuality !== undefined ? `<span style="font-size: 0.75rem; font-weight: bold; color: ${s.trainingQuality >= 90 ? 'var(--green-400)' : s.trainingQuality >= 70 ? 'var(--yellow-400)' : 'var(--red-500)'}; margin-left: 8px; margin-right: auto;" title="Training Quality Score">${s.trainingQuality}% Q</span>` : ''}
                    ${renderChannelMini(ch.neuro, ch.metabolic, ch.structural)}
                </div>
            </div>`;
    }).join('');
}

function goToHistory() {
    switchToView('history');
}

// ---- Weekly Chart (Canvas) ----
function drawWeeklyChart() {
    const canvas = $('#canvas-weekly');
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = 260 * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = '260px';
    ctx.scale(dpr, dpr);

    const W = rect.width;
    const H = 260;
    const padLeft = 50;
    const padRight = 20;
    const padTop = 20;
    const padBottom = 40;

    ctx.clearRect(0, 0, W, H);

    // Get last 8 weeks of data
    const weeks = [];
    const now = new Date();
    for (let i = 7; i >= 0; i--) {
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1) - (i * 7));
        weekStart.setHours(0, 0, 0, 0);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 7);

        const sessionsInWeek = allSessions.filter(s => {
            const d = parseLocalDate(s.date);
            return d >= weekStart && d < weekEnd;
        });

        let neuroLoad = 0, metaLoad = 0, structLoad = 0;
        sessionsInWeek.forEach(sess => {
            const ch = getSessionChannels(sess);
            neuroLoad += ch.neuro;
            metaLoad += ch.metabolic;
            structLoad += ch.structural;
        });

        const label = `${weekStart.getDate()}/${weekStart.getMonth() + 1}`;
        weeks.push({ label, neuro: neuroLoad, metabolic: metaLoad, structural: structLoad });
    }

    // Compute stack totals based on active channels only
    weeks.forEach(w => {
        w.stackTotal = 0;
        if (activeWeeklyChannels.neuro) w.stackTotal += w.neuro;
        if (activeWeeklyChannels.metabolic) w.stackTotal += w.metabolic;
        if (activeWeeklyChannels.structural) w.stackTotal += w.structural;
    });

    // Nice rounded Y-axis max
    const rawMax = Math.max(100, ...weeks.map(w => w.stackTotal));
    const niceMax = rawMax <= 500 ? Math.ceil(rawMax / 100) * 100
        : rawMax <= 2000 ? Math.ceil(rawMax / 500) * 500
            : Math.ceil(rawMax / 1000) * 1000;

    const chartW = W - padLeft - padRight;
    const chartH = H - padTop - padBottom;

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = padTop + (chartH / 4) * i;
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(W - padRight, y);
        ctx.stroke();

        const val = Math.round(niceMax * (1 - i / 4));
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.font = '11px Inter';
        ctx.textAlign = 'right';
        ctx.fillText(val, padLeft - 8, y + 4);
    }

    const barGroupW = chartW / weeks.length;
    const barW = Math.min(barGroupW * 0.5, 40);

    // Channel rendering order (bottom to top): structural, metabolic, neuro
    const channelDefs = [
        { key: 'structural', colors: ['#4ade80', '#22c55e'] },
        { key: 'metabolic', colors: ['#60a5fa', '#3b82f6'] },
        { key: 'neuro', colors: ['#fb923c', '#ef4444'] }
    ];

    weeks.forEach((w, i) => {
        const xCenter = padLeft + barGroupW * i + barGroupW / 2;
        const bX = xCenter - barW / 2;
        let yOffset = 0; // accumulates from bottom

        channelDefs.forEach(ch => {
            if (!activeWeeklyChannels[ch.key]) return;
            const val = w[ch.key];
            if (val <= 0) return;

            const segH = (val / niceMax) * chartH;
            const segY = padTop + chartH - yOffset - segH;

            const grad = ctx.createLinearGradient(0, segY, 0, segY + segH);
            grad.addColorStop(0, ch.colors[0]);
            grad.addColorStop(1, ch.colors[1]);

            // Only round top corners for the topmost segment
            roundedRect(ctx, bX, segY, barW, segH, yOffset === 0 ? 0 : 0);
            // Simple rect for stacking, with rounded top on final segment
            ctx.beginPath();
            if (yOffset === 0) {
                // Bottom segment — flat bottom
                ctx.rect(bX, segY, barW, segH);
            } else {
                ctx.rect(bX, segY, barW, segH);
            }
            ctx.fillStyle = grad;
            ctx.fill();

            yOffset += segH;
        });

        // Rounded top cap on the full stack
        if (yOffset > 0) {
            const topY = padTop + chartH - yOffset;
            ctx.fillStyle = 'rgba(0,0,0,0)'; // transparent
            // Draw a small rounded overlay at the top
            const r = Math.min(4, yOffset / 2);
            ctx.beginPath();
            ctx.moveTo(bX, topY + r);
            ctx.quadraticCurveTo(bX, topY, bX + r, topY);
            ctx.lineTo(bX + barW - r, topY);
            ctx.quadraticCurveTo(bX + barW, topY, bX + barW, topY + r);
            ctx.lineTo(bX + barW, topY + r + 2);
            ctx.lineTo(bX, topY + r + 2);
            ctx.closePath();
            // Redraw the top segment's gradient over the corners
            const topCh = [...channelDefs].reverse().find(c => activeWeeklyChannels[c.key] && w[c.key] > 0);
            if (topCh) {
                const grad = ctx.createLinearGradient(0, topY, 0, topY + 10);
                grad.addColorStop(0, topCh.colors[0]);
                grad.addColorStop(1, topCh.colors[1]);
                ctx.fillStyle = grad;
                ctx.fill();
            }
        }

        // Total label above the stack
        if (w.stackTotal > 0) {
            ctx.fillStyle = 'rgba(255,255,255,0.5)';
            ctx.font = 'bold 10px Inter';
            ctx.textAlign = 'center';
            const topY = padTop + chartH - yOffset;
            ctx.fillText(Math.round(w.stackTotal), xCenter, topY - 6);
        }

        // X label
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.font = '11px Inter';
        ctx.textAlign = 'center';
        ctx.fillText(w.label, xCenter, H - padBottom + 20);
    });
}

// Interactive legend toggles
document.querySelectorAll('#chart-weekly .legend-item[data-channel]').forEach(btn => {
    btn.addEventListener('click', () => {
        const channel = btn.dataset.channel;
        activeWeeklyChannels[channel] = !activeWeeklyChannels[channel];
        btn.classList.toggle('active');
        drawWeeklyChart();
    });
});

// ---- Average Modifiers Chart ----
function drawModifiersChart() {
    const canvas = $('#canvas-modifiers');
    const ctx = canvas.getContext('2d');

    // Ensure parent is visible and has width before drawing
    const rect = canvas.parentElement.getBoundingClientRect();
    if (rect.width === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = 280 * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = '280px';
    ctx.scale(dpr, dpr);

    const W = rect.width;
    const H = 280;
    const padLeft = 60;
    const padRight = 30;
    const padTop = 20;
    const padBottom = 50;

    ctx.clearRect(0, 0, W, H);

    // Get last 8 weeks of data — compute average modifiers per week
    const weeks = [];
    const now = new Date();
    for (let i = 7; i >= 0; i--) {
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1) - (i * 7));
        weekStart.setHours(0, 0, 0, 0);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 7);

        const sessionsInWeek = allSessions.filter(s => {
            const d = parseLocalDate(s.date);
            return d >= weekStart && d < weekEnd;
        });

        let angleSum = 0, rpeSum = 0, powerSum = 0, holdSum = 0, climbCount = 0;
        sessionsInWeek.forEach(sess => {
            sess.climbs.forEach(c => {
                angleSum += (c.angle || 1);
                rpeSum += (c.rpe || 1);
                powerSum += (c.power || 1);
                holdSum += (c.hold || 1);
                climbCount++;
            });
        });

        const label = `${weekStart.getDate()}/${weekStart.getMonth() + 1}`;
        weeks.push({
            label,
            angle: climbCount > 0 ? angleSum / climbCount : null,
            rpe: climbCount > 0 ? rpeSum / climbCount : null,
            power: climbCount > 0 ? powerSum / climbCount : null,
            hold: climbCount > 0 ? holdSum / climbCount : null,
            count: climbCount
        });
    }

    const chartW = W - padLeft - padRight;
    const chartH = H - padTop - padBottom;

    // Dynamic Y-axis: find actual min/max across all data
    const allVals = [];
    weeks.forEach(w => {
        ['angle', 'rpe', 'power', 'hold'].forEach(k => {
            if (activeModifiers[k] && w[k] !== null) allVals.push(w[k]);
        });
    });

    const dataMin = allVals.length > 0 ? Math.min(...allVals) : 0.8;
    const dataMax = allVals.length > 0 ? Math.max(...allVals) : 1.6;
    const padding = 0.1;
    const yMin = Math.floor((dataMin - padding) * 10) / 10;
    const yMax = Math.ceil((dataMax + padding) * 10) / 10;
    const yRange = Math.max(0.2, yMax - yMin);

    function yPos(val) {
        return padTop + chartH * (1 - (val - yMin) / yRange);
    }

    // Grid lines and Y labels — generate ticks dynamically
    const tickStep = yRange <= 0.5 ? 0.1 : 0.2;
    const yTicks = [];
    for (let t = Math.ceil(yMin / tickStep) * tickStep; t <= yMax; t += tickStep) {
        yTicks.push(Math.round(t * 100) / 100);
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    yTicks.forEach(tick => {
        const y = yPos(tick);
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(W - padRight, y);
        ctx.stroke();

        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.font = '11px Inter';
        ctx.textAlign = 'right';
        ctx.fillText(tick.toFixed(1), padLeft - 8, y + 4);
    });

    // Reference line at 1.0 (if within range)
    if (yMin < 1.0 && yMax > 1.0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(padLeft, yPos(1.0));
        ctx.lineTo(W - padRight, yPos(1.0));
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // X labels
    const stepW = chartW / (weeks.length - 1 || 1);
    weeks.forEach((w, i) => {
        const x = padLeft + stepW * i;
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.font = '11px Inter';
        ctx.textAlign = 'center';
        ctx.fillText(w.label, x, H - padBottom + 20);
    });

    // Draw lines — NO area fills
    const series = [
        { key: 'angle', color: '#f97316', label: 'Wall Angle' },
        { key: 'rpe', color: '#3b82f6', label: 'RPE' },
        { key: 'power', color: '#22c55e', label: 'Power' },
        { key: 'hold', color: '#8b5cf6', label: 'Hold' }
    ];

    series.forEach(s => {
        if (!activeModifiers[s.key]) return;
        const points = [];
        weeks.forEach((w, i) => {
            if (w[s.key] !== null) {
                points.push({ x: padLeft + stepW * i, y: yPos(w[s.key]), val: w[s.key] });
            }
        });

        if (points.length < 2) {
            // Draw dots for single points
            points.forEach(p => {
                ctx.fillStyle = s.color;
                ctx.beginPath();
                ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
                ctx.fill();
            });
            return;
        }

        // Line (thicker, rounded)
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        points.forEach((p, pi) => {
            if (pi === 0) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
        });
        ctx.stroke();

        // Dots
        points.forEach(p => {
            ctx.fillStyle = s.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
            ctx.fill();

            // Inner dot
            ctx.fillStyle = '#16161f';
            ctx.beginPath();
            ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
            ctx.fill();
        });
    });
}

// Interactive legend toggles for modifiers
document.querySelectorAll('#chart-modifiers .legend-item[data-modifier]').forEach(btn => {
    btn.addEventListener('click', () => {
        const mod = btn.dataset.modifier;
        activeModifiers[mod] = !activeModifiers[mod];
        btn.classList.toggle('active');
        drawModifiersChart();
    });
});

function roundedRect(ctx, x, y, w, h, r) {
    if (h < 1) return;
    r = Math.min(r, h / 2, w / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

// ---- Session Radar Charts ----
function drawSessionRadar(canvasId, climbs) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const size = 80;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    ctx.scale(dpr, dpr);

    if (!climbs || climbs.length === 0) return;

    // Averages
    let avgInt = 0, avgVol = 0, avgAng = 0, avgHold = 0;
    climbs.forEach(c => {
        avgInt += parseFloat(c.rpe) || 1.0;
        avgVol += parseFloat(c.moves) || 0;
        avgAng += parseFloat(c.angle) || 1.0;
        avgHold += parseFloat(c.hold) || 1.0;
    });
    avgInt /= climbs.length;
    avgVol /= climbs.length;
    avgAng /= climbs.length;
    avgHold /= climbs.length;

    // Normalize (0.1 to 1.0 for visibility)
    // Ranges: Int (0.8-1.6), Vol (1-30), Ang (0.8-1.8), Hold (0.8-1.6)
    const norm = (val, min, max) => Math.max(0.1, Math.min(1.0, (val - min) / (max - min)));

    const p = [
        norm(avgInt, 0.8, 1.6),  // Top: Intensity
        norm(avgVol, 1, 30),     // Right: Volume
        norm(avgAng, 0.8, 1.8),  // Bottom: Angle
        norm(avgHold, 0.8, 1.6)  // Left: Hold Size
    ];

    const center = size / 2;
    const maxR = size / 2 - 8;

    ctx.clearRect(0, 0, size, size);

    // Draw background axes
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(center, center - maxR); ctx.lineTo(center, center + maxR);
    ctx.moveTo(center - maxR, center); ctx.lineTo(center + maxR, center);
    ctx.stroke();

    // Draw polygon
    ctx.beginPath();
    ctx.moveTo(center, center - p[0] * maxR);
    ctx.lineTo(center + p[1] * maxR, center);
    ctx.lineTo(center, center + p[2] * maxR);
    ctx.lineTo(center - p[3] * maxR, center);
    ctx.closePath();

    ctx.fillStyle = 'rgba(249, 115, 22, 0.3)';
    ctx.fill();
    ctx.strokeStyle = '#f97316';
    ctx.lineWidth = 2;
    ctx.stroke();
}

// ---- History ----
function renderHistory() {
    const list = $('#history-list');

    if (allSessions.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
                <p>No sessions in your history.</p>
                <p class="subtle">Your saved sessions will appear here.</p>
            </div>`;
        return;
    }

    list.innerHTML = allSessions.map((s, idx) => {
        const date = formatDate(s.date);
        const climbsHtml = s.climbs.map((c, ci) => {
            const anglePart = c.type === 'fingerboard' ? '' : `<span class="climb-row-detail-tag">${ANGLE_LABELS[String(c.angle)] || c.angle}</span>`;
            let n = c.neuro || 0, m = c.metabolic || 0, st = c.structural || 0;
            if (n === 0 && m === 0 && st === 0) {
                const ch = calculateChannels(c.type, c.moves, c.angle || 1, c.rpe || 1, c.power || 1, c.hold || 1);
                n = ch.neuro; m = ch.metabolic; st = ch.structural;
            }
            const cChBar = renderChannelMini(n, m, st);
            const notesHtml = c.notes ? `<span class="climb-row-note" title="${escapeHtml(c.notes)}">📝</span>` : '';
            return `
            <div class="climb-row">
                <span class="climb-row-num">${ci + 1}</span>
                <span class="climb-row-type ${c.type}">${c.type}</span>
                <div class="climb-row-details">
                    <span class="climb-row-detail-tag">${c.moves} moves</span>
                    ${anglePart}
                    <span class="climb-row-detail-tag">${RPE_LABELS[String(c.rpe)] || c.rpe}</span>
                    <span class="climb-row-detail-tag">${POWER_LABELS[String(c.power)] || c.power}</span>
                    <span class="climb-row-detail-tag">${HOLD_LABELS[String(c.hold)] || c.hold}</span>
                </div>
                ${c.grade ? `<span class="climb-row-grade">${escapeHtml(c.grade)}</span>` : ''}
                ${notesHtml}
                <span class="climb-row-load">${c.load.toFixed(0)} CLU</span>
                ${cChBar}
            </div>`;
        }).join('');

        const sessionNotesHtml = s.notes ? `<div class="history-session-notes"><strong>Notes:</strong> ${escapeHtml(s.notes)}</div>` : '';
        const ch = getSessionChannels(s);

        return `
            <div class="history-session" id="hist-${idx}">
                <div class="history-session-header" onclick="toggleHistorySession(${idx})">
                    <span class="history-date">${date}</span>
                    <span class="history-name">${escapeHtml(s.name)}</span>
                    ${s.location ? `<span class="history-location">📍 ${escapeHtml(s.location)}</span>` : ''}
                    <div class="history-stats">
                        <div class="history-stat">
                            <div class="history-stat-val">${s.climbs.length}</div>
                            <div class="history-stat-label">Climbs</div>
                        </div>
                        <div class="history-stat">
                            <div class="history-stat-val load">${s.totalLoad.toFixed(0)}</div>
                            <div class="history-stat-label">CLU</div>
                        </div>
                        ${s.trainingQuality !== undefined ? `
                        <div class="history-stat" title="Training Quality Score (Adaptation Load / Taxed Load)">
                            <div class="history-stat-val" style="color: ${s.trainingQuality >= 90 ? 'var(--green-400)' : s.trainingQuality >= 70 ? 'var(--yellow-400)' : 'var(--red-500)'}; font-weight: 800;">${s.trainingQuality}%</div>
                            <div class="history-stat-label">Quality</div>
                        </div>
                        ` : ''}
                    </div>
                    <canvas id="radar-${s.id}" class="session-radar" width="80" height="80" style="margin-left: auto; margin-right: 15px;"></canvas>
                    ${renderChannelMini(ch.neuro, ch.metabolic, ch.structural)}
                    <svg class="history-session-expand" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                </div>
                <div class="history-session-body" id="hist-body-${idx}">
                    ${sessionNotesHtml}
                    <div class="history-climb-list">
                        ${climbsHtml}
                    </div>
                    <div class="history-actions-row">
                        <button class="btn-edit-session" onclick="editSession('${s.id}')">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                            Edit Session
                        </button>
                        <button class="btn-delete-session" onclick="deleteSession('${s.id}')">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                            Delete Session
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    // Draw Radars
    allSessions.forEach(s => {
        drawSessionRadar(`radar-${s.id}`, s.climbs);
    });
}

function toggleHistorySession(idx) {
    const body = $(`#hist-body-${idx}`);
    const arrow = $(`#hist-${idx} .history-session-expand`);
    body.classList.toggle('open');
    arrow.classList.toggle('open');
}

async function deleteSession(id) {
    if (!confirm('Delete this session? This cannot be undone.')) return;
    try {
        await deleteDoc(doc(db, `users/${currentUser.uid}/sessions`, id));
        showToast('Session deleted from cloud.');
    } catch (e) {
        console.error(e);
        showToast('Offline: Delete pending.');
    }
}


// ---- Utilities ----
function formatDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function showToast(msg) {
    const toast = $('#toast');
    $('#toast-message').textContent = msg;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 2500);
}

// ---- Resize handler for charts ----
let resizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        if (views.dashboard.classList.contains('active')) {
            drawWeeklyChart();
            drawModifiersChart();
            if (typeof drawIntensityHistogram === 'function') drawIntensityHistogram();
        }
    }, 200);
});

// Initial render handles default views, but Firebase onSnapshot handles allSessions

// ---- Session Presets ----
$('#session-presets').addEventListener('click', (e) => {
    if (e.target.classList.contains('pill-btn')) {
        // Toggle UI
        $$('#session-presets .pill-btn').forEach(btn => btn.classList.remove('active'));
        e.target.classList.add('active');

        const preset = e.target.dataset.preset;
        const nameInput = $('#session-name');

        if (preset === 'power') {
            applyTemplateToForm('boulder', 6, '1.6', '1.6', '1.2', '1.0');
        } else if (preset === 'project') {
            applyTemplateToForm('boulder', 4, '1.6', '1.6', '1.6', '1.2');
        } else if (preset === 'endurance') {
            applyTemplateToForm('lead', 35, '1.0', '1.2', '1.0', '0.8');
        } else if (preset === 'fingerboard') {
            applyTemplateToForm('fingerboard', 0, '1.0', '1.4', '1.2', '1.6', 0, 30);
        }
    }
});

// ---- Custom Templates Logic ----
function applyTemplateToForm(type, moves, angle, rpe, power, hold, reps = 0, tut = 0, isWarmup = false) {
    // Discipline
    $$('#climb-type-toggle .toggle-btn').forEach(btn => btn.classList.remove('active'));
    const typeBtn = $(`#toggle-${type}`);
    if (typeBtn) typeBtn.classList.add('active');
    onClimbTypeChange(type); // Triggers label changes

    // Moves / Volume
    if (type === 'fingerboard') {
        $('#fb-reps').value = reps;
        $('#fb-tut').value = tut;
    } else {
        $('#num-moves').value = moves;
    }

    // Angle
    if (type !== 'fingerboard') {
        $$('#wall-angle-group .pill-btn').forEach(btn => btn.classList.remove('active'));
        const angleBtn = $(`#wall-angle-group .pill-btn[data-value="${angle}"]`);
        if (angleBtn) angleBtn.classList.add('active');
    }

    // RPE
    $$('#rpe-group .pill-btn').forEach(btn => btn.classList.remove('active'));
    const rpeBtn = $(`#rpe-group .pill-btn[data-value="${rpe}"]`);
    if (rpeBtn) rpeBtn.classList.add('active');

    // Power
    if (type === 'fingerboard') {
        $$('#fb-modality-group .pill-btn').forEach(btn => btn.classList.remove('active'));
        const fbPBtn = $(`#fb-modality-group .pill-btn[data-value="${power}"]`);
        if (fbPBtn) fbPBtn.classList.add('active');
    } else {
        $$('#power-group .pill-btn').forEach(btn => btn.classList.remove('active'));
        const pBtn = $(`#power-group .pill-btn[data-value="${power}"]`);
        if (pBtn) pBtn.classList.add('active');
    }

    // Hold
    $$('#hold-group .pill-btn').forEach(btn => btn.classList.remove('active'));
    const hBtn = $(`#hold-group .pill-btn[data-value="${hold}"]`);
    if (hBtn) hBtn.classList.add('active');

    const warmupToggle = $('#warmup-toggle');
    if (warmupToggle) warmupToggle.checked = isWarmup;

    updatePreview();
}

$('#btn-save-template').addEventListener('click', async () => {
    const name = prompt('Name this template (e.g., C4HP Pulls):');
    if (!name || !name.trim()) return;

    // Read current form state
    const type = $('#climb-type-toggle .active').dataset.value;
    const moves = getEffectiveMoves();
    const reps = parseInt($('#fb-reps').value) || 0;
    const tut = parseInt($('#fb-tut').value) || 0;

    let angle = "1.0";
    if (type !== 'fingerboard') {
        const activeAngle = $('#wall-angle-group .active');
        if (activeAngle) angle = activeAngle.dataset.value;
    }

    const rpe = $('#rpe-group .active').dataset.value;
    const power = type === 'fingerboard' ? $('#fb-modality-group .active').dataset.value : $('#power-group .active').dataset.value;
    const hold = $('#hold-group .active').dataset.value;
    const isWarmup = $('#warmup-toggle') ? $('#warmup-toggle').checked : false;

    const template = {
        name: name.trim(),
        type, moves, angle, rpe, power, hold, reps, tut, isWarmup,
        createdAt: new Date().toISOString()
    };

    try {
        await addDoc(collection(db, `users/${currentUser.uid}/templates`), template);
        showToast('Template saved!');
    } catch (err) {
        console.error('Error saving template:', err);
        showToast('Failed to save template.');
    }
});

function renderTemplates() {
    const strip = $('#template-strip');
    const wrapper = $('#template-strip-wrapper');
    if (!strip || !wrapper) return;

    if (userTemplates.length === 0) {
        wrapper.style.display = 'none';
        return;
    }

    wrapper.style.display = 'block';
    strip.innerHTML = userTemplates.map(t => {
        return `
            <div class="template-btn-wrapper" style="display:inline-flex; align-items:center; background:var(--bg-main); border:1px solid var(--border-color); border-radius:var(--radius-sm); padding-right:0; overflow:hidden; flex-shrink:0;">
                <button class="template-btn" style="border:none; border-radius:0; padding:6px 10px;" onclick="applyUserTemplate('${t.id}')">
                    ${escapeHtml(t.name)}
                </button>
                <button class="template-btn-delete" style="background:transparent; border:none; padding:6px; cursor:pointer;" onclick="deleteTemplate('${t.id}')" title="Delete template">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
            </div>
        `;
    }).join('');
}

window.applyUserTemplate = (id) => {
    const t = userTemplates.find(x => x.id === id);
    if (!t) return;
    applyTemplateToForm(t.type, t.moves, t.angle, t.rpe, t.power, t.hold, t.reps || 0, t.tut || 0, t.isWarmup || false);
    showToast(`Applied ${t.name}`);
};

window.deleteTemplate = async (id) => {
    if (!confirm('Delete this template?')) return;
    try {
        await deleteDoc(doc(db, `users/${currentUser.uid}/templates`, id));
        showToast('Template deleted');
    } catch (err) {
        console.error('Error deleting:', err);
    }
};

// Initial render handles default views, but Firebase onSnapshot handles allSessions
updatePreview();

// ==========================================
// PHASE 4: TARGET ENGINE & INTERFERENCE
// ==========================================

function getChronicLoadASL() {
    if (!allSessions || allSessions.length === 0) return 0;
    const now = new Date();
    const chronicStart = new Date(now);
    chronicStart.setDate(now.getDate() - chronicWindowDays);
    const sixHoursAgo = new Date(now.getTime() - 6 * 3600 * 1000);

    const recentSessions = allSessions.filter(s => {
        const d = parseLocalDate(s.date);
        if (d < chronicStart) return false;
        // 6-hour adaptation delay: only include sessions older than 6 hours
        const sessTime = s.createdAt ? new Date(s.createdAt) : d;
        return sessTime <= sixHoursAgo;
    });
    if (recentSessions.length === 0) return 0;

    const totalCLU = recentSessions.reduce((sum, s) => sum + s.totalLoad, 0);
    return totalCLU / recentSessions.length;
}

$('#session-target-select').addEventListener('change', () => updateTargetUI());

window.updateTargetUI = function (currentLoad = null) {
    if (currentLoad === null) {
        currentLoad = currentSessionClimbs.reduce((sum, c) => sum + c.load, 0);
    }

    const select = $('#session-target-select');
    const fill = $('#target-progress-fill');
    const feedback = $('#target-feedback');
    if (!select || !fill || !feedback) return;

    const type = select.value;
    if (type === '0') {
        fill.style.width = '0%';
        feedback.textContent = 'No target';
        return;
    }

    const asl = getChronicLoadASL() || 500;
    let targetLoad = 0;
    if (type === 'light') targetLoad = asl * 0.5;
    else if (type === 'moderate') targetLoad = asl * 1.0;
    else if (type === 'heavy') targetLoad = asl * 1.5;

    let pct = (currentLoad / targetLoad) * 100;

    if (pct < 80) fill.style.backgroundColor = 'var(--blue-500)';
    else if (pct <= 105) fill.style.backgroundColor = 'var(--green-500)'; // Optimal zone
    else fill.style.backgroundColor = 'var(--red-500)'; // Overshot

    fill.style.width = Math.min(pct, 100) + '%';
    feedback.textContent = pct.toFixed(0) + '% of ' + targetLoad.toFixed(0) + ' CLU';
};

window.checkInterference = function () {
    const banner = $('#interference-warning');
    const textEl = $('#interference-text');
    if (!banner || !textEl) return;

    const now = new Date();
    const fortyEightHoursAgo = new Date(now);
    fortyEightHoursAgo.setHours(now.getHours() - 48);

    const recentSessions = allSessions.filter(s => new Date(s.date) >= fortyEightHoursAgo);

    let pastMetabolic = 0;
    let pastNeuro = 0;
    let pastStructural = 0;
    let pastTotal = 0;

    recentSessions.forEach(s => {
        // Exclude the currently edited session if any
        if (editingSessionId && s.id === editingSessionId) return;

        pastTotal += s.totalLoad;
        s.climbs.forEach(c => {
            pastMetabolic += (c.metabolic || 0);
            pastNeuro += (c.neuro || 0);
            pastStructural += (c.structural || 0);
        });
    });

    let curMetabolic = 0;
    let curNeuro = 0;
    let curStructural = 0;
    let curTotal = 0;

    currentSessionClimbs.forEach(c => {
        curMetabolic += (c.metabolic || 0);
        curNeuro += (c.neuro || 0);
        curStructural += (c.structural || 0);
        curTotal += c.load;
    });

    const totalMetabolic = pastMetabolic + curMetabolic;
    const totalNeuro = pastNeuro + curNeuro;
    const totalStructural = pastStructural + curStructural;
    const totalLoad48h = pastTotal + curTotal;

    const asl = getChronicLoadASL() || 500;

    let warning = null;

    // Rule 1: Neuro-Metabolic Clash
    // If both are highly accumulated in the 48h window + current session
    if (totalMetabolic > 250 && totalNeuro > 250) {
        warning = "Concurrent Training Clash: High metabolic acidosis blunts neurological adaptations. Avoid mixing heavy endurance with max power.";
    }
    // Rule 2: Structural Overload
    else if (totalStructural > 500) {
        warning = "Structural Overload: High connective tissue strain detected. Keep structural load light to allow tendon recovery.";
    }
    // Rule 3: Overtraining
    else if (totalLoad48h > asl * 2.0 && curTotal > 0) {
        warning = "Overtraining Warning: High cumulative load over the last 48 hours. Consider making today a light recovery day.";
    }

    if (warning) {
        textEl.textContent = warning;
        banner.style.display = 'block';
    } else {
        banner.style.display = 'none';
    }
};



// ==========================================
// PHASE 5: ADVANCED ANALYTICS (C4HP)
// ==========================================

function parseFontGrade(str) {
    if (!str) return 0;
    const s = str.trim().toLowerCase();

    // Font scale: 6a=1, 6a+=2, 6b=3, 6b+=4, 6c=5, 6c+=6, 7a=7...
    const match = s.match(/^([4-9])([a-c])(\+)?$/);
    if (match) {
        let num = parseInt(match[1]);
        if (num < 5) return 0; // Ignore very low grades
        let base = (num - 6) * 6; // 6=0, 7=6, 8=12
        let letter = match[2].charCodeAt(0) - 97; // a=0, b=1, c=2
        let plus = match[3] ? 1 : 0;
        return Math.max(0, base + (letter * 2) + plus + 1);
    }
    // V-Scale: v3=3, v4=4, v5=6, v6=7, v7=9
    const vMatch = s.match(/^v([0-9]+)$/);
    if (vMatch) {
        let v = parseInt(vMatch[1]);
        if (v < 3) return 0;
        return (v - 3) * 2 + 3; // Rough approximation
    }
    return 0;
}

function getFontGradeLabel(score) {
    if (score <= 0) return "<6a";
    let baseNum = Math.floor((score - 1) / 6) + 6;
    let rem = (score - 1) % 6;
    let letter = String.fromCharCode(97 + Math.floor(rem / 2));
    let plus = rem % 2 !== 0 ? "+" : "";
    return `${baseNum}${letter}${plus}`;
}

window.renderAnalytics = function () {
    const tfSelect = document.getElementById('analytics-timeframe');
    if (!tfSelect) return;
    const timeframeDays = parseInt(tfSelect.value) || 90;

    const now = new Date();
    const startDate = new Date(now);
    startDate.setDate(now.getDate() - timeframeDays);
    startDate.setHours(0, 0, 0, 0);

    const sessions = allSessions
        .filter(s => parseLocalDate(s.date) >= startDate)
        .sort((a, b) => parseLocalDate(a.date) - parseLocalDate(b.date));

    drawVelocityChart(sessions, timeframeDays);
    drawIntensityChart(sessions, timeframeDays);
    drawCorrelatorChart(sessions, timeframeDays);
    drawIntensityHistogram();
    drawModifiersChart();
    updateCoachInsight(sessions);
};

document.getElementById('analytics-timeframe').addEventListener('change', () => {
    if (document.getElementById('view-analytics').classList.contains('active')) {
        renderAnalytics();
    }
});

function drawVelocityChart(sessions, days) {
    const canvas = document.getElementById('canvas-velocity');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = 280 * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = '280px';
    ctx.scale(dpr, dpr);

    const W = rect.width;
    const H = 280;
    const padL = 40, padR = 20, padT = 20, padB = 40;
    ctx.clearRect(0, 0, W, H);

    if (sessions.length < 2) {
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.font = '14px Inter';
        ctx.textAlign = 'center';
        ctx.fillText('Not enough data to graph velocity phases.', W / 2, H / 2);
        return;
    }

    // Group by week
    const numBuckets = Math.max(2, Math.ceil(days / 7));
    const buckets = Array.from({ length: numBuckets }, () => ({ lowVel: 0, highVel: 0, date: null }));

    const now = new Date();
    sessions.forEach(sess => {
        const d = parseLocalDate(sess.date);
        const diffDays = Math.floor((now - d) / (1000 * 60 * 60 * 24));
        let bIdx = numBuckets - 1 - Math.floor(diffDays / 7);
        if (bIdx < 0) bIdx = 0;
        if (bIdx >= numBuckets) bIdx = numBuckets - 1;

        buckets[bIdx].date = buckets[bIdx].date || d;
        sess.climbs.forEach(c => {
            const p = parseFloat(c.power) || 1.0;
            // <1.3 is Low Velocity (Static, Controlled), >=1.3 is High Velocity (Dynamic)
            if (p < 1.3) buckets[bIdx].lowVel += c.load;
            else buckets[bIdx].highVel += c.load;
        });
    });

    const maxVal = Math.max(...buckets.map(b => b.lowVel + b.highVel), 100);

    const xStep = (W - padL - padR) / Math.max(1, (numBuckets - 1));

    // Draw axes
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath();
    ctx.moveTo(padL, padT); ctx.lineTo(padL, H - padB); ctx.lineTo(W - padR, H - padB);
    ctx.stroke();

    // Plot Low Velocity (Structural/Tissue Prep)
    ctx.beginPath();
    ctx.strokeStyle = '#3b82f6'; // Blue
    ctx.lineWidth = 3;
    buckets.forEach((b, i) => {
        const x = padL + i * xStep;
        const y = H - padB - (b.lowVel / maxVal) * (H - padT - padB);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Plot High Velocity (Power Phase)
    ctx.beginPath();
    ctx.strokeStyle = '#f97316'; // Orange
    ctx.lineWidth = 3;
    buckets.forEach((b, i) => {
        const x = padL + i * xStep;
        const y = H - padB - (b.highVel / maxVal) * (H - padT - padB);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Legend
    ctx.fillStyle = '#3b82f6';
    ctx.fillRect(W - 140, 10, 10, 10);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '11px Inter';
    ctx.textAlign = 'left';
    ctx.fillText('Low Velocity (Tissue)', W - 125, 20);

    ctx.fillStyle = '#f97316';
    ctx.fillRect(W - 140, 30, 10, 10);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText('High Velocity (Power)', W - 125, 40);
}

function drawIntensityHistogram() {
    const canvas = document.getElementById('canvas-intensity-hist');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = 260 * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = '260px';
    ctx.scale(dpr, dpr);

    const W = rect.width;
    const H = 260;
    const padL = 40, padR = 20, padT = 30, padB = 40;

    ctx.clearRect(0, 0, W, H);

    // 1. Gather Data (Last 14 Days)
    const buckets = [0, 0, 0, 0, 0];
    const now = new Date();
    const fourteenDaysAgo = new Date(now);
    fourteenDaysAgo.setDate(now.getDate() - 14);

    allSessions.forEach(s => {
        const d = parseLocalDate(s.date);
        if (d >= fourteenDaysAgo && s.climbs) {
            s.climbs.forEach(c => {
                const r = parseFloat(c.rpe) || 1.0;
                const load = parseFloat(c.load) || 0;

                if (r <= 0.8) buckets[0] += load;
                else if (r <= 1.0) buckets[1] += load;
                else if (r <= 1.2) buckets[2] += load;
                else if (r <= 1.4) buckets[3] += load;
                else buckets[4] += load;
            });
        }
    });

    const maxVal = Math.max(10, ...buckets);
    const chartW = W - padL - padR;
    const chartH = H - padT - padB;

    // 2. Draw Y-Axis Grid Lines
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
        const y = padT + (chartH / 3) * i;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(W - padR, y);
        ctx.stroke();

        const val = Math.round(maxVal * (1 - i / 3));
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.font = '11px Inter';
        ctx.textAlign = 'right';
        ctx.fillText(val, padL - 8, y + 4);
    }

    // 3. Draw the 5 Bars
    const labels = ['RPE 5', 'RPE 6', 'RPE 7', 'RPE 8', 'RPE 9+'];
    // Colors: Green (Easy), Gray (Mod), Gray (Hard), Orange (Very Hard), Red (Limit)
    const colors = ['#4ade80', '#9ca3af', '#9ca3af', '#f97316', '#ef4444'];

    const barGroupW = chartW / 5;
    const barW = Math.min(barGroupW * 0.4, 60); // Cap max width

    buckets.forEach((val, i) => {
        const xCenter = padL + barGroupW * i + barGroupW / 2;

        // Bar
        const barH = (val / maxVal) * chartH;
        const bX = xCenter - barW / 2;
        const bY = padT + chartH - barH;

        if (barH > 0) {
            ctx.fillStyle = colors[i];

            // Draw Rounded Rectangle
            const r = Math.min(4, barH / 2);
            ctx.beginPath();
            ctx.moveTo(bX + r, bY);
            ctx.lineTo(bX + barW - r, bY);
            ctx.quadraticCurveTo(bX + barW, bY, bX + barW, bY + r);
            ctx.lineTo(bX + barW, bY + barH);
            ctx.lineTo(bX, bY + barH);
            ctx.lineTo(bX, bY + r);
            ctx.quadraticCurveTo(bX, bY, bX + r, bY);
            ctx.closePath();
            ctx.fill();

            // Value Label above bar
            ctx.fillStyle = 'rgba(255,255,255,0.8)';
            ctx.font = 'bold 11px Inter';
            ctx.textAlign = 'center';
            ctx.fillText(Math.round(val), xCenter, bY - 6);
        }

        // X-Axis Label
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '11px Inter';
        ctx.textAlign = 'center';
        ctx.fillText(labels[i], xCenter, H - padB + 20);
    });
}

function evaluateEngine(sessions) {
    let sorted = [...sessions].sort((a, b) => {
        let ta = a.createdAt ? new Date(a.createdAt) : parseLocalDate(a.date);
        let tb = b.createdAt ? new Date(b.createdAt) : parseLocalDate(b.date);
        if (!a.createdAt) ta.setHours(12, 0, 0, 0);
        if (!b.createdAt) tb.setHours(12, 0, 0, 0);
        return ta - tb;
    });

    const getFatiguePct = (f, s, chronic) => {
        if (chronic <= 0) return { totalPct: 0 };
        let fPct = (f / chronic) * 50;
        let sPct = (s / chronic) * 50;
        let total = fPct + sPct;
        if (total > 95) total = 95;
        return { totalPct: total };
    };

    let processed = [];

    sorted.forEach(sess => {
        let sessTime = sess.createdAt ? new Date(sess.createdAt) : parseLocalDate(sess.date);
        if (!sess.createdAt) sessTime.setHours(12, 0, 0, 0);

        let chronWindowStart = new Date(sessTime);
        chronWindowStart.setDate(sessTime.getDate() - chronicWindowDays);
        let chronStruct = 0, chronNeuro = 0, chronMet = 0;

        processed.forEach(pSess => {
            if (pSess.time >= chronWindowStart && pSess.time < sessTime) {
                pSess.climbs.forEach(c => {
                    chronStruct += c.structural || 0;
                    chronNeuro += c.neuro || 0;
                    chronMet += c.metabolic || 0;
                });
                if (engineConfig.chronicCompensation) {
                    pSess.climbs.forEach(c => {
                        chronStruct += ((c.taxedStructural || c.structural) - (c.structural || 0)) * engineConfig.chronicAbsorption;
                        chronNeuro += ((c.taxedNeuro || c.neuro) - (c.neuro || 0)) * engineConfig.chronicAbsorption;
                        chronMet += ((c.taxedMetabolic || c.metabolic) - (c.metabolic || 0)) * engineConfig.chronicAbsorption;
                    });
                }
            }
        });

        const weeksInChronic = chronicWindowDays / 7;
        const wChronStruct = Math.max(1, chronStruct / weeksInChronic);
        const wChronNeuro = Math.max(1, chronNeuro / weeksInChronic);
        const wChronMet = Math.max(1, chronMet / weeksInChronic);

        let fMeta = 0, sMeta = 0, fNeuro = 0, sNeuro = 0, fStruct = 0, sStruct = 0;

        processed.forEach(pSess => {
            const diffHours = Math.max(0, (sessTime - pSess.time) / (1000 * 3600));
            pSess.climbs.forEach(c => {
                fMeta += (c.taxedMetabolic * fatigueTuning.meta.partition * ((168 * Math.LN2) / c.hlFastMeta)) * Math.pow(0.5, diffHours / c.hlFastMeta);
                sMeta += (c.taxedMetabolic * (1 - fatigueTuning.meta.partition) * ((168 * Math.LN2) / c.hlSlowMeta)) * Math.pow(0.5, diffHours / c.hlSlowMeta);
                fNeuro += (c.taxedNeuro * fatigueTuning.neuro.partition * ((168 * Math.LN2) / c.hlFastNeuro)) * Math.pow(0.5, diffHours / c.hlFastNeuro);
                sNeuro += (c.taxedNeuro * (1 - fatigueTuning.neuro.partition) * ((168 * Math.LN2) / c.hlSlowNeuro)) * Math.pow(0.5, diffHours / c.hlSlowNeuro);
                fStruct += (c.taxedStructural * fatigueTuning.struct.partition * ((168 * Math.LN2) / c.hlFastStruct)) * Math.pow(0.5, diffHours / c.hlFastStruct);
                sStruct += (c.taxedStructural * (1 - fatigueTuning.struct.partition) * ((168 * Math.LN2) / c.hlSlowStruct)) * Math.pow(0.5, diffHours / c.hlSlowStruct);
            });
        });

        let totalBase = 0, totalTaxed = 0;
        let annotatedClimbs = [];

        (sess.climbs || []).forEach(climb => {
            const metF = getFatiguePct(fMeta, sMeta, wChronMet);
            const neuroF = getFatiguePct(fNeuro, sNeuro, wChronNeuro);
            const structF = getFatiguePct(fStruct, sStruct, wChronStruct);

            let rMet = Math.max(5, Math.round(100 - metF.totalPct));
            let rNeuro = Math.max(5, Math.round(100 - neuroF.totalPct));
            let rStruct = Math.max(5, Math.round(100 - structF.totalPct));

            let taxMet = 1.0, taxNeuro = 1.0, taxStruct = 1.0;
            if (engineConfig.fatigueTax) {
                if (rMet < 30) taxMet = engineConfig.taxThreshold30;
                else if (rMet < 50) taxMet = engineConfig.taxThreshold50;

                if (rNeuro < 30) taxNeuro = engineConfig.taxThreshold30;
                else if (rNeuro < 50) taxNeuro = engineConfig.taxThreshold50;

                if (rStruct < 30) taxStruct = engineConfig.taxThreshold30;
                else if (rStruct < 50) taxStruct = engineConfig.taxThreshold50;

                if (engineConfig.neuroStructLink && rNeuro < engineConfig.neuroStructThreshold) taxStruct *= engineConfig.neuroStructMultiplier;
            }

            let mHlSlow = 1.0;
            let mHlFastMeta = 1.0;
            if (engineConfig.dynamicHalfLives) {
                let rpe = climb.rpe || 1.0;
                let rpeVal = 6;
                if (rpe >= 1.6) rpeVal = 9;
                else if (rpe >= 1.4) rpeVal = 8;
                else if (rpe >= 1.2) rpeVal = 7;
                else if (rpe <= 0.8) rpeVal = 5;

                if (rpeVal > 8) mHlSlow = engineConfig.hlMultRPE8 + (engineConfig.hlMultRPE9 - engineConfig.hlMultRPE8) * Math.min(1, rpeVal - 8);
                else if (rpeVal > 7) mHlSlow = 1.0 + (engineConfig.hlMultRPE8 - 1.0) * (rpeVal - 7);

                if (engineConfig.metaFastScaling && rpeVal >= 8 && climb.metabolic > engineConfig.metaFastThreshold) mHlFastMeta = engineConfig.metaFastMultiplier;
            }

            let cTaxedMet = (climb.metabolic || 0) * taxMet;
            let cTaxedNeuro = (climb.neuro || 0) * taxNeuro;
            let cTaxedStruct = (climb.structural || 0) * taxStruct;

            totalBase += climb.load || 0;
            let avgTax = (taxMet + taxNeuro + taxStruct) / 3;
            totalTaxed += (climb.load || 0) * avgTax;

            let hlFastMeta = fatigueTuning.meta.fastHL * mHlFastMeta;
            let hlSlowMeta = fatigueTuning.meta.slowHL * mHlSlow;
            let hlFastNeuro = fatigueTuning.neuro.fastHL;
            let hlSlowNeuro = fatigueTuning.neuro.slowHL * mHlSlow;
            let hlFastStruct = fatigueTuning.struct.fastHL;
            let hlSlowStruct = fatigueTuning.struct.slowHL * mHlSlow;

            let cAnn = {
                ...climb, taxedMetabolic: cTaxedMet, taxedNeuro: cTaxedNeuro, taxedStructural: cTaxedStruct,
                hlFastMeta, hlSlowMeta, hlFastNeuro, hlSlowNeuro, hlFastStruct, hlSlowStruct
            };
            annotatedClimbs.push(cAnn);

            fMeta += (cTaxedMet * fatigueTuning.meta.partition * ((168 * Math.LN2) / hlFastMeta));
            sMeta += (cTaxedMet * (1 - fatigueTuning.meta.partition) * ((168 * Math.LN2) / hlSlowMeta));
            fNeuro += (cTaxedNeuro * fatigueTuning.neuro.partition * ((168 * Math.LN2) / hlFastNeuro));
            sNeuro += (cTaxedNeuro * (1 - fatigueTuning.neuro.partition) * ((168 * Math.LN2) / hlSlowNeuro));
            fStruct += (cTaxedStruct * fatigueTuning.struct.partition * ((168 * Math.LN2) / hlFastStruct));
            sStruct += (cTaxedStruct * (1 - fatigueTuning.struct.partition) * ((168 * Math.LN2) / hlSlowStruct));
        });

        let quality = 100;
        if (totalTaxed > 0 && totalBase > 0) quality = Math.min(100, Math.round((totalBase / totalTaxed) * 100));

        sess.annotatedClimbs = annotatedClimbs;
        sess.trainingQuality = engineConfig.fatigueTax ? quality : undefined;

        processed.push({ time: sessTime, climbs: annotatedClimbs });
    });
}

function updateReadinessGauges() {
    const container = document.getElementById('readiness-gauges');
    if (!container) return;

    const now = new Date();
    const chronicStart = new Date(now);
    chronicStart.setDate(now.getDate() - chronicWindowDays);

    const sixHoursAgoGauges = new Date(now.getTime() - 6 * 3600 * 1000);
    const fatigueWindowDays = Math.max(60, chronicWindowDays * 2);
    const fatigueStart = new Date(now);
    fatigueStart.setDate(now.getDate() - fatigueWindowDays);

    let chronStruct = 0, chronNeuro = 0, chronMet = 0;
    let fMeta = 0, sMeta = 0, fNeuro = 0, sNeuro = 0, fStruct = 0, sStruct = 0;

    allSessions.forEach(s => {
        const d = parseLocalDate(s.date);

        if (d >= chronicStart) {
            const sessTimeChronic = s.createdAt ? new Date(s.createdAt) : d;
            if (sessTimeChronic <= sixHoursAgoGauges) {
                (s.climbs || []).forEach(c => {
                    chronStruct += c.structural || 0;
                    chronNeuro += c.neuro || 0;
                    chronMet += c.metabolic || 0;
                });
                if (engineConfig.chronicCompensation && s.annotatedClimbs) {
                    s.annotatedClimbs.forEach(c => {
                        chronStruct += ((c.taxedStructural || c.structural) - (c.structural || 0)) * engineConfig.chronicAbsorption;
                        chronNeuro += ((c.taxedNeuro || c.neuro) - (c.neuro || 0)) * engineConfig.chronicAbsorption;
                        chronMet += ((c.taxedMetabolic || c.metabolic) - (c.metabolic || 0)) * engineConfig.chronicAbsorption;
                    });
                }
            }
        }

        if (d >= fatigueStart) {
            let sessTime = s.createdAt ? new Date(s.createdAt) : parseLocalDate(s.date);
            if (!s.createdAt) sessTime.setHours(12, 0, 0, 0);
            const diffHours = Math.max(0, (now - sessTime) / (1000 * 3600));

            if (s.annotatedClimbs) {
                s.annotatedClimbs.forEach(c => {
                    fMeta += (c.taxedMetabolic * fatigueTuning.meta.partition * ((168 * Math.LN2) / c.hlFastMeta)) * Math.pow(0.5, diffHours / c.hlFastMeta);
                    sMeta += (c.taxedMetabolic * (1 - fatigueTuning.meta.partition) * ((168 * Math.LN2) / c.hlSlowMeta)) * Math.pow(0.5, diffHours / c.hlSlowMeta);
                    fNeuro += (c.taxedNeuro * fatigueTuning.neuro.partition * ((168 * Math.LN2) / c.hlFastNeuro)) * Math.pow(0.5, diffHours / c.hlFastNeuro);
                    sNeuro += (c.taxedNeuro * (1 - fatigueTuning.neuro.partition) * ((168 * Math.LN2) / c.hlSlowNeuro)) * Math.pow(0.5, diffHours / c.hlSlowNeuro);
                    fStruct += (c.taxedStructural * fatigueTuning.struct.partition * ((168 * Math.LN2) / c.hlFastStruct)) * Math.pow(0.5, diffHours / c.hlFastStruct);
                    sStruct += (c.taxedStructural * (1 - fatigueTuning.struct.partition) * ((168 * Math.LN2) / c.hlSlowStruct)) * Math.pow(0.5, diffHours / c.hlSlowStruct);
                });
            }
        }
    });

    const weeksInChronic = chronicWindowDays / 7;
    const wChronStruct = Math.max(1, chronStruct / weeksInChronic);
    const wChronNeuro = Math.max(1, chronNeuro / weeksInChronic);
    const wChronMet = Math.max(1, chronMet / weeksInChronic);

    const getFatiguePct = (f, s, chronic) => {
        let fPct = (f / chronic) * 50;
        let sPct = (s / chronic) * 50;
        let total = fPct + sPct;
        if (total > 95) {
            const scale = 95 / total;
            fPct *= scale;
            sPct *= scale;
        }
        return { fPct, sPct, totalPct: fPct + sPct };
    };

    const structF = getFatiguePct(fStruct, sStruct, wChronStruct);
    const neuroF = getFatiguePct(fNeuro, sNeuro, wChronNeuro);
    const metF = getFatiguePct(fMeta, sMeta, wChronMet);

    const readyStruct = Math.max(5, Math.round(100 - structF.totalPct));
    const readyNeuro = Math.max(5, Math.round(100 - neuroF.totalPct));
    const readyMet = Math.max(5, Math.round(100 - metF.totalPct));

    const getBarColor = (val, type) => {
        if (val < 40) return 'var(--red-500)';
        if (type === 'neuro') return 'var(--orange-400)';
        if (type === 'met') return 'var(--blue-400)';
        return 'var(--green-400)';
    };

    const renderGauge = (label, ready, fast, slow, type) => {
        const color = getBarColor(ready, type);
        const separator = `border-right: 1px solid var(--bg-card);`;

        return `
        <div style="margin-bottom: 16px;">
            <div style="display: flex; justify-content: space-between; font-size: 0.75rem; margin-bottom: 6px; font-weight: 700; color: var(--text-primary);">
                <span>${label}</span>
                <span>${ready}% Readiness</span>
            </div>
            <div style="height: 10px; background: rgba(255,255,255,0.08); border-radius: 5px; overflow: hidden; display: flex;">
                <div style="height: 100%; width: ${ready}%; background: ${color}; transition: width 0.6s var(--ease-out); ${ready > 0 ? separator : ''}"></div>
                <div style="height: 100%; width: ${slow}%; background: repeating-linear-gradient(45deg, ${color} 0, ${color} 4px, transparent 4px, transparent 8px); opacity: 0.4; transition: width 0.6s var(--ease-out); ${slow > 0 ? separator : ''}" title="Systemic Fatigue"></div>
                <div style="height: 100%; width: calc(100% - ${ready}% - ${slow}%); background: ${color}; opacity: 0.35; transition: width 0.6s var(--ease-out);" title="Acute Fatigue"></div>
            </div>
        </div>
    `;
    };

    container.innerHTML =
        renderGauge('Structural (Tissues)', readyStruct, structF.fPct, structF.sPct, 'struct') +
        renderGauge('Neuromuscular (Power)', readyNeuro, neuroF.fPct, neuroF.sPct, 'neuro') +
        renderGauge('Metabolic (Pump)', readyMet, metF.fPct, metF.sPct, 'met');
}

function drawIntensityChart(sessions, days) {
    const canvas = document.getElementById('canvas-intensity');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = 220 * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = '220px';
    ctx.scale(dpr, dpr);

    const W = rect.width, H = 220;
    const padL = 40, padR = 20, padT = 20, padB = 40;
    ctx.clearRect(0, 0, W, H);

    if (sessions.length < 2) return;

    // Intensity per session: total CLU / total Moves
    let maxI = 1;
    const pts = sessions.map(s => {
        let tMoves = s.climbs.reduce((acc, c) => acc + (c.moves || 0), 0);
        let i = tMoves > 0 ? s.totalLoad / tMoves : 0;
        if (i > maxI) maxI = i;
        return { date: parseLocalDate(s.date), intensity: i };
    });

    const start = new Date(); start.setDate(start.getDate() - days);
    const timeSpan = Math.max(1, new Date() - start);

    ctx.beginPath();
    ctx.strokeStyle = '#a855f7'; // Purple
    ctx.fillStyle = 'rgba(168, 85, 247, 0.2)';
    ctx.lineWidth = 2;

    pts.forEach((p, idx) => {
        const px = padL + ((p.date - start) / timeSpan) * (W - padL - padR);
        const py = H - padB - (p.intensity / maxI) * (H - padT - padB);
        if (idx === 0) { ctx.moveTo(px, py); } else { ctx.lineTo(px, py); }

        ctx.beginPath();
        ctx.arc(px, py, 3, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(px, py);
    });
    ctx.stroke();
}

function drawCorrelatorChart(sessions, days) {
    const canvas = document.getElementById('canvas-correlator');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = 280 * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = '280px';
    ctx.scale(dpr, dpr);

    const W = rect.width, H = 280;
    const padL = 40, padR = 20, padT = 20, padB = 40;
    ctx.clearRect(0, 0, W, H);

    if (sessions.length < 2) return;

    let maxScore = 0;
    const pts = sessions.map(s => {
        let m = 0;
        s.climbs.forEach(c => {
            let sc = parseFontGrade(c.grade);
            if (sc > m) m = sc;
        });
        if (m > maxScore) maxScore = m;
        return { date: parseLocalDate(s.date), score: m };
    }).filter(p => p.score > 0);

    if (pts.length === 0 || maxScore === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.font = '14px Inter';
        ctx.textAlign = 'center';
        ctx.fillText('Log Font grades (e.g. 6c, 7a+) to see correlation.', W / 2, H / 2);
        return;
    }

    const start = new Date(); start.setDate(start.getDate() - days);
    const timeSpan = Math.max(1, new Date() - start);

    ctx.beginPath();
    ctx.strokeStyle = '#22c55e'; // Green
    ctx.lineWidth = 3;

    pts.forEach((p, idx) => {
        const px = padL + ((p.date - start) / timeSpan) * (W - padL - padR);
        const py = H - padB - (p.score / (maxScore + 2)) * (H - padT - padB);
        if (idx === 0) { ctx.moveTo(px, py); } else { ctx.lineTo(px, py); }

        ctx.fillStyle = '#22c55e';
        ctx.beginPath(); ctx.arc(px, py, 4, 0, 2 * Math.PI); ctx.fill();

        ctx.fillStyle = '#fff';
        ctx.font = '10px Inter';
        ctx.textAlign = 'center';
        ctx.fillText(getFontGradeLabel(p.score), px, py - 10);

        ctx.beginPath(); ctx.moveTo(px, py);
    });
    ctx.stroke();
}

function updateCoachInsight(sessions) {
    const textEl = document.getElementById('analytics-insight-text');
    if (!textEl) return;

    if (sessions.length < 3) {
        textEl.textContent = "Log more sessions to generate advanced insights about your training phases.";
        return;
    }

    // Determine current phase based on last 14 days
    const now = new Date();
    const fourteenAgo = new Date(now);
    fourteenAgo.setDate(now.getDate() - 14);

    let lowVel = 0, highVel = 0, met = 0;

    sessions.filter(s => parseLocalDate(s.date) >= fourteenAgo).forEach(s => {
        s.climbs.forEach(c => {
            const p = parseFloat(c.power) || 1.0;
            if (p < 1.3) lowVel += c.load;
            else highVel += c.load;
            met += (c.metabolic || 0);
        });
    });

    let insight = "";

    if (lowVel > highVel * 1.5) {
        insight = "You are currently in a Tissue Prep phase (Low Velocity dominant). Continue building structural capacity before transitioning to power.";
    } else if (highVel > lowVel * 1.5) {
        insight = "You are currently in a Power/Projecting phase (High Velocity dominant). Ensure your connective tissues are fully recovered between sessions.";
    } else {
        insight = "Your recent training has a balanced mix of velocities. To drive specific adaptations, consider polarizing into a dedicated Tissue Prep or Power block.";
    }

    if (met > (lowVel + highVel) * 0.5) {
        insight += " Warning: High metabolic load detected. Heavy pump/acidosis will blunt your neurological power gains. Reduce pump if your goal is max bouldering strength.";
    }

    // Check correlation
    let maxScore = 0, bestSession = null;
    sessions.forEach(s => {
        s.climbs.forEach(c => {
            let sc = parseFontGrade(c.grade);
            if (sc > maxScore) { maxScore = sc; bestSession = s; }
        });
    });

    if (bestSession && maxScore > 2) {
        insight += ` You sent your hardest grade (${getFontGradeLabel(maxScore)}) on ${parseLocalDate(bestSession.date).toLocaleDateString()}. `;
    }

    // Phase 3: Golden Conditions
    const peakSessions = [...allSessions]
        .map(s => {
            let top = 0;
            s.climbs.forEach(c => {
                let sc = parseFontGrade(c.grade);
                if (sc > top) top = sc;
            });
            return { session: s, topGrade: top };
        })
        .filter(x => x.topGrade > 0)
        .sort((a, b) => b.topGrade - a.topGrade || new Date(b.session.date) - new Date(a.session.date))
        .slice(0, 3);

    if (peakSessions.length >= 1) {
        let acuteLoads = [];
        peakSessions.forEach(ps => {
            const sendDate = parseLocalDate(ps.session.date);
            const sevenDaysPrior = new Date(sendDate);
            sevenDaysPrior.setDate(sendDate.getDate() - 7);

            const priorAcuteLoad = allSessions
                .filter(s => {
                    const d = parseLocalDate(s.date);
                    return d >= sevenDaysPrior && d < sendDate;
                })
                .reduce((sum, s) => sum + s.totalLoad, 0);

            acuteLoads.push(priorAcuteLoad);
        });

        const avgAcute = acuteLoads.reduce((a, b) => a + b, 0) / acuteLoads.length;
        insight += `\n\nYour Peak Sending Sweet Spot: Your hardest grades were sent when your prior 7-day Acute Load averaged roughly ${Math.round(avgAcute)} CLU.`;
    }

    textEl.textContent = insight;
}


// ==========================================
// IMPORT DATA (JSON)
// ==========================================

document.getElementById('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!currentUser) {
        showToast('Please sign in first.');
        return;
    }

    try {
        const text = await file.text();
        const sessions = JSON.parse(text);

        if (!Array.isArray(sessions)) {
            showToast('Invalid format: expected an array of sessions.');
            return;
        }

        const confirmed = confirm(`Import ${sessions.length} sessions? This will ADD them to your existing data.`);
        if (!confirmed) return;

        let imported = 0;
        for (const sess of sessions) {
            // Validate minimum fields
            if (!sess.date || !sess.climbs || !Array.isArray(sess.climbs)) continue;

            // Recalculate totals from climbs
            let totalLoad = 0, totalNeuro = 0, totalMetabolic = 0, totalStructural = 0;
            sess.climbs.forEach(c => {
                totalLoad += (c.load || 0);
                totalNeuro += (c.neuro || 0);
                totalMetabolic += (c.metabolic || 0);
                totalStructural += (c.structural || 0);
            });

            const sessionDoc = {
                date: sess.date,
                name: sess.name || 'Imported Session',
                location: sess.location || '',
                notes: sess.notes || '',
                climbs: sess.climbs,
                totalLoad,
                totalNeuro,
                totalMetabolic,
                totalStructural,
                createdAt: sess.createdAt || new Date().toISOString()
            };

            const id = sess.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + imported);
            await setDoc(doc(db, `users/${currentUser.uid}/sessions`, id), sessionDoc);
            imported++;
        }

        showToast(`Imported ${imported} sessions successfully!`);
        e.target.value = ''; // Reset file input
    } catch (err) {
        console.error('Import error:', err);
        showToast('Import failed: ' + err.message);
    }
});

// ==========================================
// SETTINGS & PREFERENCES
// ==========================================

async function updatePreference(key, value) {
    if (!currentUser) return;
    try {
        await setDoc(doc(db, `users/${currentUser.uid}/settings`, 'preferences'), {
            [key]: value
        }, { merge: true });
    } catch (err) {
        console.error("Error saving preference:", err);
    }
}

$('#setting-chronic-window').addEventListener('change', (e) => {
    const val = parseInt(e.target.value) || 28;
    updatePreference('chronicWindowDays', val);
});

['rpe7', 'rpe8', 'rpe9'].forEach(key => {
    $(`#setting-rest-${key}`).addEventListener('change', (e) => {
        const val = parseInt(e.target.value) || 5;
        const newDefaults = { ...restTimerDefaults, [key]: val };
        updatePreference('restTimerDefaults', newDefaults);
    });
});

// Channel Dampener inputs
['neuro', 'meta', 'struct'].forEach(ch => {
    const inputId = `#setting-${ch}-dampener`;
    const prefKey = `${ch}Dampener`;
    $(inputId).addEventListener('change', (e) => {
        const val = parseFloat(e.target.value) || 1.0;
        updatePreference(prefKey, val);
        refreshDashboard();
    });
});

// Wipe Data
window.handleWipeData = async function () {
    if (!currentUser) return;
    const confirmText = "DELETE ALL DATA";
    const promptValue = prompt(`This will permanently delete ALL training sessions and settings. This action is IRREVERSIBLE.\n\nPlease type "${confirmText}" to confirm:`);

    if (promptValue !== confirmText) {
        showToast("Wipe cancelled.");
        return;
    }

    showToast("Starting wipe...");
    try {
        // Delete sessions
        for (const session of allSessions) {
            await deleteDoc(doc(db, `users/${currentUser.uid}/sessions`, session.id));
        }
        // Delete settings
        await deleteDoc(doc(db, `users/${currentUser.uid}/settings`, 'preferences'));

        showToast("All data wiped successfully.");
        switchToView('dashboard');
    } catch (err) {
        console.error("Wipe error:", err);
        showToast("Error wiping data: " + err.message);
    }
}

// Consolidation of Export Logic
const handleExport = () => {
    if (allSessions.length === 0) {
        showToast('No data to export.');
        return;
    }

    const exportData = allSessions.map(s => ({
        id: s.id,
        date: s.date,
        name: s.name,
        location: s.location || '',
        notes: s.notes || '',
        climbs: s.climbs,
        totalLoad: s.totalLoad,
        totalNeuro: s.totalNeuro,
        totalMetabolic: s.totalMetabolic,
        totalStructural: s.totalStructural,
        createdAt: s.createdAt || new Date().toISOString()
    }));

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sendload_export_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('JSON exported!');
};

// Bind export to the Settings view button
const exportBtnSettings = document.getElementById('btn-export-settings');
if (exportBtnSettings) exportBtnSettings.addEventListener('click', handleExport);

// ---- Advanced Customization Logic ----
function showSettingsSection(sectionId) {
    $$('#settings-sidebar .info-tab').forEach(t => {
        t.classList.remove('active');
        if (t.dataset.section === sectionId) {
            t.classList.add('active');
        }
    });

    $$('#view-settings .info-section').forEach(s => s.classList.remove('active'));
    const section = $(`#settings-${sectionId}`);
    if (section) section.classList.add('active');
}
window.showSettingsSection = showSettingsSection;

// Bind event listeners to settings tabs
$$('#settings-sidebar .info-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const sectionId = tab.dataset.section;
        if (sectionId) {
            showSettingsSection(sectionId);
        }
    });
});

function syncMultiplierInputs() {
    // Angle
    $('#m-angle-slab').value = customMultipliers.angle.slab;
    $('#m-angle-vertical').value = customMultipliers.angle.vertical;
    $('#m-angle-20').value = customMultipliers.angle['20deg'];
    $('#m-angle-30').value = customMultipliers.angle['30deg'];
    $('#m-angle-40').value = customMultipliers.angle['40deg'];
    $('#m-angle-50').value = customMultipliers.angle['50deg'];

    // RPE
    $('#m-rpe-5').value = customMultipliers.rpe[5];
    $('#m-rpe-6').value = customMultipliers.rpe[6];
    $('#m-rpe-7').value = customMultipliers.rpe[7];
    $('#m-rpe-8').value = customMultipliers.rpe[8];
    $('#m-rpe-9').value = customMultipliers.rpe[9];

    // Hold
    $('#m-hold-jugs').value = customMultipliers.hold.jugs;
    $('#m-hold-slopers').value = customMultipliers.hold.slopers;
    $('#m-hold-edges').value = customMultipliers.hold.edges;
    $('#m-hold-small').value = customMultipliers.hold.small;
    $('#m-hold-pockets').value = customMultipliers.hold.pockets;
}

function applyCustomMultipliers() {
    // Update Log View Pill Buttons
    const updates = [
        { id: 'pill-slab', val: customMultipliers.angle.slab },
        { id: 'pill-vertical', val: customMultipliers.angle.vertical },
        { id: 'pill-20deg', val: customMultipliers.angle['20deg'] },
        { id: 'pill-30deg', val: customMultipliers.angle['30deg'] },
        { id: 'pill-40deg', val: customMultipliers.angle['40deg'] },
        { id: 'pill-50deg', val: customMultipliers.angle['50deg'] },

        { id: 'pill-rpe5', val: customMultipliers.rpe[5] },
        { id: 'pill-rpe6', val: customMultipliers.rpe[6] },
        { id: 'pill-rpe7', val: customMultipliers.rpe[7] },
        { id: 'pill-rpe8', val: customMultipliers.rpe[8] },
        { id: 'pill-rpe9', val: customMultipliers.rpe[9] },

        { id: 'pill-jugs', val: customMultipliers.hold.jugs },
        { id: 'pill-slopers', val: customMultipliers.hold.slopers },
        { id: 'pill-edges', val: customMultipliers.hold.edges },
        { id: 'pill-small-edges', val: customMultipliers.hold.small },
        { id: 'pill-pockets', val: customMultipliers.hold.pockets }
    ];

    updates.forEach(upd => {
        const btn = $(`#${upd.id}`);
        if (btn) {
            btn.dataset.value = upd.val;
            const sub = btn.querySelector('.pill-sub');
            if (sub) sub.textContent = (sub.textContent.includes('×') ? sub.textContent.split('×')[0] + '×' : '×') + upd.val;
        }
    });

    updatePreview();
}

function syncWidgetToggles() {
    $('#w-show-weekly').checked = widgetVisibility.weekly;
    $('#w-show-polarization').checked = widgetVisibility.polarization;
    $('#w-show-pyramids').checked = widgetVisibility.pyramids;
    $('#w-show-modifiers').checked = widgetVisibility.modifiers;
    $('#w-show-velocity').checked = widgetVisibility.velocity;
    $('#w-show-intensity').checked = widgetVisibility.intensity;
    $('#w-show-correlator').checked = widgetVisibility.correlator;
}

window.updateWidgetVisibility = function (key, isVisible) {
    widgetVisibility[key] = isVisible;
    updatePreference('widgetVisibility', widgetVisibility);
    applyWidgetVisibility();
};

function applyWidgetVisibility() {
    const map = {
        weekly: '#chart-weekly',
        polarization: '#card-intensity-histogram',
        pyramids: '#card-pyramids',
        modifiers: '#chart-modifiers',
        velocity: '#card-velocity',
        intensity: '#card-intensity-move',
        correlator: '#card-correlator'
    };

    Object.keys(map).forEach(key => {
        const el = $(map[key]);
        if (el) el.style.display = widgetVisibility[key] ? 'block' : 'none';
    });
}

function applyAccentColor(theme) {
    themeColor = theme;
    const root = document.documentElement;
    const themes = {
        orange: { main: '#f97316', hover: '#ea580c', bg: 'rgba(249, 115, 22, 0.1)' },
        blue: { main: '#3b82f6', hover: '#2563eb', bg: 'rgba(59, 130, 246, 0.1)' },
        green: { main: '#22c55e', hover: '#16a34a', bg: 'rgba(34, 197, 94, 0.1)' },
        purple: { main: '#a855f7', hover: '#9333ea', bg: 'rgba(168, 85, 247, 0.1)' },
        pink: { main: '#ec4899', hover: '#db2777', bg: 'rgba(236, 72, 153, 0.1)' }
    };

    const colors = themes[theme] || themes.orange;
    root.style.setProperty('--orange-400', colors.main);
    root.style.setProperty('--orange-500', colors.main);
    root.style.setProperty('--orange-600', colors.hover);

    // Update active state on color buttons
    $$('.color-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.theme === theme);
    });
}

window.resetSettingsTab = function (tabId) {
    if (!confirm(`Reset all ${tabId} settings to defaults?`)) return;

    if (tabId === 'general') {
        chronicWindowDays = 28;
        restTimerDefaults = { rpe7: 3, rpe8: 5, rpe9: 8 };
        defaultLogPreset = 'boulder';
        updatePreference('chronicWindowDays', 28);
        updatePreference('restTimerDefaults', restTimerDefaults);
        updatePreference('defaultLogPreset', 'boulder');
    } else if (tabId === 'multipliers') {
        customMultipliers = {
            angle: { slab: 0.8, vertical: 1.0, '20deg': 1.2, '30deg': 1.4, '40deg': 1.6, '50deg': 1.8 },
            rpe: { 5: 0.8, 6: 1.0, 7: 1.2, 8: 1.4, 9: 1.6 },
            hold: { jugs: 0.8, slopers: 1.0, edges: 1.2, small: 1.4, pockets: 1.6 }
        };
        neuroDampener = 1.0; metaDampener = 1.0; structDampener = 1.0;
        updatePreference('customMultipliers', customMultipliers);
        updatePreference('neuroDampener', 1.0);
        updatePreference('metaDampener', 1.0);
        updatePreference('structDampener', 1.0);
    } else if (tabId === 'widgets') {
        widgetVisibility = {
            weekly: true, polarization: true, pyramids: true, modifiers: true,
            velocity: true, intensity: true, correlator: true
        };
        updatePreference('widgetVisibility', widgetVisibility);
    } else if (tabId === 'appearance') {
        themeColor = 'orange';
        updatePreference('themeColor', 'orange');
    } else if (tabId === 'analytics') {
        fatigueTuning = {
            meta: { partition: 0.9, fastHL: 6, slowHL: 48 },
            neuro: { partition: 0.7, fastHL: 24, slowHL: 192 },
            struct: { partition: 0.5, fastHL: 36, slowHL: 336 }
        };
        updatePreference('fatigueTuning', fatigueTuning);
    } else if (tabId === 'engine') {
        engineConfig = {
            dynamicHalfLives: true, fatigueTax: true, metaFastScaling: true,
            neuroStructLink: true, chronicCompensation: true,
            hlMultRPE8: 1.2, hlMultRPE9: 1.5, taxThreshold50: 1.15, taxThreshold30: 1.30, chronicAbsorption: 0.20,
            metaFastThreshold: 15, metaFastMultiplier: 1.2, neuroStructThreshold: 40, neuroStructMultiplier: 1.2
        };
        updatePreference('engineConfig', engineConfig);
    }

    // Force immediate UI update
    syncMultiplierInputs();
    applyCustomMultipliers();
    syncWidgetToggles();
    applyWidgetVisibility();
    applyAccentColor(themeColor);

    // Fatigue Tuning UI sync
    ['meta', 'neuro', 'struct'].forEach(ch => {
        const part = document.getElementById(`tuning-${ch}-partition`);
        const fast = document.getElementById(`tuning-${ch}-fastHL`);
        const slow = document.getElementById(`tuning-${ch}-slowHL`);
        if (part) part.value = fatigueTuning[ch].partition * 100;
        if (fast) fast.value = fatigueTuning[ch].fastHL;
        if (slow) slow.value = fatigueTuning[ch].slowHL;
    });

    // Force documented days update
    const infoDays = document.getElementById('info-chronic-days');
    if (infoDays) infoDays.textContent = chronicWindowDays;
};

// Event Listeners for Multipliers
const multInputs = [
    { id: 'm-angle-slab', cat: 'angle', key: 'slab' },
    { id: 'm-angle-vertical', cat: 'angle', key: 'vertical' },
    { id: 'm-angle-20', cat: 'angle', key: '20deg' },
    { id: 'm-angle-30', cat: 'angle', key: '30deg' },
    { id: 'm-angle-40', cat: 'angle', key: '40deg' },
    { id: 'm-angle-50', cat: 'angle', key: '50deg' },
    { id: 'm-rpe-5', cat: 'rpe', key: 5 },
    { id: 'm-rpe-6', cat: 'rpe', key: 6 },
    { id: 'm-rpe-7', cat: 'rpe', key: 7 },
    { id: 'm-rpe-8', cat: 'rpe', key: 8 },
    { id: 'm-rpe-9', cat: 'rpe', key: 9 },
    { id: 'm-hold-jugs', cat: 'hold', key: 'jugs' },
    { id: 'm-hold-slopers', cat: 'hold', key: 'slopers' },
    { id: 'm-hold-edges', cat: 'hold', key: 'edges' },
    { id: 'm-hold-small', cat: 'hold', key: 'small' },
    { id: 'm-hold-pockets', cat: 'hold', key: 'pockets' }
];

multInputs.forEach(m => {
    $(`#${m.id}`).addEventListener('change', (e) => {
        const val = parseFloat(e.target.value) || 1.0;
        customMultipliers[m.cat][m.key] = val;
        updatePreference('customMultipliers', customMultipliers);
        applyCustomMultipliers();
    });
});

// Fatigue Tuning inputs
['meta', 'neuro', 'struct'].forEach(ch => {
    $(`#tuning-${ch}-partition`).addEventListener('change', (e) => {
        fatigueTuning[ch].partition = (parseInt(e.target.value) || 0) / 100;
        updatePreference('fatigueTuning', fatigueTuning);
        refreshDashboard();
    });
    $(`#tuning-${ch}-fastHL`).addEventListener('change', (e) => {
        fatigueTuning[ch].fastHL = parseInt(e.target.value) || 1;
        updatePreference('fatigueTuning', fatigueTuning);
        refreshDashboard();
    });
    $(`#tuning-${ch}-slowHL`).addEventListener('change', (e) => {
        fatigueTuning[ch].slowHL = parseInt(e.target.value) || 1;
        updatePreference('fatigueTuning', fatigueTuning);
        refreshDashboard();
    });
});

// Theme Colors
$('#theme-color-presets').addEventListener('click', (e) => {
    const btn = e.target.closest('.color-btn');
    if (btn) {
        const theme = btn.dataset.theme;
        updatePreference('themeColor', theme);
        applyAccentColor(theme);
    }
});

// Default Preset
$('#setting-default-preset').addEventListener('change', (e) => {
    updatePreference('defaultLogPreset', e.target.value);
});

// Engine Config Listeners
window.syncEngineUI = function () {
    const hlEnabled = $('#eng-toggle-hl') ? $('#eng-toggle-hl').checked : true;
    const taxEnabled = $('#eng-toggle-tax') ? $('#eng-toggle-tax').checked : true;

    $$('.eng-hl-group').forEach(el => el.style.opacity = hlEnabled ? '1' : '0.4');
    $$('.eng-tax-group').forEach(el => el.style.opacity = taxEnabled ? '1' : '0.4');

    $$('.eng-hl-group input').forEach(el => el.disabled = !hlEnabled);
    $$('.eng-tax-group input').forEach(el => el.disabled = !taxEnabled);
};

const engToggles = ['eng-toggle-hl', 'eng-toggle-tax', 'eng-meta-fast', 'eng-neuro-struct', 'eng-chronic-comp'];
engToggles.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
        el.addEventListener('change', (e) => {
            const key = {
                'eng-toggle-hl': 'dynamicHalfLives',
                'eng-toggle-tax': 'fatigueTax',
                'eng-meta-fast': 'metaFastScaling',
                'eng-neuro-struct': 'neuroStructLink',
                'eng-chronic-comp': 'chronicCompensation'
            }[id];
            engineConfig[key] = e.target.checked;
            updatePreference('engineConfig', engineConfig);
            if (id === 'eng-toggle-hl' || id === 'eng-toggle-tax') syncEngineUI();
            refreshDashboard();
        });
    }
});

const engInputs = [
    { id: 'eng-hl-8', key: 'hlMultRPE8', isPct: false },
    { id: 'eng-hl-9', key: 'hlMultRPE9', isPct: false },
    { id: 'eng-tax-50', key: 'taxThreshold50', isPct: false },
    { id: 'eng-tax-30', key: 'taxThreshold30', isPct: false },
    { id: 'eng-absorb', key: 'chronicAbsorption', isPct: true },
    { id: 'eng-meta-fast-thresh', key: 'metaFastThreshold', isPct: false },
    { id: 'eng-meta-fast-mult', key: 'metaFastMultiplier', isPct: false },
    { id: 'eng-ns-thresh', key: 'neuroStructThreshold', isPct: false },
    { id: 'eng-ns-mult', key: 'neuroStructMultiplier', isPct: false }
];
engInputs.forEach(input => {
    const el = document.getElementById(input.id);
    if (el) {
        el.addEventListener('change', (e) => {
            let val = parseFloat(e.target.value) || 0;
            if (input.isPct) val = val / 100;
            engineConfig[input.key] = val;
            updatePreference('engineConfig', engineConfig);
            refreshDashboard();
        });
    }
});
