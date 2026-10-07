import { addDays, nowIso, toDateKey } from "@/lib/core/date";
import { getDb } from "@/lib/db";
import { findUserByEmail, updateUser } from "@/lib/repositories/identity.repo";
import { createUser } from "@/lib/repositories/identity.repo";
import { createCustomer, upsertCustomerFact } from "@/lib/repositories/customers.repo";
import { listServices } from "@/lib/repositories/catalog.repo";
import { createProject, createProjectTask } from "@/lib/repositories/projects.repo";
import { createOffer, addOfferItem } from "@/lib/repositories/offers.repo";
import { createInvoice, createPayment } from "@/lib/repositories/billing.repo";
import { createCampaign, upsertCampaignMetrics } from "@/lib/repositories/growth.repo";
import { createReview } from "@/lib/repositories/governance.repo";
import { hashPassword } from "./identity.service";

/**
 * Demo data.
 *
 * Everything created here is flagged `is_demo = 1` and is clearly labelled in the
 * UI ("بيانات تجريبية"). It exists ONLY so the dashboards, reports and client
 * portal can be exercised before the agency has real clients.
 *
 * It is deliberately:
 *   · excluded from any public/marketing surface,
 *   · removable with `npm run db:reset -- --demo`,
 *   · never seeded when NODE_ENV=production.
 */

export async function enableEmailVerificationForStaff(email: string): Promise<void> {
  const user = await findUserByEmail(email);
  if (user) await updateUser(user.id, { email_verified_at: nowIso() });
}

export interface DemoSummary {
  customer: string;
  password: string;
}

export async function seedDemoData(): Promise<string> {
  const db = await getDb();
  const existing = await db.get<{ total: number }>("SELECT COUNT(*) AS total FROM customers WHERE is_demo = 1");
  if (Number(existing?.total ?? 0) > 0) {
    return "demo records already present (nothing to do)";
  }

  const password = "DemoClient!2026";
  const user = await createUser({
    email: "demo.client@ofaq.test",
    name: "عميل تجريبي",
    role: "CLIENT",
    locale: "ar",
    password_hash: await hashPassword(password),
    email_verified_at: nowIso(),
    status: "ACTIVE",
    is_demo: 1,
  });

  const customer = await createCustomer({
    user_id: user.id,
    company_name: "متجر تجريبي (بيانات تجريبية)",
    contact_name: "عميل تجريبي",
    email: user.email,
    country: "IQ",
    city: "بغداد",
    locale: "ar",
    currency: "USD",
    status: "ACTIVE",
    source: "demo-seed",
    goals: "زيادة المبيعات عبر إنستغرام وفيسبوك",
    needs: "إدارة حسابات + إعلانات مدفوعة",
    is_demo: 1,
  });

  await upsertCustomerFact(
    {
      customer_id: customer.id,
      fact_key: "services",
      fact_value: "social-media-management,paid-ads",
      source: "IMPORT",
      confidence: 1,
      verified: true,
    },
  );
  await upsertCustomerFact(
    {
      customer_id: customer.id,
      fact_key: "journey_stage",
      fact_value: "DELIVERING",
      source: "IMPORT",
      confidence: 1,
      verified: true,
    },
  );

  const services = await listServices({ activeOnly: true });
  const social = services.find((service) => service.slug === "social-media-management");
  const ads = services.find((service) => service.slug === "paid-ads");

  const project = await createProject({
    customer_id: customer.id,
    code: `OFQ-P-${new Date().getUTCFullYear()}-9001`,
    title: "إدارة حسابات وإعلانات (بيانات تجريبية)",
    title_en: "Social + ads management (demo data)",
    brief: "مشروع تجريبي لعرض وظائف المنصة كاملة.",
    status: "IN_PROGRESS",
    currency: "USD",
    amount_total_minor: 75_000,
    internal_cost_minor: 41_250,
    margin_pct: 45,
    country: "IQ",
    progress: 40,
    risk_level: "LOW",
    start_date: addDays(new Date(), -14).toISOString(),
    due_date: addDays(new Date(), 16).toISOString(),
    is_demo: 1,
    created_by_agent: "orchestrator",
  });

  for (const [index, title] of [
    "تحليل الاحتياج وتثبيت الأهداف",
    "خطة نشر الشهر الحالي",
    "إعداد مواد الشهر (١٢ منشورًا)",
    "إطلاق الحملة الإعلانية",
    "تقرير أداء أول",
  ].entries()) {
    await createProjectTask({
      project_id: project.id,
      title,
      status: index < 2 ? "DONE" : "TODO",
      visibility: index === 3 ? "INTERNAL" : "CLIENT",
      sort_order: index,
    });
  }

  const offer = await createOffer({
    code: `OFQ-O-${new Date().getUTCFullYear()}-9001`,
    customer_id: customer.id,
    project_id: project.id,
    status: "APPROVED",
    currency: "USD",
    subtotal_minor: 75_000,
    total_minor: 75_000,
    internal_cost_minor: 41_250,
    margin_pct: 45,
    pricing_reason: "demo:base",
    valid_until: addDays(new Date(), 10).toISOString(),
    client_note: "بيانات تجريبية للعرض فقط.",
    created_by_agent: "proposal_writer",
    approved_at: addDays(new Date(), -14).toISOString(),
    is_demo: 1,
  });

  if (social) {
    await addOfferItem({
      offer_id: offer.id,
      service_id: social.id,
      description_ar: social.name_ar,
      description_en: social.name_en,
      quantity: 1,
      unit_price_minor: 35_000,
      billing_type: "SUBSCRIPTION",
      months: 1,
      total_minor: 35_000,
      sort_order: 0,
    });
  }
  if (ads) {
    await addOfferItem({
      offer_id: offer.id,
      service_id: ads.id,
      description_ar: ads.name_ar,
      description_en: ads.name_en,
      quantity: 1,
      unit_price_minor: 40_000,
      billing_type: "SUBSCRIPTION",
      months: 1,
      total_minor: 40_000,
      sort_order: 1,
    });
  }

  const invoice = await createInvoice({
    number: `INV-${new Date().getUTCFullYear()}-9001`,
    customer_id: customer.id,
    project_id: project.id,
    offer_id: offer.id,
    currency: "USD",
    subtotal_minor: 75_000,
    total_minor: 75_000,
    status: "PARTIALLY_PAID",
    amount_paid_minor: 40_000,
    issued_at: addDays(new Date(), -14).toISOString(),
    due_at: addDays(new Date(), -2).toISOString(),
    notes_client: "فاتورة تجريبية.",
    is_demo: 1,
  });

  await createPayment({
    invoice_id: invoice.id,
    customer_id: customer.id,
    amount_minor: 40_000,
    currency: "USD",
    method: "MANUAL_TRANSFER",
    provider: "manual",
    status: "SUCCEEDED",
    paid_at: addDays(new Date(), -10).toISOString(),
    note: "دفعة تجريبية",
    is_demo: 1,
  });

  const campaign = await createCampaign({
    customer_id: customer.id,
    project_id: project.id,
    platform: "GOOGLE_ADS",
    name: "حملة تجريبية — بحث (بيانات تجريبية)",
    objective: "زيادة الطلبات",
    status: "ACTIVE",
    currency: "USD",
    total_budget_minor: 100_000,
    daily_budget_minor: 5_000,
    monthly_budget_minor: 60_000,
    spent_minor: 21_400,
    start_date: addDays(new Date(), -12).toISOString(),
    end_date: addDays(new Date(), 18).toISOString(),
    autopilot_enabled: 1,
    safe_limits: JSON.stringify({
      maxDailyBudgetMinor: 10_000,
      maxMonthlyBudgetMinor: 200_000,
      maxTotalBudgetMinor: 1_000_000,
      maxBudgetShiftPercent: 20,
      minImpressionsBeforePause: 1_000,
      weakCtrThreshold: 0.5,
      allowAutoPause: true,
      allowAutoCopyChanges: true,
    }),
    // Nothing is synced: no Google Ads account exists.
    sync_status: "NOT_CONNECTED",
    created_by_agent: "ads_manager",
    is_demo: 1,
  });

  // Placeholder metrics so the reporting UI has something to render — clearly
  // demo-flagged and labelled as such in the UI, never presented as real results.
  for (let index = 11; index >= 0; index -= 1) {
    const impressions = 900 + index * 37;
    const clicks = Math.round(impressions * (0.011 + (index % 4) * 0.002));
    await upsertCampaignMetrics({
      campaign_id: campaign.id,
      metric_date: toDateKey(addDays(new Date(), -index)),
      impressions,
      clicks,
      cost_minor: clicks * 120,
      conversions: Math.max(0, Math.round(clicks / 22)),
      source: "MANUAL",
      raw: { demo: true },
    });
  }

  await createReview({
    customer_id: customer.id,
    project_id: project.id,
    rating: 5,
    satisfaction: "مرتاح",
    liked: "سرعة الرد ووضوح التقارير",
    improve: "لا شيء حاليًا",
    wants_more: 1,
    note: "تقييم تجريبي (بيانات تجريبية)",
    status: "PENDING",
    published: 0,
    is_demo: 1,
  });

  return `demo client ${user.email} / ${password}`;
}

/** Removes every demo record. Real data is never touched. */
export async function removeDemoData(): Promise<string> {
  const db = await getDb();
  const demoCustomers = await db.query<{ id: string }>("SELECT id FROM customers WHERE is_demo = 1");
  const demoUsers = await db.query<{ id: string }>("SELECT id FROM users WHERE is_demo = 1");

  // Child rows cascade from customers/users, but the tables below hold rows the
  // cascade cannot reach (demo-only rows attached to non-demo parents).
  const statements = [
    "DELETE FROM campaign_metrics_daily WHERE campaign_id IN (SELECT id FROM campaigns WHERE is_demo = 1)",
    "DELETE FROM campaign_changes WHERE campaign_id IN (SELECT id FROM campaigns WHERE is_demo = 1)",
    "DELETE FROM campaigns WHERE is_demo = 1",
    "DELETE FROM reports WHERE is_demo = 1",
    "DELETE FROM payments WHERE is_demo = 1",
    "DELETE FROM invoices WHERE is_demo = 1",
    "DELETE FROM offers WHERE is_demo = 1",
    "DELETE FROM projects WHERE is_demo = 1",
    "DELETE FROM reviews WHERE is_demo = 1",
    "DELETE FROM messages WHERE is_demo = 1",
    "DELETE FROM conversations WHERE is_demo = 1",
    "DELETE FROM files WHERE is_demo = 1",
    "DELETE FROM activities WHERE is_demo = 1",
    "DELETE FROM agent_runs WHERE is_demo = 1",
    "DELETE FROM agent_actions WHERE is_demo = 1",
    "DELETE FROM alerts WHERE is_demo = 1",
  ];
  for (const statement of statements) {
    await db.exec(statement);
  }
  for (const customer of demoCustomers) {
    await db.run("DELETE FROM customers WHERE id = ?", [customer.id]);
  }
  for (const user of demoUsers) {
    await db.run("DELETE FROM users WHERE id = ?", [user.id]);
  }

  return `removed ${demoCustomers.length} demo client(s) and ${demoUsers.length} demo user(s)`;
}
