"use client";

import { useCallback, useEffect, useState } from "react";

import type { Locale } from "@/lib/domain/types";

/**
 * The Projects panel of the admin dashboard (وكيل إدارة المشاريع).
 *
 * Everything here goes through the real Projects API:
 *   GET  /api/projects                     — the staff project list
 *   POST /api/projects                     — create a project for a customer
 *   GET  /api/projects/[id]                — the project with its tasks
 *   POST /api/projects/[id]/plan/approve   — the owner's approval of the plan
 *   PATCH /api/projects/[id]/tasks/[taskId] — task status + internal note
 *   POST /api/projects/[id]/close          — the owner's explicit closing
 *   POST /api/projects/monitor             — the delivery watch (alerts)
 *
 * The UI never decides an authorisation: the API re-checks the role and the
 * customer ownership on every call.
 */

interface ProjectPlanSummary {
  id: string;
  version: number;
  status: string;
  approvedAt: string | null;
  phases: number;
  tasks: number;
}

interface ProjectRow {
  id: string;
  code: string;
  title: string;
  titleEn: string | null;
  status: string;
  progress: number;
  customerId: string;
  customerName: string | null;
  startDate: string | null;
  dueDate: string | null;
  riskLevel: string | null;
  plan: ProjectPlanSummary | null;
  tasks: { total: number; done: number; open: number; overdue: number };
  daysRemaining: number | null;
}

interface PlanTaskDraft {
  title: string;
  dueDate: string;
  visibility: "CLIENT" | "INTERNAL";
  owner: string;
}

interface PlanPhaseDraft {
  key: string;
  title: string;
  dueDate: string;
  tasks: PlanTaskDraft[];
}

interface ProjectTask {
  id: string;
  title: string;
  status: string;
  visibility: string;
  due_date: string | null;
  internal_note: string | null;
  phase_key: string | null;
}

interface ClientOption { id: string; name: string; companyName: string | null; }
interface OfferOption { id: string; code: string; customerName: string; status: string; }

/** The catalogue the owner can start a project from. */
const SERVICE_OPTIONS: { slug: string; ar: string; en: string }[] = [
  { slug: "social-media-management", ar: "إدارة حسابات التواصل", en: "Social media management" },
  { slug: "content-design", ar: "كتابة وتصميم المنشورات", en: "Post writing and design" },
  { slug: "content-strategy", ar: "خطة المحتوى والنشر", en: "Content strategy and calendar" },
  { slug: "paid-ads", ar: "إدارة الإعلانات المدفوعة", en: "Paid ads management" },
  { slug: "branding", ar: "الهوية والمواد التسويقية", en: "Branding and marketing materials" },
  { slug: "web-development", ar: "إنشاء وتطوير المواقع", en: "Website development" },
  { slug: "seo", ar: "تحسين محركات البحث", en: "SEO" },
  { slug: "analytics-reports", ar: "تحليل الأداء والتقارير", en: "Analytics and reporting" },
  { slug: "consulting", ar: "استشارات وخطط تسويقية", en: "Consulting and marketing plans" },
];

const TASK_STATUSES = ["TODO", "IN_PROGRESS", "BLOCKED", "REVIEW", "DONE"];

export function AdminProjects({
  locale,
  clients,
  offers,
}: {
  locale: Locale;
  clients: ClientOption[];
  offers: OfferOption[];
}) {
  const ar = locale === "ar";
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [openTasks, setOpenTasks] = useState<Record<string, ProjectTask[]>>({});
  const [planDrafts, setPlanDrafts] = useState<Record<string, PlanPhaseDraft[]>>({});
  const [editingPlan, setEditingPlan] = useState<string | null>(null);
  const [taskNotes, setTaskNotes] = useState<Record<string, string>>({});
  const [taskStatus, setTaskStatus] = useState<Record<string, string>>({});

  const [customerId, setCustomerId] = useState("");
  const [title, setTitle] = useState("");
  const [source, setSource] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/projects", { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Unable to load the projects.");
      const rows = (payload.data?.rows ?? []) as ProjectRow[];
      setProjects(rows);
      setError("");
      if (!customerId && rows.length > 0) setCustomerId(rows[0]!.customerId);
    } catch (reason) {
      setProjects([]);
      setError(reason instanceof Error ? reason.message : "Unable to load the projects.");
    }
  }, [customerId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function callApi(path: string, options: RequestInit, key: string) {
    setBusy(key);
    setNotice("");
    try {
      const response = await fetch(path, {
        ...options,
        headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "The request failed.");
      setNotice(ar ? "تم تنفيذ الإجراء بنجاح." : "The action was applied.");
      await load();
      return payload;
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function createProject() {
    if (!customerId || !title.trim()) {
      setNotice(ar ? "اختر العميل واكتب عنوان المشروع." : "Pick a customer and write a project title.");
      return;
    }
    setCreating(true);
    const body: Record<string, string> = { customerId, title: title.trim() };
    if (source.startsWith("offer:")) body.offerId = source.slice("offer:".length);
    else body.serviceSlug = source;
    const result = await callApi("/api/projects", { method: "POST", body: JSON.stringify(body) }, "create");
    if (result) {
      setTitle("");
      setNotice(
        ar
          ? "أُنشئ المشروع واقترح وكيل إدارة المشاريع خطة. الخطة بانتظار مراجعة المالك واعتمادها."
          : "The project was created and the Projects Agent proposed a plan. The plan waits for the owner's review and approval.",
      );
    }
    setCreating(false);
  }

  async function approvePlan(project: ProjectRow) {
    await callApi(
      `/api/projects/${encodeURIComponent(project.id)}/plan/approve`,
      { method: "POST", body: JSON.stringify({}) },
      `approve-${project.id}`,
    );
  }

  async function closeProject(project: ProjectRow) {
    await callApi(
      `/api/projects/${encodeURIComponent(project.id)}/close`,
      { method: "POST", body: JSON.stringify({}) },
      `close-${project.id}`,
    );
  }

  async function runMonitor() {
    const result = await callApi("/api/projects/monitor", { method: "POST" }, "monitor");
    if (result) {
      const data = result.data as { overdueTasks: number; dueSoonProjects: number; lateProjects: number };
      setNotice(
        ar
          ? `الفحص اكتمل: ${data.overdueTasks} مهمة متأخرة، ${data.dueSoonProjects} مشروع يقترب موعده، ${data.lateProjects} مشروع متأخر. التنبيهات داخل التطبيق فقط.`
          : `The check is done: ${data.overdueTasks} overdue task(s), ${data.dueSoonProjects} project(s) due soon, ${data.lateProjects} late project(s). The alerts stay in the app.`,
      );
    }
  }

  async function openPlanEditor(project: ProjectRow) {
    if (editingPlan === project.id) {
      setEditingPlan(null);
      return;
    }
    setBusy(`plan-${project.id}`);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/plan`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Unable to load the plan.");
      const phases = ((payload.data?.phases ?? []) as PlanPhaseDraft[]).map((phase) => ({
        key: phase.key,
        title: phase.title ?? "",
        dueDate: phase.dueDate ?? "",
        tasks: (phase.tasks ?? []).map((task) => ({
          title: task.title ?? "",
          dueDate: task.dueDate ?? "",
          visibility: (task.visibility ?? "CLIENT") as "CLIENT" | "INTERNAL",
          owner: task.owner ?? "",
        })),
      }));
      setPlanDrafts((current) => ({ ...current, [project.id]: phases }));
      setEditingPlan(project.id);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }

  function updatePhase(projectId: string, index: number, patch: Partial<PlanPhaseDraft>) {
    setPlanDrafts((current) => {
      const phases = [...(current[projectId] ?? [])];
      phases[index] = { ...phases[index]!, ...patch };
      return { ...current, [projectId]: phases };
    });
  }

  function updatePhaseTask(projectId: string, phaseIndex: number, taskIndex: number, patch: Partial<PlanTaskDraft>) {
    setPlanDrafts((current) => {
      const phases = [...(current[projectId] ?? [])];
      const phase = { ...phases[phaseIndex]! };
      const tasks = [...(phase.tasks ?? [])];
      tasks[taskIndex] = { ...tasks[taskIndex]!, ...patch };
      phase.tasks = tasks;
      phases[phaseIndex] = phase;
      return { ...current, [projectId]: phases };
    });
  }

  async function savePlan(project: ProjectRow) {
    const phases = planDrafts[project.id] ?? [];
    if (phases.length === 0) {
      setNotice(ar ? "الخطة فارغة." : "The plan is empty.");
      return;
    }
    const result = await callApi(
      `/api/projects/${encodeURIComponent(project.id)}/plan`,
      {
        method: "POST",
        body: JSON.stringify({
          phases: phases.map((phase) => ({
            key: phase.key,
            title: phase.title.trim(),
            dueDate: phase.dueDate.trim() || null,
            tasks: phase.tasks
              .filter((task) => task.title.trim())
              .map((task) => ({
                title: task.title.trim(),
                dueDate: task.dueDate.trim() || null,
                visibility: task.visibility,
                owner: task.owner.trim() || null,
              })),
          })),
        }),
      },
      `plan-${project.id}`,
    );
    if (result) {
      setNotice(
        ar
          ? "حُفظت الخطة كمسودة. يلزم اعتماد المالك قبل أن تكون التزامًا."
          : "The plan was saved as a draft. The owner's approval is required before it becomes a commitment.",
      );
    }
  }

  async function submitPlan(project: ProjectRow) {
    await callApi(
      `/api/projects/${encodeURIComponent(project.id)}/plan/submit`,
      { method: "POST", body: JSON.stringify({}) },
      `submit-${project.id}`,
    );
  }

  async function toggleTasks(project: ProjectRow) {
    if (openTasks[project.id]) {
      setOpenTasks((current) => {
        const next = { ...current };
        delete next[project.id];
        return next;
      });
      return;
    }
    setBusy(`tasks-${project.id}`);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Unable to load the tasks.");
      const tasks = (payload.data?.tasks ?? []) as ProjectTask[];
      setOpenTasks((current) => ({ ...current, [project.id]: tasks }));
      setTaskStatus((current) => {
        const next = { ...current };
        for (const task of tasks) if (!next[task.id]) next[task.id] = task.status;
        return next;
      });
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }

  async function saveTask(project: ProjectRow, task: ProjectTask) {
    const body: Record<string, string> = {};
    const status = taskStatus[task.id] ?? task.status;
    if (status !== task.status) body.status = status;
    const note = (taskNotes[task.id] ?? "").trim();
    if (note) body.note = note;
    if (Object.keys(body).length === 0) {
      setNotice(ar ? "لا يوجد تغيير لحفظه." : "There is nothing to save.");
      return;
    }
    const result = await callApi(
      `/api/projects/${encodeURIComponent(project.id)}/tasks/${encodeURIComponent(task.id)}`,
      { method: "PATCH", body: JSON.stringify(body) },
      `task-${task.id}`,
    );
    if (result) {
      setTaskNotes((current) => ({ ...current, [task.id]: "" }));
      const refreshed = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, { cache: "no-store" });
      const payload = await refreshed.json().catch(() => ({}));
      const tasks = (payload.data?.tasks ?? []) as ProjectTask[];
      setOpenTasks((current) => ({ ...current, [project.id]: tasks }));
    }
  }

  const approvedOffers = offers.filter((offer) => offer.status === "APPROVED");

  return (
    <div className="admin-projects-panel">
      <form
        className="offer-request-form"
        onSubmit={(event) => {
          event.preventDefault();
          void createProject();
        }}
      >
        <label>
          <span>{ar ? "العميل" : "Customer"}</span>
          <select value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
            <option value="">{ar ? "اختر عميلاً" : "Pick a customer"}</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.companyName ? `${client.companyName} — ${client.name}` : client.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{ar ? "عنوان المشروع" : "Project title"}</span>
          <input
            type="text"
            value={title}
            maxLength={200}
            placeholder={ar ? "مثال: إدارة حسابات التواصل" : "e.g. Social media management"}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          <span>{ar ? "المصدر" : "Source"}</span>
          <select value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="">{ar ? "اختر خدمة أو عرضًا مقبولًا" : "Pick a service or an accepted offer"}</option>
            <optgroup label={ar ? "خدمات الكتالوج" : "Catalogue services"}>
              {SERVICE_OPTIONS.map((service) => (
                <option key={service.slug} value={service.slug}>
                  {ar ? service.ar : service.en}
                </option>
              ))}
            </optgroup>
            {approvedOffers.length > 0 && (
              <optgroup label={ar ? "عروض مقبولة" : "Accepted offers"}>
                {approvedOffers.map((offer) => (
                  <option key={offer.id} value={`offer:${offer.id}`}>
                    {offer.code} — {offer.customerName}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <button className="button button-gold" type="submit" disabled={creating}>
          {ar ? "إنشاء مشروع" : "Create project"}
        </button>
      </form>

      <div className="card-heading-row">
        <p className="card-subtitle">
          {ar
            ? "إنشاء المشروع يقترح خطة فقط؛ الاعتماد وإغلاق المشروع قراران صريحان من المالك."
            : "Creating a project only proposes a plan; approving it and closing the project are explicit owner decisions."}
        </p>
        <div className="card-heading-actions">
          <button type="button" disabled={busy === "monitor"} onClick={() => void runMonitor()}>
            {ar ? "فحص التأخير والمواعيد" : "Check delays and deadlines"}
          </button>
        </div>
      </div>

      {notice && <p className="row-meta" role="status">{notice}</p>}
      {error && <p className="row-meta form-notice-error" role="alert">{error}</p>}

      {projects === null ? (
        <div className="empty-state"><span className="empty-state-mark">◇</span><p>{ar ? "جارٍ التحميل…" : "Loading…"}</p></div>
      ) : projects.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state-mark">◇</span>
          <p>{ar ? "لا توجد مشاريع بعد. أنشئ مشروعًا من النموذج أعلاه." : "No projects yet. Create one with the form above."}</p>
        </div>
      ) : (
        <div className="compact-list">
          {projects.map((project) => (
            <article className="compact-row" key={project.id}>
              <div className="compact-row-copy">
                <strong>{project.code} · {project.title}</strong>
                <span>
                  {project.customerName}
                  {project.dueDate ? ` · ${ar ? "الاستحقاق" : "Due"} ${formatDate(project.dueDate, locale)}` : ""}
                  {project.daysRemaining !== null && project.daysRemaining < 0
                    ? ` · ${ar ? "متأخر" : "late"} ${Math.abs(project.daysRemaining)}${ar ? " يوم" : "d"}`
                    : ""}
                </span>
                <div className="progress-track" aria-hidden="true">
                  <span style={{ width: `${clampPercent(project.progress)}%` }} />
                </div>
                <span>
                  {ar ? "المهام" : "Tasks"}: {project.tasks.done}/{project.tasks.total}
                  {project.tasks.overdue > 0 ? ` · ${project.tasks.overdue} ${ar ? "متأخرة" : "overdue"}` : ""}
                </span>
                {project.plan ? (
                  <span>
                    {ar ? "الخطة" : "Plan"}: v{project.plan.version} ·{" "}
                    {ar ? planStatusLabel(project.plan.status, ar) : planStatusLabel(project.plan.status, ar)}
                    {project.plan.approvedAt ? ` · ${ar ? "معتمدة" : "approved"} ${formatDate(project.plan.approvedAt, locale)}` : ""}
                    {` · ${project.plan.phases} ${ar ? "مرحلة" : "phases"} / ${project.plan.tasks} ${ar ? "مهمة" : "tasks"}`}
                  </span>
                ) : (
                  <span>{ar ? "لا توجد خطة بعد" : "No plan yet"}</span>
                )}
                <span className="offer-admin-actions">
                  <button type="button" disabled={busy === `plan-${project.id}`} onClick={() => void openPlanEditor(project)}>
                    {editingPlan === project.id
                      ? ar ? "إغلاق محرر الخطة" : "Close the plan editor"
                      : ar ? "مراجعة وتعديل الخطة" : "Review and edit the plan"}
                  </button>
                  {project.plan && project.plan.status !== "APPROVED" && (
                    <button type="button" disabled={busy === `approve-${project.id}`} onClick={() => void approvePlan(project)}>
                      {ar ? "اعتماد الخطة (المالك)" : "Approve the plan (owner)"}
                    </button>
                  )}
                  {project.plan && project.plan.status === "DRAFT" && (
                    <button type="button" disabled={busy === `submit-${project.id}`} onClick={() => void submitPlan(project)}>
                      {ar ? "إرسال للمراجعة" : "Send for review"}
                    </button>
                  )}
                  <button type="button" disabled={busy === `tasks-${project.id}`} onClick={() => void toggleTasks(project)}>
                    {openTasks[project.id] ? (ar ? "إخفاء المهام" : "Hide tasks") : ar ? "عرض المهام" : "Show tasks"}
                  </button>
                  {project.status !== "COMPLETED" && project.status !== "CANCELLED" && (
                    <button type="button" disabled={busy === `close-${project.id}`} onClick={() => void closeProject(project)}>
                      {ar ? "إغلاق المشروع (قرار صريح)" : "Close the project (explicit)"}
                    </button>
                  )}
                </span>
                {editingPlan === project.id && (
                  <span className="admin-plan-editor">
                    {(planDrafts[project.id] ?? []).map((phase, phaseIndex) => (
                      <span className="admin-plan-phase" key={phase.key}>
                        <span className="admin-plan-phase-head">
                          <input
                            type="text"
                            value={phase.title}
                            placeholder={ar ? "عنوان المرحلة" : "Phase title"}
                            onChange={(event) => updatePhase(project.id, phaseIndex, { title: event.target.value })}
                          />
                          <input
                            type="date"
                            value={phase.dueDate}
                            onChange={(event) => updatePhase(project.id, phaseIndex, { dueDate: event.target.value })}
                          />
                          <button
                            type="button"
                            onClick={() =>
                              setPlanDrafts((current) => ({
                                ...current,
                                [project.id]: (current[project.id] ?? []).filter((_, index) => index !== phaseIndex),
                              }))
                            }
                          >
                            {ar ? "حذف المرحلة" : "Remove phase"}
                          </button>
                        </span>
                        {phase.tasks.map((task, taskIndex) => (
                          <span className="admin-plan-task" key={`${phase.key}-${taskIndex}`}>
                            <input
                              type="text"
                              value={task.title}
                              placeholder={ar ? "عنوان المهمة" : "Task title"}
                              onChange={(event) =>
                                updatePhaseTask(project.id, phaseIndex, taskIndex, { title: event.target.value })
                              }
                            />
                            <input
                              type="date"
                              value={task.dueDate}
                              onChange={(event) =>
                                updatePhaseTask(project.id, phaseIndex, taskIndex, { dueDate: event.target.value })
                              }
                            />
                            <select
                              value={task.visibility}
                              onChange={(event) =>
                                updatePhaseTask(project.id, phaseIndex, taskIndex, {
                                  visibility: event.target.value as "CLIENT" | "INTERNAL",
                                })
                              }
                            >
                              <option value="CLIENT">{ar ? "ظاهرة للعميل" : "Client visible"}</option>
                              <option value="INTERNAL">{ar ? "داخلية" : "Internal"}</option>
                            </select>
                            <button
                              type="button"
                              onClick={() =>
                                updatePhase(project.id, phaseIndex, {
                                  tasks: phase.tasks.filter((_, index) => index !== taskIndex),
                                })
                              }
                            >
                              {ar ? "حذف" : "Remove"}
                            </button>
                          </span>
                        ))}
                        <button
                          type="button"
                          onClick={() =>
                            updatePhase(project.id, phaseIndex, {
                              tasks: [
                                ...phase.tasks,
                                { title: "", dueDate: "", visibility: "CLIENT", owner: "" },
                              ],
                            })
                          }
                        >
                          {ar ? "إضافة مهمة" : "Add a task"}
                        </button>
                      </span>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        const phases = planDrafts[project.id] ?? [];
                        const key = `PHASE_${phases.length + 1}`;
                        setPlanDrafts((current) => ({
                          ...current,
                          [project.id]: [
                            ...phases,
                            { key, title: ar ? "مرحلة جديدة" : "New phase", dueDate: "", tasks: [] },
                          ],
                        }));
                      }}
                    >
                      {ar ? "إضافة مرحلة" : "Add a phase"}
                    </button>
                    <button type="button" disabled={busy === `plan-${project.id}`} onClick={() => void savePlan(project)}>
                      {ar ? "حفظ الخطة" : "Save the plan"}
                    </button>
                  </span>
                )}
                {openTasks[project.id] && (
                  <span className="admin-task-list">
                    {openTasks[project.id]!.map((task) => (
                      <span className="admin-task-row" key={task.id}>
                        <span>
                          {task.title}
                          {task.visibility === "INTERNAL" ? ` · ${ar ? "داخلية" : "internal"}` : ""}
                          {task.phase_key ? ` · ${task.phase_key}` : ""}
                        </span>
                        <select
                          value={taskStatus[task.id] ?? task.status}
                          onChange={(event) => setTaskStatus((current) => ({ ...current, [task.id]: event.target.value }))}
                        >
                          {TASK_STATUSES.map((status) => (
                            <option key={status} value={status}>{status.replaceAll("_", " ")}</option>
                          ))}
                        </select>
                        <input
                          type="text"
                          placeholder={ar ? "ملاحظة داخلية" : "Internal note"}
                          value={taskNotes[task.id] ?? ""}
                          onChange={(event) => setTaskNotes((current) => ({ ...current, [task.id]: event.target.value }))}
                        />
                        <button type="button" disabled={busy === `task-${task.id}`} onClick={() => void saveTask(project, task)}>
                          {ar ? "حفظ" : "Save"}
                        </button>
                      </span>
                    ))}
                  </span>
                )}
              </div>
              <div className="compact-row-side">
                <strong>{clampPercent(project.progress)}%</strong>
                <span className={`status-pill status-${project.status.toLowerCase()}`}>
                  {project.status.replaceAll("_", " ")}
                </span>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function planStatusLabel(status: string, ar: boolean): string {
  const labels: Record<string, [string, string]> = {
    DRAFT: ["مسودة", "Draft"],
    AWAITING_APPROVAL: ["بانتظار موافقة المالك", "Awaiting owner approval"],
    APPROVED: ["معتمدة", "Approved"],
    SUPERSEDED: ["مستبدلة", "Superseded"],
  };
  const pair = labels[status];
  if (!pair) return status;
  return ar ? pair[0] : pair[1];
}

function clampPercent(value: number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0;
}

function formatDate(value: string, locale: Locale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-IQ-u-nu-latn" : "en-GB", { dateStyle: "medium" }).format(date);
}
