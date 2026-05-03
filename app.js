/* ========================================
   SendLoad â€” Climbing Load Tracker
   Application Logic (Firebase Sync)
   ======================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { 
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, deleteDoc, onSnapshot
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
  localCache: persistentLocalCache({tabManager: persistentMultipleTabManager()})
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
let weekStripOffset = 0; // 0 = current week, -1 = last week, etc.
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
            allSessions = [];
            snapshot.forEach((doc) => {
                allSessions.push({ id: doc.id, ...doc.data() });
            });
            
            // Sort descending by creation date
            allSessions.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
            refreshDashboard();
            if (document.getElementById('view-history').classList.contains('active')) renderHistory();
        });
        
        // Listen to User Settings
        if (unsubscribeSettings) unsubscribeSettings();
        unsubscribeSettings = onSnapshot(doc(db, `users/${user.uid}/settings`, 'preferences'), (docSnap) => {
            if (docSnap.exists()) {
                deloadWeeks = docSnap.data().deloadWeeks || [];
            } else {
                deloadWeeks = [];
            }
            refreshDashboard();
        });
        
        if (unsubscribeTemplates) unsubscribeTemplates();
        unsubscribeTemplates = onSnapshot(collection(db, `users/${user.uid}/templates`), (snapshot) => {
            userTemplates = [];
            snapshot.forEach((doc) => {
                userTemplates.push({ id: doc.id, ...doc.data() });
            });
            userTemplates.sort((a,b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
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
const ANGLE_LABELS = {
    '0.8': 'Slab', '1': 'Vertical', '1.0': 'Vertical',
    '1.2': '20Â°', '1.4': '30Â°', '1.6': '40Â°', '1.8': '50Â°+'
};
const RPE_LABELS = {
    '0.8': 'RPE 5', '1': 'RPE 6', '1.0': 'RPE 6',
    '1.2': 'RPE 7', '1.4': 'RPE 8', '1.6': 'RPE 9+'
};
const POWER_LABELS = {
    '1': 'Static', '1.0': 'Static',
    '1.2': 'Controlled', '1.4': 'Less-Ctrl', '1.6': 'Hands Only'
};
const HOLD_LABELS = {
    '0.8': 'Jugs', '1': 'Slopers', '1.0': 'Slopers',
    '1.2': '20-25mm', '1.4': '<15mm', '1.6': 'Pockets'
};

function calculateLoad(type, moves, angle, rpe, power, hold) {
    // Fingerboard uses boulder multiplier (Ã—10) but no wall angle
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
    const neuro = baseMoves * effectiveAngle * (rpe * rpe) * Math.sqrt(hold);

    // Metabolic: peaks at moderate RPE (~1.0-1.2), drops at extremes
    const metabolic = baseMoves * rpe * (2.0 - rpe);

    // Structural: tendon/pulley stress from small holds + dynamic movement
    const structural = baseMoves * hold * power;

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
    history: $('#view-history')
};

// ---- Navigation ----
function switchToView(viewName) {
    $$('.nav-tab').forEach(t => t.classList.remove('active'));
    const btn = $(`[data-view="${viewName}"]`);
    if (btn) btn.classList.add('active');

    Object.values(views).forEach(v => v.classList.remove('active'));
    views[viewName].classList.add('active');

    if (viewName === 'dashboard') refreshDashboard();
    if (viewName === 'history') renderHistory();
    if (viewName === 'log' && !editingSessionId) {
        // Reset to new session mode
        $('#log-header-title').textContent = 'Log Climbing Session';
        $('#log-header-subtitle').textContent = 'Add climbs to your session and calculate your total training load.';
        $('#btn-save-label').textContent = 'Save Session';
    }
}

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
    const labelNumMoves = $('#label-num-moves');

    if (type === 'fingerboard') {
        wallAngleWrapper.style.display = 'none';
        gradeWrapper.style.display = 'none';
        if (labelNumMoves) labelNumMoves.textContent = 'Reps / Time Under Tension (s)';
        // Reset angle to 1 internally for fingerboard

        gradeWrapper.style.display = 'none';
        previewAngle.style.display = 'none';
        previewAngleOp.style.display = 'none';
    } else {
        wallAngleWrapper.style.display = 'block';
        gradeWrapper.style.display = 'block';
        if (labelNumMoves) labelNumMoves.textContent = 'Number of Moves';
        previewAngle.style.display = 'inline';
        previewAngleOp.style.display = 'inline';
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

// ---- Stepper ----
const movesInput = $('#num-moves');

$('#moves-minus').addEventListener('click', () => {
    const v = parseInt(movesInput.value) || 1;
    movesInput.value = Math.max(1, v - 1);
    updatePreview();
});

$('#moves-plus').addEventListener('click', () => {
    const v = parseInt(movesInput.value) || 0;
    movesInput.value = v + 1;
    updatePreview();
});

movesInput.addEventListener('input', updatePreview);

// ---- Live Preview ----
function getActivePillValue(groupId) {
    const active = $(`#${groupId} .pill-btn.active`);
    return active ? parseFloat(active.dataset.value) : 1.0;
}

function updatePreview() {
    const moves = parseInt(movesInput.value) || 0;
    const angle = getActivePillValue('wall-angle-group');
    const rpe = getActivePillValue('rpe-group');
    const power = getActivePillValue('power-group');
    const hold = getActivePillValue('hold-group');

    const baseMoves = currentClimbType === 'lead' ? moves * 4 : moves * 10;
    const total = calculateLoad(currentClimbType, moves, angle, rpe, power, hold);

    $('#preview-base').textContent = baseMoves;
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
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    $('#session-date').value = `${yyyy}-${mm}-${dd}`;
}
setDefaultDate();

// ---- Reset Log Form ----
function resetLogForm() {
    $('#session-name').value = '';
    $('#session-location').value = '';
    $('#session-notes').value = '';
    $('#climb-grade').value = '';
    $('#climb-notes').value = '';
    setDefaultDate();

    // Reset toggles to boulder
    climbTypeToggle.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
    $('#toggle-boulder').classList.add('active');
    onClimbTypeChange('boulder');

    // Reset all pill groups to defaults
    resetPillGroup('wall-angle-group', '1.0');
    resetPillGroup('rpe-group', '1.0');
    resetPillGroup('power-group', '1.0');
    resetPillGroup('hold-group', '1.0');

    movesInput.value = 8;
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
    const moves = parseInt(movesInput.value) || 0;
    if (moves <= 0) {
        showToast('Please enter a valid number of moves.');
        return;
    }

    const angle = getActivePillValue('wall-angle-group');
    const rpe = getActivePillValue('rpe-group');
    const power = getActivePillValue('power-group');
    const hold = getActivePillValue('hold-group');
    const grade = currentClimbType === 'fingerboard' ? '' : $('#climb-grade').value.trim();
    const notes = $('#climb-notes').value.trim();

    const load = calculateLoad(currentClimbType, moves, angle, rpe, power, hold);
    const channels = calculateChannels(currentClimbType, moves, angle, rpe, power, hold);

    const climb = {
        type: currentClimbType,
        moves,
        angle: currentClimbType === 'fingerboard' ? 1.0 : angle,
        rpe,
        power,
        hold,
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
    showToast(`Climb added â€” ${load.toFixed(0)} CLU`);
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

    list.innerHTML = currentSessionClimbs.map((c, i) => {
        const anglePart = c.type === 'fingerboard' ? '' : `<span class="climb-row-detail-tag">${ANGLE_LABELS[String(c.angle)] || c.angle}</span>`;
        const notesHtml = c.notes ? `<span class="climb-row-note" title="${escapeHtml(c.notes)}">ðŸ“</span>` : '';
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
            <button class="climb-row-remove" onclick="removeClimb(${i})" title="Remove">âœ•</button>
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
    $('#log-header-subtitle').textContent = `Editing "${session.name}" â€” modify climbs and save when done.`;
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
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1)/7);
    return `${d.getUTCFullYear()}-W${weekNo}`;
}

window.handleDeloadToggle = async (isChecked) => {
    if(!currentUser) return;
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
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1)); // Monday
    weekStart.setHours(0, 0, 0, 0);

    const lastWeekStart = new Date(weekStart);
    lastWeekStart.setDate(lastWeekStart.getDate() - 7);

    const thisWeekSessions = allSessions.filter(s => new Date(s.date) >= weekStart);
    const lastWeekSessions = allSessions.filter(s => {
        const d = new Date(s.date);
        return d >= lastWeekStart && d < weekStart;
    });

    const weeklyLoad = thisWeekSessions.reduce((s, sess) => s + sess.totalLoad, 0);
    const lastWeekLoad = lastWeekSessions.reduce((s, sess) => s + sess.totalLoad, 0);
    const avgLoad = thisWeekSessions.length > 0 ? weeklyLoad / thisWeekSessions.length : 0;

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
    // Chronic: past 28 days
    const past28DaysStart = new Date(now);
    past28DaysStart.setDate(now.getDate() - 28);
    past28DaysStart.setHours(0,0,0,0);
    const last28Sessions = allSessions.filter(s => new Date(s.date) >= past28DaysStart && new Date(s.date) <= now);
    const chronicTotal = last28Sessions.reduce((s, sess) => s + sess.totalLoad, 0);
    const chronicLoadAvg = chronicTotal / 4;

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
        acwrRatio.textContent = 'â€”';
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
        for (let i=0; i<4; i++) {
            const checkD = new Date(now);
            checkD.setDate(now.getDate() - (i*7));
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
        $('#wow-unit').textContent = change >= 0 ? 'â†‘' : 'â†“';
        $('#wow-trend').style.color = change >= 0 ? 'var(--green-400)' : 'var(--red-500)';
    } else {
        $('#wow-trend').textContent = 'â€”';
        $('#wow-unit').textContent = '';
        $('#wow-trend').style.color = '';
    }

    // Recent sessions
    renderRecentSessions();
    renderWeekStrip();

    // Charts & Pyramids
    drawWeeklyChart();
    drawModifiersChart();
    renderGradePyramids();
}

// ---- Weekly Calendar Strip ----
function renderWeekStrip() {
    const container = $('#week-strip-days');
    const header = $('#week-strip');
    if (!container || !header) return;

    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    // Get Monday of the target week (offset from current)
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1) + (weekStripOffset * 7));
    weekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);

    // Update header with date range and nav arrows
    const headerEl = header.querySelector('.week-strip-header h3');
    if (headerEl) {
        const fmt = (d) => `${d.getDate()}/${d.getMonth() + 1}`;
        const label = weekStripOffset === 0 ? 'This Week' : `${fmt(weekStart)} - ${fmt(weekEnd)}`;
        const fwdBtn = weekStripOffset < 0 ? `<button class="ws-nav-btn" onclick="weekStripNav(1)">&#9654;</button>` : '';
        const todayBtn = weekStripOffset !== 0 ? ` <button class="ws-today-btn" onclick="weekStripOffset=0;renderWeekStrip();">Today</button>` : '';
        headerEl.innerHTML = `<button class="ws-nav-btn" onclick="weekStripNav(-1)">&#9664;</button> <span>${label}</span> ${fwdBtn}${todayBtn}`;
    }

    const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const days = [];

    for (let i = 0; i < 7; i++) {
        const dayDate = new Date(weekStart);
        dayDate.setDate(weekStart.getDate() + i);
        const dateStr = dayDate.toISOString().split('T')[0];

        const daySessions = allSessions.filter(s => s.date === dateStr);
        let neuro = 0, meta = 0, struct = 0, total = 0;
        daySessions.forEach(sess => {
            const ch = getSessionChannels(sess);
            neuro += ch.neuro;
            meta += ch.metabolic;
            struct += ch.structural;
            total += sess.totalLoad;
        });

        days.push({ label: dayLabels[i], dateStr, isToday: dateStr === todayStr, neuro, meta, struct, total, sessionCount: daySessions.length });
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
    past30Start.setHours(0,0,0,0);

    const recentSessions = allSessions.filter(s => new Date(s.date) >= past30Start);
    
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
            const d = new Date(s.date);
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
        weeks.push({ label, neuro: neuroLoad, metabolic: metaLoad, structural: structLoad, total: neuroLoad + metaLoad + structLoad });
    }

    const maxVal = Math.max(100, ...weeks.map(w => w.total));
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

        const val = Math.round(maxVal * (1 - i / 4));
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.font = '11px Inter';
        ctx.textAlign = 'right';
        ctx.fillText(val, padLeft - 8, y + 4);
    }

    const barGroupW = chartW / weeks.length;
    const barW = Math.min(barGroupW * 0.22, 20);
    const gap = 2;

    weeks.forEach((w, i) => {
        const x = padLeft + barGroupW * i + barGroupW / 2;

        // Neuromuscular bar (orange-red)
        const nH = (w.neuro / maxVal) * chartH;
        const nX = x - barW * 1.5 - gap;
        const nY = padTop + chartH - nH;
        const nGrad = ctx.createLinearGradient(0, nY, 0, nY + nH);
        nGrad.addColorStop(0, '#fb923c');
        nGrad.addColorStop(1, '#ef4444');
        roundedRect(ctx, nX, nY, barW, nH, 3);
        ctx.fillStyle = nGrad;
        ctx.fill();

        // Metabolic bar (blue)
        const mH = (w.metabolic / maxVal) * chartH;
        const mX = x - barW / 2;
        const mY = padTop + chartH - mH;
        const mGrad = ctx.createLinearGradient(0, mY, 0, mY + mH);
        mGrad.addColorStop(0, '#60a5fa');
        mGrad.addColorStop(1, '#3b82f6');
        roundedRect(ctx, mX, mY, barW, mH, 3);
        ctx.fillStyle = mGrad;
        ctx.fill();

        // Structural bar (green)
        const sH = (w.structural / maxVal) * chartH;
        const sX = x + barW / 2 + gap;
        const sY = padTop + chartH - sH;
        const sGrad = ctx.createLinearGradient(0, sY, 0, sY + sH);
        sGrad.addColorStop(0, '#4ade80');
        sGrad.addColorStop(1, '#22c55e');
        roundedRect(ctx, sX, sY, barW, sH, 3);
        ctx.fillStyle = sGrad;
        ctx.fill();

        // X label
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.font = '11px Inter';
        ctx.textAlign = 'center';
        ctx.fillText(w.label, x, H - padBottom + 20);
    });
}

// ---- Average Modifiers Chart ----
function drawModifiersChart() {
    const canvas = $('#canvas-modifiers');
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
    const padLeft = 60;
    const padRight = 30;
    const padTop = 20;
    const padBottom = 50;

    ctx.clearRect(0, 0, W, H);

    // Get last 8 weeks of data â€” compute average modifiers per week
    const weeks = [];
    const now = new Date();
    for (let i = 7; i >= 0; i--) {
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1) - (i * 7));
        weekStart.setHours(0, 0, 0, 0);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 7);

        const sessionsInWeek = allSessions.filter(s => {
            const d = new Date(s.date);
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

    // Y-axis range: 0.6 to 2.0
    const yMin = 0.6;
    const yMax = 2.0;
    const yRange = yMax - yMin;

    function yPos(val) {
        return padTop + chartH * (1 - (val - yMin) / yRange);
    }

    // Grid lines and Y labels
    const yTicks = [0.8, 1.0, 1.2, 1.4, 1.6, 1.8];
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

    // Reference line at 1.0
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padLeft, yPos(1.0));
    ctx.lineTo(W - padRight, yPos(1.0));
    ctx.stroke();
    ctx.setLineDash([]);

    // X labels
    const stepW = chartW / (weeks.length - 1 || 1);
    weeks.forEach((w, i) => {
        const x = padLeft + stepW * i;
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.font = '11px Inter';
        ctx.textAlign = 'center';
        ctx.fillText(w.label, x, H - padBottom + 20);
    });

    // Draw lines
    const series = [
        { key: 'angle', color: '#f97316', label: 'Wall Angle' },
        { key: 'rpe', color: '#3b82f6', label: 'RPE' },
        { key: 'power', color: '#22c55e', label: 'Power' },
        { key: 'hold', color: '#8b5cf6', label: 'Hold' }
    ];

    series.forEach(s => {
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

        // Line
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2.5;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        points.forEach((p, pi) => {
            if (pi === 0) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
        });
        ctx.stroke();

        // Gradient area
        ctx.fillStyle = s.color;
        ctx.globalAlpha = 0.06;
        ctx.beginPath();
        points.forEach((p, pi) => {
            if (pi === 0) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
        });
        ctx.lineTo(points[points.length - 1].x, yPos(yMin));
        ctx.lineTo(points[0].x, yPos(yMin));
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;

        // Dots
        points.forEach(p => {
            ctx.fillStyle = s.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
            ctx.fill();

            // White inner
            ctx.fillStyle = '#16161f';
            ctx.beginPath();
            ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
            ctx.fill();
        });
    });
}

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
            const cChBar = renderChannelMini(c.neuro || 0, c.metabolic || 0, c.structural || 0);
            const notesHtml = c.notes ? `<span class="climb-row-note" title="${escapeHtml(c.notes)}">ðŸ“</span>` : '';
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
                    ${s.location ? `<span class="history-location">ðŸ“ ${escapeHtml(s.location)}</span>` : ''}
                    <div class="history-stats">
                        <div class="history-stat">
                            <div class="history-stat-val">${s.climbs.length}</div>
                            <div class="history-stat-label">Climbs</div>
                        </div>
                        <div class="history-stat">
                            <div class="history-stat-val load">${s.totalLoad.toFixed(0)}</div>
                            <div class="history-stat-label">CLU</div>
                        </div>
                    </div>
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
    } catch(e) {
        console.error(e);
        showToast('Offline: Delete pending.');
    }
}

// ---- Export CSV ----
$('#btn-export').addEventListener('click', () => {
    if (allSessions.length === 0) {
        showToast('No data to export.');
        return;
    }

    let csv = 'Date,Session Name,Location,Session Notes,Climb #,Type,Moves,Wall Angle,RPE,Power,Hold Type,Grade,Climb Notes,Load (CLU),Session Total (CLU)\n';

    allSessions.forEach(s => {
        s.climbs.forEach((c, i) => {
            csv += [
                s.date,
                `"${s.name}"`,
                `"${s.location || ''}"`,
                `"${(s.notes || '').replace(/"/g, '""')}"`,
                i + 1,
                c.type,
                c.moves,
                c.type === 'fingerboard' ? 'N/A' : (ANGLE_LABELS[String(c.angle)] || c.angle),
                RPE_LABELS[String(c.rpe)] || c.rpe,
                POWER_LABELS[String(c.power)] || c.power,
                HOLD_LABELS[String(c.hold)] || c.hold,
                `"${c.grade || ''}"`,
                `"${(c.notes || '').replace(/"/g, '""')}"`,
                c.load.toFixed(1),
                s.totalLoad.toFixed(1)
            ].join(',') + '\n';
        });
    });

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sendload_export_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('CSV exported!');
});

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
            if (!nameInput.value) nameInput.value = 'Power Session';
            applyTemplateToForm('boulder', 6, '1.6', '1.6', '1.2', '1.0');
        } else if (preset === 'endurance') {
            if (!nameInput.value) nameInput.value = 'Endurance Session';
            applyTemplateToForm('lead', 35, '1.0', '1.2', '1.0', '0.8');
        } else if (preset === 'fingerboard') {
            if (!nameInput.value) nameInput.value = 'Fingerboard Routine';
            applyTemplateToForm('fingerboard', 10, '1.0', '1.4', '1.0', '1.5');
        }
    }
});

// ---- Custom Templates Logic ----
function applyTemplateToForm(type, moves, angle, rpe, power, hold) {
    // Discipline
    $$('#climb-type-toggle .toggle-btn').forEach(btn => btn.classList.remove('active'));
    const typeBtn = $(`#toggle-${type}`);
    if (typeBtn) typeBtn.classList.add('active');
    onClimbTypeChange(type); // Triggers label changes

    // Moves
    $('#num-moves').value = moves;

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
    $$('#power-group .pill-btn').forEach(btn => btn.classList.remove('active'));
    const pBtn = $(`#power-group .pill-btn[data-value="${power}"]`);
    if (pBtn) pBtn.classList.add('active');

    // Hold
    $$('#hold-group .pill-btn').forEach(btn => btn.classList.remove('active'));
    const hBtn = $(`#hold-group .pill-btn[data-value="${hold}"]`);
    if (hBtn) hBtn.classList.add('active');
    
    updatePreview();
}

$('#btn-save-template').addEventListener('click', async () => {
    const name = prompt('Name this template (e.g., C4HP Pulls):');
    if (!name || !name.trim()) return;

    // Read current form state
    const type = $('#climb-type-toggle .active').dataset.value;
    const moves = parseInt($('#num-moves').value) || 8;
    
    let angle = "1.0";
    if (type !== 'fingerboard') {
        const activeAngle = $('#wall-angle-group .active');
        if (activeAngle) angle = activeAngle.dataset.value;
    }
    
    const rpe = $('#rpe-group .active').dataset.value;
    const power = $('#power-group .active').dataset.value;
    const hold = $('#hold-group .active').dataset.value;

    const template = {
        name: name.trim(),
        type, moves, angle, rpe, power, hold,
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
    applyTemplateToForm(t.type, t.moves, t.angle, t.rpe, t.power, t.hold);
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
