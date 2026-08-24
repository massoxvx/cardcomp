// ══════════════════════════════════════════════════════
// SECTION 1: SAFE STORAGE HELPERS
// Wraps localStorage/sessionStorage so the app never throws
// or crashes if storage is unavailable (private browsing,
// quota exceeded, disabled cookies, etc). Every storage read
// or write in the app should go through these.
// ══════════════════════════════════════════════════════
function safeGet(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch (e) {
    console.warn('[storage] safeGet failed for', key, e);
    return fallback;
  }
}
function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.warn('[storage] safeSet failed for', key, e);
    return false;
  }
}
function safeRemove(key) {
  try {
    localStorage.removeItem(key);
    return true;
  } catch (e) {
    console.warn('[storage] safeRemove failed for', key, e);
    return false;
  }
}
function loadJSON(key, fallback) {
  const raw = safeGet(key, null);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.warn('[storage] loadJSON parse failed for', key, e);
    return fallback;
  }
}
function saveJSON(key, value) {
  try {
    return safeSet(key, JSON.stringify(value));
  } catch (e) {
    console.warn('[storage] saveJSON stringify failed for', key, e);
    return false;
  }
}
// Session storage variants (used for one-time-per-tab flags like the welcome modal)
function safeSessionGet(key, fallback = null) {
  try {
    const v = sessionStorage.getItem(key);
    return v === null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}
function safeSessionSet(key, value) {
  try {
    sessionStorage.setItem(key, value);
    return true;
  } catch (e) {
    return false;
  }
}

// ══════════════════════════════════════════════════════
// SECTION 2: CONSTANTS AND STATE
// ══════════════════════════════════════════════════════
let selectedGame = '';

// ─── RECENT SEARCHES ─────────────────────────────────
const MAX_RECENT = 8;

function loadRecentSearches() {
  return loadJSON('cc_recent', []);
}
function saveRecentSearch(q) {
  let recent = loadRecentSearches().filter(r => r.toLowerCase() !== q.toLowerCase());
  recent.unshift(q);
  if (recent.length > MAX_RECENT) recent = recent.slice(0, MAX_RECENT);
  saveJSON('cc_recent', recent);
}
function removeRecentSearch(q) {
  const recent = loadRecentSearches().filter(r => r !== q);
  saveJSON('cc_recent', recent);
  renderRecentSearches();
}
function renderRecentSearches() {
  const recent = loadRecentSearches();
  const wrap = document.getElementById('recentSearchesWrap');
  const chips = document.getElementById('recentChips');
  if (!wrap || !chips) return;
  if (!recent.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  chips.innerHTML = recent.map(r => `
    <div class="recent-chip" onclick="runRecentSearch('${esc(r)}')">
      <span class="recent-chip-text">🕐 ${esc(r)}</span>
      <button class="recent-chip-x" onclick="event.stopPropagation();removeRecentSearch('${esc(r)}')">✕</button>
    </div>`).join('');
}
function runRecentSearch(q) {
  document.getElementById('searchInput').value = q;
  hideSuggestions();
  doSearch();
}

// ─── LIVE SUGGESTIONS ────────────────────────────────
let suggestTimeout = null;
let suggestFocusIndex = -1;
let lastSuggestQuery = '';

function onSearchInput(val) {
  // Show/hide clear button
  const clearBtn = document.getElementById('searchClear');
  clearBtn.classList.toggle('visible', val.length > 0);

  // Show recent searches when empty
  if (!val.trim()) {
    hideSuggestions();
    renderRecentSearches();
    return;
  }

  // Hide recent when typing
  document.getElementById('recentSearchesWrap').classList.add('hidden');

  // Debounce suggestions — fire after 350ms of no typing
  // Auto-detect game from what's typed
  const lower = val.toLowerCase();
  const gameKeywords = {
    pokemon: ['pikachu','charizard','mewtwo','eevee','bulbasaur','squirtle','pokemon','pokémon','psa','bgs','base set','jungle','fossil','neo','ex ','gx ','vmax','vstar'],
    mtg: ['black lotus','mox','ancestral','time walk','magic','mtg','force of will','sol ring','fetchland','dual land'],
    yugioh: ['blue-eyes','dark magician','exodia','yugioh','yu-gi-oh','blue eyes'],
    onepiece: ['luffy','zoro','nami','one piece','sanji','shanks'],
    lorcana: ['lorcana','stitch','elsa','simba','moana'],
  };
  let detected = '';
  for (const [game, keywords] of Object.entries(gameKeywords)) {
    if (keywords.some(kw => lower.includes(kw))) { detected = game; break; }
  }
  if (detected && detected !== selectedGame) {
    const chip = document.querySelector(`.game-chip[data-game="${detected}"]`);
    if (chip) selectGame(chip);
  }

  // No auto-search on input — search fires on Enter or SEARCH button only
  // This prevents burning through API rate limits while typing
  hideSuggestions();
}

async function fetchSuggestions(q) {
  if (!apiKey || q === lastSuggestQuery) return;
  lastSuggestQuery = q;
  const box = document.getElementById('suggestions');

  // Show loading state
  box.innerHTML = `<div class="sug-loading"><div class="sug-loader"></div> Searching...</div>`;
  box.classList.remove('hidden');
  box.classList.add('visible');

  try {
    const game = selectedGame || '';
    let url = `${WORKER_URL}/v1/cards/search?q=${encodeURIComponent(normalizeQuery(q))}&limit=6`;
    if (game) url += `&game=${game}`;
    const res = await fetch(url);
    if (!res.ok) { hideSuggestions(); return; }
    const data = await res.json();
    const cards = data.data || [];

    if (!cards.length) {
      box.innerHTML = `<div class="sug-empty">No results for "${esc(q)}" — try a different spelling</div>`;
      return;
    }

    suggestFocusIndex = -1;
    box.innerHTML = cards.map((c, i) => {
      const price = c.prices?.raw?.near_mint?.tcgplayer?.market;
      const img = c.image_url
        ? `<img class="sug-img" src="${esc(c.image_url)}" alt="${esc(c.name)}" onerror="this.outerHTML='<div class=sug-img-ph>🃏</div>'">`
        : `<div class="sug-img-ph">🃏</div>`;
      return `<div class="suggestion-item" data-id="${esc(c.id)}" data-index="${i}" onclick="selectSuggestion('${esc(c.id)}')">
        ${img}
        <div class="sug-info">
          <div class="sug-name">${esc(c.name)}</div>
          <div class="sug-meta">${esc(c.set?.name||'')} · ${esc(c.game?.name||'')}${c.number?' · #'+esc(c.number):''}</div>
        </div>
        ${price ? `<div class="sug-price">${fmt(price)}</div>` : ''}
      </div>`;
    }).join('');
  } catch(e) {
    hideSuggestions();
  }
}

function selectSuggestion(cardId) {
  hideSuggestions();
  const input = document.getElementById('searchInput');
  saveRecentSearch(input.value.trim());
  loadCard(cardId);
}

function hideSuggestions() {
  const box = document.getElementById('suggestions');
  box.classList.add('hidden');
  box.classList.remove('visible');
  suggestFocusIndex = -1;
  lastSuggestQuery = '';
}

function clearSearch() {
  const input = document.getElementById('searchInput');
  input.value = '';
  hideSuggestions();
  renderRecentSearches();
  document.getElementById('searchClear').classList.remove('visible');
  input.focus();
}

// Keyboard navigation through suggestions
function onSearchKeyDown(e) {
  const box = document.getElementById('suggestions');
  const items = box.querySelectorAll('.suggestion-item');

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    suggestFocusIndex = Math.min(suggestFocusIndex + 1, items.length - 1);
    items.forEach((el, i) => el.classList.toggle('focused', i === suggestFocusIndex));
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    suggestFocusIndex = Math.max(suggestFocusIndex - 1, -1);
    items.forEach((el, i) => el.classList.toggle('focused', i === suggestFocusIndex));
    return;
  }
  if (e.key === 'Enter') {
    if (suggestFocusIndex >= 0 && items[suggestFocusIndex]) {
      const id = items[suggestFocusIndex].dataset.id;
      if (id) { selectSuggestion(id); return; }
    }
    hideSuggestions();
    doSearch();
    return;
  }
  if (e.key === 'Escape') {
    hideSuggestions();
    return;
  }
}

// Close suggestions when clicking outside
document.addEventListener('click', (e) => {
  if (!document.getElementById('searchWrap')?.contains(e.target)) {
    hideSuggestions();
  }
});

function selectGame(el) {
  document.querySelectorAll('.game-chip').forEach(c=>c.classList.remove('active'));
  el.classList.add('active');
  selectedGame = el.dataset.game || '';
}
// ─── COUNTRY / TAX DATA ──────────────────────────────
const TAX_RATES = {
  CA: {
    ON:0.13, BC:0.12, AB:0.05, QC:0.14975, NS:0.15,
    NB:0.15, MB:0.12, SK:0.11, PE:0.15, NL:0.15,
    YT:0.05, NT:0.05, NU:0.05
  },
  US: {
    AL:0.04, AK:0.0, AZ:0.056, AR:0.065, CA:0.0725,
    CO:0.029, CT:0.0635, DE:0.0, FL:0.06, GA:0.04,
    HI:0.04, ID:0.06, IL:0.0625, IN:0.07, IA:0.06,
    KS:0.065, KY:0.06, LA:0.0445, ME:0.055, MD:0.06,
    MA:0.0625, MI:0.06, MN:0.06875, MS:0.07, MO:0.04225,
    MT:0.0, NE:0.055, NV:0.0685, NH:0.0, NJ:0.06625,
    NM:0.05125, NY:0.04, NC:0.0475, ND:0.05, OH:0.0575,
    OK:0.045, OR:0.0, PA:0.06, RI:0.07, SC:0.06,
    SD:0.045, TN:0.07, TX:0.0625, UT:0.0485, VT:0.06,
    VA:0.053, WA:0.065, WV:0.06, WI:0.05, WY:0.04,
    DC:0.06
  },
  UK:0.20, AU:0.10
};
const US_STATE_NAMES = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',
  CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',
  HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',
  KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',
  MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',
  MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',
  NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',
  OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',
  SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',
  VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',
  DC:'Washington D.C.'
};
const CA_PROVINCE_NAMES = {
  ON:'Ontario',BC:'British Columbia',AB:'Alberta',QC:'Quebec',
  NS:'Nova Scotia',NB:'New Brunswick',MB:'Manitoba',SK:'Saskatchewan',
  PE:'Prince Edward Island',NL:'Newfoundland',YT:'Yukon',NT:'Northwest Territories',NU:'Nunavut'
};
const TAX_LABELS = {
  CA:{ON:'13% HST',BC:'12% GST+PST',AB:'5% GST',QC:'14.975% GST+QST',NS:'15% HST',NB:'15% HST',MB:'12% GST+PST',SK:'11% GST+PST',PE:'15% HST',NL:'15% HST',YT:'5% GST',NT:'5% GST',NU:'5% GST'},
  UK:'20% VAT',AU:'10% GST'
};
const COUNTRY_FLAGS = {CA:'🇨🇦',US:'🇺🇸',UK:'🇬🇧',AU:'🇦🇺'};
const EBAY_FVF = {CA:0.1325, US:0.1325, UK:0.125, AU:0.129};
const EBAY_FIXED = {CA:0.40, US:0.40, UK:0.30, AU:0.35};
// Grading fees
const GRADING_FEES = {
  psa_economy:18, psa_value:32.99, psa_regular:75,
  bgs_economy:22, bgs_standard:75,
  cgc_economy:18, cgc_standard:35
};
function getGradingFee(graderKey) { return GRADING_FEES[graderKey] || GRADING_FEES.psa_value; }

// ─── STATE ───────────────────────────────────────────
// API key lives in Cloudflare Worker — never exposed in frontend
const WORKER_URL = 'https://cardcomp-api.romantinimassimo.workers.dev';
let apiKey = 'connected'; // auth handled by Worker
let sellerCountry = safeGet('cc_country', 'CA');
let sellerProvince = safeGet('cc_province', 'ON');
let fxRate = 1.0; // USD to local currency rate
let currencySymbol = 'US$';
let showingLocalCurrency = sellerCountry === 'CA'; // default CAD on for Canadian users
let currentCard = null;
let currentTab = 'tcg';
let currentTcgCond = 'near_mint';
let currentEbayCond = 'near_mint';
let currentGrader = 'psa';
let currentPeriod = '30d';
let chartInstance = null;
let historyCache = {};
let searchResults = [];
let allSearchResults = []; // full unfiltered list
let currentPage = 1;
const PAGE_SIZE = 12;
let snapshotText = '';

const CONDITIONS = [
  {key:'near_mint',label:'Near Mint'},
  {key:'lightly_played',label:'Lightly Played'},
  {key:'moderately_played',label:'Moderately Played'},
  {key:'heavily_played',label:'Heavily Played'},
  {key:'damaged',label:'Damaged'},
];
const GRADES = ['10','9.5','9','8.5','8','7','6','5'];
const GRADERS = {psa:'PSA',bgs:'BGS',cgc:'CGC'};

// ─── TAX HELPERS ─────────────────────────────────────
function getTaxRate() {
  if (sellerCountry === 'CA') return TAX_RATES.CA[sellerProvince] || 0.13;
  if (sellerCountry === 'US') return TAX_RATES.US[sellerProvince] || 0;
  return TAX_RATES[sellerCountry] || 0;
}
function getTaxLabel() {
  if (sellerCountry === 'CA') return TAX_LABELS.CA[sellerProvince] || '13% HST';
  if (sellerCountry === 'US') {
    const rate = TAX_RATES.US[sellerProvince] || 0;
    return rate === 0 ? 'No sales tax' : (rate*100).toFixed(2).replace(/\.?0+$/,'') + '% sales tax';
  }
  return TAX_LABELS[sellerCountry] || '0%';
}
function getFVF() { return EBAY_FVF[sellerCountry] || 0.1325; }
function getFixed() { return EBAY_FIXED[sellerCountry] || 0.40; }

// Calculate eBay net payout for a given sale price
function calcEbayPayout(salePrice, promoRate=0) {
  const tax = getTaxRate();
  const fvf = getFVF();
  const fixed = getFixed();
  const fvfAmount = salePrice * fvf;
  const taxOnFees = fvfAmount * tax;
  const promoFee = salePrice * (promoRate/100);
  const totalFees = fvfAmount + taxOnFees + fixed + promoFee;
  const netPayout = salePrice - totalFees;
  return {fvfAmount, taxOnFees, promoFee, fixed, totalFees, netPayout};
}

// ─── COUNTRY UI ──────────────────────────────────────
function refreshCountryUI() {
  const flag = COUNTRY_FLAGS[sellerCountry] || '🌍';
  document.getElementById('countryFlag').textContent = flag;
  let lbl = sellerCountry;
  if (sellerCountry === 'CA') lbl = `Canada · ${sellerProvince}`;
  else if (sellerCountry === 'US') lbl = `US · ${sellerProvince}`;
  else if (sellerCountry === 'UK') lbl = 'United Kingdom';
  else if (sellerCountry === 'AU') lbl = 'Australia';
  document.getElementById('countryLabel').textContent = lbl;
  const roiBadge = document.getElementById('roiCountryBadge');
  if (roiBadge) roiBadge.textContent = `${flag} ${sellerProvince||sellerCountry} · ${getTaxLabel()}`;
}

function openCountryModal() {
  document.getElementById('countrySelect').value = sellerCountry;
  document.getElementById('provinceSelect').value = sellerProvince;
  onCountryChange();
  document.getElementById('countryModal').classList.remove('hidden');
}
function closeCountryModal() { document.getElementById('countryModal').classList.add('hidden'); }
function onCountryChange() {
  const c = document.getElementById('countrySelect').value;
  const pr = document.getElementById('provinceRow');
  const hasSubregion = c === 'CA' || c === 'US';
  pr.classList.toggle('visible', hasSubregion);
  if (hasSubregion) {
    const sel = document.getElementById('provinceSelect');
    sel.innerHTML = '';
    const regions = c === 'CA' ? CA_PROVINCE_NAMES : US_STATE_NAMES;
    Object.entries(regions).forEach(([code, name]) => {
      const rate = c === 'CA' ? TAX_RATES.CA[code] : TAX_RATES.US[code];
      const pct = rate === 0 ? 'No tax' : (rate*100).toFixed(2).replace(/\.?0+$/,'')+'%';
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = `${name} (${pct})`;
      if (code === sellerProvince) opt.selected = true;
      sel.appendChild(opt);
    });
  }
  onProvinceChange();
}
function onProvinceChange() {
  const c = document.getElementById('countrySelect').value;
  const p = document.getElementById('provinceSelect').value;
  let label;
  if (c === 'CA') label = TAX_LABELS.CA[p] || '5% GST';
  else label = TAX_LABELS[c] || '0%';
  document.getElementById('taxInfoValue').textContent = label;
}
function saveCountry() {
  sellerCountry = document.getElementById('countrySelect').value;
  sellerProvince = document.getElementById('provinceSelect').value;
  safeSet('cc_country', sellerCountry);
  safeSet('cc_province', sellerProvince);
  // Reset currency to local when country changes
  showingLocalCurrency = sellerCountry !== 'US';
  refreshCountryUI();
  closeCountryModal();
  fetchFxRate().then(() => {
    if (currentCard) renderDetail(currentCard);
    renderPortfolio();
    renderPricerItems();
  });
}

// ─── API KEY ─────────────────────────────────────────
function refreshApiStatus() {
  const dot = document.getElementById('statusDot');
  const lbl = document.getElementById('apiBtnLabel');
  // Worker is always connected — key lives in Cloudflare
  dot.classList.add('live');
  lbl.textContent = 'Live';
}
function openApiModal() { document.getElementById('apiKeyInput').value=''; document.getElementById('apiModal').classList.remove('hidden'); }
function closeApiModal() { document.getElementById('apiModal').classList.add('hidden'); }
function saveApiKey() {
  const v = document.getElementById('apiKeyInput').value.trim();
  if (!v) return;
  apiKey = v; safeSet('cc_api_key', v);
  refreshApiStatus(); closeApiModal();
}
document.getElementById('countryModal').addEventListener('click', e => { if(e.target===document.getElementById('countryModal')) closeCountryModal(); });
document.getElementById('apiModal')?.addEventListener('click', e => { if(e.target===document.getElementById('apiModal')) closeApiModal(); });

// ─── SEARCH ──────────────────────────────────────────
async function doSearch() {
  const q = document.getElementById('searchInput').value.trim();
  if (!q) return;
  // Worker handles auth — no key check needed
  hideSuggestions();
  saveRecentSearch(q);
  const game = selectedGame || '';
  setLoading(true); hideError();
  show('emptyState',false); show('searchSection',false); show('detailSection',false);
  try {
    let url = `${WORKER_URL}/v1/cards/search?q=${encodeURIComponent(q)}&limit=50`;
    if (game) url += `&game=${game}`;
    const res = await fetch(url);
    if (res.status===401) throw new Error('Invalid API key — click the top-right button to update it.');
    if (res.status===429) throw new Error('Rate limit reached. Wait a moment and try again.');
    if (!res.ok) throw new Error(`API error ${res.status}.`);
    const data = await res.json();
    allSearchResults = data.data || [];
    searchResults = allSearchResults;
    currentPage = 1;
    if (!allSearchResults.length) throw new Error(`No cards found for "${q}". Try a broader search.`);
    if (allSearchResults.length === 1) { await loadCard(allSearchResults[0].id); return; }
    history.pushState({ view: 'search', query: q }, '', `#search`);
    renderSearchList(searchResults, currentPage);
  } catch(e) { showError(e.message); }
  finally { setLoading(false); }
}

function renderSearchList(cards, page) {
  page = page || 1;
  const list = document.getElementById('searchList');
  const totalPages = Math.ceil(cards.length / PAGE_SIZE);
  const start = (page - 1) * PAGE_SIZE;
  const pageCards = cards.slice(start, start + PAGE_SIZE);

  let html = `<div class="card-list-head">
    <div class="card-list-title">SELECT A CARD</div>
    <div style="display:flex;align-items:center;gap:8px;">
      <div class="results-count">${cards.length} result${cards.length!==1?'s':''}</div>
      ${totalPages > 1 ? `<div class="card-list-badge">Page ${page} of ${totalPages}</div>` : ''}
    </div>
  </div><div class="search-grid">`;

  pageCards.forEach(c => {
    const nm = c.prices?.raw?.near_mint?.tcgplayer?.market || c.prices?.raw?.near_mint?.ebay?.avg_7d;
    const imgHtml = c.image_url
      ? `<img class="search-card-img" src="${esc(c.image_url)}" alt="${esc(c.name)}" loading="lazy" onerror="this.outerHTML='<div class=search-card-img-ph>🃏</div>'">`
      : '<div class="search-card-img-ph">🃏</div>';
    const priceBadge = nm
      ? `<div class="search-price-badge"><div><div class="search-price-badge-label">MARKET</div><div class="search-price-badge-val">${fmt(nm)}</div></div></div>`
      : `<div class="search-no-price">NO PRICE</div>`;
    const setMeta = [c.set?.name, c.game?.name, c.number ? '#'+c.number : ''].filter(Boolean).join(' · ');
    html += `<div class="search-card" onclick="loadCard('${esc(c.id)}')">
      <div class="search-card-img-wrap">${imgHtml}${priceBadge}</div>
      <div class="search-card-info">
        <div class="search-card-name">${esc(c.name)}</div>
        <div class="search-card-meta">${esc(setMeta)}</div>
      </div>
    </div>`;
  });

  html += '</div>';

  if (totalPages > 1) {
    const pages = [];
    if (totalPages <= 7) { for(let i=1;i<=totalPages;i++) pages.push(i); }
    else if (page <= 4) pages.push(1,2,3,4,5,'e',totalPages);
    else if (page >= totalPages-3) pages.push(1,'e',totalPages-4,totalPages-3,totalPages-2,totalPages-1,totalPages);
    else pages.push(1,'e',page-1,page,page+1,'e',totalPages);

    let pgHtml = '<div class="pagination" style="padding:0 4px 16px;">';
    pgHtml += '<button class="page-btn" onclick="goToPage(' + (page-1) + ')"' + (page<=1?' disabled':'') + '>← Prev</button>';
    pages.forEach(function(p) {
      if (p === 'e') {
        pgHtml += '<span style="color:var(--muted);padding:0 4px;">…</span>';
      } else {
        pgHtml += '<button class="page-btn' + (p===page?' active':'') + '" onclick="goToPage(' + p + ')">' + p + '</button>';
      }
    });
    pgHtml += '<button class="page-btn" onclick="goToPage(' + (page+1) + ')"' + (page>=totalPages?' disabled':'') + '>Next →</button>';
    pgHtml += '</div>';
    html += pgHtml;
  }

  list.innerHTML = html;
  list.scrollIntoView({ behavior: 'smooth', block: 'start' });
  show('searchSection', true);
}

function goToPage(page) {
  if (page < 1 || page > Math.ceil(searchResults.length / PAGE_SIZE)) return;
  currentPage = page;
  renderSearchList(searchResults, page);
  // Scroll to top of list
  document.getElementById('searchList').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─── CARD DETAIL ─────────────────────────────────────
async function loadCard(id) {
  show('searchSection',false); setLoading(true); hideError();
  try {
    let card = null;
    let fromCache = false;
    let cacheAge = 0;
    try {
      const res = await fetch(`${WORKER_URL}/v1/cards/${id}`);
      if (!res.ok) throw new Error(`API ${res.status}`);
      card = await res.json();
      cacheCardPrice(id, card); // save to offline cache
    } catch(fetchErr) {
      // Offline or API error — try the local cache
      const cached = getCachedCard(id);
      if (cached) {
        card = cached.data;
        fromCache = true;
        cacheAge = cached.age;
      } else {
        throw new Error('Could not load card and no cached data available. Check your connection.');
      }
    }
    currentCard = card;
    currentCard._fromCache = fromCache;
    currentCard._cacheAge = cacheAge;
    historyCache = {};
    history.pushState({ view: 'detail', cardId: id, cardName: currentCard.name }, '', `#card`);
    renderDetail(currentCard);
    loadHistory(id, currentPeriod);
  } catch(e) { showError(e.message); }
  finally { setLoading(false); }
}

function goBack() {
  show('detailSection', false);
  show('searchSection', true);
  history.pushState({ view: 'search' }, '', '#search');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderDetail(card) {
  renderHeader(card);
  checkUpgrade(card);
  switchTab('tcg', document.querySelector('.source-tab.tcg'));
  renderTcgPanel(card);
  renderEbayPanel(card);
  renderGradedPanel(card);
  buildSnapshot(card);
  updateQuickAddBar(card);
  show('detailSection', true);
}

function renderHeader(card) {
  const updated = card.updated_at ? formatDate(card.updated_at, {month:'short',day:'numeric',year:'numeric'}) : null;
  // Get dominant price for hero display
  const nm = card.prices?.raw?.near_mint;
  const tcgPrice = nm?.tcgplayer?.market;
  const ebayPrice = nm?.ebay?.avg_7d;
  const psa10 = card.prices?.graded?.psa?.['10']?.ebay?.avg_7d;
  const img = card.image_url
    ? `<img class="card-hero-img" src="${esc(card.image_url)}" alt="${esc(card.name)}" onerror="this.outerHTML='<div class=card-hero-img-ph>🃏</div>'">`
    : `<div class="card-hero-img-ph">🃏</div>`;
  document.getElementById('cardHero').innerHTML = `
    ${img}
    <div class="card-hero-info">
      <div class="card-hero-game">${esc(card.game?.name||'')}</div>
      <div class="card-hero-name">${esc(card.name)}</div>
      <div class="card-hero-set">${esc(card.set?.name||'')}${card.number?' · #'+esc(card.number):''}</div>
      <div class="card-tags">
        ${card.rarity?`<span class="ctag ctag-rarity">${esc(card.rarity)}</span>`:''}
        ${card.variant&&card.variant!=='Standard'?`<span class="ctag ctag-variant">${esc(card.variant)}</span>`:''}
      </div>
      <div class="card-price-row">
        ${tcgPrice?`<div class="cpr src-tcg"><div class="cpr-label">TCGPlayer</div><div class="cpr-val tcg">${fmt(tcgPrice)}</div></div>`:''}
        ${ebayPrice?`<div class="cpr src-ebay"><div class="cpr-label">eBay 7D</div><div class="cpr-val ebay">${fmt(ebayPrice)}</div></div>`:''}
        ${psa10?`<div class="cpr src-psa"><div class="cpr-label">PSA 10</div><div class="cpr-val psa">${fmt(psa10)}</div></div>`:''}
      </div>
      ${updated?`<div class="updated-line"><span class="live-dot"></span>Updated ${updated}${card._fromCache?`<span class="stale-badge">CACHED · ${formatAge(card._cacheAge)}</span>`:''}</div>`:''}
      <button class="roi-trigger" onclick="openRoiModal()">🧮 GRADE ROI CALCULATOR</button>
    </div>`;
}

function checkUpgrade(card) {
  const hasEbay = card.prices?.raw?.near_mint?.ebay?.avg_7d;
  const hasGraded = card.prices?.graded?.psa?.['10']?.ebay?.avg_7d;
  const needsUpgrade = !hasEbay && !hasGraded;
  show('upgradeBar', needsUpgrade);
}

// ─── TCG PANEL ───────────────────────────────────────
function renderTcgPanel(card) {
  const tabs = document.getElementById('tcgCondChips');
  tabs.innerHTML = '';
  CONDITIONS.forEach(c => {
    const val = card.prices?.raw?.[c.key]?.tcgplayer?.market;
    if (val===undefined && c.key!=='near_mint') return;
    const btn = document.createElement('button');
    btn.className = 'cond-chip' + (c.key===currentTcgCond?' active':'');
    btn.textContent = `${c.label}${val?' ('+fmt(val)+')':' (—)'}`;
    btn.onclick = () => {
      currentTcgCond = c.key;
      tabs.querySelectorAll('.cond-chip').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      renderTcgPrices(card, c.key);
      updateQuickAddBar(card);
    };
    tabs.appendChild(btn);
  });
  renderTcgPrices(card, currentTcgCond);
}
function renderTcgPrices(card, cond) {
  const d = card.prices?.raw?.[cond]?.tcgplayer;
  document.getElementById('tcgPriceGrid').innerHTML = `
    <div class="price-big-card pbc-tcg"><div class="pbl-label">Market</div><div class="pbl-value">${fmt(d?.market)}</div><div class="pbl-sub">TCGPlayer market</div></div>
    <div class="price-big-card pbc-low"><div class="pbl-label">Low</div><div class="pbl-value">${fmt(d?.low)}</div><div class="pbl-sub">Lowest listed</div></div>
    <div class="price-big-card pbc-high"><div class="pbl-label">High</div><div class="pbl-value">${fmt(d?.high)}</div><div class="pbl-sub">Highest listed</div></div>`;
}

// ─── EBAY PANEL ──────────────────────────────────────
function renderEbayPanel(card) {
  const tabs = document.getElementById('ebayCondChips');
  tabs.innerHTML = '';
  CONDITIONS.forEach(c => {
    const val = card.prices?.raw?.[c.key]?.ebay?.avg_7d;
    if (val===undefined && c.key!=='near_mint') return;
    const btn = document.createElement('button');
    btn.className = 'cond-chip' + (c.key===currentEbayCond?' active':'');
    btn.textContent = `${c.label}${val?' ('+fmt(val)+')':' (—)'}`;
    btn.onclick = () => {
      currentEbayCond = c.key;
      tabs.querySelectorAll('.cond-chip').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      renderEbayPrices(card, c.key);
      updateQuickAddBar(card);
    };
    tabs.appendChild(btn);
  });
  renderEbayPrices(card, currentEbayCond);
}
function renderEbayPrices(card, cond) {
  const d = card.prices?.raw?.[cond]?.ebay;
  const row = document.getElementById('ebayPriceGrid');
  if (!d?.avg_7d) {
    row.innerHTML = '<div class="upgrade-bar" style="grid-column:1/-1">🔒 eBay sold data requires <a href="https://tcgpricelookup.com/pricing" target="_blank">Starter plan ($19.99/mo)</a></div>';
    document.getElementById('ebayFeeCard').innerHTML = '';
    return;
  }
  row.innerHTML = `
    <div class="price-big-card pbc-ebay7"><div class="pbl-label">eBay 7-Day Avg</div><div class="pbl-value">${fmt(d.avg_7d)}</div><div class="pbl-sub">Sold listings avg</div></div>
    <div class="price-big-card pbc-ebay30"><div class="pbl-label">eBay 30-Day Avg</div><div class="pbl-value">${fmt(d.avg_30d)}</div><div class="pbl-sub">Sold listings avg</div></div>
    <div class="price-big-card pbc-low"><div class="pbl-label">Recent Low</div><div class="pbl-value">${fmt(d.low)}</div><div class="pbl-sub">Lowest sale</div></div>
    <div class="price-big-card pbc-avg"><div class="pbl-label">Recent High</div><div class="pbl-value">${fmt(d.high)}</div><div class="pbl-sub">Highest sale</div></div>`;
  // Fee breakdown for eBay 7d avg
  renderEbayFees(d.avg_7d);
}

function renderEbayFees(salePrice) {
  if (!salePrice) return;
  const {fvfAmount, taxOnFees, promoFee, fixed, totalFees, netPayout} = calcEbayPayout(salePrice);
  const taxLbl = getTaxLabel();
  const flag = COUNTRY_FLAGS[sellerCountry]||'🌍';
  const prov = sellerCountry==='CA'?` · ${sellerProvince}`:'';
  document.getElementById('ebayFeeCard').innerHTML = `
    <div class="fee-card-title">Seller Take-Home ${flag}${prov} <span style="font-size:10px;font-family:'Instrument Mono',monospace;color:var(--muted)">(on ${fmt(salePrice)} sale)</span></div>
    <div class="fee-row deduct"><span class="fee-row-label">eBay Final Value Fee (${(getFVF()*100).toFixed(2)}%)</span><span class="fee-row-val">−${fmt(fvfAmount)}</span></div>
    <div class="fee-row deduct"><span class="fee-row-label">Tax on Fees (${taxLbl})</span><span class="fee-row-val">−${fmt(taxOnFees)}</span></div>
    <div class="fee-row deduct"><span class="fee-row-label">Per-Order Fee</span><span class="fee-row-val">−${fmt(fixed)}</span></div>
    <div class="fee-row total"><span class="fee-row-label">Your Take-Home</span><span class="fee-row-val">${fmt(netPayout)}</span></div>`;
}

// ─── GRADED PANEL ────────────────────────────────────
function renderGradedPanel(card) {
  const graders = Object.keys(GRADERS).filter(g => card.prices?.graded?.[g]);
  const tabs = document.getElementById('graderChips');
  tabs.innerHTML = '';
  if (!graders.length) {
    document.getElementById('gradeTable').innerHTML = `<div style="padding:18px;font-size:13px;color:var(--muted)">No graded data available${card.prices?.graded?'. Requires <a href="https://tcgpricelookup.com/pricing" target="_blank" style="color:var(--accent)">Starter plan</a>.':' for this card.'}</div>`;
    return;
  }
  if (!graders.includes(currentGrader)) currentGrader = graders[0];
  graders.forEach(g => {
    const btn = document.createElement('button');
    btn.className = 'grader-chip' + (g===currentGrader?' active':'');
    btn.textContent = GRADERS[g];
    btn.onclick = () => { currentGrader=g; tabs.querySelectorAll('.grader-chip').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); renderGradeRows(card,g); updateQuickAddBar(card); };
    tabs.appendChild(btn);
  });
  renderGradeRows(card, currentGrader);
}
function renderGradeRows(card, grader) {
  const gdata = card.prices?.graded?.[grader];
  const rawRef = card.prices?.raw?.near_mint?.ebay?.avg_7d || card.prices?.raw?.near_mint?.tcgplayer?.market;
  const table = document.getElementById('gradeTable');
  if (!gdata) { table.innerHTML=`<div style="padding:18px;font-size:13px;color:var(--muted)">No ${GRADERS[grader]} data.</div>`; return; }
  let html = `<div class="grade-table-head"><span class="gth">Grade</span><span class="gth">eBay 7D</span><span class="gth">eBay 30D</span><span class="gth">vs Raw</span><span class="gth">TCGPlayer</span></div>`;
  GRADES.forEach(g => {
    const gd = gdata[g];
    const e7=gd?.ebay?.avg_7d, e30=gd?.ebay?.avg_30d, tcg=gd?.tcgplayer?.market;
    let deltaHtml = '<span class="gdelta">—</span>';
    if (e7 && rawRef) { const pct=((e7-rawRef)/rawRef*100).toFixed(0); deltaHtml=`<span class="gdelta ${pct>=0?'up':'down'}">${pct>=0?'+':''}${pct}%</span>`; }
    html += `<div class="grade-row"><span><span class="gpill gpill-${grader}">${GRADERS[grader]} ${g}</span></span><span class="gval ${e7?'':'na'}">${e7?fmt(e7):'—'}</span><span class="gval ${e30?'':'na'}" style="font-size:16px">${e30?fmt(e30):'—'}</span>${deltaHtml}<span class="gval ${tcg?'':'na'}" style="color:var(--accent2);font-size:16px">${tcg?fmt(tcg):'—'}</span></div>`;
  });
  table.innerHTML = html;
}

// ─── PRICE HISTORY CHART ─────────────────────────────
async function loadHistory(cardId, period) {
  const key = `${cardId}_${period}`;
  const wrap = document.getElementById('chartWrap');
  if (historyCache[key]) { renderChart(historyCache[key]); return; }
  wrap.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:175px"><div class="loader"></div></div>';
  try {
    const res = await fetch(`${WORKER_URL}/v1/cards/${cardId}/history?period=${period}`);
    if (res.status===403||res.status===401) { wrap.innerHTML=`<div class="chart-locked"><div class="chart-locked-icon">🔒</div><div class="chart-locked-text">Price history requires <a href="https://tcgpricelookup.com/pricing" target="_blank">Starter plan ($19.99/mo)</a></div></div>`; return; }
    if (!res.ok) throw new Error('unavailable');
    const data = await res.json();
    historyCache[key] = data;
    wrap.innerHTML = '<canvas id="priceChart"></canvas>';
    renderChart(data);
  } catch(e) { wrap.innerHTML=`<div class="chart-locked"><div class="chart-locked-icon">📊</div><div class="chart-locked-text">Price history not available for this card</div></div>`; }
}
function renderChart(data) {
  const canvas = document.getElementById('priceChart');
  if (!canvas) return;
  if (chartInstance) { chartInstance.destroy(); chartInstance=null; }
  const points = data.data||[];
  if (!points.length) { canvas.parentElement.innerHTML=`<div class="chart-locked"><div class="chart-locked-icon">📊</div><div class="chart-locked-text">No history data for this period</div></div>`; return; }
  const labels = points.map(p=>p.date);
  const tcgData = points.map(p=>p.prices?.tcgplayer?.market??null);
  const ebayData = points.map(p=>p.prices?.ebay?.avg??null);
  const datasets = [{label:'TCGPlayer',data:tcgData,borderColor:'#ff6b35',backgroundColor:'rgba(255,107,53,0.06)',borderWidth:2,pointRadius:0,tension:0.4,fill:true,spanGaps:true}];
  if (ebayData.some(v=>v!==null)) datasets.push({label:'eBay',data:ebayData,borderColor:'#7b8fff',backgroundColor:'rgba(123,143,255,0.06)',borderWidth:2,pointRadius:0,tension:0.4,fill:true,spanGaps:true});
  chartInstance = new Chart(canvas, {
    type:'line', data:{labels,datasets},
    options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:datasets.length>1,labels:{color:'#526070',font:{family:'Instrument Mono',size:10},boxWidth:10,usePointStyle:true}},
        tooltip:{backgroundColor:'#161c23',borderColor:'#2a3540',borderWidth:1,titleColor:'#dde4ec',bodyColor:'#526070',callbacks:{label:ctx=>` ${ctx.dataset.label}: ${ctx.parsed.y?'$'+ctx.parsed.y.toFixed(2):'—'}`}}},
      scales:{x:{ticks:{color:'#3a4a58',font:{family:'Instrument Mono',size:9},maxRotation:0,maxTicksLimit:8},grid:{color:'rgba(30,39,48,0.8)'}},y:{ticks:{color:'#3a4a58',font:{family:'Instrument Mono',size:9},callback:v=>'$'+v},grid:{color:'rgba(30,39,48,0.8)'}}}}
  });
}

// ─── ROI CALCULATOR ──────────────────────────────────
function prefillROI(card) {
  // Try to auto-fill sale price from PSA 9 eBay 7d if available
  const psa9 = card.prices?.graded?.psa?.['9']?.ebay?.avg_7d;
  const psa10 = card.prices?.graded?.psa?.['10']?.ebay?.avg_7d;
  if (psa9) {
    document.getElementById('roiSalePrice').value = psa9.toFixed(2);
    document.getElementById('roiSalePrice').placeholder = fmt(psa9) + ' (PSA 9 avg)';
  } else if (psa10) {
    document.getElementById('roiSalePrice').value = psa10.toFixed(2);
    document.getElementById('roiSalePrice').placeholder = fmt(psa10) + ' (PSA 10 avg)';
    document.getElementById('roiGrade').value = '10';
  }
  document.getElementById('roiResults').classList.remove('visible');
}

function calcROI() {
  const fx = fxRate || 1;
  const rawCost = (parseFloat(document.getElementById('roiRawCost').value) || 0) / fx;
  const graderKey = document.getElementById('roiGrader').value;
  const gradingFee = getGradingFee(graderKey);
  const shipping = (parseFloat(document.getElementById('roiShipping').value) || 0) / fx;
  const salePrice = (parseFloat(document.getElementById('roiSalePrice').value) || 0) / fx;
  const promoRate = parseFloat(document.getElementById('roiPromo').value) || 0;

  if (!salePrice && !rawCost) { document.getElementById('roiResults').classList.remove('visible'); return; }

  const totalCosts = rawCost + gradingFee + shipping;
  const {fvfAmount, taxOnFees, promoFee, fixed, totalFees, netPayout} = calcEbayPayout(salePrice, promoRate);
  const netProfit = netPayout - totalCosts;
  const roi = totalCosts > 0 ? (netProfit / totalCosts) * 100 : 0;
  const breakEven = calcBreakEven(totalCosts, promoRate);

  // Verdict
  let verdict, cls;
  if (roi >= 50) { verdict='STRONG GRADE'; cls='strong'; }
  else if (roi >= 20) { verdict='GRADE IT'; cls='good'; }
  else if (roi >= 0) { verdict='MARGINAL'; cls='marginal'; }
  else { verdict='SKIP IT'; cls='skip'; }

  const msgs = {
    strong:`${roi.toFixed(0)}% ROI — strong play. Even if you grade down one level, you likely still profit.`,
    good:`${roi.toFixed(0)}% ROI — solid submission. Covers costs with meaningful upside.`,
    marginal:`${roi.toFixed(0)}% ROI — tight. A grade lower than expected could put you in the red.`,
    skip:`${roi.toFixed(0)}% ROI — submission costs exceed projected sale price. Hold raw or find a better price.`
  };

  const el = document.getElementById('roiResults');
  const v = document.getElementById('roiVerdict');
  v.className = `roi-verdict ${cls}`;
  document.getElementById('verdictBadge').textContent = verdict;
  document.getElementById('verdictMsg').textContent = msgs[cls];
  document.getElementById('verdictRoi').textContent = roi.toFixed(0)+'%';

  const profitCls = netProfit >= 0 ? 'profit' : 'loss';
  document.getElementById('roiNetProfit').className = `roi-bc-val ${profitCls}`;
  document.getElementById('roiNetProfit').textContent = fmt(netProfit);
  document.getElementById('roiTotalCosts').textContent = fmt(totalCosts);
  document.getElementById('roiBreakEven').textContent = fmt(breakEven);

  document.getElementById('roiFeeLines').innerHTML = roiFeeBreakdownHtml({rawCost, gradingFee, graderKey, shipping, fvfAmount, taxOnFees, promoFee, promoRate, fixed, netProfit});

  el.classList.add('visible');
  // Update country badge
  const flag = COUNTRY_FLAGS[sellerCountry]||'🌍';
  document.getElementById('roiCountryBadge').textContent = `${flag} ${sellerCountry==='CA'?sellerProvince:sellerCountry} · ${getTaxLabel()}`;
}

function calcBreakEven(totalCosts, promoRate=0) {
  // Solve: salePrice - (salePrice * fvf) - (salePrice * fvf * tax) - (salePrice * promo/100) - fixed = totalCosts
  const fvf = getFVF();
  const tax = getTaxRate();
  const promo = promoRate/100;
  const fixed = getFixed();
  const denom = 1 - fvf - (fvf*tax) - promo;
  return (totalCosts + fixed) / denom;
}

// Shared grading-cost fee breakdown, used by both the inline ROI calculator
// (calcROI) and the ROI modal (calcRoiModal) — was previously duplicated
// verbatim in both places with a minor label inconsistency between them.
function roiFeeBreakdownHtml({rawCost, gradingFee, graderKey, shipping, fvfAmount, taxOnFees, promoFee, promoRate, fixed, netProfit}) {
  const taxLbl = getTaxLabel();
  const flag = COUNTRY_FLAGS[sellerCountry]||'🌍';
  return `
    <div class="fee-row deduct"><span class="fee-row-label">Raw card cost</span><span class="fee-row-val">−${fmt(rawCost)}</span></div>
    <div class="fee-row deduct"><span class="fee-row-label">Grading fee (${graderKey.replace('_',' ').toUpperCase()})</span><span class="fee-row-val">−${fmt(gradingFee)}</span></div>
    <div class="fee-row deduct"><span class="fee-row-label">Shipping to grader</span><span class="fee-row-val">−${fmt(shipping)}</span></div>
    <div class="fee-row deduct"><span class="fee-row-label">eBay Final Value Fee (${(getFVF()*100).toFixed(2)}%)</span><span class="fee-row-val">−${fmt(fvfAmount)}</span></div>
    <div class="fee-row deduct"><span class="fee-row-label">Tax on fees ${flag} (${taxLbl})</span><span class="fee-row-val">−${fmt(taxOnFees)}</span></div>
    ${promoFee>0?`<div class="fee-row deduct"><span class="fee-row-label">Promoted listing (${promoRate}%)</span><span class="fee-row-val">−${fmt(promoFee)}</span></div>`:''}
    <div class="fee-row deduct"><span class="fee-row-label">Per-order fee</span><span class="fee-row-val">−${fmt(fixed)}</span></div>
    <div class="fee-row total"><span class="fee-row-label">Net Profit</span><span class="fee-row-val">${fmt(netProfit)}</span></div>`;
}

// ─── TABS ────────────────────────────────────────────
function switchTab(tab, el) {
  currentTab = tab;
  document.querySelectorAll('.stab').forEach(t=>t.classList.remove('active'));
  if (el) el.classList.add('active');
  document.querySelectorAll('.price-panel').forEach(p=>p.classList.remove('active'));
  document.getElementById('panel-'+tab).classList.add('active');
  if (currentCard) updateQuickAddBar(currentCard);
}
function switchPeriod(period, el) {
  currentPeriod = period;
  document.querySelectorAll('.period-chip').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  if (currentCard) loadHistory(currentCard.id, period);
}

// ─── SNAPSHOT ────────────────────────────────────────
function buildSnapshot(card) {
  const nm = card.prices?.raw?.near_mint;
  const tcg = nm?.tcgplayer?.market;
  const e7 = nm?.ebay?.avg_7d;
  const psa10 = card.prices?.graded?.psa?.['10']?.ebay?.avg_7d;
  const psa9 = card.prices?.graded?.psa?.['9']?.ebay?.avg_7d;
  const flag = COUNTRY_FLAGS[sellerCountry]||'';
  const loc = sellerCountry==='CA'?`${sellerCountry} · ${sellerProvince}`:sellerCountry;
  snapshotText = `📊 CARDCOMP — ${card.name}
━━━━━━━━━━━━━━━━━━━━━━━━━━
Set:       ${card.set?.name||'—'}${card.number?' #'+card.number:''}
Game:      ${card.game?.name||'—'}
━━━━━━━━━━━━━━━━━━━━━━━━━━
TCGPlayer: ${tcg?fmt(tcg):'—'}
eBay 7D:   ${e7?fmt(e7):'—'}
PSA 10:    ${psa10?fmt(psa10):'—'}
PSA 9:     ${psa9?fmt(psa9):'—'}
━━━━━━━━━━━━━━━━━━━━━━━━━━
${flag} Fees: ${loc} · ${getTaxLabel()}
CardComp — cardcomp.io`;
}
function copySnap() {
  if (!snapshotText) return;
  navigator.clipboard.writeText(snapshotText).then(() => {
    const btn = document.getElementById('copyBtn');
    btn.textContent = '✓ COPIED!'; btn.classList.add('copied');
    setTimeout(() => { btn.textContent='📋 COPY SNAP'; btn.classList.remove('copied'); }, 2000);
  });
}

// ══════════════════════════════════════════════════════
// SECTION 3: CENTRALIZED FORMATTING + PRICING HELPERS
// ══════════════════════════════════════════════════════
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// formatMoney is the canonical name (per style guide); fmt() is kept as
// a short alias since it's used ~80 times throughout the app already.
function formatMoney(v) {
  if (!v && v !== 0) return '—';
  const converted = v * (fxRate || 1);
  const sym = currencySymbol || 'US$';
  const abs = Math.abs(converted).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return converted < 0 ? `-${sym}${abs}` : `${sym}${abs}`;
}
function fmt(v) { return formatMoney(v); }
// Compact variant for tight layouts (e.g. the 3-column portfolio card stat row) —
// drops the 2-letter country prefix ("US$"/"CA$" → "$") since the active currency
// is already shown once in the header; keeps non-letter symbols (£) as-is.
function fmtCompact(v) {
  if (!v && v !== 0) return '—';
  const converted = v * (fxRate || 1);
  const sym = (currencySymbol || 'US$').replace(/^[A-Z]{2}(?=\$)/, '');
  const abs = Math.abs(converted);
  // Drop cents above $1,000 — precision to the cent matters far less at that
  // range, and it's what keeps this fitting in the 3-column stat row.
  const formatted = abs >= 1000
    ? Math.round(abs).toLocaleString('en-US')
    : abs.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return converted < 0 ? `-${sym}${formatted}` : `${sym}${formatted}`;
}

function formatPercent(v, decimals = 1) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return `${Number(v).toFixed(decimals)}%`;
}

// Standard short date, e.g. "Jul 9, 2026" — used for card/refresh timestamps
function formatDate(value, opts) {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', opts || { month: 'short', day: 'numeric' });
}
// Longer date for printed offer sheets, e.g. "July 9, 2026"
function formatDateLong(value) {
  return formatDate(value, { year: 'numeric', month: 'long', day: 'numeric' });
}
// Offer sheet / share-text date stamps use en-CA locale (existing behavior, unchanged)
function formatOfferDate(long = false) {
  return long
    ? new Date().toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })
    : new Date().toLocaleDateString('en-CA');
}

const CONDITION_LABELS = {
  near_mint: 'NM',
  lightly_played: 'LP',
  moderately_played: 'MP',
  heavily_played: 'HP',
  damaged: 'DMG',
};
function formatConditionLabel(condition) {
  if (!condition) return 'NM';
  return CONDITION_LABELS[condition] || condition.replace(/_/g, ' ').toUpperCase();
}
function formatGradeLabel(grade) {
  if (!grade) return null;
  return String(grade).replace(/_/g, ' ').toUpperCase();
}
// Which grading company a stored grade value (e.g. "psa_10", "bgs_9.5") belongs to —
// used to color the collection badge with that grader's real authentication color.
function graderFromGrade(grade) {
  if (!grade) return null;
  const g = String(grade).toLowerCase();
  if (g.startsWith('psa')) return 'psa';
  if (g.startsWith('bgs')) return 'bgs';
  if (g.startsWith('cgc')) return 'cgc';
  return null;
}

function show(id,v) { document.getElementById(id)?.classList.toggle('hidden',!v); }
function setLoading(v) { show('loadingState',v); const sb=document.getElementById('searchBtn'); if(sb) sb.disabled=v; }
function showError(msg) { const el=document.getElementById('errorBox'); document.getElementById('errorMsg').textContent=msg; el.classList.remove('hidden'); }
function hideError() { document.getElementById('errorBox').classList.add('hidden'); }

// ─── HOME / NAVIGATION ───────────────────────────────
function goHome() {
  switchPage('collection');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── QUICK ADD TO PORTFOLIO ──────────────────────────
function updateQuickAddBar(card) {
  const isGraded = currentTab === 'graded';
  const graderLabels = {psa:'PSA',bgs:'BGS',cgc:'CGC'};

  // Use the condition relevant to whichever tab is active
  const activeCond = currentTab === 'ebay' ? currentEbayCond : currentTcgCond;

  let type = 'raw';
  let condition = null;
  let grade = null;
  let condDisplay = '';

  if (isGraded) {
    type = 'graded';
    grade = currentGrader + '_10';
    condDisplay = `${graderLabels[currentGrader] || 'PSA'} 10`;
  } else {
    condition = activeCond;
    condDisplay = formatConditionLabel(activeCond);
  }

  // Get the relevant price for this condition to show in quick-add
  let condPrice = null;
  if (!isGraded) {
    condPrice = card.prices?.raw?.[activeCond]?.tcgplayer?.market
      || card.prices?.raw?.[activeCond]?.ebay?.avg_7d;
  }

  document.getElementById('qaContext').innerHTML =
    `<strong>${esc(card.name||'—')}</strong> · <span style="color:var(--accent2)">${condDisplay}</span> · ${esc(card.set?.name||'')}${condPrice ? ` · <span style="color:var(--green);font-family:sans-serif;font-size:14px;">${fmt(condPrice)}</span>` : ''}`;

  // Store context for when user hits + ADD
  document._qaContext = { type, condition, grade };
}

function quickAddToPortfolio() {
  if (!currentCard) return;
  const cost = parseFloat(document.getElementById('qaCost').value) || 0;
  const qty = parseInt(document.getElementById('qaQty').value) || 1;
  const ctx = document._qaContext || {type:'raw', condition:'near_mint', grade:null};

  // ── Extract market value directly from currentCard (no extra API call needed) ──
  let marketValue = null;
  if (ctx.type === 'graded' && ctx.grade) {
    const parts = ctx.grade.split('_');
    const grader = parts[0];
    const grade = parts.slice(1).join('.');
    marketValue = currentCard.prices?.graded?.[grader]?.[grade]?.ebay?.avg_7d
      || currentCard.prices?.graded?.[grader]?.[grade]?.tcgplayer?.market;
  } else {
    const cond = ctx.condition || 'near_mint';
    marketValue = currentCard.prices?.raw?.[cond]?.tcgplayer?.market
      || currentCard.prices?.raw?.[cond]?.ebay?.avg_7d;
  }
  if (marketValue) marketValue *= qty;

  let afterFeeValue = null;
  if (marketValue) {
    const perCard = marketValue / qty;
    const {netPayout} = calcEbayPayout(perCard);
    afterFeeValue = netPayout * qty;
  }

  const card = {
    id: Date.now().toString(),
    name: currentCard.name,
    set: currentCard.set?.name || '',
    game: mapGame(currentCard.game?.name || ''),
    type: ctx.type,
    condition: ctx.condition,
    grade: ctx.grade,
    cost,
    qty,
    notes: currentCard.number ? '#' + currentCard.number : '',
    addedAt: new Date().toISOString(),
    marketValue,
    afterFeeValue,
    lastRefreshed: marketValue ? new Date().toISOString() : null,
    image: currentCard.image_url || null,
    apiId: currentCard.id,
  };

  const portfolio = loadPortfolio();
  portfolio.unshift(card);
  savePortfolioData(portfolio);
  updatePortCount();

  // Show success state on button
  const btn = document.querySelector('.quick-add-btn');
  if (btn) {
    btn.textContent = '✓ ADDED';
    btn.classList.add('success');
    setTimeout(() => {
      btn.textContent = '+ ADD';
      btn.classList.remove('success');
    }, 2500);
  }

  // Switch to collection so user can see it immediately
  switchPage('collection');
}

function mapGame(gameName) {
  const g = (gameName || '').toLowerCase();
  if (g.includes('pokemon') || g.includes('pokémon')) return 'pokemon';
  if (g.includes('magic')) return 'mtg';
  if (g.includes('yu-gi') || g.includes('yugi')) return 'yugioh';
  if (g.includes('one piece')) return 'onepiece';
  if (g.includes('lorcana')) return 'lorcana';
  return 'other';
}

// ─── PAGE SWITCHING ──────────────────────────────────
function switchPage(page) {
  const pages = {
    collection: 'pageCollection',
    search: 'pageSearch',
    pricer: 'pagePricer'
  };
  const navs = {
    collection: 'bnavCollection',
    search: 'bnavSearch',
    pricer: 'bnavPricer'
  };
  Object.entries(pages).forEach(([p, id]) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', p === page);
  });
  Object.entries(navs).forEach(([p, id]) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', p === page);
  });
  updatePortCount();
  if (page === 'collection') renderPortfolio();
  if (page === 'pricer') renderPricerItems();
}

function updatePortCount() {
  const count = loadPortfolio().length;
  const el = document.getElementById('portBadge');
  if (el) {
    el.textContent = count;
    el.classList.toggle('hidden', count === 0);
  }
  // Show/hide onboarding vs toolbar+grid
  const hasCards = count > 0;
  show('collOnboard', !hasCards);
  show('collHero', hasCards);
  show('collToolbar', hasCards);
}

// ─── PORTFOLIO DATA ───────────────────────────────────
function loadPortfolio() {
  return loadJSON('cc_portfolio', []);
}
function savePortfolioData(data) {
  saveJSON('cc_portfolio', data);
}

// ─── ADD CARD MODAL ───────────────────────────────────
function openAddCardModal() {
  document.getElementById('pcName').value = '';
  document.getElementById('pcSet').value = '';
  document.getElementById('pcApiId').value = '';
  document.getElementById('pcApiLinked').classList.add('hidden');
  document.getElementById('pcApiLinkedName').textContent = '';
  document.getElementById('pcCost').value = '';
  document.getElementById('pcQty').value = '1';
  document.getElementById('pcNotes').value = '';
  document.getElementById('pcType').value = 'raw';
  toggleGradeFields();
  document.getElementById('addCardModal').classList.remove('hidden');
  setTimeout(() => document.getElementById('pcName').focus(), 100);
}
function closeAddCardModal() {
  document.getElementById('addCardModal').classList.add('hidden');
}
document.getElementById('addCardModal').addEventListener('click', e => {
  if (e.target === document.getElementById('addCardModal')) closeAddCardModal();
});

function toggleGradeFields() {
  const isGraded = document.getElementById('pcType').value === 'graded';
  document.getElementById('pcConditionWrap').style.display = isGraded ? 'none' : 'block';
  document.getElementById('pcGradeWrap').style.display = isGraded ? 'block' : 'none';
}

function savePortfolioCard() {
  const name = document.getElementById('pcName').value.trim();
  if (!name) {
    document.getElementById('pcName').focus();
    document.getElementById('pcName').style.borderColor = 'var(--orange)';
    setTimeout(() => document.getElementById('pcName').style.borderColor = '', 1500);
    return;
  }
  const costRaw = document.getElementById('pcCost').value;
  const cost = costRaw === '' ? 0 : parseFloat(costRaw);
  const isGraded = document.getElementById('pcType').value === 'graded';
  const card = {
    id: Date.now().toString(),
    name,
    set: document.getElementById('pcSet').value.trim(),
    game: document.getElementById('pcGame').value,
    type: document.getElementById('pcType').value,
    condition: isGraded ? null : document.getElementById('pcCondition').value,
    grade: isGraded ? document.getElementById('pcGrade').value : null,
    cost: isNaN(cost) ? 0 : cost,
    qty: parseInt(document.getElementById('pcQty').value) || 1,
    notes: document.getElementById('pcNotes').value.trim(),
    addedAt: new Date().toISOString(),
    marketValue: null,
    afterFeeValue: null,
    lastRefreshed: null,
    image: null,
    apiId: null,
  };
  // If opened from a card detail page, use known API id + image
  if (document._pendingApiId) {
    card.apiId = document._pendingApiId;
    document._pendingApiId = null;
  }
  if (document._pendingImage) {
    card.image = document._pendingImage;
    document._pendingImage = null;
  }
  // If linked via Find Card button in the modal, use that apiId
  const modalApiId = document.getElementById('pcApiId')?.value?.trim();
  if (modalApiId) card.apiId = modalApiId;

  const portfolio = loadPortfolio();
  portfolio.unshift(card);
  savePortfolioData(portfolio);
  updatePortCount();
  closeAddCardModal();

  // Show confirmation on the Add to Portfolio button if we came from card detail
  const portBtn = document.getElementById('addToPortBtn');
  if (portBtn && currentCard && currentCard.name === card.name) {
    portBtn.textContent = '✓ Added!';
    portBtn.classList.add('added');
    setTimeout(() => {
      portBtn.innerHTML = '📦 Add to Portfolio';
      portBtn.classList.remove('added');
    }, 2500);
  }

  switchPage('collection');
  if (card.apiId) {
    refreshCardValue(card.id);
  }
}

// ─── RENDER PORTFOLIO ─────────────────────────────────
function renderPortfolio() {
  let portfolio = loadPortfolio();
  const filter = document.getElementById('portFilter').value;
  const sort = document.getElementById('portSort').value;

  if (filter !== 'all') portfolio = portfolio.filter(c => c.game === filter);

  portfolio.sort((a, b) => {
    if (sort === 'value_desc') return (b.marketValue||0) - (a.marketValue||0);
    if (sort === 'pnl_desc') return getPnl(b) - getPnl(a);
    if (sort === 'pnl_asc') return getPnl(a) - getPnl(b);
    if (sort === 'name') return a.name.localeCompare(b.name);
    return new Date(b.addedAt) - new Date(a.addedAt);
  });

  const all = loadPortfolio();
  updateSummary(all);

  const grid = document.getElementById('portGrid');
  const proBanner = document.getElementById('portProBanner');

  if (!portfolio.length) {
    show('portGrid', false);
    if (proBanner) show('portProBanner', false);
    return;
  }
  show('portGrid', true);
  if (proBanner) show('portProBanner', all.length >= 5);

  grid.innerHTML = '';
  portfolio.forEach(card => {
    grid.appendChild(buildCardEl(card));
  });
}

function getPnl(card) {
  const mv = card.marketValue || 0;
  const cost = (card.cost || 0) * (card.qty || 1);
  return mv - cost;
}

function updateSummary(portfolio) {
  const totalCards = portfolio.reduce((s,c) => s + (c.qty||1), 0);
  const totalCost = portfolio.reduce((s,c) => s + (c.cost||0) * (c.qty||1), 0);
  const totalMarket = portfolio.reduce((s,c) => s + (c.marketValue||0), 0);
  const totalAfterFee = portfolio.reduce((s,c) => s + (c.afterFeeValue||0), 0);
  const pnl = totalMarket ? (totalMarket - totalCost) : 0;
  const hasMv = portfolio.some(c => c.marketValue);
  const hero = document.getElementById('collHero');
  if (!portfolio.length) { if(hero) hero.classList.add('hidden'); return; }
  if(hero) hero.classList.remove('hidden');
  document.getElementById('heroMarket').textContent = hasMv ? fmt(totalMarket) : '—';
  document.getElementById('heroSub').textContent = `${totalCards} card${totalCards!==1?'s':''} in collection`;
  document.getElementById('heroCost').textContent = fmt(totalCost);
  document.getElementById('heroAfterFee').textContent = hasMv ? fmt(totalAfterFee) : '—';
  const pnlEl = document.getElementById('heroPnl');
  if (!hasMv) { pnlEl.textContent = '—'; pnlEl.className = 'port-hero-stat-val neutral'; }
  else {
    pnlEl.textContent = (pnl >= 0 ? '+' : '') + fmt(pnl);
    pnlEl.className = 'port-hero-stat-val ' + (pnl >= 0 ? 'profit' : 'loss');
  }
}

function buildCardEl(card) {
  const el = document.createElement('div');
  el.className = 'pc';
  el.id = 'pc-' + card.id;

  const totalCost = (card.cost||0) * (card.qty||1);
  const mv = card.marketValue;
  const afv = card.afterFeeValue;
  const pnl = mv ? mv - totalCost : null;
  const pnlPct = mv && totalCost ? ((mv-totalCost)/totalCost*100).toFixed(1) : null;

  const gradeLabel = formatGradeLabel(card.grade);
  const condLabel = card.condition ? formatConditionLabel(card.condition) : null;

  // img now handled inline in new card template

  const refreshed = card.lastRefreshed
    ? `<span style="font-family:monospace;font-size:9px;color:var(--muted2);">↻ ${formatDate(card.lastRefreshed)}</span>`
    : `<span style="font-family:'Instrument Mono',monospace;font-size:9px;color:var(--muted2);">Not yet refreshed</span>`;

  const imgHtml = card.image
    ? `<img class="pc-img" src="${esc(card.image)}" alt="${esc(card.name)}" onerror="this.style.display='none'">`
    : `<div class="pc-img-ph">🃏</div>`;
  el.innerHTML = `
    <div class="pc-img-area">
      ${imgHtml}
      <div class="pc-badges-overlay">
        ${card.type==='graded'?`<span class="pcb pcb-graded pcb-${graderFromGrade(card.grade)||'graded'}">${esc(gradeLabel||'GRADED')}</span>`:`<span class="pcb pcb-raw">${condLabel||'RAW'}</span>`}
      </div>
    </div>
    <div class="pc-data">
      <div class="pc-card-header">
        <div class="pc-card-name">${esc(card.name)}${card.qty>1?` <span style="color:var(--muted);font-size:11px;">×${card.qty}</span>`:''}</div>
        <div class="pc-card-meta">${esc(card.set||'—')} · <span style="color:var(--accent2)">${esc(card.game||'')}</span></div>
      </div>
      <div class="pc-prices">
        <div class="pcp"><div class="pcp-label">Cost</div><div class="pcp-val neutral">${fmtCompact(totalCost)}</div></div>
        <div class="pcp"><div class="pcp-label">Market</div><div class="pcp-val green">${mv?fmtCompact(mv):'—'}</div></div>
        <div class="pcp"><div class="pcp-label">After Fees</div><div class="pcp-val blue">${afv?fmtCompact(afv):'—'}</div></div>
      </div>
      <div class="pc-pnl">
        <div class="pc-pnl-label">Unrealized P&L</div>
        <div class="pc-pnl-val ${pnl===null?'neutral':pnl>=0?'profit':'loss'}">${pnl===null?'—':(pnl>=0?'+':'')+fmt(pnl)+(pnlPct?` <span style="font-size:11px;font-family:monospace;">(${pnlPct}%)</span>`:'')}</div>
      </div>
      <div class="pc-refresh">${card.lastRefreshed?'↻ '+formatDate(card.lastRefreshed):'Not refreshed yet'}</div>
      <div class="pc-actions">
        <button class="pc-action comp" onclick="searchCardComp('${esc(card.name)}','${esc(card.game)}')">🔍 COMPS</button>
        <button class="pc-action" onclick="refreshCardValue('${card.id}')">↻ REFRESH</button>
        <button class="pc-action danger" onclick="removePortfolioCard('${card.id}')">✕ REMOVE</button>
      </div>
    </div>`;
  return el;
}

// ─── REFRESH CARD VALUE ───────────────────────────────
async function refreshCardValue(cardId) {
  const portfolio = loadPortfolio();
  const card = portfolio.find(c => c.id === cardId);
  if (!card) return;

  const el = document.getElementById('pc-' + cardId);
  if (el) el.classList.add('refreshing');

  try {
    let detail;
    if (card.apiId) {
      // Fast path — we already know the API id, skip search entirely
      const detailRes = await fetch(`${WORKER_URL}/v1/cards/${card.apiId}`);
      if (!detailRes.ok) throw new Error('Detail failed');
      detail = await detailRes.json();
    } else {
      // Slow path — search first then fetch detail
      const game = card.game !== 'other' ? card.game : '';
      const searchQ = normalizeQuery(card.name + (card.set ? ' ' + card.set : ''));
      let url = `${WORKER_URL}/v1/cards/search?q=${encodeURIComponent(searchQ)}&limit=5`;
      if (game) url += `&game=${game}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Search failed');
      const data = await res.json();
      const results = data.data || [];
      if (!results.length) throw new Error('Card not found');
      const topResult = results[0];
      const detailRes = await fetch(`${WORKER_URL}/v1/cards/${topResult.id}`);
      if (!detailRes.ok) throw new Error('Detail failed');
      detail = await detailRes.json();
      card.apiId = topResult.id;
    }

    // Extract market value based on type
    let marketValue = null;
    if (card.type === 'graded' && card.grade) {
      const parts = card.grade.split('_');
      const grader = parts[0]; // psa, bgs, cgc
      const grade = parts.slice(1).join('.');
      marketValue = detail.prices?.graded?.[grader]?.[grade]?.ebay?.avg_7d
        || detail.prices?.graded?.[grader]?.[grade]?.tcgplayer?.market;
    } else {
      const cond = card.condition || 'near_mint';
      marketValue = detail.prices?.raw?.[cond]?.tcgplayer?.market
        || detail.prices?.raw?.[cond]?.ebay?.avg_7d;
    }

    if (marketValue) marketValue *= (card.qty || 1);

    // Calculate after-fee value
    let afterFeeValue = null;
    if (marketValue) {
      const perCard = marketValue / (card.qty || 1);
      const {netPayout} = calcEbayPayout(perCard);
      afterFeeValue = netPayout * (card.qty || 1);
    }

    // Update card
    card.marketValue = marketValue;
    card.afterFeeValue = afterFeeValue;
    card.lastRefreshed = new Date().toISOString();
    if (detail.image_url) card.image = detail.image_url;

    savePortfolioData(portfolio);
    renderPortfolio();
  } catch(e) {
    console.warn('Refresh failed for', card.name, e.message);
    if (el) el.classList.remove('refreshing');
  }
}

async function refreshAllValues() {
  const portfolio = loadPortfolio();
  for (const card of portfolio) {
    await refreshCardValue(card.id);
    await new Promise(r => setTimeout(r, 600)); // rate limit spacing
  }
}

// ─── REMOVE CARD ──────────────────────────────────────
function removePortfolioCard(cardId) {
  if (!confirm('Remove this card from your portfolio?')) return;
  const portfolio = loadPortfolio().filter(c => c.id !== cardId);
  savePortfolioData(portfolio);
  renderPortfolio();
}

// ─── JUMP TO COMPS ────────────────────────────────────
function searchCardComp(name, game) {
  switchPage('search');
  document.getElementById('searchInput').value = name;
  // selectedGame set via chip — reset chips to All
  selectGame(document.querySelector('.game-chip[data-game=""]'));
  doSearch();
}

// ─── WELCOME + FEEDBACK ──────────────────────────────
function dismissWelcome() {
  safeSessionSet('cc_welcomed', '1');
  document.getElementById('welcomeModal').classList.add('hidden');
}
function openFeedbackModal(presetType) {
  const heading = document.getElementById('feedbackHeading');
  const intro = document.getElementById('feedbackIntro');
  const typeSelect = document.getElementById('feedbackType');
  if (presetType === 'waitlist') {
    typeSelect.value = 'waitlist';
    heading.textContent = 'Join the Pro Waitlist';
    intro.textContent = "Drop your email and we'll let you know the moment CardComp Pro is ready.";
  } else {
    typeSelect.value = 'general';
    heading.textContent = 'Beta Feedback';
    intro.textContent = "What's working? What's missing? What would make you use this every day?";
  }
  document.getElementById('feedbackModal').classList.remove('hidden');
}
function closeFeedbackModal() {
  document.getElementById('feedbackModal').classList.add('hidden');
}
async function submitFeedback() {
  const text = document.getElementById('feedbackText').value.trim();
  const type = document.getElementById('feedbackType').value;
  const email = document.getElementById('feedbackEmail').value.trim();
  const sendBtn = document.getElementById('feedbackSendBtn');
  const errorEl = document.getElementById('feedbackError');

  if (!text) {
    document.getElementById('feedbackText').focus();
    errorEl.textContent = 'Please enter some feedback before sending.';
    errorEl.classList.remove('hidden');
    return;
  }

  // Loading state
  errorEl.classList.add('hidden');
  sendBtn.disabled = true;
  sendBtn.textContent = 'SENDING...';

  try {
    const res = await fetch('https://formspree.io/f/xojbwqgo', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        feedback_type: type,
        email: email || 'not provided',
        app_version: 'CardComp v7',
        country: sellerCountry + (sellerProvince ? ' · ' + sellerProvince : ''),
        submitted_at: new Date().toISOString(),
      })
    });

    if (res.ok) {
      // Success — show thank you state inside modal
      document.getElementById('feedbackForm').classList.add('hidden');
      document.getElementById('feedbackSuccess').classList.remove('hidden');
      // Reset for next time
      setTimeout(() => {
        document.getElementById('feedbackText').value = '';
        document.getElementById('feedbackEmail').value = '';
        document.getElementById('feedbackType').value = 'general';
        document.getElementById('feedbackForm').classList.remove('hidden');
        document.getElementById('feedbackSuccess').classList.add('hidden');
        closeFeedbackModal();
      }, 2800);
    } else {
      const data = await res.json();
      const msg = data?.errors?.[0]?.message || 'Something went wrong. Try again.';
      errorEl.textContent = msg;
      errorEl.classList.remove('hidden');
      sendBtn.disabled = false;
      sendBtn.textContent = 'SEND FEEDBACK';
    }
  } catch(e) {
    errorEl.textContent = 'Network error — check your connection and try again.';
    errorEl.classList.remove('hidden');
    sendBtn.disabled = false;
    sendBtn.textContent = 'SEND FEEDBACK';
  }
}

// ─── CURRENCY ────────────────────────────────────────
const CURRENCY_INFO = {
  CA: { symbol: 'CA$', code: 'CAD' },
  US: { symbol: 'US$', code: 'USD' },
  UK: { symbol: '£',   code: 'GBP' },
  AU: { symbol: 'AU$', code: 'AUD' },
};

async function fetchFxRate() {
  const code = CURRENCY_INFO[sellerCountry]?.code || 'USD';
  if (code === 'USD') { fxRate = 1.0; currencySymbol = 'US$'; updateCurrencyBtn(); return; }
  try {
    const res = await fetch(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json`);
    const data = await res.json();
    const rate = data?.usd?.[code.toLowerCase()];
    if (rate) {
      fxRate = showingLocalCurrency ? rate : 1.0;
      currencySymbol = showingLocalCurrency ? (CURRENCY_INFO[sellerCountry]?.symbol || 'US$') : 'US$';
    }
  } catch(e) {
    fxRate = 1.0;
    currencySymbol = 'US$';
  }
  updateCurrencyBtn();
}

function toggleCurrency() {
  showingLocalCurrency = !showingLocalCurrency;
  const code = CURRENCY_INFO[sellerCountry]?.code || 'USD';
  if (code === 'USD') return; // no toggle needed for US
  if (showingLocalCurrency) {
    fetchFxRate().then(() => {
      if (currentCard) renderDetail(currentCard);
      renderPortfolio();
      renderPricerItems();
    });
  } else {
    fxRate = 1.0;
    currencySymbol = 'US$';
    updateCurrencyBtn();
    if (currentCard) renderDetail(currentCard);
    renderPortfolio();
    renderPricerItems();
  }
}

function updateCurrencyBtn() {
  const btn = document.getElementById('currencyToggleBtn');
  if (!btn) return;
  const code = CURRENCY_INFO[sellerCountry]?.code || 'USD';
  if (code === 'USD') { btn.classList.add('hidden'); return; }
  btn.classList.remove('hidden');
  btn.textContent = showingLocalCurrency
    ? `${CURRENCY_INFO[sellerCountry]?.symbol} ${code}`
    : `US$ USD`;
  btn.title = showingLocalCurrency ? 'Switch to USD' : `Switch to ${code}`;
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// COLLECTION PRICER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let offerPct = 70;
let pricerSelectedCard = null; // full card API data for currently selected card
// ── Load / Save session ───────────────────────────
function loadPricerSession() {
  return loadJSON('cc_pricer', []);
}
function savePricerSession(items) {
  saveJSON('cc_pricer', items);
}
function clearPricerSession() {
  if (!confirm('Clear this pricing session? This cannot be undone.')) return;
  savePricerSession([]);
  renderPricerItems();
}

// ── Offer slider ──────────────────────────────────
function onOfferSliderChange(val) {
  offerPct = parseInt(val);
  document.getElementById('offerPctDisplay').textContent = offerPct;
  // Update preset active states
  document.querySelectorAll('.offer-preset').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.textContent) === offerPct);
  });
  renderPricerItems();
}
function setOfferPct(pct) {
  offerPct = pct;
  document.getElementById('offerSlider').value = pct;
  document.getElementById('offerPctDisplay').textContent = pct;
  document.querySelectorAll('.offer-preset').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.textContent) === pct);
  });
  renderPricerItems();
}

// ── Pricer Search Modal ───────────────────────────
let psmGame = '';
let psmAllResults = [];
let psmPage = 1;
const PSM_PAGE_SIZE = 24;
let psmDebounce = null;
let psmMode = 'pricer'; // 'pricer' | 'collection'

function openPsm() {
  appState.psmMode = 'pricer';
  document.getElementById('psmOverlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('psmInput').focus(), 100);
}
function openPsmForCollection() {
  appState.psmMode = 'collection';
  // Pre-fill search with whatever name is already typed
  const existingName = document.getElementById('pcName').value.trim();
  document.getElementById('psmOverlay').classList.remove('hidden');
  const psmInput = document.getElementById('psmInput');
  if (existingName) {
    psmInput.value = existingName;
    // Pre-select the game chip to match the modal's selected game
    const game = document.getElementById('pcGame').value;
    document.querySelectorAll('.psm-chip').forEach(c => {
      c.classList.toggle('active', (c.dataset.game || '') === game);
    });
    appState.psmGame = game;
    runPsmSearch();
  }
  setTimeout(() => psmInput.focus(), 100);
}
function closePsm() {
  document.getElementById('psmOverlay').classList.add('hidden');
  appState.psmMode = 'pricer';
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!document.getElementById('psmOverlay').classList.contains('hidden')) { closePsm(); return; }
  }
});
function selectPsmGame(el) {
  document.querySelectorAll('.psm-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  psmGame = el.dataset.game || '';
}
function onPsmInput(val) {
  // No auto-search — saves API calls and prevents 429 errors
  // Search fires on Enter key or SEARCH button click only
}
async function runPsmSearch() {
  const q = document.getElementById('psmInput').value.trim();
  if (!q) return;
  const setFilter = document.getElementById('psmSetFilter').value.trim();
  const numFilter = document.getElementById('psmNumberFilter').value.trim();
  const rarFilter = document.getElementById('psmRarityFilter').value.trim();
  // Build query — name is primary, filters narrow it down
  // Keep them separate so the API can match each field correctly
  let fullQuery = normalizeQuery(q);
  if (setFilter) fullQuery += ' ' + normalizeQuery(setFilter);
  if (numFilter) fullQuery += ' ' + normalizeQuery(numFilter);
  if (rarFilter) fullQuery += ' ' + normalizeQuery(rarFilter);
  fullQuery = fullQuery.replace(/\s+/g, ' ').trim();
  const resultsEl = document.getElementById('psmResults');
  const btn = document.getElementById('psmSearchBtn');
  btn.disabled = true; btn.textContent = '...';
  resultsEl.innerHTML = '<div class="psm-loader"><div class="loader"></div><div style="font-family:monospace;font-size:11px;color:var(--muted);letter-spacing:2px;">SEARCHING ' + (psmGame ? psmGame.toUpperCase() : 'ALL GAMES') + '...</div></div>';
  try {
    let url = `${WORKER_URL}/v1/cards/search?q=${encodeURIComponent(fullQuery)}&limit=50`;
    if (psmGame) url += `&game=${psmGame}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API error ${res.status}`);
    const data = await res.json();
    psmAllResults = data.data || [];
    psmPage = 1;
    renderPsmResults();
  } catch(e) {
    const is429 = e.message.includes('429') || e.message.includes('Rate limit');
    const errMsg = is429
      ? '<b>Rate limit hit</b> — free tier is 100 searches/day. Resets at midnight. Upgrade to Starter ($19.99/mo) for 2,500/day.'
      : 'Search failed: ' + esc(e.message) + ' — check your connection.';
    resultsEl.innerHTML = '<div class="psm-empty" style="line-height:1.8;">' + errMsg + '</div>';
  } finally {
    btn.disabled = false; btn.textContent = 'SEARCH';
  }
}
function renderPsmResults() {
  const resultsEl = document.getElementById('psmResults');
  const cards = psmAllResults;
  if (!cards.length) {
    resultsEl.innerHTML = '<div class="psm-empty">No cards found.<br><small style="color:var(--muted2);line-height:1.8;">Try fewer keywords · Check spelling · For 1st edition try "Shadowless" or "1st Edition" in the Set filter</small></div>';
    return;
  }
  const totalPages = Math.ceil(cards.length / PSM_PAGE_SIZE);
  const start = (psmPage - 1) * PSM_PAGE_SIZE;
  const pageCards = cards.slice(start, start + PSM_PAGE_SIZE);
  let html = `<div class="psm-results-header"><div class="psm-results-count">${cards.length} result${cards.length !== 1 ? 's' : ''}</div>${totalPages > 1 ? `<div class="psm-results-page">Page ${psmPage} of ${totalPages}</div>` : ''}</div>`;
  html += '<div class="psm-grid">';
  pageCards.forEach(c => {
    const price = c.prices?.raw?.near_mint?.tcgplayer?.market || c.prices?.raw?.near_mint?.ebay?.avg_7d;
    const imgHtml = c.image_url
      ? `<img class="psm-card-img" src="${esc(c.image_url)}" alt="${esc(c.name)}" loading="lazy" onerror="this.outerHTML='<div class=psm-card-img-ph>🃏</div>'">`
      : '<div class="psm-card-img-ph">🃏</div>';
    const priceBadge = price
      ? `<div class="psm-price-badge"><div><div class="psm-price-badge-label">MARKET</div><div class="psm-price-badge-val">${fmt(price)}</div></div></div>`
      : `<div class="psm-no-price-badge">NO PRICE</div>`;
    html += `<div class="psm-card" onclick="psmSelectCard('${esc(c.id)}')">
      <div class="psm-card-img-wrap">${imgHtml}${priceBadge}</div>
      <div class="psm-card-info">
        <div class="psm-card-name">${esc(c.name)}</div>
        <div class="psm-card-set">${esc(c.set?.name||'—')}${c.number?' · #'+esc(c.number):''}</div>
      </div>
    </div>`;
  });
  html += '</div>';
  if (totalPages > 1) {
    const maxBtn = 7;
    let pages = [];
    if (totalPages <= maxBtn) pages = Array.from({length:totalPages},(_,i)=>i+1);
    else if (psmPage <= 4) pages = [1,2,3,4,5,'…',totalPages];
    else if (psmPage >= totalPages-3) pages = [1,'…',totalPages-4,totalPages-3,totalPages-2,totalPages-1,totalPages];
    else pages = [1,'…',psmPage-1,psmPage,psmPage+1,'…',totalPages];
    html += `<div class="psm-pagination"><button class="psm-page-btn" onclick="setPsmPage(${psmPage-1})" ${psmPage<=1?'disabled':''}>← Prev</button>${pages.map(p=>p==='…'?'<span class="psm-page-info">…</span>':`<button class="psm-page-btn ${p===psmPage?'active':''}" onclick="setPsmPage(${p})">${p}</button>`).join('')}<button class="psm-page-btn" onclick="setPsmPage(${psmPage+1})" ${psmPage>=totalPages?'disabled':''}>Next →</button></div>`;
  }
  resultsEl.innerHTML = html;
  resultsEl.scrollTop = 0;
}
function setPsmPage(p) {
  const total = Math.ceil(psmAllResults.length / PSM_PAGE_SIZE);
  if (p < 1 || p > total) return;
  psmPage = p;
  renderPsmResults();
}
async function psmSelectCard(cardId) {
  const cached = psmAllResults.find(c => c.id === cardId);
  const card = cached || null;

  if (appState.psmMode === 'collection') {
    // Fill the Add Card modal fields
    const fillCard = card || await fetch(`${WORKER_URL}/v1/cards/${cardId}`).then(r => r.json()).catch(() => null);
    if (!fillCard) { showToast('⚠️ Could not load that card — check your connection and try again'); return; }
    closePsm();
    fillCollectionFromCard(fillCard);
    return;
  }

  // Default: pricer mode
  if (card) {
    pricerSelectedCard = card;
    closePsm();
    showPricerSelected(pricerSelectedCard);
    fetch(`${WORKER_URL}/v1/cards/${cardId}`)
      .then(r => r.ok ? r.json() : null)
      .then(full => { if (full) { pricerSelectedCard = full; updatePricerSelPrice(); } })
      .catch(() => {});
    return;
  }
  const btn = document.getElementById('psmSearchBtn');
  btn.disabled = true; btn.textContent = '...';
  try {
    const res = await fetch(`${WORKER_URL}/v1/cards/${cardId}`);
    if (!res.ok) throw new Error('failed');
    pricerSelectedCard = await res.json();
    closePsm();
    showPricerSelected(pricerSelectedCard);
  } catch(e) {
    console.warn('Failed to load card:', e);
    showToast('⚠️ Could not load that card — check your connection and try again');
  } finally {
    btn.disabled = false; btn.textContent = 'SEARCH';
  }
}

function fillCollectionFromCard(card) {
  // Map game name to select value
  const gameMap = { pokemon:'pokemon', 'magic: the gathering':'mtg', mtg:'mtg', 'yu-gi-oh!':'yugioh', yugioh:'yugioh', 'one piece':'onepiece', lorcana:'lorcana' };
  const gameName = (card.game?.name || '').toLowerCase();
  const gameVal = gameMap[gameName] || 'other';

  document.getElementById('pcName').value = card.name || '';
  document.getElementById('pcSet').value = card.set?.name || '';
  document.getElementById('pcGame').value = gameVal;
  document.getElementById('pcApiId').value = card.id || '';

  // Show the linked badge
  const badge = document.getElementById('pcApiLinked');
  const badgeName = document.getElementById('pcApiLinkedName');
  badgeName.textContent = `Linked: ${card.name}${card.set?.name ? ' · ' + card.set.name : ''}${card.number ? ' #' + card.number : ''}`;
  badge.classList.remove('hidden');

  // Make sure add card modal is open
  document.getElementById('addCardModal').classList.remove('hidden');
  // Focus purchase price — that's what they need to fill next
  setTimeout(() => document.getElementById('pcCost').focus(), 100);
}

function clearPcApiLink() {
  document.getElementById('pcApiId').value = '';
  document.getElementById('pcApiLinked').classList.add('hidden');
  document.getElementById('pcApiLinkedName').textContent = '';
}
// Legacy stubs
async function doPricerSearch() { openPsm(); }
function onPricerSearchInput() {}

async function selectPricerCard(cardId) {
  document.getElementById('pricerSuggestions').classList.add('hidden');
  const btn = document.getElementById('pricerSearchBtn');
  btn.disabled = true; btn.textContent = '...';
  try {
    const res = await fetch(`${WORKER_URL}/v1/cards/${cardId}`);
    if (!res.ok) throw new Error('failed');
    pricerSelectedCard = await res.json();
    showPricerSelected(pricerSelectedCard);
  } catch(e) {
    console.warn('Failed to load card for pricer');
  } finally {
    btn.disabled = false; btn.textContent = 'FIND';
  }
}

function showPricerSelected(card) {
  const el = document.getElementById('pricerSelected');
  el.classList.add('visible');
  // Image
  const imgWrap = document.getElementById('pricerSelImg');
  imgWrap.innerHTML = card.image_url
    ? `<img class="psel-img" src="${esc(card.image_url)}" alt="${esc(card.name)}" onerror="this.outerHTML='<div class=psel-img-ph>🃏</div>'">`
    : `<div class="psel-img-ph">🃏</div>`;
  document.getElementById('pricerSelName').textContent = card.name;
  document.getElementById('pricerSelMeta').textContent =
    `${card.set?.name || ''} · ${card.game?.name || ''}${card.number ? ' · #' + card.number : ''}`;
  // Reset controls
  document.getElementById('pricerSelType').value = 'raw';
  document.getElementById('pricerSelQty').value = '1';
  onPricerTypeChange();
  updatePricerSelPrice();
  // Update search input if it exists (may not in modal flow)
  const psi = document.getElementById('pricerSearchInput');
  if (psi) psi.value = card.name;
}


function clearPricerSelected() {
  pricerSelectedCard = null;
  document.getElementById('pricerSelected').classList.remove('visible');
  document.getElementById('pricerSelPrice').textContent = '—';
  document.getElementById('pricerSelQty').value = '1';
  document.getElementById('pricerSelType').value = 'raw';
  onPricerTypeChange();
}
function onPricerTypeChange() {
  const isGraded = document.getElementById('pricerSelType').value === 'graded';
  document.getElementById('pricerCondWrap').classList.toggle('hidden', isGraded);
  document.getElementById('pricerGradeWrap').classList.toggle('hidden', !isGraded);
  updatePricerSelPrice();
}

function updatePricerSelPrice() {
  if (!pricerSelectedCard) return;
  const isGraded = document.getElementById('pricerSelType').value === 'graded';
  const qty = parseInt(document.getElementById('pricerSelQty').value) || 1;
  let price = null;
  if (isGraded) {
    const gradeVal = document.getElementById('pricerSelGrade').value; // e.g. psa_10
    const parts = gradeVal.split('_');
    const grader = parts[0];
    const grade = parts.slice(1).join('.');
    price = pricerSelectedCard.prices?.graded?.[grader]?.[grade]?.ebay?.avg_7d
      || pricerSelectedCard.prices?.graded?.[grader]?.[grade]?.tcgplayer?.market;
  } else {
    const cond = document.getElementById('pricerSelCond').value;
    price = pricerSelectedCard.prices?.raw?.[cond]?.tcgplayer?.market
      || pricerSelectedCard.prices?.raw?.[cond]?.ebay?.avg_7d;
  }
  const total = price ? price * qty : null;
  document.getElementById('pricerSelPrice').textContent = total ? fmt(total) : '—';
}

function addPricerCard() {
  if (!pricerSelectedCard) return;
  const isGraded = document.getElementById('pricerSelType').value === 'graded';
  const qty = parseInt(document.getElementById('pricerSelQty').value) || 1;
  const gradeVal = isGraded ? document.getElementById('pricerSelGrade').value : null;
  const cond = !isGraded ? document.getElementById('pricerSelCond').value : null;

  let price = null;
  let condLabel = '';
  if (isGraded && gradeVal) {
    const parts = gradeVal.split('_');
    const grader = parts[0];
    const grade = parts.slice(1).join('.');
    price = pricerSelectedCard.prices?.graded?.[grader]?.[grade]?.ebay?.avg_7d
      || pricerSelectedCard.prices?.graded?.[grader]?.[grade]?.tcgplayer?.market;
    condLabel = formatGradeLabel(gradeVal);
  } else if (cond) {
    price = pricerSelectedCard.prices?.raw?.[cond]?.tcgplayer?.market
      || pricerSelectedCard.prices?.raw?.[cond]?.ebay?.avg_7d;
    condLabel = formatConditionLabel(cond);
  }

  const item = {
    id: Date.now().toString(),
    type: 'card',
    name: pricerSelectedCard.name,
    set: pricerSelectedCard.set?.name || '',
    game: pricerSelectedCard.game?.name || '',
    number: pricerSelectedCard.number || '',
    image: pricerSelectedCard.image_url || null,
    isGraded,
    condLabel,
    qty,
    unitPrice: price || 0,
    totalPrice: (price || 0) * qty,
  };

  const session = loadPricerSession();
  session.push(item);
  savePricerSession(session);

  // Reset selected card UI
  document.getElementById('pricerSelected').classList.remove('visible');
  const psiClear = document.getElementById('pricerSearchInput');
  if (psiClear) psiClear.value = '';
  pricerSelectedCard = null;
  document.getElementById('pricerSelPrice').textContent = '—';

  renderPricerItems();
}

// ── Bulk section ──────────────────────────────────

function addBulkLine() {
  const count = parseInt(document.getElementById('bulkCount').value) || 0;
  const each = parseFloat(document.getElementById('bulkPriceEach').value) || 0;
  const label = document.getElementById('bulkLabel').value.trim() || 'Bulk Cards';
  if (!count || !each) return;

  const item = {
    id: Date.now().toString(),
    type: 'bulk',
    name: label,
    set: '',
    game: '',
    number: '',
    image: null,
    isGraded: false,
    condLabel: `${count} cards @ ${fmt(each)} each`,
    qty: count,
    unitPrice: each,
    totalPrice: count * each,
  };

  const session = loadPricerSession();
  session.push(item);
  savePricerSession(session);

  // Reset bulk inputs
  document.getElementById('bulkCount').value = '';
  document.getElementById('bulkPriceEach').value = '';
  document.getElementById('bulkLabel').value = '';
  document.getElementById('bulkPreviewTotal').textContent = '';

  renderPricerItems();
}

// ── Render items list ─────────────────────────────
function renderPricerItems() {
  const session = loadPricerSession();
  const listEl = document.getElementById('pricerItemsList');
  const countEl = document.getElementById('pricerItemCount');
  if (!listEl) return;

  // Totals
  const totalMarket = session.reduce((s, i) => s + (i.totalPrice || 0), 0);
  const totalOffer = totalMarket * (offerPct / 100);
  const totalCards = session.reduce((s, i) => s + (i.qty || 1), 0);

  document.getElementById('pricerTotalMarket').textContent = fmt(totalMarket);
  document.getElementById('pricerTotalOffer').textContent = fmt(totalOffer);
  document.getElementById('pricerCardCount').textContent = totalCards;
  countEl.textContent = `${session.length} item${session.length !== 1 ? 's' : ''}`;

  // Badge on nav
  const badge = document.getElementById('pricerBadge');
  if (badge) {
    badge.textContent = session.length;
    badge.classList.toggle('hidden', session.length === 0);
  }

  if (!session.length) {
    listEl.innerHTML = '<div class="pricer-empty">No cards added yet — search above to start pricing a collection.</div>';
    return;
  }

  listEl.innerHTML = '';

  // Column headers
  const header = document.createElement('div');
  header.style.cssText = 'display:grid;grid-template-columns:40px 1fr auto auto auto;gap:10px;padding:8px 16px;border-bottom:1px solid var(--border);';
  header.innerHTML = `
    <span></span>
    <span style="font-family:'Instrument Mono',monospace;font-size:8px;letter-spacing:2px;color:var(--muted2);text-transform:uppercase;">Card</span>
    <span style="font-family:'Instrument Mono',monospace;font-size:8px;letter-spacing:2px;color:var(--muted2);text-transform:uppercase;">Qty</span>
    <span style="font-family:'Instrument Mono',monospace;font-size:8px;letter-spacing:2px;color:var(--muted2);text-transform:uppercase;">Market</span>
    <span style="font-family:'Instrument Mono',monospace;font-size:8px;letter-spacing:2px;color:var(--accent2);text-transform:uppercase;">${offerPct}% Offer</span>
  `;
  listEl.appendChild(header);

  session.forEach(item => {
    const row = document.createElement('div');
    row.className = 'pricer-item';
    const imgHtml = item.image
      ? `<img class="pricer-item-img" src="${esc(item.image)}" alt="${esc(item.name||'')}" onerror="this.outerHTML='<div class=pricer-item-img-ph>🃏</div>'">`
      : `<div class="pricer-item-img-ph">${item.type === 'bulk' ? '📦' : '🃏'}</div>`;
    const offerAmt = (item.totalPrice || 0) * (offerPct / 100);
    row.innerHTML = `
      ${imgHtml}
      <div class="pricer-item-info">
        <div class="pricer-item-name">${esc(item.name)}</div>
        <div class="pricer-item-meta">${esc(item.set||'')}${item.number?' · #'+esc(item.number):''} · <span style="color:var(--accent2)">${esc(item.condLabel)}</span></div>
      </div>
      <div class="pricer-item-qty">×${item.qty}</div>
      <div class="pricer-item-market">${fmt(item.totalPrice)}</div>
      <div class="pricer-item-offer">${fmt(offerAmt)}</div>
      <button class="pricer-item-remove" onclick="removePricerItem('${item.id}')" title="Remove">✕</button>
    `;
    listEl.appendChild(row);
  });

  // Totals row
  const totalsRow = document.createElement('div');
  totalsRow.style.cssText = 'display:grid;grid-template-columns:40px 1fr auto auto auto;gap:10px;padding:12px 16px;border-top:2px solid var(--border2);background:var(--surface2);';
  totalsRow.innerHTML = `
    <span></span>
    <span style="font-family:'Bebas Neue',sans-serif;font-size:16px;letter-spacing:1px;color:var(--text);">TOTAL</span>
    <span style="font-family:'Instrument Mono',monospace;font-size:11px;color:var(--muted);">${totalCards} cards</span>
    <span style="font-family:'Bebas Neue',sans-serif;font-size:20px;color:var(--text);">${fmt(totalMarket)}</span>
    <span style="font-family:'Bebas Neue',sans-serif;font-size:20px;color:var(--accent2);">${fmt(totalOffer)}</span>
    <span></span>
  `;
  listEl.appendChild(totalsRow);
}

function removePricerItem(id) {
  const session = loadPricerSession().filter(i => i.id !== id);
  savePricerSession(session);
  renderPricerItems();
}

// ── Print offer sheet ─────────────────────────────
function printOffer() {
  const session = loadPricerSession();
  if (!session.length) { showToast('Add some cards first'); return; }

  const totalMarket = session.reduce((s, i) => s + (i.totalPrice || 0), 0);
  const totalOffer = totalMarket * (offerPct / 100);
  const totalCards = session.reduce((s, i) => s + (i.qty || 1), 0);
  const date = formatOfferDate(true);

  const rows = session.map(item => {
    const offerAmt = (item.totalPrice || 0) * (offerPct / 100);
    return `<tr>
      <td>${esc(item.name)}</td>
      <td>${esc(item.set||'—')}</td>
      <td>${esc(item.condLabel)}</td>
      <td style="text-align:center;">${item.qty}</td>
      <td style="text-align:right;">${item.unitPrice ? fmt(item.unitPrice) : '—'}</td>
      <td style="text-align:right;font-weight:600;">${fmt(item.totalPrice)}</td>
      <td style="text-align:right;color:#e05a00;font-weight:700;">${fmt(offerAmt)}</td>
    </tr>`;
  }).join('');

  const sheet = document.getElementById('printSheet');
  sheet.innerHTML = `
    <div style="max-width:800px;margin:0 auto;font-family:'Helvetica Neue',Arial,sans-serif;color:#111;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:24px;border-bottom:3px solid #111;padding-bottom:16px;">
        <div>
          <div style="font-size:28px;font-weight:800;letter-spacing:-0.5px;">CARDCOMP</div>
          <div style="font-size:12px;color:#666;margin-top:2px;">Collection Pricing Report</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:12px;color:#666;">${date}</div>
          <div style="font-size:12px;color:#666;margin-top:2px;">${totalCards} cards · ${offerPct}% offer</div>
        </div>
      </div>

      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:13px;">
        <thead>
          <tr style="border-bottom:2px solid #111;">
            <th style="text-align:left;padding:8px 6px;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Card</th>
            <th style="text-align:left;padding:8px 6px;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Set</th>
            <th style="text-align:left;padding:8px 6px;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Grade/Cond</th>
            <th style="text-align:center;padding:8px 6px;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Qty</th>
            <th style="text-align:right;padding:8px 6px;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Unit</th>
            <th style="text-align:right;padding:8px 6px;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Market</th>
            <th style="text-align:right;padding:8px 6px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#e05a00;">Offer (${offerPct}%)</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>

      <div style="border-top:3px solid #111;padding-top:16px;display:flex;justify-content:space-between;align-items:flex-end;">
        <div>
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#666;margin-bottom:4px;">Total Market Value</div>
          <div style="font-size:28px;font-weight:800;">${fmt(totalMarket)}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#666;margin-bottom:4px;">My Offer (${offerPct}% of market)</div>
          <div style="font-size:36px;font-weight:800;color:#e05a00;">${fmt(totalOffer)}</div>
        </div>
      </div>

      <div style="margin-top:20px;padding-top:12px;border-top:1px solid #ddd;font-size:11px;color:#999;">
        Prices sourced from TCGPlayer and eBay sold listings via CardComp. Market values are estimates and may vary. Generated ${date}.
      </div>
    </div>
  `;

  window.print();
}

// ── Shared offer summary text builder (used by copy + share) ──
function buildOfferSummaryText() {
  const session = loadPricerSession();
  if (!session.length) return null;
  const totalMarket = session.reduce((s, i) => s + (i.totalPrice || 0), 0);
  const totalOffer = totalMarket * (offerPct / 100);
  const date = formatOfferDate();
  const lines = session.map(i => {
    const offerAmt = (i.totalPrice || 0) * (offerPct / 100);
    return `${i.name}${i.set ? ' (' + i.set + ')' : ''} · ${i.condLabel} ×${i.qty} · Market: ${fmt(i.totalPrice)} · Offer: ${fmt(offerAmt)}`;
  });
  return `CARDCOMP — Collection Offer (${date})
${'─'.repeat(44)}
${lines.join('\n')}
${'─'.repeat(44)}
Total Market: ${fmt(totalMarket)}
My Offer (${offerPct}%): ${fmt(totalOffer)}

Prices from TCGPlayer/eBay via CardComp`;
}

// ── Copy offer as text ────────────────────────────
function copyOfferText() {
  const text = buildOfferSummaryText();
  if (!text) { showToast('Add some cards first'); return; }
  navigator.clipboard.writeText(text).then(() => {
    showToast('📋 Copied to clipboard!');
    const btn = document.querySelector('.pricer-action-btn:nth-child(2)');
    if (btn) { const orig = btn.innerHTML; btn.innerHTML = '✓ COPIED!'; setTimeout(() => btn.innerHTML = orig, 2000); }
  });
}

// ── Bulk margin preview ───────────────────────────
function updateBulkPreview() {
  const count = parseInt(document.getElementById('bulkCount').value) || 0;
  const price = parseFloat(document.getElementById('bulkPriceEach').value) || 0;
  const margin = parseFloat(document.getElementById('bulkMargin').value);
  const totalMarket = count * price;
  const hint = document.getElementById('bulkMarginHint');
  const tot = document.getElementById('bulkPreviewTotal');
  if (totalMarket > 0) {
    tot.textContent = `Market: ${fmt(totalMarket)}`;
  } else {
    tot.textContent = '';
  }
  if (totalMarket > 0 && margin > 0 && margin < 100) {
    const maxOffer = totalMarket * (1 - margin / 100);
    hint.textContent = `At ${margin}% margin → max offer: ${fmt(maxOffer)} (${fmt(maxOffer / count)} per card)`;
    hint.style.display = 'block';
  } else {
    hint.style.display = 'none';
  }
}

// ── Manual sports/other card entry ───────────────
function addManualCard() {
  const name = document.getElementById('manualCardName').value.trim();
  const set = document.getElementById('manualCardSet').value.trim();
  const cond = document.getElementById('manualCardCond').value;
  const price = parseFloat(document.getElementById('manualCardPrice').value) || 0;
  const qty = parseInt(document.getElementById('manualCardQty').value) || 1;
  if (!name) { document.getElementById('manualCardName').focus(); return; }
  if (!price) { document.getElementById('manualCardPrice').focus(); return; }

  const session = loadPricerSession();
  session.push({
    id: 'manual_' + Date.now(),
    name,
    set: set || '—',
    number: '',
    condLabel: cond,
    type: 'manual',
    unitPrice: price,
    totalPrice: price * qty,
    qty,
    image: null,
    source: '🔍 manual',
  });
  savePricerSession(session);
  renderPricerItems();
  // Clear fields
  document.getElementById('manualCardName').value = '';
  document.getElementById('manualCardSet').value = '';
  document.getElementById('manualCardPrice').value = '';
  document.getElementById('manualCardQty').value = '1';
  showToast('✓ Card added to session');
}

// ── Share offer as text (Web Share API → clipboard fallback) ──
function shareOfferText() {
  const text = buildOfferSummaryText();
  if (!text) { showToast('Add some cards first'); return; }

  if (navigator.share) {
    navigator.share({ title: 'CardComp Offer', text }).catch(() => {});
  } else {
    navigator.clipboard.writeText(text).then(() => showToast('📋 Copied to clipboard!'));
  }
}



// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ROI CALCULATOR MODAL
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let roiModalGrade = '9'; // currently selected grade in modal
let roiModalGrader = 'psa'; // psa / bgs / cgc

function openRoiModal() {
  if (!currentCard) return;
  const card = currentCard;

  // Set card identity in modal header
  const imgWrap = document.getElementById('roiModalCardImg');
  imgWrap.innerHTML = card.image_url
    ? `<img class="roi-modal-card-img" src="${esc(card.image_url)}" alt="${esc(card.name||'')}" onerror="this.outerHTML='<div class=roi-modal-card-img-ph>🃏</div>'">`
    : '<div class="roi-modal-card-img-ph">🃏</div>';
  document.getElementById('roiModalCardName').textContent = card.name || 'Unknown Card';
  document.getElementById('roiModalCardSet').textContent =
    (card.set?.name || '') + (card.number ? ' · #' + card.number : '') + ' · ' + (card.game?.name || '');

  // Build grade strip from available data
  buildRoiGradeStrip(card);

  // Reset inputs
  document.getElementById('roiModalCost').value = '';
  document.getElementById('roiModalShipping').value = '12';
  document.getElementById('roiModalPromo').value = '0';

  // Auto-fill sale price from PSA 9 if available
  const psa9 = card.prices?.graded?.psa?.['9']?.ebay?.avg_7d;
  const psa10 = card.prices?.graded?.psa?.['10']?.ebay?.avg_7d;
  const tcgNm = card.prices?.raw?.near_mint?.tcgplayer?.market;
  if (psa9) {
    document.getElementById('roiModalSale').value = psa9.toFixed(2);
    roiModalGrade = '9'; roiModalGrader = 'psa';
  } else if (psa10) {
    document.getElementById('roiModalSale').value = psa10.toFixed(2);
    roiModalGrade = '10'; roiModalGrader = 'psa';
  } else if (tcgNm) {
    // No graded data — use raw NM as starting point
    document.getElementById('roiModalSale').value = tcgNm.toFixed(2);
  }

  // Reset verdict
  resetRoiVerdict();
  calcRoiModal();

  document.getElementById('roiModalOverlay').classList.remove('hidden');
}

function closeRoiModal() {
  document.getElementById('roiModalOverlay').classList.add('hidden');
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!document.getElementById('roiModalOverlay').classList.contains('hidden')) { closeRoiModal(); return; }
  }
});
document.getElementById('roiModalOverlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('roiModalOverlay')) closeRoiModal();
});

function buildRoiGradeStrip(card) {
  const strip = document.getElementById('roiGradeStrip');
  const graders = ['psa','bgs','cgc'];
  const grades = ['10','9.5','9','8.5','8','7'];
  const graderLabels = {psa:'PSA',bgs:'BGS',cgc:'CGC'};
  let items = [];

  graders.forEach(grader => {
    const gdata = card.prices?.graded?.[grader];
    if (!gdata) return;
    grades.forEach(g => {
      const price = gdata[g]?.ebay?.avg_7d || gdata[g]?.tcgplayer?.market;
      items.push({ grader, grade: g, price, label: graderLabels[grader] + ' ' + g });
    });
  });

  // If no graded data at all, show grade options without prices
  if (!items.length) {
    ['PSA 10','PSA 9','PSA 8.5','PSA 8','BGS 9.5','BGS 9'].forEach(lbl => {
      const parts = lbl.split(' ');
      items.push({ grader: parts[0].toLowerCase(), grade: parts[1], price: null, label: lbl });
    });
  }

  strip.innerHTML = items.map(item => {
    const isSelected = item.grader === roiModalGrader && item.grade === roiModalGrade;
    return `<div class="gsi ${isSelected ? 'selected' : ''}"
      onclick="selectRoiGrade('${item.grader}','${item.grade}',${item.price || 0})">
      <div class="gsi-grade">${item.label}</div>
      <div class="gsi-price ${item.price ? '' : 'na'}">${item.price ? fmt(item.price) : 'No data'}</div>
    </div>`;
  }).join('');
}

function selectRoiGrade(grader, grade, price) {
  roiModalGrade = grade;
  roiModalGrader = grader;
  // Update selected state
  document.querySelectorAll('.gsi').forEach(el => el.classList.remove('selected'));
  event.currentTarget.classList.add('selected');
  // Set sale price if available
  if (price > 0) {
    document.getElementById('roiModalSale').value = price.toFixed(2);
  }
  calcRoiModal();
}

function resetRoiVerdict() {
  const v = document.getElementById('roiModalVerdict');
  v.className = 'roi-verdict-banner empty';
  document.getElementById('roiModalBadge').textContent = 'ENTER DETAILS';
  document.getElementById('roiModalMsg').textContent = 'Fill in what you paid and expected sale price to see if grading is worth it.';
  document.getElementById('roiModalPct').textContent = '—';
}

function calcRoiModal() {
  const fx = fxRate || 1; // current display currency rate vs USD
  // User types in display currency (e.g. CA$) — convert to USD for math
  const rawCostDisplay = parseFloat(document.getElementById('roiModalCost').value) || 0;
  const salePriceDisplay = parseFloat(document.getElementById('roiModalSale').value) || 0;
  const shippingDisplay = parseFloat(document.getElementById('roiModalShipping').value) || 0;
  const graderKey = document.getElementById('roiModalGrader').value;
  const promoRate = parseFloat(document.getElementById('roiModalPromo').value) || 0;

  // Convert inputs to USD for internal math
  const rawCost = rawCostDisplay / fx;
  const salePrice = salePriceDisplay / fx;
  const shipping = shippingDisplay / fx;
  const gradingFee = getGradingFee(graderKey); // grading fees are always USD

  if (!salePrice) { resetRoiVerdict(); return; }

  const totalCosts = rawCost + gradingFee + shipping;
  const {fvfAmount, taxOnFees, promoFee, fixed, totalFees, netPayout} = calcEbayPayout(salePrice, promoRate);
  const netProfit = netPayout - totalCosts;
  const roi = totalCosts > 0 ? (netProfit / totalCosts) * 100 : (netPayout > 0 ? 100 : 0);
  const breakEven = calcBreakEven(totalCosts, promoRate);

  // Verdict
  let badge, msg, cls;
  if (!rawCost) {
    // No cost entered — just show take-home
    badge = 'TAKE-HOME';
    msg = `After all eBay fees you would pocket ${fmt(netPayout)} from a ${fmt(salePrice)} sale.`;
    cls = netPayout > 0 ? 'good' : 'skip';
  } else if (roi >= 50) {
    badge = 'STRONG GRADE';
    msg = `${roi.toFixed(0)}% ROI — strong submission. Even grading down one level you likely still profit.`;
    cls = 'strong';
  } else if (roi >= 20) {
    badge = 'GRADE IT';
    msg = `${roi.toFixed(0)}% ROI — solid. Covers all costs with meaningful upside.`;
    cls = 'good';
  } else if (roi >= 0) {
    badge = 'MARGINAL';
    msg = `${roi.toFixed(0)}% ROI — tight. A grade lower than expected could put you in the red. Break even at ${fmt(breakEven)}.`;
    cls = 'marginal';
  } else {
    badge = 'SKIP IT';
    msg = `${roi.toFixed(0)}% ROI — grading costs exceed projected sale. Hold raw or wait for market to move. Break even at ${fmt(breakEven)}.`;
    cls = 'skip';
  }

  const v = document.getElementById('roiModalVerdict');
  v.className = 'roi-verdict-banner ' + cls;
  document.getElementById('roiModalBadge').textContent = badge;
  document.getElementById('roiModalMsg').textContent = msg;
  document.getElementById('roiModalPct').textContent = rawCost ? roi.toFixed(0) + '%' : fmt(netPayout);

  // Stats
  const profitCls = netProfit >= 0 ? 'profit' : 'loss';
  const profitEl = document.getElementById('roiModalProfit');
  profitEl.textContent = fmt(netProfit);
  profitEl.className = 'roi-stat-val ' + (rawCost ? profitCls : 'neutral');
  document.getElementById('roiModalCosts').textContent = fmt(totalCosts);
  document.getElementById('roiModalBreak').textContent = fmt(breakEven);

  // Fee breakdown
  document.getElementById('roiModalFeeLines').innerHTML = roiFeeBreakdownHtml({rawCost, gradingFee, graderKey, shipping, fvfAmount, taxOnFees, promoFee, promoRate, fixed, netProfit});
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SHOW MODE — Card show/convention display optimizations
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let showModeActive = false;
let wakeLock = null;

async function toggleShowMode() {
  appState.showModeActive = !appState.showModeActive;
  document.body.classList.toggle('show-mode', appState.showModeActive);

  const btn = document.getElementById('showModeBtn');
  if (btn) btn.textContent = appState.showModeActive ? 'DISABLE' : 'ENABLE';

  if (appState.showModeActive) {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch(e) { /* intentional: unsupported/denied wake lock shouldn't block or alarm the user */ }
    showToast('🏪 Show Mode on — screen will stay awake');
  } else {
    if (wakeLock) { wakeLock.release(); wakeLock = null; }
    showToast('Show Mode off');
  }
}

// Re-acquire wake lock if page becomes visible again (e.g. switching apps)
document.addEventListener('visibilitychange', async () => {
  if (appState.showModeActive && document.visibilityState === 'visible') {
    try {
      if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    } catch(e) { /* intentional: unsupported/denied wake lock shouldn't block or alarm the user */ }
  }
});

function showToast(msg) {
  let t = document.getElementById('showModeToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'showModeToast';
    t.className = 'show-mode-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('visible');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('visible'), 2500);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// OFFLINE PRICE CACHE — show stale prices when offline
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const PRICE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

function cacheCardPrice(cardId, data) {
  const cache = loadJSON('cc_price_cache', {});
  cache[cardId] = { data, ts: Date.now() };
  // Keep cache lean — max 200 cards
  const keys = Object.keys(cache);
  if (keys.length > 200) {
    keys.sort((a, b) => cache[a].ts - cache[b].ts).slice(0, 50).forEach(k => delete cache[k]);
  }
  saveJSON('cc_price_cache', cache);
}

function getCachedCard(cardId) {
  const cache = loadJSON('cc_price_cache', {});
  const entry = cache[cardId];
  if (!entry) return null;
  return { data: entry.data, stale: (Date.now() - entry.ts) > PRICE_CACHE_TTL, age: Date.now() - entry.ts };
}

function formatAge(ms) {
  const h = Math.floor(ms / 3600000);
  if (h < 1) return '<1h ago';
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h/24)}d ago`;
}

// ─── SEARCH ACCURACY HELPERS ─────────────────────────
// Strips card number patterns, normalizes special chars, trims whitespace
// so "Charizard 4/102" → "Charizard", "Farfetch'd" → "Farfetchd"
function normalizeQuery(q) {
  return q
    .replace(/\d+\/\d+/g, '')          // strip number patterns e.g. 4/102
    .replace(/[''`]/g, '')              // strip smart quotes and apostrophes
    .replace(/[^\w\s\-\.]/g, ' ')      // replace special chars with space
    .replace(/\s+/g, ' ')              // collapse whitespace
    .trim();
}

// ══════════════════════════════════════════════════════
// SECTION 4: SHARED APP STATE (appState)
// ──────────────────────────────────────────────────────
// This is a facade over the app's existing standalone state
// variables (currentCard, currentTab, sellerCountry, etc).
// Each property is a getter/setter that reads/writes the
// SAME underlying variable already used everywhere else in
// the app — so appState.currentCard and the bare variable
// currentCard are always in sync; they are literally the
// same value, not a separate copy.
//
// Why a facade instead of a full rename: this app has ~28
// state variables referenced across 150+ call sites with no
// automated test suite / real browser available in this
// environment. A blind rename risks silently breaking a
// call site that's hard to catch without live testing. The
// facade gives every future code change a single, clear
// place to read/write state (appState.x) while guaranteeing
// zero behavior change today. New code should prefer
// appState.x going forward.
// ══════════════════════════════════════════════════════
const appState = {
  // Card / search state
  get currentCard() { return currentCard; }, set currentCard(v) { currentCard = v; },
  get currentTab() { return currentTab; }, set currentTab(v) { currentTab = v; },
  get currentTcgCond() { return currentTcgCond; }, set currentTcgCond(v) { currentTcgCond = v; },
  get currentEbayCond() { return currentEbayCond; }, set currentEbayCond(v) { currentEbayCond = v; },
  get currentGrader() { return currentGrader; }, set currentGrader(v) { currentGrader = v; },
  get currentPeriod() { return currentPeriod; }, set currentPeriod(v) { currentPeriod = v; },
  get selectedGame() { return selectedGame; }, set selectedGame(v) { selectedGame = v; },
  // Search results pagination (brief calls this currentPageIndex to avoid
  // colliding with "current page/tab" terminology)
  get currentPageIndex() { return currentPage; }, set currentPageIndex(v) { currentPage = v; },
  get searchResults() { return searchResults; }, set searchResults(v) { searchResults = v; },
  get allSearchResults() { return allSearchResults; }, set allSearchResults(v) { allSearchResults = v; },
  // Country / currency / tax
  get sellerCountry() { return sellerCountry; }, set sellerCountry(v) { sellerCountry = v; },
  get sellerProvince() { return sellerProvince; }, set sellerProvince(v) { sellerProvince = v; },
  get fxRate() { return fxRate; }, set fxRate(v) { fxRate = v; },
  get currencySymbol() { return currencySymbol; }, set currencySymbol(v) { currencySymbol = v; },
  get showingLocalCurrency() { return showingLocalCurrency; }, set showingLocalCurrency(v) { showingLocalCurrency = v; },
  // Pricer (Search modal + session)
  get psmGame() { return psmGame; }, set psmGame(v) { psmGame = v; },
  get psmMode() { return psmMode; }, set psmMode(v) { psmMode = v; },
  get psmPage() { return psmPage; }, set psmPage(v) { psmPage = v; },
  get psmAllResults() { return psmAllResults; }, set psmAllResults(v) { psmAllResults = v; },
  get offerPct() { return offerPct; }, set offerPct(v) { offerPct = v; },
  get pricerSelectedCard() { return pricerSelectedCard; }, set pricerSelectedCard(v) { pricerSelectedCard = v; },
  // ROI modal
  get roiModalGrade() { return roiModalGrade; }, set roiModalGrade(v) { roiModalGrade = v; },
  get roiModalGrader() { return roiModalGrader; }, set roiModalGrader(v) { roiModalGrader = v; },
  // Show Mode
  get showModeActive() { return showModeActive; }, set showModeActive(v) { showModeActive = v; },
  // History chart
  get chartInstance() { return chartInstance; }, set chartInstance(v) { chartInstance = v; },
  get historyCache() { return historyCache; }, set historyCache(v) { historyCache = v; },
};

document.addEventListener('DOMContentLoaded', () => {
  refreshApiStatus();
  refreshCountryUI();
  updatePortCount();
  fetchFxRate();
  renderRecentSearches();
  renderPricerItems();
  
  // ── Browser back/forward button support ──
  window.addEventListener('popstate', (e) => {
    const state = e.state;
    if (!state || state.view === 'home') {
      show('detailSection', false);
      show('searchSection', false);
      show('emptyState', true);
      show('errorBox', false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (state.view === 'search') {
      show('detailSection', false);
      if (searchResults.length) {
        show('emptyState', false);
        renderSearchList(searchResults, currentPage);
      } else {
        show('emptyState', true);
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (state.view === 'detail' && state.cardId) {
      if (currentCard && currentCard.id === state.cardId) {
        // Already loaded — just re-show
        show('searchSection', false);
        show('emptyState', false);
        show('detailSection', true);
      } else {
        loadCard(state.cardId);
      }
    }
  });
  // Show welcome screen for first-time visitors only
  if (!safeSessionGet('cc_welcomed')) {
    setTimeout(() => document.getElementById('welcomeModal').classList.remove('hidden'), 400);
  }
});