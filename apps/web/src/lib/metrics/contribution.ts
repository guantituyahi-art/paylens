export type CountGroup = {
  key: string;
  numerator: number;
  denominator: number;
};

export type Contribution = {
  within: number;
  mix: number;
  total: number;
};

export function groupContribution(
  current: CountGroup,
  prior: CountGroup | undefined,
  currentTotal: number,
  priorTotal: number,
): Contribution {
  const priorNumerator = prior?.numerator ?? 0;
  const priorDenominator = prior?.denominator ?? 0;
  const currentShare = currentTotal === 0 ? 0 : current.denominator / currentTotal;
  const priorShare = priorTotal === 0 ? 0 : priorDenominator / priorTotal;
  const currentRate = current.denominator === 0 ? 0 : current.numerator / current.denominator;
  const priorRate = priorDenominator === 0 ? 0 : priorNumerator / priorDenominator;
  const within = priorShare * (currentRate - priorRate);
  const mix = (currentShare - priorShare) * currentRate;
  return { within, mix, total: within + mix };
}

export function sumContributions(rows: Contribution[]) {
  return rows.reduce((sum, row) => sum + row.total, 0);
}
