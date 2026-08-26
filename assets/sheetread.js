// © შპს მარტივადი — Elastic License 2.0 (იხ. LICENSE)
/* ============================================================================
   sheetread.js — .xlsx და .xls (BIFF8/OLE2) წამკითხველი, გარე ბიბლიოთეკის გარეშე.
   აბრუნებს: {sheets:[{name, rows:[[cell,...]]}]}   cell = string | number | Date | null
   ========================================================================== */
/* ES module */
const SR = (() => {
'use strict';

const dec = new TextDecoder('utf-8');
const u16 = (b,o)=>b[o]|(b[o+1]<<8);
const u32 = (b,o)=>(b[o]|(b[o+1]<<8)|(b[o+2]<<16)|(b[o+3]<<24))>>>0;

/* ---------- ექსელის სერიული თარიღი ---------- */
function serialToDate(v){
  if(!(v>0) || v>2958466) return null;
  const ms = Math.round((v - 25569) * 86400000);
  return new Date(ms);
}

/* ============================== XLSX ============================== */
async function inflateRaw(bytes){
  const ds = new DecompressionStream('deflate-raw');
  const s = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(s).arrayBuffer());
}

async function unzip(buf){
  const b = new Uint8Array(buf);
  // End of central directory
  let eo = -1;
  for(let i=b.length-22;i>=0 && i>b.length-70000;i--){ if(u32(b,i)===0x06054b50){ eo=i; break; } }
  if(eo<0) throw new Error('ZIP: EOCD ვერ მოიძებნა');
  const n = u16(b,eo+10), cdOff = u32(b,eo+16);
  const out = {};
  let p = cdOff;
  for(let k=0;k<n;k++){
    if(u32(b,p)!==0x02014b50) break;
    const method=u16(b,p+10), csize=u32(b,p+20), nameLen=u16(b,p+28),
          extraLen=u16(b,p+30), cmtLen=u16(b,p+32), lho=u32(b,p+42);
    const name = dec.decode(b.subarray(p+46, p+46+nameLen));
    const lNameLen=u16(b,lho+26), lExtra=u16(b,lho+28);
    const dataOff = lho+30+lNameLen+lExtra;
    out[name] = {method, data:b.subarray(dataOff, dataOff+csize)};
    p += 46+nameLen+extraLen+cmtLen;
  }
  return {
    async get(name){
      const e = out[name]; if(!e) return null;
      return e.method===0 ? e.data : await inflateRaw(e.data);
    },
    names(){ return Object.keys(out); }
  };
}

function xmlDoc(bytes){
  return new DOMParser().parseFromString(dec.decode(bytes), 'application/xml');
}
/* პრეფიქსის მიუხედავად (<row> და <x:row> ერთნაირად) */
const tags = (node, name) => node.getElementsByTagNameNS('*', name);

/* თარიღის ფორმატის ამოცნობა: ჯერ ფრჩხილებში ჩასმული ფერი/ლოკალი
   ([Red], [Black], [$-409]) და ბრჭყალებში ჩასმული ტექსტი იშლება */
const DATE_IDS = new Set([...Array(9).keys()].map(i=>i+14)
  .concat([...Array(10).keys()].map(i=>i+27), [45,46,47],
          [...Array(9).keys()].map(i=>i+50)));
function isDateCode(code){
  if(!code) return false;
  const c = String(code).replace(/\[[^\]]*\]/g,'').replace(/"[^"]*"/g,'').replace(/\\./g,'');
  return /[ymdhs]/i.test(c);
}
const isDateFmtId = (id, custom) => DATE_IDS.has(id) || isDateCode(custom && custom.get(id));
function colToIdx(ref){
  let n=0; for(const ch of ref){ const c=ch.charCodeAt(0); if(c<65||c>90) break; n=n*26+(c-64); }
  return n-1;
}

async function readXlsx(buf){
  const z = await unzip(buf);
  // shared strings
  let sst = [];
  const ssBytes = await z.get('xl/sharedStrings.xml');
  if(ssBytes){
    const d = xmlDoc(ssBytes);
    sst = [...tags(d, 'si')].map(si=>
      [...tags(si, 't')].map(t=>t.textContent).join(''));
  }
  // date-formatted styles
  const dateStyles = new Set();
  const stBytes = await z.get('xl/styles.xml');
  if(stBytes){
    const d = xmlDoc(stBytes);
    const custom = new Map();
    [...tags(d, 'numFmt')].forEach(f=>
      custom.set(+f.getAttribute('numFmtId'), f.getAttribute('formatCode')||''));
    const xf = tags(d, 'cellXfs')[0];
    if(xf) [...tags(xf, 'xf')].forEach((x,i)=>{
      if(isDateFmtId(+x.getAttribute('numFmtId')||0, custom)) dateStyles.add(i); });
  }
  // workbook sheet names → rId → file
  const wbBytes = await z.get('xl/workbook.xml');
  const relBytes = await z.get('xl/_rels/workbook.xml.rels');
  const rel = {};
  if(relBytes) [...tags(xmlDoc(relBytes), 'Relationship')]
    .forEach(r=>rel[r.getAttribute('Id')] = r.getAttribute('Target').replace(/^\/?xl\//,''));
  const sheets = [];
  const names = wbBytes ? [...tags(xmlDoc(wbBytes), 'sheet')] : [];
  for(let i=0;i<names.length;i++){
    const nm = names[i].getAttribute('name');
    const rid = names[i].getAttribute('r:id') || names[i].getAttributeNS(
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships','id');
    const path = 'xl/' + (rel[rid] || `worksheets/sheet${i+1}.xml`);
    const sb = await z.get(path) || await z.get(`xl/worksheets/sheet${i+1}.xml`);
    if(!sb){ sheets.push({name:nm, rows:[]}); continue; }
    const d = xmlDoc(sb);
    const rows = [];
    for(const row of tags(d, 'row')){
      const r = (+row.getAttribute('r') || rows.length+1) - 1;
      const arr = rows[r] = rows[r] || [];
      for(const c of tags(row, 'c')){
        const ref = c.getAttribute('r')||'';
        const ci = ref ? colToIdx(ref) : arr.length;
        const t = c.getAttribute('t');
        const sIdx = +c.getAttribute('s')||0;
        let v = null;
        if(t==='inlineStr'){
          v = [...tags(c, 't')].map(x=>x.textContent).join('');
        } else {
          const vEl = tags(c, 'v')[0];
          const raw = vEl ? vEl.textContent : null;
          if(raw===null) v=null;
          else if(t==='s') v = sst[+raw] ?? '';
          else if(t==='str' || t==='e') v = raw;
          else if(t==='b') v = raw==='1';
          else { const num = +raw;
                 v = dateStyles.has(sIdx) ? (serialToDate(num) ?? num) : num; }
        }
        arr[ci] = v;
      }
    }
    for(let i2=0;i2<rows.length;i2++) rows[i2] = rows[i2] || [];
    sheets.push({name:nm, rows});
  }
  return {sheets};
}

/* ============================== XLS (OLE2 + BIFF8) ============================== */
function cfbRead(buf){
  const b = new Uint8Array(buf);
  const sectorShift = u16(b,30), miniShift = u16(b,32);
  const secSize = 1<<sectorShift, miniSize = 1<<miniShift;
  const nDifat = u32(b,72), firstDifat = u32(b,68);
  const sect = i => b.subarray(512+i*secSize, 512+(i+1)*secSize);

  // FAT
  const fatSects = [];
  for(let i=0;i<109;i++){ const s=u32(b,76+i*4); if(s<0xFFFFFFFA) fatSects.push(s); }
  let dif = firstDifat, guard=0;
  while(dif<0xFFFFFFFA && guard++<1000){
    const s = sect(dif);
    for(let i=0;i<secSize/4-1;i++){ const v=u32(s,i*4); if(v<0xFFFFFFFA) fatSects.push(v); }
    dif = u32(s, secSize-4);
  }
  const fat = new Uint32Array(fatSects.length*secSize/4);
  fatSects.forEach((fs,k)=>{ const s=sect(fs); for(let i=0;i<secSize/4;i++) fat[k*secSize/4+i]=u32(s,i*4); });

  const chain = start => { const out=[]; let c=start, g=0;
    while(c<0xFFFFFFFA && g++<1e6){ out.push(c); c=fat[c]; } return out; };
  const readChain = (start,size) => {
    const cs = chain(start), out = new Uint8Array(cs.length*secSize);
    cs.forEach((c,i)=>out.set(sect(c), i*secSize));
    return size!=null ? out.subarray(0,size) : out;
  };

  // directory
  const dirStart = u32(b,48);
  const dirBytes = readChain(dirStart);
  const entries = [];
  for(let o=0;o+128<=dirBytes.length;o+=128){
    const nameLen = u16(dirBytes,64);
    if(!nameLen) continue;
    let nm=''; for(let i=0;i<nameLen-2;i+=2) nm += String.fromCharCode(u16(dirBytes,o+i));
    entries.push({name:nm, type:dirBytes[o+66], start:u32(dirBytes,o+116), size:u32(dirBytes,o+120)});
  }
  // re-read names at correct offsets
  entries.length = 0;
  for(let o=0;o+128<=dirBytes.length;o+=128){
    const nameLen = u16(dirBytes,o+64);
    let nm=''; for(let i=0;i+1<Math.max(0,nameLen-2);i+=2) nm += String.fromCharCode(u16(dirBytes,o+i));
    entries.push({name:nm, type:dirBytes[o+66], start:u32(dirBytes,o+116), size:u32(dirBytes,o+120)});
  }
  const root = entries.find(e=>e.type===5);
  const miniStream = root && root.size ? readChain(root.start, root.size) : new Uint8Array(0);
  // mini FAT
  const miniFatStart = u32(b,60);
  const mfBytes = miniFatStart<0xFFFFFFFA ? readChain(miniFatStart) : new Uint8Array(0);
  const miniFat = new Uint32Array(mfBytes.length/4);
  for(let i=0;i<miniFat.length;i++) miniFat[i]=u32(mfBytes,i*4);

  const readEntry = e => {
    if(e.size >= 4096) return readChain(e.start, e.size);
    const out = new Uint8Array(e.size); let c=e.start, off=0, g=0;
    while(c<0xFFFFFFFA && off<e.size && g++<1e6){
      const n = Math.min(miniSize, e.size-off);
      out.set(miniStream.subarray(c*miniSize, c*miniSize+n), off);
      off += n; c = miniFat[c];
    }
    return out;
  };
  return {entries, readEntry};
}

function biffString(b, o, lenChars){
  const flags = b[o];
  const hi = flags & 1, rich = (flags>>3)&1, ext = (flags>>2)&1;
  let p = o+1;
  let rt=0, sz=0;
  if(rich){ rt = u16(b,p); p+=2; }
  if(ext){ sz = u32(b,p); p+=4; }
  let s='';
  if(hi){ for(let i=0;i<lenChars;i++) s += String.fromCharCode(u16(b,p+i*2)); p += lenChars*2; }
  else  { for(let i=0;i<lenChars;i++) s += String.fromCharCode(b[p+i]); p += lenChars; }
  p += rt*4 + sz;
  return {s, next:p};
}

function rkToNum(rk){
  let v;
  if(rk & 0x02) v = rk >> 2;
  else { const buf = new ArrayBuffer(8), dv = new DataView(buf);
         dv.setUint32(0, (rk & 0xFFFFFFFC) >>> 0);   // მაღალი 32 ბიტი
         dv.setUint32(4, 0);
         v = dv.getFloat64(0); }
  return (rk & 0x01) ? v/100 : v;
}

function readXls(buf){
  const cfb = cfbRead(buf);
  const e = cfb.entries.find(x=>x.name==='Workbook'||x.name==='Book');
  if(!e) throw new Error('XLS: Workbook ნაკადი ვერ მოიძებნა');
  const b = cfb.readEntry(e);

  /* --- 1. ჩანაწერების სია (CONTINUE-ს შერწყმით SST-ისთვის) --- */
  const recs = [];
  let p = 0;
  while(p+4 <= b.length){
    const id = u16(b,p), len = u16(b,p+2);
    recs.push({id, off:p+4, len});
    p += 4+len;
  }

  /* --- 2. SST --- */
  let sst = [];
  const sIdx = recs.findIndex(r=>r.id===0x00FC);
  if(sIdx>=0){
    // SST + მომდევნო CONTINUE-ები ერთ ბუფერად
    const parts=[recs[sIdx]];
    for(let i=sIdx+1;i<recs.length && recs[i].id===0x003C;i++) parts.push(recs[i]);
    let total=0; parts.forEach(r=>total+=r.len);
    const flat = new Uint8Array(total); let o=0;
    const bounds=[];
    parts.forEach(r=>{ flat.set(b.subarray(r.off,r.off+r.len), o); bounds.push(o); o+=r.len; });
    const count = u32(flat,4);
    let q = 8;
    for(let i=0;i<count && q<flat.length;i++){
      const lenChars = u16(flat,q);
      const flags = flat[q+2];
      const hi = flags & 1;
      // CONTINUE-ის საზღვარზე გადასვლა: სტრიქონი შეიძლება გაიყოს
      const need = 3 + (hi ? lenChars*2 : lenChars);
      if(q+need <= flat.length && !((flags>>3)&1) && !((flags>>2)&1)){
        const r = biffString(flat, q+2, lenChars);
        sst.push(r.s); q = r.next;
      } else {
        const r = biffString(flat, q+2, lenChars);
        sst.push(r.s); q = r.next;
      }
    }
  }

  /* --- 3. ფურცლები --- */
  const bound = recs.filter(r=>r.id===0x0085).map(r=>{
    const pos = u32(b,r.off);
    const nameLen = b[r.off+6];
    const st = biffString(b, r.off+7, nameLen);
    return {pos, name:st.s};
  });

  /* --- 4. სტილები: თარიღის ფორმატები --- */
  const fmtCode = new Map();
  recs.filter(r=>r.id===0x041E).forEach(r=>{
    const id = u16(b,r.off), len = u16(b,r.off+2);
    fmtCode.set(id, biffString(b, r.off+4, len).s);
  });
  const xfDate = [];
  recs.filter(r=>r.id===0x00E0).forEach(r=>xfDate.push(isDateFmtId(u16(b,r.off+2), fmtCode)));

  /* --- 5. თითო ფურცლის უჯრები --- */
  const boundsByPos = bound.map(x=>x.pos).sort((a,c)=>a-c);
  const sheets = bound.map(sh=>{
    const rows = [];
    const set = (r,c,v)=>{ (rows[r] = rows[r]||[])[c] = v; };
    // ამ ფურცლის BOF-იდან შემდეგ BOF-მდე
    let start = recs.findIndex(rr=>rr.off-4===sh.pos);
    if(start<0) start = recs.findIndex(rr=>rr.id===0x0809 && rr.off-4>=sh.pos);
    for(let i=start+1;i<recs.length;i++){
      const r = recs[i];
      if(r.id===0x000A) break;                       // EOF
      const o = r.off;
      switch(r.id){
        case 0x00FD: {                               // LABELSST
          set(u16(b,o), u16(b,o+2), sst[u32(b,o+6)] ?? ''); break; }
        case 0x0204: {                               // LABEL
          const len=u16(b,o+6); set(u16(b,o), u16(b,o+2), biffString(b,o+8,len).s); break; }
        case 0x0203: {                               // NUMBER
          const dv=new DataView(b.buffer, b.byteOffset+o+6, 8);
          const n=dv.getFloat64(0,true), xf=u16(b,o+4);
          set(u16(b,o), u16(b,o+2), xfDate[xf] ? (serialToDate(n)??n) : n); break; }
        case 0x027E: {                               // RK
          const n=rkToNum(u32(b,o+6)|0), xf=u16(b,o+4);
          set(u16(b,o), u16(b,o+2), xfDate[xf] ? (serialToDate(n)??n) : n); break; }
        case 0x00BD: {                               // MULRK
          const row=u16(b,o), c1=u16(b,o+2);
          const n=(r.len-6)/6;
          for(let k=0;k<n;k++){
            const xf=u16(b,o+4+k*6), v=rkToNum(u32(b,o+6+k*6)|0);
            set(row, c1+k, xfDate[xf] ? (serialToDate(v)??v) : v);
          } break; }
        case 0x0006: {                               // FORMULA
          const dv=new DataView(b.buffer, b.byteOffset+o+6, 8);
          if(b[o+12]===0xFF && b[o+13]===0xFF){
            if(b[o+6]===0){                          // შედეგი სტრიქონია → STRING
              const nx = recs[i+1];
              if(nx && nx.id===0x0207){
                const len=u16(b,nx.off);
                set(u16(b,o), u16(b,o+2), biffString(b,nx.off+2,len).s);
              }
            }
          } else {
            const n=dv.getFloat64(0,true), xf=u16(b,o+4);
            set(u16(b,o), u16(b,o+2), xfDate[xf] ? (serialToDate(n)??n) : n);
          } break; }
      }
    }
    for(let i=0;i<rows.length;i++) rows[i]=rows[i]||[];
    return {name:sh.name, rows};
  });
  return {sheets};
}

/* ============================== CSV ============================== */
function readCsv(text){
  const sep = (text.split('\n')[0].match(/;/g)||[]).length >
              (text.split('\n')[0].match(/,/g)||[]).length ? ';' : ',';
  const rows=[]; let row=[], cur='', q=false;
  const t = text.replace(/^﻿/,'');
  for(let i=0;i<t.length;i++){
    const ch=t[i];
    if(q){ if(ch==='"'){ if(t[i+1]==='"'){cur+='"';i++;} else q=false; } else cur+=ch; }
    else if(ch==='"') q=true;
    else if(ch===sep){ row.push(cur); cur=''; }
    else if(ch==='\n'){ row.push(cur); rows.push(row); row=[]; cur=''; }
    else if(ch!=='\r') cur+=ch;
  }
  if(cur||row.length){ row.push(cur); rows.push(row); }
  return {sheets:[{name:'CSV', rows:rows.map(r=>r.map(v=>{
    const s=v.trim(); if(s==='') return null;
    const n=+s.replace(/\s/g,'').replace(',','.');
    return (s!=='' && isFinite(n) && /^[-+]?[\d\s.,]+$/.test(s)) ? n : s;
  }))}]};
}

/* ============================== entry ============================== */
async function read(file){
  const name = (file.name||'').toLowerCase();
  if(name.endsWith('.csv')) return readCsv(await file.text());
  const buf = await file.arrayBuffer();
  const h = new Uint8Array(buf, 0, 8);
  if(h[0]===0x50 && h[1]===0x4B) return await readXlsx(buf);
  if(h[0]===0xD0 && h[1]===0xCF) return readXls(buf);
  return readCsv(await file.text());
}

return {read, readXlsx, readXls, readCsv, serialToDate, unzip};
})();
export default SR;
export const { read, readXlsx, readXls, readCsv } = SR;
