
import React, { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import { format, parse, isSameMonth } from "date-fns";
import { de } from "date-fns/locale";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Badge, Tabs, TabsContent, TabsList, TabsTrigger, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea } from "./ui";
import { Save, FileDown, CheckCircle2, XCircle, AlertTriangle, Settings2, CalendarDays, Home, PlusCircle, FileSignature, Smartphone, Bot, Upload } from "lucide-react";

import * as pdfjs from "pdfjs-dist";
import Tesseract from "tesseract.js";
pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.js`;

/** @typedef {{id:string; name:string; address:string}} Property */
/** @typedef {{id:string; propertyId:string; label:string; rooms:number}} Unit */
/** @typedef {{id:string; unitId:string; tenantName:string; tenantIban:string; expected:number; dueDay:number; reference?:string; startDate?:string; endDate?:string; deposit?:number}} Contract */
/** @typedef {{date:Date; amount:number; name?:string; iban?:string; reference?:string}} Tx */

const uid = () => Math.random().toString(36).slice(2, 9);
const parseNumber = (v) => { if (typeof v === "number") return v; if (!v) return NaN; const s=String(v).trim().replace(/\./g,"").replace(",","."); const n=Number(s); return Number.isFinite(n)?n:NaN; };
const tryParseDate = (v) => { if (v instanceof Date && !isNaN(v)) return v; if (typeof v!=="string") return new Date(NaN); const s=v.trim(); const fmts=["dd.MM.yyyy","yyyy-MM-dd","dd.MM.yy","dd/MM/yyyy","MM/dd/yyyy"]; for (const f of fmts){ const d=parse(s,f,new Date()); if(!isNaN(d)) return d;} return new Date(s); };
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;

function parseEuro(s){ const m=String(s).replace(/\./g,'').replace(',','.').match(/-?\d+(?:\.\d+)?/); return m? Number(m[0]) : NaN; }
function parseDateDE(s){ const m=String(s).match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/); if(!m) return null; let [_,d,mo,y]=m; if(y.length===2) y='20'+y; return new Date(`${y}-${mo}-${d}`); }

const DEFAULT_MAPPING = {
  fields: {
    tenantName: { anchor: "Mieter(?:in)?|Name Mieter", take: "lineAfter" },
    rent: { anchor: "(?:Kalt)?Miete(?: monatlich)?|Miete gesamt", take: "sameLineNumber", num: "euro" },
    deposit: { anchor: "Kaution|Sicherheitsleistung", take: "sameLineNumber", num: "euro" },
    startDate: { anchor: "Mietbeginn|Beginn des Mietverh\\u00e4ltnisses", take: "sameLineDate", date: "de" },
    roomLabel: { anchor: "Zimmernummer|Zimmer|Wohnung|Whg", take: "sameLineText" },
    iban: { anchor: "IBAN", take: "sameLineText" }
  }
};

function extractWithMapping(text, mapping){
  const lines = text.split(/\\r?\\n/).map(l=>l.trim()).filter(Boolean);
  const grab = (anchor, how) => {
    const idx = lines.findIndex(l => new RegExp(anchor, 'i').test(l));
    if (idx === -1) return null;
    if (how === 'lineAfter') return lines[idx+1]||null;
    if (how === 'sameLineNumber') return parseEuro(lines[idx]);
    if (how === 'sameLineDate') return parseDateDE(lines[idx]);
    if (how === 'sameLineText') return lines[idx].replace(new RegExp(anchor, 'i'), '').replace(/[:\\-\\s]+$/,'').trim();
    return null;
  };
  const f = mapping.fields;
  const start = grab(f.startDate.anchor, f.startDate.take);
  return {
    tenantName: grab(f.tenantName.anchor, f.tenantName.take) || '',
    expected: grab(f.rent.anchor, f.rent.take) || 0,
    deposit: grab(f.deposit.anchor, f.deposit.take) || 0,
    startDate: start ? start.toISOString?.()?.slice(0,10) : null,
    unitLabel: grab(f.roomLabel.anchor, f.roomLabel.take) || '',
    iban: grab(f.iban.anchor, f.iban.take) || ''
  };
}

export default function MietCheckerApp(){
  const [properties, setProperties] = useState([]);
  const [units, setUnits] = useState([]);
  const [contracts, setContracts] = useState([]);
  const [txs, setTxs] = useState([]);

  const [selectedMonth, setSelectedMonth] = useState(() => monthKey(new Date()));
  const [graceDays, setGraceDays] = useState(3);
  const [amountTolerance, setAmountTolerance] = useState(2);
  const [settings, setSettings] = useState(()=>{ try { return JSON.parse(localStorage.getItem('mc-settings')||'{}'); } catch { return {}; } });

  useEffect(()=>{ const raw=localStorage.getItem('mc-data'); if(raw){ try{ const s=JSON.parse(raw); setProperties(s.properties||[]); setUnits(s.units||[]); setContracts(s.contracts||[]); setTxs((s.txs||[]).map(t=>({...t,date:new Date(t.date)}))); }catch{} } },[]);
  useEffect(()=>{ localStorage.setItem('mc-data', JSON.stringify({properties,units,contracts,txs})); },[properties,units,contracts,txs]);
  useEffect(()=>{ localStorage.setItem('mc-settings', JSON.stringify(settings||{})); },[settings]);

  const tenants = useMemo(()=> contracts.map(c=>{ const u = units.find(x=>x.id===c.unitId); const p = u? properties.find(pp=>pp.id===u.propertyId):undefined; return { name: c.tenantName, iban: c.tenantIban, expected: c.expected, dueDay: c.dueDay, reference: c.reference || (p? `Miete ${p.name}`: "Miete"), propertyName: p?.name, unitLabel: u?.label }; }), [contracts, units, properties]);

  const { monthDate, matches, missing, partial, overpaid } = useMemo(()=>{
    const [year, m] = selectedMonth.split("-").map(Number); const monthDate = new Date(year, m-1, 1);
    const monthTxs = txs.filter(tx=> isSameMonth(tx.date, monthDate));
    const normalize = (s)=> (s||"").toLowerCase().replace(/\\s+/g," ").trim();
    const matches = tenants.map(ten=>{
      const due = new Date(year, m-1, Math.min(ten.dueDay + graceDays, 28));
      const lo = ten.expected - amountTolerance, hi = ten.expected + amountTolerance;
      const candidate = monthTxs.find(tx=>{ const ok = tx.amount<0 && -tx.amount>=lo && -tx.amount<=hi; if(!ok) return false; const ibanOk = ten.iban && tx.iban && ten.iban.replace(/\\s+/g,"")===tx.iban.replace(/\\s+/g,""); const r1=normalize(ten.reference), r2=normalize(tx.reference); const n1=normalize(ten.name), n2=normalize(tx.name); const refOk = r1 && r2 && (r2.includes(r1)||r1.includes(r2)); const nameOk = n1 && n2 && (n2.includes(n1)||n1.includes(n2)); return ibanOk || refOk || nameOk;});
      let status = "missing", info = "Keine Zahlung gefunden"; if(candidate){ const amt=-candidate.amount; if(Math.abs(amt-ten.expected)<=amountTolerance){ status="ok"; info=`Bezahlt am ${format(candidate.date,"dd.MM.yyyy",{locale:de})} (${amt.toFixed(2)} €)`; } else if(amt < ten.expected){ status="partial"; info=`Teilzahlung ${amt.toFixed(2)} € (erwartet ${ten.expected.toFixed(2)} €)`; } else { status="over"; info=`Überzahlung ${amt.toFixed(2)} € (erwartet ${ten.expected.toFixed(2)} €)`; } }
      return { tenant: ten, tx: candidate, status, info, due };
    });
    const missing = matches.filter(m=>m.status==="missing"), partial = matches.filter(m=>m.status==="partial"), overpaid = matches.filter(m=>m.status==="over");
    return { monthDate, matches, missing, partial, overpaid };
  }, [selectedMonth, txs, tenants, graceDays, amountTolerance]);

  const [txHeaders, setTxHeaders] = useState([]);
  const [txMap, setTxMap] = useState({ date: "date", amount: "amount", name: "name", iban: "iban", reference: "reference" });
  const onUploadTxs = (file) => {
    Papa.parse(file, { header:true, skipEmptyLines:true, complete:(res)=>{
      const rows = res.data||[]; if(rows.length) setTxHeaders(Object.keys(rows[0]));
      const t = rows.map(r=>({ date: tryParseDate(r[txMap.date]), amount: parseNumber(r[txMap.amount]), name: r[txMap.name]?.toString()?.trim(), iban: r[txMap.iban]?.toString()?.replace(/\\s+/g, ""), reference: r[txMap.reference]?.toString()?.trim() })).filter(x=>!isNaN(x.date)&&Number.isFinite(x.amount));
      setTxs(t);
    }});
  };

  const downloadCsv = (rows, name) => { const csv = Papa.unparse(rows); const blob = new Blob([csv], {type:"text/csv;charset=utf-8;"}); const url = URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download=name; a.click(); URL.revokeObjectURL(url); };
  const exportOpen = () => downloadCsv(missing.map(({tenant,due})=>({ property: tenant.propertyName||"-", unit: tenant.unitLabel||"-", name: tenant.name, iban: tenant.iban, expected: tenant.expected, dueDay: tenant.dueDay, month: format(monthDate,"MM.yyyy"), dueUntil: format(due,"dd.MM.yyyy"), reference: tenant.reference||"" })), `offene-mieten-${selectedMonth}.csv`);
  const exportAll = () => downloadCsv(matches.map(({tenant,tx,status,info})=>({ property: tenant.propertyName||"-", unit: tenant.unitLabel||"-", tenant: tenant.name, iban: tenant.iban, expected: tenant.expected, status, info, tx_date: tx? format(tx.date,"dd.MM.yyyy"):"", tx_amount: tx? tx.amount: "", tx_name: tx?.name||"", tx_reference: tx?.reference||"" })), `mietabgleich-${selectedMonth}.csv`);

  const rentLabel = settings?.rentLabel || "Miete";

  return (
    <div>
      <header style={{display:'flex', gap:12, alignItems:'flex-end', justifyContent:'space-between', marginBottom:12}}>
        <div>
          <h1 style={{fontSize:24, fontWeight:700}}>Miet‑Checker PRO (PWA + KI)</h1>
          <p className="muted">Installierbar · Offline · KI‑Vertragsimport (PDF/Scan)</p>
        </div>
        <div style={{display:'flex', gap:8, alignItems:'center'}}>
          <div style={{display:'flex', gap:6, alignItems:'center'}}>
            <CalendarDays size={16} />
            <Select value={selectedMonth} onValueChange={setSelectedMonth}>
              <SelectTrigger><SelectValue placeholder="Monat"/></SelectTrigger>
              <SelectContent>
                {Array.from({length:13}).map((_,i)=>{ const d=new Date(); d.setMonth(d.getMonth()-i); const key=monthKey(d); return <SelectItem key={key} value={key}>{format(d, "MMMM yyyy", {locale:de})}</SelectItem>; })}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" onClick={exportOpen}><FileDown size={16}/>Offene als CSV</Button>
          <Button onClick={exportAll}><Save size={16}/>Abgleich exportieren</Button>
        </div>
      </header>

      <Tabs defaultValue="kiimport">
        <TabsList>
          <TabsTrigger value="objekte">Objekte & Zimmer</TabsTrigger>
          <TabsTrigger value="vertraege">Verträge</TabsTrigger>
          <TabsTrigger value="bank">Bankdaten</TabsTrigger>
          <TabsTrigger value="uebersicht">Übersicht</TabsTrigger>
          <TabsTrigger value="kiimport"><Bot size={16}/>Verträge importieren (KI)</TabsTrigger>
          <TabsTrigger value="einstellungen"><Settings2 size={16}/>Einstellungen</TabsTrigger>
        </TabsList>

        <TabsContent value="objekte"><ObjectsUnitsSection properties={properties} setProperties={setProperties} units={units} setUnits={setUnits} /></TabsContent>
        <TabsContent value="vertraege"><ContractsSection units={units} properties={properties} contracts={contracts} setContracts={setContracts} rentLabel={rentLabel} /></TabsContent>
        <TabsContent value="bank"><BankSection txHeaders={txHeaders} txMap={txMap} setTxMap={setTxMap} onUploadTxs={onUploadTxs} /></TabsContent>
        <TabsContent value="uebersicht"><OverviewSection matches={matches} missing={missing} partial={partial} overpaid={overpaid} selectedMonth={selectedMonth} /></TabsContent>
        <TabsContent value="kiimport"><KiImportSection units={units} properties={properties} setContracts={setContracts} /></TabsContent>
        <TabsContent value="einstellungen"><SettingsSection graceDays={graceDays} amountTolerance={amountTolerance} setGraceDays={setGraceDays} setAmountTolerance={setAmountTolerance} settings={settings} setSettings={setSettings} /></TabsContent>
      </Tabs>
    </div>
  );
}

function ObjectsUnitsSection({ properties, setProperties, units, setUnits }){
  const [propSel, setPropSel] = useState('');
  return (
    <div className="grid md:grid-cols-2 gap-6" style={{display:'grid', gap:16, gridTemplateColumns:'1fr'}}>
      <Card>
        <CardHeader><CardTitle>Objekt anlegen</CardTitle><CardDescription>Adresse optional</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div style={{display:'grid', gap:12}}>
            <div><Label>Objektname</Label><Input id="prop-name" placeholder="Haus Müllerstr. 10"/></div>
            <div><Label>Adresse</Label><Input id="prop-addr" placeholder="Straße, PLZ Ort"/></div>
          </div>
          <Button onClick={()=>{ const name=(document.getElementById('prop-name') as HTMLInputElement).value?.trim(); const addr=(document.getElementById('prop-addr') as HTMLInputElement).value?.trim(); if(!name) return; setProperties((p:any[])=>[...p,{id:uid(), name, address:addr||""}]); (document.getElementById('prop-name') as HTMLInputElement).value=""; (document.getElementById('prop-addr') as HTMLInputElement).value=""; }}>Hinzufügen</Button>
          <Table className="mt-4"><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Adresse</TableHead><TableHead>Einheiten</TableHead></TableRow></TableHeader><TableBody>{properties.map((p:any)=> (<TableRow key={p.id}><TableCell>{p.name}</TableCell><TableCell className="text-sm muted">{p.address||"–"}</TableCell><TableCell>{units.filter((u:any)=>u.propertyId===p.id).length}</TableCell></TableRow>))}</TableBody></Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Zimmer/Einheit anlegen</CardTitle><CardDescription>Bezeichnung & Zimmerzahl</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div style={{display:'grid', gap:12}}>
            <div><Label>Objekt</Label>
              <Select id="unit-prop" value={propSel} onValueChange={setPropSel}>
                <SelectTrigger><SelectValue placeholder="Objekt wählen"/></SelectTrigger>
                <SelectContent>
                  {properties.map((p:any)=> <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div><Label>Bezeichnung</Label><Input id="unit-label" placeholder="Whg 3 links / Zi 2"/></div>
            <div><Label>Zimmer</Label><Input id="unit-rooms" type="number" min={1} defaultValue={1}/></div>
          </div>
          <Button onClick={()=>{ const label=(document.getElementById('unit-label') as HTMLInputElement).value?.trim(); const rooms=Number((document.getElementById('unit-rooms') as HTMLInputElement).value||1); if(!propSel||!label) return; setUnits((u:any[])=>[...u,{id:uid(), propertyId:propSel, label, rooms: rooms||1}]); (document.getElementById('unit-label') as HTMLInputElement).value=""; (document.getElementById('unit-rooms') as HTMLInputElement).value="1"; }}>Hinzufügen</Button>
          <Table className="mt-4"><TableHeader><TableRow><TableHead>Objekt</TableHead><TableHead>Einheit</TableHead><TableHead>Zimmer</TableHead></TableRow></TableHeader><TableBody>{units.map((u:any)=>{ const p=properties.find((pp:any)=>pp.id===u.propertyId); return (<TableRow key={u.id}><TableCell>{p?.name||"-"}</TableCell><TableCell>{u.label}</TableCell><TableCell>{u.rooms}</TableCell></TableRow>); })}</TableBody></Table>
        </CardContent>
      </Card>
    </div>
  );
}

function ContractsSection({ units, properties, contracts, setContracts, rentLabel }){
  const [cUnit, setCUnit] = useState('');
  return (
    <Card>
      <CardHeader><CardTitle>Mietvertrag hinzufügen</CardTitle><CardDescription>Mieter:in einer Einheit zuordnen</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <div style={{display:'grid', gap:12}}>
          <div><Label>Einheit</Label>
            <Select id="c-unit" value={cUnit} onValueChange={setCUnit}>
              <SelectTrigger><SelectValue placeholder="Einheit wählen"/></SelectTrigger>
              <SelectContent>{units.map((u:any)=>{ const p=properties.find((pp:any)=>pp.id===u.propertyId); return <SelectItem key={u.id} value={u.id}>{(p?.name||"?")+" — "+u.label}</SelectItem>; })}</SelectContent>
            </Select>
          </div>
          <div><Label>Mietername</Label><Input id="c-name" placeholder="Vor- und Nachname"/></div>
          <div><Label>IBAN</Label><Input id="c-iban" placeholder="DE.."/></div>
          <div><Label>{rentLabel} (€)</Label><Input id="c-expected" type="number" min={0} step="0.5"/></div>
          <div><Label>Fälligkeit (Tag)</Label><Input id="c-dueday" type="number" min={1} max={28} defaultValue={3}/></div>
          <div><Label>Verwendungszweck</Label><Input id="c-ref" placeholder="z. B. Miete Whg 3"/></div>
          <div><Label>Start</Label><Input id="c-start" type="date"/></div>
          <div><Label>Ende (optional)</Label><Input id="c-end" type="date"/></div>
          <div><Label>Kaution (€, optional)</Label><Input id="c-dep" type="number" min={0} step="0.5"/></div>
        </div>
        <Button onClick={()=>{ const name=(document.getElementById('c-name') as HTMLInputElement).value?.trim(); const iban=(document.getElementById('c-iban') as HTMLInputElement).value?.replace(/\\s+/g,""); const expected=parseNumber((document.getElementById('c-expected') as HTMLInputElement).value); const dueDay=Number((document.getElementById('c-dueday') as HTMLInputElement).value||3); const reference=(document.getElementById('c-ref') as HTMLInputElement).value?.trim(); const startDate=(document.getElementById('c-start') as HTMLInputElement).value; const endDate=(document.getElementById('c-end') as HTMLInputElement).value; const deposit=parseNumber((document.getElementById('c-dep') as HTMLInputElement).value); if(!cUnit||!name||!iban||!Number.isFinite(expected)) return; setContracts((cs:any[])=>[...cs,{id:uid(), unitId:cUnit, tenantName:name, tenantIban:iban, expected, dueDay, reference, startDate, endDate, deposit}]); ['c-name','c-iban','c-expected','c-dueday','c-ref','c-start','c-end','c-dep'].forEach(id=>{ const el=document.getElementById(id) as HTMLInputElement|null; if(el) el.value=""; }); }}>Vertrag speichern</Button>
        <Table className="mt-4"><TableHeader><TableRow><TableHead>Objekt</TableHead><TableHead>Einheit</TableHead><TableHead>Mieter</TableHead><TableHead>{rentLabel}</TableHead><TableHead>Fälligkeit</TableHead></TableRow></TableHeader><TableBody>{contracts.map((c:any)=>{ const u=units.find((x:any)=>x.id===c.unitId); const p=properties.find((pp:any)=>pp.id===u?.propertyId); return (<TableRow key={c.id}><TableCell>{p?.name||"-"}</TableCell><TableCell>{u?.label||"-"}</TableCell><TableCell>{c.tenantName}</TableCell><TableCell>{Number(c.expected).toFixed(2)} €</TableCell><TableCell>{c.dueDay}.</TableCell></TableRow>); })}</TableBody></Table>
      </CardContent>
    </Card>
  );
}

function BankSection({ txHeaders, txMap, setTxMap, onUploadTxs }){
  return (
    <Card>
      <CardHeader><CardTitle>Bankumsätze importieren</CardTitle><CardDescription>CSV-Export deiner Bank (Einnahmen meist als negative Beträge)</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <Label htmlFor="txs">CSV-Datei</Label>
        <Input id="txs" type="file" accept=".csv" onChange={(e)=> e.target.files && onUploadTxs(e.target.files[0])} />
        {txHeaders.length>0 && (
          <div style={{display:'grid', gap:10, gridTemplateColumns:'1fr 1fr'}}>
            {Object.keys(txMap).map((key)=> (
              <div key={key} style={{display:'flex', flexDirection:'column', gap:6}}>
                <Label>{key}</Label>
                <Select value={txMap[key]} onValueChange={(v)=> setTxMap((m:any)=>({...m, [key]: v}))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{txHeaders.map((h)=> (<SelectItem key={h} value={h}>{h}</SelectItem>))}</SelectContent>
                </Select>
              </div>
            ))}
          </div>
        )}
        <div style={{display:'flex', gap:8}}>
          <Button variant="outline" onClick={()=>{ const sample=`date,amount,name,iban,reference\\n2025-08-03,-950,Max Mustermann,DE02100100109307118603,Miete Max August\\n2025-08-06,-720,Erika Musterfrau,DE12500105170648489890,Miete Erika August`; const blob=new Blob([sample],{type:"text/csv"}); const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download="bank-beispiel.csv"; a.click(); URL.revokeObjectURL(url); }}><FileDown size={16}/>Beispiel-CSV</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function OverviewSection({ matches, missing, partial, overpaid, selectedMonth }){
  return (
    <Card>
      <CardHeader><CardTitle>Übersicht</CardTitle><CardDescription>Abgleich für {format(new Date(selectedMonth+"-01"), "MMMM yyyy", {locale:de})}</CardDescription></CardHeader>
      <CardContent>
        <div style={{display:'flex', gap:8, flexWrap:'wrap', paddingBottom:12}}>
          <Badge>OK: {matches.filter((m:any)=>m.status==="ok").length}</Badge>
          <Badge>Offen: {missing.length}</Badge>
          <Badge>Teilzahlungen: {partial.length}</Badge>
          <Badge>Überzahlungen: {overpaid.length}</Badge>
        </div>
        <Table>
          <TableHeader><TableRow><TableHead>Objekt</TableHead><TableHead>Einheit</TableHead><TableHead>Mieter</TableHead><TableHead>Erwartet (€)</TableHead><TableHead>Status</TableHead><TableHead>Info</TableHead></TableRow></TableHeader>
          <TableBody>{matches.map(({ tenant, status, info }:any, i:number)=> (
            <TableRow key={i}>
              <TableCell>{tenant.propertyName || "-"}</TableCell>
              <TableCell>{tenant.unitLabel || "-"}</TableCell>
              <TableCell style={{fontWeight:600}}>{tenant.name}</TableCell>
              <TableCell>{tenant.expected.toFixed(2)}</TableCell>
              <TableCell>
                {status==="ok" && <span style={{display:'inline-flex', alignItems:'center', gap:6}}><CheckCircle2 size={16}/>Bezahlt</span>}
                {status==="missing" && <span style={{display:'inline-flex', alignItems:'center', gap:6}}><XCircle size={16}/>Offen</span>}
                {status==="partial" && <span style={{display:'inline-flex', alignItems:'center', gap:6}}><AlertTriangle size={16}/>Teilzahlung</span>}
                {status==="over" && <span style={{display:'inline-flex', alignItems:'center', gap:6}}><CheckCircle2 size={16}/>Überzahlung</span>}
              </TableCell>
              <TableCell style={{fontSize:14}} className="muted">{info}</TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function SettingsSection({ graceDays, amountTolerance, setGraceDays, setAmountTolerance, settings, setSettings }){
  return (
    <Card>
      <CardHeader><CardTitle>Einstellungen</CardTitle><CardDescription>Fälligkeit, Toleranzen & Anzeigenamen</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <div style={{display:'grid', gap:12, gridTemplateColumns:'1fr 1fr 1fr'}}>
          <div><Label>Nachfrist (Tage)</Label><Input type="number" min={0} max={10} value={graceDays} onChange={(e)=> setGraceDays(Number((e.target as HTMLInputElement).value)||0)}/></div>
          <div><Label>Betrags‑Toleranz (€)</Label><Input type="number" min={0} step="0.5" value={amountTolerance} onChange={(e)=> setAmountTolerance(Number((e.target as HTMLInputElement).value)||0)}/></div>
          <div><Label>Anzeigename für Miete</Label><Input value={settings?.rentLabel||"Miete"} onChange={(e)=> setSettings({...settings, rentLabel: (e.target as HTMLInputElement).value})} /></div>
        </div>
      </CardContent>
    </Card>
  );
}

function KiImportSection({ units, properties, setContracts }){
  const [mappingText, setMappingText] = useState(JSON.stringify(DEFAULT_MAPPING, null, 2));
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);

  async function readPdfText(file: File){
    const data = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data }).promise;
    let full = '';
    for (let p=1; p<=pdf.numPages; p++){
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const pageText = (content.items as any[]).map(it=> (it as any).str).join('\\n');
      full += pageText + '\\n';
    }
    return full.trim();
  }

  async function ocrPdfFirstPage(file: File){
    const data = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data }).promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    canvas.width = viewport.width; canvas.height = viewport.height;
    await page.render({ canvasContext: ctx as any, viewport }).promise;
    const { data: ocr } = await (Tesseract as any).recognize(canvas, 'deu');
    return (ocr as any).text || '';
  }

  const onFiles = async (files: File[]) => {
    setBusy(true);
    try{
      const map = JSON.parse(mappingText);
      const previews: any[] = [];
      for (const file of files){
        let text = '';
        if (file.type === 'application/pdf'){
          text = await readPdfText(file);
          if (!text || text.length < 30){
            text = await ocrPdfFirstPage(file);
          }
        } else if (file.type.startsWith('text/')){
          text = await file.text();
        }
        const extracted = extractWithMapping(text, map);
        const label = extracted.unitLabel?.trim();
        let unit: any = null;
        if (label){
          unit = units.find((u:any)=> u.label.toLowerCase() === label.toLowerCase())
              || units.find((u:any)=> label.toLowerCase().includes(u.label.toLowerCase()))
              || null;
        }
        previews.push({ fileName: (file as any).name, textLength: text.length, extracted, matchedUnit: unit });
      }
      setResults(previews);
    }catch(e: any){
      alert('Mapping ist kein gültiges JSON: '+ e.message);
    } finally { setBusy(false); }
  };

  const commitAll = () => {
    const ok = results.filter((r:any)=> r.matchedUnit && r.extracted.tenantName && r.extracted.expected);
    if (ok.length === 0){ alert('Keine verwertbaren Einträge gefunden.'); return; }
    setContracts((cs:any[])=> [
      ...cs,
      ...ok.map(({ matchedUnit, extracted }:any) => ({
        id: uid(), unitId: matchedUnit.id, tenantName: extracted.tenantName, tenantIban: extracted.iban||'', expected: Number(extracted.expected)||0, dueDay: 3, reference: extracted.unitLabel? `Miete ${extracted.unitLabel}`: 'Miete', startDate: extracted.startDate||'', endDate: '', deposit: Number(extracted.deposit)||0,
      }))
    ]);
    alert(`${ok.length} Vertrag/Verträge angelegt.`);
  };

  return (
    <div style={{display:'grid', gap:16, gridTemplateColumns:'1fr'}}>
      <Card>
        <CardHeader><CardTitle>Mapping</CardTitle><CardDescription>Definiere, wo die KI die Werte findet</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <Textarea rows={16} value={mappingText} onChange={(e)=> setMappingText((e.target as HTMLTextAreaElement).value)} />
          <p className="muted" style={{fontSize:14}}>Felder: tenantName, rent→expected, deposit, startDate, roomLabel→unitLabel, iban.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>PDF/Scan hochladen</CardTitle><CardDescription>Mehrere Dateien möglich (einheitliche Verträge)</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <Input type="file" accept="application/pdf,text/plain" multiple onChange={(e)=> e.target.files && onFiles([...(e.target.files as any)])} />
          <Button disabled={busy} variant="outline" onClick={()=> (document.querySelector('input[type=file]') as HTMLInputElement)?.click()}><Upload size={16}/>Dateien wählen</Button>
          {busy && <p>Analysiere …</p>}
          {results.length>0 && (
            <>
              <Table className="mt-3">
                <TableHeader><TableRow><TableHead>Datei</TableHead><TableHead>Mieter</TableHead><TableHead>{"Miete (EUR)"}</TableHead><TableHead>Kaution</TableHead><TableHead>Start</TableHead><TableHead>Einheit</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
                <TableBody>
                  {results.map((r:any,i:number)=> (
                    <TableRow key={i}>
                      <TableCell className="text-sm">{r.fileName}</TableCell>
                      <TableCell>{r.extracted.tenantName||'–'}</TableCell>
                      <TableCell>{Number(r.extracted.expected||0).toFixed(2)}</TableCell>
                      <TableCell>{Number(r.extracted.deposit||0).toFixed(2)}</TableCell>
                      <TableCell>{r.extracted.startDate||'–'}</TableCell>
                      <TableCell>{r.matchedUnit? r.matchedUnit.label: (r.extracted.unitLabel||'–')}</TableCell>
                      <TableCell>{r.matchedUnit? 'zugeordnet' : 'Einheit nicht gefunden'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div style={{paddingTop:12}}>
                <Button onClick={commitAll}><FileSignature size={16}/>Alle übernehmen</Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
