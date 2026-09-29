import { repository } from "../db/repository";
import { localDateKey } from "../utils/format";

export type BackupReminderFrequency = "off" | "daily" | "weekly";

export interface BackupReminderSettings {
  frequency: BackupReminderFrequency;
  weekday: number;
  time: string;
}

export interface BackupReminderDue {
  occurrenceKey: string;
  scheduledAt: string;
}

export const DEFAULT_BACKUP_REMINDER_SETTINGS: BackupReminderSettings = {
  frequency: "weekly",
  weekday: 0,
  time: "12:00",
};

const SETTINGS_KEY = "backup.reminder.settings";
const LAST_SHOWN_KEY = "backup.reminder.lastShown";
const LAST_EXPORTED_KEY = "backup.lastExportedAt";

const isValidTime = (value: unknown): value is string => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

const normalizeSettings = (value: unknown): BackupReminderSettings => {
  const candidate = value as Partial<BackupReminderSettings> | null;
  const frequency = candidate?.frequency === "daily" || candidate?.frequency === "weekly" || candidate?.frequency === "off" ? candidate.frequency : DEFAULT_BACKUP_REMINDER_SETTINGS.frequency;
  const weekday = Number.isInteger(candidate?.weekday) && candidate!.weekday! >= 0 && candidate!.weekday! <= 6 ? candidate!.weekday! : DEFAULT_BACKUP_REMINDER_SETTINGS.weekday;
  const time = isValidTime(candidate?.time) ? candidate.time : DEFAULT_BACKUP_REMINDER_SETTINGS.time;
  return { frequency, weekday, time };
};

const timeParts = (value: string) => {
  const [hours, minutes] = value.split(":").map(Number);
  return { hours, minutes };
};

const occurrenceFor = (settings: BackupReminderSettings, now: Date): BackupReminderDue | null => {
  if (settings.frequency === "off") return null;
  const candidateDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const { hours, minutes } = timeParts(settings.time);
  if (settings.frequency === "weekly") {
    const daysSinceTarget = (candidateDate.getDay() - settings.weekday + 7) % 7;
    candidateDate.setDate(candidateDate.getDate() - daysSinceTarget);
  }
  let scheduled = new Date(candidateDate.getFullYear(), candidateDate.getMonth(), candidateDate.getDate(), hours, minutes, 0, 0);
  if (scheduled > now) {
    if (settings.frequency === "daily") candidateDate.setDate(candidateDate.getDate() - 1);
    else candidateDate.setDate(candidateDate.getDate() - 7);
    scheduled = new Date(candidateDate.getFullYear(), candidateDate.getMonth(), candidateDate.getDate(), hours, minutes, 0, 0);
  }
  const occurrenceKey = `${settings.frequency}:${localDateKey(candidateDate)}:${settings.time}`;
  return { occurrenceKey, scheduledAt: scheduled.toISOString() };
};

export async function loadBackupReminderSettings() {
  return normalizeSettings(await repository.getSetting(SETTINGS_KEY, DEFAULT_BACKUP_REMINDER_SETTINGS));
}

export async function saveBackupReminderSettings(settings: BackupReminderSettings) {
  await repository.setSetting(SETTINGS_KEY, normalizeSettings(settings));
}

export async function recordBackupExport() {
  await repository.setSetting(LAST_EXPORTED_KEY, new Date().toISOString());
}

export async function checkBackupReminder(now = new Date()): Promise<BackupReminderDue | null> {
  const settings = await loadBackupReminderSettings();
  const due = occurrenceFor(settings, now);
  if (!due) return null;

  const lastShown = await repository.getSetting<string>(LAST_SHOWN_KEY, "");
  if (lastShown === due.occurrenceKey) return null;

  const lastExportedAt = await repository.getSetting<string>(LAST_EXPORTED_KEY, "");
  if (lastExportedAt && Number.isFinite(Date.parse(lastExportedAt)) && new Date(lastExportedAt) >= new Date(due.scheduledAt)) {
    await repository.setSetting(LAST_SHOWN_KEY, due.occurrenceKey);
    return null;
  }

  await repository.setSetting(LAST_SHOWN_KEY, due.occurrenceKey);
  return due;
}

export const backupReminderWeekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;
