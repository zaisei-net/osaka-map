#!/usr/bin/env node
/**
 * 都道府県決算カード Excel → JSON 変換スクリプト
 * =================================================
 * R5/R6 両対応（行番号を動的検出、レイアウトずれを吸収）
 *
 * 【使い方】
 *   node batch_extract_pref.js --dir pref_excel/R5 --out pref_json/R5 --all pref_json/all_pref_datasets_R5.json
 *   node batch_extract_pref.js --dir pref_excel/R6 --out pref_json/R6 --all pref_json/all_pref_datasets_R6.json
 */

const XLSX = require('xlsx');
const fs   = require('fs');
const path = require('path');

function getArg(flag,def=null){const i=args.indexOf(flag);return i>=0&&args[i+1]?args[i+1]:def;}
const args      = process.argv.slice(2);
const dirArg    = getArg('--dir','.');
const outDirArg = getArg('--out','pref_json');
const allArg    = getArg('--all','all_pref_datasets.json');
const yearArg   = getArg('--year',null);
const skipExist = args.includes('--skip-existing');

// ── ユーティリティ（0-based行列）────────────────────────────────
function colToLetter(col){let r='',c=col;while(c>=0){r=String.fromCharCode(65+(c%26))+r;c=Math.floor(c/26)-1;}return r;}
function clean(val){
  if(val===undefined||val===null)return null;
  const s=String(val).trim();
  if(['-','','nan','NaN','None','－','＊','*'].includes(s))return null;
  const n=Number(s);
  if(!isNaN(n))return Number.isInteger(n)?n:Math.round(n*10000)/10000;
  return s;
}
function gc(sheet,row,col){// 0-based
  const cell=sheet[`${colToLetter(col)}${row+1}`];
  return cell?clean(cell.v):null;
}
function num(v){return typeof v==='number'?v:null;}

// ── 年度・都道府県名検出 ──────────────────────────────────────────
function detectYear(sheet){
  const v=gc(sheet,1,3);// (2,4) 1-based
  if(typeof v==='string'&&v.includes('年度'))return v;
  for(let r=0;r<5;r++)for(let c=0;c<10;c++){const w=gc(sheet,r,c);if(typeof w==='string'&&w.includes('年度'))return w;}
  return '';
}
function detectPrefName(sheet,sheetName){
  const v=gc(sheet,1,94);// (2,95) 1-based
  if(typeof v==='string'&&/[都道府県]$/.test(v))return v;
  return sheetName.replace(/^\d+/,'').trim()||sheetName;
}

// ── 歳出性質別・目的別・経常収支比率：基準行を動的検出 ──────────────
// 「区分」ヘッダー行の次の行が「義務的経費計」の開始行
// R5: 区分=row46(0-based:45) → 義務的経費計=row48(0-based:47)
// R6: 区分=row47(0-based:46) → 義務的経費計=row49(0-based:48)
function detectExpNatureBase(sheet){
  // col2(1)〜col4(3)で「義務的経費計」を探す
  for(let r=44;r<=54;r++){
    for(let c=1;c<=4;c++){
      const v=gc(sheet,r,c);
      if(typeof v==='string'&&v.replace(/\s/g,'').includes('義務的経費計'))return r;
    }
  }
  return 47;// fallback=R5
}

// 「区分」ヘッダー（歳出目的別）を探す: col47(0-based:46)付近
function detectExpPurposeBase(sheet){
  // col47(46)に「議会費」が現れる最初の行
  for(let r=44;r<=54;r++){
    const v=gc(sheet,r,46);
    if(typeof v==='string'&&v.includes('議会費'))return r;
  }
  return 47;// fallback=R5
}

// 経常収支比率の行を動的検出（col41(0-based:40)に数値がある行）
function detectCerRow(sheet){
  for(let r=65;r<=73;r++){
    const v=gc(sheet,r,40);
    if(typeof v==='number')return r;
  }
  return 67;// fallback=R5
}

// 道府県税合計行を動的検出 (H27はrow39, R5/R6は40台の可能性)
function detectTaxTotalRow(sheet){
  for(let r=38;r<=47;r++){
    for(let c=42;c<=45;c++){
      const v=gc(sheet,r,c);
      if(typeof v==='string'&&v.trim()==='合計'){
        if(gc(sheet,r,55)!==null)return r;
      }
    }
  }
  return 42;// fallback
}

// ── 歳入明細 動的マッピング ─────────────────────────────────────
// ラベル: col2(1)/col3(2), 決算額: col13(12), 構成比: col21(20), 経常一般財源等: col26(25)
const REVENUE_LABELS=[
  ['地方税','地方税',0],
  ['地方譲与税','地方譲与税',0],
  ['地方揮発油譲与税','　地方揮発油譲与税',1],
  ['特別とん譲与税','　特別とん譲与税',1],
  ['石油ガス譲与税','　石油ガス譲与税',1],
  ['自動車重量譲与税','　自動車重量譲与税',1],
  ['航空機燃料譲与税','　航空機燃料譲与税',1],
  ['森林環境譲与税','　森林環境譲与税',1],
  ['特別法人事業譲与税','　特別法人事業譲与税',1],
  ['市町村たばこ税都道府県交付金','市町村たばこ税都道府県交付金',0],
  ['地方特例交付金等','地方特例交付金等',0],
  ['住宅借入金等','　住宅借入金等特別税額控除減収補塡特例交付金',1],// R6新規
  ['定額減税','　定額減税減収補塡特例交付金',1],                    // R6新規
  ['地方特例交付金','　地方特例交付金',1],                          // R5
  ['新型コロナ','　新型コロナ感染症対策特別交付金',1],              // R5
  ['地方交付税','地方交付税',0],
  ['普通交付税','　普通交付税',1],
  ['特別交付税','　特別交付税',1],
  ['震災復興特別交付税','　震災復興特別交付税',1],
  ['（一般財源計）','（一般財源計）',0],
  ['交通安全対策特別交付金','交通安全対策特別交付金',0],
  ['分担金','分担金・負担金',0],
  ['使用料','使用料',0],['手数料','手数料',0],
  ['国庫支出金','国庫支出金',0],
  ['国有提供交付金','国有提供交付金',0],
  ['財産収入','財産収入',0],['寄附金','寄附金',0],
  ['繰入金','繰入金',0],['繰越金','繰越金',0],['諸収入','諸収入',0],
  ['地方債','地方債',0],
  ['うち臨時財政対策債','　うち臨時財政対策債',1],
  ['歳入合計','歳入合計',0],
];

function buildRevenueRows(sheet){
  const rowMap={};
  for(let r=8;r<=47;r++){// R6で歳入合計がrow44(0-based:43)まで拡張→row47まで見る
    const v1=gc(sheet,r,1),v2=gc(sheet,r,2);
    const lbl=(typeof v1==='string'?v1:'')+(typeof v2==='string'?v2:'');
    if(lbl.trim())rowMap[r]=lbl.replace(/\s+/g,'');
  }
  const result=[];
  for(const[matchKey,outLabel,indent]of REVENUE_LABELS){
    const norm=matchKey.replace(/\s+/g,'');
    for(const[r,lbl]of Object.entries(rowMap)){
      if(lbl.includes(norm)){result.push([parseInt(r),outLabel,indent]);break;}
    }
  }
  return result;
}

// ── 歳出性質別（基準行からの相対オフセット）────────────────────────
// base = 「義務的経費計」の行(0-based)
// R5: base=47, R6: base=48
const EXP_NATURE_OFFSETS=[// [offset, label]
  [0,'義務的経費計'],[1,'　人件費'],[2,'　　うち職員給'],
  [3,'　扶助費'],[4,'　公債費'],[5,'　　元金'],[6,'　　利子'],[7,'　　一時借入金利子'],
  [8,'その他の経費'],[9,'　物件費'],[10,'　維持補修費'],[11,'　補助費等'],
  [12,'　繰出金'],[13,'　積立金'],[14,'　投資及び出資金'],[15,'　貸付金'],[16,'　前年度繰上充用金'],
  [17,'投資的経費計'],[18,'　うち人件費'],[19,'　普通建設事業費'],
  [20,'　　うち補助'],[21,'　　うち単独'],[22,'　災害復旧事業費'],[23,'　失業対策事業費'],
  // 歳出合計はオフセット固定しない → detectExpNatureTotalRow で動的取得
];

// ── 歳出目的別（基準行からの相対オフセット）────────────────────────
// base = 「議会費」の行(0-based)
const EXP_PURPOSE_OFFSETS=[// [offset, label]
  [0,'議会費'],[1,'総務費'],[2,'民生費'],[3,'衛生費'],
  [4,'労働費'],[5,'農林水産業費'],[6,'商工費'],[7,'土木費'],
  [8,'警察費'],[10,'教育費'],[11,'災害復旧費'],[12,'公債費'],
  [13,'諸支出金'],
  // 交付金行（行数可変）はスキップ、歳出合計はラベルスキャンで取得
];

// 歳出性質別の歳出合計行を動的検出（R5: base+24, R6: base+24）
function detectExpNatureTotalRow(sheet,base){
  for(let off=22;off<=28;off++){
    const r=base+off;
    for(let c=1;c<=4;c++){
      const v=gc(sheet,r,c);
      if(typeof v==='string'&&v.replace(/\s/g,'').includes('歳出合計')){
        if(gc(sheet,r,12)!==null)return r;
      }
    }
  }
  return base+24;// fallback
}

// 歳出目的別の歳出合計行を動的検出
function detectExpPurposeTotalRow(sheet){
  for(let r=70;r<=80;r++){
    const v=gc(sheet,r,46);
    if(typeof v==='string'&&v.includes('歳出合計')){
      if(gc(sheet,r,55)!==null)return r;
    }
  }
  return 74;// fallback
}

// ── 道府県税（行番号は固定・ラベルはExcelから動的読取・合計のみ動的）──
// row番号は年度共通。ラベルは年度によって変わる（自動車取得税廃止等）ため動的取得。
// tax1: '小計'=合計・区分計, '普通税'/'目的税'=個別税目
const TAX_ROWS_FIXED=[// [0-based row, fallbackLabel, tax1]
  [10,'普通税計','小計'],
  [11,'法定普通税計','小計'],
  [12,'道府県民税計','小計'],
  [13,'個人均等割','普通税'],[14,'所得割','普通税'],
  [15,'法人均等割','普通税'],[16,'法人税割','普通税'],
  [17,'利子割','普通税'],[18,'配当割','普通税'],[19,'株式等譲渡所得割','普通税'],
  [20,'事業税計','小計'],[21,'個人分','普通税'],[22,'法人分','普通税'],
  [23,'地方消費税','普通税'],[24,'不動産取得税','普通税'],
  [25,'道府県たばこ税','普通税'],[26,'ゴルフ場利用税','普通税'],
  [27,'自動車取得税等','普通税'],[28,'軽油引取税','普通税'],
  [29,'自動車税','普通税'],[31,'固定資産税特例','普通税'],
  [32,'法定外普通税','普通税'],
  [33,'目的税計','小計'],[34,'法定目的税計','小計'],[35,'狩猟税','目的税'],
  [36,'法定外目的税','目的税'],
  // 合計行は動的検出して末尾に追加
];

// ── 1都道府県データ抽出 ──────────────────────────────────────────
function extractPref(sheet,name){
  const g=(r,c)=>gc(sheet,r,c);
  const m={name};

  // 基本情報（固定行・列）
  const pop_r2=g(1,33);  if(num(pop_r2)!==null)m.pop_r2=pop_r2;
  const pop_h27=g(2,33); if(num(pop_h27)!==null)m.pop_h27=pop_h27;
  const pop_chg=g(3,33); if(num(pop_chg)!==null)m.pop_change_pct=pop_chg;
  const area=g(4,33);    if(num(area)!==null)m.area=area;
  const density=g(5,33); if(num(density)!==null)m.density=density;
  const jr6=g(3,48);  if(num(jr6)!==null)m.pop_juki_r6=jr6;
  const jr6j=g(3,57); if(num(jr6j)!==null)m.pop_juki_r6_jp=jr6j;
  const jr5=g(4,48);  if(num(jr5)!==null)m.pop_juki_r5=jr5;

  // 収支（右ブロック col95(94)=当年度, col105(104)=前年度）── 固定
  for(const[k,r]of[['revenue',4],['expenditure',5],['net_balance',6],
    ['real_balance',8],['annual_balance',9],['reserve_fund',10],
    ['reserve_fund_withdrawal',12],['real_annual_balance',13]]){
    const v=g(r,94);if(v!==null)m[k]=v;
  }
  for(const[k,r]of[['revenue_prev',4],['expenditure_prev',5],
    ['real_balance_prev',8],['annual_balance_prev',9]]){
    const v=g(r,104);if(v!==null)m[k]=v;
  }

  // 財政指標（col95(94)）── 固定
  for(const[k,r]of[
    ['base_fiscal_income',33],['base_fiscal_demand',34],
    ['standard_tax_revenue',35],['standard_fiscal_scale',36],
    ['fiscal_strength_index',37],['real_surplus_ratio',38],['debt_service_ratio',39],
    ['real_debt_ratio',42],['future_burden_ratio',43],
    ['reserve_financial_adj',44],['reserve_debt_redemption',45],['reserve_specific',46],
    ['local_bond_outstanding',49],
  ]){const v=g(r,94);if(v!==null&&typeof v==='number')m[k]=v;}

  // 経常収支比率：動的検出
  const cerRow=detectCerRow(sheet);
  const cer=g(cerRow,40);if(cer!==null&&typeof cer==='number')m.current_expenditure_ratio=cer;

  // ラスパイレス指数 (row23, col94 = CQ)
  const las=g(23,94); if(num(las)!==null)m.laspeyres_index=las;

  // 職員（固定）
  const emps=[];
  for(const[r,label]of[[16,'一般職員'],[18,'うち技能労務職員'],[19,'警察官'],[20,'教育公務員']]){
    const cnt=g(r,94);if(cnt===null)continue;
    const e={label,count:cnt};
    const sal=g(r,99);if(num(sal)!==null)e.salary_total_100yen=sal;
    const avg=g(r,105);if(num(avg)!==null)e.avg_salary_100yen=avg;
    emps.push(e);
  }
  if(emps.length)m.employees=emps;

  // 歳入明細（動的スキャン）
  const revDet=[];
  for(const[row,label,indent]of buildRevenueRows(sheet)){
    const amt=g(row,12);if(amt===null)continue;
    const e={label,amount:amt};
    if(indent)e.indent=indent;
    const pct=g(row,20);if(num(pct)!==null)e.pct=pct;
    const gen=g(row,25);if(num(gen)!==null)e.general_revenue=gen;
    revDet.push(e);
  }
  if(revDet.length)m.revenue_detail=revDet;

  // 歳出性質別（基準行から相対オフセット）
  const expNBase=detectExpNatureBase(sheet);
  const expNTotalRow=detectExpNatureTotalRow(sheet,expNBase);

  // 経常経費充当一般財源等計 (base+18, col33) & 歳入一般財源等計 (歳出合計行, col33)
  const rgr=g(expNBase+18,33); if(num(rgr)!==null)m.regular_general_revenue=rgr;
  const tgr=g(expNTotalRow,33); if(num(tgr)!==null)m.total_general_revenue=tgr;
  // 繰出金 = base+12, col12
  const pio=g(expNBase+12,12); if(num(pio)!==null)m.payout_total=pio;

  const expN=[];
  for(const[off,label]of EXP_NATURE_OFFSETS){
    const row=expNBase+off;
    const amt=g(row,12);if(amt===null)continue;
    const e={label,amount:amt};
    const pct=g(row,20);if(num(pct)!==null)e.pct=pct;
    const alloc=g(row,25);if(num(alloc)!==null)e.alloc_general=alloc;
    const curr=g(row,33);if(num(curr)!==null)e.current_alloc=curr;
    const ratio=g(row,41);if(num(ratio)!==null)e.current_ratio=ratio;
    expN.push(e);
  }
  // 歳出合計（動的行）
  {
    const amt=g(expNTotalRow,12);
    if(amt!==null){
      const e={label:'歳出合計',amount:amt};
      const pct=g(expNTotalRow,20);if(num(pct)!==null)e.pct=pct;
      const alloc=g(expNTotalRow,25);if(num(alloc)!==null)e.alloc_general=alloc;
      expN.push(e);
    }
  }
  if(expN.length)m.expenditure_by_nature=expN;

  // 歳出目的別（基準行から相対オフセット）
  const expPBase=detectExpPurposeBase(sheet);
  const expPTotalRow=detectExpPurposeTotalRow(sheet);
  const expP=[];
  for(const[off,label]of EXP_PURPOSE_OFFSETS){
    const row=expPBase+off;
    const amt=g(row,55);if(amt===null)continue;
    const e={label,amount:amt};
    const pct=g(row,62);if(num(pct)!==null)e.pct=pct;
    const pw=g(row,68);if(num(pw)!==null)e.public_works=pw;
    expP.push(e);
  }
  // 歳出合計（動的行）
  if(expPTotalRow>=0){
    const amt=g(expPTotalRow,55);
    if(amt!==null){
      const e={label:'歳出合計',amount:amt};
      const pct=g(expPTotalRow,62);if(num(pct)!==null)e.pct=pct;
      expP.push(e);
    }
  }
  if(expP.length)m.expenditure_by_purpose=expP;

  // 道府県税（固定行 + 合計行動的）
  const taxTotalRow=detectTaxTotalRow(sheet);
  const taxRows=[...TAX_ROWS_FIXED,[taxTotalRow,'道府県税合計','合計']];
  // ヘッダー行スキャンで構成比・超過課税列を動的検出
  let prefTaxPctCol=62, prefTaxExtCol=67; // 都道府県: pct=BK(62), ext header=BQ(68)→data=BP(67)
  for(let r=7;r<=13;r++){
    for(let c=55;c<=75;c++){
      const v=gc(sheet,r,c);
      if(typeof v!=='string')continue;
      const vn=v.replace(/\s+/g,'');
      if(vn.includes('構成比')&&!vn.includes('経常'))prefTaxPctCol=c;
      if(vn.includes('超過課税'))prefTaxExtCol=c-1; // ヘッダーはデータ列の1列右にある
    }
  }
  const taxDet=[];
  for(const[row,fallbackLabel,tax1]of taxRows){
    const amt=g(row,55);if(amt===null)continue;
    // ラベルをExcelから動的読取 (col45→44→43→42の順、深いインデントを優先)
    const dynLbl=g(row,45)||g(row,44)||g(row,43)||g(row,42)||null;
    const label=dynLbl!=null?String(dynLbl):fallbackLabel;
    const pct=g(row,prefTaxPctCol);
    const ext=g(row,prefTaxExtCol);
    taxDet.push({label,tax1,amount:amt,pct,
      extra_tax:(num(ext)!==null&&ext>0)?ext:null});
  }
  if(taxDet.length){
    const tot=taxDet.find(t=>t.tax1==='合計');
    const totAmt=tot?.amount||0;
    if(totAmt>0){
      taxDet.forEach(t=>{if(t.pct===null&&t.amount!=null)t.pct=+(t.amount/totAmt*100).toFixed(1);});
    }
    m.tax_detail=taxDet;
    if(tot)m.local_tax=tot.amount;
  }

  m.unit='千円';
  return Object.fromEntries(
    Object.entries(m).filter(([,v])=>v!==null&&!(Array.isArray(v)&&!v.length))
  );
}

// ── 1ファイル処理 ──────────────────────────────────────────────
function processExcel(excelPath){
  const wb=XLSX.readFile(excelPath,{type:'file',cellText:false,cellDates:false});
  const sheetNames=wb.SheetNames.filter(n=>n!=='目次');
  const year=yearArg||detectYear(wb.Sheets[sheetNames[0]])||path.basename(excelPath,'.xlsx');
  console.log(`  [都道府県 ${year}] ${sheetNames.length}シート処理中...`);

  const municipalities={};
  let errCount=0;
  for(const sname of sheetNames){
    const sheet=wb.Sheets[sname];
    const prefName=detectPrefName(sheet,sname);
    try{
      municipalities[prefName]=extractPref(sheet,prefName);
      const mm=municipalities[prefName];
      console.log(`  ✓ ${prefName.padEnd(6)}  歳入=${String(mm.revenue||0).padStart(15)}  歳出=${String(mm.expenditure||0).padStart(15)}`);
    }catch(e){console.log(`  ✗ ${prefName}: ${e.message}`);errCount++;}
  }
  return{
    dataset:{
      label:`都道府県決算カード ${year}`,
      fiscal_year:year,
      prefecture:'全国（都道府県）',
      source:`総務省 ${year} 都道府県決算カード`,
      municipalities,
    },
    prefCount:Object.keys(municipalities).length,
    errCount,
  };
}

// ── メイン ────────────────────────────────────────────────────
if(!fs.existsSync(dirArg)){console.error(`エラー: ${dirArg} が見つかりません`);process.exit(1);}
const excelFiles=fs.readdirSync(dirArg).filter(f=>f.endsWith('.xlsx')).sort().map(f=>path.join(dirArg,f));
if(!excelFiles.length){console.error('Excelファイルが見つかりません。');process.exit(1);}
if(!fs.existsSync(outDirArg))fs.mkdirSync(outDirArg,{recursive:true});

console.log(`対象ファイル数: ${excelFiles.length}`);
const allDatasets=[],results=[],startTime=Date.now();

for(let i=0;i<excelFiles.length;i++){
  const ep=excelFiles[i];
  const base=path.basename(ep,'.xlsx');
  const jp=path.join(outDirArg,base+'.json');
  console.log(`\n[${i+1}/${excelFiles.length}] ${path.basename(ep)}`);
  if(skipExist&&fs.existsSync(jp)){
    console.log(`  スキップ（既存）`);
    const ds=JSON.parse(fs.readFileSync(jp,'utf8'));
    allDatasets.push(ds);
    results.push({file:path.basename(ep),status:'skipped',prefs:Object.keys(ds.municipalities||{}).length});
    continue;
  }
  try{
    const{dataset,prefCount,errCount}=processExcel(ep);
    fs.writeFileSync(jp,JSON.stringify(dataset,null,2),'utf8');
    allDatasets.push(dataset);
    results.push({file:path.basename(ep),status:errCount?`warn(${errCount}err)`:'ok',prefs:prefCount});
    console.log(`  → ${path.basename(jp)}  (${prefCount}都道府県)`);
  }catch(e){
    console.log(`  ✗ ${e.message}`);
    results.push({file:path.basename(ep),status:'error',prefs:0});
  }
}

if(allDatasets.length){
  fs.writeFileSync(allArg,JSON.stringify(allDatasets),'utf8');
  const kb=Math.round(fs.statSync(allArg).size/1024);
  console.log(`\n統合JSON: ${allArg}  (${allDatasets.length}データセット, ${kb.toLocaleString()} KB)`);
}
const elapsed=((Date.now()-startTime)/1000).toFixed(1);
const ok=results.filter(r=>['ok','skipped'].includes(r.status)).length;
const errs=results.filter(r=>r.status==='error').length;
console.log(`\n${'='.repeat(50)}`);
console.log(`完了  ${elapsed}秒  成功:${ok}  エラー:${errs}  合計:${results.reduce((s,r)=>s+r.prefs,0)}都道府県`);
console.log('='.repeat(50));
