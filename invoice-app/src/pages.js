// HTML pages served by the Worker. Kept as template strings (no build step, no
// framework, no CDN) so the whole app is one self-contained deploy.
//
// - signPage:  client-facing. Loads invoice by token, captures a signature, submits.
// - adminPage: your side. Create invoices, copy signing links, log payments, set status.

const esc = (s) => JSON.stringify(String(s ?? ""));

export function signPage(env, token) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign — BojioVenue</title>
<style>
 *{box-sizing:border-box}
 body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0;background:#f4f4f6;color:#16161a}
 .wrap{max-width:640px;margin:0 auto;padding:16px}
 .card{background:#fff;border-radius:12px;padding:18px 20px;margin:14px 0;box-shadow:0 1px 3px rgba(0,0,0,.08)}
 h1{font-size:22px;margin:2px 0}
 .muted{color:#6b6b73;font-size:13px}
 .row{display:flex;justify-content:space-between;gap:10px;padding:6px 0;font-size:14px}
 .row.total{font-weight:700;border-top:1px solid #e6e6ea;margin-top:6px;padding-top:10px}
 canvas{border:1px dashed #b9b9c2;border-radius:10px;width:100%;height:190px;touch-action:none;background:#fff;display:block}
 label{display:block;font-size:13px;color:#6b6b73;margin:10px 0 4px}
 input{width:100%;padding:11px;border:1px solid #cfcfd6;border-radius:8px;font-size:16px}
 button{background:#111;color:#fff;border:0;border-radius:10px;padding:14px;font-size:16px;width:100%;margin-top:12px;cursor:pointer}
 button.sec{background:#ececef;color:#333;padding:8px 14px;font-size:13px;width:auto;margin-top:8px}
 #msg{margin-top:10px;font-size:13px}
 .agreement{max-height:460px;overflow-y:auto;border-radius:10px;padding:14px;background:#93C6D9}
 .agreement .a-card{background:#FFDE58;border-radius:10px;padding:12px 16px;margin:0 0 10px}
 .agreement h3{font-size:12.5px;margin:0 0 6px;color:#2F0B5D;font-weight:700}
 .agreement p{font-size:11.5px;line-height:1.5;color:#2F0B5D;margin:0 0 7px}
 .agreement p.a-bold{font-weight:700}
 .agreement p:last-child{margin-bottom:0}
 .qr-wrap{text-align:center}
 .qr-wrap svg{width:200px;height:200px;max-width:100%}
</style></head>
<body><div class="wrap"><div id="app" class="muted" style="padding:28px;text-align:center">Loading…</div></div>
<script>
const TOKEN=${esc(token)};
const BIZ=${esc(env.BUSINESS_NAME || "BojioVenue")};
const app=document.getElementById('app');
let inv=null;
const money=n=>'$'+Number(n||0).toFixed(2);

async function load(){
  const r=await fetch('/api/sign/'+TOKEN);
  if(!r.ok){
    const d=await r.json().catch(()=>({}));
    app.className='';
    app.innerHTML='<div class="card" style="text-align:center"><b>'+(d.expired?'⏳ Link expired':'⚠️ Unavailable')+'</b>'+
      '<div class="muted" style="margin-top:6px">'+(d.error||'This link is invalid.')+'</div></div>';
    return;
  }
  inv=(await r.json()).invoice;
  render(inv.status==='signed');
}

function render(signed){
  app.className='';
  app.innerHTML=
   '<div class="card"><div class="muted">'+BIZ+' · '+inv.agreement_title+'</div>'+
     '<h1>'+inv.invoice_no+'</h1>'+
     '<div class="muted">'+inv.event_type+' event · '+inv.venue_space+' · '+inv.booking_date+'</div>'+
     '<div class="row total"><span>Booking total</span><span>'+money(inv.grand_total)+'</span></div>'+
     '<div class="row muted"><span>Refundable security deposit (billed separately)</span><span>'+money(inv.deposit_amount)+'</span></div>'+
   '</div>'+
   '<div class="card">'+
     '<div class="muted" style="margin-bottom:8px">Please read the agreement below, then sign to confirm your booking.</div>'+
     '<div class="agreement">'+inv.agreement_html+'</div>'+
   '</div>'+
   (signed
     ? '<div class="card"><b>✅ Signed.</b><div class="muted">Thank you — your booking and deposit invoice have been filed. You may close this page.</div>'+
         '<a href="/sign/'+TOKEN+'/download" style="display:block;text-align:center;background:#111;color:#fff;border-radius:10px;padding:14px;font-size:16px;margin-top:12px;text-decoration:none">Download your copy (PDF)</a>'+
       '</div>'+
       (inv.payment_due
         ? '<div class="card qr-wrap"><div class="muted" style="margin-bottom:8px">Scan to pay via PayNow — '+inv.payment_due.label+': '+money(inv.payment_due.amount)+'</div>'+inv.payment_due.qr_svg+'</div>'
         : '')
     : '<div class="card">'+
         '<label>Your full name</label><input id="name" autocomplete="name" placeholder="Full name" />'+
         '<label>Signature</label><canvas id="pad"></canvas>'+
         '<button class="sec" type="button" id="clear">Clear</button>'+
         '<button id="submit">Agree &amp; Sign</button>'+
         '<div id="msg" class="muted"></div>'+
       '</div>');
  if(!signed) initPad();
}

function initPad(){
  const c=document.getElementById('pad');
  const ratio=Math.max(window.devicePixelRatio||1,1);
  c.width=c.offsetWidth*ratio; c.height=c.offsetHeight*ratio;
  const ctx=c.getContext('2d');
  ctx.scale(ratio,ratio);
  ctx.lineWidth=2.2; ctx.lineCap='round'; ctx.lineJoin='round'; ctx.strokeStyle='#111';
  let drawing=false,last=null,dirty=false;
  const pos=e=>{const r=c.getBoundingClientRect();const t=e.touches?e.touches[0]:e;return{x:t.clientX-r.left,y:t.clientY-r.top};};
  const start=e=>{drawing=true;last=pos(e);e.preventDefault();};
  const move=e=>{ if(!drawing)return; const p=pos(e);
    ctx.beginPath(); ctx.moveTo(last.x,last.y);
    const mx=(last.x+p.x)/2,my=(last.y+p.y)/2;
    ctx.quadraticCurveTo(last.x,last.y,mx,my); ctx.stroke();
    last=p; dirty=true; e.preventDefault(); };
  const end=()=>{drawing=false;};
  c.addEventListener('mousedown',start); c.addEventListener('mousemove',move); window.addEventListener('mouseup',end);
  c.addEventListener('touchstart',start,{passive:false}); c.addEventListener('touchmove',move,{passive:false}); c.addEventListener('touchend',end);
  document.getElementById('clear').onclick=()=>{ctx.clearRect(0,0,c.width,c.height);dirty=false;};
  document.getElementById('submit').onclick=async()=>{
    const name=document.getElementById('name').value.trim();
    const msg=document.getElementById('msg');
    if(!name){msg.textContent='Please enter your name.';return;}
    if(!dirty){msg.textContent='Please sign in the box above.';return;}
    msg.textContent='Submitting…';
    const png=c.toDataURL('image/png');
    const r=await fetch('/api/sign/'+TOKEN,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({signer_name:name,signature_png:png})});
    const d=await r.json().catch(()=>({}));
    if(r.ok){ inv.status='signed'; render(true); }
    else { msg.textContent=(d.error||'Something went wrong.'); }
  };
}
load();
</script></body></html>`;
}

// Deduction addendum acknowledgment (Addendum 4) — deliberately near-identical to
// signPage above (same canvas-signature UI, same load/render/initPad shape) since
// Kenneth described this as using "the SAME link-signing system as the agreement."
export function addendumPage(env, token) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Security Deposit Deduction — BojioVenue</title>
<style>
 *{box-sizing:border-box}
 body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0;background:#f4f4f6;color:#16161a}
 .wrap{max-width:640px;margin:0 auto;padding:16px}
 .card{background:#fff;border-radius:12px;padding:18px 20px;margin:14px 0;box-shadow:0 1px 3px rgba(0,0,0,.08)}
 h1{font-size:22px;margin:2px 0}
 .muted{color:#6b6b73;font-size:13px}
 .row{display:flex;justify-content:space-between;gap:10px;padding:6px 0;font-size:14px}
 .row.total{font-weight:700;border-top:1px solid #e6e6ea;margin-top:6px;padding-top:10px}
 canvas{border:1px dashed #b9b9c2;border-radius:10px;width:100%;height:190px;touch-action:none;background:#fff;display:block}
 label{display:block;font-size:13px;color:#6b6b73;margin:10px 0 4px}
 input{width:100%;padding:11px;border:1px solid #cfcfd6;border-radius:8px;font-size:16px}
 button{background:#111;color:#fff;border:0;border-radius:10px;padding:14px;font-size:16px;width:100%;margin-top:12px;cursor:pointer}
 button.sec{background:#ececef;color:#333;padding:8px 14px;font-size:13px;width:auto;margin-top:8px}
 #msg{margin-top:10px;font-size:13px}
 .agreement{max-height:460px;overflow-y:auto;border-radius:10px;padding:14px;background:#93C6D9}
 .agreement .a-card{background:#FFDE58;border-radius:10px;padding:12px 16px;margin:0 0 10px}
 .agreement h3{font-size:12.5px;margin:0 0 6px;color:#2F0B5D;font-weight:700}
 .agreement p{font-size:11.5px;line-height:1.5;color:#2F0B5D;margin:0 0 7px}
 .agreement p.a-bold{font-weight:700}
 .agreement p:last-child{margin-bottom:0}
</style></head>
<body><div class="wrap"><div id="app" class="muted" style="padding:28px;text-align:center">Loading…</div></div>
<script>
const TOKEN=${esc(token)};
const BIZ=${esc(env.BUSINESS_NAME || "BojioVenue")};
const app=document.getElementById('app');
let data=null;
const money=n=>'$'+Number(n||0).toFixed(2);

async function load(){
  const r=await fetch('/api/addendum/'+TOKEN);
  if(!r.ok){
    const d=await r.json().catch(()=>({}));
    app.className='';
    app.innerHTML='<div class="card" style="text-align:center"><b>⚠️ Unavailable</b>'+
      '<div class="muted" style="margin-top:6px">'+(d.error||'This link is invalid.')+'</div></div>';
    return;
  }
  data=(await r.json()).deduction;
  render(data.status==='acknowledged');
}

function render(acknowledged){
  app.className='';
  app.innerHTML=
   '<div class="card"><div class="muted">'+BIZ+' · Security Deposit Deduction Addendum</div>'+
     '<h1>'+data.invoice_no+'</h1>'+
     '<div class="muted">'+data.event_type+' event · '+data.venue_space+' · '+data.booking_date+'</div>'+
     '<div class="row total"><span>Deduction amount</span><span>'+money(data.amount)+'</span></div>'+
     '<div class="row muted"><span>Balance refundable</span><span>'+money(data.balance_refundable)+'</span></div>'+
   '</div>'+
   '<div class="card">'+
     '<div class="muted" style="margin-bottom:8px">Please read the addendum below, then acknowledge to confirm.</div>'+
     '<div class="agreement">'+data.addendum_html+'</div>'+
   '</div>'+
   (acknowledged
     ? '<div class="card"><b>✅ Acknowledged.</b><div class="muted">Thank you — this has been recorded. The balance refundable will be paid out within 3 working days. You may close this page.</div></div>'
     : '<div class="card">'+
         '<label>Your full name</label><input id="name" autocomplete="name" placeholder="Full name" />'+
         '<label>Signature</label><canvas id="pad"></canvas>'+
         '<button class="sec" type="button" id="clear">Clear</button>'+
         '<button id="submit">Acknowledge</button>'+
         '<div id="msg" class="muted"></div>'+
       '</div>');
  if(!acknowledged) initPad();
}

function initPad(){
  const c=document.getElementById('pad');
  const ratio=Math.max(window.devicePixelRatio||1,1);
  c.width=c.offsetWidth*ratio; c.height=c.offsetHeight*ratio;
  const ctx=c.getContext('2d');
  ctx.scale(ratio,ratio);
  ctx.lineWidth=2.2; ctx.lineCap='round'; ctx.lineJoin='round'; ctx.strokeStyle='#111';
  let drawing=false,last=null,dirty=false;
  const pos=e=>{const r=c.getBoundingClientRect();const t=e.touches?e.touches[0]:e;return{x:t.clientX-r.left,y:t.clientY-r.top};};
  const start=e=>{drawing=true;last=pos(e);e.preventDefault();};
  const move=e=>{ if(!drawing)return; const p=pos(e);
    ctx.beginPath(); ctx.moveTo(last.x,last.y);
    const mx=(last.x+p.x)/2,my=(last.y+p.y)/2;
    ctx.quadraticCurveTo(last.x,last.y,mx,my); ctx.stroke();
    last=p; dirty=true; e.preventDefault(); };
  const end=()=>{drawing=false;};
  c.addEventListener('mousedown',start); c.addEventListener('mousemove',move); window.addEventListener('mouseup',end);
  c.addEventListener('touchstart',start,{passive:false}); c.addEventListener('touchmove',move,{passive:false}); c.addEventListener('touchend',end);
  document.getElementById('clear').onclick=()=>{ctx.clearRect(0,0,c.width,c.height);dirty=false;};
  document.getElementById('submit').onclick=async()=>{
    const name=document.getElementById('name').value.trim();
    const msg=document.getElementById('msg');
    if(!name){msg.textContent='Please enter your name.';return;}
    if(!dirty){msg.textContent='Please sign in the box above.';return;}
    msg.textContent='Submitting…';
    const png=c.toDataURL('image/png');
    const r=await fetch('/api/addendum/'+TOKEN,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({acknowledger_name:name,signature_png:png})});
    const d=await r.json().catch(()=>({}));
    if(r.ok){ data.status='acknowledged'; render(true); }
    else { msg.textContent=(d.error||'Something went wrong.'); }
  };
}
load();
</script></body></html>`;
}

export function adminPage(env) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>BojioVenue — Admin</title>
<style>
 *{box-sizing:border-box}
 body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0;background:#f4f4f6;color:#16161a}
 .wrap{max-width:900px;margin:0 auto;padding:18px}
 h1{font-size:20px} h2{font-size:15px;margin:18px 0 8px}
 .card{background:#fff;border-radius:12px;padding:16px 18px;margin:12px 0;box-shadow:0 1px 3px rgba(0,0,0,.08)}
 .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
 label{display:block;font-size:12px;color:#6b6b73;margin:8px 0 3px}
 input,select,textarea{width:100%;padding:9px;border:1px solid #cfcfd6;border-radius:8px;font-size:14px}
 button{background:#111;color:#fff;border:0;border-radius:9px;padding:10px 14px;font-size:14px;cursor:pointer}
 button.sec{background:#ececef;color:#222;padding:6px 10px;font-size:12px}
 table{width:100%;border-collapse:collapse;font-size:13px}
 th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #eee;vertical-align:top}
 .pill{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;background:#eee}
 .pill.signed{background:#dcf5e3} .pill.void{background:#f6dede} .pill.issued{background:#e6ecf7}
 .muted{color:#6b6b73;font-size:12px}
 .hidden{display:none}
 .toast{position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#16161a;color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;z-index:50;box-shadow:0 4px 12px rgba(0,0,0,.2)}
 .overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:40}
 .modal{background:#fff;border-radius:12px;padding:20px;width:320px;max-width:90vw;box-shadow:0 8px 30px rgba(0,0,0,.2)}
 .modal h3{margin:0 0 12px;font-size:15px}
 .modal .actions{display:flex;gap:8px;margin-top:14px}
 .modal .actions button{flex:1}
 button.cancel{background:#ececef;color:#222}
</style></head>
<body><div id="toastHost"></div><div id="modalHost"></div><div class="wrap">
 <h1>BojioVenue — Invoices</h1>

 <div class="card" id="loginCard">
   <h2>Admin key required</h2>
   <p class="muted">Enter the admin key to manage invoices.</p>
   <input id="keyInput" type="password" placeholder="Admin key" autocomplete="off">
   <div style="margin-top:10px"><button id="loginBtn">Unlock</button> <span id="loginMsg" class="muted"></span></div>
 </div>

 <div id="app" class="hidden">
 <div class="card">
   <h2>New invoice</h2>
   <div class="grid">
     <div><label>Client name *</label><input id="client_name"></div>
     <div><label>NRIC / UEN</label><input id="client_nric_uen"></div>
     <div><label>Phone</label><input id="client_phone"></div>
     <div><label>Email</label><input id="client_email"></div>
     <div><label>Event type</label>
       <select id="event_type"><option>Social</option><option>Corporate</option><option>Seminar</option></select></div>
     <div><label>Venue space * <span class="muted">(Social is always Whole Venue)</span></label>
       <select id="venue_space"><option>Whole Venue</option><option>Main Hall Only</option></select></div>
     <div><label>Booking date *</label><input id="booking_date" type="date"></div>
     <div><label>Hours (min 4)</label><input id="hours" type="number" value="4" min="1" step="0.5"></div>
     <div><label>Start time</label><input id="start_time" type="time"></div>
     <div><label>End time</label><input id="end_time" type="time"></div>
     <div><label>Rate / Package rate ($/hr) <span class="muted">(Social: blank = usual weekday/weekend rate. Corporate: blank = auto by rate card)</span></label><input id="hourly_rate" type="number" placeholder="auto"></div>
     <div><label>Discount % <span class="muted">(Social only — plain number, e.g. 10. Leave blank for none; a promo may suggest one)</span></label><input id="discount_percent" type="number" placeholder="0"></div>
     <div><label>Cleaning fee (blank = auto by event type)</label><input id="cleaning_fee" type="number" placeholder="auto"></div>
     <div><label>Refundable deposit (blank = default by event type)</label><input id="deposit_amount" type="number" placeholder="auto"></div>
     <div><label>&nbsp;</label><label style="display:flex;align-items:center;gap:6px;margin-top:9px"><input type="checkbox" id="has_pet" style="width:auto"> Pets present (+$100 cleaning)</label></div>
     <div><label>Discount / promo <span class="muted">(Corporate/Seminar only — e.g. "10% off", "$50 off". Leave blank for none)</span></label><input id="discount_note"></div>
     <div><label>Notes</label><input id="notes"></div>
   </div>

   <h2 style="margin-top:18px">Promo labels &amp; custom clause <span class="muted">(all optional)</span></h2>
   <p class="muted" style="margin:0 0 8px">Use these when a manually-overridden rate above is a named promo (e.g. set Hourly rate/Cleaning fee/Deposit above to the promo amount, then label it here — this does not change any pricing itself, just what's shown on the Agreement).</p>
   <div class="grid">
     <div><label>Rental fee label</label><input id="rental_fee_note" placeholder='e.g. "SG61 x BoJio Turns One Promo"'></div>
     <div><label>Cleaning fee label</label><input id="cleaning_fee_note" placeholder='e.g. "SG61 Promo"'></div>
     <div><label>Deposit label</label><input id="deposit_note"></div>
     <div><label>Custom clause title <span class="muted">(inserted as its own numbered clause after Cancellation)</span></label><input id="promo_clause_title" placeholder="e.g. Special Promotion Terms – SG61 x BoJio Turns One Promo"></div>
   </div>
   <div style="margin-top:8px"><label>Custom clause text</label><textarea id="promo_clause_text" rows="3" style="width:100%;padding:9px;border:1px solid #cfcfd6;border-radius:8px;font-size:14px;font-family:inherit"></textarea></div>

   <div style="margin-top:12px"><button id="create">Create invoice</button> <span id="createMsg" class="muted"></span></div>
 </div>

 <div class="card">
   <h2>Promos</h2>
   <p class="muted" style="margin:0 0 8px">A promo whose date window covers a booking's date auto-applies to new bookings (Telegram and this form) — no need to type anything special. Only one should be active at a time.</p>
   <table id="promoTbl"><thead><tr><th>Name</th><th>Valid</th><th>Effect</th><th>Active</th><th></th></tr></thead>
   <tbody id="promoRows"><tr><td colspan="5" class="muted">Loading…</td></tr></tbody></table>

   <h2 style="margin-top:16px">New promo preset</h2>
   <div class="grid">
     <div><label>Name *</label><input id="pr_name" placeholder="e.g. SG61 x BoJio Turns One"></div>
     <div><label>&nbsp;</label><label style="display:flex;align-items:center;gap:6px;margin-top:9px"><input type="checkbox" id="pr_active" checked style="width:auto"> Active</label></div>
     <div><label>Valid from *</label><input id="pr_valid_from" type="date"></div>
     <div><label>Valid to *</label><input id="pr_valid_to" type="date"></div>
     <div><label>Discount % off rental</label><input id="pr_discount_percent" type="number" placeholder="e.g. 10"></div>
     <div><label>Cleaning fee override (blank = no change)</label><input id="pr_cleaning_fee_override" type="number" placeholder="e.g. 61"></div>
     <div><label>Extra $ off rental if hours ≥</label><input id="pr_extra_discount_hours_threshold" type="number" placeholder="e.g. 8"></div>
     <div><label>Extra discount amount</label><input id="pr_extra_discount_amount" type="number" placeholder="e.g. 61"></div>
     <div><label>Rental fee label <span class="muted">(shown on Agreement)</span></label><input id="pr_rental_fee_note" placeholder="e.g. SG61 x BoJio Turns One Promo"></div>
     <div><label>Cleaning fee label</label><input id="pr_cleaning_fee_note" placeholder="e.g. SG61 Promo"></div>
     <div><label>Custom clause title</label><input id="pr_clause_title" placeholder="e.g. Special Promotion Terms"></div>
   </div>
   <div style="margin-top:8px"><label>Custom clause text</label><textarea id="pr_clause_text" rows="3" style="width:100%;padding:9px;border:1px solid #cfcfd6;border-radius:8px;font-size:14px;font-family:inherit"></textarea></div>
   <div style="margin-top:12px"><button id="createPromo">Create promo</button> <span id="createPromoMsg" class="muted"></span></div>
 </div>

 <div class="card">
   <h2>Invoices</h2>
   <table id="tbl"><thead><tr><th>No.</th><th>Client</th><th>Event</th><th>Total</th><th>Status</th><th>Actions</th></tr></thead>
   <tbody id="rows"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody></table>
 </div>
 </div>
</div>
<script>
let KEY=localStorage.getItem('bojioAdminKey')||'';
function headers(){return {'Content-Type':'application/json','Authorization':'Bearer '+KEY};}
function showLogin(msg){
  document.getElementById('app').classList.add('hidden');
  document.getElementById('loginCard').classList.remove('hidden');
  document.getElementById('loginMsg').textContent=msg||'';
}
function showApp(){
  document.getElementById('loginCard').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
}
async function api(path,opts){
  opts=opts||{}; opts.headers=Object.assign(headers(),opts.headers||{});
  const r=await fetch(path,opts);
  if(r.status===401){ localStorage.removeItem('bojioAdminKey'); KEY=''; showLogin('Wrong key, or session expired. Try again.'); }
  return r;
}
document.getElementById('loginBtn').onclick=async()=>{
  const k=document.getElementById('keyInput').value.trim();
  if(!k){document.getElementById('loginMsg').textContent='Enter a key.';return;}
  KEY=k; localStorage.setItem('bojioAdminKey',KEY);
  document.getElementById('loginMsg').textContent='Checking…';
  const r=await fetch('/api/invoices',{headers:headers()});
  if(r.ok){ showApp(); load(); loadPromos(); } else { localStorage.removeItem('bojioAdminKey'); KEY=''; document.getElementById('loginMsg').textContent='Wrong key.'; }
};
document.getElementById('keyInput').addEventListener('keydown',e=>{ if(e.key==='Enter') document.getElementById('loginBtn').click(); });
const money=n=>'$'+Number(n||0).toFixed(2);
const val=id=>document.getElementById(id).value.trim();

function toast(msg){
  const host=document.getElementById('toastHost');
  const t=document.createElement('div'); t.className='toast'; t.textContent=msg;
  host.innerHTML=''; host.appendChild(t);
  setTimeout(()=>{ if(t.parentNode) t.parentNode.removeChild(t); },3500);
}
// modal(title, bodyHtml, {okText, onOk}) -> shows an overlay with Cancel + OK.
// onOk receives the modal element so it can read input values; return false to keep it open.
function modal(title, bodyHtml, opts){
  opts=opts||{};
  const host=document.getElementById('modalHost');
  host.innerHTML='<div class="overlay" id="ovl"><div class="modal">'+
    '<h3>'+title+'</h3>'+bodyHtml+
    '<div class="actions"><button class="cancel" id="mCancel">Cancel</button><button id="mOk">'+(opts.okText||'OK')+'</button></div>'+
    '</div></div>';
  const close=()=>{ host.innerHTML=''; };
  document.getElementById('mCancel').onclick=close;
  document.getElementById('ovl').addEventListener('click',e=>{ if(e.target.id==='ovl') close(); });
  document.getElementById('mOk').onclick=async()=>{
    const keep = opts.onOk ? await opts.onOk(host) : true;
    if(keep!==false) close();
  };
  return host;
}
function confirmModal(title, message, onConfirm){
  modal(title, '<p class="muted">'+message+'</p>', { okText:'Confirm', onOk: onConfirm });
}

document.getElementById('create').onclick=async()=>{
  const msg=document.getElementById('createMsg');
  if(!val('client_name')||!val('booking_date')){msg.textContent='Client name and booking date are required.';return;}
  msg.textContent='Creating…';
  const body={client_name:val('client_name'),client_nric_uen:val('client_nric_uen'),client_phone:val('client_phone'),client_email:val('client_email'),
    event_type:val('event_type'),venue_space:val('venue_space'),booking_date:val('booking_date'),hours:val('hours'),
    start_time:val('start_time'),end_time:val('end_time'),
    hourly_rate:val('hourly_rate'),discount_percent:val('discount_percent'),cleaning_fee:val('cleaning_fee'),deposit_amount:val('deposit_amount'),
    pet_fee:document.getElementById('has_pet').checked?100:0,discount_text:val('discount_note'),
    rental_fee_note:val('rental_fee_note'),cleaning_fee_note:val('cleaning_fee_note'),deposit_note:val('deposit_note'),
    promo_clause_title:val('promo_clause_title'),promo_clause_text:val('promo_clause_text'),
    notes:val('notes')};
  const r=await api('/api/invoices',{method:'POST',body:JSON.stringify(body)});
  const d=await r.json().catch(()=>({}));
  if(r.ok){ msg.textContent=d.invoice.invoice_no+' created.'; await copy(d.signing_url); toast(d.invoice.invoice_no+' created — signing link copied to clipboard.'); load(); }
  else { msg.textContent=d.error||'Failed.'; }
};

async function copy(t){ try{ await navigator.clipboard.writeText(t);}catch(e){} }

async function load(){
  const r=await api('/api/invoices');
  const d=await r.json().catch(()=>({invoices:[]}));
  const rows=document.getElementById('rows');
  if(!d.invoices||!d.invoices.length){rows.innerHTML='<tr><td colspan="6" class="muted">No invoices yet.</td></tr>';return;}
  rows.innerHTML=d.invoices.map(i=>
    '<tr><td>'+i.invoice_no+'</td><td>'+i.client_name+'</td><td>'+i.event_type+' · '+i.venue_space+'<br><span class="muted">'+i.booking_date+'</span></td>'+
    '<td>'+money(i.grand_total)+'<br><span class="muted">deposit '+money(i.deposit_amount)+'</span></td>'+
    '<td><span class="pill '+i.status+'">'+i.status+'</span><br><span class="muted">'+i.payment_status+' / clean:'+i.cleaning_fee_status+' / deposit:'+i.deposit_status+'</span></td>'+
    '<td>'+
      '<button class="sec" onclick="copyLink(\\''+i.token+'\\')">Copy link</button> '+
      '<button class="sec" onclick="addPay(\\''+i.invoice_no+'\\')">+ Payment</button> '+
      '<button class="sec" onclick="setStat(\\''+i.invoice_no+'\\')">Status</button> '+
      '<button class="sec" onclick="refile(\\''+i.invoice_no+'\\')">Re-file PDF</button> '+
      (i.status!=='void'?'<button class="sec" onclick="voidInv(\\''+i.invoice_no+'\\')">Void</button>':'')+
    '</td></tr>').join('');
}
function copyLink(tok){ const url=location.origin+'/sign/'+tok; copy(url); toast('Signing link copied to clipboard.'); }

async function loadPromos(){
  const r=await api('/api/promos');
  const d=await r.json().catch(()=>({promos:[]}));
  const rows=document.getElementById('promoRows');
  if(!d.promos||!d.promos.length){rows.innerHTML='<tr><td colspan="5" class="muted">No promos yet.</td></tr>';return;}
  rows.innerHTML=d.promos.map(p=>{
    const bits=[];
    if(p.discount_percent) bits.push(p.discount_percent+'% off rental');
    if(p.cleaning_fee_override!==null && p.cleaning_fee_override!==undefined) bits.push('cleaning fee $'+p.cleaning_fee_override);
    if(p.extra_discount_amount) bits.push('+$'+p.extra_discount_amount+' off if ≥'+p.extra_discount_hours_threshold+'h');
    return '<tr><td>'+p.name+'</td><td>'+p.valid_from+' – '+p.valid_to+'</td><td class="muted">'+(bits.join(', ')||'—')+'</td>'+
      '<td><span class="pill '+(p.active?'signed':'void')+'">'+(p.active?'Active':'Inactive')+'</span></td>'+
      '<td><button class="sec" onclick="togglePromo('+p.id+','+(p.active?0:1)+')">'+(p.active?'Deactivate':'Activate')+'</button></td></tr>';
  }).join('');
}
async function togglePromo(id,active){
  const r=await api('/api/promos/'+id+'/active',{method:'POST',body:JSON.stringify({active:!!active})});
  if(r.ok){ loadPromos(); } else { toast('Failed to update promo.'); }
}
document.getElementById('createPromo').onclick=async()=>{
  const msg=document.getElementById('createPromoMsg');
  if(!val('pr_name')||!val('pr_valid_from')||!val('pr_valid_to')){ msg.textContent='Name, valid from, and valid to are required.'; return; }
  msg.textContent='Creating…';
  const body={
    name:val('pr_name'), active:document.getElementById('pr_active').checked,
    valid_from:val('pr_valid_from'), valid_to:val('pr_valid_to'),
    discount_percent:Number(val('pr_discount_percent'))||0,
    cleaning_fee_override:val('pr_cleaning_fee_override')?Number(val('pr_cleaning_fee_override')):null,
    extra_discount_hours_threshold:val('pr_extra_discount_hours_threshold')?Number(val('pr_extra_discount_hours_threshold')):null,
    extra_discount_amount:Number(val('pr_extra_discount_amount'))||0,
    rental_fee_note:val('pr_rental_fee_note')||null, cleaning_fee_note:val('pr_cleaning_fee_note')||null,
    clause_title:val('pr_clause_title')||null, clause_text:val('pr_clause_text')||null,
  };
  const r=await api('/api/promos',{method:'POST',body:JSON.stringify(body)});
  const d=await r.json().catch(()=>({}));
  if(r.ok){ msg.textContent='Created.'; toast('Promo "'+d.promo.name+'" created.'); loadPromos(); }
  else { msg.textContent=d.error||'Failed.'; }
};

function addPay(no){
  modal('Log payment for '+no,
    '<label>Amount received (SGD)</label><input id="pAmount" type="number" step="0.01">'+
    '<label>Kind</label><select id="pKind"><option value="deposit">Deposit</option><option value="balance" selected>Balance</option><option value="cleaning_fee">Cleaning fee</option><option value="refund">Refund</option><option value="other">Other</option></select>'+
    '<label>Date</label><input id="pDate" type="date" value="'+new Date().toISOString().slice(0,10)+'">'+
    '<label>Note (optional)</label><input id="pNote">',
    { okText:'Log payment', onOk: async(host)=>{
        const amount=host.querySelector('#pAmount').value;
        const kind=host.querySelector('#pKind').value;
        const paid_on=host.querySelector('#pDate').value;
        const note=host.querySelector('#pNote').value;
        if(!amount||!paid_on){ toast('Amount and date are required.'); return false; }
        const r=await api('/api/invoices/'+no+'/payments',{method:'POST',body:JSON.stringify({amount:Number(amount),kind,paid_on,note})});
        if(r.ok){ toast('Payment logged.'); load(); } else { toast('Failed to log payment.'); return false; }
      } });
}

function setStat(no){
  const opt=(v,label)=>'<option value="'+v+'">'+label+'</option>';
  modal('Update status for '+no,
    '<label>Rental payment status</label><select id="sPay">'+opt('','(no change)')+opt('Unpaid','Unpaid')+opt('Partially Paid','Partially Paid')+opt('Paid','Paid')+'</select>'+
    '<label>Cleaning fee status</label><select id="sClean">'+opt('','(no change)')+opt('Unpaid','Unpaid')+opt('Paid','Paid')+'</select>'+
    '<label>Deposit status</label><select id="sDeposit">'+opt('','(no change)')+opt('Not Collected','Not Collected')+opt('Held','Held')+opt('Refunded','Refunded')+'</select>',
    { okText:'Update', onOk: async(host)=>{
        const payment_status=host.querySelector('#sPay').value||null;
        const cleaning_fee_status=host.querySelector('#sClean').value||null;
        const deposit_status=host.querySelector('#sDeposit').value||null;
        const r=await api('/api/invoices/'+no+'/status',{method:'POST',body:JSON.stringify({payment_status,cleaning_fee_status,deposit_status})});
        if(r.ok){ toast('Status updated. Tip: Re-file PDF to refresh the filed copy.'); load(); } else { toast('Failed to update status.'); return false; }
      } });
}

function refile(no){
  confirmModal('Re-file '+no+'?', 'Regenerates the PDF and re-uploads it to Google Drive.', async()=>{
    const r=await api('/api/invoices/'+no+'/refile',{method:'POST'});
    const d=await r.json().catch(()=>({}));
    if(r.ok){ toast('Re-filed to Drive.'); } else { toast('Failed: '+(d.error||'')); return false; }
  });
}

function voidInv(no){
  confirmModal('Void '+no+'?', 'The number is kept (never reused) but the invoice is cancelled.', async()=>{
    const r=await api('/api/invoices/'+no+'/void',{method:'POST'});
    if(r.ok){ load(); } else { toast('Failed to void.'); return false; }
  });
}

(async function init(){
  if(!KEY){ showLogin(); return; }
  const r=await fetch('/api/invoices',{headers:headers()});
  if(r.ok){ showApp(); load(); loadPromos(); } else { localStorage.removeItem('bojioAdminKey'); KEY=''; showLogin('Session expired, enter the key again.'); }
})();
</script></body></html>`;
}
