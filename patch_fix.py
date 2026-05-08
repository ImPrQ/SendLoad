with open('app.js', 'r', encoding='utf-8') as f:
    data = f.read()

# 1. Fix updatePreview to account for warmup toggle
old_preview = """function updatePreview() {
    const moves = getEffectiveMoves();
    const angle = getActivePillValue('wall-angle-group');
    const rpe = getActivePillValue('rpe-group');
    const power = getEffectivePower();
    const hold = getActivePillValue('hold-group');

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
}"""

new_preview = """function updatePreview() {
    const moves = getEffectiveMoves();
    const angle = getActivePillValue('wall-angle-group');
    let rpe = getActivePillValue('rpe-group');
    const power = getEffectivePower();
    const hold = getActivePillValue('hold-group');

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
}"""

data = data.replace(old_preview, new_preview)

# 2. Add warmup toggle change listener (after setDefaultDate)
old_setdate = """setDefaultDate();

// ---- Reset Log Form ----"""
new_setdate = """setDefaultDate();

// Wire warmup toggle to live preview
const warmupToggleEl = $('#warmup-toggle');
if (warmupToggleEl) warmupToggleEl.addEventListener('change', updatePreview);

// ---- Reset Log Form ----"""

data = data.replace(old_setdate, new_setdate)

# 3. Replace CSV export with JSON export
old_export = """// ---- Export CSV ----
$('#btn-export').addEventListener('click', () => {
    if (allSessions.length === 0) {
        showToast('No data to export.');
        return;
    }

    let csv = 'Date,Session Name,Location,Session Notes,Climb #,Type,Moves,Wall Angle,RPE,Power,Hold Type,Grade,Climb Notes,Load (CLU),Session Total (CLU)\\n';

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
            ].join(',') + '\\n';
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
});"""

new_export = """// ---- Export JSON ----
$('#btn-export').addEventListener('click', () => {
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
        totalNeuro: s.totalNeuro || 0,
        totalMetabolic: s.totalMetabolic || 0,
        totalStructural: s.totalStructural || 0,
        createdAt: s.createdAt
    }));

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sendload_export_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('JSON exported!');
});"""

data = data.replace(old_export, new_export)

with open('app.js', 'w', encoding='utf-8') as f:
    f.write(data)

print("Patched successfully!")
