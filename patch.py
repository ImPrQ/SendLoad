with open('app.js', 'r', encoding='utf-8') as f:
    data = f.read()

target = """    log: $('#view-log'),
    history: $('#view-history')
};"""
replacement = """    log: $('#view-log'),
    history: $('#view-history'),
    analytics: $('#view-analytics')
};"""

data = data.replace(target, replacement)

# Add renderAnalytics call to switchToView
target_view = """    if (viewName === 'dashboard') refreshDashboard();"""
replace_view = """    if (viewName === 'dashboard') refreshDashboard();
    if (viewName === 'analytics') renderAnalytics();"""

data = data.replace(target_view, replace_view)

with open('app.js', 'w', encoding='utf-8') as f:
    f.write(data)
