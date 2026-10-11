export type AdminAlertStatus = "NEW" | "ACKNOWLEDGED" | "RESOLVED";
export type AdminAlertFilter = "OPEN" | "ALL" | AdminAlertStatus;

export interface AdminAlertListItem {
  id: string;
  severity: "URGENT" | "IMPORTANT" | "INFO" | string;
  category: string;
  titleAr: string;
  titleEn: string;
  bodyAr: string | null;
  bodyEn: string | null;
  status: AdminAlertStatus;
  createdAt: string;
  updatedAt: string;
  customerName: string | null;
  customerEmail: string | null;
  conversationId: string | null;
}

export interface AdminAlertListResponse {
  items: AdminAlertListItem[];
  total: number;
  filter: AdminAlertFilter;
  limit: number;
  offset: number;
}

export interface AdminAlertMessage {
  id: string;
  sender: "CLIENT" | "ASSISTANT" | "STAFF" | "AGENT" | "SYSTEM" | string;
  senderLabel: string | null;
  body: string;
  language: string | null;
  createdAt: string;
}

export interface AdminAlertActivity {
  id: string;
  action: string;
  actorType: string;
  actorLabel: string | null;
  summary: string | null;
  createdAt: string;
}

export interface AdminAlertDetail extends AdminAlertListItem {
  entityType: string | null;
  entityId: string | null;
  targetRole: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

export interface AdminAlertDetailsResponse {
  alert: AdminAlertDetail;
  client: {
    id: string | null;
    name: string | null;
    companyName: string | null;
    email: string | null;
    phone: string | null;
  } | null;
  conversation: {
    id: string;
    subject: string | null;
    status: string;
    lastMessageAt: string | null;
  } | null;
  messages: AdminAlertMessage[];
  activities: AdminAlertActivity[];
}
