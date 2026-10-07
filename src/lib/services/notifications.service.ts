import { logger } from "@/lib/core/logger";
import type { NotificationChannel, UserRow } from "@/lib/domain/types";
import {
  countUnreadNotifications,
  createNotification,
  listNotifications,
  markAllNotificationsRead,
} from "@/lib/repositories/messaging.repo";
import type { DbDriver } from "@/lib/db/types";

import { sendEmail } from "./email.service";

/**
 * Notification fan-out.
 *
 * Today: IN_APP rows in the unified inbox + EMAIL through the configured
 * transport. WHATSAPP is part of the same enum and the delivery function below
 * already routes to the WhatsApp adapter, which reports itself as not connected
 * until a business account is linked (see src/lib/integrations/whatsapp.ts).
 */
export interface NotifyInput {
  subject: string;
  body: string;
  html?: string;
  alertId?: string | null;
  email?: boolean;
  inApp?: boolean;
  whatsapp?: boolean;
  meta?: unknown;
  template?: string;
}

export interface NotifyResult {
  inAppCreated: number;
  emailsSent: number;
  emailFailures: number;
  whatsappQueued: number;
}

export async function notifyUsers(
  users: (Pick<UserRow, "id" | "email" | "name" | "locale"> & { phone?: string | null })[],
  input: NotifyInput,
  db?: DbDriver,
): Promise<NotifyResult> {
  const result: NotifyResult = { inAppCreated: 0, emailsSent: 0, emailFailures: 0, whatsappQueued: 0 };

  for (const user of users) {
    if (input.inApp !== false) {
      try {
        await createNotification(
          {
            user_id: user.id,
            alert_id: input.alertId ?? null,
            channel: "IN_APP",
            subject: input.subject,
            body: input.body,
            status: "QUEUED",
          },
          db,
        );
        result.inAppCreated += 1;
      } catch (error) {
        logger.warn("Failed to create in-app notification", { userId: user.id, error });
      }
    }

    if (input.email && user.email) {
      const delivery = await sendEmail({
        to: user.email,
        userId: user.id,
        subject: input.subject,
        text: input.body,
        html: input.html,
        template: input.template ?? "notification",
        meta: input.meta,
      });
      if (delivery.delivered) result.emailsSent += 1;
      else result.emailFailures += 1;
    }

    if (input.whatsapp && user.phone) {
      const queued = await queueWhatsApp(user.phone, input.body, db);
      if (queued) result.whatsappQueued += 1;
    }
  }

  return result;
}

/**
 * WhatsApp delivery is intentionally a no-op that records the intent.
 * It becomes active only when a WhatsApp Business account is linked; until then
 * the platform keeps every other channel working.
 */
async function queueWhatsApp(phone: string, body: string, db?: DbDriver): Promise<boolean> {
  try {
    const { whatsappAdapter } = await import("@/lib/integrations/whatsapp");
    const status = await whatsappAdapter.status();
    if (!status.connected) {
      logger.info("WhatsApp message skipped (integration not connected)", { to: maskPhone(phone) });
      return false;
    }
    await createNotification(
      {
        user_id: "integration-queue",
        channel: "WHATSAPP" as NotificationChannel,
        subject: "WhatsApp",
        body,
        status: "QUEUED",
      },
      db,
    );
    return true;
  } catch (error) {
    logger.warn("WhatsApp queue failed", { error });
    return false;
  }
}

export async function inbox(userId: string, limit = 30) {
  return listNotifications(userId, { limit });
}

export async function unreadCount(userId: string): Promise<number> {
  return countUnreadNotifications(userId);
}

export async function markInboxRead(userId: string): Promise<void> {
  await markAllNotificationsRead(userId);
}

function maskPhone(phone: string): string {
  return phone.length <= 4 ? "***" : `${"*".repeat(phone.length - 4)}${phone.slice(-4)}`;
}
