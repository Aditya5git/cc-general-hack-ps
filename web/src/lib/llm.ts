// Provider-agnostic JSON completion with failover. Every configured key is used, in this order:
// GEMINI_API_KEY → OPENROUTER_API_KEY → ANTHROPIC_API_KEY → OPENAI_API_KEY. When one provider is busy
// (rate limit, overload, out of credits, timeout) the next one answers instead. Returns null when no key is
// set so callers can fall back to heuristics.

type Provider = "gemini" | "openrouter" | "anthropic" | "openai";

const ORDER: Provider[] = ["gemini", "openrouter", "anthropic", "openai"];
const KEY_ENV: Record<Provider, string> = {
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};
const LABEL: Record<Provider, string> = { gemini: "Gemini", openrouter: "OpenRouter", anthropic: "Anthropic", openai: "OpenAI" };

export function llmProviders(): Provider[] {
  return ORDER.filter((p) => process.env[KEY_ENV[p]]);
}

/** The provider tried first, or null when no key is configured. */
export function llmProvider(): Provider | null {
  return llmProviders()[0] ?? null;
}

/** Model per provider: GEMINI_MODEL etc. LLM_MODEL (older setting) only applies to the first provider. */
function modelFor(p: Provider, fallback: string) {
  return process.env[`${p.toUpperCase()}_MODEL`] || (p === llmProvider() ? process.env.LLM_MODEL : undefined) || fallback;
}

/** Running totals for this process, read by the eval harness to report requests and tokens per prompt. */
export const llmUsage = { requests: 0, failed: 0, input: 0, output: 0 };
const count = (ok: boolean, input = 0, output = 0) => {
  llmUsage.requests++;
  if (!ok) llmUsage.failed++;
  llmUsage.input += input;
  llmUsage.output += output;
};

/** A provider call that failed. `retryable` means another provider may well succeed (busy, not our fault). */
export class LLMError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

// busy, out of credits, or this provider's key is bad: another provider can still answer
const busy = (status: number) => [401, 402, 403, 408, 429].includes(status) || status >= 500;

// A provider that just said "rate limited / out of credits" is skipped for a while, so later calls in the
// same run go straight to one that works instead of failing on it again.
const coolingUntil = new Map<Provider, number>();
const cooldownMs = (e: LLMError) => (e.status === 429 || e.status === 402 ? 60_000 : 15_000);

/** POST JSON with its own timeout. Network errors and timeouts become retryable LLMErrors. */
async function post(label: string, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number) {
  try {
    return await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  } catch (e) {
    count(false);
    const timedOut = (e as Error).name === "TimeoutError";
    throw new LLMError(`${label} ${timedOut ? `timed out after ${timeoutMs / 1000}s` : `unreachable (${(e as Error).message})`}`, null, true);
  }
}

async function fail(label: string, res: Response): Promise<never> {
  count(false);
  throw new LLMError(`${label} ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status, busy(res.status));
}

type Call = (sys: string, user: string, maxTokens: number, timeoutMs: number) => Promise<string>;

const anthropic: Call = async (sys, user, maxTokens, timeoutMs) => {
  const res = await post(
    "Anthropic",
    "https://api.anthropic.com/v1/messages",
    { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" },
    { model: modelFor("anthropic", "claude-haiku-4-5-20251001"), max_tokens: maxTokens, system: sys, messages: [{ role: "user", content: user }] },
    timeoutMs,
  );
  if (!res.ok) await fail("Anthropic", res);
  const body = await res.json();
  count(true, body.usage?.input_tokens, body.usage?.output_tokens);
  return body.content?.find((b: { type: string }) => b.type === "text")?.text ?? "";
};

const openaiCompatible =
  (p: "openai" | "openrouter"): Call =>
  async (sys, user, maxTokens, timeoutMs) => {
    const or = p === "openrouter";
    const call = (tokens: number) =>
      post(
        LABEL[p],
        or ? "https://openrouter.ai/api/v1/chat/completions" : "https://api.openai.com/v1/chat/completions",
        { authorization: `Bearer ${process.env[KEY_ENV[p]]}`, ...(or ? { "x-title": "DataPilot" } : {}) },
        {
          model: modelFor(p, or ? "anthropic/claude-haiku-4.5" : "gpt-4o-mini"),
          max_tokens: tokens,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: sys + " Wrap arrays in an object." },
            { role: "user", content: user },
          ],
        },
        timeoutMs,
      );
    let res = await call(maxTokens);
    // OpenRouter answers 402 when the credit balance can't cover max_tokens; retry with what it can afford.
    if (res.status === 402) {
      count(false);
      const affordable = Number((await res.text()).match(/afford (\d+)/)?.[1] ?? 0);
      if (affordable < 400) throw new LLMError(`${LABEL[p]} 402: out of credits`, 402, true);
      res = await call(Math.min(maxTokens, affordable - 50));
    }
    if (!res.ok) await fail(LABEL[p], res);
    const body = await res.json();
    count(true, body.usage?.prompt_tokens, body.usage?.completion_tokens);
    return body.choices?.[0]?.message?.content ?? "";
  };

/** Gemini tries the preferred model, then lighter ones (separate quotas) when Google reports overload or limits. */
const gemini: Call = async (sys, user, maxTokens, timeoutMs) => {
  const models = [modelFor("gemini", "gemini-3.6-flash"), "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-flash-latest"];
  let last: LLMError | null = null;
  for (const model of [...new Set(models)]) {
    const res = await post(
      `Gemini ${model}`,
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      // header auth works for both classic (AIza…) and newer (AQ.…) Gemini keys
      { "x-goog-api-key": process.env.GEMINI_API_KEY! },
      {
        systemInstruction: { parts: [{ text: sys }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: maxTokens,
          // Gemini 3 otherwise spends most of maxOutputTokens on hidden reasoning and truncates the JSON
          ...(model.startsWith("gemini-3") ? { thinkingConfig: { thinkingLevel: "minimal" } } : {}),
        },
      },
      timeoutMs,
    );
    // a timeout or network error throws from post(): go to the next provider rather than wait on 3 more models
    if (res.ok) {
      const body = await res.json();
      const u = body.usageMetadata ?? {};
      count(true, u.promptTokenCount, (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0));
      return body.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
    }
    last = await fail(`Gemini ${model}`, res).catch((e: LLMError) => e);
    if (![404, 429, 500, 503].includes(res.status)) break;
    // LLM_NO_FALLBACK=1 (eval harness): a rate limit stops here instead of fanning out into 4 requests;
    // overload (503) still moves on to a lighter model.
    if (res.status === 429 && process.env.LLM_NO_FALLBACK) break;
  }
  // a retired model (404) on every try is still worth handing to the next provider
  throw last && last.status === 404 ? new LLMError(last.message, 404, true) : last!;
};

const CALLS: Record<Provider, Call> = { gemini, openrouter: openaiCompatible("openrouter"), anthropic, openai: openaiCompatible("openai") };

function parseJSON<T>(text: string): T {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.search(/[[{]/);
    const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  }
}

/**
 * One JSON completion. Tries each configured provider in order, moving on only when one is busy (rate limit,
 * overload, out of credits, timeout); a bad request or unparseable answer throws straight away. `timeoutMs`
 * applies to each attempt.
 */
export async function llmJSON<T>(system: string, user: string, maxTokens = 4096, opts: { timeoutMs?: number } = {}): Promise<T | null> {
  const providers = llmProviders();
  if (!providers.length) return null;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const sys = `${system}\n\nRespond with a single valid JSON value only. No prose, no markdown fences.`;

  const ready = providers.filter((p) => (coolingUntil.get(p) ?? 0) <= Date.now());
  const errors: LLMError[] = [];
  // all cooling down: try them anyway rather than fail without asking
  for (const p of ready.length ? ready : providers) {
    let text: string;
    try {
      text = await CALLS[p](sys, user, maxTokens, timeoutMs);
    } catch (e) {
      if (!(e instanceof LLMError) || !e.retryable) throw e;
      coolingUntil.set(p, Date.now() + cooldownMs(e));
      errors.push(e);
      continue;
    }
    coolingUntil.delete(p);
    return parseJSON<T>(text);
  }
  const last = errors[errors.length - 1];
  throw new LLMError(errors.map((e) => e.message).join(" · then "), last.status, true);
}
