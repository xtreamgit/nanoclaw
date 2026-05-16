/**
 * Per-million-token pricing for Anthropic models.
 *
 * Prices are dollars per million tokens, taken from Anthropic's public pricing
 * page as of May 2026. Update this table when Anthropic posts new prices —
 * `cost_usd` is computed at ingest time, so historical rows in `token_usage`
 * keep the price in effect at ingest, not at the original API call. For
 * invoice-grade attribution, use Anthropic's own usage report instead.
 *
 * Model IDs match what Claude Code emits in JSONL `message.model` (e.g.
 * 'claude-sonnet-4-6'). For model strings we don't recognize we fall back
 * to a conservative Sonnet-equivalent rate so we never under-count.
 */

export interface ModelPricing {
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok: number;
  cacheWritePerMtok: number;
}

const PRICING: Record<string, ModelPricing> = {
  // Sonnet 4.6 — current default in this install.
  'claude-sonnet-4-6': {
    inputPerMtok: 3.0,
    outputPerMtok: 15.0,
    cacheReadPerMtok: 0.3,
    cacheWritePerMtok: 3.75,
  },
  // Opus 4.7 — only used when /fast or explicit opus selection.
  'claude-opus-4-7': {
    inputPerMtok: 15.0,
    outputPerMtok: 75.0,
    cacheReadPerMtok: 1.5,
    cacheWritePerMtok: 18.75,
  },
  // Haiku 4.5 — used by some sub-agents for cheap classification work.
  'claude-haiku-4-5': {
    inputPerMtok: 1.0,
    outputPerMtok: 5.0,
    cacheReadPerMtok: 0.1,
    cacheWritePerMtok: 1.25,
  },
};

/** Conservative fallback (= Sonnet rate). Used when a model ID isn't recognized
 * — better to over-estimate than under-count when this is the user's
 * spend-watch surface. */
const FALLBACK: ModelPricing = PRICING['claude-sonnet-4-6']!;

export interface UsageCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function priceFor(model: string): ModelPricing {
  // Strip date/region suffixes Anthropic sometimes appends, e.g.
  // 'claude-sonnet-4-6-20260315'. The first three dash-separated tokens
  // identify the model family for our purposes.
  if (PRICING[model]) return PRICING[model]!;
  const normalized = model.split('-').slice(0, 4).join('-');
  return PRICING[normalized] ?? FALLBACK;
}

export function computeCostUsd(model: string, usage: UsageCounts): number {
  const p = priceFor(model);
  const cost =
    (usage.input * p.inputPerMtok) / 1_000_000 +
    (usage.output * p.outputPerMtok) / 1_000_000 +
    (usage.cacheRead * p.cacheReadPerMtok) / 1_000_000 +
    (usage.cacheWrite * p.cacheWritePerMtok) / 1_000_000;
  // Round to 6 decimals so we don't carry float noise — well below a cent.
  return Math.round(cost * 1_000_000) / 1_000_000;
}
