with open('app.js', 'r', encoding='utf-8') as f:
    data = f.read()

import_code = """
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
                createdAt: sess.createdAt || new Date(sess.date).toISOString()
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
"""

if "IMPORT DATA" not in data:
    data = data + "\n" + import_code

with open('app.js', 'w', encoding='utf-8') as f:
    f.write(data)
