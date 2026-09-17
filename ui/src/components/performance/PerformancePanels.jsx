
// Dashboard → Overview and Revenue.
//
// Every figure here comes from /api/xero-reports/performance, which is composed
// from the Profit & Loss and Budget Summary reports. Nothing is modelled,
// estimated or carried over from a spreadsheet: a metric Xero cannot answer
// renders as an em dash with the reason, never as a zero.
//
// The backend returns all twelve months whole, so the month-range control below
// re-slices in place without another request.
export { PRESETS, MonthRange } from './MonthRange';
export { BarList, GroupedMonthlyBars } from './charts';
export { VarianceReasons, AnalysisPanel, ExecutiveActionChecklist, NarrativeCard } from './AnalysisPanel';
export { OverviewPanel } from './OverviewPanel';
export { RevenuePanel } from './RevenuePanel';
export { ProfitabilityPanel } from './ProfitabilityPanel';
export { CashFlowPanel } from './CashFlowPanel';
