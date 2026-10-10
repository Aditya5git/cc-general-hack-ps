import type { ConnectorResult, RawItem } from "../types";
import { clip, fetchJson, stripTags } from "./http";

// ---------------- Hacker News (Algolia) ----------------
interface HnHit {
  objectID: string;
  title?: string;
  url?: string;
  author?: string;
  points?: number;
  num_comments?: number;
  created_at?: string;
  story_text?: string;
}

export async function hackernews(query: string, limit: number): Promise<ConnectorResult> {
  // Algolia ranks all-time popular stories first, so recent requests found almost nothing. Fetch the best
  // matches from the last 60 days alongside the all-time ones, recent first, and dedupe.
  const n = Math.min(Math.max(limit, 20), 100);
  const base = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${n}`;
  const since = Math.floor(Date.now() / 1000) - 60 * 86_400;
  const url = `${base}&numericFilters=created_at_i>${since}`;
  const [recent, allTime] = await Promise.all([
    fetchJson<{ hits?: HnHit[] }>(url).catch(() => ({ hits: [] as HnHit[] })),
    fetchJson<{ hits?: HnHit[] }>(base),
  ]);
  const seen = new Set<string>();
  const hits = [...(recent.hits ?? []), ...(allTime.hits ?? [])].filter((h) => !seen.has(h.objectID) && seen.add(h.objectID));
  const items: RawItem[] = hits.slice(0, Math.max(limit, 30)).map((h) => {
    const hnUrl = `https://news.ycombinator.com/item?id=${h.objectID}`;
    return {
      source: "hackernews",
      url: h.url || hnUrl,
      title: h.title ?? "(untitled)",
      text: clip(
        `${h.title ?? ""}\nPoints: ${h.points ?? 0} · Comments: ${h.num_comments ?? 0} · by ${h.author ?? "?"}\n${stripTags(h.story_text)}`,
        4000,
      ),
      fields: {
        title: h.title,
        points: h.points ?? 0,
        author: h.author,
        num_comments: h.num_comments ?? 0,
        url: h.url || hnUrl,
        hn_url: hnUrl,
        posted_at: h.created_at,
      },
      published_at: h.created_at,
    };
  });
  return { items, url };
}

// ---------------- GitHub repos ----------------
interface GhRepo {
  name: string;
  full_name: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  language: string | null;
  owner: { login: string };
  homepage: string | null;
  topics?: string[];
  html_url: string;
  updated_at?: string;
  license?: { spdx_id?: string } | null;
}

export async function githubRepos(query: string, limit: number): Promise<ConnectorResult> {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${Math.min(limit, 100)}`;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const d = await fetchJson<{ items?: GhRepo[] }>(url, { headers });
  const items: RawItem[] = (d.items ?? []).slice(0, limit).map((r) => ({
    source: "github_repos",
    url: r.html_url,
    title: r.full_name,
    text: clip(`${r.full_name}: ${r.description ?? ""}\nTopics: ${(r.topics ?? []).join(", ")}`, 4000),
    fields: {
      name: r.name,
      full_name: r.full_name,
      description: r.description,
      stars: r.stargazers_count,
      forks: r.forks_count,
      language: r.language,
      owner: r.owner?.login,
      homepage: r.homepage || null,
      topics: r.topics ?? [],
      license: r.license?.spdx_id ?? null,
      updated_at: r.updated_at,
      url: r.html_url,
    },
    published_at: r.updated_at,
  }));
  return { items, url };
}

// ---------------- Wikipedia ----------------
interface WikiSearchHit {
  title: string;
  snippet: string;
  pageid: number;
}
interface WikiSummary {
  title: string;
  type?: string;
  extract?: string;
  description?: string;
  content_urls?: { desktop?: { page?: string } };
}

export async function wikipedia(query: string, limit: number): Promise<ConnectorResult> {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=${Math.min(limit, 50)}&srsearch=${encodeURIComponent(query)}`;
  const d = await fetchJson<{ query?: { search?: WikiSearchHit[] } }>(url);
  const hits = (d.query?.search ?? []).slice(0, limit);
  const items = await Promise.all(
    hits.map(async (h): Promise<RawItem | null> => {
      const pageUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, "_"))}`;
      let text = stripTags(h.snippet);
      let description: string | undefined;
      if (hits.indexOf(h) < 10) {
        try {
          const s = await fetchJson<WikiSummary>(
            `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(h.title.replace(/ /g, "_"))}`,
          );
          if (s.type === "disambiguation") return null; // lists of unrelated meanings, never a real entity
          if (s.extract) text = s.extract;
          description = s.description;
        } catch {
          /* keep snippet */
        }
      }
      return {
        source: "wikipedia",
        url: pageUrl,
        title: h.title,
        text: clip(text, 4000),
        fields: { title: h.title, description: description ?? null, url: pageUrl },
      };
    }),
  );
  return { items: items.filter((i): i is RawItem => i !== null && !/\(disambiguation\)$/i.test(i.title)), url };
}

// ---------------- CoinGecko ----------------
interface CgMarket {
  id: string;
  symbol: string;
  name: string;
  current_price: number | null;
  market_cap: number | null;
  market_cap_rank: number | null;
  price_change_percentage_24h: number | null;
  total_volume: number | null;
  last_updated?: string;
}

// Words that aren't coin names. Anything else is looked up as a coin, and CoinGecko's search always returns
// something: "in" → Bitcoin, "usd" → Tether, "defi" → Definitive, which replaced the top-coins list with them.
const GENERIC_CRYPTO = new RegExp(
  "^(" +
    [
      "top", "crypto", "cryptocurrenc(y|ies)", "coins?", "tokens?", "market", "markets", "cap", "by", "largest", "biggest",
      "price", "prices", "\\d+", "all", "the", "of", "and", "list", "in", "on", "for", "with", "to", "a", "an",
      "usd", "eur", "inr", "gbp", "dollars?", "rupees?", "euros?",
      "defi", "meme", "memecoins?", "layer", "layer-?[12]", "l[12]", "stablecoins?", "altcoins?",
      "today", "current", "currently", "latest", "now", "live", "value", "values", "rank", "ranking", "rankings",
      "volume", "trending", "best", "popular", "new", "highest", "most",
    ].join("|") +
    ")$",
  "i",
);

export async function coingecko(query: string, limit: number): Promise<ConnectorResult> {
  try {
    return await coingeckoPrimary(query, limit);
  } catch (e) {
    // CoinGecko's public API often 403/429s shared IPs; fall back to CoinPaprika (also keyless).
    try {
      return await coinpaprika(query, limit);
    } catch (e2) {
      throw new Error(`coingecko failed (${String(e)}); coinpaprika fallback failed (${String(e2)})`);
    }
  }
}

interface PaprikaTicker {
  id: string;
  name: string;
  symbol: string;
  rank: number;
  last_updated?: string;
  quotes?: { USD?: { price: number; market_cap: number; volume_24h: number; percent_change_24h: number } };
}

async function coinpaprika(query: string, limit: number): Promise<ConnectorResult> {
  const words = query.split(/[\s,]+/).filter(Boolean);
  const specific = words.filter((w) => !GENERIC_CRYPTO.test(w));
  let tickers: PaprikaTicker[] = [];
  let url = "https://api.coinpaprika.com/v1/tickers";
  if (specific.length) {
    const ids = await Promise.all(
      specific.slice(0, 10).map((term) =>
        fetchJson<{ currencies?: { id: string }[] }>(
          `https://api.coinpaprika.com/v1/search?c=currencies&limit=1&q=${encodeURIComponent(term)}`,
        )
          .then((r) => r.currencies?.[0]?.id)
          .catch(() => undefined),
      ),
    );
    const uniq = [...new Set(ids.filter((x): x is string => !!x))];
    tickers = (
      await Promise.all(uniq.map((id) => fetchJson<PaprikaTicker>(`https://api.coinpaprika.com/v1/tickers/${id}`).catch(() => null)))
    ).filter((t): t is PaprikaTicker => !!t);
    url = `https://api.coinpaprika.com/v1/tickers/${uniq.join(",")}`;
  } else {
    const all = await fetchJson<PaprikaTicker[]>(url);
    tickers = (Array.isArray(all) ? all : []).filter((t) => t.rank > 0).sort((a, b) => a.rank - b.rank);
  }
  const items: RawItem[] = tickers.slice(0, limit).map((t) => {
    const q = t.quotes?.USD;
    const pageUrl = `https://coinpaprika.com/coin/${t.id}/`;
    return {
      source: "coingecko",
      url: pageUrl,
      title: `${t.name} (${t.symbol})`,
      text: `${t.name} (${t.symbol}): price $${q?.price}, market cap $${q?.market_cap}, rank #${t.rank}, 24h change ${q?.percent_change_24h}%, 24h volume $${q?.volume_24h}`,
      fields: {
        name: t.name,
        symbol: t.symbol,
        price_usd: q?.price ?? null,
        market_cap: q?.market_cap ?? null,
        market_cap_rank: t.rank,
        change_24h_pct: q?.percent_change_24h ?? null,
        volume_24h: q?.volume_24h ?? null,
        url: pageUrl,
        data_provider: "coinpaprika",
      },
      published_at: t.last_updated,
    };
  });
  return { items, url };
}

async function coingeckoPrimary(query: string, limit: number): Promise<ConnectorResult> {
  const words = query.split(/[\s,]+/).filter(Boolean);
  const specific = words.filter((w) => !GENERIC_CRYPTO.test(w));
  let ids: string[] = [];
  if (specific.length) {
    // Resolve each named coin via /search (take best match per term).
    const results = await Promise.all(
      specific.slice(0, 10).map((term) =>
        fetchJson<{ coins?: { id: string }[] }>(
          `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(term)}`,
        ).catch(() => ({ coins: [] })),
      ),
    );
    ids = [...new Set(results.map((r) => r.coins?.[0]?.id).filter((x): x is string => !!x))];
  }
  const perPage = Math.min(Math.max(ids.length || limit, 1), 250);
  const url =
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=1` +
    (ids.length ? `&ids=${ids.join(",")}` : "");
  const data = await fetchJson<CgMarket[]>(url);
  const items: RawItem[] = (Array.isArray(data) ? data : []).slice(0, limit).map((c) => {
    const pageUrl = `https://www.coingecko.com/en/coins/${c.id}`;
    return {
      source: "coingecko",
      url: pageUrl,
      title: `${c.name} (${c.symbol.toUpperCase()})`,
      text: `${c.name} (${c.symbol.toUpperCase()}): price $${c.current_price}, market cap $${c.market_cap}, rank #${c.market_cap_rank}, 24h change ${c.price_change_percentage_24h?.toFixed(2)}%, 24h volume $${c.total_volume}`,
      fields: {
        name: c.name,
        symbol: c.symbol.toUpperCase(),
        price_usd: c.current_price,
        market_cap: c.market_cap,
        market_cap_rank: c.market_cap_rank,
        change_24h_pct: c.price_change_percentage_24h,
        volume_24h: c.total_volume,
        url: pageUrl,
      },
      published_at: c.last_updated,
    };
  });
  return { items, url };
}
