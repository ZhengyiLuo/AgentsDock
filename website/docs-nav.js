// Mobile-only docs directory menu.
// On phones the docs sidebar is collapsed behind a tappable button; tapping it
// reveals the full directory, and tapping any link jumps to that page/section
// and closes the menu. Has no visual effect on desktop — the button is
// display:none there (see .docs-menu-toggle in styles.css) and the sidebar
// shows as the usual sticky column.
(function () {
  var nav = document.querySelector('.docs-nav');
  if (!nav || document.querySelector('.docs-menu-toggle')) return;

  var aside = nav.closest('aside') || nav;
  var docsLabel = aside.getAttribute('data-docs-label') || 'Docs';
  var active = nav.querySelector('.docs-nav-link.current');
  var current = active ? active.textContent.trim() : docsLabel;

  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'docs-menu-toggle';
  btn.setAttribute('aria-label', aside.getAttribute('data-docs-menu-label') || 'Open the docs menu');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML =
    '<span class="docs-menu-label">' +
      '<span class="docs-menu-kicker">' + docsLabel + '</span>' +
      '<span class="docs-menu-current"></span>' +
    '</span>' +
    '<svg class="docs-menu-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  btn.querySelector('.docs-menu-current').textContent = current;

  // Mobile row: the directory button plus (on docs pages) a language switch link.
  var row = document.createElement('div');
  row.className = 'docs-menu-row';
  row.appendChild(btn);
  var langHref = aside.getAttribute('data-lang-href');
  if (langHref) {
    var lang = document.createElement('a');
    lang.className = 'docs-menu-lang';
    lang.href = langHref;
    lang.textContent = aside.getAttribute('data-lang-label') || 'EN';
    row.appendChild(lang);
  }
  nav.parentNode.insertBefore(row, nav);

  function setOpen(open) {
    nav.classList.toggle('is-open', open);
    btn.classList.toggle('is-open', open);
    btn.setAttribute('aria-expanded', String(open));
  }
  btn.addEventListener('click', function () { setOpen(!nav.classList.contains('is-open')); });
  // Jumping to a link (another page or an in-page anchor) closes the menu.
  nav.addEventListener('click', function (e) { if (e.target.closest('a')) setOpen(false); });
})();
