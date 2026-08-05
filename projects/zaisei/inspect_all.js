// 全タブ対応・包括的JSON点検スクリプト
const fs = require('fs');

function fmt(v) { return v==null?'null':typeof v==='number'?v.toLocaleString('ja-JP'):v; }

function check(label, json_path) {
  const raw = fs.readFileSync(json_path, 'utf8');
  const data = JSON.parse(raw);
  let datasets = Array.isArray(data) ? data : [data];
  const muns = datasets.flatMap(d => {
    const m = d.municipalities;
    if (!m) return [];
    return Array.isArray(m) ? m : Object.values(m);
  });
  const meta = datasets[0] || {};

  console.log(`\n${'='.repeat(65)}`);
  console.log(`【${label}】 ${muns.length}件  年度:${meta.fiscal_year||'?'}  ${meta.prefecture||''}`);
  const N = muns.length;
  if (!N) { console.log('  データなし'); return; }

  function pct(n) { return (n/N*100).toFixed(0)+'%'; }
  function countWith(field) { return muns.filter(m=>m[field]!=null).length; }
  function countArr(field) { return muns.filter(m=>Array.isArray(m[field])&&m[field].length).length; }
  function mark(n) { return n===N?'✓':n>=N*0.8?'△':'✗'; }

  // ── 概要タブフィールド ──────────────────────────────────────────
  console.log('\n■ 概要タブ');
  const overviewFields = [
    ['pop_r2','人口（R2国調）'],['area','面積'],['density','人口密度'],
    ['pop_juki_r6','住基人口R6'],['fiscal_strength_index','財政力指数'],
    ['revenue','歳入'],['expenditure','歳出'],['net_balance','形式収支'],
    ['real_balance','実質収支'],['annual_balance','単年度収支'],
    ['local_tax','地方税'],['reserve_fund','積立金'],
    ['reserve_financial_adj','財政調整基金'],['local_bond_outstanding','地方債現在高'],
  ];
  for(const [f,lbl] of overviewFields) {
    const n=countWith(f); console.log(`  ${mark(n)} ${lbl.padEnd(18)} ${n}/${N} (${pct(n)})`);
  }

  // ── 歳入タブ ───────────────────────────────────────────────────
  console.log('\n■ 歳入タブ (revenue_detail)');
  const revWith = muns.filter(m=>Array.isArray(m.revenue_detail)&&m.revenue_detail.length);
  console.log(`  ${mark(revWith.length)} revenue_detail      ${revWith.length}/${N} (${pct(revWith.length)})  平均${revWith.length?(revWith.reduce((s,m)=>s+m.revenue_detail.length,0)/revWith.length).toFixed(1):0}項目`);
  if(revWith.length) {
    const pctNull = revWith.filter(m=>m.revenue_detail.some(r=>r.amount!=null&&r.pct==null));
    const pctNullRows = pctNull.flatMap(m=>m.revenue_detail.filter(r=>r.amount!=null&&r.pct==null).map(r=>`${m.name}:${r.label}`)).slice(0,5);
    console.log(`  ${pctNull.length?'✗ pct=null: '+pctNull.length+'件 → '+pctNullRows.join(' / '):'✓ 構成比: 全行OK'}`);
  }

  // ── 歳出タブ ───────────────────────────────────────────────────
  console.log('\n■ 歳出タブ');
  const expNWith = muns.filter(m=>Array.isArray(m.expenditure_by_nature)&&m.expenditure_by_nature.length);
  const expPWith = muns.filter(m=>Array.isArray(m.expenditure_by_purpose)&&m.expenditure_by_purpose.length);
  console.log(`  ${mark(expNWith.length)} expenditure_by_nature   ${expNWith.length}/${N} (${pct(expNWith.length)})  平均${expNWith.length?(expNWith.reduce((s,m)=>s+m.expenditure_by_nature.length,0)/expNWith.length).toFixed(1):0}項目`);
  console.log(`  ${mark(expPWith.length)} expenditure_by_purpose  ${expPWith.length}/${N} (${pct(expPWith.length)})  平均${expPWith.length?(expPWith.reduce((s,m)=>s+m.expenditure_by_purpose.length,0)/expPWith.length).toFixed(1):0}項目`);
  // pct nullチェック
  const expNPctNull = expNWith.filter(m=>m.expenditure_by_nature.some(r=>r.amount!=null&&r.pct==null));
  const expPPctNull = expPWith.filter(m=>m.expenditure_by_purpose.some(r=>r.amount!=null&&r.pct==null));
  console.log(`  ${expNPctNull.length?'✗ 性質別pct=null: '+expNPctNull.length+'件':'✓ 性質別pct: 全行OK'}`);
  console.log(`  ${expPPctNull.length?'✗ 目的別pct=null: '+expPPctNull.length+'件':'✓ 目的別pct: 全行OK'}`);

  // ── 財政指標タブ ───────────────────────────────────────────────
  console.log('\n■ 財政指標タブ');
  const fiscalFields = [
    ['fiscal_strength_index','財政力指数'],['current_expenditure_ratio','経常収支比率'],
    ['real_debt_ratio','実質公債費比率'],['future_burden_ratio','将来負担比率'],
    ['debt_service_ratio','公債費負担比率'],['laspeyres_index','ラスパイレス指数'],
    ['standard_fiscal_scale','標準財政規模'],
  ];
  for(const [f,lbl] of fiscalFields) {
    const n=countWith(f); console.log(`  ${mark(n)} ${lbl.padEnd(18)} ${n}/${N} (${pct(n)})`);
  }

  // ── 市町村税タブ ───────────────────────────────────────────────
  console.log('\n■ 市町村税タブ (tax_detail)');
  const taxWith = muns.filter(m=>Array.isArray(m.tax_detail)&&m.tax_detail.length);
  console.log(`  ${mark(taxWith.length)} tax_detail          ${taxWith.length}/${N} (${pct(taxWith.length)})  平均${taxWith.length?(taxWith.reduce((s,m)=>s+m.tax_detail.length,0)/taxWith.length).toFixed(1):0}項目`);
  if(taxWith.length){
    const pctNull=taxWith.filter(m=>m.tax_detail.some(r=>r.amount!=null&&r.pct==null));
    const extHas=taxWith.filter(m=>m.tax_detail.some(r=>r.extra_tax!=null));
    console.log(`  ${pctNull.length?'✗ pct=null: '+pctNull.length+'件 ← 要確認':'✓ 構成比: 全行OK'}`);
    console.log(`  ✓ extra_tax有: ${extHas.length}件 / extra_tax全null: ${taxWith.length-extHas.length}件(超過課税なし)`);
  }

  // ── 職員タブ ───────────────────────────────────────────────────
  console.log('\n■ 職員タブ');
  const empWith = muns.filter(m=>Array.isArray(m.employees)&&m.employees.length);
  console.log(`  ${mark(empWith.length)} employees           ${empWith.length}/${N} (${pct(empWith.length)})  平均${empWith.length?(empWith.reduce((s,m)=>s+m.employees.length,0)/empWith.length).toFixed(1):0}種別`);
  const lasN=countWith('laspeyres_index');
  console.log(`  ${mark(lasN)} laspeyres_index     ${lasN}/${N} (${pct(lasN)})`);

  // ── 追加項目タブ ───────────────────────────────────────────────
  console.log('\n■ 追加項目タブ');
  const extraFields = [
    ['public_enterprises','公営企業繰出'],['payout_total','実質公債費'],
    ['collection_rate_total','収納率（現年＋滞納）'],['regular_general_revenue','経常一般財源'],
    ['total_general_revenue','一般財源合計'],
  ];
  for(const [f,lbl] of extraFields) {
    const n=countWith(f)||countArr(f);
    console.log(`  ${n>0?'✓':'✗'} ${lbl.padEnd(18)} ${n}/${N}`);
  }

  // ── 数値サニティ ───────────────────────────────────────────────
  console.log('\n■ 数値サニティ');
  const bigDiff = muns.filter(m=>{
    if(!m.revenue||!m.expenditure) return false;
    return Math.abs(m.revenue-m.expenditure)/Math.max(m.revenue,m.expenditure)>0.1;
  });
  console.log(`  ${bigDiff.length?'✗':'✓'} 歳入vs歳出乖離>10%: ${bigDiff.length}件 ${bigDiff.map(m=>`${m.name}(${((m.revenue-m.expenditure)/m.revenue*100).toFixed(1)}%)`).join(' ')}`);

  const zeroRev = muns.filter(m=>m.revenue!=null&&m.revenue<=0);
  const zeroExp = muns.filter(m=>m.expenditure!=null&&m.expenditure<=0);
  console.log(`  ${zeroRev.length?'✗':'✓'} 歳入≤0: ${zeroRev.length}件`);

  // ── 未知フィールドスキャン ─────────────────────────────────────
  const KNOWN = new Set([
    'name','mtype','pop_r2','pop_r2_h27','pop_h27','area','density','pop_juki_r6','pop_juki_r5',
    'pop_juki_r6_jp','pop_juki_r4','pop_juki_r3','pop_change_pct','fiscal_strength_index',
    'local_tax','revenue','expenditure','net_balance','real_balance','annual_balance',
    'real_annual_balance','reserve_fund','reserve_fund_rollover','reserve_fund_withdrawal',
    'current_expenditure_ratio','real_debt_ratio','future_burden_ratio',
    'debt_service_ratio','standard_fiscal_scale','standard_fiscal_revenue','standard_fiscal_need',
    'reserve_financial_adj','reserve_debt_redemption','reserve_specific',
    'local_bond_outstanding','revenue_prev','expenditure_prev','real_balance_prev',
    'annual_balance_prev','revenue_detail','expenditure_by_nature','expenditure_by_purpose',
    'tax_detail','employees','laspeyres_index','public_enterprises','payout_total',
    'collection_rate_total','collection_rate_current','collection_rate_muni_tax','collection_rate_property',
    'regular_general_revenue','total_general_revenue','unit','fiscal_year',
    'base_fiscal_demand','base_fiscal_income','standard_tax_revenue','real_surplus_ratio',
    'debt_commit_purchase','debt_commit_other','debt_commit_guarantee',
  ]);
  const unknownFields = new Set();
  muns.forEach(m=>Object.keys(m).forEach(k=>{ if(!KNOWN.has(k)) unknownFields.add(k); }));
  if(unknownFields.size) {
    console.log(`\n■ 未知フィールド (viewer未対応の可能性): ${[...unknownFields].join(', ')}`);
  } else {
    console.log('\n■ 未知フィールド: なし ✓');
  }
}

check('市区町村 高知R6',  'kochi_r6.json');
check('市区町村 栃木H27', 'tochigi_h27.json');
check('都道府県 H27全国', 'pref_h27_all.json');
