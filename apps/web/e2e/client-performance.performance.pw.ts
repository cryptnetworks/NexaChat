import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance as nodePerformance } from 'node:perf_hooks';
import {
  expect,
  test,
  type BrowserContext,
  type CDPSession,
  type Page,
  type Route,
  type WebSocketRoute,
} from '@playwright/test';
import {
  collectPerformanceEnvironment,
  comparableEnvironmentKey,
} from '../../../tools/performance/environment.js';
import {
  roundDistribution,
  summarizeDistribution,
} from '../../../tools/performance/statistics.js';

const repetitions = 6;
const warmupRuns = 1;
const historyMessages = 100;
const insertedMessages = 100;
const updateCycles = 20;

const ids = {
  account: uuid(1),
  community: uuid(2),
  category: uuid(3),
  space: uuid(4),
};

const profile = {
  id: ids.account,
  username: 'performance-user',
  displayName: 'Performance User',
  avatar: null,
  createdAt: '2026-07-22T12:00:00.000Z',
  updatedAt: '2026-07-22T12:00:00.000Z',
  version: 1,
};

const account = { id: ids.account, displayName: profile.displayName };
const community = {
  id: ids.community,
  ownerId: ids.account,
  name: 'Performance community',
  archivedAt: null,
  version: 1,
};
const category = {
  id: ids.category,
  communityId: ids.community,
  name: 'General',
  position: 0,
  archivedAt: null,
  version: 1,
};
const space = {
  id: ids.space,
  communityId: ids.community,
  name: 'performance',
  kind: 'text',
  categoryId: ids.category,
  position: 0,
  archivedAt: null,
  slowModeSeconds: 0,
  version: 1,
};

interface BrowserSnapshot {
  documents: number;
  nodes: number;
  eventListeners: number;
  jsHeapUsedBytes: number;
  jsHeapTotalBytes: number;
  taskDurationMs: number;
  scriptDurationMs: number;
  layoutDurationMs: number;
  styleDurationMs: number;
  layoutCount: number;
  styleRecalculationCount: number;
  longTaskCount: number;
  longTaskDurationMs: number;
  layoutShiftScore: number;
}

interface BrowserRun {
  coldReadyMs: number;
  warmReadyMs: number;
  historyRenderMs: number;
  realtimeInsertMs: number;
  realtimeUpdateMs: number;
  beforeUpdates: BrowserSnapshot;
  afterUpdates: BrowserSnapshot;
}

interface ValueSummary {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  standardDeviation: number;
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}

function message(index: number, updateCycle = 0) {
  const createdAt = new Date(
    Date.parse('2026-07-22T12:00:00.000Z') + index * 1_000,
  ).toISOString();
  return {
    id: uuid(1_000 + index),
    spaceId: ids.space,
    authorId: ids.account,
    body:
      updateCycle === 0
        ? `performance message ${String(index)}`
        : `updated cycle ${String(updateCycle)} item ${String(index)}`,
    replyToId: null,
    idempotencyKey: `performance-${String(index)}`,
    createdAt,
    updatedAt:
      updateCycle === 0
        ? createdAt
        : new Date(Date.parse(createdAt) + updateCycle * 100_000).toISOString(),
    deletedAt: null,
    version: updateCycle + 1,
  };
}

async function fulfillJson(route: Route, json: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', json });
}

async function mockApplicationApi(context: BrowserContext) {
  const history = Array.from({ length: historyMessages }, (_, index) =>
    message(index + 1),
  );
  await context.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/v1/account' && request.method() === 'GET')
      await fulfillJson(route, profile);
    else if (path === '/v1/sessions' && request.method() === 'GET')
      await fulfillJson(route, []);
    else if (path === '/v1/dev/accounts')
      await fulfillJson(route, account, 201);
    else if (path === '/v1/communities')
      await fulfillJson(route, community, 201);
    else if (path.endsWith('/categories'))
      await fulfillJson(route, category, 201);
    else if (path.endsWith('/spaces')) await fulfillJson(route, space, 201);
    else if (path.endsWith('/messages') && request.method() === 'GET')
      await fulfillJson(route, { items: history, nextCursor: null });
    else await fulfillJson(route, { error: 'not_found' }, 404);
  });
}

async function instrument(page: Page) {
  await page.addInitScript(() => {
    const measurements = {
      longTaskCount: 0,
      longTaskDurationMs: 0,
      layoutShiftScore: 0,
    };
    Object.defineProperty(window, '__nexaPerformanceMeasurements', {
      value: measurements,
      configurable: false,
      enumerable: false,
      writable: false,
    });
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          measurements.longTaskCount += 1;
          measurements.longTaskDurationMs += entry.duration;
        }
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      // Unsupported metrics remain explicit zeros in the report.
    }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & {
            value?: number;
            hadRecentInput?: boolean;
          };
          if (!shift.hadRecentInput)
            measurements.layoutShiftScore += shift.value ?? 0;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {
      // Unsupported metrics remain explicit zeros in the report.
    }
  });
}

function metric(metrics: { name: string; value: number }[], name: string) {
  return metrics.find((entry) => entry.name === name)?.value ?? 0;
}

async function snapshot(page: Page, cdp: CDPSession): Promise<BrowserSnapshot> {
  const [performanceMetrics, dom, timeline] = await Promise.all([
    cdp.send('Performance.getMetrics'),
    cdp.send('Memory.getDOMCounters'),
    page.evaluate(() => {
      const value = (
        window as Window & {
          __nexaPerformanceMeasurements?: {
            longTaskCount: number;
            longTaskDurationMs: number;
            layoutShiftScore: number;
          };
        }
      ).__nexaPerformanceMeasurements;
      return (
        value ?? {
          longTaskCount: 0,
          longTaskDurationMs: 0,
          layoutShiftScore: 0,
        }
      );
    }),
  ]);
  const metrics = performanceMetrics.metrics;
  return {
    documents: dom.documents,
    nodes: dom.nodes,
    eventListeners: dom.jsEventListeners,
    jsHeapUsedBytes: metric(metrics, 'JSHeapUsedSize'),
    jsHeapTotalBytes: metric(metrics, 'JSHeapTotalSize'),
    taskDurationMs: metric(metrics, 'TaskDuration') * 1_000,
    scriptDurationMs: metric(metrics, 'ScriptDuration') * 1_000,
    layoutDurationMs: metric(metrics, 'LayoutDuration') * 1_000,
    styleDurationMs: metric(metrics, 'RecalcStyleDuration') * 1_000,
    layoutCount: metric(metrics, 'LayoutCount'),
    styleRecalculationCount: metric(metrics, 'RecalcStyleCount'),
    ...timeline,
  };
}

async function waitForAccount(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
}

test('records bounded production-client performance evidence', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const environment = await collectPerformanceEnvironment('production');
  const runs: BrowserRun[] = [];

  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const context = await browser.newContext({
      viewport: { width: 1_440, height: 900 },
    });
    await mockApplicationApi(context);
    let realtimeSocket: WebSocketRoute | undefined;
    let resolveRealtimeSocket: ((socket: WebSocketRoute) => void) | undefined;
    const realtimeSocketReady = new Promise<WebSocketRoute>((resolve) => {
      resolveRealtimeSocket = resolve;
    });
    await context.routeWebSocket('**/v1/realtime', (socket) => {
      realtimeSocket = socket;
      socket.onMessage(() => undefined);
      resolveRealtimeSocket?.(socket);
    });
    const page = await context.newPage();
    await instrument(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable', { timeDomain: 'timeTicks' });

    const coldStarted = nodePerformance.now();
    await page.goto('/');
    await waitForAccount(page);
    const coldReadyMs = nodePerformance.now() - coldStarted;

    const warmStarted = nodePerformance.now();
    await page.reload();
    await waitForAccount(page);
    const warmReadyMs = nodePerformance.now() - warmStarted;

    const historyStarted = nodePerformance.now();
    await page.getByRole('button', { name: 'Create the demo space' }).click();
    await expect(page.locator('.messages article')).toHaveCount(
      historyMessages,
    );
    const historyRenderMs = nodePerformance.now() - historyStarted;
    const socket = realtimeSocket ?? (await realtimeSocketReady);

    let sequence = 0;
    const sendDelivery = (index: number, updateCycle: number) => {
      sequence += 1;
      const payload = message(index, updateCycle);
      socket.send(
        JSON.stringify({
          version: 1,
          type: 'event',
          spaceId: ids.space,
          sequence,
          event: {
            version: 1,
            id: uuid(100_000 + sequence),
            type: updateCycle === 0 ? 'message.created' : 'message.updated',
            occurredAt: payload.updatedAt,
            correlationId: uuid(900_000 + sequence),
            payload: { message: payload },
          },
        }),
      );
    };

    const insertionStarted = nodePerformance.now();
    for (
      let index = historyMessages + 1;
      index <= historyMessages + insertedMessages;
      index += 1
    )
      sendDelivery(index, 0);
    await expect(page.locator('.messages article')).toHaveCount(
      historyMessages + insertedMessages,
    );
    const realtimeInsertMs = nodePerformance.now() - insertionStarted;
    const beforeUpdates = await snapshot(page, cdp);

    const updatesStarted = nodePerformance.now();
    for (let cycle = 1; cycle <= updateCycles; cycle += 1)
      for (
        let index = historyMessages + 1;
        index <= historyMessages + insertedMessages;
        index += 1
      )
        sendDelivery(index, cycle);
    await expect(
      page.getByText(
        `updated cycle ${String(updateCycles)} item ${String(historyMessages + insertedMessages)}`,
      ),
    ).toBeVisible();
    const realtimeUpdateMs = nodePerformance.now() - updatesStarted;
    await page.waitForTimeout(250);
    const afterUpdates = await snapshot(page, cdp);

    if (repetition >= warmupRuns)
      runs.push({
        coldReadyMs,
        warmReadyMs,
        historyRenderMs,
        realtimeInsertMs,
        realtimeUpdateMs,
        beforeUpdates,
        afterUpdates,
      });
    await context.close();
  }

  const summarize = (select: (run: BrowserRun) => number) =>
    roundDistribution(summarizeDistribution(runs.map(select)));
  const summarizeRetainedGrowth = (
    select: (run: BrowserRun) => number,
  ): ValueSummary => {
    const result = summarize((run) => Math.max(0, select(run)));
    return {
      count: result.count,
      min: result.minMs,
      max: result.maxMs,
      mean: result.meanMs,
      p50: result.p50Ms,
      p75: result.p75Ms,
      p90: result.p90Ms,
      p95: result.p95Ms,
      p99: result.p99Ms,
      standardDeviation: result.standardDeviationMs,
    };
  };
  const budget = {
    maxColdReadyP95Ms: 2_500,
    maxWarmReadyP95Ms: 1_500,
    maxHistoryRenderP95Ms: 750,
    maxRealtimeInsertP95Ms: 1_500,
    maxRealtimeUpdateP95Ms: 10_000,
    maxHeapGrowthBytes: 67_108_864,
    maxNodeGrowth: 500,
    maxEventListenerGrowth: 32,
    maxMainThreadTaskP95Ms: 5_000,
    maxLongTaskDurationMs: 5_000,
    maxLayoutShiftScore: 0.1,
  };
  const measurements = {
    coldReady: summarize((run) => run.coldReadyMs),
    warmReady: summarize((run) => run.warmReadyMs),
    historyRender: summarize((run) => run.historyRenderMs),
    realtimeInsert: summarize((run) => run.realtimeInsertMs),
    realtimeUpdate: summarize((run) => run.realtimeUpdateMs),
    heapGrowth: summarizeRetainedGrowth(
      (run) =>
        run.afterUpdates.jsHeapUsedBytes - run.beforeUpdates.jsHeapUsedBytes,
    ),
    nodeGrowth: summarizeRetainedGrowth(
      (run) => run.afterUpdates.nodes - run.beforeUpdates.nodes,
    ),
    eventListenerGrowth: summarizeRetainedGrowth(
      (run) =>
        run.afterUpdates.eventListeners - run.beforeUpdates.eventListeners,
    ),
    mainThreadTaskDuration: summarize(
      (run) =>
        run.afterUpdates.taskDurationMs - run.beforeUpdates.taskDurationMs,
    ),
    scriptDuration: summarize(
      (run) =>
        run.afterUpdates.scriptDurationMs - run.beforeUpdates.scriptDurationMs,
    ),
    layoutDuration: summarize(
      (run) =>
        run.afterUpdates.layoutDurationMs - run.beforeUpdates.layoutDurationMs,
    ),
    styleDuration: summarize(
      (run) =>
        run.afterUpdates.styleDurationMs - run.beforeUpdates.styleDurationMs,
    ),
    longTaskDuration: summarize((run) => run.afterUpdates.longTaskDurationMs),
    layoutShift: summarizeRetainedGrowth(
      (run) => run.afterUpdates.layoutShiftScore,
    ),
  };
  const p95 = (value: { p95Ms: number }) => value.p95Ms;
  const failures: string[] = [];
  if (p95(measurements.coldReady) > budget.maxColdReadyP95Ms)
    failures.push('cold_ready_p95_exceeded');
  if (p95(measurements.warmReady) > budget.maxWarmReadyP95Ms)
    failures.push('warm_ready_p95_exceeded');
  if (p95(measurements.historyRender) > budget.maxHistoryRenderP95Ms)
    failures.push('history_render_p95_exceeded');
  if (p95(measurements.realtimeInsert) > budget.maxRealtimeInsertP95Ms)
    failures.push('realtime_insert_p95_exceeded');
  if (p95(measurements.realtimeUpdate) > budget.maxRealtimeUpdateP95Ms)
    failures.push('realtime_update_p95_exceeded');
  if (measurements.heapGrowth.p95 > budget.maxHeapGrowthBytes)
    failures.push('heap_growth_exceeded');
  if (measurements.nodeGrowth.p95 > budget.maxNodeGrowth)
    failures.push('node_growth_exceeded');
  if (measurements.eventListenerGrowth.p95 > budget.maxEventListenerGrowth)
    failures.push('event_listener_growth_exceeded');
  if (p95(measurements.mainThreadTaskDuration) > budget.maxMainThreadTaskP95Ms)
    failures.push('main_thread_task_duration_exceeded');
  if (p95(measurements.longTaskDuration) > budget.maxLongTaskDurationMs)
    failures.push('long_task_duration_exceeded');
  if (measurements.layoutShift.p95 > budget.maxLayoutShiftScore)
    failures.push('layout_shift_exceeded');

  const report = {
    schemaVersion: 1,
    environmentKey: comparableEnvironmentKey(environment),
    environment: { ...environment, browser: browser.version() },
    workload: {
      repetitions: repetitions - warmupRuns,
      warmupRuns,
      viewport: { width: 1_440, height: 900 },
      buildMode: 'production',
      mockedNetwork: true,
      historyMessages,
      insertedMessages,
      updateCycles,
      updateEvents: insertedMessages * updateCycles,
    },
    budget,
    measurements,
    runs,
    failures,
    passed: failures.length === 0,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const outputPath = process.env.NEXA_BROWSER_RESULT_PATH;
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, { encoding: 'utf8', mode: 0o600 });
  }
  process.stdout.write(serialized);
  expect(failures).toEqual([]);
});
