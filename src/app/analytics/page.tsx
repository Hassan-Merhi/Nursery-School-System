import { requirePermission } from "@/lib/security";
import { loadAnalytics,resolveAnalyticsPeriod,type AnalyticsSearch } from "@/lib/analytics";
import { EmptyState,MetricCard,MiniBars,MoneyStack,money,monthLabel,percent,signed } from "./components";

function rowsForCurrency<T extends {currency:string}>(rows:T[],currency:string){return rows.filter((row)=>row.currency===currency);}
function uniqueExpenseAccounts(rows:Awaited<ReturnType<typeof loadAnalytics>>["expenses"]){
  const map=new Map<string,(typeof rows)[number]>();
  for(const row of rows)if(!map.has(row.currency+":"+row.accountId))map.set(row.currency+":"+row.accountId,row);
  return [...map.values()];
}
function displayYoy(row:Awaited<ReturnType<typeof loadAnalytics>>["yearOverYear"][number],value:number|null){
  if(value===null)return "—";
  if(row.unit==="money")return money(value,row.currency??"USD");
  if(row.unit==="percent")return percent(value);
  return String(Math.round(value));
}

export default async function AnalyticsPage({searchParams}:{searchParams:Promise<AnalyticsSearch>}){
  await requirePermission("analytics.view");
  const period=await resolveAnalyticsPeriod(await searchParams);
  const data=await loadAnalytics(period);
  const selectedYear=period.years.find((year)=>year.id===period.selectedYearId)??null;
  const currencies=[...new Set([
    ...data.summary.map((row)=>row.currency),...data.monthly.map((row)=>row.currency),
    ...data.food.map((row)=>row.currency),...data.cash.map((row)=>row.currency),
  ])].sort();
  const firstStudents=data.students[0];
  const lastStudents=data.students[data.students.length-1];
  const studentNet=firstStudents&&lastStudents?lastStudents.closingActive-firstStudents.openingActive:0;
  const expenseAccounts=uniqueExpenseAccounts(data.expenses);
  const priorRange=data.yearOverYear[0];

  return <main className="app-shell analytics-shell">
    <header className="topbar">
      <div>
        <p className="eyebrow">Montikids Montessori Preschool & Nursery</p>
        <h1>Advanced Dashboard & Analysis</h1>
        <p className="muted">Read-only management analytics from posted accounting and historical operational records.</p>
      </div>
      <div className="top-actions no-print">
        <a className="button-link secondary-link" href="/reports">Management & reports</a>
        <a className="button-link secondary-link" href="/dashboard">Administration</a>
      </div>
    </header>

    <section className="panel analytics-filter no-print">
      <form method="get" action="/analytics" className="analytics-filter-grid">
        <label>View
          <select name="mode" defaultValue={period.mode}>
            <option value="year">School year</option><option value="term">Term</option><option value="custom">Custom range</option>
          </select>
        </label>
        <label>School year
          <select name="year" defaultValue={period.selectedYearId??""}>
            {period.years.map((year)=><option value={year.id} key={year.id}>{year.name}</option>)}
          </select>
        </label>
        <label>Term
          <select name="term" defaultValue={period.selectedTermId??selectedYear?.terms[0]?.id??""}>
            {(selectedYear?.terms??[]).map((term)=><option value={term.id} key={term.id}>Term {term.sequence} · {term.name}</option>)}
          </select>
        </label>
        <label>From<input type="date" name="from" defaultValue={period.from}/></label>
        <label>To<input type="date" name="to" defaultValue={period.to}/></label>
        <button type="submit">Apply analysis</button>
      </form>
      <p className="muted compact-text analytics-period-note">
        Showing {period.from} → {period.to}
        {priorRange?<> · comparison period {priorRange.priorFrom} → {priorRange.priorTo}</>:null}.
        Monetary figures stay separated by currency.
      </p>
    </section>

    <section className="analytics-kpis">
      <MetricCard label="Active students" value={lastStudents?.closingActive??0} note={"Historical active enrollment as of "+period.to+"."}/>
      <MetricCard label="Student growth" value={(studentNet>0?"+":"")+studentNet} note="Net change from the opening population to the period end."/>
      <MetricCard label="Fee collection rate" value={<span className="money-stack">{data.fees.length?data.fees.map((row)=><span key={row.currency}>{row.currency}: {row.collectionRate===null?"No fees due":percent(row.collectionRate)}</span>):<span>No fees due</span>}</span>} note="Allocated tuition collections divided by tuition due."/>
      <MetricCard label="Income" value={<MoneyStack rows={data.summary} field="income"/>} note="Posted income-account activity."/>
      <MetricCard label="Expenses" value={<MoneyStack rows={data.summary} field="expenses"/>} note="Posted expense-account activity."/>
      <MetricCard label="Net cash movement" value={<MoneyStack rows={data.summary} field="netCashMovement"/>} note="External cash movement; internal cash/bank transfers cancel."/>
      <MetricCard label="Payroll expense" value={<MoneyStack rows={data.summary} field="payrollExpense"/>} note="Aggregate locked/paid payroll cost only."/>
      <MetricCard label="Rent impact" value={<MoneyStack rows={data.summary} field="rentExpense"/>} note="Recognized rent expense, not prepaid rent cash."/>
    </section>

    <section className="panel section-block" id="term-comparison">
      <div className="section-heading"><div><p className="eyebrow">1 · Term comparison</p><h2>Compare the three school terms</h2><p className="muted">Uses each term's configured dates and historical balances.</p></div></div>
      {!data.terms.length?<EmptyState/>:<div className="table-wrap"><table><thead><tr><th>Term</th><th>Currency</th><th>Students</th><th>Fees due</th><th>Collected</th><th>Outstanding</th><th>Rate</th><th>Income</th><th>Expenses</th><th>Payroll</th><th>Rent</th><th>Food contribution</th><th>Net cash</th></tr></thead>
      <tbody>{data.terms.map((row)=><tr key={row.termId+":"+row.currency}><td><strong>Term {row.termSequence}</strong><div className="muted">{row.termName}<br/>{row.startsOn} → {row.endsOn}</div></td><td>{row.currency}</td><td>{row.activeStudents}</td><td>{money(row.expectedFees,row.currency)}</td><td>{money(row.collectedFees,row.currency)}</td><td>{money(row.outstandingReceivables,row.currency)}</td><td>{row.collectionRate===null?"No fees due":percent(row.collectionRate)}</td><td>{money(row.income,row.currency)}</td><td>{money(row.expenses,row.currency)}</td><td>{money(row.payrollExpense,row.currency)}</td><td>{money(row.rentExpense,row.currency)}</td><td>{money(row.foodContribution,row.currency)}</td><td>{money(row.netCashMovement,row.currency)}</td></tr>)}</tbody></table></div>}
    </section>

    <section className="panel section-block" id="monthly-trends">
      <div className="section-heading"><div><p className="eyebrow">2 · Monthly trends</p><h2>Income, expenses and fees by month</h2></div></div>
      {currencies.map((currency)=>{
        const rows=rowsForCurrency(data.monthly,currency);
        return <div className="analytics-currency-block" key={currency}><h3>{currency}</h3>
          <MiniBars points={rows.map((row)=>({label:monthLabel(row.monthStart),value:row.income-row.expenses,display:money(row.income-row.expenses,currency)}))}/>
          <div className="table-wrap"><table><thead><tr><th>Month</th><th>Income</th><th>Expenses</th><th>Fees due</th><th>Collected</th><th>Rate</th><th>Students</th></tr></thead><tbody>{rows.map((row)=><tr key={row.monthStart}><td>{monthLabel(row.monthStart)}</td><td>{money(row.income,currency)}</td><td>{money(row.expenses,currency)}</td><td>{money(row.expectedFees,currency)}</td><td>{money(row.collectedFees,currency)}</td><td>{row.collectionRate===null?"No fees due":percent(row.collectionRate)}</td><td>{row.activeStudents}</td></tr>)}</tbody></table></div>
        </div>;
      })}
      {!currencies.length?<EmptyState/>:null}
    </section>

    <section className="panel section-block" id="expense-trends">
      <div className="section-heading"><div><p className="eyebrow">3 · Expense trends</p><h2>Movement by custom expense account</h2><p className="muted">No hard-coded expense categories; these are your chart-of-accounts names.</p></div></div>
      {!expenseAccounts.length?<EmptyState/>:<><MiniBars points={expenseAccounts.slice(0,12).map((row)=>({label:row.accountCode+" · "+row.accountName,value:row.periodAmount,display:money(row.periodAmount,row.currency)}))}/>
      <div className="table-wrap"><table><thead><tr><th>Account</th><th>Currency</th><th>Period</th><th>Share</th><th>Prior comparable</th><th>Change</th></tr></thead><tbody>{expenseAccounts.map((row)=><tr key={row.currency+":"+row.accountId}><td>{row.accountCode} · {row.accountName}</td><td>{row.currency}</td><td>{money(row.periodAmount,row.currency)}</td><td>{percent(row.sharePercent)}</td><td>{money(row.priorPeriodAmount,row.currency)}</td><td>{money(row.changeAmount,row.currency)}<div className="muted">{row.changePercent===null?"No prior base":signed(row.changePercent,"%")}</div></td></tr>)}</tbody></table></div></>}
    </section>

    <section className="panel section-block" id="student-growth">
      <div className="section-heading"><div><p className="eyebrow">4 · Student growth</p><h2>Enrollment population movement</h2></div></div>
      {!data.students.length?<EmptyState/>:<><MiniBars points={data.students.map((row)=>({label:monthLabel(row.monthStart),value:row.closingActive,display:String(row.closingActive)}))}/>
      <div className="table-wrap"><table><thead><tr><th>Month</th><th>Opening</th><th>New enrollments</th><th>Withdrawals</th><th>Closing</th><th>Net change</th><th>Growth</th></tr></thead><tbody>{data.students.map((row)=><tr key={row.monthStart}><td>{monthLabel(row.monthStart)}</td><td>{row.openingActive}</td><td>{row.newEnrollments}</td><td>{row.withdrawals}</td><td><strong>{row.closingActive}</strong></td><td>{row.netChange>0?"+":""}{row.netChange}</td><td>{row.netGrowthRate===null?"No opening base":percent(row.netGrowthRate)}</td></tr>)}</tbody></table></div></>}
    </section>

    <section className="panel section-block" id="fee-collection">
      <div className="section-heading"><div><p className="eyebrow">5 · Fee collection rate</p><h2>Tuition due versus tuition collected</h2><p className="muted">Unallocated parent funds remain prepayments and are not counted as tuition collected.</p></div></div>
      {!data.fees.length?<EmptyState>No tuition activity in this period.</EmptyState>:<div className="table-wrap"><table><thead><tr><th>Currency</th><th>Expected fees</th><th>Collected fees</th><th>Collection rate</th></tr></thead><tbody>{data.fees.map((row)=><tr key={row.currency}><td>{row.currency}</td><td>{money(row.expectedFees,row.currency)}</td><td>{money(row.collectedFees,row.currency)}</td><td><strong>{row.collectionRate===null?"No fees due":percent(row.collectionRate)}</strong></td></tr>)}</tbody></table></div>}
    </section>

    <section className="panel section-block" id="food-profitability">
      <div className="section-heading"><div><p className="eyebrow">6 · Food profitability</p><h2>Food revenue, purchasing and recognized cost</h2><p className="muted">Cost is sourced from Step 11 inventory/accounting. Purchases stay inventory until usage, waste, spoilage or correction recognizes cost.</p></div></div>
      {!data.food.length?<EmptyState/>:null}
      {currencies.map((currency)=>{
        const rows=rowsForCurrency(data.food,currency);
        if(!rows.length)return null;
        const unavailable=rows.some((row)=>!row.costAvailable);
        return <div className="analytics-currency-block" key={currency}><h3>{currency}</h3>
          {unavailable?<div className="notice">Cost data unavailable</div>:<MiniBars points={rows.map((row)=>({label:monthLabel(row.monthStart),value:row.contribution,display:money(row.contribution,currency)}))}/>}
          <div className="table-wrap"><table><thead><tr><th>Month</th><th>Purchases</th><th>Revenue</th><th>Usage</th><th>Waste</th><th>Spoilage</th><th>Other/corrections</th><th>Recognized cost</th><th>Contribution</th><th>Margin</th></tr></thead><tbody>{rows.map((row)=><tr key={row.monthStart}><td>{monthLabel(row.monthStart)}</td><td>{money(row.purchasedAmount,currency)}</td><td>{money(row.foodRevenue,currency)}</td><td>{money(row.usageCost,currency)}</td><td>{money(row.wasteCost,currency)}</td><td>{money(row.spoilageCost,currency)}</td><td>{money(row.correctionCost+row.otherCost,currency)}</td><td>{row.costAvailable?money(row.foodCost,currency):"Cost data unavailable"}</td><td><strong>{row.costAvailable?money(row.contribution,currency):"—"}</strong></td><td>{row.costAvailable?percent(row.contributionMargin):"—"}</td></tr>)}</tbody></table></div>
        </div>;
      })}
    </section>

    <section className="panel section-block" id="payroll-trends">
      <div className="section-heading"><div><p className="eyebrow">7 · Payroll trends</p><h2>Aggregate locked/paid payroll</h2><p className="muted">This analytics permission exposes totals only—no employee names, employee numbers, salary agreements or payslips.</p></div></div>
      {!data.payroll.length?<EmptyState/>:<div className="table-wrap"><table><thead><tr><th>Month</th><th>Currency</th><th>Employees</th><th>Base</th><th>Allowances</th><th>Bonuses</th><th>Deductions</th><th>Employee cost</th><th>Advance repayments</th><th>Net pay</th></tr></thead><tbody>{data.payroll.map((row)=><tr key={row.monthStart+":"+row.currency}><td>{monthLabel(row.monthStart)}</td><td>{row.currency}</td><td>{row.employeeCount}</td><td>{money(row.baseSalary,row.currency)}</td><td>{money(row.allowances,row.currency)}</td><td>{money(row.bonuses,row.currency)}</td><td>{money(row.deductions,row.currency)}</td><td><strong>{money(row.payrollExpense,row.currency)}</strong></td><td>{money(row.advanceRepayments,row.currency)}</td><td>{money(row.netPay,row.currency)}</td></tr>)}</tbody></table></div>}
    </section>

    <section className="panel section-block" id="rent-impact">
      <div className="section-heading"><div><p className="eyebrow">8 · Rent impact</p><h2>Recognized rent versus income and expenses</h2><p className="muted">Prepaid rent cash is not treated as immediate rent expense.</p></div></div>
      {!data.rent.length?<EmptyState/>:<div className="table-wrap"><table><thead><tr><th>Month</th><th>Currency</th><th>Recognized rent</th><th>Total expenses</th><th>Total income</th><th>% of expenses</th><th>% of income</th></tr></thead><tbody>{data.rent.map((row)=><tr key={row.monthStart+":"+row.currency}><td>{monthLabel(row.monthStart)}</td><td>{row.currency}</td><td>{money(row.recognizedRentExpense,row.currency)}</td><td>{money(row.totalExpenses,row.currency)}</td><td>{money(row.totalIncome,row.currency)}</td><td>{percent(row.rentPercentExpenses)}</td><td>{percent(row.rentPercentIncome)}</td></tr>)}</tbody></table></div>}
    </section>

    <section className="panel section-block" id="cash-movement">
      <div className="section-heading"><div><p className="eyebrow">9 · Cash movement</p><h2>External inflow, outflow and closing liquidity</h2><p className="muted">Transfers between Montikids cash and bank accounts do not inflate external inflow or outflow.</p></div></div>
      {!data.cash.length?<EmptyState/>:<div className="table-wrap"><table><thead><tr><th>Month</th><th>Currency</th><th>External inflow</th><th>External outflow</th><th>Net movement</th><th>Closing cash</th><th>Closing bank</th><th>Total liquidity</th></tr></thead><tbody>{data.cash.map((row)=><tr key={row.monthStart+":"+row.currency}><td>{monthLabel(row.monthStart)}</td><td>{row.currency}</td><td>{money(row.externalInflow,row.currency)}</td><td>{money(row.externalOutflow,row.currency)}</td><td><strong>{money(row.netExternalMovement,row.currency)}</strong></td><td>{money(row.closingCash,row.currency)}</td><td>{money(row.closingBank,row.currency)}</td><td>{money(row.closingTotal,row.currency)}</td></tr>)}</tbody></table></div>}
    </section>

    <section className="panel section-block" id="year-over-year">
      <div className="section-heading"><div><p className="eyebrow">10 · Year-over-year comparisons</p><h2>Current versus comparable prior period</h2><p className="muted">{priorRange?period.from+" → "+period.to+" compared with "+priorRange.priorFrom+" → "+priorRange.priorTo:"No comparable period."}</p></div></div>
      {!data.yearOverYear.length?<EmptyState/>:<div className="table-wrap"><table><thead><tr><th>Metric</th><th>Currency</th><th>Current</th><th>Prior</th><th>Absolute change</th><th>% change</th></tr></thead><tbody>{data.yearOverYear.map((row)=><tr key={row.metricKey+":"+(row.currency??"count")}><td>{row.metricLabel}</td><td>{row.currency??"—"}</td><td>{displayYoy(row,row.currentValue)}</td><td>{displayYoy(row,row.priorValue)}</td><td>{row.changeValue===null?"—":row.unit==="money"?money(row.changeValue,row.currency??"USD"):row.unit==="percent"?signed(row.changeValue," pp"):signed(row.changeValue)}</td><td>{row.changePercent===null?"No prior base":signed(row.changePercent,"%")}</td></tr>)}</tbody></table></div>}
    </section>
  </main>;
}
