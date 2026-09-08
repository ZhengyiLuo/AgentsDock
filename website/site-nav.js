// Mobile-only primary navigation. Injects a hamburger button into the site
// header; tapping it drops down the header links (Home / Docs / Discord). On
// desktop the button is display:none and the nav shows inline as usual, so
// desktop is completely unaffected (see .nav-toggle rules in styles.css).
(function () {
  var header = document.querySelector('.site-header');
  if (!header || header.querySelector('.nav-toggle')) return;
  var nav = header.querySelector('nav');
  if (!nav) return;

  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'nav-toggle';
  btn.setAttribute('aria-label', 'Menu');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML =
    '<svg class="nav-toggle-open" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>' +
    '<svg class="nav-toggle-close" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  header.appendChild(btn);

  function setOpen(open) {
    header.classList.toggle('nav-open', open);
    btn.setAttribute('aria-expanded', String(open));
  }
  btn.addEventListener('click', function () { setOpen(!header.classList.contains('nav-open')); });
  // Tapping any link closes the menu.
  nav.addEventListener('click', function (e) { if (e.target.closest('a')) setOpen(false); });
  // Tapping outside the header closes it too.
  document.addEventListener('click', function (e) {
    if (header.classList.contains('nav-open') && !header.contains(e.target)) setOpen(false);
  });
})();
