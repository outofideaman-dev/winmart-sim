import assert from 'node:assert/strict';
import fs from 'node:fs';
import {WinMartEngine} from './core.mjs';

const checks=[];
function check(name,fn){fn();checks.push({name,passed:true});console.log('PASS',name);}
function fixture(policy='V6_2_BASELINE'){
 const e=new WinMartEngine({dispatchPolicy:policy,fefoMode:policy==='V6_2_BASELINE'?'STRICT_FEFO':'WINDOW_FEFO'});
 const pool=[...e.pallets.values()].filter(p=>p.skuCode===e.skuCodes[0]).slice(0,3);
 pool.forEach((p,i)=>{p.cartons=[10,30,30][i];p.allocatedCartons=0;p.job=null;p.expiry=['2027-01-01','2027-01-05','2027-01-09'][i];});
 e.eligibleSourcePallets=sku=>sku==='MISSING'?[]:pool;
 e.anyStockRemainingForSku=()=>false;
 const pp={id:'TEST',orderId:'TEST',dispatchMode:'MIXED_PALLET',lines:[{lineNo:1,skuCode:e.skuCodes[0],qtyCartons:20,minShelfLifeDays:0}]};
 return {e,pool,pp};
}
check('STRICT_FEFO exhausts earliest lot then uses next lot without counting WINDOW choice',()=>{
 const {e,pp}=fixture();assert.equal(e.allocateSourcesForPlannedPallet(pp).ok,true);
 assert.equal(pp.allocations.length,2);assert.equal(e.metrics.windowFefoOptimizations,0);assert.equal(e.metrics.strictFefoPicks,2);
 assert.deepEqual(pp.allocations.map(a=>a.earliestAvailableExpiry),['2027-01-01','2027-01-05']);
});
check('WINDOW_FEFO counts a genuine choice while earlier eligible stock remains',()=>{
 const {e,pp}=fixture('V6_2_PROPOSED');assert.equal(e.allocateSourcesForPlannedPallet(pp).ok,true);
 assert.equal(e.metrics.windowFefoOptimizations,1);assert.equal(pp.allocations[0].windowChoice,true);
});
check('Failed multi-line allocation does not commit KPI increments or reservations',()=>{
 const {e,pool,pp}=fixture('V6_2_PROPOSED');pp.lines.push({lineNo:2,skuCode:'MISSING',qtyCartons:10});
 assert.equal(e.allocateSourcesForPlannedPallet(pp).ok,false);assert.equal(e.metrics.windowFefoOptimizations,0);assert.equal(e.metrics.strictFefoPicks,0);
 assert.ok(pool.every(p=>p.allocatedCartons===0));
});
check('WINDOW_FEFO re-anchors after exhausting early stock and never skips outside the new window',()=>{
 const {e,pool,pp}=fixture('V6_2_PROPOSED');
 pool.forEach((p,i)=>p.expiry=['2027-01-01','2027-05-15','2027-08-30'][i]);
 pp.lines[0].qtyCartons=40;
 assert.equal(e.allocateSourcesForPlannedPallet(pp,e.locations.get(pool[2].location).x).ok,true);
 assert.deepEqual(pp.allocations.map(a=>a.sourcePalletId),[pool[0].id,pool[1].id]);
 assert.equal(e.metrics.windowFefoOptimizations,0);
});
check('QC base norm and slow scenario change human times only',()=>{
 const a=new WinMartEngine({}),b=new WinMartEngine({humanMultiplier:1.25});
 assert.equal(a.config.qcWrapSeconds,60);assert.equal(b.config.qcWrapSeconds*b.config.humanMultiplier,75);
 for(const k of ['rtPickDropBaseSec','rtLiftSecPerMeter','cpPickSec','cpDropSec','cpTruckDropSec','shiftHandoverCheckSeconds'])assert.equal(a.config[k],b.config[k]);
});
fs.writeFileSync(new URL('data/verification_metrics.json',import.meta.url),JSON.stringify({checks,passedChecks:checks.length,totalChecks:checks.length},null,2));
