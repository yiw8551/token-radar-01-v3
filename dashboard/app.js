// Token Launch Radar — board rendering, filtering, sorting and detail view.
// Data comes from ../data.js (window.BOARD_DATA), written by main.ts from the
// same snapshot and model as board.json. No network: everything renders local.
(function () {
  var DATA = window.BOARD_DATA;
  var rows = DATA.rows;

  function money(n) {
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function compact(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(n >= 1e10 ? 0 : 2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return '$' + Math.round(n);
  }
  function chgCell(v) {
    // change_7d is already in per cent: 2.37 means +2.37%.
    if (v === null || v === undefined) return '<span class="mut">n/a</span>';
    var pct = v;
    var cls = pct >= 0 ? 'up' : 'down';
    return '<span class="' + cls + '">' + (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%</span>';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // KPI strip: coverage, rows, snapshot date, held-out fit.
  var v = DATA.validation;
  var kpis = [
    { k: 'Watchlist covered', v: DATA.meta.watchlist_covered + ' / ' + DATA.meta.watchlist_total },
    { k: 'Board rows', v: DATA.meta.rows + ' pre-token' },
    { k: 'Snapshot', v: DATA.meta.snapshot_date },
    { k: 'Leave-one-out MAE', v: 'x' + v.mae_factor.toFixed(1) + '  ·  R2 ' + v.r2.toFixed(2) },
  ];
  document.getElementById('kpis').innerHTML = kpis.map(function (c) {
    return '<div class="kpi"><span class="k">' + c.k + '</span><span class="v">' + c.v + '</span></div>';
  }).join('');
  document.getElementById('snapDate').textContent = DATA.meta.snapshot_date;
  document.getElementById('snapDate2').textContent = DATA.meta.snapshot_date;

  // Category filter options, most rows first.
  var counts = {};
  rows.forEach(function (r) { counts[r.category] = (counts[r.category] || 0) + 1; });
  var cats = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
  var catSel = document.getElementById('category');
  cats.forEach(function (c) {
    var o = document.createElement('option');
    o.value = c;
    o.textContent = c + ' (' + counts[c] + ')';
    catSel.appendChild(o);
  });

  var searchEl = document.getElementById('search');
  var sortEl = document.getElementById('sort');
  var watchEl = document.getElementById('watchOnly');
  var tbody = document.getElementById('rows');
  var countEl = document.getElementById('count');

  function filtered() {
    var q = searchEl.value.trim().toLowerCase();
    var cat = catSel.value;
    var list = rows.filter(function (r) {
      if (cat && r.category !== cat) return false;
      if (watchEl.checked && !r.watchlist) return false;
      if (q && r.name.toLowerCase().indexOf(q) === -1 && r.slug.indexOf(q) === -1) return false;
      return true;
    });
    var key = sortEl.value;
    var sorters = {
      implied: function (a, b) { return a.implied_value_usd - b.implied_value_usd; },
      tvl: function (a, b) { return a.tvl_usd - b.tvl_usd; },
      chg: function (a, b) { return (b.change_7d || 0) - (a.change_7d || 0); },
      odds: function (a, b) { return b.launch_odds - a.launch_odds; },
      name: function (a, b) { return a.name.localeCompare(b.name); },
    };
    list.sort(sorters[key] || sorters.implied);
    if (key === 'implied' || key === 'tvl') list.reverse();
    return list;
  }

  function render() {
    var list = filtered();
    tbody.innerHTML = list.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '">' +
        '<td>' + r.rank + '</td>' +
        '<td>' + esc(r.name) + (r.watchlist ? '<span class="badge">WATCH</span>' : '') + '</td>' +
        '<td class="mut">' + esc(r.category) + '</td>' +
        '<td class="num">' + compact(r.tvl_usd) + '</td>' +
        '<td class="num">' + chgCell(r.change_7d) + '</td>' +
        '<td class="num"><strong>' + compact(r.implied_value_usd) + '</strong></td>' +
        '<td class="num mut">' + compact(r.implied_low_usd) + '–' + compact(r.implied_high_usd) + '</td>' +
        '<td class="num">' + Math.round(r.launch_odds * 100) + '%</td></tr>';
    }).join('');
    countEl.textContent = 'Showing ' + list.length + ' of ' + rows.length + ' rows.';
  }

  function showDetail(r) {
    document.getElementById('detail').hidden = false;
    document.getElementById('dName').textContent = '#' + r.rank + '  ' + r.name;
    document.getElementById('dSub').textContent =
      r.category + '  ·  ' + r.chain + '  ·  listed ' + r.age_years.toFixed(1) + ' yrs ago  ·  ' +
      (r.watchlist ? 'on the watchlist' : 'not on the watchlist');
    document.getElementById('dValue').textContent = money(r.implied_value_usd);
    document.getElementById('dRange').textContent = money(r.implied_low_usd) + ' – ' + money(r.implied_high_usd);
    document.getElementById('dTvl').textContent = money(r.tvl_usd);
    var chg = document.getElementById('dChg');
    chg.textContent = r.change_7d === null ? 'n/a' : ((r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(1) + '%');
    chg.className = r.change_7d === null ? 'mut' : (r.change_7d >= 0 ? 'up' : 'down');
    document.getElementById('dMult').textContent =
      r.multiple_source === 'category'
        ? r.multiple.toFixed(3) + '  (' + r.multiple_n + ' ' + r.category + ' peers)'
        : r.multiple.toFixed(3) + '  (global median, ' + r.multiple_n + ' peers)';
    document.getElementById('dOdds').textContent = Math.round(r.launch_odds * 100) + '%';
    var multPhrase = r.multiple_source === 'category'
      ? r.multiple.toFixed(3) + ' (median mcap/TVL of ' + r.multiple_n + ' tokenized ' + r.category + ' protocols)'
      : r.multiple.toFixed(3) + ' (global median mcap/TVL of ' + r.multiple_n + ' tokenized protocols; its category holds too few)';
    document.getElementById('dModel').textContent =
      'Implied value = TVL ' + money(r.tvl_usd) + ' × ' + multPhrase +
      ' × ' + r.momentum.toFixed(2) + ' momentum × ' + r.maturity.toFixed(2) + ' maturity. ' +
      'The range comes from the multiple’s spread (25th–75th percentile). Launch odds fall with no-token age: ' +
      'a protocol that has run ' + r.age_years.toFixed(1) + ' years without a token is less likely to issue one soon.';
    document.getElementById('dSteps').innerHTML = r.farm_steps.map(function (s) {
      return '<li>' + esc(s) + '</li>';
    }).join('');
    var trs = tbody.querySelectorAll('tr');
    trs.forEach(function (tr) { tr.classList.toggle('sel', tr.getAttribute('data-slug') === r.slug); });
    document.getElementById('detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  tbody.addEventListener('click', function (e) {
    var tr = e.target.closest('tr');
    if (!tr) return;
    var r = rows.find(function (x) { return x.slug === tr.getAttribute('data-slug'); });
    if (r) showDetail(r);
  });
  [searchEl, sortEl, catSel, watchEl].forEach(function (el) {
    el.addEventListener('input', render);
    el.addEventListener('change', render);
  });

  // Validation panel: the honest numbers.
  document.getElementById('vText').textContent =
    'Leave-one-out on ' + v.n + ' tokenized protocols: the multiples model predicts a market cap within a typical factor of ×' +
    v.mae_factor.toFixed(1) + ' (MAE ' + v.mae_log10.toFixed(2) + ' in log10) with R² ' + v.r2.toFixed(2) +
    '. Global median multiple ' + v.global_median.toFixed(3) + ' (25th–75th percentile ' +
    v.global_q25.toFixed(3) + '–' + v.global_q75.toFixed(3) + ').';

  // Reference list: tokenized protocols, never ranked.
  document.getElementById('refList').innerHTML = DATA.reference_tokenized.map(function (p) {
    return '<li>' + esc(p.name) + ' <span class="mut">(' + esc(p.category) + ', mcap ' + compact(p.mcap_usd) +
      ', multiple ' + p.multiple.toFixed(2) + ')</span></li>';
  }).join('');

  render();
})();
