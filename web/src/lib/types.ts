// Shared contracts between the pipeline, API routes and UI.

export type WorkflowStatus =
  | "queued"
  | "planning"
  | "review" // plan ready, waiting for the user to edit/approve it
  | "collecting"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled"; // stopped by the user

export type FieldType = "string" | "number" | "url" | "date" | "email" | "list";

export interface FieldSpec {
  name: string; // snake_case key used in record.data
  type: FieldType;
  description: string;
  required?: boolean;
  ai?: boolean; // added after collection via "Add AI column"; description holds the question
}

export type ConnectorId =
  | "remotive_jobs"
  | "arbeitnow_jobs"
  | "remoteok_jobs"
  | "hackernews"
  | "github_repos"
  | "wikipedia"
  | "web_search"
  | "url_fetch"
  | "coingecko";

export interface SourceStep {
  connector: ConnectorId;
  query: string; // search terms, or a URL for url_fetch
  limit?: number;
  reason?: string; // why the planner picked it (shown in UI)
}

export interface WorkflowPlan {
  title: string;
  intent: string; // one-line restatement of what the user wants
  entity: string; // e.g. "job posting", "company", "sponsor"
  fields: FieldSpec[];
  sources: SourceStep[];
  filters: string[]; // plain-English constraints applied during validation
  /** The filters that define what a row IS (topic, skill, kind of thing). A row that fails one is dropped;
   *  every other filter only marks the row ✗ and ranks it lower. Always a subset of `filters`. */
  subject_filters?: string[];
  /** Order the user asked for ("top by market cap", "most starred", "latest"): a number or date column. */
  sort_by?: { field: string; direction: "asc" | "desc" };
  dedupe_on: string[]; // field names forming the dedupe key
  max_results: number;
  planner: "llm" | "heuristic";
  watch?: { every_hours: number }; // refresh on a schedule (cron) and badge new rows
}

/** What every connector returns: one raw item per document/listing it found. */
export interface RawItem {
  source: ConnectorId;
  url: string; // canonical URL for traceability
  title: string;
  text: string; // body/snippet for extraction (up to ~20k chars; extraction keeps the relevant passages)
  /** Already-structured fields when the source is an API (jobs, repos...). */
  fields?: Record<string, unknown>;
  published_at?: string;
}

export interface ConnectorResult {
  items: RawItem[];
  url?: string; // the request URL we hit (for the Sources tab)
}

/** Why rows were dropped during validation, for the activity log and the empty-table message. */
export interface DropReasons {
  no_name: number; // the row had no name/title, so it can't be shown as an entity
  irrelevant: number; // the extractor rated it as not matching the request
  failed_filters: Record<string, number>; // filter text → rows that clearly violated it
}

export interface Workflow {
  id: string;
  prompt: string;
  title: string | null;
  status: WorkflowStatus;
  plan: WorkflowPlan | null;
  progress: number;
  stats: {
    raw?: number;
    extracted?: number;
    valid?: number;
    duplicates?: number;
    invalid?: number;
    stored?: number;
    sources_ok?: number;
    sources_failed?: number;
    runs?: number; // 1 = first collection; >1 = refreshed
    run_started_at?: string; // rows first seen after this are NEW
    added?: number;
    removed?: number;
    dropped?: DropReasons;
    extraction?: "llm" | "mixed" | "heuristic"; // how rows were built; not "llm" means some pages fell back to keywords
    keyword_pages?: number; // pages matched by keywords because the AI was unavailable (out of `raw`)
  };
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  record_count?: number;
  owner_id?: string | null; // null = shared read-only example
}

export interface WorkflowEvent {
  id: number;
  step: string;
  level: "info" | "warn" | "error" | "success";
  message: string;
  created_at: string;
}

/** Reserved keys in record.data holding extraction metadata (not schema fields). */
export const WHY_KEY = "_why"; // string: one-line evidence for the match
export const CHECKS_KEY = "_checks"; // (boolean | null)[] aligned with plan.filters
export const QUOTE_KEY = "_quote"; // verbatim excerpt from the source backing the row
export const QUOTE_OK_KEY = "_quote_verified"; // true when the excerpt was found in the fetched text
export const METHOD_KEY = "_method"; // "keyword" when the row came from the keyword fallback instead of the AI

export interface DataRecord {
  id: number;
  data: Record<string, unknown>;
  source_name: string;
  source_url: string | null;
  confidence: number;
  fetched_at: string;
}

export interface SourceRun {
  id: number;
  connector: string;
  query: string | null;
  url: string | null;
  status: "ok" | "empty" | "failed" | "skipped";
  items: number;
  duration_ms: number | null;
  error: string | null;
  pages?: string[] | null; // links to the items this step returned
}
