import { repository } from "../db/repository";
import { localDateKey } from "../utils/format";

const DAILY_BACKUP_HOUR = 20;

const backupIsDue = (now: Date) => now.getHours() >= DAILY_BACKUP_HOUR;

const millisecondsUntilNextBackupWindow = (now: Date) => {
  const next = new Date(now);
  if (backupIsDue(now)) next.setDate(next.getDate() + 1);
  next.setHours(DAILY_BACKUP_HOUR, 0, 0, 0);
  return Math.max(1_000, next.getTime() - now.getTime());
};

/**
 * Creates one local backup per calendar day after 20:00. The visibility and
 * focus listeners cover phones that suspend timers while the app is closed.
 */
export function startAutomaticBackups() {
  let active = true;
  let timer: number | undefined;

  const attemptBackup = async () => {
    if (!active) return;
    const now = new Date();
    if (!backupIsDue(now)) return;
    try {
      await repository.ensureDailyBackup(localDateKey(now));
    } catch {
      // The next visibility/focus event retries without interrupting sales.
    }
  };

  const schedule = () => {
    if (!active) return;
    timer = window.setTimeout(() => {
      void attemptBackup().finally(schedule);
    }, millisecondsUntilNextBackupWindow(new Date()));
  };

  const wake = () => {
    if (document.visibilityState === "visible") void attemptBackup();
  };

  window.addEventListener("focus", wake);
  document.addEventListener("visibilitychange", wake);
  void attemptBackup().finally(schedule);

  return () => {
    active = false;
    if (timer !== undefined) window.clearTimeout(timer);
    window.removeEventListener("focus", wake);
    document.removeEventListener("visibilitychange", wake);
  };
}
