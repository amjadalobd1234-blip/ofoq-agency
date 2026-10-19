import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The Projects API: UI → routes → services → permissions.
 *
 * The Supabase session resolution is mocked (the same pattern as the offers
 * route tests); the service layer and the database are real, so these tests
 * prove the wiring and the authorisation of the HTTP surface.
 */
const profiles = vi.hoisted(() => ({ byId: new Map<string, { id: string; role: string; status: string }>() }));

vi.mock("@/lib/supabase/config", () => ({
  getSupabaseConfig: () => ({ url: "https://test.supabase.co", anonKey: "test" }),
}));

vi.mock("@/lib/supabase/route-auth", () => ({
  requireSupabaseUser: (request: Request) => {
    const id = request.headers.get("x-test-user");
    if (!id) return Promise.resolve({ response: Response.json({ error: "auth" }, { status: 401 }) });
    return Promise.resolve({
      client: {}, user: { id }, requestId: "test",
      finalize: (response: Response) => response,
    });
  },
  fetchOwnProfile: (_client: unknown, id: string) => {
    const profile = profiles.byId.get(id);
    return Promise.resolve(profile ? { profile } : { error: { code: "NO_PROFILE", message: "none" } });
  },
}));

const { GET: listProjects, POST: createProject } = await import("../src/app/api/projects/route");
const { GET: getProject, PATCH: patchProject } = await import("../src/app/api/projects/[id]/route");
const { POST: savePlan } = await import("../src/app/api/projects/[id]/plan/route");
const { POST: submitPlan } = await import("../src/app/api/projects/[id]/plan/submit/route");
const { POST: approvePlanRoute } = await import("../src/app/api/projects/[id]/plan/approve/route");
const { PATCH: updateTask } = await import("../src/app/api/projects/[id]/tasks/[taskId]/route");
const { POST: closeProjectRoute } = await import("../src/app/api/projects/[id]/close/route");
const { POST: monitorRoute } = await import("../src/app/api/projects/monitor/route");

const { createCustomer } = await import("../src/lib/repositories/customers.repo");
const { createUser } = await import("../src/lib/repositories/identity.repo");
const { createOffer } = await import("../src/lib/repositories/offers.repo");
const { listProjectTasks } = await import("../src/lib/repositories/projects.repo");

function req(userId: string | null, body?: unknown, method = "GET", path = "/api/projects"): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(userId ? { "x-test-user": userId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const taskCtx = (id: string, taskId: string) => ({ params: Promise.resolve({ id, taskId }) });

let ownerId = "";
let partnerId = "";
let clientId = "";
let otherClientId = "";
let customerId = "";
let otherCustomerId = "";
let approvedOfferId = "";
let sentOfferId = "";

beforeAll(async () => {
  const owner = await createUser({ email: "pa-owner@example.test", name: "Owner", role: "OWNER" });
  const partner = await createUser({ email: "pa-partner@example.test", name: "Partner", role: "PARTNER" });
  const client = await createUser({ email: "pa-client@example.test", name: "Client", role: "CLIENT" });
  const other = await createUser({ email: "pa-other@example.test", name: "Other", role: "CLIENT" });
  ownerId = owner.id;
  partnerId = partner.id;
  clientId = client.id;
  otherClientId = other.id;

  const customer = await createCustomer({
    user_id: client.id, contact_name: "Client", email: client.email,
    locale: "ar", currency: "USD", country: "IQ", status: "ACTIVE",
  });
  const otherCustomer = await createCustomer({
    user_id: other.id, contact_name: "Other", email: other.email,
    locale: "ar", currency: "USD", country: "IQ", status: "ACTIVE",
  });
  customerId = customer.id;
  otherCustomerId = otherCustomer.id;

  const approved = await createOffer({
    customer_id: customerId, code: "OFOQ-TEST-001", status: "APPROVED",
    currency: "USD", subtotal_minor: 100_00, total_minor: 100_00,
    internal_cost_minor: 40_00, margin_pct: 60, approved_at: new Date().toISOString(),
  });
  const sent = await createOffer({
    customer_id: customerId, code: "OFOQ-TEST-002", status: "SENT",
    currency: "USD", subtotal_minor: 50_00, total_minor: 50_00, internal_cost_minor: 20_00,
  });
  approvedOfferId = approved.id;
  sentOfferId = sent.id;

  profiles.byId.set(ownerId, { id: ownerId, role: "OWNER", status: "ACTIVE" });
  profiles.byId.set(partnerId, { id: partnerId, role: "PARTNER", status: "ACTIVE" });
  profiles.byId.set(clientId, { id: clientId, role: "CLIENT", status: "ACTIVE" });
  profiles.byId.set(otherClientId, { id: otherClientId, role: "CLIENT", status: "ACTIVE" });
});

describe("projects API routes", () => {
  it("refuses anonymous callers and clients on the staff actions", async () => {
    expect((await listProjects(req(null))).status).toBe(401);
    expect((await createProject(req(null, { customerId, title: "مشروع" }, "POST"))).status).toBe(401);

    // A client may not create a project, save a plan, update a task, monitor
    // or close a project.
    expect((await createProject(req(clientId, { customerId, title: "مشروع" }, "POST"))).status).toBe(403);
    expect((await monitorRoute(req(clientId, {}, "POST"))).status).toBe(403);
  });

  it("creates a project for a customer from a service and links an accepted offer", async () => {
    const created = await createProject(
      req(ownerId, { customerId, title: "مشروع من خدمة", serviceSlug: "social-media-management" }, "POST"),
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      data: { project: { id: string; code: string; status: string }; plan: { status: string; taskCount: number }; requiresOwnerApproval: boolean };
    };
    expect(body.data.project.status).toBe("DRAFT");
    expect(body.data.plan.status).toBe("DRAFT");
    expect(body.data.plan.taskCount).toBeGreaterThan(0);
    expect(body.data.requiresOwnerApproval).toBe(true);

    // An offer that the client has NOT accepted cannot start a project.
    const fromSentOffer = await createProject(
      req(ownerId, { customerId, title: "مشروع من عرض", offerId: sentOfferId }, "POST"),
    );
    expect(fromSentOffer.status).toBe(412);

    const fromOffer = await createProject(
      req(ownerId, { customerId, title: "مشروع من عرض", offerId: approvedOfferId }, "POST"),
    );
    expect(fromOffer.status).toBe(201);
    const offerBody = (await fromOffer.json()) as { data: { project: { id: string } } };
    const { findOfferById } = await import("../src/lib/repositories/offers.repo");
    const offer = await findOfferById(approvedOfferId);
    expect(offer?.project_id).toBe(offerBody.data.project.id);
  });

  it("keeps the plan approval with the owner and lets the client read the project", async () => {
    const created = await createProject(
      req(ownerId, { customerId, title: "مشروع للاعتماد", serviceSlug: "consulting" }, "POST"),
    );
    const body = (await created.json()) as { data: { project: { id: string } } };
    const projectId = body.data.project.id;

    // The plan is saved and submitted…
    const saved = await savePlan(
      req(ownerId, {
        phases: [
          {
            key: "PHASE_1",
            title: "التحضير",
            dueDate: "2026-12-01",
            owner: "content",
            tasks: [{ title: "مهمة أولى", dueDate: "2026-11-20", owner: "content" }],
          },
        ],
      }, "POST", `/api/projects/${projectId}/plan`),
      ctx(projectId),
    );
    expect(saved.status).toBe(200);
    const submitted = await submitPlan(req(ownerId, {}, "POST", `/api/projects/${projectId}/plan/submit`), ctx(projectId));
    expect(submitted.status).toBe(200);

    // …but only the owner can approve it.
    expect((await approvePlanRoute(req(partnerId, {}, "POST"), ctx(projectId))).status).toBe(403);
    const approved = await approvePlanRoute(req(ownerId, {}, "POST"), ctx(projectId));
    expect(approved.status).toBe(200);
    const approvedBody = (await approved.json()) as { data: { plan: { status: string } } };
    expect(approvedBody.data.plan.status).toBe("APPROVED");

    // The client reads the project: the client-safe view, with no internal data.
    const clientView = await getProject(req(clientId, undefined, "GET", `/api/projects/${projectId}`), ctx(projectId));
    expect(clientView.status).toBe(200);
    const text = JSON.stringify(await clientView.json());
    expect(text).not.toContain("internal_cost_minor");
    expect(text).not.toContain("margin_pct");
    expect(text).not.toContain("INTERNAL");

    // Another client cannot read it.
    const other = await getProject(req(otherClientId, undefined, "GET", `/api/projects/${projectId}`), ctx(projectId));
    expect(other.status).toBe(404);
  });

  it("updates a task with an internal note and refuses the client", async () => {
    const created = await createProject(
      req(ownerId, { customerId, title: "مشروع المهام", serviceSlug: "seo" }, "POST"),
    );
    const body = (await created.json()) as { data: { project: { id: string } } };
    const projectId = body.data.project.id;
    const tasks = await listProjectTasks(projectId, { includeInternal: true });
    const task = tasks.find((row) => row.visibility === "CLIENT")!;

    expect(
      (await updateTask(req(clientId, { status: "DONE" }, "PATCH"), taskCtx(projectId, task.id))).status,
    ).toBe(403);

    const updated = await updateTask(
      req(ownerId, { status: "IN_PROGRESS", note: "ملاحظة داخلية" }, "PATCH"),
      taskCtx(projectId, task.id),
    );
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as { data: { status: string } };
    expect(updatedBody.data.status).toBe("IN_PROGRESS");

    const staffView = await getProject(req(ownerId, undefined, "GET", `/api/projects/${projectId}`), ctx(projectId));
    const staffText = JSON.stringify(await staffView.json());
    expect(staffText).toContain("ملاحظة داخلية");
  });

  it("closes a project only on an explicit owner decision", async () => {
    const created = await createProject(
      req(ownerId, { customerId, title: "مشروع الإغلاق", serviceSlug: "consulting" }, "POST"),
    );
    const body = (await created.json()) as { data: { project: { id: string } } };
    const projectId = body.data.project.id;

    // A partner can never close a project.
    expect((await closeProjectRoute(req(partnerId, {}, "POST"), ctx(projectId))).status).toBe(403);

    // The plan is still a draft: nothing is committed, so the owner may close
    // the project right away.
    const closedDraft = await closeProjectRoute(req(ownerId, {}, "POST"), ctx(projectId));
    expect(closedDraft.status).toBe(200);
    const draftBody = (await closedDraft.json()) as { data: { status: string } };
    expect(draftBody.data.status).toBe("COMPLETED");
  });

  it("blocks the closing while committed work is still open", async () => {
    const created = await createProject(
      req(ownerId, { customerId, title: "مشروع بمهام مفتوحة", serviceSlug: "consulting" }, "POST"),
    );
    const body = (await created.json()) as { data: { project: { id: string } } };
    const projectId = body.data.project.id;

    // The owner approves the plan: the tasks become committed work.
    await approvePlanRoute(req(ownerId, {}, "POST"), ctx(projectId));

    const tasks = await listProjectTasks(projectId, { includeInternal: true });
    const open = tasks.filter((row) => row.visibility === "CLIENT");
    expect(open.length).toBeGreaterThan(0);

    const blocked = await closeProjectRoute(req(ownerId, {}, "POST"), ctx(projectId));
    expect(blocked.status).toBe(412);

    for (const task of open) {
      await updateTask(req(ownerId, { status: "DONE" }, "PATCH"), taskCtx(projectId, task.id));
    }

    const closed = await closeProjectRoute(req(ownerId, {}, "POST"), ctx(projectId));
    expect(closed.status).toBe(200);
    const closedBody = (await closed.json()) as { data: { status: string; progress: number } };
    expect(closedBody.data.status).toBe("COMPLETED");
    expect(closedBody.data.progress).toBe(100);
  });

  it("lists only the client's own projects and keeps the staff list complete", async () => {
    // A project of another customer: the client must never see it.
    await createProject(
      req(ownerId, { customerId: otherCustomerId, title: "مشروع عميل آخر", serviceSlug: "seo" }, "POST"),
    );

    const staff = await listProjects(req(ownerId));
    expect(staff.status).toBe(200);
    const staffBody = (await staff.json()) as { data: { rows: { id: string; customerId: string; plan: unknown }[] } };
    expect(staffBody.data.rows.length).toBeGreaterThan(0);
    expect(staffBody.data.rows.some((row) => row.customerId === otherCustomerId)).toBe(true);

    const client = await listProjects(req(clientId));
    expect(client.status).toBe(200);
    const clientBody = (await client.json()) as { data: { rows: { id: string; code: string }[] } };
    const clientIds = new Set(clientBody.data.rows.map((row) => row.id));
    const otherIds = new Set(
      staffBody.data.rows.filter((row) => row.customerId === otherCustomerId).map((row) => row.id),
    );
    expect(clientIds.size).toBeGreaterThan(0);
    for (const id of clientIds) expect(otherIds.has(id)).toBe(false);
    // The client list never carries the internal risk level.
    expect(JSON.stringify(clientBody)).not.toContain("riskLevel");
  });

  it("runs the delivery watch for the staff only", async () => {
    const response = await monitorRoute(req(ownerId));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { alerts: number } };
    expect(typeof body.data.alerts).toBe("number");
  });
});
