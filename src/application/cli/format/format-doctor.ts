/**
 * Plain-text formatter for the doctor report. Each row reads as
 * `[STATUS] name — message`, matching the legacy output style so users
 * see the same shape across versions.
 */
import * as c from 'colorette';

import type { DoctorCheckResult, DoctorCheckStatus, DoctorReport } from '../../doctor/run-doctor.ts';

const STATUS_TAG: Record<DoctorCheckStatus, string> = {
  pass: c.green('PASS'),
  warn: c.yellow('WARN'),
  fail: c.red('FAIL'),
  skip: c.gray('SKIP'),
};

export function formatCheckRow(check: DoctorCheckResult): string {
  const tag = STATUS_TAG[check.status];
  const message = check.message ? ` — ${check.message}` : '';
  return `  [${tag}] ${check.name}${message}`;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(c.bold('Doctor — environment health'));
  lines.push('');
  for (const check of report.checks) {
    lines.push(formatCheckRow(check));
  }
  lines.push('');
  switch (report.status) {
    case 'ok':
      lines.push(c.green('Overall: OK'));
      break;
    case 'warn':
      lines.push(c.yellow('Overall: WARN — review warnings above'));
      break;
    case 'fail':
      lines.push(c.red('Overall: FAIL — fix errors above'));
      break;
  }
  return lines.join('\n');
}
