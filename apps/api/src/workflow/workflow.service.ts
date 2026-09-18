import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { WhatsappService } from '../whatsapp/whatsapp.service';

// Per-day business-hours schedule. Keyed by JS Date "day" (0=Sun..6=Sat); a day
// with no entry is fully closed. Matches the default schedule the sales team
// actually works: Mon-Fri 10:00-19:00, Sat 11:00-16:00, Sunday off.
const DEFAULT_BUSINESS_HOURS = {
  '1': { start: '10:00', end: '19:00' },
  '2': { start: '10:00', end: '19:00' },
  '3': { start: '10:00', end: '19:00' },
  '4': { start: '10:00', end: '19:00' },
  '5': { start: '10:00', end: '19:00' },
  '6': { start: '11:00', end: '16:00' },
};

const SETTING_DEFAULTS: Record<string, string> = {
  BUSINESS_HOURS: JSON.stringify(DEFAULT_BUSINESS_HOURS), // per-day-of-week {start,end}; a missing day is closed
  WHATSAPP_ENABLED: 'false',
  SLA_MINUTES: '2',                   // TEMP: set low for testing — how long an agent has, in business minutes, before the lead rotates to the next agent. Change back (or edit in Settings) once testing is done.
  MAX_ROTATION_LAPS: '2',             // how many full laps through the active roster before escalating
  NEW_LEAD_STATUS_ID: 'NEW',          // Bitrix STATUS_ID that counts as "not yet worked" — any other value closes the SLA clock
  ASSIGNMENT_HISTORY_FIELD: 'UF_CRM_1787754199499', // Bitrix Lead custom field (JSON array) that logs every handoff — who held it, when, and why they stopped
  // Stale-lead recycling — leads sitting untouched in these stages for the
  // given number of days get moved back to NEW_LEAD_STATUS_ID and re-enter
  // the normal round-robin pipeline, same as a brand-new lead.
  RECYCLE_ENABLED: 'true',            // dedicated on/off switch for this feature — independent of the master WORKFLOW_ENABLED pause
  RECYCLE_FREQUENCY_HOURS: '24',      // how often the recycle sweep actually runs (the cron ticks hourly to check, but only acts once this many hours have passed since the last run) — 24 = once daily
  DEAD_LEAD_STATUS_ID: 'UC_2H1LKX',   // "Dead Lead"
  DEAD_LEAD_RECYCLE_DAYS: '90',       // ~3 months
  DEAD_LEAD_RECYCLE_LIMIT: '75',      // max Dead leads recycled per run — caps how many get redistributed to agents at once on a large backlog; leftovers just get picked up next run
  JUNK_LEAD_STATUS_ID: 'UC_POEFNU',   // "Junk Lead" — distinct from STATUS_ID=JUNK ("Duplicate"), which the auto-merge feature sets and this must never touch
  JUNK_LEAD_RECYCLE_DAYS: '7',
  JUNK_LEAD_RECYCLE_LIMIT: '75',      // same idea, for Junk leads — combined cap across both is 150/run by default
  SELF_CREATED_SOURCE_IDS: '[]',      // JSON array of Bitrix SOURCE_ID values that mean "agent made this lead themselves" — excluded from the workflow entirely
  ALLOWED_SOURCES: '[]',              // JSON array of source IDs eligible for assignment; empty = all sources allowed
  WORKFLOW_MANAGER_ID: '1',
  WORKFLOW_ENABLED: 'true',            // master on/off switch — set to 'false' to pause all lead assignment
  // Assignment scope
  LEAD_ASSIGNMENT_TEAM: 'B2C',        // default rotation team — used when a lead's source isn't in SOURCE_TEAM_MAP
  ELIGIBLE_DEPT_IDS: '[]',            // JSON array of Bitrix24 dept IDs eligible for assignment; empty = no restriction
  SOURCE_TEAM_MAP: '{}',              // JSON object mapping Bitrix source ID -> team name, e.g. {"FACEBOOK":"B2C"}
};

interface LeadDetails {
  name: string;
  source: string;
  sourceId: string;
  title: string;
  phone?: string;
  email?: string;
  isReturnCustomer?: boolean;
  assignedById?: string;
  modifyById?: string;
  statusId?: string;
  createdById?: string;
}

// Credentials can be OAuth-based or webhook-based
interface BitrixCreds {
  accessToken?: string;
  domain?: string;
  webhookBase?: string; // full webhook URL like https://pcicrm.bitrix24.com/rest/11/token
}

// One holding period in the Bitrix-visible assignment history (ASSIGNMENT_HISTORY_FIELD).
// Keys kept short on purpose to save space in the field: uid = bitrix_user_id
// (the agent's name/our internal id are both dropped — uid alone identifies
// them in Bitrix), lap = rotation lap (0 for the Escalation Manager), asg =
// when they got it, end/res = when + why they stopped holding it (null while
// they're still the current holder).
interface AssignmentHistoryEntry {
  uid: string;
  lap: number;
  asg: string; // Asia/Karachi, ISO 8601, no timezone marker
  end: string | null;
  res: 'worked' | 'missed' | 'manual_reassigned' | null;
}

@Injectable()
export class WorkflowService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkflowService.name);
  private readonly activeAssignments = new Set<string>();
  private readonly teamLocks = new Map<string, Promise<unknown>>();

  // Serialize "pick next agent → assign" per team so two leads arriving close
  // together for the same team can never both read the same last-assigned
  // agent and land on the same "next" pick.
  private async withTeamLock<T>(team: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.teamLocks.get(team) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    this.teamLocks.set(team, result.catch(() => undefined));
    return result;
  }

  constructor(private readonly whatsapp: WhatsappService) {
    super();
  }

  getPKTime(): { day: number; hour: number; minute: number } {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Karachi',
      hourCycle: 'h23',
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
    });
    const parts = formatter.formatToParts(now);
    const partMap = Object.fromEntries(parts.map(p => [p.type, p.value]));

    const weekdayMap: Record<string, number> = {
      'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6
    };

    const day = weekdayMap[partMap.weekday] ?? 0;
    const hour = parseInt(partMap.hour, 10);
    const minute = parseInt(partMap.minute, 10);

    return { day, hour, minute };
  }

  getPKTMidnight(): Date {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Karachi',
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    });
    const parts = formatter.formatToParts(now);
    const partMap = Object.fromEntries(parts.map(p => [p.type, p.value]));

    const isoString = `${partMap.year}-${partMap.month.padStart(2, '0')}-${partMap.day.padStart(2, '0')}T00:00:00+05:00`;
    return new Date(isoString);
  }

  async onModuleInit() {
    await this.$connect();
    for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
      const exists = await this.workflowSetting.findUnique({ where: { key } });
      if (!exists) await this.workflowSetting.create({ data: { key, value } });
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  // ─── Bitrix24 REST helper ──────────────────────────────────────────────────
  // Works with both OAuth tokens and webhook URLs transparently

  private bitrixUrl(method: string, creds: BitrixCreds): string {
    if (creds.webhookBase) {
      return `${creds.webhookBase.replace(/\/$/, '')}/${method}.json`;
    }
    return `https://${creds.domain}/rest/${method}.json?auth=${creds.accessToken}`;
  }

  private getWebhookCreds(): BitrixCreds {
    const token = process.env.BITRIX_WEBHOOK_TOKEN || '';
    const portal = process.env.BITRIX_PORTAL_URL || 'https://pcicrm.bitrix24.com';
    const base = token.startsWith('http') ? token.replace(/\/$/, '') : `${portal}/rest/${token}`.replace(/\/$/, '');
    return { webhookBase: base };
  }

  // im.notify.personal.add rejects the main webhook token with "requires
  // higher privileges" — that webhook's owning user isn't a full
  // Administrator. This is a separate, Administrator-owned webhook used only
  // for that one call. Falls back to the main webhook if unset, so nothing
  // breaks (beyond the notification still failing exactly as it does today)
  // until BITRIX_NOTIFICATION_WEBHOOK_TOKEN is actually configured.
  private getNotificationWebhookCreds(): BitrixCreds {
    const token = process.env.BITRIX_NOTIFICATION_WEBHOOK_TOKEN || '';
    if (!token) return this.getWebhookCreds();
    const portal = process.env.BITRIX_PORTAL_URL || 'https://pcicrm.bitrix24.com';
    const base = token.startsWith('http') ? token.replace(/\/$/, '') : `${portal}/rest/${token}`.replace(/\/$/, '');
    return { webhookBase: base };
  }

  // ─── Agents ────────────────────────────────────────────────────────────────

  async getAgents() {
    return this.agent.findMany({ orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }] });
  }

  async reorderAgents(orderedIds: string[]) {
    await Promise.all(
      orderedIds.map((id, index) => this.agent.update({ where: { id }, data: { sort_order: index } }))
    );
    return this.getAgents();
  }

  async addAgent(data: { bitrix_user_id: string; name: string; team: string; whatsapp_phone?: string; department_id?: string; department_name?: string }) {
    return this.agent.create({
      data: {
        ...data,
        whatsapp_phone: data.whatsapp_phone ?? null,
        department_id: data.department_id ?? null,
        department_name: data.department_name ?? null,
        is_active: true,
      },
    });
  }

  async updateAgent(id: string, data: { name?: string; team?: string; whatsapp_phone?: string; department_id?: string; department_name?: string }) {
    return this.agent.update({ where: { id }, data });
  }

  async toggleAgentActive(id: string, is_active: boolean) {
    return this.agent.update({ where: { id }, data: { is_active } });
  }

  async deleteAgent(id: string) {
    return this.agent.delete({ where: { id } });
  }

  // ─── Settings ──────────────────────────────────────────────────────────────

  async getSettings(): Promise<Record<string, string>> {
    const rows = await this.workflowSetting.findMany();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async updateSetting(key: string, value: string) {
    return this.workflowSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
  }

  // ─── Late Leads ────────────────────────────────────────────────────────────

  async getLateLeads() {
    return this.lateLead.findMany({ where: { processed: false }, orderBy: { created_at: 'asc' } });
  }

  async storeLateLeadIfAbsent(leadId: string) {
    await this.lateLead.upsert({
      where: { lead_id: leadId },
      update: {},
      create: { lead_id: leadId },
    });
  }

  // ─── Assignment Log ────────────────────────────────────────────────────────

  async getAssignmentLog(limit = 50) {
    return this.assignmentLog.findMany({ orderBy: { assigned_at: 'desc' }, take: limit });
  }

  async getAssignedTodayCount() {
    const midnight = this.getPKTMidnight();
    return this.assignmentLog.count({ where: { assigned_at: { gte: midnight } } });
  }

  // ─── Lead owner tracking (cascading-reassignment guard) ───────────────────
  // Tracks the last Bitrix ASSIGNED_BY_ID we actually observed for each lead,
  // updated whenever we assign it ourselves or process a genuine external
  // owner change. handleLeadChangeWebhook uses this to tell "the owner
  // genuinely just changed" apart from "the manager's account merely touched
  // an already-correctly-assigned lead" (a comment, an unrelated field edit,
  // another automation running under their identity) — the latter used to be
  // misread as a fresh reassignment and re-notify the current owner, which is
  // how one lead could end up cycling through several agents with no real
  // handoff happening.

  private async getKnownOwner(leadId: string): Promise<string | null> {
    const row = await this.leadOwner.findUnique({ where: { lead_id: leadId } });
    return row?.assigned_by_id ?? null;
  }

  private async setKnownOwner(leadId: string, assignedById: string): Promise<void> {
    if (!assignedById) return;
    await this.leadOwner.upsert({
      where: { lead_id: leadId },
      update: { assigned_by_id: assignedById },
      create: { lead_id: leadId, assigned_by_id: assignedById },
    });
  }

  // ─── Time / Day Helpers ────────────────────────────────────────────────────
  // Business hours are per-day-of-week (0=Sun..6=Sat); a day with no entry in
  // the schedule is fully closed. Replaces the old single start/end + off-days
  // pair so Saturday can run a shorter window than weekdays.

  getBusinessHoursSchedule(settings: Record<string, string>): Record<string, { start: string; end: string }> {
    try {
      return JSON.parse(settings.BUSINESS_HOURS || '{}');
    } catch {
      return {};
    }
  }

  private toMinutesOfDay(hhmm: string): number {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + (m || 0);
  }

  isWithinBusinessHours(settings: Record<string, string>, at?: Date): boolean {
    const schedule = this.getBusinessHoursSchedule(settings);
    const { day, hour, minute } = at ? this.getPKTimeAt(at) : this.getPKTime();
    const window = schedule[String(day)];
    if (!window) return false; // no entry for this day = closed

    const currentMins = hour * 60 + minute;
    return currentMins >= this.toMinutesOfDay(window.start) && currentMins < this.toMinutesOfDay(window.end);
  }

  private getPKTimeAt(date: Date): { day: number; hour: number; minute: number } {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Karachi', hourCycle: 'h23', weekday: 'short', hour: 'numeric', minute: 'numeric',
    });
    const parts = formatter.formatToParts(date);
    const partMap = Object.fromEntries(parts.map(p => [p.type, p.value]));
    const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return { day: weekdayMap[partMap.weekday] ?? 0, hour: parseInt(partMap.hour, 10), minute: parseInt(partMap.minute, 10) };
  }

  // Sums only in-business-hours minutes between two timestamps, walking day by
  // day. This is what lets the 1-hour SLA "pause" overnight/on weekends instead
  // of ticking in real time — a lead assigned at 6:30pm only accrues 30 minutes
  // before close, and picks up the remaining 30 minutes the next working day.
  businessMinutesElapsed(start: Date, end: Date, schedule: Record<string, { start: string; end: string }>): number {
    if (end <= start) return 0;
    let total = 0;
    const cursor = new Date(start);

    // Cap iterations defensively — a lead can't realistically sit unprocessed
    // for years; this just guards against an unbounded loop if data is bad.
    for (let i = 0; i < 3650 && cursor < end; i++) {
      const { day, hour, minute } = this.getPKTimeAt(cursor);
      const window = schedule[String(day)];
      const nowMins = hour * 60 + minute;

      // Midnight (in PKT) at the start of the next day, used to advance the cursor.
      const nextMidnight = new Date(cursor);
      const pktParts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Karachi', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(cursor);
      const pm = Object.fromEntries(pktParts.map(p => [p.type, p.value]));
      const todayMidnight = new Date(`${pm.year}-${pm.month.padStart(2, '0')}-${pm.day.padStart(2, '0')}T00:00:00+05:00`);
      nextMidnight.setTime(todayMidnight.getTime() + 24 * 3600 * 1000);

      const segmentEnd = end < nextMidnight ? end : nextMidnight;

      if (window) {
        const startMins = this.toMinutesOfDay(window.start);
        const endMins = this.toMinutesOfDay(window.end);
        const dayStart = new Date(todayMidnight.getTime() + Math.max(nowMins, startMins) * 60 * 1000);
        const dayEnd = new Date(todayMidnight.getTime() + endMins * 60 * 1000);
        const effectiveStart = cursor > dayStart ? cursor : dayStart;
        const effectiveEnd = segmentEnd < dayEnd ? segmentEnd : dayEnd;
        if (effectiveEnd > effectiveStart) {
          total += (effectiveEnd.getTime() - effectiveStart.getTime()) / 60000;
        }
      }

      cursor.setTime(segmentEnd.getTime());
    }
    return total;
  }

  // Pakistan doesn't observe DST, so the offset is always a fixed +05:00 — no
  // timezone library needed. Shifting the instant forward 5h then formatting
  // with toISOString() (always UTC) yields Karachi's wall-clock digits; the
  // trailing "Z" is then relabeled "+05:00" since that's the true offset, not UTC.
  private toKarachiISOString(date: Date): string {
    const shifted = new Date(date.getTime() + 5 * 3600 * 1000);
    return shifted.toISOString().replace('Z', '');
  }

  // ─── Self-created leads ─────────────────────────────────────────────────────
  // An agent creating a lead for themselves (picked from a designated Bitrix
  // Source, configured in Settings) should never enter the workflow at all.

  isSelfCreatedSource(sourceId: string, settings: Record<string, string>): boolean {
    if (!sourceId) return false;
    let selfSources: string[] = [];
    try { selfSources = JSON.parse(settings.SELF_CREATED_SOURCE_IDS || '[]'); } catch {}
    return selfSources.map((s) => s.toUpperCase()).includes(sourceId.toUpperCase());
  }

  // ─── Source allow-list ─────────────────────────────────────────────────────

  isSourceAllowed(sourceId: string, settings: Record<string, string>): boolean {
    // A source explicitly mapped in SOURCE_TEAM_MAP is a deliberate routing
    // decision — a stronger, more specific signal than the coarser
    // ALLOWED_SOURCES list, so it can't be silently dropped by it.
    if (sourceId) {
      let map: Record<string, string> = {};
      try { map = JSON.parse(settings.SOURCE_TEAM_MAP || '{}'); } catch {}
      if (Object.keys(map).some((src) => src.toUpperCase() === sourceId.toUpperCase())) return true;
    }

    const allowedRaw = settings.ALLOWED_SOURCES || '[]';
    let allowed: string[] = [];
    try { allowed = JSON.parse(allowedRaw); } catch { return true; }
    if (allowed.length === 0) return true;
    if (!sourceId) return false;
    return allowed.map((s) => s.toUpperCase()).includes(sourceId.toUpperCase());
  }

  // ─── Source → Team routing ─────────────────────────────────────────────────
  // One shared ONCRMLEADADD webhook receives every lead regardless of source;
  // this decides which team's rotation a lead lands in. A source explicitly
  // mapped in SOURCE_TEAM_MAP wins; anything else falls back to the single
  // default team (LEAD_ASSIGNMENT_TEAM) so unmapped sources still get assigned
  // rather than silently escalating.

  resolveTeamForSource(sourceId: string, settings: Record<string, string>): string {
    let map: Record<string, string> = {};
    try { map = JSON.parse(settings.SOURCE_TEAM_MAP || '{}'); } catch {}
    if (sourceId) {
      const hit = Object.entries(map).find(([src]) => src.toUpperCase() === sourceId.toUpperCase());
      if (hit) return hit[1].trim();
    }
    return (settings.LEAD_ASSIGNMENT_TEAM || 'B2C').trim();
  }

  // ─── Bitrix24: Source labels (live, cached) ────────────────────────────────
  // Replaces the old hardcoded SOURCE_LABELS map. Pulls human-readable names from
  // crm.status.list (ENTITY_ID=SOURCE) and caches them so we don't hit Bitrix on
  // every lead. Cache refreshes every 30 minutes.

  private sourceLabelCache: { labels: Record<string, string>; fetchedAt: number } | null = null;
  private readonly SOURCE_LABEL_TTL_MS = 30 * 60 * 1000;

  private async getSourceLabels(creds: BitrixCreds): Promise<Record<string, string>> {
    if (this.sourceLabelCache && Date.now() - this.sourceLabelCache.fetchedAt < this.SOURCE_LABEL_TTL_MS) {
      return this.sourceLabelCache.labels;
    }
    try {
      const sep = this.bitrixUrl('crm.status.list', creds).includes('?') ? '&' : '?';
      const url = `${this.bitrixUrl('crm.status.list', creds)}${sep}filter[ENTITY_ID]=SOURCE`;
      const res = await fetch(url);
      const data = (await res.json()) as any;
      const labels: Record<string, string> = {};
      for (const s of data.result || []) labels[s.STATUS_ID] = s.NAME;
      this.sourceLabelCache = { labels, fetchedAt: Date.now() };
      return labels;
    } catch (err) {
      this.logger.warn(`getSourceLabels failed: ${(err as Error).message}`);
      return this.sourceLabelCache?.labels || {};
    }
  }

  // ─── Bitrix24: Lead details ────────────────────────────────────────────────

  async fetchLeadDetails(leadId: string, creds: BitrixCreds): Promise<LeadDetails> {
    try {
      const separator = this.bitrixUrl('crm.lead.get', creds).includes('?') ? '&' : '?';
      const url = `${this.bitrixUrl('crm.lead.get', creds)}${separator}id=${leadId}`;
      const res = await fetch(url);
      const data = (await res.json()) as any;
      const lead = data.result;
      if (!lead) return { name: `Lead #${leadId}`, source: 'CRM', sourceId: '', title: `Lead #${leadId}` };

      const contactName = [lead.NAME, lead.LAST_NAME].filter(Boolean).join(' ').trim();
      const displayName = contactName || lead.COMPANY_TITLE || lead.TITLE || `Lead #${leadId}`;
      const sourceId = lead.SOURCE_ID || '';
      const sourceLabels = await this.getSourceLabels(creds);
      const sourceLabel = sourceLabels[sourceId] || lead.SOURCE_DESCRIPTION || sourceId || 'CRM';

      let phone = '';
      if (lead.PHONE && Array.isArray(lead.PHONE) && lead.PHONE.length > 0) {
        phone = lead.PHONE[0]?.VALUE || '';
      }
      let email = '';
      if (lead.EMAIL && Array.isArray(lead.EMAIL) && lead.EMAIL.length > 0) {
        email = lead.EMAIL[0]?.VALUE || '';
      }

      // Fallback: some leads keep no phone/email on the lead itself — it lives on
      // the linked contact. Pull it from there so the alert shows a real number.
      if ((!phone || !email) && lead.CONTACT_ID) {
        const contact = await this.fetchContactComm(String(lead.CONTACT_ID), creds);
        if (!phone) phone = contact.phone;
        if (!email) email = contact.email;
      }

      return {
        name: displayName,
        source: sourceLabel,
        sourceId,
        title: lead.TITLE || displayName,
        phone,
        email,
        isReturnCustomer: lead.IS_RETURN_CUSTOMER === 'Y',
        assignedById: lead.ASSIGNED_BY_ID,
        modifyById: lead.MODIFY_BY_ID,
        statusId: lead.STATUS_ID,
        createdById: lead.CREATED_BY_ID,
      };
    } catch (err) {
      this.logger.warn(`fetchLeadDetails failed for #${leadId}: ${(err as Error).message}`);
      return { name: `Lead #${leadId}`, source: 'CRM', sourceId: '', title: `Lead #${leadId}` };
    }
  }

  // Read phone/email from a CRM contact (used when the lead has none of its own).
  private async fetchContactComm(contactId: string, creds: BitrixCreds): Promise<{ phone: string; email: string }> {
    try {
      const sep = this.bitrixUrl('crm.contact.get', creds).includes('?') ? '&' : '?';
      const res = await fetch(`${this.bitrixUrl('crm.contact.get', creds)}${sep}id=${contactId}`);
      const data = (await res.json()) as any;
      const c = data.result || {};
      const phone = Array.isArray(c.PHONE) && c.PHONE.length > 0 ? (c.PHONE[0]?.VALUE || '') : '';
      const email = Array.isArray(c.EMAIL) && c.EMAIL.length > 0 ? (c.EMAIL[0]?.VALUE || '') : '';
      return { phone, email };
    } catch {
      return { phone: '', email: '' };
    }
  }

  // ─── Duplicate detection ───────────────────────────────────────────────────
  // The same customer often enters Bitrix as several leads from different
  // sources (e.g. Website + CRM form), sometimes seconds apart from the same
  // form submission. Bitrix's own crm.duplicate.findbycomm only searches
  // phone/email stored directly on the Lead entity — confirmed against
  // production data that this portal's web-sourced leads routinely keep that
  // data on a linked Contact instead, which the Lead-level index can't see —
  // so we also check the Contact-level index and map back to its lead(s).
  // A same-name lead created within a short recency window is checked too,
  // since that's the only remaining signal once a lead has neither Lead- nor
  // Contact-level phone/email. Any of these routes to the Escalation Manager
  // instead of round-robining a second rep to the same customer.

  private normalizeName(name: string): string {
    return (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  private buildDisplayName(raw: any): string {
    const contactName = [raw.NAME, raw.LAST_NAME].filter(Boolean).join(' ').trim();
    return contactName || raw.COMPANY_TITLE || raw.TITLE || `Lead #${raw.ID}`;
  }

  // Ask Bitrix's own duplicate index for other lead IDs sharing this phone/email.
  private async findDuplicateLeadIdsByType(
    type: 'PHONE' | 'EMAIL',
    leadId: string,
    value: string,
    creds: BitrixCreds,
  ): Promise<string[]> {
    if (!value) return [];
    try {
      const sep = this.bitrixUrl('crm.duplicate.findbycomm', creds).includes('?') ? '&' : '?';
      const url = `${this.bitrixUrl('crm.duplicate.findbycomm', creds)}${sep}type=${type}&entity_type=LEAD&values[]=${encodeURIComponent(value)}`;
      const res = await fetch(url);
      const data = (await res.json()) as any;
      const ids: any[] = data.result?.LEAD || [];
      return ids.map(String).filter((id) => id !== String(leadId));
    } catch (err) {
      this.logger.warn(`findDuplicateLeadIdsByType (${type}) failed for #${leadId}: ${(err as Error).message}`);
      return [];
    }
  }

  // crm.duplicate.findbycomm with entity_type=LEAD only searches phone/email
  // values stored directly on the Lead entity. Confirmed against production
  // data (2026-07-22): this portal's web-sourced leads routinely arrive with
  // no phone/email on the Lead itself — Bitrix links a Contact record and the
  // communication data lives there instead — so findDuplicateLeadIdsByType
  // above silently misses these. Searching entity_type=CONTACT finds the
  // matching contact(s), which we then map back to whatever lead(s) they're
  // linked to.
  private async findDuplicateLeadIdsViaContact(
    type: 'PHONE' | 'EMAIL',
    leadId: string,
    value: string,
    creds: BitrixCreds,
  ): Promise<string[]> {
    if (!value) return [];
    try {
      const sep = this.bitrixUrl('crm.duplicate.findbycomm', creds).includes('?') ? '&' : '?';
      const url = `${this.bitrixUrl('crm.duplicate.findbycomm', creds)}${sep}type=${type}&entity_type=CONTACT&values[]=${encodeURIComponent(value)}`;
      const res = await fetch(url);
      const data = (await res.json()) as any;
      const contactIds: any[] = data.result?.CONTACT || [];
      if (contactIds.length === 0) return [];

      const params = new URLSearchParams();
      contactIds.forEach((id: any) => params.append('filter[CONTACT_ID][]', String(id)));
      params.append('select[]', 'ID');
      const sep2 = this.bitrixUrl('crm.lead.list', creds).includes('?') ? '&' : '?';
      const res2 = await fetch(`${this.bitrixUrl('crm.lead.list', creds)}${sep2}${params.toString()}`);
      const data2 = (await res2.json()) as any;
      const leadIds: any[] = data2.result || [];
      return leadIds.map((r: any) => String(r.ID)).filter((id) => id !== String(leadId));
    } catch (err) {
      this.logger.warn(`findDuplicateLeadIdsViaContact (${type}) failed for #${leadId}: ${(err as Error).message}`);
      return [];
    }
  }

  // Recent leads (any source, no source filter — confirmed against production
  // data that the same submission can double-post under two different
  // sources, e.g. "Website" + "CRM form", seconds apart) whose display name
  // matches and which were created within the time window. Recency is what
  // makes a bare name match trustworthy instead of a coincidental namesake.
  private async findRecentLeadsByName(
    leadId: string,
    name: string,
    creds: BitrixCreds,
    windowMinutes = 30,
    limit = 50,
  ): Promise<string[]> {
    const normalizedTarget = this.normalizeName(name);
    if (!normalizedTarget) return [];
    try {
      const params = new URLSearchParams();
      params.append('order[ID]', 'DESC');
      params.append('select[]', 'ID');
      params.append('select[]', 'NAME');
      params.append('select[]', 'LAST_NAME');
      params.append('select[]', 'COMPANY_TITLE');
      params.append('select[]', 'TITLE');
      params.append('select[]', 'DATE_CREATE');
      const sep = this.bitrixUrl('crm.lead.list', creds).includes('?') ? '&' : '?';
      const res = await fetch(`${this.bitrixUrl('crm.lead.list', creds)}${sep}${params.toString()}`);
      const data = (await res.json()) as any;
      const rows: any[] = (data.result || []).slice(0, limit);
      const cutoff = Date.now() - windowMinutes * 60 * 1000;
      return rows
        .filter((r) => String(r.ID) !== String(leadId))
        .filter((r) => this.normalizeName(this.buildDisplayName(r)) === normalizedTarget)
        .filter((r) => { const t = new Date(r.DATE_CREATE).getTime(); return !isNaN(t) && t >= cutoff; })
        .map((r) => String(r.ID));
    } catch (err) {
      this.logger.warn(`findRecentLeadsByName failed for #${leadId}: ${(err as Error).message}`);
      return [];
    }
  }

  // Combines phone/email (Lead-level and Contact-level index, either
  // sufficient alone) with a recent name match (sufficient on its own within
  // the time window — see findRecentLeadsByName) into one duplicate check.
  async findGuardrailDuplicates(
    leadId: string,
    lead: LeadDetails,
    creds: BitrixCreds,
  ): Promise<{ leadId: string; matchedFields: string[] }[]> {
    const matched = new Map<string, Set<string>>();
    const addMatches = (ids: string[], ...fields: string[]) => {
      for (const id of ids) {
        if (!matched.has(id)) matched.set(id, new Set());
        fields.forEach((f) => matched.get(id)!.add(f));
      }
    };

    const [phoneIds, emailIds, phoneViaContact, emailViaContact, recentNameIds] = await Promise.all([
      this.findDuplicateLeadIdsByType('PHONE', leadId, lead.phone || '', creds),
      this.findDuplicateLeadIdsByType('EMAIL', leadId, lead.email || '', creds),
      this.findDuplicateLeadIdsViaContact('PHONE', leadId, lead.phone || '', creds),
      this.findDuplicateLeadIdsViaContact('EMAIL', leadId, lead.email || '', creds),
      this.findRecentLeadsByName(leadId, lead.name, creds),
    ]);
    addMatches(phoneIds, 'phone');
    addMatches(emailIds, 'email');
    addMatches(phoneViaContact, 'phone (via contact)');
    addMatches(emailViaContact, 'email (via contact)');
    addMatches(recentNameIds, 'name+recent');

    return [...matched.entries()].map(([id, fields]) => ({ leadId: id, matchedFields: [...fields].sort() }));
  }


  // ─── Bitrix24: Mutations ───────────────────────────────────────────────────

  async assignLeadInBitrix(leadId: string, assigneeUserId: string, creds: BitrixCreds): Promise<boolean> {
    try {
      const body = new URLSearchParams({ id: leadId, 'fields[ASSIGNED_BY_ID]': assigneeUserId });
      if (creds.accessToken) body.append('auth', creds.accessToken);
      const res = await fetch(this.bitrixUrl('crm.lead.update', creds), { method: 'POST', body });
      const data = (await res.json()) as any;
      if (data.result !== true) {
        // Previously silent — callers didn't check this return value, so a
        // failure here (e.g. the lead was deleted in Bitrix) was invisible.
        this.logger.warn(`assignLeadInBitrix for #${leadId} → user ${assigneeUserId} did not confirm: ${JSON.stringify(data)}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(`assignLeadInBitrix failed: ${(err as Error).message}`);
      return false;
    }
  }

  // Set a lead's stage — used to Junk the losing side of an auto-merge.
  async updateLeadStatus(leadId: string, statusId: string, creds: BitrixCreds): Promise<boolean> {
    try {
      const body = new URLSearchParams({ id: leadId, 'fields[STATUS_ID]': statusId });
      if (creds.accessToken) body.append('auth', creds.accessToken);
      const res = await fetch(this.bitrixUrl('crm.lead.update', creds), { method: 'POST', body });
      const data = (await res.json()) as any;
      return data.result === true;
    } catch (err) {
      this.logger.error(`updateLeadStatus failed for #${leadId}: ${(err as Error).message}`);
      return false;
    }
  }

  // Timeline comment — used for the merge audit trail (no task, no rotation).
  async addTimelineComment(leadId: string, comment: string, creds: BitrixCreds): Promise<boolean> {
    try {
      const body = new URLSearchParams();
      body.append('fields[ENTITY_ID]', leadId);
      body.append('fields[ENTITY_TYPE]', 'lead');
      body.append('fields[COMMENT]', comment);
      if (creds.accessToken) body.append('auth', creds.accessToken);
      const res = await fetch(this.bitrixUrl('crm.timeline.comment.add', creds), { method: 'POST', body });
      const data = (await res.json()) as any;
      return !data.error;
    } catch (err) {
      this.logger.warn(`addTimelineComment failed for #${leadId}: ${(err as Error).message}`);
      return false;
    }
  }

  // ─── Assignment history (Bitrix-visible, replaces needing to query our DB) ─
  // A JSON array written straight to a Lead custom field, one entry per holding
  // period: who had it, when they got it, when they stopped, and why. This is
  // what lets "how long did it sit with X before it moved" and "worked vs
  // missed vs manually moved" counts be answered directly from Bitrix data,
  // without needing access to our own database.

  private async readAssignmentHistory(leadId: string, fieldCode: string, creds: BitrixCreds): Promise<AssignmentHistoryEntry[]> {
    try {
      const sep = this.bitrixUrl('crm.lead.get', creds).includes('?') ? '&' : '?';
      const res = await fetch(`${this.bitrixUrl('crm.lead.get', creds)}${sep}id=${leadId}`);
      const data = (await res.json()) as any;
      const raw = data.result?.[fieldCode];
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      this.logger.warn(`readAssignmentHistory failed for #${leadId}: ${(err as Error).message}`);
      return [];
    }
  }

  private async writeAssignmentHistory(leadId: string, entries: AssignmentHistoryEntry[], fieldCode: string, creds: BitrixCreds): Promise<boolean> {
    try {
      const body = new URLSearchParams({ id: leadId, [`fields[${fieldCode}]`]: JSON.stringify(entries) });
      if (creds.accessToken) body.append('auth', creds.accessToken);
      const res = await fetch(this.bitrixUrl('crm.lead.update', creds), { method: 'POST', body });
      const data = (await res.json()) as any;
      if (data.result !== true) {
        this.logger.warn(`writeAssignmentHistory for #${leadId} did not confirm: ${JSON.stringify(data)}`);
        return false;
      }
      // (A read-back verification lived here temporarily to debug the custom
      // field write — removed now that it's confirmed working, since it cost
      // an extra Bitrix call on every single handoff.)
      return true;
    } catch (err) {
      this.logger.warn(`writeAssignmentHistory failed for #${leadId}: ${(err as Error).message}`);
      return false;
    }
  }

  // Closes out the current holder's entry (when they stopped, and why) and opens
  // a new one for whoever holds it now. Never throws — a failure here logs and
  // moves on rather than blocking the actual reassignment, since this field is
  // a reporting aid, not the source of truth (LeadRotation + Bitrix ASSIGNED_BY_ID
  // are). newHolder is null for the "worked" case, where nobody takes over.
  //
  // Known limitation: this is a read-modify-write against a single Bitrix field,
  // not atomic. Two handoffs for the same lead firing within the same instant
  // (e.g. a webhook and the SLA sweep landing together) could race and one
  // could clobber the other. In practice handoffs for one lead are minutes
  // apart, so this is a low-probability edge case, not a correctness guarantee.
  private async recordAssignmentHandoff(
    leadId: string,
    newHolderBitrixUserId: string | null,
    lap: number,
    previousOutcome: 'worked' | 'missed' | 'manual_reassigned' | null,
    settings: Record<string, string>,
    creds: BitrixCreds,
  ): Promise<void> {
    const fieldCode = settings.ASSIGNMENT_HISTORY_FIELD;
    if (!fieldCode) {
      // Previously a silent no-op — indistinguishable from "it worked" in the
      // logs. This setting only self-seeds on the first boot after it was
      // introduced; an existing deployment that already had a WorkflowSetting
      // table won't get it for free, so this is worth surfacing loudly.
      this.logger.warn(`recordAssignmentHandoff skipped for #${leadId} — ASSIGNMENT_HISTORY_FIELD setting is empty/unset`);
      return;
    }
    const history = await this.readAssignmentHistory(leadId, fieldCode, creds);
    const open = history[history.length - 1];
    const now = this.toKarachiISOString(new Date());
    if (open && !open.end) {
      open.end = now;
      open.res = previousOutcome;
    }
    if (newHolderBitrixUserId) {
      history.push({ uid: newHolderBitrixUserId, lap, asg: now, end: null, res: null });
    }
    const ok = await this.writeAssignmentHistory(leadId, history, fieldCode, creds);
    if (ok) {
      this.logger.log(`Assignment history updated for #${leadId} (${fieldCode}) — ${history.length} entr${history.length === 1 ? 'y' : 'ies'}`);
    }
  }

  // Native Bitrix24 in-app notification (bell icon + activity stream), used
  // alongside WhatsApp so an agent is alerted even without WhatsApp configured.
  // Deliberately ignores whatever creds the caller is using elsewhere and
  // always goes through getNotificationWebhookCreds() — im.notify.personal.add
  // rejected the main webhook with "requires higher privileges" (the owning
  // user isn't a full Administrator), which is a rights issue on that specific
  // webhook, not a blanket restriction on webhooks calling this method at all.
  async sendBitrixNotification(userId: string, message: string): Promise<boolean> {
    if (!userId) return false;
    const creds = this.getNotificationWebhookCreds();
    try {
      const body = new URLSearchParams({ 'fields[USER_ID]': userId, 'fields[MESSAGE]': message });
      if (creds.accessToken) body.append('auth', creds.accessToken);
      const res = await fetch(this.bitrixUrl('im.notify.personal.add', creds), { method: 'POST', body });
      const data = (await res.json()) as any;
      if (data.error) {
        // Bitrix returned an error body instead of throwing — this was previously
        // swallowed silently.
        this.logger.warn(`sendBitrixNotification failed for user ${userId}: ${data.error_description || data.error}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(`sendBitrixNotification failed for user ${userId}: ${(err as Error).message}`);
      return false;
    }
  }

  // ─── Round-Robin Pick ──────────────────────────────────────────────────────

  async pickNextAgent(team: string): Promise<any | null> {
    const settings = await this.getSettings();
    let deptFilter: string[] = [];
    try { deptFilter = JSON.parse(settings.ELIGIBLE_DEPT_IDS || '[]'); } catch {}

    const agents = await this.agent.findMany({
      where: {
        team,
        is_active: true,
        ...(deptFilter.length > 0 ? { department_id: { in: deptFilter } } : {}),
      },
      orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
    });
    if (agents.length === 0) return null;

    const lastLog = await this.assignmentLog.findFirst({
      where: { team },
      orderBy: { assigned_at: 'desc' },
    });
    if (!lastLog) return agents[0];

    const lastIdx = agents.findIndex((a) => a.id === lastLog.agent_id);
    return agents[(lastIdx + 1) % agents.length];
  }

  // ─── CORE: Process Lead Assignment ────────────────────────────────────────
  // Used by both manual force-assign and the cron job

  async processLeadAssignment(
    leadId: string,
    team: string | undefined,
    creds: BitrixCreds,
    force = false,
    opts: { skipHoursCheck?: boolean; isRecycle?: boolean } = {},
  ): Promise<{ success: boolean; agent?: any; skipped?: boolean; queued?: boolean; message?: string }> {
    const settings = await this.getSettings();

    if (settings.WORKFLOW_ENABLED !== 'true') {
      this.logger.log(`Lead #${leadId} skipped — workflow engine is paused`);
      return { success: false, message: 'Workflow engine is paused' };
    }

    const cleanLeadId = String(leadId);

    // Concurrency Lock: Serialize concurrent calls for the same lead
    if (this.activeAssignments.has(cleanLeadId)) {
      this.logger.log(`Lead #${cleanLeadId} assignment is already in progress. Skipping concurrent request.`);
      return { success: false, message: 'Assignment already in progress' };
    }
    this.activeAssignments.add(cleanLeadId);

    try {
      // Idempotency guard. A lead already logged must never produce a second
      // WhatsApp/log row when nothing has actually changed — no matter how we
      // got here (a retried webhook delivery, or a Bitrix ONCRMLEADUPDATE event
      // that merely touches an already-assigned lead rather than genuinely
      // reassigning it). Bypassed by force=true, and by isRecycle=true (a stale
      // lead being reintroduced after weeks/months necessarily already has an
      // old AssignmentLog row — that's expected here, not a retry to ignore).
      // Irrelevant once the lead is being manually reassigned (that path goes
      // through handleLeadChangeWebhook → assignToAgent directly, not here).
      const existingLog = await this.assignmentLog.findFirst({
        where: { lead_id: cleanLeadId },
        orderBy: { assigned_at: 'desc' },
      });
      if (existingLog && !force && !opts.isRecycle) {
        this.logger.log(`Lead #${cleanLeadId} is already assigned to ${existingLog.agent_name}. Skipping duplicate assignment.`);
        return { success: true, skipped: true, message: `Lead already assigned to ${existingLog.agent_name}` };
      }

      // Already flagged as a duplicate on a previous pass (e.g. a retried
      // webhook delivery) — don't re-run the guardrail's several Bitrix API
      // calls, and don't let a forced/manager path assign it out from under
      // the duplicate flag either.
      if (!force) {
        const existingFlag = await this.duplicateLead.findUnique({ where: { lead_id: cleanLeadId } });
        if (existingFlag) {
          const matches = JSON.parse(existingFlag.matched_lead_ids || '[]').join(', ');
          return { success: true, skipped: true, message: `Lead flagged as duplicate of ${matches} — left unassigned` };
        }
      }

      // Fetch lead details up front — needed for routing and escalation messaging.
      const lead = await this.fetchLeadDetails(cleanLeadId, creds);

      // Self-created leads (agent made the lead themselves, flagged by Source)
      // never enter the workflow — left exactly as Bitrix set them up.
      if (!force && this.isSelfCreatedSource(lead.sourceId, settings)) {
        this.logger.log(`Lead #${cleanLeadId} skipped — self-created source "${lead.sourceId}"`);
        return { success: true, skipped: true, message: `Self-created lead (source "${lead.sourceId}") — left as-is` };
      }

      // Skip sources outside the allow-list (empty list = all allowed)
      if (!force && !this.isSourceAllowed(lead.sourceId, settings)) {
        this.logger.log(`Lead #${cleanLeadId} skipped — source "${lead.sourceId}" is not allowed`);
        return { success: true, skipped: true, message: `Source "${lead.sourceId}" is not allowed` };
      }

      // Resolve the target team from the lead's own source unless the caller
      // pinned one explicitly (e.g. handleLeadChangeWebhook routing to the rep's
      // existing team). This is what lets one shared ONCRMLEADADD webhook route
      // every source to the right team instead of everything piling into a
      // single global team.
      const resolvedTeam = (team ? team.trim() : '') || this.resolveTeamForSource(lead.sourceId, settings);

      const slaMinutes = parseInt(settings.SLA_MINUTES || '60', 10);

      // Out of business hours → queue it. Processed through this exact same
      // pipeline (self-created / duplicate / round-robin, all still apply) the
      // moment the next business window opens — see CronService + processAllLateLeads.
      if (!force && !opts.skipHoursCheck && !this.isWithinBusinessHours(settings)) {
        await this.storeLateLeadIfAbsent(cleanLeadId);
        this.logger.log(`Lead #${cleanLeadId} queued — outside business hours`);
        return { success: true, queued: true, message: 'Outside business hours — queued for the next working window' };
      }

      // ── Duplicate guardrail — a same-customer lead that already exists. ──
      if (!force) {
        const duplicates = await this.findGuardrailDuplicates(cleanLeadId, lead, creds);
        if (duplicates.length > 0) {
          // Phone/email match is high-confidence enough to auto-merge without a
          // human. A bare name+recency match is weaker and still goes to the
          // Duplicates page for manual review.
          const strong = duplicates.filter((d) => d.matchedFields.some((f) => f.startsWith('phone') || f.startsWith('email')));
          if (strong.length > 0) {
            const merged = await this.autoMergeDuplicate(cleanLeadId, lead, resolvedTeam, strong, creds);
            if (merged) return merged;
            // autoMergeDuplicate returns null when the survivor is already closed —
            // fall through to flagging for manual review instead of silently burying
            // a genuine re-engagement inside a dead lead.
          }
          return this.flagAsDuplicate(cleanLeadId, lead, resolvedTeam, duplicates);
        }
      }

      // Fresh lead → round-robin to the next active agent. Locked per-team so
      // concurrent leads for the same team can't both pick the same agent.
      return this.withTeamLock(resolvedTeam, async () => {
        const agent = await this.pickNextAgent(resolvedTeam);
        if (!agent) {
          return this.escalateToManager(cleanLeadId, lead, resolvedTeam, `no active agents in team "${resolvedTeam}"`, settings, creds);
        }
        return this.assignToAgent(cleanLeadId, lead, agent, resolvedTeam, slaMinutes, settings, creds, 'round-robin');
      });
    } finally {
      this.activeAssignments.delete(cleanLeadId);
    }
  }

  // Assign a lead to a specific agent: update Bitrix, (re)start its SLA rotation
  // tracking, log it, and send the WhatsApp + Bitrix alerts. Used for round-robin,
  // rotation timeouts, manager reassigns, and any other manual reassignment.
  private async assignToAgent(
    leadId: string, lead: LeadDetails, agent: any, team: string,
    slaMinutes: number, settings: Record<string, string>, creds: BitrixCreds, reason: string,
    lapNumber = 1, previousOutcome: 'missed' | 'manual_reassigned' | null = null,
  ): Promise<any> {
    await this.assignLeadInBitrix(leadId, agent.bitrix_user_id, creds);
    await this.setKnownOwner(leadId, agent.bitrix_user_id);
    await this.recordAssignmentHandoff(leadId, agent.bitrix_user_id, lapNumber, previousOutcome, settings, creds);

    await this.assignmentLog.upsert({
      where: { lead_id_agent_id: { lead_id: leadId, agent_id: agent.id || 'manual-assignee' } },
      update: {},
      create: { lead_id: leadId, agent_id: agent.id || 'manual-assignee', agent_name: agent.name, team },
    });

    await this.leadRotation.upsert({
      where: { lead_id: leadId },
      update: {
        team, current_agent_id: agent.id || 'manual-assignee', current_agent_name: agent.name,
        assigned_at: new Date(), tried_agent_ids: JSON.stringify([agent.id || 'manual-assignee']),
        lap_number: lapNumber, status: 'active',
      },
      create: {
        lead_id: leadId, team, current_agent_id: agent.id || 'manual-assignee', current_agent_name: agent.name,
        tried_agent_ids: JSON.stringify([agent.id || 'manual-assignee']), lap_number: lapNumber, status: 'active',
      },
    });

    const waNotified = await this.notifyAgent(agent, lead, slaMinutes, settings);
    this.logger.log(`"${lead.name}" (${lead.source}) → ${agent.name} [${team}] (${reason}, lap ${lapNumber}). WA: ${waNotified}`);
    return { success: true, agent };
  }

  // Route a lead to the Escalation Manager (no active agents, or the rotation
  // exhausted every lap with nobody acting). No SLA timer runs while it sits
  // with the manager — it waits until they manually reassign it, which restarts
  // tracking for the new rep via handleLeadChangeWebhook.
  private async escalateToManager(
    leadId: string, lead: LeadDetails, team: string,
    reason: string, settings: Record<string, string>, creds: BitrixCreds,
    previousOutcome: 'missed' | null = null,
  ): Promise<any> {
    const managerId = settings.WORKFLOW_MANAGER_ID || '1';
    const manager = await this.agent.findFirst({ where: { bitrix_user_id: managerId } });
    this.logger.warn(`Lead #${leadId} ("${lead.name}") → Escalation Manager (${reason})`);

    await this.assignLeadInBitrix(leadId, managerId, creds);
    await this.setKnownOwner(leadId, managerId);
    await this.recordAssignmentHandoff(leadId, managerId, 0, previousOutcome, settings, creds);

    await this.assignmentLog.upsert({
      where: { lead_id_agent_id: { lead_id: leadId, agent_id: manager?.id || 'escalation-manager' } },
      update: {},
      create: { lead_id: leadId, agent_id: manager?.id || 'escalation-manager', agent_name: manager?.name || `Manager #${managerId}`, team },
    });

    await this.leadRotation.upsert({
      where: { lead_id: leadId },
      update: {
        team, current_agent_id: manager?.id || 'escalation-manager', current_agent_name: manager?.name || `Manager #${managerId}`,
        assigned_at: new Date(), status: 'escalated',
      },
      create: {
        lead_id: leadId, team, current_agent_id: manager?.id || 'escalation-manager',
        current_agent_name: manager?.name || `Manager #${managerId}`, tried_agent_ids: '[]', status: 'escalated',
      },
    });

    let waNotified = false;
    if (manager) {
      waNotified = await this.notifyEscalation(manager, lead, reason, settings);
    }
    return { success: true, agent: manager, message: reason, waNotified };
  }

  // Sends the "assigned to you" (or "escalated to you") alert on both channels
  // WhatsApp and Bitrix in-app notify — used by assignToAgent/notifyEscalation.
  private async notifyAgent(
    agent: any, lead: LeadDetails, slaMinutes: number, settings: Record<string, string>,
  ): Promise<boolean> {
    let waNotified = false;
    if (settings.WHATSAPP_ENABLED !== 'true') {
      this.logger.log(`WhatsApp skipped for ${agent.name} — WHATSAPP_ENABLED is off`);
    } else if (!agent.whatsapp_phone) {
      this.logger.log(`WhatsApp skipped for ${agent.name} — no whatsapp_phone on their agent record`);
    } else {
      waNotified = await this.whatsapp.sendLeadAssignedNotification(agent.whatsapp_phone, agent.name, lead.name, lead.phone || '', slaMinutes, lead.source);
    }
    if (agent.bitrix_user_id) {
      const msg = `New lead assigned: ${lead.name} (${lead.phone || 'no phone'}). You have ${slaMinutes} minutes to move it out of "New Lead" before it moves to the next agent.`;
      const ok = await this.sendBitrixNotification(agent.bitrix_user_id, msg);
      if (!ok) this.logger.warn(`Bitrix in-app notify to ${agent.name} did not go through — see reason above`);
    } else {
      this.logger.log(`Bitrix in-app notify skipped for ${agent.name} — no bitrix_user_id on their agent record`);
    }
    return waNotified;
  }

  private async notifyEscalation(
    manager: any, lead: LeadDetails, reason: string, settings: Record<string, string>,
  ): Promise<boolean> {
    let waNotified = false;
    if (settings.WHATSAPP_ENABLED !== 'true') {
      this.logger.log(`WhatsApp skipped for ${manager.name} — WHATSAPP_ENABLED is off`);
    } else if (!manager.whatsapp_phone) {
      this.logger.log(`WhatsApp skipped for ${manager.name} — no whatsapp_phone on their agent record`);
    } else {
      waNotified = await this.whatsapp.sendEscalationNotification(manager.whatsapp_phone, manager.name, lead.name, lead.phone || '', reason, lead.source);
    }
    if (manager.bitrix_user_id) {
      const msg = `Lead escalated to you: ${lead.name} (${lead.phone || 'no phone'}). Reason: ${reason}. No auto-timer runs until you assign it to someone.`;
      const ok = await this.sendBitrixNotification(manager.bitrix_user_id, msg);
      if (!ok) this.logger.warn(`Bitrix in-app notify to ${manager.name} did not go through — see reason above`);
    }
    return waNotified;
  }

  // Duplicate guardrail matched — left unassigned on purpose. No Bitrix
  // mutation at all (no ASSIGNED_BY_ID change, no task, no WhatsApp); just
  // recorded for a human to review from the Duplicates page.
  private async flagAsDuplicate(
    leadId: string,
    lead: LeadDetails,
    team: string,
    duplicates: { leadId: string; matchedFields: string[] }[],
  ): Promise<any> {
    const matchedLeadIds = duplicates.map((d) => d.leadId);
    const matchedFields = [...new Set(duplicates.flatMap((d) => d.matchedFields))];
    this.logger.warn(`Lead #${leadId} ("${lead.name}") flagged as duplicate of ${matchedLeadIds.join(', ')} — left unassigned.`);
    await this.duplicateLead.upsert({
      where: { lead_id: leadId },
      update: { matched_lead_ids: JSON.stringify(matchedLeadIds), matched_fields: JSON.stringify(matchedFields), team },
      create: {
        lead_id: leadId,
        lead_name: lead.name,
        team,
        matched_lead_ids: JSON.stringify(matchedLeadIds),
        matched_fields: JSON.stringify(matchedFields),
      },
    });
    return { success: true, skipped: true, message: `Flagged as duplicate of ${matchedLeadIds.join(', ')} — left unassigned` };
  }

  // ─── Duplicate auto-merge (phone/email match) ──────────────────────────────
  // Two leads from the same customer arriving via different channels (e.g.
  // Facebook + Website) are merged automatically: the older lead survives
  // untouched, the newer one is closed as Junk with a cross-reference note.
  // Nothing is deleted — fully reversible by a human in Bitrix if needed.

  // Bitrix lead IDs are sequential, so the lowest numeric ID is the oldest lead.
  private pickMergeSurvivor(leadId: string, candidates: { leadId: string; matchedFields: string[] }[]): { leadId: string; matchedFields: string[] } {
    return [...candidates, { leadId, matchedFields: [] }]
      .sort((a, b) => Number(a.leadId) - Number(b.leadId))[0];
  }

  private async autoMergeDuplicate(
    leadId: string, lead: LeadDetails, team: string,
    strongMatches: { leadId: string; matchedFields: string[] }[],
    creds: BitrixCreds,
  ): Promise<any | null> {
    const survivor = this.pickMergeSurvivor(leadId, strongMatches);

    // This lead is already the oldest of the group — nothing to merge it into.
    if (survivor.leadId === leadId) return null;

    const survivorDetails = await this.fetchLeadDetails(survivor.leadId, creds);
    const closedStatuses = ['CONVERTED', 'JUNK'];
    if (survivorDetails.statusId && closedStatuses.includes(survivorDetails.statusId)) {
      this.logger.log(`Lead #${leadId} matched closed lead #${survivor.leadId} — not auto-merging, flagging for review instead`);
      return null;
    }

    const fieldsList = survivor.matchedFields.join(', ');
    await this.updateLeadStatus(leadId, 'JUNK', creds);
    await Promise.all([
      this.addTimelineComment(leadId, `Merged as duplicate of Lead #${survivor.leadId} — matched: ${fieldsList}.`, creds),
      this.addTimelineComment(survivor.leadId, `Lead #${leadId} ("${lead.name}", source: ${lead.source}) was auto-merged into this lead as a duplicate — matched: ${fieldsList}.`, creds),
    ]);

    await this.mergedLead.upsert({
      where: { lead_id: leadId },
      update: { merged_into_lead_id: survivor.leadId, matched_fields: JSON.stringify(survivor.matchedFields), team },
      create: {
        lead_id: leadId, lead_name: lead.name, merged_into_lead_id: survivor.leadId,
        team, matched_fields: JSON.stringify(survivor.matchedFields),
      },
    });

    this.logger.log(`Lead #${leadId} ("${lead.name}") auto-merged into #${survivor.leadId} — matched: ${fieldsList}`);
    return { success: true, skipped: true, message: `Auto-merged into Lead #${survivor.leadId} (matched: ${fieldsList})` };
  }

  async getMergedLeads(limit = 100) {
    return this.mergedLead.findMany({ orderBy: { merged_at: 'desc' }, take: limit });
  }

  // ─── Duplicate review queue ─────────────────────────────────────────────────

  async getDuplicates(resolved?: boolean) {
    return this.duplicateLead.findMany({
      where: resolved === undefined ? {} : { resolved },
      orderBy: { detected_at: 'desc' },
    });
  }

  async resolveDuplicate(id: string) {
    return this.duplicateLead.update({ where: { id }, data: { resolved: true, resolved_at: new Date() } });
  }

  // Close a lead's active SLA rotation the instant it leaves the "new" stage —
  // per the product rule, any stage change (forward, junk, or otherwise) counts
  // as the agent having worked it. Runs regardless of who changed it or whether
  // the owner also changed.
  private async closeRotationIfStageChanged(leadId: string, lead: LeadDetails, settings: Record<string, string>, creds: BitrixCreds): Promise<void> {
    const newStatus = settings.NEW_LEAD_STATUS_ID || 'NEW';
    if (!lead.statusId || lead.statusId === newStatus) return;
    const row = await this.leadRotation.findUnique({ where: { lead_id: leadId } });
    if (row && row.status === 'active') {
      await this.leadRotation.update({ where: { lead_id: leadId }, data: { status: 'done' } });
      await this.recordAssignmentHandoff(leadId, null, 0, 'worked', settings, creds);
      this.logger.log(`Lead #${leadId} left "${newStatus}" stage (now "${lead.statusId}") — SLA rotation closed`);
    }
  }

  // ─── Reassignment webhook → restart tracking for the new owner ─────────────
  // Fired by a Bitrix outbound webhook on lead update (ONCRMLEADUPDATE). Any
  // genuine change of responsible person — the Escalation Manager handing off,
  // a team lead reassigning directly in Bitrix, or our own rotation-timeout
  // reassignment looping back through — (re)starts the SLA rotation for
  // whoever now holds it.
  async handleLeadChangeWebhook(payload: any): Promise<{ action: string; detail?: string }> {
    const settings = await this.getSettings();
    const creds = this.getWebhookCreds();

    const leadId = payload?.data?.FIELDS?.ID || payload?.FIELDS?.ID || payload?.lead_id || '';
    // Logged unconditionally on arrival — this is the only way to tell "Bitrix
    // never called this webhook" (nothing here at all) apart from "it called us
    // but we couldn't find a lead ID in the payload shape it sent."
    this.logger.log(`handleLeadChangeWebhook fired — leadId=${leadId || '(none found)'} payload=${JSON.stringify(payload).slice(0, 500)}`);
    if (!leadId) return { action: 'ignored', detail: 'No lead ID in payload' };

    const lead = await this.fetchLeadDetails(String(leadId), creds);
    const managerId = settings.WORKFLOW_MANAGER_ID || '1';

    await this.closeRotationIfStageChanged(String(leadId), lead, settings, creds);

    // Ignore events where the owner hasn't actually changed since we last saw
    // it — e.g. someone commenting on or editing a lead that's already
    // correctly assigned. Without this, any such touch looks identical to a
    // deliberate reassignment and re-notifies the current owner, which is how
    // one lead could end up cycling through several agents with no real
    // handoff happening.
    const knownOwner = await this.getKnownOwner(String(leadId));
    if (knownOwner !== null && lead.assignedById && knownOwner === lead.assignedById) {
      return { action: 'ignored', detail: 'Owner unchanged since last observation' };
    }

    if (!lead.assignedById || lead.assignedById === knownOwner) {
      return { action: 'ignored', detail: 'No owner change detected' };
    }

    // Reassigned TO the Escalation Manager — hold with no SLA timer, same as
    // any other escalation, until they hand it to someone.
    if (lead.assignedById === managerId) {
      await this.setKnownOwner(String(leadId), lead.assignedById);
      const manager = await this.agent.findFirst({ where: { bitrix_user_id: managerId } });
      const team = (manager?.team || settings.LEAD_ASSIGNMENT_TEAM || 'B2C').trim();
      await this.recordAssignmentHandoff(String(leadId), managerId, 0, 'manual_reassigned', settings, creds);
      await this.leadRotation.upsert({
        where: { lead_id: String(leadId) },
        update: { team, current_agent_id: manager?.id || 'escalation-manager', current_agent_name: manager?.name || `Manager #${managerId}`, assigned_at: new Date(), status: 'escalated' },
        create: { lead_id: String(leadId), team, current_agent_id: manager?.id || 'escalation-manager', current_agent_name: manager?.name || `Manager #${managerId}`, tried_agent_ids: '[]', status: 'escalated' },
      });
      return { action: 'escalated', detail: 'Reassigned to Escalation Manager — SLA tracking paused' };
    }

    // Reassigned to any known agent in the roster — (re)start their SLA rotation.
    const repAgent = await this.agent.findFirst({ where: { bitrix_user_id: lead.assignedById } });
    if (!repAgent) {
      // Reassigned to someone outside our agent roster — nothing we can track
      // (no WhatsApp/notify target on file). Just record the new owner.
      await this.setKnownOwner(String(leadId), lead.assignedById);
      return { action: 'ignored', detail: 'Reassigned to a user outside the agent roster' };
    }

    const team = (repAgent.team || settings.LEAD_ASSIGNMENT_TEAM || 'B2C').trim();
    const slaMinutes = parseInt(settings.SLA_MINUTES || '60', 10);
    this.logger.log(`Lead #${leadId} manually reassigned → ${repAgent.name}. Restarting SLA rotation.`);
    await this.assignToAgent(String(leadId), lead, repAgent, team, slaMinutes, settings, creds, 'manual reassignment', 1, 'manual_reassigned');

    return { action: 'restarted', detail: `SLA rotation restarted for ${repAgent.name}` };
  }

  // ─── Cron — Process all queued off-hours leads ─────────────────────────────
  // Called by CronService the moment each configured business-hours window opens

  async processAllLateLeads(): Promise<{ processed: number; skipped: number; failed: number }> {
    const leads = await this.getLateLeads();
    if (leads.length === 0) {
      this.logger.log('Cron: no late leads to process');
      return { processed: 0, skipped: 0, failed: 0 };
    }

    const settings = await this.getSettings();

    if (settings.WORKFLOW_ENABLED !== 'true') {
      this.logger.log('Cron: skipped — workflow engine is paused');
      return { processed: 0, skipped: leads.length, failed: 0 };
    }

    this.logger.log(`Cron: processing ${leads.length} late lead(s) — team resolved per-lead by source`);
    const creds = this.getWebhookCreds();
    let processed = 0, skipped = 0, failed = 0;

    for (const lateLead of leads) {
      try {
        // skipHoursCheck (not force): we're intentionally draining the queue now
        // that the business window is open, but self-created/source/duplicate
        // checks must still run — force would bypass those too.
        const result = await this.processLeadAssignment(lateLead.lead_id, undefined, creds, false, { skipHoursCheck: true });
        await this.lateLead.update({ where: { lead_id: lateLead.lead_id }, data: { processed: true, processed_at: new Date() } });
        if (result.skipped) skipped++;
        else if (result.success) processed++;
        else failed++;
      } catch (err) {
        this.logger.error(`Cron: failed to process lead #${lateLead.lead_id}: ${(err as Error).message}`);
        failed++;
      }
      // Each lead can fire several Bitrix REST calls (assign, history, notify).
      // A queue of many leads processed back-to-back with no spacing is exactly
      // what trips Bitrix's QUERY_LIMIT_EXCEEDED — this paces it out.
      await this.sleep(500);
    }

    this.logger.log(`Cron done — processed: ${processed}, skipped: ${skipped}, failed: ${failed}`);
    return { processed, skipped, failed };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ─── Stale-lead recycling — called by CronService once an hour ────────────
  // Leads sitting untouched (STATUS_ID unchanged, per MOVED_TIME) in the Dead
  // or Junk Lead stage for the configured number of days get moved back to
  // "New Lead" and re-enter the normal pipeline — self-created/source/
  // duplicate/business-hours checks, round-robin assignment, SLA rotation,
  // notifications — exactly as if they'd just arrived fresh. Deliberately
  // scoped to DEAD_LEAD_STATUS_ID/JUNK_LEAD_STATUS_ID only — never touches
  // STATUS_ID=JUNK ("Duplicate"), which the auto-merge feature sets on a
  // lead it deliberately closed; recycling that one back to New would
  // silently undo the merge a week later.

  // force=true (the manual trigger endpoint) bypasses the frequency gate only
  // — RECYCLE_ENABLED and WORKFLOW_ENABLED still apply, since those mean
  // "don't do this at all," not "don't do this yet."
  async recycleStaleLeads(force = false): Promise<{ deadRecycled: number; junkRecycled: number; skipped?: boolean }> {
    const settings = await this.getSettings();
    if (settings.WORKFLOW_ENABLED !== 'true') {
      this.logger.log('Stale-lead recycle skipped — workflow engine is paused');
      return { deadRecycled: 0, junkRecycled: 0, skipped: true };
    }
    if (settings.RECYCLE_ENABLED !== 'true') {
      this.logger.log('Stale-lead recycle skipped — RECYCLE_ENABLED is off');
      return { deadRecycled: 0, junkRecycled: 0, skipped: true };
    }

    if (!force) {
      const frequencyHours = parseInt(settings.RECYCLE_FREQUENCY_HOURS || '24', 10);
      const lastRunAt = settings.RECYCLE_LAST_RUN_AT ? new Date(settings.RECYCLE_LAST_RUN_AT) : null;
      if (lastRunAt) {
        const hoursSinceLastRun = (Date.now() - lastRunAt.getTime()) / 3600000;
        if (hoursSinceLastRun < frequencyHours) {
          return { deadRecycled: 0, junkRecycled: 0, skipped: true };
        }
      }
    }

    const creds = this.getWebhookCreds();

    const deadStatus = settings.DEAD_LEAD_STATUS_ID || '';
    const deadDays = parseInt(settings.DEAD_LEAD_RECYCLE_DAYS || '30', 10);
    const deadLimit = parseInt(settings.DEAD_LEAD_RECYCLE_LIMIT || '75', 10);
    const deadRecycled = deadStatus
      ? await this.recycleLeadsInStatus(deadStatus, deadDays, deadLimit, settings, creds)
      : 0;

    const junkStatus = settings.JUNK_LEAD_STATUS_ID || '';
    const junkDays = parseInt(settings.JUNK_LEAD_RECYCLE_DAYS || '7', 10);
    const junkLimit = parseInt(settings.JUNK_LEAD_RECYCLE_LIMIT || '75', 10);
    const junkRecycled = junkStatus
      ? await this.recycleLeadsInStatus(junkStatus, junkDays, junkLimit, settings, creds)
      : 0;

    await this.updateSetting('RECYCLE_LAST_RUN_AT', new Date().toISOString());
    return { deadRecycled, junkRecycled };
  }

  // Bulk-fetches leads in `fromStatus` whose MOVED_TIME is older than `days`,
  // using the >ID-cursor + start=-1 pagination pattern (disables Bitrix's
  // slow `total` calculation, per Bitrix's own "Retrieve Large Volumes of
  // Data" guidance) rather than plain start/50 paging. Stops once `limit` has
  // been recycled this run — dumping an entire large backlog on agents in one
  // hour would be its own problem. Nothing is lost by stopping early: a
  // recycled lead's STATUS_ID is no longer `fromStatus`, so it drops out of
  // this same query on its own; whatever's left over just still matches next
  // hour, with no cursor/offset bookkeeping needed across runs.
  private async recycleLeadsInStatus(
    fromStatus: string, days: number, limit: number, settings: Record<string, string>, creds: BitrixCreds,
  ): Promise<number> {
    const cutoffIso = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
    let recycled = 0;
    let lastId = '0';

    while (recycled < limit) {
      const params = new URLSearchParams();
      params.append('filter[STATUS_ID]', fromStatus);
      params.append('filter[<MOVED_TIME]', cutoffIso);
      params.append('filter[>ID]', lastId);
      params.append('order[ID]', 'ASC');
      params.append('select[]', 'ID');
      params.append('start', '-1');

      let rows: any[] = [];
      try {
        const sep = this.bitrixUrl('crm.lead.list', creds).includes('?') ? '&' : '?';
        const res = await fetch(`${this.bitrixUrl('crm.lead.list', creds)}${sep}${params.toString()}`);
        const data = (await res.json()) as any;
        if (data.error) {
          this.logger.warn(`recycleLeadsInStatus(${fromStatus}) list failed: ${data.error_description || data.error}`);
          break;
        }
        rows = data.result || [];
      } catch (err) {
        this.logger.error(`recycleLeadsInStatus(${fromStatus}) list failed: ${(err as Error).message}`);
        break;
      }
      if (rows.length === 0) break;

      for (const row of rows) {
        if (recycled >= limit) break;
        const leadId = String(row.ID);
        lastId = leadId;
        try {
          await this.recycleOneLead(leadId, fromStatus, days, settings, creds);
          recycled++;
        } catch (err) {
          this.logger.error(`recycleLeadsInStatus(${fromStatus}): failed to recycle #${leadId}: ${(err as Error).message}`);
        }
        // Each lead fires several Bitrix calls (status update, comment, then the
        // full assignment pipeline) — same throttling reasoning as the SLA sweep.
        await this.sleep(500);
      }
      // No "rows.length < N" early-exit here on purpose — that would assume a
      // specific per-call page size, which isn't guaranteed to be 50 for every
      // method/portal. The >ID cursor always advances past whatever was just
      // processed, so the only reliable end-of-data signal is an empty page
      // (the `rows.length === 0` check above), regardless of the real page size.
    }
    if (recycled >= limit) {
      this.logger.log(`recycleLeadsInStatus(${fromStatus}): hit the ${limit}-per-run cap — remainder will continue next hour`);
    }
    return recycled;
  }

  private async recycleOneLead(
    leadId: string, fromStatus: string, days: number, settings: Record<string, string>, creds: BitrixCreds,
  ): Promise<void> {
    const newStatus = settings.NEW_LEAD_STATUS_ID || 'NEW';
    await this.updateLeadStatus(leadId, newStatus, creds);
    await this.addTimelineComment(
      leadId,
      `Auto-recycled back to "New Lead" — sat in this stage for ${days}+ days with no activity.`,
      creds,
    );
    this.logger.log(`Lead #${leadId} recycled from status "${fromStatus}" (${days}+ days stale) → "${newStatus}"`);
    // isRecycle bypasses the "already assigned" idempotency guard — a lead
    // sitting stale for weeks/months necessarily already has an old
    // AssignmentLog row, which is expected here, not a retry to ignore.
    // Everything else runs exactly like a fresh lead: self-created/source/
    // duplicate/business-hours checks, then round-robin + SLA rotation start.
    await this.processLeadAssignment(leadId, undefined, creds, false, { isRecycle: true });
  }

  // ─── SLA rotation sweep — called by CronService every couple of minutes ────
  // For every lead still actively rotating: close it out if it silently caught
  // up to the current stage already (belt-and-suspenders alongside the webhook),
  // otherwise reassign once SLA_MINUTES of business time have elapsed with no
  // movement. Walks the *live* team roster each time, so adding/removing an
  // agent in the frontend takes effect on the very next tick.

  async getActiveRotations() {
    return this.leadRotation.findMany({ where: { status: 'active' }, orderBy: { assigned_at: 'asc' } });
  }

  async sweepRotationTimeouts(): Promise<{ checked: number; rotated: number; escalated: number }> {
    const settings = await this.getSettings();
    if (settings.WORKFLOW_ENABLED !== 'true') return { checked: 0, rotated: 0, escalated: 0 };

    const schedule = this.getBusinessHoursSchedule(settings);
    const slaMinutes = parseInt(settings.SLA_MINUTES || '60', 10);
    const maxLaps = parseInt(settings.MAX_ROTATION_LAPS || '2', 10);
    const creds = this.getWebhookCreds();

    const rotations = await this.getActiveRotations();
    let rotated = 0, escalated = 0;

    for (const row of rotations) {
      const elapsed = this.businessMinutesElapsed(row.assigned_at, new Date(), schedule);
      if (elapsed < slaMinutes) continue;

      try {
        const advanced = await this.advanceRotation(row, settings, schedule, slaMinutes, maxLaps, creds);
        if (advanced === 'escalated') escalated++;
        else if (advanced === 'rotated') rotated++;
        // Same reasoning as processAllLateLeads: several Bitrix calls per
        // reassignment, and a batch of leads all timing out in the same tick
        // (e.g. right after a low SLA_MINUTES test setting) must not fire them
        // all in one burst.
        if (advanced !== 'skipped') await this.sleep(500);
      } catch (err) {
        this.logger.error(`sweepRotationTimeouts: failed to advance lead #${row.lead_id}: ${(err as Error).message}`);
      }
    }

    if (rotated || escalated) {
      this.logger.log(`SLA sweep — checked: ${rotations.length}, rotated: ${rotated}, escalated: ${escalated}`);
    }
    return { checked: rotations.length, rotated, escalated };
  }

  private async advanceRotation(
    row: any, settings: Record<string, string>, schedule: Record<string, { start: string; end: string }>,
    slaMinutes: number, maxLaps: number, creds: BitrixCreds,
  ): Promise<'rotated' | 'escalated' | 'skipped'> {
    // The stage may have changed since the last webhook without us catching it
    // (a missed/late delivery) — double-check directly against Bitrix before
    // reassigning out from under an agent who already did the work.
    const lead = await this.fetchLeadDetails(row.lead_id, creds);
    const newStatus = settings.NEW_LEAD_STATUS_ID || 'NEW';
    if (lead.statusId && lead.statusId !== newStatus) {
      await this.leadRotation.update({ where: { id: row.id }, data: { status: 'done' } });
      return 'skipped';
    }

    const deptFilter: string[] = (() => { try { return JSON.parse(settings.ELIGIBLE_DEPT_IDS || '[]'); } catch { return []; } })();
    const roster = await this.agent.findMany({
      where: { team: row.team, is_active: true, ...(deptFilter.length > 0 ? { department_id: { in: deptFilter } } : {}) },
      orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
    });

    if (roster.length === 0) {
      await this.escalateToManager(row.lead_id, lead, row.team, 'no active agents left in team', settings, creds, 'missed');
      return 'escalated';
    }

    let tried: string[] = [];
    try { tried = JSON.parse(row.tried_agent_ids || '[]'); } catch {}

    const currentIdx = roster.findIndex((a) => a.id === row.current_agent_id);
    const orderedFromCurrent = currentIdx >= 0
      ? [...roster.slice(currentIdx + 1), ...roster.slice(0, currentIdx + 1)]
      : roster;
    const next = orderedFromCurrent.find((a) => !tried.includes(a.id));

    if (next) {
      tried.push(next.id);
      await this.leadRotation.update({ where: { id: row.id }, data: { tried_agent_ids: JSON.stringify(tried) } });
      await this.assignToAgent(row.lead_id, lead, next, row.team, slaMinutes, settings, creds, `SLA timeout (lap ${row.lap_number})`, row.lap_number, 'missed');
      return 'rotated';
    }

    // Every active agent has had a turn this lap.
    if (row.lap_number < maxLaps) {
      const first = roster[0];
      await this.assignToAgent(row.lead_id, lead, first, row.team, slaMinutes, settings, creds, 'starting next rotation lap', row.lap_number + 1, 'missed');
      return 'rotated';
    }

    await this.escalateToManager(row.lead_id, lead, row.team, `exhausted ${maxLaps} full rotation laps with no action`, settings, creds, 'missed');
    return 'escalated';
  }

  // ─── Dashboard Status (combined snapshot for the UI) ────────────────────────

  async getWorkflowStatus(): Promise<any> {
    const settings = await this.getSettings();
    const team = settings.LEAD_ASSIGNMENT_TEAM || 'B2C';
    const engineEnabled = settings.WORKFLOW_ENABLED !== 'false';

    // Get agents for the active team
    let deptFilter: string[] = [];
    try { deptFilter = JSON.parse(settings.ELIGIBLE_DEPT_IDS || '[]'); } catch {}
    const agents = await this.agent.findMany({
      where: {
        team,
        is_active: true,
        ...(deptFilter.length > 0 ? { department_id: { in: deptFilter } } : {}),
      },
      orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
    });

    const totalAgents = await this.agent.count({ where: { team } });

    // Find last assignment and next agent
    const lastLog = await this.assignmentLog.findFirst({
      where: { team },
      orderBy: { assigned_at: 'desc' },
    });

    let lastAssigned: any = null;
    let nextAgent: any = null;
    if (lastLog) {
      lastAssigned = { id: lastLog.agent_id, name: lastLog.agent_name };
      const lastIdx = agents.findIndex(a => a.id === lastLog.agent_id);
      const nextIdx = (lastIdx + 1) % agents.length;
      if (agents[nextIdx]) {
        nextAgent = { id: agents[nextIdx].id, name: agents[nextIdx].name };
      }
    } else if (agents.length > 0) {
      nextAgent = { id: agents[0].id, name: agents[0].name };
    }

    // Queue depth
    const queueDepth = await this.lateLead.count({ where: { processed: false } });

    // Assigned today count
    const midnight = this.getPKTMidnight();
    const assignedToday = await this.assignmentLog.count({ where: { assigned_at: { gte: midnight } } });

    // Per-agent workload today
    const todayLogs = await this.assignmentLog.findMany({ where: { assigned_at: { gte: midnight } } });
    const workloadMap: Record<string, { name: string; count: number }> = {};
    for (const log of todayLogs) {
      if (!workloadMap[log.agent_id]) workloadMap[log.agent_id] = { name: log.agent_name, count: 0 };
      workloadMap[log.agent_id].count++;
    }
    const agentWorkload = Object.values(workloadMap).sort((a, b) => b.count - a.count);

    // Dynamic teams list
    const allAgents = await this.agent.findMany({ select: { team: true } });
    const teams = [...new Set(allAgents.map(a => a.team))].sort();

    return {
      engineEnabled,
      assignmentTeam: team,
      withinBusinessHours: this.isWithinBusinessHours(settings),
      lastAssigned,
      nextAgent,
      activeAgentCount: agents.length,
      totalAgentCount: totalAgents,
      queueDepth,
      assignedToday,
      agentWorkload,
      teams,
      agents: agents.map(a => ({ id: a.id, name: a.name, team: a.team, is_active: a.is_active })),
    };
  }

  // ─── Dynamic Teams ──────────────────────────────────────────────────────────

  async getTeams(): Promise<string[]> {
    const allAgents = await this.agent.findMany({ select: { team: true } });
    return [...new Set(allAgents.map(a => a.team))].sort();
  }

  async clearQueue() {
    const result = await this.lateLead.updateMany({
      where: { processed: false },
      data: { processed: true, processed_at: new Date() }
    });
    this.logger.log(`Cleared ${result.count} leads from the queue without assigning them.`);
    return { success: true, clearedCount: result.count };
  }
}
