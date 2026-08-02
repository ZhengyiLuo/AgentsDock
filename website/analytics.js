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
