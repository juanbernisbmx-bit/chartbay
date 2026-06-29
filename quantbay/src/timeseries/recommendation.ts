import type { TimeSeriesAnalysisResult } from './types';

function isStationaryADF(result: TimeSeriesAnalysisResult): boolean {
  return result.adf.available && result.adf.statistic <= result.adf.criticalValues.fivePercent;
}

function isNonStationaryADF(result: TimeSeriesAnalysisResult): boolean {
  return result.adf.available && result.adf.statistic > result.adf.criticalValues.tenPercent;
}

function hasPositiveValues(result: TimeSeriesAnalysisResult): boolean {
  return result.selectedTransformation.points.length > 0 &&
    result.selectedTransformation.points.every(point => point.value > 0);
}

function hasLjungBoxAutocorrelation(result: TimeSeriesAnalysisResult): boolean {
  return result.acf.ljungBox.some(row => row.pValue < 0.05);
}

function hasLjungBoxNoAutocorrelation(result: TimeSeriesAnalysisResult): boolean {
  return result.acf.ljungBox.length > 0 && result.acf.ljungBox.every(row => row.pValue >= 0.05);
}

function hasEarlyPACFSpike(result: TimeSeriesAnalysisResult): boolean {
  return result.acf.pacf.some(row => row.lag <= 3 && row.outsideThreshold);
}

function diagnosticsUnavailable(result: TimeSeriesAnalysisResult): boolean {
  return !result.adf.available || result.acf.rows.length === 0 || result.acf.ljungBox.length === 0;
}

export function buildTimeSeriesRecommendation(result: TimeSeriesAnalysisResult): string {
  const notes: string[] = [];

  if (diagnosticsUnavailable(result)) {
    notes.push('Educational guidance: review data quality and sample size before interpreting these diagnostics. Very small samples, constant series, or invalid values can make ADF/ACF-style checks unavailable.');
    return notes.join(' ');
  }

  if (isNonStationaryADF(result)) {
    const transformSuggestion = hasPositiveValues(result)
      ? 'Try a first difference; if all values are positive, a log difference can also be compared as an educational transformation.'
      : 'Try a first difference as an educational transformation before re-reading the diagnostics.';
    notes.push(`Educational guidance: ADF does not strongly reject a unit root here. ${transformSuggestion}`);
  } else if (isStationaryADF(result) && hasLjungBoxAutocorrelation(result)) {
    notes.push('Educational guidance: ADF suggests stationarity, but Ljung-Box still flags autocorrelation at one or more tested lags, so AR or lag structure may be worth exploring.');
  } else if (isStationaryADF(result) && hasLjungBoxNoAutocorrelation(result)) {
    notes.push('Educational guidance: these diagnostics show no strong evidence of a unit root or residual autocorrelation at the tested Ljung-Box lags.');
  } else {
    notes.push('Educational guidance: ADF is borderline in this view, so compare transformations and avoid relying on one diagnostic alone.');
  }

  if (hasEarlyPACFSpike(result)) {
    notes.push('Early PACF spikes may suggest autoregressive structure, but this view should not automatically select a model.');
  }

  return notes.join(' ');
}
