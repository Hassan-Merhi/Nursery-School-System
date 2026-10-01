import { query } from "@/lib/db";

type DbRow=Record<string,any>;
export type AnalyticsMode="year"|"term"|"custom";
export type AnalyticsSearch={mode?:string;year?:string;term?:string;from?:string;to?:string};

export type AnalyticsTerm={
  id:string;sequence:number;name:string;startsOn:string;endsOn:string;status:string;
};
export type AnalyticsYear={
  id:string;name:string;startsOn:string;endsOn:string;status:string;terms:AnalyticsTerm[];
};
export type AnalyticsPeriod={
  mode:AnalyticsMode;from:string;to:string;today:string;
  selectedYearId:string|null;selectedTermId:string|null;
  years:AnalyticsYear[];
};

export type MonthlyFinancial={
  monthStart:string;periodStart:string;periodEnd:string;currency:string;
  income:number;expenses:number;expectedFees:number;collectedFees:number;
  collectionRate:number|null;activeStudents:number;
};
export type MonthlyStudents={
  monthStart:string;periodStart:string;periodEnd:string;openingActive:number;
  newEnrollments:number;withdrawals:number;closingActive:number;netChange:number;
  netGrowthRate:number|null;
};
export type FeeCollection={currency:string;expectedFees:number;collectedFees:number;collectionRate:number|null};
export type ExpenseTrend={
  monthStart:string;periodStart:string;periodEnd:string;currency:string;accountId:string;
  accountCode:string;accountName:string;monthlyAmount:number;periodAmount:number;
  periodExpenseTotal:number;sharePercent:number|null;priorPeriodAmount:number;
  changeAmount:number;changePercent:number|null;
};
export type PayrollTrend={
  monthStart:string;currency:string;baseSalary:number;allowances:number;bonuses:number;
  deductions:number;payrollExpense:number;advanceRepayments:number;netPay:number;employeeCount:number;
};
export type RentTrend={
  monthStart:string;currency:string;recognizedRentExpense:number;totalExpenses:number;totalIncome:number;
  rentPercentExpenses:number|null;rentPercentIncome:number|null;
};
export type CashTrend={
  monthStart:string;currency:string;externalInflow:number;externalOutflow:number;
  netExternalMovement:number;closingCash:number;closingBank:number;closingTotal:number;
};
export type FoodTrend={
  monthStart:string;currency:string;purchasedAmount:number;foodRevenue:number;usageCost:number;
  wasteCost:number;spoilageCost:number;correctionCost:number;otherCost:number;foodCost:number;
  contribution:number;contributionMargin:number|null;costAvailable:boolean;
};
export type TermComparison={
  termId:string;termSequence:number;termName:string;startsOn:string;endsOn:string;currency:string;
  activeStudents:number;expectedFees:number;collectedFees:number;outstandingReceivables:number;
  collectionRate:number|null;income:number;expenses:number;payrollExpense:number;rentExpense:number;
  foodRevenue:number;foodCost:number;foodContribution:number;netCashMovement:number;
};
export type YearComparison={
  metricKey:string;metricLabel:string;unit:"money"|"count"|"percent";currency:string|null;
  currentValue:number|null;priorValue:number|null;changeValue:number|null;changePercent:number|null;
  currentFrom:string;currentTo:string;priorFrom:string;priorTo:string;
};
export type PeriodSummary={
  currency:string;income:number;expenses:number;expectedFees:number;collectedFees:number;
  collectionRate:number|null;payrollExpense:number;rentExpense:number;foodRevenue:number;
  foodCost:number;foodContribution:number;netCashMovement:number;
};
export type AnalyticsBundle={
  summary:PeriodSummary[];monthly:MonthlyFinancial[];students:MonthlyStudents[];
  fees:FeeCollection[];expenses:ExpenseTrend[];payroll:PayrollTrend[];rent:RentTrend[];
  cash:CashTrend[];food:FoodTrend[];terms:TermComparison[];yearOverYear:YearComparison[];
};

const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;
function iso(value:unknown){
  if(value instanceof Date)return value.toISOString().slice(0,10);
  return String(value??"").slice(0,10);
}
function num(value:unknown){const n=Number(value??0);return Number.isFinite(n)?n:0;}
function nullableNum(value:unknown){if(value===null||value===undefined)return null;const n=Number(value);return Number.isFinite(n)?n:null;}

export async function resolveAnalyticsPeriod(search:AnalyticsSearch):Promise<AnalyticsPeriod>{
  const [clockResult,yearsResult]=await Promise.all([
    query<{today:string}>("select (now() at time zone sp.timezone)::date::text today from school_profile sp where sp.id=1"),
    query<DbRow>("select y.id,y.name,y.starts_on::text,y.ends_on::text,y.status, coalesce(json_agg(json_build_object('id',t.id,'sequence',t.sequence,'name',t.name,'startsOn',t.starts_on::text,'endsOn',t.ends_on::text,'status',t.status) order by t.sequence) filter(where t.id is not null),'[]') terms from school_year y left join school_term t on t.school_year_id=y.id group by y.id order by y.starts_on desc"),
  ]);
  const today=clockResult.rows[0]?.today??new Date().toISOString().slice(0,10);
  const years:AnalyticsYear[]=yearsResult.rows.map((row)=>({
    id:String(row.id),name:String(row.name),startsOn:iso(row.starts_on),endsOn:iso(row.ends_on),
    status:String(row.status),terms:(Array.isArray(row.terms)?row.terms:[]).map((term:DbRow)=>({
      id:String(term.id),sequence:num(term.sequence),name:String(term.name),
      startsOn:iso(term.startsOn),endsOn:iso(term.endsOn),status:String(term.status),
    })),
  }));

  const fallback=years.find((year)=>year.status==="current")
    ??years.find((year)=>year.startsOn<=today&&year.endsOn>=today)
    ??years[0]??null;
  const selectedYear=years.find((year)=>year.id===search.year)??fallback;
  const requestedMode:AnalyticsMode=search.mode==="term"||search.mode==="custom"?search.mode:"year";

  if(requestedMode==="custom"&&DATE_RE.test(search.from??"")&&DATE_RE.test(search.to??"")&&search.from!<=search.to!){
    return {mode:"custom",from:search.from!,to:search.to!,today,selectedYearId:selectedYear?.id??null,selectedTermId:null,years};
  }

  if(requestedMode==="term"&&selectedYear){
    const term=selectedYear.terms.find((item)=>item.id===search.term)??selectedYear.terms[0];
    if(term){
      const to=term.startsOn<=today&&today<term.endsOn?today:term.endsOn;
      return {mode:"term",from:term.startsOn,to,today,selectedYearId:selectedYear.id,selectedTermId:term.id,years};
    }
  }

  if(selectedYear){
    const to=selectedYear.startsOn<=today&&today<selectedYear.endsOn?today:selectedYear.endsOn;
    return {mode:"year",from:selectedYear.startsOn,to,today,selectedYearId:selectedYear.id,selectedTermId:null,years};
  }

  const monthStart=today.slice(0,8)+"01";
  return {mode:"custom",from:monthStart,to:today,today,selectedYearId:null,selectedTermId:null,years};
}

export async function loadAnalytics(period:AnalyticsPeriod):Promise<AnalyticsBundle>{
  const termQuery=period.selectedYearId
    ?query<DbRow>("select * from analytics_term_comparison($1::uuid)",[period.selectedYearId])
    :Promise.resolve({rows:[]} as {rows:DbRow[]});
  const [
    summaryResult,monthlyResult,studentsResult,feesResult,expensesResult,payrollResult,
    rentResult,cashResult,foodResult,termsResult,yoyResult,
  ]=await Promise.all([
    query<DbRow>("select * from analytics_period_summary($1::date,$2::date)",[period.from,period.to]),
    query<DbRow>("select * from analytics_monthly_financials($1::date,$2::date)",[period.from,period.to]),
    query<DbRow>("select * from analytics_monthly_students($1::date,$2::date)",[period.from,period.to]),
    query<DbRow>("select * from analytics_fee_collection($1::date,$2::date)",[period.from,period.to]),
    query<DbRow>("select * from analytics_expense_trend($1::date,$2::date)",[period.from,period.to]),
    query<DbRow>("select * from analytics_payroll_trend($1::date,$2::date)",[period.from,period.to]),
    query<DbRow>("select * from analytics_rent_trend($1::date,$2::date)",[period.from,period.to]),
    query<DbRow>("select * from analytics_cash_trend($1::date,$2::date)",[period.from,period.to]),
    query<DbRow>("select * from analytics_food_trend($1::date,$2::date)",[period.from,period.to]),
    termQuery,
    query<DbRow>("select * from analytics_year_over_year($1::date,$2::date)",[period.from,period.to]),
  ]);

  return {
    summary:summaryResult.rows.map((r)=>({
      currency:String(r.currency),income:num(r.income),expenses:num(r.expenses),expectedFees:num(r.expected_fees),
      collectedFees:num(r.collected_fees),collectionRate:nullableNum(r.collection_rate),
      payrollExpense:num(r.payroll_expense),rentExpense:num(r.rent_expense),foodRevenue:num(r.food_revenue),
      foodCost:num(r.food_cost),foodContribution:num(r.food_contribution),netCashMovement:num(r.net_cash_movement),
    })),
    monthly:monthlyResult.rows.map((r)=>({
      monthStart:iso(r.month_start),periodStart:iso(r.period_start),periodEnd:iso(r.period_end),currency:String(r.currency),
      income:num(r.income),expenses:num(r.expenses),expectedFees:num(r.expected_fees),collectedFees:num(r.collected_fees),
      collectionRate:nullableNum(r.collection_rate),activeStudents:num(r.active_students),
    })),
    students:studentsResult.rows.map((r)=>({
      monthStart:iso(r.month_start),periodStart:iso(r.period_start),periodEnd:iso(r.period_end),
      openingActive:num(r.opening_active),newEnrollments:num(r.new_enrollments),withdrawals:num(r.withdrawals),
      closingActive:num(r.closing_active),netChange:num(r.net_change),netGrowthRate:nullableNum(r.net_growth_rate),
    })),
    fees:feesResult.rows.map((r)=>({
      currency:String(r.currency),expectedFees:num(r.expected_fees),collectedFees:num(r.collected_fees),
      collectionRate:nullableNum(r.collection_rate),
    })),
    expenses:expensesResult.rows.map((r)=>({
      monthStart:iso(r.month_start),periodStart:iso(r.period_start),periodEnd:iso(r.period_end),currency:String(r.currency),
      accountId:String(r.account_id),accountCode:String(r.account_code),accountName:String(r.account_name),
      monthlyAmount:num(r.monthly_amount),periodAmount:num(r.period_amount),periodExpenseTotal:num(r.period_expense_total),
      sharePercent:nullableNum(r.share_percent),priorPeriodAmount:num(r.prior_period_amount),
      changeAmount:num(r.change_amount),changePercent:nullableNum(r.change_percent),
    })),
    payroll:payrollResult.rows.map((r)=>({
      monthStart:iso(r.month_start),currency:String(r.currency),baseSalary:num(r.base_salary),allowances:num(r.allowances),
      bonuses:num(r.bonuses),deductions:num(r.deductions),payrollExpense:num(r.payroll_expense),
      advanceRepayments:num(r.advance_repayments),netPay:num(r.net_pay),employeeCount:num(r.employee_count),
    })),
    rent:rentResult.rows.map((r)=>({
      monthStart:iso(r.month_start),currency:String(r.currency),recognizedRentExpense:num(r.recognized_rent_expense),
      totalExpenses:num(r.total_expenses),totalIncome:num(r.total_income),
      rentPercentExpenses:nullableNum(r.rent_percent_expenses),rentPercentIncome:nullableNum(r.rent_percent_income),
    })),
    cash:cashResult.rows.map((r)=>({
      monthStart:iso(r.month_start),currency:String(r.currency),externalInflow:num(r.external_inflow),
      externalOutflow:num(r.external_outflow),netExternalMovement:num(r.net_external_movement),
      closingCash:num(r.closing_cash),closingBank:num(r.closing_bank),closingTotal:num(r.closing_total),
    })),
    food:foodResult.rows.map((r)=>({
      monthStart:iso(r.month_start),currency:String(r.currency),purchasedAmount:num(r.purchased_amount),
      foodRevenue:num(r.food_revenue),usageCost:num(r.usage_cost),wasteCost:num(r.waste_cost),
      spoilageCost:num(r.spoilage_cost),correctionCost:num(r.correction_cost),otherCost:num(r.other_cost),
      foodCost:num(r.food_cost),contribution:num(r.contribution),contributionMargin:nullableNum(r.contribution_margin),
      costAvailable:Boolean(r.cost_available),
    })),
    terms:termsResult.rows.map((r)=>({
      termId:String(r.term_id),termSequence:num(r.term_sequence),termName:String(r.term_name),
      startsOn:iso(r.starts_on),endsOn:iso(r.ends_on),currency:String(r.currency),activeStudents:num(r.active_students),
      expectedFees:num(r.expected_fees),collectedFees:num(r.collected_fees),
      outstandingReceivables:num(r.outstanding_receivables),collectionRate:nullableNum(r.collection_rate),
      income:num(r.income),expenses:num(r.expenses),payrollExpense:num(r.payroll_expense),rentExpense:num(r.rent_expense),
      foodRevenue:num(r.food_revenue),foodCost:num(r.food_cost),foodContribution:num(r.food_contribution),
      netCashMovement:num(r.net_cash_movement),
    })),
    yearOverYear:yoyResult.rows.map((r)=>({
      metricKey:String(r.metric_key),metricLabel:String(r.metric_label),
      unit:String(r.unit) as "money"|"count"|"percent",currency:r.currency===null?null:String(r.currency),
      currentValue:nullableNum(r.current_value),priorValue:nullableNum(r.prior_value),
      changeValue:nullableNum(r.change_value),changePercent:nullableNum(r.change_percent),
      currentFrom:iso(r.current_from),currentTo:iso(r.current_to),priorFrom:iso(r.prior_from),priorTo:iso(r.prior_to),
    })),
  };
}
