import { addDays, nowIso } from "@/lib/core/date";
import type { CustomerRow, Locale, ReviewRow } from "@/lib/domain/types";
import { listReviews, reviewStats, updateReview } from "@/lib/repositories/governance.repo";
import { listProjects } from "@/lib/repositories/projects.repo";
import { raiseAlert } from "@/lib/services/alerts.service";
import { createNotification } from "@/lib/repositories/messaging.repo";
import { logActivity } from "@/lib/services/activity.service";

import { runAgent } from "../runtime";

/**
 * Satisfaction analyst.
 *
 * Analyses reviews, sums up what needs improving and follows up with any client
 * who was not satisfied. Publication rules are strict and enforced here:
 *   · the owner and partner can see every review,
 *   · the client sees their own reviews,
 *   · visitors only see reviews the owner/partner explicitly approved AND
 *     published — never automatic, never with sensitive data.
 */
export interface SatisfactionAnalysis {
  average: number | null;
  count: number;
  lowRatingCount: number;
  themesAr: string[];
  themesEn: string[];
  actionsAr: string[];
  actionsEn: string[];
}

export async function analyseSatisfaction(locale: Locale): Promise<SatisfactionAnalysis> {
  const reviews = await listReviews({ limit: 200 });
  const stats = await reviewStats();
  const low = reviews.filter((review) => review.rating <= 3);

  const improvementThemes = collectThemes(low.map((review) => review.improve).filter(Boolean) as string[]);
  const likedThemes = collectThemes(
    reviews.filter((review) => review.rating >= 4).map((review) => review.liked).filter(Boolean) as string[],
  );

  const analysis: SatisfactionAnalysis = {
    average: stats.average,
    count: stats.count,
    lowRatingCount: low.length,
    themesAr: [
      ...improvementThemes.slice(0, 5).map((theme) => `يحتاج تحسينًا: ${theme}`),
      ...likedThemes.slice(0, 5).map((theme) => `نقطة قوة: ${theme}`),
    ],
    themesEn: [
      ...improvementThemes.slice(0, 5).map((theme) => `Needs improvement: ${theme}`),
      ...likedThemes.slice(0, 5).map((theme) => `Strength: ${theme}`),
    ],
    actionsAr: [],
    actionsEn: [],
  };

  if (stats.average !== null && stats.average < 3.5 && stats.count >= 3) {
    analysis.actionsAr.push("متوسط التقييم منخفض: راجع أسباب عدم الرضا في التقارير واجتماع الفريق.");
    analysis.actionsEn.push("Average rating is low: review the dissatisfaction reasons in the weekly meeting.");
  }
  if (low.length > 0) {
    analysis.actionsAr.push(`${low.length} تقييم منخفض يحتاج متابعة شخصية من المالك أو الشريك.`);
    analysis.actionsEn.push(`${low.length} low rating(s) need a personal follow-up from the owner or partner.`);
  }
  if (reviews.length === 0) {
    analysis.actionsAr.push("لا توجد تقييمات بعد: التقييمات تُطلب تلقائيًا عند إنجاز كل مشروع.");
    analysis.actionsEn.push("No reviews yet: they are requested automatically when a project completes.");
  }

  await runAgent(
    "satisfaction",
    { trigger: "analysis.requested", locale, input: { count: stats.count } },
    async ({ record }) => {
      if (low.length > 0) {
        record({
          action: "low_rating_detected",
          summary: `${low.length} تقييم منخفض يحتاج متابعة`,
          entityType: "review",
          entityId: low[0]!.id,
          customerId: low[0]!.customer_id,
          riskLevel: "MEDIUM",
          requiresApproval: true,
        });
      }
      return {
        data: { average: stats.average, count: stats.count, low: low.length },
        summary: `تحليل ${stats.count} تقييم (متوسط ${stats.average ?? "—"})`,
        riskLevel: "LOW",
      };
    },
  );

  if (low.length > 0) {
    await raiseAlert({
      severity: "IMPORTANT",
      category: "satisfaction",
      title_ar: "تقييمات منخفضة تحتاج متابعة",
      title_en: "Low ratings need follow-up",
      body_ar: `${low.length} عميل قيّم تجربته بثلاث نجوم أو أقل. يُنصح بمتابعة شخصية من المالك أو الشريك.`,
      body_en: `${low.length} client(s) rated their experience 3 stars or less. A personal follow-up is recommended.`,
      dedupe_key: `low-ratings:${new Date().toISOString().slice(0, 10)}`,
    });
  }

  return analysis;
}

/** Requests a review after project completion (short, non-intrusive). */
export async function requestReview(input: {
  customer: CustomerRow;
  projectId: string;
  projectTitle: string;
  locale: Locale;
}): Promise<void> {
  if (!input.customer.user_id) return;
  const text =
    input.locale === "ar"
      ? `أنجزنا «${input.projectTitle}». هل يمكنك تقييم تجربتك؟\n١) تقييم من ١ إلى ٥\n٢) ما الذي أعجبك؟\n٣) ما الذي يحتاج تحسينًا؟\n٤) هل تحتاج خدمة أخرى؟`
      : `We completed "${input.projectTitle}". Could you rate your experience?\n1) Rating from 1 to 5\n2) What did you like?\n3) What needs improvement?\n4) Do you need another service?`;

  await createNotification({
    user_id: input.customer.user_id,
    channel: "IN_APP",
    subject: input.locale === "ar" ? "قيّم تجربتك مع أفق" : "Rate your experience with Ofoq",
    body: text,
    status: "QUEUED",
  });

  await runAgent(
    "satisfaction",
    {
      trigger: "project.completed",
      locale: input.locale,
      customerId: input.customer.id,
      projectId: input.projectId,
    },
    async ({ record }) => {
      record({
        action: "review_requested",
        summary: `طُلب تقييم العميل لمشروع ${input.projectTitle}`,
        entityType: "project",
        entityId: input.projectId,
        riskLevel: "LOW",
      });
      return { data: {}, summary: "طلب تقييم", riskLevel: "LOW" };
    },
  );
}

/** Records a submitted review and reacts to low ratings. */
export async function recordReviewFeedback(input: {
  reviewId: string;
  rating: number;
  liked?: string | null;
  improve?: string | null;
  wantsMore?: boolean;
  note?: string | null;
  locale: Locale;
  actorUserId: string;
}): Promise<void> {
  if (input.rating < 1 || input.rating > 5) throw new Error("Rating must be between 1 and 5");
  const { findRowById } = await import("@/lib/repositories/base");
  const review = await findRowById<ReviewRow>("reviews", input.reviewId);
  if (!review) throw new Error("Review not found");

  await updateReview(input.reviewId, {
    rating: input.rating,
    liked: input.liked ?? null,
    improve: input.improve ?? null,
    wants_more: input.wantsMore ? 1 : 0,
    note: input.note ?? null,
    status: "PENDING",
  });

  await logActivity({
    actor_type: "USER",
    actor_user_id: input.actorUserId,
    action: "review.submitted",
    entity_type: "review",
    entity_id: input.reviewId,
    customer_id: review.customer_id,
    summary: `Review submitted (${input.rating}/5)`,
  });

  await runAgent(
    "satisfaction",
    {
      trigger: "review.submitted",
      locale: input.locale,
      customerId: review.customer_id,
      input: { rating: input.rating },
    },
    async ({ record }) => {
      record({
        action: "review.recorded",
        summary: `تقييم جديد: ${input.rating}/5`,
        entityType: "review",
        entityId: input.reviewId,
        riskLevel: input.rating <= 3 ? "MEDIUM" : "LOW",
        requiresApproval: input.rating <= 3,
      });
      return { data: { rating: input.rating }, summary: `تقييم ${input.rating}/5`, riskLevel: "LOW" };
    },
  );
}

/**
 * Publishes a review on the marketing site. Requires an explicit owner/partner
 * decision and an approved display name; sensitive notes are never published.
 */
export async function publishReview(input: {
  reviewId: string;
  displayName: string;
  actorUserId: string;
  approve: boolean;
}): Promise<void> {
  const { findRowById } = await import("@/lib/repositories/base");
  const review = await findRowById<ReviewRow>("reviews", input.reviewId);
  if (!review) throw new Error("Review not found");

  await updateReview(input.reviewId, {
    status: input.approve ? "APPROVED" : "REJECTED",
    published: input.approve ? 1 : 0,
    published_name: input.approve ? input.displayName.slice(0, 80) : null,
    published_at: input.approve ? nowIso() : null,
  });

  await logActivity({
    actor_type: "USER",
    actor_user_id: input.actorUserId,
    action: input.approve ? "review.published" : "review.rejected",
    entity_type: "review",
    entity_id: input.reviewId,
    customer_id: review.customer_id,
    summary: input.approve
      ? `Review published as "${input.displayName}"`
      : "Review rejected for publication",
  });
}

export async function publicReviews(limit = 12): Promise<ReviewRow[]> {
  return listReviews({ publishedOnly: true, status: ["APPROVED"], limit });
}

export async function customerReviews(customerId: string): Promise<ReviewRow[]> {
  return listReviews({ customerId, limit: 50 });
}

/** Reminder for a project that finished a while ago and still has no review. */
export async function followUpMissingReviews(locale: Locale): Promise<number> {
  const { rows } = await listProjects({ status: ["COMPLETED"], limit: 50 });
  const reviews = await listReviews({ limit: 200 });
  const reviewedProjectIds = new Set(reviews.map((review) => review.project_id).filter(Boolean));
  let sent = 0;

  for (const project of rows) {
    if (reviewedProjectIds.has(project.id)) continue;
    if (!project.completed_at) continue;
    const daysSince = Math.floor(
      (Date.now() - new Date(project.completed_at).getTime()) / 86_400_000,
    );
    if (daysSince < 2 || daysSince > 14) continue;

    const { findCustomerById } = await import("@/lib/repositories/customers.repo");
    const customer = await findCustomerById(project.customer_id);
    if (!customer) continue;
    await requestReview({ customer, projectId: project.id, projectTitle: project.title, locale });
    sent += 1;
  }
  void addDays;
  return sent;
}

function collectThemes(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const normalised = value.trim().toLowerCase().slice(0, 120);
    if (!normalised) continue;
    counts.set(normalised, (counts.get(normalised) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([theme, count]) => (count > 1 ? `${theme} (${count})` : theme));
}
