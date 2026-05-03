import re

with open('app.js', 'r', encoding='utf-8', errors='ignore') as f:
    content = f.read()

# Fix History bars
old_history = '''        const climbsHtml = s.climbs.map((c, ci) => {
            const anglePart = c.type === 'fingerboard' ? '' : `<span class="climb-row-detail-tag">${ANGLE_LABELS[String(c.angle)] || c.angle}</span>`;
            const cChBar = renderChannelMini(c.neuro || 0, c.metabolic || 0, c.structural || 0);'''

new_history = '''        const climbsHtml = s.climbs.map((c, ci) => {
            const anglePart = c.type === 'fingerboard' ? '' : `<span class="climb-row-detail-tag">${ANGLE_LABELS[String(c.angle)] || c.angle}</span>`;
            let n = c.neuro || 0, m = c.metabolic || 0, st = c.structural || 0;
            if (n === 0 && m === 0 && st === 0) {
                const ch = calculateChannels(c.type, c.moves, c.angle || 1, c.rpe || 1, c.power || 1, c.hold || 1);
                n = ch.neuro; m = ch.metabolic; st = ch.structural;
            }
            const cChBar = renderChannelMini(n, m, st);'''
content = content.replace(old_history, new_history)

# Fix Notes emoji
content = re.sub(r'title="\$\{escapeHtml\(c\.notes\)\}">.*?</span>', 'title="${escapeHtml(c.notes)}">📝</span>', content)

# Fix Location emoji
content = re.sub(r'<span class="history-location">.*? \$\{escapeHtml\(s\.location\)\}</span>', '<span class="history-location">📍 ${escapeHtml(s.location)}</span>', content)

with open('app.js', 'w', encoding='utf-8') as f:
    f.write(content)
