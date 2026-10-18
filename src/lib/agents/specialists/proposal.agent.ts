import { formatMoney } from "@/lib/core/money";
import type { CustomerRow, Locale, OfferWithItems, ProjectRow } from "@/lib/domain/types";
import { createOfferFromQuote } from "@/lib/services/offers.service";
import { attachServicesToProject, createProjectForCustomer } from "@/lib/services/projects.service";

import { runAgent } from "../runtime";
import type { PricingOutcome } from "./pricing.agent";
import type { RequirementProfile } from "./needs.agent";

/**
 * Proposal writer.
 *
 * Converts a priced requirement into two linked records:
 *   · a project (the delivery container), and
 *   · an offer (what the client reviews and approves).
 *
 * The offer always carries the pricing reason, the breakdown, the internal cost
 * and the policy snapshot. When the pricing agent reported an escalation, the
 * offer is created as a DRAFT and an alert goes to the owner/partner instead of
 * being sent to the client.
 */
export interface ProposalOutcome {
  project: ProjectRow;
  offer: OfferWithItems;
  sentToClient: boolean;
  requiresApproval: boolean;
}

export async function buildProposal(input: {
  customer: CustomerRow;
  profile: RequirementProfile;
  pricing: PricingOutcome;
  locale: Locale;
  projectId?: string | null;
  createdByUserId?: string | null;
  send?: boolean;
}): Promise<ProposalOutcome> {
  const { customer, profile, pricing, locale } = input;
  const title =
    profile.services.length > 0
      ? profile.services.map((slug) => prettifySlug(slug)).join(" + ")
      : locale === "ar"
        ? "مشروع جديد"
        : "New project";

  const project =
    (input.projectId
      ? await (async () => {
          const { findProjectById } = await import("@/lib/repositories/projects.repo");
          return (await findProjectById(input.projectId!)) ?? null;
        })()
      : null) ??
    (await createProjectForCustomer({
      customer,
      title: locale === "ar" ? `${title} — ${customer.contact_name}` : `${title} — ${customer.contact_name}`,
      titleEn: title,
      brief: buildBrief(profile, locale),
      currency: pricing.quote.currency,
      dueDate: pricing.quote.deliveryDays
        ? new Date(Date.now() + pricing.quote.deliveryDays * 86_400_000).toISOString()
        : null,
      createdByUserId: input.createdByUserId ?? null,
      createdByAgent: "proposal_writer",
      status: pricing.autoApproved ? "AWAITING_APPROVAL" : "DRAFT",
    }));

  await attachServicesToProject(
    project.id,
    pricing.quote.lines.map((line) => {
      const service = pricing.services.find((candidate) => candidate.id === line.serviceId)!;
      return {
        service,
        quantity: line.quantity,
        unitPriceMinor: line.unitPriceMinor,
        months: line.months,
      };
    }),
  );

  // Owner approval is mandatory before any offer reaches a client (Offers
  // Agent rule): proposals are ALWAYS drafts here, whatever the caller or the
  // pricing outcome suggested. Sending happens only via approveAndSendOffer.
  void input.send;
  const offer = await createOfferFromQuote({
    customer,
    quote: pricing.quote,
    projectId: project.id,
    locale,
    createdByAgent: "proposal_writer",
    createdByUserId: input.createdByUserId ?? null,
    send: false,
  });

  const requiresApproval = true;

  await runAgent(
    "proposal_writer",
    {
      trigger: "pricing.ready",
      locale,
      customerId: customer.id,
      projectId: project.id,
      input: { offerId: offer.id, totalMinor: pricing.quote.totalMinor },
    },
    async ({ record }) => {
      record({
        action: "offer.created",
        summary: `عرض ${offer.code} بمبلغ ${formatMoney(offer.total_minor, offer.currency, locale)}`,
        reason: pricing.quote.reasons.slice(0, 10).join(" | "),
        entityType: "offer",
        entityId: offer.id,
        riskLevel: pricing.quote.riskLevel,
        requiresApproval,
        payload: { projectId: project.id, totalMinor: offer.total_minor },
      });
      if (requiresApproval) {
        record({
          action: "offer.held_for_approval",
          summary: "العرض محتفظ به لمراجعة المالك أو الشريك قبل إرساله",
          riskLevel: "HIGH",
          requiresApproval: true,
          entityType: "offer",
          entityId: offer.id,
        });
      }
      return {
        data: { offerId: offer.id, projectId: project.id, totalMinor: offer.total_minor },
        summary: requiresApproval
          ? `عرض بانتظار الموافقة: ${offer.code}`
          : `تم إنشاء العرض ${offer.code} وإرساله للعميل`,
        riskLevel: pricing.quote.riskLevel,
      };
    },
  );

  if (requiresApproval) {
    const { alertNeedsHuman } = await import("@/lib/services/alerts.service");
    await alertNeedsHuman({
      reason: "pricing_escalation",
      detailAr: `العرض ${offer.code} يحتاج مراجعة قبل الإرسال: ${pricing.escalations
        .map((entry) => entry.messageAr)
        .join(" · ")}`,
      detailEn: `Offer ${offer.code} needs review before sending: ${pricing.escalations
        .map((entry) => entry.messageEn)
        .join(" · ")}`,
      customerId: customer.id,
      entityType: "offer",
      entityId: offer.id,
      severity: "IMPORTANT",
      dedupeKey: `offer-approval:${offer.id}`,
    });
  }

  return { project, offer, sentToClient: false, requiresApproval };
}

function buildBrief(profile: RequirementProfile, locale: Locale): string {
  const lines: string[] = [];
  if (profile.goal) lines.push(locale === "ar" ? `الهدف: ${profile.goal}` : `Goal: ${profile.goal}`);
  if (profile.services.length) {
    lines.push(
      `${locale === "ar" ? "الخدمات" : "Services"}: ${profile.services.map(prettifySlug).join(", ")}`,
    );
  }
  if (profile.platforms.length) {
    lines.push(`${locale === "ar" ? "المنصات" : "Platforms"}: ${profile.platforms.join(", ")}`);
  }
  if (profile.volume) lines.push(`${locale === "ar" ? "الكمية" : "Volume"}: ${profile.volume}`);
  if (profile.timelineDays) {
    lines.push(`${locale === "ar" ? "المدة المطلوبة" : "Requested timeline"}: ${profile.timelineDays} days`);
  }
  if (profile.country) lines.push(`${locale === "ar" ? "السوق" : "Market"}: ${profile.country}`);
  if (profile.notes.length) {
    lines.push(`${locale === "ar" ? "ملاحظات العميل" : "Client notes"}: ${profile.notes.join(" · ")}`);
  }
  return lines.join("\n");
}

export function prettifySlug(slug: string): string {
  const labels: Record<string, { ar: string; en: string }> = {
    "social-media-management": { ar: "إدارة حسابات التواصل", en: "Social media management" },
    "content-design": { ar: "كتابة وتصميم المنشورات", en: "Post writing and design" },
    "content-strategy": { ar: "خطة المحتوى والنشر", en: "Content strategy and calendar" },
    "paid-ads": { ar: "إدارة الإعلانات المدفوعة", en: "Paid ads management" },
    branding: { ar: "الهوية والمواد التسويقية", en: "Branding and marketing materials" },
    "web-development": { ar: "إنشاء وتطوير المواقع", en: "Website development" },
    seo: { ar: "تحسين محركات البحث", en: "SEO" },
    "analytics-reports": { ar: "تحليل الأداء والتقارير", en: "Analytics and reporting" },
    consulting: { ar: "استشارات وخطط تسويقية", en: "Consulting and marketing plans" },
  };
  return labels[slug]?.en ?? slug.replace(/-/g, " ");
}
