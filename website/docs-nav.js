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

  function fileName(href) {
    return (href || '').split('#')[0].split('?')[0].split('/').pop();
  }

  function normalizeDocsDirectory() {
    if (!nav.querySelector('.docs-nav-link')) return;

    var isZh = (document.documentElement.lang || '').toLowerCase().indexOf('zh') === 0;
    var labels = isZh ? {
      setup: '安装与连接',
      iphone: '客户端安装',
      firstChat: '第一个会话',
      features: '功能概览',
      shortcuts: '键盘快捷键',
      update: '更新',
      language: '语言',
      server: '管理服务器',
      advanced: '高级安装',
      multipleServers: '多服务器',
      backup: '备份与卸载',
      reportIssue: '反馈问题'
    } : {
      setup: 'Setup guide',
      iphone: 'Client install',
      firstChat: 'First chat',
      features: 'Features',
      shortcuts: 'Keyboard shortcuts',
      update: 'Updates',
      language: 'Language',
      server: 'Manage server',
      advanced: 'Advanced install',
      multipleServers: 'Multiple servers',
      backup: 'Backup & uninstall',
      reportIssue: 'Report an issue'
    };

    var groups = isZh ? [
      { label: '开始使用', items: [
        ['setup.html', labels.setup],
        ['iphone.html', labels.iphone],
        ['first-chat.html', labels.firstChat]
      ] },
      { label: '使用 AgentsDock', items: [
        ['features.html', labels.features],
        ['shortcuts.html', labels.shortcuts],
        ['update.html', labels.update],
        ['language.html', labels.language]
      ] },
      { label: '服务器', items: [
        ['server.html', labels.server],
        ['advanced-install.html', labels.advanced],
        ['multiple-servers.html', labels.multipleServers],
        ['backup-uninstall.html', labels.backup]
      ] },
      { label: '支持', items: [
        ['report-issue.html', labels.reportIssue]
      ] }
    ] : [
      { label: 'Get started', items: [
        ['setup.html', labels.setup],
        ['iphone.html', labels.iphone],
        ['first-chat.html', labels.firstChat]
      ] },
      { label: 'Using AgentsDock', items: [
        ['features.html', labels.features],
        ['shortcuts.html', labels.shortcuts],
        ['update.html', labels.update],
        ['language.html', labels.language]
      ] },
      { label: 'Server', items: [
        ['server.html', labels.server],
        ['advanced-install.html', labels.advanced],
        ['multiple-servers.html', labels.multipleServers],
        ['backup-uninstall.html', labels.backup]
      ] },
      { label: 'Support', items: [
        ['report-issue.html', labels.reportIssue]
      ] }
    ];

    var lang = nav.querySelector('.docs-lang');
    var pairsByFile = {};
    Array.prototype.slice.call(nav.querySelectorAll('.docs-nav-link')).forEach(function (link) {
      pairsByFile[fileName(link.getAttribute('href'))] = {
        link: link,
        subs: link.nextElementSibling && link.nextElementSibling.classList.contains('docs-nav-subs')
          ? link.nextElementSibling
          : null
      };
    });

    while (nav.firstChild) nav.removeChild(nav.firstChild);
    if (lang) nav.appendChild(lang);

    groups.forEach(function (group) {
      var present = group.items.some(function (item) { return pairsByFile[item[0]]; });
      if (!present) return;

      var label = document.createElement('p');
      label.className = 'docs-nav-label';
      label.textContent = group.label;
      nav.appendChild(label);

      group.items.forEach(function (item) {
        var pair = pairsByFile[item[0]];
        if (!pair) return;
        pair.link.textContent = item[1];
        nav.appendChild(pair.link);
        if (pair.subs) nav.appendChild(pair.subs);
      });
    });
  }

  normalizeDocsDirectory();

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
