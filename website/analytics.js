// Send a named GA4 event for every link/button click, so each one shows up
// in Analytics by its label (e.g. "Download for macOS") rather than only as a
// generic outbound click. Runs on the capture phase so the event is queued
// before any navigation; gtag uses sendBeacon, which survives the page change.
(function () {
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href], button[data-download]');
    if (!a || typeof window.gtag !== 'function') return;

    var href = a.getAttribute('href') || '';
    if (href.charAt(0) === '#') return; // in-page anchor / table-of-contents link

    var label = (a.textContent || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    var url = a.href || href;
    var outbound = false;
    try { outbound = new URL(url, location.href).host !== location.host; } catch (err) {}

    gtag('event', 'link_click', {
      link_text: label || '(no text)',
      link_url: url,
      outbound: outbound,
      page_path: location.pathname
    });
  }, true);
})();

// Section-level dwell tracking for long doc-style pages (setup.html's
// Part/Step headings, etc.): reports how long each h2/h3 section stayed the
// "active" one, so we can see which part of a guide people actually spend
// time in, not just total time on the page. No-op on pages without such
// headings. "Active" = whichever heading is crossing the vertical center of
// the viewport, via a -50%/-50% rootMargin - a standard scroll-spy trick
// that avoids comparing intersection ratios across multiple observed
// elements by hand.
(function () {
  if (typeof window.gtag !== 'function' || !('IntersectionObserver' in window)) return;
  var headings = document.querySelectorAll('main h2[id], main h3[id]');
  if (!headings.length) return;

  var active = null;
  var enteredAt = 0;

  function label(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  }

  function report(el, endedAt) {
    if (!el || !enteredAt) return;
    var dwellMs = Math.round(endedAt - enteredAt);
    if (dwellMs < 300) return; // filters out fast scroll-throughs, not real dwell
    gtag('event', 'section_dwell', {
      section_id: el.id,
      section_label: label(el),
      dwell_ms: dwellMs,
      page_path: location.pathname
    });
  }

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting || entry.target === active) return;
      var now = performance.now();
      report(active, now);
      active = entry.target;
      enteredAt = now;
    });
  }, { rootMargin: '-50% 0px -50% 0px', threshold: 0 });

  headings.forEach(function (h) { observer.observe(h); });

  document.addEventListener('visibilitychange', function () {
    var now = performance.now();
    if (document.visibilityState === 'hidden') {
      report(active, now);
      enteredAt = 0; // paused - don't count time spent away from the tab
    } else if (active) {
      enteredAt = now; // resumed - start a fresh dwell period for the same section
    }
  });

  window.addEventListener('pagehide', function () {
    report(active, performance.now());
  });
})();
