export type PageId = 'dashboard' | 'documents' | 'analytics' | 'papers' | 'research' | 'mail' | 'automation' | 'connectors' | 'settings';

export type TaskKind =
  | 'document.outline' | 'document.draft' | 'document.polish' | 'document.continue' | 'document.summarize'
  | 'analytics.insights' | 'analytics.report' | 'paper.summary' | 'paper.review' | 'paper.synthesize'
  | 'research.design' | 'research.interpret' | 'research.plan' | 'mail.reply' | 'mail.summary' | 'mail.compose'
  | 'agent.chat';

export type AiMode = 'live' | 'offline';

export interface User { id: string; username: string }

export interface Activity {
  id: string; user_id: string; module: string; action: string; description: string; created_at: string;
}

export interface DashboardStats {
  documents: number; datasets: number; papers: number; projects: number;
  experiments: number; tasks: number; unreadMail: number; totalMail: number;
  recent: Activity[];
  ai: { mode: AiMode; model: string; baseUrl: string };
}

export interface DocumentDto {
  id: string; title: string; content: string; kind: string; template: string | null;
  tags: string[]; wordCount: number; status: string; createdAt: string; updatedAt: string; excerpt: string;
}

export interface DocumentTemplate {
  id: string; name: string; kind: string; description: string; sections: string[];
}

export interface ColumnInfo {
  name: string; type: 'numeric' | 'categorical'; missing: number; unique?: number;
  mean?: number; sum?: number; min?: number; max?: number; std?: number;
}

export interface DatasetStats {
  rowCount: number; columnCount: number; columns: ColumnInfo[];
  groups: Array<{ label: string; value: number; count: number }>;
  trend: Array<{ label: string; value: number }>;
  correlations: Array<{ pair: string; value: number }>;
}

export interface DatasetSummary {
  id: string; name: string; filename: string; rowCount: number; columnCount: number; createdAt: string;
}

export interface DatasetDto extends DatasetSummary {
  columns: ColumnInfo[];
  rows: Array<Record<string, string | number | null>>;
  stats: DatasetStats;
}

export interface PaperDto {
  id: string; title: string; authors: string; year: number | null; venue: string; doi: string;
  url: string; abstract: string; tags: string[]; status: string; rating: number;
  notes: string; createdAt: string; updatedAt: string;
}

export interface PaperStats {
  total: number; unread: number; reading: number; read: number; tags: string[]; years: number[];
}

export interface ProjectDto {
  id: string; name: string; description: string; objective: string; status: string;
  createdAt: string; updatedAt: string; experimentCount: number; taskCount: number;
}

export interface ExperimentDto {
  id: string; projectId: string | null; title: string; hypothesis: string; method: string;
  result: string; conclusion: string; status: string;
  metrics: Array<{ name: string; value: number }>; createdAt: string; updatedAt: string;
}

export interface TaskDto {
  id: string; projectId: string | null; title: string; status: string;
  priority: string; dueDate: string | null; createdAt: string;
}

export interface ResearchOverview {
  projects: ProjectDto[]; experiments: ExperimentDto[]; tasks: TaskDto[];
  stats: { projects: number; activeProjects: number; experiments: number; completed: number; openTasks: number };
}

export interface MessageDto {
  id: string; folder: string; subject: string; from: string; to: string; body: string;
  sentAt: string; isRead: boolean; aiSummary: string; excerpt: string; simulated?: boolean;
}

export interface MailAccountDto {
  id: string; email: string; username: string; imapHost: string; imapPort: number;
  imapSecure: boolean; smtpHost: string; smtpPort: number; smtpSecure: boolean; createdAt: string;
}

export interface MailStatus { configured: boolean; account: MailAccountDto | null; delivery: string }

export interface AiResult { text: string; mode: AiMode; action?: string }

export interface AutomationAction {
  value: string; label: string; module: string; description: string;
}

export interface AutomationTask {
  id: string; name: string; description: string;
  triggerType: 'manual' | 'interval'; intervalMinutes: number;
  module: string; action: string; enabled: boolean;
  lastRunAt: string | null; nextRunAt: string | null; runCount: number;
  lastStatus: string; lastResult: string; createdAt: string; updatedAt: string;
}

export interface ConnectorDto {
  id: string; name: string; kind: string; baseUrl: string; description: string;
  hasToken: boolean; status: string; enabled: boolean;
  lastCheckedAt: string | null; lastError: string;
  createdAt: string; updatedAt: string; builtin: boolean; detail?: string;
}
