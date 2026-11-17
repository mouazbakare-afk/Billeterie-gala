const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const PRIX_BILLET = 10000; // FCFA, même valeur que dans index.html
const FICHIER = path.join(__dirname, "commandes.json");
const lire = () => (fs.existsSync(FICHIER) ? JSON.parse(fs.readFileSync(FICHIER)) : []);
const ecrire = (l) => fs.writeFileSync(FICHIER, JSON.stringify(l, null, 2));

app.post("/api/commande", async (req, res) => {
  const { nom, email, tel, quantite } = req.body || {};
  const q = Number(quantite);
  if (!nom || !/^\S+@\S+\.\S+$/.test(email || "") || !tel || !(q >= 1 && q <= 10)) {
    return res.status(400).json({ erreur: "Données invalides" });
  }
  const commande = {
    id: "CMD" + Date.now(),
    nom: nom.trim(), email, tel, quantite: q,
    montant: q * PRIX_BILLET,
    statut: "en_attente",
  };
  const liste = lire(); liste.push(commande); ecrire(liste);

  let paiement_url = null;
  if (process.env.CINETPAY_APIKEY) {
    try {
      const r = await fetch("https://api-checkout.cinetpay.com/v2/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apikey: process.env.CINETPAY_APIKEY,
          site_id: process.env.CINETPAY_SITE_ID,
          transaction_id: commande.id,
          amount: commande.montant,
          currency: "XOF",
          description: "Billets Diner de Gala",
          notify_url: process.env.SITE_URL + "/api/webhook",
          return_url: process.env.SITE_URL,
          channels: "ALL",
          customer_name: commande.nom,
          customer_surname: commande.nom,
          customer_email: commande.email,
          customer_phone_number: commande.tel,
          customer_address: "San Pedro",
          customer_city: "San Pedro",
          customer_country: "CI",
          customer_state: "CI",
          customer_zip_code: "00225",
        }),
      });
      const j = await r.json();
      paiement_url = j.data && j.data.payment_url;
    } catch (e) { console.error("CinetPay :", e.message); }
  }
  res.json({ id: commande.id, paiement_url });
});

app.post("/api/webhook", async (req, res) => {
  const id = req.body.cpm_trans_id || req.body.transaction_id;
  try {
    const r = await fetch("https://api-checkout.cinetpay.com/v2/payment/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apikey: process.env.CINETPAY_APIKEY,
        site_id: process.env.CINETPAY_SITE_ID,
        transaction_id: id,
      }),
    });
    const j = await r.json();
    const liste = lire();
    const c = liste.find((x) => x.id === id);
    if (c && j.data && j.data.status === "ACCEPTED") { c.statut = "paye"; ecrire(liste); }
  } catch (e) { console.error("Webhook :", e.message); }
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Billetterie sur le port " + PORT));
