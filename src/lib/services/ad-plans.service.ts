import { nowIso, toDateKey } from "@/lib/core/date";
import { ConflictError, NotFoundError, PreconditionError, ValidationError } from "@/lib/core/errors";
import { formatReference, nextSequence } from "@/lib/core/ids";
import { formatMoney } from "@/lib/core/money";
import {
  assertCustomerAccess,
  isStaff,
  requireCapability,
  type Actor,
} from "@/lib/auth/permissions";
import type {
  AdBusinessCategory,
  AdForecasts,
  AdObjective,
  AdPlanBody,
  AdPlanPlatform,
  AdPlanResultRow,
  AdPlanRow,
  AdPlanStatus,
  AdResultPlatform,
  Locale,
  ReportRow,
} from "@/lib/domain/types";
import {
  applySuggestedSplit,
  ADS_AGENT_KEY,
  buildForecasts,
  computeAdKpis,
  proposeAdPlanDraft,
  recommendImprovements,
  splitBudgetAcrossPlatforms,
  summariseAdPlan,
  type AdKpiActuals,
  type AdRecommendation,
} from "@/lib/agents/specialists/ads.agent";
import { findCustomerById } from "@/lib/repositories/customers.repo";
import { findProjectById } from "@/lib/repositories/projects.repo";
import { createReport, listReports, updateReport } from "@/lib/repositories/growth.repo";
import {
  adPlanFamilyKey,
  createAdPlan,
  findAdPlanById,
  findLatestAdPlan,
  listAdPlanCodes,
  listAdPlanResults,
  listApprovedAdPlansForCustomer,
  listAdPlansForFamily,
  listLatestAdPlans,
  nextAdPlanVersion,
  updateAdPlan,
  upsertAdPlanResult,
} from "@/lib/repositories/ads.repo";

import { logActivity } from "./activity.service";

/**
 * Advertising plans (الخطة الإعلانية) — the document the Ads Agent prepares
 * and the owner approves.
 *
 * Rules enforced here (not in the UI):
 *   1. A plan is a proposal until the owner approves it.
 *   2. Only the owner approves (`campaigns.plan.approve`).
 *   3. Editing an approved plan creates a new DRAFT; the approved copy stays.
 *   4. The agent never launches, pauses, spends, invoices, emails, or invents results.
 *   5. The client sees only their own APPROVED plan, without internal notes.
 */

export const ADS_EXECUTION_DISABLED_MESSAGE =
  "Advertising execution is disabled. The ads agent is advisory only: it cannot launch, pause or spend on Meta, Google or TikTok, and no ads account is connected.";

export function forbidLiveAdsExecution(): never {
  throw new PreconditionError(ADS_EXECUTION_DISABLED_MESSAGE);
}

const BUSINESS_CATEGORIES: AdBusinessCategory[] = [
  "LOCAL_RETAIL",
  "RESTAURANT",
  "SERVICES",
  "PROFESSIONAL",
  "ECOMMERCE",
  "CONTENT",
  "REAL_ESTATE",
  "EDUCATION",
  "HEALTH",
  "OTHER",
];

const OBJECTIVES: AdObjective[] = ["AWARENESS", "TRAFFIC", "ENGAGEMENT", "MESSAGES", "LEADS", "SALES"];
const PLATFORMS: AdPlanPlatform[] = ["META_ADS", "GOOGLE_ADS", "TIKTOK"];
const RESULT_PLATFORMS: AdResultPlatform[] = ["META_ADS", "GOOGLE_ADS", "TIKTOK", "ALL"];

export function parseAdPlanBody(plan: AdPlanRow | undefined): AdPlanBody | null {
  if (!plan?.body) return null;
  try {
    const parsed = JSON.parse(plan.body) as AdPlanBody;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function parseAdForecasts(plan: AdPlanRow | undefined): AdForecasts | null {
  if (!plan?.forecasts) return null;
  try {
    const parsed = JSON.parse(plan.forecasts) as AdForecasts;
    return parsed?.isEstimate ? parsed : null;
  } catch {
    return null;
  }
}

function assertValidDateKey(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime())) {
    throw new ValidationError(`Invalid date for ${field}`, { field });
  }
}

export interface CreateAdPlanRequest {
  customerId: string;
  projectId?: string | null;
  businessCategory?: AdBusinessCategory;
  objective?: AdObjective;
  brief?: string | null;
  audience?: string | null;
  geo?: string[] | null;
  totalBudgetUsd: number;
  durationDays?: number;
  preferredPlatforms?: AdPlanPlatform[] | null;
  locale?: Locale;
  internalNote?: string | null;
}

export interface StaffAdPlanView {
  id: string;
  code: string;
  customerId: string;
  customerName: string | null;
  customerCompany: string | null;
  projectId: string | null;
  familyKey: string;
  version: number;
  status: AdPlanStatus;
  locale: Locale;
  currency: "USD";
  summary: string | null;
  body: AdPlanBody | null;
  forecasts: AdForecasts | null;
  internalNote: string | null;
  reviewNote: string | null;
  createdByAgent: string | null;
  approvedAt: string | null;
  approvedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  approvedVersion: number | null;
  requiresOwnerApproval: boolean;
  liveExecution: false;
}

export interface ClientAdPlanView {
  id: string;
  code: string;
  projectId: string | null;
  version: number;
  status: "APPROVED";
  summary: string | null;
  currency: "USD";
  body: AdPlanBody;
  forecasts: AdForecasts | null;
  approvedAt: string | null;
  actuals: AdKpiActuals;
  reports: { id: string; title: string; summary: string; createdAt: string }[];
  disclaimerAr: string;
  disclaimerEn: string;
}

function toStaffView(
  plan: AdPlanRow,
  extras: { customerName?: string | null; customerCompany?: string | null; approvedVersion?: number | null } = {},
): StaffAdPlanView {
  return {
    id: plan.id,
    code: plan.code,
    customerId: plan.customer_id,
    customerName: extras.customerName ?? null,
    customerCompany: extras.customerCompany ?? null,
    projectId: plan.project_id,
    familyKey: plan.family_key,
    version: plan.version,
    status: plan.status,
    locale: plan.locale,
    currency: "USD",
    summary: plan.summary,
    body: parseAdPlanBody(plan),
    forecasts: parseAdForecasts(plan),
    internalNote: plan.internal_note,
    reviewNote: plan.review_note,
    createdByAgent: plan.created_by_agent,
    approvedAt: plan.approved_at,
    approvedByUserId: plan.approved_by_user_id,
    createdAt: plan.created_at,
    updatedAt: plan.updated_at,
    approvedVersion: extras.approvedVersion ?? (plan.status === "APPROVED" ? plan.version : null),
    requiresOwnerApproval: plan.status !== "APPROVED",
    liveExecution: false,
  };
}

function toClientBody(body: AdPlanBody): AdPlanBody {
  return {
    ...body,
    currency: "USD",
    disclaimerAr: body.disclaimerAr,
    disclaimerEn: body.disclaimerEn,
  };
}

async function requireCustomer(customerId: string) {
  const customer = await findCustomerById(customerId);
  if (!customer) throw new NotFoundError("Customer not found");
  return customer;
}

export async function createAdPlanForCustomer(
  input: CreateAdPlanRequest,
  actor: Actor,
): Promise<StaffAdPlanView> {
  requireCapability(actor, "campaigns.manage");
  const customer = await requireCustomer(input.customerId);
  if (input.projectId) {
    const project = await findProjectById(input.projectId);
    if (!project || project.customer_id !== customer.id) {
      throw new NotFoundError("Project not found");
    }
  }
  if (!Number.isFinite(input.totalBudgetUsd) || input.totalBudgetUsd <= 0) {
    throw new ValidationError("The advertising budget must be greater than zero (USD)", { field: "totalBudgetUsd" });
  }
  const category = input.businessCategory ?? "OTHER";
  if (!BUSINESS_CATEGORIES.includes(category)) {
    throw new ValidationError("Unknown business category", { field: "businessCategory" });
  }
  const objective = input.objective ?? "MESSAGES";
  if (!OBJECTIVES.includes(objective)) {
    throw new ValidationError("Unknown advertising objective", { field: "objective" });
  }
  const durationDays = input.durationDays && input.durationDays > 0 ? Math.round(input.durationDays) : 30;
  const preferred = (input.preferredPlatforms ?? []).filter((platform): platform is AdPlanPlatform =>
    PLATFORMS.includes(platform),
  );
  const locale = input.locale ?? customer.locale ?? "ar";
  const totalBudgetMinor = Math.round(input.totalBudgetUsd * 100);

  const draft = await proposeAdPlanDraft({
    customerId: customer.id,
    projectId: input.projectId ?? null,
    businessCategory: category,
    objective,
    brief: input.brief?.trim() || customer.needs || customer.goals || "",
    audience: input.audience ?? null,
    geo: input.geo ?? (customer.city ? ["العراق", customer.city] : null),
    totalBudgetMinor,
    durationDays,
    preferredPlatforms: preferred.length ? preferred : null,
    locale,
    brandName: customer.company_name ?? customer.contact_name,
    city: customer.city,
    country: customer.country,
    actorUserId: actor.id,
  });

  const familyKey = adPlanFamilyKey(customer.id, input.projectId ?? null);
  const latest = await findLatestAdPlan(familyKey);
  const codes = await listAdPlanCodes();
  const code = latest?.code ?? formatReference("AD", nextSequence(codes, "AD"));

  let saved: AdPlanRow;
  if (latest && latest.status !== "APPROVED" && latest.status !== "SUPERSEDED") {
    saved = (await updateAdPlan(latest.id, {
      status: "DRAFT",
      locale,
      currency: "USD",
      summary: draft.summary,
      body: JSON.stringify(draft.body),
      forecasts: JSON.stringify(draft.forecasts),
      internal_note: input.internalNote ?? latest.internal_note,
      approved_by_user_id: null,
      approved_at: null,
      created_by_agent: ADS_AGENT_KEY,
    }))!;
  } else {
    saved = await createAdPlan({
      customer_id: customer.id,
      project_id: input.projectId ?? null,
      family_key: familyKey,
      code,
      version: await nextAdPlanVersion(familyKey),
      status: "DRAFT",
      locale,
      currency: "USD",
      summary: draft.summary,
      body: JSON.stringify(draft.body),
      forecasts: JSON.stringify(draft.forecasts),
      internal_note: input.internalNote ?? null,
      created_by_user_id: actor.id,
      created_by_agent: ADS_AGENT_KEY,
    });
  }

  await logActivity({
    actor_type: "AGENT",
    actor_user_id: actor.id,
    actor_label: ADS_AGENT_KEY,
    action: "ad_plan.draft_saved",
    entity_type: "ad_plan",
    entity_id: saved.id,
    customer_id: customer.id,
    project_id: input.projectId ?? null,
    summary: `مسودة خطة إعلانية ${saved.code} (نسخة ${saved.version}) — بانتظار اعتماد المالك`,
  });

  return toStaffView(saved, {
    customerName: customer.contact_name,
    customerCompany: customer.company_name,
  });
}

export interface SaveAdPlanPatch {
  summary?: string | null;
  brief?: string | null;
  objective?: AdObjective;
  audienceDescription?: string | null;
  geo?: string[] | null;
  durationDays?: number;
  totalBudgetUsd?: number;
  platformPercents?: { platform: AdPlanPlatform; percent: number }[];
  adCopy?: AdPlanBody["adCopy"];
  adIdeas?: AdPlanBody["adIdeas"];
  internalNote?: string | null;
  reviewNote?: string | null;
}

export async function saveAdPlanDraft(
  planId: string,
  actor: Actor,
  patch: SaveAdPlanPatch,
): Promise<StaffAdPlanView> {
  requireCapability(actor, "campaigns.manage");
  const current = await findAdPlanById(planId);
  if (!current) throw new NotFoundError("Ad plan not found");
  const body = parseAdPlanBody(current);
  if (!body) throw new PreconditionError("This plan has no body to edit");

  if (patch.objective && !OBJECTIVES.includes(patch.objective)) {
    throw new ValidationError("Unknown advertising objective", { field: "objective" });
  }
  if (patch.durationDays !== undefined && patch.durationDays < 1) {
    throw new ValidationError("Duration must be at least one day", { field: "durationDays" });
  }
  if (patch.totalBudgetUsd !== undefined && patch.totalBudgetUsd <= 0) {
    throw new ValidationError("The advertising budget must be greater than zero (USD)", { field: "totalBudgetUsd" });
  }

  let nextBody: AdPlanBody = {
    ...body,
    brief: patch.brief !== undefined ? (patch.brief ?? "").trim() : body.brief,
    objective: patch.objective ?? body.objective,
    durationDays: patch.durationDays ?? body.durationDays,
    adCopy: patch.adCopy ?? body.adCopy,
    adIdeas: patch.adIdeas ?? body.adIdeas,
  };
  if (patch.audienceDescription !== undefined || patch.geo) {
    nextBody = {
      ...nextBody,
      audience: {
        ...body.audience,
        description: patch.audienceDescription?.trim() || body.audience.description,
        geo: patch.geo?.length ? patch.geo : body.audience.geo,
      },
    };
  }
  if (patch.totalBudgetUsd !== undefined) {
    nextBody = { ...nextBody, totalBudgetMinor: Math.round(patch.totalBudgetUsd * 100) };
  }
  const percents =
    patch.platformPercents?.filter((row) => PLATFORMS.includes(row.platform) && row.percent > 0) ??
    nextBody.platforms.map((row) => ({ platform: row.platform, percent: row.percent }));
  if (percents.length === 0) {
    throw new ValidationError("A plan needs at least one platform", { field: "platformPercents" });
  }
  const { dailyBudgetMinor, allocations } = splitBudgetAcrossPlatforms(
    nextBody.totalBudgetMinor,
    nextBody.durationDays,
    percents,
  );
  nextBody = { ...nextBody, dailyBudgetMinor, platforms: allocations, currency: "USD" };
  const forecasts = buildForecasts(allocations, nextBody.objective);
  const locale = current.locale;
  const summary = patch.summary?.trim() || summariseAdPlan(nextBody, locale);

  let saved: AdPlanRow;
  if (current.status === "APPROVED" || current.status === "SUPERSEDED") {
    saved = await createAdPlan({
      customer_id: current.customer_id,
      project_id: current.project_id,
      family_key: current.family_key,
      code: current.code,
      version: await nextAdPlanVersion(current.family_key),
      status: "DRAFT",
      locale,
      currency: "USD",
      summary,
      body: JSON.stringify(nextBody),
      forecasts: JSON.stringify(forecasts),
      internal_note: patch.internalNote ?? current.internal_note,
      review_note: patch.reviewNote ?? null,
      created_by_user_id: actor.id,
    });
  } else {
    saved = (await updateAdPlan(current.id, {
      status: "DRAFT",
      summary,
      body: JSON.stringify(nextBody),
      forecasts: JSON.stringify(forecasts),
      internal_note: patch.internalNote === undefined ? current.internal_note : patch.internalNote,
      review_note: patch.reviewNote === undefined ? current.review_note : patch.reviewNote,
      approved_by_user_id: null,
      approved_at: null,
    }))!;
  }

  await logActivity({
    actor_type: "USER",
    actor_user_id: actor.id,
    action: "ad_plan.draft_edited",
    entity_type: "ad_plan",
    entity_id: saved.id,
    customer_id: saved.customer_id,
    project_id: saved.project_id,
    summary: `عُدّلت مسودة الخطة الإعلانية ${saved.code} (نسخة ${saved.version})`,
  });

  const customer = await findCustomerById(saved.customer_id);
  return toStaffView(saved, {
    customerName: customer?.contact_name ?? null,
    customerCompany: customer?.company_name ?? null,
  });
}

export async function submitAdPlanForApproval(
  planId: string,
  actor: Actor,
  options: { note?: string | null } = {},
): Promise<StaffAdPlanView> {
  requireCapability(actor, "campaigns.manage");
  const plan = await findAdPlanById(planId);
  if (!plan) throw new NotFoundError("Ad plan not found");
  if (plan.status === "APPROVED") throw new PreconditionError("This plan is already approved");
  const body = parseAdPlanBody(plan);
  if (!body || body.platforms.length === 0) {
    throw new PreconditionError("A plan without platforms cannot be submitted");
  }

  const updated = (await updateAdPlan(plan.id, {
    status: "AWAITING_APPROVAL",
    review_note: options.note ?? plan.review_note,
  }))!;

  const { raiseAlert } = await import("./alerts.service");
  await raiseAlert({
    severity: "IMPORTANT",
    category: "campaigns",
    title_ar: `خطة إعلانية بانتظار موافقتك: ${plan.code}`,
    title_en: `Ads plan awaiting your approval: ${plan.code}`,
    body_ar: `خطة ${plan.code} (نسخة ${plan.version}) جاهزة للمراجعة. الميزانية ${formatMoney(body.totalBudgetMinor, "USD", "ar")}. الوكيل استشاري فقط: لا إطلاق ولا إنفاق عند الاعتماد.`,
    body_en: `Plan ${plan.code} (version ${plan.version}) is ready for review. Budget ${formatMoney(body.totalBudgetMinor, "USD", "en")}. The agent is advisory only: approval does not launch or spend.`,
    entity_type: "ad_plan",
    entity_id: plan.id,
    customer_id: plan.customer_id,
    target_role: "OWNER",
    dedupe_key: `ad-plan-awaiting-approval:${plan.id}`,
    notify: false,
  });

  await logActivity({
    actor_type: "USER",
    actor_user_id: actor.id,
    action: "ad_plan.submitted",
    entity_type: "ad_plan",
    entity_id: plan.id,
    customer_id: plan.customer_id,
    summary: `أُرسلت الخطة الإعلانية ${plan.code} لمراجعة المالك`,
  });

  const customer = await findCustomerById(updated.customer_id);
  return toStaffView(updated, {
    customerName: customer?.contact_name ?? null,
    customerCompany: customer?.company_name ?? null,
  });
}

export async function approveAdPlan(
  planId: string,
  actor: Actor,
  options: { note?: string | null } = {},
): Promise<StaffAdPlanView> {
  requireCapability(actor, "campaigns.plan.approve");
  const plan = await findAdPlanById(planId);
  if (!plan) throw new NotFoundError("Ad plan not found");
  if (plan.status === "APPROVED") throw new PreconditionError("This plan is already approved");
  const body = parseAdPlanBody(plan);
  if (!body || body.platforms.length === 0) {
    throw new PreconditionError("A plan without platforms cannot be approved");
  }

  const updated = (await updateAdPlan(plan.id, {
    status: "APPROVED",
    approved_by_user_id: actor.id,
    approved_at: nowIso(),
    review_note: options.note ?? plan.review_note,
  }))!;

  const versions = await listAdPlansForFamily(plan.family_key);
  for (const version of versions) {
    if (version.id === updated.id) continue;
    if (version.status === "APPROVED") {
      await updateAdPlan(version.id, { status: "SUPERSEDED" });
    }
  }

  await notifyClientOfApprovedAdPlan(plan.customer_id, plan.code, plan.version, plan.locale);

  await logActivity({
    actor_type: "USER",
    actor_user_id: actor.id,
    action: "ad_plan.approved",
    entity_type: "ad_plan",
    entity_id: plan.id,
    customer_id: plan.customer_id,
    summary: `اعتمد المالك الخطة الإعلانية ${plan.code} (نسخة ${plan.version}) — بدون إطلاق أو إنفاق`,
    meta: { liveExecution: false },
  });

  const customer = await findCustomerById(updated.customer_id);
  return toStaffView(updated, {
    customerName: customer?.contact_name ?? null,
    customerCompany: customer?.company_name ?? null,
    approvedVersion: updated.version,
  });
}

async function notifyClientOfApprovedAdPlan(
  customerId: string,
  code: string,
  version: number,
  locale: Locale,
): Promise<void> {
  try {
    const { createNotification } = await import("@/lib/repositories/messaging.repo");
    const customer = await findCustomerById(customerId);
    if (!customer?.user_id) return;
    await createNotification({
      user_id: customer.user_id,
      channel: "IN_APP",
      subject: locale === "ar" ? `اعتُمدت خطتك الإعلانية ${code}` : `Your ads plan ${code} was approved`,
      body:
        locale === "ar"
          ? `أصبحت الخطة الإعلانية ${code} (نسخة ${version}) معتمدة. يمكنك مراجعتها من بوابتك. التنفيذ على المنصات يتم يدويًا خارج النظام.`
          : `Ads plan ${code} (version ${version}) is approved. You can review it in your portal. Any live execution happens manually outside the platform.`,
      status: "QUEUED",
    });
  } catch {
    // A missing notification must never fail the owner's approval.
  }
}

export async function listStaffAdPlans(actor: Actor, customerId?: string): Promise<StaffAdPlanView[]> {
  requireCapability(actor, "campaigns.view");
  if (!isStaff(actor)) {
    throw new NotFoundError("Ad plan not found");
  }
  const rows = await listLatestAdPlans({ customerId, limit: 80 });
  const views: StaffAdPlanView[] = [];
  for (const row of rows) {
    const family = await listAdPlansForFamily(row.family_key);
    const approved = family.find((entry) => entry.status === "APPROVED");
    views.push(
      toStaffView(row, {
        customerName: row.customer_name,
        customerCompany: row.customer_company,
        approvedVersion: approved?.version ?? null,
      }),
    );
  }
  return views;
}

export async function getStaffAdPlan(planId: string, actor: Actor): Promise<StaffAdPlanView> {
  requireCapability(actor, "campaigns.view");
  if (!isStaff(actor)) throw new NotFoundError("Ad plan not found");
  const plan = await findAdPlanById(planId);
  if (!plan) throw new NotFoundError("Ad plan not found");
  const customer = await findCustomerById(plan.customer_id);
  const family = await listAdPlansForFamily(plan.family_key);
  const approved = family.find((entry) => entry.status === "APPROVED");
  return toStaffView(plan, {
    customerName: customer?.contact_name ?? null,
    customerCompany: customer?.company_name ?? null,
    approvedVersion: approved?.version ?? null,
  });
}

export async function listClientAdPlans(actor: Actor): Promise<ClientAdPlanView[]> {
  requireCapability(actor, "campaigns.view");
  assertCustomerAccess(actor, actor.customerId);
  if (!actor.customerId) return [];
  const rows = await listApprovedAdPlansForCustomer(actor.customerId);
  const views: ClientAdPlanView[] = [];
  for (const row of rows) {
    const view = await toClientView(row);
    if (view) views.push(view);
  }
  return views;
}

export async function getClientAdPlan(planId: string, actor: Actor): Promise<ClientAdPlanView> {
  requireCapability(actor, "campaigns.view");
  const plan = await findAdPlanById(planId);
  // Same message as "not found" so ids and drafts cannot be probed.
  if (!plan || plan.status !== "APPROVED" || actor.customerId !== plan.customer_id) {
    throw new NotFoundError("Ad plan not found");
  }
  const view = await toClientView(plan);
  if (!view) throw new NotFoundError("Ad plan not found");
  return view;
}

async function toClientView(plan: AdPlanRow): Promise<ClientAdPlanView | null> {
  if (plan.status !== "APPROVED") return null;
  const body = parseAdPlanBody(plan);
  if (!body) return null;
  const results = await listAdPlanResults(plan.id);
  const reports = await listReports({ adPlanId: plan.id, status: "SENT", limit: 20 });
  return {
    id: plan.id,
    code: plan.code,
    projectId: plan.project_id,
    version: plan.version,
    status: "APPROVED",
    summary: plan.summary,
    currency: "USD",
    body: toClientBody(body),
    forecasts: parseAdForecasts(plan),
    approvedAt: plan.approved_at,
    actuals: computeAdKpis(results),
    reports: reports.rows.map((report) => ({
      id: report.id,
      title: report.title,
      summary: report.summary,
      createdAt: report.created_at,
    })),
    disclaimerAr: body.disclaimerAr,
    disclaimerEn: body.disclaimerEn,
  };
}

export interface RecordAdResultInput {
  date: string;
  platform?: AdResultPlatform;
  spendUsd?: number;
  impressions?: number;
  clicks?: number;
  messages?: number;
  orders?: number;
  notes?: string | null;
}

export async function recordAdPlanResult(
  planId: string,
  actor: Actor,
  input: RecordAdResultInput,
): Promise<{ result: AdPlanResultRow; actuals: AdKpiActuals }> {
  requireCapability(actor, "campaigns.manage");
  const plan = await findAdPlanById(planId);
  if (!plan) throw new NotFoundError("Ad plan not found");
  if (plan.status !== "APPROVED") {
    throw new PreconditionError("Results can only be recorded against an approved plan");
  }
  const date = input.date?.trim() || toDateKey(new Date());
  assertValidDateKey(date, "date");
  const platform = input.platform ?? "ALL";
  if (!RESULT_PLATFORMS.includes(platform)) {
    throw new ValidationError("Unknown platform", { field: "platform" });
  }
  const spendMinor = Math.round((input.spendUsd ?? 0) * 100);
  const impressions = Math.round(input.impressions ?? 0);
  const clicks = Math.round(input.clicks ?? 0);
  const messages = Math.round(input.messages ?? 0);
  const orders = Math.round(input.orders ?? 0);
  if ([spendMinor, impressions, clicks, messages, orders].some((value) => value < 0)) {
    throw new ValidationError("Metrics cannot be negative");
  }
  if (spendMinor === 0 && impressions === 0 && clicks === 0 && messages === 0 && orders === 0) {
    throw new ValidationError("Enter at least one metric. Results are never invented.");
  }

  const result = await upsertAdPlanResult({
    ad_plan_id: plan.id,
    customer_id: plan.customer_id,
    result_date: date,
    platform,
    spend_minor: spendMinor,
    impressions,
    clicks,
    messages,
    orders,
    notes: input.notes ?? null,
    created_by_user_id: actor.id,
  });

  await logActivity({
    actor_type: "USER",
    actor_user_id: actor.id,
    action: "ad_plan.result_recorded",
    entity_type: "ad_plan",
    entity_id: plan.id,
    customer_id: plan.customer_id,
    summary: `أُدخلت نتائج يدوية للخطة ${plan.code} بتاريخ ${date} (مصدر يدوي فقط)`,
    meta: { source: "MANUAL", liveExecution: false },
  });

  const actuals = computeAdKpis(await listAdPlanResults(plan.id));
  return { result, actuals };
}

export interface AnalyzeAdPlanResult {
  actuals: AdKpiActuals;
  recommendations: AdRecommendation[];
  report: ReportRow;
  suggestionDraftId: string | null;
  approvedPlanUnchanged: true;
  liveExecution: false;
}

export async function analyzeAdPlan(planId: string, actor: Actor): Promise<AnalyzeAdPlanResult> {
  requireCapability(actor, "campaigns.manage");
  const plan = await findAdPlanById(planId);
  if (!plan) throw new NotFoundError("Ad plan not found");
  if (plan.status !== "APPROVED") {
    throw new PreconditionError("Analyse the approved plan. Drafts are not measured.");
  }
  const body = parseAdPlanBody(plan);
  if (!body) throw new PreconditionError("This plan has no body");

  const results = await listAdPlanResults(plan.id);
  const actuals = computeAdKpis(results);
  const recommendations = recommendImprovements(body, actuals);

  const { runAgent } = await import("@/lib/agents/runtime");
  await runAgent(
    ADS_AGENT_KEY,
    {
      trigger: "ads.results_analysed",
      locale: plan.locale,
      customerId: plan.customer_id,
      projectId: plan.project_id,
      actorUserId: actor.id,
      input: { planId: plan.id, actuals, recommendations: recommendations.map((row) => row.key) },
    },
    async ({ record }) => {
      record({
        action: "ad_plan.analysed",
        summary: `حُلّلت نتائج ${plan.code} يدويًا. الخطة المعتمدة لم تُغيَّر. لا إطلاق ولا إنفاق.`,
        reason: "advisory_only",
        entityType: "ad_plan",
        entityId: plan.id,
        customerId: plan.customer_id,
        riskLevel: "LOW",
        requiresApproval: true,
        payload: { actuals, liveExecution: false, autoApplied: false },
      });
      return {
        data: { recommendations: recommendations.length },
        summary: "تحليل أداء استشاري — بدون تعديل الخطة المعتمدة",
        riskLevel: "LOW",
      };
    },
  );

  const locale = plan.locale;
  const title =
    locale === "ar" ? `تقرير أداء الخطة ${plan.code}` : `Performance report for ${plan.code}`;
  const summary =
    locale === "ar"
      ? `إنفاق ${formatMoney(actuals.spendMinor, "USD", "ar")} · ظهور ${actuals.impressions} · نقر ${actuals.clicks} · رسائل ${actuals.messages} · طلبات ${actuals.orders}. تقديرات الخطة ليست ضمانًا.`
      : `Spend ${formatMoney(actuals.spendMinor, "USD", "en")} · impressions ${actuals.impressions} · clicks ${actuals.clicks} · messages ${actuals.messages} · orders ${actuals.orders}. Plan estimates are not a guarantee.`;
  const report = await createReport({
    customer_id: plan.customer_id,
    project_id: plan.project_id,
    campaign_id: null,
    ad_plan_id: plan.id,
    report_type: "CAMPAIGN_DEEP",
    language: locale,
    title,
    summary,
    body: JSON.stringify({ actuals, recommendations, disclaimerAr: body.disclaimerAr, disclaimerEn: body.disclaimerEn }),
    metrics: JSON.stringify(actuals),
    status: "DRAFT",
    generated_by_agent: ADS_AGENT_KEY,
  });

  let suggestionDraftId: string | null = null;
  const rebalance = recommendations.find((row) => row.suggestedSplit?.length);
  if (rebalance?.suggestedSplit) {
    const suggestedBody = applySuggestedSplit(body, rebalance.suggestedSplit);
    const forecasts = buildForecasts(suggestedBody.platforms, suggestedBody.objective);
    const latest = await findLatestAdPlan(plan.family_key);
    if (latest && latest.status !== "APPROVED" && latest.status !== "SUPERSEDED") {
      const updated = await updateAdPlan(latest.id, {
        status: "DRAFT",
        summary: summariseAdPlan(suggestedBody, locale),
        body: JSON.stringify(suggestedBody),
        forecasts: JSON.stringify(forecasts),
        review_note: rebalance.detailAr,
        created_by_agent: ADS_AGENT_KEY,
        approved_by_user_id: null,
        approved_at: null,
      });
      suggestionDraftId = updated?.id ?? null;
    } else {
      const created = await createAdPlan({
        customer_id: plan.customer_id,
        project_id: plan.project_id,
        family_key: plan.family_key,
        code: plan.code,
        version: await nextAdPlanVersion(plan.family_key),
        status: "DRAFT",
        locale,
        currency: "USD",
        summary: summariseAdPlan(suggestedBody, locale),
        body: JSON.stringify(suggestedBody),
        forecasts: JSON.stringify(forecasts),
        review_note: rebalance.detailAr,
        created_by_user_id: actor.id,
        created_by_agent: ADS_AGENT_KEY,
      });
      suggestionDraftId = created.id;
    }
  }

  const approved = await findAdPlanById(plan.id);
  if (approved?.status !== "APPROVED") {
    throw new ConflictError("The approved plan must not change during analysis");
  }

  await logActivity({
    actor_type: "AGENT",
    actor_user_id: actor.id,
    actor_label: ADS_AGENT_KEY,
    action: "ad_plan.report_saved",
    entity_type: "report",
    entity_id: report.id,
    customer_id: plan.customer_id,
    summary: `حُفظ تقرير أداء مسودة للخطة ${plan.code}. الخطة المعتمدة بقيت كما هي.`,
    meta: { suggestionDraftId, approvedPlanId: plan.id },
  });

  return {
    actuals,
    recommendations,
    report,
    suggestionDraftId,
    approvedPlanUnchanged: true,
    liveExecution: false,
  };
}

export async function publishAdPlanReport(
  planId: string,
  reportId: string,
  actor: Actor,
): Promise<ReportRow> {
  requireCapability(actor, "campaigns.manage");
  const plan = await findAdPlanById(planId);
  if (!plan) throw new NotFoundError("Ad plan not found");
  const { findReportById } = await import("@/lib/repositories/growth.repo");
  const report = await findReportById(reportId);
  if (!report || report.ad_plan_id !== plan.id) throw new NotFoundError("Report not found");
  if (report.status === "SENT") return report;
  const updated = (await updateReport(report.id, { status: "SENT", sent_at: nowIso() }))!;
  await logActivity({
    actor_type: "USER",
    actor_user_id: actor.id,
    action: "ad_plan.report_published",
    entity_type: "report",
    entity_id: report.id,
    customer_id: plan.customer_id,
    summary: `نُشر تقرير أداء الخطة ${plan.code} داخل البوابة (بدون بريد)`,
  });
  return updated;
}

export async function listAdPlanReports(planId: string, actor: Actor): Promise<ReportRow[]> {
  requireCapability(actor, "campaigns.view");
  const plan = await findAdPlanById(planId);
  if (!plan) throw new NotFoundError("Ad plan not found");
  if (isStaff(actor)) {
    const { rows } = await listReports({ adPlanId: plan.id, limit: 30 });
    return rows;
  }
  assertCustomerAccess(actor, plan.customer_id);
  if (plan.status !== "APPROVED") throw new NotFoundError("Ad plan not found");
  const { rows } = await listReports({ adPlanId: plan.id, status: "SENT", limit: 30 });
  return rows;
}
