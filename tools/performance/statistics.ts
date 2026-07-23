export interface DistributionSummary {
  count: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p75Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  standardDeviationMs: number;
}

export interface TrialSummary {
  latency: DistributionSummary;
  elapsedMs: number;
  throughputPerSecond: number;
}

export interface AggregateSummary {
  medianP95Ms: number;
  medianP99Ms: number;
  medianThroughputPerSecond: number;
  p95CoefficientOfVariation: number;
  trials: TrialSummary[];
}

export interface PerformanceBudget {
  maxMedianP95Ms: number;
  maxMedianP99Ms: number;
  maxP95CoefficientOfVariation: number;
  maxRegressionPercent: number;
}

export interface BudgetEvaluation {
  passed: boolean;
  failures: string[];
  p95RegressionPercent: number | null;
}

function finiteSamples(samples: readonly number[]): number[] {
  if (samples.length === 0) throw new Error('performance samples are empty');
  if (samples.some((sample) => !Number.isFinite(sample) || sample < 0))
    throw new Error('performance samples must be finite and non-negative');
  return [...samples].sort((left, right) => left - right);
}

export function percentile(
  samples: readonly number[],
  quantile: number,
): number {
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1)
    throw new Error('quantile must be between zero and one');
  const sorted = finiteSamples(samples);
  const position = (sorted.length - 1) * quantile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  if (lower === undefined || upper === undefined)
    throw new Error('performance percentile could not be calculated');
  return lower + (upper - lower) * (position - lowerIndex);
}

export function summarizeDistribution(
  samples: readonly number[],
): DistributionSummary {
  const sorted = finiteSamples(samples);
  const mean = sorted.reduce((sum, sample) => sum + sample, 0) / sorted.length;
  const variance =
    sorted.reduce((sum, sample) => sum + (sample - mean) ** 2, 0) /
    sorted.length;
  return {
    count: sorted.length,
    minMs: sorted[0] ?? 0,
    maxMs: sorted.at(-1) ?? 0,
    meanMs: mean,
    p50Ms: percentile(sorted, 0.5),
    p75Ms: percentile(sorted, 0.75),
    p90Ms: percentile(sorted, 0.9),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    standardDeviationMs: Math.sqrt(variance),
  };
}

export function roundDistribution(
  summary: DistributionSummary,
  fractionDigits = 4,
): DistributionSummary {
  const rounded = (value: number) => Number(value.toFixed(fractionDigits));
  return {
    count: summary.count,
    minMs: rounded(summary.minMs),
    maxMs: rounded(summary.maxMs),
    meanMs: rounded(summary.meanMs),
    p50Ms: rounded(summary.p50Ms),
    p75Ms: rounded(summary.p75Ms),
    p90Ms: rounded(summary.p90Ms),
    p95Ms: rounded(summary.p95Ms),
    p99Ms: rounded(summary.p99Ms),
    standardDeviationMs: rounded(summary.standardDeviationMs),
  };
}

export function aggregateTrials(
  trials: readonly TrialSummary[],
): AggregateSummary {
  if (trials.length < 5)
    throw new Error('performance policy requires at least five trials');
  const p95Values = trials.map((trial) => trial.latency.p95Ms);
  const p95Mean =
    p95Values.reduce((sum, value) => sum + value, 0) / p95Values.length;
  const p95Variance =
    p95Values.reduce((sum, value) => sum + (value - p95Mean) ** 2, 0) /
    p95Values.length;
  return {
    medianP95Ms: percentile(p95Values, 0.5),
    medianP99Ms: percentile(
      trials.map((trial) => trial.latency.p99Ms),
      0.5,
    ),
    medianThroughputPerSecond: percentile(
      trials.map((trial) => trial.throughputPerSecond),
      0.5,
    ),
    p95CoefficientOfVariation:
      p95Mean === 0 ? 0 : Math.sqrt(p95Variance) / p95Mean,
    trials: [...trials],
  };
}

export function evaluateBudget(
  result: AggregateSummary,
  budget: PerformanceBudget,
  baseline?: AggregateSummary,
): BudgetEvaluation {
  const failures: string[] = [];
  if (result.medianP95Ms > budget.maxMedianP95Ms)
    failures.push('median_p95_exceeded');
  if (result.medianP99Ms > budget.maxMedianP99Ms)
    failures.push('median_p99_exceeded');
  if (result.p95CoefficientOfVariation > budget.maxP95CoefficientOfVariation)
    failures.push('p95_variance_exceeded');
  const p95RegressionPercent = baseline
    ? baseline.medianP95Ms === 0
      ? result.medianP95Ms === 0
        ? 0
        : Number.POSITIVE_INFINITY
      : ((result.medianP95Ms - baseline.medianP95Ms) / baseline.medianP95Ms) *
        100
    : null;
  if (
    p95RegressionPercent !== null &&
    p95RegressionPercent > budget.maxRegressionPercent
  )
    failures.push('p95_regression_exceeded');
  return { passed: failures.length === 0, failures, p95RegressionPercent };
}
