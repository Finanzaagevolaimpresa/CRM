import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
/** Never serialize browser traces, requests, provider query strings or error messages. */
export default class RedactedReporter implements Reporter {
  private rows: { test: string; status: string; failedAt: string[] }[] = [];
  onTestEnd(test: TestCase, result: TestResult) {
    const failedAt = result.errors.flatMap(error =>
      (error.stack ?? '').split('\n').filter(line => /callback\.spec\.ts:\d+:\d+/.test(line))
        .map(line => line.match(/callback\.spec\.ts:\d+:\d+/)![0]));
    this.rows.push({ test: test.title, status: result.status, failedAt });
    console.log(JSON.stringify(this.rows.at(-1)));
  }
  onEnd(result: FullResult) {
    writeFileSync(join(process.env.FLOW_EVIDENCE!, 'browser-result.json'), JSON.stringify({ status: result.status, tests: this.rows }, null, 2));
  }
}
