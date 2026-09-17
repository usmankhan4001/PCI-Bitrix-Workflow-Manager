import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { WorkflowService } from '../workflow/workflow.service';

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);
  // @Cron gives no protection against overlapping runs on its own — if a run
  // takes longer than the tick interval (easy once Bitrix starts throttling
  // requests), the next tick fires on top of it, and both process the same
  // stale rows concurrently. These flags make each job skip a tick rather
  // than double up.
  private processingLateLeads = false;
  private sweepingRotations = false;
  private recyclingStaleLeads = false;

  constructor(private readonly workflow: WorkflowService) {}

  /**
   * Runs every minute, checks if it is the start of today's business-hours
   * window (per the per-day BUSINESS_HOURS schedule). When it fires at exactly
   * that time it processes all queued off-hours leads.
   */
  @Cron('* * * * *') // every minute
  async maybeProcessLateLeads() {
    if (this.processingLateLeads) {
      this.logger.warn('Day-start cron tick skipped — previous run is still in progress');
      return;
    }
    const settings = await this.workflow.getSettings();

    // Check if we're in the 1-minute window at the start of today's business hours
    if (!this.isStartOfDay(settings)) return;

    const pending = await this.workflow.getLateLeads();
    if (pending.length === 0) return;

    this.processingLateLeads = true;
    try {
      this.logger.log(`⏰ Day-start cron triggered — ${pending.length} queued lead(s) to process`);
      const result = await this.workflow.processAllLateLeads();
      this.logger.log(`✅ Cron complete — processed: ${result.processed}, skipped: ${result.skipped}, failed: ${result.failed}`);
    } finally {
      this.processingLateLeads = false;
    }
  }

  private isStartOfDay(settings: Record<string, string>): boolean {
    const { day, hour, minute } = this.workflow.getPKTime();
    const schedule = this.workflow.getBusinessHoursSchedule(settings);
    const window = schedule[String(day)];
    if (!window) return false; // day is closed

    const [startH, startM] = window.start.split(':').map(Number);
    // Fire within the first minute of the configured start time
    return hour === startH && minute === startM;
  }

  /**
   * SLA rotation sweep — reassigns leads whose current agent has let the
   * 1-hour (business-time) window lapse without moving the lead out of "New
   * Lead". Runs every 2 minutes; cheap when idle since it only does local time
   * math unless a lead has actually timed out.
   */
  @Cron('*/2 * * * *')
  async sweepRotationTimeouts() {
    if (this.sweepingRotations) {
      this.logger.warn('SLA sweep tick skipped — previous run is still in progress');
      return;
    }
    this.sweepingRotations = true;
    try {
      const result = await this.workflow.sweepRotationTimeouts();
      if (result.rotated || result.escalated) {
        this.logger.log(`⏱️ SLA sweep — checked: ${result.checked}, rotated: ${result.rotated}, escalated: ${result.escalated}`);
      }
    } finally {
      this.sweepingRotations = false;
    }
  }

  /**
   * Stale-lead recycling — runs once an hour, on the hour. Leads sitting
   * untouched in the Dead Lead or Junk Lead stage past the configured number
   * of days get moved back to "New Lead" and re-enter the full pipeline
   * (round-robin, SLA rotation, notifications) as if freshly created.
   */
  @Cron('0 * * * *')
  async recycleStaleLeads() {
    if (this.recyclingStaleLeads) {
      this.logger.warn('Stale-lead recycle tick skipped — previous run is still in progress');
      return;
    }
    this.recyclingStaleLeads = true;
    try {
      const result = await this.workflow.recycleStaleLeads();
      if (result.deadRecycled || result.junkRecycled) {
        this.logger.log(`♻️ Stale-lead recycle — dead: ${result.deadRecycled}, junk: ${result.junkRecycled}`);
      }
    } finally {
      this.recyclingStaleLeads = false;
    }
  }
}
