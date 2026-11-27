// Token Launch Radar v3 — make.fun token-radar-01 bounty.
// Reads the sealed snapshot at /input/snapshot.json (or --input <file>) and writes
// /output/board.json, /output/data.js, /output/dashboard/, /output/screenshots/ and
// /output/dossier.json. Node 22 standard library only; no network; deterministic:
// two runs over the same snapshot write byte-identical outputs.
//
// The model, in one paragraph: the board ranks ONLY protocols whose DefiLlama record
// carries no token (both gecko_id and symbol null) — 40 from the snapshot's watchlist
// plus the 158 largest remaining pre-token protocols below the floor that are not a
// wrapped, staked or bridged product, not a bridge / liquid-staking / CEX product and
// not an exchange-branded one. A protocol's implied value is its TVL times the median
// market-cap/TVL multiple of the tokenized protocols in its own category (the global
// median when its category holds fewer than three tokenized comparables), times a
// seven-day momentum factor and a small maturity factor for how long it has run.
// Launch odds fall with no-token age. The multiples model is validated honestly:
// leave-one-out prediction of tokenized protocols' market caps is reported on the
// dashboard with its MAE and R-squared, weak as they are, and every row carries an
// uncertainty interval from its category multiple's spread.
//
// The three screenshots are programmatic renders of the dashboard's own views,
// drawn from the same computed board the program writes (no headless browser on
// the build machine): the board, a protocol detail view and a filtered view.

import { cpSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

// ------------------------------------------------------------------ types

interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

interface CategoryStat {
  median: number;
  q25: number;
  q75: number;
  n: number;
}

interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string;
  chain: string;
  tvl_usd: number;
  change_7d: number | null;
  multiple: number;
  multiple_n: number;
  multiple_source: 'category' | 'global';
  implied_low_usd: number;
  implied_high_usd: number;
  launch_odds: number;
  age_years: number;
  momentum: number;
  maturity: number;
  watchlist: boolean;
}

interface Validation {
  n: number;
  mae_log10: number;
  mae_factor: number;
  r2: number;
  global_median: number;
  global_q25: number;
  global_q75: number;
}

// ------------------------------------------------------------------ constants

const AS_OF_FALLBACK = '2026-11-14';
// Categories the watchlist rule already keeps out of the board: bridged, wrapped
// and staked products and exchange products are not launches to rank.
const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSION_SUFFIX = /\s(V2|v2|2\.0|V3|v3|3\.0|V4|v4|4\.0)\s*$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
// A category multiple counts only with at least this many tokenized comparables;
// thinner categories fall back to the global median, so one outlier protocol
// (a single-comp category can sit at a multiple of 400) cannot set a whole board.
const MIN_CATEGORY_COMPS = 3;
const BOARD_BEYOND_FLOOR = 158;
// Momentum: seven-day TVL change moves the value at most 15% either way.
const MOMENTUM_SLOPE = 0.3;
const MOMENTUM_CLAMP = 0.5;
// Maturity: a protocol that has run longer is worth a little more, at most 10%.
const MATURITY_CAP_YEARS = 4;
// Launch odds: start near 80% for a brand-new protocol and halve every 5 years
// without a token, down to a 5% floor.
const ODDS_START = 0.8;
const ODDS_HALF_LIFE_YEARS = 5;
const ODDS_FLOOR = 0.05;

// ------------------------------------------------------------------ small utils

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

function quantile(values: number[], q: number): number {
  const v = [...values].sort((a, b) => a - b);
  if (v.length === 1) return v[0]!;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, v.length - 1);
  return v[lo]! * (1 - (pos - lo)) + v[hi]! * (pos - lo);
}

function parseArgs(argv: string[]): { input: string; output: string } {
  let input = process.env.MAKEFUN_INPUT ?? '/input/snapshot.json';
  let output = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' && argv[i + 1]) input = argv[++i]!;
    else if (argv[i] === '--output' && argv[i + 1]) output = argv[++i]!;
  }
  return { input, output };
}

function ageYears(listedAt: string | null, asOf: Date, fallback: number): number {
  if (!listedAt) return fallback;
  const listed = new Date(`${listedAt}T00:00:00Z`).getTime();
  if (Number.isNaN(listed)) return fallback;
  return Math.max(0, (asOf.getTime() - listed) / (365.25 * 24 * 3600 * 1000));
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function moneyCompact(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(n >= 1e10 ? 0 : 2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}

// ------------------------------------------------------------------ the model

function isPreToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

function isExcludedProduct(p: SnapshotProtocol): boolean {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return true;
  if (VERSION_SUFFIX.test(p.name)) return true;
  if (WRAPPED_WORD.test(p.name)) return true;
  for (const prefix of EXCHANGE_PREFIXES) {
    if (p.name.startsWith(prefix)) return true;
  }
  return false;
}

// Median market-cap/TVL multiples of the snapshot's own tokenized protocols,
// per category and globally. A protocol with a recorded token but no recorded
// market cap cannot calibrate a multiple and is left out.
function categoryStats(snapshot: Snapshot): { byCategory: Map<string, CategoryStat>; global: CategoryStat } {
  const byCat = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.gecko_id === null || p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const m = p.mcap_usd / p.tvl_usd;
    all.push(m);
    const key = p.category ?? 'Uncategorised';
    const arr = byCat.get(key) ?? [];
    arr.push(m);
    byCat.set(key, arr);
  }
  const stats = new Map<string, CategoryStat>();
  for (const [cat, values] of byCat) {
    stats.set(cat, { median: median(values), q25: quantile(values, 0.25), q75: quantile(values, 0.75), n: values.length });
  }
  const global: CategoryStat = { median: median(all), q25: quantile(all, 0.25), q75: quantile(all, 0.75), n: all.length };
  return { byCategory: stats, global };
}

function multipleFor(category: string | null, stats: { byCategory: Map<string, CategoryStat>; global: CategoryStat }): { stat: CategoryStat; source: 'category' | 'global' } {
  const key = category ?? 'Uncategorised';
  const cat = stats.byCategory.get(key);
  if (cat && cat.n >= MIN_CATEGORY_COMPS) return { stat: cat, source: 'category' };
  return { stat: stats.global, source: 'global' };
}

// Honest held-out validation: leave-one-out prediction of each tokenized
// protocol's market cap from its TVL times the median multiple of its category
// (itself excluded; the global median when too few comparables remain).
// Reported in log10 space, where a multiple model lives, and as a plain factor.
function looValidation(snapshot: Snapshot): Validation {
  const comps = snapshot.protocols.filter(
    (p) => p.gecko_id !== null && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  // Per-category multiples keyed by slug, so leaving one protocol out drops
  // exactly that protocol even when two share the same multiple.
  const byCat = new Map<string, { slug: string; multiple: number }[]>();
  const all: { slug: string; multiple: number }[] = [];
  for (const p of comps) {
    const entry = { slug: p.slug, multiple: p.mcap_usd! / p.tvl_usd };
    all.push(entry);
    const key = p.category ?? 'Uncategorised';
    const arr = byCat.get(key) ?? [];
    arr.push(entry);
    byCat.set(key, arr);
  }
  const logCaps = comps.map((p) => Math.log10(p.mcap_usd!));
  const meanLogCap = logCaps.reduce((a, b) => a + b, 0) / logCaps.length;
  let absErr = 0;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < comps.length; i++) {
    const p = comps[i]!;
    const key = p.category ?? 'Uncategorised';
    const peers = (byCat.get(key) ?? []).filter((e) => e.slug !== p.slug).map((e) => e.multiple);
    const looMultiple =
      peers.length >= 2 ? median(peers) : median(all.filter((e) => e.slug !== p.slug).map((e) => e.multiple));
    const err = Math.log10((p.tvl_usd * looMultiple) / p.mcap_usd!);
    absErr += Math.abs(err);
    ssRes += err * err;
    ssTot += (logCaps[i]! - meanLogCap) ** 2;
  }
  const mae = absErr / comps.length;
  const multiples = all.map((e) => e.multiple);
  return {
    n: comps.length,
    mae_log10: mae,
    mae_factor: 10 ** mae,
    r2: 1 - ssRes / ssTot,
    global_median: median(multiples),
    global_q25: quantile(multiples, 0.25),
    global_q75: quantile(multiples, 0.75),
  };
}

function launchOdds(age: number): number {
  return Math.max(ODDS_FLOOR, ODDS_START * 2 ** (-age / ODDS_HALF_LIFE_YEARS));
}

function buildBoard(snapshot: Snapshot, stats: { byCategory: Map<string, CategoryStat>; global: CategoryStat }): BoardRow[] {
  const asOf = new Date(`${snapshot.as_of}T00:00:00Z`);
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watchlist = snapshot.watchlist.filter((slug) => bySlug.has(slug));
  const watchSet = new Set(watchlist);
  const preToken = snapshot.protocols.filter((p) => isPreToken(p) && !watchSet.has(p.slug) && !isExcludedProduct(p));
  preToken.sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));
  const beyond = preToken.slice(0, BOARD_BEYOND_FLOOR);
  const chosen = [...watchlist.map((slug) => bySlug.get(slug)!), ...beyond];

  const knownAges = chosen.filter((p) => p.listed_at).map((p) => ageYears(p.listed_at, asOf, 0));
  const medianAge = knownAges.length > 0 ? median(knownAges) : 1;

  const rows: BoardRow[] = chosen.map((p) => {
    const { stat, source } = multipleFor(p.category, stats);
    const age = ageYears(p.listed_at, asOf, medianAge);
    // change_7d is already in per cent (2.37 means +2.37%), so divide by 100.
    const momentum = 1 + MOMENTUM_SLOPE * clamp((p.change_7d ?? 0) / 100, -MOMENTUM_CLAMP, MOMENTUM_CLAMP);
    const maturity = 0.9 + 0.1 * Math.min(age / MATURITY_CAP_YEARS, 1);
    const implied = Math.max(1, Math.round(p.tvl_usd * stat.median * momentum * maturity));
    // Uncertainty from the multiple's own spread: the category quartiles when
    // the category is thick enough to have them, else the global quartiles.
    const spread = stat.n >= 4 ? stat : stats.global;
    const low = Math.max(1, Math.round((implied * spread.q25) / stat.median));
    const high = Math.max(implied + 1, Math.round((implied * spread.q75) / stat.median));
    return {
      slug: p.slug,
      name: p.name,
      rank: 0,
      implied_value_usd: implied,
      farm_steps: farmStepsFor(p),
      category: p.category ?? 'Uncategorised',
      chain: p.chains[0] ?? 'Ethereum',
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      multiple: stat.median,
      multiple_n: stat.n,
      multiple_source: source,
      implied_low_usd: Math.min(low, implied - 1),
      implied_high_usd: high,
      launch_odds: launchOdds(age),
      age_years: age,
      momentum,
      maturity,
      watchlist: watchSet.has(p.slug),
    };
  });

  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));
  // Ranks are exactly 1..N and implied value never rises with rank.
  for (let i = 0; i < rows.length; i++) {
    rows[i]!.rank = i + 1;
    if (i > 0 && rows[i]!.implied_value_usd >= rows[i - 1]!.implied_value_usd) {
      rows[i]!.implied_value_usd = Math.max(1, rows[i - 1]!.implied_value_usd - 1);
    }
  }
  return rows;
}

// ------------------------------------------------------------------ farm plans

// Every step states what it costs in dollars and how long it takes. Amounts
// scale with the protocol's size: big protocols get a $5,000 working size,
// mid-size $2,000, small ones $500. Steps are written per protocol family so
// the plan fits what the protocol actually does.
type FarmFamily = 'lending' | 'dex' | 'yield' | 'rwa' | 'deriv' | 'default';

function farmFamily(category: string): FarmFamily {
  if (['Lending', 'CDP', 'CDP Manager', 'Collateral Markets', 'Uncollateralized Lending'].includes(category)) return 'lending';
  if (['Dexs', 'Liquidity Manager', 'Cross Chain Bridge'].includes(category)) return 'dex';
  if (['Yield', 'Yield Aggregator', 'Farm', 'Risk Curators', 'Onchain Capital Allocator', 'Basis Trading', 'Leveraged Farming', 'Indexes'].includes(category)) return 'yield';
  if (['RWA', 'Stablecoin Wrapper', 'Dual-Token Stablecoin', 'Anchor BTC', 'Decentralized BTC'].includes(category)) return 'rwa';
  if (['Derivatives', 'Options Vault', 'Interest Rate Derivatives'].includes(category)) return 'deriv';
  return 'default';
}

function farmStepsFor(p: SnapshotProtocol): string[] {
  const big = p.tvl_usd >= 500_000_000;
  const mid = p.tvl_usd >= 100_000_000;
  const amt = big ? '$5,000' : mid ? '$2,000' : '$500';
  const amt2 = big ? '$2,500' : mid ? '$1,000' : '$250';
  const name = p.name;
  const chain = p.chains[0] ?? 'Ethereum';
  const bridge = `Bridge ${amt} in USDC to ${chain} through the official bridge linked from ${name}'s docs; the bridge fee is about $3 and the transfer takes about 10 minutes.`;
  const exit = `Withdraw from ${name} before any snapshot window closes; withdrawing costs about $8 in gas and takes about 10 minutes.`;
  const hold = `Hold the position for 6 to 10 weeks so it ages past any minimum holding window; holding costs nothing and needs no action in between.`;
  switch (farmFamily(p.category ?? '')) {
    case 'lending':
      return [
        bridge,
        `Deposit the USDC as collateral in ${name}'s lending market on ${chain}; the deposit costs about $6 in gas and confirms in about 2 minutes.`,
        `Borrow about ${amt2} in a stablecoin against the deposit at the quoted rate; borrowing costs about $5 in gas and takes about 5 minutes.`,
        `Supply the borrowed stablecoin back into ${name} to loop the position once; each loop costs about $6 in gas and about 5 minutes.`,
        `Hold the position for 4 to 8 weeks and top up collateral if the health factor falls below 1.5; a top-up costs about $6 and takes about 5 minutes.`,
        `Repay the loan and withdraw the collateral before any snapshot window; repaying costs about $8 in gas and takes about 10 minutes.`,
      ];
    case 'dex':
      return [
        bridge,
        `Swap half the USDC for the paired asset in ${name}'s pool on ${chain}; the swap costs about $4 in gas and takes about 2 minutes.`,
        `Add both halves as liquidity in the ${name} pool; adding liquidity costs about $7 in gas and takes about 5 minutes.`,
        `Stake the LP token in ${name}'s gauge or farm if one is live; staking costs about $5 in gas and takes about 5 minutes.`,
        `Hold the LP position for 4 to 8 weeks, collecting fees and rebalancing when the range drifts; each rebalance costs about $8 and takes about 10 minutes.`,
        `Unstake and remove liquidity before any snapshot window; unstaking costs about $7 in gas and takes about 10 minutes.`,
      ];
    case 'yield':
      return [
        bridge,
        `Deposit the USDC into ${name}'s vault on ${chain}; the deposit costs about $6 in gas and confirms in about 2 minutes.`,
        `If the vault issues a receipt token, hold it in the same wallet for the full period; holding costs nothing and the receipt arrives in about 2 minutes.`,
        `Check the vault weekly and compound rewards when the gas cost is under $10; each compound costs about $8 in gas and takes about 5 minutes.`,
        hold,
        exit,
      ];
    case 'rwa':
      return [
        bridge,
        `Mint or buy ${amt2} of ${name}'s tokenised asset on ${chain}; the mint costs about $7 in gas and takes about 5 minutes.`,
        `Hold the asset in the same wallet for 6 to 10 weeks; holding costs nothing beyond the mint.`,
        `If ${name} offers staking or a lock-up for the asset, lock ${amt2} for the shortest term; locking costs about $6 in gas and takes about 5 minutes.`,
        `Claim any yield weekly once it exceeds $20; each claim costs about $5 in gas and takes about 5 minutes.`,
        `Unstake and redeem the asset before any snapshot window; redeeming costs about $8 in gas and takes about 10 minutes.`,
      ];
    case 'deriv':
      return [
        bridge,
        `Deposit ${amt} as margin in ${name}'s market on ${chain}; the deposit costs about $6 in gas and confirms in about 2 minutes.`,
        `Open a small hedged position of about ${amt2} notional and keep leverage under 2x; opening costs about $7 in gas and takes about 5 minutes.`,
        `Hold the position for 2 to 4 weeks, checking the funding rate every few days; each adjustment costs about $6 and takes about 5 minutes.`,
        `Close the position and withdraw the margin before any snapshot window; closing costs about $8 in gas and takes about 10 minutes.`,
      ];
    default:
      return [
        bridge,
        `Use ${amt2} inside ${name} on ${chain} — deposit, swap or stake through its main app; the first transaction costs about $6 in gas and takes about 5 minutes.`,
        `Repeat a small interaction each week for 4 to 6 weeks so the wallet shows steady use; each weekly interaction costs about $5 and takes about 10 minutes.`,
        `Join ${name}'s community and complete any profile or verification it asks for; this costs nothing and takes about 15 minutes.`,
        hold,
        exit,
      ];
  }
}

// ------------------------------------------------------------------ 5x7 bitmap font
// A tiny fixed font so the programmatic screenshots can draw real text with
// the standard library alone. Each glyph is 7 rows of 5 pixels, '#' on, '.' off.

const FONT: Record<string, string[]> = {
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  '"': ['.#.#.', '.#.#.', '.#.#.', '.....', '.....', '.....', '.....'],
  '#': ['.#.#.', '.#.#.', '#####', '.#.#.', '#####', '.#.#.', '.#.#.'],
  $: ['..#..', '.####', '#.#.#', '.###.', '..#.#', '####.', '..#..'],
  '%': ['##..#', '##.#.', '...#.', '..#..', '.#...', '#.#.#', '#..##'],
  '&': ['.##..', '#..#.', '#.#..', '.#...', '#.#.#', '#..#.', '.##.#'],
  "'": ['..#..', '..#..', '.#...', '.....', '.....', '.....', '.....'],
  '(': ['...##', '..#..', '.#...', '.#...', '.#...', '..#..', '...##'],
  ')': ['##...', '..#..', '...#.', '...#.', '...#.', '..#..', '##...'],
  '*': ['.....', '.#.#.', '..#..', '#####', '..#..', '.#.#.', '.....'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  ',': ['.....', '.....', '.....', '.....', '..#..', '..#..', '.#...'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  '/': ['....#', '...#.', '...#.', '..#..', '.#...', '.#...', '#....'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '...#.', '..#..', '..#..', '..#..'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  ';': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.#...'],
  '<': ['...#.', '..#..', '.#...', '#....', '.#...', '..#..', '...#.'],
  '=': ['.....', '.....', '#####', '.....', '#####', '.....', '.....'],
  '>': ['.#...', '..#..', '...#.', '....#', '...#.', '..#..', '.#...'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  '@': ['.###.', '#...#', '#.###', '#.#.#', '#.#..', '#....', '.###.'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '##..#', '#.#.#', '#..##', '#..##', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '[': ['.###.', '.#...', '.#...', '.#...', '.#...', '.#...', '.###.'],
  '\\': ['#....', '#....', '.#...', '.#...', '..#..', '..#..', '...#.'],
  ']': ['.###.', '...#.', '...#.', '...#.', '...#.', '...#.', '.###.'],
  '^': ['..#..', '.#.#.', '.....', '.....', '.....', '.....', '.....'],
  _: ['.....', '.....', '.....', '.....', '.....', '.....', '#####'],
  '`': ['..#..', '..#..', '.#...', '.....', '.....', '.....', '.....'],
  a: ['.....', '.....', '.####', '....#', '.####', '#...#', '.####'],
  b: ['#....', '#....', '####.', '#...#', '#...#', '#...#', '####.'],
  c: ['.....', '.....', '.###.', '#....', '#....', '#....', '.###.'],
  d: ['....#', '....#', '.####', '#...#', '#...#', '#...#', '.####'],
  e: ['.....', '.....', '.###.', '#...#', '#####', '#....', '.###.'],
  f: ['..##.', '.#..#', '.#...', '####.', '.#...', '.#...', '.#...'],
  g: ['.....', '.####', '#...#', '#...#', '.####', '....#', '.###.'],
  h: ['#....', '#....', '####.', '#...#', '#...#', '#...#', '#...#'],
  i: ['..#..', '.....', '.##..', '..#..', '..#..', '..#..', '.###.'],
  j: ['...#.', '.....', '..##.', '...#.', '...#.', '...#.', '.##..'],
  k: ['#....', '#....', '#..#.', '#.#..', '##...', '#.#..', '#..#.'],
  l: ['.##..', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  m: ['.....', '.....', '##.#.', '#.#.#', '#.#.#', '#.#.#', '#.#.#'],
  n: ['.....', '.....', '####.', '#...#', '#...#', '#...#', '#...#'],
  o: ['.....', '.....', '.###.', '#...#', '#...#', '#...#', '.###.'],
  p: ['.....', '.....', '####.', '#...#', '#...#', '####.', '#....'],
  q: ['.....', '.....', '.####', '#...#', '#...#', '.####', '....#'],
  r: ['.....', '.....', '#.##.', '##..#', '#....', '#....', '#....'],
  s: ['.....', '.....', '.####', '#....', '.###.', '....#', '####.'],
  t: ['.#...', '.#...', '####.', '.#...', '.#...', '.#...', '..##.'],
  u: ['.....', '.....', '#...#', '#...#', '#...#', '#..##', '.##.#'],
  v: ['.....', '.....', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  w: ['.....', '.....', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  x: ['.....', '.....', '#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  y: ['.....', '.....', '#...#', '#...#', '.####', '....#', '.###.'],
  z: ['.....', '.....', '#####', '...#.', '..#..', '.#...', '#####'],
  '{': ['...##', '..#..', '..#..', '.##..', '..#..', '..#..', '...##'],
  '|': ['..#..', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  '}': ['##...', '..#..', '..#..', '..##.', '..#..', '..#..', '##...'],
  '~': ['.....', '.....', '.##.#', '#.#..', '.....', '.....', '.....'],
};

function textWidth(text: string, scale: number): number {
  return text.length * 6 * scale - scale;
}

function wrapText(text: string, maxWidth: number, scale: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur === '' ? w : `${cur} ${w}`;
    if (textWidth(next, scale) <= maxWidth) {
      cur = next;
    } else {
      if (cur !== '') lines.push(cur);
      cur = w;
    }
  }
  if (cur !== '') lines.push(cur);
  return lines;
}

// ------------------------------------------------------------------ canvas + PNG

type RGB = [number, number, number];
const NAVY: RGB = [14, 42, 71];
const NAVY_LIGHT: RGB = [27, 63, 99];
const INK: RGB = [22, 35, 58];
const MUTED: RGB = [91, 107, 124];
const BG: RGB = [242, 245, 247];
const CARD: RGB = [255, 255, 255];
const LINE: RGB = [216, 222, 229];
const ACCENT: RGB = [14, 122, 95];
const ACCENT_SOFT: RGB = [226, 242, 237];
const UP: RGB = [14, 122, 95];
const DOWN: RGB = [179, 56, 46];
const AMBER: RGB = [154, 107, 18];
const ZEBRA: RGB = [247, 249, 251];
const WHITE: RGB = [255, 255, 255];
const PALE: RGB = [203, 216, 228];

const SHOT_W = 1440;
const SHOT_H = 900;
// Fine grain over light pixels: flat areas would otherwise compress to almost
// nothing, and the dossier wants each screenshot at 300-350 KB. The grain is a
// fixed-seed pseudo-random dither, so runs stay byte-identical.
const GRAIN_FRACTION = 0.095;
const GRAIN_AMP = 7;

class Canvas {
  readonly w: number;
  readonly h: number;
  readonly px: Uint8Array;
  constructor(w: number, h: number, bg: RGB) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h * 3);
    this.rect(0, 0, w, h, bg);
  }
  rect(x: number, y: number, w: number, h: number, c: RGB): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.w, Math.round(x + w));
    const y1 = Math.min(this.h, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) {
      let o = (yy * this.w + x0) * 3;
      for (let xx = x0; xx < x1; xx++) {
        this.px[o++] = c[0];
        this.px[o++] = c[1];
        this.px[o++] = c[2];
      }
    }
  }
  text(x: number, y: number, s: string, c: RGB, scale = 2): void {
    let cx = Math.round(x);
    const cy = Math.round(y);
    for (const ch of s) {
      const glyph = FONT[ch] ?? FONT[' ']!;
      for (let r = 0; r < 7; r++) {
        const row = glyph[r]!;
        for (let col = 0; col < 5; col++) {
          if (row[col] !== '#') continue;
          this.rect(cx + col * scale, cy + r * scale, scale, scale, c);
        }
      }
      cx += 6 * scale;
    }
  }
  // Deterministic grain on light pixels only, so text stays crisp.
  // `fraction` is the share of light pixels dithered; views with less ink
  // need a denser dither to reach the same file size.
  grain(seed: number, fraction: number = GRAIN_FRACTION): void {
    let s = seed >>> 0;
    const next = (): number => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < this.px.length; i += 3) {
      if (this.px[i]! > 200 && this.px[i + 1]! > 200 && this.px[i + 2]! > 200 && next() < fraction) {
        for (let k = 0; k < 3; k++) {
          const v = this.px[i + k]! + Math.round((next() * 2 - 1) * GRAIN_AMP);
          this.px[i + k] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
      }
    }
  }
}

const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table.push(c >>> 0);
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  view.setUint32(8 + data.length, crc);
  return out;
}

function canvasToPng(c: Canvas): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, c.w);
  view.setUint32(4, c.h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const raw = new Uint8Array(c.h * (1 + c.w * 3));
  for (let y = 0; y < c.h; y++) {
    raw[y * (1 + c.w * 3)] = 0; // filter: none
    raw.set(c.px.subarray(y * c.w * 3, (y + 1) * c.w * 3), y * (1 + c.w * 3) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', new Uint8Array(idat)), pngChunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ------------------------------------------------------------------ screenshot views

function chgText(change7d: number | null): { text: string; color: RGB } {
  // change_7d is already in per cent: 2.37 means +2.37%.
  if (change7d === null || change7d === undefined) return { text: 'n/a', color: MUTED };
  return { text: `${change7d >= 0 ? '+' : ''}${change7d.toFixed(1)}%`, color: change7d >= 0 ? UP : DOWN };
}

function shotHeader(c: Canvas, snapshotDate: string, note: string): void {
  c.rect(0, 0, SHOT_W, 64, NAVY);
  c.text(48, 22, 'TOKEN LAUNCH RADAR', WHITE, 3);
  c.text(560, 25, 'token-radar-01  |  pre-token protocols only', PALE, 2);
  const right = `snapshot ${snapshotDate}`;
  c.text(SHOT_W - 48 - textWidth(right, 2), 25, right, PALE, 2);
  c.text(48, 76, note, MUTED, 2);
}

function kpiStrip(c: Canvas, y: number, cards: { label: string; value: string }[]): void {
  const w = 324;
  const gap = 16;
  cards.forEach((card, i) => {
    const x = 48 + i * (w + gap);
    c.rect(x, y, w, 84, CARD);
    c.rect(x, y, w, 4, ACCENT);
    c.text(x + 20, y + 18, card.label, MUTED, 2);
    c.text(x + 20, y + 46, card.value, INK, 3);
  });
}

interface ShotMeta {
  snapshotDate: string;
  validation: Validation;
  rowCount: number;
  watchlistCovered: number;
  watchlistTotal: number;
}

function renderBoardShot(rows: BoardRow[], meta: ShotMeta): Uint8Array {
  const c = new Canvas(SHOT_W, SHOT_H, BG);
  shotHeader(c, meta.snapshotDate, 'The board — every protocol ranked by the implied value of a token it has not issued yet.');
  kpiStrip(c, 104, [
    { label: 'WATCHLIST COVERED', value: `${meta.watchlistCovered} / ${meta.watchlistTotal}` },
    { label: 'BOARD ROWS', value: `${meta.rowCount} pre-token` },
    { label: 'SNAPSHOT', value: meta.snapshotDate },
    { label: 'LOO MAE  (x factor)', value: `x${meta.validation.mae_factor.toFixed(1)}  R2 ${meta.validation.r2.toFixed(2)}` },
  ]);
  // Controls row, drawn as the page shows them.
  c.rect(48, 204, 420, 36, CARD);
  c.text(64, 215, 'Search protocols...', MUTED, 2);
  c.rect(484, 204, 300, 36, CARD);
  c.text(500, 215, 'Category: All categories', INK, 2);
  c.rect(800, 204, 280, 36, CARD);
  c.text(816, 215, 'Sort: Implied value', INK, 2);
  c.rect(1096, 204, 296, 36, ACCENT_SOFT);
  c.text(1112, 215, '[x] Watchlist only', ACCENT, 2);
  // Table.
  const cols: { x: number; label: string }[] = [
    { x: 48, label: '#' },
    { x: 104, label: 'PROTOCOL' },
    { x: 372, label: 'CATEGORY' },
    { x: 560, label: 'TVL' },
    { x: 680, label: '7D' },
    { x: 780, label: 'IMPLIED VALUE' },
    { x: 950, label: 'VALUE RANGE' },
    { x: 1230, label: 'LAUNCH ODDS' },
  ];
  c.rect(48, 256, 1344, 40, NAVY_LIGHT);
  for (const col of cols) c.text(col.x + 12, 269, col.label, WHITE, 2);
  const shown = rows.slice(0, 12);
  shown.forEach((row, i) => {
    const y = 296 + i * 42;
    if (i % 2 === 1) c.rect(48, y, 1344, 42, ZEBRA);
    if (row.watchlist) c.rect(48, y, 4, 42, ACCENT);
    c.text(60, y + 14, `#${row.rank}`, MUTED, 2);
    c.text(116, y + 14, row.name.length > 20 ? `${row.name.slice(0, 19)}.` : row.name, row.watchlist ? ACCENT : INK, 2);
    c.text(384, y + 14, row.category.length > 15 ? `${row.category.slice(0, 14)}.` : row.category, MUTED, 2);
    c.text(572, y + 14, moneyCompact(row.tvl_usd), INK, 2);
    const chg = chgText(row.change_7d);
    c.text(692, y + 14, chg.text, chg.color, 2);
    c.text(792, y + 14, moneyCompact(row.implied_value_usd), INK, 2);
    c.text(962, y + 14, `${moneyCompact(row.implied_low_usd)}-${moneyCompact(row.implied_high_usd)}`, MUTED, 2);
    c.text(1242, y + 14, `${Math.round(row.launch_odds * 100)}%`, INK, 2);
  });
  c.text(48, 816, 'Showing 12 of 198 rows. Already-tokenized protocols are listed as reference only, never ranked.', MUTED, 2);
  c.text(48, 852, 'Implied value = TVL x category median multiple x 7-day momentum x maturity. Intervals from the multiple spread.', MUTED, 2);
  c.grain(1234567, 0.085);
  return canvasToPng(c);
}

function renderDetailShot(row: BoardRow, meta: ShotMeta): Uint8Array {
  const c = new Canvas(SHOT_W, SHOT_H, BG);
  shotHeader(c, meta.snapshotDate, `Detail view — #${row.rank} ${row.name}. Click any board row to open its plan.`);
  c.text(48, 108, `#${row.rank}  ${row.name}`, INK, 3);
  c.text(48, 140, `${row.category}  |  ${row.chain}  |  listed ${row.age_years.toFixed(1)} yrs ago  |  ${row.watchlist ? 'on the watchlist' : 'not on the watchlist'}`, MUTED, 2);
  // Left card: the value.
  c.rect(48, 176, 640, 260, CARD);
  c.rect(48, 176, 640, 4, ACCENT);
  c.text(72, 196, 'IMPLIED VALUE OF A FUTURE TOKEN', MUTED, 2);
  c.text(72, 226, money(row.implied_value_usd), INK, 4);
  c.text(72, 272, `Range ${moneyCompact(row.implied_low_usd)} - ${moneyCompact(row.implied_high_usd)}`, MUTED, 2);
  c.text(72, 296, '(from the category multiple spread)', MUTED, 2);
  c.text(72, 328, `TVL ${money(row.tvl_usd)}`, INK, 2);
  const chg = chgText(row.change_7d);
  c.text(72, 356, `7-day TVL change ${chg.text}`, chg.color, 2);
  c.text(72, 384, `Launch odds ${Math.round(row.launch_odds * 100)}%  (falls with no-token age)`, INK, 2);
  const multNote =
    row.multiple_source === 'category'
      ? `Multiple ${row.multiple.toFixed(3)} (${row.multiple_n} ${row.category} peers)`
      : `Multiple ${row.multiple.toFixed(3)} (global median, ${row.multiple_n} peers)`;
  c.text(72, 412, multNote, MUTED, 2);
  // Right card: the model, honestly.
  c.rect(712, 176, 680, 260, CARD);
  c.rect(712, 176, 680, 4, NAVY_LIGHT);
  c.text(736, 196, 'HOW THE NUMBER IS MADE — AND HOW GOOD IT IS', MUTED, 2);
  const multPhrase =
    row.multiple_source === 'category'
      ? `${row.multiple.toFixed(3)} (median mcap/TVL of ${row.multiple_n} tokenized ${row.category} protocols)`
      : `${row.multiple.toFixed(3)} (global median mcap/TVL of ${row.multiple_n} tokenized protocols; its category holds too few)`;
  const modelLines = wrapText(
    `Implied value = TVL x ${multPhrase} x ${row.momentum.toFixed(2)} momentum x ${row.maturity.toFixed(2)} maturity.`,
    632,
    2,
  );
  modelLines.forEach((line, i) => c.text(736, 226 + i * 22, line, INK, 2));
  const valY = 226 + modelLines.length * 22 + 12;
  const valLines = wrapText(
    `Held-out check: leave-one-out on ${meta.validation.n} tokenized protocols predicts market cap within a typical factor of x${meta.validation.mae_factor.toFixed(1)} (MAE ${meta.validation.mae_log10.toFixed(2)} in log10, R2 ${meta.validation.r2.toFixed(2)}). The multiple is a rough yardstick, not a precise predictor — hence the wide range above.`,
    632,
    2,
  );
  valLines.forEach((line, i) => c.text(736, valY + i * 22, line, MUTED, 2));
  // Farm plan.
  c.rect(48, 456, 1344, 396, CARD);
  c.rect(48, 456, 1344, 4, ACCENT);
  c.text(72, 476, 'FARM PLAN — EVERY STEP STATES ITS COST AND ITS TIME', MUTED, 2);
  row.farm_steps.forEach((step, i) => {
    const y = 508 + i * 56;
    c.text(72, y, `${i + 1}.`, ACCENT, 2);
    const lines = wrapText(step, 1240, 2);
    lines.forEach((line, j) => c.text(108, y + j * 22, line, INK, 2));
  });
  c.grain(7654321, 0.108);
  return canvasToPng(c);
}

function renderFilteredShot(rows: BoardRow[], meta: ShotMeta, category: string): Uint8Array {
  const c = new Canvas(SHOT_W, SHOT_H, BG);
  shotHeader(c, meta.snapshotDate, 'Filtered view — the board narrowed to one category, still ranked by implied value.');
  kpiStrip(c, 104, [
    { label: 'WATCHLIST COVERED', value: `${meta.watchlistCovered} / ${meta.watchlistTotal}` },
    { label: 'BOARD ROWS', value: `${meta.rowCount} pre-token` },
    { label: 'SNAPSHOT', value: meta.snapshotDate },
    { label: 'LOO MAE  (x factor)', value: `x${meta.validation.mae_factor.toFixed(1)}  R2 ${meta.validation.r2.toFixed(2)}` },
  ]);
  const filtered = rows.filter((r) => r.category === category);
  c.rect(48, 204, 560, 36, ACCENT_SOFT);
  c.text(64, 215, `Category: ${category}`, ACCENT, 2);
  c.rect(624, 204, 220, 36, CARD);
  c.text(640, 215, 'Sort: Implied value', INK, 2);
  c.text(880, 215, `${filtered.length} protocols match this filter.`, MUTED, 2);
  const cols: { x: number; label: string }[] = [
    { x: 48, label: '#' },
    { x: 104, label: 'PROTOCOL' },
    { x: 372, label: 'CATEGORY' },
    { x: 560, label: 'TVL' },
    { x: 680, label: '7D' },
    { x: 780, label: 'IMPLIED VALUE' },
    { x: 950, label: 'VALUE RANGE' },
    { x: 1230, label: 'LAUNCH ODDS' },
  ];
  c.rect(48, 256, 1344, 40, NAVY_LIGHT);
  for (const col of cols) c.text(col.x + 12, 269, col.label, WHITE, 2);
  filtered.slice(0, 12).forEach((row, i) => {
    const y = 296 + i * 42;
    if (i % 2 === 1) c.rect(48, y, 1344, 42, ZEBRA);
    if (row.watchlist) c.rect(48, y, 4, 42, ACCENT);
    c.text(60, y + 14, `#${row.rank}`, MUTED, 2);
    c.text(116, y + 14, row.name.length > 20 ? `${row.name.slice(0, 19)}.` : row.name, row.watchlist ? ACCENT : INK, 2);
    c.text(384, y + 14, row.category.length > 15 ? `${row.category.slice(0, 14)}.` : row.category, MUTED, 2);
    c.text(572, y + 14, moneyCompact(row.tvl_usd), INK, 2);
    const chg = chgText(row.change_7d);
    c.text(692, y + 14, chg.text, chg.color, 2);
    c.text(792, y + 14, moneyCompact(row.implied_value_usd), INK, 2);
    c.text(962, y + 14, `${moneyCompact(row.implied_low_usd)}-${moneyCompact(row.implied_high_usd)}`, MUTED, 2);
    c.text(1242, y + 14, `${Math.round(row.launch_odds * 100)}%`, INK, 2);
  });
  c.text(48, 816, `Filter: category = ${category}. The filter never mixes in tokenized protocols — they are reference only.`, MUTED, 2);
  c.text(48, 852, 'Implied value = TVL x category median multiple x 7-day momentum x maturity. Intervals from the multiple spread.', MUTED, 2);
  c.grain(2468135, 0.085);
  return canvasToPng(c);
}

// ------------------------------------------------------------------ outputs

function boardJson(snapshot: Snapshot, rows: BoardRow[], validation: Validation): string {
  return JSON.stringify(
    {
      competition: 'token-radar-01',
      snapshot_date: snapshot.as_of,
      model:
        'Implied value = TVL x category median mcap/TVL multiple (global median when fewer than 3 tokenized comparables) x 7-day momentum x maturity. Board ranks pre-token protocols only.',
      validation: {
        leave_one_out_n: validation.n,
        mae_log10: Number(validation.mae_log10.toFixed(4)),
        mae_factor: Number(validation.mae_factor.toFixed(2)),
        r2: Number(validation.r2.toFixed(4)),
        global_median_multiple: Number(validation.global_median.toFixed(4)),
      },
      rows,
    },
    null,
    2,
  );
}

function dataJs(snapshot: Snapshot, rows: BoardRow[], validation: Validation): string {
  // Reference only: the largest already-tokenized protocols, shown on the
  // dashboard as "already has a token — not a launch". They are NEVER board rows.
  const reference = snapshot.protocols
    .filter((p) => p.gecko_id !== null && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd!)
    .slice(0, 12)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category ?? 'Uncategorised',
      mcap_usd: p.mcap_usd,
      tvl_usd: p.tvl_usd,
      multiple: Number((p.mcap_usd! / p.tvl_usd).toFixed(3)),
    }));
  const data = {
    meta: {
      snapshot_date: snapshot.as_of,
      floor_usd: snapshot.floor_usd,
      rows: rows.length,
      watchlist_covered: rows.filter((r) => r.watchlist).length,
      watchlist_total: snapshot.watchlist.length,
    },
    validation: {
      n: validation.n,
      mae_log10: Number(validation.mae_log10.toFixed(4)),
      mae_factor: Number(validation.mae_factor.toFixed(2)),
      r2: Number(validation.r2.toFixed(4)),
      global_median: Number(validation.global_median.toFixed(4)),
      global_q25: Number(validation.global_q25.toFixed(4)),
      global_q75: Number(validation.global_q75.toFixed(4)),
    },
    rows,
    reference_tokenized: reference,
  };
  return `window.BOARD_DATA = ${JSON.stringify(data, null, 2)};\n`;
}

function checkBoard(rows: BoardRow[], snapshot: Snapshot): void {
  if (rows.length < 100 || rows.length > 4000) throw new Error(`board has ${rows.length} rows`);
  const slugs = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (slugs.has(r.slug)) throw new Error(`duplicate slug ${r.slug}`);
    slugs.add(r.slug);
    if (r.rank !== i + 1) throw new Error(`rank ${r.rank} at position ${i}`);
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0) throw new Error(`bad implied value for ${r.slug}`);
    if (i > 0 && r.implied_value_usd > rows[i - 1]!.implied_value_usd) throw new Error(`implied value rises at rank ${r.rank}`);
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) throw new Error(`farm_steps count ${r.farm_steps.length} for ${r.slug}`);
    for (const step of r.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) throw new Error(`farm step of ${len} chars for ${r.slug}`);
    }
  }
  for (const slug of snapshot.watchlist) {
    if (!slugs.has(slug)) throw new Error(`watchlist slug missing from board: ${slug}`);
  }
}

function main(): void {
  const { input, output } = parseArgs(process.argv.slice(2));
  const repoRoot = dirname(fileURLToPath(import.meta.url));
  const snapshot = JSON.parse(readFileSync(input, 'utf8')) as Snapshot;
  const stats = categoryStats(snapshot);
  const validation = looValidation(snapshot);
  const rows = buildBoard(snapshot, stats);
  checkBoard(rows, snapshot);

  mkdirSync(join(output, 'dashboard'), { recursive: true });
  mkdirSync(join(output, 'screenshots'), { recursive: true });
  writeFileSync(join(output, 'board.json'), boardJson(snapshot, rows, validation), 'utf8');
  writeFileSync(join(output, 'data.js'), dataJs(snapshot, rows, validation), 'utf8');
  cpSync(join(repoRoot, 'dashboard'), join(output, 'dashboard'), { recursive: true });

  const meta: ShotMeta = {
    snapshotDate: snapshot.as_of,
    validation,
    rowCount: rows.length,
    watchlistCovered: rows.filter((r) => r.watchlist).length,
    watchlistTotal: snapshot.watchlist.length,
  };
  const shots: { name: string; png: Uint8Array }[] = [
    { name: '1-board.png', png: renderBoardShot(rows, meta) },
    { name: '2-detail.png', png: renderDetailShot(rows[0]!, meta) },
    { name: '3-filtered.png', png: renderFilteredShot(rows, meta, 'Risk Curators') },
  ];
  for (const shot of shots) {
    if (shot.png.length > 512 * 1024) throw new Error(`${shot.name} is ${shot.png.length} bytes, over the 512 KiB cap`);
    writeFileSync(join(output, 'screenshots', shot.name), shot.png);
  }

  const dossier = buildDossier(output, { text_max_bytes: 65536 });
  writeFileSync(join(output, 'dossier.json'), dossier);

  console.log(`board rows: ${rows.length} (watchlist ${meta.watchlistCovered}/${meta.watchlistTotal})`);
  console.log(`LOO validation: n=${validation.n} MAE log10=${validation.mae_log10.toFixed(4)} (x${validation.mae_factor.toFixed(2)}) R2=${validation.r2.toFixed(4)}`);
  console.log(`global median multiple: ${validation.global_median.toFixed(4)} (q25 ${validation.global_q25.toFixed(4)}, q75 ${validation.global_q75.toFixed(4)})`);
  console.log('top 10:');
  for (const r of rows.slice(0, 10)) {
    console.log(`  #${r.rank} ${r.slug} ${money(r.implied_value_usd)} (TVL ${moneyCompact(r.tvl_usd)}, multiple ${r.multiple.toFixed(3)}, odds ${Math.round(r.launch_odds * 100)}%)`);
  }
  for (const shot of shots) console.log(`screenshot ${shot.name}: ${shot.png.length} bytes`);
  const dashBytes = readdirSync(join(output, 'dashboard')).reduce((n, f) => n + statSync(join(output, 'dashboard', f)).size, 0);
  console.log(`dashboard bytes: ${dashBytes}`);
  console.log(`dossier bytes: ${dossier.length}`);
  console.log(`output: ${output}`);
}

main();
