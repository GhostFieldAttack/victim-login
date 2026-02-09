/*
  load_technique.js
  --------------------------------------
  Load technique from techniques.json and inject data-tech/technique into the UI container
*/
(function () {
    const JSON_PATH = '../assets/data/techniques.json';

    function normalizePath(path) {
        // Remove leading slash and potential query params
        return path.replace(/^\//, '').split('?')[0];
    }

    async function loadTechnique() {
        try {
            const response = await fetch(JSON_PATH);
            if (!response.ok) {
                console.error('[Loader] Failed to fetch techniques.json:', response.status);
                return;
            }
            const techniques = await response.json();
            const currentPath = window.location.pathname;

            // Find matching entry
            // Check if the current pathname ends with the entry's page_path
            // This handles difference in absolute paths (e.g. /victim-login/cases/... vs /cases/...)
            const entry = techniques.find(t => currentPath.endsWith(t.page_path));

            if (entry) {
                // console.log('[Loader] Found technique config:', entry);

                // 1. Set global case_id for exfiltrate.js
                window.CASE_ID = entry.case_id;

                // 2. Inject data-tech/technique into the UI container
                // exfiltrate.js looks for data-tech on parents like .card or .glass-card
                const container = document.querySelector('.glass-card') || document.body;
                if (container) {
                    container.setAttribute('data-tech', entry.technique);
                }

                // Optional: You can also inject specific hidden inputs if the technique requires it dynamically
                // but for now we just handle meta-data.
            } else {
                console.warn('[Loader] No matching technique found for path:', currentPath);
            }

        } catch (e) {
            console.error('[Loader] Error loading technique:', e);
        }
    }

    // Run immediately
    loadTechnique();
})();
