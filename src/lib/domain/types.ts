/**
 * Domain row types.
 *
 * These mirror the database schema 1:1 (snake_case column names). Keeping the
 * same names end-to-end removes an entire class of mapping bugs and makes the
 * SQL the single source of truth. Presentation-layer helpers live in
 * `src/lib/domain/labels.ts`.
 */

/* ------------------------------------------------------------------ enums --- */

export type UserRole = "OWNER" | "PARTNER" | "CLIENT";
export type UserStatus = "ACTIVE" | "PENDING" | "SUSPENDED" | "DELETED";
export type Locale = "ar" | "en";

export type CustomerStatus = "LEAD" | "ACTIVE" | "PAUSED" | "ARCHIVED";
export type FactSource = "CHAT" | "FORM" | "AGENT" | "STAFF" | "IMPORT";

export type BillingType = "ONE_TIME" | "SUBSCRIPTION";
export type ServiceUnit =
  | "PROJECT"
  | "MONTH"
  | "POST"
  | "DESIGN"
  | "CAMPAIGN"
  | "HOUR"
  | "REPORT";

export type ProjectStatus =
  | "DRAFT"
  | "AWAITING_APPROVAL"
  | "AWAITING_PAYMENT"
  | "PLANNING"
  | "IN_PROGRESS"
  | "IN_REVIEW"
  | "REVISIONS"
  | "COMPLETED"
  | "CANCELLED";

export type TaskStatus = "TODO" | "IN_PROGRESS" | "BLOCKED" | "REVIEW" | "DONE";
export type Visibility = "CLIENT" | "INTERNAL";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

/**
 * Plan lifecycle (وكيل إدارة المشاريع).
 *
 * DRAFT          → the plan is being written (by the owner or proposed by the AI).
 * AWAITING_APPROVAL → the plan was submitted and waits for the owner's decision.
 * APPROVED       → the owner approved it; only now is it a commitment.
 * SUPERSEDED     → an older version of the plan, kept for the audit trail.
 */
export type ProjectPlanStatus = "DRAFT" | "AWAITING_APPROVAL" | "APPROVED" | "SUPERSEDED";

export type OfferStatus = "DRAFT" | "SENT" | "APPROVED" | "REJECTED" | "EXPIRED" | "CANCELLED";

export type InvoiceStatus =
  | "DRAFT"
  | "ISSUED"
  | "PARTIALLY_PAID"
  | "PAID"
  | "OVERDUE"
  | "CANCELLED"
  | "REFUNDED";

export type PaymentMethod = "MANUAL_TRANSFER" | "CASH" | "CARD_ONLINE" | "WALLET" | "OTHER";
export type PaymentStatus = "PENDING" | "SUCCEEDED" | "FAILED" | "REFUNDED";
export type SubscriptionStatus = "ACTIVE" | "PAST_DUE" | "PAUSED" | "CANCELLED" | "EXPIRED";
export type BillingInterval = "MONTHLY" | "QUARTERLY" | "YEARLY";

export type Channel = "WEB" | "EMAIL" | "WHATSAPP" | "PHONE" | "SYSTEM";
export type ConversationStatus = "OPEN" | "PENDING" | "CLOSED";
export type MessageSender = "CLIENT" | "ASSISTANT" | "STAFF" | "AGENT" | "SYSTEM";

export type AlertSeverity = "URGENT" | "IMPORTANT" | "INFO";
export type AlertStatus = "NEW" | "ACKNOWLEDGED" | "RESOLVED";
export type NotificationChannel = "IN_APP" | "EMAIL" | "WHATSAPP";

export type CampaignPlatform =
  | "GOOGLE_ADS"
  | "META_ADS"
  | "TIKTOK"
  | "SNAPCHAT"
  | "X_ADS"
  | "LINKEDIN"
  | "OTHER";

export type CampaignStatus =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "ACTIVE"
  | "PAUSED"
  | "COMPLETED"
  | "ARCHIVED";

export type SyncStatus = "DISABLED" | "NOT_CONNECTED" | "SYNCED" | "ERROR";
export type ReportType = "CAMPAIGN_DAILY" | "CAMPAIGN_DEEP" | "PROJECT" | "MONTHLY_SUMMARY" | "SERVICE";
export type ReviewStatus = "PENDING" | "APPROVED" | "REJECTED";
export type IntegrationStatus = "DISABLED" | "DISCONNECTED" | "CONNECTED" | "ERROR";
export type AgentRunStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED" | "AWAITING_APPROVAL";

/* ------------------------------------------------------------------ rows ---- */

export interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  name: string;
  role: UserRole;
  status: UserStatus;
  locale: Locale;
  phone: string | null;
  country: string | null;
  avatar_url: string | null;
  google_sub: string | null;
  email_verified_at: string | null;
  last_login_at: string | null;
  is_demo: number;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface VerificationTokenRow {
  id: string;
  user_id: string;
  type: "EMAIL_VERIFY" | "PASSWORD_RESET";
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  meta: string | null;
  created_at: string;
}

export interface CustomerRow {
  id: string;
  user_id: string | null;
  company_name: string | null;
  contact_name: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  city: string | null;
  locale: Locale;
  currency: string;
  timezone: string | null;
  source: string | null;
  status: CustomerStatus;
  goals: string | null;
  needs: string | null;
  ai_summary: string | null;
  internal_notes: string | null;
  owner_user_id: string | null;
  is_demo: number;
  created_at: string;
  updated_at: string;
}

export interface CustomerFactRow {
  id: string;
  customer_id: string;
  fact_key: string;
  fact_value: string;
  source: FactSource;
  confidence: number;
  verified: number;
  recorded_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ServiceRow {
  id: string;
  slug: string;
  name_ar: string;
  name_en: string;
  short_ar: string | null;
  short_en: string | null;
  description_ar: string | null;
  description_en: string | null;
  category: string;
  billing_type: BillingType;
  unit: ServiceUnit;
  base_price_minor: number;
  min_price_minor: number;
  currency: string;
  delivery_days: number;
  revisions_included: number;
  complexity_factor: number;
  requires_approval_above_minor: number | null;
  is_active: number;
  sort_order: number;
  pricing_config: string | null;
  cancellation_policy: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectRow {
  id: string;
  code: string;
  customer_id: string;
  title: string;
  title_en: string | null;
  brief: string | null;
  status: ProjectStatus;
  currency: string;
  amount_total_minor: number;
  internal_cost_minor: number;
  margin_pct: number | null;
  country: string | null;
  progress: number;
  risk_level: RiskLevel | null;
  start_date: string | null;
  due_date: string | null;
  completed_at: string | null;
  ai_plan: string | null;
  created_by_user_id: string | null;
  created_by_agent: string | null;
  is_demo: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectServiceRow {
  id: string;
  project_id: string;
  service_id: string | null;
  name_snapshot: string;
  quantity: number;
  unit_price_minor: number;
  billing_type: BillingType;
  months: number | null;
  notes: string | null;
  created_at: string;
}

export interface ProjectTaskRow {
  id: string;
  project_id: string;
  title: string;
  title_en: string | null;
  description: string | null;
  status: TaskStatus;
  visibility: Visibility;
  sort_order: number;
  due_date: string | null;
  completed_at: string | null;
  assigned_agent: string | null;
  /** Internal note — never sent to the client (unlike `description`). */
  internal_note: string | null;
  /** The plan phase this task belongs to (`project_plans.phases[].key`). */
  phase_key: string | null;
  created_at: string;
  updated_at: string;
}

/** One phase of a project plan: a milestone with its own deadline and owner. */
export interface ProjectPlanPhase {
  key: string;
  title: string;
  titleEn?: string | null;
  /** Deadline of the phase (ISO date). */
  dueDate?: string | null;
  /** Responsible role/agent key (e.g. `project_manager`, `content`). */
  owner?: string | null;
  /** Human label of the responsible party, shown to staff only. */
  ownerLabel?: string | null;
  /** `CLIENT` when at least one task of the phase is visible to the client. */
  visibility?: Visibility;
  tasks?: { title: string; titleEn?: string | null; dueDate?: string | null; owner?: string | null; visibility: Visibility }[];
}

export interface ProjectPlanRow {
  id: string;
  project_id: string;
  version: number;
  status: ProjectPlanStatus;
  locale: Locale;
  summary: string | null;
  /** The phase structure, stored as JSON text. */
  phases: string;
  start_date: string | null;
  due_date: string | null;
  created_by_user_id: string | null;
  created_by_agent: string | null;
  approved_by_user_id: string | null;
  approved_at: string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface OfferRow {
  id: string;
  code: string;
  customer_id: string;
  project_id: string | null;
  status: OfferStatus;
  currency: string;
  subtotal_minor: number | null;
  discount_minor: number;
  total_minor: number | null;
  internal_cost_minor: number;
  margin_pct: number | null;
  valid_until: string | null;
  pricing_reason: string | null;
  pricing_breakdown: string | null;
  client_note: string | null;
  internal_note: string | null;
  created_by_agent: string | null;
  created_by_user_id: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  is_demo: number;
  created_at: string;
  updated_at: string;
}

export interface OfferItemRow {
  id: string;
  offer_id: string;
  service_id: string | null;
  description_ar: string;
  description_en: string | null;
  quantity: number;
  unit_price_minor: number;
  billing_type: BillingType;
  months: number | null;
  total_minor: number;
  sort_order: number;
}

export interface InvoiceRow {
  id: string;
  number: string;
  customer_id: string;
  project_id: string | null;
  offer_id: string | null;
  subscription_id: string | null;
  currency: string;
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  amount_paid_minor: number;
  refunded_minor: number;
  status: InvoiceStatus;
  issued_at: string | null;
  due_at: string | null;
  paid_at: string | null;
  notes_client: string | null;
  internal_note: string | null;
  policy_snapshot: string | null;
  is_demo: number;
  created_at: string;
  updated_at: string;
}

export interface PaymentRow {
  id: string;
  invoice_id: string | null;
  customer_id: string;
  subscription_id: string | null;
  amount_minor: number;
  refunded_minor: number;
  currency: string;
  method: PaymentMethod;
  provider: string;
  provider_ref: string | null;
  status: PaymentStatus;
  paid_at: string | null;
  recorded_by_user_id: string | null;
  note: string | null;
  is_demo: number;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionRow {
  id: string;
  customer_id: string;
  service_id: string | null;
  project_id: string | null;
  plan_name: string;
  amount_minor: number;
  currency: string;
  interval: BillingInterval;
  interval_count: number;
  status: SubscriptionStatus;
  started_at: string;
  current_period_start: string;
  current_period_end: string;
  next_renewal_at: string | null;
  auto_renew: number;
  cancel_at_period_end: number;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  policy_snapshot: string | null;
  is_demo: number;
  created_at: string;
  updated_at: string;
}

export interface ConversationRow {
  id: string;
  customer_id: string;
  channel: Channel;
  subject: string | null;
  status: ConversationStatus;
  assigned_to_user_id: string | null;
  external_ref: string | null;
  unread_for_client: number;
  unread_for_staff: number;
  last_message_at: string | null;
  is_demo: number;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_type: MessageSender;
  sender_user_id: string | null;
  sender_label: string | null;
  body: string;
  language: string | null;
  translated_body: string | null;
  translated_language: string | null;
  meta: string | null;
  created_at: string;
  read_at: string | null;
  is_demo: number;
}

export interface FileRow {
  id: string;
  customer_id: string;
  project_id: string | null;
  offer_id: string | null;
  uploader_type: "CLIENT" | "STAFF" | "AGENT" | "SYSTEM";
  uploader_user_id: string | null;
  name: string;
  kind: string | null;
  mime: string | null;
  size_bytes: number;
  storage_provider: string;
  storage_key: string;
  visibility: Visibility;
  checksum: string | null;
  is_demo: number;
  created_at: string;
}

export interface ReviewRow {
  id: string;
  customer_id: string;
  project_id: string | null;
  rating: number;
  satisfaction: string | null;
  liked: string | null;
  improve: string | null;
  wants_more: number;
  note: string | null;
  status: ReviewStatus;
  published: number;
  published_name: string | null;
  published_at: string | null;
  source: string;
  is_demo: number;
  created_at: string;
  updated_at: string;
}

export interface ActivityRow {
  id: string;
  actor_type: "USER" | "AGENT" | "SYSTEM";
  actor_user_id: string | null;
  actor_label: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  customer_id: string | null;
  summary: string | null;
  meta: string | null;
  ip: string | null;
  user_agent: string | null;
  is_demo: number;
  created_at: string;
}

export interface SettingRow {
  key: string;
  value: string;
  value_type: "string" | "number" | "boolean" | "json";
  updated_by_user_id: string | null;
  updated_at: string;
}

export interface AgentRow {
  id: string;
  key: string;
  name_ar: string;
  name_en: string;
  category: string;
  description_ar: string | null;
  description_en: string | null;
  is_enabled: number;
  required_skills: string | null;
  sort_order: number;
  config: string | null;
  updated_at: string;
  created_at: string;
}

export interface AgentRunRow {
  id: string;
  agent_key: string;
  trigger: string;
  customer_id: string | null;
  project_id: string | null;
  conversation_id: string | null;
  status: AgentRunStatus;
  input: string | null;
  output: string | null;
  provider: string | null;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  error: string | null;
  is_demo: number;
  created_at: string;
  finished_at: string | null;
}

export interface AgentActionRow {
  id: string;
  agent_run_id: string | null;
  agent_key: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  customer_id: string | null;
  summary: string;
  reason: string | null;
  risk_level: RiskLevel;
  requires_approval: number;
  approved_by_user_id: string | null;
  approved_at: string | null;
  payload: string | null;
  is_demo: number;
  created_at: string;
}

export interface CampaignRow {
  id: string;
  customer_id: string;
  project_id: string | null;
  platform: CampaignPlatform;
  external_id: string | null;
  name: string;
  objective: string | null;
  status: CampaignStatus;
  currency: string;
  total_budget_minor: number;
  daily_budget_minor: number;
  monthly_budget_minor: number;
  spent_minor: number;
  start_date: string | null;
  end_date: string | null;
  targeting: string | null;
  keywords: string | null;
  ad_copy: string | null;
  autopilot_enabled: number;
  safe_limits: string | null;
  sync_status: SyncStatus;
  last_sync_at: string | null;
  created_by_agent: string | null;
  created_by_user_id: string | null;
  is_demo: number;
  created_at: string;
  updated_at: string;
}

export interface CampaignMetricsRow {
  id: string;
  campaign_id: string;
  metric_date: string;
  impressions: number;
  clicks: number;
  cost_minor: number;
  conversions: number;
  conversion_value_minor: number;
  ctr: number | null;
  cpc_minor: number | null;
  cpa_minor: number | null;
  source: "MANUAL" | "API" | "IMPORT";
  raw: string | null;
  created_at: string;
}

export interface CampaignChangeRow {
  id: string;
  campaign_id: string;
  agent_key: string | null;
  change_type: string;
  before_state: string | null;
  after_state: string | null;
  reason: string | null;
  risk_level: RiskLevel;
  auto_applied: number;
  within_limits: number;
  approver_user_id: string | null;
  applied_at: string | null;
  created_at: string;
}

export interface ReportRow {
  id: string;
  customer_id: string;
  project_id: string | null;
  campaign_id: string | null;
  report_type: ReportType;
  language: string;
  period_start: string | null;
  period_end: string | null;
  title: string;
  summary: string;
  body: string | null;
  metrics: string | null;
  status: "DRAFT" | "SENT" | "FAILED";
  channel: string | null;
  generated_by_agent: string | null;
  sent_at: string | null;
  is_demo: number;
  created_at: string;
}

export interface AlertRow {
  id: string;
  severity: AlertSeverity;
  category: string;
  title_ar: string;
  title_en: string;
  body_ar: string | null;
  body_en: string | null;
  entity_type: string | null;
  entity_id: string | null;
  customer_id: string | null;
  target_role: "OWNER" | "PARTNER" | "ANY_STAFF" | "CLIENT";
  status: AlertStatus;
  acknowledged_by_user_id: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
  dedupe_key: string | null;
  meta: string | null;
  is_demo: number;
  created_at: string;
  updated_at: string;
}

export interface NotificationRow {
  id: string;
  user_id: string;
  alert_id: string | null;
  channel: NotificationChannel;
  subject: string | null;
  body: string | null;
  status: "QUEUED" | "SENT" | "FAILED" | "READ";
  error: string | null;
  sent_at: string | null;
  read_at: string | null;
  created_at: string;
}

export interface OutboxEmailRow {
  id: string;
  to_email: string;
  to_user_id: string | null;
  subject: string;
  text: string | null;
  html: string | null;
  template: string | null;
  status: "QUEUED" | "SENT" | "FAILED";
  provider: string;
  attempts: number;
  error: string | null;
  meta: string | null;
  sent_at: string | null;
  created_at: string;
}

export interface IntegrationConnectionRow {
  id: string;
  provider: string;
  status: IntegrationStatus;
  account_label: string | null;
  account_ref: string | null;
  scopes: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: string | null;
  last_error: string | null;
  meta: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobRunRow {
  id: string;
  job_key: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED";
  started_at: string;
  finished_at: string | null;
  items_processed: number;
  summary: string | null;
  error: string | null;
  meta: string | null;
}

/* --------------------------------------------------------------- composite --- */

/** A user row with the password hash removed — the only shape sent to clients. */
export type PublicUser = Omit<UserRow, "password_hash">;

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  locale: Locale;
  status: UserStatus;
  customerId: string | null;
}

export interface ProjectWithCustomer extends ProjectRow {
  customer_name: string | null;
  customer_company: string | null;
  customer_locale: Locale | null;
}

export interface OfferWithItems extends OfferRow {
  items: OfferItemRow[];
  customer_name?: string | null;
}

export interface CampaignWithCustomer extends CampaignRow {
  customer_name: string | null;
}

export interface InvoiceWithCustomer extends InvoiceRow {
  customer_name: string | null;
}

export interface ConversationWithCustomer extends ConversationRow {
  customer_name: string | null;
}
