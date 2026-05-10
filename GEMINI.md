# SendLoad — Climbing Load Tracker

SendLoad is a Progressive Web Application (PWA) designed to track climbing sessions and calculate training load using the **C4HP Climbing Index**. It focuses on mapping "channels" of stress (Neuro, Metabolic, Structural) to help climbers optimize their training and recovery.

## Project Overview

- **Core Functionality:** Log climbing sessions, calculate session load (CLU), track Chronic Load, manage Deload weeks, and visualize performance analytics.
- **Key Concepts:**
    - **CLU (Climbing Load Unit):** A proprietary metric derived from moves, wall angle, RPE, power style, and hold type.
    - **Channels:** Breakdown of load into Neuromuscular, Metabolic, and Structural stress.
    - **ACWR (Acute:Chronic Workload Ratio):** Used to monitor training zones (Under-trained, Sweet Spot, Caution, Danger).
    - **C4HP Methodology:** Aligned with training philosophies that prioritize velocity transitions and tissue preparation.

## Technology Stack

- **Frontend:** Vanilla HTML5, CSS3, and JavaScript (ES Modules).
- **Backend/Persistence:** 
    - **Firebase Auth:** Google Sign-in for user accounts.
    - **Firebase Firestore:** Real-time synchronization and offline persistence.
- **Visualization:** Custom Canvas-based charting (no external charting libraries used).
- **PWA:** Service Workers (`sw.js`) and Web App Manifest (`manifest.json`) for offline support and "Add to Home Screen" capability.

## Architecture & Logic

- **SPA Pattern:** The app uses a single `index.html` with multiple `<main>` views (Dashboard, Log, History, Analytics, Settings) toggled via `app.js`.
- **State Management:** Local state in `app.js` (e.g., `allSessions`, `currentUser`) is kept in sync with Firestore via `onSnapshot` listeners.
- **Load Logic:**
    - `calculateLoad()`: Computes the total CLU for a climb.
    - `calculateChannels()`: Computes the specific Neuro/Meta/Struct stress for a climb.
- **Analytics:** The `renderAnalytics()` function processes session history to generate velocity charts, intensity histograms, and performance correlations.

## Key Files

- `index.html`: Main application structure and view templates.
- `app.js`: Main entry point containing application logic, Firebase integration, and chart rendering.
- `index.css`: Comprehensive styling for the application, including custom components and dark mode theme.
- `sw.js`: Service worker for resource caching.
- `manifest.json`: PWA metadata.

## Building and Running

Since this project uses vanilla JS and CDN imports, it does not require a build step.

### Development
1.  Serve the root directory using any static web server:
    ```bash
    # Using python
    python -m http.server 8000
    
    # Using Node.js (if available)
    npx serve .
    ```
2.  Open `http://localhost:8000` in your browser.

### Testing
There is currently no automated test suite. Manual verification is performed by logging sessions and checking the Dashboard/Analytics views.

## Development Conventions

- **Firebase First:** All data should be persisted to Firestore under `users/${uid}/sessions`.
- **Local Time:** Dates are handled in local time using `formatLocalDate` and `parseLocalDate`.
- **Surgical DOM Updates:** Prefers `document.querySelector` (aliased as `$`) for targeted updates.
- **Chart Rendering:** All charts are drawn directly to `<canvas>` elements using the 2D context. When adding or modifying charts, ensure High-DPI support by scaling with `window.devicePixelRatio`.

## Workflow

- **Local Verification:** After making changes, start a local server (e.g., `python -m http.server 8000`) and provide the address to the user.
- **Commit & Push:** Do not commit or push changes until the user has manually tested and verified the feature. Once verified, the user will explicitly instruct to commit and push to the `main` branch.

## Troubleshooting

- **Git/Shell Commands:** On this system (Windows/PowerShell), the `&&` operator for chaining commands may fail. Use `;` instead (e.g., `git status; git diff HEAD; git log -n 3`).
