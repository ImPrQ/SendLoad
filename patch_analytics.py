import re

with open('app.js', 'r', encoding='utf-8') as f:
    data = f.read()

analytics_code = """
// ==========================================
// PHASE 5: ADVANCED ANALYTICS (C4HP)
// ==========================================

function parseFontGrade(str) {
    if (!str) return 0;
    const s = str.trim().toLowerCase();
    
    // Font scale: 6a=1, 6a+=2, 6b=3, 6b+=4, 6c=5, 6c+=6, 7a=7...
    const match = s.match(/^([4-9])([a-c])(\\+)?$/);
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

window.renderAnalytics = function() {
    const tfSelect = document.getElementById('analytics-timeframe');
    if (!tfSelect) return;
    const timeframeDays = parseInt(tfSelect.value) || 90;
    
    const now = new Date();
    const startDate = new Date(now);
    startDate.setDate(now.getDate() - timeframeDays);
    startDate.setHours(0,0,0,0);
    
    const sessions = allSessions
        .filter(s => new Date(s.date) >= startDate)
        .sort((a,b) => new Date(a.date) - new Date(b.date));
        
    drawVelocityChart(sessions, timeframeDays);
    drawIntensityChart(sessions, timeframeDays);
    drawCorrelatorChart(sessions, timeframeDays);
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
        ctx.fillText('Not enough data to graph velocity phases.', W/2, H/2);
        return;
    }

    // Group by week
    const numBuckets = Math.max(2, Math.ceil(days / 7));
    const buckets = Array.from({length: numBuckets}, () => ({ lowVel: 0, highVel: 0, date: null }));
    
    const now = new Date();
    sessions.forEach(sess => {
        const d = new Date(sess.date);
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
        if (i===0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Plot High Velocity (Power Phase)
    ctx.beginPath();
    ctx.strokeStyle = '#f97316'; // Orange
    ctx.lineWidth = 3;
    buckets.forEach((b, i) => {
        const x = padL + i * xStep;
        const y = H - padB - (b.highVel / maxVal) * (H - padT - padB);
        if (i===0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
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
        return { date: new Date(s.date), intensity: i };
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
        ctx.arc(px, py, 3, 0, 2*Math.PI);
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
        return { date: new Date(s.date), score: m };
    }).filter(p => p.score > 0);

    if (pts.length === 0 || maxScore === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.font = '14px Inter';
        ctx.textAlign = 'center';
        ctx.fillText('Log Font grades (e.g. 6c, 7a+) to see correlation.', W/2, H/2);
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
        ctx.beginPath(); ctx.arc(px, py, 4, 0, 2*Math.PI); ctx.fill();
        
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
    
    sessions.filter(s => new Date(s.date) >= fourteenAgo).forEach(s => {
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
        insight += " Warning: High metabolic load detected. Heavy pump/acidosis will blunt your neuromuscular power gains. Reduce pump if your goal is max bouldering strength.";
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
        insight += ` You sent your hardest grade (${getFontGradeLabel(maxScore)}) on ${new Date(bestSession.date).toLocaleDateString()}. `;
    }
    
    textEl.textContent = insight;
}
"""

if "PHASE 5" not in data:
    data = data + "\n" + analytics_code

with open('app.js', 'w', encoding='utf-8') as f:
    f.write(data)
