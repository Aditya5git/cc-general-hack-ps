// Provider-agnostic JSON completion. Uses whichever key is configured:
// GEMINI_API_KEY → OPENROUTER_API_KEY → ANTHROPIC_API_KEY → OPENAI_API_KEY. Returns null when none is set
// so callers can fall back to heuristics.

export function llmProvider(): "openrouter" | "anthropic" | "openai" | "gemini" | null {
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  return null;
}

/** Running totals for this process, read by the eval harness to report requests and tokens per prompt. */
export const llmUsage = { requests: 0, failed: 0, input: 0, output: 0 };
const count = (ok: boolean, input = 0, output = 0) => {
  llmUsage.requests++;
  if (!ok) llmUsage.failed++;
  llmUsage.input += input;
  llmUsage.output += output;
};

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

export async function llmJSON<T>(system: string, user: string, maxTokens = 4096): Promise<T | null> {
  const provider = llmProvider();
  if (!provider) return null;
  const signal = AbortSignal.timeout(90_000);
  const sys = `${system}\n\nRespond with a single valid JSON value only. No prose, no markdown fences.`;

  if (provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL || "claude-haiku-4-5-20251001",
        max_tokens: maxTokens,
        system: sys,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) {
      count(false);
      throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const body = await res.json();
    count(true, body.usage?.input_tokens, body.usage?.output_tokens);
    const text = body.content?.find((b: { type: string }) => b.type === "text")?.text ?? "";
    return parseJSON<T>(text);
  }

  if (provider === "openai" || provider === "openrouter") {
    const or = provider === "openrouter";
    const call = (tokens: number) =>
      fetch(or ? "https://openrouter.ai/api/v1/chat/completions" : "https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal,
        headers: {
          authorization: `Bearer ${or ? process.env.OPENROUTER_API_KEY : process.env.OPENAI_API_KEY}`,
          "content-type": "application/json",
          ...(or ? { "x-title": "DataPilot" } : {}),
        },
        body: JSON.stringify({
          model: process.env.LLM_MODEL || (or ? "anthropic/claude-haiku-4.5" : "gpt-4o-mini"),
          max_tokens: tokens,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: sys + " Wrap arrays in an object." },
            { role: "user", content: user },
          ],
        }),
      });
    let res = await call(maxTokens);
    if (res.status === 402) count(false);
    // OpenRouter answers 402 when the credit balance can't cover max_tokens; retry with what it can afford.
    if (res.status === 402) {
      const affordable = Number((await res.text()).match(/afford (\d+)/)?.[1] ?? 0);
      if (affordable >= 400) res = await call(Math.min(maxTokens, affordable - 50));
      else throw new Error("OpenRouter 402: out of credits");
    }
    if (!res.ok) {
      count(false);
      throw new Error(`${or ? "OpenRouter" : "OpenAI"} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const body = await res.json();
    count(true, body.usage?.prompt_tokens, body.usage?.completion_tokens);
    return parseJSON<T>(body.choices?.[0]?.message?.content ?? "");
  }

  // Try the preferred model, then lighter ones when Google reports overload / retirement.
  const models = [process.env.LLM_MODEL || "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-flash-latest"];
  let lastErr = "";
  for (const model of [...new Set(models)]) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      signal,
      // header auth works for both classic (AIza…) and newer (AQ.…) Gemini keys
      headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY! },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sys }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: maxTokens,
          // Gemini 3 otherwise spends most of maxOutputTokens on hidden reasoning and truncates the JSON
          ...(model.startsWith("gemini-3") ? { thinkingConfig: { thinkingLevel: "minimal" } } : {}),
        },
      }),
    });
    if (res.ok) {
      const body = await res.json();
      const u = body.usageMetadata ?? {};
      count(true, u.promptTokenCount, (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0));
      return parseJSON<T>(body.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "");
    }
    count(false);
    lastErr = `Gemini ${model} ${res.status}: ${(await res.text()).slice(0, 200)}`;
    if (![404, 429, 500, 503].includes(res.status)) break;
    // LLM_NO_FALLBACK=1 (eval harness): a rate limit stops here instead of fanning out into 4 requests;
    // overload (503) still moves on to a lighter model.
    if (res.status === 429 && process.env.LLM_NO_FALLBACK) break;
  }
  throw new Error(lastErr);
}
