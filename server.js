const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PRIX_BILLET = 10000; // même valeur que dans index.html
const SITE = process.env.SITE_URL || "";
const F_CMD = path.join(__dirname, "commandes.json");
const F_ENT = path.join(__dirname, "entrees.json");
const lire = (f, d) => { try { return JSON.parse(fs.readFileSync(f)); } catch (_) { return d; } };
const ecrire = (f, v) => fs.writeFileSync(f, JSON.stringify(v));
const sign = (s) => crypto.createHmac("sha256", process.env.ADMIN_KEY || "").update(s).digest("hex").slice(0, 10).toUpperCase();
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const unb64 = (s) => JSON.parse(Buffer.from(s, "base64url").toString());
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
const jeton = (c) => { const o = b64({ i: c.id, n: c.nom, e: c.email, t: c.tel, q: c.quantite }); return { o, s: sign(o) }; };
const codeBillet = (id, q) => "GALA-" + id + "-" + q + "-" + sign("T" + id + q);
const codeValide = (code) => {
  const m = /^GALA-([0-9A-F]{8})-(\d{1,2})-([0-9A-F]{10})$/.exec(code || "");
  return m && sign("T" + m[1] + m[2]) === m[3] ? { id: m[1], q: Number(m[2]) } : null;
};
const garde = (req, res, next) => {
  const k = req.get("x-cle");
  if (!process.env.ADMIN_KEY || k !== process.env.ADMIN_KEY) return res.status(401).json({ erreur: "Accès refusé" });
  next();
};
const page = (titre, corps) => `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${titre}</title><style>body{font:16px system-ui,sans-serif;max-width:460px;margin:0 auto;padding:20px;line-height:1.5}button{font:inherit;padding:12px 16px;border-radius:10px;border:0;background:#141A3F;color:#fff;margin-top:8px}input{font:inherit;padding:10px;width:100%;border:1px solid #999;border-radius:8px}.c{border:1px solid #999;border-radius:12px;padding:12px;margin:10px 0}img{max-width:100%}</style></head><body>${corps}</body></html>`;

async function envoyerMail(to, nom, sujet, html, pj) {
  if (!process.env.BREVO_API_KEY || !process.env.MAIL_EXPEDITEUR || !to) return false;
  try {
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": process.env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: { name: "Dîner de Gala", email: process.env.MAIL_EXPEDITEUR }, to: [{ email: to, name: nom }], subject: sujet, htmlContent: html, attachment: pj }),
    });
    if (!r.ok) console.error("Brevo", r.status, await r.text());
    return r.ok;
  } catch (e) { console.error("Brevo", e.message); return false; }
}

// 1) Nouvelle commande
app.post("/api/commande", (req, res) => {
  const { nom, email, tel, quantite } = req.body || {};
  const q = Number(quantite);
  if (!nom || !/^\S+@\S+\.\S+$/.test(email || "") || !tel || !(q >= 1 && q <= 10)) return res.status(400).json({ erreur: "Données invalides" });
  const c = { id: crypto.randomBytes(4).toString("hex").toUpperCase(), nom: nom.trim(), email, tel, quantite: q, montant: q * PRIX_BILLET, statut: "en_attente", date: new Date().toISOString() };
  const liste = lire(F_CMD, []); liste.push(c); ecrire(F_CMD, liste);

  const { o, s } = jeton(c);
  envoyerMail(process.env.ADMIN_EMAIL, "Organisateur", "Nouvelle commande : " + c.nom,
    `<p><b>${esc(c.nom)}</b> · ${q} billet(s) · ${c.montant} FCFA</p><p>Tél : ${esc(c.tel)}<br>E-mail : ${esc(c.email)}<br>Référence : ${c.id}</p><p>Vérifie le paiement dans Wave, puis : <a href="${SITE}/valider?o=${o}&s=${s}">Valider ce paiement</a></p>`);

  let paiement_url = null;
  if (process.env.WAVE_LINK) {
    const sep = process.env.WAVE_LINK.includes("?") ? "&" : "?";
    paiement_url = process.env.WAVE_LINK + sep + "amount=" + c.montant;
  }
  res.json({ id: c.id, paiement_url });
});

// 2) Valider un paiement (lien reçu par e-mail)
app.get("/valider", (req, res) => {
  const { o, s } = req.query;
  if (!process.env.ADMIN_KEY || sign(String(o)) !== s) return res.status(403).send(page("Lien invalide", "<p>Lien invalide.</p>"));
  const d = unb64(o);
  res.send(page("Valider", `<h2>Valider le paiement ?</h2><p><b>${esc(d.n)}</b><br>${d.q} billet(s) · ${d.q * PRIX_BILLET} FCFA<br>${esc(d.t)} · ${esc(d.e)}</p><p>Vérifie d'abord dans Wave que l'argent est arrivé.</p><button id="b">Oui, j'ai reçu le paiement</button><p id="m"></p><script>document.getElementById("b").onclick=async()=>{const r=await fetch("/api/valider",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({o:${JSON.stringify(o)},s:${JSON.stringify(s)}})});const j=await r.json();document.getElementById("m").textContent=r.ok?(j.mail?"Billet envoyé par e-mail : "+j.code:"Billet créé ("+j.code+") mais e-mail non envoyé."):"Erreur";}</script>`));
});

app.post("/api/valider", async (req, res) => {
  const { o, s } = req.body || {};
  if (!process.env.ADMIN_KEY || sign(String(o)) !== s) return res.status(403).json({ erreur: "Lien invalide" });
  const d = unb64(o);
  const code = codeBillet(d.i, d.q);
  const liste = lire(F_CMD, []);
  const c = liste.find((x) => x.id === d.i);
  if (c) { c.statut = "paye"; ecrire(F_CMD, liste); }
  const png = await QRCode.toBuffer(code, { width: 400, margin: 2 });
  const mail = await envoyerMail(d.e, d.n, "Votre billet – Dîner de Gala",
    `<p>Bonjour ${esc(d.n)},</p><p>Votre paiement est confirmé : ${d.q} billet(s) pour le Dîner de Gala.</p><p>Code : <b>${code}</b></p><p>Le QR code est en pièce jointe. À l'entrée : <a href="${SITE}/billet/${code}">ouvrir mon billet</a></p>`,
    [{ content: png.toString("base64"), name: "billet-" + code + ".png" }]);
  res.json({ code, mail });
});

// 3) Billet en ligne
app.get("/billet/:code", (req, res) => {
  const t = codeValide(req.params.code);
  if (!t) return res.status(404).send(page("Billet", "<p>Billet introuvable.</p>"));
  res.send(page("Billet", `<h2>Dîner de Gala</h2><p>Billet valable pour ${t.q} personne(s)</p><img src="/qr/${req.params.code}" alt="QR code"><p><b>${req.params.code}</b></p>`));
});
app.get("/qr/:code", async (req, res) => {
  if (!codeValide(req.params.code)) return res.sendStatus(404);
  res.type("png").send(await QRCode.toBuffer(req.params.code, { width: 400, margin: 2 }));
});

// 4) Espace organisateur
app.get("/api/admin/commandes", garde, (req, res) => {
  res.json(lire(F_CMD, []).reverse().map((c) => ({ ...c, ...jeton(c) })));
});
app.post("/api/verifier", garde, (req, res) => {
  const t = codeValide(String(req.body.code || "").trim().toUpperCase());
  if (!t) return res.json({ ok: false, message: "Billet invalide" });
  const e = lire(F_ENT, {}); const u = e[t.id] || 0;
  if (u >= t.q) return res.json({ ok: false, message: "Déjà utilisé (" + u + "/" + t.q + ")" });
  e[t.id] = u + 1; ecrire(F_ENT, e);
  res.json({ ok: true, message: "Valide : entrée " + (u + 1) + "/" + t.q });
});
app.get("/admin", (req, res) => res.send(page("Organisateur", `<h2>Organisateur</h2><h3>Contrôle à l'entrée</h3><input id="code" placeholder="Code du billet (GALA-…)"><button onclick="verif()">Vérifier</button><p id="res"></p><h3>Commandes</h3><div id="liste">Chargement…</div><script>
const K=new URLSearchParams(location.search).get("cle")||"";const H={"x-cle":K,"Content-Type":"application/json"};
const $=id=>document.getElementById(id);const e=s=>String(s).replace(/[&<>"']/g,c=>"&#"+c.charCodeAt(0)+";");
async function verif(){const r=await fetch("/api/verifier",{method:"POST",headers:H,body:JSON.stringify({code:$("code").value})});const j=await r.json();$("res").textContent=r.ok?j.message:"Accès refusé";}
async function valider(o,s){const r=await fetch("/api/valider",{method:"POST",headers:H,body:JSON.stringify({o,s})});const j=await r.json();alert(r.ok?(j.mail?"Billet envoyé : "+j.code:"Billet créé "+j.code+" (e-mail non envoyé)"):"Erreur");charger();}
async function charger(){const r=await fetch("/api/admin/commandes",{headers:H});if(!r.ok){$("liste").textContent="Accès refusé : ajoute ?cle=TA_CLE à l'adresse.";return;}
const l=await r.json();$("liste").innerHTML=l.length?l.map(c=>'<div class="c"><b>'+e(c.nom)+'</b> · '+e(c.quantite)+' billet(s) · '+e(c.montant)+' FCFA<br>'+e(c.tel)+' · '+e(c.email)+'<br><small>'+e(c.id)+' · '+e(c.statut)+'</small><br><button onclick="valider(\\''+c.o+'\\',\\''+c.s+'\\')">Valider le paiement</button></div>').join(""):"Aucune commande en mémoire.";}
charger();</script>`)));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Billetterie sur le port " + PORT));
