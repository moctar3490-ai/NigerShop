// ============================================================
// NigerShop — Backend Node.js + SQLite/Turso (version corrigée finale)
// Dépendances : npm install express@4 @libsql/client @libsql/linux-x64-gnu bcryptjs jsonwebtoken multer nodemailer cors dotenv
// ============================================================

require('dotenv').config();

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-moi-secret-par-defaut';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@nigershop.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// ---------- TRANSPORTEUR EMAIL ----------
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS
  }
});

// ---------- MIDDLEWARE ----------
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Dossier uploads
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Fichiers statiques (HTML, CSS, JS client)
app.use(express.static(__dirname));

// ---------- UPLOAD MULTER ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) =>
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Seules les images sont autorisées'));
  }
});

// ============================================================
// CONNEXION À LA BASE (Turso / libSQL)
// ============================================================
const DB_URL = process.env.TURSO_DATABASE_URL || 'file:nigershop.db';
const DB_TOKEN = process.env.TURSO_AUTH_TOKEN || null;
const IS_TURSO = DB_URL.startsWith('libsql://');

console.log('📊 Base de données :', IS_TURSO ? 'Turso (cloud)' : 'Fichier local');

const db = createClient({
  url: DB_URL,
  authToken: DB_TOKEN,
  intMode: 'number'
});

// ============================================================
// WRAPPER DE COMPATIBILITÉ (API sqlite3 → libSQL)
// ============================================================
db.run = function (sql, params, callback) {
  if (typeof params === 'function') { callback = params; params = []; }
  db.execute({ sql, args: params || [] })
    .then(r => {
      if (callback) callback.call(
        { lastID: Number(r.lastInsertRowid || 0), changes: Number(r.rowsAffected || 0) },
        null
      );
    })
    .catch(err => {
      console.error('❌ DB run:', err.message);
      if (callback) callback(err);
    });
};

db.get = function (sql, params, callback) {
  if (typeof params === 'function') { callback = params; params = []; }
  db.execute({ sql, args: params || [] })
    .then(r => { if (callback) callback(null, r.rows[0] || null); })
    .catch(err => {
      console.error('❌ DB get:', err.message);
      if (callback) callback(err);
    });
};

db.all = function (sql, params, callback) {
  if (typeof params === 'function') { callback = params; params = []; }
  db.execute({ sql, args: params || [] })
    .then(r => { if (callback) callback(null, r.rows); })
    .catch(err => {
      console.error('❌ DB all:', err.message);
      if (callback) callback(err);
    });
};

db.prepare = function (sql) {
  const stmts = [];
  return {
    run: (...args) => stmts.push({ sql, args }),
    finalize: () => {
      stmts.reduce((p, s) => p.then(() => db.execute(s)).catch(e => console.error('Batch:', e.message)), Promise.resolve());
    }
  };
};

db.serialize = function (cb) {
  if (typeof cb === 'function') setTimeout(cb, 0);
};

// ============================================================
// INITIALISATION DES TABLES (idempotente)
// ============================================================
async function initDatabase() {
  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, nom TEXT, email TEXT UNIQUE,
      password_hash TEXT, telephone TEXT, ville TEXT, role TEXT DEFAULT 'client',
      verifie INTEGER DEFAULT 0, code_parrain TEXT UNIQUE, parrain_id INTEGER,
      bloque INTEGER DEFAULT 0, motif_blocage TEXT, date_blocage DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS produits (
      id INTEGER PRIMARY KEY AUTOINCREMENT, nom TEXT, description TEXT,
      prix REAL, ancien_prix REAL, stock INTEGER DEFAULT 0, categorie TEXT,
      actif INTEGER DEFAULT 1, vendeur_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS produit_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT, produit_id INTEGER, url TEXT, ordre INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS commentaires (
      id INTEGER PRIMARY KEY AUTOINCREMENT, produit_id INTEGER, user_id INTEGER,
      note INTEGER, texte TEXT, masque INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS favoris (
      user_id INTEGER, produit_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, produit_id)
    )`,
    `CREATE TABLE IF NOT EXISTS historique (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, produit_id INTEGER,
      action TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS commandes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, total REAL,
      transport TEXT, paiement TEXT, ville_livraison TEXT, telephone TEXT,
      statut TEXT DEFAULT 'en_attente', code_promo TEXT, remise REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS commande_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, commande_id INTEGER, produit_id INTEGER,
      nom TEXT, qty INTEGER, prix REAL
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, expediteur_id INTEGER, destinataire_id INTEGER,
      produit_id INTEGER, contenu TEXT, lu INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS commissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, commande_id INTEGER,
      montant REAL, niveau INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS codes_promo (
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, type TEXT, valeur REAL,
      min_commande REAL DEFAULT 0, actif INTEGER DEFAULT 1, date_expiration DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS codes_promo_utilisations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, code_id INTEGER, user_id INTEGER,
      commande_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, token TEXT,
      code TEXT, tentatives INTEGER DEFAULT 0, expiration DATETIME NOT NULL,
      utilise INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  ];

  for (const sql of tables) {
    try { await db.execute(sql); } catch (e) { console.error('❌ Table:', e.message); }
  }

  // Vérifier / créer l'admin
  try {
    const r = await db.execute('SELECT COUNT(*) as c FROM users');
    if (r.rows[0].c === 0) {
      const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
      await db.execute({
        sql: `INSERT INTO users (nom,email,password_hash,role,verifie,code_parrain)
              VALUES (?,?,?,?,1,?)`,
        args: ['Administrateur', ADMIN_EMAIL, hash, 'admin', 'ADMIN001']
      });
      console.log('✅ Admin créé :', ADMIN_EMAIL);
    } else {
      console.log('ℹ️  Base existante —', r.rows[0].c, 'utilisateur(s)');
    }
  } catch (e) {
    console.error('❌ Init admin:', e.message);
  }
}

initDatabase();

// ---------- HELPERS ----------
const auth = (req, res, next) => {
  const t = req.headers.authorization?.split(' ')[1];
  if (!t) return res.status(401).json({ message: 'Non authentifié' });
  try {
    req.user = jwt.verify(t, JWT_SECRET);
    db.get('SELECT bloque, motif_blocage FROM users WHERE id=?', [req.user.id], (e, u) => {
      if (e) return res.status(500).json({ message: 'Erreur DB' });
      if (!u) return res.status(401).json({ message: 'Utilisateur introuvable' });
      if (u.bloque) {
        return res.status(403).json({
          message: 'Votre compte a été suspendu.',
          motif: u.motif_blocage || 'Non précisé',
          banni: true
        });
      }
      next();
    });
  } catch { res.status(401).json({ message: 'Token invalide' }); }
};

const adminOnly = (req, res, next) =>
  req.user && req.user.role === 'admin' ? next() : res.status(403).json({ message: 'Accès refusé' });

function genCodeParrain(nom) {
  return nom.slice(0, 3).toUpperCase() + Math.floor(1000 + Math.random() * 9000);
}

function formaterPrixServeur(n) {
  return new Intl.NumberFormat('fr-FR').format(n) + ' FCFA';
}

// ============================================================
// AUTH
// ============================================================
app.post('/api/register', async (req, res) => {
  const { nom, email, mot_de_passe, telephone, ville, role, code_parrain_utilise } = req.body;
  if (!nom || !email || !mot_de_passe)
    return res.status(400).json({ message: 'Champs requis manquants' });

  db.get('SELECT id FROM users WHERE email=?', [email], async (e, ex) => {
    if (e) return res.status(500).json({ message: 'Erreur DB' });
    if (ex) return res.status(400).json({ message: 'Email déjà utilisé' });
    try {
      const hash = await bcrypt.hash(mot_de_passe, 10);
      let parrain_id = null;
      if (code_parrain_utilise) {
        parrain_id = await new Promise(r =>
          db.get('SELECT id FROM users WHERE code_parrain=?', [code_parrain_utilise], (e, x) => r(x ? x.id : null)));
      }
      const code = genCodeParrain(nom);
      db.run(
        `INSERT INTO users (nom,email,password_hash,telephone,ville,role,code_parrain,parrain_id)
         VALUES (?,?,?,?,?,?,?,?)`,
        [nom, email, hash, telephone || '', ville || '', role || 'client', code, parrain_id],
        function (err) {
          if (err) return res.status(500).json({ message: 'Erreur création' });
          res.json({ id: this.lastID, code_parrain: code });
        }
      );
    } catch { res.status(500).json({ message: 'Erreur serveur' }); }
  });
});

app.post('/api/login', (req, res) => {
  const { email, mot_de_passe } = req.body;
  db.get('SELECT * FROM users WHERE email=?', [email], async (e, u) => {
    if (e) return res.status(500).json({ message: 'Erreur DB' });
    if (!u) return res.status(400).json({ message: 'Utilisateur inconnu' });
    if (u.bloque) {
      return res.status(403).json({
        message: 'Votre compte a été suspendu.',
        motif: u.motif_blocage || 'Non précisé',
        date_blocage: u.date_blocage || null,
        banni: true
      });
    }
    const ok = await bcrypt.compare(mot_de_passe, u.password_hash);
    if (!ok) return res.status(400).json({ message: 'Mot de passe incorrect' });
    const token = jwt.sign({ id: u.id, email: u.email, role: u.role, nom: u.nom }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: u.id, nom: u.nom, email: u.email, role: u.role, verifie: u.verifie, code_parrain: u.code_parrain } });
  });
});

// ============================================================
// PRODUITS
// ============================================================
app.get('/api/produits', (req, res) => {
  db.all('SELECT * FROM produits ORDER BY created_at DESC', (e, rows) => {
    if (e) return res.status(500).json({ message: 'Erreur' });
    if (!rows || !rows.length) return res.json([]);
    const promises = rows.map(p => new Promise(resolve => {
      db.all('SELECT id, url FROM produit_images WHERE produit_id=? ORDER BY ordre', [p.id], (e2, imgs) => {
        p.images = (imgs || []).map(i => i.url);
        db.get('SELECT AVG(note) as moy, COUNT(*) as nb FROM commentaires WHERE produit_id=?', [p.id], (e3, st) => {
          p.note_moyenne = st?.moy || 0;
          p.nb_avis = st?.nb || 0;
          resolve(p);
        });
      });
    }));
    Promise.all(promises).then(list => res.json(list));
  });
});

app.get('/api/produits/:id', (req, res) => {
  db.get('SELECT * FROM produits WHERE id=?', [req.params.id], (e, p) => {
    if (e) return res.status(500).json({ message: 'Erreur' });
    if (!p) return res.status(404).json({ message: 'Introuvable' });
    db.all('SELECT id, url FROM produit_images WHERE produit_id=? ORDER BY ordre', [p.id], (e2, imgs) => {
      p.images = (imgs || []).map(i => i.url);
      db.all(`SELECT c.*, u.nom as user_nom FROM commentaires c
              JOIN users u ON u.id=c.user_id WHERE c.produit_id=? ORDER BY c.created_at DESC`,
        [p.id], (e3, comms) => { p.commentaires = comms || []; res.json(p); });
    });
  });
});

app.post('/api/produits', auth, adminOnly, upload.array('images', 10), (req, res) => {
  const { nom, description, prix, ancien_prix, stock, categorie } = req.body;
  if (!nom || !prix) return res.status(400).json({ message: 'Nom et prix requis' });
  db.run(
    `INSERT INTO produits (nom,description,prix,ancien_prix,stock,categorie,vendeur_id)
     VALUES (?,?,?,?,?,?,?)`,
    [nom, description || '', prix, ancien_prix || null, stock || 0, categorie || 'Divers', req.user.id],
    function (err) {
      if (err) return res.status(500).json({ message: 'Erreur' });
      const pid = this.lastID;
      if (req.files?.length) {
        req.files.forEach((f, i) => db.run('INSERT INTO produit_images (produit_id,url,ordre) VALUES (?,?,?)', [pid, '/uploads/' + f.filename, i]));
      }
      res.json({ id: pid });
    }
  );
});

app.put('/api/produits/:id', auth, adminOnly, upload.array('images', 10), (req, res) => {
  const { nom, description, prix, ancien_prix, stock, categorie } = req.body;
  db.run(
    `UPDATE produits SET nom=?, description=?, prix=?, ancien_prix=?, stock=?, categorie=? WHERE id=?`,
    [nom, description, prix, ancien_prix || null, stock, categorie, req.params.id],
    function (err) {
      if (err) return res.status(500).json({ message: 'Erreur' });
      if (req.files?.length) {
        db.run('DELETE FROM produit_images WHERE produit_id=?', [req.params.id], () => {
          req.files.forEach((f, i) => db.run('INSERT INTO produit_images (produit_id,url,ordre) VALUES (?,?,?)', [req.params.id, '/uploads/' + f.filename, i]));
        });
      }
      res.json({ ok: true });
    }
  );
});

app.delete('/api/produits/:id', auth, adminOnly, (req, res) => {
  db.run('DELETE FROM produits WHERE id=?', [req.params.id], err =>
    err ? res.status(500).json({ message: 'Erreur' }) : res.json({ ok: true }));
});

// ============================================================
// COMMENTAIRES / FAVORIS / HISTORIQUE
// ============================================================
app.post('/api/produits/:id/commentaires', auth, (req, res) => {
  const { note, texte } = req.body;
  if (!note || !texte) return res.status(400).json({ message: 'Note et texte requis' });
  db.run('INSERT INTO commentaires (produit_id,user_id,note,texte) VALUES (?,?,?,?)',
    [req.params.id, req.user.id, note, texte],
    function (err) { if (err) return res.status(500).json({ message: 'Erreur' }); res.json({ id: this.lastID }); });
});

app.post('/api/favoris/:pid', auth, (req, res) => {
  db.run('INSERT OR IGNORE INTO favoris (user_id,produit_id) VALUES (?,?)', [req.user.id, req.params.pid], () => res.json({ ok: true }));
});
app.delete('/api/favoris/:pid', auth, (req, res) => {
  db.run('DELETE FROM favoris WHERE user_id=? AND produit_id=?', [req.user.id, req.params.pid], () => res.json({ ok: true }));
});
app.get('/api/favoris', auth, (req, res) => {
  db.all('SELECT p.* FROM favoris f JOIN produits p ON p.id=f.produit_id WHERE f.user_id=?', [req.user.id], (e, r) => res.json(r || []));
});

app.post('/api/historique', auth, (req, res) => {
  const { produit_id, action } = req.body;
  db.run('INSERT INTO historique (user_id,produit_id,action) VALUES (?,?,?)', [req.user.id, produit_id, action]);
  res.json({ ok: true });
});
app.get('/api/historique', auth, (req, res) => {
  db.all(`SELECT h.*, p.nom as produit_nom FROM historique h
          LEFT JOIN produits p ON p.id=h.produit_id WHERE h.user_id=? ORDER BY h.created_at DESC LIMIT 50`,
    [req.user.id], (e, r) => res.json(r || []));
});

// ============================================================
// COMMANDES
// ============================================================
app.post('/api/commandes', auth, (req, res) => {
  const { total, transport, paiement, ville_livraison, telephone, articles, code_promo } = req.body;
  if (!articles?.length) return res.status(400).json({ message: 'Panier vide' });
  db.run(
    `INSERT INTO commandes (user_id,total,transport,paiement,ville_livraison,telephone,code_promo,remise)
     VALUES (?,?,?,?,?,?,?,?)`,
    [req.user.id, total, transport, paiement, ville_livraison, telephone, code_promo || null, 0],
    function (err) {
      if (err) return res.status(500).json({ message: 'Erreur' });
      const cid = this.lastID;
      if (code_promo) {
        db.get('SELECT id FROM codes_promo WHERE code=?', [code_promo], (e, cp) => {
          if (cp) db.run('INSERT INTO codes_promo_utilisations (code_id,user_id,commande_id) VALUES (?,?,?)', [cp.id, req.user.id, cid]);
        });
      }
      const stmt = db.prepare('INSERT INTO commande_items (commande_id,produit_id,nom,qty,prix) VALUES (?,?,?,?,?)');
      articles.forEach(a => stmt.run(cid, a.id, a.nom, a.qty, a.prix));
      stmt.finalize();
      db.get('SELECT parrain_id FROM users WHERE id=?', [req.user.id], (e, u) => {
        if (u?.parrain_id) {
          db.run('INSERT INTO commissions (user_id,commande_id,montant,niveau) VALUES (?,?,?,1)', [u.parrain_id, cid, total * 0.03]);
          db.get('SELECT parrain_id FROM users WHERE id=?', [u.parrain_id], (e2, u2) => {
            if (u2?.parrain_id) db.run('INSERT INTO commissions (user_id,commande_id,montant,niveau) VALUES (?,?,?,2)', [u2.parrain_id, cid, total * 0.01]);
          });
        }
      });
      articles.forEach(a => db.run('UPDATE produits SET stock = stock - ? WHERE id=?', [a.qty, a.id]));
      db.get('SELECT nom,email FROM users WHERE id=?', [req.user.id], (e, cli) => {
        const lignes = articles.map(a => `- ${a.nom} x${a.qty} = ${a.prix * a.qty} FCFA`).join('\n');
        const body = `🛒 NOUVELLE COMMANDE #${cid}\n\nClient : ${cli?.nom} (${cli?.email})\nTéléphone : ${telephone}\nVille : ${ville_livraison}\nTransport : ${transport}\nPaiement : ${paiement}\n\nArticles :\n${lignes}\n\nTOTAL : ${total} FCFA`;
        if (process.env.MAIL_USER && process.env.MAIL_PASS) {
          transporter.sendMail({ from: `"NigerShop" <${process.env.MAIL_USER}>`, to: ADMIN_EMAIL, subject: `🛒 Commande #${cid} — NigerShop`, text: body }).catch(err => console.log('⚠️ Mail admin:', err.message));
          transporter.sendMail({ from: `"NigerShop" <${process.env.MAIL_USER}>`, to: cli?.email, subject: `✅ Commande #${cid} confirmée — NigerShop`, text: `Bonjour ${cli?.nom},\n\nVotre commande #${cid} est confirmée.\n\n${lignes}\n\nTOTAL : ${total} FCFA\n\nMerci !` }).catch(() => {});
        }
      });
      res.json({ id: cid });
    }
  );
});

app.get('/api/commandes', auth, (req, res) => {
  const q = req.user.role === 'admin'
    ? `SELECT c.*, u.nom as client_nom, u.email as client_email FROM commandes c JOIN users u ON u.id=c.user_id ORDER BY c.created_at DESC`
    : `SELECT * FROM commandes WHERE user_id=? ORDER BY created_at DESC`;
  const params = req.user.role === 'admin' ? [] : [req.user.id];
  db.all(q, params, (e, rows) => {
    if (!rows) return res.json([]);
    const promises = rows.map(c => new Promise(r => {
      db.all('SELECT * FROM commande_items WHERE commande_id=?', [c.id], (e2, its) => { c.articles = its || []; r(c); });
    }));
    Promise.all(promises).then(list => res.json(list));
  });
});

app.put('/api/commandes/:id/statut', auth, adminOnly, (req, res) => {
  db.run('UPDATE commandes SET statut=? WHERE id=?', [req.body.statut, req.params.id], () => res.json({ ok: true }));
});

// ============================================================
// MESSAGES
// ============================================================
app.get('/api/messages', auth, (req, res) => {
  db.all(`SELECT m.*, u1.nom as exp_nom, u2.nom as dest_nom FROM messages m
          JOIN users u1 ON u1.id=m.expediteur_id JOIN users u2 ON u2.id=m.destinataire_id
          WHERE m.expediteur_id=? OR m.destinataire_id=? ORDER BY m.created_at DESC`,
    [req.user.id, req.user.id], (e, r) => res.json(r || []));
});
app.get('/api/messages/:otherId', auth, (req, res) => {
  db.all(`SELECT * FROM messages WHERE (expediteur_id=? AND destinataire_id=?) OR (expediteur_id=? AND destinataire_id=?) ORDER BY created_at ASC`,
    [req.user.id, req.params.otherId, req.params.otherId, req.user.id], (e, r) => {
      db.run('UPDATE messages SET lu=1 WHERE destinataire_id=? AND expediteur_id=?', [req.user.id, req.params.otherId]);
      res.json(r || []);
    });
});
app.post('/api/messages', auth, (req, res) => {
  const { destinataire_id, contenu, produit_id } = req.body;
  if (!destinataire_id || !contenu) return res.status(400).json({ message: 'Champs requis' });
  db.run('INSERT INTO messages (expediteur_id,destinataire_id,produit_id,contenu) VALUES (?,?,?,?)',
    [req.user.id, destinataire_id, produit_id || null, contenu],
    function (err) { if (err) return res.status(500).json({ message: 'Erreur' }); res.json({ id: this.lastID }); });
});

// ============================================================
// CHANGEMENT MDP + MOT DE PASSE OUBLIÉ
// ============================================================
app.put('/api/user/changer-mot-de-passe', auth, async (req, res) => {
  const { ancien_mot_de_passe, nouveau_mot_de_passe } = req.body;
  if (!ancien_mot_de_passe || !nouveau_mot_de_passe) return res.status(400).json({ message: 'Champs requis' });
  if (nouveau_mot_de_passe.length < 6) return res.status(400).json({ message: 'Minimum 6 caractères' });
  db.get('SELECT password_hash FROM users WHERE id=?', [req.user.id], async (e, u) => {
    if (!u) return res.status(404).json({ message: 'Introuvable' });
    const ok = await bcrypt.compare(ancien_mot_de_passe, u.password_hash);
    if (!ok) return res.status(400).json({ message: 'Mot de passe actuel incorrect' });
    const hash = await bcrypt.hash(nouveau_mot_de_passe, 10);
    db.run('UPDATE users SET password_hash=? WHERE id=?', [hash, req.user.id], () => res.json({ ok: true, message: 'Mot de passe modifié' }));
  });
});

app.post('/api/auth/mot-de-passe-oublie', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email requis' });
  db.get('SELECT id, nom, email, bloque FROM users WHERE email=?', [email], (e, u) => {
    if (!u) return res.json({ ok: true, message: 'Si cet email existe, un code a été envoyé.' });
    if (u.bloque) return res.status(403).json({ message: 'Compte suspendu', banni: true });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiration = new Date(Date.now() + 10 * 60 * 1000);
    db.run('DELETE FROM password_resets WHERE user_id=? AND utilise=0', [u.id], () => {
      db.run('INSERT INTO password_resets (user_id, code, expiration) VALUES (?,?,?)', [u.id, code, expiration.toISOString()], async (err) => {
        if (err) return res.status(500).json({ message: 'Erreur' });
        if (process.env.MAIL_USER && process.env.MAIL_PASS) {
          transporter.sendMail({
            from: `"NigerShop" <${process.env.MAIL_USER}>`, to: u.email,
            subject: '🔐 Votre code de réinitialisation — NigerShop',
            text: `Bonjour ${u.nom},\n\nVotre code : ${code}\n\nValable 10 minutes.`
          }).catch(err => console.log('⚠️ Mail reset:', err.message));
        }
        res.json({ ok: true, message: 'Si cet email existe, un code a été envoyé.' });
      });
    });
  });
});

app.post('/api/auth/verifier-code', (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ message: 'Email et code requis' });
  db.get('SELECT id FROM users WHERE email=?', [email], (e, u) => {
    if (!u) return res.status(404).json({ message: 'Code invalide' });
    db.get(`SELECT * FROM password_resets WHERE user_id=? AND utilise=0 ORDER BY created_at DESC LIMIT 1`, [u.id], (e2, pr) => {
      if (!pr) return res.status(404).json({ message: 'Aucun code actif' });
      if (new Date(pr.expiration) < new Date()) return res.status(400).json({ message: 'Code expiré' });
      if (pr.tentatives >= 5) return res.status(429).json({ message: 'Trop de tentatives' });
      if (pr.code !== code) {
        db.run('UPDATE password_resets SET tentatives = tentatives + 1 WHERE id=?', [pr.id]);
        return res.status(400).json({ message: 'Code incorrect' });
      }
      res.json({ ok: true, message: 'Code vérifié' });
    });
  });
});

app.post('/api/auth/reinitialiser-mdp', async (req, res) => {
  const { email, code, nouveau_mot_de_passe } = req.body;
  if (!email || !code || !nouveau_mot_de_passe) return res.status(400).json({ message: 'Champs requis' });
  if (nouveau_mot_de_passe.length < 6) return res.status(400).json({ message: 'Minimum 6 caractères' });
  db.get('SELECT id FROM users WHERE email=?', [email], (e, u) => {
    if (!u) return res.status(404).json({ message: 'Introuvable' });
    db.get(`SELECT * FROM password_resets WHERE user_id=? AND utilise=0 ORDER BY created_at DESC LIMIT 1`, [u.id], async (e2, pr) => {
      if (!pr) return res.status(404).json({ message: 'Aucun code actif' });
      if (new Date(pr.expiration) < new Date()) return res.status(400).json({ message: 'Code expiré' });
      if (pr.code !== code) return res.status(400).json({ message: 'Code incorrect' });
      const hash = await bcrypt.hash(nouveau_mot_de_passe, 10);
      db.run('UPDATE users SET password_hash=? WHERE id=?', [hash, u.id], () => {
        db.run('UPDATE password_resets SET utilise=1 WHERE id=?', [pr.id]);
        res.json({ ok: true, message: 'Mot de passe modifié' });
      });
    });
  });
});

// ============================================================
// CONTACT
// ============================================================
app.post('/api/contact', async (req, res) => {
  const { nom, email, telephone, sujet, message } = req.body;
  if (!nom || !email || !sujet || !message) return res.status(400).json({ message: 'Champs requis' });
  if (!process.env.MAIL_USER) return res.status(500).json({ message: 'Email non configuré' });
  try {
    await transporter.sendMail({
      from: `"NigerShop Contact" <${process.env.MAIL_USER}>`, to: ADMIN_EMAIL, replyTo: email,
      subject: `📩 [Contact] ${sujet} — ${nom}`,
      text: `Nom: ${nom}\nEmail: ${email}\nTél: ${telephone || '-'}\nSujet: ${sujet}\n\n${message}`
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: 'Erreur envoi' }); }
});

// ============================================================
// ADMIN
// ============================================================
app.get('/api/admin/users', auth, adminOnly, (req, res) => {
  db.all(`SELECT id,nom,email,telephone,ville,role,verifie,code_parrain,parrain_id,created_at,bloque,motif_blocage,date_blocage
          FROM users ORDER BY created_at DESC`, (e, r) => res.json(r || []));
});

app.put('/api/admin/users/:id/verifier', auth, adminOnly, (req, res) => {
  db.run('UPDATE users SET verifie=1 WHERE id=?', [req.params.id], () => res.json({ ok: true }));
});

app.delete('/api/admin/users/:id', auth, adminOnly, (req, res) => {
  db.run('DELETE FROM users WHERE id=?', [req.params.id], () => res.json({ ok: true }));
});

app.put('/api/admin/users/:id/bloquer', auth, adminOnly, (req, res) => {
  const { motif } = req.body || {};
  db.get('SELECT bloque FROM users WHERE id=?', [req.params.id], (e, u) => {
    if (!u) return res.status(404).json({ message: 'Introuvable' });
    const statut = u.bloque ? 0 : 1;
    db.run('UPDATE users SET bloque=?, motif_blocage=?, date_blocage=? WHERE id=?',
      [statut, statut ? (motif || 'Sans motif') : null, statut ? new Date().toISOString() : null, req.params.id],
      () => res.json({ ok: true, bloque: statut, message: statut ? 'Banni' : 'Débanni' }));
  });
});

app.put('/api/admin/users/:id/modifier', auth, adminOnly, (req, res) => {
  const { nom, email, telephone, ville, role, verifie } = req.body;
  db.run(`UPDATE users SET nom=?, email=?, telephone=?, ville=?, role=?, verifie=? WHERE id=?`,
    [nom, email, telephone || '', ville || '', role || 'client', verifie ? 1 : 0, req.params.id],
    (err) => {
      if (err) return res.status(err.message.includes('UNIQUE') ? 400 : 500).json({ message: err.message });
      res.json({ ok: true });
    });
});

app.get('/api/admin/users/:id/details', auth, adminOnly, (req, res) => {
  db.get('SELECT * FROM users WHERE id=?', [req.params.id], (e, user) => {
    if (!user) return res.status(404).json({ message: 'Introuvable' });
    delete user.password_hash;
    db.all('SELECT * FROM commandes WHERE user_id=? ORDER BY created_at DESC', [req.params.id], (e1, commandes) => {
      db.all(`SELECT c.*, p.nom as produit_nom FROM commentaires c LEFT JOIN produits p ON p.id=c.produit_id WHERE c.user_id=? ORDER BY c.created_at DESC`, [req.params.id], (e2, avis) => {
        db.all(`SELECT h.*, p.nom as produit_nom FROM historique h LEFT JOIN produits p ON p.id=h.produit_id WHERE h.user_id=? ORDER BY h.created_at DESC LIMIT 20`, [req.params.id], (e3, historique) => {
          res.json({ user, commandes: commandes || [], avis: avis || [], historique: historique || [] });
        });
      });
    });
  });
});

app.get('/api/admin/stats', auth, adminOnly, (req, res) => {
  db.get('SELECT COUNT(*) as users FROM users', (e, u) => {
    db.get('SELECT COUNT(*) as produits FROM produits', (e2, p) => {
      db.get('SELECT COUNT(*) as commandes, IFNULL(SUM(total),0) as ca FROM commandes', (e3, c) => {
        res.json({ users: u?.users || 0, produits: p?.produits || 0, commandes: c?.commandes || 0, ca: c?.ca || 0 });
      });
    });
  });
});

app.get('/api/admin/commissions', auth, (req, res) => {
  db.all(`SELECT c.*, u.nom as user_nom FROM commissions c JOIN users u ON u.id=c.user_id WHERE c.user_id=? ORDER BY c.created_at DESC`,
    [req.user.id], (e, r) => res.json(r || []));
});

// AVIS
app.get('/api/admin/avis', auth, adminOnly, (req, res) => {
  db.all(`SELECT c.*, u.nom as user_nom, u.email as user_email, p.nom as produit_nom
          FROM commentaires c LEFT JOIN users u ON u.id=c.user_id LEFT JOIN produits p ON p.id=c.produit_id
          ORDER BY c.created_at DESC`, (e, r) => res.json(r || []));
});
app.delete('/api/admin/avis/:id', auth, adminOnly, (req, res) => {
  db.run('DELETE FROM commentaires WHERE id=?', [req.params.id], () => res.json({ ok: true }));
});
app.put('/api/admin/avis/:id/masquer', auth, adminOnly, (req, res) => {
  db.get('SELECT masque FROM commentaires WHERE id=?', [req.params.id], (e, a) => {
    if (!a) return res.status(404).json({ message: 'Introuvable' });
    const n = a.masque ? 0 : 1;
    db.run('UPDATE commentaires SET masque=? WHERE id=?', [n, req.params.id], () => res.json({ ok: true, masque: n }));
  });
});

// MESSAGES (modération)
app.delete('/api/admin/messages/conversation/:u1/:u2', auth, adminOnly, (req, res) => {
  db.run(`DELETE FROM messages WHERE (expediteur_id=? AND destinataire_id=?) OR (expediteur_id=? AND destinataire_id=?)`,
    [req.params.u1, req.params.u2, req.params.u2, req.params.u1], () => res.json({ ok: true }));
});
app.get('/api/admin/messages', auth, adminOnly, (req, res) => {
  db.all(`SELECT m.*, u1.nom as exp_nom, u1.email as exp_email, u2.nom as dest_nom, u2.email as dest_email
          FROM messages m LEFT JOIN users u1 ON u1.id=m.expediteur_id LEFT JOIN users u2 ON u2.id=m.destinataire_id
          ORDER BY m.created_at DESC`, (e, r) => res.json(r || []));
});
app.delete('/api/admin/messages/:id', auth, adminOnly, (req, res) => {
  db.run('DELETE FROM messages WHERE id=?', [req.params.id], () => res.json({ ok: true }));
});

// PROMO
app.post('/api/promo/verifier', auth, (req, res) => {
  const { code, total } = req.body;
  db.get('SELECT * FROM codes_promo WHERE code=? AND actif=1', [code.toUpperCase()], (e, c) => {
    if (!c) return res.status(404).json({ message: 'Code invalide' });
    if (c.date_expiration && new Date(c.date_expiration) < new Date()) return res.status(400).json({ message: 'Code expiré' });
    if (total < c.min_commande) return res.status(400).json({ message: `Minimum ${c.min_commande} FCFA` });
    db.get('SELECT id FROM codes_promo_utilisations WHERE code_id=? AND user_id=?', [c.id, req.user.id], (e2, usage) => {
      if (usage) return res.status(400).json({ message: 'Code déjà utilisé' });
      const remise = c.type === 'pourcent' ? Math.round(total * c.valeur / 100) : Math.min(c.valeur, total);
      res.json({ ok: true, code: c.code, type: c.type, valeur: c.valeur, remise, nouveau_total: total - remise });
    });
  });
});
app.post('/api/admin/promo', auth, adminOnly, (req, res) => {
  const { code, type, valeur, min_commande, date_expiration } = req.body;
  db.run('INSERT INTO codes_promo (code,type,valeur,min_commande,date_expiration) VALUES (?,?,?,?,?)',
    [code.toUpperCase(), type, valeur, min_commande || 0, date_expiration || null],
    (err) => {
      if (err) return res.status(400).json({ message: err.message });
      res.json({ ok: true });
    });
});
app.get('/api/admin/promo', auth, adminOnly, (req, res) => {
  db.all(`SELECT c.*, (SELECT COUNT(*) FROM codes_promo_utilisations WHERE code_id=c.id) as nb_utilisations
          FROM codes_promo c ORDER BY c.created_at DESC`, (e, r) => res.json(r || []));
});
app.put('/api/admin/promo/:id/toggle', auth, adminOnly, (req, res) => {
  db.run('UPDATE codes_promo SET actif = CASE WHEN actif=1 THEN 0 ELSE 1 END WHERE id=?', [req.params.id], () => res.json({ ok: true }));
});
app.delete('/api/admin/promo/:id', auth, adminOnly, (req, res) => {
  db.run('DELETE FROM codes_promo WHERE id=?', [req.params.id], () => res.json({ ok: true }));
});

app.delete('/api/admin/commandes/:id', auth, adminOnly, (req, res) => {
  db.run('DELETE FROM commande_items WHERE commande_id=?', [req.params.id], () => {
    db.run('DELETE FROM commandes WHERE id=?', [req.params.id], () => res.json({ ok: true }));
  });
});

// ============================================================
// CATCH-ALL SPA
// ============================================================
app.get('*', (req, res) => {
  if (/\.\w+$/.test(req.path)) return res.status(404).send('Fichier non trouvé');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
// DÉMARRAGE
// ============================================================
app.listen(PORT, () => {
  console.log('🚀 NigerShop sur http://localhost:' + PORT);
  console.log('📧 Admin :', ADMIN_EMAIL);
});
