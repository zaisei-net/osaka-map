#!/usr/bin/env node
/**
 * 市区町村決算状況調 Excel → JSON 変換スクリプト（Node.js版）
 * ==============================================================
 * 【セットアップ（初回のみ）】  npm install xlsx
 * 【使い方】
 *   node extract_municipal.js <Excelファイル>
 *   node extract_municipal.js 000998974.xlsx --out osaka_r5.json
 *   node extract_municipal.js 000998974.xlsx --pref 大阪府 --year 2023
 */

const XLSX = require('xlsx');
const fs   = require('fs');
const path = require('path');

const args = process.argv.slice(2);
if (!args.length || args[0]==='--help') {
  console.log('使い方: node extract_municipal.js <Excelファイル> [--out file] [--pref 都道府県] [--year 年度]');
  process.exit(0);
}
function getArg(flag,def=null){const i=args.indexOf(flag);return i>=0&&args[i+1]?args[i+1]:def;}

const excelPath  = args[0];
const forcedPref = getArg('--pref');
const forcedYear = getArg('--year');
const outArg     = getArg('--out');

if (!fs.existsSync(excelPath)) { console.error(`エラー: ${excelPath}`); process.exit(1); }

// ── セル位置定数 ────────────────────────────────────────
const COL_R5=92, COL_PREV=102, COL_IDX=96;

// ── 定義テーブル ─────────────────────────────────────────
// 【行番号について】g(row,col) の row は 0-based。実際のExcelセル行 = row+1。
// 全年度（H28〜R5）で同一レイアウト。歳入明細のみ年度により行が増減するため動的検索。

// 歳出性質別（行47-70 → 0-based:46-69、値 col13/0-based:12）
const EXP_NATURE_ROWS = [
  [46,'人件費'],[47,'　うち職員給'],[48,'扶助費'],[49,'公債費'],
  [50,'　元金'],[51,'　利子'],[52,'　一時借入金利子'],
  [53,'(義務的経費計)'],[54,'物件費'],[55,'維持補修費'],
  [56,'補助費等'],[57,'　うち一部事務組合負担金'],
  [58,'繰出金'],[59,'積立金'],[60,'投資・出資金・貸付金'],
  [61,'前年度繰上充用金'],
  [62,'投資的経費'],[63,'　うち人件費'],[64,'　普通建設事業費'],
  [65,'　　うち補助'],[66,'　　うち単独'],
  [67,'　災害復旧事業費'],[68,'　失業対策事業費'],
  [69,'歳出合計'],
];

// 歳出目的別（ラベル col49/0-based:48、値 col58/0-based:57）
const EXP_PURPOSE_ROWS = [
  [47,'議会費'],[48,'総務費'],[49,'民生費'],[50,'衛生費等'],
  [51,'労働費'],[52,'農林水産業費'],[53,'商工費'],[54,'土木費'],
  [55,'消防費'],[56,'教育費'],[57,'災害復旧費'],[58,'公債費'],
  [59,'諸支出金'],[60,'前年度繰上充用金'],[61,'歳出合計'],
];

// 市町村税（ラベル col39/0-based:38、値 col49/0-based:48）
const TAX_ROWS = [
  [18,'個人均等割','普通税'],[19,'所得割','普通税'],
  [20,'法人均等割','普通税'],[21,'法人税割','普通税'],
  [17,'市町村民税 計','小計'],
  [22,'固定資産税','普通税'],[23,'うち純固定資産税','普通税'],
  [24,'軽自動車税','普通税'],[25,'市町村たばこ税','普通税'],
  [26,'鉱産税','普通税'],[27,'特別土地保有税','普通税'],
  [28,'法定外普通税','普通税'],
  [15,'普通税 計','小計'],
  [31,'入湯税','目的税'],[32,'事業所税','目的税'],
  [33,'都市計画税','目的税'],[34,'水利地益税等','目的税'],
  [35,'法定外目的税','目的税'],[36,'旧法による税','目的税'],
  [29,'目的税 合計','小計'],
  [37,'合計','合計'],
];

// 公営企業（ラベル col51/0-based:50、値 col58/0-based:57）
const PUBLIC_ENT_ROWS = [
  [64,'下水道'],[65,'病院'],[66,'交通'],[67,'市場'],
  [68,'国民健康保険'],[69,'その他'],
];

const EMPLOYEE_ROWS = [
  [22,'一般職員'],[23,'うち消防職員'],[24,'うち技能労務員'],[25,'教育公務員'],
];

// ── 歳入明細の動的行マッピング ───────────────────────────
const REVENUE_LABELS = [
  ['地方税','地方税',0],['地方譲与税','地方譲与税',0],
  ['利子割交付金','利子割交付金',0],['配当割交付金','配当割交付金',0],
  ['株式等譲渡所得割交付金','株式等譲渡所得割交付金',0],
  ['分離課税所得割交付金','分離課税所得割交付金',0],
  ['地方消費税交付金','地方消費税交付金',0],
  ['ゴルフ場利用税交付金','ゴルフ場利用税交付金',0],
  ['特別地方消費税交付金','特別地方消費税交付金',0],
  ['自動車取得税交付金','自動車取得税交付金',0],
  ['軽油引取税交付金','軽油引取税交付金',0],
  ['自動車税環境性能割交付金','自動車税環境性能割交付金',0],
  ['法人事業税交付金','法人事業税交付金',0],
  ['地方特例交付金等','地方特例交付金等',0],
  ['地方特例交付金','　地方特例交付金',1],
  ['新型コロナ','　新型コロナウイルス感染症対策地方税減収補塡特別交付金',1],
  ['地方交付税','地方交付税',0],
  ['普通交付税','　普通交付税',1],['特別交付税','　特別交付税',1],
  ['震災復興特別交付税','　震災復興特別交付税',1],
  ['(一般財源計)','(一般財源計)',0],
  ['交通安全対策特別交付金','交通安全対策特別交付金',0],
  ['分担金','分担金・負担金',0],
  ['使用料','使用料',0],['手数料','手数料',0],['国庫支出金','国庫支出金',0],
  ['国有提供交付金','国有提供交付金',0],['(特別区財調交付金)','(特別区財調交付金)',0],
  ['都道府県支出金','都道府県支出金',0],['財産収入','財産収入',0],['寄附金','寄附金',0],
  ['繰入金','繰入金',0],['繰越金','繰越金',0],['諸収入','諸収入',0],
  ['地方債','地方債',0],
  ['うち減収補塡債','　うち減収補塡債(特例分)',1],
  ['うち臨時財政対策債','　うち臨時財政対策債',1],
  ['歳入合計','歳入合計',0],
];

function buildRevenueRows(sheet) {
  const rowMap = {};
  for (let r = 9; r <= 45; r++) {
    const v2 = gc(sheet, r, 1);
    const v3 = gc(sheet, r, 2);
    const lbl = (typeof v2 === 'string' ? v2 : '') || (typeof v3 === 'string' ? v3 : '');
    if (lbl) rowMap[r] = lbl.replace(/\s+/g, '');
  }
  const result = [];
  for (const [matchKey, outLabel, indent] of REVENUE_LABELS) {
    const normalized = matchKey.replace(/\s+/g, '');
    for (const [r, lbl] of Object.entries(rowMap)) {
      if (lbl.includes(normalized)) {
        result.push([parseInt(r), outLabel, indent]);
        break;
      }
    }
  }
  return result;
}

// ── ユーティリティ ─────────────────────────────────────
function colToLetter(col){
  let r='',c=col;
  while(c>=0){r=String.fromCharCode(65+(c%26))+r;c=Math.floor(c/26)-1;}
  return r;
}
function clean(val){
  if(val===undefined||val===null) return null;
  const s=String(val).trim();
  if(['-','','nan','NaN','None','－'].includes(s)) return null;
  const n=Number(s);
  if(!isNaN(n)) return Number.isInteger(n)?n:Math.round(n*10000)/10000;
  return s;
}
function gc(sheet,row,col){
  const cell=sheet[`${colToLetter(col)}${row+1}`];
  return cell?clean(cell.v):null;
}
function num(v){return typeof v==='number'?v:null;}

// ── 1自治体データ抽出 ──────────────────────────────────
function extractMunicipality(sheet, name) {
  const g=(r,c)=>gc(sheet,r,c);
  const m = { name };

  // 基本情報
  const fields = {
    pop_r2:[1,28], pop_r2_h27:[2,28], pop_change_pct:[3,28],
    area:[4,28], density:[5,28], mtype:[1,104],
    pop_juki_r6:[3,41], pop_juki_r6_jp:[3,49], pop_juki_r5:[4,41],
  };
  for(const[k,[r,c]] of Object.entries(fields)){const v=g(r,c);if(v!==null)m[k]=v;}

  // 収支（当年度）
  const r5 = {
    revenue:10,expenditure:11,net_balance:12,real_balance:14,
    annual_balance:15,reserve_fund:16,reserve_fund_rollover:18,real_annual_balance:19,
  };
  for(const[k,r] of Object.entries(r5)){const v=g(r,COL_R5);if(v!==null)m[k]=v;}

  // 前年度収支
  for(const[k,r] of [['revenue_prev',10],['expenditure_prev',11],
    ['real_balance_prev',14],['annual_balance_prev',15]]){
    const v=g(r,COL_PREV);if(v!==null)m[k]=v;
  }

  // ── 財政指標セクション：ヘッダー行を動的検索してオフセットで取得 ──────
  // 年度によって歳入明細の行数が変わるため、絶対行番号は使えない。
  // col=96 に「○年度(千円)」というヘッダー行があり、そこからの相対位置で取得。
  // R5確認値(下川町): ヘッダー=row48  R3確認値(札幌市): ヘッダー=row51
  let hdr = -1;
  for(let r=40;r<=60;r++){
    const v=gc(sheet,r,COL_IDX);
    if(typeof v==='string'&&v.includes('年度')&&v.includes('千円')){hdr=r;break;}
  }
  if(hdr>=0){
    // オフセット定義（両年度で実測確認済み）
    const OFFSETS=[
      ['base_fiscal_demand',   2, COL_IDX],  // 基準財政需要額
      ['base_fiscal_income',   3, COL_IDX],  // 基準財政収入額
      ['standard_tax_revenue', 4, COL_IDX],  // 標準税収入額等
      ['standard_fiscal_scale',5, COL_IDX],  // 標準財政規模
      ['fiscal_strength_index',6, COL_IDX],  // 財政力指数
      ['real_surplus_ratio',   7, COL_IDX],  // 実質収支比率
      ['debt_service_ratio',   8, COL_IDX],  // 公債費負担比率
      // +9,+10 = 空白行
      ['real_debt_ratio',     11, COL_IDX],  // 実質公債費比率
      ['future_burden_ratio', 12, COL_IDX],  // 将来負担比率
      ['reserve_financial_adj',  13, COL_IDX], // 財政調整基金残高
      ['reserve_debt_redemption',14, COL_IDX], // 減債基金残高
      ['reserve_specific',       15, COL_IDX], // その他特定目的基金残高
      ['local_bond_outstanding', 16, COL_IDX], // 地方債現在高
      ['debt_commit_purchase',   17, COL_IDX], // 債務負担行為（物件購入等）
      ['debt_commit_guarantee',  18, COL_IDX], // 債務負担行為（債務保証）
      ['debt_commit_other',      19, COL_IDX], // 債務負担行為（その他）
      ['laspeyres_index',        23, COL_IDX], // ラスパイレス指数
      // 徴収率 col=96/100
      ['collection_rate_total',   25, COL_IDX],
      ['collection_rate_current', 25, 100],
      ['collection_rate_muni_tax',27, COL_IDX],
      ['collection_rate_property',28, COL_IDX],
    ];
    for(const[k,off,col] of OFFSETS){
      const v=gc(sheet,hdr+off,col);
      if(v!==null&&typeof v==='number')m[k]=v;
    }

    // 経常収支比率: ヘッダー+22, col=36
    const cer=gc(sheet,hdr+22,36);if(cer!==null&&typeof cer==='number')m.current_expenditure_ratio=cer;

    // 経常一般財源等: ヘッダー+20, col=33
    const rgr=gc(sheet,hdr+20,33);if(rgr!==null&&typeof rgr==='number')m.regular_general_revenue=rgr;

    // 歳入一般財源等: ヘッダー+26, col=33
    const tgr=gc(sheet,hdr+26,33);if(tgr!==null&&typeof tgr==='number')m.total_general_revenue=tgr;

    // 繰出金合計: ヘッダー+15, col=57
    const pt=gc(sheet,hdr+15,57);if(pt!==null&&typeof pt==='number')m.payout_total=pt;
  }

  // 歳入明細（動的行マッピング）
  const revDet=[];
  const revenueRows=buildRevenueRows(sheet);
  for(const[row,label,indent] of revenueRows){
    const amt=g(row,12),pct=g(row,20),gen=g(row,24),gpct=g(row,32);
    if(amt===null&&pct===null)continue;
    const e={label,amount:amt,pct};
    if(indent)e.indent=indent;
    if(num(gen)!==null)e.general_revenue=gen;
    if(num(gpct)!==null)e.general_revenue_pct=gpct;
    revDet.push(e);
  }
  if(revDet.length)m.revenue_detail=revDet.filter(r=>r.amount!==null);

  // 歳出性質別（行47-70 → 0-based:46-69、値 col13/21/25/33/43）
  const expN=[];
  for(const[row,label] of EXP_NATURE_ROWS){
    const amt=g(row,12),pct=g(row,20),alloc=g(row,24),curr=g(row,32),ratio=g(row,42);
    if(amt===null&&pct===null)continue;
    const e={label,amount:amt,pct};
    if(num(alloc)!==null)e.alloc_general=alloc;
    if(num(curr)!==null)e.current_alloc=curr;
    if(num(ratio)!==null)e.current_ratio=ratio;
    expN.push(e);
  }
  if(expN.length)m.expenditure_by_nature=expN.filter(r=>r.amount!==null);

  // 歳出目的別（ラベル col49/0-based:48、値 col58/0-based:57、alloc col78/0-based:77）
  const expP=[];
  for(const[row,label] of EXP_PURPOSE_ROWS){
    const amt=g(row,57),pct=g(row,64),pw=g(row,69),alloc=g(row,77);
    if(amt===null&&pct===null)continue;
    const e={label,amount:amt,pct};
    if(num(pw)!==null)e.public_works=pw;
    if(num(alloc)!==null)e.alloc_general=alloc;
    expP.push(e);
  }
  if(expP.length)m.expenditure_by_purpose=expP.filter(r=>r.amount!==null);

  // 市町村税：ヘッダー行スキャンで構成比・超過課税列を動的検出（年度レイアウトずれ対策）
  let taxPctCol=57, taxExtCol=61;
  for(let r=11;r<=16;r++){
    for(let c=50;c<=68;c++){
      const v=gc(sheet,r,c);
      if(typeof v!=='string')continue;
      const vn=v.replace(/\s+/g,'');
      if(vn.includes('構成比')&&!vn.includes('経常'))taxPctCol=c;
      if(vn.includes('超過課税'))taxExtCol=c-1; // ヘッダーはデータ列の1列右にある
    }
  }
  const taxDet=[];
  for(const[row,label,tax1] of TAX_ROWS){
    const amt=g(row,48),pct=g(row,taxPctCol),ext=g(row,taxExtCol);
    if(amt===null&&pct===null)continue;
    taxDet.push({label,tax1,amount:amt,pct,
      extra_tax:(num(ext)!==null&&ext>0)?ext:null});
  }
  const validTax=taxDet.filter(t=>t.amount!==null);
  if(validTax.length){
    const tot=validTax.find(t=>t.tax1==='合計');
    const totAmt=tot?.amount||0;
    if(totAmt>0){
      validTax.forEach(t=>{if(t.pct===null)t.pct=+(t.amount/totAmt*100).toFixed(1);});
    }
    m.tax_detail=validTax;
    if(tot)m.local_tax=tot.amount;
  }

  // 公営事業等繰出（ラベル col51/0-based:50、値 col58/0-based:57）
  const pubEnt=[];
  for(const[row,label] of PUBLIC_ENT_ROWS){
    const amt=g(row,57);
    if(amt!==null)pubEnt.push({label,amount:amt});
  }
  if(pubEnt.length)m.public_enterprises=pubEnt;

  // 職員
  const emps=[];
  for(const[row,label] of EMPLOYEE_ROWS){
    const cnt=g(row,92),sal=g(row,97),avg=g(row,103);
    if(cnt===null)continue;
    const e={label,count:cnt};
    if(num(sal)!==null)e.salary_total_100yen=sal;
    if(num(avg)!==null)e.avg_salary_100yen=avg;
    emps.push(e);
  }
  if(emps.length)m.employees=emps;

  m.unit='千円';

  return Object.fromEntries(Object.entries(m).filter(([,v])=>v!==null&&!(Array.isArray(v)&&!v.length)));
}

// ── メタ検出 ────────────────────────────────────────────
function detectMeta(sheet){
  let pref=null,year=null;
  for(let ri=4;ri<10&&!pref;ri++)
    for(let ci=75;ci<82;ci++){
      const v=gc(sheet,ri,ci);
      if(typeof v==='string'&&/[府県都道]$/.test(v)){pref=v;break;}
    }
  for(let ri=0;ri<5&&!year;ri++){
    const v=gc(sheet,ri,3);
    if(typeof v==='string'&&v.includes('年度')){year=v;break;}
  }
  return{pref:pref||'',year:year||''};
}

// ── メイン ──────────────────────────────────────────────
console.log(`読み込み中: ${path.basename(excelPath)}`);
const wb=XLSX.readFile(excelPath,{type:'file',cellText:false,cellDates:false});
const sheetNames=wb.SheetNames.filter(n=>n!=='目次');
console.log(`対象シート数: ${sheetNames.length}`);

const firstSheet=wb.Sheets[sheetNames[0]];
const{pref:dp,year:dy}=detectMeta(firstSheet);
const pref=forcedPref||dp, year=forcedYear||dy;
console.log(`都道府県: ${pref}  年度: ${year}`);

const municipalities={};
for(const sname of sheetNames){
  const muniName=sname.replace(/^\d+/,'');
  try{
    const m=extractMunicipality(wb.Sheets[sname],muniName);
    municipalities[muniName]=m;
    console.log(`  ✓ ${muniName.padEnd(10)} 歳出=${String(m.expenditure||0).padStart(16)}  歳入明細=${(m.revenue_detail||[]).length}件`);
  }catch(e){console.log(`  ✗ ${muniName}: ${e.message}`);}
}

const label=[pref,year].filter(Boolean).join(' ')||path.basename(excelPath,'.xlsx');
const dataset={label,fiscal_year:year,prefecture:pref,
  source:`総務省 ${year} 市町村決算状況調（${pref}）`,municipalities};

const outPath=outArg||`${(pref+'_'+year).replace(/\s/g,'_')}.json`;
fs.writeFileSync(outPath,JSON.stringify(dataset,null,2),'utf8');
console.log(`\n完了: ${Object.keys(municipalities).length}自治体 → ${outPath}`);
console.log(`ファイルサイズ: ${fs.statSync(outPath).size.toLocaleString()} bytes`);
