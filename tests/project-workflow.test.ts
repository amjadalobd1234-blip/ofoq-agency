import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The full Projects Agent cycle, end to end over HTTP:
 *
 *   create the project → prepare the plan → the owner's approval →
 *   execute and follow the tasks → the client sees the progress →
 *   the owner closes the project.
 *
 * Every step goes through the real route handlers, the real services and the
 * real database; only the Supabase session resolution is mocked.
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

const { POST: createProject } = await import("../src/app/api/projects/route");
const { GET: getProject } = await import("../src/app/api/projects/[id]/route");
const { POST: savePlan } = await import("../src/app/api/projects/[id]/plan/route");
const { POST: submitPlan } = await import("../src/app/api/projects/[id]/plan/submit/route");
const { POST: approvePlan } = await import("../src/app/api/projects/[id]/plan/approve/route");
const { PATCH: updateTask } = await import("../src/app/api/projects/[id]/tasks/[taskId]/route");
const { POST: closeProject } = await import("../src/app/api/projects/[id]/close/route");
const { POST: monitor } = await import("../src/app/api/projects/monitor/route");

const { createCustomer } = await import("../src/lib/repositories/customers.repo");
const { createUser } = await import("../src/lib/repositories/identity.repo");
const { listProjectTasks } = await import("../src/lib/repositories/projects.repo");
const { listAlerts } = await import("../src/lib/repositories/governance.repo");
const { listActivities } = await import("../src/lib/repositories/governance.repo");

function call(userId: string | null, method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(userId ? { "x-test-user": userId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const taskCtx = (id: string, taskId: string) => ({ params: Promise.resolve({ id, taskId }) });

let ownerId = "";
let clientId = "";
let customerId = "";

beforeAll(async () => {
  const owner = await createUser({ email: "wf-owner@example.test", name: "Owner", role: "OWNER" });
  const client = await createUser({ email: "wf-client@example.test", name: "Client", role: "CLIENT" });
  ownerId = owner.id;
  clientId = client.id;
  const customer = await createCustomer({
    user_id: client.id, contact_name: "عميل الدورة", email: client.email,
    locale: "ar", currency: "USD", country: "IQ", status: "ACTIVE",
  });
  customerId = customer.id;
  profiles.byId.set(ownerId, { id: ownerId, role: "OWNER", status: "ACTIVE" });
  profiles.byId.set(clientId, { id: clientId, role: "CLIENT", status: "ACTIVE" });
});

describe("the Projects Agent cycle", () => {
  it("runs from the created project to the closed project", async () => {
    // ── 1) the owner creates the project ───────────────────────────────────
    const created = await createProject(
      call(ownerId, "POST", "/api/projects", { customerId, title: "دورة المشروع الكاملة", serviceSlug: "social-media-management" }),
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      data: { project: { id: string; code: string; status: string }; plan: { id: string; status: string; taskCount: number } };
    };
    const projectId = createdBody.data.project.id;
    expect(createdBody.data.project.status).toBe("DRAFT");
    // The agent only proposed the plan: nothing is committed yet.
    expect(createdBody.data.plan.status).toBe("DRAFT");
    expect(createdBody.data.plan.taskCount).toBeGreaterThan(0);

    // ── 2) the owner prepares the plan ────────────────────────────────────
    const plan = await savePlan(
      call(ownerId, "POST", `/api/projects/${projectId}/plan`, {
        phases: [
          {
            key: "PREPARATION",
            title: "التحضير",
            dueDate: "2026-12-01",
            owner: "content",
            tasks: [
              { title: "إعداد خطة النشر", dueDate: "2026-11-20", owner: "content" },
              { title: "تصميم القوالب", dueDate: "2026-11-25", owner: "content" },
            ],
          },
          {
            key: "DELIVERY",
            title: "التسليم",
            dueDate: "2026-12-20",
            owner: "project_manager",
            tasks: [{ title: "مراجعة وتسليم", dueDate: "2026-12-18", owner: "project_manager" }],
          },
        ],
      }),
      ctx(projectId),
    );
    expect(plan.status).toBe(200);

    const submitted = await submitPlan(call(ownerId, "POST", `/api/projects/${projectId}/plan/submit`), ctx(projectId));
    expect(submitted.status).toBe(200);

    // ── 3) the owner approves the plan ────────────────────────────────────
    const approved = await approvePlan(call(ownerId, "POST", `/api/projects/${projectId}/plan/approve`), ctx(projectId));
    expect(approved.status).toBe(200);

    // The project is now planned, and the client sees the approved plan.
    const clientView = await getProject(call(clientId, "GET", `/api/projects/${projectId}`), ctx(projectId));
    expect(clientView.status).toBe(200);
    const view = ((await clientView.json()) as { data: {
      project: { status: string };
      plan: { status: string; phases: { key: string; tasks: unknown[] }[] } | null;
    } }).data;
    expect(view.project.status).toBe("PLANNING");
    expect(view.plan?.status).toBe("APPROVED");
    expect(view.plan?.phases.map((phase) => phase.key)).toEqual(["PREPARATION", "DELIVERY"]);

    // ── 4) the team executes and follows the tasks ────────────────────────
    const tasks = await listProjectTasks(projectId, { includeInternal: true });
    const clientTasks = tasks.filter((task) => task.visibility === "CLIENT");
    expect(clientTasks).toHaveLength(3);

    const first = await updateTask(
      call(ownerId, "PATCH", `/api/projects/${projectId}/tasks/${clientTasks[0]!.id}`, { status: "DONE", note: "تم التسليم" }),
      taskCtx(projectId, clientTasks[0]!.id),
    );
    expect(first.status).toBe(200);

    const second = await updateTask(
      call(ownerId, "PATCH", `/api/projects/${projectId}/tasks/${clientTasks[1]!.id}`, { status: "IN_PROGRESS" }),
      taskCtx(projectId, clientTasks[1]!.id),
    );
    expect(second.status).toBe(200);

    // The client sees the progress that follows the real tasks: 1 of 3.
    const progressView = await getProject(call(clientId, "GET", `/api/projects/${projectId}`), ctx(projectId));
    const progress = ((await progressView.json()) as { data: { project: { progress: number } } }).data;
    expect(progress.project.progress).toBe(33);

    // ── 5) the delivery watch warns the owner about the open work ────────
    const monitorResponse = await monitor(call(ownerId, "POST", "/api/projects/monitor"));
    expect(monitorResponse.status).toBe(200);

    // ── 6) the owner closes the project, explicitly ───────────────────────
    // Open tasks still block the closing.
    const blockedClose = await closeProject(call(ownerId, "POST", `/api/projects/${projectId}/close`), ctx(projectId));
    expect(blockedClose.status).toBe(412);

    for (const task of clientTasks.slice(1)) {
      const response = await updateTask(
        call(ownerId, "PATCH", `/api/projects/${projectId}/tasks/${task.id}`, { status: "DONE" }),
        taskCtx(projectId, task.id),
      );
      expect(response.status).toBe(200);
    }

    const closed = await closeProject(
      call(ownerId, "POST", `/api/projects/${projectId}/close`, { note: "سُلّم المشروع" }),
      ctx(projectId),
    );
    expect(closed.status).toBe(200);
    const closedBody = (await closed.json()) as { data: { status: string; progress: number; completedAt: string } };
    expect(closedBody.data.status).toBe("COMPLETED");
    expect(closedBody.data.progress).toBe(100);
    expect(closedBody.data.completedAt).toBeTruthy();

    // The client sees the finished project.
    const finalView = await getProject(call(clientId, "GET", `/api/projects/${projectId}`), ctx(projectId));
    const final = ((await finalView.json()) as { data: { project: { status: string; progress: number } } }).data;
    expect(final.project.status).toBe("COMPLETED");
    expect(final.project.progress).toBe(100);

    // The whole cycle is in the activity log.
    const { rows } = await listActivities({ limit: 200 });
    const actions = rows.map((row) => row.action);
    expect(actions).toContain("project.created_by_owner");
    expect(actions).toContain("project.plan_saved");
    expect(actions).toContain("project.plan_submitted");
    expect(actions).toContain("project.plan_approved");
    expect(actions).toContain("project.closed_by_owner");
  });

  it("keeps the internal work out of the client portal", async () => {
    const created = await createProject(
      call(ownerId, "POST", "/api/projects", { customerId, title: "مشروع بملاحظات داخلية", serviceSlug: "consulting" }),
    );
    const body = (await created.json()) as { data: { project: { id: string } } };
    const projectId = body.data.project.id;

    await approvePlan(call(ownerId, "POST", `/api/projects/${projectId}/plan/approve`), ctx(projectId));

    const tasks = await listProjectTasks(projectId, { includeInternal: true });
    const internal = tasks.find((task) => task.visibility === "INTERNAL")!;
    await updateTask(
      call(ownerId, "PATCH", `/api/projects/${projectId}/tasks/${internal.id}`, { status: "DONE", note: "ملاحظة داخلية سرية" }),
      taskCtx(projectId, internal.id),
    );

    const clientView = await getProject(call(clientId, "GET", `/api/projects/${projectId}`), ctx(projectId));
    const text = JSON.stringify(await clientView.json());
    expect(text).not.toContain("ملاحظة داخلية سرية");
    expect(text).not.toContain("INTERNAL");

    // The staff view still has it.
    const staffView = await getProject(call(ownerId, "GET", `/api/projects/${projectId}`), ctx(projectId));
    expect(JSON.stringify(await staffView.json())).toContain("ملاحظة داخلية سرية");
  });
});
